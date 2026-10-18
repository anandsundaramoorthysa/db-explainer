import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { detectEngine, identityColumns, importSql, normalizeTsql, splitStatements } from '../src/importer/sqlText';
import { foreignKeyEdges, summarize } from '../src/model/schemaModel';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'sql', name), 'utf8');

describe('splitStatements', () => {
  it('splits on semicolons but not inside strings, comments or quoted names', () => {
    const parts = splitStatements("INSERT INTO t VALUES ('a;b'); -- comment; here\nSELECT `x;y` FROM t; /* a; b */ SELECT 2;");
    expect(parts.map((p) => p.text)).toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT `x;y` FROM t', 'SELECT 2']);
  });

  it('records the starting line of each statement', () => {
    const parts = splitStatements('\n\nSELECT 1;\n\n-- note\nSELECT 2;');
    expect(parts.map((p) => p.line)).toEqual([3, 6]);
  });

  it('treats GO as a batch separator and keeps dollar-quoted blocks whole', () => {
    expect(splitStatements('CREATE TABLE a (id INT)\nGO\nCREATE TABLE b (id INT)\nGO\n').length).toBe(2);
    const pg = splitStatements("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;");
    expect(pg.length).toBe(2);
  });
});

describe('detectEngine and normalizeTsql', () => {
  it('recognises the usual dialect markers', () => {
    expect(detectEngine('CREATE TABLE t (id INT AUTO_INCREMENT) ENGINE=InnoDB')).toBe('mysql');
    expect(detectEngine('CREATE TABLE t (id SERIAL PRIMARY KEY, x timestamptz)')).toBe('postgres');
    expect(detectEngine('CREATE TABLE [dbo].[t] ([id] INT IDENTITY(1,1))\nGO')).toBe('mssql');
    expect(detectEngine('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)')).toBe('sqlite');
  });

  it('turns T-SQL syntax into something the parser reads', () => {
    expect(normalizeTsql('[id] INT IDENTITY(1,1), [n] NVARCHAR(MAX)')).toBe('`id` INT , `n` TEXT');
    expect([...identityColumns('[id] INT IDENTITY(1,1) NOT NULL, [n] NVARCHAR(20), seq BIGINT IDENTITY')]).toEqual(['id', 'seq']);
  });
});

describe('the sample store schema', () => {
  const core = importSql(fixture('01_core.sql') + '\n' + fixture('02_inventory.sql'), 'store');

  it('reads every table, column and foreign key', () => {
    const s = summarize(core.model);
    expect(s).toMatchObject({ tables: 12, columns: 69, foreignKeys: 14 });
    expect(core.skipped).toEqual([]);
    expect(core.model.warnings).toEqual([]);
  });

  it('resolves every foreign key to a table that exists', () => {
    expect(foreignKeyEdges(core.model).length).toBe(14);
  });

  it('knows primary keys, nullability, defaults and unique columns', () => {
    const orders = core.model.tables.find((t) => t.name === 'orders')!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((c) => c.name === 'status')).toMatchObject({ dataType: 'VARCHAR(20)', nullable: false, defaultValue: "'pending'" });
    expect(orders.columns.find((c) => c.name === 'shipped_at')!.nullable).toBe(true);
    expect(orders.foreignKeys.map((f) => f.refTable).sort()).toEqual(['addresses', 'customers']);
    const customers = core.model.tables.find((t) => t.name === 'customers')!;
    expect(customers.columns.find((c) => c.name === 'email')!.isUnique).toBe(true);
    expect(customers.columns.find((c) => c.name === 'id')).toMatchObject({ isPrimaryKey: true, isAutoIncrement: true });
  });

  it('sees the self-reference in categories', () => {
    const cat = core.model.tables.find((t) => t.name === 'categories')!;
    expect(cat.foreignKeys[0]).toMatchObject({ columns: ['parent_id'], refTable: 'categories' });
  });
});

describe('statements that confused the old parser', () => {
  const edge = importSql(fixture('edge_cases.sql'), 'edge');
  const table = (n: string) => edge.model.tables.find((t) => t.name === n)!;

  it('treats a composite primary key as a key, not a foreign key', () => {
    expect(table('enrollments').primaryKey).toEqual(['student_id', 'course_id']);
    expect(table('enrollments').foreignKeys).toEqual([]);
    expect(table('enrollments').columns.map((c) => c.isPrimaryKey)).toEqual([true, true, false]);
  });

  it('reads table-level UNIQUE KEY as an index', () => {
    expect(table('course_codes').foreignKeys).toEqual([]);
    expect(table('course_codes').indexes).toEqual([{ name: 'uq_course_term', columns: ['code', 'term'], unique: true }]);
  });

  it('parses ENUM, JSON, defaults, table options and IF NOT EXISTS', () => {
    expect(table('audit_log').columns.map((c) => c.name)).toEqual(['id', 'action', 'payload', 'created_at']);
    expect(table('settings')).toBeTruthy();
  });

  it('does not invent tables from CREATE INDEX, CREATE VIEW or ALTER', () => {
    expect(edge.model.tables.map((t) => t.name).sort()).toEqual(['active_customers', 'audit_log', 'course_codes', 'enrollments', 'settings']);
    expect(table('active_customers').kind).toBe('view');
    expect(table('active_customers').definition).toContain('SELECT id, full_name');
    expect(edge.model.warnings.join(' ')).toMatch(/orders/);
  });

  it('skips INSERT without failing', () => {
    expect(edge.skipped.some((k) => /INSERT/.test(k.reason))).toBe(true);
  });
});

describe('other dialects and statement kinds', () => {
  it('reads PostgreSQL with schema names, SERIAL and inline references', () => {
    const r = importSql('CREATE TABLE public.orgs (id SERIAL PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE public.users (id SERIAL PRIMARY KEY, org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL, created timestamptz DEFAULT now());');
    expect(r.model.engine).toBe('postgres');
    const users = r.model.tables.find((t) => t.name === 'users')!;
    expect(users.schema).toBeUndefined();
    expect(users.columns[0]).toMatchObject({ isPrimaryKey: true, isAutoIncrement: true });
    expect(users.foreignKeys[0]).toMatchObject({ refTable: 'orgs', onDelete: 'SET NULL' });
    expect(users.columns[2].defaultValue).toBe('now()');
  });

  it('reads SQLite', () => {
    const r = importSql('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent INTEGER REFERENCES t(id));');
    expect(r.model.engine).toBe('sqlite');
    expect(r.model.tables[0].foreignKeys[0].refTable).toBe('t');
  });

  it('reads SQL Server scripts with brackets, IDENTITY and GO', () => {
    const r = importSql('CREATE TABLE [dbo].[customers] ([id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY, [name] NVARCHAR(100) NOT NULL)\nGO\nCREATE TABLE [dbo].[orders] ([id] INT IDENTITY(1,1) PRIMARY KEY, [customer_id] INT NOT NULL, CONSTRAINT [fk_o] FOREIGN KEY ([customer_id]) REFERENCES [dbo].[customers]([id]))\nGO\n');
    expect(r.model.engine).toBe('mssql');
    expect(r.model.tables.map((t) => t.name)).toEqual(['customers', 'orders']);
    expect(r.model.tables[1].foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers' });
    expect(r.model.tables[0].columns[0]).toMatchObject({ name: 'id', isPrimaryKey: true, isAutoIncrement: true });
    expect(r.model.tables[0].columns[1].dataType).toBe('NVARCHAR(100)');
  });

  it('applies ALTER TABLE, CREATE INDEX and DROP TABLE in order', () => {
    const r = importSql(`
      CREATE TABLE a (id INT PRIMARY KEY, x INT);
      CREATE TABLE b (id INT PRIMARY KEY, a_id INT);
      ALTER TABLE b ADD CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES a (id);
      ALTER TABLE a ADD COLUMN note VARCHAR(50) NOT NULL;
      ALTER TABLE a DROP COLUMN x;
      CREATE UNIQUE INDEX ux_b ON b (a_id);
      CREATE TABLE gone (id INT);
      DROP TABLE gone;
    `);
    const [a, b] = r.model.tables;
    expect(r.model.tables.length).toBe(2);
    expect(a.columns.map((c) => c.name)).toEqual(['id', 'note']);
    expect(b.foreignKeys[0].refTable).toBe('a');
    expect(b.indexes).toEqual([{ name: 'ux_b', columns: ['a_id'], unique: true }]);
  });

  it('keeps SELECT statements apart as queries to explain', () => {
    const r = importSql('SELECT c.id, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id;');
    expect(r.queries.length).toBe(1);
    expect(r.model.tables).toEqual([]);
  });

  it('reports statements it cannot read instead of hiding them', () => {
    const r = importSql('CREATE TABLE ok (id INT);\nTHIS IS NOT SQL AT ALL;');
    expect(r.model.tables.length).toBe(1);
    expect(r.skipped.length).toBe(1);
    expect(r.model.warnings[0]).toMatch(/could not be read/);
  });
});

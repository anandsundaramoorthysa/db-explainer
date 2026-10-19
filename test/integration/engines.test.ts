// Integration tests against real databases. They need the sample database loaded first:
//   node test/integration/docker.js up        (MySQL, PostgreSQL and SQL Server in Docker)
// SQLite needs nothing. Run with: npx vitest run --config vitest.integration.config.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConnectionProfile, DbEngine, SchemaModel } from '../../src/types';
import { Connector } from '../../src/db/connector';
import { openConnector } from '../../src/db/open';
import { summarize, findTable, shortestPath, foreignKeyEdges } from '../../src/model/schemaModel';
import { guardReadOnly } from '../../src/db/sqlGuard';
import initSqlJs from 'sql.js';

const root = path.resolve(__dirname, '..', '..');
const enginesFile = path.join(root, '.tmp', 'engines.json');
const external: Record<string, ConnectionProfile & { password: string }> = fs.existsSync(enginesFile) ? JSON.parse(fs.readFileSync(enginesFile, 'utf8')) : {};
const LIMITS = { maxRows: 100, timeoutMs: 15000 };
let sqliteFile = '';

interface Case {
  engine: DbEngine;
  profile: () => ConnectionProfile;
  password?: string;
  sleepQuery: string;
}

const cases: Case[] = [
  {
    engine: 'sqlite',
    profile: () => ({ id: 'sqlite', name: 'shop.db', engine: 'sqlite', filePath: sqliteFile }),
    sleepQuery: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000000) SELECT COUNT(*) FROM c',
  },
  { engine: 'mysql', profile: () => ({ id: 'mysql', name: 'shop', ...external.mysql }), password: external.mysql?.password, sleepQuery: 'SELECT SLEEP(30)' },
  { engine: 'postgres', profile: () => ({ id: 'pg', name: 'shop', ...external.postgres }), password: external.postgres?.password, sleepQuery: 'SELECT pg_sleep(30)' },
  {
    engine: 'mssql',
    profile: () => ({ id: 'mssql', name: 'shop', ...external.mssql }),
    password: external.mssql?.password,
    sleepQuery: 'SELECT COUNT_BIG(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c CROSS JOIN sys.all_objects d',
  },
];

beforeAll(async () => {
  // Build the SQLite file from the same sample script.
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'sqlite.sql'), 'utf8'));
  sqliteFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-')), 'shop.db');
  fs.writeFileSync(sqliteFile, Buffer.from(db.export()));
  db.close();
});

afterAll(() => {
  if (sqliteFile) fs.rmSync(path.dirname(sqliteFile), { recursive: true, force: true });
});

describe.each(cases)('$engine', (c) => {
  const available = c.engine === 'sqlite' || !!external[c.engine];
  const run = available ? it : it.skip;
  let conn: Connector;
  let model: SchemaModel;

  beforeAll(async () => {
    if (!available) return;
    conn = openConnector(c.profile(), c.password, { assetsDir: path.join(root, 'out') });
    model = await conn.introspect();
  });
  afterAll(async () => {
    await conn?.close();
  });

  run('reads every table, view, column and foreign key', () => {
    const s = summarize(model);
    expect(s.tables).toBe(12);
    expect(s.views).toBe(1);
    expect(s.foreignKeys).toBe(14);
    expect(model.tables.find((t) => t.name === 'orders')!.columns.map((x) => x.name)).toEqual(['id', 'customer_id', 'shipping_address_id', 'status', 'total_amount', 'placed_at', 'shipped_at']);
    expect(foreignKeyEdges(model).length).toBe(14);
    expect(model.warnings).toEqual([]);
  });

  run('knows keys, nullability, defaults and unique columns', () => {
    const orders = findTable(model, 'orders')!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((x) => x.name === 'id')).toMatchObject({ isPrimaryKey: true, isAutoIncrement: true, nullable: false });
    expect(orders.columns.find((x) => x.name === 'shipped_at')!.nullable).toBe(true);
    expect(orders.columns.find((x) => x.name === 'status')!.defaultValue).toContain('pending');
    expect(orders.foreignKeys.map((f) => f.refTable).sort()).toEqual(['addresses', 'customers']);
    expect(findTable(model, 'customers')!.columns.find((x) => x.name === 'email')!.isUnique).toBe(true);
    const cat = findTable(model, 'categories')!;
    expect(cat.foreignKeys[0]).toMatchObject({ columns: ['parent_id'], refTable: 'categories', refColumns: ['id'] });
  });

  run('reads cascade rules, indexes, views and check constraints', () => {
    const items = findTable(model, 'order_items')!;
    expect(items.foreignKeys.find((f) => f.refTable === 'orders')!.onDelete).toBe('CASCADE');
    expect(findTable(model, 'orders')!.indexes.some((i) => i.name === 'idx_orders_placed_at' && i.columns.join() === 'placed_at')).toBe(true);
    const view = findTable(model, 'customer_order_totals')!;
    expect(view.kind).toBe('view');
    expect(view.columns.map((x) => x.name)).toEqual(['customer_id', 'full_name', 'order_count', 'total_spent']);
    expect(view.definition ?? '').toMatch(/orders/i);
    if (c.engine !== 'sqlite') expect(findTable(model, 'reviews')!.checks.join('') + JSON.stringify(findTable(model, 'reviews')!.checks)).toMatch(/rating/);
  });

  run('reads comments where the engine has them', () => {
    if (c.engine === 'sqlite') return;
    expect(findTable(model, 'orders')!.columns.find((x) => x.name === 'status')!.comment).toBe('pending, paid, shipped or cancelled');
    if (c.engine !== 'mssql') expect(findTable(model, 'customers')!.comment).toBe('People who can place orders');
  });

  run('finds how two tables connect', () => {
    const path1 = shortestPath(model, 'payments', 'products')!;
    expect(path1.map((h) => h.to)).toEqual(['orders', 'order_items', 'products']);
  });

  run('runs a query and returns column names and rows', async () => {
    const r = await conn.query('SELECT id, full_name FROM customers ORDER BY id', LIMITS);
    expect(r.columns).toEqual(['id', 'full_name']);
    expect(r.rows.length).toBe(5);
    expect(r.rows[0].map(String)).toEqual(['1', 'Asha Kumar']);
    expect(r.truncated).toBe(false);
  });

  run('computes values with joins and aggregates', async () => {
    const r = await conn.query('SELECT c.full_name, COUNT(o.id) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.full_name ORDER BY n DESC, c.full_name', LIMITS);
    expect(r.rows.map((x) => [x[0], Number(x[1])])).toEqual([['Asha Kumar', 2], ['Bala Raj', 2], ['Chitra Devi', 2], ['Esha Rao', 1]]);
  });

  run('stops at the row limit and says so', async () => {
    const r = await conn.query('SELECT a.id FROM orders a CROSS JOIN order_items b CROSS JOIN customers c', { maxRows: 100, timeoutMs: 15000 });
    expect(r.rows.length).toBe(100);
    expect(r.truncated).toBe(true);
    // The connection still works afterwards.
    expect((await conn.query('SELECT COUNT(*) FROM customers', LIMITS)).rows[0].map(Number)).toEqual([5]);
  });

  // SQL Server has no plain EXPLAIN, so the extension does not plan queries there.
  (c.engine === 'mssql' ? it.skip : run)('plans a query without running it, and the database refuses a wrong one', async () => {
    const ok = await conn.query('EXPLAIN SELECT id FROM customers', { maxRows: 1, timeoutMs: 5000 });
    expect(ok.rows.length).toBeGreaterThan(0);
    await expect(conn.query('EXPLAIN SELECT no_such_column FROM customers', { maxRows: 1, timeoutMs: 5000 })).rejects.toThrow(/no_such_column|unknown|exist|no such/i);
    await expect(conn.query('EXPLAIN SELECT * FROM customers WHERE NOT IN (SELECT 1)', { maxRows: 1, timeoutMs: 5000 })).rejects.toThrow(/syntax|near|error/i);
  });

  run('stops a query that runs too long', async () => {
    const started = Date.now();
    await expect(conn.query(c.sleepQuery, { maxRows: 10, timeoutMs: 2000 })).rejects.toThrow(/longer than 2 seconds|timed out|timeout/i);
    expect(Date.now() - started).toBeLessThan(10000);
    expect((await conn.query('SELECT COUNT(*) FROM customers', LIMITS)).rows[0].map(Number)).toEqual([5]);
  });

  run('never changes the database, even if a write gets past the guard', async () => {
    const attempts = [
      "INSERT INTO customers (full_name, email, created_at) VALUES ('Intruder', 'x@example.com', '2025-01-01 00:00:00')",
      "UPDATE customers SET full_name = 'Hacked'",
      'DELETE FROM payments',
    ];
    for (const sql of attempts) {
      // The guard refuses these. They are sent straight to the connector to prove the database protects itself too.
      expect(guardReadOnly(sql, c.engine).ok).toBe(false);
      await conn.query(sql, LIMITS).catch(() => undefined);
    }
    expect(Number((await conn.query('SELECT COUNT(*) FROM customers', LIMITS)).rows[0][0])).toBe(5);
    expect((await conn.query("SELECT COUNT(*) FROM customers WHERE full_name = 'Hacked'", LIMITS)).rows[0].map(Number)).toEqual([0]);
    expect(Number((await conn.query('SELECT COUNT(*) FROM payments', LIMITS)).rows[0][0])).toBe(6);
  });

  run('reports a clear error for a bad query', async () => {
    await expect(conn.query('SELECT nothing FROM nowhere', LIMITS)).rejects.toThrow();
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { systemPrompt } from '../src/ai/prompt';
import { Conversation, Source } from '../src/chat/conversation';
import { ChatMessage } from '../src/ai/client';
import { openConnector } from '../src/db/open';
import { describeStats, TableStats } from '../src/db/stats';
import { DbEngine } from '../src/types';

const root = path.resolve(__dirname, '..');

describe('what Dex is told, so its SQL is right', () => {
  const p = systemPrompt('sqlite');

  it('never lets it guess the capitalisation of a value, and says how each dialect compares text', () => {
    expect(p).toContain('Never guess the spelling or capitalisation of a value');
    expect(p).toContain("In SQLite, = on text is case-sensitive, so 'Cancelled' does not match 'cancelled'");
    expect(systemPrompt('postgres')).toContain('In PostgreSQL, = on text is case-sensitive');
    expect(systemPrompt('mysql')).toContain('collation');
    expect(systemPrompt('mssql')).toContain('collation');
    expect(p).toContain('SELECT DISTINCT');
  });

  it('warns that NOT IN returns nothing when the subquery has a NULL, and to say so when comparing', () => {
    expect(p).toContain('NOT IN (subquery) returns no rows at all if the subquery can return a NULL');
    expect(p).toContain('prefer NOT EXISTS');
    expect(p).toContain('without NOT NULL or PK in the context allows NULL');
  });

  it('lists the other common pitfalls', () => {
    for (const phrase of ['COUNT(DISTINCT key)', 'turned into an INNER JOIN', 'grouped or aggregated', 'stop an index being used']) expect(p).toContain(phrase);
  });

  it('asks for one complete corrected query', () => {
    expect(p).toContain('ONE complete corrected query');
  });

  it('asks for rounded money and for the statuses counted in revenue', () => {
    expect(p).toContain('ROUND(expression, 2)');
    expect(p).toMatch(/includes cancelled and pending rows/);
  });

  it.each(['mysql', 'postgres', 'mssql', 'sqlite'] as DbEngine[])('builds for %s', (e) => {
    expect(systemPrompt(e)).toContain('SQL PITFALLS');
  });
});

describe('statistics show exact NULL counts', () => {
  const stats = (rowCount: number, nonNull: number): TableStats => ({ key: 'orders', rowCount, columns: [{ name: 'customer_id', nonNull, nullPercent: 0, distinct: 10 }] });

  it('keeps a single NULL in a large table, which a rounded percent would hide', () => {
    expect(describeStats(stats(5000, 4999))).toContain('customer_id 1 of 5000 NULL');
  });

  it('says nothing about a column that has no NULLs', () => {
    expect(describeStats(stats(10, 10))).toBe('exact row count 10');
  });
});

describe('the accuracy test database', () => {
  let source: Source;
  let all: (sql: string) => Promise<unknown[][]>;
  const asked: ChatMessage[][] = [];

  beforeAll(async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database();
    db.run(fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'accuracy.sql'), 'utf8'));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-acc-')), 'acc.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    const connector = openConnector({ id: 'a', name: 'acc.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
    source = { id: 'a', label: 'acc.db', model: await connector.introspect(), connector };
    all = async (sql) => (await connector.query(sql, { maxRows: 100, timeoutMs: 10000 })).rows;
  });

  it('customers with no orders: 2 rows (Mei Chen, Noah Davis)', async () => {
    const rows = await all('SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id) ORDER BY name');
    expect(rows).toEqual([['Mei Chen'], ['Noah Davis']]);
  });

  it("customers with no cancelled orders: NOT EXISTS gives 9, NOT IN gives 0 (a NULL in the subquery), and the wrong casing gives all 12", async () => {
    expect((await all("SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND o.status = 'cancelled')"))[0][0]).toBe(9);
    expect((await all("SELECT COUNT(*) FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders WHERE status = 'cancelled')"))[0][0]).toBe(0);
    expect((await all("SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND o.status = 'Cancelled')"))[0][0]).toBe(12);
    expect((await all("SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND LOWER(o.status) = 'cancelled')"))[0][0]).toBe(9);
  });

  it('employees above their department average: 3 rows', async () => {
    const rows = await all('SELECT e.name FROM employees e WHERE e.salary > (SELECT AVG(salary) FROM employees WHERE department = e.department)');
    expect(rows.length).toBe(3);
  });

  it('employee hierarchy (recursive): 10 rows', async () => {
    const rows = await all('WITH RECURSIVE tree(id, depth) AS (SELECT employee_id, 0 FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.employee_id, t.depth + 1 FROM employees e JOIN tree t ON e.manager_id = t.id) SELECT id, depth FROM tree');
    expect(rows.length).toBe(10);
  });

  it('two different customers share a name, so grouping by name merges them', async () => {
    expect((await all("SELECT COUNT(*) FROM customers WHERE name = 'Asha Raman'"))[0][0]).toBe(2);
  });

  it('puts the NULL count in the statistics and the NULLable column in the prompt, and sends no row values', async () => {
    const conversation = new Conversation({
      ai: async (m) => {
        asked.push(m);
        return 'ok';
      },
      notes: () => '',
      limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
      maxTables: () => 12,
      sampleRows: () => 5,
    });
    await conversation.ask(source, 'which customers have no cancelled orders?');
    const text = asked[0].map((m) => m.content).join('\n');
    expect(text).toContain('customer_id INT');
    expect(text).toMatch(/customer_id 1 of 14 NULL/);
    expect(text).not.toMatch(/Asha Raman|asha\.r@example/);
  });
});

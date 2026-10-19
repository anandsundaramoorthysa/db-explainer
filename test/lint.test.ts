import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { lintSql, NullCounts } from '../src/ai/lint';
import { extractSql, pastedSql, stripSqlBlocks } from '../src/ai/prompt';
import { Conversation, Source } from '../src/chat/conversation';
import { openConnector } from '../src/db/open';
import { importSql } from '../src/importer/sqlText';

const root = path.resolve(__dirname, '..');
const accuracySql = fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'accuracy.sql'), 'utf8');
const model = importSql(accuracySql, 'acc').model;

describe('names that do not exist', () => {
  it('flags an invented table or view', () => {
    expect(lintSql(model, 'SELECT * FROM nowhere').join('\n')).toContain('no table or view named `nowhere`');
  });

  it('flags an invented column, qualified or not, and lists the real ones', () => {
    const q = lintSql(model, 'SELECT o.total FROM orders o').join('\n');
    expect(q).toContain('`orders` has no column named `total`');
    expect(q).toContain('order_id, customer_id, order_date, status');
    expect(lintSql(model, "SELECT SUM(revenue) FROM v_customer_revenue WHERE status = 'completed'").join('\n')).toContain('`v_customer_revenue` has no column named `status`');
  });

  it('is quiet for real names, select aliases, functions and comparisons between columns', () => {
    expect(lintSql(model, "SELECT o.order_id, o.status AS s FROM orders o WHERE o.status = 'cancelled'")).toEqual([]);
    expect(lintSql(model, "SELECT COUNT(*) AS n FROM orders WHERE LOWER(status) = 'cancelled' AND customer_id IS NOT NULL")).toEqual([]);
    expect(lintSql(model, 'SELECT product_name, price AS cost FROM products WHERE price > 10 ORDER BY cost')).toEqual([]);
  });

  it('does not judge queries with a subquery or WITH, which it cannot read safely', () => {
    expect(lintSql(model, 'SELECT * FROM (SELECT 1 AS x) t')).toEqual([]);
    expect(lintSql(model, 'WITH a AS (SELECT 1) SELECT * FROM a')).toEqual([]);
  });
});

describe('aliases and join columns', () => {
  it('flags an alias that is not defined in the query', () => {
    const w = lintSql(model, "SELECT * FROM customers WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)").join('\n');
    expect(lintSql(model, 'SELECT c.name FROM orders o WHERE o.customer_id = c.customer_id').join('\n')).toContain('`c` is used but is not defined in the FROM or JOIN clause');
    expect(w).toBe('');
  });

  it('is quiet when every alias is defined, including table names used directly', () => {
    expect(lintSql(model, 'SELECT customers.name, o.order_id FROM customers JOIN orders o ON o.customer_id = customers.customer_id')).toEqual([]);
  });

  it('flags a join on columns the foreign key does not link, and says what the link is', () => {
    const w = lintSql(model, 'SELECT * FROM orders o JOIN customers c ON o.order_id = c.customer_id').join('\n');
    expect(w).toContain('`orders.order_id = customers.customer_id` is not how these tables are linked');
    expect(w).toContain('The foreign key is `orders.customer_id` -> `customers.customer_id`');
  });

  it('accepts the real foreign key in either order, and joins between tables that have no foreign key', () => {
    expect(lintSql(model, 'SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id')).toEqual([]);
    expect(lintSql(model, 'SELECT * FROM orders o JOIN customers c ON c.customer_id = o.customer_id')).toEqual([]);
    expect(lintSql(model, 'SELECT * FROM customers c JOIN products p ON c.customer_id = p.product_id')).toEqual([]);
  });
});

describe('an inner join on a key that has NULLs', () => {
  const counts: NullCounts = (table, column) => (table.name === 'orders' && column === 'customer_id' ? { nulls: 1, rows: 14 } : undefined);
  const inner = 'SELECT c.name, o.order_id FROM orders o JOIN customers c ON c.customer_id = o.customer_id';

  it('says how many rows the inner join leaves out', () => {
    expect(lintSql(model, inner, counts).join('\n')).toContain('`orders.customer_id` is NULL in 1 of 14 rows, and this inner JOIN leaves those rows out');
  });

  it('is quiet for a LEFT JOIN, without statistics, or when there are no NULLs', () => {
    expect(lintSql(model, 'SELECT c.name, o.order_id FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id', counts)).toEqual([]);
    expect(lintSql(model, inner)).toEqual([]);
    expect(lintSql(model, inner, () => ({ nulls: 0, rows: 14 }))).toEqual([]);
  });
});

describe('finding SQL', () => {
  it('reads SQL in <sql> tags, which some models use instead of a code fence', () => {
    expect(extractSql('Here:\n<sql>SELECT 1;</sql>\nDone')).toEqual(['SELECT 1']);
    expect(stripSqlBlocks('Here:\n<sql>SELECT 1;</sql>\nDone')).toBe('Here:\n\nDone');
  });

  it('finds SQL in a block that starts with a comment or holds two statements, one entry each', () => {
    const reply = 'Both:\n```sql\n-- NOT IN query\nSELECT * FROM a WHERE x NOT IN (SELECT y FROM b);\n\n/* second */\n-- NOT EXISTS query\nSELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.y = a.x);\n```\nDone';
    expect(extractSql(reply)).toEqual(['SELECT * FROM a WHERE x NOT IN (SELECT y FROM b)', 'SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.y = a.x)']);
    expect(stripSqlBlocks(reply)).toBe('Both:\n\nDone');
  });

  it('leaves blocks that hold no query alone', () => {
    const reply = 'Run this:\n```sql\nDELETE FROM a;\n```\nand\n```sql\n-- just a comment\n```';
    expect(extractSql(reply)).toEqual([]);
    expect(stripSqlBlocks(reply)).toContain('DELETE FROM a');
  });

  it('finds the query in a question, fenced or after a sentence, and nothing in plain questions', () => {
    expect(pastedSql("Review this query: SELECT c.name FROM customers c WHERE c.country = 'x'")).toBe("SELECT c.name FROM customers c WHERE c.country = 'x'");
    expect(pastedSql('is this ok?\n```sql\nSELECT 1 FROM t;\n```')).toBe('SELECT 1 FROM t');
    expect(pastedSql('SELECT a FROM b')).toBe('SELECT a FROM b');
    expect(pastedSql('which customers have no orders?')).toBeUndefined();
    expect(pastedSql('select the best customers')).toBeUndefined();
  });
});

describe('a review with a sentence in front of the query', () => {
  it('still reports the problems found in the pasted query', async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database();
    db.run(accuracySql);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-rev-')), 'a.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    const connector = openConnector({ id: 'a', name: 'a.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
    const source: Source = { id: 'a', label: 'a.db', model: await connector.introspect(), connector };
    const fixed = 'Fixed it.\n```sql\nSELECT c.customer_id, c.name, COUNT(o.order_id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id AND o.status = \'completed\' GROUP BY c.customer_id, c.name\n```';
    const c = new Conversation({ ai: async () => fixed, notes: () => '', limits: () => ({ maxRows: 100, timeoutMs: 10000 }), maxTables: () => 12, sampleRows: () => 5 });
    const a = await c.ask(source, "Review this query: SELECT c.name, COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE o.status = 'completed' GROUP BY c.name");
    expect(a.text).toContain('**Problems found in your query**');
    expect(a.text).toContain('LEFT JOIN kept');
    expect(a.text).toContain('Grouping by `customers.name`');
  });

  it('uses the statistics to say an inner join drops rows with a NULL key', async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database();
    db.run(accuracySql);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-null-')), 'a.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    const connector = openConnector({ id: 'a', name: 'a.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
    const source: Source = { id: 'a', label: 'a.db', model: await connector.introspect(), connector };
    const reply = "```sql\nSELECT o.order_id, c.name FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.status = 'cancelled'\n```";
    const c = new Conversation({ ai: async () => reply, notes: () => '', limits: () => ({ maxRows: 100, timeoutMs: 10000 }), maxTables: () => 12, sampleRows: () => 5 });
    const a = await c.ask(source, 'List the cancelled orders and their customers.');
    expect(a.text).toContain('is NULL in 1 of 14 rows');
  });
});

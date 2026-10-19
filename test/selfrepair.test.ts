import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { ChatMessage } from '../src/ai/client';
import { lintSql } from '../src/ai/lint';
import { answerProblems, repairRequest } from '../src/ai/review';
import { Conversation, Source } from '../src/chat/conversation';
import { openConnector } from '../src/db/open';
import { importSql } from '../src/importer/sqlText';

const root = path.resolve(__dirname, '..');
const accuracySql = fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'accuracy.sql'), 'utf8');
const model = importSql(accuracySql, 'acc').model;

async function liveSource(): Promise<Source> {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database();
  db.run(accuracySql);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-fix-')), 'a.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
  const connector = openConnector({ id: 'a', name: 'a.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
  return { id: 'a', label: 'a.db', model: await connector.introspect(), connector };
}

const deps = (ai: (m: ChatMessage[]) => Promise<string>) => ({
  ai,
  notes: () => '',
  limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
  maxTables: () => 12,
  sampleRows: () => 5,
});

describe('COUNT inflated by a join', () => {
  it('warns when a parent column is counted after joining its child table', () => {
    const w = lintSql(model, 'SELECT o.customer_id, COUNT(o.order_id) FROM orders o JOIN order_items oi ON oi.order_id = o.order_id GROUP BY o.customer_id');
    expect(w.join('\n')).toContain('COUNT(o.order_id) counts `orders` rows once for every matching `order_items` row');
  });

  it('is quiet with COUNT(DISTINCT) and when the counted table is the child', () => {
    expect(lintSql(model, 'SELECT o.customer_id, COUNT(DISTINCT o.order_id) FROM orders o JOIN order_items oi ON oi.order_id = o.order_id GROUP BY o.customer_id')).toEqual([]);
    expect(lintSql(model, 'SELECT c.customer_id, COUNT(o.order_id) FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id')).toEqual([]);
  });
});

describe('what an answer must contain', () => {
  it('wants both queries and an explanation when asked to compare NOT IN and NOT EXISTS', () => {
    const q = 'Show customers with no cancelled orders, using both NOT IN and NOT EXISTS, and compare them.';
    const bare = answerProblems(model, q, '```sql\nSELECT 1\n```', ['SELECT 1']).join('\n');
    expect(bare).toContain('both queries');
    expect(bare).toContain('Explain in words');
    const good =
      'NOT IN returns no rows when the subquery has a NULL, which can happen here because orders.customer_id allows NULL. NOT EXISTS ignores NULLs and returns the right customers, so it is the correct one for this data and the one to use.';
    const both = ['SELECT 1 FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)', 'SELECT 1 FROM customers WHERE name NOT IN (SELECT name FROM customers)'];
    expect(answerProblems(model, q, good, both)).toEqual([]);
  });

  it('wants ROUND and the statuses for a revenue question', () => {
    const p = answerProblems(model, 'What is the total revenue?', 'Here it is.', ['SELECT SUM(price) FROM products']).join('\n');
    expect(p).toContain('ROUND');
    expect(p).toContain('which statuses');
  });

  it('wants a corrected query that has fixed every problem in a pasted query', () => {
    expect(answerProblems(model, 'review this', 'It is wrong.', [], ['x']).join('\n')).toContain('ONE complete corrected query');
    const still = "SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE o.status = 'completed'";
    expect(answerProblems(model, 'review this', 'Fixed.', [still], ['x']).join('\n')).toContain('must fix every problem');
  });

  it('lists the problems in the repair request', () => {
    expect(repairRequest(['a', 'b'])).toContain('- a\n- b');
  });
});

describe('self-repair in the conversation', () => {
  it('asks the model again once, keeps the better answer, and puts only that answer in the history', async () => {
    const source = await liveSource();
    const calls: ChatMessage[][] = [];
    const replies = [
      "Here.\n```sql\nSELECT * FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders WHERE status = 'cancelled')\n```",
      "Use NOT EXISTS, because orders.customer_id allows NULL.\n```sql\nSELECT * FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND LOWER(o.status) = 'cancelled')\n```",
    ];
    const c = new Conversation(deps(async (m) => (calls.push(m), replies[calls.length - 1] ?? 'ok')));
    const a = await c.ask(source, 'customers with no cancelled orders');
    expect(calls).toHaveLength(2);
    expect(calls[1].at(-1)!.content).toContain('Your answer has problems');
    expect(calls[1].at(-1)!.content).toContain('orders.customer_id');
    expect(a.sql[0]).toContain('NOT EXISTS');
    expect(a.text).not.toContain('Check before you run this');
    await c.ask(source, 'thanks');
    expect(calls[2].filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([replies[1]]);
  });

  it('does not ask again when the answer is fine', async () => {
    const source = await liveSource();
    let n = 0;
    const c = new Conversation(deps(async () => (n++, 'The orders table holds one row per order.')));
    await c.ask(source, 'what is the orders table for?');
    expect(n).toBe(1);
  });

  it('shows the first answer, with its warning, if asking again fails', async () => {
    const source = await liveSource();
    let n = 0;
    const c = new Conversation(
      deps(async () => {
        if (++n === 2) throw new Error('network');
        return 'Here.\n```sql\nSELECT * FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders)\n```';
      }),
    );
    const a = await c.ask(source, 'customers with no orders');
    expect(a.text).toContain('Here.');
    expect(a.text).toContain('Check before you run this');
  });
});

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { ChatMessage } from '../src/ai/client';
import { Conversation, Deps, Source } from '../src/chat/conversation';
import { Connector } from '../src/db/connector';
import { openConnector } from '../src/db/open';

const root = path.resolve(__dirname, '..');
const accuracySql = fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'accuracy.sql'), 'utf8');

async function liveSource(): Promise<{ source: Source; seen: string[] }> {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database();
  db.run(accuracySql);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-plan-')), 'a.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
  const real = openConnector({ id: 'a', name: 'a.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
  const seen: string[] = [];
  // Records every statement the extension sends to the database on its own.
  const connector: Connector = { engine: real.engine, introspect: () => real.introspect(), close: () => real.close(), query: (sql, limits) => (seen.push(sql), real.query(sql, limits)) };
  return { source: { id: 'a', label: 'a.db', model: await real.introspect(), connector }, seen };
}

const deps = (ai: (m: ChatMessage[]) => Promise<string>): Deps => ({ ai, notes: () => '', limits: () => ({ maxRows: 100, timeoutMs: 10000 }), maxTables: () => 12, sampleRows: () => 5 });

describe('asking the database to plan a query before it is shown', () => {
  it('sends the database error to the model, shows the repaired query, and never runs the query itself', async () => {
    const { source, seen } = await liveSource();
    const calls: ChatMessage[][] = [];
    const replies = [
      'Here.\n```sql\nSELECT * FROM customers WHERE NOT IN (SELECT customer_id FROM orders)\n```',
      "Fixed.\n```sql\nSELECT * FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)\n```",
    ];
    const c = new Conversation(deps(async (m) => (calls.push(m), replies[calls.length - 1] ?? 'ok')));
    const a = await c.ask(source, 'customers with no orders');
    expect(calls).toHaveLength(2);
    expect(calls[1].at(-1)!.content).toContain('The database refused this query when asked to plan it');
    expect(a.sql[0]).toContain('NOT EXISTS');
    expect(a.text).not.toContain('refused this query');
    const own = seen.filter((s) => !/^SELECT COUNT\(\*\) AS n/.test(s));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((s) => /^EXPLAIN /i.test(s))).toBe(true);
  });

  it('shows the refusal if the model cannot fix it', async () => {
    const { source } = await liveSource();
    const bad = 'Here.\n```sql\nSELECT * FROM customers WHERE NOT IN (SELECT customer_id FROM orders)\n```';
    const a = await new Conversation(deps(async () => bad)).ask(source, 'customers with no orders');
    expect(a.text).toContain('**Check before you run this:**');
    expect(a.text).toContain('The database refused this query when asked to plan it');
  });

  it('is quiet for a good query, and asks the model nothing extra', async () => {
    const { source } = await liveSource();
    let n = 0;
    const good = 'Count.\n```sql\nSELECT COUNT(*) FROM orders\n```';
    const a = await new Conversation(deps(async () => (n++, good))).ask(source, 'how many orders?');
    expect(n).toBe(1);
    expect(a.text).not.toContain('refused');
  });

  it('does nothing for shared SQL, which has no database to ask', async () => {
    const { source } = await liveSource();
    const shared: Source = { ...source, connector: undefined };
    let n = 0;
    const bad = 'Here.\n```sql\nSELECT name FROM customers WHERE name =\n```';
    const a = await new Conversation(deps(async () => (n++, bad))).ask(shared, 'customers with no orders');
    expect(n).toBe(1);
    expect(a.text).not.toContain('refused');
  });

  it('does not plan a query that the read-only guard refuses', async () => {
    const { source, seen } = await liveSource();
    const reply = 'Delete them.\n```sql\nSELECT 1; DROP TABLE customers\n```';
    await new Conversation(deps(async () => reply)).ask(source, 'remove customers');
    expect(seen.some((s) => /drop/i.test(s))).toBe(false);
  });
});

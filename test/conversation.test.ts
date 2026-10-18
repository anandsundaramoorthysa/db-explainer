import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { ChatMessage } from '../src/ai/client';
import { extractSql, looksLikeQuery, buildMessages, systemPrompt } from '../src/ai/prompt';
import { Conversation, Deps, Source } from '../src/chat/conversation';
import { buildContext } from '../src/model/contextBuilder';
import { rankTables, tokenize } from '../src/model/search';
import { importSql } from '../src/importer/sqlText';
import { openConnector } from '../src/db/open';
import { addNoteToText } from '../src/notes';
import { describeTable, shortestPath, referencedBy, summaryLine } from '../src/model/schemaModel';
import { Connector } from '../src/db/connector';

const root = path.resolve(__dirname, '..');
const fixture = (n: string): string => fs.readFileSync(path.join(root, 'test', 'fixtures', 'sql', n), 'utf8');
const store = importSql(fixture('01_core.sql') + fixture('02_inventory.sql'), 'store').model;

describe('finding the tables that matter for a question', () => {
  it('tokenizes snake_case, camelCase and plurals', () => {
    expect(tokenize('Which customers placed orderItems?')).toEqual(['customer', 'placed', 'order', 'item']);
  });

  it('ranks the named table first and relevant columns next', () => {
    expect(rankTables(store, 'what is the orders table for?')[0].key).toBe('orders');
    expect(rankTables(store, 'who wrote reviews with low rating?')[0].key).toBe('reviews');
    expect(rankTables(store, 'which warehouse has low stock')[0].key).toMatch(/warehouses|stock_levels/);
  });

  it('includes the tables linked to the matches, and describes them with keys and references', () => {
    const ctx = buildContext(store, 'what references products?', '');
    for (const t of ['products', 'order_items', 'reviews', 'stock_levels', 'supplier_products']) expect(ctx.tables).toContain(t);
    expect(ctx.text).toContain('ALL TABLES AND VIEWS');
    expect(ctx.text).toContain('referenced by: order_items.product_id');
  });

  it('always lists every table so the AI knows what exists, even on a big schema', () => {
    const big = { ...store, tables: [...store.tables, ...Array.from({ length: 300 }, (_, i) => ({ ...store.tables[0], name: `t${i}`, columns: store.tables[0].columns }))] };
    const ctx = buildContext(big, 'orders', '', { maxChars: 8000 });
    expect(ctx.text).toContain('t299');
    expect(ctx.text.length).toBeLessThan(9000);
    expect(ctx.truncated).toBe(true);
  });

  it('adds team notes and statistics when there are any', () => {
    const ctx = buildContext(store, 'what does the status of an order mean?', '## orders\n- status 3 means shipped', {}, new Map([['orders', 'exact row count 7; status 4 different values']]));
    expect(ctx.text).toContain('TEAM NOTES');
    expect(ctx.text).toContain('status 3 means shipped');
    expect(ctx.text).toContain('statistics: exact row count 7');
  });

  it('describes a table compactly', () => {
    const text = describeTable(store, store.tables.find((t) => t.name === 'orders')!);
    expect(text).toContain('TABLE orders');
    expect(text).toContain('customer_id INT NOT NULL -> customers.id');
    expect(summaryLine(store)).toBe('12 tables, 69 columns, 14 foreign keys');
    expect(referencedBy(store, 'products').length).toBe(4);
    expect(shortestPath(store, 'payments', 'products')!.length).toBe(3);
  });
});

describe('prompts and replies', () => {
  it('pulls SQL out of fenced blocks and ignores everything else', () => {
    const reply = 'Try this:\n```sql\nSELECT COUNT(*) FROM orders;\n```\nand this:\n```js\nconsole.log(1)\n```\n```\nDROP TABLE x\n```';
    expect(extractSql(reply)).toEqual(['SELECT COUNT(*) FROM orders']);
  });

  it('knows a pasted query from a question', () => {
    expect(looksLikeQuery('SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id')).toBe(true);
    expect(looksLikeQuery('```sql\nWITH a AS (SELECT 1) SELECT * FROM a\n```')).toBe(true);
    expect(looksLikeQuery('select the best customers?')).toBe(false);
    expect(looksLikeQuery('what does the orders table do')).toBe(false);
  });

  it('tells the AI the dialect, that it cannot run queries, and that context is untrusted', () => {
    const p = systemPrompt('mssql');
    expect(p).toContain('T-SQL');
    expect(p).toContain('cannot run queries');
    expect(p).toContain('untrusted data');
  });

  it('keeps only the latest turns of history and puts fresh context in the last message', () => {
    const history: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const m = buildMessages({ engine: 'mysql', question: 'q?', context: 'CTX', history });
    expect(m[0].role).toBe('system');
    expect(m.length).toBe(1 + 8 + 1);
    expect(m[m.length - 1].content).toContain('<schema_context>\nCTX\n</schema_context>');
    expect(m[m.length - 1].content).toContain('QUESTION:\nq?');
  });
});

describe('team notes', () => {
  it('starts a notes file with a header and groups notes by table', () => {
    let t = addNoteToText('', 'status 3 means shipped', 'orders');
    expect(t).toContain('# Team notes');
    expect(t).toContain('## orders\n- status 3 means shipped');
    t = addNoteToText(t, 'amounts are in rupees', 'orders');
    t = addNoteToText(t, 'a customer can have many addresses', 'customers');
    t = addNoteToText(t, 'all dates are IST');
    expect(t).toMatch(/## orders\n- status 3 means shipped\n- amounts are in rupees\n/);
    expect(t).toContain('## customers\n- a customer can have many addresses');
    expect(t).toContain('## General\n- all dates are IST');
  });

  it('ignores empty notes and flattens multi-line notes', () => {
    expect(addNoteToText('x', '   ', 'orders')).toBe('x');
    expect(addNoteToText('', 'line one\n  line two', 'a')).toContain('- line one line two');
  });
});

describe('the conversation with a live SQLite database', () => {
  let source: Source;
  let connector: Connector;
  let asked: ChatMessage[][];
  let conversation: Conversation;
  let reply = 'It joins `orders` to `customers`.\n```sql\nSELECT COUNT(*) FROM orders;\n```';

  beforeAll(async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => path.join(root, 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database();
    db.run(fs.readFileSync(path.join(root, 'test', 'fixtures', 'db', 'sqlite.sql'), 'utf8'));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-conv-')), 'shop.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    connector = openConnector({ id: 's', name: 'shop.db', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
    source = { id: 's', label: 'shop.db', model: await connector.introspect(), connector };
    asked = [];
    const deps: Deps = {
      ai: async (m) => {
        asked.push(m);
        return reply;
      },
      notes: () => '## orders\n- status "shipped" means the parcel left the warehouse',
      limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
      maxTables: () => 12,
      sampleRows: () => 5,
    };
    conversation = new Conversation(deps);
  });

  it('answers with schema, statistics and notes in the prompt, and finds the SQL to offer', async () => {
    const a = await conversation.ask(source, 'how many orders does each customer have, and what does shipped mean?');
    expect(a.sql).toEqual(['SELECT COUNT(*) FROM orders']);
    expect(a.statsUsed).toBe(true);
    const last = asked[0][asked[0].length - 1].content;
    expect(last).toContain('TABLE orders (7 rows)');
    expect(last).toContain('statistics: exact row count 7');
    expect(last).toContain('shipped" means the parcel left the warehouse');
    expect(last).toContain('QUESTION:');
  });

  it('never puts real data values in the prompt before the developer allows it', () => {
    const everything = asked.flat().map((m) => m.content).join('\n');
    expect(everything).not.toMatch(/asha@example|9876543210|Asha Kumar/);
  });

  it('remembers the earlier turns', async () => {
    await conversation.ask(source, 'and what about payments?');
    const msgs = asked[1];
    expect(msgs.some((m) => m.role === 'assistant' && m.content.includes('joins `orders`'))).toBe(true);
  });

  it('runs a safe query and refuses an unsafe one with a reason', async () => {
    const ok = await conversation.run(source, 'SELECT id, full_name FROM customers ORDER BY id');
    expect(ok.ok && ok.result.rows.length).toBe(5);
    const bad = await conversation.run(source, 'DELETE FROM customers');
    expect(bad).toEqual({ ok: false, reason: 'Only SELECT queries can be run, not DELETE.' });
    const sharedOnly = await conversation.run({ ...source, connector: undefined }, 'SELECT 1');
    expect(sharedOnly.ok).toBe(false);
  });

  it('sends only masked sample rows when the developer allows it', async () => {
    const outcome = await conversation.run(source, 'SELECT full_name, email, phone, id FROM customers ORDER BY id');
    if (!outcome.ok) throw new Error(outcome.reason);
    reply = 'Five customers.';
    await conversation.explainRows(source, outcome.sql, outcome.result);
    const last = asked[asked.length - 1];
    const text = last[last.length - 1].content;
    expect(text).toContain('<sample_rows');
    expect(text).toContain('showing="5 of 5 rows"');
    expect(text).toContain('Hidden columns: email, phone');
    expect(text).toContain('Asha Kumar');
    expect(text).not.toMatch(/asha@example|9876543210/);
  });

  it('turns a pasted query into an explain request', async () => {
    reply = 'It counts rows.';
    await conversation.ask(source, 'SELECT c.id, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id');
    const last = asked[asked.length - 1];
    expect(last[last.length - 1].content).toContain('Explain this query step by step and check it against the schema');
  });
});

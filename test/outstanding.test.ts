import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { lintSql } from '../src/ai/lint';
import { saveProfileForm } from '../src/ai/profileForm';
import { COPILOT_ADDRESS, keysOf, Memento, ProfileStore, Secrets } from '../src/ai/profiles';
import { AiService, CopilotBridge } from '../src/ai/service';
import { Conversation, Source } from '../src/chat/conversation';
import { Connector } from '../src/db/connector';
import { openConnector } from '../src/db/open';
import { checkSqlText, modelForText, speedHints, sqlStatements } from '../src/editor/sqlChecks';
import { importSql, splitStatements } from '../src/importer/sqlText';
import { layoutDiagram, mermaidEr } from '../src/model/diagram';
import { anchor, dataDictionary, notesFor } from '../src/model/dictionary';

const root = path.resolve(__dirname, '..');
const testFile = fs.readFileSync(path.join(root, 'test', 'fixtures', 'sql', 'explainer_levels.sql'), 'utf8');
const shop = importSql(testFile, 'levels').model;
const at = (text: string, needle: string): number => text.indexOf(needle);

describe('statement positions', () => {
  it('points at each statement, after comments and without the semicolon', () => {
    const text = '-- note\nSELECT 1;\n\n/* c */ SELECT 2 ;';
    const parts = splitStatements(text, true);
    expect(parts.map((p) => text.slice(p.start, p.end))).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('leaves the old shape alone when positions are not asked for', () => {
    expect(splitStatements('SELECT 1;')).toEqual([{ text: 'SELECT 1', line: 1 }]);
  });

  it('marks which statements are queries', () => {
    expect(sqlStatements('SELECT 1; UPDATE t SET a = 1; WITH x AS (SELECT 1) SELECT * FROM x;').map((s) => s.query)).toEqual([true, false, true]);
  });
});

describe('checks in the editor', () => {
  const findings = checkSqlText(testFile);
  const near = (needle: string) => findings.filter((f) => f.start <= at(testFile, needle) && f.end >= at(testFile, needle));

  it('uses the file\x27s own tables when it has them', () => {
    expect(modelForText(testFile)?.tables.map((t) => t.name)).toContain('order_items');
    expect(modelForText('SELECT 1', shop)).toBe(shop);
    expect(modelForText('SELECT 1')).toBeUndefined();
  });

  it('flags = NULL', () => {
    expect(near('email = NULL').map((f) => f.message).join(' ')).toMatch(/never true.*IS NULL/);
  });

  it('flags a comma join with nothing linking the tables', () => {
    expect(near('FROM customers c, products p').some((f) => /every row of one is paired/.test(f.message))).toBe(true);
  });

  it('flags a function on a filtered column, as a hint rather than an error', () => {
    const f = near('YEAR(order_date)').find((x) => /YEAR\(order_date\)/.test(x.message));
    expect(f?.severity).toBe('info');
  });

  it('flags a misspelled command, on the word itself', () => {
    const f = findings.find((x) => /SELEC/.test(x.message))!;
    expect(f.severity).toBe('error');
    expect(f.message).toContain('Did you mean \'SELECT\'?');
    expect(testFile.slice(f.start, f.end)).toBe('SELEC');
  });

  it('flags a column that does not exist', () => {
    expect(checkSqlText("SELECT name FROM customers WHERE contry = 'IN';", shop).some((f) => /no column named 'contry'/.test(f.message))).toBe(true);
    expect(checkSqlText('SELECT c.nmae FROM customers c;', shop).some((f) => /no column named 'nmae'/.test(f.message))).toBe(true);
  });

  it('says nothing about the correct queries', () => {
    expect(near('SELECT name, email\nFROM customers\nWHERE country = \'India\'')).toEqual([]);
    expect(near('INNER JOIN orders o ON o.customer_id = c.customer_id;')).toEqual([]);
  });

  it('keeps the checks that need no structure when there is none', () => {
    const lone = checkSqlText('SELECT a FROM t WHERE b = NULL;');
    expect(lone).toHaveLength(1);
    expect(lone[0].message).toMatch(/never true/);
  });

  it('leaves unknown commands alone unless one is a near miss', () => {
    expect(checkSqlText('MERGE INTO a USING b ON 1=1;')).toEqual([]);
    expect(checkSqlText('FROBNICATE everything;')).toEqual([]);
    expect(checkSqlText('UPDTE t SET a = 1;')[0].message).toContain('UPDATE');
  });

  it('does not mistake SET x = NULL or IS NULL for a comparison', () => {
    expect(lintSql(shop, 'SELECT name FROM customers WHERE email IS NULL')).toEqual([]);
    expect(lintSql(shop, "SELECT name FROM customers WHERE name = 'NULL'")).toEqual([]);
  });
});

describe('speed hints', () => {
  it('suggests a range instead of a date function', () => {
    expect(speedHints(shop, 'SELECT * FROM orders WHERE YEAR(order_date) = 2026')[0]).toMatch(/order_date >= '2026-01-01'/);
  });

  it('flags a leading wildcard', () => {
    expect(speedHints(shop, "SELECT name FROM customers WHERE email LIKE '%@gmail.com'").join(' ')).toMatch(/starts with `%`/);
  });

  it('only when asked properly, suggests an index for an unindexed filter and mentions SELECT *', () => {
    const sql = "SELECT * FROM orders WHERE status = 'completed'";
    expect(speedHints(shop, sql)).toEqual([]);
    const thorough = speedHints(shop, sql, true).join(' ');
    expect(thorough).toMatch(/SELECT \*/);
    expect(thorough).toMatch(/CREATE INDEX idx_orders_status ON orders \(status\)/);
  });

  it('does not suggest an index on a column that already starts one', () => {
    expect(speedHints(shop, 'SELECT * FROM orders WHERE order_id = 3', true).join(' ')).not.toMatch(/CREATE INDEX/);
  });
});

describe('the table diagram', () => {
  const layout = layoutDiagram(shop);
  const node = (k: string) => layout.nodes.find((n) => n.key === k)!;

  it('puts tables that others point at to the left of the tables pointing at them', () => {
    expect(node('customers').x).toBeLessThan(node('orders').x);
    expect(node('orders').x).toBeLessThan(node('order_items').x);
    expect(node('products').x).toBeLessThan(node('order_items').x);
  });

  it('keeps every link between neighbouring columns, so no line runs behind another box', () => {
    const columns = [...new Set(layout.nodes.map((n) => n.x))].sort((a, b) => a - b);
    for (const e of layout.edges.filter((x) => x.from !== x.to)) {
      expect(columns.indexOf(node(e.from).x) - columns.indexOf(node(e.to).x), `${e.from} -> ${e.to}`).toBe(1);
    }
  });

  it('keeps boxes from overlapping', () => {
    for (const a of layout.nodes) for (const b of layout.nodes) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.key} and ${b.key}`).toBe(true);
    }
  });

  it('copes with a table that points at itself', () => {
    expect(layout.edges.some((e) => e.from === 'employees' && e.to === 'employees')).toBe(true);
    expect(node('employees')).toBeDefined();
  });

  it('shows keys first and marks them', () => {
    const items = node('order_items').columns;
    expect(items.slice(0, 2).every((c) => c.fk || c.pk)).toBe(true);
  });

  it('leaves out columns beyond the limit and says how many', () => {
    const wide = importSql(`CREATE TABLE w (id INT PRIMARY KEY, ${Array.from({ length: 20 }, (_, i) => `c${i} INT`).join(', ')});`).model;
    const n = layoutDiagram(wide).nodes[0];
    expect(n.columns).toHaveLength(12);
    expect(n.more).toBe(9);
  });

  it('writes valid-looking Mermaid with every link', () => {
    const text = mermaidEr(shop);
    expect(text.startsWith('erDiagram')).toBe(true);
    expect(text).toContain('customers |o--o{ orders : "customer_id"');
    expect(text).toMatch(/int customer_id PK/i);
  });
});

describe('the data dictionary', () => {
  const notes = '# Team notes\n\n## orders\n- status 3 means shipped\n- placed in UTC\n\n## customers\n- country is ISO\n';
  const md = dataDictionary(shop, notes, new Date('2026-11-16T00:00:00Z'));

  it('lists every table with links that work on GitHub', () => {
    for (const t of shop.tables) expect(md).toContain(`- [${t.name}](#${anchor(t.name)})`);
    expect(anchor('order_items')).toBe('order_items');
    expect(anchor('sales.Order Lines')).toBe('salesorder-lines');
  });

  it('describes columns, keys and links', () => {
    expect(md).toContain('| `customer_id` | INT | yes | FK → customers.customer_id, indexed |');
    expect(md).toContain('| `order_id` | INT | no | PK, FK → orders.order_id |');
    expect(md).toMatch(/\*\*Linked from:\*\* \[orders\]\(#orders\)/);
  });

  it('includes the team notes under the right table only', () => {
    expect(notesFor(notes, 'orders')).toEqual(['status 3 means shipped', 'placed in UTC']);
    const orders = md.slice(md.indexOf('## orders'), md.indexOf('## order_items'));
    expect(orders).toContain('- status 3 means shipped');
    expect(orders).not.toContain('country is ISO');
  });

  it('includes the diagram and the date, and no values', () => {
    expect(md).toContain('```mermaid\nerDiagram');
    expect(md).toContain('made 2026-11-16');
    expect(md).not.toContain('Asha Raman');
  });

  it('escapes a pipe so a table row is not broken', () => {
    const m = importSql("CREATE TABLE t (a VARCHAR(5) DEFAULT 'x|y');").model;
    expect(dataDictionary(m)).toContain("`'x\\|y'`");
  });
});

describe('checking speed on a real database', () => {
  async function sample(): Promise<{ source: Source; seen: string[]; prompts: string[]; convo: Conversation }> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-speed-')), 's.db');
    fs.copyFileSync(path.join(root, 'test', 'fixtures', 'sql_explainer_test.db'), file);
    const real = openConnector({ id: 's', name: 's', engine: 'sqlite', filePath: file }, undefined, { assetsDir: path.join(root, 'out') });
    const seen: string[] = [];
    const connector: Connector = { engine: real.engine, introspect: () => real.introspect(), close: () => real.close(), query: (sql, limits) => (seen.push(sql), real.query(sql, limits)) };
    const prompts: string[] = [];
    const convo = new Conversation({
      ai: async (m) => {
        prompts.push(m[m.length - 1].content);
        return 'It scans orders. Add an index:\n```sql\nCREATE INDEX idx_orders_status ON orders (status);\n```';
      },
      notes: () => '',
      limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
      maxTables: () => 12,
      sampleRows: () => 5,
    });
    return { source: { id: 's', label: 's', model: await real.introspect(), connector }, seen, prompts, convo };
  }

  it('asks the database for its plan without running the query, and sends the plan with the question', async () => {
    const t = await sample();
    const a = await t.convo.explainSpeed(t.source, "SELECT * FROM orders WHERE status = 'completed'");
    expect(t.seen.some((s) => s.startsWith('EXPLAIN QUERY PLAN SELECT * FROM orders'))).toBe(true);
    expect(t.seen.every((s) => /^EXPLAIN\b/i.test(s) || /COUNT\(\*\)/.test(s))).toBe(true);
    expect(t.prompts[0]).toMatch(/SCAN orders/);
    expect(t.prompts[0]).toMatch(/CREATE INDEX idx_orders_status/);
    expect(a.text).toContain('It scans orders');
    await t.source.connector!.close();
  });

  it('refuses anything but a read-only query', async () => {
    const t = await sample();
    const a = await t.convo.explainSpeed(t.source, 'DELETE FROM orders');
    expect(a.text).toMatch(/cannot be checked/);
    expect(t.prompts).toEqual([]);
    expect(t.seen).toEqual([]);
    await t.source.connector!.close();
  });

  it('still helps without a live database, from the query and structure alone', async () => {
    const t = await sample();
    const a = await t.convo.explainSpeed({ ...t.source, connector: undefined }, 'SELECT * FROM orders WHERE YEAR(order_date) = 2026');
    expect(t.prompts[0]).toMatch(/no live connection/i);
    expect(t.prompts[0]).toMatch(/YEAR\(order_date\)/);
    expect(a.text).toBeTruthy();
    await t.source.connector!.close();
  });
});

describe('Copilot with no key', () => {
  function setup(models: string[], reply: (model: string) => Promise<string>) {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
    const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
    const store = new ProfileStore(memento, sec);
    const calls: { model: string; text?: string }[] = [];
    const fetched: string[] = [];
    const asked: string[] = [];
    const copilot: CopilotBridge = {
      models: async () => models,
      chat: async (model, messages, onText) => {
        calls.push({ model });
        const r = await reply(model);
        onText?.(r);
        return r;
      },
    };
    const service = new AiService({
      store,
      copilot,
      legacy: () => ({ baseUrl: 'http://localhost:1/v1', model: '', maxTokens: 10, maxTokensParam: 'max_tokens' }),
      legacyKey: async () => undefined,
      fallback: () => false,
      allowHost: async (u) => void asked.push(u),
      notice: () => undefined,
      fetchFn: (async (u: string) => (fetched.push(u), new Response('{}'))) as unknown as typeof fetch,
    });
    return { store, service, calls, fetched, asked, secrets };
  }

  it('answers through Copilot with no key and no web request of its own, after asking once', async () => {
    const t = setup(['gpt-x'], async () => 'from copilot');
    await t.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'gpt-x' });
    expect(t.service.ready()).toBe(true);
    const seen: string[] = [];
    expect(await t.service.chat([{ role: 'user', content: 'hi' }], (x) => seen.push(x))).toBe('from copilot');
    expect(t.calls).toEqual([{ model: 'gpt-x' }]);
    expect(t.fetched).toEqual([]);
    expect(t.asked).toEqual([COPILOT_ADDRESS]);
    expect(seen).toEqual(['from copilot']);
  });

  it('tries the other Copilot models when the one in use is gone, and says when none answers', async () => {
    const t = setup(['b'], async () => {
      const { AiError } = await import('../src/ai/client');
      throw new AiError('Copilot has no model called "a" any more.', 'model');
    });
    await t.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'a', models: ['a', 'b'] });
    await expect(t.service.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/No other Copilot model answered either/);
    expect(t.calls.map((c) => c.model)).toEqual(['a', 'b']);
  });

  it('switches to another Copilot model that answers, and keeps it', async () => {
    const t = setup(['gone', 'good'], async (model) => {
      if (model === 'gone') {
        const { AiError } = await import('../src/ai/client');
        throw new AiError('Copilot has no model called "gone" any more.', 'model');
      }
      return `from ${model}`;
    });
    await t.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'gone' });
    expect(await t.service.chat([{ role: 'user', content: 'hi' }])).toBe('from good');
    expect(t.store.get('c')!.model).toBe('good');
  });

  it('tests by listing Copilot\x27s models, and says what to do when there are none', async () => {
    const t = setup(['m1', 'm2'], async () => '');
    await t.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'm1' });
    expect(await t.service.test('c')).toMatchObject({ ok: true, models: ['m1', 'm2'] });
    const none = setup([], async () => '');
    await none.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'm1' });
    expect((await none.service.test('c')).message).toMatch(/Install the GitHub Copilot extension/);
  });

  it('is skipped, not crashed on, where Copilot is missing', async () => {
    const t = setup([], async () => '');
    const bare = new AiService({ store: t.store, legacy: () => ({ baseUrl: 'http://localhost:1/v1', model: '', maxTokens: 10, maxTokensParam: 'max_tokens' }), legacyKey: async () => undefined, fallback: () => false, allowHost: async () => undefined, notice: () => undefined });
    await t.store.save({ id: 'c', label: 'Copilot', provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'm1' });
    await expect(bare.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/needs GitHub Copilot/);
  });

  it('saves from the form with no key or address, and drops keys an edited profile had', async () => {
    const t = setup(['m1'], async () => '');
    await t.store.save({ id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' }, 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA');
    const r = await saveProfileForm(t.store, { id: 'g', provider: 'vscode', model: 'm1', key: 'ignored' }, { confirmAddress: async () => undefined });
    expect(r).toEqual({ id: 'g' });
    expect(t.store.get('g')).toMatchObject({ provider: 'vscode', baseUrl: COPILOT_ADDRESS, model: 'm1' });
    expect(t.secrets.size).toBe(0);
    expect(keysOf(t.store.get('g')!)).toHaveLength(1);
    expect(await saveProfileForm(t.store, { provider: 'vscode', model: '' }, { confirmAddress: async () => undefined })).toEqual({ error: 'Pick a Copilot model.' });
  });
});

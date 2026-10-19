// Asks Dex the questions from the accuracy checklist using a real model, runs the SQL it writes on the test
// database, and judges each answer. Usage:
//   LIVE_MODEL=qwen2.5:3b-instruct npx vitest run --config vitest.live.config.ts
// Optional: LIVE_BASE_URL (default http://localhost:11434/v1), LIVE_KEY, LIVE_RUNS (repeats per question, default 1).
import { describe, it, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chat } from '../../src/ai/client';
import { Conversation, Source } from '../../src/chat/conversation';
import { openConnector } from '../../src/db/open';

const root = path.resolve(__dirname, '..', '..');
const model = process.env.LIVE_MODEL ?? 'qwen2.5:3b-instruct';
const baseUrl = process.env.LIVE_BASE_URL ?? 'http://localhost:11434/v1';
const runs = Number(process.env.LIVE_RUNS ?? 1);
const cfg = { baseUrl, model, maxTokens: 1200, maxTokensParam: 'max_tokens' as const };

interface Verdict {
  ok: boolean;
  /** Not correct, but the answer tells the developer what is wrong, so nothing fails silently. Defaults to ok. */
  safe?: boolean;
  notes: string[];
}
interface Scenario {
  id: string;
  question: string;
  judge: (a: { text: string; sql: string[]; rows: Array<{ sql: string; ok: boolean; reason?: string; columns?: string[]; rows?: unknown[][] }> }) => Verdict;
}

const mentions = (t: string, re: RegExp): boolean => re.test(t);
const firstCol = (r: unknown[][] | undefined): unknown[] => (r ?? []).map((x) => x[0]);

const scenarios: Scenario[] = [
  {
    id: 'S1 cancelled orders (value casing)',
    question: 'List the cancelled orders and their customers.',
    judge: ({ text, sql, rows }) => {
      const notes: string[] = [];
      if (!sql.length) return { ok: false, notes: ['no SQL was offered'] };
      const lit = sql.join('\n').match(/status\s*(?:=|like|ilike)\s*'([^']*)'|lower\(\s*(?:\w+\.)?status\s*\)\s*=\s*'([^']*)'/i);
      notes.push(`filter literal: ${lit ? lit[1] ?? lit[2] : 'none found'}`);
      const ran = rows.find((r) => r.ok);
      if (!ran) return { ok: false, notes: [...notes, 'no query ran: ' + (rows[0]?.reason ?? '')] };
      const n = ran.rows?.length ?? 0;
      notes.push(`rows returned: ${n} (4 cancelled orders exist; 3 means the order with no customer was silently dropped by an inner join)`);
      return { ok: n === 4, safe: n === 4 || /leaves those rows out/.test(text), notes };
    },
  },
  {
    id: 'S2 NOT IN vs NOT EXISTS (NULL trap)',
    question: 'Show customers with no cancelled orders, using both NOT IN and NOT EXISTS, and compare them.',
    judge: ({ text, sql, rows }) => {
      const notes: string[] = [];
      const joined = sql.join('\n');
      const hasBoth = /not\s+in\b/i.test(joined) && /not\s+exists\b/i.test(joined);
      notes.push(`both forms offered: ${hasBoth}`);
      const warnsNull = mentions(text, /null/i) && mentions(text, /not\s+in/i);
      notes.push(`explains the NULL problem: ${warnsNull}`);
      const counts = rows.filter((r) => r.ok).map((r) => `${/not\s+exists/i.test(r.sql) ? 'EXISTS' : /not\s+in/i.test(r.sql) ? 'IN' : '?'}=${r.rows?.length}`);
      notes.push(`row counts: ${counts.join(', ')} (expected EXISTS=9, IN=0)`);
      const exists = rows.find((r) => r.ok && /not\s+exists/i.test(r.sql));
      const existsOk = !!exists && (exists.rows?.length ?? -1) === 9;
      return { ok: hasBoth && warnsNull && existsOk, notes };
    },
  },
  {
    id: 'S3 review a broken query (one complete fix)',
    question:
      "Review this query: SELECT c.name, COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE o.status = 'completed' GROUP BY c.name",
    judge: ({ text, sql, rows }) => {
      const notes: string[] = [];
      const leftJoin = mentions(text, /left\s+join/i) && mentions(text, /where/i) && mentions(text, /(inner\s+join|turn|cancel|defeat|negat|filters? out|null)/i);
      notes.push(`spots the LEFT JOIN / WHERE problem: ${leftJoin}`);
      const byName = mentions(text, /(same name|two customers|duplicate|different customers|group(?:ing)? by (?:the )?(?:customer_id|id|key|name))/i);
      notes.push(`spots grouping by name merges people: ${byName}`);
      const last = sql[sql.length - 1] ?? '';
      const complete = /select[\s\S]*from\s+customers/i.test(last) && /group\s+by[\s\S]*customer_id/i.test(last);
      notes.push(`ends with one complete corrected query that groups by customer_id: ${complete}`);
      const ran = rows.find((r) => r.ok && r.sql === last.replace(/;\s*$/, ''));
      notes.push(`corrected query runs: ${!!ran}${ran ? ` (${ran.rows?.length} rows)` : ''}`);
      const flagged = /Problems found in your query/.test(text) && /LEFT JOIN kept/.test(text);
      return { ok: leftJoin && complete && !!ran, safe: (leftJoin && complete && !!ran) || (flagged && /Grouping by|LEFT JOIN kept|Check before you run this/.test(text)), notes };
    },
  },
  {
    id: 'S4 total revenue (statuses, rounding)',
    question: 'What is the total revenue?',
    judge: ({ text, sql, rows }) => {
      const notes: string[] = [];
      const says = mentions(text, /status/i) && mentions(text, /(completed|cancel|pending)/i);
      notes.push(`says which statuses are included: ${says}`);
      const rounds = /round\s*\(/i.test(sql.join('\n'));
      notes.push(`rounds money: ${rounds}`);
      const ran = rows.filter((r) => r.ok);
      const shown = ran.map((r) => String(r.rows?.[0]?.[0]));
      notes.push(`results: ${shown.join(' | ')}`);
      const clean = ran.length > 0 && shown.every((v) => !/\.\d{3,}/.test(v));
      notes.push(`no long decimals: ${clean}`);
      return { ok: says && rounds && clean, notes };
    },
  },
  {
    id: 'S5 orders per customer (group by key, no inflated count)',
    question: 'How many orders does each customer have? Include the order item count too.',
    judge: ({ text, sql, rows }) => {
      const notes: string[] = [];
      const joined = sql.join('\n');
      const byKey = /group\s+by[^;]*customer_id/i.test(joined);
      notes.push(`groups by customer_id: ${byKey}`);
      const ran = rows.find((r) => r.ok);
      notes.push(`ran: ${!!ran}${ran ? ` (${ran.rows?.length} rows)` : ''}`);
      // Check the numbers, not the wording: the column that counts orders must match the true order count per customer.
      const truth: Record<number, number> = { 1: 2, 2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 1, 8: 2, 9: 1, 10: 1 };
      let right = false;
      if (ran?.columns && ran.rows) {
        const idCol = ran.columns.findIndex((c) => /customer_id|^id$/i.test(c));
        const orderCol = ran.columns.findIndex((c) => /order/i.test(c) && !/item/i.test(c) && !/id$/i.test(c));
        if (idCol >= 0 && orderCol >= 0) {
          const checked = ran.rows.filter((r) => truth[Number(r[idCol])] !== undefined);
          right = checked.length >= 9 && checked.every((r) => Number(r[orderCol]) === truth[Number(r[idCol])]);
          notes.push(`order-count column "${ran.columns[orderCol]}" matches the true counts: ${right}`);
        } else notes.push('could not find the customer id and order count columns');
      }
      return { ok: byKey && right, safe: (byKey && right) || /inflated|Grouping by/.test(text), notes };
    },
  },
];

let source: Source;
const report: Array<{ id: string; run: number; ok: boolean; safe: boolean; notes: string[]; text: string; sql: string[]; ms: number }> = [];

beforeAll(async () => {
  const dbFile = path.join(root, 'test', 'fixtures', 'sql_explainer_test.db');
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-live-')), 'test.db');
  fs.copyFileSync(dbFile, copy);
  const connector = openConnector({ id: 'l', name: 'sql_explainer_test.db', engine: 'sqlite', filePath: copy }, undefined, { assetsDir: path.join(root, 'out') });
  source = { id: 'l', label: 'sql_explainer_test.db', model: await connector.introspect(), connector };
});

describe(`Dex with ${model}`, () => {
  for (const sc of scenarios) {
    for (let i = 1; i <= runs; i++) {
      it(`${sc.id} (run ${i})`, async () => {
        // A fresh conversation per question, so earlier answers cannot help.
        const conversation = new Conversation({
          ai: (messages) => chat(cfg, process.env.LIVE_KEY, messages, { timeoutMs: 600000 }),
          notes: () => '',
          limits: () => ({ maxRows: 100, timeoutMs: 15000 }),
          maxTables: () => 12,
          sampleRows: () => 5,
        });
        const t0 = Date.now();
        const a = await conversation.ask(source, sc.question);
        const ran = [];
        for (const sql of a.sql) {
          const out = await conversation.run(source, sql);
          ran.push(out.ok ? { sql, ok: true, columns: out.result.columns, rows: out.result.rows } : { sql, ok: false, reason: out.reason });
        }
        const v = sc.judge({ text: a.text, sql: a.sql, rows: ran });
        report.push({ id: sc.id, run: i, ok: v.ok, safe: v.safe ?? v.ok, notes: v.notes, text: a.text, sql: a.sql, ms: Date.now() - t0 });
        console.log(`\n=== ${sc.id} (run ${i}) -> ${v.ok ? 'PASS' : 'FAIL'}  [${Math.round((Date.now() - t0) / 1000)}s]\n${v.notes.map((n) => '  - ' + n).join('\n')}\n--- Dex said:\n${a.text}\n`);
      });
    }
  }
});

import { afterAll } from 'vitest';
afterAll(() => {
  const out = path.join(root, '.tmp', `live-${model.replace(/[^\w.-]/g, '_')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const pass = report.filter((r) => r.ok).length;
  console.log(`\nSUMMARY ${model}: ${pass}/${report.length} correct, ${report.filter((r) => r.safe).length}/${report.length} correct or clearly flagged. Details in ${out}`);
  for (const r of report) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id} (run ${r.run})`);
});

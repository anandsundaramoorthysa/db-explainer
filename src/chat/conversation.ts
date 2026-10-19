import { ChatMessage } from '../ai/client';
import { lintSql, NullCounts } from '../ai/lint';
import { answerProblems, repairRequest } from '../ai/review';
import { maskSample, MaskedSample } from '../ai/mask';
import { buildMessages, extractSql, looksLikeQuery, pastedSql } from '../ai/prompt';
import { Connector } from '../db/connector';
import { guardReadOnly } from '../db/sqlGuard';
import { describeStats, profileTable, TableStats } from '../db/stats';
import { buildContext } from '../model/contextBuilder';
import { findTable, tableKey } from '../model/schemaModel';
import { QueryLimits, QueryResult, SchemaModel } from '../types';

/** Something the developer can ask about: a live connection, or SQL they shared. */
export interface Source {
  id: string;
  label: string;
  model: SchemaModel;
  connector?: Connector;
  /** Text of the shared SQL, so the AI can also see statements the importer did not turn into tables. */
  sharedSql?: string;
}

export interface Answer {
  text: string;
  /** SQL found in the reply. The panel shows a Run button under each one. */
  sql: string[];
  /** Tables described in full in the context for this answer. */
  tables: string[];
  statsUsed: boolean;
}

export interface Deps {
  ai: (messages: ChatMessage[]) => Promise<string>;
  notes: () => string;
  limits: () => QueryLimits;
  maxTables: () => number;
  sampleRows: () => number;
}

export type RunOutcome = { ok: true; sql: string; result: QueryResult } | { ok: false; reason: string };

const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_TABLES = 6;

export class Conversation {
  private history: ChatMessage[] = [];
  private stats = new Map<string, { at: number; value: TableStats | null }>();

  constructor(private readonly deps: Deps) {}

  reset(): void {
    this.history = [];
  }

  private async statsFor(source: Source, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!source.connector) return out;
    const limits = this.deps.limits();
    await Promise.all(
      keys.slice(0, STATS_TABLES).map(async (key) => {
        const cacheKey = `${source.id}\u0000${key}`;
        let entry = this.stats.get(cacheKey);
        if (!entry || Date.now() - entry.at > STATS_TTL_MS) {
          const table = findTable(source.model, key);
          let value: TableStats | null = null;
          if (table && table.kind === 'table') {
            try {
              value = await profileTable(source.connector!, source.model.engine, table, key, limits);
            } catch {
              value = null;
            }
          }
          entry = { at: Date.now(), value };
          this.stats.set(cacheKey, entry);
        }
        if (entry.value) out.set(key, describeStats(entry.value));
      }),
    );
    return out;
  }

  async ask(source: Source, question: string, sample?: { query: string; data: MaskedSample }): Promise<Answer> {
    const asked = looksLikeQuery(question) ? `Explain this query step by step and check it against the schema:\n\`\`\`sql\n${question.trim().replace(/^```(?:sql)?\s*\n?|```\s*$/gi, '').trim()}\n\`\`\`` : question.trim();
    const notes = this.deps.notes();
    const options = { maxTables: this.deps.maxTables() };
    const first = buildContext(source.model, asked, notes, options);
    const stats = await this.statsFor(source, first.tables);
    const ctx = stats.size ? buildContext(source.model, asked, notes, options, stats) : first;
    const messages = buildMessages({ engine: source.model.engine, question: asked, context: ctx.text, sharedSql: source.sharedSql, history: this.history, sample });
    // How many NULLs each column has comes from the statistics that were just read. Only counts are used.
    const nullCounts: NullCounts = (table, column) => {
      const s = this.stats.get(`${source.id}\u0000${tableKey(table)}`)?.value;
      const c = s?.columns.find((x) => x.name === column);
      return s && c ? { nulls: s.rowCount - c.nonNull, rows: s.rowCount } : undefined;
    };
    const pastedQuery = pastedSql(question);
    const pasted = pastedQuery ? lintSql(source.model, pastedQuery, nullCounts) : [];
    let text = await this.deps.ai(messages);
    // A model can ignore the rules it was given. If the answer has problems the schema can reveal, or the database refuses the
    // query when asked to plan it, ask the model once to fix them.
    const check = async (reply: string): Promise<string[]> => [...answerProblems(source.model, asked, reply, extractSql(reply), pasted, nullCounts), ...(sample ? [] : await this.rejectedByDatabase(source, extractSql(reply)))];
    const problems = await check(text);
    if (problems.length && !sample) {
      try {
        const again = await this.deps.ai([...messages, { role: 'assistant', content: text }, { role: 'user', content: repairRequest(problems) }]);
        if ((await check(again)).length <= problems.length) text = again;
      } catch {
        // The first answer is still good enough to show.
      }
    }
    this.history.push({ role: 'user', content: asked }, { role: 'assistant', content: text });
    const sql = extractSql(text);
    const warnings = [...new Set(sql.flatMap((s) => lintSql(source.model, s, nullCounts)))].filter((w) => !pasted.includes(w));
    const refused = sample ? [] : await this.rejectedByDatabase(source, sql);
    const checks = [
      pasted.length ? `**Problems found in your query** (checked against the schema):\n${pasted.map((w) => '- ' + w).join('\n')}` : '',
      warnings.length || refused.length ? `**Check before you run this:**\n${[...warnings, ...refused].map((w) => '- ' + w).join('\n')}` : '',
    ].filter(Boolean);
    const shown = checks.length ? `${text}\n\n${checks.join('\n\n')}` : text;
    return { text: shown, sql, tables: ctx.tables, statsUsed: stats.size > 0 };
  }

  /**
   * Asks a live database to plan each query with EXPLAIN, which compiles it without running it or reading any row, and returns
   * the database's own complaint for each one it refuses (a syntax error, an unknown column). SQL Server has no plain EXPLAIN.
   */
  private async rejectedByDatabase(source: Source, queries: string[]): Promise<string[]> {
    if (!source.connector || source.model.engine === 'mssql') return [];
    const limits = { maxRows: 1, timeoutMs: Math.min(this.deps.limits().timeoutMs, 5000) };
    const out: string[] = [];
    for (const q of queries.slice(0, 3)) {
      if (/^\s*explain\b/i.test(q)) continue;
      const guarded = guardReadOnly(`EXPLAIN ${q}`, source.model.engine);
      if (!guarded.ok) continue;
      try {
        await source.connector.query(guarded.sql, limits);
      } catch (e) {
        const message = ((e as Error).message ?? '').split('\n')[0].slice(0, 200);
        if (message && !/timed out|timeout|connect|ECONN/i.test(message)) out.push(`The database refused this query when asked to plan it: ${message}`);
      }
    }
    return [...new Set(out)];
  }

  /** Runs a query for the developer after the guard has checked it. The AI is not involved and never sees the rows. */
  async run(source: Source, sql: string): Promise<RunOutcome> {
    if (!source.connector) return { ok: false, reason: 'Queries can only be run on a live connection. Connect to the database first.' };
    const guarded = guardReadOnly(sql, source.model.engine);
    if (!guarded.ok) return { ok: false, reason: guarded.reason };
    try {
      return { ok: true, sql: guarded.sql, result: await source.connector.query(guarded.sql, this.deps.limits()) };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** Only called when the developer presses "Let the AI see these rows". Sensitive columns are masked first. */
  async explainRows(source: Source, sql: string, result: QueryResult): Promise<Answer> {
    const data = maskSample(result.columns, result.rows, this.deps.sampleRows());
    return this.ask(source, 'Explain what these rows show and whether the query answered the question. Do not repeat the hidden values.', { query: sql, data });
  }
}

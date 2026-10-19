import { ChatMessage } from '../ai/client';
import { lintSql } from '../ai/lint';
import { maskSample, MaskedSample } from '../ai/mask';
import { buildMessages, extractSql, looksLikeQuery } from '../ai/prompt';
import { Connector } from '../db/connector';
import { guardReadOnly } from '../db/sqlGuard';
import { describeStats, profileTable, TableStats } from '../db/stats';
import { buildContext } from '../model/contextBuilder';
import { findTable } from '../model/schemaModel';
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
    const text = await this.deps.ai(messages);
    this.history.push({ role: 'user', content: asked }, { role: 'assistant', content: text });
    const sql = extractSql(text);
    const pasted = looksLikeQuery(question) ? lintSql(source.model, asked.replace(/^[\s\S]*?```sql\s*\n|\n?```\s*$/g, '')) : [];
    const warnings = [...new Set(sql.flatMap((s) => lintSql(source.model, s)))].filter((w) => !pasted.includes(w));
    const checks = [
      pasted.length ? `**Problems found in your query** (checked against the schema):\n${pasted.map((w) => '- ' + w).join('\n')}` : '',
      warnings.length ? `**Check before you run this:**\n${warnings.map((w) => '- ' + w).join('\n')}` : '',
    ].filter(Boolean);
    const shown = checks.length ? `${text}\n\n${checks.join('\n\n')}` : text;
    return { text: shown, sql, tables: ctx.tables, statsUsed: stats.size > 0 };
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

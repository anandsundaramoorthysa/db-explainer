import { SchemaModel } from '../types';
import { describeTable, foreignKeyEdges, overviewLine, summaryLine, tableKey } from './schemaModel';
import { rankTables, relevantNotes } from './search';

export interface ContextOptions {
  maxTables: number;
  /** Rough character budget for the whole context. */
  maxChars: number;
}

export interface BuiltContext {
  text: string;
  /** Tables described in full, so the UI can show what the answer was based on. */
  tables: string[];
  truncated: boolean;
}

const DEFAULTS: ContextOptions = { maxTables: 12, maxChars: 28000 };

/**
 * Builds the schema description sent along with one question: a one-line overview of every table, full detail for
 * the tables that best match the question plus the tables they link to, and the team notes that matter.
 */
export function buildContext(model: SchemaModel, question: string, notes: string, options: Partial<ContextOptions> = {}, stats: Map<string, string> = new Map()): BuiltContext {
  const opts = { ...DEFAULTS, ...options };
  const ranked = rankTables(model, question, notes);
  const edges = foreignKeyEdges(model);

  const chosen: string[] = [];
  const add = (key: string): void => {
    if (!chosen.includes(key) && chosen.length < opts.maxTables) chosen.push(key);
  };
  const matched = ranked.filter((r) => r.score > 0);
  for (const r of matched.slice(0, Math.max(3, Math.ceil(opts.maxTables / 2)))) add(r.key);
  for (const key of [...chosen]) {
    for (const e of edges) {
      if (e.from === key) add(e.to);
      else if (e.to === key) add(e.from);
    }
  }
  for (const r of matched) add(r.key);
  // A question with no recognisable words still needs something to work with.
  if (!chosen.length) for (const t of model.tables.slice(0, opts.maxTables)) add(tableKey(t));

  const sections: string[] = [];
  sections.push(`DATABASE: ${model.name} (${model.source === 'live' ? 'live connection' : 'shared SQL'}), ${summaryLine(model)}`);
  const overview = model.tables.map(overviewLine);
  let overviewText = overview.join('\n');
  let truncated = false;
  if (overviewText.length > opts.maxChars / 3) {
    overviewText = model.tables.map(tableKey).join(', ');
    truncated = true;
  }
  sections.push(`ALL TABLES AND VIEWS:\n${overviewText}`);

  const detail: string[] = [];
  let used = sections.join('\n\n').length;
  for (const key of chosen) {
    const t = model.tables.find((x) => tableKey(x) === key);
    if (!t) continue;
    const statLine = stats.get(key);
    const text = describeTable(model, t) + (statLine ? `\n  statistics: ${statLine}` : '');
    if (used + text.length > opts.maxChars) {
      truncated = true;
      break;
    }
    detail.push(text);
    used += text.length + 2;
  }
  sections.push(`TABLES RELEVANT TO THE QUESTION (in full):\n${detail.join('\n\n')}`);

  const routines = model.routines.slice(0, 40).map((r) => `${r.kind} ${r.name}${r.table ? ` on ${r.table}` : ''}`);
  if (routines.length) sections.push(`ROUTINES AND TRIGGERS: ${routines.join(', ')}`);

  const noteText = relevantNotes(notes, chosen, question, 4000);
  if (noteText) sections.push(`TEAM NOTES (written by the developers, treat as facts about the business):\n${noteText}`);

  return { text: sections.join('\n\n'), tables: chosen, truncated };
}

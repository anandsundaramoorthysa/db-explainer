import { SchemaModel, Table } from '../types';
import { tableKey } from './schemaModel';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'by', 'from', 'how', 'what', 'which',
  'who', 'whom', 'where', 'when', 'why', 'does', 'do', 'did', 'show', 'give', 'me', 'my', 'list', 'get', 'find', 'all', 'any', 'each',
  'per', 'this', 'that', 'these', 'those', 'it', 'its', 'be', 'can', 'i', 'we', 'you', 'table', 'tables', 'column', 'columns', 'data',
  'query', 'sql', 'write', 'explain', 'about', 'there', 'than', 'then', 'have', 'has', 'top', 'number', 'count', 'many', 'much',
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Splits text into lowercase word stems, also breaking snake_case and camelCase. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

export interface Scored {
  table: Table;
  key: string;
  score: number;
}

/**
 * Ranks tables by how well they match a question. Table name matches count most, then column names,
 * then comments and team notes. Plain keyword scoring is deterministic and needs no extra services.
 */
export function rankTables(model: SchemaModel, question: string, notes = ''): Scored[] {
  const words = new Set(tokenize(question));
  const noteTokens = new Set(tokenize(notes));
  const lowerQuestion = question.toLowerCase();
  return model.tables
    .map((table) => {
      const key = tableKey(table);
      let score = 0;
      const nameTokens = tokenize(table.name);
      if (new RegExp(`\\b${table.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase()}\\b`).test(lowerQuestion)) score += 12;
      for (const t of nameTokens) if (words.has(t)) score += 6;
      for (const c of table.columns) {
        for (const t of tokenize(c.name)) if (words.has(t)) score += 2;
        if (c.comment) for (const t of tokenize(c.comment)) if (words.has(t)) score += 1;
      }
      if (table.comment) for (const t of tokenize(table.comment)) if (words.has(t)) score += 2;
      for (const t of nameTokens) if (noteTokens.has(t) && words.size) score += 0.5;
      return { table, key, score };
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Notes are plain text. Returns the sections that mention any of the given tables or question words. */
export function relevantNotes(notes: string, tableNames: string[], question: string, maxChars: number): string {
  if (!notes.trim()) return '';
  if (notes.length <= maxChars) return notes.trim();
  const words = new Set([...tokenize(question), ...tableNames.flatMap(tokenize)]);
  const sections = notes.split(/\n(?=#{1,4}\s)|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const scored = sections.map((s) => ({ s, score: tokenize(s).filter((t) => words.has(t)).length })).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  let used = 0;
  for (const { s } of scored) {
    if (used + s.length > maxChars) continue;
    out.push(s);
    used += s.length + 2;
  }
  return out.join('\n\n');
}

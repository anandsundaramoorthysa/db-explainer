import { lintSql } from '../ai/lint';
import { importSql, splitStatements } from '../importer/sqlText';
import { findTable } from '../model/schemaModel';
import { SchemaModel, Table } from '../types';

/* Checks for SQL files in the editor. No vscode import and no AI: everything here works offline and can be tested on its own. */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  start: number;
  end: number;
  message: string;
  severity: Severity;
}

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
  /** A SELECT or WITH query, which can be explained, checked and run. */
  query: boolean;
}

const COMMANDS = [
  'select', 'with', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate', 'merge', 'grant', 'revoke', 'begin', 'commit',
  'rollback', 'set', 'use', 'declare', 'exec', 'execute', 'explain', 'show', 'describe', 'desc', 'pragma', 'values', 'replace', 'call',
  'comment', 'analyze', 'vacuum', 'if', 'print', 'return', 'end', 'start', 'savepoint', 'release', 'lock', 'unlock', 'copy', 'do',
  'refresh', 'reindex', 'cluster', 'listen', 'notify', 'prepare', 'deallocate', 'fetch', 'open', 'close', 'while', 'raiserror', 'throw',
  'attach', 'detach', 'load', 'optimize', 'repair', 'check', 'flush', 'kill', 'handler', 'table', 'checkpoint', 'discard', 'reset',
  'security', 'import', 'unload', 'upsert', 'go',
];
const COMMAND_SET = new Set(COMMANDS);
const NO_SCHEMA: SchemaModel = { engine: 'mysql', name: '', source: 'sql', tables: [], routines: [], capturedAt: '', warnings: [] };

export function sqlStatements(text: string): SqlStatement[] {
  return splitStatements(text, true).map((s) => ({ text: s.text, start: s.start ?? 0, end: s.end ?? text.length, query: /^(select|with)\b/i.test(s.text) }));
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** A statement that starts with a misspelled command, such as SELEC. Unknown words with no close match are left alone. */
function misspelledCommand(text: string): string | undefined {
  const word = text.match(/^[A-Za-z_]+/)?.[0];
  if (!word || COMMAND_SET.has(word.toLowerCase()) || word.length < 3) return undefined;
  const near = COMMANDS.filter((c) => c.length >= 3).map((c) => ({ c, d: distance(word.toLowerCase(), c) })).sort((x, y) => x.d - y.d)[0];
  return near && near.d <= (word.length > 4 ? 2 : 1) ? `\`${word}\` is not a SQL command. Did you mean \`${near.c.toUpperCase()}\`?` : undefined;
}

function blank(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
}

const DATE_PARTS = /^(year|month|day|date|date_trunc|extract|datepart|strftime|to_char)$/i;

/**
 * Patterns that make a query read more of a table than it needs to. `thorough` adds the ones that are only worth raising when
 * someone asks why a query is slow, because they are too noisy to underline while typing.
 */
export function speedHints(model: SchemaModel | undefined, sql: string, thorough = false): string[] {
  const text = blank(sql);
  const where = text.match(/\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|\)\s*$|;|$)/i)?.[1] ?? '';
  const out: string[] = [];
  for (const m of where.matchAll(/\b(\w+)\s*\(\s*(?:'[^']*'\s*,\s*)?([A-Za-z_][\w.]*)\s*[,)]/g)) {
    const fn = m[1];
    if (/^(in|exists|select|any|all|not|and|or|coalesce)$/i.test(fn)) continue;
    const column = m[2];
    out.push(
      DATE_PARTS.test(fn)
        ? `\`${fn.toUpperCase()}(${column})\` in WHERE stops the database using an index on \`${column}\`, so it reads every row. Compare the column to a range instead, such as \`${column} >= '2026-01-01' AND ${column} < '2027-01-01'\`.`
        : `\`${fn.toUpperCase()}(${column})\` in WHERE stops the database using an index on \`${column}\`, so it reads every row.`,
    );
  }
  if (/\bLIKE\s+'%/i.test(sql.replace(/--[^\n]*/g, ' '))) out.push('A `LIKE` pattern that starts with `%` cannot use an index, so every row is read.');
  if (thorough) {
    if (/\bSELECT\s+(?:DISTINCT\s+)?\*/i.test(text)) out.push('`SELECT *` reads every column. Naming only the columns you need reads less and can let an index answer the query alone.');
    if (model) {
      for (const m of where.matchAll(/(?<![\w.])(?:(\w+)\.)?([A-Za-z_]\w*)\s*(?:=|\bIN\b)/gi)) {
        const table = tableFor(model, text, m[1], m[2]);
        if (!table) continue;
        const col = m[2].toLowerCase();
        const indexed = table.primaryKey[0]?.toLowerCase() === col || table.indexes.some((ix) => ix.columns[0]?.toLowerCase() === col);
        if (!indexed) out.push(`No index starts with \`${table.name}.${m[2]}\`, so filtering on it reads the whole table. On a large table an index would help: \`CREATE INDEX idx_${table.name}_${m[2]} ON ${table.name} (${m[2]});\``);
      }
    }
  }
  return [...new Set(out)];
}

function tableFor(model: SchemaModel, text: string, alias: string | undefined, column: string): Table | undefined {
  const refs = [...text.matchAll(/\b(?:FROM|JOIN)\s+([`"\[\]\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi)].map((m) => ({ table: findTable(model, m[1]), alias: (m[2] ?? '').toLowerCase() }));
  const has = (t: Table | undefined): t is Table => !!t && t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase());
  if (alias) {
    const hit = refs.find((r) => r.alias === alias.toLowerCase() || r.table?.name.toLowerCase() === alias.toLowerCase());
    return has(hit?.table) ? hit!.table : undefined;
  }
  const owners = refs.map((r) => r.table).filter(has);
  return owners.length === 1 ? owners[0] : undefined;
}

/** The structure to check against: the file's own CREATE TABLE statements if it has any, otherwise the database in use. */
export function modelForText(text: string, fallback?: SchemaModel): SchemaModel | undefined {
  if (/\bcreate\s+(?:temporary\s+|temp\s+)?(?:table|view)\b/i.test(text)) {
    try {
      const own = importSql(text, 'this file').model;
      if (own.tables.length) return own;
    } catch {
      // A file the importer cannot read still gets the other checks.
    }
  }
  return fallback;
}

/** Every problem found in a SQL file, with where it is. */
export function checkSqlText(text: string, fallback?: SchemaModel): Finding[] {
  const model = modelForText(text, fallback);
  const findings: Finding[] = [];
  for (const s of sqlStatements(text)) {
    const at = { start: s.start, end: s.end };
    const typo = misspelledCommand(s.text);
    if (typo) {
      findings.push({ ...at, end: s.start + (s.text.match(/^[A-Za-z_]+/)?.[0].length ?? 1), message: typo.replace(/`/g, "'"), severity: 'error' });
      continue;
    }
    if (!s.query) continue;
    // With no structure to check against, only the checks that need none are kept (an empty model would call every table unknown).
    const warnings = model ? lintSql(model, s.text) : lintSql(NO_SCHEMA, s.text).filter((w) => /is never true|listed with a comma/.test(w));
    for (const w of warnings) findings.push({ ...at, message: w.replace(/`/g, "'"), severity: 'warning' });
    for (const h of speedHints(model, s.text)) findings.push({ ...at, message: h.replace(/`/g, "'"), severity: 'info' });
  }
  return findings;
}

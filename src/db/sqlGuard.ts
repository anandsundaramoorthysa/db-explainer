import { DbEngine } from '../types';

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const MAX_LENGTH = 20000;

/** Words that mean a statement writes, changes the database, runs code or reads outside it. Checked as whole words. */
const DENIED_WORDS = [
  'insert', 'update', 'delete', 'merge', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'exec', 'execute', 'call',
  'declare', 'use', 'vacuum', 'kill', 'shutdown', 'backup', 'restore', 'load', 'attach', 'detach', 'pragma', 'waitfor',
  'into', 'outfile', 'dumpfile', 'load_file', 'nextval', 'setval', 'set_config', 'pg_sleep', 'pg_read_file', 'pg_read_binary_file',
  'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export', 'dblink', 'xp_cmdshell', 'openrowset', 'opendatasource', 'openquery',
  'rename', 'comment', 'refresh', 'reindex', 'cluster', 'lock', 'unlock', 'handler', 'checkpoint',
];
const DENIED_PHRASES: RegExp[] = [
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i,
  /\block\s+in\s+share\s+mode\b/i,
  /\breplace\s+into\b/i,
  /\bsp_\w+/i,
  /\bxp_\w+/i,
  /\bpg_advisory\w*/i,
  /\bpg_terminate_backend\b|\bpg_cancel_backend\b/i,
];

/**
 * Replaces comments and the contents of strings and quoted names with spaces or empty quotes, so the keywords that are
 * left are the ones that will really be executed. Returns undefined when the SQL contains something that cannot be
 * judged safely (an unterminated string, or a MySQL executable comment).
 */
export function stripLiterals(sql: string, engine: DbEngine): string | undefined {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--' || (c === '#' && engine === 'mysql')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      if (sql[i + 2] === '!') return undefined;
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 2;
        } else if (engine === 'postgres' && sql.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) return undefined;
      i = j;
      out += ' ';
      continue;
    }
    if (c === '$' && engine === 'postgres') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) return undefined;
        out += "''";
        i = end + tag[0].length;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      if (c === '[' && engine !== 'mssql') {
        out += c;
        i += 1;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        const backslash = sql[j] === '\\' && (engine === 'mysql') && c !== '`';
        // MySQL reads \' as an escaped quote unless NO_BACKSLASH_ESCAPES is on, and then it ends the string instead.
        // The guard cannot know the server mode, so it refuses what could be read both ways.
        if (backslash && sql[j + 1] === c) return undefined;
        if (backslash) j += 2;
        else if (sql[j] === close && sql[j + 1] === close && c !== '[') j += 2;
        else if (sql[j] === close) {
          closed = true;
          break;
        } else j += 1;
      }
      if (!closed) return undefined;
      out += c === "'" ? "''" : '_q_';
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function guardReadOnly(sql: string, engine: DbEngine): GuardResult {
  const trimmed = sql.trim().replace(/;+\s*$/, '').trim();
  if (!trimmed) return { ok: false, reason: 'The query is empty.' };
  if (trimmed.length > MAX_LENGTH) return { ok: false, reason: 'The query is too long to run.' };
  const stripped = stripLiterals(trimmed, engine);
  if (stripped === undefined) {
    return { ok: false, reason: 'The query has an unterminated string or an executable comment, so it cannot be checked.' };
  }
  if (stripped.includes(';')) return { ok: false, reason: 'Only one statement can be run at a time.' };
  const words = stripped.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  const first = words[0];
  if (first === 'explain') {
    const inner = words.slice(1).find((w) => !['analyze', 'verbose', 'format', 'json', 'text', 'yaml', 'xml', 'costs', 'buffers', 'extended', 'partitions', 'true', 'false', 'on', 'off', 'query', 'plan', 'for'].includes(w));
    if (inner !== 'select' && inner !== 'with') return { ok: false, reason: 'EXPLAIN is only allowed in front of a SELECT query.' };
  } else if (first !== 'select' && first !== 'with') {
    return { ok: false, reason: `Only SELECT queries can be run, not ${first ? first.toUpperCase() : 'this statement'}.` };
  }
  const denied = words.find((w) => DENIED_WORDS.includes(w));
  if (denied) return { ok: false, reason: `"${denied.toUpperCase()}" is not allowed. Only read-only SELECT queries can be run.` };
  for (const re of DENIED_PHRASES) {
    if (re.test(stripped)) return { ok: false, reason: 'This query uses a feature that is not allowed in read-only mode.' };
  }
  return { ok: true, sql: trimmed };
}

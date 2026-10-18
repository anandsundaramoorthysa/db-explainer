import { DbEngine, QueryLimits, Table } from '../types';
import { Connector, quoteIdent, quoteTable } from './connector';
import { guardReadOnly } from './sqlGuard';

export interface ColumnStats {
  name: string;
  nonNull: number;
  nullPercent: number;
  distinct?: number;
  min?: string;
  max?: string;
}

export interface TableStats {
  key: string;
  rowCount: number;
  columns: ColumnStats[];
}

const MAX_COLUMNS = 30;
const RANGE_TYPES = /(int|dec|numeric|float|double|real|money|serial|date|time|year)/i;
const NO_DISTINCT = /^(text|ntext|image|xml|geography|geometry|blob|clob|json|jsonb|bytea)/i;

/**
 * Counts rows and, per column, how many values are filled, how many are different, and the lowest and highest value
 * for numbers and dates. Text values are never read back, so no real content is exposed. One scan of the table.
 */
export async function profileTable(conn: Connector, engine: DbEngine, table: Table, key: string, limits: QueryLimits): Promise<TableStats> {
  const cols = table.columns.slice(0, MAX_COLUMNS);
  const parts: string[] = ['COUNT(*) AS n'];
  cols.forEach((c, i) => {
    const q = quoteIdent(engine, c.name);
    parts.push(`COUNT(${q}) AS nn${i}`);
    if (!NO_DISTINCT.test(c.dataType)) parts.push(`COUNT(DISTINCT ${q}) AS d${i}`);
    if (RANGE_TYPES.test(c.dataType) && !/char|text/i.test(c.dataType)) parts.push(`MIN(${q}) AS lo${i}`, `MAX(${q}) AS hi${i}`);
  });
  const sql = `SELECT ${parts.join(', ')} FROM ${quoteTable(engine, table)}`;
  const guarded = guardReadOnly(sql, engine);
  if (!guarded.ok) throw new Error(guarded.reason);
  const result = await conn.query(guarded.sql, { maxRows: 1, timeoutMs: limits.timeoutMs });
  const row = result.rows[0] ?? [];
  const at = new Map(result.columns.map((name, i) => [name.toLowerCase(), i]));
  const val = (name: string): unknown => row[at.get(name) ?? -1];
  const total = Number(val('n') ?? 0);
  return {
    key,
    rowCount: total,
    columns: cols.map((c, i) => {
      const nonNull = Number(val(`nn${i}`) ?? 0);
      const distinct = val(`d${i}`);
      const lo = val(`lo${i}`);
      const hi = val(`hi${i}`);
      return {
        name: c.name,
        nonNull,
        nullPercent: total ? Math.round(((total - nonNull) / total) * 100) : 0,
        distinct: distinct === undefined || distinct === null ? undefined : Number(distinct),
        min: lo === undefined || lo === null ? undefined : String(lo),
        max: hi === undefined || hi === null ? undefined : String(hi),
      };
    }),
  };
}

/** One line per table for the prompt, for example: "5 rows; email 0% empty, 5 different; total_amount 399 to 89999". */
export function describeStats(s: TableStats): string {
  const bits = s.columns
    .filter((c) => c.nullPercent > 0 || (c.distinct !== undefined && c.distinct <= 12 && s.rowCount > 12) || c.min !== undefined)
    .slice(0, 14)
    .map((c) => {
      const parts = [`${c.name}`];
      if (c.nullPercent > 0) parts.push(`${c.nullPercent}% empty`);
      if (c.distinct !== undefined && c.distinct <= 12 && s.rowCount > 12) parts.push(`${c.distinct} different values`);
      if (c.min !== undefined && c.max !== undefined) parts.push(`${c.min} to ${c.max}`);
      return parts.join(' ');
    });
  return `exact row count ${s.rowCount.toLocaleString('en-US')}${bits.length ? '; ' + bits.join('; ') : ''}`;
}

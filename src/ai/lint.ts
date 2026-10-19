import { findTable } from '../model/schemaModel';
import { SchemaModel, Table } from '../types';

const NOT_IN = /(?:\b[\w.]+\s+)NOT\s+IN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?(?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?(\w+)[`"\]]?\s+FROM\s+([`"\[\]\w.]+)/gi;
const TABLE_REF = /\b(FROM|JOIN)\s+([`"\[\]\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi;
const NOT_ALIASES = new Set(['on', 'where', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'group', 'order', 'having', 'limit', 'union', 'using', 'natural', 'select', 'except', 'intersect']);
const NAME_COLUMN = /(^|_)(name|title)$/i;

function clean(sql: string): string {
  // Comments and string contents are blanked so text inside them is not mistaken for SQL.
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
}

/** alias (or table name) -> table, for the FROM and JOIN parts of a query. */
function aliases(model: SchemaModel, text: string): Map<string, { table: Table; join: string }> {
  const out = new Map<string, { table: Table; join: string }>();
  for (const m of text.matchAll(TABLE_REF)) {
    const table = findTable(model, m[2]);
    if (!table) continue;
    const alias = m[3] && !NOT_ALIASES.has(m[3].toLowerCase()) ? m[3] : table.name;
    out.set(alias.toLowerCase(), { table, join: m[1].toUpperCase() });
  }
  return out;
}

/**
 * Checks SQL against the structure only and returns warnings in plain language. A small model can ignore the rules it was
 * given, and a developer's own query can have the same mistakes, so the ones that are certain from the schema are caught here.
 * No data is read, and nothing here is sent to the AI.
 */
export function lintSql(model: SchemaModel, sql: string): string[] {
  const text = clean(sql);
  const warnings: string[] = [];

  // NOT IN over a column that allows NULL returns nothing at all.
  for (const m of text.matchAll(NOT_IN)) {
    const table = findTable(model, m[2]);
    const column = table?.columns.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (table && column && column.nullable && !column.isPrimaryKey) {
      warnings.push(`\`${table.name}.${column.name}\` allows NULL, so \`NOT IN\` returns no rows at all if even one value is NULL. Use \`NOT EXISTS\`, or add \`WHERE ${column.name} IS NOT NULL\` inside the subquery.`);
    }
  }

  // The checks below read one SELECT. With subqueries or unions the parts cannot be told apart safely, so they are skipped.
  if ((text.match(/\bselect\b/gi) ?? []).length === 1) {
    const refs = aliases(model, text);
    const where = text.match(/\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|;|$)/i)?.[1] ?? '';

    // A WHERE condition on the right-hand table of a LEFT JOIN throws away the rows the LEFT JOIN kept.
    for (const m of text.matchAll(/\bLEFT\s+(?:OUTER\s+)?JOIN\s+([`"\[\]\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
      const table = findTable(model, m[1]);
      const alias = (m[2] && !NOT_ALIASES.has(m[2].toLowerCase()) ? m[2] : table?.name ?? m[1]).toLowerCase();
      const onRight = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\w+)\\s*(?:=|<>|!=|<=|>=|<|>|\\bLIKE\\b|\\bIN\\b|\\bBETWEEN\\b)`, 'i');
      const antiJoin = new RegExp(`\\b${alias}\\.\\w+\\s+IS\\s+NULL`, 'i');
      const hit = where.match(onRight);
      if (hit && !antiJoin.test(where)) {
        warnings.push(`The WHERE condition on \`${alias}.${hit[1]}\` removes the rows that the LEFT JOIN kept, so this behaves like an INNER JOIN. Move that condition into the \`ON\` clause if you want rows without a match.`);
      }
    }

    // GROUP BY a name merges different people who share it, when the table has a key that is not in the GROUP BY.
    const group = text.match(/\bGROUP\s+BY\b([\s\S]*?)(?=\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|;|$)/i)?.[1];
    if (group) {
      const items = group.split(',').map((s) => s.trim().replace(/[`"\[\]]/g, '').toLowerCase()).filter(Boolean);
      for (const item of items) {
        const [a, col] = item.includes('.') ? item.split('.') : [undefined, item];
        const candidates = a ? [refs.get(a)?.table] : [...refs.values()].map((r) => r.table);
        const table = candidates.find((t) => t?.columns.some((c) => c.name.toLowerCase() === col));
        const column = table?.columns.find((c) => c.name.toLowerCase() === col);
        if (!table || !column || column.isPrimaryKey || column.isUnique || !NAME_COLUMN.test(column.name)) continue;
        const key = table.primaryKey.length === 1 ? table.primaryKey[0] : undefined;
        if (key && !items.some((i) => i === key.toLowerCase() || i.endsWith(`.${key.toLowerCase()}`))) {
          warnings.push(`Grouping by \`${table.name}.${column.name}\` merges different rows that share the same ${column.name}. Group by \`${table.name}.${key}\` as well (or instead) to keep them apart.`);
        }
      }
    }
  }
  return [...new Set(warnings)];
}

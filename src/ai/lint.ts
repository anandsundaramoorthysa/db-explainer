import { findTable } from '../model/schemaModel';
import { SchemaModel, Table } from '../types';

const NOT_IN = /(?:\b[\w.]+\s+)NOT\s+IN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?(?:[`"\[]?\w+[`"\]]?\.)?[`"\[]?(\w+)[`"\]]?\s+FROM\s+([`"\[\]\w.]+)/gi;
const KEYWORDS = ['on', 'where', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'group', 'order', 'having', 'limit', 'union', 'using', 'natural', 'select', 'except', 'intersect'];
const NOT_ALIASES = new Set(KEYWORDS);
// The alias must not be a keyword, otherwise "FROM a JOIN b x" would swallow JOIN as the alias of a and never see b.
const TABLE_REF = new RegExp(String.raw`\b(FROM|JOIN)\s+([` + '`"' + String.raw`\[\]\w.]+)(?:\s+(?:AS\s+)?(?!(?:${KEYWORDS.join('|')})\b)(\w+))?`, 'gi');
const NAME_COLUMN = /(^|_)(name|title)$/i;

/** How many rows of a table have NULL in a column, when the statistics know. Counts only, never values. */
export type NullCounts = (table: Table, column: string) => { nulls: number; rows: number } | undefined;

function clean(sql: string): string {
  // Comments and string contents are blanked so text inside them is not mistaken for SQL.
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
}

type Ref = { table: Table; join: string };

/** alias (or table name) -> table for the FROM and JOIN parts of a query, plus the names that match no table. */
function references(model: SchemaModel, text: string): { found: Map<string, Ref>; missing: string[] } {
  const found = new Map<string, Ref>();
  const missing: string[] = [];
  for (const m of text.matchAll(TABLE_REF)) {
    if (m[2].startsWith('(')) continue;
    const table = findTable(model, m[2]);
    if (!table) {
      missing.push(m[2].replace(/[`"\[\]]/g, ''));
      continue;
    }
    const alias = m[3] && !NOT_ALIASES.has(m[3].toLowerCase()) ? m[3] : table.name;
    found.set(alias.toLowerCase(), { table, join: m[1].toUpperCase() });
  }
  return { found, missing };
}

const has = (t: Table, column: string): boolean => t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase());

/**
 * Checks SQL against the structure only and returns warnings in plain language. A small model can ignore the rules it was
 * given, and a developer's own query can have the same mistakes, so the ones that are certain from the schema are caught here.
 * No row values are read, and nothing here is sent to the AI.
 */
export function lintSql(model: SchemaModel, sql: string, nullCounts?: NullCounts): string[] {
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

  // The checks below read one SELECT. With subqueries, unions or WITH the parts cannot be told apart safely, so they are skipped.
  if ((text.match(/\bselect\b/gi) ?? []).length === 1 && !/^\s*with\b/i.test(text)) {
    const { found: refs, missing } = references(model, text);
    const where = text.match(/\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|;|$)/i)?.[1] ?? '';

    // Names that do not exist: the assistant must never invent them.
    for (const name of missing) warnings.push(`There is no table or view named \`${name}\` in this database.`);
    const undefinedAliases = new Set<string>();
    for (const m of text.matchAll(/(?<![\w.])(\w+)\.(\w+)\b/g)) {
      const ref = refs.get(m[1].toLowerCase());
      if (!ref && !missing.length && !/^\d+$/.test(m[1]) && !findTable(model, m[1])) {
        if (!undefinedAliases.has(m[1].toLowerCase())) warnings.push(`\`${m[1]}\` is used but is not defined in the FROM or JOIN clause. Add it, or use the alias that is defined (${[...refs.keys()].join(', ')}).`);
        undefinedAliases.add(m[1].toLowerCase());
      }
      if (ref && !has(ref.table, m[2])) warnings.push(`\`${ref.table.name}\` has no column named \`${m[2]}\`. Its columns are: ${ref.table.columns.map((c) => c.name).join(', ')}.`);
    }
    if (refs.size === 1 && !missing.length) {
      const only = [...refs.values()][0].table;
      const selectList = text.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)?.[1] ?? '';
      const aliasesDefined = new Set([...selectList.matchAll(/\bAS\s+(\w+)/gi)].map((a) => a[1].toLowerCase()));
      for (const m of where.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*(?:=|<>|!=|<=|>=|<|>|\bLIKE\b|\bIN\b|\bIS\b|\bBETWEEN\b)/gi)) {
        const name = m[1];
        if (/^(and|or|not|null|true|false|exists|case|when|then|else|end|is|in|like|between)$/i.test(name)) continue;
        if (!has(only, name) && !aliasesDefined.has(name.toLowerCase())) warnings.push(`\`${only.name}\` has no column named \`${name}\`. Its columns are: ${only.columns.map((c) => c.name).join(', ')}.`);
      }
    }

    // A join on columns the foreign keys do not link, when the foreign key between the two tables is a different pair of columns.
    for (const m of text.matchAll(/\b(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\b/g)) {
      const a = refs.get(m[1].toLowerCase())?.table;
      const b = refs.get(m[3].toLowerCase())?.table;
      if (!a || !b || a === b) continue;
      const links = [...a.foreignKeys.filter((fk) => fk.refTable.toLowerCase() === b.name.toLowerCase()).map((fk) => ({ from: a, to: b, fk })), ...b.foreignKeys.filter((fk) => fk.refTable.toLowerCase() === a.name.toLowerCase()).map((fk) => ({ from: b, to: a, fk }))];
      if (!links.length) continue;
      const matches = links.some((l) => l.fk.columns.some((c, i) => {
        const x = l.from === a ? m[2] : m[4];
        const y = l.from === a ? m[4] : m[2];
        return c.toLowerCase() === x.toLowerCase() && (l.fk.refColumns[i] ?? '').toLowerCase() === y.toLowerCase();
      }));
      if (!matches) {
        const l = links[0];
        warnings.push(`\`${a.name}.${m[2]} = ${b.name}.${m[4]}\` is not how these tables are linked. The foreign key is \`${l.from.name}.${l.fk.columns.join(', ')}\` -> \`${l.to.name}.${l.fk.refColumns.join(', ')}\`.`);
      }
    }

    // An inner join on a key that has NULLs leaves those rows out without any sign of it.
    if (nullCounts) {
      for (const m of text.matchAll(/(?<!\b(?:LEFT|RIGHT|FULL|OUTER|CROSS)\s+)\bJOIN\s+[`"\[\]\w.]+(?:\s+(?:AS\s+)?\w+)?\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi)) {
        for (const [a, c] of [[m[1], m[2]], [m[3], m[4]]]) {
          const table = refs.get(a.toLowerCase())?.table;
          const column = table?.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
          if (!table || !column || !table.foreignKeys.some((fk) => fk.columns.some((x) => x.toLowerCase() === c.toLowerCase()))) continue;
          const n = nullCounts(table, column.name);
          if (n && n.nulls > 0) warnings.push(`\`${table.name}.${column.name}\` is NULL in ${n.nulls} of ${n.rows} rows, and this inner JOIN leaves those rows out. Use LEFT JOIN if they should be included.`);
        }
      }
    }

    // COUNT(parent.col) after joining a child table repeats each parent once per child row.
    for (const m of text.matchAll(/\bCOUNT\s*\(\s*(?!DISTINCT\b)(?:(\w+)\.)?(\w+)\s*\)/gi)) {
      const owner = m[1] ? refs.get(m[1].toLowerCase())?.table : [...refs.values()].map((r) => r.table).find((t) => has(t, m[2]));
      if (!owner) continue;
      const child = [...refs.values()].map((r) => r.table).find((t) => t !== owner && t.foreignKeys.some((fk) => fk.refTable.toLowerCase() === owner.name.toLowerCase()));
      if (child) {
        const col = `${m[1] ? m[1] + '.' : ''}${m[2]}`;
        warnings.push(`COUNT(${col}) counts \`${owner.name}\` rows once for every matching \`${child.name}\` row, so the number is inflated. Use COUNT(DISTINCT ${col}).`);
      }
    }

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
        const table = candidates.find((t) => t && has(t, col));
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

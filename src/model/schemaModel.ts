import { SchemaModel, Table } from '../types';

export function tableKey(t: Pick<Table, 'schema' | 'name'>): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** Finds a table by plain or schema-qualified name, ignoring case and quoting characters. */
export function findTable(model: SchemaModel, name: string): Table | undefined {
  const wanted = name.replace(/[`"\[\]]/g, '').toLowerCase();
  const exact = model.tables.find((t) => tableKey(t).toLowerCase() === wanted);
  if (exact) return exact;
  const plain = wanted.split('.').pop() as string;
  const matches = model.tables.filter((t) => t.name.toLowerCase() === plain);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface Edge {
  from: string;
  fromColumns: string[];
  to: string;
  toColumns: string[];
  name?: string;
}

/** Every foreign key as a directed edge from the table that holds it to the table it points at. */
export function foreignKeyEdges(model: SchemaModel): Edge[] {
  const edges: Edge[] = [];
  for (const t of model.tables) {
    for (const fk of t.foreignKeys) {
      const target = findTable(model, fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable);
      if (!target) continue;
      edges.push({ from: tableKey(t), fromColumns: fk.columns, to: tableKey(target), toColumns: fk.refColumns, name: fk.name });
    }
  }
  return edges;
}

export function referencedBy(model: SchemaModel, key: string): Edge[] {
  return foreignKeyEdges(model).filter((e) => e.to === key && e.from !== key);
}

export function references(model: SchemaModel, key: string): Edge[] {
  return foreignKeyEdges(model).filter((e) => e.from === key);
}

export interface Hop {
  from: string;
  to: string;
  /** Human readable, for example "orders.customer_id -> customers.id". */
  via: string;
}

/** Shortest chain of foreign keys between two tables, in either direction. Undefined when they are not connected. */
export function shortestPath(model: SchemaModel, fromKey: string, toKey: string): Hop[] | undefined {
  if (fromKey === toKey) return [];
  const edges = foreignKeyEdges(model);
  const neighbours = new Map<string, Array<{ other: string; hop: Hop }>>();
  const add = (a: string, b: string, hop: Hop): void => {
    if (!neighbours.has(a)) neighbours.set(a, []);
    neighbours.get(a)!.push({ other: b, hop });
  };
  for (const e of edges) {
    const text = `${e.from}.${e.fromColumns.join(',')} -> ${e.to}.${e.toColumns.join(',')}`;
    add(e.from, e.to, { from: e.from, to: e.to, via: text });
    add(e.to, e.from, { from: e.to, to: e.from, via: text });
  }
  const previous = new Map<string, { key: string; hop: Hop }>();
  const queue = [fromKey];
  const seen = new Set([fromKey]);
  while (queue.length) {
    const current = queue.shift() as string;
    for (const { other, hop } of neighbours.get(current) ?? []) {
      if (seen.has(other)) continue;
      seen.add(other);
      previous.set(other, { key: current, hop });
      if (other === toKey) {
        const path: Hop[] = [];
        for (let k = toKey; k !== fromKey; ) {
          const p = previous.get(k) as { key: string; hop: Hop };
          path.unshift(p.hop);
          k = p.key;
        }
        return path;
      }
      queue.push(other);
    }
  }
  return undefined;
}

export interface ModelSummary {
  tables: number;
  views: number;
  columns: number;
  foreignKeys: number;
  indexes: number;
}

export function summarize(model: SchemaModel): ModelSummary {
  const tables = model.tables.filter((t) => t.kind === 'table');
  return {
    tables: tables.length,
    views: model.tables.length - tables.length,
    columns: model.tables.reduce((n, t) => n + t.columns.length, 0),
    foreignKeys: model.tables.reduce((n, t) => n + t.foreignKeys.length, 0),
    indexes: model.tables.reduce((n, t) => n + t.indexes.length, 0),
  };
}

export function summaryLine(model: SchemaModel): string {
  const s = summarize(model);
  const parts = [`${s.tables} table${s.tables === 1 ? '' : 's'}`];
  if (s.views) parts.push(`${s.views} view${s.views === 1 ? '' : 's'}`);
  parts.push(`${s.columns} columns`, `${s.foreignKeys} foreign keys`);
  return parts.join(', ');
}

function formatCount(n: number | undefined, estimate?: boolean): string {
  if (n === undefined) return '';
  return `${estimate ? '~' : ''}${n.toLocaleString('en-US')} rows`;
}

/** Compact text description of one table, used both in prompts and in tooltips. */
export function describeTable(model: SchemaModel, t: Table): string {
  const key = tableKey(t);
  const header = [`${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${key}`];
  const count = formatCount(t.rowCount, t.rowCountIsEstimate);
  if (count) header.push(`(${count})`);
  if (t.comment) header.push(`-- ${t.comment}`);
  const lines = [header.join(' ')];
  const fkByColumn = new Map<string, string>();
  for (const fk of t.foreignKeys) {
    fk.columns.forEach((c, i) => fkByColumn.set(c, `${fk.refTable}.${fk.refColumns[i] ?? fk.refColumns[0] ?? '?'}${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}`));
  }
  for (const c of t.columns) {
    const flags: string[] = [];
    if (c.isPrimaryKey) flags.push('PK');
    if (c.isAutoIncrement) flags.push('AUTO');
    if (!c.nullable && !c.isPrimaryKey) flags.push('NOT NULL');
    if (c.isUnique && !c.isPrimaryKey) flags.push('UNIQUE');
    if (c.defaultValue !== undefined) flags.push(`DEFAULT ${c.defaultValue}`);
    const fk = fkByColumn.get(c.name);
    if (fk) flags.push(`-> ${fk}`);
    if (c.comment) flags.push(`-- ${c.comment}`);
    lines.push(`  ${c.name} ${c.dataType}${flags.length ? ' ' + flags.join(' ') : ''}`);
  }
  if (t.primaryKey.length > 1) lines.push(`  primary key: (${t.primaryKey.join(', ')})`);
  const extraIndexes = t.indexes.filter((i) => !(i.columns.length === 1 && t.primaryKey.length === 1 && i.columns[0] === t.primaryKey[0]));
  if (extraIndexes.length) lines.push(`  indexes: ${extraIndexes.map((i) => `${i.name}(${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`).join('; ')}`);
  if (t.checks.length) lines.push(`  checks: ${t.checks.map((c) => c.expression).join('; ')}`);
  const incoming = referencedBy(model, key);
  if (incoming.length) lines.push(`  referenced by: ${incoming.map((e) => `${e.from}.${e.fromColumns.join(',')}`).join(', ')}`);
  if (t.kind === 'view' && t.definition) lines.push(`  definition: ${t.definition.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  return lines.join('\n');
}

/** One short line per table, so the AI always knows every table that exists. */
export function overviewLine(t: Table): string {
  const shown = t.columns.slice(0, 8).map((c) => c.name).join(', ');
  const more = t.columns.length > 8 ? `, ... ${t.columns.length - 8} more` : '';
  return `${tableKey(t)}${t.kind === 'view' ? ' (view)' : ''}(${shown}${more})`;
}

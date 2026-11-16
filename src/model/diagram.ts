import { ENGINE_LABEL, SchemaModel, Table } from '../types';
import { foreignKeyEdges, tableKey } from './schemaModel';

/* The table diagram: where each box goes, and the same picture as Mermaid text for documents. No vscode import. */

export interface DiagramColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

export interface DiagramNode {
  key: string;
  kind: 'table' | 'view';
  x: number;
  y: number;
  w: number;
  h: number;
  columns: DiagramColumn[];
  /** Columns left out to keep the box small. */
  more: number;
  rows?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
}

export interface DiagramLayout {
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
}

export const HEADER = 30;
export const ROW = 18;
const PAD = 8;
const GAP_X = 90;
const GAP_Y = 28;
const MAX_COLUMNS = 12;

function sizeOf(t: Table, columns: DiagramColumn[], more: number): { w: number; h: number } {
  const longest = Math.max(tableKey(t).length + 10, ...columns.map((c) => c.name.length + c.type.length + 6));
  return { w: Math.min(320, Math.max(170, Math.round(longest * 7.2) + 24)), h: HEADER + (columns.length + (more ? 1 : 0)) * ROW + PAD };
}

/**
 * Tables that others point at sit on the left, and the tables pointing at them to the right, so links mostly run one way.
 * Within a column, tables are ordered by where the tables they point at are, which keeps lines from crossing. Tables with no
 * links at all go in a last column of their own.
 */
export function layoutDiagram(model: SchemaModel): DiagramLayout {
  const edges = foreignKeyEdges(model);
  const keys = model.tables.map(tableKey);
  const linked = new Set(edges.flatMap((e) => (e.from === e.to ? [] : [e.from, e.to])));
  const level = new Map(keys.map((k) => [k, 0]));
  // Longest path from a table nobody points at. A loop stops growing after one pass per table.
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (e.from === e.to) continue;
      const want = (level.get(e.to) ?? 0) + 1;
      if (want > (level.get(e.from) ?? 0) && want < keys.length) {
        level.set(e.from, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Then pull each table right, up to just left of the nearest table pointing at it, so a line does not pass behind another box.
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const k of keys) {
      const from = edges.filter((e) => e.to === k && e.from !== k).map((e) => level.get(e.from) ?? 0);
      if (!from.length) continue;
      const want = Math.min(...from) - 1;
      if (want > (level.get(k) ?? 0)) {
        level.set(k, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const lonely = keys.filter((k) => !linked.has(k));
  const deepest = Math.max(0, ...keys.filter((k) => linked.has(k)).map((k) => level.get(k) ?? 0));
  for (const k of lonely) level.set(k, linked.size ? deepest + 1 : 0);

  const fkColumns = new Map(model.tables.map((t) => [tableKey(t), new Set(t.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())))]));
  const nodes = new Map<string, DiagramNode>();
  for (const t of model.tables) {
    const key = tableKey(t);
    const all = t.columns.map((c) => ({ name: c.name, type: c.dataType, pk: c.isPrimaryKey, fk: fkColumns.get(key)?.has(c.name.toLowerCase()) ?? false }));
    // Keys first, so the columns that explain the lines are never the ones cut off.
    const ordered = [...all.filter((c) => c.pk || c.fk), ...all.filter((c) => !c.pk && !c.fk)];
    const shown = ordered.slice(0, MAX_COLUMNS);
    const more = ordered.length - shown.length;
    const { w, h } = sizeOf(t, shown, more);
    const rows = t.rowCount === undefined ? undefined : `${t.rowCountIsEstimate ? '~' : ''}${t.rowCount.toLocaleString('en-US')} rows`;
    nodes.set(key, { key, kind: t.kind, x: 0, y: 0, w, h, columns: shown, more, ...(rows ? { rows } : {}) });
  }

  const columns: string[][] = [];
  for (const k of keys) (columns[level.get(k) ?? 0] ??= []).push(k);
  let x = 0;
  let height = 0;
  const placedY = new Map<string, number>();
  columns.forEach((col, i) => {
    if (!col?.length) return;
    const centre = (k: string): number => {
      const targets = edges.filter((e) => e.from === k && e.to !== k && placedY.has(e.to)).map((e) => placedY.get(e.to)!);
      return targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : Number.MAX_SAFE_INTEGER;
    };
    const ordered = i === 0 ? [...col].sort((a, b) => edges.filter((e) => e.to === b).length - edges.filter((e) => e.to === a).length || a.localeCompare(b)) : [...col].sort((a, b) => centre(a) - centre(b) || a.localeCompare(b));
    let y = 0;
    let widest = 0;
    for (const k of ordered) {
      const n = nodes.get(k)!;
      n.x = x;
      n.y = y;
      placedY.set(k, y + n.h / 2);
      y += n.h + GAP_Y;
      widest = Math.max(widest, n.w);
    }
    height = Math.max(height, y - GAP_Y);
    x += widest + GAP_X;
  });

  return {
    title: `${model.name} (${ENGINE_LABEL[model.engine]})`,
    nodes: keys.map((k) => nodes.get(k)!),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.fromColumns.join(', ') })),
    width: Math.max(0, x - GAP_X),
    height,
  };
}

const ident = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');

/** The same tables and links as a Mermaid ER diagram, which GitHub and many wikis draw from text. */
export function mermaidEr(model: SchemaModel): string {
  const lines = ['erDiagram'];
  const fkCols = (t: Table): Set<string> => new Set(t.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())));
  for (const t of model.tables) {
    const fks = fkCols(t);
    lines.push(`  ${ident(tableKey(t))} {`);
    for (const c of t.columns) {
      const marks = [c.isPrimaryKey ? 'PK' : '', fks.has(c.name.toLowerCase()) ? 'FK' : ''].filter(Boolean).join(', ');
      lines.push(`    ${ident(c.dataType.split('(')[0] || 'unknown')} ${ident(c.name)}${marks ? ' ' + marks : ''}`);
    }
    lines.push('  }');
  }
  for (const t of model.tables) {
    for (const fk of t.foreignKeys) {
      const target = model.tables.find((x) => x.name.toLowerCase() === fk.refTable.toLowerCase() && (!fk.refSchema || x.schema?.toLowerCase() === fk.refSchema.toLowerCase()));
      if (!target) continue;
      const optional = fk.columns.some((c) => t.columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.nullable);
      lines.push(`  ${ident(tableKey(target))} ${optional ? '|o' : '||'}--o{ ${ident(tableKey(t))} : "${fk.columns.join(', ').replace(/"/g, "'")}"`);
    }
  }
  return lines.join('\n');
}

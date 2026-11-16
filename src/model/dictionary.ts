import { ENGINE_LABEL, SchemaModel, Table } from '../types';
import { mermaidEr } from './diagram';
import { referencedBy, references, tableKey } from './schemaModel';

/* A Markdown page describing every table, made only from the structure and the team notes. No AI and no row values. */

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** GitHub's anchor for a heading. */
export function anchor(heading: string): string {
  return heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

/** The bullet lines under "## <table>" in the notes file. */
export function notesFor(notes: string, table: string): string[] {
  const lines = notes.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    if (l.trim()) out.push(l.replace(/^\s*[-*]\s*/, ''));
  }
  return out;
}

function tableSection(model: SchemaModel, t: Table, notes: string): string {
  const key = tableKey(t);
  const out = [`## ${key}`, ''];
  const facts = [t.kind === 'view' ? 'View' : 'Table', t.rowCount === undefined ? '' : `${t.rowCountIsEstimate ? 'about ' : ''}${t.rowCount.toLocaleString('en-US')} rows`].filter(Boolean);
  out.push(`_${facts.join(', ')}_`, '');
  if (t.comment) out.push(t.comment, '');
  const team = notesFor(notes, t.name);
  if (team.length) out.push('**Team notes**', '', ...team.map((n) => `- ${n}`), '');
  const fkCols = new Map(t.foreignKeys.flatMap((f) => f.columns.map((c, i) => [c.toLowerCase(), `${f.refTable}.${f.refColumns[i] ?? ''}`] as const)));
  const indexed = new Set(t.indexes.flatMap((i) => i.columns.map((c) => c.toLowerCase())));
  out.push('| Column | Type | Null | Key | Default | Description |', '|---|---|---|---|---|---|');
  for (const c of t.columns) {
    const keyParts = [c.isPrimaryKey ? 'PK' : '', fkCols.has(c.name.toLowerCase()) ? `FK → ${fkCols.get(c.name.toLowerCase())}` : '', c.isUnique && !c.isPrimaryKey ? 'unique' : '', !c.isPrimaryKey && indexed.has(c.name.toLowerCase()) ? 'indexed' : '', c.isAutoIncrement ? 'auto' : ''].filter(Boolean);
    out.push(`| \`${cell(c.name)}\` | ${cell(c.dataType)} | ${c.nullable ? 'yes' : 'no'} | ${cell(keyParts.join(', '))} | ${c.defaultValue ? `\`${cell(c.defaultValue)}\`` : ''} | ${cell(c.comment)} |`);
  }
  out.push('');
  const to = references(model, key);
  const from = referencedBy(model, key);
  if (to.length) out.push(`**Links to:** ${to.map((e) => `[${e.to}](#${anchor(e.to)}) (\`${e.fromColumns.join(', ')}\`)`).join(', ')}`, '');
  if (from.length) out.push(`**Linked from:** ${from.map((e) => `[${e.from}](#${anchor(e.from)}) (\`${e.fromColumns.join(', ')}\`)`).join(', ')}`, '');
  if (t.indexes.length) out.push(`**Indexes:** ${t.indexes.map((i) => `\`${cell(i.name)}\` (${i.columns.join(', ')}${i.unique ? ', unique' : ''})`).join('; ')}`, '');
  if (t.checks.length) out.push(`**Checks:** ${t.checks.map((c) => `\`${cell(c.expression)}\``).join('; ')}`, '');
  if (t.definition) out.push('**Definition**', '', '```sql', t.definition.trim(), '```', '');
  return out.join('\n');
}

export function dataDictionary(model: SchemaModel, notes = '', now = new Date()): string {
  const tables = model.tables.filter((t) => t.kind === 'table');
  const views = model.tables.filter((t) => t.kind === 'view');
  const out = [
    `# ${model.name}: data dictionary`,
    '',
    `${ENGINE_LABEL[model.engine]} · ${tables.length} table${tables.length === 1 ? '' : 's'}, ${views.length} view${views.length === 1 ? '' : 's'} · made ${now.toISOString().slice(0, 10)} by DB Explainer from the structure${notes.trim() ? ' and the team notes' : ''}. No row values are included.`,
    '',
    '## Contents',
    '',
    ...model.tables.map((t) => `- [${tableKey(t)}](#${anchor(tableKey(t))})${t.kind === 'view' ? ' (view)' : ''}`),
    '',
    '## Diagram',
    '',
    '```mermaid',
    mermaidEr(model),
    '```',
    '',
  ];
  for (const t of model.tables) out.push(tableSection(model, t, notes));
  if (model.routines.length) {
    out.push('## Procedures, functions and triggers', '');
    for (const r of model.routines) out.push(`- \`${r.schema ? r.schema + '.' : ''}${r.name}\` (${r.kind}${r.table ? ` on ${r.table}` : ''})`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

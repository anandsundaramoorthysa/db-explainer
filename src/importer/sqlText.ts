import { Parser } from 'node-sql-parser';
import { DbEngine, SchemaModel, Table, emptyColumn, emptyTable, Column, ForeignKey } from '../types';
import { findTable } from '../model/schemaModel';

/* The parser's syntax trees have a different shape per dialect, so they are handled as loosely typed data here. */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Statement {
  text: string;
  /** 1-based line where the statement starts. */
  line: number;
}

export interface ImportResult {
  model: SchemaModel;
  /** SELECT statements found in the text. These are queries to explain, not schema. */
  queries: string[];
  statementCount: number;
  skipped: Array<{ line: number; reason: string; text: string }>;
}

const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main']);
const PARSER = new Parser();

/** Splits SQL text on semicolons while respecting strings, quoted names, comments and $$ blocks. Also drops T-SQL GO lines. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let current = '';
  let startLine = 1;
  let line = 1;
  let i = 0;
  let began = false;
  const push = (): void => {
    const text = current.trim();
    if (text) out.push({ text, line: startLine });
    current = '';
    began = false;
  };
  const begin = (): void => {
    if (!began) {
      startLine = line;
      began = true;
    }
  };
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === '\n') line += 1;
    if (two === '--' || (c === '#' && !began)) {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      begin();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && c !== '`') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      const chunk = sql.slice(i, j + 1);
      line += (chunk.match(/\n/g) ?? []).length;
      current += chunk;
      i = j + 1;
      continue;
    }
    if (c === '[') {
      begin();
      const end = sql.indexOf(']', i);
      const stop = end < 0 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      begin();
      const tag = (sql.slice(i).match(/^\$[A-Za-z_]*\$/) as RegExpMatchArray)[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      push();
      i += 1;
      continue;
    }
    if (c === '\n' && /^\s*GO\s*$/i.test(current.split('\n').pop() as string)) {
      current = current.slice(0, current.lastIndexOf('\n') + 1);
      push();
      i += 1;
      continue;
    }
    if (c.trim()) begin();
    current += c;
    i += 1;
  }
  if (/^\s*GO\s*$/i.test(current)) current = '';
  push();
  return out;
}

/** Guesses which database the SQL was written for from characteristic keywords. */
export function detectEngine(sql: string): DbEngine {
  const score: Record<DbEngine, number> = { mysql: 0, postgres: 0, mssql: 0, sqlite: 0 };
  const count = (re: RegExp): number => (sql.match(re) ?? []).length;
  score.mysql += count(/\bAUTO_INCREMENT\b/gi) * 3 + count(/`/g) + count(/\bENGINE\s*=/gi) * 3 + count(/\bUNSIGNED\b/gi) + count(/\bTINYINT\b/gi);
  score.postgres += count(/\b(BIG|SMALL)?SERIAL\b/gi) * 3 + count(/::/g) * 2 + count(/\bRETURNING\b/gi) + count(/\bTIMESTAMPTZ\b/gi) * 2 + count(/\bGENERATED\b.*\bIDENTITY\b/gi) * 2 + count(/\bpublic\./gi);
  score.mssql += count(/\bIDENTITY\s*\(/gi) * 3 + count(/\[\w[\w ]*\]/g) * 2 + count(/\bNVARCHAR\b/gi) + count(/^\s*GO\s*$/gim) * 3 + count(/\bdbo\./gi) * 2 + count(/\bUNIQUEIDENTIFIER\b/gi);
  score.sqlite += count(/\bAUTOINCREMENT\b/gi) * 3 + count(/\bPRAGMA\b/gi) * 2 + count(/\bWITHOUT\s+ROWID\b/gi) * 3;
  const best = (Object.keys(score) as DbEngine[]).sort((a, b) => score[b] - score[a])[0];
  return score[best] > 0 ? best : 'mysql';
}

/** Rewrites T-SQL into a form the generic parser understands. Only structure matters here, never the data types' exact spelling. */
export function normalizeTsql(sql: string): string {
  return sql
    .replace(/\[([^\]]+)\]/g, '`$1`')
    .replace(/\bIDENTITY(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, '')
    .replace(/\bN?VARCHAR\s*\(\s*MAX\s*\)/gi, 'TEXT')
    .replace(/\bVARBINARY\s*\(\s*MAX\s*\)/gi, 'BLOB')
    .replace(/\bNVARCHAR\b/gi, 'VARCHAR')
    .replace(/\bNCHAR\b/gi, 'CHAR')
    .replace(/\bNTEXT\b/gi, 'TEXT')
    .replace(/\bUNIQUEIDENTIFIER\b/gi, 'CHAR(36)')
    .replace(/\b(DATETIME2|SMALLDATETIME|DATETIMEOFFSET)(\s*\(\s*\d+\s*\))?/gi, 'DATETIME')
    .replace(/\bMONEY\b/gi, 'DECIMAL(19,4)')
    .replace(/\bBIT\b/gi, 'TINYINT(1)')
    .replace(/\bXML\b/gi, 'TEXT')
    .replace(/\bNONCLUSTERED\b|\bCLUSTERED\b/gi, '')
    .replace(/\bON\s+`?PRIMARY`?/gi, '')
    .replace(/\bWITH\s*\([^)]*\)/gi, '');
}

/** Names of columns declared with IDENTITY, which normalizeTsql removes so the parser accepts the statement. */
export function identityColumns(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\[([^\]]+)\]|`([^`]+)`|\b(\w+)\b)\s+(?:\[[^\]]+\]|\w+)(?:\s*\([^)]*\))?\s+IDENTITY\b/gi;
  for (const m of sql.matchAll(re)) names.add(m[1] ?? m[2] ?? m[3]);
  return names;
}

/** The T-SQL type written for each column, so the original names (NVARCHAR, BIT, MONEY) survive normalization. */
export function tsqlColumnTypes(sql: string): Map<string, string> {
  const types = new Map<string, string>();
  const re = /(?:\[([^\]]+)\]|`([^`]+)`)\s+\[?(\w+)\]?(\s*\(\s*(?:\d+|MAX)\s*(?:,\s*\d+\s*)?\))?/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (!types.has(name) && !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY|INDEX)$/i.test(m[3])) {
      types.set(name, (m[3] + (m[4] ? m[4].replace(/\s+/g, '') : '')).toUpperCase());
    }
  }
  return types;
}

const DIALECT_ORDER = ['mysql', 'postgresql', 'sqlite'] as const;

function dialectFor(engine: DbEngine): string {
  return engine === 'postgres' ? 'postgresql' : engine === 'sqlite' ? 'sqlite' : 'mysql';
}

function parseStatement(text: string, engine: DbEngine): any[] | undefined {
  const normalized = engine === 'mssql' ? normalizeTsql(text) : text;
  const first = dialectFor(engine);
  const order = [first, ...DIALECT_ORDER.filter((d) => d !== first)];
  for (const database of order) {
    try {
      const ast = PARSER.astify(normalized, { database });
      return Array.isArray(ast) ? ast : [ast];
    } catch {
      // try the next dialect
    }
  }
  return undefined;
}

/* ---- helpers for the loosely typed syntax trees ---- */

function nameOf(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node.column !== 'undefined') return nameOf(node.column);
  if (node.expr) return nameOf(node.expr);
  if (typeof node.value !== 'undefined') return String(node.value);
  if (typeof node.table === 'string') return node.table;
  return '';
}

function tableRef(t: any): { schema?: string; name: string } {
  const ref = Array.isArray(t) ? t[0] : t;
  const db = ref?.db ?? undefined;
  return { schema: db && !DEFAULT_SCHEMAS.has(String(db).toLowerCase()) ? String(db) : undefined, name: nameOf(ref?.table ?? ref?.view ?? ref) };
}

function literal(node: any): string {
  if (node == null) return '';
  if (node.type === 'function') return `${nameOf(node.name?.name?.[0] ?? node.name)}()`;
  if (node.type === 'single_quote_string' || node.type === 'string') return `'${node.value}'`;
  if (node.type === 'bool') return String(node.value).toUpperCase();
  if (node.type === 'null') return 'NULL';
  if (node.value !== undefined && typeof node.value === 'object') return literal(node.value);
  return String(node.value ?? '');
}

function exprText(node: any): string {
  if (node == null) return '';
  if (node.type === 'binary_expr') return `${exprText(node.left)} ${node.operator} ${exprText(node.right)}`;
  if (node.type === 'column_ref') return nameOf(node);
  if (node.type === 'expr_list') return `(${(node.value ?? []).map(exprText).join(', ')})`;
  if (node.type === 'function') return `${nameOf(node.name?.name?.[0] ?? node.name)}(${(node.args?.value ?? []).map(exprText).join(', ')})`;
  return literal(node);
}

function dataType(def: any): string {
  if (!def) return 'unknown';
  let t = String(def.dataType ?? def.type ?? 'unknown').toUpperCase();
  if (def.length !== undefined && def.length !== null) t += `(${def.length}${def.scale !== undefined ? ',' + def.scale : ''})`;
  if (Array.isArray(def.expr?.value)) t += `(${def.expr.value.map(literal).join(', ')})`;
  if (Array.isArray(def.suffix) && def.suffix.length) t += ' ' + def.suffix.map((s: any) => String(s).toUpperCase()).join(' ');
  return t;
}

function foreignKeyFrom(columns: string[], ref: any, name?: string): ForeignKey {
  const target = tableRef(ref.table);
  const actions: Record<string, string> = {};
  for (const a of ref.on_action ?? []) actions[String(a.type).toLowerCase()] = String(a.value?.value ?? a.value ?? '').toUpperCase();
  return {
    name,
    columns,
    refSchema: target.schema,
    refTable: target.name,
    refColumns: (ref.definition ?? []).map(nameOf),
    onDelete: actions['on delete'],
    onUpdate: actions['on update'],
  };
}

function columnFrom(def: any, table: Table): Column {
  const c = emptyColumn(nameOf(def.column));
  c.dataType = dataType(def.definition);
  const type = c.dataType.toUpperCase();
  c.isPrimaryKey = !!def.primary_key;
  c.nullable = !(def.nullable?.type === 'not null') && !c.isPrimaryKey;
  c.isUnique = !!def.unique;
  c.isAutoIncrement = !!def.auto_increment || /^(BIG|SMALL)?SERIAL/.test(type);
  if (def.default_val) c.defaultValue = literal(def.default_val.value);
  const comment = def.comment?.value;
  if (comment) c.comment = String(comment.value ?? comment);
  if (def.reference_definition) table.foreignKeys.push(foreignKeyFrom([c.name], def.reference_definition));
  if (def.check?.definition || def.check) {
    const expr = def.check?.definition?.[0] ?? def.check;
    if (expr) table.checks.push({ expression: exprText(expr) });
  }
  return c;
}

function mark(table: Table): void {
  for (const c of table.columns) {
    if (table.primaryKey.includes(c.name)) {
      c.isPrimaryKey = true;
      c.nullable = false;
    }
  }
}

function addIndex(table: Table, name: string | undefined, columns: string[], unique: boolean): void {
  if (!columns.length) return;
  table.indexes.push({ name: name || `${table.name}_${columns.join('_')}`, columns, unique });
  if (unique && columns.length === 1) {
    const col = table.columns.find((c) => c.name === columns[0]);
    if (col) col.isUnique = true;
  }
}

function applyConstraint(table: Table, d: any): boolean {
  const type = String(d.constraint_type ?? '').toLowerCase();
  const cols = (d.definition ?? []).map(nameOf).filter(Boolean);
  if (type === 'primary key') {
    table.primaryKey = cols;
    mark(table);
    return true;
  }
  if (type.startsWith('unique')) {
    addIndex(table, d.index || d.constraint || undefined, cols, true);
    return true;
  }
  if (type === 'foreign key') {
    if (d.reference_definition) table.foreignKeys.push(foreignKeyFrom(cols, d.reference_definition, d.constraint || undefined));
    return true;
  }
  if (type === 'check') {
    table.checks.push({ name: d.constraint || undefined, expression: (d.definition ?? []).map(exprText).join(' ') });
    return true;
  }
  return false;
}

function tableComment(options: any): string | undefined {
  for (const o of options ?? []) {
    if (String(o.keyword).toLowerCase() === 'comment') return String(o.value).replace(/^'|'$/g, '');
  }
  return undefined;
}

export function importSql(text: string, label = 'Shared SQL'): ImportResult {
  const engine = detectEngine(text);
  const model: SchemaModel = { engine, name: label, source: 'sql', tables: [], routines: [], capturedAt: new Date().toISOString(), warnings: [] };
  const queries: string[] = [];
  const skipped: ImportResult['skipped'] = [];
  const statements = splitStatements(text);

  const skip = (s: Statement, reason: string): void => {
    skipped.push({ line: s.line, reason, text: s.text.replace(/\s+/g, ' ').slice(0, 100) });
  };

  for (const s of statements) {
    const ast = parseStatement(s.text, engine);
    if (!ast) {
      skip(s, 'could not be parsed');
      continue;
    }
    const hints: Hints = engine === 'mssql' ? { autoCols: identityColumns(s.text), types: tsqlColumnTypes(s.text) } : { autoCols: new Set(), types: new Map() };
    for (const node of ast) {
      try {
        const handled = apply(model, node, s, queries, hints);
        if (!handled) skip(s, `${String(node.type).toUpperCase()} statements are not part of the schema`);
      } catch {
        skip(s, 'could not be applied');
      }
    }
  }
  for (const t of model.tables) mark(t);
  const structural = skipped.filter((k) => /parsed|applied/.test(k.reason));
  if (structural.length) {
    model.warnings.push(`${structural.length} statement${structural.length === 1 ? '' : 's'} could not be read and ${structural.length === 1 ? 'was' : 'were'} left out, first at line ${structural[0].line}.`);
  }
  return { model, queries, statementCount: statements.length, skipped };
}

interface Hints {
  autoCols: Set<string>;
  types: Map<string, string>;
}

function withHints(col: Column, hints: Hints): Column {
  if (hints.autoCols.has(col.name)) col.isAutoIncrement = true;
  const original = hints.types.get(col.name);
  if (original) col.dataType = original;
  return col;
}

function apply(model: SchemaModel, node: any, s: Statement, queries: string[], hints: Hints): boolean {
  if (node.type === 'select') {
    queries.push(s.text);
    return true;
  }
  if (node.type === 'create' && node.keyword === 'table') {
    const ref = tableRef(node.table);
    const table = emptyTable(ref.name, ref.schema);
    table.comment = tableComment(node.table_options);
    for (const d of node.create_definitions ?? []) {
      if (d.resource === 'column') {
        table.columns.push(withHints(columnFrom(d, table), hints));
      }
      else if (d.resource === 'constraint') applyConstraint(table, d);
      else if (d.resource === 'index') addIndex(table, d.index, (d.definition ?? []).map(nameOf), String(d.keyword).toLowerCase() === 'unique');
    }
    mark(table);
    for (const c of table.columns) if (c.isPrimaryKey && !table.primaryKey.includes(c.name)) table.primaryKey.push(c.name);
    model.tables = model.tables.filter((t) => !(t.name === table.name && t.schema === table.schema));
    model.tables.push(table);
    return true;
  }
  if (node.type === 'create' && node.keyword === 'index') {
    const ref = tableRef(node.table);
    const table = findTable(model, ref.schema ? `${ref.schema}.${ref.name}` : ref.name);
    if (!table) {
      model.warnings.push(`An index was created on ${ref.name}, which is not defined in the shared SQL.`);
      return true;
    }
    addIndex(table, nameOf(node.index), (node.index_columns ?? []).map(nameOf), String(node.index_type).toLowerCase() === 'unique');
    return true;
  }
  if (node.type === 'create' && node.keyword === 'view') {
    const ref = tableRef(node.view);
    const view = emptyTable(ref.name, ref.schema);
    view.kind = 'view';
    view.definition = (s.text.match(/\bAS\b([\s\S]*)$/i)?.[1] ?? '').trim();
    const cols = Array.isArray(node.select?.columns) ? node.select.columns : [];
    for (const c of cols) {
      const n = c.as || nameOf(c.expr);
      if (n && n !== '*') view.columns.push(emptyColumn(n));
    }
    model.tables = model.tables.filter((t) => !(t.name === view.name && t.schema === view.schema));
    model.tables.push(view);
    return true;
  }
  if (node.type === 'alter') {
    const ref = tableRef(node.table);
    const table = findTable(model, ref.schema ? `${ref.schema}.${ref.name}` : ref.name);
    if (!table) {
      model.warnings.push(`ALTER TABLE ${ref.name} was ignored because the table is not defined in the shared SQL.`);
      return true;
    }
    let all = true;
    for (const e of node.expr ?? []) {
      const action = String(e.action).toLowerCase();
      if (action === 'add' && e.resource === 'column') {
        table.columns.push(withHints(columnFrom(e, table), hints));
      } else if (action === 'add' && e.create_definitions) {
        if (e.resource === 'index') addIndex(table, e.create_definitions.index, (e.create_definitions.definition ?? []).map(nameOf), false);
        else if (!applyConstraint(table, e.create_definitions)) all = false;
      } else if (action === 'drop' && e.resource === 'column') {
        const name = nameOf(e.column);
        table.columns = table.columns.filter((c) => c.name !== name);
        table.primaryKey = table.primaryKey.filter((c) => c !== name);
      } else if ((action === 'modify' || action === 'change' || action === 'alter') && e.resource === 'column' && e.definition) {
        const updated = columnFrom(e, table);
        const at = table.columns.findIndex((c) => c.name === (nameOf(e.old_column) || updated.name));
        if (at >= 0) table.columns[at] = updated;
        else table.columns.push(updated);
      } else {
        all = false;
      }
    }
    mark(table);
    if (!all) model.warnings.push(`Some changes in ALTER TABLE ${ref.name} are not applied to the model.`);
    return true;
  }
  if (node.type === 'drop' && (node.keyword === 'table' || node.keyword === 'view')) {
    for (const n of node.name ?? []) {
      const ref = tableRef(n);
      model.tables = model.tables.filter((t) => !(t.name === ref.name && (t.schema ?? '') === (ref.schema ?? '')));
    }
    return true;
  }
  return false;
}

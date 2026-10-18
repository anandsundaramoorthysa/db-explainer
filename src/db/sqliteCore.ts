/* The SQLite engine (sql.js, a WebAssembly build) runs in a worker thread so a slow query can be stopped.
   This file holds the code that runs inside that worker and is also used directly by tests. */
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';
import { Column, ForeignKey, IndexInfo, Routine, SchemaModel, Table, emptyColumn, emptyTable } from '../types';

export interface SqliteRequest {
  op: 'introspect' | 'query';
  filePath: string;
  wasmDir: string;
  sql?: string;
  maxRows?: number;
}

export interface SqliteReply {
  ok: boolean;
  error?: string;
  model?: SchemaModel;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
}

async function open(req: SqliteRequest): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(req.wasmDir, f) });
  // The file is copied into memory, so the original can never be changed, whatever the query does.
  const db = new SQL.Database(fs.readFileSync(req.filePath));
  db.run('PRAGMA query_only = ON');
  return db;
}

function all(db: Database, sql: string, params: Array<string | number> = []): Array<Record<string, any>> {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Array<Record<string, any>> = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const quote = (name: string): string => '"' + name.replace(/"/g, '""') + '"';

function introspect(db: Database, filePath: string): SchemaModel {
  const model: SchemaModel = {
    engine: 'sqlite',
    name: path.basename(filePath),
    source: 'live',
    tables: [],
    routines: [],
    capturedAt: new Date().toISOString(),
    warnings: [],
  };
  const objects = all(db, "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const o of objects) {
    const t: Table = emptyTable(String(o.name));
    t.kind = o.type === 'view' ? 'view' : 'table';
    if (t.kind === 'view') t.definition = String(o.sql ?? '').replace(/^[\s\S]*?\bAS\b/i, '').trim();
    const info = all(db, `PRAGMA table_info(${quote(t.name)})`);
    const pkCols = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
    t.primaryKey = pkCols.map((c) => String(c.name));
    for (const c of info) {
      const col: Column = emptyColumn(String(c.name));
      col.dataType = String(c.type || 'ANY');
      col.isPrimaryKey = Number(c.pk) > 0;
      col.nullable = Number(c.notnull) === 0 && !col.isPrimaryKey;
      if (c.dflt_value !== null && c.dflt_value !== undefined) col.defaultValue = String(c.dflt_value);
      // A single INTEGER PRIMARY KEY is an alias of the row id, so the database assigns it.
      col.isAutoIncrement = col.isPrimaryKey && pkCols.length === 1 && /^INTEGER$/i.test(col.dataType);
      t.columns.push(col);
    }
    const fks = new Map<number, ForeignKey>();
    for (const f of all(db, `PRAGMA foreign_key_list(${quote(t.name)})`)) {
      const id = Number(f.id);
      if (!fks.has(id)) fks.set(id, { columns: [], refTable: String(f.table), refColumns: [], onDelete: noAction(f.on_delete), onUpdate: noAction(f.on_update) });
      const fk = fks.get(id) as ForeignKey;
      fk.columns.push(String(f.from));
      fk.refColumns.push(String(f.to ?? 'rowid'));
    }
    t.foreignKeys = [...fks.values()];
    if (t.kind === 'table') {
      for (const ix of all(db, `PRAGMA index_list(${quote(t.name)})`)) {
        const cols = all(db, `PRAGMA index_info(${quote(String(ix.name))})`).map((c) => String(c.name));
        if (String(ix.origin) === 'pk') continue;
        const index: IndexInfo = { name: String(ix.name), columns: cols, unique: Number(ix.unique) === 1 };
        t.indexes.push(index);
        if (index.unique && cols.length === 1) {
          const col = t.columns.find((c) => c.name === cols[0]);
          if (col) col.isUnique = true;
        }
      }
      try {
        t.rowCount = Number(all(db, `SELECT COUNT(*) AS n FROM ${quote(t.name)}`)[0].n);
      } catch {
        // leave the count out
      }
    }
    model.tables.push(t);
  }
  for (const tr of all(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")) {
    const r: Routine = { name: String(tr.name), kind: 'trigger', table: String(tr.tbl_name), definition: String(tr.sql ?? '') };
    model.routines.push(r);
  }
  return model;
}

function noAction(v: unknown): string | undefined {
  const s = String(v ?? '').toUpperCase();
  return s && s !== 'NO ACTION' ? s : undefined;
}

function runQuery(db: Database, sql: string, maxRows: number): SqliteReply {
  const stmt = db.prepare(sql);
  const columns = stmt.getColumnNames();
  const rows: unknown[][] = [];
  let truncated = false;
  while (stmt.step()) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(stmt.get());
  }
  stmt.free();
  return { ok: true, columns, rows, truncated };
}

export async function handle(req: SqliteRequest): Promise<SqliteReply> {
  try {
    const db = await open(req);
    try {
      if (req.op === 'introspect') return { ok: true, model: introspect(db, req.filePath) };
      return runQuery(db, req.sql as string, req.maxRows as number);
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

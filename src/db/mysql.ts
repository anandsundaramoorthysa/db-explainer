import * as mysql from 'mysql2/promise';
import { Column, ConnectionProfile, ForeignKey, IndexInfo, QueryLimits, QueryResult, Routine, SchemaModel, Table, emptyColumn, emptyTable } from '../types';
import { Connector, QueryTimeoutError, schemaFor, toResult } from './connector';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

type Row = Record<string, any>;

export class MysqlConnector implements Connector {
  readonly engine = 'mysql' as const;
  private conn?: mysql.Connection;

  constructor(private readonly profile: ConnectionProfile, private readonly password: string | undefined) {}

  private async connection(): Promise<mysql.Connection> {
    if (this.conn) return this.conn;
    const conn = await mysql.createConnection({
      host: this.profile.host ?? 'localhost',
      port: this.profile.port ?? 3306,
      user: this.profile.user,
      password: this.password,
      database: this.profile.database || undefined,
      ssl: this.profile.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    // Every transaction this session starts is read-only, whatever the query says.
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    this.conn = conn;
    return conn;
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    const conn = await this.connection();
    const [rows] = await conn.query({ sql, values: params, rowsAsArray: false });
    return rows as Row[];
  }

  async introspect(): Promise<SchemaModel> {
    const db = this.profile.database;
    const schemaFilter = db ? 'IN (?)' : `NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(',')})`;
    const args = db ? [[db]] : SYSTEM_SCHEMAS;
    const model: SchemaModel = {
      engine: 'mysql',
      name: db || this.profile.name,
      source: 'live',
      tables: [],
      routines: [],
      capturedAt: new Date().toISOString(),
      warnings: [],
    };
    const byKey = new Map<string, Table>();
    const keyOf = (schema: string, name: string): string => `${schema}\u0000${name}`;
    const place = (schema: string): string | undefined => (db ? undefined : schemaFor('mysql', schema) ?? schema);

    for (const r of await this.rows(`SELECT TABLE_SCHEMA s, TABLE_NAME n, TABLE_TYPE t, TABLE_COMMENT c, TABLE_ROWS r FROM information_schema.TABLES WHERE TABLE_SCHEMA ${schemaFilter} ORDER BY TABLE_SCHEMA, TABLE_NAME`, args)) {
      const t = emptyTable(r.n, place(r.s));
      t.kind = String(r.t).toUpperCase().includes('VIEW') ? 'view' : 'table';
      if (r.c) t.comment = r.c;
      if (t.kind === 'table' && r.r !== null && r.r !== undefined) {
        t.rowCount = Number(r.r);
        t.rowCountIsEstimate = true;
      }
      byKey.set(keyOf(r.s, r.n), t);
      model.tables.push(t);
    }
    for (const r of await this.rows(`SELECT TABLE_SCHEMA s, TABLE_NAME n, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE nl, COLUMN_DEFAULT d, COLUMN_KEY k, EXTRA x, COLUMN_COMMENT cm FROM information_schema.COLUMNS WHERE TABLE_SCHEMA ${schemaFilter} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, args)) {
      const t = byKey.get(keyOf(r.s, r.n));
      if (!t) continue;
      const col: Column = emptyColumn(r.c);
      col.dataType = String(r.ty);
      col.nullable = r.nl === 'YES';
      if (r.d !== null && r.d !== undefined) col.defaultValue = String(r.d);
      col.isPrimaryKey = r.k === 'PRI';
      col.isUnique = r.k === 'UNI';
      col.isAutoIncrement = /auto_increment/i.test(String(r.x));
      if (r.cm) col.comment = r.cm;
      t.columns.push(col);
      if (col.isPrimaryKey) t.primaryKey.push(col.name);
    }
    const idx = new Map<string, IndexInfo & { table: Table }>();
    for (const r of await this.rows(`SELECT TABLE_SCHEMA s, TABLE_NAME n, INDEX_NAME i, NON_UNIQUE nu, COLUMN_NAME c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA ${schemaFilter} ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, args)) {
      const t = byKey.get(keyOf(r.s, r.n));
      if (!t || r.i === 'PRIMARY') continue;
      const key = `${keyOf(r.s, r.n)}\u0000${r.i}`;
      if (!idx.has(key)) {
        const info = { name: r.i, columns: [] as string[], unique: Number(r.nu) === 0, table: t };
        idx.set(key, info);
        t.indexes.push(info);
      }
      idx.get(key)!.columns.push(r.c);
    }
    for (const t of model.tables) t.indexes = t.indexes.map(({ name, columns, unique }) => ({ name, columns, unique }));
    const fks = new Map<string, ForeignKey & { table: Table }>();
    for (const r of await this.rows(`SELECT k.TABLE_SCHEMA s, k.TABLE_NAME n, k.CONSTRAINT_NAME cn, k.COLUMN_NAME c, k.REFERENCED_TABLE_SCHEMA rs, k.REFERENCED_TABLE_NAME rt, k.REFERENCED_COLUMN_NAME rc, r.UPDATE_RULE ur, r.DELETE_RULE dr FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA ${schemaFilter} AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, args)) {
      const t = byKey.get(keyOf(r.s, r.n));
      if (!t) continue;
      const key = `${keyOf(r.s, r.n)}\u0000${r.cn}`;
      if (!fks.has(key)) {
        const fk = {
          name: r.cn,
          columns: [] as string[],
          refSchema: place(r.rs),
          refTable: r.rt,
          refColumns: [] as string[],
          onDelete: rule(r.dr),
          onUpdate: rule(r.ur),
          table: t,
        };
        fks.set(key, fk);
        t.foreignKeys.push(fk);
      }
      const fk = fks.get(key)!;
      fk.columns.push(r.c);
      fk.refColumns.push(r.rc);
    }
    for (const t of model.tables) t.foreignKeys = t.foreignKeys.map(({ name, columns, refSchema, refTable, refColumns, onDelete, onUpdate }) => ({ name, columns, refSchema, refTable, refColumns, onDelete, onUpdate }));
    try {
      for (const r of await this.rows(`SELECT tc.TABLE_SCHEMA s, tc.TABLE_NAME n, cc.CONSTRAINT_NAME cn, cc.CHECK_CLAUSE e FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA ${schemaFilter} AND tc.CONSTRAINT_TYPE = 'CHECK'`, args)) {
        byKey.get(keyOf(r.s, r.n))?.checks.push({ name: r.cn, expression: String(r.e) });
      }
    } catch {
      // Older servers have no CHECK constraint catalog.
    }
    try {
      for (const r of await this.rows(`SELECT TABLE_SCHEMA s, TABLE_NAME n, VIEW_DEFINITION d FROM information_schema.VIEWS WHERE TABLE_SCHEMA ${schemaFilter}`, args)) {
        const t = byKey.get(keyOf(r.s, r.n));
        if (t) t.definition = String(r.d ?? '');
      }
      for (const r of await this.rows(`SELECT ROUTINE_SCHEMA s, ROUTINE_NAME n, ROUTINE_TYPE t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA ${schemaFilter}`, args)) {
        const routine: Routine = { schema: place(r.s), name: r.n, kind: String(r.t).toLowerCase() === 'function' ? 'function' : 'procedure' };
        model.routines.push(routine);
      }
      for (const r of await this.rows(`SELECT TRIGGER_SCHEMA s, TRIGGER_NAME n, EVENT_OBJECT_TABLE t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA ${schemaFilter}`, args)) {
        model.routines.push({ schema: place(r.s), name: r.n, kind: 'trigger', table: r.t });
      }
    } catch (e) {
      model.warnings.push(`Views, routines or triggers could not be read: ${(e as Error).message}`);
    }
    return model;
  }

  async query(sql: string, limits: QueryLimits): Promise<QueryResult> {
    const started = Date.now();
    const conn = await this.connection();
    const seconds = Math.max(1, Math.round(limits.timeoutMs / 1000));
    // The server enforces a slightly longer limit as a backstop, so the work stops even if the connection is cut. It must be longer than
    // ours: a query the server stops first can come back as a normal result (SLEEP returns 1). MariaDB uses another name.
    const serverMs = limits.timeoutMs + 2000;
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${serverMs}`).catch(() => conn.query(`SET SESSION max_statement_time = ${serverMs / 1000}`).catch(() => undefined));
    await conn.query('START TRANSACTION READ ONLY');
    let timedOut = false;
    const rows: unknown[][] = [];
    let columns: string[] = [];
    let cut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          conn.destroy();
          reject(new QueryTimeoutError(seconds));
        }, limits.timeoutMs);
        const q = (conn as any).connection.query({ sql, rowsAsArray: true });
        const stream = q.stream();
        stream.on('fields', (f: Array<{ name: string }>) => {
          columns = f.map((x) => x.name);
        });
        stream.on('data', (row: unknown[]) => {
          rows.push(row);
          if (rows.length > limits.maxRows && !cut) {
            cut = true;
            clearTimeout(timer);
            stream.destroy();
            resolve();
          }
        });
        stream.on('error', (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
        stream.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (timedOut || cut) {
        // A stopped query may still be running on the server, so the connection is dropped and reopened next time.
        this.conn = undefined;
        conn.destroy();
      } else {
        await conn.query('ROLLBACK').catch(() => undefined);
      }
    }
    return toResult(columns, rows, limits.maxRows, started);
  }

  async close(): Promise<void> {
    const c = this.conn;
    this.conn = undefined;
    await c?.end().catch(() => undefined);
  }
}

function rule(v: unknown): string | undefined {
  const s = String(v ?? '').toUpperCase();
  return s && s !== 'NO ACTION' ? s : undefined;
}

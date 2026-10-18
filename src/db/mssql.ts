import * as sql from 'mssql';
import { Column, ConnectionProfile, ForeignKey, QueryLimits, QueryResult, Routine, SchemaModel, Table, emptyColumn, emptyTable } from '../types';
import { Connector, QueryTimeoutError, schemaFor, toResult } from './connector';

type Row = Record<string, any>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '(local)', '.']);

function typeText(r: Row): string {
  const t = String(r.ty).toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${r.len === -1 ? 'max' : r.len})`;
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${r.len === -1 ? 'max' : r.len / 2})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${r.prec},${r.scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(t) && Number(r.scale) !== 7) return `${t}(${r.scale})`;
  return t;
}

export class MssqlConnector implements Connector {
  readonly engine = 'mssql' as const;
  private pool?: sql.ConnectionPool;

  constructor(private readonly profile: ConnectionProfile, private readonly password: string | undefined) {}

  private async connection(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    const host = this.profile.host ?? 'localhost';
    const local = LOCAL_HOSTS.has(host.toLowerCase());
    const pool = new sql.ConnectionPool({
      server: host,
      port: this.profile.port ?? 1433,
      user: this.profile.user,
      password: this.password,
      database: this.profile.database || undefined,
      connectionTimeout: 10000,
      requestTimeout: 60000,
      options: {
        encrypt: this.profile.ssl !== false,
        // A local server usually has a self-signed certificate. Remote servers must present a valid one.
        trustServerCertificate: this.profile.trustServerCertificate ?? local,
        enableArithAbort: true,
      },
      pool: { max: 1, min: 0 },
    });
    pool.on('error', () => {
      this.pool = undefined;
    });
    await pool.connect();
    this.pool = pool;
    return pool;
  }

  private async rows(text: string): Promise<Row[]> {
    const pool = await this.connection();
    const result = await pool.request().query(text);
    return result.recordset as unknown as Row[];
  }

  async introspect(): Promise<SchemaModel> {
    const model: SchemaModel = { engine: 'mssql', name: this.profile.database || this.profile.name, source: 'live', tables: [], routines: [], capturedAt: new Date().toISOString(), warnings: [] };
    const byId = new Map<number, Table>();

    for (const r of await this.rows(`SELECT o.object_id id, s.name s, o.name n, o.type k, CAST(ep.value AS NVARCHAR(4000)) cm, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1)) cnt, m.definition def FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id AND o.type = 'V' WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`)) {
      const t = emptyTable(r.n, schemaFor('mssql', r.s));
      t.kind = r.k === 'V' ? 'view' : 'table';
      if (r.cm) t.comment = r.cm;
      if (r.def) t.definition = String(r.def).replace(/^[\s\S]*?\bAS\b/i, '').trim();
      if (t.kind === 'table' && r.cnt !== null) {
        t.rowCount = Number(r.cnt);
        t.rowCountIsEstimate = true;
      }
      byId.set(r.id, t);
      model.tables.push(t);
    }
    for (const r of await this.rows(`SELECT c.object_id id, c.name col, TYPE_NAME(c.user_type_id) ty, c.max_length len, c.precision prec, c.scale scale, c.is_nullable nl, c.is_identity idt, OBJECT_DEFINITION(c.default_object_id) def, CAST(ep.value AS NVARCHAR(4000)) cm FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY c.object_id, c.column_id`)) {
      const t = byId.get(r.id);
      if (!t) continue;
      const col: Column = emptyColumn(r.col);
      col.dataType = typeText(r);
      col.nullable = !!r.nl;
      col.isAutoIncrement = !!r.idt;
      if (r.def) col.defaultValue = String(r.def).replace(/^\(\((.*)\)\)$/, '$1').replace(/^\((.*)\)$/, '$1');
      if (r.cm) col.comment = r.cm;
      t.columns.push(col);
    }
    for (const r of await this.rows(`SELECT i.object_id id, i.name ix, i.is_primary_key pk, i.is_unique uq, i.is_unique_constraint uc, c.name col FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.objects o ON o.object_id = i.object_id WHERE i.type > 0 AND o.type = 'U' AND o.is_ms_shipped = 0 ORDER BY i.object_id, i.index_id, ic.key_ordinal`)) {
      const t = byId.get(r.id);
      if (!t) continue;
      if (r.pk) {
        t.primaryKey.push(r.col);
        const c = t.columns.find((x) => x.name === r.col);
        if (c) {
          c.isPrimaryKey = true;
          c.nullable = false;
        }
        continue;
      }
      let ix = t.indexes.find((x) => x.name === r.ix);
      if (!ix) {
        ix = { name: r.ix, columns: [], unique: !!r.uq };
        t.indexes.push(ix);
      }
      ix.columns.push(r.col);
    }
    for (const t of model.tables) {
      for (const ix of t.indexes) {
        if (ix.unique && ix.columns.length === 1) {
          const c = t.columns.find((x) => x.name === ix.columns[0]);
          if (c) c.isUnique = true;
        }
      }
    }
    const fks = new Map<number, ForeignKey>();
    for (const r of await this.rows(`SELECT fk.object_id fid, fk.parent_object_id id, fk.name fname, pc.name col, rs.name rs, ro.name rt, rc.name rcol, fk.delete_referential_action_desc dd, fk.update_referential_action_desc ud FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = ro.schema_id ORDER BY fk.object_id, fkc.constraint_column_id`)) {
      const t = byId.get(r.id);
      if (!t) continue;
      if (!fks.has(r.fid)) {
        const fk: ForeignKey = { name: r.fname, columns: [], refSchema: schemaFor('mssql', r.rs), refTable: r.rt, refColumns: [], onDelete: action(r.dd), onUpdate: action(r.ud) };
        fks.set(r.fid, fk);
        t.foreignKeys.push(fk);
      }
      fks.get(r.fid)!.columns.push(r.col);
      fks.get(r.fid)!.refColumns.push(r.rcol);
    }
    try {
      for (const r of await this.rows(`SELECT parent_object_id id, name n, definition d FROM sys.check_constraints WHERE is_ms_shipped = 0`)) {
        byId.get(r.id)?.checks.push({ name: r.n, expression: String(r.d) });
      }
      for (const r of await this.rows(`SELECT s.name s, o.name n, o.type k FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('P','FN','IF','TF') AND o.is_ms_shipped = 0`)) {
        const routine: Routine = { schema: schemaFor('mssql', r.s), name: r.n, kind: r.k === 'P' ? 'procedure' : 'function' };
        model.routines.push(routine);
      }
      for (const r of await this.rows(`SELECT tr.name n, o.name t FROM sys.triggers tr JOIN sys.objects o ON o.object_id = tr.parent_id WHERE tr.is_ms_shipped = 0`)) {
        model.routines.push({ name: r.n, kind: 'trigger', table: r.t });
      }
    } catch (e) {
      model.warnings.push(`Checks, routines or triggers could not be read: ${(e as Error).message}`);
    }
    return model;
  }

  async query(text: string, limits: QueryLimits): Promise<QueryResult> {
    const started = Date.now();
    const pool = await this.connection();
    const seconds = Math.max(1, Math.round(limits.timeoutMs / 1000));
    // SQL Server cannot force read-only access, so everything runs inside a transaction that is always rolled back.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    const rows: unknown[][] = [];
    let columns: string[] = [];
    let timedOut = false;
    let cut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const request = new sql.Request(tx);
        (request as any).stream = true;
        (request as any).arrayRowMode = true;
        const timer = setTimeout(() => {
          timedOut = true;
          request.cancel();
          reject(new QueryTimeoutError(seconds));
        }, limits.timeoutMs);
        request.on('recordset', (cols: Record<string, { index: number; name: string }>) => {
          columns = Object.values(cols).sort((a, b) => a.index - b.index).map((c) => c.name);
        });
        request.on('row', (row: unknown[]) => {
          if (cut) return;
          rows.push(row);
          if (rows.length > limits.maxRows) {
            cut = true;
            clearTimeout(timer);
            request.cancel();
            resolve();
          }
        });
        request.on('error', (e: Error) => {
          clearTimeout(timer);
          if (cut) resolve();
          else reject(e);
        });
        request.on('done', () => {
          clearTimeout(timer);
          resolve();
        });
        request.query(text);
      });
    } finally {
      await tx.rollback().catch(() => undefined);
      if (timedOut) {
        this.pool = undefined;
        await pool.close().catch(() => undefined);
      }
    }
    return toResult(columns, rows, limits.maxRows, started);
  }

  async close(): Promise<void> {
    const p = this.pool;
    this.pool = undefined;
    await p?.close().catch(() => undefined);
  }
}

function action(v: unknown): string | undefined {
  const s = String(v ?? '').replace(/_/g, ' ').toUpperCase();
  return s && s !== 'NO ACTION' ? s : undefined;
}

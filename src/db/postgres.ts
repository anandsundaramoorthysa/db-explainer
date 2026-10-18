import { Client } from 'pg';
import { Column, ConnectionProfile, ForeignKey, QueryLimits, QueryResult, SchemaModel, Table, emptyColumn, emptyTable } from '../types';
import { Connector, QueryTimeoutError, schemaFor, toResult } from './connector';

type Row = Record<string, any>;

const SYSTEM = "('pg_catalog','information_schema')";

const ACTION: Record<string, string | undefined> = { a: undefined, r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export class PostgresConnector implements Connector {
  readonly engine = 'postgres' as const;
  private client?: Client;

  constructor(private readonly profile: ConnectionProfile, private readonly password: string | undefined) {}

  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({
      host: this.profile.host ?? 'localhost',
      port: this.profile.port ?? 5432,
      user: this.profile.user,
      password: this.password,
      database: this.profile.database || undefined,
      ssl: this.profile.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      // Every transaction in this session is read-only, whatever the query says.
      options: '-c default_transaction_read_only=on',
    });
    client.on('error', () => {
      this.client = undefined;
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private async rows(sql: string): Promise<Row[]> {
    const client = await this.connection();
    return (await client.query(sql)).rows as Row[];
  }

  async introspect(): Promise<SchemaModel> {
    const dbName = this.profile.database || this.profile.name;
    const model: SchemaModel = { engine: 'postgres', name: dbName, source: 'live', tables: [], routines: [], capturedAt: new Date().toISOString(), warnings: [] };
    const byKey = new Map<string, Table>();
    const key = (s: string, n: string): string => `${s}\u0000${n}`;
    const userSchemas = `n.nspname NOT IN ${SYSTEM} AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

    for (const r of await this.rows(`SELECT n.nspname s, c.relname n, c.relkind k, obj_description(c.oid, 'pg_class') cm, c.reltuples::bigint est, CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) END def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND ${userSchemas} ORDER BY n.nspname, c.relname`)) {
      const t = emptyTable(r.n, schemaFor('postgres', r.s));
      t.kind = r.k === 'v' || r.k === 'm' ? 'view' : 'table';
      if (r.cm) t.comment = r.cm;
      if (r.def) t.definition = String(r.def);
      if (t.kind === 'table' && Number(r.est) >= 0) {
        t.rowCount = Number(r.est);
        t.rowCountIsEstimate = true;
      }
      byKey.set(key(r.s, r.n), t);
      model.tables.push(t);
    }
    for (const r of await this.rows(`SELECT n.nspname s, c.relname n, a.attname col, format_type(a.atttypid, a.atttypmod) ty, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def, a.attidentity idt, col_description(c.oid, a.attnum) cm FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') AND ${userSchemas} ORDER BY n.nspname, c.relname, a.attnum`)) {
      const t = byKey.get(key(r.s, r.n));
      if (!t) continue;
      const col: Column = emptyColumn(r.col);
      col.dataType = String(r.ty);
      col.nullable = !r.nn;
      if (r.def !== null && r.def !== undefined) col.defaultValue = String(r.def);
      col.isAutoIncrement = !!r.idt || /^nextval\(/i.test(String(r.def ?? ''));
      if (r.cm) col.comment = r.cm;
      t.columns.push(col);
    }
    const cols = (oid: string, arr: string): string => `ARRAY(SELECT a.attname::text FROM unnest(${arr}) WITH ORDINALITY AS k(num, ord) JOIN pg_attribute a ON a.attrelid = ${oid} AND a.attnum = k.num ORDER BY k.ord)`;
    for (const r of await this.rows(`SELECT n.nspname s, c.relname n, con.conname cn, con.contype ct, ${cols('con.conrelid', 'con.conkey')} cols, fn.nspname rs, fc.relname rt, ${cols('con.confrelid', 'con.confkey')} rcols, con.confdeltype dt, con.confupdtype ut, pg_get_constraintdef(con.oid) def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace WHERE con.contype IN ('p','u','f','c') AND ${userSchemas} ORDER BY n.nspname, c.relname, con.conname`)) {
      const t = byKey.get(key(r.s, r.n));
      if (!t) continue;
      if (r.ct === 'p') {
        t.primaryKey = r.cols;
        for (const c of t.columns) if (r.cols.includes(c.name)) c.isPrimaryKey = true;
      } else if (r.ct === 'u') {
        t.indexes.push({ name: r.cn, columns: r.cols, unique: true });
        if (r.cols.length === 1) {
          const c = t.columns.find((x) => x.name === r.cols[0]);
          if (c) c.isUnique = true;
        }
      } else if (r.ct === 'f') {
        const fk: ForeignKey = { name: r.cn, columns: r.cols, refSchema: schemaFor('postgres', r.rs), refTable: r.rt, refColumns: r.rcols, onDelete: ACTION[r.dt], onUpdate: ACTION[r.ut] };
        t.foreignKeys.push(fk);
      } else if (r.ct === 'c') {
        t.checks.push({ name: r.cn, expression: String(r.def).replace(/^CHECK\s*/i, '') });
      }
    }
    for (const r of await this.rows(`SELECT n.nspname s, t.relname n, i.relname ix, x.indisunique uq, x.indisprimary pk, ${cols('t.oid', 'x.indkey::int2[]')} cols FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE ${userSchemas} ORDER BY n.nspname, t.relname, i.relname`)) {
      const t = byKey.get(key(r.s, r.n));
      if (!t || r.pk || t.indexes.some((i) => i.name === r.ix)) continue;
      t.indexes.push({ name: r.ix, columns: r.cols.filter(Boolean), unique: !!r.uq });
    }
    try {
      for (const r of await this.rows(`SELECT n.nspname s, p.proname n, p.prokind k FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind IN ('f','p') AND ${userSchemas}`)) {
        model.routines.push({ schema: schemaFor('postgres', r.s), name: r.n, kind: r.k === 'p' ? 'procedure' : 'function' });
      }
      for (const r of await this.rows(`SELECT n.nspname s, g.tgname n, c.relname t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT g.tgisinternal AND ${userSchemas}`)) {
        model.routines.push({ schema: schemaFor('postgres', r.s), name: r.n, kind: 'trigger', table: r.t });
      }
    } catch (e) {
      model.warnings.push(`Routines or triggers could not be read: ${(e as Error).message}`);
    }
    return model;
  }

  async query(sql: string, limits: QueryLimits): Promise<QueryResult> {
    const started = Date.now();
    const client = await this.connection();
    const seconds = Math.max(1, Math.round(limits.timeoutMs / 1000));
    const isExplain = /^\s*explain\b/i.test(sql);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.client = undefined;
      void client.end().catch(() => undefined);
    }, limits.timeoutMs + 500);
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${seconds * 1000}`);
      let columns: string[];
      let rows: unknown[][];
      if (isExplain) {
        const res = await client.query({ text: sql, rowMode: 'array' });
        columns = res.fields.map((f) => f.name);
        rows = res.rows as unknown[][];
      } else {
        // A cursor lets the database stop after maxRows + 1 rows instead of sending everything.
        await client.query(`DECLARE db_explainer_cursor NO SCROLL CURSOR FOR ${sql}`);
        const res = await client.query({ text: `FETCH FORWARD ${limits.maxRows + 1} FROM db_explainer_cursor`, rowMode: 'array' });
        columns = res.fields.map((f) => f.name);
        rows = res.rows as unknown[][];
      }
      await client.query('ROLLBACK');
      return toResult(columns, rows, limits.maxRows, started);
    } catch (e) {
      if (timedOut) throw new QueryTimeoutError(seconds);
      await client.query('ROLLBACK').catch(() => undefined);
      if (/statement timeout/i.test((e as Error).message)) throw new QueryTimeoutError(seconds);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }
}

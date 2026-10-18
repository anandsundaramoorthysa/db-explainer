import { ConnectionProfile, DbEngine, QueryLimits, QueryResult, SchemaModel, Table } from '../types';

export interface Connector {
  readonly engine: DbEngine;
  /** Reads the structure of the database: tables, columns, keys, indexes, views, routines and row counts. */
  introspect(): Promise<SchemaModel>;
  /**
   * Runs one query. The caller has already passed it through the SQL guard. Connectors add their own protection:
   * a read-only transaction where the engine supports it, a row cap and a time limit.
   */
  query(sql: string, limits: QueryLimits): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Folder holding sql-wasm.wasm and sqliteWorker.js. Defaults to the folder of the running bundle. */
  assetsDir?: string;
}

export function quoteIdent(engine: DbEngine, name: string): string {
  if (engine === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (engine === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteTable(engine: DbEngine, t: Pick<Table, 'schema' | 'name'>): string {
  return t.schema ? `${quoteIdent(engine, t.schema)}.${quoteIdent(engine, t.name)}` : quoteIdent(engine, t.name);
}

export class QueryTimeoutError extends Error {
  constructor(seconds: number) {
    super(`The query took longer than ${seconds} seconds and was stopped.`);
    this.name = 'QueryTimeoutError';
  }
}

export function toResult(columns: string[], rows: unknown[][], maxRows: number, started: number): QueryResult {
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;
  return { columns, rows: kept.map((r) => r.map(plainValue)), rowCount: kept.length, truncated, elapsedMs: Date.now() - started };
}

/** Makes driver values safe to show and to send over a message: no Buffers, BigInts or Dates that cannot be serialised. */
export function plainValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `[binary ${v.byteLength} bytes]`;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

export function withTimeout<T>(promise: Promise<T>, limits: QueryLimits, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new QueryTimeoutError(Math.round(limits.timeoutMs / 1000)));
    }, limits.timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Default schemas are left out of table names so they read naturally. */
export const DEFAULT_SCHEMA: Record<DbEngine, string[]> = {
  mysql: [],
  postgres: ['public'],
  mssql: ['dbo'],
  sqlite: ['main'],
};

export function schemaFor(engine: DbEngine, schema: string | null | undefined): string | undefined {
  if (!schema) return undefined;
  return DEFAULT_SCHEMA[engine].includes(schema.toLowerCase()) ? undefined : schema;
}

export function describeProfile(p: ConnectionProfile): string {
  if (p.engine === 'sqlite') return p.filePath ?? 'SQLite file';
  return `${p.user ? p.user + '@' : ''}${p.host ?? 'localhost'}${p.port ? ':' + p.port : ''}/${p.database ?? ''}`;
}

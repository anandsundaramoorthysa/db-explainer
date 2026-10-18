import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { ConnectionProfile, QueryLimits, QueryResult, SchemaModel } from '../types';
import { Connector, QueryTimeoutError, toResult } from './connector';
import { SqliteReply, SqliteRequest } from './sqliteCore';

function workerFile(assetsDir: string): string {
  const here = path.join(assetsDir, 'sqliteWorker.js');
  return fs.existsSync(here) ? here : path.join(__dirname, '..', '..', 'out', 'sqliteWorker.js');
}

function runInWorker(assetsDir: string, req: SqliteRequest, timeoutMs: number): Promise<SqliteReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile(assetsDir), { workerData: req });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new QueryTimeoutError(Math.round(timeoutMs / 1000)));
    }, timeoutMs);
    worker.once('message', (reply: SqliteReply) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(reply);
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** SQLite files are read into memory by a worker thread. The original file is never opened for writing. */
export class SqliteConnector implements Connector {
  readonly engine = 'sqlite' as const;

  constructor(private readonly profile: ConnectionProfile, private readonly assetsDir: string) {
    if (!profile.filePath || !fs.existsSync(profile.filePath)) throw new Error(`The SQLite file was not found: ${profile.filePath ?? '(none given)'}`);
  }

  private request(op: SqliteRequest['op'], extra: Partial<SqliteRequest>): SqliteRequest {
    return { op, filePath: this.profile.filePath as string, wasmDir: this.assetsDir, ...extra };
  }

  async introspect(): Promise<SchemaModel> {
    const reply = await runInWorker(this.assetsDir, this.request('introspect', {}), 60000);
    if (!reply.ok || !reply.model) throw new Error(reply.error ?? 'Could not read the SQLite file.');
    reply.model.name = this.profile.name;
    return reply.model;
  }

  async query(sql: string, limits: QueryLimits): Promise<QueryResult> {
    const started = Date.now();
    const reply = await runInWorker(this.assetsDir, this.request('query', { sql, maxRows: limits.maxRows }), limits.timeoutMs);
    if (!reply.ok) throw new Error(reply.error ?? 'The query failed.');
    const result = toResult(reply.columns ?? [], reply.rows ?? [], limits.maxRows, started);
    result.truncated = !!reply.truncated;
    return result;
  }

  async close(): Promise<void> {
    // Nothing stays open between operations.
  }
}

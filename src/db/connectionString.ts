import { DbEngine } from '../types';

export const DEFAULT_PORT: Record<DbEngine, number | undefined> = { mysql: 3306, postgres: 5432, mssql: 1433, sqlite: undefined };

const SCHEMES: Record<string, DbEngine> = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', mssql: 'mssql', sqlserver: 'mssql' };

export interface ParsedConnection {
  engine: DbEngine;
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  /** Only set to false by sslmode=no-verify, which asks for encryption without checking the certificate. */
  tlsVerify?: boolean;
}

function truth(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (/^(true|1|yes|require|required|verify-ca|verify-full|prefer)$/i.test(v)) return true;
  if (/^(false|0|no|disable|disabled)$/i.test(v)) return false;
  return undefined;
}

/** Reads a string such as postgres://user:pass@host:5432/shop?sslmode=require. Returns the reason as text if it cannot. */
export function parseConnectionString(raw: string): ParsedConnection | string {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^jdbc:/i, ''));
  } catch {
    return 'That is not a connection string. It should look like postgres://user:password@host:5432/database';
  }
  const engine = SCHEMES[url.protocol.replace(':', '').toLowerCase()];
  if (!engine) return 'Use a string starting with postgres://, mysql://, mariadb:// or sqlserver://';
  if (!url.hostname) return 'The connection string has no host.';
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return 'The connection string has a badly encoded name or password.';
  }
  if (!database) return 'The connection string has no database name.';
  const q = url.searchParams;
  const noVerify = /^no-verify$/i.test(q.get('sslmode') ?? '') || /^(true|1|yes)$/i.test(q.get('trustServerCertificate') ?? '');
  const ssl = noVerify ? true : (truth(q.get('sslmode')) ?? truth(q.get('ssl')) ?? truth(q.get('encrypt')));
  return {
    engine,
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT[engine]!,
    database,
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    ...(ssl === undefined ? {} : { ssl }),
    ...(noVerify ? { tlsVerify: false } : {}),
  };
}

/** "db.example.com:5433" or just "db.example.com", which gets the usual port. */
export function splitHostPort(text: string, fallbackPort: number): { host: string; port: number } | undefined {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(text.trim());
  const port = m?.[2] ? Number(m[2]) : fallbackPort;
  if (!m?.[1] || port < 1 || port > 65535) return undefined;
  return { host: m[1], port };
}

export function isLocalHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '(local)', '.'].includes(host.toLowerCase());
}

/** Ask about TLS only for a remote host when the connection string did not say ssl either way. */
export function tlsQuestionNeeded(host: string, ssl: boolean | undefined): boolean {
  return ssl === undefined && !isLocalHost(host);
}

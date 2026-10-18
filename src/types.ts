export type DbEngine = 'mysql' | 'postgres' | 'mssql' | 'sqlite';

export const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
};

/** Dialect names used in prompts so the AI writes SQL the connected engine understands. */
export const ENGINE_DIALECT: Record<DbEngine, string> = {
  mysql: 'MySQL (identifiers in backticks, LIMIT n)',
  postgres: 'PostgreSQL (identifiers in double quotes, LIMIT n)',
  mssql: 'Microsoft SQL Server T-SQL (identifiers in [brackets], SELECT TOP n, no LIMIT)',
  sqlite: 'SQLite (identifiers in double quotes, LIMIT n)',
};

export interface Column {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  comment?: string;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface CheckInfo {
  name?: string;
  expression: string;
}

export interface Table {
  /** Only set when the table is not in the default schema (public, dbo, main or the connected database). */
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  comment?: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
  checks: CheckInfo[];
  rowCount?: number;
  rowCountIsEstimate?: boolean;
  /** SQL text of a view. */
  definition?: string;
}

export interface Routine {
  schema?: string;
  name: string;
  kind: 'procedure' | 'function' | 'trigger';
  table?: string;
  definition?: string;
}

export interface SchemaModel {
  engine: DbEngine;
  /** Database name, or a label for shared SQL. */
  name: string;
  source: 'live' | 'sql';
  tables: Table[];
  routines: Routine[];
  capturedAt: string;
  /** Things that could not be read or parsed. Shown to the developer, never hidden. */
  warnings: string[];
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** SQLite database file. */
  filePath?: string;
  ssl?: boolean;
  /** SQL Server only. Defaults to true for local servers and false for remote ones. */
  trustServerCertificate?: boolean;
}

export interface QueryLimits {
  maxRows: number;
  timeoutMs: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** True when more rows existed than maxRows. */
  truncated: boolean;
  elapsedMs: number;
}

export function emptyTable(name: string, schema?: string): Table {
  return { schema, name, kind: 'table', columns: [], primaryKey: [], foreignKeys: [], indexes: [], checks: [] };
}

export function emptyColumn(name: string): Column {
  return { name, dataType: 'unknown', nullable: true, isPrimaryKey: false, isUnique: false, isAutoIncrement: false };
}

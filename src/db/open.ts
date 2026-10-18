import * as path from 'path';
import { ConnectionProfile } from '../types';
import { Connector, OpenOptions } from './connector';
import { MssqlConnector } from './mssql';
import { MysqlConnector } from './mysql';
import { PostgresConnector } from './postgres';
import { SqliteConnector } from './sqlite';

/** Creates the connector for a saved connection. Nothing is contacted until the first call. */
export function openConnector(profile: ConnectionProfile, password: string | undefined, options: OpenOptions = {}): Connector {
  switch (profile.engine) {
    case 'mysql':
      return new MysqlConnector(profile, password);
    case 'postgres':
      return new PostgresConnector(profile, password);
    case 'mssql':
      return new MssqlConnector(profile, password);
    case 'sqlite':
      return new SqliteConnector(profile, options.assetsDir ?? path.resolve(__dirname));
  }
}

import * as vscode from 'vscode';
import { ConnectionProfile, DbEngine, ENGINE_LABEL } from './types';

const PROFILES_KEY = 'dbExplainer.connections';
const PASSWORD_PREFIX = 'dbExplainer.password.';

const DEFAULT_PORT: Record<DbEngine, number | undefined> = { mysql: 3306, postgres: 5432, mssql: 1433, sqlite: undefined };

/** Saved connections. Everything except the password is kept in VS Code state, and the password goes into secret storage. */
export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async save(profile: ConnectionProfile, password?: string): Promise<void> {
    const rest = this.list().filter((p) => p.id !== profile.id);
    await this.context.globalState.update(PROFILES_KEY, [...rest, profile]);
    if (password !== undefined) {
      if (password) await this.context.secrets.store(PASSWORD_PREFIX + profile.id, password);
      else await this.context.secrets.delete(PASSWORD_PREFIX + profile.id);
    }
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, this.list().filter((p) => p.id !== id));
    await this.context.secrets.delete(PASSWORD_PREFIX + id);
  }

  password(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(PASSWORD_PREFIX + id);
  }
}

function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Asks for the connection details one step at a time. Returns undefined if the developer cancels. */
export async function promptForConnection(): Promise<{ profile: ConnectionProfile; password?: string } | undefined> {
  const engine = await vscode.window.showQuickPick(
    (Object.keys(ENGINE_LABEL) as DbEngine[]).map((e) => ({ label: ENGINE_LABEL[e], description: e === 'sqlite' ? 'a database file' : 'a database server', engine: e })),
    { title: 'Add a database connection (1)', placeHolder: 'Which database?' },
  );
  if (!engine) return undefined;
  const kind = engine.engine;

  if (kind === 'sqlite') {
    const picked = await vscode.window.showOpenDialog({ title: 'Choose the SQLite database file', canSelectMany: false, filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] } });
    if (!picked?.length) return undefined;
    const file = picked[0].fsPath;
    const name = await vscode.window.showInputBox({ title: 'Name this connection', value: file.split(/[\\/]/).pop(), ignoreFocusOut: true });
    if (!name) return undefined;
    return { profile: { id: newId(), name, engine: kind, filePath: file } };
  }

  const host = await vscode.window.showInputBox({ title: 'Add a database connection (2)', prompt: 'Host', value: 'localhost', ignoreFocusOut: true });
  if (!host) return undefined;
  const portText = await vscode.window.showInputBox({
    title: 'Add a database connection (3)',
    prompt: 'Port',
    value: String(DEFAULT_PORT[kind]),
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : 'Enter a port number'),
  });
  if (!portText) return undefined;
  const database = await vscode.window.showInputBox({ title: 'Add a database connection (4)', prompt: 'Database name', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter the database name') });
  if (!database) return undefined;
  const user = await vscode.window.showInputBox({ title: 'Add a database connection (5)', prompt: 'User. A read-only account is best.', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter the user name') });
  if (!user) return undefined;
  const password = await vscode.window.showInputBox({ title: 'Add a database connection (6)', prompt: 'Password. It is stored in VS Code secret storage on this computer only.', password: true, ignoreFocusOut: true });
  if (password === undefined) return undefined;
  const tls = await vscode.window.showQuickPick([{ label: 'No', value: false }, { label: 'Yes, encrypt the connection', value: true }], { title: 'Add a database connection (7)', placeHolder: 'Use an encrypted connection (TLS)?' });
  if (!tls) return undefined;
  const name = await vscode.window.showInputBox({ title: 'Name this connection', value: `${database}@${host}`, ignoreFocusOut: true });
  if (!name) return undefined;
  return { profile: { id: newId(), name, engine: kind, host, port: Number(portText), database, user, ssl: tls.value }, password };
}

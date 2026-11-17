import * as vscode from 'vscode';
import { DEFAULT_PORT, isLocalHost, parseConnectionString, splitHostPort, tlsQuestionNeeded } from './db/connectionString';
import { ConnectionProfile, DbEngine, ENGINE_LABEL } from './types';

const PROFILES_KEY = 'dbExplainer.connections';
const PASSWORD_PREFIX = 'dbExplainer.password.';

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

const PASSWORD_PROMPT = 'Password. It is stored in VS Code secret storage on this computer only.';

/** One paste instead of several boxes. Only asks for what the string left out. */
async function connectionFromString(): Promise<{ profile: ConnectionProfile; password?: string } | undefined> {
  const text = await vscode.window.showInputBox({
    title: 'Add a database connection',
    prompt: 'Paste a connection string, such as postgres://user:password@host:5432/database. A read-only account is best.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return undefined;
      const parsed = parseConnectionString(v);
      return typeof parsed === 'string' ? parsed : undefined;
    },
  });
  if (!text?.trim()) return undefined;
  const c = parseConnectionString(text);
  if (typeof c === 'string') return undefined;
  const user = c.user ?? (await vscode.window.showInputBox({ title: 'Add a database connection', prompt: 'User. A read-only account is best.', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter the user name') }));
  if (!user) return undefined;
  const password = c.password ?? (await vscode.window.showInputBox({ title: 'Add a database connection', prompt: PASSWORD_PROMPT, password: true, ignoreFocusOut: true }));
  if (password === undefined) return undefined;
  let ssl = c.ssl;
  if (tlsQuestionNeeded(c.host, ssl)) {
    const tls = await vscode.window.showQuickPick([{ label: 'Yes, encrypt the connection', value: true }, { label: 'No', value: false }], { title: 'Add a database connection', placeHolder: 'This server is not on your computer. Encrypt the connection (TLS)?' });
    if (!tls) return undefined;
    ssl = tls.value;
  }
  return { profile: { id: newId(), name: `${c.database}@${c.host}`, engine: c.engine, host: c.host, port: c.port, database: c.database, user, ...(ssl === undefined ? {} : { ssl }), ...(c.tlsVerify === false ? { tlsVerify: false } : {}) }, password };
}

/** Asks only for what it cannot work out. Returns undefined if the developer cancels. */
export async function promptForConnection(): Promise<{ profile: ConnectionProfile; password?: string } | undefined> {
  type Choice = vscode.QuickPickItem & { engine?: DbEngine };
  const engine = await vscode.window.showQuickPick<Choice>(
    [
      { label: '$(link) Paste a connection string', description: 'quickest: everything in one go' },
      ...(Object.keys(ENGINE_LABEL) as DbEngine[]).map((e): Choice => ({ label: ENGINE_LABEL[e], description: e === 'sqlite' ? 'a database file' : 'a database server', engine: e })),
    ],
    { title: 'Add a database connection', placeHolder: 'Paste a connection string, or pick the database' },
  );
  if (!engine) return undefined;
  const kind = engine.engine;
  if (!kind) return connectionFromString();

  if (kind === 'sqlite') {
    const picked = await vscode.window.showOpenDialog({ title: 'Choose the SQLite database file', canSelectMany: false, filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] } });
    if (!picked?.length) return undefined;
    const file = picked[0].fsPath;
    return { profile: { id: newId(), name: file.split(/[\\/]/).pop() ?? file, engine: kind, filePath: file } };
  }

  const usual = DEFAULT_PORT[kind]!;
  const hostText = await vscode.window.showInputBox({
    title: 'Add a database connection (2 of 5)',
    prompt: `Host. Add :port if it is not ${usual}.`,
    value: 'localhost',
    ignoreFocusOut: true,
    validateInput: (v) => (splitHostPort(v, usual) ? undefined : 'Enter a host, or host:port'),
  });
  const address = hostText ? splitHostPort(hostText, usual) : undefined;
  if (!address) return undefined;
  const { host, port } = address;
  const database = await vscode.window.showInputBox({ title: 'Add a database connection (3 of 5)', prompt: 'Database name', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter the database name') });
  if (!database) return undefined;
  const user = await vscode.window.showInputBox({ title: 'Add a database connection (4 of 5)', prompt: 'User. A read-only account is best.', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter the user name') });
  if (!user) return undefined;
  const password = await vscode.window.showInputBox({ title: 'Add a database connection (5 of 5)', prompt: PASSWORD_PROMPT, password: true, ignoreFocusOut: true });
  if (password === undefined) return undefined;
  // Encryption only needs a decision when the traffic leaves this computer.
  let ssl = false;
  if (!isLocalHost(host)) {
    const tls = await vscode.window.showQuickPick([{ label: 'Yes, encrypt the connection', value: true }, { label: 'No', value: false }], { title: 'Add a database connection', placeHolder: 'This server is not on your computer. Encrypt the connection (TLS)?' });
    if (!tls) return undefined;
    ssl = tls.value;
  }
  return { profile: { id: newId(), name: `${database}@${host}`, engine: kind, host, port, database, user, ssl }, password };
}

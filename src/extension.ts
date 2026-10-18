import * as path from 'path';
import * as vscode from 'vscode';
import { AiConfig, AiError, chat, isLocalUrl, listModels, normalizeBaseUrl } from './ai/client';
import { Conversation } from './chat/conversation';
import { ConnectionStore, promptForConnection } from './connections';
import { readNotes, saveNote } from './notes';
import { ChatPanel } from './panel';
import { SourceManager } from './sources';
import { DatabaseTree, Node } from './tree';

const KEY_SECRET = 'dbExplainer.ai.key';
const HOSTS_KEY = 'dbExplainer.ai.allowedHosts';

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dbExplainer');
}

function aiConfig(): AiConfig {
  const c = settings();
  return {
    baseUrl: c.get<string>('ai.baseUrl', 'http://localhost:11434/v1'),
    model: c.get<string>('ai.model', ''),
    maxTokens: c.get<number>('ai.maxTokens', 1200),
    maxTokensParam: c.get<'max_tokens' | 'max_completion_tokens'>('ai.maxTokensParam', 'max_tokens'),
  };
}

function notesFile(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const rel = settings().get<string>('notes.path', '.dbexplainer/notes.md');
  const full = path.resolve(folder.uri.fsPath, rel);
  // The notes file must stay inside the workspace, whatever the setting says.
  return full.startsWith(folder.uri.fsPath) ? full : undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context);
  const sources = new SourceManager(path.join(context.extensionPath, 'out'));
  const tree = new DatabaseTree(store, sources);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('dbExplainer.connections', tree), { dispose: () => void sources.disposeAll() });

  /** The first time data is sent to a host that is not on this computer, the developer says yes or no once. */
  async function allowHost(cfg: AiConfig): Promise<void> {
    if (isLocalUrl(cfg.baseUrl)) return;
    const host = new URL(cfg.baseUrl).host;
    const allowed = context.globalState.get<string[]>(HOSTS_KEY, []);
    if (allowed.includes(host)) return;
    const pick = await vscode.window.showWarningMessage(
      `DB Explainer will send your table and column names, your notes and your questions to ${host}. Row values are never sent unless you press "Let the AI see these rows".`,
      { modal: true },
      'Allow',
    );
    if (pick !== 'Allow') throw new AiError('Cancelled. Nothing was sent.', 'config');
    await context.globalState.update(HOSTS_KEY, [...allowed, host]);
  }

  const conversation = new Conversation({
    ai: async (messages) => {
      const cfg = aiConfig();
      normalizeBaseUrl(cfg.baseUrl, false);
      await allowHost(cfg);
      return chat(cfg, await context.secrets.get(KEY_SECRET), messages);
    },
    notes: () => {
      const f = notesFile();
      return f ? readNotes(f) : '';
    },
    limits: () => ({ maxRows: settings().get<number>('query.maxRows', 100), timeoutMs: settings().get<number>('query.timeoutSeconds', 15) * 1000 }),
    maxTables: () => settings().get<number>('context.maxTables', 12),
    sampleRows: () => settings().get<number>('ai.sampleRows', 5),
  });

  const openChat = (): ChatPanel =>
    ChatPanel.open(context, sources, conversation, {
      aiReady: () => !!aiConfig().model.trim(),
      saveNote: async (text, table) => {
        const f = notesFile();
        if (!f) throw new Error('Open a folder first: the team notes file lives in your workspace.');
        saveNote(f, text, table);
      },
    });

  const connectProfile = async (id: string): Promise<void> => {
    const profile = store.get(id);
    if (!profile) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${profile.name}` }, async () => {
        await sources.connect(profile, await store.password(profile.id));
      });
      openChat().pushState();
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not connect to ${profile.name}: ${(e as Error).message}`);
    }
  };

  const idOf = (n?: Node): string | undefined => (n?.kind === 'connection' ? n.profile.id : n?.kind === 'shared' ? n.id : undefined);

  const reg = (id: string, fn: (...a: any[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  reg('dbExplainer.openChat', () => openChat());

  reg('dbExplainer.addConnection', async () => {
    const made = await promptForConnection();
    if (!made) return;
    await store.save(made.profile, made.password);
    tree.refresh();
    await connectProfile(made.profile.id);
  });

  reg('dbExplainer.connect', async (n?: Node) => {
    let id = idOf(n);
    if (!id) {
      const pick = await vscode.window.showQuickPick(store.list().map((p) => ({ label: p.name, id: p.id })), { placeHolder: 'Connect to which database?' });
      id = pick?.id;
    }
    if (id) await connectProfile(id);
  });

  reg('dbExplainer.disconnect', async (n?: Node) => {
    const id = idOf(n);
    if (id) await sources.disconnect(id);
  });

  reg('dbExplainer.removeConnection', async (n?: Node) => {
    const id = idOf(n);
    if (!id) return;
    if (n?.kind === 'shared') {
      await sources.disconnect(id);
      return;
    }
    await sources.disconnect(id);
    await store.remove(id);
    tree.refresh();
  });

  reg('dbExplainer.refresh', async () => {
    try {
      await Promise.all(sources.list().filter((s) => s.connector).map((s) => sources.refresh(s.id)));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not refresh: ${(e as Error).message}`);
    }
    tree.refresh();
  });

  reg('dbExplainer.shareSql', async (uri?: vscode.Uri) => {
    let label = 'pasted.sql';
    let text: string | undefined;
    if (uri instanceof vscode.Uri) {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      label = path.basename(uri.fsPath);
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'sql') {
        text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
        label = path.basename(editor.document.fileName) || label;
      } else {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Choose a .sql file...', value: 'file' },
            { label: 'Paste SQL from the clipboard', value: 'clip' },
          ],
          { placeHolder: 'Share SQL with the chat' },
        );
        if (!choice) return;
        if (choice.value === 'clip') text = await vscode.env.clipboard.readText();
        else {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQL: ['sql', 'ddl', 'txt'] } });
          if (!picked?.length) return;
          text = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
          label = path.basename(picked[0].fsPath);
        }
      }
    }
    if (!text?.trim()) {
      void vscode.window.showWarningMessage('There is no SQL to share.');
      return;
    }
    const r = sources.addSharedSql(label, text);
    const panel = openChat();
    panel.pushState();
    panel.notice(`Shared ${label}: ${r.source.model.tables.length} tables found${r.skipped ? `, ${r.skipped} statement(s) not fully understood` : ''}.`);
  });

  reg('dbExplainer.askAboutTable', (n?: Node) => {
    if (n?.kind !== 'table') return;
    sources.setActive(n.sourceId);
    openChat().ask(`What is the ${n.key} table for, what are its columns, and how does it connect to the other tables?`);
  });

  reg('dbExplainer.addNote', async () => {
    const f = notesFile();
    if (!f) {
      void vscode.window.showWarningMessage('Open a folder first: the team notes file lives in your workspace.');
      return;
    }
    const tables = sources.active()?.model.tables.map((t) => t.name) ?? [];
    const table = await vscode.window.showQuickPick(['(General note)', ...tables], { placeHolder: 'Which table is the note about?' });
    if (!table) return;
    const note = await vscode.window.showInputBox({ prompt: 'What should everyone know? For example: status 3 means shipped.', ignoreFocusOut: true });
    if (!note) return;
    saveNote(f, note, table === '(General note)' ? undefined : table);
    void vscode.window.showInformationMessage('Saved to the team notes.');
  });

  reg('dbExplainer.openNotes', async () => {
    const f = notesFile();
    if (!f) {
      void vscode.window.showWarningMessage('Open a folder first: the team notes file lives in your workspace.');
      return;
    }
    if (!readNotes(f)) saveNote(f, 'Replace this with something your team should know.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(f));
  });

  reg('dbExplainer.ai.setKey', async () => {
    const key = await vscode.window.showInputBox({ prompt: 'API key for your AI service. It is kept in VS Code secret storage and sent only to the base URL you configured.', password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    if (key.trim()) await context.secrets.store(KEY_SECRET, key.trim());
    else await context.secrets.delete(KEY_SECRET);
    openChat().pushState();
  });

  reg('dbExplainer.ai.clearKey', async () => {
    await context.secrets.delete(KEY_SECRET);
    void vscode.window.showInformationMessage('API key removed.');
  });

  reg('dbExplainer.ai.test', async () => {
    try {
      const cfg = aiConfig();
      normalizeBaseUrl(cfg.baseUrl, false);
      await allowHost(cfg);
      const models = await listModels(cfg, await context.secrets.get(KEY_SECRET));
      void vscode.window.showInformationMessage(`The AI service answered. ${models.length} model(s) available${cfg.model && !models.includes(cfg.model) && models.length ? `; "${cfg.model}" is not in the list` : ''}.`);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('dbExplainer') && ChatPanel.current?.pushState()));

  // What the end-to-end test drives. Nothing in the normal user interface depends on it.
  return { sources, store, conversation, ChatPanel };
}

export function deactivate(): void {}

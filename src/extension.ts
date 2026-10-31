import * as path from 'path';
import * as vscode from 'vscode';
import { AiConfig, AiError, isLocalUrl } from './ai/client';
import { dayStamp, expiryWarnings, isValidDate, preset, ProfileStore } from './ai/profiles';
import { AiService } from './ai/service';
import { changeKey } from './changeKey';
import { Conversation } from './chat/conversation';
import { ConnectionStore, promptForConnection } from './connections';
import { KeysDeps, KeysPanel } from './keysPanel';
import { readNotes, saveNote } from './notes';
import { ChatPanel } from './panel';
import { SourceManager } from './sources';
import { AiStatusBar, SWITCH, switchProfile } from './statusBar';
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
  async function allowHost(baseUrl: string): Promise<void> {
    if (isLocalUrl(baseUrl)) return;
    const host = new URL(baseUrl).host;
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

  // AI profiles: metadata in extension state, keys only in secret storage. With no profiles the old dbExplainer.ai.* settings and
  // the old single key are used exactly as before.
  const profiles = new ProfileStore(context.globalState, context.secrets);
  const ai = new AiService({
    store: profiles,
    legacy: aiConfig,
    legacyKey: () => context.secrets.get(KEY_SECRET),
    fallback: () => settings().get<boolean>('ai.fallback', false),
    allowHost,
    notice: (text) => ChatPanel.current?.notice(text),
  });
  const keysDeps: KeysDeps = {
    store: profiles,
    service: ai,
    fallback: () => settings().get<boolean>('ai.fallback', false),
    setFallback: (on) => settings().update('ai.fallback', on, vscode.ConfigurationTarget.Global),
    legacy: aiConfig,
  };

  // A rejected key is fixed in one click from the message itself. Shown at most every 30 seconds, since one question can fail twice.
  let lastToast = 0;
  const conversation = new Conversation({
    ai: (messages) =>
      ai.chat(messages).catch((e) => {
        if (e instanceof AiError && e.code === 'auth' && profiles.active() && Date.now() - lastToast > 30_000) {
          lastToast = Date.now();
          void vscode.window.showErrorMessage(e.message, 'Change key').then((pick) => pick && vscode.commands.executeCommand('dbExplainer.ai.changeKey'));
        }
        throw e;
      }),
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
      aiReady: () => ai.ready(),
      saveNote: async (text, table) => {
        const f = notesFile();
        if (!f) throw new Error('Open a folder first: the team notes file lives in your workspace.');
        saveNote(f, text, table);
      },
      keyPasted: async (found) => {
        const what = `${found.provider ? `${preset(found.provider).name} ` : ''}API key`;
        const pick = await vscode.window.showInformationMessage(
          `That looks like ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}, so it was not sent to the AI. If it came from a shared chat or screen, consider revoking it. Save it as a profile?`,
          'Save as profile',
          'No thanks',
        );
        if (pick === 'Save as profile') KeysPanel.open(context, keysDeps, found);
      },
      manageAi: () => KeysPanel.open(context, keysDeps, undefined, true),
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

  // Changing a key is one path whoever asks: the command, the status bar, the Manage page or the "key rejected" message.
  const changeKeyNow = (id?: string): Promise<void> =>
    changeKey(
      {
        store: profiles,
        service: ai,
        promptKey: (forWhat) => vscode.window.showInputBox({ title: 'Change API key', prompt: `New API key for ${forWhat}. Kept in VS Code secret storage.`, password: true, ignoreFocusOut: true, validateInput: (v) => (/\s/.test(v.trim()) ? 'A key cannot contain spaces' : undefined) }),
        promptDate: (current) => vscode.window.showInputBox({ title: 'Change API key', prompt: 'New expiry date, YYYY-MM-DD. Leave empty to remove it, Escape to keep it.', value: current, ignoreFocusOut: true, validateInput: (v) => (!v.trim() || isValidDate(v.trim()) ? undefined : 'Use the form YYYY-MM-DD') }),
        setLegacyKey: (key) => context.secrets.store(KEY_SECRET, key),
        report: (ok, text, pid) => {
          void (ok ? vscode.window.showInformationMessage(text) : vscode.window.showErrorMessage(text));
          if (pid) void KeysPanel.current?.showTest(pid, ok, text);
          ChatPanel.current?.pushState();
        },
      },
      id,
    );

  // These three act on the profile in use, or on the old single key when there are no profiles.
  reg('dbExplainer.ai.setKey', () => changeKeyNow());
  reg('dbExplainer.ai.changeKey', (id?: unknown) => changeKeyNow(typeof id === 'string' ? id : undefined));

  reg('dbExplainer.ai.clearKey', async () => {
    const p = profiles.active();
    const sure = await vscode.window.showWarningMessage(`Remove the saved API key${p ? ` for "${p.label}"` : ''}?`, { modal: true }, 'Remove');
    if (sure !== 'Remove') return;
    if (p) await profiles.setKey(p.id, '');
    else await context.secrets.delete(KEY_SECRET);
    void vscode.window.showInformationMessage('API key removed.');
  });

  reg('dbExplainer.ai.test', async () => {
    const r = await ai.test(profiles.active()?.id);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showErrorMessage(r.message));
  });

  reg('dbExplainer.ai.manage', (startAdd?: unknown) => KeysPanel.open(context, keysDeps, undefined, startAdd === true));
  reg(SWITCH, () => switchProfile(profiles));

  const statusBar = new AiStatusBar(profiles, aiConfig);
  context.subscriptions.push(statusBar);

  /** Warns once a day per key that is about to expire or already has. Expired keys are skipped elsewhere, this only tells the developer. */
  let warning = false;
  const warnAboutExpiry = async (): Promise<void> => {
    // Two calls close together must not both toast, so only one runs at a time.
    if (warning) return;
    warning = true;
    try {
      const now = new Date();
      const today = dayStamp(now);
      const done = profiles.warnedToday(today);
      const w = expiryWarnings(profiles.list(), now, done);
      if (!w.ids.length) return;
      for (const id of w.ids) done.add(id);
      await profiles.markWarned(today, done);
      void vscode.window.showWarningMessage(w.messages.join('\n'), 'Change key', 'Manage AI Keys').then((pick) => {
        if (pick === 'Change key') void vscode.commands.executeCommand(w.ids.length === 1 ? 'dbExplainer.ai.changeKey' : 'dbExplainer.ai.manage', ...(w.ids.length === 1 ? [w.ids[0]] : []));
        else if (pick) void vscode.commands.executeCommand('dbExplainer.ai.manage');
      });
    } finally {
      warning = false;
    }
  };
  const refreshAi = (): void => {
    statusBar.update();
    ChatPanel.current?.pushState();
  };
  context.subscriptions.push({
    dispose: profiles.onChange(() => {
      refreshAi();
      void warnAboutExpiry();
    }),
  });
  void warnAboutExpiry();
  // A key can cross its expiry date while VS Code stays open, so look again every hour.
  const hourly = setInterval(() => {
    refreshAi();
    void KeysPanel.current?.push();
    void warnAboutExpiry();
  }, 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(hourly) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dbExplainer')) return;
      refreshAi();
      void KeysPanel.current?.push();
    }),
  );

  // What the end-to-end test drives. Nothing in the normal user interface depends on it.
  return { sources, store, conversation, ChatPanel, ai, profiles };
}

export function deactivate(): void {}

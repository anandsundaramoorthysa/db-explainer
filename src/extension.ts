import * as path from 'path';
import * as vscode from 'vscode';
import { AiConfig, AiError, isLocalUrl } from './ai/client';
import { COPILOT_ADDRESS, dayStamp, expiryWarnings, isValidDate, modelsOf, newProfileId, preset, ProfileStore, withModel } from './ai/profiles';
import { AiService } from './ai/service';
import { rankModels } from './ai/modelPick';
import { vscodeCopilot } from './ai/vscodeLm';
import { registerDex } from './chatParticipant';
import { DiagramPanel } from './diagramPanel';
import { registerSqlEditor, statementAt } from './editor/sqlEditor';
import { dataDictionary } from './model/dictionary';
import { addKey, changeKey, ChangeKeyDeps } from './changeKey';
import { Conversation, Deps } from './chat/conversation';
import { ConnectionStore, promptForConnection } from './connections';
import { certificateProblem } from './db/tls';
import { KeysDeps, KeysPanel } from './keysPanel';
import { readNotes, resolveNotesFile, saveNote } from './notes';
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
  // The notes file must stay inside the workspace, whatever the setting says.
  return resolveNotesFile(folder.uri.fsPath, settings().get<string>('notes.path', '.dbexplainer/notes.md'));
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context);
  const sources = new SourceManager(path.join(context.extensionPath, 'out'));
  const tree = new DatabaseTree(store, sources);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('dbExplainer.connections', tree), { dispose: () => void sources.disposeAll() });

  /** The first time data is sent to a host that is not on this computer, the developer says yes or no once. */
  async function allowHost(baseUrl: string): Promise<void> {
    if (isLocalUrl(baseUrl)) return;
    // Copilot has no address of its own: VS Code sends the request to GitHub on the developer's behalf.
    const host = baseUrl === COPILOT_ADDRESS ? 'GitHub Copilot' : new URL(baseUrl).host;
    const allowed = context.globalState.get<string[]>(HOSTS_KEY, []);
    if (allowed.includes(host)) return;
    const pick = await vscode.window.showWarningMessage(
      `DB Explainer will send your table and column names, your notes and your questions, and the API key saved for it, to ${host}. Row values are never sent unless you press "Let the AI see these rows".`,
      { modal: true },
      'Allow',
    );
    if (pick !== 'Allow') throw new AiError('Cancelled. Nothing was sent.', 'config');
    await context.globalState.update(HOSTS_KEY, [...allowed, host]);
  }

  // AI profiles: metadata in extension state, keys only in secret storage. With no profiles the old dbExplainer.ai.* settings and
  // the old single key are used exactly as before.
  const profiles = new ProfileStore(context.globalState, context.secrets);
  // Copilot's models are looked up once and again whenever they change, so buttons can be offered only where Copilot works.
  const copilot = vscodeCopilot();
  let copilotModels: string[] = [];
  const refreshCopilot = async (): Promise<void> => {
    copilotModels = await copilot.models();
    ChatPanel.current?.pushState();
    void KeysPanel.current?.push();
  };
  context.subscriptions.push(copilot.onChange(() => void refreshCopilot()));
  void refreshCopilot();
  const ai = new AiService({
    store: profiles,
    copilot,
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
    copilotModels: async () => copilotModels,
  };

  // A rejected key is fixed in one click from the message itself. Shown at most every 30 seconds, since one question can fail twice.
  let lastToast = 0;
  const convDeps: Deps = {
    ai: (messages, onText, signal) =>
      ai.chat(messages, onText, signal).catch((e) => {
        // A retired model is also fixed in one click: each button makes that saved model the one in use.
        const inUse = profiles.active();
        if (e instanceof AiError && e.code === 'model' && inUse && Date.now() - lastToast > 30_000) {
          lastToast = Date.now();
          const others = modelsOf(inUse).filter((m) => m !== inUse.model).slice(0, 2);
          void vscode.window.showErrorMessage(e.message, ...others, 'Manage AI Keys').then(async (pick) => {
            const latest = profiles.active();
            if (pick === 'Manage AI Keys') await vscode.commands.executeCommand('dbExplainer.ai.manage');
            else if (pick && latest) await profiles.save(withModel(latest, pick));
          });
        }
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
  };
  const conversation = new Conversation(convDeps);

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
      copilotAvailable: () => copilotModels.length > 0,
      useCopilot: () => void vscode.commands.executeCommand('dbExplainer.ai.useCopilot'),
      trySample: () => void vscode.commands.executeCommand('dbExplainer.trySample'),
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
      // A certificate that cannot be checked is a choice for the developer, not a dead end: trust the provider's authority file,
      // or knowingly connect without the check. Either is remembered for this connection only.
      const problem = profile.engine !== 'sqlite' && profile.tlsVerify !== false ? certificateProblem(e) : undefined;
      if (!problem) {
        void vscode.window.showErrorMessage(`Could not connect to ${profile.name}: ${(e as Error).message}`);
        return;
      }
      const CA = 'Choose CA file...';
      const ANYWAY = "Connect anyway (don't verify)";
      const pick = await vscode.window.showErrorMessage(
        `${profile.name}: the server's certificate could not be verified (${problem}). This is normal for a self-signed certificate, or a provider such as AWS RDS whose certificate authority is not built in. Choose the provider's certificate authority file to stay fully protected, or connect without verifying: still encrypted, but someone on the network could pretend to be the server.`,
        CA,
        ANYWAY,
      );
      if (pick === CA) {
        const file = await vscode.window.showOpenDialog({ title: 'Certificate authority file from your database provider', canSelectMany: false, filters: { Certificates: ['pem', 'crt', 'cer'], 'All files': ['*'] } });
        if (!file?.length) return;
        await store.save({ ...profile, caFile: file[0].fsPath });
        return connectProfile(id);
      }
      if (pick === ANYWAY) {
        await store.save({ ...profile, tlsVerify: false });
        return connectProfile(id);
      }
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
  const keyPrompts = (title: string): ChangeKeyDeps => ({
    store: profiles,
    service: ai,
    promptKey: (forWhat) => vscode.window.showInputBox({ title, prompt: `New API key for ${forWhat}. Kept in VS Code secret storage.`, password: true, ignoreFocusOut: true, validateInput: (v) => (/\s/.test(v.trim()) ? 'A key cannot contain spaces' : undefined) }),
    promptDate: (current) => vscode.window.showInputBox({ title, prompt: 'New expiry date, YYYY-MM-DD. Leave empty to remove it, Escape to keep it.', value: current, ignoreFocusOut: true, validateInput: (v) => (!v.trim() || isValidDate(v.trim()) ? undefined : 'Use the form YYYY-MM-DD') }),
    setLegacyKey: (key) => context.secrets.store(KEY_SECRET, key),
    report: (ok, text, pid) => {
      void (ok ? vscode.window.showInformationMessage(text) : vscode.window.showErrorMessage(text));
      if (pid) void KeysPanel.current?.showTest(pid, ok, text);
      ChatPanel.current?.pushState();
    },
  });
  const text = (v?: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  // These act on the key in use of the profile in use, or on the old single key when there are no profiles.
  reg('dbExplainer.ai.setKey', () => changeKey(keyPrompts('Change API key')));
  reg('dbExplainer.ai.changeKey', (id?: unknown, keyId?: unknown) => changeKey(keyPrompts('Change API key'), text(id), text(keyId)));
  reg('dbExplainer.ai.addKey', (id?: unknown) => {
    // No profile yet means there is nothing to add to, so this goes straight to the Add form.
    if (!profiles.active()) {
      KeysPanel.open(context, keysDeps, undefined, true);
      return;
    }
    return addKey(keyPrompts('Add another API key'), text(id));
  });

  reg('dbExplainer.ai.clearKey', async () => {
    const p = profiles.active();
    const sure = await vscode.window.showWarningMessage(`Remove the saved API key${p ? ` for "${p.label}"` : ''}?`, { modal: true }, 'Remove');
    if (sure !== 'Remove') return;
    if (p) await profiles.removeKey(p.id, profiles.currentKeyId(p));
    else await context.secrets.delete(KEY_SECRET);
    void vscode.window.showInformationMessage('API key removed.');
  });

  reg('dbExplainer.ai.test', async () => {
    const r = await ai.test(profiles.active()?.id);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showErrorMessage(r.message));
  });

  reg('dbExplainer.ai.manage', (startAdd?: unknown) => KeysPanel.open(context, keysDeps, undefined, startAdd === true));
  reg(SWITCH, () => switchProfile(profiles));

  // One click to use Copilot: no key, no address. The newest profile becomes the one in use.
  reg('dbExplainer.ai.useCopilot', async () => {
    await refreshCopilot();
    if (!copilotModels.length) {
      const pick = await vscode.window.showWarningMessage('GitHub Copilot is not available. Install the GitHub Copilot extension and sign in, then try again. Or add a free Groq or Gemini key instead.', 'Add an AI key');
      if (pick) KeysPanel.open(context, keysDeps, undefined, true);
      return;
    }
    const existing = profiles.list().find((p) => p.provider === 'vscode');
    const model = existing && copilotModels.includes(existing.model) ? existing.model : (rankModels(copilotModels)[0] ?? copilotModels[0]);
    const profile = existing
      ? { ...withModel(existing, model), models: [...new Set([model, ...copilotModels])] }
      : { id: newProfileId(), label: 'Copilot', provider: 'vscode' as const, baseUrl: COPILOT_ADDRESS, model, models: copilotModels };
    await profiles.save(profile);
    await profiles.setActive(profile.id);
    void vscode.window.showInformationMessage(`DB Explainer now uses ${model} through GitHub Copilot. No key needed.`);
  });

  // The sample store: a small read-only SQLite database shipped with the extension, so the first question needs no setup.
  reg('dbExplainer.trySample', async () => {
    const profile = { id: 'sample', name: 'Sample store', engine: 'sqlite' as const, filePath: path.join(context.extensionPath, 'out', 'sample.db') };
    try {
      if (!sources.isConnected(profile.id)) await sources.connect(profile, undefined);
      sources.setActive(profile.id);
      const panel = openChat();
      panel.pushState();
      panel.notice('The sample store is connected: customers, products, orders, order items and employees. Try "Which customers have never ordered?"');
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not open the sample database: ${(e as Error).message}`);
    }
  });

  /** The SQL to act on: what was passed (from the lens above a statement), else the selection or the statement under the cursor. */
  const sqlFrom = (arg: unknown): string | undefined => {
    if (typeof arg === 'string' && arg.trim()) return arg;
    const editor = vscode.window.activeTextEditor;
    return editor ? statementAt(editor) : undefined;
  };

  reg('dbExplainer.explainSql', (arg?: unknown, uri?: unknown) => {
    const sql = sqlFrom(arg);
    if (!sql) {
      void vscode.window.showInformationMessage('Put the cursor in a SQL statement, or select one, then try again.');
      return;
    }
    // With nothing shared yet, the file itself is shared, so its own tables explain its queries. One click, no setup.
    if (!sources.active()) {
      const doc = vscode.workspace.textDocuments.find((d) => uri instanceof vscode.Uri && d.uri.toString() === uri.toString()) ?? vscode.window.activeTextEditor?.document;
      if (doc) sources.addSharedSql(path.basename(doc.fileName) || 'query.sql', doc.getText());
    }
    const panel = openChat();
    panel.pushState();
    const fence = '`'.repeat(3);
    panel.ask(/^\s*(select|with)\b/i.test(sql) ? sql : `Explain what this SQL does, step by step:\n${fence}sql\n${sql}\n${fence}`);
  });

  reg('dbExplainer.checkSpeed', async (arg?: unknown) => {
    const sql = sqlFrom(arg);
    if (!sql) {
      void vscode.window.showInformationMessage('Put the cursor in a SELECT query, or select one, then try again.');
      return;
    }
    if (!sources.active()?.connector) {
      const pick = await vscode.window.showInformationMessage('Checking speed needs a live database to ask how it would run the query.', 'Try the sample database', 'Add a connection');
      if (pick === 'Try the sample database') await vscode.commands.executeCommand('dbExplainer.trySample');
      else if (pick) await vscode.commands.executeCommand('dbExplainer.addConnection');
      return;
    }
    const panel = openChat();
    panel.pushState();
    await panel.checkSpeed(sql);
  });

  const askAbout = (sourceId: string, key: string): void => {
    sources.setActive(sourceId);
    openChat().ask(`What is the ${key} table for, what are its columns, and how does it connect to the other tables?`);
  };
  const needSource = (): void => {
    void vscode.window.showInformationMessage('Connect a database or share some SQL first.', 'Try the sample database').then((p) => p && vscode.commands.executeCommand('dbExplainer.trySample'));
  };
  reg('dbExplainer.showDiagram', () => {
    const s = sources.active();
    if (!s) return needSource();
    DiagramPanel.show(context, s.id, s.label, s.model, { ask: askAbout });
  });
  context.subscriptions.push({
    dispose: sources.onDidChange(() => {
      const s = sources.active();
      if (s && DiagramPanel.current?.isShowing(s.id)) DiagramPanel.current.update(s.id, s.label, s.model);
    }),
  });

  // A Markdown page for the repository, made from the structure and the team notes only. Opened unsaved, so nothing is overwritten.
  reg('dbExplainer.exportDictionary', async () => {
    const s = sources.active();
    if (!s) return needSource();
    const f = notesFile();
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: dataDictionary(s.model, f ? readNotes(f) : '') });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
    await vscode.commands.executeCommand('markdown.showPreviewToSide');
  });

  registerSqlEditor(context, {
    model: () => sources.active()?.model,
    live: () => !!sources.active()?.connector,
    onModelChange: (fn) => sources.onDidChange(fn),
  });

  // @dex in Copilot Chat, with its own conversation. A VS Code build without chat must not stop the rest of the extension.
  try {
    registerDex(context, { sources, conversation: new Conversation(convDeps), aiReady: () => ai.ready(), copilotAvailable: () => copilotModels.length > 0 });
  } catch {
    // No chat in this VS Code: everything else still works.
  }

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
        if (pick === 'Change key') void vscode.commands.executeCommand(w.ids.length === 1 ? 'dbExplainer.ai.changeKey' : 'dbExplainer.ai.manage', ...(w.ids.length === 1 ? [w.targets[0].profileId, w.targets[0].keyId] : []));
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

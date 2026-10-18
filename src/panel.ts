import * as vscode from 'vscode';
import { Conversation } from './chat/conversation';
import { renderMarkdown } from './render';
import { SourceManager } from './sources';
import { QueryResult } from './types';

export interface PanelHooks {
  aiReady: () => boolean;
  saveNote: (text: string, table?: string) => Promise<void>;
}

interface Inbound {
  type: string;
  text?: string;
  sql?: string;
  id?: string;
  runId?: string;
  table?: string;
  href?: string;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The chat window. All the thinking is in Conversation, this only moves messages between it and the page. */
export class ChatPanel {
  static current: ChatPanel | undefined;
  /** Lets the end-to-end test see what the page is sent. Unused in normal operation. */
  static tap: ((m: object) => void) | undefined;
  private readonly runs = new Map<string, { sourceId: string; sql: string; result: QueryResult }>();
  private counter = 0;
  private busy = false;

  static open(context: vscode.ExtensionContext, sources: SourceManager, conversation: Conversation, hooks: PanelHooks): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('dbExplainer.chat', 'DB Explainer', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    ChatPanel.current = new ChatPanel(panel, context, sources, conversation, hooks);
    return ChatPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly sources: SourceManager,
    private readonly conversation: Conversation,
    private readonly hooks: PanelHooks,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(context);
    panel.webview.onDidReceiveMessage((m: Inbound) => void this.handle(m));
    sources.onDidChange(() => this.pushState());
    panel.onDidDispose(() => {
      ChatPanel.current = undefined;
    });
  }

  /** Puts a question in the box and sends it, used by "Ask about this table". */
  ask(text: string): void {
    void this.panel.webview.postMessage({ type: 'prefill', text, send: true });
  }

  pushState(): void {
    ChatPanel.tap?.({ type: 'state' });
    void this.panel.webview.postMessage({ type: 'state', sources: this.sources.info(), activeId: this.sources.active()?.id, aiReady: this.hooks.aiReady() });
  }

  notice(text: string): void {
    void this.panel.webview.postMessage({ type: 'notice', text });
  }

  private post(m: object): void {
    ChatPanel.tap?.(m);
    void this.panel.webview.postMessage(m);
  }

  async handle(m: Inbound): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.pushState();
        return;
      case 'select':
        if (m.id) this.sources.setActive(m.id);
        return;
      case 'clear':
        this.conversation.reset();
        this.runs.clear();
        return;
      case 'ask':
        return this.ask_(m.text ?? '');
      case 'run':
        return this.run(m.sql ?? '');
      case 'explainRows':
        return this.explainRows(m.runId ?? '');
      case 'copy':
        await vscode.env.clipboard.writeText(m.sql ?? '');
        return;
      case 'insert': {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: m.sql ?? '' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        return;
      }
      case 'note':
        if (m.text?.trim()) {
          await this.hooks.saveNote(m.text, m.table || undefined);
          this.post({ type: 'notice', text: 'Saved to the team notes. The next answer will use it.' });
        }
        return;
      case 'link':
        if (m.href && /^https:\/\//i.test(m.href)) await vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;
    }
  }

  private async ask_(text: string): Promise<void> {
    const source = this.sources.active();
    if (!text.trim() || this.busy) return;
    if (!source) {
      this.post({ type: 'error', text: 'Nothing is shared yet. Add a database connection or share a SQL file first.' });
      return;
    }
    this.busy = true;
    this.post({ type: 'thinking', on: true });
    try {
      const a = await this.conversation.ask(source, text);
      this.post({ type: 'answer', html: renderMarkdown(a.text), sql: a.sql, tables: a.tables, statsUsed: a.statsUsed, canRun: !!source.connector });
    } catch (e) {
      this.post({ type: 'error', text: (e as Error).message });
    } finally {
      this.busy = false;
      this.post({ type: 'thinking', on: false });
    }
  }

  private async run(sql: string): Promise<void> {
    const source = this.sources.active();
    if (!source) return;
    const outcome = await this.conversation.run(source, sql);
    if (!outcome.ok) {
      this.post({ type: 'runError', sql, text: outcome.reason });
      return;
    }
    const runId = `r${(this.counter += 1)}`;
    this.runs.set(runId, { sourceId: source.id, sql: outcome.sql, result: outcome.result });
    const r = outcome.result;
    this.post({ type: 'result', runId, sql, columns: r.columns, rows: r.rows.map((row) => row.map(cell)), truncated: r.truncated, elapsedMs: r.elapsedMs, rowCount: r.rowCount });
  }

  private async explainRows(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    const source = this.sources.get(run?.sourceId);
    if (!run || !source || this.busy) return;
    this.busy = true;
    this.post({ type: 'thinking', on: true });
    try {
      const a = await this.conversation.explainRows(source, run.sql, run.result);
      this.post({ type: 'answer', html: renderMarkdown(a.text), sql: a.sql, tables: a.tables, statsUsed: a.statsUsed, canRun: !!source.connector });
    } catch (e) {
      this.post({ type: 'error', text: (e as Error).message });
    } finally {
      this.busy = false;
      this.post({ type: 'thinking', on: false });
    }
  }

  private html(context: vscode.ExtensionContext): string {
    const w = this.panel.webview;
    const uri = (f: string): vscode.Uri => w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('chat.css')}">
<title>DB Explainer</title></head>
<body>
<header>
  <label for="source">Database</label>
  <select id="source" aria-label="Database to ask about"></select>
  <button id="clear" class="ghost" title="Start a new conversation">New chat</button>
</header>
<div id="banner" class="banner" role="status" hidden></div>
<main id="log" aria-live="polite"></main>
<div id="thinking" class="thinking" hidden>Thinking...</div>
<form id="form">
  <textarea id="input" rows="2" placeholder="Ask about the database, ask for a query, or paste one to have it explained" aria-label="Your question"></textarea>
  <button id="send" type="submit">Send</button>
</form>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body></html>`;
  }
}

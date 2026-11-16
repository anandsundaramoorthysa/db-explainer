import * as vscode from 'vscode';
import { layoutDiagram, mermaidEr } from './model/diagram';
import { SchemaModel } from './types';

export interface DiagramHooks {
  /** Asks Dex about a table, from a click on its box. */
  ask: (sourceId: string, tableKey: string) => void;
}

/** A picture of the tables and how their foreign keys link them. Click a table to ask about it. */
export class DiagramPanel {
  static current: DiagramPanel | undefined;
  private sourceId = '';
  private model: SchemaModel | undefined;

  static show(context: vscode.ExtensionContext, sourceId: string, label: string, model: SchemaModel, hooks: DiagramHooks): DiagramPanel {
    if (!DiagramPanel.current) {
      const panel = vscode.window.createWebviewPanel('dbExplainer.diagram', 'Table diagram', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      });
      DiagramPanel.current = new DiagramPanel(panel, context, hooks);
    } else {
      DiagramPanel.current.panel.reveal(vscode.ViewColumn.Active);
    }
    DiagramPanel.current.update(sourceId, label, model);
    return DiagramPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly hooks: DiagramHooks,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(context);
    panel.webview.onDidReceiveMessage((m: { type: string; key?: string }) => void this.handle(m));
    panel.onDidDispose(() => (DiagramPanel.current = undefined));
  }

  /** Redraws, for example after the structure was read again. */
  update(sourceId: string, label: string, model: SchemaModel): void {
    this.sourceId = sourceId;
    this.model = model;
    this.panel.title = `Diagram: ${label}`;
    void this.panel.webview.postMessage({ type: 'layout', layout: layoutDiagram(model) });
  }

  isShowing(sourceId: string): boolean {
    return this.sourceId === sourceId;
  }

  private async handle(m: { type: string; key?: string }): Promise<void> {
    if (m.type === 'ready' && this.model) void this.panel.webview.postMessage({ type: 'layout', layout: layoutDiagram(this.model) });
    if (m.type === 'ask' && m.key && this.model?.tables.some((t) => (t.schema ? `${t.schema}.${t.name}` : t.name) === m.key)) this.hooks.ask(this.sourceId, m.key);
    if (m.type === 'copyMermaid' && this.model) {
      await vscode.env.clipboard.writeText('```mermaid\n' + mermaidEr(this.model) + '\n```\n');
      void vscode.window.showInformationMessage('Copied as a Mermaid diagram. Paste it into a README, wiki or pull request.');
    }
  }

  private html(context: vscode.ExtensionContext): string {
    const w = this.panel.webview;
    const uri = (f: string): vscode.Uri => w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('diagram.css')}">
<title>Table diagram</title></head>
<body>
<header>
  <strong id="title">Table diagram</strong>
  <span class="hint">Drag to move, scroll to zoom, click a table to ask about it.</span>
  <button id="fit" class="ghost">Fit</button>
  <button id="mermaid" class="ghost">Copy as Mermaid</button>
</header>
<div id="empty" class="empty" hidden>This database has no tables yet.</div>
<svg id="canvas" role="img" aria-label="Diagram of the tables and their links"><g id="world"></g></svg>
<script nonce="${nonce}" src="${uri('diagram.js')}"></script>
</body></html>`;
  }
}

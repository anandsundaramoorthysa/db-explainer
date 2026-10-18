import * as vscode from 'vscode';
import { ConnectionStore } from './connections';
import { findTable, tableKey } from './model/schemaModel';
import { SourceManager } from './sources';
import { ConnectionProfile, ENGINE_LABEL } from './types';

export type Node =
  | { kind: 'connection'; profile: ConnectionProfile }
  | { kind: 'shared'; id: string }
  | { kind: 'table'; sourceId: string; key: string }
  | { kind: 'column'; sourceId: string; key: string; column: string };

/** Databases in the sidebar: saved connections, shared SQL, and (when active) their tables and columns. */
export class DatabaseTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: ConnectionStore, private readonly sources: SourceManager) {
    sources.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'connection') {
      const live = this.sources.isConnected(node.profile.id);
      const item = new vscode.TreeItem(node.profile.name, live ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = `conn:${node.profile.id}`;
      item.description = live ? `${ENGINE_LABEL[node.profile.engine]} - connected` : ENGINE_LABEL[node.profile.engine];
      item.iconPath = new vscode.ThemeIcon(live ? 'database' : 'debug-disconnect');
      item.contextValue = live ? 'connectionActive' : 'connectionIdle';
      item.command = live ? undefined : { command: 'dbExplainer.connect', title: 'Connect', arguments: [node] };
      return item;
    }
    if (node.kind === 'shared') {
      const s = this.sources.get(node.id);
      const item = new vscode.TreeItem(s?.label ?? node.id, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `shared:${node.id}`;
      item.description = 'shared SQL';
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.contextValue = 'connectionShared';
      return item;
    }
    const source = this.sources.get(node.sourceId);
    const table = source ? findTable(source.model, node.key) : undefined;
    if (node.kind === 'table') {
      const item = new vscode.TreeItem(node.key, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `table:${node.sourceId}:${node.key}`;
      item.iconPath = new vscode.ThemeIcon(table?.kind === 'view' ? 'eye' : 'table');
      item.description = table?.rowCount !== undefined ? `${table.rowCountIsEstimate ? '~' : ''}${table.rowCount.toLocaleString('en-US')} rows` : undefined;
      item.tooltip = table?.comment;
      item.contextValue = 'table';
      return item;
    }
    const col = table?.columns.find((c) => c.name === node.column);
    const item = new vscode.TreeItem(node.column, vscode.TreeItemCollapsibleState.None);
    item.id = `col:${node.sourceId}:${node.key}:${node.column}`;
    const flags = [col?.dataType, col?.isPrimaryKey ? 'PK' : '', col && !col.nullable && !col.isPrimaryKey ? 'NOT NULL' : ''].filter(Boolean);
    item.description = flags.join(' ');
    item.tooltip = col?.comment;
    item.iconPath = new vscode.ThemeIcon(col?.isPrimaryKey ? 'key' : 'symbol-field');
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const connections = this.store.list().map((profile): Node => ({ kind: 'connection', profile }));
      const shared = this.sources.list().filter((s) => s.kind === 'sql').map((s): Node => ({ kind: 'shared', id: s.id }));
      return [...connections, ...shared];
    }
    if (node.kind === 'connection' || node.kind === 'shared') {
      const id = node.kind === 'connection' ? node.profile.id : node.id;
      const s = this.sources.get(id);
      return s ? s.model.tables.map((t): Node => ({ kind: 'table', sourceId: id, key: tableKey(t) })) : [];
    }
    if (node.kind === 'table') {
      const s = this.sources.get(node.sourceId);
      const t = s ? findTable(s.model, node.key) : undefined;
      return t ? t.columns.map((c): Node => ({ kind: 'column', sourceId: node.sourceId, key: node.key, column: c.name })) : [];
    }
    return [];
  }
}

import * as vscode from 'vscode';
import { SchemaModel } from '../types';
import { checkSqlText, sqlStatements } from './sqlChecks';

export interface SqlEditorDeps {
  /** The database in use, used when a file has no CREATE TABLE statements of its own. */
  model: () => SchemaModel | undefined;
  /** True when queries can be run, so "Check speed" is worth offering. */
  live: () => boolean;
  /** Fires when the database in use changes. Returns a function that stops listening. */
  onModelChange: (fn: () => void) => () => void;
}

const MAX_CHARS = 500_000;
const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };

const isSql = (doc: vscode.TextDocument): boolean => doc.languageId === 'sql' || /\.sql$/i.test(doc.fileName);
const setting = (name: string): boolean => vscode.workspace.getConfiguration('dbExplainer').get<boolean>(`editor.${name}`, true);

/** The statement under the cursor, or the selection if there is one. */
export function statementAt(editor: vscode.TextEditor): string | undefined {
  if (!editor.selection.isEmpty) return editor.document.getText(editor.selection).trim() || undefined;
  const offset = editor.document.offsetAt(editor.selection.active);
  const all = sqlStatements(editor.document.getText());
  return (all.find((s) => offset >= s.start && offset <= s.end + 1) ?? all.find((s) => s.start >= offset))?.text;
}

/** Underlines problems in .sql files as you type, and puts Explain and Check speed above each statement. */
export function registerSqlEditor(context: vscode.ExtensionContext, deps: SqlEditorDeps): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('DB Explainer');
  const timers = new Map<string, NodeJS.Timeout>();

  const check = (doc: vscode.TextDocument): void => {
    if (!isSql(doc)) return;
    if (!setting('checks') || doc.getText().length > MAX_CHARS) {
      diagnostics.delete(doc.uri);
      return;
    }
    const found = checkSqlText(doc.getText(), deps.model());
    diagnostics.set(
      doc.uri,
      found.map((f) => {
        const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)), f.message, SEVERITY[f.severity]);
        d.source = 'DB Explainer';
        return d;
      }),
    );
  };
  const later = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => check(doc), 400));
  };
  const checkAll = (): void => vscode.workspace.textDocuments.forEach(check);

  const lenses = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lenses.event,
    provideCodeLenses(doc) {
      if (!setting('codeLens') || doc.getText().length > MAX_CHARS) return [];
      const live = deps.live();
      return sqlStatements(doc.getText()).flatMap((s) => {
        const range = new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.start));
        const out = [new vscode.CodeLens(range, { title: '$(comment) Explain', tooltip: 'Ask Dex to explain this statement', command: 'dbExplainer.explainSql', arguments: [s.text, doc.uri] })];
        if (s.query && live) out.push(new vscode.CodeLens(range, { title: '$(dashboard) Check speed', tooltip: 'Asks the database how it would run this query, without running it', command: 'dbExplainer.checkSpeed', arguments: [s.text] }));
        return out;
      });
    },
  };

  context.subscriptions.push(
    diagnostics,
    lenses,
    vscode.languages.registerCodeLensProvider([{ language: 'sql' }, { pattern: '**/*.sql' }], provider),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dbExplainer.editor')) return;
      checkAll();
      lenses.fire();
    }),
    { dispose: deps.onModelChange(() => {
      checkAll();
      lenses.fire();
    }) },
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
  checkAll();
}

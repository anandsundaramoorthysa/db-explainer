import * as vscode from 'vscode';
import { AiConfig, AiError, isLocalUrl, normalizeBaseUrl } from './ai/client';
import { keyProblem } from './ai/keyScan';
import { AiService } from './ai/service';
import { describeExpiry, isValidDate, maskKey, newProfileId, preset, PRESETS, Profile, ProfileStore, Provider, statusOf } from './ai/profiles';

export interface KeysDeps {
  store: ProfileStore;
  service: AiService;
  fallback: () => boolean;
  setFallback: (on: boolean) => PromiseLike<void>;
  legacy: () => AiConfig;
}

interface Inbound {
  type: string;
  id?: string;
  label?: string;
  provider?: Provider;
  baseUrl?: string;
  model?: string;
  expiresAt?: string;
  key?: string;
  on?: boolean;
  href?: string;
}

/** A key pasted into the chat. It stays in memory on this side and is never sent to the page. */
export interface PendingKey {
  key: string;
  provider?: Provider;
}

/** The "Manage AI Keys" page. It lists the profiles and never receives more of a key than its last four characters. */
export class KeysPanel {
  static current: KeysPanel | undefined;
  private pending: PendingKey | undefined;
  private readonly fetched = new Map<string, string[]>();
  private readonly off: () => void;

  static open(context: vscode.ExtensionContext, deps: KeysDeps, pending?: PendingKey, startAdd?: boolean): KeysPanel {
    if (KeysPanel.current) {
      KeysPanel.current.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel('dbExplainer.keys', 'Manage AI Keys', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      });
      KeysPanel.current = new KeysPanel(panel, context, deps);
    }
    if (pending) {
      KeysPanel.current.pending = pending;
      void KeysPanel.current.push().then(() => KeysPanel.current?.panel.webview.postMessage({ type: 'startAdd', provider: pending.provider }));
    } else if (startAdd) {
      void KeysPanel.current.push().then(() => KeysPanel.current?.panel.webview.postMessage({ type: 'startAdd' }));
    }
    return KeysPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly deps: KeysDeps,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(context);
    panel.webview.onDidReceiveMessage((m: Inbound) => void this.handle(m));
    this.off = deps.store.onChange(() => void this.push());
    panel.onDidDispose(() => {
      this.off();
      this.pending = undefined;
      KeysPanel.current = undefined;
    });
  }

  private startAddForm(): void {
    KeysPanel.open(this.context, this.deps, undefined, true);
  }

  async push(): Promise<void> {
    const { store } = this.deps;
    const now = new Date();
    const inUse = store.active()?.id;
    const profiles = await Promise.all(
      store.list().map(async (p) => {
        const key = await store.key(p.id);
        return {
          id: p.id,
          label: p.label,
          provider: p.provider,
          providerName: preset(p.provider).name,
          baseUrl: p.baseUrl,
          model: p.model,
          models: [...new Set([...preset(p.provider).models, p.model, ...(this.fetched.get(p.id) ?? [])].filter(Boolean))],
          expiresAt: p.expiresAt ?? '',
          expiryText: describeExpiry(p, now),
          status: statusOf(p, now),
          keyMask: maskKey(key),
          hasKey: !!key,
          local: isLocalUrl(p.baseUrl),
          inUse: p.id === inUse,
        };
      }),
    );
    const legacy = this.deps.legacy();
    void this.panel.webview.postMessage({
      type: 'state',
      profiles,
      fallback: this.deps.fallback(),
      legacy: profiles.length ? undefined : { baseUrl: legacy.baseUrl, model: legacy.model },
      presets: PRESETS.map((p) => ({ provider: p.provider, name: p.name, baseUrl: p.baseUrl, models: p.models, keyUrl: p.keyUrl })),
      pendingKey: this.pending ? { provider: this.pending.provider } : undefined,
    });
  }

  /** Shows a check result on a card, for example after the key was changed. */
  async showTest(id: string, ok: boolean, text: string): Promise<void> {
    await this.push();
    void this.panel.webview.postMessage({ type: 'testResult', id, ok, text });
  }

  private error(text: string): void {
    void this.panel.webview.postMessage({ type: 'formError', text });
  }

  async handle(m: Inbound): Promise<void> {
    const { store } = this.deps;
    switch (m.type) {
      case 'ready':
        return this.push();
      case 'save':
        return this.save(m);
      case 'delete': {
        const p = store.get(m.id);
        if (!p) return;
        const pick = await vscode.window.showWarningMessage(`Delete the profile "${p.label}" and its saved key? This cannot be undone.`, { modal: true }, 'Delete');
        if (pick !== 'Delete') return;
        const wasInUse = store.active()?.id === p.id;
        await store.remove(p.id);
        const next = store.active();
        if (!wasInUse) void vscode.window.showInformationMessage(`Deleted "${p.label}".`);
        else if (next) void vscode.window.showInformationMessage(`Deleted "${p.label}". Now using "${next.label}".`);
        else void vscode.window.showInformationMessage('No AI profile left. Add one in Manage AI Keys.', 'Add profile').then((b) => b && KeysPanel.current?.startAddForm());
        return;
      }
      case 'activate': {
        const p = store.get(m.id);
        if (!p) return;
        if (statusOf(p, new Date()) === 'expired') {
          void vscode.window.showWarningMessage(`"${p.label}" expired on ${p.expiresAt}. Change its expiry date first.`);
          return;
        }
        await store.setActive(p.id);
        return;
      }
      case 'setModel': {
        const p = store.get(m.id);
        const model = m.model?.trim();
        if (p && model && model !== p.model) await store.save({ ...p, model });
        else if (p) void this.push();
        return;
      }
      case 'changeKey':
        if (m.id) await vscode.commands.executeCommand('dbExplainer.ai.changeKey', m.id);
        return;
      case 'test': {
        const p = store.get(m.id);
        if (!p) return;
        void this.panel.webview.postMessage({ type: 'testing', id: p.id });
        const r = await this.deps.service.test(p.id);
        if (r.models.length) this.fetched.set(p.id, r.models);
        await this.push();
        void this.panel.webview.postMessage({ type: 'testResult', id: p.id, ok: r.ok, text: r.message });
        return;
      }
      case 'setFallback':
        await this.deps.setFallback(!!m.on);
        return this.push();
      case 'link':
        // Only the key pages of the presets can be opened, whatever the page asks for.
        if (m.href && PRESETS.some((p) => p.keyUrl === m.href)) await vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;
      case 'discardPending':
        this.pending = undefined;
        return this.push();
    }
  }

  private async save(m: Inbound): Promise<void> {
    const { store } = this.deps;
    const existing = m.id ? store.get(m.id) : undefined;
    const provider = m.provider ?? 'custom';
    const label = (m.label ?? '').trim() || preset(provider).name;
    const baseUrl = (m.baseUrl ?? '').trim();
    const model = (m.model ?? '').trim();
    const expiresAt = (m.expiresAt ?? '').trim();
    // A key typed in the form wins. Otherwise a key pasted in the chat is used for a new profile, and an existing one is kept.
    const typed = (m.key ?? '').trim();
    const problem = typed ? keyProblem(typed) : undefined;
    if (problem) return this.error(problem);
    const key = typed || (!existing ? this.pending?.key : undefined);
    const hasKey = !!(key || (existing && (await store.key(existing.id))));

    if (!baseUrl) return this.error('Enter the base URL of the service.');
    try {
      normalizeBaseUrl(baseUrl, hasKey);
    } catch (e) {
      return this.error((e as AiError).message.replace(/ Fix the setting dbExplainer\.ai\.baseUrl\./, ''));
    }
    if (!model) return this.error('Enter a model name.');
    if (expiresAt && !isValidDate(expiresAt)) return this.error('The expiry date must be a real date.');
    if (!hasKey && !isLocalUrl(baseUrl)) return this.error('This service needs an API key.');

    const profile: Profile = { id: existing?.id ?? newProfileId(), label, provider, baseUrl, model, ...(expiresAt ? { expiresAt } : {}) };
    await store.save(profile, key);
    if (!existing) this.pending = undefined;
    void this.panel.webview.postMessage({ type: 'saved' });
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
<link rel="stylesheet" href="${uri('keys.css')}">
<title>Manage AI Keys</title></head>
<body class="keys">
<header>
  <h1>AI keys</h1>
  <label class="check"><input type="checkbox" id="fallback"> Fall back to the next valid profile on 401, 429 or 503</label>
  <button id="add">Add profile</button>
</header>
<div id="banner" class="banner" role="status" hidden></div>
<main id="list" aria-live="polite"></main>
<script nonce="${nonce}" src="${uri('keys.js')}"></script>
</body></html>`;
  }
}

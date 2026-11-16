import * as vscode from 'vscode';
import { AiConfig, isLocalUrl } from './ai/client';
import { AddressChoice, saveProfileForm } from './ai/profileForm';
import { AiService } from './ai/service';
import { describeExpiry, describeKeyExpiry, isValidDate, keysOf, keyStatus, maskKey, modelsOf, preset, PRESETS, ProfileStore, Provider, statusOf, withModel } from './ai/profiles';
import { addAndCheckKeys } from './changeKey';

export interface KeysDeps {
  store: ProfileStore;
  service: AiService;
  fallback: () => boolean;
  setFallback: (on: boolean) => PromiseLike<void>;
  legacy: () => AiConfig;
  /** Copilot's models, or none when Copilot is not available. */
  copilotModels?: () => Promise<string[]>;
}

interface Inbound {
  type: string;
  id?: string;
  keyId?: string;
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
        const current = store.currentKeyId(p);
        const keys = await Promise.all(
          keysOf(p).map(async (k) => {
            const value = await store.key(p.id, k.id);
            return { id: k.id, mask: maskKey(value), hasKey: !!value, expiresAt: k.expiresAt ?? '', expiryText: describeKeyExpiry(k, now), status: keyStatus(k, now), inUse: k.id === current };
          }),
        );
        const key = await store.key(p.id, current);
        return {
          id: p.id,
          label: p.label,
          provider: p.provider,
          providerName: preset(p.provider).name,
          baseUrl: p.baseUrl,
          model: p.model,
          models: [...new Set([...preset(p.provider).models, ...modelsOf(p), ...(this.fetched.get(p.id) ?? [])].filter(Boolean))],
          savedModels: modelsOf(p),
          keys,
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
    const copilot = (await this.deps.copilotModels?.().catch(() => [])) ?? [];
    // Copilot is only offered where it can work, unless a profile already uses it.
    const offered = PRESETS.filter((p) => p.provider !== 'vscode' || copilot.length || profiles.some((x) => x.provider === 'vscode'));
    void this.panel.webview.postMessage({
      type: 'state',
      profiles,
      fallback: this.deps.fallback(),
      copilot: copilot.length > 0,
      legacy: profiles.length ? undefined : { baseUrl: legacy.baseUrl, model: legacy.model },
      presets: offered.map((p) => ({ provider: p.provider, name: p.name, baseUrl: p.baseUrl, models: p.provider === 'vscode' ? copilot : p.models, keyUrl: p.keyUrl })),
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
        const pick = await vscode.window.showWarningMessage(`Delete the profile "${p.label}" and ${keysOf(p).length > 1 ? `its ${keysOf(p).length} saved keys` : 'its saved key'}? This cannot be undone.`, { modal: true }, 'Delete');
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
        if (p && model && model !== p.model) await store.save(withModel(p, model));
        else if (p) void this.push();
        return;
      }
      case 'addModel': {
        const p = store.get(m.id);
        const model = m.model?.trim();
        if (p && model) await store.save({ ...p, models: [...new Set([...modelsOf(p), model])] });
        return;
      }
      case 'removeModel': {
        const p = store.get(m.id);
        // The model in use always stays: pick another one first.
        if (p && m.model && m.model !== p.model) await store.save({ ...p, models: modelsOf(p).filter((x) => x !== m.model) });
        return;
      }
      case 'changeKey':
        if (m.id) await vscode.commands.executeCommand('dbExplainer.ai.changeKey', m.id, m.keyId);
        return;
      case 'addKeys': {
        const p = store.get(m.id);
        if (!p || !m.key?.trim()) return;
        void this.panel.webview.postMessage({ type: 'testing', id: p.id });
        const r = await addAndCheckKeys(store, this.deps.service, p.id, m.key, m.expiresAt?.trim() || undefined);
        return this.showTest(p.id, r.ok, r.text);
      }
      case 'setKeyDate': {
        const p = store.get(m.id);
        const date = (m.expiresAt ?? '').trim();
        if (!p || !m.keyId || (date && !isValidDate(date))) return;
        await store.setKeyExpiry(p.id, m.keyId, date);
        return;
      }
      case 'testKey': {
        const p = store.get(m.id);
        if (!p || !m.keyId) return;
        const at = keysOf(p).findIndex((k) => k.id === m.keyId) + 1;
        void this.panel.webview.postMessage({ type: 'testing', id: p.id });
        const r = await this.deps.service.test(p.id, m.keyId);
        if (r.models.length) this.fetched.set(p.id, r.models);
        return this.showTest(p.id, r.ok, `Key ${at}: ${r.message}`);
      }
      case 'useKey': {
        const p = store.get(m.id);
        const entry = p && keysOf(p).find((k) => k.id === m.keyId);
        if (!p || !entry) return;
        if (keyStatus(entry, new Date()) === 'expired') {
          void vscode.window.showWarningMessage(`That key expired on ${entry.expiresAt}. Change its expiry date first.`);
          return;
        }
        await store.setCurrentKey(p.id, entry.id);
        return;
      }
      case 'removeKey': {
        const p = store.get(m.id);
        const keys = p ? keysOf(p) : [];
        const at = keys.findIndex((k) => k.id === m.keyId);
        if (!p || at < 0) return;
        const pick = await vscode.window.showWarningMessage(`Remove key ${at + 1} from "${p.label}"? This cannot be undone.`, { modal: true }, 'Remove');
        if (pick === 'Remove') await store.removeKey(p.id, keys[at].id);
        return;
      }
      case 'test':
        if (m.id) await this.check(m.id);
        return;
      case 'setFallback':
        await this.deps.setFallback(!!m.on);
        return this.push();
      case 'link':
        // Only the key pages of the presets can be opened, whatever the page asks for.
        if (m.href && PRESETS.some((p) => p.keyUrl === m.href)) await vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;
      case 'useCopilot':
        await vscode.commands.executeCommand('dbExplainer.ai.useCopilot');
        return;
      case 'discardPending':
        this.pending = undefined;
        return this.push();
    }
  }

  /** Asks the service for its model list, which also proves the key works and fills the model dropdown. */
  private async check(id: string): Promise<void> {
    void this.panel.webview.postMessage({ type: 'testing', id });
    const r = await this.deps.service.test(id);
    if (r.models.length) this.fetched.set(id, r.models);
    // The suggested model may be gone by now. Rather than leave a model that will fail, take the best one the service offers.
    const was = this.deps.store.get(id)?.model;
    const chosen = r.ok ? await this.deps.service.adoptOfferedModel(id, r.models) : undefined;
    await this.showTest(id, r.ok, chosen ? `The service answered. "${was}" is not offered any more, so "${chosen}" was picked for you. You can change it under Saved models.` : r.message);
  }

  private async save(m: Inbound): Promise<void> {
    const isNew = !m.id;
    const r = await saveProfileForm(this.deps.store, m, {
      pendingKey: this.pending?.key,
      confirmAddress: async (host, count): Promise<AddressChoice> => {
        const keys = count === 1 ? 'Your saved key' : `Your ${count} saved keys`;
        const pick = await vscode.window.showWarningMessage(`${keys} would start going to ${host}. Only keep them if they belong to that service.`, { modal: true }, 'Keep and send them', 'Remove them');
        return pick === 'Keep and send them' ? 'keep' : pick === 'Remove them' ? 'remove' : undefined;
      },
    });
    if ('error' in r) return this.error(r.error);
    if (isNew) this.pending = undefined;
    void this.panel.webview.postMessage({ type: 'saved' });
    // No need to press anything: saving checks the key and fills the model dropdown.
    await this.check(r.id);
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
  <button id="copilot" class="ghost" hidden>Use Copilot (no key)</button>
  <button id="add">Add profile</button>
</header>
<div id="banner" class="banner" role="status" hidden></div>
<main id="list" aria-live="polite"></main>
<script nonce="${nonce}" src="${uri('keys.js')}"></script>
</body></html>`;
  }
}

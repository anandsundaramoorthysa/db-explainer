import * as vscode from 'vscode';
import { AiConfig } from './ai/client';
import { describeExpiry, keysOf, modelsOf, preset, ProfileStore, providerFromUrl, statusOf, withModel } from './ai/profiles';

const MANAGE = 'dbExplainer.ai.manage';
export const SWITCH = 'dbExplainer.ai.switch';
const CHANGE = '\u0000change-key';
const ADD = '\u0000add';
const ADD_KEY = '\u0000add-key';
const MODEL = '\u0000model:';

function short(text: string, max = 32): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Shows which provider and model the chat will use. Clicking it opens the quick pick to switch. */
export class AiStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor(
    private readonly store: ProfileStore,
    private readonly legacy: () => AiConfig,
  ) {
    this.item.command = SWITCH;
    this.update();
    this.item.show();
  }

  update(): void {
    const now = new Date();
    const p = this.store.active();
    this.item.backgroundColor = undefined;
    if (!p) {
      const old = this.legacy();
      this.item.text = old.model.trim() ? `$(sparkle) ${preset(providerFromUrl(old.baseUrl)).name} · ${short(old.model)}` : '$(sparkle) AI: set up';
      if (old.model.trim()) this.item.tooltip = 'DB Explainer is using the dbExplainer.ai.* settings. Click to add a profile.';
      else {
        this.item.tooltip = 'Click to add an AI key';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }
      return;
    }
    const status = statusOf(p, now);
    const icon = status === 'expired' ? '$(error)' : status === 'expiring' ? '$(warning)' : '$(sparkle)';
    this.item.text = `${icon} ${preset(p.provider).name} · ${short(p.model)}`;
    if (status === 'expired') this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    else if (status === 'expiring') this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    const tip = new vscode.MarkdownString(undefined, true);
    const keys = keysOf(p);
    const position = keys.length > 1 ? `\nUsing key ${keys.findIndex((k) => k.id === this.store.currentKeyId(p)) + 1} of ${keys.length}.` : '';
    tip.appendText(`${p.label} (${preset(p.provider).name}, ${p.model})\n${describeExpiry(p, now)}${status === 'expired' ? '. This key is skipped.' : ''}${position}\nClick to switch profile.`);
    this.item.tooltip = tip;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** One step: pick a profile and it becomes the one in use. Expired profiles are left out because they are never used. */
export async function switchProfile(store: ProfileStore): Promise<void> {
  const now = new Date();
  const all = store.list();
  if (!all.length) {
    await vscode.commands.executeCommand(MANAGE, true);
    return;
  }
  const inUse = store.active()?.id;
  const valid = all.filter((p) => statusOf(p, now) !== 'expired');
  const hidden = all.length - valid.length;
  const active = store.active();
  type Item = vscode.QuickPickItem & { id?: string };
  const otherModels = active ? modelsOf(active).filter((m) => m !== active.model) : [];
  const items: Item[] = [
    ...valid.map((p): Item => ({ id: p.id, label: `${p.id === inUse ? '$(check) ' : ''}${p.label}`, description: `${preset(p.provider).name} · ${p.model}`, detail: describeExpiry(p, now) })),
    ...(otherModels.length ? [{ label: `Models for ${active?.label}`, kind: vscode.QuickPickItemKind.Separator } as Item] : []),
    ...otherModels.map((m): Item => ({ id: MODEL + m, label: `$(versions) Use ${m}` })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(key) Change key for ${store.active()?.label ?? 'the active profile'}...`, id: CHANGE },
    { label: `$(add) Add another key to ${store.active()?.label ?? 'the active profile'}...`, id: ADD_KEY },
    { label: '$(add) Add profile...', id: ADD },
    { label: '$(gear) Manage AI Keys...' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Switch AI profile', placeHolder: hidden ? `${hidden} expired profile${hidden === 1 ? ' is' : 's are'} hidden and never used` : 'Which profile should the chat use?' });
  if (!pick) return;
  if (pick.id === CHANGE) await vscode.commands.executeCommand('dbExplainer.ai.changeKey');
  else if (pick.id === ADD_KEY) await vscode.commands.executeCommand('dbExplainer.ai.addKey');
  else if (pick.id?.startsWith(MODEL)) {
    const latest = store.active();
    if (latest) await store.save(withModel(latest, pick.id.slice(MODEL.length)));
  } else if (pick.id === ADD) await vscode.commands.executeCommand(MANAGE, true);
  else if (pick.id) await store.setActive(pick.id);
  else await vscode.commands.executeCommand(MANAGE);
}

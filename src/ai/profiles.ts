/** Saved AI profiles. No vscode import, so the storage is injected and the logic can be tested on its own. */

export type Provider = 'gemini' | 'groq' | 'openrouter' | 'openai' | 'claude' | 'ollama' | 'vscode' | 'custom';

/** The address stored on a Copilot profile. It is never fetched: Copilot is reached through VS Code. */
export const COPILOT_ADDRESS = 'vscode-lm:copilot';

export interface ProviderPreset {
  provider: Provider;
  name: string;
  baseUrl: string;
  /** Suggestions for the model dropdown. The field stays editable, and "Test connection" adds the service's own list. */
  models: string[];
  /** Only set where the service needs a different request field than the dbExplainer.ai.maxTokensParam setting. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Headers some services want in addition to the bearer token. */
  headers?: Record<string, string>;
  /** Where the developer creates a key for this service. */
  keyUrl?: string;
}

export const PRESETS: ProviderPreset[] = [
  { provider: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'], keyUrl: 'https://aistudio.google.com/apikey' },
  { provider: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'], keyUrl: 'https://console.groq.com/keys' },
  { provider: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash'], keyUrl: 'https://openrouter.ai/keys' },
  { provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], maxTokensParam: 'max_completion_tokens', keyUrl: 'https://platform.openai.com/api-keys' },
  { provider: 'claude', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], headers: { 'anthropic-version': '2023-06-01' }, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { provider: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5-coder:7b', 'llama3.2:3b', 'qwen2.5:3b-instruct'] },
  { provider: 'vscode', name: 'GitHub Copilot (no key)', baseUrl: COPILOT_ADDRESS, models: [] },
  { provider: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '', models: [] },
];

export function preset(provider: Provider): ProviderPreset {
  return PRESETS.find((p) => p.provider === provider) ?? PRESETS[PRESETS.length - 1];
}

export interface Profile {
  id: string;
  label: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  /** YYYY-MM-DD. The first key works through the end of that day. */
  expiresAt?: string;
  /** Model versions saved on this profile. `model` is the one in use. */
  models?: string[];
  /** Keys after the first. The first key and its date stay where they always were, so an older version can still read the profile. */
  extraKeys?: KeyEntry[];
  /** The key last used successfully. Missing or stale means the first key. */
  currentKeyId?: string;
}

/** A key's details. The key itself is only ever in secret storage. */
export interface KeyEntry {
  id: string;
  expiresAt?: string;
}

export const PRIMARY_KEY = 'primary';

export type Status = 'active' | 'expiring' | 'expired';

export const WARN_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function isValidDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** Whole days from today to the expiry date: 0 means it expires today, negative means it already has. Undefined when there is no date. */
export function daysLeft(p: Pick<Profile, 'expiresAt'>, now: Date): number | undefined {
  if (!p.expiresAt || !isValidDate(p.expiresAt)) return undefined;
  const [y, m, d] = p.expiresAt.split('-').map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - localMidnight(now)) / DAY_MS);
}

export function keysOf(p: Pick<Profile, 'expiresAt' | 'extraKeys'>): KeyEntry[] {
  return [{ id: PRIMARY_KEY, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}) }, ...(p.extraKeys ?? [])];
}

export function keyStatus(k: Pick<Profile, 'expiresAt'>, now: Date): Status {
  const left = daysLeft(k, now);
  if (left === undefined) return 'active';
  if (left < 0) return 'expired';
  return left <= WARN_DAYS ? 'expiring' : 'active';
}

/** A profile is only as bad as its best key: it has expired only when every key has. */
export function statusOf(p: Pick<Profile, 'expiresAt' | 'extraKeys'>, now: Date): Status {
  const all = keysOf(p).map((k) => keyStatus(k, now));
  return all.includes('active') ? 'active' : all.includes('expiring') ? 'expiring' : 'expired';
}

export function describeKeyExpiry(k: Pick<Profile, 'expiresAt'>, now: Date): string {
  const left = daysLeft(k, now);
  if (left === undefined) return 'No expiry date';
  if (left < 0) return `Expired on ${k.expiresAt}`;
  if (left === 0) return `Expires today (${k.expiresAt})`;
  return `Expires in ${left} day${left === 1 ? '' : 's'} (${k.expiresAt})`;
}

export function describeExpiry(p: Profile, now: Date): string {
  const keys = keysOf(p);
  if (keys.length === 1) return describeKeyExpiry(p, now);
  return `${keys.filter((k) => keyStatus(k, now) !== 'expired').length} of ${keys.length} keys valid`;
}

/** The profile's saved model versions, with the one in use first. */
export function modelsOf(p: Pick<Profile, 'model' | 'models'>): string[] {
  return [...new Set([p.model, ...(p.models ?? [])].filter(Boolean))];
}

/** Makes a model the one in use. The model it replaces stays saved. */
export function withModel(p: Profile, model: string): Profile {
  return { ...p, model, models: [...new Set([...modelsOf(p), model])] };
}

/** Shows the end of a key and nothing else, and not even that for a short one. */
export function maskKey(key: string | undefined): string {
  if (!key) return '';
  return key.length >= 16 ? `••••••••${key.slice(-4)}` : '••••••••';
}

/** Best guess at the provider from the address, for profiles that were typed in by hand. */
export function providerFromUrl(raw: string): Provider {
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    return 'custom';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'ollama';
  return PRESETS.find((p) => p.baseUrl && new URL(p.baseUrl).hostname === host)?.provider ?? 'custom';
}

export interface Memento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const PROFILES_KEY = 'dbExplainer.ai.profiles';
const ACTIVE_KEY = 'dbExplainer.ai.activeProfile';
const WARNED_KEY = 'dbExplainer.ai.expiryWarned';
export const KEY_PREFIX = 'dbExplainer.ai.key.';

export function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Profiles live in extension state. Their keys live only in secret storage. */
export class ProfileStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly state: Memento,
    private readonly secrets: Secrets,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  list(): Profile[] {
    return this.state.get<Profile[]>(PROFILES_KEY, []);
  }

  get(id: string | undefined): Profile | undefined {
    return id ? this.list().find((p) => p.id === id) : undefined;
  }

  /** The profile in use. Falls back to the first one if the saved choice no longer exists. */
  active(): Profile | undefined {
    const list = this.list();
    return list.find((p) => p.id === this.state.get<string | undefined>(ACTIVE_KEY, undefined)) ?? list[0];
  }

  async setActive(id: string): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
    this.changed();
  }

  /** A key of undefined leaves the saved key alone. */
  async save(profile: Profile, key?: string): Promise<void> {
    const list = this.list();
    const at = list.findIndex((p) => p.id === profile.id);
    const next = at < 0 ? [...list, profile] : list.map((p) => (p.id === profile.id ? profile : p));
    await this.state.update(PROFILES_KEY, next);
    if (key) await this.secrets.store(KEY_PREFIX + profile.id, key);
    if (at < 0 && next.length === 1) await this.state.update(ACTIVE_KEY, profile.id);
    this.changed();
  }

  async remove(id: string): Promise<void> {
    const wasActive = this.active()?.id === id;
    const keys = keysOf(this.get(id) ?? {});
    const next = this.list().filter((p) => p.id !== id);
    await this.state.update(PROFILES_KEY, next);
    for (const k of keys) await this.secrets.delete(this.slot(id, k.id));
    if (wasActive) await this.state.update(ACTIVE_KEY, next.find((p) => statusOf(p, new Date()) !== 'expired')?.id ?? next[0]?.id);
    this.changed();
  }

  private slot(id: string, keyId: string): string {
    return keyId === PRIMARY_KEY ? KEY_PREFIX + id : `${KEY_PREFIX}${id}.${keyId}`;
  }

  key(id: string, keyId: string = PRIMARY_KEY): PromiseLike<string | undefined> {
    return this.secrets.get(this.slot(id, keyId));
  }

  async setKey(id: string, key: string, keyId: string = PRIMARY_KEY): Promise<void> {
    if (key) await this.secrets.store(this.slot(id, keyId), key);
    else await this.secrets.delete(this.slot(id, keyId));
    this.changed();
  }

  /** The key to try first. */
  currentKeyId(p: Profile): string {
    return keysOf(p).find((k) => k.id === p.currentKeyId)?.id ?? PRIMARY_KEY;
  }

  async setCurrentKey(id: string, keyId: string): Promise<void> {
    const p = this.get(id);
    if (p && keysOf(p).some((k) => k.id === keyId)) await this.save({ ...p, currentKeyId: keyId });
  }

  /** Keys that can be sent, starting from the current one and wrapping round. Expired keys and empty slots are left out. */
  async usableKeys(p: Profile, now: Date): Promise<{ id: string; key: string }[]> {
    const keys = keysOf(p);
    const start = keys.findIndex((k) => k.id === this.currentKeyId(p));
    const out: { id: string; key: string }[] = [];
    for (const k of [...keys.slice(start), ...keys.slice(0, start)]) {
      if (keyStatus(k, now) === 'expired') continue;
      const key = await this.key(p.id, k.id);
      if (key) out.push({ id: k.id, key });
    }
    return out;
  }

  /** The other key slot on this profile that already holds this key, if any. */
  async duplicateOf(p: Profile, key: string, exceptKeyId?: string): Promise<string | undefined> {
    for (const k of keysOf(p)) if (k.id !== exceptKeyId && (await this.key(p.id, k.id)) === key) return k.id;
    return undefined;
  }

  async addKey(id: string, key: string, expiresAt?: string): Promise<string | undefined> {
    if (!this.get(id)) return undefined;
    const keyId = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await this.secrets.store(this.slot(id, keyId), key);
    // Read again after the await, so an edit made meanwhile is kept.
    const p = this.get(id);
    if (!p) {
      await this.secrets.delete(this.slot(id, keyId));
      return undefined;
    }
    await this.save({ ...p, extraKeys: [...(p.extraKeys ?? []), { id: keyId, ...(expiresAt ? { expiresAt } : {}) }] });
    return keyId;
  }

  async setKeyExpiry(id: string, keyId: string, expiresAt: string): Promise<void> {
    const p = this.get(id);
    if (!p) return;
    if (keyId === PRIMARY_KEY) {
      const { expiresAt: _old, ...rest } = p;
      await this.save(expiresAt ? { ...rest, expiresAt } : rest);
    } else {
      await this.save({ ...p, extraKeys: (p.extraKeys ?? []).map((k) => (k.id === keyId ? { id: k.id, ...(expiresAt ? { expiresAt } : {}) } : k)) });
    }
  }

  /** Removing the first key moves the next one into its place, so the first slot is never empty while others are saved. */
  async removeKey(id: string, keyId: string): Promise<void> {
    const p = this.get(id);
    if (!p) return;
    const { expiresAt: _date, extraKeys: _keys, currentKeyId: _current, ...base } = p;
    const extras = p.extraKeys ?? [];
    const pointer = p.currentKeyId;
    if (keyId !== PRIMARY_KEY) {
      const rest = extras.filter((k) => k.id !== keyId);
      await this.secrets.delete(this.slot(id, keyId));
      await this.save({
        ...base,
        ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
        ...(rest.length ? { extraKeys: rest } : {}),
        ...(pointer && pointer !== keyId ? { currentKeyId: pointer } : {}),
      });
      return;
    }
    const [next, ...rest] = extras;
    if (!next) {
      await this.setKey(id, '');
      return;
    }
    const value = await this.key(id, next.id);
    if (value) await this.secrets.store(this.slot(id, PRIMARY_KEY), value);
    else await this.secrets.delete(this.slot(id, PRIMARY_KEY));
    await this.secrets.delete(this.slot(id, next.id));
    await this.save({
      ...base,
      ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
      ...(rest.length ? { extraKeys: rest } : {}),
      // The key that moved is now the first key, so a pointer to it needs no entry. Any other extra key stays current.
      ...(pointer && pointer !== PRIMARY_KEY && pointer !== next.id ? { currentKeyId: pointer } : {}),
    });
  }

  /** Which profiles were already warned about today, so the same warning is not shown again and again. */
  warnedToday(today: string): Set<string> {
    const saved = this.state.get<{ day: string; ids: string[] }>(WARNED_KEY, { day: '', ids: [] });
    return new Set(saved.day === today ? saved.ids : []);
  }

  async markWarned(today: string, ids: Set<string>): Promise<void> {
    await this.state.update(WARNED_KEY, { day: today, ids: [...ids] });
  }
}

export function dayStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Messages for keys that are expiring or have expired, minus those already shown today. */
export function expiryWarnings(profiles: Profile[], now: Date, alreadyWarned: Set<string>): { ids: string[]; messages: string[]; targets: { profileId: string; keyId: string }[] } {
  const ids: string[] = [];
  const messages: string[] = [];
  const targets: { profileId: string; keyId: string }[] = [];
  for (const p of profiles) {
    const keys = keysOf(p);
    keys.forEach((k, i) => {
      const status = keyStatus(k, now);
      const warnId = k.id === PRIMARY_KEY ? p.id : `${p.id}.${k.id}`;
      if (status === 'active' || alreadyWarned.has(warnId)) return;
      ids.push(warnId);
      targets.push({ profileId: p.id, keyId: k.id });
      const name = `${preset(p.provider).name} key "${p.label}"${keys.length > 1 ? ` (key ${i + 1})` : ''}`;
      const left = daysLeft(k, now) ?? 0;
      const another = keys.some((o) => o !== k && keyStatus(o, now) !== 'expired');
      messages.push(status === 'expired' ? `Your ${name} expired on ${k.expiresAt} and is being skipped. ${another ? 'Another key in this profile is used instead.' : 'Change its key and date to use it again.'}` : `Your ${name} expires ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`} (${k.expiresAt}).`);
    });
  }
  return { ids, messages, targets };
}

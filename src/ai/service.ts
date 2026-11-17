import { AiConfig, AiError, ChatMessage, chat, isLocalUrl, listModels, normalizeBaseUrl } from './client';
import { replacementsFor } from './modelPick';
import { describeExpiry, keysOf, keyStatus, modelsOf, preset, Profile, ProfileStore, statusOf, withModel } from './profiles';

/** Copilot through VS Code. Kept behind this shape so the service needs no vscode import and can be tested. */
export interface CopilotBridge {
  models(): Promise<string[]>;
  chat(model: string, messages: ChatMessage[], onText?: (soFar: string) => void, signal?: AbortSignal): Promise<string>;
}

export interface ServiceDeps {
  store: ProfileStore;
  copilot?: CopilotBridge;
  /** The dbExplainer.ai.* settings. Used as they always were until the first profile is added. */
  legacy: () => AiConfig;
  legacyKey: () => PromiseLike<string | undefined>;
  fallback: () => boolean;
  /** Asks the developer, once per host, before data goes to a service that is not on this computer. Throws if they say no. */
  allowHost: (baseUrl: string) => Promise<void>;
  notice: (text: string) => void;
  now?: () => Date;
  fetchFn?: typeof fetch;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  models: string[];
}

/** The answers that mean "this profile cannot help right now, another might". */
const FALLBACK_CODES = new Set(['auth', 'rate', 'server']);

/** The answers that mean "this key cannot help right now, another key might". A server fault would hit every key alike. */
const NEXT_KEY_CODES = new Set(['auth', 'rate']);

/**
 * A replacement to suggest when `id` is not in the service's list, or undefined when it is listed (also as "name:latest", with a
 * "models/" prefix, or as a longer id that starts with it, such as a dated version). Pure: nothing is saved.
 */
export function suggestModel(id: string, listed: string[]): string | undefined {
  const names = listed.map((m) => m.replace(/^models\//, ''));
  const name = id.trim().replace(/^models\//, '');
  if (!name || !names.length) return undefined;
  const bare = (m: string): string => m.replace(/:latest$/, '');
  if (names.some((m) => bare(m) === bare(name) || m.startsWith(name + '-') || m.startsWith(name + ':'))) return undefined;
  return replacementsFor(name, [], names, 1)[0];
}

function who(p: Profile): string {
  return `${preset(p.provider).name} "${p.label}"`;
}

function explain(p: Profile, e: AiError, keysTried = 1): string {
  if (e.code === 'auth' && keysTried > 1) return `${who(p)} refused all ${keysTried} keys (${e.status ?? 401}). They may be mistyped, revoked, or not allowed to use this model. Use "Change key" to replace one.`;
  if (e.code === 'auth') return `${who(p)} refused the key (${e.status ?? 401}). It may be mistyped, revoked, or not allowed to use this model. Use "Change key" to replace it.`;
  if (e.code === 'rate') return `${who(p)} is busy or you hit its free limit (429)${e.retryAfter ? `. Wait ${e.retryAfter} seconds and ask again` : ''}, or switch profile in the status bar.`;
  return `${who(p)} is down or overloaded (${e.status ?? 503}). Try again shortly, or switch profile in the status bar.`;
}

export class AiService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** True when a question can reasonably be sent: a usable profile exists, or the old settings name a model. */
  ready(): boolean {
    const list = this.deps.store.list();
    return list.length ? list.some((p) => statusOf(p, this.now()) !== 'expired') : !!this.deps.legacy().model.trim();
  }

  private config(p: Profile): AiConfig {
    const base = this.deps.legacy();
    return { baseUrl: p.baseUrl, model: p.model, maxTokens: base.maxTokens, maxTokensParam: preset(p.provider).maxTokensParam ?? base.maxTokensParam };
  }

  private opts(p: Profile, onText?: (soFar: string) => void, signal?: AbortSignal) {
    return { fetchFn: this.deps.fetchFn, headers: preset(p.provider).headers, onText, signal };
  }

  /** Why a profile must not be used, or undefined if it can be. An expired key is never sent anywhere. */
  private async skipReason(p: Profile): Promise<string | undefined> {
    if (statusOf(p, this.now()) === 'expired') {
      const count = keysOf(p).length;
      return `${who(p)} ${count > 1 ? `has ${count} keys and all have expired` : `expired on ${p.expiresAt}`}, so it is skipped. Pick another in the status bar, or change its date in "DB Explainer: Manage AI Keys".`;
    }
    // Checked before anyone is asked to trust the host, and so that one broken profile is skipped instead of ending the whole chain.
    if (!p.model.trim()) return `${who(p)} has no model name. Add one in "DB Explainer: Manage AI Keys".`;
    // Copilot has no address or key of its own: VS Code reaches it.
    if (p.provider === 'vscode') return this.deps.copilot ? undefined : `${who(p)} needs GitHub Copilot in VS Code.`;
    try {
      normalizeBaseUrl(p.baseUrl, true);
    } catch {
      return `${who(p)} has an invalid or unsafe address (${p.baseUrl}). Fix it in "DB Explainer: Manage AI Keys".`;
    }
    if (!isLocalUrl(p.baseUrl) && !(await this.deps.store.usableKeys(p, this.now())).length) return `${who(p)} has no API key saved. Add one in "DB Explainer: Manage AI Keys".`;
    return undefined;
  }

  /**
   * Tries the profile's valid keys in turn, moving on when one is refused or rate limited. Every key goes only to this profile's own
   * address, so nothing reaches a new service. The key that worked is remembered, so a dead key is not tried first next time.
   */
  private async askProfile(p: Profile, messages: ChatMessage[], onText?: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
    const { store } = this.deps;
    if (p.provider === 'vscode') {
      try {
        return await this.deps.copilot!.chat(p.model, messages, onText, signal);
      } catch (e) {
        if (!(e instanceof AiError) || e.code !== 'model') throw e;
        const reply = await this.replaceModel(p, undefined, messages, onText, signal);
        if (reply !== undefined) return reply;
        throw new AiError(`${e.message} No other Copilot model answered either.`, 'model');
      }
    }
    const usable = await store.usableKeys(p, this.now());
    // A local service can work with no key at all.
    const attempts: { id: string; key?: string }[] = usable.length ? usable : [{ id: store.currentKeyId(p) }];
    const current = store.currentKeyId(p);
    let refused = 0;
    let lastFailure: AiError | undefined;
    for (const k of attempts) {
      try {
        const reply = await chat(this.config(p), k.key, messages, this.opts(p, onText, signal));
        if (usable.length && k.id !== current) {
          await store.setCurrentKey(p.id, k.id);
          const all = keysOf(p);
          const why = lastFailure?.code === 'rate' ? 'hit its rate limit' : lastFailure ? 'was refused' : 'has expired or is missing';
          this.deps.notice(`${who(p)} switched to key ${all.findIndex((x) => x.id === k.id) + 1} of ${all.length}, because the previous key ${why}.`);
        }
        return reply;
      } catch (e) {
        if (!(e instanceof AiError) || signal?.aborted) throw e;
        if (e.code === 'auth') refused++;
        lastFailure = e;
        if (NEXT_KEY_CODES.has(e.code) && k !== attempts[attempts.length - 1]) continue;
        if (FALLBACK_CODES.has(e.code)) throw new AiError(explain(p, e, refused), e.code, e.status, e.retryAfter);
        if (e.code === 'model') {
          // A retired model is not the developer's problem: find one that works, and keep it.
          const reply = await this.replaceModel(p, k.key, messages, onText, signal);
          if (reply !== undefined) return reply;
          throw new AiError(`${who(p)}: ${e.message} No other model it offers answered either. Pick one in "DB Explainer: Manage AI Keys".`, 'model', e.status);
        }
        throw e;
      }
    }
    throw new AiError(`${who(p)} has no API key saved.`, 'config');
  }

  /** The service's own model list, or none if it cannot be read. */
  private async offered(p: Profile, key: string | undefined): Promise<string[]> {
    try {
      if (p.provider === 'vscode') return (await this.deps.copilot?.models()) ?? [];
      return (await listModels(this.config(p), key, this.opts(p))).map((m) => m.replace(/^models\//, ''));
    } catch {
      return [];
    }
  }

  /**
   * The model in use is gone. Tries the saved models the service still offers, then its other models, best first, and keeps the
   * first that answers as the model in use, dropping the dead one from the saved list. Undefined if none answers.
   */
  private async replaceModel(p: Profile, key: string | undefined, messages: ChatMessage[], onText?: (soFar: string) => void, signal?: AbortSignal): Promise<string | undefined> {
    const candidates = replacementsFor(p.model, modelsOf(p), await this.offered(p, key));
    for (const model of candidates) {
      try {
        const reply = p.provider === 'vscode' ? await this.deps.copilot!.chat(model, messages, onText, signal) : await chat({ ...this.config(p), model }, key, messages, this.opts(p, onText, signal));
        await this.keepModel(p.id, p.model, model);
        this.deps.notice(`${who(p)}: "${p.model}" is no longer available, so DB Explainer switched to "${model}" and will use it from now on.`);
        return reply;
      } catch (e) {
        if (e instanceof AiError && e.code === 'model') continue;
        if (e instanceof AiError && FALLBACK_CODES.has(e.code) && !signal?.aborted) throw new AiError(explain(p, e), e.code, e.status, e.retryAfter);
        throw e;
      }
    }
    return undefined;
  }

  /** Makes `model` the one in use and forgets `dead`. Reads the profile again, so edits made meanwhile are kept. */
  private async keepModel(id: string, dead: string, model: string): Promise<void> {
    const latest = this.deps.store.get(id);
    if (!latest) return;
    const next = withModel(latest, model);
    await this.deps.store.save({ ...next, models: modelsOf(next).filter((m) => m !== dead) });
  }

  async chat(messages: ChatMessage[], onText?: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
    const { store } = this.deps;
    const all = store.list();
    if (!all.length) {
      const cfg = this.deps.legacy();
      normalizeBaseUrl(cfg.baseUrl, false);
      await this.deps.allowHost(cfg.baseUrl);
      return chat(cfg, await this.deps.legacyKey(), messages, { fetchFn: this.deps.fetchFn, onText, signal });
    }

    const active = store.active() ?? all[0];
    const start = all.findIndex((p) => p.id === active.id);
    const ring = [...all.slice(start), ...all.slice(0, start)];
    const fallbackOn = this.deps.fallback();
    const queue = fallbackOn ? ring : [active];

    const failures: AiError[] = [];
    for (const p of queue) {
      const skip = await this.skipReason(p);
      if (skip) {
        failures.push(new AiError(skip, 'config'));
        continue;
      }
      try {
        await this.deps.allowHost(p.baseUrl);
      } catch (e) {
        failures.push(e instanceof AiError ? e : new AiError((e as Error).message, 'config'));
        continue;
      }
      try {
        const reply = await this.askProfile(p, messages, onText, signal);
        if (failures.length) this.deps.notice(`${failures.map((f) => f.message).join(' ')} This answer came from ${who(p)}.`);
        return reply;
      } catch (e) {
        if (!(e instanceof AiError) || !FALLBACK_CODES.has(e.code)) throw e;
        failures.push(e);
      }
    }

    // Nothing worked. Say why for each profile tried, and how to get a second chance if there could be one.
    const first = failures[0];
    // The code that matters is the last real failure (a rejected key, a rate limit), not a profile that was only skipped.
    const real = [...failures].reverse().find((f) => f.code !== 'config');
    const others = all.filter((p) => p.id !== active.id && statusOf(p, this.now()) !== 'expired').length;
    const hint = !real ? '' : fallbackOn ? ' No other valid profile worked either.' : others ? ' Turn on "Fall back to the next valid profile" in "DB Explainer: Manage AI Keys" to switch automatically.' : ' Fix it in "DB Explainer: Manage AI Keys".';
    throw new AiError((failures.map((f) => f.message).join(' ') || 'No AI profile is available.') + hint, real?.code ?? 'config', real?.status);
  }

  /** Checks a profile's key in use (or `keyId`), or the old settings when `id` is undefined, by asking the service for its model list. */
  async test(id?: string, keyId?: string): Promise<TestOutcome> {
    try {
      const p = id ? this.deps.store.get(id) : undefined;
      if (id && !p) return { ok: false, message: 'That profile no longer exists.', models: [] };
      if (p?.provider === 'vscode') {
        const models = (await this.deps.copilot?.models()) ?? [];
        if (!models.length) return { ok: false, message: 'GitHub Copilot is not available. Install the GitHub Copilot extension and sign in, then try again.', models: [] };
        return { ok: true, models, message: `Copilot answered. ${models.length} model(s) available${p.model && !models.includes(p.model) ? `; "${p.model}" is not in the list` : ''}.` };
      }
      const cfg = p ? this.config(p) : this.deps.legacy();
      let key: string | undefined;
      if (p) {
        const skip = await this.skipReason(p);
        if (skip) return { ok: false, message: skip, models: [] };
        const entry = keyId ? keysOf(p).find((k) => k.id === keyId) : undefined;
        if (entry && keyStatus(entry, this.now()) === 'expired') return { ok: false, message: `That key expired on ${entry.expiresAt}, so it is never sent.`, models: [] };
        key = entry ? await this.deps.store.key(p.id, entry.id) : (await this.deps.store.usableKeys(p, this.now()))[0]?.key;
      } else {
        key = await this.deps.legacyKey();
      }
      normalizeBaseUrl(cfg.baseUrl, !!key);
      await this.deps.allowHost(cfg.baseUrl);
      const listed = await listModels(cfg, key, p ? this.opts(p) : { fetchFn: this.deps.fetchFn });
      const models = [...new Set(listed.map((m) => m.replace(/^models\//, '')))];
      const missing = cfg.model && models.length && !models.includes(cfg.model);
      return { ok: true, models, message: `The service answered. ${models.length} model(s) available${missing ? `; "${cfg.model}" is not in the list` : ''}.` };
    } catch (e) {
      const p = id ? this.deps.store.get(id) : undefined;
      const message = p && e instanceof AiError && FALLBACK_CODES.has(e.code) ? explain(p, e) : (e as Error).message;
      return { ok: false, message, models: [] };
    }
  }

  /** One line for a profile's expiry, used by the status bar and the quick pick. */
  describe(p: Profile): string {
    return describeExpiry(p, this.now());
  }
}

import { AiConfig, AiError, ChatMessage, chat, isLocalUrl, listModels, normalizeBaseUrl } from './client';
import { describeExpiry, preset, Profile, ProfileStore, statusOf } from './profiles';

export interface ServiceDeps {
  store: ProfileStore;
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

function who(p: Profile): string {
  return `${preset(p.provider).name} "${p.label}"`;
}

function explain(p: Profile, e: AiError): string {
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

  private opts(p: Profile) {
    return { fetchFn: this.deps.fetchFn, headers: preset(p.provider).headers };
  }

  /** Why a profile must not be used, or undefined if it can be. An expired key is never sent anywhere. */
  private async skipReason(p: Profile): Promise<string | undefined> {
    if (statusOf(p, this.now()) === 'expired') return `${who(p)} expired on ${p.expiresAt}, so it is skipped. Pick another in the status bar, or change its date in "DB Explainer: Manage AI Keys".`;
    // Checked before anyone is asked to trust the host, and so that one broken profile is skipped instead of ending the whole chain.
    if (!p.model.trim()) return `${who(p)} has no model name. Add one in "DB Explainer: Manage AI Keys".`;
    try {
      normalizeBaseUrl(p.baseUrl, true);
    } catch {
      return `${who(p)} has an invalid or unsafe address (${p.baseUrl}). Fix it in "DB Explainer: Manage AI Keys".`;
    }
    if (!isLocalUrl(p.baseUrl) && !(await this.deps.store.key(p.id))) return `${who(p)} has no API key saved. Add one in "DB Explainer: Manage AI Keys".`;
    return undefined;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const { store } = this.deps;
    const all = store.list();
    if (!all.length) {
      const cfg = this.deps.legacy();
      normalizeBaseUrl(cfg.baseUrl, false);
      await this.deps.allowHost(cfg.baseUrl);
      return chat(cfg, await this.deps.legacyKey(), messages, { fetchFn: this.deps.fetchFn });
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
        const reply = await chat(this.config(p), await store.key(p.id), messages, this.opts(p));
        if (failures.length) this.deps.notice(`${failures.map((f) => f.message).join(' ')} This answer came from ${who(p)}.`);
        return reply;
      } catch (e) {
        if (!(e instanceof AiError) || !FALLBACK_CODES.has(e.code)) throw e;
        failures.push(new AiError(explain(p, e), e.code, e.status, e.retryAfter));
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

  /** Checks a profile, or the old settings when `id` is undefined, by asking the service for its model list. */
  async test(id?: string): Promise<TestOutcome> {
    try {
      const p = id ? this.deps.store.get(id) : undefined;
      if (id && !p) return { ok: false, message: 'That profile no longer exists.', models: [] };
      const cfg = p ? this.config(p) : this.deps.legacy();
      let key: string | undefined;
      if (p) {
        const skip = await this.skipReason(p);
        if (skip) return { ok: false, message: skip, models: [] };
        key = await this.deps.store.key(p.id);
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

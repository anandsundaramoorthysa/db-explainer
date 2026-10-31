import { describe, expect, it } from 'vitest';
import { AiError } from '../src/ai/client';
import { AiService } from '../src/ai/service';
import { Memento, Profile, ProfileStore, Secrets } from '../src/ai/profiles';

const NOW = new Date('2026-11-07T10:00:00');
const msgs = [{ role: 'user' as const, content: 'hi' }];

interface Call {
  url: string;
  auth?: string;
  model?: string;
}

function setup(opts: { profiles?: [Profile, string][]; fallback?: boolean; replies: Record<string, number | string> }) {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  const store = new ProfileStore(memento, sec);
  const calls: Call[] = [];
  const notices: string[] = [];
  const asked: string[] = [];
  // Each host answers with a status number or a reply text, keyed by host name.
  const fetchFn = (async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ url, auth: init.headers.authorization, model: init.body ? JSON.parse(init.body).model : undefined });
    const r = opts.replies[u.hostname];
    if (typeof r === 'number') return new Response('', { status: r, headers: r === 429 ? { 'retry-after': '7' } : {} });
    const body = url.endsWith('/models') ? { data: [{ id: 'models/gemini-x' }, { id: 'gemini-y' }] } : { choices: [{ message: { content: r } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const service = new AiService({
    store,
    legacy: () => ({ baseUrl: 'http://localhost:11434/v1', model: 'old-model', maxTokens: 100, maxTokensParam: 'max_tokens' }),
    legacyKey: async () => undefined,
    fallback: () => !!opts.fallback,
    allowHost: async (url) => void asked.push(url),
    notice: (t) => void notices.push(t),
    now: () => NOW,
    fetchFn,
  });
  return {
    service,
    store,
    calls,
    notices,
    asked,
    ready: async () => {
      for (const [p, k] of opts.profiles ?? []) await store.save(p, k);
    },
  };
}

const groq: Profile = { id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
const oai: Profile = { id: 'o', label: 'home', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
const gem: Profile = { id: 'm', label: 'free', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' };

describe('AiService with no profiles', () => {
  it('uses the old settings exactly as before', async () => {
    const t = setup({ replies: { localhost: 'old path works' } });
    expect(t.service.ready()).toBe(true);
    expect(await t.service.chat(msgs)).toBe('old path works');
    expect(t.calls[0].model).toBe('old-model');
    expect(t.calls[0].auth).toBeUndefined();
  });
});

describe('AiService with profiles', () => {
  it('sends the active profile its own key and model', async () => {
    const t = setup({ profiles: [[groq, 'gsk_one'], [oai, 'sk_two']], replies: { 'api.groq.com': 'from groq', 'api.openai.com': 'from openai' } });
    await t.ready();
    await t.store.setActive('o');
    expect(await t.service.chat(msgs)).toBe('from openai');
    expect(t.calls).toEqual([{ url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer sk_two', model: 'gpt-4o-mini' }]);
  });

  it.each([[401, 'refused the key (401)'], [429, 'busy or you hit its free limit (429). Wait 7 seconds'], [503, 'down or overloaded (503)']])('%i gives a clear message and does not switch when fallback is off', async (status, text) => {
    const t = setup({ profiles: [[groq, 'k1'], [oai, 'k2']], replies: { 'api.groq.com': status, 'api.openai.com': 'from openai' } });
    await t.ready();
    const err = (await t.service.chat(msgs).catch((e) => e)) as AiError;
    expect(err.message).toContain(text);
    expect(err.message).toContain('Groq "work"');
    expect(err.message).toContain('Turn on "Fall back');
    expect(t.calls).toHaveLength(1);
  });

  it.each([401, 429, 503])('%i falls to the next valid profile when fallback is on, and says so', async (status) => {
    const t = setup({ profiles: [[groq, 'k1'], [oai, 'k2']], fallback: true, replies: { 'api.groq.com': status, 'api.openai.com': 'from openai' } });
    await t.ready();
    expect(await t.service.chat(msgs)).toBe('from openai');
    expect(t.notices[0]).toContain('This answer came from OpenAI "home"');
    expect(t.store.active()?.id).toBe('g');
  });

  it('does not fall back on an error that another profile cannot fix', async () => {
    const t = setup({ profiles: [[groq, 'k1'], [oai, 'k2']], fallback: true, replies: { 'api.groq.com': 400, 'api.openai.com': 'from openai' } });
    await t.ready();
    await expect(t.service.chat(msgs)).rejects.toThrow(/status 400/);
    expect(t.calls).toHaveLength(1);
  });

  it('never sends an expired key anywhere, and skips to the next valid one only when fallback is on', async () => {
    const expired = { ...groq, expiresAt: '2026-11-06' };
    const off = setup({ profiles: [[expired, 'k1'], [oai, 'k2']], replies: { 'api.groq.com': 'no!', 'api.openai.com': 'from openai' } });
    await off.ready();
    await expect(off.service.chat(msgs)).rejects.toThrow(/expired on 2026-11-06/);
    expect(off.calls).toHaveLength(0);
    const on = setup({ profiles: [[expired, 'k1'], [oai, 'k2']], fallback: true, replies: { 'api.groq.com': 'no!', 'api.openai.com': 'from openai' } });
    await on.ready();
    expect(await on.service.chat(msgs)).toBe('from openai');
    expect(on.calls.map((c) => c.auth)).toEqual(['Bearer k2']);
  });

  it('skips expired profiles while walking the fallback chain', async () => {
    const dead = { ...oai, expiresAt: '2020-01-01' };
    const t = setup({ profiles: [[groq, 'k1'], [dead, 'k2'], [gem, 'k3']], fallback: true, replies: { 'api.groq.com': 429, 'api.openai.com': 'no!', 'generativelanguage.googleapis.com': 'from gemini' } });
    await t.ready();
    expect(await t.service.chat(msgs)).toBe('from gemini');
    expect(t.calls.map((c) => new URL(c.url).hostname)).toEqual(['api.groq.com', 'generativelanguage.googleapis.com']);
  });

  it('reports when every profile failed', async () => {
    const t = setup({ profiles: [[groq, 'k1'], [oai, 'k2']], fallback: true, replies: { 'api.groq.com': 401, 'api.openai.com': 503 } });
    await t.ready();
    const err = (await t.service.chat(msgs).catch((e) => e)) as AiError;
    expect(err.message).toContain('Groq "work" refused');
    expect(err.message).toContain('No other valid profile worked either');
  });

  it('refuses a remote profile that has no key, without any request', async () => {
    const t = setup({ profiles: [[groq, '']], replies: { 'api.groq.com': 'x' } });
    await t.store.save(groq);
    await expect(t.service.chat(msgs)).rejects.toThrow(/no API key saved/);
    expect(t.calls).toHaveLength(0);
  });

  it('asks before using a host, and a fallback host is asked too', async () => {
    const t = setup({ profiles: [[groq, 'k1'], [oai, 'k2']], fallback: true, replies: { 'api.groq.com': 503, 'api.openai.com': 'ok' } });
    await t.ready();
    await t.service.chat(msgs);
    expect(t.asked).toEqual(['https://api.groq.com/openai/v1', 'https://api.openai.com/v1']);
  });

  it('uses max_completion_tokens for OpenAI', async () => {
    const t = setup({ profiles: [[oai, 'k']], replies: { 'api.openai.com': 'ok' } });
    await t.ready();
    let body: any;
    const svc = new AiService({
      store: t.store, legacy: () => ({ baseUrl: 'x', model: '', maxTokens: 50, maxTokensParam: 'max_tokens' }), legacyKey: async () => undefined, fallback: () => false, allowHost: async () => {}, notice: () => {}, now: () => NOW,
      fetchFn: (async (_u: string, init: any) => ((body = JSON.parse(init.body)), new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))) as any,
    });
    await svc.chat(msgs);
    expect(body.max_completion_tokens).toBe(50);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe('AiService.test', () => {
  it('lists models, strips the Gemini models/ prefix, and flags a missing model', async () => {
    const t = setup({ profiles: [[gem, 'k']], replies: { 'generativelanguage.googleapis.com': 'x' } });
    await t.ready();
    const r = await t.service.test('m');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['gemini-x', 'gemini-y']);
    expect(r.message).toContain('"gemini-2.5-flash" is not in the list');
  });
  it('explains a rejected key and refuses an expired profile', async () => {
    const t = setup({ profiles: [[groq, 'k'], [{ ...oai, expiresAt: '2020-01-01' }, 'k']], replies: { 'api.groq.com': 401 } });
    await t.ready();
    expect((await t.service.test('g')).message).toContain('refused the key (401)');
    const expired = await t.service.test('o');
    expect(expired.ok).toBe(false);
    expect(t.calls).toHaveLength(1);
  });
});

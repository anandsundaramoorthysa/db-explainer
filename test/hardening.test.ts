import { describe, expect, it } from 'vitest';
import { AiError, chat, listModels, normalizeBaseUrl } from '../src/ai/client';
import { detectApiKey, keyProblem } from '../src/ai/keyScan';
import { AiService } from '../src/ai/service';
import { Memento, Profile, ProfileStore, Secrets } from '../src/ai/profiles';

const cfg = { baseUrl: 'https://h.example/v1', model: 'm', maxTokens: 10, maxTokensParam: 'max_tokens' as const };
const msgs = [{ role: 'user' as const, content: 'hi' }];

describe('client', () => {
  it('gives up when the body stalls after the headers arrive', async () => {
    const stalled = (async (_u: string, init: any) => {
      const body = new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))); } });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn: stalled, timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(listModels(cfg, 'k', { fetchFn: stalled, timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('only reports Retry-After when it is a number of seconds', async () => {
    const reply = (v: string) => (async () => new Response('', { status: 429, headers: { 'retry-after': v } })) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn: reply('Wed, 21 Oct 2026 07:28:00 GMT') }).catch((e) => e)).toMatchObject({ retryAfter: undefined });
    expect(await chat(cfg, 'k', msgs, { fetchFn: reply('7') }).catch((e) => e)).toMatchObject({ retryAfter: '7' });
  });
  it('drops a query string or fragment from the base URL', () => {
    expect(normalizeBaseUrl('https://h.example/v1/?x=1#top', true)).toBe('https://h.example/v1');
  });
});

describe('keys', () => {
  it('finds a key glued to a word, and leaves dotted identifiers alone', () => {
    expect(detectApiKey('key_gsk_abcdefghijklmnopqrstuvwxyz123456')?.provider).toBe('groq');
    expect(detectApiKey('dbo.CustomerOrderItemsArchive2024Final')).toBeUndefined();
    expect(detectApiKey('the task-abcdefghijklmnopqrstuvwxyz is done')).toBeUndefined();
  });
  it('rejects a key that cannot be sent as a header', () => {
    expect(keyProblem('sk-abc')).toBeUndefined();
    expect(keyProblem('sk-abc def')).toContain('spaces');
    expect(keyProblem('sk-\u00e9\u00e9')).toContain('plain');
  });
});

function service(profiles: Profile[], replies: Record<string, number | string>, allow: (u: string) => Promise<void> = async () => {}) {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  const store = new ProfileStore(memento, sec);
  const calls: string[] = [];
  const svc = new AiService({
    store, legacy: () => cfg, legacyKey: async () => undefined, fallback: () => true, allowHost: allow, notice: () => {}, now: () => new Date('2026-11-07T10:00:00'),
    fetchFn: (async (u: string) => {
      calls.push(u);
      const r = replies[new URL(u).hostname];
      return typeof r === 'number' ? new Response('', { status: r }) : new Response(JSON.stringify({ choices: [{ message: { content: r } }] }));
    }) as unknown as typeof fetch,
  });
  return { store, svc, calls, load: async () => { for (const p of profiles) await store.save(p, 'k'); } };
}
const P = (id: string, host: string, extra: Partial<Profile> = {}): Profile => ({ id, label: id, provider: 'custom', baseUrl: `https://${host}/v1`, model: 'm', ...extra });

describe('service edge cases', () => {
  it('skips a broken profile and carries on to the next', async () => {
    const t = service([P('a', 'a.example', { model: '' }), P('b', 'b.example', { baseUrl: 'http://not-local.example/v1' }), P('c', 'c.example')], { 'c.example': 'from c' });
    await t.load();
    expect(await t.svc.chat(msgs)).toBe('from c');
    expect(t.calls).toHaveLength(1);
  });
  it('does not ask to trust a host whose address is invalid', async () => {
    const asked: string[] = [];
    const t = service([P('a', 'a.example', { baseUrl: 'ftp://a.example' })], {}, async (u) => void asked.push(u));
    await t.load();
    await t.svc.chat(msgs).catch(() => {});
    expect(asked).toEqual([]);
  });
  it('treats a declined host as a configuration problem, with no misleading hint', async () => {
    const t = service([P('a', 'a.example')], {}, async () => { throw new Error('Cancelled. Nothing was sent.'); });
    await t.load();
    const err = (await t.svc.chat(msgs).catch((e) => e)) as AiError;
    expect(err.code).toBe('config');
    expect(err.message).toBe('Cancelled. Nothing was sent.');
  });
  it('reports the real failure code when an earlier profile was only skipped', async () => {
    const t = service([P('a', 'a.example', { expiresAt: '2020-01-01' }), P('b', 'b.example')], { 'b.example': 401 });
    await t.load();
    const err = (await t.svc.chat(msgs).catch((e) => e)) as AiError;
    expect(err.code).toBe('auth');
    expect(err.message).toContain('expired');
    expect(err.message).toContain('refused the key');
  });
});

describe('keys of no known provider', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
  it.each([
    ['a JSON web token on its own', JWT],
    ['a JSON web token inside a sentence', `why does ${JWT} fail`],
    ['an Authorization header', 'Authorization: Bearer abcDEF123456.ghiJKL7890_mnoPQR'],
    ['a bearer token', 'curl -H "authorization: bearer ZXhhbXBsZS10b2tlbi12YWx1ZS0xMjM0NQ=="'],
    ['an assignment', 'api_key = "Zk3Lm9Qp2Xv8Rt5Yb1Nc7Hd4"'],
    ['a token: line', 'token: Zk3Lm9Qp2Xv8Rt5Yb1Nc7Hd4Ws'],
  ])('catches %s', (_n, text) => {
    expect(detectApiKey(text)).toBeDefined();
  });
  it('still lets dotted names and ordinary SQL through', () => {
    for (const t of [
      'dbo.CustomerOrderItemsArchive2024Final',
      'analytics.CustomerOrderItems2024.LineTotalAmount',
      'select token from sessions where api_key is null',
      'the token column in sessions holds what?',
      'password = hashed_value',
      'what does eyJ mean in a column name?',
      'bearer of the order is the customer',
    ]) {
      expect(detectApiKey(t), t).toBeUndefined();
    }
  });
  it('returns the secret itself, so it can be saved as a profile', () => {
    expect(detectApiKey('api_key = "Zk3Lm9Qp2Xv8Rt5Yb1Nc7Hd4"')?.key).toBe('Zk3Lm9Qp2Xv8Rt5Yb1Nc7Hd4');
  });
});

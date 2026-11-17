import { describe, expect, it } from 'vitest';
import { AiConfig, AiError, chat } from '../src/ai/client';
import { abortOn } from '../src/ai/cancel';
import { detectApiKey } from '../src/ai/keyScan';
import { saveProfileForm } from '../src/ai/profileForm';
import { Memento, Profile, ProfileStore, Secrets } from '../src/ai/profiles';
import { AiService } from '../src/ai/service';
import { Conversation, Source } from '../src/chat/conversation';
import { importSql } from '../src/importer/sqlText';

const cfg: AiConfig = { baseUrl: 'https://api.example.com/v1', model: 'm', maxTokens: 10, maxTokensParam: 'max_tokens' };
const msgs = [{ role: 'user' as const, content: 'hi' }];
const enc = new TextEncoder();
const sse = (body: ReadableStream) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const delta = (d: object) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;

function newStore() {
  const state = new Map<string, unknown>();
  const sec = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const secrets: Secrets = { get: async (k) => sec.get(k), store: async (k, v) => void sec.set(k, v), delete: async (k) => void sec.delete(k) };
  return new ProfileStore(memento, secrets);
}

/** A stream that sends `first` every 20 ms for `ticks` ticks, then `last` and closes. */
const slowStream = (first: string, ticks: number, last: string[]) =>
  (async (_u: string, init: any) => {
    let n = 0;
    return sse(
      new ReadableStream({
        start(c) {
          init.signal.addEventListener('abort', () => {
            clearInterval(t);
            c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          const t = setInterval(() => {
            if (++n <= ticks) return c.enqueue(enc.encode(first));
            clearInterval(t);
            last.forEach((x) => c.enqueue(enc.encode(x)));
            c.close();
          }, 20);
        },
      }),
    );
  }) as unknown as typeof fetch;

describe('idle timer and reasoning pieces', () => {
  it('reasoning_content alone keeps a stream alive past the idle limit, and is not part of the answer', async () => {
    const fetchFn = slowStream(delta({ reasoning_content: 'thinking' }), 10, [delta({ content: 'done' }), 'data: [DONE]\n\n']);
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined, timeoutMs: 80 })).toBe('done');
  });

  it('the reasoning field does the same', async () => {
    const fetchFn = slowStream(delta({ reasoning: 'thinking' }), 10, [delta({ content: 'ok' }), 'data: [DONE]\n\n']);
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined, timeoutMs: 80 })).toBe('ok');
  });

  it('empty reasoning pieces and ping comments still time out', async () => {
    for (const first of [': ping\n\n', delta({ reasoning_content: '' })]) {
      await expect(chat(cfg, 'k', msgs, { fetchFn: slowStream(first, 1000, []), onText: () => undefined, timeoutMs: 80 })).rejects.toMatchObject({ code: 'timeout' });
    }
  });
});

describe('a replacement model that fails', () => {
  it('names the profile when the replacement is rate limited', async () => {
    const store = newStore();
    const p: Profile = { id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
    await store.save(p, 'k1');
    const fetchFn = (async (url: string, init: any) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama-b' }] }), { status: 200 });
      return new Response('', { status: JSON.parse(init.body).model === 'llama' ? 404 : 429, headers: { 'retry-after': '7' } });
    }) as unknown as typeof fetch;
    const service = new AiService({ store, legacy: () => ({ ...cfg, baseUrl: 'http://localhost:1/v1' }), legacyKey: async () => undefined, fallback: () => false, allowHost: async () => undefined, notice: () => undefined, fetchFn });
    const e: AiError = await service.chat(msgs).catch((x) => x);
    expect(e.code).toBe('rate');
    expect(e.status).toBe(429);
    expect(e.message).toContain('"work"');
    expect(e.message).toContain('busy or you hit its free limit');
  });
});

describe('cancelling through AiService', () => {
  const groq: Profile = { id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
  const oai: Profile = { id: 'o', label: 'home', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

  async function setup(fetchFor: (call: number, signal: AbortSignal, ctl: AbortController) => Promise<Response>) {
    const store = newStore();
    await store.save(groq, 'k1');
    await store.addKey('g', 'k2');
    await store.save(oai, 'k3');
    await store.setActive('g');
    const ctl = new AbortController();
    const urls: string[] = [];
    const notices: string[] = [];
    const fetchFn = (async (url: string, init: any) => (urls.push(url), fetchFor(urls.length, init.signal, ctl))) as unknown as typeof fetch;
    const service = new AiService({ store, legacy: () => cfg, legacyKey: async () => undefined, fallback: () => true, allowHost: async () => undefined, notice: (t) => void notices.push(t), fetchFn });
    return { service, ctl, urls, notices, store };
  }
  const hang = (_n: number, signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

  it('an already cancelled signal sends nothing', async () => {
    const t = await setup(async () => new Response('', { status: 429 }));
    t.ctl.abort();
    const e: AiError = await t.service.chat(msgs, undefined, t.ctl.signal).catch((x) => x);
    expect([e.code, e.message]).toEqual(['config', 'Cancelled.']);
    expect(t.urls).toHaveLength(0);
  });

  it('cancelling mid-flight sends no second request', async () => {
    const t = await setup(hang);
    const p = t.service.chat(msgs, undefined, t.ctl.signal);
    setTimeout(() => t.ctl.abort(), 20);
    const e: AiError = await p.catch((x) => x);
    expect([e.code, e.message]).toEqual(['config', 'Cancelled.']);
    expect(t.urls).toHaveLength(1);
  });

  it('a 429 or 401 arriving with the cancel does not rotate the key or fall back', async () => {
    for (const status of [429, 401]) {
      const t = await setup(async (_n, _s, ctl) => (ctl.abort(), new Response('', { status })));
      const e: AiError = await t.service.chat(msgs, undefined, t.ctl.signal).catch((x) => x);
      expect([e.code, e.message]).toEqual(['config', 'Cancelled.']);
      expect(t.urls).toHaveLength(1);
      expect(t.notices).toEqual([]);
      expect(t.store.currentKeyId(t.store.get('g')!)).toBe(t.store.currentKeyId(groq));
    }
  });
});

describe('cancelling in the conversation', () => {
  const model = importSql('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT);', 'c').model;
  const source: Source = { id: 'c', label: 'c', model };
  const bad = 'Here.\n```sql\nSELECT * FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders)\n```';
  const make = (ai: (m: any[], t?: any, s?: AbortSignal) => Promise<string>) => new Conversation({ ai, notes: () => '', limits: () => ({ maxRows: 100, timeoutMs: 1000 }), maxTables: () => 12, sampleRows: () => 5 });

  it('makes no repair request when cancelled after the first answer', async () => {
    const ctl = new AbortController();
    let n = 0;
    const c = make(async () => (n++, ctl.abort(), bad));
    await c.ask(source, 'customers with no orders', undefined, { draft: () => undefined, checking: () => undefined, signal: ctl.signal });
    expect(n).toBe(1);
  });

  it('lets the error of a cancelled repair request through', async () => {
    const ctl = new AbortController();
    let n = 0;
    const c = make(async () => {
      if (++n === 2) {
        ctl.abort();
        throw new AiError('Cancelled.', 'config');
      }
      return bad;
    });
    await expect(c.ask(source, 'customers with no orders', undefined, { draft: () => undefined, checking: () => undefined, signal: ctl.signal })).rejects.toThrow('Cancelled.');
    expect(n).toBe(2);
  });

  it('lets the error of a cancelled first request through', async () => {
    const ctl = new AbortController();
    let n = 0;
    const c = make(async () => (n++, ctl.abort(), Promise.reject(new AiError('Cancelled.', 'config'))));
    await expect(c.ask(source, 'x', undefined, { draft: () => undefined, checking: () => undefined, signal: ctl.signal })).rejects.toThrow('Cancelled.');
    expect(n).toBe(1);
  });
});

describe('chat participant cancel wiring', () => {
  it('aborts when the token fires, also when it already had, and stops listening on dispose', () => {
    let fire = () => {};
    let disposed = false;
    const token = { isCancellationRequested: false, onCancellationRequested: (f: () => void) => ((fire = f), { dispose: () => void (disposed = true) }) };
    const w = abortOn(token);
    expect(w.signal.aborted).toBe(false);
    fire();
    expect(w.signal.aborted).toBe(true);
    w.dispose();
    expect(disposed).toBe(true);
    expect(abortOn({ ...token, isCancellationRequested: true }).signal.aborted).toBe(true);
  });
});

describe('profile form: a key added while the address modal is open', () => {
  const form = { id: 'p1', provider: 'custom' as const, label: 'A', baseUrl: 'https://new.example.com/v1', model: 'm1', key: '' };
  const seeded = async () => {
    const store = newStore();
    await store.save({ id: 'p1', label: 'A', provider: 'custom', baseUrl: 'https://old.example.com/v1', model: 'm1', models: ['m1'] }, 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    return store;
  };

  for (const choice of ['keep', 'remove'] as const) {
    it(`is not moved silently (${choice})`, async () => {
      const store = await seeded();
      const r = await saveProfileForm(store, form, { confirmAddress: async () => (await store.addKey('p1', 'sk-bbbbbbbbbbbbbbbbbbbbbbbb'), choice) });
      expect('error' in r && r.error).toContain('added while you were deciding');
      expect(store.get('p1')!.baseUrl).toBe('https://old.example.com/v1');
    });
  }
});

describe('pasted key check (what checkSpeed relies on)', () => {
  it('blocks SQL that carries a key and lets ordinary SQL through', () => {
    expect(detectApiKey("SELECT * FROM users WHERE token='sk-abcdefghijklmnopqrstuvwx'")).toMatchObject({ provider: 'openai' });
    expect(detectApiKey("SELECT * FROM users WHERE api_key = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'")).toBeDefined();
    expect(detectApiKey("SELECT o.order_id, c.name FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE o.status = 'shipped' AND c.name LIKE 'sk-%'")).toBeUndefined();
  });
});

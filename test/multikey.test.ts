import { describe, expect, it } from 'vitest';
import { AiService } from '../src/ai/service';
import { addKey, changeKey, ChangeKeyDeps } from '../src/changeKey';
import { describeExpiry, expiryWarnings, KEY_PREFIX, keysOf, Memento, modelsOf, PRIMARY_KEY, Profile, ProfileStore, Secrets, statusOf, withModel } from '../src/ai/profiles';

const NOW = new Date('2026-11-07T10:00:00');
const PAST = '2026-10-01';
const FUTURE = '2027-06-01';
const msgs = [{ role: 'user' as const, content: 'hi' }];

const KEY_A = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'gsk_BBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_C = 'gsk_CCCCCCCCCCCCCCCCCCCCCCCC';

const groq: Profile = { id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
const oai: Profile = { id: 'o', label: 'home', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

/** `refuse` lists keys the service answers 401 to. Everything else gets a reply naming the host. */
function setup(opts: { refuse?: string[]; limited?: string[]; status?: number; fallback?: boolean } = {}) {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  const store = new ProfileStore(memento, sec);
  const calls: { host: string; auth?: string; model?: string }[] = [];
  const notices: string[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const auth: string | undefined = init.headers.authorization;
    calls.push({ host: new URL(url).hostname, auth, model: init.body ? JSON.parse(init.body).model : undefined });
    if (opts.status) return new Response('', { status: opts.status });
    if (auth && opts.refuse?.includes(auth.replace('Bearer ', ''))) return new Response('', { status: 401 });
    if (auth && opts.limited?.includes(auth.replace('Bearer ', ''))) return new Response('', { status: 429 });
    const body = url.endsWith('/models') ? { data: [{ id: 'llama' }] } : { choices: [{ message: { content: `from ${new URL(url).hostname}` } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const service = new AiService({
    store,
    legacy: () => ({ baseUrl: 'http://localhost:11434/v1', model: 'old', maxTokens: 100, maxTokensParam: 'max_tokens' }),
    legacyKey: async () => undefined,
    fallback: () => !!opts.fallback,
    allowHost: async () => undefined,
    notice: (t) => void notices.push(t),
    now: () => NOW,
    fetchFn,
  });
  return { store, service, calls, notices, secrets, state };
}

const sentKeys = (calls: { auth?: string }[]): (string | undefined)[] => calls.map((c) => c.auth?.replace('Bearer ', ''));

describe('profile status with several keys', () => {
  it('has expired only when every key has', () => {
    const extra = (expiresAt: string) => [{ id: 'k2', expiresAt }];
    expect(statusOf({ expiresAt: PAST, extraKeys: extra(FUTURE) }, NOW)).toBe('active');
    expect(statusOf({ expiresAt: PAST, extraKeys: extra('2026-11-08') }, NOW)).toBe('expiring');
    expect(statusOf({ expiresAt: PAST, extraKeys: extra(PAST) }, NOW)).toBe('expired');
    expect(statusOf({ expiresAt: PAST }, NOW)).toBe('expired');
  });

  it('counts the valid keys, and reads as before with one key', () => {
    expect(describeExpiry({ ...groq, expiresAt: PAST, extraKeys: [{ id: 'k2' }] }, NOW)).toBe('1 of 2 keys valid');
    expect(describeExpiry({ ...groq, expiresAt: PAST }, NOW)).toBe(`Expired on ${PAST}`);
  });

  it('warns about each key once, and says when another key takes over', () => {
    const p: Profile = { ...groq, expiresAt: PAST, extraKeys: [{ id: 'k2', expiresAt: '2026-11-08' }, { id: 'k3' }] };
    const w = expiryWarnings([p], NOW, new Set());
    expect(w.ids).toEqual(['g', 'g.k2']);
    expect(w.targets).toEqual([{ profileId: 'g', keyId: PRIMARY_KEY }, { profileId: 'g', keyId: 'k2' }]);
    expect(w.messages[0]).toContain('(key 1)');
    expect(w.messages[0]).toContain('Another key in this profile is used instead.');
    expect(expiryWarnings([p], NOW, new Set(w.ids)).ids).toEqual([]);
  });
});

describe('switching keys', () => {
  it('moves past an expired key without ever sending it, and says so', async () => {
    const t = setup();
    await t.store.save({ ...groq, expiresAt: PAST }, KEY_A);
    await t.store.addKey('g', KEY_B);
    expect(await t.service.chat(msgs)).toBe('from api.groq.com');
    expect(sentKeys(t.calls)).toEqual([KEY_B]);
    expect(t.notices[0]).toContain('switched to key 2 of 2');
    expect(t.notices[0]).toContain('expired');
  });

  it('works with fallback off, because the key stays with the same service', async () => {
    const t = setup({ refuse: [KEY_A], fallback: false });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.service.chat(msgs);
    expect(sentKeys(t.calls)).toEqual([KEY_A, KEY_B]);
    expect(t.notices[0]).toContain('was refused');
  });

  it('remembers the key that worked, so a dead key is not tried first next time', async () => {
    const t = setup({ refuse: [KEY_A] });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.service.chat(msgs);
    t.calls.length = 0;
    t.notices.length = 0;
    await t.service.chat(msgs);
    expect(sentKeys(t.calls)).toEqual([KEY_B]);
    expect(t.notices).toEqual([]);
  });

  it('stays quiet and sends one request while the first key works', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.service.chat(msgs);
    expect(sentKeys(t.calls)).toEqual([KEY_A]);
    expect(t.notices).toEqual([]);
  });

  it('reports all keys refused, and never sends them to another service with fallback off', async () => {
    const t = setup({ refuse: [KEY_A, KEY_B, KEY_C] });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.store.save(oai, KEY_C);
    await expect(t.service.chat(msgs)).rejects.toThrow(/refused all 2 keys/);
    expect(t.calls.every((c) => c.host === 'api.groq.com')).toBe(true);
    expect(sentKeys(t.calls)).toEqual([KEY_A, KEY_B]);
  });

  it('with fallback on, tries the next service only after every key here is refused, each with its own key', async () => {
    const t = setup({ refuse: [KEY_A, KEY_B], fallback: true });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.store.save(oai, KEY_C);
    expect(await t.service.chat(msgs)).toBe('from api.openai.com');
    expect(t.calls.map((c) => [c.host, c.auth])).toEqual([
      ['api.groq.com', `Bearer ${KEY_A}`],
      ['api.groq.com', `Bearer ${KEY_B}`],
      ['api.openai.com', `Bearer ${KEY_C}`],
    ]);
  });

  it('moves to the next key on a rate limit, trying each key once', async () => {
    const t = setup({ status: 429 });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await expect(t.service.chat(msgs)).rejects.toThrow(/429/);
    expect(sentKeys(t.calls)).toEqual([KEY_A, KEY_B]);
  });

  it('says a key hit its limit when the next one answers', async () => {
    const t = setup({ limited: [KEY_A] });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.service.chat(msgs);
    expect(sentKeys(t.calls)).toEqual([KEY_A, KEY_B]);
    expect(t.notices[0]).toContain('hit its rate limit');
  });

  it('does not change key on a server error, which would hit every key alike', async () => {
    const t = setup({ status: 503 });
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await expect(t.service.chat(msgs)).rejects.toThrow();
    expect(sentKeys(t.calls)).toEqual([KEY_A]);
  });

  it('skips the profile when every key has expired, and sends nothing', async () => {
    const t = setup();
    await t.store.save({ ...groq, expiresAt: PAST }, KEY_A);
    await t.store.addKey('g', KEY_B, PAST);
    await expect(t.service.chat(msgs)).rejects.toThrow(/all have expired/);
    expect(t.calls).toEqual([]);
  });

  it('still lets a local service run with no key', async () => {
    const t = setup();
    await t.store.save({ id: 'l', label: 'local', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen' });
    expect(await t.service.chat(msgs)).toBe('from localhost');
    expect(t.calls[0].auth).toBeUndefined();
  });

  it('tests the key in use, or the one asked for', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const k2 = (await t.store.addKey('g', KEY_B))!;
    await t.store.setCurrentKey('g', k2);
    await t.service.test('g');
    await t.service.test('g', PRIMARY_KEY);
    expect(sentKeys(t.calls)).toEqual([KEY_B, KEY_A]);
  });

  it('refuses to test an expired key', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const k2 = (await t.store.addKey('g', KEY_B, PAST))!;
    const r = await t.service.test('g', k2);
    expect(r.ok).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

describe('storing several keys', () => {
  it('keeps keys in secret storage only, and the first key where 1.1.0 looks for it', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    expect(JSON.stringify([...t.state.entries()])).not.toContain('gsk_');
    expect(t.secrets.get(KEY_PREFIX + 'g')).toBe(KEY_A);
    expect(t.store.get('g')?.model).toBe('llama');
  });

  it('deletes every key along with the profile', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    await t.store.remove('g');
    expect(t.secrets.size).toBe(0);
  });

  it('removing an extra key leaves the others, and a pointer to it goes back to the first key', async () => {
    const t = setup();
    await t.store.save({ ...groq, expiresAt: FUTURE }, KEY_A);
    const k2 = (await t.store.addKey('g', KEY_B))!;
    await t.store.setCurrentKey('g', k2);
    await t.store.removeKey('g', k2);
    const p = t.store.get('g')!;
    expect(keysOf(p)).toEqual([{ id: PRIMARY_KEY, expiresAt: FUTURE }]);
    expect(t.store.currentKeyId(p)).toBe(PRIMARY_KEY);
    expect(t.secrets.size).toBe(1);
  });

  it('removing the first key moves the next into its place with its own date', async () => {
    const t = setup();
    await t.store.save({ ...groq, expiresAt: PAST }, KEY_A);
    await t.store.addKey('g', KEY_B, FUTURE);
    const k3 = (await t.store.addKey('g', KEY_C))!;
    await t.store.removeKey('g', PRIMARY_KEY);
    const p = t.store.get('g')!;
    expect(p.expiresAt).toBe(FUTURE);
    expect(p.extraKeys?.map((k) => k.id)).toEqual([k3]);
    expect(await t.store.key('g')).toBe(KEY_B);
    expect(t.secrets.size).toBe(2);
  });

  it('removing the first key keeps an extra key that is current', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await t.store.addKey('g', KEY_B);
    const k3 = (await t.store.addKey('g', KEY_C))!;
    await t.store.setCurrentKey('g', k3);
    await t.store.removeKey('g', PRIMARY_KEY);
    const p = t.store.get('g')!;
    expect(t.store.currentKeyId(p)).toBe(k3);
    expect(await t.store.key('g', t.store.currentKeyId(p))).toBe(KEY_C);
  });

  it('removing the only key leaves the profile with none', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await t.store.removeKey('g', PRIMARY_KEY);
    expect(t.store.get('g')).toBeDefined();
    expect(t.secrets.size).toBe(0);
  });

  it('reads a profile saved by 1.1.0 as one key and one model', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const p = t.store.get('g')!;
    expect(keysOf(p)).toEqual([{ id: PRIMARY_KEY }]);
    expect(modelsOf(p)).toEqual(['llama']);
    expect(t.store.currentKeyId(p)).toBe(PRIMARY_KEY);
  });
});

describe('saved models', () => {
  it('keeps the old model when another is chosen, with no duplicates', () => {
    const a = withModel(groq, 'llama-2');
    expect(a.model).toBe('llama-2');
    expect(modelsOf(a)).toEqual(['llama-2', 'llama']);
    expect(modelsOf(withModel(a, 'llama'))).toEqual(['llama', 'llama-2']);
  });

  it('sends the chosen model', async () => {
    const t = setup();
    await t.store.save(withModel(groq, 'llama-2'), KEY_A);
    await t.service.chat(msgs);
    expect(t.calls[0].model).toBe('llama-2');
  });
});

describe('adding and changing keys', () => {
  function deps(t: ReturnType<typeof setup>, key: string | undefined, date?: string) {
    const reports: [boolean, string][] = [];
    const prompts: string[] = [];
    const d: ChangeKeyDeps = {
      store: t.store,
      service: t.service,
      promptKey: async (what) => {
        prompts.push(what);
        return key;
      },
      promptDate: async () => date,
      setLegacyKey: async () => undefined,
      report: (ok, text) => void reports.push([ok, text]),
    };
    return { d, reports, prompts };
  }

  it('adds several keys from one box, and checks each straight away', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const { d, reports } = deps(t, `${KEY_B} ${KEY_C}`);
    await addKey(d, 'g');
    const added = t.store.get('g')!.extraKeys!;
    expect(added).toHaveLength(2);
    expect(await t.store.key('g', added[1].id)).toBe(KEY_C);
    expect(sentKeys(t.calls)).toEqual([KEY_B, KEY_C]);
    expect(reports[0]).toEqual([true, '2 keys added and checked.']);
  });

  it('says when a key added fails its check, and keeps it', async () => {
    const t = setup({ refuse: [KEY_B] });
    await t.store.save(groq, KEY_A);
    const { d, reports } = deps(t, KEY_B);
    await addKey(d, 'g');
    expect(reports[0][0]).toBe(false);
    expect(reports[0][1]).toContain('1 key added, but 1 failed the check');
    expect(t.store.get('g')!.extraKeys).toHaveLength(1);
  });

  it('refuses a key that is already on the profile', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const { d, reports } = deps(t, KEY_A);
    await addKey(d, 'g');
    expect(t.store.get('g')!.extraKeys).toBeUndefined();
    expect(reports[0]).toEqual([false, expect.stringContaining('already saved')]);
  });

  it('adds nothing if the box is cancelled', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    await addKey(deps(t, undefined).d, 'g');
    expect(t.store.get('g')!.extraKeys).toBeUndefined();
    expect(t.secrets.size).toBe(1);
  });

  it('changes the chosen key and its date, and leaves the others alone', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const k2 = (await t.store.addKey('g', KEY_B, PAST))!;
    const { d } = deps(t, KEY_C, FUTURE);
    await changeKey(d, 'g', k2);
    expect(await t.store.key('g')).toBe(KEY_A);
    expect(await t.store.key('g', k2)).toBe(KEY_C);
    expect(t.store.get('g')!.extraKeys![0].expiresAt).toBe(FUTURE);
    expect(sentKeys(t.calls)).toEqual([KEY_C]);
  });

  it('with no key named, changes the key in use', async () => {
    const t = setup();
    await t.store.save(groq, KEY_A);
    const k2 = (await t.store.addKey('g', KEY_B))!;
    await t.store.setCurrentKey('g', k2);
    await changeKey(deps(t, KEY_C).d, 'g');
    expect(await t.store.key('g')).toBe(KEY_A);
    expect(await t.store.key('g', k2)).toBe(KEY_C);
  });
});

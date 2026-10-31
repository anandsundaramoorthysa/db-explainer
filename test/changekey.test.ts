import { describe, expect, it } from 'vitest';
import { changeKey, ChangeKeyDeps } from '../src/changeKey';
import { Memento, Profile, ProfileStore, Secrets } from '../src/ai/profiles';
import { AiService } from '../src/ai/service';

const NOW = new Date('2026-11-07T10:00:00');
const base: Profile = { id: 'a', label: 'Work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'm' };

async function setup(profile: Profile | undefined, answers: { key?: string; date?: string }, status = 200) {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  const store = new ProfileStore(memento, sec);
  if (profile) await store.save(profile, 'OLDKEY-1234567890');
  const auths: (string | undefined)[] = [];
  const service = new AiService({
    store,
    legacy: () => ({ baseUrl: 'https://legacy.example.com/v1', model: 'x', maxTokens: 10, maxTokensParam: 'max_tokens' }),
    legacyKey: async () => secrets.get('legacy'),
    fallback: () => false,
    allowHost: async () => {},
    notice: () => {},
    now: () => NOW,
    fetchFn: (async (_u: string, init: any) => (auths.push(init.headers.authorization), new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status }))) as any,
  });
  const reports: { ok: boolean; text: string }[] = [];
  const asked = { key: 0, date: 0 };
  const deps: ChangeKeyDeps = {
    store,
    service,
    promptKey: async () => (asked.key++, answers.key),
    promptDate: async () => (asked.date++, answers.date),
    setLegacyKey: async (k) => void secrets.set('legacy', k),
    report: (ok, text) => void reports.push({ ok, text }),
  };
  return { deps, store, secrets, state, reports, asked, auths };
}

describe('changeKey', () => {
  it('keeps the old key when the box is cancelled or empty', async () => {
    for (const key of [undefined, '', '   ']) {
      const t = await setup(base, { key });
      await changeKey(t.deps);
      expect(await t.store.key('a')).toBe('OLDKEY-1234567890');
      expect(t.reports).toEqual([]);
    }
  });

  it('refuses a key with whitespace inside and changes nothing', async () => {
    const t = await setup(base, { key: 'abc def' });
    await changeKey(t.deps);
    expect(await t.store.key('a')).toBe('OLDKEY-1234567890');
    expect(t.reports[0].ok).toBe(false);
    expect(t.auths).toEqual([]);
  });

  it('stores the new key in secret storage only, then tests it with that key', async () => {
    const t = await setup(base, { key: ' NEWKEY-abcdefghij ' });
    await changeKey(t.deps, 'a');
    expect(t.secrets.get('dbExplainer.ai.key.a')).toBe('NEWKEY-abcdefghij');
    expect(JSON.stringify([...t.state.entries()])).not.toContain('NEWKEY');
    expect(t.auths).toEqual(['Bearer NEWKEY-abcdefghij']);
    expect(t.reports[0].ok).toBe(true);
    expect(t.reports.map((r) => r.text).join()).not.toContain('NEWKEY');
  });

  it('does not ask for a date when the profile has none', async () => {
    const t = await setup(base, { key: 'NEWKEY-abcdefghij', date: '2030-01-01' });
    await changeKey(t.deps);
    expect(t.asked.date).toBe(0);
  });

  it('asks for the date when the profile has one: a new date, an empty one, Escape, and a bad one', async () => {
    const withDate = { ...base, expiresAt: '2026-11-01' };
    const run = async (date: string | undefined) => {
      const t = await setup(withDate, { key: 'NEWKEY-abcdefghij', date });
      await changeKey(t.deps);
      return t;
    };
    const set = await run('2027-03-04');
    expect(set.store.get('a')?.expiresAt).toBe('2027-03-04');
    expect(set.reports[0].ok).toBe(true); // the old date had expired the key; the new one lets the check run
    expect((await run('')).store.get('a')?.expiresAt).toBeUndefined();
    expect((await run(undefined)).store.get('a')?.expiresAt).toBe('2026-11-01');
    const bad = await run('soon');
    expect(bad.store.get('a')?.expiresAt).toBe('2026-11-01');
    expect(bad.reports[0].text).toContain('not a real date');
    expect(await bad.store.key('a')).toBe('NEWKEY-abcdefghij');
  });

  it('reports a rejected key clearly after saving it', async () => {
    const t = await setup(base, { key: 'NEWKEY-abcdefghij' }, 401);
    await changeKey(t.deps);
    expect(t.reports[0].ok).toBe(false);
    expect(t.reports[0].text).toContain('refused the key (401)');
  });

  it('uses the old single key when there are no profiles', async () => {
    const t = await setup(undefined, { key: 'LEGACYKEY-abcdefghij' });
    await changeKey(t.deps);
    expect(t.secrets.get('legacy')).toBe('LEGACYKEY-abcdefghij');
    expect(t.auths).toEqual(['Bearer LEGACYKEY-abcdefghij']);
  });

  it('ignores a profile id that no longer exists', async () => {
    const t = await setup(base, { key: 'NEWKEY-abcdefghij' });
    await changeKey(t.deps, 'gone');
    expect(t.asked.key).toBe(0);
  });
});

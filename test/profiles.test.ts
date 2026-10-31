import { describe, expect, it } from 'vitest';
import { dayStamp, daysLeft, expiryWarnings, maskKey, Memento, Profile, ProfileStore, providerFromUrl, Secrets, statusOf } from '../src/ai/profiles';
import { detectApiKey } from '../src/ai/keyScan';

const at = (iso: string): Date => new Date(`${iso}T15:30:00`);

function fakes() {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  return { state, secrets, store: new ProfileStore(memento, sec) };
}

const prof = (id: string, extra: Partial<Profile> = {}): Profile => ({ id, label: id, provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'm', ...extra });

describe('expiry', () => {
  it('is valid through the whole expiry day, then expired', () => {
    expect(statusOf({ expiresAt: '2026-11-10' }, at('2026-11-10'))).toBe('expiring');
    expect(statusOf({ expiresAt: '2026-11-10' }, at('2026-11-11'))).toBe('expired');
  });
  it('warns from three days before, not four', () => {
    expect(statusOf({ expiresAt: '2026-11-10' }, at('2026-11-06'))).toBe('active');
    expect(statusOf({ expiresAt: '2026-11-10' }, at('2026-11-07'))).toBe('expiring');
    expect(daysLeft({ expiresAt: '2026-11-10' }, at('2026-11-07'))).toBe(3);
  });
  it('counts across a month end and with no date', () => {
    expect(daysLeft({ expiresAt: '2026-12-01' }, at('2026-11-29'))).toBe(2);
    expect(statusOf({}, at('2026-11-29'))).toBe('active');
    expect(statusOf({ expiresAt: 'garbage' }, at('2026-11-29'))).toBe('active');
  });
  it('warns once a day per key and never for a key with room', () => {
    const list = [prof('a', { expiresAt: '2026-11-08' }), prof('b', { expiresAt: '2026-10-01' }), prof('c', { expiresAt: '2027-01-01' }), prof('d')];
    const first = expiryWarnings(list, at('2026-11-07'), new Set());
    expect(first.ids).toEqual(['a', 'b']);
    expect(first.messages[0]).toContain('expires in 1 day');
    expect(first.messages[1]).toContain('expired on 2026-10-01');
    expect(expiryWarnings(list, at('2026-11-07'), new Set(first.ids)).ids).toEqual([]);
    expect(dayStamp(at('2026-03-05'))).toBe('2026-03-05');
  });
});

describe('masking', () => {
  it('shows only the last four of a long key and nothing of a short one', () => {
    expect(maskKey('sk-1234567890abcdefWXYZ')).toMatch(/^•+WXYZ$/);
    expect(maskKey('sk-short')).not.toContain('short');
    expect(maskKey(undefined)).toBe('');
  });
  it('guesses the provider from an address', () => {
    expect(providerFromUrl('https://api.groq.com/openai/v1')).toBe('groq');
    expect(providerFromUrl('http://localhost:1234/v1')).toBe('ollama');
    expect(providerFromUrl('https://llm.example.com/v1')).toBe('custom');
    expect(providerFromUrl('nope')).toBe('custom');
  });
});

describe('ProfileStore', () => {
  it('keeps the key in secret storage and out of the saved profile', async () => {
    const { state, secrets, store } = fakes();
    await store.save(prof('a'), 'gsk_SECRETSECRETSECRETSECRET');
    expect(JSON.stringify([...state.entries()])).not.toContain('SECRET');
    expect(secrets.get('dbExplainer.ai.key.a')).toBe('gsk_SECRETSECRETSECRETSECRET');
    expect(await store.key('a')).toBe('gsk_SECRETSECRETSECRETSECRET');
  });
  it('makes the first profile active and keeps the key when a save has none', async () => {
    const { store } = fakes();
    await store.save(prof('a'), 'k1');
    await store.save(prof('b'), 'k2');
    expect(store.active()?.id).toBe('a');
    await store.save(prof('a', { model: 'changed' }));
    expect(await store.key('a')).toBe('k1');
    expect(store.get('a')?.model).toBe('changed');
  });
  it('removing the active profile moves to a valid one and deletes its key', async () => {
    const { secrets, store } = fakes();
    await store.save(prof('a'), 'k1');
    await store.save(prof('b', { expiresAt: '2000-01-01' }), 'k2');
    await store.save(prof('c'), 'k3');
    await store.remove('a');
    expect(secrets.has('dbExplainer.ai.key.a')).toBe(false);
    expect(store.active()?.id).toBe('c');
  });
  it('tells listeners about changes', async () => {
    const { store } = fakes();
    let n = 0;
    store.onChange(() => n++);
    await store.save(prof('a'), 'k');
    await store.setActive('a');
    expect(n).toBe(2);
  });
});

describe('detectApiKey', () => {
  it.each([
    ['sk-proj-abcdefghijklmnopqrstuvwx1234', 'openai'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwx', 'claude'],
    ['sk-or-v1-abcdefghijklmnopqrstuvwx1234', 'openrouter'],
    ['gsk_abcdefghijklmnopqrstuvwxyz123456', 'groq'],
    ['AIzaSyA-abcdefghijklmnopqrstuvwxyz12345', 'gemini'],
    ['my key is gsk_abcdefghijklmnopqrstuvwxyz123456 why does it fail', 'groq'],
  ])('finds %s', (text, provider) => {
    expect(detectApiKey(text)?.provider).toBe(provider);
  });
  it('finds a bare long token, with or without Bearer', () => {
    expect(detectApiKey('Bearer a8Kd92jfLq0Zx71mNb5Vc3RtYu6HgE4s')?.key).toBe('a8Kd92jfLq0Zx71mNb5Vc3RtYu6HgE4s');
  });
  it('leaves ordinary questions, SQL, identifiers and hashes alone', () => {
    for (const t of [
      'How many orders did each customer place?',
      'select * from customer_order_line_items where sku = 5',
      'what does the sk_value column in the invoices table hold',
      'customer_order_line_items_archive_2024',
      'd41d8cd98f00b204e9800998ecf8427e',
      'The api key column in the users table is nullable, is that ok?',
    ]) {
      expect(detectApiKey(t), t).toBeUndefined();
    }
  });
});

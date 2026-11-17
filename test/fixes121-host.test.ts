import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tlsQuestionNeeded } from '../src/db/connectionString';
import { saveProfileForm } from '../src/ai/profileForm';
import { Memento, ProfileStore, Secrets } from '../src/ai/profiles';

function setup() {
  const state = new Map<string, unknown>();
  const sec = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const secrets: Secrets = { get: async (k) => sec.get(k), store: async (k, v) => void sec.set(k, v), delete: async (k) => void sec.delete(k) };
  return new ProfileStore(memento, secrets);
}

describe('tlsQuestionNeeded', () => {
  it('asks only for a remote host with no ssl setting', () => {
    expect(tlsQuestionNeeded('db.example.com', undefined)).toBe(true);
    expect(tlsQuestionNeeded('db.example.com', false)).toBe(false); // sslmode=disable, explicit
    expect(tlsQuestionNeeded('db.example.com', true)).toBe(false);
    for (const h of ['localhost', '127.0.0.1', '::1']) expect(tlsQuestionNeeded(h, undefined)).toBe(false);
  });
});

describe('profile form merge', () => {
  const form = { id: 'p1', provider: 'custom' as const, label: 'A', baseUrl: 'https://old.example.com/v1', model: 'm2', key: '' };

  async function seeded() {
    const store = setup();
    await store.save({ id: 'p1', label: 'A', provider: 'custom', baseUrl: 'https://old.example.com/v1', model: 'm1', models: ['m1'] }, 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
    return store;
  }

  it('keeps an edit made while the confirm modal was open', async () => {
    const store = await seeded();
    const r = await saveProfileForm(store, { ...form, baseUrl: 'https://new.example.com/v1' }, {
      confirmAddress: async () => {
        await store.save({ ...store.get('p1')!, currentKeyId: 'k2', extraKeys: [{ id: 'k2' }], models: ['m1', 'extra'] });
        return 'keep';
      },
    });
    expect(r).toEqual({ id: 'p1' });
    const p = store.get('p1')!;
    expect(p.currentKeyId).toBe('k2');
    expect(p.extraKeys).toEqual([{ id: 'k2' }]);
    expect(p.models).toContain('extra');
    expect(p.baseUrl).toBe('https://new.example.com/v1');
  });

  it('does not bring back a profile deleted during the modal', async () => {
    const store = await seeded();
    const r = await saveProfileForm(store, { ...form, baseUrl: 'https://new.example.com/v1' }, {
      confirmAddress: async () => {
        await store.remove('p1');
        return 'keep';
      },
    });
    expect('error' in r).toBe(true);
    expect(store.get('p1')).toBeUndefined();
  });
});

describe('package.json settings scope', () => {
  it('fallback AI address, model and fallback cannot come from workspace settings', () => {
    const props = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration.properties;
    for (const k of ['baseUrl', 'model', 'fallback']) expect(props[`dbExplainer.ai.${k}`].scope).toBe('machine');
  });
});

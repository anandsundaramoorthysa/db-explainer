import { describe, expect, it } from 'vitest';
import { isChatModel, rankModels, replacementsFor } from '../src/ai/modelPick';
import { Memento, Profile, ProfileStore, Secrets } from '../src/ai/profiles';
import { AiService, suggestModel } from '../src/ai/service';

const GROQ_LIST = ['whisper-large-v3', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'meta-llama/llama-guard-4-12b', 'qwen/qwen3-32b', 'groq/compound', 'openai/gpt-oss-20b', 'playai-tts'];

describe('picking a model', () => {
  it('leaves out models that cannot chat', () => {
    expect(isChatModel('whisper-large-v3')).toBe(false);
    expect(isChatModel('meta-llama/llama-guard-4-12b')).toBe(false);
    expect(isChatModel('text-embedding-3-small')).toBe(false);
    expect(isChatModel('qwen/qwen3-32b')).toBe(true);
  });

  it('puts bigger and higher-tier models first, and small or preview ones last', () => {
    expect(rankModels(['gemini-2.5-flash', 'gemini-2.5-pro'])[0]).toBe('gemini-2.5-pro');
    expect(rankModels(GROQ_LIST)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']);
    expect(rankModels(['gemini-2.5-flash-lite', 'models/gemini-2.5-pro', 'gemini-2.5-flash'])).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    expect(rankModels(['gpt-4o-mini', 'gpt-4o'])).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('tries the developer\x27s own saved models first, if the service still has them', () => {
    expect(replacementsFor('dead', ['dead', 'llama-3.1-8b-instant', 'gone-too'], GROQ_LIST)).toEqual(['llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'qwen/qwen3-32b']);
    expect(replacementsFor('dead', ['dead', 'mine'], [])).toEqual(['mine']);
  });
});

describe('a model that has been retired', () => {
  const groq: Profile = { id: 'g', label: 'Groq', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' };

  function setup(alive: string[], listed = GROQ_LIST) {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
    const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
    const store = new ProfileStore(memento, sec);
    const tried: string[] = [];
    const notices: string[] = [];
    const fetchFn = (async (url: string, init: any) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }), { status: 200 });
      const model = JSON.parse(init.body).model;
      tried.push(model);
      if (!alive.includes(model)) return new Response(JSON.stringify({ error: { message: `The model ${model} does not exist`, code: 'model_not_found' } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: `answer from ${model}` } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const service = new AiService({ store, legacy: () => ({ baseUrl: 'http://localhost:1/v1', model: '', maxTokens: 10, maxTokensParam: 'max_tokens' }), legacyKey: async () => undefined, fallback: () => false, allowHost: async () => undefined, notice: (t) => void notices.push(t), fetchFn });
    return { store, service, tried, notices };
  }
  const ask = [{ role: 'user' as const, content: 'hi' }];

  it('switches to the best model the service offers, keeps it, and says so once', async () => {
    const t = setup(['openai/gpt-oss-120b', 'qwen/qwen3-32b']);
    await t.store.save(groq, 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await t.service.chat(ask)).toBe('answer from openai/gpt-oss-120b');
    // The closest name (same family) is tried before the biggest model.
    expect(t.tried).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b']);
    expect(t.notices[0]).toMatch(/"llama-3.3-70b-versatile" is no longer available, so DB Explainer switched to "openai\/gpt-oss-120b"/);
    const p = t.store.get('g')!;
    expect(p.model).toBe('openai/gpt-oss-120b');
    expect(p.models).not.toContain('llama-3.3-70b-versatile');
    t.tried.length = 0;
    await t.service.chat(ask);
    expect(t.tried).toEqual(['openai/gpt-oss-120b']);
  });

  it('keeps going down the list until one answers', async () => {
    const t = setup(['llama-3.1-8b-instant']);
    await t.store.save(groq, 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await t.service.chat(ask)).toBe('answer from llama-3.1-8b-instant');
    expect(t.tried).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
  });

  it('only gives up, with a clear message, when no model answers', async () => {
    const t = setup([]);
    await t.store.save(groq, 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(t.service.chat(ask)).rejects.toThrow(/No other model it offers answered either/);
    expect(t.store.get('g')!.model).toBe('llama-3.3-70b-versatile');
  });

  it('only suggests a model when a saved profile is checked, and changes nothing', async () => {
    const t = setup(['openai/gpt-oss-120b']);
    await t.store.save(groq, 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA');
    const r = await t.service.test('g');
    expect(suggestModel('llama-3.3-70b-versatile', r.models)).toBe('llama-3.1-8b-instant');
    expect(t.store.get('g')!.model).toBe('llama-3.3-70b-versatile');
    expect(suggestModel('qwen/qwen3-32b', r.models)).toBeUndefined();
  });
});

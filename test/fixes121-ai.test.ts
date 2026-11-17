import { describe, expect, it } from 'vitest';
import { AiConfig, AiError, chat, modelIsGone } from '../src/ai/client';
import { replacementsFor } from '../src/ai/modelPick';
import { suggestModel } from '../src/ai/service';

const cfg: AiConfig = { baseUrl: 'https://api.example.com/v1', model: 'm', maxTokens: 10, maxTokensParam: 'max_tokens' };
const msgs = [{ role: 'user' as const, content: 'hi' }];
const enc = new TextEncoder();
const piece = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
const sse = (body: ReadableStream) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const streamOf = (chunks: string[]) =>
  new ReadableStream({
    start(c) {
      chunks.forEach((x) => c.enqueue(enc.encode(x)));
      c.close();
    },
  });

describe('a 400 is a retired model only when the service says so', () => {
  it('matches real "model is gone" bodies', () => {
    expect(modelIsGone(404, 'anything')).toBe(true);
    expect(modelIsGone(400, 'The model `llama-3.1-70b` has been decommissioned and is no longer supported.')).toBe(true);
    expect(modelIsGone(400, '{"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}')).toBe(true);
    expect(modelIsGone(400, 'models/gemini-9 is not found for API version v1beta')).toBe(true);
    expect(modelIsGone(410, 'model claude-2.0 has been deprecated')).toBe(true);
  });

  it('does not match limits, parameters or other 400s that only mention the model', () => {
    expect(modelIsGone(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")).toBe(false);
    expect(modelIsGone(400, "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.")).toBe(false);
    expect(modelIsGone(400, 'max_tokens: 99999 > 8192, which is the maximum allowed number of output tokens for claude-3-opus')).toBe(false);
    expect(modelIsGone(400, "Unsupported value: 'temperature' does not support 0.2 with this model.")).toBe(false);
    expect(modelIsGone(400, 'Please reduce the length of the messages for this model.')).toBe(false);
    expect(modelIsGone(400, 'bad request')).toBe(false);
  });

  it('turns a 400 about max_tokens into a plain config error, not a model error', async () => {
    const fetchFn = (async () => new Response('Unsupported parameter: max_tokens is not supported with this model', { status: 400 })) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn })).rejects.toMatchObject({ code: 'config', status: 400 });
  });
});

describe('suggesting a model without changing anything', () => {
  const listed = ['llama3.2:latest', 'claude-sonnet-5-5-20260101', 'models/gemini-2.5-pro', 'gpt-4o', 'gpt-4o-mini'];
  it('treats aliases and prefixes as listed', () => {
    expect(suggestModel('llama3.2', listed)).toBeUndefined();
    expect(suggestModel('llama3.2:latest', listed)).toBeUndefined();
    expect(suggestModel('claude-sonnet-5-5', listed)).toBeUndefined();
    expect(suggestModel('gemini-2.5-pro', listed)).toBeUndefined();
  });
  it('suggests the closest name, not the costliest', () => {
    expect(suggestModel('gpt-4o-old', listed)).toBe('gpt-4o-mini');
    expect(suggestModel('anything', [])).toBeUndefined();
  });
  it('ranks by name similarity first and tries at most 3', () => {
    const l = ['claude-opus-9', 'claude-haiku-4', 'gpt-5', 'o3-pro'];
    const out = replacementsFor('claude-haiku-3', [], l);
    expect(out[0]).toBe('claude-haiku-4');
    expect(out).toHaveLength(3);
  });
});

describe('streaming', () => {
  it('a server that only sends keep-alive comments times out', async () => {
    let aborted = false;
    const fetchFn = (async (_u: string, init: any) => {
      let t: ReturnType<typeof setInterval>;
      const body = new ReadableStream({
        start(c) {
          t = setInterval(() => c.enqueue(enc.encode(': ping\n\n')), 10);
          init.signal.addEventListener('abort', () => {
            aborted = true;
            clearInterval(t);
            c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        },
      });
      return sse(body);
    }) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined, timeoutMs: 80 })).rejects.toMatchObject({ code: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('aborts the request when the stream ends or fails', async () => {
    let signal: AbortSignal | undefined;
    const ok = (async (_u: string, init: any) => ((signal = init.signal), sse(streamOf([`data: ${piece('hi')}\n\n`, 'data: [DONE]\n\n'])))) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn: ok, onText: () => undefined })).toBe('hi');
    expect(signal!.aborted).toBe(true);
    const bad = (async (_u: string, init: any) => ((signal = init.signal), sse(streamOf([`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`])))) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn: bad, onText: () => undefined })).rejects.toMatchObject({ code: 'server' });
    expect(signal!.aborted).toBe(true);
  });

  it('a stream cut with no [DONE] and no finish_reason is an error, not an answer', async () => {
    const cut = (async () => sse(streamOf([`data: ${piece('half an ans')}\n\n`]))) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn: cut, onText: () => undefined })).rejects.toMatchObject({ code: 'server', message: expect.stringContaining('stopped sending') });
  });

  it('a finish_reason without [DONE] is fine', async () => {
    const fin = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    const f = (async () => sse(streamOf([`data: ${piece('whole')}\n\n`, `data: ${fin}\n\n`]))) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn: f, onText: () => undefined })).toBe('whole');
  });
});

describe('cancelling', () => {
  it('stops the fetch, says Cancelled and sends no second request', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const fetchFn = (async (_u: string, init: any) => {
      calls++;
      return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }) as unknown as typeof fetch;
    const p = chat(cfg, 'k', msgs, { fetchFn, signal: ctl.signal, onText: () => undefined });
    setTimeout(() => ctl.abort(), 20);
    const e: AiError = await p.catch((x) => x);
    expect(e.message).toBe('Cancelled.');
    expect(e.code).toBe('config');
    expect(calls).toBe(1);
  });

  it('an already cancelled signal sends nothing', async () => {
    let calls = 0;
    const fetchFn = (async () => (calls++, new Response('{}'))) as unknown as typeof fetch;
    const ctl = new AbortController();
    ctl.abort();
    await expect(chat(cfg, 'k', msgs, { fetchFn, signal: ctl.signal })).rejects.toThrow('Cancelled.');
    expect(calls).toBe(0);
  });
});

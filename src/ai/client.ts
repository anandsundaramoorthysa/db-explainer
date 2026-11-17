export interface AiConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type AiErrorCode = 'config' | 'auth' | 'rate' | 'network' | 'timeout' | 'server' | 'empty' | 'model';

export class AiError extends Error {
  constructor(
    message: string,
    readonly code: AiErrorCode,
    /** The HTTP status, when the service answered. */
    readonly status?: number,
    /** Seconds the service asked us to wait (429 only). */
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

export interface AiOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Extra request headers some services want. They can never replace the content type or the key. */
  headers?: Record<string, string>;
  /** Called with the reply so far as it arrives. Without it the whole reply is waited for. */
  onText?: (soFar: string) => void;
  /** Aborts the request. The answer is then a 'Cancelled.' error and nothing is retried. */
  signal?: AbortSignal;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const CHECK_SETTINGS = 'Check the address and model in "DB Explainer: Manage AI Keys".';

const cancelled = (): AiError => new AiError('Cancelled.', 'config');

/** The service's own words saying the model is missing or retired, and not a complaint about a parameter or a limit. */
const MODEL_GONE = /model[^\n]{0,80}(not[ _]found|does not exist|doesn't exist|unknown|invalid model|decommission|deprecat|retired|no longer (available|supported))|(not[ _]found|does not exist|doesn't exist|unknown|invalid model|decommission|deprecat|retired|no longer (available|supported))[^\n]{0,80}model/i;
const NOT_MODEL = /max_tokens|max_completion_tokens|token|context length|context window|temperature|unsupported parameter|not supported with this model/i;

export function modelIsGone(status: number | undefined, serviceText: string): boolean {
  return status === 404 || ((status === 400 || status === 410) && MODEL_GONE.test(serviceText) && !NOT_MODEL.test(serviceText));
}

export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(raw: string, hasKey: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AiError('The AI base URL is not a valid URL. Fix the setting dbExplainer.ai.baseUrl.', 'config');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AiError('The AI base URL must start with https:// or http://.', 'config');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname) && hasKey) {
    throw new AiError('Your API key would be sent without encryption. Use an https:// URL, or a local server such as http://localhost.', 'config');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function headers(key: string | undefined, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra, 'content-type': 'application/json' };
  if (key) {
    h.authorization = `Bearer ${key}`;
    // Anthropic's own endpoints read the key from this header instead.
    if (extra && 'anthropic-version' in extra) h['x-api-key'] = key;
  }
  return h;
}

/** Sends the request and reads the reply while the timeout is still running, so a body that stalls cannot hang for ever. */
async function send<T>(url: string, init: RequestInit, opts: AiOptions, read: (res: Response, stillAlive: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const wait = opts.timeoutMs ?? 60000;
  let timer = setTimeout(() => controller.abort(), wait);
  const onAbort = (): void => controller.abort();
  if (opts.signal?.aborted) throw cancelled();
  opts.signal?.addEventListener('abort', onAbort);
  // A streamed reply may take a long time overall, so its limit counts from the last text received.
  const stillAlive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), wait);
  };
  try {
    const res = await (opts.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new AiError('The AI service rejected your API key. Replace it with "DB Explainer: Change API Key".', 'auth', res.status);
    if (res.status === 429) {
      // Retry-After may also be a date, which would read badly in "try again in N seconds".
      const raw = res.headers.get('retry-after') ?? '';
      const wait = /^\d+$/.test(raw) ? raw : undefined;
      throw new AiError(`The AI service is rate limiting you${wait ? `. Try again in ${wait} seconds` : ''}.`, 'rate', 429, wait);
    }
    if (res.status >= 500) throw new AiError(`The AI service had a problem (status ${res.status}). Try again later.`, 'server', res.status);
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
      throw new AiError(`The AI service returned status ${res.status}. ${CHECK_SETTINGS}${detail ? ' ' + detail : ''}`, 'config', res.status);
    }
    return await read(res, stillAlive);
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled();
    if (e instanceof AiError) throw e;
    if ((e as Error)?.name === 'AbortError') throw new AiError('The AI service took too long to answer.', 'timeout');
    throw new AiError('Could not reach the AI service. Check your connection and the base URL.', 'network');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // Releases the connection, so a server still writing stops.
    controller.abort();
  }
}

function plainText(content: unknown): unknown {
  return Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : content;
}

/** Reads a streamed reply: lines of "data: {json}", ending with "data: [DONE]". */
async function readStream(res: Response, stillAlive: () => void, onText: (soFar: string) => void): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  // A stream cut by a proxy ends with neither of these.
  let finished = false;
  const line = (raw: string): void => {
    const data = raw.trim().replace(/^data:\s*/, '');
    if (!raw.trim().startsWith('data:')) return;
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // A keep-alive or a partial line from an unusual server. Whatever follows still counts.
    }
    if (json?.error) throw new AiError(`The AI service reported a problem: ${String(json.error.message ?? json.error).slice(0, 200)}`, 'server');
    if (json?.choices?.[0]?.finish_reason) finished = true;
    const delta = json?.choices?.[0]?.delta;
    // A reasoning model may think for a long while before the answer starts. That is progress, but not part of the answer.
    for (const thought of [delta?.reasoning_content, delta?.reasoning]) if (typeof thought === 'string' && thought) stillAlive();
    const piece = plainText(delta?.content);
    if (typeof piece === 'string' && piece) {
      stillAlive();
      text += piece;
      onText(text);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(line);
  }
  if (pending) line(pending);
  if (!finished) throw new AiError('The AI service stopped sending in the middle of the answer. Try again.', 'server');
  return text;
}

export async function chat(cfg: AiConfig, key: string | undefined, messages: ChatMessage[], opts: AiOptions = {}): Promise<string> {
  if (!cfg.model.trim()) throw new AiError('Choose a model first in "DB Explainer: Manage AI Keys".', 'config');
  const base = normalizeBaseUrl(cfg.baseUrl, !!key);
  const onText = opts.onText;
  const body = { model: cfg.model.trim(), messages, [cfg.maxTokensParam]: cfg.maxTokens, ...(onText ? { stream: true } : {}) };
  let result: { streamed: string } | { json: any };
  try {
    result = await send(`${base}/chat/completions`, { method: 'POST', headers: headers(key, opts.headers), body: JSON.stringify(body) }, opts, async (res, stillAlive) => {
      // A service may ignore the request to stream, so go by what actually came back.
      if (onText && res.body && /event-stream/i.test(res.headers.get('content-type') ?? '')) return { streamed: await readStream(res, stillAlive, onText) };
      try {
        return { json: await res.json() };
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        throw new AiError('The AI service sent a reply that could not be read.', 'server');
      }
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if (e instanceof AiError && e.code === 'config' && e.status === 400 && onText && /stream/i.test(e.message)) return chat(cfg, key, messages, { ...opts, onText: undefined });
    // Only the service's own words count here: our advice in the same message also says "model".
    if (e instanceof AiError && e.code === 'config' && modelIsGone(e.status, e.message.replace(CHECK_SETTINGS, ''))) {
      throw new AiError(`The AI service cannot find the model "${cfg.model.trim()}". It may have been retired, or the address may be wrong.`, 'model', e.status);
    }
    throw e;
  }
  const text = 'streamed' in result ? result.streamed : plainText(result.json?.choices?.[0]?.message?.content);
  if (typeof text !== 'string' || !text.trim()) throw new AiError('The AI service returned an empty answer.', 'empty');
  return text.trim();
}

export async function listModels(cfg: Pick<AiConfig, 'baseUrl'>, key: string | undefined, opts: AiOptions = {}): Promise<string[]> {
  const base = normalizeBaseUrl(cfg.baseUrl, !!key);
  const json: any = await send(`${base}/models`, { method: 'GET', headers: headers(key, opts.headers) }, opts, (res) => res.json().catch((e) => ((e as Error)?.name === 'AbortError' ? Promise.reject(e) : {})));
  const data: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return data.map((m) => String(m?.id ?? m?.name ?? '')).filter(Boolean);
}

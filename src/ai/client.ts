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

export type AiErrorCode = 'config' | 'auth' | 'rate' | 'network' | 'timeout' | 'server' | 'empty';

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
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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
async function send<T>(url: string, init: RequestInit, opts: AiOptions, read: (res: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await (opts.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new AiError('The AI service rejected your API key. Set it again with "DB Explainer: AI: Set API Key".', 'auth', res.status);
    if (res.status === 429) {
      // Retry-After may also be a date, which would read badly in "try again in N seconds".
      const raw = res.headers.get('retry-after') ?? '';
      const wait = /^\d+$/.test(raw) ? raw : undefined;
      throw new AiError(`The AI service is rate limiting you${wait ? `. Try again in ${wait} seconds` : ''}.`, 'rate', 429, wait);
    }
    if (res.status >= 500) throw new AiError(`The AI service had a problem (status ${res.status}). Try again later.`, 'server', res.status);
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
      throw new AiError(`The AI service returned status ${res.status}. Check the base URL and model name in settings.${detail ? ' ' + detail : ''}`, 'config');
    }
    return await read(res);
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error)?.name === 'AbortError') throw new AiError('The AI service took too long to answer.', 'timeout');
    throw new AiError('Could not reach the AI service. Check your connection and the base URL.', 'network');
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(cfg: AiConfig, key: string | undefined, messages: ChatMessage[], opts: AiOptions = {}): Promise<string> {
  if (!cfg.model.trim()) throw new AiError('Choose a model first: set dbExplainer.ai.model in settings.', 'config');
  const base = normalizeBaseUrl(cfg.baseUrl, !!key);
  const body = { model: cfg.model.trim(), messages, [cfg.maxTokensParam]: cfg.maxTokens };
  const json: any = await send(`${base}/chat/completions`, { method: 'POST', headers: headers(key, opts.headers), body: JSON.stringify(body) }, opts, async (res) => {
    try {
      return await res.json();
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new AiError('The AI service sent a reply that could not be read.', 'server');
    }
  });
  const content = json?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : content;
  if (typeof text !== 'string' || !text.trim()) throw new AiError('The AI service returned an empty answer.', 'empty');
  return text.trim();
}

export async function listModels(cfg: Pick<AiConfig, 'baseUrl'>, key: string | undefined, opts: AiOptions = {}): Promise<string[]> {
  const base = normalizeBaseUrl(cfg.baseUrl, !!key);
  const json: any = await send(`${base}/models`, { method: 'GET', headers: headers(key, opts.headers) }, opts, (res) => res.json().catch((e) => ((e as Error)?.name === 'AbortError' ? Promise.reject(e) : {})));
  const data: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return data.map((m) => String(m?.id ?? m?.name ?? '')).filter(Boolean);
}

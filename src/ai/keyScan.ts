import { Provider } from './profiles';

// A key is not part of a longer word, but "key_sk-..." still counts.
const START = '(?<![A-Za-z0-9])';

/** Key shapes that are specific enough to trust anywhere in a message. Order matters: the generic sk- comes last. */
const KNOWN: { provider: Provider; re: RegExp }[] = [
  { provider: 'claude', re: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}`) },
  { provider: 'openrouter', re: new RegExp(`${START}sk-or-[A-Za-z0-9_-]{20,}`) },
  { provider: 'groq', re: new RegExp(`${START}gsk_[A-Za-z0-9]{20,}`) },
  { provider: 'gemini', re: new RegExp(`${START}AIza[0-9A-Za-z_-]{30,}`) },
  { provider: 'openai', re: new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`) },
];

const MIXED = (t: string): boolean => /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t);

const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const BEARER = /\bbearer\s+([A-Za-z0-9._~+/=_-]{20,})/i;
const ASSIGNED = /\b(?:api[_-]?key|apikey|secret|token|password|authorization)\s*[:=]\s*["']?([A-Za-z0-9._~+/=_-]{24,})/i;

/**
 * Shapes that are not tied to one provider but are still clearly credentials: a JSON web token (three dotted segments, the first
 * starting eyJ), anything given as a bearer token, and a value assigned to a name such as api_key or token. A dotted table name
 * (dbo.CustomerOrderItems2024) matches none of these.
 */
function genericKey(text: string): string | undefined {
  const jwt = JWT.exec(text);
  if (jwt) return jwt[0];
  const bearer = BEARER.exec(text);
  if (bearer) return bearer[1];
  const assigned = ASSIGNED.exec(text);
  if (assigned && MIXED(assigned[1])) return assigned[1];
  return undefined;
}

/**
 * Decides whether a message contains an API key. A key of a known shape is caught anywhere, and so are JWTs, bearer tokens and
 * api_key=... assignments. Beyond that, a message that is nothing but one long token with upper case, lower case and digits is
 * treated as a key too. Random keys have all three and identifiers (customer_order_items_2024) and hashes (plain hex) do not.
 */
export function detectApiKey(text: string): { key: string; provider?: Provider } | undefined {
  for (const { provider, re } of KNOWN) {
    const m = re.exec(text);
    if (m) return { key: m[0], provider };
  }
  const generic = genericKey(text);
  if (generic) return { key: generic };
  const bare = text.trim().replace(/^bearer\s+/i, '');
  if (/^[A-Za-z0-9_-]{30,}$/.test(bare) && MIXED(bare)) return { key: bare };
  return undefined;
}

/** Why a typed key cannot be used, or undefined. A header value outside plain ASCII makes every request fail with a misleading error. */
export function keyProblem(key: string): string | undefined {
  if (/\s/.test(key)) return 'A key cannot contain spaces or line breaks.';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'A key can only contain plain letters, digits and symbols. Check that you copied the right text.';
  return undefined;
}

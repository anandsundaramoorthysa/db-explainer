import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AiError, chat } from '../src/ai/client';
import { AddressChoice, addKeysToProfile, saveProfileForm, splitKeys } from '../src/ai/profileForm';
import { keysOf, Memento, PRIMARY_KEY, Profile, ProfileStore, Secrets } from '../src/ai/profiles';
import { AiService } from '../src/ai/service';
import { Conversation, describeQuery, Source } from '../src/chat/conversation';
import { Connector } from '../src/db/connector';
import { parseConnectionString, splitHostPort } from '../src/db/connectionString';
import { resolveNotesFile } from '../src/notes';
import { SchemaModel } from '../src/types';

const KEY_A = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'gsk_BBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_C = 'gsk_CCCCCCCCCCCCCCCCCCCCCCCC';
const groq: Profile = { id: 'g', label: 'work', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
const cfg = { baseUrl: 'https://api.example.com/v1', model: 'm', maxTokens: 10, maxTokensParam: 'max_tokens' as const };
const msgs = [{ role: 'user' as const, content: 'hi' }];

function stores() {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: Memento = { get: (k, d) => (state.has(k) ? (state.get(k) as any) : d), update: async (k, v) => void state.set(k, v) };
  const sec: Secrets = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  return { store: new ProfileStore(memento, sec), secrets };
}

function sse(lines: string[]): Response {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const piece = (t: string): string => JSON.stringify({ choices: [{ delta: { content: t } }] });

describe('streaming', () => {
  it('reports the reply as it arrives and asks the service to stream', async () => {
    const seen: string[] = [];
    let sent: any;
    const fetchFn = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return sse([piece('Hel'), piece('lo'), '[DONE]']);
    }) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: (t) => seen.push(t) })).toBe('Hello');
    expect(seen).toEqual(['Hel', 'Hello']);
    expect(sent.stream).toBe(true);
  });

  it('copes with a chunk split in the middle of a line', async () => {
    const whole = `data: ${piece('split')}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(whole.slice(0, 20)));
        c.enqueue(new TextEncoder().encode(whole.slice(20)));
        c.close();
      },
    });
    const fetchFn = (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined })).toBe('split');
  });

  it('still works when the service ignores the request to stream', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined })).toBe('whole');
  });

  it('does not ask to stream unless someone is listening', async () => {
    let sent: any;
    const fetchFn = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chat(cfg, 'k', msgs, { fetchFn });
    expect(sent.stream).toBeUndefined();
  });

  it('tries again without streaming if the service refuses it', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      return b.stream ? new Response('stream is not supported', { status: 400 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined })).toBe('ok');
    expect(bodies.map((b) => !!b.stream)).toEqual([true, false]);
  });

  it('reports an error sent in the middle of a stream', async () => {
    const fetchFn = (async () => sse([piece('Hi'), JSON.stringify({ error: { message: 'overloaded' } })])) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn, onText: () => undefined })).rejects.toThrow(/overloaded/);
  });

  it('a slow reply survives past the limit as long as text keeps coming, and a stalled one stops', async () => {
    const encoder = new TextEncoder();
    const slow = new ReadableStream({
      async start(c) {
        for (const t of ['a', 'b', 'c', 'd']) {
          c.enqueue(encoder.encode(`data: ${piece(t)}\n\n`));
          await new Promise((r) => setTimeout(r, 40));
        }
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const ok = (async () => new Response(slow, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    expect(await chat(cfg, 'k', msgs, { fetchFn: ok, onText: () => undefined, timeoutMs: 100 })).toBe('abcd');

    const stalled = (async (_u: string, init: any) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(`data: ${piece('x')}\n\n`));
          init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    await expect(chat(cfg, 'k', msgs, { fetchFn: stalled, onText: () => undefined, timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('a model that no longer exists', () => {
  const service = (store: ProfileStore, status: number, body = '') =>
    new AiService({
      store,
      legacy: () => ({ ...cfg, baseUrl: 'http://localhost:1/v1' }),
      legacyKey: async () => undefined,
      fallback: () => false,
      allowHost: async () => undefined,
      notice: () => undefined,
      fetchFn: (async () => new Response(body, { status })) as unknown as typeof fetch,
    });

  it('tries the other saved models first, and only then says no model answered', async () => {
    const { store } = stores();
    await store.save({ ...groq, models: ['llama', 'llama-2'] }, KEY_A);
    await expect(service(store, 404).chat(msgs)).rejects.toMatchObject({ code: 'model', message: expect.stringMatching(/cannot find the model "llama".*No other model it offers answered either/) });
  });

  it('recognises a 400 that names the model, but not any other 400', async () => {
    const { store } = stores();
    await store.save(groq, KEY_A);
    await expect(service(store, 400, 'model_not_found').chat(msgs)).rejects.toMatchObject({ code: 'model' });
    await expect(service(store, 400, 'bad request').chat(msgs)).rejects.toMatchObject({ code: 'config' });
  });

  it('never uses the old wording for errors', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const e: AiError = await chat(cfg, 'k', msgs, { fetchFn }).catch((x) => x);
    expect(e.message).toContain('Change API Key');
    expect(e.message).not.toContain('Set API Key');
  });
});

describe('saving the form', () => {
  const never = async (): Promise<AddressChoice> => {
    throw new Error('should not be asked');
  };
  const form = { provider: 'groq' as const, label: 'work', baseUrl: groq.baseUrl, model: 'llama' };

  it('splits keys on spaces, commas and line breaks and drops repeats', () => {
    expect(splitKeys(`${KEY_A}, ${KEY_B}\n${KEY_C} ${KEY_A}`)).toEqual([KEY_A, KEY_B, KEY_C]);
    expect(splitKeys(undefined)).toEqual([]);
  });

  it('saves several pasted keys in one go, the first in its usual place', async () => {
    const { store, secrets } = stores();
    const r = await saveProfileForm(store, { ...form, key: `${KEY_A} ${KEY_B}\n${KEY_C}` }, { confirmAddress: never });
    expect('id' in r).toBe(true);
    const p = store.list()[0];
    expect(keysOf(p)).toHaveLength(3);
    expect(await store.key(p.id)).toBe(KEY_A);
    expect(secrets.size).toBe(3);
    expect(JSON.stringify(p)).not.toContain('gsk_');
  });

  it('keeps the other keys and models when the first key is edited', async () => {
    const { store } = stores();
    await store.save({ ...groq, models: ['llama', 'llama-2'] }, KEY_A);
    const k2 = (await store.addKey('g', KEY_B))!;
    await saveProfileForm(store, { ...form, id: 'g', key: KEY_C }, { confirmAddress: never });
    const p = store.get('g')!;
    expect(await store.key('g')).toBe(KEY_C);
    expect(await store.key('g', k2)).toBe(KEY_B);
    expect(p.models).toContain('llama-2');
  });

  it('does not ask when the address stays on the same host', async () => {
    const { store } = stores();
    await store.save(groq, KEY_A);
    const r = await saveProfileForm(store, { ...form, id: 'g', baseUrl: 'https://api.groq.com/openai/v2' }, { confirmAddress: never });
    expect('id' in r).toBe(true);
  });

  describe('when the address moves to another host', () => {
    const moved = { ...form, id: 'g', baseUrl: 'https://other.example.com/v1' };
    async function two() {
      const s = stores();
      await s.store.save(groq, KEY_A);
      await s.store.addKey('g', KEY_B);
      return s;
    }

    it('changes nothing if the developer backs out', async () => {
      const { store } = await two();
      const r = await saveProfileForm(store, moved, { confirmAddress: async () => undefined });
      expect('error' in r).toBe(true);
      expect(store.get('g')!.baseUrl).toBe(groq.baseUrl);
    });

    it('names the host and counts the keys, and keeps them when told to', async () => {
      const { store } = await two();
      const asked: [string, number][] = [];
      await saveProfileForm(store, moved, {
        confirmAddress: async (h, n) => {
          asked.push([h, n]);
          return 'keep';
        },
      });
      expect(asked).toEqual([['other.example.com', 2]]);
      expect(store.get('g')!.baseUrl).toBe(moved.baseUrl);
      expect(keysOf(store.get('g')!)).toHaveLength(2);
    });

    it('removes them when told to, leaving none to send', async () => {
      const { store, secrets } = await two();
      await saveProfileForm(store, moved, { confirmAddress: async () => 'remove' });
      expect(secrets.size).toBe(0);
      expect(keysOf(store.get('g')!)).toEqual([{ id: PRIMARY_KEY }]);
    });

    it('does not count a key that is being replaced, and keeps the new one when the rest are removed', async () => {
      const { store } = await two();
      const asked: number[] = [];
      await saveProfileForm(store, { ...moved, key: KEY_C }, {
        confirmAddress: async (_h, n) => {
          asked.push(n);
          return 'remove';
        },
      });
      expect(asked).toEqual([1]);
      expect(await store.key('g')).toBe(KEY_C);
      expect(keysOf(store.get('g')!)).toHaveLength(1);
    });

    it('does not ask for a profile with no saved keys', async () => {
      const { store } = stores();
      await store.save({ id: 'l', label: 'local', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'q' });
      const r = await saveProfileForm(store, { id: 'l', provider: 'ollama', baseUrl: 'http://127.0.0.1:1234/v1', model: 'q' }, { confirmAddress: never });
      expect('id' in r).toBe(true);
    });
  });

  it('adds nothing at all if one pasted key is unusable', async () => {
    const { store } = stores();
    await store.save(groq, KEY_A);
    const r = await addKeysToProfile(store, 'g', `${KEY_B} bad\u00e9key`);
    expect(r.error).toBeTruthy();
    expect(keysOf(store.get('g')!)).toHaveLength(1);
  });

  it('skips keys already saved, and fills an empty first slot first', async () => {
    const { store } = stores();
    await store.save(groq);
    const r = await addKeysToProfile(store, 'g', `${KEY_A} ${KEY_B}`);
    expect(r.added[0]).toBe(PRIMARY_KEY);
    expect(await store.key('g')).toBe(KEY_A);
    const again = await addKeysToProfile(store, 'g', KEY_B);
    expect(again).toEqual({ added: [], duplicates: 1 });
  });

  it('gives keys added together the same expiry date', async () => {
    const { store } = stores();
    await store.save(groq, KEY_A);
    await addKeysToProfile(store, 'g', `${KEY_B} ${KEY_C}`, '2027-01-01');
    expect(store.get('g')!.extraKeys!.map((k) => k.expiresAt)).toEqual(['2027-01-01', '2027-01-01']);
  });
});

describe('the notes path', () => {
  const win = path.win32;
  const posix = path.posix;

  it('allows a path inside the workspace', () => {
    expect(resolveNotesFile('C:\\proj', '.dbexplainer\\notes.md', win)).toBe('C:\\proj\\.dbexplainer\\notes.md');
    expect(resolveNotesFile('/proj', '.dbexplainer/notes.md', posix)).toBe('/proj/.dbexplainer/notes.md');
    expect(resolveNotesFile('/proj', '..notes/a.md', posix)).toBe('/proj/..notes/a.md');
  });

  it('refuses a neighbouring folder whose name starts the same', () => {
    expect(resolveNotesFile('C:\\proj', '..\\proj-other\\notes.md', win)).toBeUndefined();
    expect(resolveNotesFile('/proj', '../proj-other/notes.md', posix)).toBeUndefined();
  });

  it('refuses the parent, another drive, an absolute path and the folder itself', () => {
    expect(resolveNotesFile('/proj', '../notes.md', posix)).toBeUndefined();
    expect(resolveNotesFile('C:\\proj', 'D:\\notes.md', win)).toBeUndefined();
    expect(resolveNotesFile('/proj', '/etc/passwd', posix)).toBeUndefined();
    expect(resolveNotesFile('/proj', '.', posix)).toBeUndefined();
  });
});

describe('connection strings', () => {
  it('reads every part, including an encoded password', () => {
    expect(parseConnectionString('postgres://me:p%40ss@db.example.com:5433/shop?sslmode=require')).toEqual({ engine: 'postgres', host: 'db.example.com', port: 5433, database: 'shop', user: 'me', password: 'p@ss', ssl: true });
  });

  it.each([
    ['postgresql://u@h/d', 'postgres', 5432],
    ['mysql://u@h/d', 'mysql', 3306],
    ['mariadb://u@h/d', 'mysql', 3306],
    ['sqlserver://u@h/d', 'mssql', 1433],
    ['mssql://u@h/d', 'mssql', 1433],
    ['jdbc:postgresql://u@h/d', 'postgres', 5432],
  ])('%s uses the usual port', (s, engine, port) => {
    expect(parseConnectionString(s)).toMatchObject({ engine, port });
  });

  it('reads the encryption setting, and leaves it out when not given', () => {
    expect(parseConnectionString('postgres://u@h/d?sslmode=disable')).toMatchObject({ ssl: false });
    expect(parseConnectionString('mysql://u@h/d?ssl=true')).toMatchObject({ ssl: true });
    expect(parseConnectionString('mssql://u@h/d?encrypt=false')).toMatchObject({ ssl: false });
    expect(parseConnectionString('mysql://u@h/d')).not.toHaveProperty('ssl');
  });

  it('explains what is wrong, without repeating the password', () => {
    expect(parseConnectionString('not a url')).toEqual(expect.any(String));
    expect(parseConnectionString('postgres://u:secret@h')).toEqual('The connection string has no database name.');
    expect(parseConnectionString('oracle://u:secret@h/d')).not.toContain('secret');
    expect(parseConnectionString('postgres://u:%zz@h/d')).toEqual(expect.stringContaining('badly encoded'));
  });

  it('splits a host and an optional port', () => {
    expect(splitHostPort('db.example.com', 5432)).toEqual({ host: 'db.example.com', port: 5432 });
    expect(splitHostPort('db.example.com:6000', 5432)).toEqual({ host: 'db.example.com', port: 6000 });
    expect(splitHostPort('', 5432)).toBeUndefined();
    expect(splitHostPort('h:70000', 5432)).toBeUndefined();
  });
});

describe('checking a query on SQL Server', () => {
  const model: SchemaModel = { engine: 'mssql', name: 'db', source: 'live', tables: [], routines: [], capturedAt: '', warnings: [] };
  function setup(fail?: string) {
    const seen: { sql: string; maxRows: number }[] = [];
    const connector: Connector = {
      engine: 'mssql',
      introspect: async () => model,
      close: async () => undefined,
      query: async (sql, limits) => {
        seen.push({ sql, maxRows: limits.maxRows });
        if (fail) throw new Error(fail);
        return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
      },
    };
    const replies: string[] = [];
    const convo = new Conversation({
      ai: async (m) => {
        replies.push(m[m.length - 1].content);
        return 'Here:\n```sql\nSELECT name FROM customers WHERE country = \'India\'\n```';
      },
      notes: () => '',
      limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
      maxTables: () => 12,
      sampleRows: () => 5,
    });
    const source: Source = { id: 's', label: 's', model, connector };
    return { seen, replies, convo, source };
  }

  it('escapes the query as a text value', () => {
    expect(describeQuery("SELECT 'a'")).toBe("EXEC sp_describe_first_result_set @tsql = N'SELECT ''a'''");
  });

  it('describes the query instead of running it, with room for one row per column', async () => {
    const t = setup();
    await t.convo.ask(t.source, 'customers in India');
    expect(t.seen.length).toBeGreaterThan(0);
    for (const s of t.seen) {
      expect(s.sql.startsWith('EXEC sp_describe_first_result_set @tsql = N')).toBe(true);
      expect(s.maxRows).toBe(1000);
    }
  });

  it('asks the AI to fix a query the database refuses, and warns if it stays refused', async () => {
    const t = setup("Invalid column name 'country'.");
    const a = await t.convo.ask(t.source, 'customers in India');
    expect(t.replies.some((r) => r.includes("Invalid column name 'country'"))).toBe(true);
    expect(a.text).toContain("Invalid column name 'country'");
  });

  it('stays quiet when SQL Server only cannot describe a valid query', async () => {
    const t = setup('The metadata could not be determined because statement uses a temp table.');
    const a = await t.convo.ask(t.source, 'customers in India');
    expect(a.text).not.toContain('could not be determined');
    expect(t.replies.some((r) => r.includes('could not be determined'))).toBe(false);
  });
});

describe('showing a reply while it is written', () => {
  const model: SchemaModel = { engine: 'sqlite', name: 'db', source: 'file' as any, tables: [], routines: [], capturedAt: '', warnings: [] };

  it('sends the draft, then says it is checking, and still returns the checked answer', async () => {
    const events: string[] = [];
    const convo = new Conversation({
      ai: async (_m, onText) => {
        onText?.('par');
        onText?.('partial');
        return 'partial answer';
      },
      notes: () => '',
      limits: () => ({ maxRows: 100, timeoutMs: 10000 }),
      maxTables: () => 12,
      sampleRows: () => 5,
    });
    const a = await convo.ask({ id: 's', label: 's', model }, 'what is here?', undefined, { draft: (t) => events.push(`draft:${t}`), checking: () => events.push('checking') });
    expect(events).toEqual(['draft:par', 'draft:partial', 'checking']);
    expect(a.text).toBe('partial answer');
  });
});

// Drives media/keys.js (the Manage AI Keys page) in a real browser with a stand-in for the VS Code webview API and the same kind of
// content security policy. Run with: node test/ui/keys.js   (uses Microsoft Edge or Chrome if installed)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const media = path.resolve(__dirname, '..', '..', 'media');

const page_html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>${fs.readFileSync(path.join(media, 'chat.css'), 'utf8')}${fs.readFileSync(path.join(media, 'keys.css'), 'utf8')}</style></head>
<body class="keys"><header><h1>AI keys</h1><label class="check"><input type="checkbox" id="fallback"> Fall back</label><button id="add">Add profile</button></header>
<div id="banner" class="banner" hidden></div><main id="list"></main>
<script>window.__sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__sent.push(m) });</script>
<script>${fs.readFileSync(path.join(media, 'keys.js'), 'utf8')}</script></body></html>`;

const presets = [
  { provider: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  { provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { provider: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5-coder:7b'] },
];
const prof = (id, extra) => ({ id, label: id, provider: 'groq', providerName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], expiresAt: '', expiryText: 'No expiry date', status: 'active', keyMask: '••••••••WXYZ', hasKey: true, local: false, inUse: false, ...extra });

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // try the next one
    }
  }
  throw new Error('No Edge or Chrome found for the UI test');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 800 } });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.setContent(page_html);
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m);
  const sent = () => page.evaluate(() => window.__sent);
  const settle = () => page.waitForTimeout(80);

  assert.deepStrictEqual((await sent())[0], { type: 'ready' });

  // Nothing set up yet, but the old settings are still in use: say so.
  await send({ type: 'state', profiles: [], presets, fallback: false, legacy: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' } });
  await settle();
  assert.ok(/dbExplainer\.ai\.\* settings/.test(await page.textContent('#banner')));
  assert.ok(/No profiles yet/.test(await page.textContent('#list')));

  // Three profiles: one in use, one expiring, one expired.
  await send({
    type: 'state', presets, fallback: true,
    profiles: [
      prof('Work', { inUse: true, expiresAt: '2027-01-01', expiryText: 'Expires in 60 days (2027-01-01)' }),
      prof('Soon', { status: 'expiring', expiresAt: '2026-11-09', expiryText: 'Expires in 2 days (2026-11-09)' }),
      prof('Old', { status: 'expired', expiresAt: '2026-10-01', expiryText: 'Expired on 2026-10-01' }),
    ],
  });
  await settle();
  assert.strictEqual(await page.locator('section.card').count(), 3);
  assert.ok(await page.isChecked('#fallback'));
  const texts = await page.locator('.pill').allTextContents();
  assert.deepStrictEqual(texts, ['Active', 'Expiring soon', 'Expired'], 'a status word, not only a colour');
  assert.strictEqual(await page.locator('.badge').count(), 1);

  // The page only ever shows the masked key.
  const body = await page.textContent('body');
  assert.ok(body.includes('••••••••WXYZ'));
  assert.ok(!/gsk_|sk-/.test(body), 'no key text anywhere on the page');

  // The model field is editable and also offers a list; changing it is sent.
  const model = page.locator('section.card').first().locator('input[list]');
  assert.strictEqual(await page.locator('datalist#models-Work option').count(), 2);
  await model.fill('my-custom-model');
  await model.dispatchEvent('change');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'setModel', id: 'Work', model: 'my-custom-model' });

  // Test connection and its result line.
  await page.locator('section.card').first().locator('button:has-text("Test connection")').click();
  assert.deepStrictEqual((await sent()).at(-1), { type: 'test', id: 'Work' });
  await send({ type: 'testResult', id: 'Work', ok: false, text: 'Groq "Work" rejected the API key (401).' });
  await settle();
  assert.ok(/rejected the API key/.test(await page.textContent('#test-Work')));
  assert.ok(await page.locator('#test-Work.bad').count());

  // Use this profile works on a valid profile, is off for the one in use and for an expired one.
  const soon = page.locator('section.card').nth(1);
  await soon.locator('button:has-text("Use this profile")').click();
  assert.deepStrictEqual((await sent()).at(-1), { type: 'activate', id: 'Soon' });
  assert.ok(await page.locator('section.card').first().locator('button:has-text("Use this profile")').isDisabled());
  const old = page.locator('section.card').nth(2);
  assert.ok(await old.locator('button:has-text("Use this profile")').isDisabled());
  assert.ok(await old.locator('button:has-text("Test connection")').isDisabled());
  // Change key is the way back for an expired key, so it stays enabled there and sends the profile id.
  assert.ok(await old.locator('button:has-text("Change key")').isEnabled());
  await old.locator('button:has-text("Change key")').click();
  assert.deepStrictEqual((await sent()).at(-1), { type: 'changeKey', id: 'Old' });
  assert.strictEqual(await page.locator('button:has-text("Change key")').count(), 3, 'every card has one');
  await old.locator('button:has-text("Delete")').click();
  assert.deepStrictEqual((await sent()).at(-1), { type: 'delete', id: 'Old' });

  // The fallback switch is sent.
  await page.uncheck('#fallback');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'setFallback', on: false });

  // Add: the provider fills the address and model, the key field is a password box, and the typed key is cleared after Save.
  await page.click('#add');
  assert.strictEqual(await page.getAttribute('input[type=password]', 'type'), 'password');
  assert.strictEqual(await page.locator('form select').inputValue(), 'groq');
  await page.selectOption('form select', 'openai');
  const fields = page.locator('form input'); // key, model, then label, address, date inside Advanced
  assert.ok(!(await page.locator('form details').evaluate((d) => d.open)), 'Advanced is closed for a preset');
  await page.click('form summary');
  assert.strictEqual(await fields.nth(3).inputValue(), 'https://api.openai.com/v1', 'address follows the provider');
  assert.strictEqual(await fields.nth(1).inputValue(), 'gpt-4o-mini', 'model follows the provider');
  await fields.nth(2).fill('Home');
  await page.fill('input[type=password]', 'sk-live-SECRET-1234567890');
  await page.fill('input[type=date]', '2027-02-03');
  await page.click('form button[type=submit]');
  const saved = (await sent()).at(-1);
  assert.deepStrictEqual({ ...saved, key: undefined }, { type: 'save', id: undefined, provider: 'openai', label: 'Home', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', expiresAt: '2027-02-03', key: undefined });
  assert.strictEqual(saved.key, 'sk-live-SECRET-1234567890');
  assert.strictEqual(await page.inputValue('input[type=password]'), 'sk-live-SECRET-1234567890', 'the key stays until the host accepts it');
  await send({ type: 'formError', text: 'The expiry date must be a real date.' });
  await settle();
  assert.ok(/real date/.test(await page.textContent('.formerror')));
  assert.strictEqual(await page.inputValue('input[type=password]'), 'sk-live-SECRET-1234567890', 'a form error does not wipe the key');
  await send({ type: 'saved' });
  await settle();
  assert.strictEqual(await page.locator('form').count(), 0);
  assert.ok(/Saved/.test(await page.textContent('[role=status].sr-only')));

  // A key pasted in the chat is waiting on the host: the page knows it exists but never has it.
  await send({ type: 'state', presets, fallback: false, profiles: [], pendingKey: { provider: 'groq' } });
  await send({ type: 'startAdd', provider: 'groq' });
  await settle();
  assert.ok(/pasted in the chat/.test(await page.textContent('#banner')));
  assert.ok(/Using the key you pasted/.test(await page.getAttribute('input[type=password]', 'placeholder')));
  assert.strictEqual(await page.inputValue('input[type=password]'), '');
  await page.click('#banner button:has-text("Discard")');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'discardPending' });

  // Editing keeps the saved key unless a new one is typed.
  await send({ type: 'state', presets, fallback: false, profiles: [prof('Work', { inUse: true })] });
  await settle();
  await page.click('button:has-text("Edit")');
  assert.ok(/Leave empty to keep/.test(await page.getAttribute('input[type=password]', 'placeholder')));

  // A label with markup in it is shown as text, not run.
  await send({ type: 'state', presets, fallback: false, profiles: [prof('x', { label: '<img src=x onerror="window.__pwned=1">' })] });
  await settle();
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
  assert.ok((await page.textContent('.card .label')).includes('<img'));

  // Narrow width.
  await page.setViewportSize({ width: 320, height: 700 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scrolling at 320px');

  assert.deepStrictEqual(problems, [], 'no console errors or CSP violations');
  await browser.close();
  console.log('keys page checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

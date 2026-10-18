// Drives media/chat.js in a real browser with a stand-in for the VS Code webview API and the same kind of
// content security policy. Run with: node test/ui/panel.js   (uses Microsoft Edge or Chrome if installed)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const media = path.resolve(__dirname, '..', '..', 'media');

const page_html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>${fs.readFileSync(path.join(media, 'chat.css'), 'utf8')}</style></head><body>
<header><label for="source">Database</label><select id="source"></select><button id="clear">New chat</button></header>
<div id="banner" class="banner" hidden></div><main id="log"></main><div id="thinking" class="thinking" hidden>Thinking...</div>
<form id="form"><textarea id="input" rows="2"></textarea><button id="send" type="submit">Send</button></form>
<script>window.__sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__sent.push(m) });</script>
<script>${fs.readFileSync(path.join(media, 'chat.js'), 'utf8')}</script></body></html>`;

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
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.setContent(page_html);
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m);
  const sent = () => page.evaluate(() => window.__sent);
  const settle = () => page.waitForTimeout(80);

  assert.deepStrictEqual((await sent())[0], { type: 'ready' });
  assert.ok(/Hi, I'm Dex/.test(await page.textContent('.welcome')), 'welcome message from Dex');
  assert.strictEqual(await page.locator('.welcome svg').count(), 1);

  // With nothing shared, the banner explains what to do.
  await send({ type: 'state', sources: [], activeId: undefined, aiReady: false });
  await settle();
  const banner = await page.textContent('#banner');
  assert.ok(/Nothing is shared yet/.test(banner) && /No AI model/.test(banner));

  // A live database and a shared script appear in the selector.
  await send({ type: 'state', aiReady: true, activeId: 'a', sources: [
    { id: 'a', label: 'shop.db', kind: 'live', engine: 'sqlite', summary: '12 tables, 1 views', warnings: [] },
    { id: 'b', label: 'schema.sql', kind: 'sql', engine: 'mysql', summary: '5 tables, 0 views', warnings: ['x'] },
  ] });
  await settle();
  assert.strictEqual(await page.locator('#source option').count(), 2);
  assert.ok(await page.isHidden('#banner'));
  await page.selectOption('#source', 'b');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'select', id: 'b' });
  await send({ type: 'state', aiReady: true, activeId: 'b', sources: [
    { id: 'a', label: 'shop.db', kind: 'live', engine: 'sqlite', summary: '12 tables, 1 views', warnings: [] },
    { id: 'b', label: 'schema.sql', kind: 'sql', engine: 'mysql', summary: '5 tables, 0 views', warnings: ['x'] },
  ] });
  await settle();
  assert.ok(/shared SQL, so there is no data/.test(await page.textContent('#banner')));
  await send({ type: 'state', aiReady: true, activeId: 'a', sources: [{ id: 'a', label: 'shop.db', kind: 'live', engine: 'sqlite', summary: '12 tables, 1 views', warnings: [] }] });

  // Typing a question and pressing Enter sends it once; Shift+Enter makes a new line.
  await page.fill('#input', 'how many orders?');
  await page.press('#input', 'Enter');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'ask', text: 'how many orders?' });
  assert.strictEqual(await page.inputValue('#input'), '');
  assert.strictEqual(await page.locator('.msg.user .body').last().textContent(), 'how many orders?');
  await send({ type: 'thinking', on: true });
  await settle();
  assert.ok(await page.isDisabled('#send'));

  // An answer: markdown HTML, a SQL block with a Run button, links only open when https.
  await send({ type: 'thinking', on: false });
  await send({ type: 'answer', canRun: true, statsUsed: true, tables: ['orders'], sql: ['SELECT COUNT(*) FROM orders'],
    html: '<p>Count <code>orders</code> <a href="https://example.com/doc" data-external="1">docs</a> <a href="#" aria-disabled="true">bad</a></p><script>window.__pwned = 1</script>' });
  await settle();
  assert.strictEqual(await page.locator('.msg.bot .who').first().textContent(), 'Dex');
  assert.strictEqual(await page.locator('.msg.bot .avatar svg').count(), 1);
  assert.strictEqual(await page.locator('.sqlblock pre').textContent(), 'SELECT COUNT(*) FROM orders');
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, 'script in an answer did not run');
  await page.click('text=docs');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'link', href: 'https://example.com/doc' });
  await page.locator('text=bad').dispatchEvent('click');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'link', href: 'https://example.com/doc' }, 'a non-https link sends nothing');

  // Run, then show the result; the rows button sends only when pressed.
  await page.click('button:has-text("Run")');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'run', sql: 'SELECT COUNT(*) FROM orders' });
  await send({ type: 'result', runId: 'r1', columns: ['n', 'email'], rows: [['7', 'NULL']], truncated: true, elapsedMs: 3, rowCount: 1 });
  await settle();
  assert.ok(/1 row in 3 ms/.test(await page.textContent('.result .meta')));
  assert.ok(/More rows exist/.test(await page.textContent('.result .meta')));
  assert.strictEqual(await page.locator('.result th').count(), 2);
  assert.strictEqual(await page.locator('.result td.null').count(), 1);
  assert.ok(!(await sent()).some((m) => m.type === 'explainRows'), 'nothing sent about rows yet');
  await page.click('text=Let the AI see these rows');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'explainRows', runId: 'r1' });

  // A refused query shows its reason and re-enables Run.
  await page.click('.sqlblock button:has-text("Run")');
  await send({ type: 'runError', sql: 'x', text: 'Only SELECT queries can be run, not DELETE.' });
  await settle();
  assert.ok(/Only SELECT/.test(await page.textContent('.result .meta')));
  assert.ok(await page.isEnabled('.sqlblock button:has-text("Run")'));

  // Copy, open in editor, and saving a note under the answer.
  await page.click('button:has-text("Copy")');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'copy', sql: 'SELECT COUNT(*) FROM orders' });
  await page.click('button:has-text("Open in editor")');
  assert.strictEqual((await sent()).at(-1).type, 'insert');
  await page.fill('.noterow input', 'orders are in rupees');
  await page.click('text=Save note');
  assert.deepStrictEqual((await sent()).at(-1), { type: 'note', text: 'orders are in rupees', table: 'orders' });

  // Errors, notices, prefilled questions, and a new chat.
  await send({ type: 'error', text: 'Could not reach the AI service.' });
  await settle();
  assert.ok(/Could not reach/.test(await page.locator('.msg.error .body').textContent()));
  await send({ type: 'prefill', text: 'what is orders for?', send: true });
  await settle();
  assert.deepStrictEqual((await sent()).at(-1), { type: 'ask', text: 'what is orders for?' });
  await page.click('#clear');
  assert.strictEqual(await page.locator('.msg').count(), 0);
  assert.strictEqual(await page.locator('.welcome').count(), 1, 'the welcome is back after a new chat');
  assert.strictEqual((await sent()).at(-1).type, 'clear');

  // The page works at a narrow width.
  await page.setViewportSize({ width: 320, height: 600 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scrolling at 320px');

  assert.deepStrictEqual(problems, [], 'no console errors or CSP violations');
  await browser.close();
  console.log('chat page checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

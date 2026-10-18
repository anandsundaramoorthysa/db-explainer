const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const repo = process.env.DBX_E2E_REPO;
const workspace = process.env.DBX_E2E_WORKSPACE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('Timed out waiting for: ' + label);
}

// A stand-in for the developer's AI service. It records every request and answers with fixed text.
function startMockAi() {
  const requests = [];
  let reply = 'Orders are counted below.\n```sql\nSELECT COUNT(*) FROM orders;\n```';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
        return;
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port, setReply: (r) => (reply = r) })));
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('AnandSundaramoorthySa.db-explainer');
  assert.ok(ext, 'extension is installed in the test host');
  const api = await ext.activate();
  assert.ok(api && api.sources && api.ChatPanel, 'extension exposes its test hooks');

  const commands = await vscode.commands.getCommands(true);
  for (const id of ['openChat', 'addConnection', 'connect', 'disconnect', 'removeConnection', 'refresh', 'shareSql', 'askAboutTable', 'addNote', 'openNotes', 'ai.setKey', 'ai.clearKey', 'ai.test']) {
    assert.ok(commands.includes('dbExplainer.' + id), 'command registered: ' + id);
  }

  // A real SQLite database made from the shared fixture.
  const initSqlJs = require(path.join(repo, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(repo, 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database();
  db.run(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'db', 'sqlite.sql'), 'utf8'));
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-e2e-db-')), 'shop.db');
  fs.writeFileSync(dbFile, Buffer.from(db.export()));

  const ai = await startMockAi();
  const cfg = vscode.workspace.getConfiguration('dbExplainer');
  await cfg.update('ai.baseUrl', `http://127.0.0.1:${ai.port}/v1`, vscode.ConfigurationTarget.Global);
  await cfg.update('ai.model', 'test-model', vscode.ConfigurationTarget.Global);

  const seen = [];
  api.ChatPanel.tap = (m) => seen.push(m);
  const waitFor = (type, from) => until(() => seen.slice(from).find((m) => m.type === type), type);

  // Connect to the live database and open the chat.
  const profile = { id: 'e2e', name: 'shop.db', engine: 'sqlite', filePath: dbFile };
  await api.store.save(profile);
  await vscode.commands.executeCommand('dbExplainer.connect', { kind: 'connection', profile });
  await until(() => api.sources.isConnected('e2e'), 'connection');
  const panel = api.ChatPanel.current;
  assert.ok(panel, 'the chat panel opened');
  await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === 'DB Explainer'), 'the chat tab');
  assert.strictEqual(api.sources.active().model.tables.length, 13, '12 tables and 1 view were read');

  // Ask a question: the AI gets schema and statistics, offers SQL, and nothing runs by itself.
  let at = seen.length;
  await panel.handle({ type: 'ask', text: 'how many orders are there?' });
  const answer = await waitFor('answer', at);
  assert.deepStrictEqual(answer.sql, ['SELECT COUNT(*) FROM orders']);
  assert.strictEqual(answer.canRun, true);
  assert.ok(answer.html.includes('Orders are counted below'));
  const prompt = ai.requests[0].body.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('TABLE orders (7 rows)'), 'the prompt describes the orders table');
  assert.ok(!/asha@example|9876543210|Asha Kumar/.test(prompt), 'no row values were sent');
  assert.strictEqual(ai.requests[0].body.model, 'test-model');
  assert.strictEqual(ai.requests[0].auth, undefined, 'no key is sent when none is set');

  // Run the suggested query, then try a dangerous one.
  at = seen.length;
  await panel.handle({ type: 'run', sql: 'SELECT COUNT(*) FROM orders' });
  const result = await waitFor('result', at);
  assert.deepStrictEqual(result.rows, [['7']]);
  at = seen.length;
  await panel.handle({ type: 'run', sql: 'DELETE FROM orders' });
  const refused = await waitFor('runError', at);
  assert.ok(/Only SELECT/.test(refused.text));
  at = seen.length;
  await panel.handle({ type: 'run', sql: 'SELECT COUNT(*) FROM orders' });
  assert.deepStrictEqual((await waitFor('result', at)).rows, [['7']], 'the data is untouched');

  // Let the AI see rows: only now do values go out, and sensitive columns are hidden.
  at = seen.length;
  await panel.handle({ type: 'run', sql: 'SELECT full_name, email, phone FROM customers ORDER BY id' });
  const rows = await waitFor('result', at);
  ai.setReply('These are customers.');
  at = seen.length;
  const before = ai.requests.length;
  await panel.handle({ type: 'explainRows', runId: rows.runId });
  await waitFor('answer', at);
  const last = ai.requests[before].body.messages.at(-1).content;
  assert.ok(last.includes('Asha Kumar'), 'a masked sample reached the AI after the developer chose it');
  assert.ok(!/asha@example|9876543210/.test(last), 'emails and phones stayed hidden');

  // Team notes: saved in the workspace and used in the next answer.
  await panel.handle({ type: 'note', text: 'status shipped means the parcel left the warehouse', table: 'orders' });
  const notesFile = path.join(workspace, '.dbexplainer', 'notes.md');
  await until(() => fs.existsSync(notesFile), 'notes file');
  assert.ok(fs.readFileSync(notesFile, 'utf8').includes('## orders\n- status shipped means the parcel left the warehouse'));
  at = seen.length;
  const before2 = ai.requests.length;
  await panel.handle({ type: 'ask', text: 'what does shipped mean for an order?' });
  await waitFor('answer', at);
  assert.ok(ai.requests[before2].body.messages.at(-1).content.includes('left the warehouse'), 'the note is in the next prompt');

  // Share SQL from a file: tables are found, nothing can be run.
  const sqlFile = path.join(repo, 'test', 'fixtures', 'sql', '01_core.sql');
  await vscode.commands.executeCommand('dbExplainer.shareSql', vscode.Uri.file(sqlFile));
  await until(() => api.sources.list().some((s) => s.kind === 'sql'), 'shared sql');
  const shared = api.sources.active();
  assert.strictEqual(shared.kind, 'sql');
  assert.ok(shared.model.tables.length >= 5, 'tables were read from the script');
  at = seen.length;
  await panel.handle({ type: 'run', sql: 'SELECT 1' });
  assert.ok(/live connection/i.test((await waitFor('runError', at)).text));
  at = seen.length;
  await panel.handle({ type: 'ask', text: 'how are customers and orders related?' });
  assert.strictEqual((await waitFor('answer', at)).canRun, false);

  // The AI test command talks to the mock service.
  await vscode.commands.executeCommand('dbExplainer.ai.test');
  assert.ok(ai.requests.length >= 3);

  await vscode.commands.executeCommand('dbExplainer.disconnect', { kind: 'connection', profile });
  assert.ok(!api.sources.isConnected('e2e'));
  ai.server.close();
  console.log('end-to-end checks passed');
};

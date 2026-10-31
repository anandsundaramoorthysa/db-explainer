(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), form = $('form'), sourceSel = $('source'), banner = $('banner'), thinking = $('thinking'), send = $('send');
  let sources = [], activeId, aiReady = true, waiting = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  const BOT = 'Dex';
  const AVATAR = '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#14324D"/><g fill="none" stroke="#3FB6A8" stroke-width="1.8" stroke-linecap="round"><ellipse cx="14" cy="10" rx="6.5" ry="2.4"/><path d="M7.5 10v9M20.5 10v4M7.5 14.5c0 1.3 2.9 2.4 6.5 2.4M7.5 19c0 1.3 2.9 2.4 6.5 2.4"/></g><path d="M16.5 17h9v6.5h-4.3l-2.4 2.3v-2.3h-2.3z" fill="#fff"/><g fill="#14324D"><circle cx="19" cy="20.2" r=".9"/><circle cx="21" cy="20.2" r=".9"/><circle cx="23" cy="20.2" r=".9"/></g></svg>';
  function avatarEl() {
    const a = el('div', 'avatar');
    a.innerHTML = AVATAR;
    return a;
  }
  function welcome() {
    const w = el('div', 'welcome');
    w.appendChild(avatarEl());
    w.appendChild(el('div', 'hello', "Hi, I'm " + BOT + '. Ask me anything about your database: what a table is for, how tables connect, or for a query.'));
    return w;
  }
  function add(kind, who) {
    const first = log.querySelector('.welcome');
    if (first) first.remove();
    const m = el('div', 'msg ' + kind);
    if (kind !== 'user') m.appendChild(avatarEl());
    const col = el('div', 'col');
    col.appendChild(el('div', 'who', kind === 'user' ? who : BOT));
    const body = el('div', 'body');
    col.appendChild(body);
    m.appendChild(col);
    log.appendChild(m);
    return { m, body };
  }

  function showBanner() {
    const active = sources.find((s) => s.id === activeId);
    const parts = [];
    if (!sources.length) parts.push('Nothing is shared yet. Use the DB Explainer sidebar to add a database connection, or right-click a .sql file and choose "Share SQL With the Chat".');
    if (active && active.kind === 'sql') parts.push('This is shared SQL, so there is no data. You can ask about the structure and ask for queries, but not run them.');
    if (active && active.warnings.length) parts.push(active.warnings.length + ' statement(s) could not be read fully; the AI still sees the original text.');
    if (!aiReady) parts.push('No AI is set up yet. Add a free Groq or Gemini key to start asking questions.');
    banner.hidden = !parts.length;
    banner.className = 'banner' + (!aiReady ? ' warn' : '');
    banner.textContent = parts.join(' ');
    if (!aiReady) {
      const b = el('button', '', 'Add an AI key');
      b.type = 'button';
      b.onclick = () => vscode.postMessage({ type: 'manageAi' });
      banner.append(' ', b);
    }
  }

  function renderSources() {
    sourceSel.replaceChildren();
    for (const s of sources) {
      const o = el('option', '', s.label + ' (' + s.engine + ', ' + s.summary + ')');
      o.value = s.id;
      sourceSel.appendChild(o);
    }
    if (activeId) sourceSel.value = activeId;
    showBanner();
  }

  function sqlBlock(sql, canRun, parent) {
    const box = el('div', 'sqlblock');
    box.appendChild(el('pre', '', sql));
    const bar = el('div', 'bar');
    const run = el('button', '', 'Run');
    run.title = 'Runs this on your database. Read-only, limited rows, limited time.';
    if (!canRun) { run.disabled = true; run.title = 'Connect to a live database to run queries.'; }
    const copy = el('button', 'ghost', 'Copy');
    const open = el('button', 'ghost', 'Open in editor');
    bar.append(run, copy, open);
    if (canRun) bar.appendChild(el('span', 'hint', 'Nothing runs until you press Run.'));
    box.appendChild(bar);
    const out = el('div', 'result');
    box.appendChild(out);
    run.onclick = () => { run.disabled = true; vscode.postMessage({ type: 'run', sql }); box._out = out; box._run = run; pendingRun = box; };
    copy.onclick = () => vscode.postMessage({ type: 'copy', sql });
    open.onclick = () => vscode.postMessage({ type: 'insert', sql });
    parent.appendChild(box);
    return box;
  }
  let pendingRun;

  function showResult(m) {
    const box = pendingRun; pendingRun = undefined;
    if (!box) return;
    box._run.disabled = false;
    const out = box._out;
    out.replaceChildren();
    out.appendChild(el('div', 'meta', m.rowCount + ' row' + (m.rowCount === 1 ? '' : 's') + ' in ' + m.elapsedMs + ' ms' + (m.truncated ? '. More rows exist; only the first ones are shown.' : '')));
    const wrap = el('div', 'scroll');
    const table = el('table');
    const head = el('tr');
    for (const c of m.columns) { const th = el('th', '', c); th.scope = 'col'; head.appendChild(th); }
    const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of m.rows) {
      const tr = el('tr');
      for (const v of row) { const td = el('td', v === 'NULL' ? 'null' : '', v); td.title = v; tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table); out.appendChild(wrap);
    const bar = el('div', 'bar');
    const see = el('button', 'ghost', 'Let the AI see these rows');
    see.title = 'Sends a few rows to your AI service so it can explain them. Sensitive-looking columns are hidden first. Nothing is sent unless you press this.';
    see.onclick = () => { see.disabled = true; vscode.postMessage({ type: 'explainRows', runId: m.runId }); };
    bar.appendChild(see);
    out.appendChild(bar);
    scrollDown();
  }

  function noteRow(parent, tables) {
    const row = el('div', 'noterow');
    const i = el('input'); i.placeholder = 'Tell the team what this means (saved to the notes file)'; i.setAttribute('aria-label', 'Team note');
    const b = el('button', 'ghost', 'Save note');
    b.onclick = () => { if (i.value.trim()) { vscode.postMessage({ type: 'note', text: i.value, table: tables.length === 1 ? tables[0] : '' }); i.value = ''; } };
    row.append(i, b);
    parent.appendChild(row);
  }

  function setWaiting(on) { waiting = on; send.disabled = on; thinking.hidden = !on; }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'state': sources = m.sources; activeId = m.activeId; aiReady = m.aiReady; renderSources(); break;
      case 'thinking': setWaiting(m.on); break;
      case 'answer': {
        const a = add('bot', 'DB Explainer');
        a.body.innerHTML = m.html;
        for (const link of a.body.querySelectorAll('a')) {
          link.addEventListener('click', (ev) => { ev.preventDefault(); if (link.dataset.external) vscode.postMessage({ type: 'link', href: link.getAttribute('href') }); });
        }
        for (const sql of m.sql) sqlBlock(sql, m.canRun, a.body);
        if (m.statsUsed) a.body.appendChild(el('div', 'hint', 'Used table statistics (counts and ranges only, no values).'));
        noteRow(a.body, m.tables);
        scrollDown();
        break;
      }
      case 'result': showResult(m); break;
      case 'runError': {
        if (pendingRun) { pendingRun._run.disabled = false; const o = pendingRun._out; o.replaceChildren(el('div', 'meta', m.text)); pendingRun = undefined; }
        break;
      }
      case 'error': { const x = add('error', 'DB Explainer'); x.body.textContent = m.text; scrollDown(); break; }
      case 'redactLast': { const users = log.querySelectorAll('.msg.user .body'); if (users.length) users[users.length - 1].textContent = m.text; break; }
      case 'notice': { banner.hidden = false; banner.className = 'banner'; banner.textContent = m.text; break; }
      case 'prefill': input.value = m.text; if (m.send) submit(); else input.focus(); break;
    }
  });

  function submit() {
    const text = input.value.trim();
    if (!text || waiting) return;
    const u = add('user', 'You');
    u.body.textContent = text;
    input.value = '';
    scrollDown();
    vscode.postMessage({ type: 'ask', text });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  sourceSel.addEventListener('change', () => vscode.postMessage({ type: 'select', id: sourceSel.value }));
  $('clear').addEventListener('click', () => { log.replaceChildren(welcome()); vscode.postMessage({ type: 'clear' }); });
  log.appendChild(welcome());
  vscode.postMessage({ type: 'ready' });
})();

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const list = $('list'), banner = $('banner'), fallback = $('fallback');
  let state = { profiles: [], presets: [], fallback: false };
  let form; // the open add/edit form, if any
  const results = new Map(); // id -> { ok, text } from the last "Test connection"
  const testing = new Set(); // ids whose test is still running
  list.removeAttribute('aria-live'); // re-rendering the whole list must not be re-read; announce() speaks instead
  const live = el('div', 'sr-only', '');
  live.setAttribute('role', 'status');
  document.body.appendChild(live);
  const announce = (t) => { live.textContent = t; };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function field(label, input, hint) {
    const wrap = el('label', 'field');
    wrap.appendChild(el('span', 'name', label));
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el('span', 'hint', hint));
    return wrap;
  }
  function button(text, cls, onclick, title, action, label) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    if (action) b.dataset.action = action;
    if (label) b.setAttribute('aria-label', label);
    b.onclick = onclick;
    return b;
  }
  const STATUS = { active: 'Active', expiring: 'Expiring soon', expired: 'Expired' };
  const presetOf = (p) => state.presets.find((x) => x.provider === p) || { models: [], baseUrl: '', name: p };

  // The saved model versions. Pressing one makes it the model in use.
  function modelList(p) {
    const wrap = el('div', 'versions');
    wrap.appendChild(el('span', 'name', 'Saved models'));
    const row = el('div', 'versionrow');
    for (const m of p.savedModels || [p.model]) {
      const on = m === p.model;
      const item = el('span', 'version' + (on ? ' on' : ''));
      const use = button(m, 'link', () => { results.delete(p.id); vscode.postMessage({ type: 'setModel', id: p.id, model: m }); }, on ? 'The model in use' : 'Use this model', 'useModel:' + m, 'Use model ' + m + ' for ' + p.label);
      use.disabled = on;
      item.appendChild(use);
      if (!on) item.appendChild(button('×', 'link', () => vscode.postMessage({ type: 'removeModel', id: p.id, model: m }), 'Remove from this list', 'removeModel:' + m, 'Remove model ' + m + ' from ' + p.label));
      row.appendChild(item);
    }
    const input = el('input');
    input.placeholder = 'Add a model version';
    input.setAttribute('list', 'models-' + p.id);
    input.setAttribute('aria-label', 'Add a model version to ' + p.label);
    const add = () => { const v = input.value.trim(); if (v) { input.value = ''; vscode.postMessage({ type: 'addModel', id: p.id, model: v }); } };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    row.append(input, button('Add model', 'ghost', add, '', 'addModel', 'Add this model version to ' + p.label));
    wrap.appendChild(row);
    return wrap;
  }

  // A password box turns pasted line breaks into nothing, which would join two keys into one.
  function keepKeysApart(input) {
    input.onpaste = (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text');
      if (!text || !/\s/.test(text.trim())) return;
      e.preventDefault();
      input.setRangeText(text.trim().replace(/\s+/g, ' '), input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input'));
    };
  }

  // Add keys right on the card. Each one is checked as soon as it is saved.
  function addKeyRow(p) {
    const row = el('div', 'addkey');
    const key = el('input');
    key.type = 'password'; key.autocomplete = 'off'; key.spellcheck = false;
    key.placeholder = p.hasKey ? 'Add more keys: paste one or several' : 'Paste an API key';
    key.setAttribute('aria-label', 'Add API keys to ' + p.label);
    keepKeysApart(key);
    const date = el('input');
    date.type = 'date';
    date.title = 'Expiry date (optional). Most keys have none.';
    date.setAttribute('aria-label', 'Expiry date of the new keys for ' + p.label);
    const add = () => {
      if (!key.value.trim()) return;
      vscode.postMessage({ type: 'addKeys', id: p.id, key: key.value, expiresAt: date.value });
      key.value = ''; date.value = '';
    };
    key.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    row.append(key, date, button('Add key', 'ghost', add, 'If a key expires, is refused or hits its limit, the next valid key is used automatically', 'addKeys', 'Add these keys to ' + p.label));
    return row;
  }

  // One row per key, shown once a profile has more than one.
  function keyList(p, keys) {
    const wrap = el('div', 'keyrows');
    keys.forEach((k, i) => {
      const n = 'key ' + (i + 1);
      const row = el('div', 'keyrow status-' + k.status);
      row.appendChild(el('strong', '', 'Key ' + (i + 1)));
      row.appendChild(el('code', 'mask', k.hasKey ? k.mask : 'No key saved'));
      row.appendChild(el('span', 'pill ' + k.status, STATUS[k.status]));
      if (k.inUse) row.appendChild(el('span', 'badge', 'In use'));
      row.appendChild(el('span', 'expiry', k.expiryText));
      const acts = el('span', 'keyacts');
      const use = button('Use', 'ghost', () => vscode.postMessage({ type: 'useKey', id: p.id, keyId: k.id }), 'Try this key first', 'useKey:' + k.id, 'Use ' + n + ' of ' + p.label);
      use.disabled = k.inUse || k.status === 'expired' || !k.hasKey;
      const date = el('input');
      date.type = 'date';
      date.value = k.expiresAt || '';
      date.title = 'Expiry date, if this key has one';
      date.setAttribute('aria-label', 'Expiry date of ' + n + ' of ' + p.label);
      date.onchange = () => vscode.postMessage({ type: 'setKeyDate', id: p.id, keyId: k.id, expiresAt: date.value });
      const test = button('Test', 'ghost', () => vscode.postMessage({ type: 'testKey', id: p.id, keyId: k.id }), 'Checks this key without using it for the chat', 'testKey:' + k.id, 'Test ' + n + ' of ' + p.label);
      test.disabled = k.status === 'expired' || !k.hasKey;
      row.appendChild(date);
      acts.append(use, test,
        button('Change', 'ghost', () => vscode.postMessage({ type: 'changeKey', id: p.id, keyId: k.id }), '', 'changeKey:' + k.id, 'Change ' + n + ' of ' + p.label),
        button('Remove', 'ghost', () => vscode.postMessage({ type: 'removeKey', id: p.id, keyId: k.id }), '', 'removeKey:' + k.id, 'Remove ' + n + ' of ' + p.label));
      row.appendChild(acts);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function card(p) {
    const c = el('section', 'card status-' + p.status + (p.inUse ? ' in-use' : ''));
    c.dataset.id = p.id;
    const top = el('div', 'top');
    top.appendChild(el('strong', 'label', p.label));
    top.appendChild(el('span', 'chip', p.providerName));
    top.appendChild(el('span', 'pill ' + p.status, STATUS[p.status]));
    if (p.inUse) top.appendChild(el('span', 'badge', 'In use'));
    c.appendChild(top);

    const grid = el('div', 'grid');
    const model = el('input');
    model.value = p.model;
    model.setAttribute('list', 'models-' + p.id);
    model.setAttribute('aria-label', 'Model for ' + p.label);
    const dl = el('datalist');
    dl.id = 'models-' + p.id;
    for (const m of p.models) { const o = el('option'); o.value = m; dl.appendChild(o); }
    model.dataset.action = 'model';
    model.onchange = () => { results.delete(p.id); vscode.postMessage({ type: 'setModel', id: p.id, model: model.value }); };
    grid.append(field('Model', model), dl);
    const keys = p.keys || [];
    const many = keys.length > 1;
    const copilot = p.provider === 'vscode';
    if (copilot) grid.appendChild(field('Key', el('span', 'mask', 'Not needed: uses your GitHub Copilot through VS Code')));
    else if (!many) {
      grid.appendChild(field('Key', el('code', 'mask', p.hasKey ? p.keyMask : p.local ? 'Not needed for a local service' : 'No key saved')));
      grid.appendChild(field('Expiry', el('span', 'expiry', p.expiryText)));
    }
    if (!copilot) grid.appendChild(field('Address', el('span', 'url', p.baseUrl)));
    c.appendChild(grid);
    c.appendChild(modelList(p));
    if (many && !copilot) c.appendChild(keyList(p, keys));
    if (!copilot) c.appendChild(addKeyRow(p));

    const bar = el('div', 'bar');
    const expired = p.status === 'expired';
    bar.appendChild(button('Change key', '', () => vscode.postMessage({ type: 'changeKey', id: p.id }), 'Type the new key (and expiry date) and it is checked straight away', 'changeKey', 'Change key for ' + p.label));
    bar.appendChild(button('Test connection', 'ghost', () => vscode.postMessage({ type: 'test', id: p.id }), expired ? 'Expired keys are never used. Change the expiry date first.' : 'Asks the service for its model list', 'test', 'Test connection for ' + p.label));
    bar.appendChild(button('Use this profile', 'ghost', () => vscode.postMessage({ type: 'activate', id: p.id }), expired ? 'Expired keys are never used.' : 'Use this profile for the chat', 'activate', 'Use ' + p.label + ' for the chat'));
    bar.appendChild(button('Edit', 'ghost', () => openForm(p), '', 'edit', 'Edit ' + p.label));
    bar.appendChild(button('Delete', 'ghost danger', () => vscode.postMessage({ type: 'delete', id: p.id }), '', 'delete', 'Delete ' + p.label));
    // Change key stays enabled on an expired card: changing the key and date is how it comes back.
    if (expired) { bar.children[1].disabled = true; bar.children[2].disabled = true; }
    if (copilot) bar.children[0].hidden = true;
    if (p.inUse) bar.children[2].disabled = true;
    c.appendChild(bar);

    const r = testing.has(p.id) ? { text: 'Testing...', pending: true } : results.get(p.id);
    const out = el('div', 'test' + (r && !r.pending ? (r.ok ? ' ok' : ' bad') : ''), r ? r.text : '');
    out.id = 'test-' + p.id;
    out.setAttribute('role', 'status');
    c.appendChild(out);
    return c;
  }

  function render() {
    fallback.checked = !!state.fallback;
    const cop = $('copilot');
    if (cop) cop.hidden = !state.copilot || state.profiles.some((p) => p.provider === 'vscode');
    const ae = document.activeElement;
    const inForm = form && form.root.contains(ae);
    const cardEl = ae && ae.closest && ae.closest('section[data-id]');
    const was = cardEl && ae.dataset.action ? [cardEl.dataset.id, ae.dataset.action] : undefined;
    list.replaceChildren();
    const notes = [];
    if (state.legacy) notes.push('You are using the dbExplainer.ai.* settings (' + state.legacy.baseUrl + (state.legacy.model ? ', ' + state.legacy.model : '') + '). Add a profile to replace them; until then they keep working.');
    if (state.pendingKey) notes.push('A key you pasted in the chat is waiting, hidden. Fill in the rest and press Save to keep it as a profile.');
    banner.hidden = !notes.length;
    banner.textContent = notes.join(' ');
    if (state.pendingKey) {
      const d = el('button', 'ghost', 'Discard');
      d.type = 'button';
      d.onclick = () => vscode.postMessage({ type: 'discardPending' });
      banner.append(' ', d);
    }
    if (form) list.appendChild(form.root);
    if (!state.profiles.length && !form) list.appendChild(el('p', 'empty', 'No profiles yet. Press "Add profile" to set up Gemini, Groq, OpenRouter, OpenAI, Claude or Ollama.'));
    for (const p of state.profiles) if (!(form && form.id === p.id)) list.appendChild(card(p));
    if (inForm) ae.focus();
    else if (was) for (const c of list.querySelectorAll('section[data-id]')) if (c.dataset.id === was[0]) { const t = [...c.querySelectorAll('[data-action]')].find((x) => x.dataset.action === was[1]); if (t) t.focus(); }
  }

  function openForm(p, provider) {
    const editing = !!p;
    const start = p || { provider: provider || 'groq', label: '', baseUrl: '', model: '', expiresAt: '' };
    const root = el('form', 'card formcard');
    root.noValidate = true;
    root.appendChild(el('h2', '', editing ? 'Edit ' + p.label : 'Add a profile'));
    const sel = el('select');
    for (const x of state.presets) { const o = el('option', '', x.name); o.value = x.provider; sel.appendChild(o); }
    sel.value = start.provider;
    const label = el('input'); label.value = start.label; label.placeholder = 'For example: Work Groq';
    const url = el('input'); url.value = start.baseUrl; url.inputMode = 'url';
    const model = el('input'); model.value = start.model; model.setAttribute('list', 'form-models');
    const dl = el('datalist'); dl.id = 'form-models';
    const keyHint = el('span', 'hint');
    const key = el('input'); key.type = 'password'; key.autocomplete = 'off'; key.spellcheck = false;
    key.placeholder = editing ? 'Leave empty to keep the saved key' : state.pendingKey ? 'Using the key you pasted in the chat' : 'Paste one or several API keys';
    keepKeysApart(key);
    const adv = el('details'); adv.appendChild(el('summary', '', 'Advanced'));
    const exp = el('input'); exp.type = 'date'; exp.value = start.expiresAt || '';
    const err = el('div', 'formerror'); err.setAttribute('role', 'alert');
    let keyFieldRef, urlFieldRef;

    function fillModels() {
      dl.replaceChildren();
      const ms = new Set([...presetOf(sel.value).models, ...((p && p.models) || [])]);
      for (const m of ms) { const o = el('option'); o.value = m; dl.appendChild(o); }
    }
    function setKeyHint() {
      keyHint.replaceChildren();
      // Copilot needs no key and no address.
      const noKey = sel.value === 'vscode';
      if (keyFieldRef) keyFieldRef.hidden = noKey;
      if (urlFieldRef) urlFieldRef.hidden = noKey;
      const pr = presetOf(sel.value);
      if (pr.keyUrl) keyHint.append('Get a key: ', button(pr.name + ' key page', 'link', () => vscode.postMessage({ type: 'link', href: pr.keyUrl })));
      else keyHint.textContent = 'Kept in VS Code secret storage, never in settings.';
    }
    let last = sel.value;
    sel.onchange = () => {
      // Replace the address and model only if the developer has not changed them from the previous preset.
      const was = presetOf(last), now = presetOf(sel.value);
      if (!url.value || url.value === was.baseUrl) url.value = now.baseUrl;
      if (!model.value || was.models.includes(model.value)) model.value = now.models[0] || '';
      if (!label.value) label.placeholder = 'For example: Work ' + now.name;
      last = sel.value;
      if (sel.value === 'custom') adv.open = true;
      setKeyHint();
      fillModels();
    };
    // Most keys show which service they are for, so the provider can pick itself. Choosing one by hand always wins.
    let chosen = editing;
    sel.addEventListener('change', () => { chosen = true; });
    key.addEventListener('input', () => {
      if (chosen) return;
      const v = key.value.trim();
      const found = /^sk-ant-/.test(v) ? 'claude' : /^sk-or-/.test(v) ? 'openrouter' : /^gsk_/.test(v) ? 'groq' : /^AIza/.test(v) ? 'gemini' : /^sk-/.test(v) ? 'openai' : '';
      if (found && found !== sel.value && state.presets.some((x) => x.provider === found)) { sel.value = found; sel.onchange(); }
    });
    if (!editing) {
      const preset = presetOf(sel.value);
      if (!url.value) url.value = preset.baseUrl;
      if (!model.value) model.value = preset.models[0] || '';
    }
    fillModels();
    setKeyHint();
    adv.open = editing || sel.value === 'custom';
    const urlField = field('Base URL', url, 'Any OpenAI-compatible address. The key is only ever sent to this address.');
    adv.append(field('Label', label), urlField,
      field('Key expiry date (optional)', exp, 'Only if your provider gave this key an end date. Most do not. You are warned 3 days before it ends, and an expired key is never used.'));
    const keyField = field('API key', key);
    keyField.appendChild(keyHint);
    keyFieldRef = keyField;
    urlFieldRef = urlField;
    setKeyHint();
    root.append(field('Provider', sel), keyField, field('Model', model, 'Pick one or type your own.'), dl, adv, err);
    const bar = el('div', 'bar');
    const save = el('button', '', 'Save'); save.type = 'submit';
    bar.append(save, button('Cancel', 'ghost', () => { key.value = ''; form = undefined; render(); }));
    root.appendChild(bar);
    root.onsubmit = (e) => {
      e.preventDefault();
      err.textContent = '';
      if (p) results.delete(p.id);
      vscode.postMessage({ type: 'save', id: p && p.id, provider: sel.value, label: label.value, baseUrl: url.value, model: model.value, expiresAt: exp.value, key: key.value });
    };
    form = { root, id: p && p.id, err, key };
    render();
    (editing ? model : key).focus();
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'state': {
        for (const p of m.profiles) {
          const o = state.profiles.find((x) => x.id === p.id);
          if (o && (o.baseUrl !== p.baseUrl || o.model !== p.model || o.hasKey !== p.hasKey)) results.delete(p.id);
        }
        state = m; render(); break;
      }
      case 'startAdd': openForm(undefined, m.provider); break;
      case 'saved': if (form) form.key.value = ''; form = undefined; render(); announce('Saved'); break;
      case 'formError': if (form) form.err.textContent = m.text; break;
      case 'testing': { testing.add(m.id); const o = $('test-' + m.id); if (o) { o.className = 'test'; o.textContent = 'Testing...'; } break; }
      case 'testResult': { testing.delete(m.id); announce(m.text); results.set(m.id, { ok: m.ok, text: m.text }); const o = $('test-' + m.id); if (o) { o.className = 'test ' + (m.ok ? 'ok' : 'bad'); o.textContent = m.text; } break; }
    }
  });

  $('add').onclick = () => openForm();
  if ($('copilot')) $('copilot').onclick = () => vscode.postMessage({ type: 'useCopilot' });
  fallback.onchange = () => vscode.postMessage({ type: 'setFallback', on: fallback.checked });
  vscode.postMessage({ type: 'ready' });
})();

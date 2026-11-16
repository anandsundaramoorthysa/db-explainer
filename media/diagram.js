(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const HEADER = 30, ROW = 18;
  const svg = document.getElementById('canvas');
  const world = document.getElementById('world');
  const empty = document.getElementById('empty');
  const title = document.getElementById('title');
  let layout;
  let view = { x: 0, y: 0, k: 1 };

  function make(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text; // always text, never markup
    return e;
  }
  function apply() { world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); }
  function fit() {
    if (!layout || !layout.nodes.length) return;
    const r = svg.getBoundingClientRect();
    const k = Math.min(1.2, (r.width - 40) / Math.max(layout.width, 1), (r.height - 40) / Math.max(layout.height, 1));
    view = { k: Math.max(0.2, k), x: 0, y: 0 };
    view.x = (r.width - layout.width * view.k) / 2;
    view.y = Math.max(20, (r.height - layout.height * view.k) / 2);
    apply();
  }

  // From the table holding the foreign key to the table it points at. Most targets are to the left.
  function path(a, b) {
    if (a === b) {
      const x = a.x + a.w, y = a.y + HEADER / 2;
      return { d: `M ${x} ${y} C ${x + 40} ${y - 30}, ${x + 40} ${y + 40}, ${x} ${y + 20}`, lx: x + 30, ly: y };
    }
    const leftward = b.x + b.w <= a.x;
    const rightward = a.x + a.w <= b.x;
    const ay = a.y + Math.min(a.h / 2, HEADER + 10), by = b.y + Math.min(b.h / 2, HEADER + 10);
    if (leftward || rightward) {
      const x1 = leftward ? a.x : a.x + a.w, x2 = leftward ? b.x + b.w : b.x;
      const bend = Math.max(30, Math.abs(x1 - x2) / 2) * (leftward ? -1 : 1);
      return { d: `M ${x1} ${ay} C ${x1 + bend} ${ay}, ${x2 - bend} ${by}, ${x2} ${by}`, lx: (x1 + x2) / 2, ly: (ay + by) / 2 - 4 };
    }
    // Same column: go out to the right and back.
    const x = Math.max(a.x + a.w, b.x + b.w);
    return { d: `M ${a.x + a.w} ${ay} C ${x + 60} ${ay}, ${x + 60} ${by}, ${b.x + b.w} ${by}`, lx: x + 34, ly: (ay + by) / 2 };
  }

  function draw() {
    world.replaceChildren();
    empty.hidden = !!layout.nodes.length;
    title.textContent = layout.title;
    const defs = make('defs');
    const marker = make('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.appendChild(make('path', { d: 'M 0 0 L 10 5 L 0 10 z' }));
    defs.appendChild(marker);
    world.appendChild(defs);
    const byKey = new Map(layout.nodes.map((n) => [n.key, n]));
    const edgeEls = [];
    for (const e of layout.edges) {
      const a = byKey.get(e.from), b = byKey.get(e.to);
      if (!a || !b) continue;
      const p = path(a, b);
      const line = make('path', { class: 'edge', d: p.d, 'marker-end': 'url(#arrow)' });
      const label = make('text', { class: 'edge-label', x: p.lx, y: p.ly, 'text-anchor': 'middle' }, e.label);
      world.append(line, label);
      edgeEls.push({ e, line, label });
    }
    for (const n of layout.nodes) {
      const g = make('g', { class: 'node ' + n.kind, transform: `translate(${n.x} ${n.y})`, tabindex: 0, role: 'button' });
      g.setAttribute('aria-label', `${n.key}, ${n.kind}${n.rows ? ', ' + n.rows : ''}. Press Enter to ask about it.`);
      g.appendChild(make('rect', { class: 'box', width: n.w, height: n.h, rx: 4 }));
      g.appendChild(make('rect', { class: 'head', width: n.w, height: HEADER, rx: 4 }));
      g.appendChild(make('text', { class: 'name', x: 10, y: 19 }, n.key + (n.kind === 'view' ? ' (view)' : '')));
      if (n.rows) g.appendChild(make('text', { class: 'rows', x: n.w - 8, y: 19, 'text-anchor': 'end' }, n.rows));
      n.columns.forEach((c, i) => {
        const y = HEADER + 14 + i * ROW;
        if (c.pk || c.fk) g.appendChild(make('text', { class: 'key' + (c.pk ? '' : ' fk'), x: 8, y }, c.pk ? 'PK' : 'FK'));
        g.appendChild(make('text', { x: 30, y }, c.name));
        g.appendChild(make('text', { class: 'type', x: n.w - 8, y, 'text-anchor': 'end' }, c.type.length > 18 ? c.type.slice(0, 17) + '…' : c.type));
      });
      if (n.more) g.appendChild(make('text', { class: 'more', x: 30, y: HEADER + 14 + n.columns.length * ROW }, `+ ${n.more} more column${n.more === 1 ? '' : 's'}`));
      const mark = (on) => {
        g.classList.toggle('on', on);
        for (const x of edgeEls) if (x.e.from === n.key || x.e.to === n.key) { x.line.classList.toggle('on', on); x.label.classList.toggle('on', on); }
      };
      g.addEventListener('mouseenter', () => mark(true));
      g.addEventListener('mouseleave', () => mark(false));
      g.addEventListener('focus', () => mark(true));
      g.addEventListener('blur', () => mark(false));
      g.addEventListener('click', (ev) => { if (!moved) vscode.postMessage({ type: 'ask', key: n.key }); ev.stopPropagation(); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); vscode.postMessage({ type: 'ask', key: n.key }); } });
      world.appendChild(g);
    }
    fit();
  }

  // Drag to move, wheel to zoom around the pointer.
  let drag, moved = false;
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; moved = false; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; svg.classList.add('dragging'); }
    view.x = drag.vx + dx; view.y = drag.vy + dy; apply();
  });
  window.addEventListener('pointerup', () => { drag = undefined; svg.classList.remove('dragging'); setTimeout(() => (moved = false), 0); });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = px - ((px - view.x) * k) / view.k;
    view.y = py - ((py - view.y) * k) / view.k;
    view.k = k;
    apply();
  }, { passive: false });

  document.getElementById('fit').onclick = fit;
  document.getElementById('mermaid').onclick = () => vscode.postMessage({ type: 'copyMermaid' });
  window.addEventListener('resize', fit);
  window.addEventListener('message', (e) => { if (e.data.type === 'layout') { layout = e.data.layout; draw(); } });
  vscode.postMessage({ type: 'ready' });
})();

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * charts.js is a browser module: it builds real DOM/SVG nodes and wires
 * pointer + focus listeners on them. This repo has zero dependencies (no
 * jsdom), so this file stands up the smallest DOM shim that satisfies what
 * charts.js actually calls: createElement(NS), setAttribute, appendChild,
 * insertBefore, classList, style, addEventListener and getBoundingClientRect.
 * That is enough to render every chart, dispatch the pointer/focus events a
 * user would, and assert on the resulting tree without ever touching a real
 * browser.
 *
 * Each test file the built-in runner spawns gets its own process, so
 * installing `document`/`window` on `globalThis` here cannot leak into any
 * other *.test.js file.
 */

function makeNode(tag) {
  const node = {
    tagName: tag,
    attrs: {},
    children: [],
    _listeners: {},
    style: {},
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get className() { return this.attrs.class || ''; },
    set className(v) { this.attrs.class = v; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
      return child;
    },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (arr) this._listeners[type] = arr.filter((f) => f !== fn);
    },
    dispatch(type, ev = {}) { for (const fn of (this._listeners[type] || []).slice()) fn(ev); },
    setPointerCapture() {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    getBoundingClientRect() {
      if (this.tagName === 'svg' && this.attrs.viewBox) {
        const parts = this.attrs.viewBox.split(/\s+/).map(Number);
        const w = parts[2] || 0;
        const h = parts[3] || 0;
        return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
      }
      return { left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 };
    },
  };
  return node;
}

/** Every node with a 'd', 'x', 'y', 'cx', 'cy', 'r' attribute, walked deep. */
function walk(node, out = []) {
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}

function findAll(root, pred) {
  return walk(root).filter(pred);
}
function findOne(root, pred) {
  return findAll(root, pred)[0];
}
function hasClass(node, name) {
  return String(node.attrs?.class || '').split(/\s+/).includes(name);
}

function installFakeDom() {
  const doc = {
    head: makeNode('head'),
    body: makeNode('body'),
    createElement(tag) { return makeNode(tag); },
    createElementNS(_ns, tag) { return makeNode(tag); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    querySelector() { return null; },
  };
  globalThis.document = /** @type {any} */ (doc);
  globalThis.window = /** @type {any} */ (globalThis);
  delete globalThis.window.__TOKENFLOW_BUNDLE__;
  return doc;
}

/** The fake head's linked stylesheets, typed loosely: real HTMLCollection
 * has no .filter, but this file's own head.children is a plain array. */
function headLinks() {
  return /** @type {any[]} */ (/** @type {unknown} */ (document.head.children)).filter((c) => c.tagName === 'link');
}

async function freshCharts({ snapshot = false } = {}) {
  installFakeDom();
  if (snapshot) globalThis.window.__TOKENFLOW_BUNDLE__ = { annotations: [] };
  const bust = `?t=${Date.now()}${Math.random()}`;
  return import(`../src/ui/charts.js${bust}`);
}

// ------------------------------------------------------------- niceTicks ----

test('niceTicks: degenerate range (min === max) never divides by zero', async () => {
  const { niceTicks } = await freshCharts();
  const r = niceTicks(5, 5);
  assert.deepEqual(r.ticks, [0, 5]);
  assert.equal(r.max, 5);
});

test('niceTicks: all-zero data still returns a usable [0,1] axis', async () => {
  const { niceTicks } = await freshCharts();
  const r = niceTicks(0, 0);
  assert.deepEqual(r.ticks, [0, 1]);
});

// ---------------------------------------------------------- roundedTopPath --

test('roundedTopPath: zero height or width draws nothing, never a NaN path', async () => {
  const { roundedTopPath } = await freshCharts();
  assert.equal(roundedTopPath(0, 0, 10, 0, 4), '');
  assert.equal(roundedTopPath(0, 0, 0, 10, 4), '');
});

test('roundedTopPath: a bar shorter than the radius still closes at a flat baseline', async () => {
  const { roundedTopPath } = await freshCharts();
  const d = roundedTopPath(10, 90, 20, 1.5, 4);
  assert.ok(!d.includes('NaN'));
  // baseline (bottom edge) is at y=91.5 on both the left and right side
  assert.ok(d.includes('91.5'));
});

test('roundedTopPath: a tall bar rounds only the top two corners', async () => {
  const { roundedTopPath } = await freshCharts();
  const d = roundedTopPath(0, 0, 20, 40, 4);
  assert.ok(d.startsWith('M0 40')); // starts at the flat baseline
  assert.ok(d.includes('Q')); // has quadratic curves for the top corners
});

// -------------------------------------------------------------- timeSeries --

test('timeSeries: n=0 renders a readable empty state, not a NaN axis', async () => {
  const { timeSeries } = await freshCharts();
  const root = timeSeries({
    data: [], keys: [{ key: 'a', label: 'A', color: 'var(--series-1)' }],
    fmtY: (v) => String(v), fmtX: (k) => k,
  });
  const all = walk(root);
  assert.ok(all.some((n) => hasClass(n, 'empty-state')));
  for (const n of all) {
    if (n.attrs?.d) assert.ok(!n.attrs.d.includes('NaN'), `d attr contains NaN: ${n.attrs.d}`);
  }
});

test('timeSeries: n=1 draws a marker since a lone "M" path is invisible', async () => {
  const { timeSeries } = await freshCharts();
  const root = timeSeries({
    data: [{ key: '2026-01-01', a: 42 }],
    keys: [{ key: 'a', label: 'A', color: 'var(--series-1)' }],
    fmtY: (v) => String(v), fmtX: (k) => k,
  });
  const dots = findAll(root, (n) => n.tagName === 'circle' && n.attrs.fill === 'var(--series-1)');
  assert.ok(dots.length >= 1, 'expected a marker circle for the single data point');
});

test('timeSeries: hovering snaps the crosshair, shows every series in the tooltip and does not throw with a missing fmtY', async () => {
  const { timeSeries } = await freshCharts();
  const data = [
    { key: '2026-01-01', a: 10, b: 20 },
    { key: '2026-01-02', a: 30, b: 5 },
    { key: '2026-01-03', a: 50, b: 15 },
  ];
  const root = timeSeries({
    data,
    keys: [
      { key: 'a', label: 'Input', color: 'var(--series-1)' },
      { key: 'b', label: 'Output', color: 'var(--series-2)' },
    ],
    // fmtY intentionally omitted: must fall back, never throw calling o.fmtY directly
    fmtX: (k) => k,
    width: 300, height: 200,
    // isolates this test's arithmetic from the end-label margin widening,
    // which is exercised separately below
    directLabels: false,
  });
  const hit = findOne(root, (n) => n.tagName === 'rect' && hasClass(n, 'hit'));
  assert.ok(hit, 'expected a .hit rect for the hover layer');
  const cross = findOne(root, (n) => hasClass(n, 'crosshair'));
  // W=300, viewBox matches W 1:1 in the fake DOM, so clientX maps straight
  // through to plot-space x. M.l defaults to 58 (no y-label widening needed
  // for single-digit values), iw = 300-58-16=226, x(2) (last of 3 points) =
  // M.l + iw = 284.
  hit.dispatch('pointermove', { clientX: 284, clientY: 50 });
  assert.equal(Number(cross.attrs.x1), 284);
  assert.equal(cross.attrs.opacity, '1');

  const tip = findOne(document.body, (n) => hasClass(n, 'tip'));
  assert.ok(tip, 'expected the shared tooltip node in <body>');
  assert.ok(tip.classList.contains('on'));
  const values = findAll(tip, (n) => hasClass(n, 't-val')).map((n) => n.children[0]?._text ?? n._text);
  assert.ok(values.includes('50'), `expected series a's value 50 in the tooltip, got ${JSON.stringify(values)}`);
  assert.ok(values.includes('15'), `expected series b's value 15 in the tooltip, got ${JSON.stringify(values)}`);

  hit.dispatch('pointerleave', {});
  assert.equal(cross.attrs.opacity, '0');
  assert.ok(!tip.classList.contains('on'));
});

test('timeSeries: 2 to 4 non-stacked series get a direct end label per series', async () => {
  const { timeSeries } = await freshCharts();
  const data = [{ key: '2026-01-01', a: 1, b: 2 }, { key: '2026-01-02', a: 3, b: 9 }];
  const root = timeSeries({
    data,
    keys: [
      { key: 'a', label: 'Alpha', color: 'var(--series-1)' },
      { key: 'b', label: 'Beta', color: 'var(--series-2)' },
    ],
    fmtY: (v) => String(v), fmtX: (k) => k,
  });
  const labels = findAll(root, (n) => hasClass(n, 'series-end-label'));
  assert.equal(labels.length, 2);
});

test('timeSeries: directLabels: false suppresses the automatic end labels', async () => {
  const { timeSeries } = await freshCharts();
  const data = [{ key: '2026-01-01', a: 1, b: 2 }];
  const root = timeSeries({
    data,
    keys: [
      { key: 'a', label: 'Alpha', color: 'var(--series-1)' },
      { key: 'b', label: 'Beta', color: 'var(--series-2)' },
    ],
    fmtY: (v) => String(v), fmtX: (k) => k, directLabels: false,
  });
  assert.equal(findAll(root, (n) => hasClass(n, 'series-end-label')).length, 0);
});

test('timeSeries: stacked mode with a single bucket still marks each series', async () => {
  const { timeSeries } = await freshCharts();
  const root = timeSeries({
    data: [{ key: '2026-01-01', a: 4, b: 6 }],
    keys: [
      { key: 'a', label: 'A', color: 'var(--series-1)' },
      { key: 'b', label: 'B', color: 'var(--series-2)' },
    ],
    mode: 'stacked',
    fmtY: (v) => String(v), fmtX: (k) => k,
  });
  const all = walk(root);
  for (const n of all) if (n.attrs?.d) assert.ok(!n.attrs.d.includes('NaN'));
  const markers = findAll(root, (n) => n.tagName === 'circle' && (n.attrs.fill === 'var(--series-1)' || n.attrs.fill === 'var(--series-2)'));
  assert.ok(markers.length >= 2);
});

// ------------------------------------------------------------------ columns --

test('columns: n=0 renders an empty state instead of a bare axis', async () => {
  const { columns } = await freshCharts();
  const root = columns({ data: [], fmtY: (v) => String(v) });
  assert.ok(findOne(root, (n) => hasClass(n, 'empty-state')));
});

test('columns: bars are drawn as a rounded-top path, and the hit rect is keyboard-reachable', async () => {
  const { columns } = await freshCharts();
  const root = columns({
    data: [{ label: 'Mon', value: 100 }, { label: 'Tue', value: 0.001 }],
    fmtY: (v) => String(v),
  });
  const paths = findAll(root, (n) => n.tagName === 'path' && n.attrs.fill && n.attrs.fill !== 'none');
  assert.equal(paths.length, 2);
  for (const p of paths) assert.ok(!p.attrs.d.includes('NaN'));
  const hits = findAll(root, (n) => n.tagName === 'rect' && hasClass(n, 'hit'));
  assert.equal(hits.length, 2);
  for (const h of hits) assert.equal(h.attrs.tabindex, '0');

  // focus shows the same tooltip a pointermove would
  hits[0].dispatch('focus', {});
  const tip = findOne(document.body, (n) => hasClass(n, 'tip'));
  assert.ok(tip.classList.contains('on'));
  hits[0].dispatch('blur', {});
  assert.ok(!tip.classList.contains('on'));
});

// -------------------------------------------------------------------- hbars --

test('hbars: no rows renders an empty state instead of a bare box', async () => {
  const { hbars } = await freshCharts();
  const box = hbars([]);
  assert.ok(findOne(box, (n) => hasClass(n, 'empty-state')));
});

test('hbars: rows are keyboard-reachable and focus mirrors pointer hover', async () => {
  const { hbars } = await freshCharts();
  const box = hbars([{ label: 'anthropic', value: 100, color: 'var(--series-1)' }], { fmt: (v) => String(v) });
  const rows = findAll(box, (n) => n.attrs.tabindex === '0');
  assert.equal(rows.length, 1);
  rows[0].dispatch('focus', {});
  const tip = findOne(document.body, (n) => hasClass(n, 'tip'));
  assert.ok(tip.classList.contains('on'));
  rows[0].dispatch('blur', {});
  assert.ok(!tip.classList.contains('on'));
});

// -------------------------------------------------------------------- donut --

test('donut: zero total renders a readable empty ring, not a NaN slice', async () => {
  const { donut } = await freshCharts();
  const root = donut([{ label: 'A', value: 0 }, { label: 'B', value: 0 }]);
  assert.ok(findOne(root, (n) => hasClass(n, 'empty-state')));
});

test('donut: segments are keyboard-reachable and focusable', async () => {
  const { donut } = await freshCharts();
  const root = donut([{ label: 'A', value: 3, color: 'var(--series-1)' }, { label: 'B', value: 1, color: 'var(--series-2)' }]);
  const segs = findAll(root, (n) => n.tagName === 'path');
  assert.equal(segs.length, 2);
  for (const s of segs) assert.equal(s.attrs.tabindex, '0');
  segs[0].dispatch('focus', {});
  assert.ok(findOne(document.body, (n) => hasClass(n, 'tip')).classList.contains('on'));
});

// ------------------------------------------------------------------- matrix --

test('matrix: cells are keyboard-reachable and the focus/blur pair mirrors pointer hover', async () => {
  const { matrix } = await freshCharts();
  const cells = [
    { row: 0, col: 0, value: 10, label: 'Mon 0h' },
    { row: 0, col: 1, value: 0, label: 'Mon 1h' },
  ];
  const root = matrix(cells, { rows: ['Mon'], cols: ['0h', '1h'], fmt: (v) => String(v) });
  const rects = findAll(root, (n) => n.tagName === 'rect');
  assert.equal(rects.length, 2);
  for (const r of rects) assert.equal(r.attrs.tabindex, '0');
  rects[0].dispatch('focus', {});
  assert.equal(rects[0].attrs.stroke, 'var(--text-primary)');
  rects[0].dispatch('blur', {});
  assert.equal(rects[0].getAttribute('stroke'), null);
});

// ------------------------------------------------------------------ scatter --

test('scatter: no valid points renders an empty state, never a NaN axis', async () => {
  const { scatter } = await freshCharts();
  const root = scatter([{ x: null, y: null, label: 'x' }], { fmtX: (v) => String(v), fmtY: (v) => String(v) });
  assert.ok(findOne(root, (n) => hasClass(n, 'empty-state')));
});

test('scatter: hit circles are keyboard-reachable', async () => {
  const { scatter } = await freshCharts();
  const root = scatter([{ x: 1, y: 2, r: 5, color: 'var(--series-1)', label: 'Point' }], {
    fmtX: (v) => String(v), fmtY: (v) => String(v),
  });
  const hits = findAll(root, (n) => n.tagName === 'circle' && n.attrs.fill === 'transparent');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].attrs.tabindex, '0');
});

// ------------------------------------------------------------- compositionBar

test('compositionBar: all-zero segments do not throw and legend shows 0%, not NaN%', async () => {
  const { compositionBar } = await freshCharts();
  const box = compositionBar([{ label: 'A', value: 0, color: 'var(--series-1)' }]);
  const legendText = findAll(box, (n) => n._text).map((n) => n._text).join(' ');
  assert.ok(!legendText.includes('NaN'));
});

test('compositionBar: segments are keyboard-reachable', async () => {
  const { compositionBar } = await freshCharts();
  const box = compositionBar([
    { label: 'A', value: 3, color: 'var(--series-1)' },
    { label: 'B', value: 1, color: 'var(--series-2)' },
  ]);
  const segs = findAll(box, (n) => n.attrs.tabindex === '0');
  assert.equal(segs.length, 2);
});

// ------------------------------------------------------------- calendarHeatmap

test('calendarHeatmap: no days renders a readable empty message, not a blank div', async () => {
  const { calendarHeatmap } = await freshCharts();
  const wrap = calendarHeatmap([], { levelOf: () => 0, fmt: (v) => String(v) });
  const text = findAll(wrap, (n) => n._text).map((n) => n._text).join(' ');
  assert.ok(text.length > 0);
});

// -------------------------------------------------------- stylesheet linking

test('charts.css is linked once on the live dashboard and never in a snapshot', async () => {
  const dev = await freshCharts({ snapshot: false });
  dev.columns({ data: [{ label: 'A', value: 1 }], fmtY: (v) => String(v) });
  const devLinks = headLinks();
  assert.equal(devLinks.length, 1);
  assert.ok(devLinks[0].attrs.href.endsWith('styles/charts.css'));
  // a second render must not add a second <link>
  dev.columns({ data: [{ label: 'A', value: 1 }], fmtY: (v) => String(v) });
  assert.equal(headLinks().length, 1);

  const snap = await freshCharts({ snapshot: true });
  snap.columns({ data: [{ label: 'A', value: 1 }], fmtY: (v) => String(v) });
  assert.equal(headLinks().length, 0);
});

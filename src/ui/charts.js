/**
 * A small SVG chart library, hand-written so the dashboard has zero runtime
 * dependencies and works with no network access.
 *
 * Every chart here follows the same mark specs: thin marks, hairline solid
 * gridlines, a 2px surface gap between touching fills, a 2px surface ring on
 * overlapping markers, selective direct labels, and a hover layer with hit
 * targets larger than the marks. Colours come from CSS custom properties
 * (--series-1..8, --seq-*), assigned by entity in a fixed order and never by
 * rank, so filtering a series out never repaints the survivors.
 */

const NS = 'http://www.w3.org/2000/svg';

export const SERIES_VARS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];
export const OTHER_COLOR = 'var(--text-muted)';
export const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)'];

/**
 * Stable colour assignment: a key always gets the same slot for the lifetime
 * of the page, so a filter that removes series 2 leaves series 3's colour
 * alone. Past 8 keys everything folds into one muted "Other" — never a
 * generated 9th hue.
 */
export class ColorScale {
  constructor(order = []) {
    this.map = new Map();
    order.forEach((k) => this.get(k));
  }
  get(key) {
    if (key === 'Other' || key === 'other') return OTHER_COLOR;
    if (!this.map.has(key)) {
      const i = this.map.size;
      this.map.set(key, i < SERIES_VARS.length ? SERIES_VARS[i] : OTHER_COLOR);
    }
    return this.map.get(key);
  }
  /** Colours available for all-pairs forms (scatter/bubble) — capped at 3. */
  static ALLPAIRS_LIMIT = 3;
}

export function svg(tag, attrs = {}, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    e.setAttribute(k, String(v));
  }
  for (const k of [].concat(kids)) if (k) e.appendChild(k);
  return e;
}

export function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v; // always textContent: labels are untrusted data
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const k of [].concat(kids)) if (k) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

// ------------------------------------------------------------------ tooltip --

let tipEl = null;
export const tooltip = {
  show(html, ev) {
    if (!tipEl) {
      tipEl = el('div', { class: 'tip', role: 'status' });
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = '';
    tipEl.appendChild(html);
    tipEl.classList.add('on');
    this.move(ev);
  },
  move(ev) {
    if (!tipEl || !ev) return;
    const pad = 14;
    const r = tipEl.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tipEl.style.left = Math.max(6, x) + 'px';
    tipEl.style.top = Math.max(6, y) + 'px';
  },
  hide() {
    if (tipEl) tipEl.classList.remove('on');
  },
};

/** Build a tooltip body: a head line, then value-led rows. */
/**
 * A vertical fade for area fills. A flat 10% fill reads as a smudge under the
 * line; a fade puts the ink where the line is and lets the plot floor go back
 * to being surface. Ids are per-call so two charts on a page never collide.
 */
let gradSeq = 0;
export function areaGradient(root, color, { from = 0.30, to = 0.02 } = {}) {
  const id = `agrad-${++gradSeq}`;
  const defs = svg('defs');
  const g = svg('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' });
  g.appendChild(svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': String(from) }));
  g.appendChild(svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': String(to) }));
  defs.appendChild(g);
  root.appendChild(defs);
  return `url(#${id})`;
}

export function tipBody(head, rows, note) {
  const box = el('div');
  if (head) box.appendChild(el('div', { class: 't-head', text: head }));
  for (const r of rows) {
    const row = el('div', { class: 't-row' });
    if (r.color) {
      const k = el('span', { class: 't-key' });
      k.style.background = r.color;
      row.appendChild(k);
    }
    row.appendChild(el('span', { class: 't-val', text: r.value }));
    row.appendChild(el('span', { class: 't-name', text: r.name }));
    box.appendChild(row);
  }
  if (note) box.appendChild(el('div', { class: 't-note', text: note }));
  return box;
}

// ------------------------------------------------------------------- scales --

export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || max === min) {
    return { ticks: [0, max || 1], min: 0, max: max || 1 };
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, min: lo, max: hi, step };
}

// -------------------------------------------------------------- time series --

/**
 * Multi-series time chart.
 * @param {object} o
 * @param {{key:string}[]} o.data one object per bucket
 * @param {{key:string,label:string,color:string}[]} o.keys series definitions
 * @param {'line'|'stacked'} [o.mode]
 * @param {{values:(number|null)[],label:string,color:string}[]} [o.overlays] moving averages
 * @param {(v:number)=>string} o.fmtY
 * @param {(k:string)=>string} o.fmtX
 * @param {number[]} [o.peaks] indices to mark
 * @param {(i:number, ev:Event)=>void} [o.onClick]
 * @param {(a:number,b:number)=>void} [o.onBrush]
 * @param {number} [o.height]
 */
export function timeSeries(o) {
  const H = o.height || 300;
  const W = o.width || 1000;
  const M = { t: 14, r: 16, b: 26, l: 58 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const data = o.data;
  const keys = o.keys.filter((k) => !k.hidden);
  const n = data.length;

  const stacked = o.mode === 'stacked';
  let maxV = 0;
  const tops = [];
  for (let i = 0; i < n; i++) {
    if (stacked) {
      let s = 0;
      for (const k of keys) s += Math.max(0, data[i][k.key] || 0);
      tops.push(s);
      if (s > maxV) maxV = s;
    } else {
      for (const k of keys) maxV = Math.max(maxV, data[i][k.key] || 0);
    }
  }
  for (const ov of o.overlays || []) for (const v of ov.values) if (v !== null) maxV = Math.max(maxV, v);

  const { ticks, max: yMax } = niceTicks(0, maxV || 1, 5);
  const x = (i) => (n <= 1 ? M.l + iw / 2 : M.l + (i / (n - 1)) * iw);
  const y = (v) => M.t + ih - (Math.max(0, v) / (yMax || 1)) * ih;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': o.ariaLabel || 'time series' });
  root.style.height = H + 'px';

  // gridlines + y ticks (solid hairlines, one step off surface)
  const g = svg('g');
  for (const t of ticks) {
    g.appendChild(svg('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: y(t), y2: y(t) }));
    g.appendChild(svg('text', { class: 'tick', x: M.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' }, [txt(o.fmtY(t))]));
  }
  root.appendChild(g);

  // x ticks: ~7 labels, always including first and last
  const step = Math.max(1, Math.ceil(n / 7));
  const xg = svg('g');
  for (let i = 0; i < n; i += step) {
    xg.appendChild(svg('text', { class: 'tick', x: x(i), y: H - 8, 'text-anchor': 'middle' }, [txt(o.fmtX(data[i].key, i))]));
  }
  if (n > 1 && (n - 1) % step !== 0) {
    xg.appendChild(svg('text', { class: 'tick', x: x(n - 1), y: H - 8, 'text-anchor': 'end' }, [txt(o.fmtX(data[n - 1].key, n - 1))]));
  }
  root.appendChild(xg);
  root.appendChild(svg('line', { class: 'axis-line', x1: M.l, x2: W - M.r, y1: y(0), y2: y(0) }));

  // marks
  if (stacked) {
    const base = new Array(n).fill(0);
    for (const k of keys) {
      const upper = [];
      const lower = [];
      for (let i = 0; i < n; i++) {
        const v = Math.max(0, data[i][k.key] || 0);
        lower.push(base[i]);
        base[i] += v;
        upper.push(base[i]);
      }
      const d = areaPath(upper, lower, x, y);
      root.appendChild(svg('path', { class: 'series-area', d, fill: k.color, 'fill-opacity': 0.85 }));
      // 2px surface gap between touching fills — white doing the separating
      root.appendChild(svg('path', {
        class: 'series-line', d: linePath(upper, x, y),
        stroke: 'var(--surface-1)', 'stroke-width': 2,
      }));
    }
  } else {
    for (const k of keys) {
      const vals = data.map((d) => d[k.key] || 0);
      if (o.fillArea) {
        root.appendChild(svg('path', {
          class: 'series-area', d: areaPath(vals, new Array(n).fill(0), x, y),
          fill: areaGradient(root, k.color),
        }));
      }
      root.appendChild(svg('path', { class: 'series-line', d: linePath(vals, x, y), stroke: k.color }));
    }
  }

  for (const ov of o.overlays || []) {
    root.appendChild(svg('path', {
      class: 'ma-line', d: linePathSparse(ov.values, x, y), stroke: ov.color, 'stroke-opacity': 0.95,
    }));
  }

  // peak markers: a ring, not a label on every point
  for (const pi of o.peaks || []) {
    if (pi < 0 || pi >= n) continue;
    const v = stacked ? tops[pi] : Math.max(...keys.map((k) => data[pi][k.key] || 0));
    root.appendChild(svg('circle', { class: 'peak-mark', cx: x(pi), cy: y(v), r: 5, stroke: 'var(--text-primary)' }));
    root.appendChild(svg('circle', { cx: x(pi), cy: y(v), r: 2, fill: 'var(--text-primary)' }));
  }

  // one direct label: the endpoint of the leading series (selective by design)
  if (o.endLabel && n) {
    const lastVal = stacked ? tops[n - 1] : (data[n - 1][keys[0]?.key] || 0);
    if (lastVal > 0) {
      root.appendChild(svg('text', {
        class: 'tick', x: x(n - 1) - 4, y: y(lastVal) - 8, 'text-anchor': 'end',
        style: 'fill: var(--text-secondary); font-size: 11px; font-weight: 600',
      }, [txt(o.fmtY(lastVal))]));
    }
  }

  // ---- hover layer: crosshair snapping to the nearest X -------------------
  const cross = svg('line', { class: 'crosshair', y1: M.t, y2: M.t + ih, opacity: 0 });
  const dots = svg('g', { opacity: 0 });
  root.appendChild(cross);
  root.appendChild(dots);
  const hit = svg('rect', { class: 'hit', x: M.l, y: M.t, width: iw, height: ih, 'pointer-events': 'all' });
  root.appendChild(hit);

  let brushing = null;
  const brushRect = svg('rect', { class: 'brush-rect', y: M.t, height: ih, width: 0, opacity: 0 });
  root.insertBefore(brushRect, cross);

  const nearest = (ev) => {
    const box = root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    if (n <= 1) return 0;
    const i = Math.round(((px - M.l) / iw) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };

  hit.addEventListener('pointermove', (ev) => {
    const i = nearest(ev);
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('opacity', 1);
    dots.textContent = '';
    dots.setAttribute('opacity', 1);
    let acc = 0;
    const rows = [];
    for (const k of keys) {
      const v = data[i][k.key];
      if (stacked) acc += Math.max(0, v || 0);
      const cy = stacked ? y(acc) : y(v || 0);
      // surface ring keeps the dot legible where it crosses a line
      dots.appendChild(svg('circle', { cx: x(i), cy, r: 4.5, fill: k.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      rows.push({ color: k.color, name: k.label, value: v === null || v === undefined ? 'n/a' : o.fmtY(v) });
    }
    for (const ov of o.overlays || []) {
      const v = ov.values[i];
      if (v === null || v === undefined) continue;
      rows.push({ color: ov.color, name: ov.label, value: o.fmtY(v) });
    }
    if (stacked && keys.length > 1) rows.unshift({ color: null, name: 'Total', value: o.fmtY(tops[i]) });
    tooltip.show(tipBody(o.fmtXLong ? o.fmtXLong(data[i].key) : data[i].key, rows, o.tipNote), ev);
    if (brushing !== null) {
      const a = Math.min(x(brushing), x(i));
      brushRect.setAttribute('x', a);
      brushRect.setAttribute('width', Math.abs(x(i) - x(brushing)));
      brushRect.setAttribute('opacity', 1);
    }
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', 0);
    dots.setAttribute('opacity', 0);
    tooltip.hide();
  });
  if (o.onBrush) {
    hit.addEventListener('pointerdown', (ev) => { brushing = nearest(ev); hit.setPointerCapture(ev.pointerId); });
    hit.addEventListener('pointerup', (ev) => {
      const b = nearest(ev);
      brushRect.setAttribute('opacity', 0);
      const a = brushing;
      brushing = null;
      if (a === null) return;
      if (Math.abs(b - a) < 1) {
        if (o.onClick) o.onClick(b, ev);
        return;
      }
      o.onBrush(Math.min(a, b), Math.max(a, b));
    });
  } else if (o.onClick) {
    hit.addEventListener('click', (ev) => o.onClick(nearest(ev), ev));
  }
  hit.style.cursor = o.onBrush || o.onClick ? 'crosshair' : 'default';
  return root;
}

function linePath(vals, x, y) {
  let d = '';
  vals.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2); });
  return d;
}
function linePathSparse(vals, x, y) {
  let d = '';
  let open = false;
  vals.forEach((v, i) => {
    if (v === null || v === undefined) { open = false; return; }
    d += (open ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2);
    open = true;
  });
  return d;
}
function areaPath(upper, lower, x, y) {
  let d = '';
  upper.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2); });
  for (let i = lower.length - 1; i >= 0; i--) d += 'L' + x(i).toFixed(2) + ' ' + y(lower[i]).toFixed(2);
  return d + 'Z';
}
function txt(s) {
  return document.createTextNode(String(s));
}

// ---------------------------------------------------------------- bar chart --

/** Vertical column chart with a 2px surface gap between adjacent bars. */
export function columns(o) {
  const H = o.height || 220;
  const W = o.width || 1000;
  const M = { t: 14, r: 12, b: 30, l: 52 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const data = o.data;
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value || 0));
  const { ticks, max: yMax } = niceTicks(0, max, 4);
  const band = iw / Math.max(1, n);
  const bw = Math.min(24, Math.max(2, band - 4));
  const y = (v) => M.t + ih - (v / yMax) * ih;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': o.ariaLabel || 'bar chart' });
  root.style.height = H + 'px';
  for (const t of ticks) {
    root.appendChild(svg('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: y(t), y2: y(t) }));
    root.appendChild(svg('text', { class: 'tick', x: M.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' }, [txt(o.fmtY(t))]));
  }
  data.forEach((d, i) => {
    const cx = M.l + band * i + band / 2;
    const h = Math.max(0, ih - (y(d.value || 0) - M.t));
    const bar = svg('rect', {
      x: cx - bw / 2, y: y(d.value || 0), width: bw, height: Math.max(h, d.value ? 1.5 : 0),
      fill: d.color || 'var(--series-1)', rx: Math.min(4, bw / 2), ry: 4,
    });
    root.appendChild(bar);
    // square off the baseline end: the rounded rect's bottom corners are
    // covered so the bar grows from a flat baseline
    if (h > 5) root.appendChild(svg('rect', { x: cx - bw / 2, y: y(0) - 4, width: bw, height: 4, fill: d.color || 'var(--series-1)' }));
    const hitW = Math.max(24, band);
    const hb = svg('rect', { class: 'hit', x: cx - hitW / 2, y: M.t, width: hitW, height: ih, 'pointer-events': 'all' });
    hb.addEventListener('pointermove', (ev) => {
      bar.setAttribute('opacity', 0.78);
      tooltip.show(tipBody(o.fmtXLong ? o.fmtXLong(d) : d.label, [{ color: d.color || 'var(--series-1)', name: o.valueLabel || 'Tokens', value: o.fmtY(d.value) }, ...(d.extra || [])], o.tipNote), ev);
    });
    hb.addEventListener('pointerleave', () => { bar.removeAttribute('opacity'); tooltip.hide(); });
    if (o.onClick) { hb.style.cursor = 'pointer'; hb.addEventListener('click', (ev) => o.onClick(d, ev)); }
    root.appendChild(hb);
    if (n <= 24 || i % Math.ceil(n / 12) === 0) {
      root.appendChild(svg('text', { class: 'tick', x: cx, y: H - 9, 'text-anchor': 'middle' }, [txt(d.label)]));
    }
  });
  root.appendChild(svg('line', { class: 'axis-line', x1: M.l, x2: W - M.r, y1: y(0), y2: y(0) }));
  return root;
}

// ------------------------------------------------------------ horizontal bars

/** DOM (not SVG) horizontal bars — cheaper, and text wraps/ellipsises properly. */
export function hbars(rows, o = {}) {
  const box = el('div');
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  for (const r of rows) {
    const w = ((r.value || 0) / max) * 100;
    const row = el('div', { class: 'bar-row' + (o.onClick ? ' clickable' : '') }, [
      el('span', { class: 'nm', text: r.label, title: r.title || r.label }),
      el('span', { class: 'track' }, [(() => {
        const f = el('span', { class: 'fill' });
        f.style.width = Math.max(w, r.value ? 0.6 : 0) + '%';
        f.style.background = r.color || 'var(--series-1)';
        return f;
      })()]),
      el('span', { class: 'vl', text: o.fmt ? o.fmt(r.value) : String(r.value) }),
    ]);
    if (o.onClick) row.addEventListener('click', (ev) => o.onClick(r, ev));
    row.addEventListener('pointermove', (ev) => tooltip.show(tipBody(r.label, r.rows || [{ color: r.color, name: o.valueLabel || 'Tokens', value: o.fmt ? o.fmt(r.value) : r.value }]), ev));
    row.addEventListener('pointerleave', () => tooltip.hide());
    box.appendChild(row);
  }
  return box;
}

// --------------------------------------------------------------------- donut

export function donut(segments, o = {}) {
  const size = o.size || 190;
  const R = size / 2;
  const thick = o.thickness || 26;
  const r0 = R - thick;
  const total = segments.reduce((a, s) => a + (s.value || 0), 0);
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': o.ariaLabel || 'share' });
  root.style.height = size + 'px';
  root.style.width = size + 'px';
  root.style.flex = 'none';
  if (!total) {
    root.appendChild(svg('circle', { cx: R, cy: R, r: (R + r0) / 2, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': thick }));
    return root;
  }
  // 2px surface gap between adjacent segments
  const gapDeg = segments.length > 1 ? (2 / (Math.PI * (R + r0))) * 360 : 0;
  let a0 = -90;
  segments.forEach((s) => {
    const sweep = ((s.value || 0) / total) * 360;
    if (sweep <= 0) return;
    const a1 = a0 + sweep;
    const p = svg('path', {
      d: ringSlice(R, R, r0, R, a0 + gapDeg / 2, Math.max(a0 + gapDeg / 2 + 0.01, a1 - gapDeg / 2)),
      fill: s.color || 'var(--series-1)',
    });
    p.addEventListener('pointermove', (ev) => {
      p.setAttribute('opacity', 0.8);
      tooltip.show(tipBody(s.label, [
        { color: s.color, name: o.valueLabel || 'Tokens', value: o.fmt ? o.fmt(s.value) : s.value },
        { color: null, name: 'Share', value: ((s.value / total) * 100).toFixed(1) + '%' },
      ]), ev);
    });
    p.addEventListener('pointerleave', () => { p.removeAttribute('opacity'); tooltip.hide(); });
    if (o.onClick) { p.style.cursor = 'pointer'; p.addEventListener('click', (ev) => o.onClick(s, ev)); }
    root.appendChild(p);
    a0 = a1;
  });
  if (o.center) {
    root.appendChild(svg('text', {
      x: R, y: R - 2, 'text-anchor': 'middle',
      style: 'fill: var(--text-primary); font-size: 19px; font-weight: 640',
    }, [txt(o.center.value)]));
    root.appendChild(svg('text', {
      x: R, y: R + 15, 'text-anchor': 'middle',
      style: 'fill: var(--text-muted); font-size: 10.5px',
    }, [txt(o.center.label)]));
  }
  return root;
}

function ringSlice(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => {
    const t = (a * Math.PI) / 180;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

// ---------------------------------------------------------- composition bar --

/** A single stacked horizontal bar with a 2px surface gap between segments. */
export function compositionBar(segments, o = {}) {
  const total = segments.reduce((a, s) => a + (s.value || 0), 0);
  const box = el('div');
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:2px;height:28px;border-radius:6px;overflow:hidden;background:var(--surface-3)';
  for (const s of segments) {
    if (!s.value) continue;
    const seg = el('div');
    seg.style.cssText = `flex:${s.value} 1 0;background:${s.color};position:relative;cursor:${o.onClick ? 'pointer' : 'default'}`;
    seg.addEventListener('pointermove', (ev) => {
      seg.style.filter = 'brightness(1.15)';
      tooltip.show(tipBody(s.label, [
        { color: s.color, name: o.valueLabel || 'Tokens', value: o.fmt ? o.fmt(s.value) : s.value },
        { color: null, name: 'Share', value: ((s.value / total) * 100).toFixed(1) + '%' },
      ]), ev);
    });
    seg.addEventListener('pointerleave', () => { seg.style.filter = ''; tooltip.hide(); });
    if (o.onClick) seg.addEventListener('click', (ev) => o.onClick(s, ev));
    bar.appendChild(seg);
  }
  box.appendChild(bar);
  const legend = el('div', { class: 'legend' });
  for (const s of segments) {
    const sw = el('span', { class: 'sw' });
    sw.style.background = s.color;
    legend.appendChild(el('span', { class: 'item' }, [
      sw,
      el('span', { text: `${s.label} ${total ? ((s.value / total) * 100).toFixed(0) : 0}%` }),
    ]));
  }
  box.appendChild(legend);
  return box;
}

// ------------------------------------------------------------------ calendar

/** GitHub-style year heatmap. Intensity is percentile-based, set by the caller. */
export function calendarHeatmap(days, o = {}) {
  const wrap = el('div');
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  if (!first) return wrap;

  const start = shiftToMonday(first);
  const cols = [];
  let cur = start;
  let guard = 0;
  while (cur <= last && guard++ < 800) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      col.push(cur);
      cur = addDays(cur, 1);
    }
    cols.push(col);
  }

  const months = el('div', { class: 'cal-months' });
  let lastMonth = '';
  for (const col of cols) {
    const m = col[0].slice(0, 7);
    const lbl = m !== lastMonth ? monthShort(m) : '';
    lastMonth = m;
    const c = el('span', { text: lbl });
    c.style.cssText = 'width:12px;flex:none;overflow:visible;white-space:nowrap';
    months.appendChild(c);
  }
  wrap.appendChild(months);

  const body = el('div', { class: 'cal' });
  const dows = el('div', { class: 'cal-dows' });
  ['M', '', 'W', '', 'F', '', 'S'].forEach((d) => dows.appendChild(el('span', { text: d })));
  body.appendChild(dows);

  for (const col of cols) {
    const c = el('div', { class: 'cal-col' });
    for (const date of col) {
      const d = byDate.get(date);
      const lvl = d ? o.levelOf(d.total, d.active) : 0;
      const cell = el('div', {
        class: `cal-cell l${lvl}${d ? '' : ' out'}${o.selected === date ? ' sel' : ''}`,
        role: 'gridcell', tabindex: d ? '0' : '-1',
        'aria-label': `${date}: ${d ? o.fmt(d.total) : 'no data'}`,
      });
      if (d) {
        const showTip = (ev) => tooltip.show(tipBody(o.fmtDate ? o.fmtDate(date) : date, [
          { color: null, name: 'Total', value: o.fmt(d.total) },
          { color: 'var(--series-1)', name: 'Input', value: o.fmt(d.in) },
          { color: 'var(--series-2)', name: 'Output', value: o.fmt(d.out) },
          { color: 'var(--series-3)', name: 'Cache', value: o.fmt(d.cr + d.cw) },
          { color: null, name: 'Requests', value: String(d.req) },
        ], d.active ? 'Click for the full day breakdown' : 'No usage recorded'), ev);
        cell.addEventListener('pointermove', showTip);
        cell.addEventListener('focus', (ev) => showTip({ clientX: cell.getBoundingClientRect().right, clientY: cell.getBoundingClientRect().bottom }));
        cell.addEventListener('pointerleave', () => tooltip.hide());
        cell.addEventListener('blur', () => tooltip.hide());
        if (o.onClick) cell.addEventListener('click', () => o.onClick(date));
        cell.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && o.onClick) o.onClick(date); });
      }
      c.appendChild(cell);
    }
    body.appendChild(c);
  }
  wrap.appendChild(body);

  const lg = el('div', { class: 'cal-legend' });
  lg.appendChild(el('span', { text: 'Less' }));
  for (let i = 0; i <= 5; i++) {
    const s = el('span', { class: `cal-cell l${i}` });
    s.style.cursor = 'default';
    lg.appendChild(s);
  }
  lg.appendChild(el('span', { text: 'More' }));
  if (o.note) lg.appendChild(el('span', { class: 'muted', text: '· ' + o.note }));
  wrap.appendChild(lg);
  return wrap;
}

function shiftToMonday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function monthShort(m) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5, 7)) - 1];
}

// -------------------------------------------------------------- matrix heat --

/** Hour x weekday matrix. One hue, light->dark; a scale legend is mandatory. */
export function matrix(cells, o) {
  const rows = o.rows;
  const cols = o.cols;
  const cw = o.cellW || 26;
  const ch = o.cellH || 20;
  const left = 34;
  const top = 16;
  const W = left + cols.length * cw;
  const H = top + rows.length * ch + 8;
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel || 'heatmap' });
  root.style.height = H + 'px';
  const max = o.max || Math.max(1, ...cells.map((c) => c.value));

  cols.forEach((c, i) => {
    if (i % (o.colLabelEvery || 2) !== 0) return;
    root.appendChild(svg('text', { class: 'tick', x: left + i * cw + cw / 2, y: 11, 'text-anchor': 'middle' }, [txt(c)]));
  });
  rows.forEach((r, j) => {
    root.appendChild(svg('text', { class: 'tick', x: left - 7, y: top + j * ch + ch / 2 + 3.5, 'text-anchor': 'end' }, [txt(r)]));
  });

  for (const cell of cells) {
    const v = cell.value;
    const t = max ? v / max : 0;
    const idx = v <= 0 ? -1 : Math.min(SEQ.length - 1, Math.floor(Math.pow(t, 0.55) * SEQ.length));
    const rect = svg('rect', {
      x: left + cell.col * cw + 1, y: top + cell.row * ch + 1,
      width: cw - 2, height: ch - 2, rx: 3,
      fill: idx < 0 ? 'var(--surface-3)' : SEQ[idx],
    });
    rect.addEventListener('pointermove', (ev) => {
      rect.setAttribute('stroke', 'var(--text-primary)');
      rect.setAttribute('stroke-width', '1.5');
      tooltip.show(tipBody(cell.label, [{ color: idx < 0 ? null : SEQ[idx], name: o.valueLabel || 'Tokens', value: o.fmt(v) }, ...(cell.extra || [])]), ev);
    });
    rect.addEventListener('pointerleave', () => { rect.removeAttribute('stroke'); tooltip.hide(); });
    if (o.onClick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', (ev) => o.onClick(cell, ev)); }
    root.appendChild(rect);
  }
  return root;
}

export function scaleLegend(max, fmt) {
  const box = el('div', { class: 'cal-legend' });
  box.appendChild(el('span', { text: '0' }));
  for (const c of SEQ) {
    const s = el('span');
    s.style.cssText = `width:16px;height:10px;border-radius:2px;background:${c}`;
    box.appendChild(s);
  }
  box.appendChild(el('span', { text: fmt(max) }));
  return box;
}

// -------------------------------------------------------------------- scatter

/**
 * Bubble scatter. Colour groups are capped at 3 because a scatter needs
 * all-pairs colour separation, not just adjacent-pair — past three, everything
 * else becomes a muted "Other" and identity comes from the tooltip and table.
 */
export function scatter(points, o) {
  const H = o.height || 320;
  const W = o.width || 900;
  const M = { t: 16, r: 24, b: 54, l: 62 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const xs = points.map((p) => p.x).filter((v) => v !== null && isFinite(v));
  const ys = points.map((p) => p.y).filter((v) => v !== null && isFinite(v));
  const xt = niceTicks(0, Math.max(1, ...xs), 5);
  const yt = niceTicks(0, Math.max(1, ...ys), 4);
  const rMax = Math.max(1, ...points.map((p) => p.r || 0));
  const X = (v) => M.l + (v / xt.max) * iw;
  const Y = (v) => M.t + ih - (v / yt.max) * ih;
  const R = (v) => 4 + Math.sqrt((v || 0) / rMax) * 20;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': o.ariaLabel || 'scatter' });
  root.style.height = H + 'px';
  for (const t of yt.ticks) {
    root.appendChild(svg('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t) }));
    root.appendChild(svg('text', { class: 'tick', x: M.l - 8, y: Y(t) + 3.5, 'text-anchor': 'end' }, [txt(o.fmtY(t))]));
  }
  for (const t of xt.ticks) {
    root.appendChild(svg('text', { class: 'tick', x: X(t), y: H - 32, 'text-anchor': 'middle' }, [txt(o.fmtX(t))]));
  }
  root.appendChild(svg('text', {
    class: 'tick', x: M.l + iw / 2, y: H - 10, 'text-anchor': 'middle',
    style: 'fill: var(--text-secondary)',
  }, [txt(o.xLabel || '')]));
  root.appendChild(svg('text', {
    class: 'tick', x: 12, y: M.t + ih / 2, 'text-anchor': 'middle',
    transform: `rotate(-90 12 ${M.t + ih / 2})`,
  }, [txt(o.yLabel || '')]));
  root.appendChild(svg('line', { class: 'axis-line', x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0) }));

  const sorted = [...points].sort((a, b) => (b.r || 0) - (a.r || 0));
  for (const p of sorted) {
    if (p.x === null || p.y === null || !isFinite(p.x) || !isFinite(p.y)) continue;
    const c = svg('circle', {
      cx: X(p.x), cy: Y(p.y), r: R(p.r), fill: p.color, 'fill-opacity': 0.55,
      stroke: 'var(--surface-1)', 'stroke-width': 2,
    });
    root.appendChild(c);
    // hit target of at least 24px, independent of the mark's own radius
    const hitR = Math.max(12, R(p.r));
    const h = svg('circle', { cx: X(p.x), cy: Y(p.y), r: hitR, fill: 'transparent', 'pointer-events': 'all' });
    h.addEventListener('pointermove', (ev) => {
      c.setAttribute('fill-opacity', 0.9);
      tooltip.show(tipBody(p.label, p.rows || []), ev);
    });
    h.addEventListener('pointerleave', () => { c.setAttribute('fill-opacity', 0.55); tooltip.hide(); });
    if (o.onClick) { h.style.cursor = 'pointer'; h.addEventListener('click', (ev) => o.onClick(p, ev)); }
    root.appendChild(h);
  }
  // label only the extremes, never every point
  const extremes = [...sorted].slice(0, 3);
  for (const p of extremes) {
    if (p.x === null || p.y === null) continue;
    root.appendChild(svg('text', {
      class: 'tick', x: X(p.x), y: Y(p.y) - R(p.r) - 5, 'text-anchor': 'middle',
      style: 'fill: var(--text-secondary); font-size: 10.5px',
    }, [txt(p.short || p.label)]));
  }
  return root;
}

// ------------------------------------------------------------------ sparkline

export function sparkline(values, o = {}) {
  const W = o.width || 120;
  const H = o.height || 26;
  const n = values.length;
  if (!n) return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}` });
  const max = Math.max(1, ...values);
  const x = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => H - 2 - ((v || 0) / max) * (H - 4);
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  root.style.height = H + 'px';
  root.appendChild(svg('path', {
    d: areaPath(values, new Array(n).fill(0), x, (v) => y(v)),
    fill: areaGradient(root, o.color || 'var(--series-1)', { from: 0.34, to: 0.0 }), stroke: 'none',
  }));
  root.appendChild(svg('path', { d: linePath(values, x, y), class: 'series-line', stroke: o.color || 'var(--series-1)', 'stroke-width': 1.6 }));
  root.appendChild(svg('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 2.4, fill: o.color || 'var(--series-1)' }));
  return root;
}

// ------------------------------------------------------------------- legend --

export function legend(items, o = {}) {
  const box = el('div', { class: 'legend' });
  for (const it of items) {
    const sw = el('span', { class: 'sw' + (o.line ? ' line' : '') });
    sw.style.background = it.color;
    const b = el('span', {
      class: 'item', role: o.onToggle ? 'button' : null,
      'aria-pressed': o.onToggle ? String(!it.hidden) : null, tabindex: o.onToggle ? '0' : null,
    }, [sw, el('span', { text: it.label })]);
    if (o.onToggle) {
      b.addEventListener('click', () => o.onToggle(it));
      b.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); o.onToggle(it); } });
    }
    box.appendChild(b);
  }
  return box;
}

// -------------------------------------------------------------- table twin --

/**
 * The WCAG-clean twin of a chart. Every chart in the dashboard has one, so no
 * value is ever reachable only by hovering.
 */
export function table(columns, rows, o = {}) {
  const wrap = el('div', { class: 'tbl-wrap' + (o.tall ? ' tall' : '') });
  const t = el('table', { class: 'tbl' });
  const thead = el('thead');
  const tr = el('tr');
  for (const c of columns) {
    const th = el('th', { class: o.onSort ? '' : 'no-sort', text: c.label, title: c.title || '' });
    if (o.onSort) th.addEventListener('click', () => o.onSort(c.key));
    if (o.sortKey === c.key) th.textContent = `${c.label} ${o.sortDir === 'asc' ? '↑' : '↓'}`;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    for (const c of columns) {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
      const td = el('td', { class: c.text ? 't' : '' });
      if (v === null || v === undefined || v === '') {
        td.appendChild(el('span', { class: 'na', text: c.na || '—', title: c.naTitle || 'Not available' }));
      } else if (v instanceof Node) {
        td.appendChild(v);
      } else {
        td.textContent = String(v);
      }
      if (c.onClick) {
        td.classList.add('link-cell');
        td.addEventListener('click', () => c.onClick(r));
      }
      row.appendChild(td);
    }
    if (o.onRowClick) { row.style.cursor = 'pointer'; row.addEventListener('click', () => o.onRowClick(r)); }
    tb.appendChild(row);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  if (!rows.length) wrap.appendChild(el('div', { class: 'empty', text: o.emptyText || 'No rows match the current filters.' }));
  return wrap;
}

/** Inline mini-bar for a table cell (share-of-max), as a DOM node. */
export function miniBar(frac, color) {
  const s = el('span', { class: 'mini' });
  s.style.width = Math.max(2, (frac || 0) * 56) + 'px';
  if (color) s.style.background = color;
  return s;
}

/** Responsive width helper: charts re-render at the container's real width. */
export function observeWidth(node, render) {
  let last = 0;
  const run = () => {
    const w = Math.max(320, Math.floor(node.clientWidth));
    if (Math.abs(w - last) < 8) return;
    last = w;
    render(w);
  };
  run();
  const ro = new ResizeObserver(run);
  ro.observe(node);
  return () => ro.disconnect();
}

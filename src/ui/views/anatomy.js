/**
 * Session anatomy: pick one session and see where its money went.
 *
 * Every other tab aggregates. This one does the opposite: it takes a single
 * session's turns and draws the shape of the spend — the waterfall of turn
 * costs against the running total, the prompt growing as the context fills,
 * the block of subagent turns, and the turn where per-turn cost stepped up and
 * stayed up.
 *
 * Turn-level records are the one thing the bundle does not carry, so this tab
 * fetches them from /api/session and degrades to the picker plus an empty
 * state in a saved snapshot, which has no server to ask.
 *
 * Cost here is estimated in the browser from the same price book the Cost tab
 * uses, never from a stored total, and an unpriced turn stays null all the way
 * to the screen.
 */
import { el, svg, niceTicks, tooltip, tipBody, timeSeries, compositionBar, legend, areaGradient } from '../charts.js';
import { buildPriceBook } from '../../core/pricing.js';
import { MEASUREMENT } from '../../core/schema.js';
import { turnSeries, summarizeTurns, detectStep, fanOut, sessionKind, STEP_WINDOW, STEP_RATIO, STEP_MIN_ABS } from '../../analytics/anatomy.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'anatomy';
export const label = 'Session anatomy';
export const order = 25;
export const css = './styles/anatomy.css';

/** Sessions offered in the picker, most expensive first. */
const PICK_LIMIT = 50;

/** The only measurement with per-request records behind it. */
const PRIMARY = MEASUREMENT.PRIMARY;

const MAIN_COLOR = 'var(--series-1)';
const SUB_COLOR = 'var(--series-2)';
const CUM_COLOR = 'var(--series-3)';

/**
 * This tab's slice of dashboard state. app.js owns `S`; `S.anatomy` is ours.
 * @param {ViewContext} ctx
 */
function state(ctx) {
  if (!ctx.S.anatomy) {
    ctx.S.anatomy = { id: null, filter: '', data: null, loading: false, error: null };
  }
  return ctx.S.anatomy;
}

/**
 * Load one session's turns. A snapshot never gets here: it has no server, and
 * `view()` renders the empty state instead of a control that cannot work.
 * @param {ViewContext} ctx
 * @param {string} sessionId
 */
async function load(ctx, sessionId) {
  const st = state(ctx);
  st.id = sessionId;
  st.data = null;
  st.error = null;
  st.loading = true;
  ctx.rerender({ recompute: false });
  try {
    const res = await ctx.fetchJson(`/api/session?id=${encodeURIComponent(sessionId)}`);
    // A second pick while this one was in flight wins; drop the stale answer.
    if (state(ctx).id !== sessionId) return;
    st.data = res;
  } catch (err) {
    if (state(ctx).id !== sessionId) return;
    st.error = err.message;
  }
  st.loading = false;
  ctx.rerender({ recompute: false });
}

/**
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  const st = state(ctx);
  const root = el('div', { class: 'grid' });
  root.appendChild(pickerCard(ctx));

  if (ctx.snapshot) {
    root.appendChild(ctx.card(
      'Turn detail',
      'Request-level records stay on your machine. A saved file carries the bundle, not the turns.',
      ctx.emptyCard('Turn-level detail needs the live dashboard.', 'Run tokenflow dashboard.'),
    ));
    return root;
  }

  if (st.error) {
    root.appendChild(ctx.card('Turn detail', 'The request for this session failed.', el('p', {
      class: 'hint anatomy-error', text: st.error,
    })));
    return root;
  }
  if (st.loading) {
    root.appendChild(ctx.card('Turn detail', 'Reading this session from the store.', el('div', {
      class: 'anatomy-loading',
    }, [el('span', { class: 'anatomy-dot' }), el('span', { text: `Loading turns for ${st.id}` })])));
    return root;
  }
  if (!st.data) return root;

  const records = st.data.records || [];
  if (sessionKind(records) === 'session-level') {
    root.appendChild(ctx.card(
      'Turn detail',
      `${st.data.session?.source || 'This source'} reports totals, not requests.`,
      ctx.emptyCard('This source records one row per session, so there is no per-turn view.',
        'The totals for it are on the Overview and Cost tabs.'),
    ));
    return root;
  }

  const book = buildPriceBook(ctx.bundle?.pricing || {});
  const series = turnSeries(records, book);
  const sum = summarizeTurns(series);
  if (!series.length) {
    root.appendChild(ctx.card('Turn detail', 'This session has no primary records in the store.',
      ctx.emptyCard('No turns to show.', 'The session row exists, but its records were superseded or removed.')));
    return root;
  }

  root.appendChild(waterfallCard(ctx, series, sum));
  root.appendChild(contextCard(ctx, series, sum));
  root.appendChild(fanOutCard(ctx, series));
  root.appendChild(stepCard(ctx, series));
  return root;
}

/** Fetch on entry when a session is already picked, so a repaint keeps it. */
export function onEnter(ctx) {
  if (ctx.snapshot) return;
  const st = state(ctx);
  if (st.id && !st.data && !st.loading && !st.error) load(ctx, st.id);
}

// ------------------------------------------------------------------- picker --

/**
 * Sessions matching the filter, most expensive first.
 *
 * Only primary sessions are offered. `Store#upsertSession` files a row for
 * every measurement, so the bundle also carries activity-only sessions (Cline,
 * Cursor, git) with no tokens at all and overlay sessions (Headroom) that
 * re-describe traffic another adapter already counted. The route returns
 * primary records, so offering either would open a session that can only
 * answer "no turns".
 *
 * Filtering happens over the whole list before the top 50 is taken, or a
 * search for a cheap project would find nothing.
 */
function pickList(ctx) {
  const q = state(ctx).filter.trim().toLowerCase();
  const all = (ctx.bundle?.sessions || []).filter((s) => s.ms === PRIMARY);
  const hit = q
    ? all.filter((s) => `${s.id} ${s.pj} ${s.rp} ${s.br} ${s.d} ${s.m} ${s.so}`.toLowerCase().includes(q))
    : all.slice();
  hit.sort((a, b) => (b.cost || 0) - (a.cost || 0) || (b.req || 0) - (a.req || 0));
  return { rows: hit.slice(0, PICK_LIMIT), total: hit.length };
}

function pickerCard(ctx) {
  const st = state(ctx);
  const body = el('div', { class: 'anatomy-picker' });

  const search = el('input', {
    type: 'search',
    class: 'tf-input anatomy-search',
    placeholder: 'Filter by project, branch, date or model',
    'aria-label': 'Filter sessions',
    value: st.filter,
  });
  const rows = el('div', { class: 'anatomy-rows' });
  const count = el('p', { class: 'hint anatomy-count' });

  const paint = () => {
    const { rows: list, total } = pickList(ctx);
    rows.textContent = '';
    rows.appendChild(pickHead());
    for (const s of list) rows.appendChild(pickRow(ctx, s));
    if (!list.length) {
      rows.appendChild(el('p', { class: 'hint', text: 'No session matches that filter.' }));
    }
    count.textContent = total > list.length
      ? `Showing the ${list.length} most expensive of ${total} sessions.`
      : `${total} session${total === 1 ? '' : 's'}.`;
  };
  // Repainting only the list keeps the caret in the box; a full re-render on
  // every keystroke would rebuild the input and lose focus.
  search.addEventListener('input', () => { st.filter = /** @type {HTMLInputElement} */ (search).value; paint(); });
  paint();

  body.appendChild(search);
  body.appendChild(count);
  body.appendChild(rows);

  const hint = ctx.snapshot
    ? 'Totals come from the saved bundle. Turn detail needs the live dashboard.'
    : 'Pick a session to see its turns. The most expensive come first.';
  return ctx.card('Sessions', hint, body, st.id && !ctx.snapshot
    ? ctx.btn('Clear selection', () => {
      const s = state(ctx);
      s.id = null; s.data = null; s.error = null; s.loading = false;
      ctx.rerender({ recompute: false });
    }, 'ghost sm')
    : null);
}

function pickHead() {
  const head = el('div', { class: 'anatomy-row anatomy-row-head' });
  for (const [text, cls] of [['Session', ''], ['Project', ''], ['Branch', ''], ['Date', ''], ['Model', ''], ['Turns', 'num'], ['Cost (est.)', 'num']]) {
    head.appendChild(el('span', { class: cls, text }));
  }
  return head;
}

function pickRow(ctx, s) {
  const { usd, int, shortDate } = ctx.fmt;
  const st = state(ctx);
  const cells = [
    el('span', { class: 'mono anatomy-id', text: s.id, title: s.id }),
    el('span', { text: s.pj || 'n/a' }),
    el('span', { text: s.br || 'n/a' }),
    el('span', { text: s.d ? shortDate(s.d) : 'n/a' }),
    el('span', { class: 'anatomy-model', text: s.m || 'n/a', title: s.m || 'Not available' }),
    el('span', { class: 'num', text: int(s.req, 'n/a') }),
    el('span', { class: 'num', text: usd(s.cost, 'n/a') }),
  ];
  // A saved file cannot fetch the turns, so its rows are readable, not clickable.
  const row = el(ctx.snapshot ? 'div' : 'button', {
    class: 'anatomy-row' + (st.id === s.id ? ' is-picked' : ''),
    'data-session-id': s.id,
    type: ctx.snapshot ? null : 'button',
  }, cells);
  if (!ctx.snapshot) row.addEventListener('click', () => load(ctx, s.id));
  return row;
}

// ---------------------------------------------------------------- waterfall --

/**
 * Bars run from the running total before the turn to the running total after
 * it, so every bar is that turn's cost and the tops trace the cumulative line.
 * One dollar axis carries both, which a bare per-turn bar chart beside a
 * cumulative line could not do at a readable scale.
 */
function waterfall(ctx, series, w) {
  const { usd, int } = ctx.fmt;
  const H = 280;
  const M = { t: 16, r: 16, b: 26, l: 64 };
  const maxCum = Math.max(0, ...series.map((t) => t.cumulative ?? 0));
  const { ticks, max: yMax } = niceTicks(0, maxCum || 1, 5);
  M.l = Math.max(M.l, Math.ceil(Math.max(...ticks.map((t) => usd(t).length)) * 6.6) + 18);
  const iw = Math.max(40, w - M.l - M.r);
  const ih = H - M.t - M.b;
  const n = series.length;
  const band = iw / Math.max(1, n);
  const x = (i) => M.l + band * i + band / 2;
  const y = (v) => M.t + ih - (Math.max(0, v) / (yMax || 1)) * ih;

  const root = svg('svg', {
    class: 'chart', viewBox: `0 0 ${w} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': 'Cost per turn as a waterfall, with the cumulative total',
  });
  root.style.height = H + 'px';
  for (const t of ticks) {
    root.appendChild(svg('line', { class: 'grid-line', x1: M.l, x2: w - M.r, y1: y(t), y2: y(t) }));
    root.appendChild(svg('text', { class: 'tick', x: M.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' }, [text(usd(t))]));
  }

  // The money already spent, as ground under the curve. It is the same number
  // the line traces, so it takes the line's colour rather than a fourth one,
  // which also leaves the per-turn ribbon its own hue to be read against.
  const spent = series.filter((t) => t.cumulative !== null);
  if (spent.length) {
    let area = `M${x(spent[0].index).toFixed(2)} ${y(0).toFixed(2)}`;
    for (const t of spent) area += `L${x(t.index).toFixed(2)} ${y(t.cumulative).toFixed(2)}`;
    area += `L${x(spent[spent.length - 1].index).toFixed(2)} ${y(0).toFixed(2)}Z`;
    root.appendChild(svg('path', { class: 'series-area', d: area, fill: areaGradient(root, CUM_COLOR) }));
  }

  // Each bar runs from the running total before the turn to the running total
  // after it, so the bars tile into a ribbon whose thickness is what that turn
  // cost. Bands touch rather than leaving a gap: at 500 turns a gap would eat
  // the bar. A floor of 3px keeps a cheap turn visible at all.
  const bw = band > 6 ? band - 1 : band;
  for (const t of series) {
    if (t.cost === null || t.cumulative === null) continue;
    const top = y(t.cumulative);
    const bottom = y(t.cumulative - t.cost);
    root.appendChild(svg('rect', {
      x: x(t.index) - bw / 2, y: top, width: bw, height: Math.max(3, bottom - top),
      fill: t.subagent ? SUB_COLOR : MAIN_COLOR,
    }));
  }

  let d = '';
  let open = false;
  for (const t of series) {
    if (t.cumulative === null) { open = false; continue; }
    d += (open ? 'L' : 'M') + x(t.index).toFixed(2) + ' ' + y(t.cumulative).toFixed(2);
    open = true;
  }
  root.appendChild(svg('path', { class: 'series-line', d, stroke: CUM_COLOR, fill: 'none', 'stroke-width': 1.5 }));

  // x ticks: about seven turn numbers, first and last always shown
  const step = Math.max(1, Math.ceil(n / 7));
  for (let i = 0; i < n; i += step) {
    root.appendChild(svg('text', { class: 'tick', x: x(i), y: H - 8, 'text-anchor': 'middle' }, [text(String(i + 1))]));
  }
  root.appendChild(svg('line', { class: 'axis-line', x1: M.l, x2: w - M.r, y1: y(0), y2: y(0) }));

  // One hit area with a crosshair, not one listener per bar: a 500-turn
  // session would otherwise carry a thousand extra nodes.
  const cross = svg('line', { class: 'crosshair', y1: M.t, y2: M.t + ih, opacity: 0 });
  const dot = svg('circle', { r: 4.5, fill: CUM_COLOR, stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 });
  root.appendChild(cross);
  root.appendChild(dot);
  const hit = svg('rect', { class: 'hit', x: M.l, y: M.t, width: iw, height: ih, 'pointer-events': 'all' });
  root.appendChild(hit);
  hit.addEventListener('pointermove', (ev) => {
    const box = root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * w;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - M.l) / band)));
    const t = series[i];
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('opacity', '1');
    if (t.cumulative !== null) {
      dot.setAttribute('cx', String(x(i)));
      dot.setAttribute('cy', String(y(t.cumulative)));
      dot.setAttribute('opacity', '1');
    } else {
      dot.setAttribute('opacity', '0');
    }
    tooltip.show(tipBody(`Turn ${t.turn}${t.subagent ? ' (subagent)' : ''}`, [
      { color: t.subagent ? SUB_COLOR : MAIN_COLOR, name: 'This turn', value: usd(t.cost, 'n/a') },
      { color: CUM_COLOR, name: 'Running total', value: usd(t.cumulative, 'n/a') },
      { color: null, name: 'Prompt', value: t.promptTokens === null ? 'n/a' : int(t.promptTokens) },
      { color: null, name: 'Model', value: t.model || 'n/a' },
    ]), ev);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    tooltip.hide();
  });

  const wrap = el('div');
  wrap.appendChild(root);
  wrap.appendChild(legend([
    { color: MAIN_COLOR, label: 'Turn cost' },
    { color: SUB_COLOR, label: 'Subagent turn' },
    { color: CUM_COLOR, label: 'Running total' },
  ]));
  return wrap;
}

function waterfallCard(ctx, series, sum) {
  const { usd, int, relativeTime } = ctx.fmt;
  const st = state(ctx);
  const parts = [
    `${int(series.length)} turns`,
    `${usd(sum.cost, 'n/a')} estimated`,
  ];
  if (sum.unpriced) parts.push(`${int(sum.unpriced)} turns unpriced`);
  if (st.data.truncated) parts.push(`showing the first ${int(st.data.returned)} of ${int(st.data.total)}`);
  if (sum.from) parts.push(`started ${relativeTime(sum.from)}`);

  return ctx.chartCard(
    'anatomy-waterfall',
    'Cost waterfall',
    `${parts.join(' · ')}. Each bar is one turn, stacked on the running total. Estimated from the price table, never from a vendor invoice.`,
    (w) => waterfall(ctx, series, w),
    {
      columns: [
        { key: 'turn', label: 'Turn', na: 'n/a' },
        { key: 'ts', label: 'Time', na: 'n/a', value: (r) => (r.ts ? r.ts.slice(11, 19) : null) },
        { key: 'model', label: 'Model', na: 'n/a', text: true },
        { key: 'kind', label: 'Kind', na: 'n/a', value: (r) => (r.subagent ? 'subagent' : r.category || 'main') },
        { key: 'cost', label: 'Cost', na: 'n/a', value: (r) => usd(r.cost, 'n/a') },
        { key: 'cumulative', label: 'Running total', na: 'n/a', value: (r) => usd(r.cumulative, 'n/a') },
        { key: 'promptTokens', label: 'Prompt', na: 'n/a', value: (r) => int(r.promptTokens, 'n/a') },
        { key: 'output', label: 'Output', na: 'n/a', value: (r) => int(r.output, 'n/a') },
      ],
      rows: series,
      tall: true,
      emptyText: 'This session has no turns.',
    },
  );
}

// ----------------------------------------------------------- context growth --

function contextCard(ctx, series, sum) {
  const { compact, int, pct } = ctx.fmt;
  const data = series.map((t) => ({
    key: t.turn,
    cacheRead: t.cacheRead,
    input: t.input,
    cacheWrite: t.cacheWrite,
  }));
  const keys = [
    { key: 'cacheRead', label: 'Cache read', color: MAIN_COLOR },
    { key: 'input', label: 'Fresh input', color: SUB_COLOR },
    { key: 'cacheWrite', label: 'Cache write', color: CUM_COLOR },
  ];
  const grew = sum.promptFirst !== null && sum.promptLast !== null
    ? `Prompt went from ${compact(sum.promptFirst)} to ${compact(sum.promptLast)} tokens`
    : 'Prompt size is not reported by this source';

  return ctx.chartCard(
    'anatomy-context',
    'Context growth',
    `${grew}. Peak ${compact(sum.promptPeak)}. Cache read is ${pct(sum.cacheReadShare, 0, 'n/a')} of all prompt tokens. Prompt size is fresh input plus cache read plus cache write.`,
    (w) => {
      const chart = timeSeries({
        data, keys, width: w, height: 260, mode: 'stacked',
        fmtY: (v) => compact(v),
        fmtX: (k) => String(k),
        fmtXLong: (k) => `Turn ${k}`,
        ariaLabel: 'Prompt tokens per turn, split into cache read, fresh input and cache write',
      });
      const wrap = el('div');
      wrap.appendChild(chart);
      wrap.appendChild(legend(keys.map((k) => ({ color: k.color, label: k.label }))));
      return wrap;
    },
    {
      columns: [
        { key: 'turn', label: 'Turn', na: 'n/a' },
        { key: 'cacheRead', label: 'Cache read', na: 'n/a', value: (r) => int(r.cacheRead, 'n/a') },
        { key: 'input', label: 'Fresh input', na: 'n/a', value: (r) => int(r.input, 'n/a') },
        { key: 'cacheWrite', label: 'Cache write', na: 'n/a', value: (r) => int(r.cacheWrite, 'n/a') },
        { key: 'promptTokens', label: 'Prompt total', na: 'n/a', value: (r) => int(r.promptTokens, 'n/a') },
        { key: 'cacheReadShare', label: 'Cache read share', na: 'n/a', value: (r) => pct(r.cacheReadShare, 0, 'n/a') },
      ],
      rows: series,
      tall: true,
      emptyText: 'This session has no turns.',
    },
  );
}

// --------------------------------------------------------------- subagents --

function fanOutCard(ctx, series) {
  const { usd, int, pct } = ctx.fmt;
  const f = fanOut(series);
  const shareText = (v) => pct(v, 0, 'n/a');

  if (!f.subagentTurns) {
    return ctx.card('Subagent fan-out', 'Turns marked as a subagent by the source, never inferred from a model or a gap.',
      ctx.emptyCard('No subagent turns in this session.', 'Every turn ran on the main agent.'));
  }

  const note = f.grouped
    ? 'Subagent turns are grouped by position. The logs record no parent link.'
    : 'Built from the parent link the source recorded.';
  const basis = f.shareBasis === 'cost' ? 'share of estimated cost' : 'share of turns (no turn in this session is priced)';

  if (f.grouped) {
    const segments = f.groups.map((g) => ({
      label: `${g.kind === 'subagent' ? 'Subagent' : 'Main'} ${g.startTurn} to ${g.endTurn}`,
      value: f.shareBasis === 'cost' ? (g.cost ?? 0) : g.turns,
      color: g.kind === 'subagent' ? SUB_COLOR : MAIN_COLOR,
    }));
    return ctx.chartCard(
      'anatomy-fanout',
      'Subagent fan-out',
      `${int(f.subagentTurns)} of ${int(f.turns)} turns ran as a subagent, ${shareText(f.cost ? (f.subagentCost ?? 0) / f.cost : null)} of the spend. Segments are in turn order, sized by ${basis}. ${note}`,
      () => compositionBar(segments, {
        valueLabel: f.shareBasis === 'cost' ? 'Cost' : 'Turns',
        fmt: (v) => (f.shareBasis === 'cost' ? usd(v, 'n/a') : int(v, 'n/a')),
      }),
      {
        columns: [
          { key: 'kind', label: 'Run', na: 'n/a' },
          { key: 'startTurn', label: 'First turn', na: 'n/a' },
          { key: 'endTurn', label: 'Last turn', na: 'n/a' },
          { key: 'turns', label: 'Turns', na: 'n/a', value: (r) => int(r.turns, 'n/a') },
          { key: 'cost', label: 'Cost', na: 'n/a', value: (r) => usd(r.cost, 'n/a') },
          { key: 'share', label: 'Share', na: 'n/a', value: (r) => shareText(r.share) },
        ],
        rows: f.groups,
        emptyText: 'No runs to show.',
      },
    );
  }

  const flat = [];
  const walk = (node) => { flat.push(node); for (const c of node.children) walk(c); };
  for (const r of f.roots) walk(r);
  return ctx.chartCard(
    'anatomy-fanout',
    'Subagent fan-out',
    `${int(f.subagentTurns)} of ${int(f.turns)} turns ran as a subagent. Sized by ${basis}. ${note}`,
    () => {
      const box = el('div', { class: 'anatomy-tree' });
      for (const node of flat) {
        const line = el('div', { class: 'anatomy-branch' });
        line.style.paddingLeft = `${node.depth * 18}px`;
        const swatch = el('span', { class: 'anatomy-swatch' });
        swatch.style.background = node.depth ? SUB_COLOR : MAIN_COLOR;
        line.appendChild(swatch);
        line.appendChild(el('span', { class: 'anatomy-branch-name', text: node.label }));
        line.appendChild(el('span', { class: 'hint', text: `turns ${node.startTurn} to ${node.endTurn} · ${int(node.turns)} turns · ${usd(node.cost, 'n/a')} · ${shareText(node.share)}` }));
        box.appendChild(line);
      }
      return box;
    },
    {
      columns: [
        { key: 'label', label: 'Agent', na: 'n/a' },
        { key: 'depth', label: 'Depth', na: 'n/a' },
        { key: 'startTurn', label: 'First turn', na: 'n/a' },
        { key: 'endTurn', label: 'Last turn', na: 'n/a' },
        { key: 'turns', label: 'Turns', na: 'n/a', value: (r) => int(r.turns, 'n/a') },
        { key: 'cost', label: 'Cost', na: 'n/a', value: (r) => usd(r.cost, 'n/a') },
        { key: 'share', label: 'Share', na: 'n/a', value: (r) => shareText(r.share) },
      ],
      rows: flat,
      emptyText: 'No branches to show.',
    },
  );
}

// -------------------------------------------------------------- step change --

function stepCard(ctx, series) {
  const { usd, int } = ctx.fmt;
  const step = detectStep(series);
  const body = el('div', { class: 'anatomy-step' });
  if (step) {
    body.appendChild(el('p', {
      class: 'anatomy-step-line',
      text: `Per-turn cost stepped from ${usd(step.from, 'n/a')} to ${usd(step.to, 'n/a')} at turn ${int(step.turn)}.`,
    }));
    body.appendChild(el('p', {
      class: 'hint',
      text: `That is ${step.ratio === Infinity ? 'a rise from zero' : `${step.ratio.toFixed(1)}x`}, and ${usd(step.step, 'n/a')} more per turn. Both figures are medians, so one expensive turn cannot cause this.`,
    }));
  } else {
    body.appendChild(el('p', { class: 'anatomy-step-line', text: 'No step found.' }));
    body.appendChild(el('p', {
      class: 'hint',
      text: series.length < STEP_WINDOW * 2
        ? `A step needs ${int(STEP_WINDOW)} turns on each side to compare. This session has ${int(series.length)}.`
        : 'Per-turn cost never doubled and stayed doubled.',
    }));
  }
  return ctx.card(
    'Step change',
    `The median of the ${int(STEP_WINDOW)} turns before a point against the ${int(STEP_WINDOW)} after. A step needs both a ${STEP_RATIO}x rise and at least ${usd(STEP_MIN_ABS, 'n/a')} more per turn.`,
    body,
  );
}

function text(s) {
  return document.createTextNode(String(s));
}

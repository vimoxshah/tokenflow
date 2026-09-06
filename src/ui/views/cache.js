/**
 * The Cache health tab: is the prompt cache doing its job.
 *
 * The prompt cache is where most of the money goes: a cache hit is cheap, a
 * cache miss re-sends the whole context. Two halves, kept apart on purpose:
 *
 *  - hit rate, write split and the per-model table come from the cube
 *    (ctx.view), so they work offline, in a snapshot, everywhere.
 *  - churn events come from request-level records through /api/cache-health,
 *    so they are live-dashboard only. A snapshot shows why instead of a dead
 *    control (see docs/ui-views.md, "Working offline").
 */
import { el, timeSeries } from '../charts.js';
import { hitRateSeries, writeSplitSeries } from '../../analytics/cache-health.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'cache';
export const label = 'Cache health';
export const order = 95;
export const css = './styles/cache.css';

/**
 * Fetch state for the churn card, kept in the module rather than in `ctx.S`
 * because the churn endpoint has nothing to do with the global filter bar
 * beyond the date window. `key` is the from/to pair the current data (or
 * in-flight fetch) answers; `view()` compares it on every render and starts
 * a new fetch only when it changed.
 */
let churn = { key: null, status: 'idle', data: null, error: null };

function dateKey(filters) {
  return `${filters.from || ''}|${filters.to || ''}`;
}

/**
 * Start (or skip) the churn fetch for the current date filters.
 * @param {ViewContext} ctx
 */
function ensureChurn(ctx) {
  if (ctx.snapshot) {
    if (churn.status !== 'unavailable') churn = { key: 'snapshot', status: 'unavailable', data: null, error: null };
    return;
  }
  const key = dateKey(ctx.filters);
  if (churn.key === key && churn.status !== 'idle') return;
  churn = { key, status: 'loading', data: null, error: null };
  const q = new URLSearchParams();
  if (ctx.filters.from) q.set('from', ctx.filters.from);
  if (ctx.filters.to) q.set('to', ctx.filters.to);
  ctx.fetchJson(`/api/cache-health?${q.toString()}`)
    .then((data) => {
      if (churn.key !== key) return; // superseded by a newer filter change
      churn = { key, status: 'ready', data, error: null };
      ctx.rerender({ recompute: false });
    })
    .catch((err) => {
      if (churn.key !== key) return;
      churn = { key, status: 'error', data: null, error: err && err.message ? err.message : String(err) };
      ctx.rerender({ recompute: false });
    });
}

/** @param {ViewContext} ctx */
export function onEnter(ctx) {
  ensureChurn(ctx);
}

/** @param {ViewContext} ctx */
export function view(ctx) {
  ensureChurn(ctx);
  const root = el('div', { class: 'grid' });
  root.appendChild(kpiRow(ctx));
  root.appendChild(hitRateCard(ctx));
  root.appendChild(writeSplitCard(ctx));
  root.appendChild(modelTableCard(ctx));
  root.appendChild(churnCard(ctx));
  return root;
}

function kpiRow(ctx) {
  const { pct, usd, int } = ctx.fmt;
  const t = ctx.view.totals;
  const hitRate = (t.cr + t.in) > 0 ? t.cr / (t.cr + t.in) : null;
  const writeShare = t.cw > 0 ? t.cf / t.cw : null;

  const box = el('div', { class: 'cards' });
  box.appendChild(ctx.kpi('Cache hit rate', pct(hitRate, 1), 'cache_read / (cache_read + input), current filters'));
  box.appendChild(ctx.kpi('Long-TTL write share', pct(writeShare, 1), 'cache_refresh / cache_write, current filters'));

  const snapshotSub = ctx.snapshot ? 'live dashboard only' : null;
  const errorSub = churn.status === 'error' ? 'failed to load' : null;
  const eventsValue = ctx.snapshot ? '—'
    : churn.status === 'ready' ? int(churn.data.summary.totalEvents)
    : churn.status === 'error' ? '—'
    : '…';
  box.appendChild(ctx.kpi('Churn events', eventsValue, snapshotSub || errorSub));

  const premiumValue = ctx.snapshot ? '—'
    : churn.status === 'ready' ? usd(churn.data.summary.totalPremiumUsd)
    : churn.status === 'error' ? '—'
    : '…';
  box.appendChild(ctx.kpi('Churn premium (estimated)', premiumValue, snapshotSub || errorSub));
  return box;
}

function hitRateCard(ctx) {
  const { shortDate, pct } = ctx.fmt;
  const rows = hitRateSeries(ctx.view.daily);
  const renderChart = (w) => timeSeries({
    data: rows.map((r) => ({ key: r.date })),
    keys: [],
    overlays: [{ values: rows.map((r) => r.hitRate), label: 'Hit rate', color: 'var(--series-1)' }],
    fmtY: (v) => pct(v, 0),
    fmtX: (k) => shortDate(k),
    fmtXLong: (k) => shortDate(k),
    width: w,
    height: 220,
    ariaLabel: 'Daily cache hit rate',
  });
  const tableSpec = {
    columns: [
      { key: 'date', label: 'Date', text: true, value: (r) => shortDate(r.date) },
      { key: 'hitRate', label: 'Hit rate', value: (r) => (r.hitRate === null ? null : pct(r.hitRate, 1)) },
    ],
    rows,
  };
  return ctx.chartCard(
    'cache-hit-rate',
    'Cache hit rate over time',
    'Daily cache_read / (cache_read + input) for the current filters. A day with no input or cache tokens shows no value, not 0%.',
    renderChart,
    tableSpec,
  );
}

function writeSplitCard(ctx) {
  const { shortDate, compact } = ctx.fmt;
  const rows = writeSplitSeries(ctx.view.daily);
  const keys = [
    { key: 'shortTTL', label: 'Short-TTL writes', color: 'var(--series-1)' },
    { key: 'longTTL', label: 'Long-TTL writes', color: 'var(--series-2)' },
  ];
  const renderChart = (w) => timeSeries({
    data: rows.map((r) => ({ key: r.date, shortTTL: r.shortTTL, longTTL: r.longTTL })),
    keys,
    mode: 'stacked',
    fmtY: (v) => compact(v),
    fmtX: (k) => shortDate(k),
    fmtXLong: (k) => shortDate(k),
    width: w,
    height: 220,
    ariaLabel: 'Daily cache write split, short-TTL versus long-TTL',
  });
  const tableSpec = {
    columns: [
      { key: 'date', label: 'Date', text: true, value: (r) => shortDate(r.date) },
      { key: 'shortTTL', label: 'Short-TTL writes', value: (r) => compact(r.shortTTL) },
      { key: 'longTTL', label: 'Long-TTL writes', value: (r) => compact(r.longTTL) },
    ],
    rows,
  };
  return ctx.chartCard(
    'cache-write-split',
    'Cache write split',
    'Short-TTL cache writes (cache_write minus cache_refresh) against long-TTL writes (cache_refresh), stacked by day.',
    renderChart,
    tableSpec,
  );
}

function modelTableCard(ctx) {
  const { pct, int } = ctx.fmt;
  const rows = (ctx.view.dimensions.models || []).map((m) => {
    const denom = (m.cacheRead || 0) + (m.input || 0);
    return {
      model: m.key,
      provider: m.provider,
      hitRate: denom > 0 ? m.cacheRead / denom : null,
      requests: m.requests,
    };
  });
  const tbl = ctx.charts.table([
    { key: 'model', label: 'Model', text: true },
    { key: 'provider', label: 'Provider', text: true },
    { key: 'hitRate', label: 'Hit rate', value: (r) => (r.hitRate === null ? null : pct(r.hitRate, 1)) },
    { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
  ], rows, { emptyText: 'No models match the current filters.' });
  return ctx.card('Cache hit rate by model', 'cache_read / (cache_read + input) per model, for the current filters.', tbl);
}

function churnCard(ctx) {
  if (ctx.snapshot) {
    return ctx.emptyCard(
      'Churn events need the live dashboard.',
      'Churn detection reads request records, which stay on the machine. Open the live dashboard to see them.',
    );
  }

  const { int, usd } = ctx.fmt;
  const columns = [
    { key: 'sessionId', label: 'Session', text: true, value: (r) => (r.sessionId ? String(r.sessionId).slice(0, 12) : null) },
    { key: 'project', label: 'Project', text: true },
    { key: 'branch', label: 'Branch', text: true },
    { key: 'turnIndex', label: 'Turn', value: (r) => int(r.turnIndex) },
    { key: 'writeTokens', label: 'Write tokens', value: (r) => int(r.writeTokens) },
    { key: 'previousReadTokens', label: 'Previous read', value: (r) => int(r.previousReadTokens) },
    { key: 'premiumUsd', label: 'Premium (estimated)', value: (r) => (r.premiumUsd === null ? null : usd(r.premiumUsd)) },
    { key: 'timestamp', label: 'When', value: (r) => (r.timestamp ? r.timestamp.replace('T', ' ').slice(0, 19) : null) },
  ];

  let rows = [];
  let emptyText = 'No churn events in the current window.';
  let note = null;
  if (churn.status === 'loading' || churn.status === 'idle') {
    emptyText = 'Loading churn events...';
  } else if (churn.status === 'error') {
    emptyText = `Could not load churn events: ${churn.error}`;
  } else if (churn.data) {
    // The route already sorts by estimated premium, highest first.
    rows = (churn.data.events || []).slice(0, 20);
    if (churn.data.truncated) {
      note = `Scan capped at ${int(churn.data.scanned)} records. Some churn events may be missed.`;
    }
  }

  const body = el('div');
  body.appendChild(el('p', { class: 'hint', text: 'A churn event is a turn whose cache write is at least 10,000 tokens. It is also at least half of the previous turn\'s cache read in the same session. That pattern means the cache was invalidated and rewritten, for example when a system prompt changes.' }));
  if (note) body.appendChild(el('p', { class: 'hint cache-status', text: note }));
  body.appendChild(ctx.charts.table(columns, rows, { emptyText }));
  return ctx.card('Churn events', 'Top 20 by estimated cost premium.', body);
}

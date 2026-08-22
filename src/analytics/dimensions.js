/**
 * Per-dimension analytics: provider, model, interface, project.
 *
 * All four share one shape so the UI can render any of them with the same
 * table and chart components, and so a dimension added by a future adapter
 * needs no new analytics code.
 */
import { rank, groupRows, filterCube, sumRows, dateRange, daysBetween, addDays, finalize, zeroMeasures, addInto } from './aggregate.js';
import { interfaceClass } from '../core/schema.js';

/**
 * @param {any[][]} rows
 * @param {object} ix
 * @param {string} dim cube dimension key: p | m | mf | c | i | g | pj | rp
 * @param {{limit?:number, activeDays?:boolean, sessions?:any[], grandTotal?:number}} opt
 */
export function calculateDimensionUsage(rows, ix, dim, opt = {}) {
  const col = ix.d[dim];
  const groups = rank(rows, ix, (r) => r[col], { keepRows: true });
  const grand = opt.grandTotal ?? groups.reduce((a, g) => a + g.m.total, 0);
  const sessionsBy = new Map();
  if (opt.sessions) {
    // Sessions carry the same short dimension keys as the cube.
    const KNOWN = new Set(['p', 'm', 'mf', 'c', 'i', 'g', 'pj', 'rp', 'st']);
    const sdim = KNOWN.has(dim) ? dim : 'rp';
    for (const s of opt.sessions) {
      const k = s[sdim];
      const e = sessionsBy.get(k) || { n: 0, tokens: 0, longMs: 0 };
      e.n++;
      e.tokens += s.total || 0;
      e.longMs += s.durationMs || 0;
      sessionsBy.set(k, e);
    }
  }

  const out = groups.map((g) => {
    const days = new Set();
    let peakDay = null;
    let peakTotal = -1;
    const byDay = new Map();
    for (const r of g.rows) {
      const d = r[ix.d.d];
      days.add(d);
      const t = r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
      byDay.set(d, (byDay.get(d) || 0) + t);
    }
    for (const [d, t] of byDay) if (t > peakTotal) { peakTotal = t; peakDay = d; }
    const sess = sessionsBy.get(g.key) || null;
    return {
      key: g.key,
      // The dominant provider for this dimension value — needed to resolve a
      // vendor-specific cache multiplier when pricing a model.
      provider: g.rows.length ? g.rows[0][ix.d.p] : null,
      total: g.m.total,
      input: g.m.in,
      output: g.m.out,
      cacheRead: g.m.cr,
      cacheWrite: g.m.cw,
      cache: g.m.cr + g.m.cw,
      cacheRefresh: g.m.cf,
      reasoning: g.m.rs,
      requests: g.m.req,
      cost: g.m.costReq > 0 ? g.m.cost : null,
      costMeasured: g.m.costMeasured || null,
      costCoveredRequests: g.m.costReq,
      activeDays: days.size,
      avgPerActiveDay: days.size ? g.m.total / days.size : null,
      avgPerRequest: g.m.req ? g.m.total / g.m.req : null,
      peakDay,
      peakDayTotal: peakTotal < 0 ? null : peakTotal,
      sessions: sess ? sess.n : null,
      avgPerSession: sess && sess.n ? g.m.total / sess.n : null,
      share: grand ? g.m.total / grand : null,
      missing: { input: g.m.naIn, output: g.m.naOut, cacheRead: g.m.naCr, cacheWrite: g.m.naCw },
    };
  });
  return opt.limit ? out.slice(0, opt.limit) : out;
}

export const calculateProviderUsage = (rows, ix, opt) => calculateDimensionUsage(rows, ix, 'p', opt);
export const calculateModelUsage = (rows, ix, opt) => calculateDimensionUsage(rows, ix, 'm', opt);
export const calculateInterfaceUsage = (rows, ix, opt) => calculateDimensionUsage(rows, ix, 'i', opt);
export const calculateProjectUsage = (rows, ix, opt) => calculateDimensionUsage(rows, ix, 'pj', opt);

/**
 * Stacked series per dimension value: one row per bucket, one column per
 * top-N key, with everything else folded into "Other" — never a 9th generated
 * colour.
 */
export function calculateDimensionSeries(rows, ix, dim, buckets, opt = {}) {
  const topN = opt.topN ?? 6;
  const keyFn = opt.bucketOf || ((d) => d);
  const top = rank(rows, ix, (r) => r[ix.d[dim]], { limit: topN }).map((g) => g.key);
  const topSet = new Set(top);
  const byBucket = new Map();
  for (const r of rows) {
    const b = keyFn(r[ix.d.d]);
    let row = byBucket.get(b);
    if (!row) {
      row = { key: b };
      for (const k of top) row[k] = 0;
      row.Other = 0;
      byBucket.set(b, row);
    }
    const k = r[ix.d[dim]];
    const t = r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
    if (topSet.has(k)) row[k] += t;
    else row.Other += t;
  }
  const hasOther = [...byBucket.values()].some((r) => r.Other > 0);
  const keys = hasOther ? [...top, 'Other'] : top;
  const series = (buckets || [...byBucket.keys()].sort()).map((b) => {
    const row = byBucket.get(b);
    if (row) return row;
    const empty = { key: b };
    for (const k of keys) empty[k] = 0;
    return empty;
  });
  return { keys, series };
}

/**
 * Period-over-period growth per dimension value. The comparison window is the
 * same length as the current one, immediately preceding it.
 */
export function calculateDimensionGrowth(ix, dim, filters, { from, to }) {
  // An empty store has no coverage; growth against nothing is nothing.
  if (!from || !to) {
    return { window: { from: null, to: null }, previousWindow: { from: null, to: null }, rows: [] };
  }
  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const cur = filterCube(ix, { ...filters, from, to });
  const prev = filterCube(ix, { ...filters, from: prevFrom, to: prevTo });
  const curBy = groupRows(cur, ix, (r) => r[ix.d[dim]]);
  const prevBy = groupRows(prev, ix, (r) => r[ix.d[dim]]);
  const keys = new Set([...curBy.keys(), ...prevBy.keys()]);
  const out = [];
  for (const k of keys) {
    const c = curBy.get(k)?.m.total ?? 0;
    const p = prevBy.get(k)?.m.total ?? 0;
    out.push({
      key: k,
      current: c,
      previous: p,
      change: p > 0 ? (c - p) / p : null,
      absolute: c - p,
      status: p === 0 ? (c > 0 ? 'new' : 'none') : c === 0 ? 'stopped' : c > p ? 'up' : c < p ? 'down' : 'flat',
    });
  }
  out.sort((a, b) => b.current - a.current);
  return { window: { from, to }, previousWindow: { from: prevFrom, to: prevTo }, rows: out };
}

/**
 * Model efficiency scatter: tokens per session (x) against sessions per active
 * day (y), bubble = total tokens. Grouped by provider, which is why the caller
 * caps the colour count — a scatter needs all-pairs colour separation.
 */
export function calculateModelEfficiency(rows, ix, sessions, { limit = 24 } = {}) {
  const byModel = rank(rows, ix, (r) => r[ix.d.m], { keepRows: true, limit });
  const sessByModel = new Map();
  for (const s of sessions) {
    const e = sessByModel.get(s.m) || { n: 0, days: new Set(), tokens: 0, durations: [] };
    e.n++;
    e.days.add(s.d);
    e.tokens += s.total || 0;
    if (s.durationMs) e.durations.push(s.durationMs);
    sessByModel.set(s.m, e);
  }
  return byModel.map((g) => {
    const s = sessByModel.get(g.key);
    const days = new Set(g.rows.map((r) => r[ix.d.d]));
    const provider = g.rows.length ? g.rows[0][ix.d.p] : 'unknown';
    return {
      model: g.key,
      provider,
      family: g.rows.length ? g.rows[0][ix.d.mf] : 'Unknown',
      total: g.m.total,
      requests: g.m.req,
      sessions: s ? s.n : null,
      activeDays: days.size,
      tokensPerSession: s && s.n ? g.m.total / s.n : null,
      sessionsPerDay: s && s.days.size ? s.n / s.days.size : null,
      tokensPerRequest: g.m.req ? g.m.total / g.m.req : null,
      outputPerRequest: g.m.req ? g.m.out / g.m.req : null,
      medianSessionMs: s && s.durations.length ? median(s.durations) : null,
    };
  });
}

/** CLI vs GUI over time — the "how is my tooling shifting" series. */
export function calculateInterfaceTrend(rows, ix, buckets, bucketOf = (d) => d) {
  const classes = new Map();
  for (const r of rows) {
    const b = bucketOf(r[ix.d.d]);
    const cls = interfaceClass(r[ix.d.i]);
    let row = classes.get(b);
    if (!row) { row = { key: b }; classes.set(b, row); }
    row[cls] = (row[cls] || 0) + r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
  }
  const keys = [...new Set([...classes.values()].flatMap((r) => Object.keys(r).filter((k) => k !== 'key')))];
  const series = (buckets || [...classes.keys()].sort()).map((b) => {
    const row = classes.get(b) || { key: b };
    for (const k of keys) if (row[k] === undefined) row[k] = 0;
    return row;
  });
  // Share-of-total per bucket, which is what makes a shift legible.
  const shares = series.map((row) => {
    const t = keys.reduce((a, k) => a + row[k], 0);
    const o = { key: row.key };
    for (const k of keys) o[k] = t ? row[k] / t : 0;
    return o;
  });
  return { keys, series, shares };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Filtering + aggregation primitives.
 *
 * Everything downstream operates on a "slice": the cube rows that survive the
 * global filter bar, plus the sessions that survive the same filter. Slices are
 * computed in-process (in the browser, from a bundle loaded once) so changing a
 * filter costs no network round trip.
 *
 * This module is deliberately free of Node imports so the exact same code runs
 * in the CLI, the API and the browser.
 */

export const MEASURES = ['in', 'out', 'cr', 'cw', 'cf', 'rs', 'req', 'cost', 'costMeasured', 'costReq', 'naIn', 'naOut', 'naCr', 'naCw'];

/** Column indices for a cube built by src/core/store.js. */
export function indexCube(cube) {
  const d = {};
  cube.dims.forEach((k, i) => { d[k] = i; });
  const m = {};
  cube.measures.forEach((k, i) => { m[k] = cube.dims.length + i; });
  return { d, m, rows: cube.rows, dims: cube.dims, measures: cube.measures };
}

export const EMPTY_FILTERS = {
  from: null, to: null,
  hourFrom: null, hourTo: null,
  dows: null,
  provider: null, model: null, model_family: null, client: null,
  interface: null, gateway: null, project: null, repository: null, service_tier: null,
  includeOverlay: false,
  includeActivity: true,
};

/**
 * @param {ReturnType<typeof indexCube>} ix
 * @param {Partial<typeof EMPTY_FILTERS>} f
 * @returns {any[][]} cube rows
 */
export function filterCube(ix, f = {}) {
  const { d } = ix;
  const set = (v) => (v && v.length ? new Set(v) : null);
  const P = set(f.provider), M = set(f.model), MF = set(f.model_family), C = set(f.client),
    I = set(f.interface), G = set(f.gateway), PJ = set(f.project), RP = set(f.repository),
    ST = set(f.service_tier), W = f.dows && f.dows.length ? new Set(f.dows) : null;
  const from = f.from || null, to = f.to || null;
  const hf = f.hourFrom === null || f.hourFrom === undefined ? null : Number(f.hourFrom);
  const ht = f.hourTo === null || f.hourTo === undefined ? null : Number(f.hourTo);
  const overlay = !!f.includeOverlay;
  const activity = f.includeActivity !== false;

  const out = [];
  for (const r of ix.rows) {
    const ms = r[d.ms];
    if (ms === 'overlay' && !overlay) continue;
    if (ms === 'activity' && !activity) continue;
    if (from && r[d.d] < from) continue;
    if (to && r[d.d] > to) continue;
    if (hf !== null || ht !== null) {
      const h = r[d.h];
      if (hf !== null && ht !== null) {
        // A window may wrap past midnight (22 -> 03).
        const ok = hf <= ht ? h >= hf && h <= ht : h >= hf || h <= ht;
        if (!ok) continue;
      } else if (hf !== null && h < hf) continue;
      else if (ht !== null && h > ht) continue;
    }
    if (W && !W.has(r[d.w])) continue;
    if (P && !P.has(r[d.p])) continue;
    if (M && !M.has(r[d.m])) continue;
    if (MF && !MF.has(r[d.mf])) continue;
    if (C && !C.has(r[d.c])) continue;
    if (I && !I.has(r[d.i])) continue;
    if (G && !G.has(r[d.g])) continue;
    if (PJ && !PJ.has(r[d.pj])) continue;
    if (RP && !RP.has(r[d.rp])) continue;
    if (ST && !ST.has(r[d.st])) continue;
    out.push(r);
  }
  return out;
}

/** Sessions filtered by the same predicate set (dimension keys match the cube). */
export function filterSessions(sessions, f = {}) {
  const set = (v) => (v && v.length ? new Set(v) : null);
  const P = set(f.provider), M = set(f.model), MF = set(f.model_family), C = set(f.client),
    I = set(f.interface), G = set(f.gateway), PJ = set(f.project), RP = set(f.repository),
    ST = set(f.service_tier), W = f.dows && f.dows.length ? new Set(f.dows) : null;
  const overlay = !!f.includeOverlay;
  const activity = f.includeActivity !== false;
  return sessions.filter((s) => {
    if (s.ms === 'overlay' && !overlay) return false;
    if (s.ms === 'activity' && !activity) return false;
    if (f.from && s.d < f.from) return false;
    if (f.to && s.d > f.to) return false;
    if (W && !W.has(s.w)) return false;
    if (P && !P.has(s.p)) return false;
    if (M && !M.has(s.m)) return false;
    if (MF && !MF.has(s.mf)) return false;
    if (C && !C.has(s.c)) return false;
    if (I && !I.has(s.i)) return false;
    if (G && !G.has(s.g)) return false;
    if (PJ && !PJ.has(s.pj)) return false;
    if (RP && !RP.has(s.rp)) return false;
    if (ST && !ST.has(s.st)) return false;
    return true;
  });
}

export function zeroMeasures() {
  const o = {};
  for (const k of MEASURES) o[k] = 0;
  return o;
}

/** Sum measures across rows. Adds a derived `total` and `naAny`. */
export function sumRows(rows, ix) {
  const { m } = ix;
  const o = zeroMeasures();
  for (const r of rows) for (const k of MEASURES) o[k] += r[m[k]];
  return finalize(o);
}

export function addInto(acc, r, ix) {
  const { m } = ix;
  for (const k of MEASURES) acc[k] += r[m[k]];
  return acc;
}

export function finalize(o) {
  o.total = o.in + o.out + o.cr + o.cw;
  o.cache = o.cr + o.cw;
  o.naAny = o.naIn + o.naOut + o.naCr + o.naCw;
  return o;
}

/**
 * Group rows by a key derived from dimension columns.
 * @returns {Map<string, {key:string, m:ReturnType<typeof zeroMeasures>, rows:any[][]}>}
 */
export function groupRows(rows, ix, keyFn, { keepRows = false } = {}) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r, ix.d);
    if (k === null || k === undefined) continue;
    let g = out.get(k);
    if (!g) {
      g = { key: k, m: zeroMeasures(), rows: keepRows ? [] : null };
      out.set(k, g);
    }
    addInto(g.m, r, ix);
    if (keepRows) g.rows.push(r);
  }
  for (const g of out.values()) finalize(g.m);
  return out;
}

/** Sorted, finalized array form of groupRows, largest total first. */
export function rank(rows, ix, keyFn, { limit = null, keepRows = false } = {}) {
  const arr = [...groupRows(rows, ix, keyFn, { keepRows }).values()];
  arr.sort((a, b) => b.m.total - a.m.total || (a.key < b.key ? -1 : 1));
  return limit ? arr.slice(0, limit) : arr;
}

/** All distinct values of a dimension, with request counts — for the filter bar. */
export function facet(ix, dim, rows = ix.rows) {
  const i = ix.d[dim];
  const out = new Map();
  for (const r of rows) {
    const v = r[i];
    const e = out.get(v) || { value: v, req: 0, total: 0 };
    e.req += r[ix.m.req];
    e.total += r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
    out.set(v, e);
  }
  return [...out.values()].sort((a, b) => b.total - a.total || (a.value < b.value ? -1 : 1));
}

// --------------------------------------------------------------- calendar ---

export function toISODate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

export function daysBetween(a, b) {
  return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
}

/** Inclusive list of every calendar date in a range — including empty ones. */
export function dateRange(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 20000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** ISO week key, e.g. "2026-W33". */
export function weekKey(iso) {
  const d = parseISODate(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

/** Monday of the week containing `iso` — the label for weekly buckets. */
export function weekStart(iso) {
  const d = parseISODate(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return toISODate(d);
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

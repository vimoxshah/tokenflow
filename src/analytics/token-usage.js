/**
 * Core token-usage analytics: the time series, its moving averages, the
 * composition split, the hour/day profiles, and the trend.
 */
import {
  groupRows, sumRows, zeroMeasures, finalize, addInto, dateRange, weekStart,
  monthKey, percentile, mean, daysBetween, addDays,
} from './aggregate.js';

/**
 * Daily (or weekly / monthly) token series.
 *
 * Empty calendar days inside the range are emitted with zeros and
 * `active: false`, because a gap in a time series is information — but they are
 * excluded from "average per active day", which is the number people actually
 * mean when they ask how much they use per day.
 *
 * @param {any[][]} rows filtered cube rows
 * @param {object} ix index from indexCube
 * @param {{granularity?:'day'|'week'|'month', from?:string, to?:string, fill?:boolean}} opt
 */
export function calculateDailyUsage(rows, ix, opt = {}) {
  const gran = opt.granularity || 'day';
  const keyOf = gran === 'week' ? weekStart : gran === 'month' ? monthKey : (d) => d;
  const groups = groupRows(rows, ix, (r, d) => keyOf(r[d.d]));

  let keys = [...groups.keys()].sort();
  if (opt.fill !== false && gran === 'day') {
    const from = opt.from || keys[0];
    const to = opt.to || keys[keys.length - 1];
    if (from && to) keys = dateRange(from, to);
  }
  return keys.map((k) => {
    const g = groups.get(k);
    const m = g ? g.m : finalize(zeroMeasures());
    return {
      key: k,
      date: k,
      // `active` = any AI activity that day (including sources that report no
      // tokens). `tokenActive` = tokens were actually measured. Averaging over
      // the wrong one is how a dashboard ends up claiming a median of ~0.
      active: !!g && m.req > 0,
      tokenActive: !!g && m.total > 0,
      ...m,
    };
  });
}

/** Trailing simple moving average over a series field. Nulls until the window fills. */
export function movingAverage(series, window, field = 'total') {
  const out = new Array(series.length).fill(null);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i][field] || 0;
    if (i >= window) sum -= series[i - window][field] || 0;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

/**
 * Average usage. `perActiveDay` is the headline; `perCalendarDay` is offered
 * beside it so the difference between "how hard I work when I work" and "how
 * much I use overall" stays visible instead of being silently chosen for you.
 */
export function calculateAverageUsage(series) {
  const active = series.filter((d) => d.tokenActive);
  const anyActivity = series.filter((d) => d.active);
  const sum = (f, arr) => arr.reduce((a, b) => a + (b[f] || 0), 0);
  return {
    activeDays: active.length,
    activityDays: anyActivity.length,
    activityOnlyDays: anyActivity.length - active.length,
    calendarDays: series.length,
    perActiveDay: active.length ? sum('total', active) / active.length : null,
    perCalendarDay: series.length ? sum('total', series) / series.length : null,
    outputPerActiveDay: active.length ? sum('out', active) / active.length : null,
    requestsPerActiveDay: active.length ? sum('req', active) / active.length : null,
    medianActiveDay: active.length
      ? percentile(active.map((d) => d.total).sort((a, b) => a - b), 0.5)
      : null,
  };
}

/** Input / output / cache composition, with the two ratios the spec asks for. */
export function calculateComposition(totals) {
  const t = totals.total || 0;
  return {
    total: t,
    input: totals.in,
    output: totals.out,
    cacheRead: totals.cr,
    cacheWrite: totals.cw,
    cacheRefresh: totals.cf,
    reasoning: totals.rs,
    cache: totals.cr + totals.cw,
    shares: t
      ? {
        input: totals.in / t,
        output: totals.out / t,
        cacheRead: totals.cr / t,
        cacheWrite: totals.cw / t,
        cache: (totals.cr + totals.cw) / t,
      }
      : { input: null, output: null, cacheRead: null, cacheWrite: null, cache: null },
    outputPerInput: totals.in ? totals.out / totals.in : null,
    // Output against ALL prompt-side tokens (fresh + cache read + cache write).
    // With a cache-heavy agent, fresh input is a sliver of what was actually
    // sent, so out/in alone would badly misdescribe the workload.
    outputPerPromptToken: (totals.in + totals.cr + totals.cw)
      ? totals.out / (totals.in + totals.cr + totals.cw) : null,
    promptTokens: totals.in + totals.cr + totals.cw,
    cacheRatio: t ? (totals.cr + totals.cw) / t : null,
    // Of all prompt-side tokens, how many were served from cache rather than
    // re-sent fresh. This is the number that actually reflects cache benefit.
    cacheHitRate: totals.in + totals.cr ? totals.cr / (totals.in + totals.cr) : null,
    reasoningShareOfOutput: totals.out ? totals.rs / totals.out : null,
    refreshShareOfCacheWrite: totals.cw ? totals.cf / totals.cw : null,
  };
}

export function calculateCacheRatio(totals) {
  return calculateComposition(totals).cacheRatio;
}

/**
 * Trend: compare the last `window` active-or-not calendar days against the
 * equally long window before it. Returns null rather than a made-up number
 * when there isn't enough history for a fair comparison.
 */
export function calculateUsageTrend(series, window = 30) {
  if (series.length < 4) return { window: null, change: null, reason: 'not enough history' };
  const w = Math.min(window, Math.floor(series.length / 2));
  const recent = series.slice(-w);
  const prior = series.slice(-2 * w, -w);
  const sum = (a) => a.reduce((x, d) => x + (d.total || 0), 0);
  const a = sum(prior);
  const b = sum(recent);
  return {
    window: w,
    recentTotal: b,
    priorTotal: a,
    change: a > 0 ? (b - a) / a : null,
    direction: a > 0 ? (b > a * 1.05 ? 'increasing' : b < a * 0.95 ? 'decreasing' : 'flat') : 'unknown',
    reason: a > 0 ? null : 'no usage in the comparison window',
  };
}

/** 24-bucket hour-of-day profile. */
export function calculateHourlyUsage(rows, ix) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...finalize(zeroMeasures()) }));
  for (const r of rows) {
    const b = buckets[r[ix.d.h]];
    if (!b) continue;
    addInto(b, r, ix);
  }
  for (const b of buckets) finalize(b);
  const totals = buckets.map((b) => b.total);
  return { buckets, peakWindow: bestWindow(totals, 3), secondaryWindow: secondBestWindow(totals, 3) };
}

/** Monday-first day-of-week profile, with a per-active-day average. */
export function calculateDowUsage(rows, ix, series = null) {
  const buckets = Array.from({ length: 7 }, (_, w) => ({ dow: w, days: 0, ...finalize(zeroMeasures()) }));
  for (const r of rows) {
    const b = buckets[r[ix.d.w]];
    if (!b) continue;
    addInto(b, r, ix);
  }
  if (series) {
    for (const d of series) {
      if (!d.tokenActive) continue;
      const w = dowOf(d.date);
      buckets[w].days++;
    }
  }
  for (const b of buckets) {
    finalize(b);
    b.perActiveDay = b.days ? b.total / b.days : null;
  }
  return buckets;
}

/** 7x24 matrix for the hour x weekday heatmap. */
export function calculateHourDow(rows, ix) {
  const cells = [];
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => zeroMeasures()));
  for (const r of rows) {
    const w = r[ix.d.w];
    const h = r[ix.d.h];
    if (grid[w] && grid[w][h]) addInto(grid[w][h], r, ix);
  }
  let max = 0;
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const m = finalize(grid[w][h]);
      if (m.total > max) max = m.total;
      cells.push({ dow: w, hour: h, ...m });
    }
  }
  return { cells, max };
}

/**
 * Calendar-heatmap levels from the *distribution* of the data, not from fixed
 * thresholds — so the heatmap still reads correctly whether your daily usage is
 * measured in thousands or in billions.
 */
export function calendarLevels(series, levels = 4) {
  const active = series.filter((d) => d.tokenActive).map((d) => d.total).sort((a, b) => a - b);
  if (!active.length) return { thresholds: [], levelOf: () => 0, max: 0 };
  const thresholds = [];
  for (let i = 1; i <= levels; i++) thresholds.push(percentile(active, i / (levels + 1)));
  return {
    thresholds,
    max: active[active.length - 1],
    median: percentile(active, 0.5),
    levelOf(total, isActive) {
      if (!isActive || !total) return 0;
      let l = 1;
      for (const t of thresholds) if (total > t) l++;
      return Math.min(l, levels + 1);
    },
  };
}

export function dowOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Contiguous window of `size` buckets with the largest sum (wraps midnight). */
export function bestWindow(values, size) {
  const n = values.length;
  if (!n) return null;
  let best = -1;
  let at = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < size; k++) s += values[(i + k) % n];
    if (s > best) { best = s; at = i; }
  }
  if (best <= 0) return null;
  return { from: at, to: (at + size - 1) % n, total: best, share: best / values.reduce((a, b) => a + b, 0) };
}

function secondBestWindow(values, size) {
  const first = bestWindow(values, size);
  if (!first) return null;
  const masked = values.slice();
  for (let k = 0; k < size; k++) masked[(first.from + k) % masked.length] = 0;
  const second = bestWindow(masked, size);
  if (!second || !second.total) return null;
  return { ...second, share: second.total / values.reduce((a, b) => a + b, 0) };
}

/** Longest run of consecutive active days, and the current run. */
export function calculateStreaks(series) {
  let best = 0, cur = 0, bestEnd = null;
  for (const d of series) {
    if (d.tokenActive) {
      cur++;
      if (cur > best) { best = cur; bestEnd = d.date; }
    } else cur = 0;
  }
  return { longest: best, longestEndedOn: bestEnd, current: cur };
}

/**
 * AI activity / productivity **proxies** — and correlations, never causation.
 *
 * Token counts do not measure productivity. What they measure is how much
 * model capacity a day consumed. This module therefore does two separate
 * things and labels them differently:
 *
 *   1. Activity proxies — sessions, sessions/day, tokens/session, active
 *      workdays, session length distribution. These are descriptions of
 *      behaviour, presented as such.
 *
 *   2. Correlation — when an independent work signal exists (git commits,
 *      AI-authored lines, files changed), the Pearson coefficient between it
 *      and daily AI usage, over the OVERLAPPING days only, with n reported.
 *      Below `minOverlap` days it returns `null` and an explanation rather
 *      than a number, because a correlation computed on four days is not a
 *      finding, it is decoration.
 */
import { dowOf } from './token-usage.js';

export function calculateActivityProxies(series, sessions, totals) {
  const active = series.filter((d) => d.tokenActive);
  const byDay = new Map();
  for (const s of sessions) byDay.set(s.d, (byDay.get(s.d) || 0) + 1);
  const sessionDays = byDay.size;
  const weekdayActive = active.filter((d) => dowOf(d.date) < 5).length;
  const weekendActive = active.length - weekdayActive;
  return {
    sessions: sessions.length,
    activeDays: active.length,
    sessionDays,
    sessionsPerActiveDay: sessionDays ? sessions.length / sessionDays : null,
    tokensPerSession: sessions.length ? totals.total / sessions.length : null,
    requestsPerSession: sessions.length ? totals.req / sessions.length : null,
    outputPerSession: sessions.length ? totals.out / sessions.length : null,
    weekdayActiveDays: weekdayActive,
    weekendActiveDays: weekendActive,
    weekendShare: active.length ? weekendActive / active.length : null,
    projects: new Set(sessions.map((s) => s.pj)).size,
    repositories: new Set(sessions.map((s) => s.rp)).size,
    medianSessionsPerDay: sessionDays
      ? [...byDay.values()].sort((a, b) => a - b)[Math.floor(sessionDays / 2)]
      : null,
  };
}

/**
 * Daily work signals from the activity rollup.
 * @param {{rows:Record<string,object>}} activity
 * @param {{from?:string,to?:string,projects?:string[]}} [f]
 */
export function calculateWorkSeries(activity, f = {}) {
  const byDay = new Map();
  const pj = f.projects && f.projects.length ? new Set(f.projects) : null;
  for (const a of Object.values(activity.rows || {})) {
    if (f.from && a.d < f.from) continue;
    if (f.to && a.d > f.to) continue;
    if (pj && !pj.has(a.pj)) continue;
    const e = byDay.get(a.d) || { date: a.d, commits: 0, files: 0, insertions: 0, deletions: 0, aiLines: 0, humanLines: 0, edits: 0 };
    e.commits += a.commits || 0;
    e.files += a.files || 0;
    e.insertions += a.ins || 0;
    e.deletions += a.del || 0;
    e.aiLines += a.aiLines || 0;
    e.humanLines += a.humanLines || 0;
    e.edits += a.edits || 0;
    byDay.set(a.d, e);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Pearson r. Returns null for degenerate input rather than 0. */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
    }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * @param {any[]} usageSeries output of calculateDailyUsage
 * @param {any[]} workSeries output of calculateWorkSeries
 * @param {{minOverlap?:number, metrics?:string[]}} [opt]
 */
export function calculateCorrelations(usageSeries, workSeries, opt = {}) {
  const minOverlap = opt.minOverlap ?? 10;
  const metrics = opt.metrics ?? ['commits', 'insertions', 'files', 'aiLines', 'edits'];
  const usageBy = new Map(usageSeries.map((d) => [d.date, d]));
  const workBy = new Map(workSeries.map((d) => [d.date, d]));
  const overlap = [...workBy.keys()].filter((d) => usageBy.has(d)).sort();

  const base = {
    available: false,
    overlapDays: overlap.length,
    minOverlap,
    window: overlap.length ? { from: overlap[0], to: overlap[overlap.length - 1] } : null,
    reason: null,
    metrics: [],
    note: 'Correlation only. AI token usage is not a measure of productivity, and a relationship here does not imply that one caused the other.',
  };

  if (!workSeries.length) {
    return { ...base, reason: 'No independent work signal is available. Enable the git or cursor adapter to correlate usage with shipped work.' };
  }
  if (overlap.length < minOverlap) {
    return {
      ...base,
      reason: `Only ${overlap.length} day(s) where both AI usage and work activity were recorded — at least ${minOverlap} are needed before a correlation means anything.`,
    };
  }

  const usage = overlap.map((d) => usageBy.get(d).total);
  const out = [];
  for (const key of metrics) {
    const work = overlap.map((d) => workBy.get(d)[key] || 0);
    if (work.every((v) => v === 0)) continue;
    const r = pearson(usage, work);
    if (r === null) continue;
    out.push({
      metric: key,
      r,
      strength: Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : Math.abs(r) >= 0.2 ? 'weak' : 'negligible',
      direction: r > 0 ? 'positive' : 'negative',
      n: overlap.length,
      series: overlap.map((d, i) => ({ date: d, usage: usage[i], work: work[i] })),
    });
  }
  out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return { ...base, available: out.length > 0, metrics: out, reason: out.length ? null : 'No work metric had enough variation to correlate.' };
}

/**
 * Split a day set into higher- and lower-usage halves and compare the work
 * signal between them. Reported as a difference between groups — explicitly not
 * as "AI made you N% faster".
 */
export function calculateActivityContrast(usageSeries, workSeries, metric = 'insertions') {
  const usageBy = new Map(usageSeries.map((d) => [d.date, d.total]));
  const pairs = workSeries
    .filter((w) => usageBy.has(w.date) && usageBy.get(w.date) > 0)
    .map((w) => ({ date: w.date, usage: usageBy.get(w.date), work: w[metric] || 0 }));
  if (pairs.length < 8) return null;
  const sorted = [...pairs].sort((a, b) => a.usage - b.usage);
  const half = Math.floor(sorted.length / 2);
  const low = sorted.slice(0, half);
  const high = sorted.slice(-half);
  const avg = (a) => a.reduce((x, y) => x + y.work, 0) / a.length;
  const lo = avg(low);
  const hi = avg(high);
  return {
    metric,
    n: pairs.length,
    lowUsageMean: lo,
    highUsageMean: hi,
    difference: lo > 0 ? (hi - lo) / lo : null,
    note: 'Days grouped by AI usage; the difference is an observed association between the two groups, not an effect of AI usage.',
  };
}

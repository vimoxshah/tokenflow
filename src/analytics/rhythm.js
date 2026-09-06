/**
 * Rhythm: how the work happens — focus, switching, and when a turn costs
 * most.
 *
 * Pure functions over two shapes only:
 *  - a session (src/core/store.js `sessionList()`): `{ d, pj, total,
 *    durationMs, req, ... }`.
 *  - a per-hour rollup (src/analytics/token-usage.js
 *    `calculateHourlyUsage()` bucket): `{ hour, total, req, cost, costReq,
 *    ... }`.
 *
 * No Node imports (besides the shared, dependency-free formatter module), so
 * this runs the same in the browser, the CLI and the offline snapshot.
 */
import { pct, usd, compact, hourLabel, shortDate } from '../core/units.js';

/** A deep-work session runs this long or longer without a break. */
export const DEEP_WORK_MS = 45 * 60 * 1000;
/** ...or, when duration cannot be measured, spans at least this many turns. */
export const DEEP_WORK_TURNS = 40;

function hasKnownDuration(s) {
  return Number.isFinite(s.durationMs);
}

function isDeepWork(s) {
  if (hasKnownDuration(s)) return s.durationMs >= DEEP_WORK_MS;
  const turns = Number.isFinite(s.req) ? s.req : 0;
  return turns >= DEEP_WORK_TURNS;
}

/**
 * Deep-work sessions: count, share of sessions, share of tokens, longest.
 * A deep-work session runs 45 minutes or longer of continuous activity, or —
 * when duration is unknown — spans 40 or more turns (requests).
 * @param {any[]} sessions
 * @returns {{count:number, total:number, shareOfSessions:number|null, shareOfTokens:number|null, longest:any|null}}
 */
export function deepWork(sessions) {
  if (!sessions || !sessions.length) {
    return { count: 0, total: 0, shareOfSessions: null, shareOfTokens: null, longest: null };
  }
  const flagged = sessions.filter(isDeepWork);
  const totalTokens = sessions.reduce((a, s) => a + (s.total || 0), 0);
  const deepTokens = flagged.reduce((a, s) => a + (s.total || 0), 0);
  let longest = null;
  for (const s of sessions) {
    if (!hasKnownDuration(s)) continue;
    if (!longest || s.durationMs > longest.durationMs) longest = s;
  }
  return {
    count: flagged.length,
    total: sessions.length,
    shareOfSessions: sessions.length ? flagged.length / sessions.length : null,
    shareOfTokens: totalTokens > 0 ? deepTokens / totalTokens : null,
    longest,
  };
}

/**
 * Project-switching per day: distinct projects touched that day, minus one.
 * Only days that actually have a session are counted — a day with no
 * sessions has no measurable switching, which is not the same as zero
 * switching, so it is left out rather than filled in as a fabricated 0.
 * @param {any[]} sessions
 * @returns {{days:{date:string, projects:number, switches:number}[], average:number|null, worst:{date:string, projects:number, switches:number}|null}}
 */
export function switching(sessions) {
  if (!sessions || !sessions.length) return { days: [], average: null, worst: null };
  const byDay = new Map();
  for (const s of sessions) {
    const day = s.d;
    if (day === null || day === undefined) continue;
    let set = byDay.get(day);
    if (!set) { set = new Set(); byDay.set(day, set); }
    set.add(s.pj ?? 'unknown');
  }
  const days = [...byDay.entries()]
    .map(([date, projects]) => ({ date, projects: projects.size, switches: Math.max(0, projects.size - 1) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!days.length) return { days, average: null, worst: null };
  const total = days.reduce((a, d) => a + d.switches, 0);
  const average = total / days.length;
  let worst = days[0];
  for (const d of days.slice(1)) {
    if (d.switches > worst.switches || (d.switches === worst.switches && d.date > worst.date)) worst = d;
  }
  return { days, average, worst };
}

/**
 * Cost (or, failing that, tokens) per request by hour of day, from the
 * per-hour rollups behind `ctx.view` (the `hourly.buckets` this dashboard
 * already computes). The rows are shape-detected rather than assumed:
 *  - carries `cost` and `costReq` (requests a price could be assigned to) ->
 *    estimated cost per PRICED request, metric `'cost'`.
 *  - carries `total`/`tokens` and `req` only -> tokens per request, metric
 *    `'tokens'`.
 *  - neither -> `null`, so the caller can say "not derivable from the
 *    aggregate" instead of guessing.
 *
 * `costReq`, not `req`, is the denominator for the cost metric: `cost` is a
 * sum over priced requests only (src/core/store.js addToCube), so dividing
 * by every request would silently treat unpriced traffic as free — a false
 * zero, not a real one. When an hour has requests but none of them priced,
 * its `value` is `null` rather than 0.
 * @param {any[]} rows
 * @returns {{metric:'cost'|'tokens', hours:{hour:number, value:number|null, requests:number}[], costliest:{hour:number, value:number, requests:number}|null} | null}
 */
export function costliestHour(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sample = rows[0];
  /** @type {'cost'|'tokens'} */
  let metric;
  if ('cost' in sample && 'costReq' in sample) metric = 'cost';
  else if (('total' in sample || 'tokens' in sample) && 'req' in sample) metric = 'tokens';
  else return null;

  const hours = rows.map((r) => {
    const denom = metric === 'cost' ? (r.costReq || 0) : (r.req || 0);
    const numer = metric === 'cost' ? (r.cost || 0) : (r.total ?? r.tokens ?? 0);
    return { hour: r.hour, value: denom > 0 ? numer / denom : null, requests: denom };
  });
  const ranked = hours.filter((h) => h.value !== null);
  const costliest = ranked.length ? ranked.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  return { metric, hours, costliest };
}

/**
 * Days ranked by the share of that day's tokens spent in deep-work sessions,
 * top 5. Days with zero tokens are excluded — a 0/0 share is not a real 0%.
 * @param {any[]} sessions
 * @returns {{date:string, total:number, deepTokens:number, sessions:number, share:number}[]}
 */
export function focusDays(sessions) {
  if (!sessions || !sessions.length) return [];
  const byDay = new Map();
  for (const s of sessions) {
    const day = s.d;
    if (day === null || day === undefined) continue;
    let acc = byDay.get(day);
    if (!acc) { acc = { date: day, total: 0, deepTokens: 0, sessions: 0 }; byDay.set(day, acc); }
    const tokens = s.total || 0;
    acc.total += tokens;
    acc.sessions += 1;
    if (isDeepWork(s)) acc.deepTokens += tokens;
  }
  const days = [...byDay.values()]
    .filter((d) => d.total > 0)
    .map((d) => ({ ...d, share: d.deepTokens / d.total }));
  days.sort((a, b) => b.share - a.share || (a.date < b.date ? -1 : 1));
  return days.slice(0, 5);
}

/**
 * Three story-strip sentences summarizing the rhythm of work, in the style
 * of the Overview's insight cards.
 * @param {{deep:ReturnType<typeof deepWork>, switching:ReturnType<typeof switching>, costliest:ReturnType<typeof costliestHour>}} o
 * @returns {string[]}
 */
export function rhythmSummary({ deep, switching: sw, costliest }) {
  const s1 = deep.count > 0
    ? `Deep-work sessions were ${pct(deep.shareOfSessions, 1, 'n/a')} of sessions and ${pct(deep.shareOfTokens, 1, 'n/a')} of tokens.`
    : 'No deep-work sessions (45+ minutes, or 40+ turns when duration is unknown) in this slice.';

  const s2 = sw.days.length
    ? `Projects switched ${sw.average.toFixed(1)} times a day on average, worst was ${sw.worst.switches} switch${sw.worst.switches === 1 ? '' : 'es'} on ${shortDate(sw.worst.date)}.`
    : 'No sessions with a known day, so project switching cannot be measured.';

  let s3;
  if (!costliest) {
    s3 = 'Cost per request by hour is not derivable from the aggregate.';
  } else if (!costliest.costliest) {
    s3 = costliest.metric === 'cost'
      ? 'No priced requests in this slice, so cost per request by hour is not shown.'
      : 'No requests in this slice, so tokens per request by hour is not shown.';
  } else if (costliest.metric === 'cost') {
    s3 = `The costliest hour was ${hourLabel(costliest.costliest.hour)}:00, at ${usd(costliest.costliest.value)} per priced request.`;
  } else {
    s3 = `The heaviest hour was ${hourLabel(costliest.costliest.hour)}:00, at ${compact(costliest.costliest.value)} tokens per request.`;
  }

  return [s1, s2, s3];
}

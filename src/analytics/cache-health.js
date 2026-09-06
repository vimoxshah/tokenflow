/**
 * Cache health analytics: how well the prompt cache is working, and where it
 * gets invalidated and rewritten at a premium.
 *
 * Two kinds of input, kept apart on purpose:
 *
 *  - `hitRateSeries` and `writeSplitSeries` read the pre-aggregated cube
 *    (daily rows from `calculateDailyUsage`, e.g. `ctx.view.daily`). They work
 *    offline, because the cube ships in every bundle and every snapshot.
 *  - `detectChurn` and `summarize` read request-level records, one session at
 *    a time. Records never ship in a snapshot, so churn detection is a live
 *    dashboard feature only. See src/server/routes/cache-health.js.
 *
 * This module has no Node imports, so it runs the same in the browser, the
 * CLI and a test.
 */

/** A churn event needs at least this many write tokens. */
export const CHURN_MIN_WRITE_TOKENS = 10000;
/** ...and at least this share of the previous turn's cache read. */
export const CHURN_MIN_READ_SHARE = 0.5;

/**
 * Daily cache hit rate: cache_read / (cache_read + input).
 * @param {{key?:string, date?:string, cr:number, in:number}[]} rows daily cube rows, e.g. ctx.view.daily
 * @returns {{date:string, hitRate:number|null}[]} hitRate is null when neither field was measured that day
 */
export function hitRateSeries(rows) {
  return (rows || []).map((d) => {
    const date = d.key ?? d.date;
    const cr = d.cr || 0;
    const inTok = d.in || 0;
    const denom = cr + inTok;
    return { date, hitRate: denom > 0 ? cr / denom : null };
  });
}

/**
 * Daily cache write split: short-TTL writes (cache_write minus cache_refresh)
 * versus long-TTL writes (cache_refresh). Both are real sums from the cube,
 * so they are 0 (not null) on a day with no writes at all.
 * @param {{key?:string, date?:string, cw:number, cf:number}[]} rows daily cube rows
 * @returns {{date:string, shortTTL:number, longTTL:number}[]}
 */
export function writeSplitSeries(rows) {
  return (rows || []).map((d) => {
    const date = d.key ?? d.date;
    const cw = d.cw || 0;
    const cf = d.cf || 0;
    return { date, shortTTL: Math.max(0, cw - cf), longTTL: cf };
  });
}

/**
 * Find churn events in one session's turns: a turn whose cache write is at
 * least `CHURN_MIN_WRITE_TOKENS` and at least `CHURN_MIN_READ_SHARE` of the
 * PREVIOUS turn's cache read, in the same session. That pattern means the
 * cache was invalidated and rewritten, as happens when a system prompt
 * changes mid-session.
 *
 * Records are sorted by timestamp internally, so callers do not have to
 * guarantee order. A turn with a null write or a previous turn with a null
 * read cannot be evaluated and is skipped, never treated as a zero.
 *
 * @param {{timestamp:string, session_id?:string|null, project?:string|null,
 *          git_branch?:string|null, model?:string, provider?:string,
 *          cache_read_tokens:number|null, cache_write_tokens:number|null}[]} sessionRecords
 *   every record for one session
 * @param {ReturnType<typeof import('../core/pricing.js').buildPriceBook>} book price book for the cost premium
 * @returns {object[]} churn events, oldest first
 */
export function detectChurn(sessionRecords, book) {
  const turns = [...(sessionRecords || [])].sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    return a.timestamp < b.timestamp ? -1 : 1;
  });
  const events = [];
  for (let i = 1; i < turns.length; i++) {
    const cur = turns[i];
    const prev = turns[i - 1];
    const write = cur.cache_write_tokens;
    const prevRead = prev.cache_read_tokens;
    if (write === null || write === undefined) continue;
    if (prevRead === null || prevRead === undefined) continue;
    if (write < CHURN_MIN_WRITE_TOKENS) continue;
    if (write < CHURN_MIN_READ_SHARE * prevRead) continue;

    const rates = book ? book.lookup(cur.model, cur.provider) : null;
    const premiumUsd = rates && rates.cacheWrite !== null && rates.cacheWrite !== undefined
      && rates.cacheRead !== null && rates.cacheRead !== undefined
      ? (write / 1e6) * (rates.cacheWrite - rates.cacheRead)
      : null;

    events.push({
      sessionId: cur.session_id ?? null,
      project: cur.project ?? null,
      branch: cur.git_branch ?? null,
      turnIndex: i,
      writeTokens: write,
      previousReadTokens: prevRead,
      model: cur.model ?? null,
      provider: cur.provider ?? null,
      premiumUsd,
      timestamp: cur.timestamp ?? null,
    });
  }
  return events;
}

/**
 * Per-day event counts and the total estimated cost premium across every
 * churn event. `totalPremiumUsd` is a real 0 when there are no events, but
 * null (not available) when there are events and every one of them is priced
 * with an unknown model, so the total is never a silent zero standing in for
 * "unknown".
 * @param {ReturnType<typeof detectChurn>} events
 * @returns {{totalEvents:number, byDay:{date:string,count:number}[], totalPremiumUsd:number|null, premiumPartial:boolean}}
 */
export function summarize(events) {
  const list = events || [];
  const byDayMap = new Map();
  let totalPremium = 0;
  let premiumKnown = 0;
  for (const e of list) {
    const day = (e.timestamp || '').slice(0, 10);
    if (day) byDayMap.set(day, (byDayMap.get(day) || 0) + 1);
    if (e.premiumUsd !== null && e.premiumUsd !== undefined) {
      totalPremium += e.premiumUsd;
      premiumKnown++;
    }
  }
  const byDay = [...byDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));
  return {
    totalEvents: list.length,
    byDay,
    totalPremiumUsd: list.length === 0 ? 0 : (premiumKnown > 0 ? totalPremium : null),
    premiumPartial: list.length > 0 && premiumKnown < list.length,
  };
}

/**
 * Peak analysis. Every value here is an argmax over the filtered slice — there
 * are no thresholds and nothing is hardcoded.
 */
import { groupRows, rank, weekStart, monthKey, finalize, zeroMeasures, addInto } from './aggregate.js';

/**
 * @param {any[][]} rows filtered cube rows
 * @param {object} ix
 * @param {{series?:any[], topN?:number, sessions?:any[]}} opt
 */
export function calculatePeakUsage(rows, ix, opt = {}) {
  const topN = opt.topN ?? 10;
  const byDay = rank(rows, ix, (r) => r[ix.d.d]);
  const byWeek = rank(rows, ix, (r) => weekStart(r[ix.d.d]));
  const byMonth = rank(rows, ix, (r) => monthKey(r[ix.d.d]));
  const byHour = rank(rows, ix, (r) => r[ix.d.h]);
  const byProvider = rank(rows, ix, (r) => r[ix.d.p]);
  const byModel = rank(rows, ix, (r) => r[ix.d.m]);
  const byInterface = rank(rows, ix, (r) => r[ix.d.i]);
  const byProject = rank(rows, ix, (r) => r[ix.d.pj]);

  const maxBy = (groups, field) => {
    let best = null;
    for (const g of groups) if (!best || g.m[field] > best.m[field]) best = g;
    return best ? { key: best.key, value: best.m[field], total: best.m.total } : null;
  };

  // Lowest *active* day: a zero-token calendar gap is not a "low day".
  const activeDays = byDay.filter((g) => g.m.req > 0 && g.m.total > 0);
  const lowest = activeDays.length
    ? activeDays.reduce((a, b) => (b.m.total < a.m.total ? b : a))
    : null;

  const peakSession = opt.sessions && opt.sessions.length
    ? opt.sessions.reduce((a, b) => ((b.total || 0) > (a.total || 0) ? b : a))
    : null;

  return {
    topDays: byDay.slice(0, topN).map((g) => ({
      date: g.key, total: g.m.total, input: g.m.in, output: g.m.out,
      cache: g.m.cr + g.m.cw, requests: g.m.req,
    })),
    peakDay: byDay[0] ? { date: byDay[0].key, total: byDay[0].m.total } : null,
    lowestActiveDay: lowest ? { date: lowest.key, total: lowest.m.total } : null,
    peakWeek: byWeek[0] ? { weekStart: byWeek[0].key, total: byWeek[0].m.total } : null,
    peakMonth: byMonth[0] ? { month: byMonth[0].key, total: byMonth[0].m.total } : null,
    peakHour: byHour[0] ? { hour: Number(byHour[0].key), total: byHour[0].m.total } : null,
    peakProvider: byProvider[0] ? { provider: byProvider[0].key, total: byProvider[0].m.total } : null,
    peakModel: byModel[0] ? { model: byModel[0].key, total: byModel[0].m.total } : null,
    peakInterface: byInterface[0] ? { interface: byInterface[0].key, total: byInterface[0].m.total } : null,
    peakProject: byProject[0] ? { project: byProject[0].key, total: byProject[0].m.total } : null,
    highestOutputDay: maxBy(byDay, 'out'),
    highestInputDay: maxBy(byDay, 'in'),
    highestCacheDay: (() => {
      let best = null;
      for (const g of byDay) {
        const c = g.m.cr + g.m.cw;
        if (!best || c > best.value) best = { key: g.key, value: c, total: g.m.total };
      }
      return best;
    })(),
    busiestDayByRequests: maxBy(byDay, 'req'),
    peakSession: peakSession
      ? {
        id: peakSession.id, total: peakSession.total, model: peakSession.m,
        project: peakSession.pj, date: peakSession.d, requests: peakSession.req,
        durationMs: peakSession.durationMs,
      }
      : null,
  };
}

/** Per-day detail for the heatmap drill-down. */
export function dayDetail(rows, ix, date, sessions = []) {
  const dayRows = rows.filter((r) => r[ix.d.d] === date);
  if (!dayRows.length) return null;
  const m = finalize(dayRows.reduce((acc, r) => addInto(acc, r, ix), zeroMeasures()));
  const top = (dim) => {
    const g = rank(dayRows, ix, (r) => r[ix.d[dim]], { limit: 3 });
    return g.map((x) => ({ key: x.key, total: x.m.total, share: m.total ? x.m.total / m.total : null }));
  };
  const daySessions = sessions.filter((s) => s.d === date);
  return {
    date,
    total: m.total,
    input: m.in,
    output: m.out,
    cacheRead: m.cr,
    cacheWrite: m.cw,
    cache: m.cr + m.cw,
    reasoning: m.rs,
    requests: m.req,
    cost: m.costReq > 0 ? m.cost : null,
    sessions: daySessions.length,
    providers: top('p'),
    models: top('m'),
    interfaces: top('i'),
    projects: top('pj'),
    hours: (() => {
      const h = Array.from({ length: 24 }, () => 0);
      for (const r of dayRows) h[r[ix.d.h]] += r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
      return h;
    })(),
  };
}

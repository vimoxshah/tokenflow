/**
 * Comparison mode — two arbitrary periods, side by side.
 */
import { filterCube, filterSessions, sumRows, groupRows, daysBetween, addDays, rank } from './aggregate.js';
import { interfaceClass } from '../core/schema.js';

/**
 * @param {object} ix
 * @param {any[]} sessions
 * @param {object} filters base filters (date fields are overridden)
 * @param {{from:string,to:string}} a
 * @param {{from:string,to:string}} b
 */
export function calculatePeriodComparison(ix, sessions, filters, a, b) {
  const side = (p) => {
    const rows = filterCube(ix, { ...filters, from: p.from, to: p.to });
    const m = sumRows(rows, ix);
    const sess = filterSessions(sessions, { ...filters, from: p.from, to: p.to });
    const days = new Set(rows.map((r) => r[ix.d.d]));
    const cli = rows.reduce((acc, r) => {
      const c = interfaceClass(r[ix.d.i]);
      const t = r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
      acc.total += t;
      if (c === 'CLI / headless') acc.cli += t;
      return acc;
    }, { cli: 0, total: 0 });
    const byDay = rank(rows, ix, (r) => r[ix.d.d], { limit: 1 });
    return {
      period: p,
      calendarDays: daysBetween(p.from, p.to) + 1,
      activeDays: days.size,
      total: m.total,
      input: m.in,
      output: m.out,
      cacheRead: m.cr,
      cacheWrite: m.cw,
      cache: m.cr + m.cw,
      reasoning: m.rs,
      requests: m.req,
      sessions: sess.length,
      cost: m.costReq > 0 ? m.cost : null,
      avgPerActiveDay: days.size ? m.total / days.size : null,
      avgPerSession: sess.length ? m.total / sess.length : null,
      providers: new Set(rows.map((r) => r[ix.d.p])).size,
      models: new Set(rows.map((r) => r[ix.d.m])).size,
      cliShare: cli.total ? cli.cli / cli.total : null,
      peak: byDay[0] ? { date: byDay[0].key, total: byDay[0].m.total } : null,
      _rows: rows,
    };
  };

  const A = side(a);
  const B = side(b);
  const METRICS = [
    ['total', 'Total usage'], ['input', 'Input'], ['output', 'Output'],
    ['cache', 'Cache'], ['requests', 'Requests'], ['sessions', 'Sessions'],
    ['avgPerActiveDay', 'Avg / active day'], ['avgPerSession', 'Avg / session'],
    ['activeDays', 'Active days'], ['providers', 'Providers'], ['models', 'Models'],
    ['cliShare', 'CLI share'], ['cost', 'Estimated cost'],
  ];
  const deltas = METRICS.map(([k, label]) => {
    const av = A[k];
    const bv = B[k];
    const change = av === null || bv === null || av === 0 ? null : (bv - av) / av;
    return { key: k, label, a: av, b: bv, change, kind: k === 'cliShare' ? 'share' : k === 'cost' ? 'cost' : 'count' };
  });

  // Which providers/models moved — the "what changed" part of a comparison.
  const shift = (dim) => {
    const ga = groupRows(A._rows, ix, (r) => r[ix.d[dim]]);
    const gb = groupRows(B._rows, ix, (r) => r[ix.d[dim]]);
    const keys = new Set([...ga.keys(), ...gb.keys()]);
    const rows = [...keys].map((k) => {
      const x = ga.get(k)?.m.total ?? 0;
      const y = gb.get(k)?.m.total ?? 0;
      return { key: k, a: x, b: y, change: x ? (y - x) / x : null, absolute: y - x };
    });
    rows.sort((p, q) => Math.abs(q.absolute) - Math.abs(p.absolute));
    return rows;
  };

  // Compute the shifts BEFORE dropping the row references they read.
  const providerShift = shift('p');
  const modelShift = shift('m');
  const interfaceShift = shift('i');
  delete A._rows;
  delete B._rows;
  return { a: A, b: B, deltas, providerShift, modelShift, interfaceShift };
}

/** The previous equally-long window immediately before `from`. */
export function previousPeriod(from, to) {
  const len = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

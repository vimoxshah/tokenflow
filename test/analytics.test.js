import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexCube, filterCube, filterSessions, sumRows, computeView, resolveRange,
  calculateDailyUsage, movingAverage, calculateAverageUsage, calculateComposition,
  calculateUsageTrend, calculateHourlyUsage, calculateDowUsage, calculateHourDow,
  calendarLevels, calculatePeakUsage, calculateEfficiency, calculateCost,
  calculatePeriodComparison, previousPeriod, calculateDimensionUsage,
  calculateCorrelations, calculateWorkSeries, generateInsights, addDays, daysBetween,
} from '../src/analytics/index.js';
import { pearson } from '../src/analytics/productivity.js';
import { calendarLevels as levels } from '../src/analytics/token-usage.js';
import { cubeFrom, sessionsFrom } from './helpers.js';
import { createRecord, dateParts } from '../src/core/schema.js';

function rec(o) {
  const dp = dateParts(o.timestamp, 'UTC');
  return createRecord({
    ...o, date: dp.date, hour: dp.hour, dow: dp.dow, tz_offset: 0,
    source: o.source || 'test', id: o.id || Math.random().toString(36).slice(2),
    provider: o.provider || 'anthropic', model: o.model || 'claude-opus-5',
    model_family: 'Claude Opus 5', client: o.client || 'claude-code',
    interface: o.interface || 'CLI', project: o.project || 'proj',
  });
}

/** A small deterministic dataset: 10 days, two providers, two interfaces. */
async function dataset() {
  const records = [];
  for (let d = 1; d <= 10; d++) {
    const day = `2026-08-${String(d).padStart(2, '0')}`;
    if (d === 4) continue; // a genuinely idle day
    const n = d;
    for (let i = 0; i < n; i++) {
      records.push(rec({
        timestamp: `${day}T${String(9 + (i % 6)).padStart(2, '0')}:15:00Z`,
        input_tokens: 100 * d, output_tokens: 10 * d,
        cache_read_tokens: 1000 * d, cache_write_tokens: 50 * d,
        cache_refresh_tokens: 20 * d, reasoning_tokens: 4 * d,
        session_id: `s-${day}-${i % 2}`,
      }));
    }
    records.push(rec({
      timestamp: `${day}T21:00:00Z`, provider: 'openai', model: 'gpt-4o',
      client: 'codex', interface: 'IDE',
      input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0,
      session_id: `cx-${day}`,
    }));
  }
  const cube = await cubeFrom(records);
  return { records, cube, sessions: sessionsFrom(records), ix: indexCube(cube) };
}

test('filterCube: a date window is inclusive at both ends', async () => {
  const { ix } = await dataset();
  const rows = filterCube(ix, { from: '2026-08-02', to: '2026-08-03' });
  const dates = new Set(rows.map((r) => r[ix.d.d]));
  assert.deepEqual([...dates].sort(), ['2026-08-02', '2026-08-03']);
});

test('filterCube: an hour window can wrap past midnight', async () => {
  const { ix } = await dataset();
  const wrapped = filterCube(ix, { hourFrom: 21, hourTo: 9 });
  const hours = new Set(wrapped.map((r) => r[ix.d.h]));
  assert.ok(hours.has(21) && hours.has(9), 'both ends of a wrapping window are included');
  assert.ok(![...hours].some((h) => h > 9 && h < 21), 'the middle of the day is excluded');
});

test('filterCube: overlay rows are excluded unless asked for', async () => {
  const records = [
    rec({ timestamp: '2026-08-01T10:00:00Z', input_tokens: 100, output_tokens: 10 }),
    rec({ timestamp: '2026-08-01T10:00:00Z', input_tokens: 999, measurement: 'overlay', source: 'gw' }),
  ];
  const ix = indexCube(await cubeFrom(records));
  assert.equal(sumRows(filterCube(ix, {}), ix).in, 100, 'overlay excluded by default');
  assert.equal(sumRows(filterCube(ix, { includeOverlay: true }), ix).in, 1099);
});

test('activity rows never add tokens but do count as activity', async () => {
  const records = [
    rec({ timestamp: '2026-08-01T10:00:00Z', input_tokens: 100, output_tokens: 10 }),
    rec({
      timestamp: '2026-08-02T10:00:00Z', measurement: 'activity', source: 'cursor', client: 'cursor',
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    }),
  ];
  const ix = indexCube(await cubeFrom(records));
  const rows = filterCube(ix, {});
  const totals = sumRows(rows, ix);
  assert.equal(totals.total, 110);
  const series = calculateDailyUsage(rows, ix, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(series[0].tokenActive, true);
  assert.equal(series[1].active, true, 'the activity day is active');
  assert.equal(series[1].tokenActive, false, 'but not token-active');
  const avg = calculateAverageUsage(series);
  assert.equal(avg.activeDays, 1, 'token averages use token-active days only');
  assert.equal(avg.activityOnlyDays, 1);
  assert.equal(avg.perActiveDay, 110);
});

test('missing fields are counted, not zero-filled', async () => {
  const records = [
    rec({ timestamp: '2026-08-01T10:00:00Z', input_tokens: 100, output_tokens: 10, cache_read_tokens: null, cache_write_tokens: null }),
  ];
  const ix = indexCube(await cubeFrom(records));
  const t = sumRows(filterCube(ix, {}), ix);
  assert.equal(t.cr, 0, 'the sum of nothing is zero');
  assert.equal(t.naCr, 1, 'but one record is recorded as not-available');
  assert.equal(t.naIn, 0);
});

test('calculateDailyUsage fills calendar gaps and marks them inactive', async () => {
  const { ix } = await dataset();
  const series = calculateDailyUsage(filterCube(ix, {}), ix, { from: '2026-08-01', to: '2026-08-10' });
  assert.equal(series.length, 10);
  const idle = series.find((d) => d.date === '2026-08-04');
  assert.equal(idle.active, false);
  assert.equal(idle.total, 0);
  assert.equal(series.filter((d) => d.tokenActive).length, 9);
});

test('movingAverage is null until its window fills, then correct', () => {
  const s = [1, 2, 3, 4, 5].map((v) => ({ total: v }));
  const ma = movingAverage(s, 3);
  assert.deepEqual(ma.slice(0, 2), [null, null]);
  assert.equal(ma[2], 2);
  assert.equal(ma[4], 4);
});

test('composition ratios use the right denominators', () => {
  const totals = { in: 100, out: 50, cr: 800, cw: 50, cf: 20, rs: 10, req: 1, total: 1000, cache: 850, naIn: 0, naOut: 0, naCr: 0, naCw: 0, naAny: 0, cost: 0, costMeasured: 0, costReq: 0 };
  const c = calculateComposition(totals);
  assert.equal(c.shares.input, 0.1);
  assert.equal(c.cacheRatio, 0.85);
  assert.equal(c.outputPerInput, 0.5, 'output over FRESH input');
  assert.equal(c.outputPerPromptToken, 50 / 950, 'output over everything actually sent');
  assert.equal(c.cacheHitRate, 800 / 900, 'cache reads over all prompt-side tokens');
  assert.equal(c.reasoningShareOfOutput, 0.2);
  assert.equal(c.refreshShareOfCacheWrite, 0.4);
});

test('trend refuses to invent a number without a comparison base', () => {
  assert.equal(calculateUsageTrend([{ total: 1 }]).change, null);
  const flat = Array.from({ length: 60 }, () => ({ total: 0 }));
  assert.equal(calculateUsageTrend(flat).change, null, 'a zero base has no percentage change');
});

test('trend compares the last window against the one before it', () => {
  const series = [
    ...Array.from({ length: 30 }, () => ({ total: 100 })),
    ...Array.from({ length: 30 }, () => ({ total: 150 })),
  ];
  const t = calculateUsageTrend(series, 30);
  assert.equal(t.window, 30);
  assert.equal(Math.round(t.change * 100), 50);
  assert.equal(t.direction, 'increasing');
});

test('hourly analysis finds the busiest window and can wrap midnight', () => {
  const buckets = Array.from({ length: 24 }, () => 0);
  const rows = [];
  const ix = { d: { h: 0, w: 1, d: 2, ms: 3 }, m: { in: 4, out: 5, cr: 6, cw: 7, cf: 8, rs: 9, req: 10, cost: 11, costMeasured: 12, costReq: 13, naIn: 14, naOut: 15, naCr: 16, naCw: 17 } };
  for (const h of [22, 23, 0]) rows.push(makeRow(ix, h, 1000));
  const r = calculateHourlyUsage(rows, ix);
  assert.equal(r.peakWindow.from, 22);
  assert.equal(r.peakWindow.to, 0);
});

function makeRow(ix, hour, tokens) {
  const row = new Array(18).fill(0);
  row[ix.d.h] = hour;
  row[ix.d.w] = 0;
  row[ix.d.d] = '2026-08-01';
  row[ix.d.ms] = 'primary';
  row[ix.m.in] = tokens;
  row[ix.m.req] = 1;
  return row;
}

test('calendar levels come from percentiles, so scale does not matter', () => {
  const small = levels([1, 2, 3, 4, 40].map((v, i) => ({ date: `2026-08-0${i + 1}`, total: v, active: true, tokenActive: true })));
  const big = levels([1e9, 2e9, 3e9, 4e9, 40e9].map((v, i) => ({ date: `2026-08-0${i + 1}`, total: v, active: true, tokenActive: true })));
  assert.equal(small.levelOf(40, true), big.levelOf(40e9, true), 'the same shape gets the same level');
  assert.equal(small.levelOf(0, false), 0, 'an inactive day is level 0');
});

test('peak analysis returns argmaxes and excludes idle days from the low', async () => {
  const { ix, sessions } = await dataset();
  const rows = filterCube(ix, {});
  const series = calculateDailyUsage(rows, ix, { from: '2026-08-01', to: '2026-08-10' });
  const p = calculatePeakUsage(rows, ix, { series, sessions, topN: 5 });
  assert.equal(p.peakDay.date, '2026-08-10', 'usage grows with the day number');
  assert.equal(p.topDays.length, 5);
  assert.equal(p.lowestActiveDay.date, '2026-08-01', 'not 2026-08-04, which had no usage at all');
  assert.ok(p.peakHour);
  assert.equal(p.peakProvider.provider, 'anthropic');
  assert.equal(p.peakInterface.interface, 'CLI');
});

test('efficiency ratios divide by what they say they divide by', () => {
  const totals = { in: 100, out: 50, cr: 900, cw: 0, cf: 0, rs: 5, req: 10, total: 1050 };
  const e = calculateEfficiency(totals, { sessions: 5, activeDays: 2 });
  assert.equal(e.tokensPerSession, 210);
  assert.equal(e.outputPerSession, 10);
  assert.equal(e.tokensPerActiveDay, 525);
  assert.equal(e.tokensPerRequest, 105);
  assert.equal(e.freshPerCachedPrompt, 100 / 900);
});

test('cost is null, with an explanation, when nothing is priced', () => {
  const totals = { in: 1, out: 1, cr: 0, cw: 0, req: 10, total: 2, cost: 0, costMeasured: 0, costReq: 0 };
  const c = calculateCost(totals, { unpriced: [{ model: 'x', total: 5 }] });
  assert.equal(c.estimated, null, 'no price means no number, not zero');
  assert.equal(c.coverage, 0);
  assert.match(c.basisNote, /No pricing configured/);
});

test('cost reports partial coverage instead of implying completeness', () => {
  const totals = { in: 1, out: 1, cr: 0, cw: 0, req: 10, total: 2, cost: 4, costMeasured: 0, costReq: 4 };
  const c = calculateCost(totals, { sessions: 2, activeDays: 2 });
  assert.equal(c.estimated, 4);
  assert.equal(c.coverage, 0.4);
  assert.match(c.basisNote, /40\.0% of requests/);
});

test('period comparison reports null rather than a change from a zero base', async () => {
  const { ix, sessions } = await dataset();
  const cmp = calculatePeriodComparison(ix, sessions, {}, { from: '2026-08-01', to: '2026-08-05' }, { from: '2026-08-06', to: '2026-08-10' });
  assert.ok(cmp.b.total > cmp.a.total);
  const total = cmp.deltas.find((d) => d.key === 'total');
  assert.ok(total.change > 0);
  const cmp2 = calculatePeriodComparison(ix, sessions, {}, { from: '2026-07-01', to: '2026-07-05' }, { from: '2026-08-06', to: '2026-08-10' });
  assert.equal(cmp2.deltas.find((d) => d.key === 'total').change, null, 'growth from nothing is undefined');
});

test('previousPeriod is the same length, immediately before', () => {
  const p = previousPeriod('2026-08-11', '2026-08-20');
  assert.equal(p.to, '2026-08-10');
  assert.equal(p.from, '2026-08-01');
  assert.equal(daysBetween(p.from, p.to), 9);
});

test('dimension usage shares sum to 1 and peak days are per dimension', async () => {
  const { ix, sessions } = await dataset();
  const rows = filterCube(ix, {});
  const totals = sumRows(rows, ix);
  const dims = calculateDimensionUsage(rows, ix, 'p', { sessions, grandTotal: totals.total });
  const sum = dims.reduce((a, d) => a + d.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(dims[0].key, 'anthropic');
  assert.ok(dims[0].peakDay);
  assert.equal(dims.find((d) => d.key === 'openai').activeDays, 9);
});

test('pearson returns null for a degenerate series instead of zero', () => {
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.equal(pearson([1, 2], [1, 2]), null, 'too few points');
  assert.equal(Math.round(pearson([1, 2, 3, 4], [2, 4, 6, 8])), 1);
});

test('correlation refuses to report on too little overlap, and says why', () => {
  const usage = Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, total: 100 + i }));
  const work = [{ date: '2026-08-01', commits: 3, insertions: 10, files: 2, aiLines: 1, edits: 0 }];
  const c = calculateCorrelations(usage, work, { minOverlap: 10 });
  assert.equal(c.available, false);
  assert.match(c.reason, /at least 10/);
});

test('correlation is reported with n and labelled as correlation only', () => {
  const usage = Array.from({ length: 20 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, total: (i + 1) * 100 }));
  const work = usage.map((u, i) => ({ date: u.date, commits: i + 1, insertions: (i + 1) * 5, files: 1, aiLines: 0, edits: 0 }));
  const c = calculateCorrelations(usage, work, { minOverlap: 10 });
  assert.equal(c.available, true);
  assert.equal(c.metrics[0].n, 20);
  assert.ok(c.metrics[0].r > 0.99);
  assert.match(c.note, /not a measure of productivity/i);
});

test('work series aggregates the activity rollup by day', () => {
  const activity = {
    rows: {
      'a|git|p1': { d: '2026-08-01', so: 'git', pj: 'p1', commits: 2, files: 5, ins: 100, del: 10, aiLines: 0, humanLines: 0, edits: 0 },
      'b|git|p2': { d: '2026-08-01', so: 'git', pj: 'p2', commits: 1, files: 2, ins: 40, del: 4, aiLines: 0, humanLines: 0, edits: 0 },
    },
  };
  const w = calculateWorkSeries(activity);
  assert.equal(w.length, 1);
  assert.equal(w[0].commits, 3);
  assert.equal(w[0].insertions, 140);
  assert.equal(calculateWorkSeries(activity, { projects: ['p1'] })[0].commits, 2);
});

test('resolveRange honours the dataset, not the wall clock', () => {
  const cov = { from: '2026-03-14', to: '2026-08-20' };
  assert.deepEqual(resolveRange('all', cov, '2026-08-20'), { from: '2026-03-14', to: '2026-08-20' });
  assert.deepEqual(resolveRange('7d', cov, '2026-08-20'), { from: '2026-08-14', to: '2026-08-20' });
  assert.deepEqual(resolveRange('mtd', cov, '2026-08-20'), { from: '2026-08-01', to: '2026-08-20' });
  assert.deepEqual(resolveRange('lastmonth', cov, '2026-08-20'), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(resolveRange('today', cov, '2026-08-20'), { from: '2026-08-20', to: '2026-08-20' });
});

test('computeView produces a coherent view and matches its own totals', async () => {
  const { cube, sessions } = await dataset();
  const v = computeView({ cube, sessions, activity: { rows: {} }, meta: {}, pricing: {} }, {});
  assert.equal(v.range.from, '2026-08-01');
  assert.equal(v.range.to, '2026-08-10');
  const seriesTotal = v.daily.reduce((a, d) => a + d.total, 0);
  assert.equal(seriesTotal, v.totals.total, 'the series must sum to the headline total');
  const dimTotal = v.dimensions.providers.reduce((a, p) => a + p.total, 0);
  assert.equal(dimTotal, v.totals.total, 'provider breakdown must sum to the headline total');
  const ifaceTotal = v.dimensions.interfaces.reduce((a, p) => a + p.total, 0);
  assert.equal(ifaceTotal, v.totals.total);
  const compTotal = v.composition.input + v.composition.output + v.composition.cacheRead + v.composition.cacheWrite;
  assert.equal(compTotal, v.totals.total, 'composition must be exhaustive and non-overlapping');
  assert.equal(v.kpis.total.value, v.totals.total);
  const hourTotal = v.hourly.buckets.reduce((a, b) => a + b.total, 0);
  assert.equal(hourTotal, v.totals.total, 'hour buckets must be exhaustive');
  const dowTotal = v.dowUsage.reduce((a, b) => a + b.total, 0);
  assert.equal(dowTotal, v.totals.total);
  const matrixTotal = v.hourDow.cells.reduce((a, c) => a + c.total, 0);
  assert.equal(matrixTotal, v.totals.total);
});

test('filters scope every part of the view consistently', async () => {
  const { cube, sessions } = await dataset();
  const bundle = { cube, sessions, activity: { rows: {} }, meta: {}, pricing: {} };
  const all = computeView(bundle, {});
  const only = computeView(bundle, { provider: ['openai'] });
  assert.ok(only.totals.total < all.totals.total);
  assert.equal(only.dimensions.providers.length, 1);
  assert.equal(only.dimensions.providers[0].key, 'openai');
  assert.equal(only.dimensions.providers[0].share, 1);
  assert.equal(only.daily.reduce((a, d) => a + d.total, 0), only.totals.total);
});

test('insights are empty-but-honest on an empty slice', async () => {
  const { cube, sessions } = await dataset();
  const v = computeView({ cube, sessions, activity: { rows: {} }, meta: {}, pricing: {} }, { provider: ['nope'] });
  assert.equal(v.insights.length, 1);
  assert.equal(v.insights[0].kind, 'empty');
  assert.equal(v.totals.total, 0);
});

test('insights never claim a trend without enough active days', async () => {
  const records = [rec({ timestamp: '2026-08-01T10:00:00Z', input_tokens: 10, output_tokens: 1 })];
  const cube = await cubeFrom(records);
  const v = computeView({ cube, sessions: sessionsFrom(records), activity: { rows: {} }, meta: {}, pricing: {} }, {});
  assert.ok(!v.insights.some((i) => i.kind === 'trend'), 'one day is not a trend');
});

test("an overlay source's tokens stay out of the totals but its measured cost is reported", async () => {
  const records = [
    rec({
      timestamp: '2026-08-01T10:00:00Z', input_tokens: 1e6, output_tokens: 2e6,
      cache_read_tokens: 0, cache_write_tokens: 0, session_id: 's1',
      estimated_cost: 55, cost_basis: 'estimated',
    }),
    // The gateway's own billing log describing the same traffic.
    rec({
      timestamp: '2026-08-01T10:00:05Z', input_tokens: 1e6, output_tokens: 2e6,
      cache_read_tokens: 0, cache_write_tokens: 0, session_id: 'g1',
      source: 'headroom', measurement: 'overlay',
      estimated_cost: 42.5, cost_basis: 'measured',
    }),
  ];
  const bundle = { cube: await cubeFrom(records), sessions: sessionsFrom(records), activity: { rows: {} }, pricing: {} };
  const v = computeView(bundle, {});

  assert.equal(v.totals.total, 3e6, 'overlay tokens are not double counted');
  assert.equal(v.cost.measured, 42.5, 'the gateway bill is still reported');
  assert.equal(v.cost.measuredOverlay, 42.5);
  assert.equal(v.cost.measuredInSlice, null);
  assert.match(v.cost.measuredNote, /excluded from the totals/);
  // The estimate stands on its own and never absorbs the measured number.
  assert.equal(v.cost.estimated, 55);

  // Including the overlay counts its tokens and stops attributing the cost twice.
  const withOverlay = computeView(bundle, { includeOverlay: true });
  assert.equal(withOverlay.totals.total, 6e6);
  assert.equal(withOverlay.cost.measured, 42.5);
  assert.equal(withOverlay.cost.measuredOverlay, null);
});

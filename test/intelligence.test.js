import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linearForecast, monthEndProjection, buildForecast, exhaustionEta, lastDayOfMonth,
} from '../src/analytics/forecast.js';
import { detectAnomalies, modifiedZ, firstSeenEntities } from '../src/analytics/anomalies.js';
import {
  normalizeLimit, normalizeLimits, evaluateLimits, summarizeCapacity,
  resetFor, windowFor, localMidnightMs,
} from '../src/analytics/capacity.js';
import { indexCube } from '../src/analytics/aggregate.js';

// ---------------------------------------------------------------- forecast --

/** Calendar-complete daily series with a deterministic shape. */
function series(values, start = '2026-07-01') {
  const out = [];
  const [y, m, d] = start.split('-').map(Number);
  let dt = new Date(Date.UTC(y, m - 1, d));
  for (const v of values) {
    out.push({
      key: dt.toISOString().slice(0, 10),
      total: v.total ?? v,
      cost: v.cost ?? (Number.isFinite(v.total) ? (v.total ?? v) / 1e6 : 0),
      req: v.req ?? 10,
      active: true,
      tokenActive: (v.total ?? v) > 0,
      in: 0, out: 0, cr: 0, cw: 0,
    });
    dt = new Date(dt.getTime() + 86400000);
  }
  return out;
}

test('forecast: a perfectly linear series is predicted exactly', () => {
  const s = series(Array.from({ length: 14 }, (_, i) => ({ total: 1000 + i * 100 })));
  const fc = linearForecast(s);
  assert.equal(fc.next, 2400);
  assert.equal(fc.confidence, 'high');
  assert.equal(fc.horizon.days, 7);
});

test('forecast: too few points yields nulls with a reason, never a number', () => {
  const fc = linearForecast(series([100, 200, 300]));
  assert.equal(fc.next, null);
  assert.ok(fc.reason.includes('need at least'));
});

test('forecast: a flat series gets high confidence and a tight interval', () => {
  const s = series(Array.from({ length: 12 }, () => ({ total: 5000 })));
  const fc = linearForecast(s);
  assert.equal(fc.next, 5000);
  // Flat history has zero residual spread; the interval must not be NaN.
  assert.equal(fc.interval[0], 5000);
  assert.equal(fc.interval[1], 5000);
});

test('monthEndProjection splits measured from forecast', () => {
  // July has 31 days; pretend today is July 20.
  const values = Array.from({ length: 20 }, (_, i) => ({ total: 1000 }));
  const s = series(values, '2026-07-01');
  const p = monthEndProjection(s, '2026-07-20');
  assert.equal(p.actualToDate, 20000);           // measured
  assert.equal(p.remainingDays, 11);             // Jul 21..31
  assert.equal(p.forecastRemainder, 11000);      // predicted
  assert.equal(p.projected, 31000);              // the sum, labelled as projection
  assert.equal(lastDayOfMonth('2026-07-20'), '2026-07-31');
  assert.equal(lastDayOfMonth('2024-02-03'), '2024-02-29');
});

test('monthEndProjection on the last day of the month is pure fact', () => {
  const s = series([{ total: 100 }, { total: 100 }], '2026-07-30');
  const p = monthEndProjection(s, '2026-07-31');
  assert.equal(p.remainingDays, 0);
  assert.equal(p.forecastRemainder, 0);
  assert.equal(p.projected, 200);
});

test('exhaustionEta prefers hourly burn and falls back to daily', () => {
  assert.equal(exhaustionEta({ remaining: 0, burnPerHour: 10, nowMs: 0 }), null);
  const hourly = exhaustionEta({ remaining: 300, burnPerHour: 50, nowMs: 0 });
  assert.equal(hourly.hours, 6);
  assert.equal(hourly.via, 'hourly');
  const daily = exhaustionEta({ remaining: 300, burnPerHour: null, burnPerDay: 100, nowMs: 0 });
  assert.equal(daily.hours, 72);
  assert.equal(daily.via, 'daily');
  assert.equal(exhaustionEta({ remaining: 300, burnPerHour: null, burnPerDay: null, nowMs: 0 }), null);
});

test('buildForecast carries cost only when cost data exists', () => {
  const s = series(Array.from({ length: 12 }, (_, i) => ({ total: 1000 + i * 10, cost: 0.5 + i * 0.01 })));
  const fc = buildForecast(s, '2026-07-12');
  assert.equal(fc.n, 12);
  assert.notEqual(fc.next7daysCost, null);
  const noCost = buildForecast(series(Array.from({ length: 12 }, (_, i) => ({ total: 1000 + i * 10, cost: 0 }))), '2026-07-12');
  assert.equal(noCost.next7daysCost, null);
});

// --------------------------------------------------------------- anomalies --

test('anomalies: a clear spike is flagged with its arithmetic', () => {
  // Noisy-but-stable history (so MAD > 0), then an unmistakable spike.
  const vals = Array.from({ length: 30 }, (_, i) => 1000 + Math.round(Math.sin(i) * 100));
  vals[29] = 8000;
  const out = detectAnomalies(series(vals));
  const spike = out.find((a) => a.type === 'token_spike');
  assert.ok(spike, 'expected a spike anomaly');
  assert.equal(spike.severity, 'high');
  assert.equal(spike.observed, 8000);
  assert.ok(Math.abs(spike.expectedMedian - 1000) < 60, `median ${spike.expectedMedian}`);
  assert.ok(spike.z > 6);
  assert.ok(spike.detail.includes('trailing'));
});

test('anomalies: quiet data produces an empty list', () => {
  const vals = Array.from({ length: 30 }, (_, i) => 1000 + Math.sin(i) * 50);
  assert.deepEqual(detectAnomalies(series(vals)), []);
});

test('anomalies: a weekday zero between two active days is a possible gap', () => {
  // 2026-07-15 is a Wednesday. Build Mon..Fri active around it.
  const s = series(
    Array.from({ length: 17 }, (_, i) => ({ total: 1000 })),
    '2026-07-06',
  );
  const wed = s.find((d) => d.key === '2026-07-15');
  wed.total = 0;
  wed.active = false;
  wed.tokenActive = false;
  const out = detectAnomalies(s);
  assert.ok(out.some((a) => a.type === 'possible_gap' && a.date === '2026-07-15'), JSON.stringify(out));
});

test('anomalies: weekend zeros are never called gaps', () => {
  const s = series(Array.from({ length: 17 }, () => ({ total: 1000 })), '2026-07-06');
  for (const d of s) if (['2026-07-11', '2026-07-12'].includes(d.key)) { d.total = 0; d.active = false; d.tokenActive = false; }
  assert.deepEqual(
    detectAnomalies(s).filter((a) => a.type === 'possible_gap'),
    [],
  );
});

test('anomalies: modified z-score caps flat-history surprises at warn level', () => {
  assert.equal(modifiedZ(1100, { med: 1000, mad: 0 }), 4.99);
  assert.equal(modifiedZ(1000, { med: 1000, mad: 0 }), 0);
});

test('firstSeenEntities reports models that appeared inside the window', async () => {
  const recs = [];
  for (let i = 1; i <= 20; i++) {
    const day = `2026-08-${String(i).padStart(2, '0')}`;
    recs.push(mkRec(`${day}T10:00:00Z`, i < 18 ? 'old-model' : 'brand-new-model'));
  }
  const ix = indexCube(await buildCube(recs));
  const fresh = firstSeenEntities(ix, { today: '2026-08-20', withinDays: 7, dim: 'm' });
  assert.deepEqual(fresh.map((f) => f.entity), ['brand-new-model']);
  assert.equal(fresh[0].firstSeen, '2026-08-18');
  const all = firstSeenEntities(ix, { today: '2026-08-20', withinDays: 3650, dim: 'm' });
  assert.equal(all.length, 2);
});

/** Build one record from a full ISO timestamp. */
function mkRec(timestamp, model) {
  return {
    timestamp,
    provider: 'anthropic',
    model,
    input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0,
  };
}

async function buildCube(recs) {
  const { cubeFrom } = await import('./helpers.js');
  const { createRecord, dateParts } = await import('../src/core/schema.js');
  return cubeFrom(recs.map((o) => {
    const dp = dateParts(o.timestamp, 'UTC');
    return createRecord({
      ...o, date: dp.date, hour: dp.hour, dow: dp.dow, tz_offset: 0,
      source: 'test', id: `${o.timestamp}|${o.model}`,
      model_family: o.model, client: 'claude-code', interface: 'CLI', project: 'p',
    });
  }));
}

// ---------------------------------------------------------------- capacity --

const LIMITS = [
  { id: 'day-tokens', scope: 'day', metric: 'tokens', cap: 12500 },
  { id: 'day-openai', provider: 'openai', scope: 'day', metric: 'tokens', cap: 6250, warnAt: 0.5 },
  { id: 'week-anthropic', provider: 'anthropic', scope: 'week', metric: 'tokens', cap: 250000, warnAt: 0.8 },
  { id: 'month-cost', scope: 'month', metric: 'cost', cap: 3 },
];

test('capacity: invalid limit definitions are rejected with reasons', () => {
  assert.equal(normalizeLimit({}).ok, false);
  const bad = normalizeLimit({ id: 'x', scope: 'fortnight', metric: 'tokens', cap: -1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(normalizeLimit({ id: 'x', scope: 'day', metric: 'tokens', cap: 5 }).ok, true);
  const dupes = normalizeLimits([{ id: 'a', scope: 'day', cap: 1 }, { id: 'a', scope: 'day', cap: 2 }]);
  assert.equal(dupes.limits.length, 1);
  assert.equal(dupes.invalid[0].errors[0], 'duplicate id');
});

test('capacity: window + reset calendar math is exact across timezones', () => {
  assert.deepEqual(windowFor('day', '2026-08-20'), { from: '2026-08-20', to: '2026-08-20' });
  // Thu 2026-08-20 sits in the week starting Mon 2026-08-17.
  assert.deepEqual(windowFor('week', '2026-08-20'), { from: '2026-08-17', to: '2026-08-20' });
  assert.deepEqual(windowFor('month', '2026-08-20'), { from: '2026-08-01', to: '2026-08-20' });

  const noonUtc = Date.UTC(2026, 7, 20, 12, 0);
  assert.equal(resetFor('day', '2026-08-20', 0, noonUtc).atMs, Date.UTC(2026, 7, 21));
  assert.equal(resetFor('week', '2026-08-20', 0, noonUtc).atMs, Date.UTC(2026, 7, 24)); // next Monday
  assert.equal(resetFor('month', '2026-08-20', 0, noonUtc).atMs, Date.UTC(2026, 8, 1));

  // UTC+5:30: local midnight of Aug 21 is 18:30 UTC on Aug 20.
  assert.equal(localMidnightMs('2026-08-21', 330), Date.UTC(2026, 7, 20, 18, 30));
  const ist = resetFor('day', '2026-08-20', 330, Date.UTC(2026, 7, 20, 6, 30));
  assert.equal(ist.atMs, Date.UTC(2026, 7, 20, 18, 30));
  assert.equal(ist.inMs, 12 * 3600000);
});

/**
 * Deterministic dataset. Mon 2026-08-17 .. Thu 2026-08-20 (today = the 20th):
 *   anthropic totals by day: 20000 / 30000 / 40000 / 10000 (in = 90%, out = 10%)
 *   each anthropic record carries estimated_cost $1 -> MTD cost $4
 *   today also has an openai record with 5000 fresh input and no cost.
 */
async function capacityDataset() {
  /** @type {[string, number][]} */
  const days = [
    ['2026-08-17', 20000], ['2026-08-18', 30000], ['2026-08-19', 40000], ['2026-08-20', 10000],
  ];
  /** @type {object[]} */
  const recs = days.map(([day, total]) => ({
    ...mkRec(`${day}T10:00:00Z`, 'claude-opus-5'),
    input_tokens: Math.round(total * 0.9),
    output_tokens: total - Math.round(total * 0.9),
    estimated_cost: 1,
    cost_basis: 'estimated',
  }));
  recs.push({
    ...mkRec('2026-08-20T15:00:00Z', 'gpt-5'),
    provider: 'openai',
    client: 'codex',
    input_tokens: 5000,
    output_tokens: 0,
    estimated_cost: null,
  });
  return { cube: await buildCube(recs) };
}

test('capacity: consumption, status boundaries and scoping are exact', async () => {
  const { cube } = await capacityDataset();
  const { states, invalid } = evaluateLimits(LIMITS, {
    cube,
    today: '2026-08-20',
    nowMs: Date.UTC(2026, 7, 20, 12, 0),
    tzOffsetMinutes: 0,
  });
  assert.deepEqual(invalid, []);
  const byId = Object.fromEntries(states.map((s) => [s.id, s]));

  // Unscoped day limit sees both records today: 10000 + 5000 = 15000 -> exceeded.
  assert.equal(byId['day-tokens'].used, 15000);
  assert.equal(byId['day-tokens'].status, 'exceeded');
  assert.equal(byId['day-tokens'].remaining, 0);
  assert.equal(byId['day-tokens'].etaHours, null);

  // Provider-scoped limit counts only openai's 5000: exactly at the warn boundary (0.8 of 6250).
  assert.equal(byId['day-openai'].used, 5000);
  assert.ok(Math.abs(byId['day-openai'].pctUsed - 0.8) < 1e-12);
  assert.equal(byId['day-openai'].status, 'warn');

  // Week limit proves scoping excludes openai: only the four anthropic rows count.
  assert.equal(byId['week-anthropic'].used, 100000);
  assert.equal(byId['week-anthropic'].status, 'ok');
  assert.deepEqual(byId['week-anthropic'].window, { from: '2026-08-17', to: '2026-08-20' });

  // Cost limit: four priced records = $4 against a $3 cap; coverage states itself honestly (4/5 priced).
  assert.equal(byId['month-cost'].used, 4);
  assert.equal(byId['month-cost'].status, 'exceeded');
  assert.ok(Math.abs(byId['month-cost'].priceCoverage - 0.8) < 1e-12);
});

test('capacity: burn rates, ETAs and first-to-hit ordering', async () => {
  const { cube } = await capacityDataset();
  const { states } = evaluateLimits(LIMITS, {
    cube,
    today: '2026-08-20',
    nowMs: Date.UTC(2026, 7, 20, 12, 0),
    tzOffsetMinutes: 0,
    coverageFrom: '2026-08-17',
  });
  const byId = Object.fromEntries(states.map((s) => [s.id, s]));

  // At noon UTC, 12h of the day has elapsed.
  assert.ok(Math.abs(byId['day-openai'].burn.perHourToday - 5000 / 12) < 1e-9);
  // Unscoped trailing window trimmed by coverageFrom covers Mon..Wed (3 basis
  // days) holding 90000 tokens -> a 30000/day pace.
  assert.ok(Math.abs(byId['day-tokens'].burn.perDayTrailing - 90000 / 3) < 1e-9);
  assert.equal(byId['day-tokens'].burn.basisDays, 3);
  // The same window scoped to openai holds nothing — openai only appears
  // today — so its trailing pace is null ("no measurable pace"), not 0,
  // while its hourly pace is live.
  assert.equal(byId['day-openai'].burn.perDayTrailing, null);

  // Warn-state limit ETA: remaining 1250 at an hourly pace of 5000/12 -> 3h, inside its 12h reset.
  assert.ok(Math.abs(byId['day-openai'].etaHours - 3) < 1e-9);
  assert.equal(byId['day-openai'].etaVia, 'hourly');

  // The week limit will NOT be crossed before its reset: 150000 remaining at
  // an anthropic-only hourly pace of 10000/12 -> 180h against 84h until Monday.
  assert.ok(Math.abs(byId['week-anthropic'].etaHours - 180) < 1e-9);

  const summary = summarizeCapacity(states);
  assert.equal(summary.anyExceeded, true);
  assert.equal(summary.anyWarn, true);
  assert.equal(summary.worst.id, 'day-tokens'); // exceeded sorts before everything
  assert.equal(summary.firstToHit.id, 'day-openai'); // earliest projected crossing
  assert.deepEqual(summary.counts, { total: 4, exceeded: 2, warn: 1 });
});

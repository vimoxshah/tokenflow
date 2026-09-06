import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deepWork, switching, costliestHour, focusDays, rhythmSummary,
  DEEP_WORK_MS, DEEP_WORK_TURNS,
} from '../src/analytics/rhythm.js';

// ------------------------------------------------------------- deepWork ---

test('deepWork: empty input reports no data, not zeroes', () => {
  const d = deepWork([]);
  assert.equal(d.count, 0);
  assert.equal(d.shareOfSessions, null);
  assert.equal(d.shareOfTokens, null);
  assert.equal(d.longest, null);
});

test('deepWork: a known duration of 45min+ counts as deep work regardless of turns', () => {
  const sessions = [
    { d: '2026-08-01', pj: 'a', total: 100, durationMs: DEEP_WORK_MS, req: 1 },
    { d: '2026-08-01', pj: 'a', total: 100, durationMs: DEEP_WORK_MS - 1, req: 1 },
  ];
  const d = deepWork(sessions);
  assert.equal(d.count, 1);
  assert.equal(d.shareOfSessions, 0.5);
  assert.equal(d.shareOfTokens, 0.5);
});

test('deepWork: unknown duration (NaN) falls back to a 40-turn threshold', () => {
  const sessions = [
    { d: '2026-08-01', pj: 'a', total: 10, durationMs: NaN, req: DEEP_WORK_TURNS },
    { d: '2026-08-01', pj: 'a', total: 10, durationMs: NaN, req: DEEP_WORK_TURNS - 1 },
  ];
  const d = deepWork(sessions);
  assert.equal(d.count, 1, 'only the 40-turn session should count');
  assert.equal(d.shareOfSessions, 0.5);
});

test('deepWork: a durationMs of undefined is treated the same as unknown', () => {
  const sessions = [
    { d: '2026-08-01', pj: 'a', total: 10, req: 40 },
    { d: '2026-08-01', pj: 'a', total: 10, req: 39 },
  ];
  const d = deepWork(sessions);
  assert.equal(d.count, 1);
});

test('deepWork: longest is the max known duration; unknown-duration sessions never win it', () => {
  const sessions = [
    { d: '2026-08-01', pj: 'a', total: 1, durationMs: 1000, req: 1 },
    { d: '2026-08-01', pj: 'a', total: 1, durationMs: 5000, req: 1 },
    { d: '2026-08-01', pj: 'a', total: 1, durationMs: NaN, req: 999 },
  ];
  const d = deepWork(sessions);
  assert.equal(d.longest.durationMs, 5000);
});

// ------------------------------------------------------------ switching ---

test('switching: no sessions reports no data', () => {
  const s = switching([]);
  assert.deepEqual(s.days, []);
  assert.equal(s.average, null);
  assert.equal(s.worst, null);
});

test('switching: one project touched in a day is 0 switches', () => {
  const s = switching([
    { d: '2026-08-01', pj: 'alpha' },
    { d: '2026-08-01', pj: 'alpha' },
  ]);
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].switches, 0);
  assert.equal(s.average, 0);
});

test('switching: three distinct projects in a day is 2 switches', () => {
  const s = switching([
    { d: '2026-08-01', pj: 'alpha' },
    { d: '2026-08-01', pj: 'beta' },
    { d: '2026-08-01', pj: 'gamma' },
  ]);
  assert.equal(s.days[0].projects, 3);
  assert.equal(s.days[0].switches, 2);
});

test('switching: average and worst day span multiple days; days with no sessions are absent, not zero', () => {
  const s = switching([
    { d: '2026-08-01', pj: 'alpha' },
    { d: '2026-08-02', pj: 'alpha' },
    { d: '2026-08-02', pj: 'beta' },
    { d: '2026-08-02', pj: 'gamma' },
  ]);
  assert.equal(s.days.length, 2, 'only the two days with sessions appear');
  assert.equal(s.average, 1, '(0 + 2) / 2');
  assert.equal(s.worst.date, '2026-08-02');
  assert.equal(s.worst.switches, 2);
});

test('switching: sessions missing a day are ignored rather than grouped under "undefined"', () => {
  const s = switching([
    { d: '2026-08-01', pj: 'alpha' },
    { pj: 'beta' },
  ]);
  assert.equal(s.days.length, 1);
});

// --------------------------------------------------------- costliestHour ---

test('costliestHour: empty input returns null', () => {
  assert.equal(costliestHour([]), null);
  assert.equal(costliestHour(null), null);
});

test('costliestHour: cost + costReq rows compute estimated cost per PRICED request, not per request', () => {
  const rows = [
    { hour: 0, cost: 10, costReq: 5, req: 20, total: 1000 }, // 8 of 20 requests unpriced-free
    { hour: 1, cost: 100, costReq: 4, req: 4, total: 500 },
    { hour: 2, cost: 0, costReq: 0, req: 10, total: 200 }, // requests exist, none priced
  ];
  const c = costliestHour(rows);
  assert.equal(c.metric, 'cost');
  assert.equal(c.hours[0].value, 2, '10 / 5 priced requests, not 10 / 20 all requests');
  assert.equal(c.hours[1].value, 25);
  assert.equal(c.hours[2].value, null, 'no priced requests -> null, not 0');
  assert.equal(c.costliest.hour, 1);
  assert.equal(c.costliest.value, 25);
});

test('costliestHour: rows with only tokens + req fall back to tokens per request, labelled tokens', () => {
  const rows = [
    { hour: 0, total: 1000, req: 10 },
    { hour: 1, total: 4000, req: 20 },
  ];
  const c = costliestHour(rows);
  assert.equal(c.metric, 'tokens');
  assert.equal(c.hours[0].value, 100);
  assert.equal(c.hours[1].value, 200);
  assert.equal(c.costliest.hour, 1);
});

test('costliestHour: rows carrying neither cost nor tokens return null', () => {
  const rows = [{ hour: 0, foo: 1 }, { hour: 1, foo: 2 }];
  assert.equal(costliestHour(rows), null);
});

test('costliestHour: cost-shaped rows with zero priced requests everywhere leave costliest null', () => {
  const rows = [
    { hour: 0, cost: 0, costReq: 0, req: 5, total: 100 },
    { hour: 1, cost: 0, costReq: 0, req: 8, total: 300 },
  ];
  const c = costliestHour(rows);
  assert.equal(c.metric, 'cost');
  assert.equal(c.costliest, null);
  assert.ok(c.hours.every((h) => h.value === null));
});

// ------------------------------------------------------------- focusDays ---

test('focusDays: ranks days by share of tokens in deep-work sessions, top 5', () => {
  const sessions = [
    // day 1: all deep work -> share 1
    { d: '2026-08-01', pj: 'a', total: 1000, durationMs: DEEP_WORK_MS, req: 1 },
    // day 2: half deep work -> share 0.5
    { d: '2026-08-02', pj: 'a', total: 1000, durationMs: DEEP_WORK_MS, req: 1 },
    { d: '2026-08-02', pj: 'a', total: 1000, durationMs: 1000, req: 1 },
    // day 3: no deep work -> share 0
    { d: '2026-08-03', pj: 'a', total: 500, durationMs: 1000, req: 1 },
  ];
  const days = focusDays(sessions);
  assert.equal(days.length, 3);
  assert.equal(days[0].date, '2026-08-01');
  assert.equal(days[0].share, 1);
  assert.equal(days[1].date, '2026-08-02');
  assert.equal(days[1].share, 0.5);
  assert.equal(days[2].share, 0);
});

test('focusDays: a day with zero tokens is excluded, not scored as 0%', () => {
  const sessions = [
    { d: '2026-08-01', pj: 'a', total: 0, durationMs: 1000, req: 1 },
    { d: '2026-08-02', pj: 'a', total: 100, durationMs: DEEP_WORK_MS, req: 1 },
  ];
  const days = focusDays(sessions);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-08-02');
});

test('focusDays: caps at 5 days', () => {
  const sessions = [];
  for (let i = 1; i <= 8; i++) {
    sessions.push({ d: `2026-08-0${i}`, pj: 'a', total: i, durationMs: 1000, req: 1 });
  }
  assert.equal(focusDays(sessions).length, 5);
});

// ---------------------------------------------------------- rhythmSummary ---

test('rhythmSummary: produces exactly three sentences with figures baked in', () => {
  const deep = deepWork([
    { d: '2026-08-01', pj: 'a', total: 1000, durationMs: DEEP_WORK_MS, req: 1 },
    { d: '2026-08-01', pj: 'a', total: 1000, durationMs: 1000, req: 1 },
  ]);
  const sw = switching([
    { d: '2026-08-01', pj: 'a' },
    { d: '2026-08-01', pj: 'b' },
  ]);
  const costliest = costliestHour([
    { hour: 0, cost: 10, costReq: 5, req: 5, total: 100 },
    { hour: 1, cost: 40, costReq: 4, req: 4, total: 100 },
  ]);
  const [s1, s2, s3] = rhythmSummary({ deep, switching: sw, costliest });
  assert.match(s1, /Deep-work sessions were 50\.0% of sessions/);
  assert.match(s2, /Projects switched 1\.0 times a day/);
  assert.match(s3, /costliest hour was 01:00/);
});

test('rhythmSummary: degrades to explanatory sentences when a metric has no data', () => {
  const [s1, s2, s3] = rhythmSummary({
    deep: deepWork([]),
    switching: switching([]),
    costliest: costliestHour([{ hour: 0, foo: 1 }]),
  });
  assert.match(s1, /No deep-work sessions/);
  assert.match(s2, /cannot be measured/);
  assert.match(s3, /not derivable from the aggregate/);
});

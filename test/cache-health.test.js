/**
 * Cache health analytics + route.
 *
 *  - hitRateSeries, writeSplitSeries, detectChurn and summarize are pure
 *    functions tested on synthetic data.
 *  - GET /api/cache-health is tested against a real (temp) store through the
 *    real server, the same way test/ui-registry.test.js tests a registered
 *    route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hitRateSeries, writeSplitSeries, detectChurn, summarize } from '../src/analytics/cache-health.js';
import { createRecord, dateParts } from '../src/core/schema.js';
import { Store, encodeRecord } from '../src/core/store.js';
import { buildPriceBook } from '../src/core/pricing.js';

// A throwaway store for the whole file. The route and the server both read
// TOKENFLOW_HOME at call time, so this must be set before anything below
// touches either.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cache-health-home-'));
process.env.TOKENFLOW_HOME = HOME;
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// ------------------------------------------------------------ hitRateSeries --

test('hitRateSeries: cache_read / (cache_read + input), per day', () => {
  const rows = [
    { key: '2026-08-01', in: 100, cr: 300 }, // 300/400 = 0.75
    { key: '2026-08-02', in: 0, cr: 0 }, // no traffic at all: undefined, not 0
    { key: '2026-08-03', in: 50, cr: 0 }, // a real miss-only day: 0, not n/a
  ];
  const out = hitRateSeries(rows);
  assert.deepEqual(out, [
    { date: '2026-08-01', hitRate: 0.75 },
    { date: '2026-08-02', hitRate: null },
    { date: '2026-08-03', hitRate: 0 },
  ]);
});

test('hitRateSeries: falls back to `date` when `key` is absent, and handles an empty list', () => {
  assert.deepEqual(hitRateSeries([{ date: '2026-08-05', in: 10, cr: 10 }]), [{ date: '2026-08-05', hitRate: 0.5 }]);
  assert.deepEqual(hitRateSeries([]), []);
  assert.deepEqual(hitRateSeries(undefined), []);
});

// --------------------------------------------------------- writeSplitSeries --

test('writeSplitSeries: short-TTL is cache_write minus cache_refresh, long-TTL is cache_refresh', () => {
  const rows = [
    { key: '2026-08-01', cw: 1000, cf: 400 }, // 600 short, 400 long
    { key: '2026-08-02', cw: 0, cf: 0 }, // a real zero day, not n/a
    { key: '2026-08-03', cw: 500, cf: 500 }, // all long-TTL
  ];
  assert.deepEqual(writeSplitSeries(rows), [
    { date: '2026-08-01', shortTTL: 600, longTTL: 400 },
    { date: '2026-08-02', shortTTL: 0, longTTL: 0 },
    { date: '2026-08-03', shortTTL: 0, longTTL: 500 },
  ]);
});

test('writeSplitSeries: never goes negative even if cache_refresh somehow exceeds cache_write', () => {
  assert.deepEqual(writeSplitSeries([{ key: '2026-08-01', cw: 100, cf: 900 }]), [{ date: '2026-08-01', shortTTL: 0, longTTL: 900 }]);
});

// -------------------------------------------------------------- detectChurn --

const book = buildPriceBook({}); // claude-opus-5: in 5, out 25, cacheRead 0.5, cacheWrite 6.25

function turn(o) {
  return {
    timestamp: o.timestamp,
    session_id: o.session_id ?? 's1',
    project: o.project ?? 'proj',
    git_branch: o.git_branch ?? 'main',
    model: o.model ?? 'claude-opus-5',
    provider: o.provider ?? 'anthropic',
    cache_read_tokens: o.cache_read_tokens ?? null,
    cache_write_tokens: o.cache_write_tokens ?? null,
  };
}

test('detectChurn: a big write against a small previous read is a churn event, with its estimated premium', () => {
  const turns = [
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 20000 }),
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 15000 }),
  ];
  const events = detectChurn(turns, book);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.sessionId, 's1');
  assert.equal(e.project, 'proj');
  assert.equal(e.branch, 'main');
  assert.equal(e.turnIndex, 1);
  assert.equal(e.writeTokens, 15000);
  assert.equal(e.previousReadTokens, 20000);
  assert.equal(e.timestamp, '2026-08-01T09:05:00Z');
  // (15000 / 1e6) * (6.25 - 0.5)
  assert.ok(Math.abs(e.premiumUsd - 0.08625) < 1e-9);
});

test('detectChurn: sorts turns by timestamp itself, so callers do not have to', () => {
  const turns = [
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 15000 }),
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 20000 }),
  ];
  assert.equal(detectChurn(turns, book).length, 1, 'out-of-order input still finds the event');
});

test('detectChurn: below the absolute floor is not a churn event', () => {
  const turns = [
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 20000 }),
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 9999 }),
  ];
  assert.equal(detectChurn(turns, book).length, 0);
});

test('detectChurn: below half the previous read is not a churn event, even above the absolute floor', () => {
  const turns = [
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 30000 }),
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 12000 }), // needs >= 15000
  ];
  assert.equal(detectChurn(turns, book).length, 0);
});

test('detectChurn: a null write or a null previous read is skipped, never treated as 0', () => {
  const noWrite = [
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 20000 }),
    turn({ timestamp: '2026-08-01T09:05:00Z' }), // cache_write_tokens stays null
  ];
  assert.equal(detectChurn(noWrite, book).length, 0);

  const noPrevRead = [
    turn({ timestamp: '2026-08-01T09:00:00Z' }), // cache_read_tokens stays null
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 50000 }),
  ];
  assert.equal(detectChurn(noPrevRead, book).length, 0);
});

test('detectChurn: a single turn has no previous turn to compare against', () => {
  assert.deepEqual(detectChurn([turn({ timestamp: '2026-08-01T09:00:00Z', cache_write_tokens: 50000 })], book), []);
  assert.deepEqual(detectChurn([], book), []);
});

test('detectChurn: an unpriced model still produces the event, with premiumUsd: null', () => {
  const turns = [
    turn({ timestamp: '2026-08-01T09:00:00Z', cache_read_tokens: 20000, model: 'no-such-model', provider: 'nobody' }),
    turn({ timestamp: '2026-08-01T09:05:00Z', cache_write_tokens: 15000, model: 'no-such-model', provider: 'nobody' }),
  ];
  const events = detectChurn(turns, book);
  assert.equal(events.length, 1);
  assert.equal(events[0].premiumUsd, null);
});

// ------------------------------------------------------------------ summarize --

test('summarize: per-day counts and a total premium across events', () => {
  const events = [
    { timestamp: '2026-08-01T09:05:00Z', premiumUsd: 0.5 },
    { timestamp: '2026-08-01T20:00:00Z', premiumUsd: 0.25 },
    { timestamp: '2026-08-02T09:05:00Z', premiumUsd: 1 },
  ];
  const s = summarize(events);
  assert.equal(s.totalEvents, 3);
  assert.deepEqual(s.byDay, [{ date: '2026-08-01', count: 2 }, { date: '2026-08-02', count: 1 }]);
  assert.ok(Math.abs(s.totalPremiumUsd - 1.75) < 1e-9);
  assert.equal(s.premiumPartial, false);
});

test('summarize: zero events is a real zero premium, not n/a', () => {
  const s = summarize([]);
  assert.equal(s.totalEvents, 0);
  assert.deepEqual(s.byDay, []);
  assert.equal(s.totalPremiumUsd, 0);
  assert.equal(s.premiumPartial, false);
});

test('summarize: every event unpriced makes the total null, not a silent 0', () => {
  const s = summarize([
    { timestamp: '2026-08-01T09:00:00Z', premiumUsd: null },
    { timestamp: '2026-08-01T10:00:00Z', premiumUsd: null },
  ]);
  assert.equal(s.totalEvents, 2);
  assert.equal(s.totalPremiumUsd, null);
  assert.equal(s.premiumPartial, true);
});

test('summarize: a mix of priced and unpriced events sums what it knows and flags the rest', () => {
  const s = summarize([
    { timestamp: '2026-08-01T09:00:00Z', premiumUsd: 2 },
    { timestamp: '2026-08-01T10:00:00Z', premiumUsd: null },
  ]);
  assert.equal(s.totalPremiumUsd, 2);
  assert.equal(s.premiumPartial, true);
});

// -------------------------------------------------------------------- route --

/** Write one record straight into the store, the way ingest would. */
function writeRecord(store, o) {
  const dp = dateParts(o.timestamp, 'UTC');
  const r = createRecord({
    date: dp.date, hour: dp.hour, dow: dp.dow, tz_offset: 0,
    source: 'test', provider: 'anthropic', model: 'claude-opus-5',
    model_family: 'Claude Opus 5', client: 'claude-code', interface: 'CLI',
    project: 'proj', git_branch: 'main', measurement: 'primary',
    ...o,
  });
  store.writer(r.date).write(encodeRecord(r));
  return r;
}

test('GET /api/cache-health: finds a churn event across a session\'s turns, and excludes sessionless records', async () => {
  const store = new Store();
  writeRecord(store, { id: 'r1', timestamp: '2026-08-01T09:00:00Z', session_id: 's1', cache_read_tokens: 20000, input_tokens: 100 });
  writeRecord(store, { id: 'r2', timestamp: '2026-08-01T09:05:00Z', session_id: 's1', cache_write_tokens: 15000, input_tokens: 100 });
  // A second session with only one turn: nothing to compare, no event.
  writeRecord(store, { id: 'r3', timestamp: '2026-08-01T10:00:00Z', session_id: 's2', cache_write_tokens: 50000, input_tokens: 100 });
  // No session_id at all: cannot be placed in a turn sequence, must be excluded
  // even though the write alone would otherwise qualify.
  writeRecord(store, { id: 'r4', timestamp: '2026-08-01T11:00:00Z', session_id: null, cache_read_tokens: 40000, input_tokens: 100 });
  writeRecord(store, { id: 'r5', timestamp: '2026-08-01T11:05:00Z', session_id: null, cache_write_tokens: 30000, input_tokens: 100 });
  store.closeWriters();

  const { startServer } = await import(`../src/server/server.js?t=${Date.now()}`);
  const s = await startServer({ port: 0, host: '127.0.0.1', open: false, token: false });
  try {
    const res = await fetch(`${s.url}/api/cache-health?from=2026-08-01&to=2026-08-01`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.truncated, false);
    assert.equal(body.scanned, 5, 'every record read in the window is counted, matched or not');
    assert.equal(body.events.length, 1);
    const e = body.events[0];
    assert.equal(e.sessionId, 's1');
    assert.equal(e.project, 'proj');
    assert.equal(e.branch, 'main');
    assert.equal(e.writeTokens, 15000);
    assert.equal(e.previousReadTokens, 20000);
    assert.ok(Math.abs(e.premiumUsd - 0.08625) < 1e-9);
    assert.equal(body.summary.totalEvents, 1);
    assert.ok(Math.abs(body.summary.totalPremiumUsd - 0.08625) < 1e-9);
    assert.deepEqual(body.summary.byDay, [{ date: '2026-08-01', count: 1 }]);
  } finally {
    await s.close();
  }
});

test('GET /api/cache-health: no window returns an empty, well-formed result rather than throwing', async () => {
  const { startServer } = await import(`../src/server/server.js?t=${Date.now()}`);
  const s = await startServer({ port: 0, host: '127.0.0.1', open: false, token: false });
  try {
    // The store here already has last test's records on disk, but a window
    // outside them must simply come back empty.
    const res = await fetch(`${s.url}/api/cache-health?from=2020-01-01&to=2020-01-02`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scanned, 0);
    assert.deepEqual(body.events, []);
    assert.equal(body.summary.totalEvents, 0);
    assert.equal(body.summary.totalPremiumUsd, 0);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- registry --

test('view registry: the cache tab is registered with the expected id and order', async () => {
  const { VIEWS } = await import('../src/ui/views/index.js');
  const cache = VIEWS.find((v) => v.id === 'cache');
  assert.ok(cache, 'the cache view must be registered');
  assert.equal(cache.label, 'Cache health');
  assert.equal(cache.order, 95);
  assert.equal(cache.css, './styles/cache.css');
});

test('route registry: /api/cache-health is registered as GET', async () => {
  const { ROUTES } = await import('../src/server/routes/index.js');
  const route = ROUTES.find((r) => r.path === '/api/cache-health');
  assert.ok(route, 'the cache-health route must be registered');
  assert.equal(route.method, 'GET');
});

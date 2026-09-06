/**
 * Schema-completeness of the mock/demo provider.
 *
 * Every dashboard surface (receipts, guard, live sessions, cache health,
 * session anatomy) needs a particular SHAPE of data to have something real
 * to show, not just "some records". This generates through the mock adapter
 * — the same path `tokenflow demo` uses — into fully-enriched records (via
 * `fetchAll`, which runs the real `enrich()` pipeline including the price
 * book) and checks the structural properties those surfaces depend on.
 *
 * Volume is checked against a baseline measured from the PREVIOUS generator
 * (the flat "one turn per emit, same shape every day" version this change
 * replaces): running the pre-change `src/providers/mock/index.js` with
 * `days: 160, seed: 20260814` produced **4759 records** at the pinned
 * calendar instant below (verified by temporarily patching that file to
 * accept the same `now` override this one does, then running it).
 *
 * All the structural/volume assertions here pin `now` to that same instant,
 * so the test is not a function of which real day it happens to run on —
 * calendar-driven volume (weekday vs weekend session counts) legitimately
 * varies by a modest amount across the year, and pinning is what keeps the
 * assertion meaningful rather than occasionally flaky. Only the "a session
 * is active within 10 minutes of now" check legitimately needs the real
 * clock, and gets its own unpinned pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mock from '../src/providers/mock/index.js';
import { validateUsage } from '../src/core/validate.js';
import { buildReceipts, evaluateGuard } from '../src/analytics/receipt.js';
import { ctx, fetchAll } from './helpers.js';

// Measured from the generator this change replaces, same seed/days, same
// pinned calendar instant as PINNED_NOW below. Acceptance band is +/-20%.
const PREVIOUS_VOLUME = 4759;
const PINNED_NOW = '2026-09-05T15:00:00.000Z';

/** @returns {ReturnType<typeof ctx>} a ctx wired to run the mock provider with a fixed calendar instant */
function pinnedCtx() {
  return ctx({
    config: {
      providers: ['mock'],
      sources: { mock: { days: 160, seed: 20260814, now: PINNED_NOW } },
      interfaceOverrides: {},
    },
  });
}

/** Sum of a token field across a slice, skipping null/undefined rather than coercing to 0. */
function sumField(records, field) {
  let t = 0;
  for (const r of records) {
    const v = r[field];
    if (v !== null && v !== undefined) t += v;
  }
  return t;
}

/** Group records by session_id, each session's records sorted by timestamp. */
function groupSessions(records) {
  const by = new Map();
  for (const r of records) {
    if (!r.session_id) continue;
    let s = by.get(r.session_id);
    if (!s) { s = []; by.set(r.session_id, s); }
    s.push(r);
  }
  for (const recs of by.values()) recs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return by;
}

test('mock demo data: record volume stays within 20% of the previous generator', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const lo = PREVIOUS_VOLUME * 0.8;
  const hi = PREVIOUS_VOLUME * 1.2;
  assert.ok(
    records.length >= lo && records.length <= hi,
    `expected record count within 20% of ${PREVIOUS_VOLUME} (${lo}-${hi}), got ${records.length}`,
  );
});

test('mock demo data: every record satisfies the schema validator', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  assert.ok(records.length > 0, 'the mock provider produced records to check');
  const bad = [];
  for (const r of records) {
    const v = validateUsage(r);
    if (!v.ok) bad.push({ id: r.id, session: r.session_id, errors: v.errors });
  }
  assert.deepEqual(bad, [], `${bad.length} record(s) failed validateUsage: ${JSON.stringify(bad.slice(0, 5))}`);
});

test('mock demo data: sessions carry growing cache-read context', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const bySession = groupSessions(records);
  let growing = 0;
  for (const recs of bySession.values()) {
    if (recs.length < 8) continue;
    const q = Math.floor(recs.length / 4);
    const firstQ = sumField(recs.slice(0, q), 'cache_read_tokens') / q;
    const lastQ = sumField(recs.slice(-q), 'cache_read_tokens') / q;
    if (lastQ > firstQ * 1.3) growing++;
  }
  assert.ok(growing > 0, 'expected at least one session whose cache_read_tokens grows turn over turn');
});

test('mock demo data: at least one churn event (a big cache write after turn 0)', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const bySession = groupSessions(records);
  let churnSessions = 0;
  for (const recs of bySession.values()) {
    const hasChurn = recs.some((r, i) => i > 0 && r.cache_write_tokens !== null && r.cache_write_tokens > 0);
    if (hasChurn) churnSessions++;
  }
  assert.ok(churnSessions > 0, 'expected at least one session with a cache-write churn event after its first turn');
});

test('mock demo data: subagent share lands between 0.3 and 0.7 in some session', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const bySession = groupSessions(records);
  const shares = [];
  for (const recs of bySession.values()) {
    const sub = recs.filter((r) => r.category === 'subagent').length;
    if (sub > 0) shares.push(sub / recs.length);
  }
  assert.ok(shares.length > 0, 'expected at least one session with subagent turns');
  assert.ok(
    shares.some((s) => s >= 0.3 && s <= 0.7),
    `expected some session's subagent share in [0.3, 0.7], got ${JSON.stringify(shares)}`,
  );
});

test('mock demo data: exactly one detached-HEAD session, one null-branch session, and every record carries the synthetic cwd', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const bySession = groupSessions(records);
  const headSessions = [...bySession.values()].filter((recs) => recs[0].git_branch === 'HEAD');
  const nullBranchSessions = [...bySession.values()].filter((recs) => recs[0].git_branch === null);
  assert.equal(headSessions.length, 1, 'expected exactly one detached-HEAD session');
  assert.equal(nullBranchSessions.length, 1, 'expected exactly one session with no branch at all');
  assert.ok(
    records.every((r) => r.metadata.cwd === `/Users/demo/src/${r.repository}`),
    'expected every record\'s metadata.cwd to be a non-git path derived from its repository',
  );
});

test('mock demo data: at least one model has no configured price', async () => {
  const { records } = await fetchAll(mock, pinnedCtx());
  const unpriced = records.filter((r) => r.estimated_cost === null && r.cost_basis === null);
  assert.ok(unpriced.length > 0, 'expected at least one record with no configured price');
  assert.ok(unpriced.every((r) => typeof r.model === 'string' && r.model.length > 0));
});

test('mock demo data: receipts cover >=4 repos with feature branches and a long-lived main, and one branch outranks its repo median by >50x', async () => {
  const c = pinnedCtx();
  const { records } = await fetchAll(mock, c);
  const receipts = buildReceipts(records, { book: c.priceBook });

  assert.ok(receipts.repos.length >= 4, `expected at least 4 repos in the receipts, got ${receipts.repos.length}`);

  const reposWithMainAndFeature = receipts.repos.filter((r) => {
    const hasMain = r.branches.some((b) => b.longLived);
    const hasFeature = r.branches.some((b) => !b.longLived);
    return hasMain && hasFeature;
  });
  assert.ok(
    reposWithMainAndFeature.length >= 4,
    `expected at least 4 repos with both a long-lived branch and a feature branch, got ${reposWithMainAndFeature.length}`,
  );

  const outlierBranches = receipts.repos.flatMap((r) => r.branches).filter((b) => b.vsMedian !== null && b.vsMedian > 50);
  assert.ok(
    outlierBranches.length > 0,
    `expected at least one branch receipt more than 50x its repo's median branch cost, largest vsMedian seen: ${
      Math.max(...receipts.repos.flatMap((r) => r.branches).map((b) => b.vsMedian ?? 0))}`,
  );
});

test('mock demo data: at least one session is active within the last 10 minutes', async () => {
  // Unpinned: this is the one property that legitimately needs the real clock.
  const c = ctx({
    config: { providers: ['mock'], sources: { mock: { days: 160, seed: 20260814 } }, interfaceOverrides: {} },
  });
  const { records } = await fetchAll(mock, c);
  const bySession = groupSessions(records);
  const nowMs = Date.now();
  const recentSessions = [...bySession.entries()].filter(([, recs]) => {
    const last = recs[recs.length - 1].timestamp;
    return nowMs - new Date(last).getTime() < 10 * 60 * 1000;
  });
  assert.ok(recentSessions.length > 0, 'expected at least one session whose last turn is within 10 minutes of now');

  // Bonus: one of the recent sessions should be expensive enough to trip a
  // guard warning at a $25 session cap (point 5 of the generation spec) —
  // this is what gives the Live view / menu bar something to show.
  let tripped = false;
  for (const [, recs] of recentSessions) {
    const verdict = evaluateGuard(recs, { warnCostUsd: 25 }, c.priceBook);
    if (verdict.level === 'warn' || verdict.level === 'block') { tripped = true; break; }
  }
  assert.ok(tripped, 'expected at least one recent session to trip a $25 guard warning');
});

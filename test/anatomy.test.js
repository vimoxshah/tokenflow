/**
 * Session anatomy: the arithmetic behind the flame graph.
 *
 * Every case here stands for a way the tab could lie: a turn priced from a
 * stored total instead of the price book, an unpriced turn drawn as a free
 * one, a spike sold as a step change, a guessed parent link presented as a
 * hierarchy, or a per-turn chart drawn over a source that only reports one row
 * per session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  turnSeries, summarizeTurns, detectStep, fanOut, sessionKind,
  STEP_WINDOW, STEP_RATIO, STEP_MIN_ABS,
} from '../src/analytics/anatomy.js';
import { buildPriceBook } from '../src/core/pricing.js';

/** $1 per million on every bucket, so a turn's cost is its token count / 1e6. */
const BOOK = buildPriceBook({
  models: {
    'test-model': { in: 1, out: 1, cacheRead: 1, cacheWrite: 1, cacheRefresh: 1 },
  },
});

let seq = 0;
const T0 = Date.UTC(2026, 7, 14, 10, 0, 0);

function rec(over = {}) {
  seq++;
  return {
    // Strictly increasing for any seq: turnSeries sorts by timestamp, so a
    // clock that wrapped would silently interleave two runs of a fixture and
    // make these tests depend on how many ran before them.
    ts: new Date(T0 + seq * 1000).toISOString(),
    model: 'test-model',
    provider: 'anthropic',
    source: 'mock',
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_refresh_tokens: null,
    output_tokens: 0,
    reasoning_tokens: null,
    category: 'main',
    request_id: `req-${seq}`,
    ...over,
  };
}

/** A run of turns whose per-turn cost is exactly `dollars`. */
function run(n, dollars, over = {}) {
  return Array.from({ length: n }, () => rec({ output_tokens: Math.round(dollars * 1e6), ...over }));
}

test('turnSeries: prices each turn from the book and carries a running total', () => {
  const series = turnSeries([
    rec({ input_tokens: 1_000_000, output_tokens: 500_000 }),
    rec({ input_tokens: 250_000, cache_read_tokens: 250_000 }),
  ], BOOK);

  assert.equal(series.length, 2);
  assert.deepEqual(series.map((t) => t.turn), [1, 2]);
  assert.equal(series[0].cost, 1.5);
  assert.equal(series[1].cost, 0.5);
  assert.equal(series[0].cumulative, 1.5);
  assert.equal(series[1].cumulative, 2);
  // Prompt size is input + cache read + cache write; output is not a prompt.
  assert.equal(series[0].promptTokens, 1_000_000);
  assert.equal(series[1].promptTokens, 500_000);
  assert.equal(series[1].cacheReadShare, 0.5);
  assert.equal(series[0].cacheReadShare, 0);
});

test('turnSeries: orders by timestamp whatever order the shard gave them', () => {
  const late = rec({ ts: '2026-08-14T12:00:00.000Z', output_tokens: 2_000_000 });
  const early = rec({ ts: '2026-08-14T09:00:00.000Z', output_tokens: 1_000_000 });
  const series = turnSeries([late, early], BOOK);
  assert.deepEqual(series.map((t) => t.ts), [early.ts, late.ts]);
  assert.deepEqual(series.map((t) => t.cumulative), [1, 3]);
});

test('turnSeries: an unpriced turn is null, never zero, and the total holds flat', () => {
  const series = turnSeries([
    rec({ output_tokens: 1_000_000 }),
    rec({ model: 'model-nobody-priced', output_tokens: 1_000_000 }),
    rec({ output_tokens: 1_000_000 }),
  ], BOOK);
  assert.equal(series[1].cost, null);
  assert.equal(series[1].cumulative, 1, 'the running total holds across an unknown turn');
  assert.equal(series[2].cumulative, 2);

  const s = summarizeTurns(series);
  assert.equal(s.priced, 2);
  assert.equal(s.unpriced, 1);
  assert.equal(s.cost, 2);
  assert.equal(s.avgCost, 1, 'the average is over the turns we could price');
});

test('turnSeries: a session with no priced turn at all reports null, not zero', () => {
  const series = turnSeries(run(3, 1, { model: 'model-nobody-priced' }), BOOK);
  assert.deepEqual(series.map((t) => t.cost), [null, null, null]);
  assert.deepEqual(series.map((t) => t.cumulative), [null, null, null]);
  assert.equal(summarizeTurns(series).cost, null);
});

test('turnSeries: a token field the source never reported stays not-available', () => {
  const series = turnSeries([rec({
    input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: 100,
  })], BOOK);
  assert.equal(series[0].input, null);
  assert.equal(series[0].promptTokens, null, 'no prompt bucket reported is n/a, not 0');
  assert.equal(series[0].cacheReadShare, null);
});

test('turnSeries: the price book applies the service tier, like every other surface', () => {
  const [plain] = turnSeries([rec({ provider: 'openai', output_tokens: 1_000_000 })], BOOK);
  const [priority] = turnSeries([rec({ provider: 'openai', output_tokens: 1_000_000, service_tier: 'priority' })], BOOK);
  assert.equal(plain.cost, 1);
  assert.equal(priority.cost, 4, 'OpenAI priority is billed at 4x');
});

test('detectStep: finds the first turn where the median doubles and stays up', () => {
  const series = turnSeries([...run(STEP_WINDOW, 0.01), ...run(STEP_WINDOW, 0.05)], BOOK);
  const step = detectStep(series);
  assert.ok(step, 'a 5x step over full windows must be found');
  assert.equal(step.index, STEP_WINDOW);
  assert.equal(step.turn, STEP_WINDOW + 1);
  assert.ok(Math.abs(step.from - 0.01) < 1e-9);
  assert.ok(Math.abs(step.to - 0.05) < 1e-9);
  assert.ok(step.ratio >= STEP_RATIO);
  assert.ok(step.step >= STEP_MIN_ABS);
});

test('detectStep: a rise under 2x is not a step', () => {
  const series = turnSeries([...run(STEP_WINDOW, 0.05), ...run(STEP_WINDOW, 0.09)], BOOK);
  assert.equal(detectStep(series), null, '1.8x is a drift, not a step');
});

test('detectStep: a big ratio on trivial money is not a step', () => {
  const series = turnSeries([...run(STEP_WINDOW, 0.0001), ...run(STEP_WINDOW, 0.004)], BOOK);
  assert.equal(detectStep(series), null, '40x of nothing is still nothing');
});

test('detectStep: a single spike that comes back down is not a step', () => {
  const series = turnSeries([
    ...run(STEP_WINDOW, 0.01),
    ...run(1, 50),
    ...run(STEP_WINDOW, 0.01),
  ], BOOK);
  assert.equal(detectStep(series), null, 'the median is what makes a spike survivable');
});

test('detectStep: a session shorter than two full windows has no answer', () => {
  const series = turnSeries([...run(10, 0.01), ...run(10, 1)], BOOK);
  assert.equal(detectStep(series), null);
  // …and the same shape with full windows does have one.
  const longer = turnSeries([...run(STEP_WINDOW, 0.01), ...run(STEP_WINDOW, 1)], BOOK);
  assert.ok(detectStep(longer));
});

test('detectStep: reports the FIRST step when the cost climbs twice', () => {
  const series = turnSeries([
    ...run(STEP_WINDOW, 0.01),
    ...run(STEP_WINDOW, 0.05),
    ...run(STEP_WINDOW, 0.5),
  ], BOOK);
  const step = detectStep(series);
  assert.equal(step.index, STEP_WINDOW, 'the first regime change is the one that matters');
});

test('detectStep: the thresholds are inclusive, so a step exactly on the line counts', () => {
  // 0.02 -> 0.04 sits on BOTH limits at once: the ratio is exactly 2 and the
  // rise is exactly $0.02. "At least" has to mean at least.
  const both = turnSeries([...run(STEP_WINDOW, 0.02), ...run(STEP_WINDOW, 0.04)], BOOK);
  const onLine = detectStep(both);
  assert.ok(onLine, 'exactly 2x and exactly $0.02 is a step');
  assert.equal(onLine.ratio, STEP_RATIO);
  assert.equal(onLine.step, STEP_MIN_ABS);
  assert.equal(onLine.index, STEP_WINDOW);

  // Exactly $0.02 with the ratio well clear of its limit.
  const onAbs = detectStep(turnSeries([...run(STEP_WINDOW, 0.005), ...run(STEP_WINDOW, 0.025)], BOOK));
  assert.ok(onAbs, 'a rise of exactly $0.02 counts');
  assert.equal(onAbs.step, STEP_MIN_ABS);

  // Exactly 2x with the money well clear of its limit.
  const onRatio = detectStep(turnSeries([...run(STEP_WINDOW, 0.05), ...run(STEP_WINDOW, 0.1)], BOOK));
  assert.ok(onRatio, 'a rise of exactly 2x counts');
  assert.equal(onRatio.ratio, STEP_RATIO);
});

test('detectStep: a hair under either threshold does not count', () => {
  const underRatio = detectStep(turnSeries([...run(STEP_WINDOW, 0.05), ...run(STEP_WINDOW, 0.0999)], BOOK));
  assert.equal(underRatio, null, '1.998x is not 2x');

  const underAbs = detectStep(turnSeries([...run(STEP_WINDOW, 0.005), ...run(STEP_WINDOW, 0.0249)], BOOK));
  assert.equal(underAbs, null, '$0.0199 is not $0.02');
});

test('detectStep: a window that is mostly unpriced cannot vote', () => {
  // Nineteen unknown turns and one cheap one, then a full expensive window.
  // The median of a single point is not a regime, and reading the unknowns as
  // zero would invent the largest step in the session.
  const thin = [
    ...run(1, 0.01),
    ...run(STEP_WINDOW - 1, 0.01, { model: 'model-nobody-priced' }),
    ...run(STEP_WINDOW, 1),
  ];
  assert.equal(detectStep(turnSeries(thin, BOOK)), null);
  // The same shape with both windows priced does report the step.
  const solid = [...run(STEP_WINDOW, 0.01), ...run(STEP_WINDOW, 1)];
  assert.ok(detectStep(turnSeries(solid, BOOK)));
});

test('detectStep: unpriced turns are skipped, not read as zero', () => {
  const series = turnSeries([
    ...run(STEP_WINDOW, 0.01),
    ...run(STEP_WINDOW, 0.05, { model: 'model-nobody-priced' }),
  ], BOOK);
  assert.equal(detectStep(series), null, 'a window with no priced turn cannot be compared');
});

test('fanOut: with no parent link, contiguous subagent runs are grouped and flagged', () => {
  const records = [
    ...run(2, 1),
    ...run(3, 2, { category: 'subagent' }),
    ...run(1, 1),
    ...run(2, 3, { category: 'subagent' }),
  ];
  const f = fanOut(turnSeries(records, BOOK));

  assert.equal(f.grouped, true);
  assert.equal(f.roots.length, 0);
  assert.equal(f.shareBasis, 'cost');
  assert.deepEqual(f.groups.map((g) => g.kind), ['main', 'subagent', 'main', 'subagent']);
  assert.deepEqual(f.groups.map((g) => [g.startTurn, g.endTurn]), [[1, 2], [3, 5], [6, 6], [7, 8]]);
  assert.deepEqual(f.groups.map((g) => g.turns), [2, 3, 1, 2]);
  // 2 + 6 + 1 + 6 = 15 dollars
  assert.equal(f.cost, 15);
  assert.equal(f.subagentCost, 12);
  assert.equal(f.subagentTurns, 5);
  assert.ok(Math.abs(f.groups[1].share - 6 / 15) < 1e-12);
  assert.ok(Math.abs(f.groups.reduce((a, g) => a + g.share, 0) - 1) < 1e-12);
});

test('fanOut: with no cost anywhere, the share falls back to turns and says so', () => {
  const records = [
    ...run(2, 1, { model: 'model-nobody-priced' }),
    ...run(2, 1, { model: 'model-nobody-priced', category: 'subagent' }),
  ];
  const f = fanOut(turnSeries(records, BOOK));
  assert.equal(f.shareBasis, 'turns');
  assert.equal(f.cost, null);
  assert.deepEqual(f.groups.map((g) => g.share), [0.5, 0.5]);
});

test('fanOut: a real parent link builds a tree instead of guessing from position', () => {
  const root = rec({ request_id: 'r1', output_tokens: 1_000_000 });
  const child = rec({ request_id: 'r2', output_tokens: 2_000_000, category: 'subagent', parent: 'r1', agent: 'reviewer' });
  const grandchild = rec({ request_id: 'r3', output_tokens: 1_000_000, category: 'subagent', parent: 'r2', agent: 'fetcher' });
  const f = fanOut(turnSeries([root, child, grandchild], BOOK));

  assert.equal(f.grouped, false);
  assert.equal(f.groups.length, 0);
  assert.equal(f.roots.length, 1);
  const main = f.roots[0];
  assert.equal(main.key, null);
  assert.equal(main.label, 'main');
  assert.equal(main.turns, 1);
  assert.equal(main.children.length, 1);

  const reviewer = main.children[0];
  assert.equal(reviewer.key, 'r1');
  assert.equal(reviewer.label, 'reviewer');
  assert.equal(reviewer.depth, 1);
  assert.equal(reviewer.cost, 2);
  assert.ok(Math.abs(reviewer.share - 0.5) < 1e-12);
  assert.equal(reviewer.children.length, 1);
  assert.equal(reviewer.children[0].label, 'fetcher');
  assert.equal(reviewer.children[0].depth, 2);
});

test('fanOut: a parent link that points in a circle still terminates', () => {
  const a = rec({ request_id: 'a', parent: 'b', output_tokens: 1_000_000 });
  const b = rec({ request_id: 'b', parent: 'a', output_tokens: 1_000_000 });
  const f = fanOut(turnSeries([a, b], BOOK));
  assert.equal(f.grouped, false);
  assert.ok(f.roots.length >= 1, 'a cycle must still expose its turns');
  const seen = [];
  const walk = (n, d) => { seen.push(d); for (const c of n.children) walk(c, d + 1); };
  for (const r of f.roots) walk(r, 0);
  assert.ok(Math.max(...seen) <= 12, 'depth is bounded');
});

test('fanOut: a session with no subagent turn is one main group', () => {
  const f = fanOut(turnSeries(run(4, 1), BOOK));
  assert.equal(f.subagentTurns, 0);
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].kind, 'main');
  assert.equal(f.groups[0].share, 1);
});

test('sessionKind: a per-request adapter is per-turn, a session-level one is not', () => {
  assert.equal(sessionKind([rec({ source: 'anthropic' })]), 'per-turn');
  assert.equal(sessionKind([rec({ source: 'mock' })]), 'per-turn');
  assert.equal(sessionKind([rec({ source: 'hermes' })]), 'session-level');
  // A mixed session still has real turns for the part we can chart.
  assert.equal(sessionKind([rec({ source: 'hermes' }), rec({ source: 'openai' })]), 'per-turn');
  assert.equal(sessionKind([]), 'per-turn');
});

test('sessionKind: an unknown source fails open to per-turn', () => {
  // otel and generic emit primary per-request records and are named in no
  // allow-list. Calling them session-level would cost them every chart on the
  // strength of a list that simply had not been updated.
  assert.equal(sessionKind([rec({ source: 'otel' })]), 'per-turn');
  assert.equal(sessionKind([rec({ source: 'generic' })]), 'per-turn');
  assert.equal(sessionKind([rec({ source: 'some-adapter-written-next-year' })]), 'per-turn');
  assert.equal(sessionKind([rec({ source: null })]), 'per-turn');
});

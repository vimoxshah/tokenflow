import test from 'node:test';
import assert from 'node:assert/strict';
import { reprice, deriveModelName, targetModelOptions } from '../src/analytics/whatif.js';
import { buildPriceBook, BUILTIN_PRICES } from '../src/core/pricing.js';

/** A stub price book: a plain map of model name -> rate, no regex matching.
 * Decoupling the analytics tests from the real BUILTIN_PRICES table means a
 * future edit to the shipped rates can never change what these tests assert. */
function stubBook(rates) {
  return {
    lookup(model) {
      return Object.prototype.hasOwnProperty.call(rates, model) ? rates[model] : null;
    },
  };
}

function row(o) {
  return {
    key: o.key, provider: o.provider || 'test', total: o.total ?? 0, requests: o.requests ?? 1,
    input: o.input ?? 0, output: o.output ?? 0, cacheRead: o.cacheRead ?? 0,
    cacheWrite: o.cacheWrite ?? 0, cacheRefresh: o.cacheRefresh ?? 0,
  };
}

// ------------------------------------------------------------------ reprice --

test('reprice: savings case, target is cheaper on every kind', () => {
  const book = stubBook({
    expensive: { in: 10, out: 50, cacheRead: 1, cacheWrite: 12, cacheRefresh: 2 },
    cheap: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2, cacheRefresh: 0.4 },
  });
  const rows = [row({ key: 'expensive', input: 1e6, output: 1e6, total: 2e6 })];
  const out = reprice({ rows, book, mapping: { expensive: 'cheap' } });
  const m = out.models[0];
  assert.equal(m.current, 10 + 50);
  assert.equal(m.whatif, 2 + 10);
  assert.equal(m.delta, (2 + 10) - (10 + 50));
  assert.ok(m.delta < 0, 'a cheaper target must show a negative delta');
  assert.equal(m.partial, false);
  assert.equal(out.overall.current, m.current);
  assert.equal(out.overall.whatif, m.whatif);
  assert.equal(out.overall.delta, m.delta);
  assert.equal(out.overall.excluded, 0);
  assert.equal(out.overall.partial, false);
});

test('reprice: extra-cost case, target is pricier on every kind', () => {
  const book = stubBook({
    cheap: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2, cacheRefresh: 0.4 },
    expensive: { in: 10, out: 50, cacheRead: 1, cacheWrite: 12, cacheRefresh: 2 },
  });
  const rows = [row({ key: 'cheap', input: 1e6, output: 1e6, total: 2e6 })];
  const out = reprice({ rows, book, mapping: { cheap: 'expensive' } });
  const m = out.models[0];
  assert.equal(m.current, 2 + 10);
  assert.equal(m.whatif, 10 + 50);
  assert.ok(m.delta > 0, 'a pricier target must show a positive delta');
  assert.equal(m.partial, false);
});

test('reprice: missing rate kind on the target. That kind is n/a, and the total stays partial, never zero', () => {
  const book = stubBook({
    source: { in: 5, out: 20, cacheRead: 0.5, cacheWrite: 6, cacheRefresh: 1 },
    // No cacheWrite/cacheRefresh rate published for this target at all.
    'no-cache-rate': { in: 1, out: 4, cacheRead: 0.1, cacheWrite: null, cacheRefresh: null },
  });
  const rows = [row({ key: 'source', input: 1e6, output: 1e6, cacheWrite: 5e5, cacheRefresh: 0, total: 2.5e6 })];
  const out = reprice({ rows, book, mapping: { source: 'no-cache-rate' } });
  const m = out.models[0];
  assert.equal(m.whatifByKind.cacheWrite, null, 'the unpriced kind reports null (n/a), never 0');
  assert.equal(m.whatifByKind.input, 1, 'the priced kinds still compute');
  assert.equal(m.whatifByKind.output, 4);
  // Total sums only the known kinds: input(1) + output(4) + cacheRead(0).
  // It must not silently add 0 for the missing cache-write kind either.
  assert.equal(m.whatif, 1 + 4 + 0);
  assert.equal(m.partial, true, 'a missing kind flags the model row partial');
  assert.equal(out.overall.partial, true);
});

test('reprice: zero-token missing rate is 0, not partial. There was nothing to fail to price', () => {
  const book = stubBook({
    source: { in: 5, out: 20, cacheRead: 0.5, cacheWrite: 6, cacheRefresh: 1 },
    target: { in: 1, out: 4, cacheRead: 0.1, cacheWrite: null, cacheRefresh: null },
  });
  const rows = [row({ key: 'source', input: 1e6, output: 1e6, cacheWrite: 0, cacheRefresh: 0, total: 2e6 })];
  const out = reprice({ rows, book, mapping: { source: 'target' } });
  const m = out.models[0];
  assert.equal(m.whatifByKind.cacheWrite, 0);
  assert.equal(m.partial, false);
});

test('reprice: unpriced source model. Current is n/a and it is excluded from every overall total', () => {
  const book = stubBook({
    priced: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2, cacheRefresh: 0.4 },
    'known-target': { in: 3, out: 12, cacheRead: 0.3, cacheWrite: 3, cacheRefresh: 0.6 },
    // 'mystery-model' has no entry at all: book.lookup returns null.
  });
  const rows = [
    row({ key: 'priced', input: 1e6, output: 1e6, total: 2e6 }),
    row({ key: 'mystery-model', input: 1e6, output: 1e6, total: 2e6 }),
  ];
  const out = reprice({ rows, book, mapping: { priced: 'priced', 'mystery-model': 'known-target' } });
  const priced = out.models.find((m) => m.model === 'priced');
  const mystery = out.models.find((m) => m.model === 'mystery-model');

  assert.equal(mystery.current, null, 'no rate for the source model at all: current is n/a');
  assert.equal(mystery.whatif, 3 + 12, 'the target side can still be priced from the same tokens');
  assert.equal(mystery.delta, null, 'no baseline means no delta, never a delta against an assumed zero');

  // The unpriced-source model must not corrupt the aggregate: overall figures
  // come out exactly as if only the priced model were in the slice.
  assert.equal(out.overall.current, priced.current);
  assert.equal(out.overall.whatif, priced.whatif);
  assert.equal(out.overall.delta, priced.delta);
  assert.equal(out.overall.excluded, 1);
  assert.equal(out.overall.partial, true);
});

test('reprice: identity mapping yields zero delta', () => {
  const book = stubBook({
    solo: { in: 4, out: 16, cacheRead: 0.4, cacheWrite: 4, cacheRefresh: 0.8 },
  });
  const rows = [row({ key: 'solo', input: 1e6, output: 1e6, cacheRead: 5e5, cacheWrite: 2e5, cacheRefresh: 5e4, total: 2.75e6 })];
  // No mapping entry for 'solo' at all: reprice() must default to identity.
  const out = reprice({ rows, book, mapping: {} });
  const m = out.models[0];
  assert.equal(m.target, 'solo');
  assert.equal(m.current, m.whatif);
  assert.equal(m.delta, 0);
  assert.equal(out.overall.delta, 0);
  assert.equal(out.overall.partial, false);
});

test('reprice: no rows is an empty, non-crashing result', () => {
  const out = reprice({ rows: [], book: stubBook({}), mapping: {} });
  assert.deepEqual(out.models, []);
  assert.equal(out.overall.current, null);
  assert.equal(out.overall.whatif, null);
  assert.equal(out.overall.delta, null);
  assert.equal(out.overall.excluded, 0);
  assert.equal(out.overall.partial, false);
});

// ------------------------------------------------------------ deriveModelName --

test('deriveModelName: literal pattern with no groups or anchors', () => {
  assert.equal(deriveModelName('claude-sonnet-5'), 'claude-sonnet-5');
});

test('deriveModelName: anchors and an escaped dot', () => {
  assert.equal(deriveModelName('^gpt-5\\.5'), 'gpt-5.5');
});

test('deriveModelName: a group resolves to its first alternative', () => {
  assert.equal(deriveModelName('claude-opus-(5|4-8|4-7|4-6|4-5)'), 'claude-opus-5');
});

test('deriveModelName: top-level alternation takes the first branch, nested group included', () => {
  assert.equal(deriveModelName('claude-opus-4-(1|0)|claude-4-1-opus|claude-4-opus'), 'claude-opus-4-1');
});

test('deriveModelName: a bare "$" alternative in a group resolves to empty, not the literal character', () => {
  assert.equal(deriveModelName('^gpt-5($|[^.\\d])'), 'gpt-5');
  assert.equal(deriveModelName('^glm-5($|[^.\\d-])'), 'glm-5');
});

test('deriveModelName: every BUILTIN_PRICES entry round-trips through its own price book', () => {
  const book = buildPriceBook();
  for (const p of BUILTIN_PRICES) {
    const name = deriveModelName(p.match);
    assert.ok(name.length, `pattern ${p.match} derived an empty name`);
    const rate = book.lookup(name, 'unknown');
    assert.ok(rate, `derived name "${name}" from pattern ${p.match} did not resolve to any price`);
  }
});

// ------------------------------------------------------------- targetModelOptions --

test('targetModelOptions: builtin entries, user overrides and dataset models are grouped by provider', () => {
  const book = {
    entries: [
      { match: 'claude-sonnet-5', src: 'anthropic', origin: 'builtin' },
      { match: '^gpt-5\\.5', src: 'openai-thirdparty', origin: 'builtin' },
      { key: 'my-custom-model', origin: 'user' },
    ],
    lookup(model) {
      const known = { 'claude-sonnet-5': {}, 'gpt-5.5': {}, 'my-custom-model': {}, 'seen-and-priced': {} };
      return known[model] || null;
    },
  };
  const opts = targetModelOptions({ book, seenModels: [{ value: 'seen-and-priced' }, { value: 'seen-but-unpriced' }] });
  const byName = Object.fromEntries(opts.map((o) => [o.name, o.provider]));
  assert.equal(byName['claude-sonnet-5'], 'Anthropic');
  assert.equal(byName['gpt-5.5'], 'OpenAI', 'openai-thirdparty groups under OpenAI');
  assert.equal(byName['my-custom-model'], 'Other', 'a user override with no name pattern to infer from falls back to Other');
  assert.equal(byName['seen-and-priced'], 'Other', 'unrecognised prefix but still offered, since it is a priced dataset model');
  assert.equal(byName['seen-but-unpriced'], undefined, 'a dataset model with no price is not offered as a reprice target');
});

test('targetModelOptions: a derived name that fails to round-trip is dropped, never offered', () => {
  const book = {
    entries: [{ match: 'unmatchable-pattern', src: 'anthropic', origin: 'builtin' }],
    lookup() { return null; },
  };
  const opts = targetModelOptions({ book, seenModels: [] });
  assert.deepEqual(opts, []);
});

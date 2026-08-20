import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, int, usd, pct, delta, signedPct, shortDate, longDate, hourWindow, relativeTime, humanDuration } from '../src/core/units.js';
import { parseYaml, stringifyYaml } from '../src/core/yaml.js';
import {
  buildPriceBook, estimateCost, PRICING_TABLE_VERSION, BUILTIN_PRICES,
  PRICING_SOURCES, TIER_MULTIPLIERS, tierMultiplier,
} from '../src/core/pricing.js';
import { csvCell, csvLine, exportFilename } from '../src/export/csv.js';

test('compact scales through K, M, B and T without huge raw numbers', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1K');
  assert.equal(compact(1234), '1.23K');
  assert.equal(compact(12_345), '12.3K');
  assert.equal(compact(1_420_000_000), '1.42B');
  assert.equal(compact(104_236_288_020), '104B');
  assert.equal(compact(2_500_000_000_000), '2.5T');
  assert.equal(compact(-1_500_000), '-1.5M');
});

test('a missing number renders as not-available, never as zero', () => {
  assert.equal(compact(null), '—');
  assert.equal(compact(undefined), '—');
  assert.equal(int(null), '—');
  assert.equal(usd(null), '—');
  assert.equal(pct(null), '—');
  assert.equal(pct(Infinity), '—');
  assert.notEqual(compact(null), '0');
});

test('percentages and signed changes format sensibly', () => {
  assert.equal(pct(0.3456), '34.6%');
  assert.equal(signedPct(0.31), '+31%');
  assert.equal(signedPct(-0.07), '-7%');
  assert.equal(delta(150, 100), 0.5);
  assert.equal(delta(1, 0), null, 'growth from zero is undefined, not infinite');
  assert.equal(delta(0, 0), 0);
});

test('currency stays readable across four orders of magnitude', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(0.0004), '$0.0004');
  assert.equal(usd(12.5), '$12.50');
  assert.equal(usd(2345), '$2.3K');
  assert.equal(usd(2_345_000), '$2.35M');
});

test('dates and windows read the way people say them', () => {
  assert.equal(shortDate('2026-08-12'), 'Aug 12');
  assert.equal(longDate('2026-08-12'), 'Aug 12, 2026');
  assert.equal(hourWindow(10, 12), '10:00 – 13:00');
  assert.equal(hourWindow(22, 23), '22:00 – 00:00', 'a window can wrap midnight');
  assert.equal(humanDuration(90_000), '1m 30s');
  assert.equal(humanDuration(null), '—');
  assert.match(relativeTime(new Date(Date.now() - 3 * 60000).toISOString()), /min ago/);
  assert.equal(relativeTime(null), 'never');
});

test('the yaml subset round-trips the real config shape', () => {
  const cfg = {
    version: 1,
    timezone: 'Asia/Kolkata',
    identity: { user: 'v', machine: 'mac', team: null },
    providers: ['anthropic', 'openai'],
    sources: { anthropic: { paths: ['~/.claude', '~/.claude-work'] }, openai: { type: 'auto' } },
    store: { keepRaw: true, rawRetentionDays: null },
    analytics: { includeOverlaySources: false, minSessionGapMinutes: 30 },
    modelMappings: [{ match: '^acme-', provider: 'acme', label: 'Acme' }],
    interfaceOverrides: {},
    ui: { theme: 'dark', defaultRange: 'all', defaultFrom: '2026-03-14' },
  };
  const back = parseYaml(stringifyYaml(cfg));
  assert.deepEqual(back, cfg);
});

test('the yaml parser rejects what it cannot represent instead of guessing', () => {
  assert.throws(() => parseYaml('a: &anchor 1'), /anchors/);
  assert.throws(() => parseYaml('a: {b: 1}'), /flow mappings/);
  assert.deepEqual(parseYaml('a: {}'), { a: {} });
  assert.deepEqual(parseYaml('a: []'), { a: [] });
  assert.deepEqual(parseYaml('# just a comment\na: 1 # trailing\n'), { a: 1 });
  assert.deepEqual(parseYaml('a: "1"'), { a: '1' }, 'a quoted number stays a string');
});

test('pricing never invents a rate for an unknown model', () => {
  const book = buildPriceBook({});
  assert.equal(book.lookup('some-model-nobody-has-heard-of', 'unknown'), null);
  const c = estimateCost({ input_tokens: 1e6, output_tokens: 1e6 }, 'some-model-nobody-has-heard-of', 'unknown', book);
  assert.equal(c.cost, null, 'no price means no cost');
  assert.equal(c.basis, null);
});

test('pricing computes a known model from the published table', () => {
  const book = buildPriceBook({});
  const c = estimateCost(
    { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: null },
    'claude-3-5-sonnet-20241022', 'anthropic', book,
  );
  // 3.00 input + 15.00 output + 0.30 cache read
  assert.ok(Math.abs(c.cost - 18.3) < 1e-9, `expected 18.3, got ${c.cost}`);
  assert.equal(c.basis, 'estimated');
});

test('a user override beats the built-in table', () => {
  const book = buildPriceBook({ models: { 'claude-3-5-sonnet-20241022': { in: 1, out: 2 } } });
  const c = estimateCost({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-3-5-sonnet-20241022', 'anthropic', book);
  assert.ok(Math.abs(c.cost - 3) < 1e-6, `user rate applied: expected 3, got ${c.cost}`);
});

test('a cache write split into refresh and standard uses both rates', () => {
  const book = buildPriceBook({});
  const c = estimateCost(
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 2e6, cache_refresh_tokens: 1e6 },
    'claude-3-5-sonnet-20241022', 'anthropic', book,
  );
  // 1M standard write @ 3.75 + 1M refresh @ 6.00 (2x input)
  assert.ok(Math.abs(c.cost - 9.75) < 1e-6, `expected 9.75, got ${c.cost}`);
});

test('the built-in price table is well formed', () => {
  assert.match(PRICING_TABLE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  for (const p of BUILTIN_PRICES) {
    assert.ok(typeof p.in === 'number' && p.in >= 0, `${p.match} input rate`);
    assert.ok(typeof p.out === 'number' && p.out >= 0, `${p.match} output rate`);
    assert.ok(p.out >= p.in, `${p.match}: output should not be cheaper than input`);
    assert.doesNotThrow(() => new RegExp(p.match), `${p.match} compiles`);
    if (p.cacheRead !== undefined) assert.ok(p.cacheRead <= p.in, `${p.match}: a cache read should not cost more than fresh input`);
    if (p.cacheWrite) assert.ok(p.cacheWrite >= p.in, `${p.match}: a cache write should not be cheaper than fresh input`);
    if (p.cacheRefresh) assert.ok(p.cacheRefresh >= (p.cacheWrite ?? 0), `${p.match}: a long-TTL write should not be cheaper than a short-TTL one`);
  }
  // Ordering matters: a specific pattern must win over a general one.
  const book = buildPriceBook({});
  assert.equal(book.lookup('gpt-5.6-luna', 'openai').in, 0.1, 'the luna pattern must beat the generic gpt-5 pattern');
  assert.equal(book.lookup('claude-opus-4-1-20250805', 'anthropic').in, 15, 'opus 4.1 must not match the opus 4.5-5 row');
  assert.equal(book.lookup('claude-opus-5', 'anthropic').in, 5);
  assert.equal(book.lookup('glm-4.7-flash', 'zai').in, 0, 'a free tier is a real zero');
  assert.equal(book.lookup('glm-4.7-flashx', 'zai').in, 0.07, 'flashx is not the free flash tier');
});

test('the fetched rates match the published tables they came from', () => {
  const book = buildPriceBook({});
  const cases = [
    // model, provider, in, out, cacheRead, cacheWrite(5m), cacheRefresh(1h)
    ['claude-opus-5', 'anthropic', 5, 25, 0.5, 6.25, 10],
    ['claude-opus-4-8', 'anthropic', 5, 25, 0.5, 6.25, 10],
    ['claude-sonnet-5', 'anthropic', 2, 10, 0.2, 2.5, 4],
    ['claude-fable-5', 'anthropic', 10, 50, 1, 12.5, 20],
    ['claude-sonnet-4-5-20250929', 'anthropic', 3, 15, 0.3, 3.75, 6],
    ['claude-haiku-4-5-20251001', 'anthropic', 1, 5, 0.1, 1.25, 2],
    ['claude-opus-4-1-20250805', 'anthropic', 15, 75, 1.5, 18.75, 30],
    ['gpt-5.6-sol', 'openai', 2.5, 15, 0.25, 0, 0],
    ['gpt-5.6-terra', 'openai', 1, 6, 0.1, 0, 0],
    ['gpt-5.6-luna', 'openai', 0.1, 0.6, 0.01, 0, 0],
    ['deepseek-v4-flash', 'deepseek', 0.22, 0.66, 0.007, 0, 0],
    ['glm-4.6', 'zai', 0.6, 2.2, 0.11, 0, 0],
    ['gemini-3.5-flash', 'google', 1.5, 9, 0.15, 0, 0],
  ];
  for (const [model, provider, i, o, cr, cw, cf] of cases) {
    const p = book.lookup(model, provider);
    assert.ok(p, `${model} must be priced`);
    assert.equal(p.in, i, `${model} input`);
    assert.equal(p.out, o, `${model} output`);
    assert.equal(p.cacheRead, cr, `${model} cache read`);
    assert.equal(p.cacheWrite, cw, `${model} cache write (5m)`);
    assert.equal(p.cacheRefresh, cf, `${model} cache write (1h)`);
  }
});

test('every price entry names a source that exists', () => {
  for (const p of BUILTIN_PRICES) {
    assert.ok(p.src, `${p.match} must name a source`);
    assert.ok(PRICING_SOURCES[p.src], `${p.match} names unknown source "${p.src}"`);
  }
  for (const [key, s] of Object.entries(PRICING_SOURCES)) {
    assert.match(s.url, /^https:\/\//, `${key} url`);
    assert.match(s.fetched, /^\d{4}-\d{2}-\d{2}$/, `${key} fetched date`);
    assert.ok(['official', 'official-historical', 'third-party'].includes(s.confidence), `${key} confidence`);
  }
});

test('a service tier is a real multiplier, not a footnote', () => {
  assert.equal(tierMultiplier('priority', 'openai').mult, 4, 'OpenAI Fast mode is 4x standard');
  assert.equal(tierMultiplier('fast', 'openai').mult, 4, 'renamed from priority on 2026-07-30');
  assert.equal(tierMultiplier('standard', 'openai').mult, 1);
  assert.equal(tierMultiplier('default', 'openai').mult, 1);
  assert.equal(tierMultiplier('batch', 'anthropic').mult, 0.5);
  // An unrecognised tier is the standard rate, flagged as unknown — not a guess.
  const unknown = tierMultiplier('some-new-tier', 'openai');
  assert.equal(unknown.mult, 1);
  assert.equal(unknown.known, false);
  assert.equal(tierMultiplier(null, 'openai').mult, 1);
});

test('the tier multiplier is applied to the estimate', () => {
  const book = buildPriceBook({});
  const tok = { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0 };
  const std = estimateCost(tok, 'gpt-5.6-luna', 'openai', book, { tier: 'standard' });
  const fast = estimateCost(tok, 'gpt-5.6-luna', 'openai', book, { tier: 'priority' });
  assert.ok(Math.abs(std.cost - 0.7) < 1e-9, `standard: expected 0.70, got ${std.cost}`);
  assert.ok(Math.abs(fast.cost - 2.8) < 1e-9, `fast mode: expected 2.80, got ${fast.cost}`);
  assert.equal(fast.tierMult, 4);
  assert.equal(fast.tier, 'priority');
  const batch = estimateCost(tok, 'claude-opus-5', 'anthropic', book, { tier: 'batch' });
  assert.ok(Math.abs(batch.cost - 15) < 1e-9, `batch: expected 15.00, got ${batch.cost}`);
});

test('the long-TTL cache write tier is priced separately from the 5-minute one', () => {
  const book = buildPriceBook({});
  // 2M cache writes, of which 1M were long-TTL: 1M @ 6.25 + 1M @ 10.00
  const c = estimateCost(
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 2e6, cache_refresh_tokens: 1e6 },
    'claude-opus-5', 'anthropic', book,
  );
  assert.ok(Math.abs(c.cost - 16.25) < 1e-9, `expected 16.25, got ${c.cost}`);
  // Without the refresh breakdown, everything is priced at the 5-minute rate.
  const flat = estimateCost(
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 2e6, cache_refresh_tokens: null },
    'claude-opus-5', 'anthropic', book,
  );
  assert.ok(Math.abs(flat.cost - 12.5) < 1e-9, `expected 12.50, got ${flat.cost}`);
});

test('an estimate carries the source it was priced from', () => {
  const book = buildPriceBook({});
  assert.equal(estimateCost({ input_tokens: 1 }, 'claude-opus-5', 'anthropic', book).src, 'anthropic');
  assert.equal(estimateCost({ input_tokens: 1 }, 'gpt-5.6-sol', 'openai', book).src, 'openai');
  assert.equal(estimateCost({ input_tokens: 1 }, 'gpt-5.5', 'openai', book).src, 'openai-thirdparty');
  assert.equal(estimateCost({ input_tokens: 1 }, 'claude-opus-4-1-20250805', 'anthropic', book).src, 'legacy');
});

test('CSV writes a missing value as an empty cell, never as 0', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvLine([1, null, 'x']), '1,,x\n');
});

test('export filenames carry the date', () => {
  assert.equal(exportFilename('tokenflow-usage', new Date('2026-08-20T00:00:00Z')), 'tokenflow-usage-2026-08-20.csv');
  assert.equal(exportFilename('tokenflow', new Date('2026-08-20T00:00:00Z'), 'html'), 'tokenflow-2026-08-20.html');
});

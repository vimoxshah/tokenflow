import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecord, computeTotal, dateParts, hashId, interfaceClass,
  BILLABLE_TOKEN_FIELDS, BREAKDOWN_TOKEN_FIELDS, INTERFACE,
} from '../src/core/schema.js';
import { validateUsage } from '../src/core/validate.js';
import { classifyModel } from '../src/core/model-map.js';
import { classifyInterface } from '../src/core/interface-map.js';

test('missing token fields become null, not zero', () => {
  const r = createRecord({ timestamp: '2026-08-01T00:00:00Z', date: '2026-08-01', hour: 0, dow: 5, input_tokens: 10 });
  assert.equal(r.input_tokens, 10);
  assert.equal(r.output_tokens, null, 'unset field must be null');
  assert.equal(r.cache_read_tokens, null);
  assert.notEqual(r.output_tokens, 0);
});

test('a reported zero stays a zero', () => {
  const r = createRecord({ timestamp: '2026-08-01T00:00:00Z', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  assert.equal(r.input_tokens, 0);
  assert.equal(r.total_tokens, 0);
  assert.equal(r.total_is_partial, false);
});

test('total sums only the four mutually exclusive billable buckets', () => {
  const t = computeTotal({ input_tokens: 100, cache_read_tokens: 900, cache_write_tokens: 50, output_tokens: 20, cache_refresh_tokens: 40, reasoning_tokens: 10 });
  assert.equal(t.total, 1070, 'breakdown fields must not be added twice');
  assert.equal(t.partial, false);
});

test('breakdown fields are documented as subsets, never billable', () => {
  const billable = /** @type {readonly string[]} */ (BILLABLE_TOKEN_FIELDS);
  for (const f of BREAKDOWN_TOKEN_FIELDS) assert.ok(!billable.includes(f), `${f} must not be billable`);
});

test('a partially reported record still gets a total, flagged partial', () => {
  const t = computeTotal({ input_tokens: 100, output_tokens: 20, cache_read_tokens: null, cache_write_tokens: null });
  assert.equal(t.total, 120);
  assert.equal(t.partial, true);
});

test('a record with no billable field at all has a null total', () => {
  const t = computeTotal({ input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null });
  assert.equal(t.total, null);
});

test('validateUsage rejects a reasoning count above its output', () => {
  const r = createRecord({
    timestamp: '2026-08-01T00:00:00Z', date: '2026-08-01', hour: 0, dow: 5,
    id: 'x', source: 's', output_tokens: 10, reasoning_tokens: 50,
  });
  const v = validateUsage(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /reasoning_tokens exceeds output_tokens/.test(e)));
});

test('validateUsage rejects a cache refresh above its cache write', () => {
  const r = createRecord({
    timestamp: '2026-08-01T00:00:00Z', date: '2026-08-01', hour: 0, dow: 5,
    id: 'x', source: 's', cache_write_tokens: 10, cache_refresh_tokens: 99,
  });
  assert.ok(validateUsage(r).errors.some((e) => /cache_refresh_tokens exceeds/.test(e)));
});

test('validateUsage rejects a negative token count', () => {
  const r = createRecord({ timestamp: '2026-08-01T00:00:00Z', date: '2026-08-01', hour: 0, dow: 5, id: 'x', source: 's', input_tokens: -5 });
  assert.ok(validateUsage(r).errors.some((e) => /must not be negative/.test(e)));
});

test('dateParts resolves the wall clock in the capture timezone', () => {
  // 2026-08-01T20:30Z is already 2026-08-02 in Asia/Kolkata (+05:30).
  const utc = dateParts('2026-08-01T20:30:00Z', 'UTC');
  assert.equal(utc.date, '2026-08-01');
  assert.equal(utc.hour, 20);
  const ist = dateParts('2026-08-01T20:30:00Z', 'Asia/Kolkata');
  assert.equal(ist.date, '2026-08-02', 'a late-evening UTC event is next-day in IST');
  assert.equal(ist.hour, 2);
  assert.equal(ist.tz_offset, 330);
});

test('day of week is Monday-first', () => {
  assert.equal(dateParts('2026-08-17T12:00:00Z', 'UTC').dow, 0, '2026-08-17 is a Monday');
  assert.equal(dateParts('2026-08-23T12:00:00Z', 'UTC').dow, 6, '2026-08-23 is a Sunday');
});

test('hashId is stable and order-sensitive', () => {
  assert.equal(hashId('a', 'b'), hashId('a', 'b'));
  assert.notEqual(hashId('a', 'b'), hashId('b', 'a'));
});

test('model classification never guesses a vendor it cannot see', () => {
  assert.equal(classifyModel('claude-opus-4-1-20250805').provider, 'anthropic');
  assert.equal(classifyModel('gpt-5.6-sol').provider, 'openai');
  assert.equal(classifyModel('deepseek/deepseek-v4-flash').provider, 'deepseek');
  assert.equal(classifyModel('glm-4.6').provider, 'zai');
  assert.equal(classifyModel('gemini-2.0-flash').provider, 'google');
  assert.equal(classifyModel('kimi-k2').provider, 'moonshot');
  const unknown = classifyModel('totally-made-up-model-9000');
  assert.equal(unknown.provider, 'unknown');
  assert.equal(unknown.model, 'totally-made-up-model-9000', 'the raw string is preserved');
});

test('gateway-namespaced free/preview models classify by their own slug prefix', () => {
  // Real models seen on the opencode and hermes gateways.
  assert.equal(classifyModel('minimax/minimax-m2.5:free').provider, 'minimax');
  assert.equal(classifyModel('upstage/solar-pro4:free').provider, 'upstage');
  assert.equal(classifyModel('tencent/hy3:free').provider, 'tencent');
  assert.equal(classifyModel('tencent/hy3-preview').provider, 'tencent');
  assert.equal(classifyModel('nvidia/nemotron-3-super-120b-a12b:free').provider, 'nvidia');
  assert.equal(classifyModel('mimo-v2.5-free').provider, 'xiaomi');
  // A vendor slug inside an openrouter prefix wins over the namespace.
  assert.equal(classifyModel('openrouter/deepseek/v3').provider, 'deepseek');
  // OpenRouter's own house/stealth series attributes to OpenRouter itself —
  // the prefix is evidence, not a guess.
  assert.equal(classifyModel('openrouter/owl-alpha').provider, 'openrouter');
  // OpenCode's own gateway catalog: these slugs are published by OpenCode
  // (verified against real ingest — every x-preview-f-free record arrives via
  // the opencode adapter), so attribution follows the publisher.
  assert.equal(classifyModel('x-preview-f-free').provider, 'opencode');
  assert.equal(classifyModel('muse-spark-1.2-contributor-free').provider, 'opencode');
  // A stealth model with no namespace at all stays unknown: nothing local
  // names its vendor, so none is invented.
  assert.equal(classifyModel('zz-stealth-model-9').provider, 'unknown');
});

test('a provider hint never overrides evidence in the model name', () => {
  const c = classifyModel('claude-opus-5', { providerHint: 'openai' });
  assert.equal(c.provider, 'anthropic', 'the model name wins over a routing hint');
});

test('user rules take precedence over the built-ins', () => {
  const rules = [{ match: '^my-glm', provider: 'acme', label: 'Acme' }];
  const c = classifyModel('my-glm-turbo', { rules: [...rules] });
  assert.equal(c.provider, 'acme');
});

test('interface comes only from a surface signal, never from the model', () => {
  assert.equal(classifyInterface(['vscode']).interface, INTERFACE.IDE);
  assert.equal(classifyInterface(['codex-tui']).interface, INTERFACE.CLI);
  assert.equal(classifyInterface(['Codex Desktop']).interface, INTERFACE.DESKTOP);
  assert.equal(classifyInterface(['codex_sdk_ts']).interface, INTERFACE.SDK);
  assert.equal(classifyInterface(['exec']).interface, INTERFACE.CLI);
  assert.equal(classifyInterface(['Claude Code']).interface, INTERFACE.CLI);
  assert.equal(classifyInterface([null, undefined, '']).interface, INTERFACE.UNKNOWN);
  // A model name is not a surface signal.
  assert.equal(classifyInterface(['claude-opus-5']).interface, INTERFACE.UNKNOWN);
});

test('interfaceClass groups CLI and SDK together for the CLI-vs-GUI split', () => {
  assert.equal(interfaceClass(INTERFACE.CLI), interfaceClass(INTERFACE.SDK));
  assert.notEqual(interfaceClass(INTERFACE.CLI), interfaceClass(INTERFACE.DESKTOP));
});

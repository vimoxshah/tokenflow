import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import anthropic from '../src/providers/anthropic/index.js';
import openai, { TurnUsage } from '../src/providers/openai/index.js';
import cline from '../src/providers/cline/index.js';
import headroom from '../src/providers/headroom/index.js';
import generic, { mapRow, parseDelimited, normalizeTs } from '../src/providers/generic/index.js';
import mock from '../src/providers/mock/index.js';
import { ingestFixtureAsync, fetchAll, ctx, FIXTURES } from './helpers.js';
import { validateUsage } from '../src/core/validate.js';
import { MEASUREMENT } from '../src/core/schema.js';

// ============================================================== Anthropic ===

test('anthropic: streaming snapshots collapse to one record at the final max', async () => {
  const { records } = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl');
  const r1 = records.filter((r) => r.request_id === 'req_1');
  assert.equal(r1.length, 1, 'three streamed lines are one API call');
  assert.equal(r1[0].output_tokens, 250, 'the largest snapshot wins, not the sum (335) or the first (5)');
  assert.equal(r1[0].input_tokens, 10);
  assert.equal(r1[0].cache_read_tokens, 1000);
  assert.equal(r1[0].cache_write_tokens, 200);
  assert.equal(r1[0].cache_refresh_tokens, 200);
  assert.equal(r1[0].reasoning_tokens, 90);
  assert.equal(r1[0].total_tokens, 10 + 1000 + 200 + 250);
});

test('anthropic: synthetic zero-usage entries are not counted as requests', async () => {
  const { records, result } = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl');
  assert.equal(records.length, 2, 'two real API calls, the synthetic entry excluded');
  assert.equal(result.synthetic, 1);
  assert.ok(!records.some((r) => r.request_id === null));
});

test('anthropic: fields, project, branch and interface come from the transcript', async () => {
  const { records } = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl');
  const r = records[0];
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.client, 'claude-code');
  assert.equal(r.interface, 'CLI', 'from entrypoint=cli');
  assert.equal(r.project, 'billing-service');
  assert.equal(r.git_branch, 'main');
  assert.equal(r.session_id, 'sess-a');
  assert.equal(r.measurement, MEASUREMENT.PRIMARY);
  const side = records.find((x) => x.category === 'subagent');
  assert.ok(side, 'a sidechain message is categorised as a subagent');
});

test('anthropic: every emitted record validates', async () => {
  const { records } = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl');
  for (const r of records) {
    const v = validateUsage(r);
    assert.ok(v.ok, `invalid record: ${v.errors.join('; ')}`);
  }
});

test('anthropic: re-reading from the recorded offset emits nothing new', async () => {
  const first = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl');
  const again = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl', {
    start: first.result.offset, state: first.state,
  });
  assert.equal(again.records.length, 0, 'an unchanged file must not produce duplicates');
});

test('anthropic: a group that grew after the last read emits only the delta', async () => {
  // Simulate: the file was read to EOF mid-message, then the message finished.
  const partial = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl', { start: 0 });
  const emittedOut = partial.records.find((r) => r.request_id === 'req_1').output_tokens;
  assert.equal(emittedOut, 250);
  // Replaying the same bytes with the recorded tail state must add nothing.
  const replay = await ingestFixtureAsync(anthropic, 'anthropic-session.jsonl', { start: 0, state: partial.state });
  const req1 = replay.records.filter((r) => r.request_id === 'req_1');
  assert.equal(req1.length, 0, 'a fully-accounted group contributes no second record');
});

test('anthropic: a group split by the early flush is not double counted', async () => {
  // Force the early-flush path by making the lag threshold effectively zero:
  // build a file where an interleaved second group pushes the first far behind
  // the read head, then the first reappears with a larger snapshot.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-split-'));
  const file = path.join(dir, 'split.jsonl');
  const line = (req, mid, out, filler = 0) => JSON.stringify({
    type: 'assistant', requestId: req, uuid: `u-${mid}-${out}`, isSidechain: false,
    timestamp: '2026-08-01T10:00:00.000Z', sessionId: 's', cwd: '/p/proj', entrypoint: 'cli',
    pad: 'x'.repeat(filler),
    message: {
      id: mid, model: 'claude-opus-5', role: 'assistant',
      usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
    },
  });
  // A (small), then >2MB of B, then A again with a bigger output.
  fs.writeFileSync(file, [
    line('req_A', 'msg_A', 50),
    line('req_B', 'msg_B', 10, 2 * 1024 * 1024 + 1000),
    line('req_A', 'msg_A', 400),
  ].join('\n') + '\n');

  try {
    const { records } = await ingestFixtureAsync(anthropic, file);
    const a = records.filter((r) => r.request_id === 'req_A');
    const outSum = a.reduce((x, r) => x + r.output_tokens, 0);
    const inSum = a.reduce((x, r) => x + r.input_tokens, 0);
    const crSum = a.reduce((x, r) => x + r.cache_read_tokens, 0);
    assert.equal(outSum, 400, 'the split group must total its true maximum, not 50 + 400');
    assert.equal(inSum, 10, 'prompt-side counts must not be counted twice either');
    assert.equal(crSum, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================= Codex ====

test('codex TurnUsage: a single event is the identity', () => {
  const t = new TurnUsage();
  t.add({ total_tokens: 100, input_tokens: 90, cached_input_tokens: 10, output_tokens: 10 });
  const u = t.finish();
  assert.equal(u.input_tokens, 90);
  assert.equal(u.output_tokens, 10);
  assert.equal(t.segments, 1);
});

test('codex TurnUsage: re-reported growth takes the max, never the sum', () => {
  const t = new TurnUsage();
  for (const v of [20000, 24000, 30000]) t.add({ total_tokens: v, input_tokens: v - 1000, output_tokens: 100 });
  const u = t.finish();
  assert.equal(u.input_tokens, 29000, 'not 20000+23000+29000');
  assert.equal(u.output_tokens, 100);
  assert.equal(t.segments, 1);
  assert.equal(t.events, 3);
});

test('codex TurnUsage: a drop starts a new segment and the segments add up', () => {
  const t = new TurnUsage();
  for (const v of [30000, 5000, 9000]) t.add({ total_tokens: v, input_tokens: v, output_tokens: 1 });
  const u = t.finish();
  assert.equal(u.input_tokens, 30000 + 9000);
  assert.equal(t.segments, 2);
});

test('codex TurnUsage: a field never reported stays null', () => {
  const t = new TurnUsage();
  t.add({ total_tokens: 5, input_tokens: 5 });
  const u = t.finish();
  assert.equal(u.cache_write_input_tokens, null, 'unreported is not zero');
  assert.equal(u.output_tokens, null);
});

test('codex: one record per turn, with OpenAI-inclusive input split correctly', async () => {
  const { records } = await ingestFixtureAsync(openai, 'codex-session.jsonl');
  assert.equal(records.length, 2, 'two turns, not eleven events');
  const a = records.find((r) => r.request_id === 'turn-A');
  // final snapshot of turn A: input 28000 incl. 22000 cached
  assert.equal(a.cache_read_tokens, 22000);
  assert.equal(a.input_tokens, 6000, 'fresh input excludes the cached portion');
  assert.equal(a.output_tokens, 2000);
  assert.equal(a.reasoning_tokens, 900);
  assert.equal(a.total_tokens, 6000 + 22000 + 0 + 2000);
  assert.equal(a.metadata.token_count_events, 3);
  assert.equal(a.metadata.usage_segments, 1);
});

test('codex: a mid-turn compaction is summed across segments', async () => {
  const { records } = await ingestFixtureAsync(openai, 'codex-session.jsonl');
  const b = records.find((r) => r.request_id === 'turn-B');
  // segment 1 max: input 29000 / cached 25000 ; segment 2 max: input 8500 / cached 6000
  assert.equal(b.cache_read_tokens, 25000 + 6000);
  assert.equal(b.input_tokens, (29000 - 25000) + (8500 - 6000));
  assert.equal(b.metadata.usage_segments, 2);
});

test('codex: a non-vendor model_provider is recorded as a gateway, not a vendor', async () => {
  const { records } = await ingestFixtureAsync(openai, 'codex-session.jsonl');
  const r = records[0];
  assert.equal(r.provider, 'openai', 'the vendor comes from the model name');
  assert.equal(r.gateway, 'headroom', 'the router is its own dimension');
  assert.equal(r.model, 'gpt-5.6-sol');
  assert.equal(r.interface, 'CLI');
  assert.equal(r.project, 'web-app');
  assert.equal(r.session_id, 'cx-sess-1');
});

test('codex: every emitted record validates', async () => {
  const { records } = await ingestFixtureAsync(openai, 'codex-session.jsonl');
  for (const r of records) {
    const v = validateUsage(r);
    assert.ok(v.ok, `invalid record: ${v.errors.join('; ')}`);
  }
});

test('codex: re-reading from the recorded offset emits nothing new', async () => {
  const first = await ingestFixtureAsync(openai, 'codex-session.jsonl');
  const again = await ingestFixtureAsync(openai, 'codex-session.jsonl', { start: first.result.offset, state: first.state });
  assert.equal(again.records.length, 0);
});

// ================================================================= Cline ====

test('cline: reports activity with every token field null, never zero', async () => {
  const c = ctx({ config: { sources: { cline: { path: path.join(FIXTURES, 'cline', 'sessions') } } } });
  const files = await cline.discover(c);
  assert.equal(files.length, 1);
  const { records } = await ingestFixtureAsync(cline, files[0].path, { c, key: files[0].key });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.measurement, MEASUREMENT.ACTIVITY);
  for (const f of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    assert.equal(r[f], null, `${f} must be null — Cline does not report it`);
  }
  assert.equal(r.total_tokens, null, 'no token total can be claimed');
  assert.equal(r.provider, 'deepseek', 'the vendor comes from the model, not from provider:"cline"');
  assert.equal(r.client, 'cline');
  assert.equal(r.interface, 'CLI');
  assert.equal(r.duration_ms, 30 * 60 * 1000 + 30170);
  assert.equal(r.metadata.agent_messages, 2);
});

// ============================================================== Headroom ====

test('headroom: overlay records carry measured cost and no invented tokens', async () => {
  const { records } = await ingestFixtureAsync(headroom, 'headroom-savings.jsonl');
  assert.equal(records.length, 2);
  const r = records[0];
  assert.equal(r.measurement, MEASUREMENT.OVERLAY, 'must not enter token totals by default');
  assert.equal(r.input_tokens, 83161, 'post-compression prompt tokens actually sent');
  assert.equal(r.output_tokens, null, 'the savings log has no output count');
  assert.equal(r.cost_basis, 'measured');
  assert.equal(r.estimated_cost, 0.028866);
  assert.equal(r.gateway, 'headroom');
  assert.equal(r.metadata.tokens_saved, 92783 - 83161);
});

// =============================================================== Generic ====

test('generic: CSV parsing handles quotes and empty cells', () => {
  const rows = parseDelimited('a,b,c\n1,"x,y",\n2,z,3\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].b, 'x,y');
  assert.equal(rows[0].c, '');
});

test('generic: an unmapped token field stays null, and cost is measured', () => {
  const mapping = {
    name: 'test', timestampFormat: 'iso',
    fields: {
      timestamp: 'created_at', model: 'model', input_tokens: 'prompt_tokens',
      output_tokens: 'completion_tokens', cache_read_tokens: 'cached_tokens',
      estimated_cost: 'cost_usd', session_id: 'generation_id',
    },
    defaults: { client: 'openrouter', interface: 'API' },
  };
  const rows = parseDelimited(
    'created_at,model,prompt_tokens,completion_tokens,cached_tokens,cost_usd,generation_id\n'
    + '2026-08-05T12:05:00Z,gemini-2.0-flash,900,120,,0.0002,gen-2\n',
  );
  const r = mapRow(rows[0], mapping, 0);
  assert.equal(r.input_tokens, 900);
  assert.equal(r.cache_read_tokens, null, 'an empty cell is not available, not zero');
  assert.equal(r.cache_write_tokens, null, 'an unmapped field is not available');
  assert.equal(r.measured_cost, 0.0002);
  assert.equal(r.interface, 'API');
});

test('generic: timestamps in seconds, milliseconds and ISO all normalise', () => {
  assert.equal(normalizeTs('2026-08-05T12:00:00Z'), '2026-08-05T12:00:00.000Z');
  assert.equal(normalizeTs(1785600000, 'epoch_s'), new Date(1785600000000).toISOString());
  assert.equal(normalizeTs(1785600000000, 'epoch_ms'), new Date(1785600000000).toISOString());
  assert.equal(normalizeTs('not a date'), null);
});

test('generic: a row with an unusable timestamp is rejected, not defaulted to now', () => {
  const r = mapRow({ ts: 'nonsense' }, { name: 'x', fields: { timestamp: 'ts' } }, 0);
  assert.equal(r, null);
});

// ================================================================== Mock ====

test('mock: demo data is deterministic and labelled', async () => {
  const c = ctx({ config: { providers: ['mock'], sources: { mock: { days: 20, seed: 42 } } } });
  const a = await fetchAll(mock, c);
  const b = await fetchAll(mock, c);
  assert.equal(a.records.length, b.records.length, 'same seed, same output');
  assert.ok(a.records.length > 0);
  assert.deepEqual(a.records.map((r) => r.total_tokens), b.records.map((r) => r.total_tokens));
  assert.ok(a.records.every((r) => r.metadata.demo === true), 'every demo record is flagged');
  assert.ok(a.records.every((r) => r.machine === 'demo-machine'));
});

test('mock: detection is opt-in only', async () => {
  const off = await mock.detect(ctx({ config: { providers: [] } }));
  assert.equal(off.available, false, 'demo data must never appear by accident');
});

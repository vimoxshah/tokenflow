import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import anthropic from '../src/providers/anthropic/index.js';
import openai, { TurnUsage } from '../src/providers/openai/index.js';
import cline from '../src/providers/cline/index.js';
import headroom from '../src/providers/headroom/index.js';
import generic, { mapRow, parseDelimited, normalizeTs } from '../src/providers/generic/index.js';
import mock from '../src/providers/mock/index.js';
import opencode from '../src/providers/opencode/index.js';
import hermes from '../src/providers/hermes/index.js';
import { ingestFixtureAsync, fetchAll, ctx, FIXTURES } from './helpers.js';
import { validateUsage } from '../src/core/validate.js';
import { MEASUREMENT } from '../src/core/schema.js';
import { sqliteAvailable } from '../src/core/sqlite.js';

// Built lazily so a Node without node:sqlite skips these tests instead of
// failing on the import.
const haveSqlite = sqliteAvailable();
const { DatabaseSync } = haveSqlite ? await import('node:sqlite') : {};

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

// ============================================================== OpenCode ====

/** Build a minimal opencode.db in a temp dir; returns { path, close, db }. */
function buildOpencodeDb(dir) {
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, agent TEXT, version TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  return { file, db };
}

function opencodeMsg(db, { id, session = 'ses_1', created, updated = created, tokens, modelID = 'claude-sonnet-4', providerID = 'opencode', mode = 'build', finish = 'stop' }) {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(
    id, session, created, updated,
    JSON.stringify({
      role: 'assistant', modelID, providerID, mode, finish,
      tokens: { ...tokens, total: (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0) },
      time: { created, completed: created + 4000 },
    }),
  );
}

function opencodeCtx(dir) {
  return ctx({ config: { sources: { opencode: { db: path.join(dir, 'opencode.db') } }, interfaceOverrides: {} } });
}

test('opencode: one record per assistant message with exclusive input and gateway routing', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-opencode-'));
  try {
    const { db } = buildOpencodeDb(dir);
    db.prepare('INSERT INTO project (id, worktree) VALUES (?,?)').run('prj_1', '/code/billing-service');
    db.prepare('INSERT INTO session (id, project_id, parent_id, directory, agent, version) VALUES (?,?,?,?,?,?)')
      .run('ses_1', 'prj_1', null, '/code/billing-service', 'build', '1.0.0');
    db.prepare('INSERT INTO session (id, project_id, parent_id, directory, agent, version) VALUES (?,?,?,?,?,?)')
      .run('ses_2', 'prj_1', 'ses_1', '/code/billing-service', 'explore', '1.0.0');
    opencodeMsg(db, { id: 'msg_1', created: 1787000000000, tokens: { input: 9000, output: 300, reasoning: 100, cache: { read: 50000, write: 1200 } } });
    opencodeMsg(db, { id: 'msg_2', session: 'ses_2', created: 1787000060000, tokens: { input: 500, output: 40, reasoning: 0, cache: { read: 8000, write: 0 } }, providerID: 'anthropic' });
    db.close();

    const { records } = await fetchAll(opencode, opencodeCtx(dir));
    assert.equal(records.length, 2);
    const r1 = records.find((r) => r.request_id === 'msg_1');
    // input is exclusive of cache reads — nothing to subtract
    assert.equal(r1.input_tokens, 9000);
    assert.equal(r1.cache_read_tokens, 50000);
    assert.equal(r1.cache_write_tokens, 1200);
    assert.equal(r1.output_tokens, 300);
    assert.equal(r1.reasoning_tokens, 100, 'reasoning within output stays a plain subset');
    assert.equal(r1.provider, 'anthropic', 'vendor comes from the model string');
    assert.equal(r1.gateway, 'opencode', 'a non-vendor providerID is a gateway');
    assert.equal(r1.project, 'billing-service');
    assert.equal(r1.client, 'opencode');
    assert.equal(r1.interface, 'Unknown', 'no surface field exists, so no interface is invented');
    assert.equal(r1.measurement, MEASUREMENT.PRIMARY);
    const r2 = records.find((r) => r.request_id === 'msg_2');
    assert.equal(r2.gateway, null, 'providerID anthropic IS the vendor');
    assert.equal(r2.category, 'subagent', 'a child session is a subagent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: zero-token rows are skipped, additive reasoning is folded into output', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-opencode-'));
  try {
    const { db } = buildOpencodeDb(dir);
    db.prepare('INSERT INTO session (id, project_id, parent_id, directory, agent, version) VALUES (?,?,?,?,?,?)')
      .run('ses_1', null, null, '/code/x', 'build', '1.0.0');
    opencodeMsg(db, { id: 'msg_aborted', created: 1787000000000, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    opencodeMsg(db, { id: 'msg_add', created: 1787000060000, tokens: { input: 200, output: 30, reasoning: 80, cache: { read: 0, write: 0 } } });
    db.close();

    const { records } = await fetchAll(opencode, opencodeCtx(dir));
    assert.equal(records.length, 1, 'the aborted zero-token row is not a request');
    const r = records[0];
    assert.equal(r.output_tokens, 110, 'reasoning reported additively folds into output');
    assert.equal(r.reasoning_tokens, 80);
    assert.ok(validateUsage(r).ok, 'the folded record satisfies the subset invariant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: an in-place update emits only the delta, and an unchanged re-read emits nothing', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-opencode-'));
  try {
    const { db } = buildOpencodeDb(dir);
    db.prepare('INSERT INTO session (id, project_id, parent_id, directory, agent, version) VALUES (?,?,?,?,?,?)')
      .run('ses_1', null, null, '/code/x', 'build', '1.0.0');
    opencodeMsg(db, { id: 'msg_1', created: 1787000000000, updated: 1787000010000, tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 2000, write: 0 } } });
    db.close();

    const state = {};
    const first = await fetchAll(opencode, opencodeCtx(dir), state);
    assert.equal(first.records.length, 1);

    // The row is revised in place, as opencode does while a response finalises.
    const db2 = new DatabaseSync(path.join(dir, 'opencode.db'));
    opencodeMsgUpdate(db2, 'msg_1', 1787000090000, { input: 1000, output: 220, reasoning: 0, cache: { read: 3500, write: 0 } });
    db2.close();

    const second = await fetchAll(opencode, opencodeCtx(dir), state);
    assert.equal(second.records.length, 1, 'only the delta is emitted');
    const d = second.records[0];
    assert.equal(d.input_tokens, 0);
    assert.equal(d.output_tokens, 170);
    assert.equal(d.cache_read_tokens, 1500);
    assert.ok(d.metadata.continuation_of, 'the delta names what it continues');

    const third = await fetchAll(opencode, opencodeCtx(dir), state);
    assert.equal(third.records.length, 0, 'an unchanged re-read must produce no duplicates');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function opencodeMsgUpdate(db, id, updated, tokens) {
  db.prepare('UPDATE message SET time_updated = ?, data = ? WHERE id = ?').run(
    updated,
    JSON.stringify({
      role: 'assistant', modelID: 'claude-sonnet-4', providerID: 'opencode', mode: 'build', finish: 'stop',
      tokens: { ...tokens, total: (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0) },
      time: { created: 1787000000000, completed: updated },
    }),
    id,
  );
}

// =============================================================== Hermes =====

/** Build a minimal hermes state.db in a temp dir. */
function buildHermesDb(dir) {
  const file = path.join(dir, 'state.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, cwd TEXT, git_branch TEXT, git_repo_root TEXT,
      parent_session_id TEXT, started_at REAL, ended_at REAL, title TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
      cost_status TEXT, first_seen REAL, last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    );
  `);
  return { file, db };
}

function hermesUsage(db, { session, model, provider = '', baseUrl = '', mode = '', task = '', calls = 3, i = 0, o = 0, cr = 0, cw = 0, rs = 0, actual = 0, first, last, source = 'cli', cwd = null, branch = null, root = null, parent = null, started = null, ended = null }) {
  db.prepare('INSERT OR REPLACE INTO sessions (id, source, cwd, git_branch, git_repo_root, parent_session_id, started_at, ended_at, title) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(session, source, cwd, branch, root, parent, started ?? first, ended ?? last, `session ${session}`);
  db.prepare(`INSERT OR REPLACE INTO session_model_usage
    (session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
     actual_cost_usd, cost_status, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(session, model, provider, baseUrl, mode, task, calls, i, o, cr, cw, rs, actual, actual > 0 ? 'measured' : null, first, last);
}

function hermesCtx(dir) {
  return ctx({ config: { sources: { hermes: { db: path.join(dir, 'state.db') } }, interfaceOverrides: {} } });
}

test('hermes: per-session-per-model records with exclusive input, gateway routing and measured cost', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    hermesUsage(db, {
      session: 's1', model: 'gpt-5.5', provider: 'openai-codex', task: 'review',
      i: 36000, o: 2600, cr: 288000, rs: 340, actual: 0.42,
      first: 1787000000, last: 1787003600, source: 'cli', cwd: '/work/billing-service', branch: 'main', root: '/work/billing-service',
      started: 1786999900, ended: 1787003700,
    });
    db.close();

    const { records } = await fetchAll(hermes, hermesCtx(dir));
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.provider, 'openai', 'vendor from the model string');
    assert.equal(r.gateway, 'openai-codex', 'billing_provider is the routing layer');
    assert.equal(r.input_tokens, 36000, 'input is already exclusive of cache reads');
    assert.equal(r.cache_read_tokens, 288000);
    assert.equal(r.output_tokens, 2600);
    assert.equal(r.reasoning_tokens, 340);
    assert.equal(r.estimated_cost, 0.42);
    assert.equal(r.cost_basis, 'measured', "hermes' actual cost is a measurement, not an estimate");
    assert.equal(r.interface, 'CLI', 'from sessions.source = cli');
    assert.equal(r.git_branch, 'main');
    assert.equal(r.project, 'billing-service');
    assert.equal(r.category, 'review');
    assert.equal(r.session_id, 's1');
    assert.ok(validateUsage(r).ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: unmapped models stay unknown but keep their gateway; "default" is not a model', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    hermesUsage(db, { session: 's1', model: 'anonymous-stealth-preview', provider: 'nous', i: 500, o: 100, first: 1787000000, last: 1787000100, source: 'cron' });
    hermesUsage(db, { session: 's2', model: 'default', provider: 'nous', i: 10, o: 5, first: 1787000200, last: 1787000300, source: 'telegram' });
    db.close();

    const { records } = await fetchAll(hermes, hermesCtx(dir));
    assert.equal(records.length, 2);
    const unmapped = records.find((r) => r.session_id === 's1');
    assert.equal(unmapped.provider, 'unknown', 'never bucketed into a plausible-looking vendor');
    assert.equal(unmapped.gateway, 'nous');
    assert.equal(unmapped.interface, 'Unknown', 'cron has no CLI surface signal');
    const def = records.find((r) => r.session_id === 's2');
    assert.equal(def.model, 'unknown', '"default" is a placeholder, not a model name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: a grown usage row emits only the delta, and an unchanged re-read emits nothing', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    hermesUsage(db, { session: 's1', model: 'gpt-5.5', provider: 'openrouter', i: 1000, o: 200, cr: 5000, actual: 0.10, first: 1787000000, last: 1787000100, source: 'cli' });
    db.close();

    const state = {};
    const first = await fetchAll(hermes, hermesCtx(dir), state);
    assert.equal(first.records.length, 1);

    // The session makes more calls: same row, bigger totals, later last_seen.
    const db2 = new DatabaseSync(path.join(dir, 'state.db'));
    hermesUsage(db2, { session: 's1', model: 'gpt-5.5', provider: 'openrouter', i: 1800, o: 650, cr: 9000, actual: 0.25, first: 1787000000, last: 1787000900, source: 'cli' });
    db2.close();

    const second = await fetchAll(hermes, hermesCtx(dir), state);
    assert.equal(second.records.length, 1, 'only the delta is emitted');
    const d = second.records[0];
    assert.equal(d.input_tokens, 800);
    assert.equal(d.output_tokens, 450);
    assert.equal(d.cache_read_tokens, 4000);
    assert.equal(d.estimated_cost, 0.15, 'measured cost is delta-ed too');
    assert.equal(d.cost_basis, 'measured');

    const third = await fetchAll(hermes, hermesCtx(dir), state);
    assert.equal(third.records.length, 0, 'an unchanged re-read must produce no duplicates');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: rows differing only in billing_mode are distinct, not an oscillating pair', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    // The exact shape that produced 37 billion phantom tokens in one day: one
    // session and model billed through the same provider twice, distinguished
    // only by billing_mode — a column the tail key used to ignore. The two
    // rows then shared a tail, each computed its delta against the other's
    // totals, and every refresh cycle re-emitted the difference forever.
    const { db } = buildHermesDb(dir);
    const row = { session: 's1', model: 'gpt-5.5', provider: 'opencode-free', baseUrl: 'https://example.invalid/v1', first: 1787000000, last: 1787000100 };
    hermesUsage(db, { ...row, mode: '', i: 380141, o: 43829, cr: 44942080 });
    hermesUsage(db, { ...row, mode: 'chat_completions', i: 902243, o: 16861, cr: 33361280 });
    db.close();

    const billable = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
    const tokensOf = (recs) => recs.reduce(
      (n, r) => n + billable.reduce((m, k) => m + (Number.isFinite(r[k]) ? r[k] : 0), 0), 0,
    );
    const state = {};
    const first = await fetchAll(hermes, hermesCtx(dir), state);
    assert.equal(first.records.length, 2, 'two source rows are two records');
    assert.equal(tokensOf(first.records), 380141 + 43829 + 44942080 + 902243 + 16861 + 33361280);
    assert.equal(new Set(first.records.map((r) => r.id)).size, 2, 'distinct rows get distinct ids');

    // The decisive check: re-reading an UNCHANGED database must be a no-op.
    // Under the collision this emitted the pair's difference again on every
    // pass, so the totals grew with the number of refresh cycles.
    for (let pass = 0; pass < 3; pass++) {
      const again = await fetchAll(hermes, hermesCtx(dir), state);
      assert.equal(again.records.length, 0, `pass ${pass + 2} must add nothing`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: a field that dips while another grows cannot manufacture usage', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    const row = { session: 's1', model: 'gpt-5.5', provider: 'openrouter', first: 1787000000 };
    hermesUsage(db, { ...row, i: 5000, o: 1000, last: 1787000100 });
    db.close();

    const state = {};
    assert.equal((await fetchAll(hermes, hermesCtx(dir), state)).records.length, 1);

    // A row where input GREW but output DIPPED — the mixed case the colliding
    // pair produced. The row is emitted for its real growth, and the tail must
    // keep output's high-water mark: recording the dip would turn output's
    // return to its old value into usage that never happened.
    const db2 = new DatabaseSync(path.join(dir, 'state.db'));
    hermesUsage(db2, { ...row, i: 5200, o: 20, last: 1787000200 });
    db2.close();
    const grew = await fetchAll(hermes, hermesCtx(dir), state);
    assert.equal(grew.records.length, 1);
    assert.equal(grew.records[0].input_tokens, 200);
    assert.equal(grew.records[0].output_tokens, 0, 'a dip contributes nothing');

    const db3 = new DatabaseSync(path.join(dir, 'state.db'));
    hermesUsage(db3, { ...row, i: 5200, o: 1000, last: 1787000300 });
    db3.close();
    assert.equal((await fetchAll(hermes, hermesCtx(dir), state)).records.length, 0,
      'output returning to its earlier high is not new usage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: a vendor billing_provider is a direct call, not a gateway', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    hermesUsage(db, { session: 's1', model: 'claude-sonnet-4', provider: 'anthropic', i: 900, o: 100, first: 1787000000, last: 1787000100, source: 'cli' });
    db.close();

    const { records } = await fetchAll(hermes, hermesCtx(dir));
    const r = records[0];
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.gateway, null, 'billing via the vendor itself is direct, not a gateway');
    assert.equal(r.metadata.billing_provider, 'anthropic', 'the raw value is preserved in metadata');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermes: every emitted record validates across a mixed corpus', { skip: !haveSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hermes-'));
  try {
    const { db } = buildHermesDb(dir);
    hermesUsage(db, { session: 's1', model: 'tencent/hy3:free', provider: 'nous', i: 2000, o: 300, cr: 28000, rs: 140, first: 1787000000, last: 1787000500, source: 'whatsapp' });
    hermesUsage(db, { session: 's2', model: 'claude-sonnet-4', provider: 'openrouter', i: 900, o: 400, cw: 1200, rs: 400, first: 1787001000, last: 1787001600, source: 'cli', parent: 's1' });
    db.close();

    const { records } = await fetchAll(hermes, hermesCtx(dir));
    assert.equal(records.length, 2);
    for (const r of records) assert.ok(validateUsage(r).ok, `invalid: ${r.id}: ${validateUsage(r).errors.join('; ')}`);
    const sub = records.find((r) => r.session_id === 's2');
    assert.equal(sub.category, 'subagent', 'a child session is a subagent');
    assert.equal(sub.reasoning_tokens, 400, 'reasoning equal to output stays a subset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

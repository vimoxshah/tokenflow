import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `buildLiveStatus`'s four newest sections: live sessions, today's receipts,
 * guard state and sparklines. Each test gets its own TOKENFLOW_HOME, seeded by
 * writing already-normalized records straight through `encodeRecord` into the
 * store's shard files (the same on-disk shape `scanRecords`/`decodeRecord`
 * round-trip in test/store.test.js) plus a `data/state.json` naming a fixed
 * `lastRefresh` — the instant every new section anchors on instead of the
 * real clock.
 */
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-livesess-'));
  const prev = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = dir;
  const bust = `?t=${Date.now()}${Math.random()}`;
  const mods = {
    live: await import(`../src/core/live-status.js${bust}`),
    store: await import(`../src/core/store.js${bust}`),
    config: await import(`../src/core/config.js${bust}`),
  };
  try {
    return await fn(dir, mods);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME;
    else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The local calendar date of `ms`, machine timezone — matches bundle.js's `localToday`. */
function localDate(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Write one normalized record into the store's shard file for its month. */
function seed(dir, encodeRecord, r) {
  const date = localDate(r.ts);
  const full = {
    timestamp: new Date(r.ts).toISOString(),
    date,
    hour: new Date(r.ts).getUTCHours(),
    dow: new Date(r.ts).getUTCDay(),
    provider: r.provider,
    model: r.model,
    model_family: r.model,
    client: 'claude-code',
    interface: 'cli',
    input_tokens: r.input_tokens ?? null,
    output_tokens: r.output_tokens ?? null,
    cache_read_tokens: r.cache_read_tokens ?? null,
    cache_write_tokens: r.cache_write_tokens ?? null,
    session_id: r.session_id,
    project: r.project ?? null,
    repository: r.repository ?? null,
    git_branch: r.git_branch ?? null,
    category: r.category ?? null,
    service_tier: null,
    estimated_cost: r.estimated_cost ?? null,
    cost_basis: r.cost_basis ?? (r.estimated_cost != null ? 'estimated' : null),
    source: r.source,
    measurement: r.measurement ?? 'primary',
  };
  const shard = path.join(dir, 'data', 'records', `${date.slice(0, 7)}.jsonl`);
  fs.mkdirSync(path.dirname(shard), { recursive: true });
  fs.appendFileSync(shard, JSON.stringify(encodeRecord(full)) + '\n');
}

function writeState(dir, lastRefresh) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
    version: 4, sources: {}, lastRefresh, lastRefreshDurationMs: 0, stale: [], counters: { records: 0, malformed: 0 },
  }));
}

function closeTo(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(actual !== null && actual !== undefined, `expected a number${msg ? ` (${msg})` : ''}, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be close to ${expected}${msg ? ` (${msg})` : ''}`);
}

// ---------------------------------------------------------------- fixture ---

/** Seeds the scenario shared by the liveSessions + guard tests. Returns NOW (ms). */
function seedScenario(dir, encodeRecord) {
  const NOW = Date.now();
  writeState(dir, new Date(NOW).toISOString());

  // sess-a: three turns, all priced (claude-sonnet-5: in $2, out $10 /1M),
  // no cache tokens -> contextShare is a real, deterministic 0.
  seed(dir, encodeRecord, {
    ts: NOW - 40 * 60000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
    session_id: 'sess-a', project: 'tokenflow', repository: '/Users/x/work/tokenflow', git_branch: 'feature/live',
    input_tokens: 100_000, output_tokens: 10_000, estimated_cost: 0.2 + 0.1, // 0.3
  });
  seed(dir, encodeRecord, {
    ts: NOW - 20 * 60000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5', category: 'subagent',
    session_id: 'sess-a', project: 'tokenflow', repository: '/Users/x/work/tokenflow', git_branch: 'feature/live',
    input_tokens: 50_000, output_tokens: 5_000, estimated_cost: 0.1 + 0.05, // 0.15
  });
  seed(dir, encodeRecord, { // last turn -> contextTokens/lastActivityAt
    ts: NOW - 2 * 60000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
    session_id: 'sess-a', project: 'tokenflow', repository: '/Users/x/work/tokenflow', git_branch: 'feature/live',
    input_tokens: 20_000, output_tokens: 2_000, estimated_cost: 0.04 + 0.02, // 0.06 -> total 0.51
  });

  // sess-b: two turns, one with cache-read tokens (gpt-5.6-sol: in $2.5, out
  // $15, cacheRead $0.25 /1M) -> a real, non-zero, non-one contextShare.
  seed(dir, encodeRecord, {
    ts: NOW - 15 * 60000, source: 'openai', provider: 'openai', model: 'gpt-5.6-sol',
    session_id: 'sess-b', project: 'otherrepo', repository: '/Users/x/work/otherrepo', git_branch: 'main',
    input_tokens: 40_000, output_tokens: 2_000, cache_read_tokens: 200_000, estimated_cost: 0.1 + 0.03 + 0.05, // 0.18
  });
  seed(dir, encodeRecord, { // last turn, no cache tokens
    ts: NOW - 5 * 60000, source: 'openai', provider: 'openai', model: 'gpt-5.6-sol',
    session_id: 'sess-b', project: 'otherrepo', repository: '/Users/x/work/otherrepo', git_branch: 'main',
    input_tokens: 10_000, output_tokens: 1_000, estimated_cost: 0.025 + 0.015, // 0.04 -> total 0.22
  });

  // sess-c: last activity 2h ago -> outside the 10-minute live window, but
  // still inside the last 24h (present only indirectly, via any sparkline).
  seed(dir, encodeRecord, {
    ts: NOW - 120 * 60000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
    session_id: 'sess-c', project: 'tokenflow', repository: '/Users/x/work/tokenflow', git_branch: 'main',
    input_tokens: 5_000, output_tokens: 500, estimated_cost: 0.01 + 0.005,
  });

  // sess-d: one turn, a model with no configured price -> unpriced, most
  // recent of all four (sorts first).
  seed(dir, encodeRecord, {
    ts: NOW - 1 * 60000, source: 'anthropic', provider: 'anthropic', model: 'totally-unknown-model-xyz',
    session_id: 'sess-d', project: 'tokenflow', repository: '/Users/x/work/tokenflow', git_branch: 'feature/live',
    input_tokens: 1_000, output_tokens: 100, estimated_cost: null, cost_basis: null,
  });

  return NOW;
}

// ------------------------------------------------------------ liveSessions --

test('liveSessions: identity, sort order, per-session guard fields, and an old session excluded', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = seedScenario(dir, store.encodeRecord);
    const cfg = structuredClone(config.DEFAULT_CONFIG);
    const status = live.buildLiveStatus({ config: cfg, nowMs: NOW });

    const ls = status.liveSessions;
    assert.equal(ls.asOf, new Date(NOW).toISOString());
    assert.equal(ls.windowMinutes, 10);

    // sess-c (2h old) never appears; the rest sort by lastActivityAt desc:
    // sess-d (NOW-1m) > sess-a (NOW-2m) > sess-b (NOW-5m).
    assert.deepEqual(ls.sessions.map((s) => s.sessionId), ['sess-d', 'sess-a', 'sess-b']);

    const d = ls.sessions[0];
    assert.equal(d.source, 'anthropic');
    assert.equal(d.provider, 'anthropic');
    assert.equal(d.model, 'totally-unknown-model-xyz');
    assert.equal(d.project, 'tokenflow');
    assert.equal(d.repository, 'tokenflow', 'repository is basenamed, not a full path');
    assert.equal(d.branch, 'feature/live');
    assert.equal(d.turns, 1);
    assert.equal(d.subagentTurns, 0);
    assert.equal(d.costUsd, null, 'an unpriced turn must never invent a cost');
    assert.equal(d.coverage, 0);
    assert.equal(d.contextTokens, 1000);
    assert.equal(d.contextShare, null);
    assert.deepEqual(d.guard, { level: 'ok', reasons: [], declared: false });

    const a = ls.sessions[1];
    assert.equal(a.sessionId, 'sess-a');
    assert.equal(a.repository, 'tokenflow');
    assert.equal(a.branch, 'feature/live');
    assert.equal(a.startedAt, new Date(NOW - 40 * 60000).toISOString());
    assert.equal(a.lastActivityAt, new Date(NOW - 2 * 60000).toISOString());
    assert.equal(a.turns, 3);
    assert.equal(a.subagentTurns, 1, 'the middle turn was marked category:"subagent"');
    closeTo(a.costUsd, 0.51, 1e-9, 'sess-a total cost');
    assert.equal(a.coverage, 1);
    assert.equal(a.contextTokens, 20_000, 'last turn only: input + cache read + cache write');
    closeTo(a.contextShare, 0, 1e-9, 'no cache tokens anywhere in sess-a');

    const b = ls.sessions[2];
    assert.equal(b.sessionId, 'sess-b');
    assert.equal(b.repository, 'otherrepo');
    closeTo(b.costUsd, 0.22, 1e-9, 'sess-b total cost');
    assert.equal(b.contextTokens, 10_000, 'last turn had no cache tokens');
    closeTo(b.contextShare, 0.05 / 0.22, 1e-9, 'sess-b: 0.05 context / 0.22 total');

    // No guard caps declared anywhere -> every verdict is informational.
    assert.equal(status.guard.declared, false);
    assert.deepEqual(status.guard.policy, {
      warnCostUsd: null, maxCostUsd: null, warnContextTokens: null, maxContextTokens: null, warnMarginalUsd: null,
    });
    assert.ok(status.guard.lastVerdict, 'derived even with no caps, from the live sessions present');
    assert.equal(status.guard.lastVerdict.level, 'ok');
    assert.equal(status.guard.lastVerdict.source, 'derived');
    assert.equal(status.guard.lastVerdict.sessionId, 'sess-d');
  });
});

test('liveSessions: caps at 8 and keeps the 8 most recent', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = Date.now();
    writeState(dir, new Date(NOW).toISOString());
    for (let i = 0; i < 10; i++) {
      seed(dir, store.encodeRecord, {
        ts: NOW - i * 30_000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
        session_id: `sess-${i}`, project: 'p', repository: 'p',
        input_tokens: 1000, output_tokens: 100, estimated_cost: 0.001,
      });
    }
    const cfg = structuredClone(config.DEFAULT_CONFIG);
    const status = live.buildLiveStatus({ config: cfg, nowMs: NOW });
    assert.equal(status.liveSessions.sessions.length, 8);
    assert.deepEqual(
      status.liveSessions.sessions.map((s) => s.sessionId),
      Array.from({ length: 8 }, (_, i) => `sess-${i}`),
      'the 8 most recent, most recent first',
    );
  });
});

// ------------------------------------------------------------------ guard ---

test('guard: a session over a declared warn cap trips it, and the derived verdict names it', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = seedScenario(dir, store.encodeRecord);
    const cfg = structuredClone(config.DEFAULT_CONFIG);
    cfg.guard = { warnCostUsd: 0.3 }; // sess-a ($0.51) trips it; sess-b ($0.22) does not
    const status = live.buildLiveStatus({ config: cfg, nowMs: NOW });

    assert.equal(status.guard.declared, true);
    assert.equal(status.guard.policy.warnCostUsd, 0.3);
    assert.equal(status.guard.policy.maxCostUsd, null);

    const a = status.liveSessions.sessions.find((s) => s.sessionId === 'sess-a');
    const b = status.liveSessions.sessions.find((s) => s.sessionId === 'sess-b');
    assert.equal(a.guard.level, 'warn');
    assert.ok(a.guard.reasons.length > 0);
    assert.equal(a.guard.declared, true);
    assert.equal(b.guard.level, 'ok');

    assert.equal(status.guard.lastVerdict.level, 'warn');
    assert.equal(status.guard.lastVerdict.sessionId, 'sess-a');
    assert.equal(status.guard.lastVerdict.source, 'derived');
    assert.equal(status.guard.lastVerdict.at, a.lastActivityAt);
  });
});

test('guard: honors a cache file with a verdict; falls back to derived when the cache carries none', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = seedScenario(dir, store.encodeRecord);
    const cfg = structuredClone(config.DEFAULT_CONFIG);

    // Today's real `tokenflow guard` cache format (src/commands/guard.js):
    // {offset, state, records, updated} -- no `verdict` key at all.
    const guardDir = path.join(dir, 'guard');
    fs.mkdirSync(guardDir, { recursive: true });
    fs.writeFileSync(path.join(guardDir, 'plain.json'), JSON.stringify({
      offset: 100, state: {}, records: [{ session_id: 'sess-a' }], updated: new Date(NOW).toISOString(),
    }));
    let status = live.buildLiveStatus({ config: cfg, nowMs: NOW });
    assert.equal(status.guard.lastVerdict.source, 'derived', 'no verdict in the cache -> derive from live sessions');

    // A hypothetical future cache format that does carry one takes priority.
    fs.writeFileSync(path.join(guardDir, 'zz-newer.json'), JSON.stringify({
      offset: 200, state: {}, records: [], updated: new Date(NOW - 1000).toISOString(),
      verdict: { level: 'block', reasons: ['cap exceeded'], sessionId: 'cached-sess' },
    }));
    // Make sure it really is the most recently modified file.
    fs.utimesSync(path.join(guardDir, 'zz-newer.json'), new Date(), new Date());
    status = live.buildLiveStatus({ config: cfg, nowMs: NOW });
    assert.deepEqual(status.guard.lastVerdict, {
      level: 'block', sessionId: 'cached-sess', at: new Date(NOW - 1000).toISOString(), reasons: ['cap exceeded'], source: 'cache',
    });
  });
});

// ------------------------------------------------------------ receiptsToday -

test('receiptsToday: top 3 by cost among primary records dated today, repo basenamed', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = Date.now();
    writeState(dir, new Date(NOW).toISOString());
    const rows = [
      { repo: '/Users/x/work/repoA', branch: 'branch1', out: 100_000, sid: 'r1' }, // $1.00
      { repo: '/Users/x/work/repoA', branch: 'branch2', out: 50_000, sid: 'r2' },  // $0.50
      { repo: '/Users/x/work/repoB', branch: 'branch1', out: 30_000, sid: 'r3' },  // $0.30
      { repo: '/Users/x/work/repoB', branch: 'branch2', out: 10_000, sid: 'r4' },  // $0.10
      { repo: '/Users/x/work/repoC', branch: null, out: 5_000, sid: 'r5' },        // $0.05, unattributed
    ];
    for (const r of rows) {
      seed(dir, store.encodeRecord, {
        ts: NOW - 3 * 60000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
        session_id: r.sid, project: path.basename(r.repo), repository: r.repo, git_branch: r.branch,
        output_tokens: r.out, estimated_cost: (r.out * 10) / 1e6,
      });
    }
    const cfg = structuredClone(config.DEFAULT_CONFIG);
    const status = live.buildLiveStatus({ config: cfg, nowMs: NOW });

    const rt = status.receiptsToday;
    assert.equal(rt.asOf, new Date(NOW).toISOString());
    closeTo(rt.totalCostUsd, 1.0 + 0.5 + 0.3 + 0.1 + 0.05, 1e-9);
    assert.equal(rt.items.length, 3);
    assert.deepEqual(rt.items.map((i) => `${i.repo}/${i.branch}`), ['repoA/branch1', 'repoA/branch2', 'repoB/branch1']);
    closeTo(rt.items[0].costUsd, 1.0, 1e-9);
    assert.equal(rt.items[0].turns, 1);
    assert.equal(rt.items[0].sessions, 1);
    assert.ok(!rt.items.some((i) => i.repo.includes('/')), 'repo is a basename, never a path');
  });
});

// -------------------------------------------------------------- sparklines --

test('sparklines: 24 hourly buckets oldest-first, sums matching seeded totals across two sources, measured cost excluded', async () => {
  await withHome(async (dir, { live, store, config }) => {
    const NOW = Date.now();
    writeState(dir, new Date(NOW).toISOString());

    // anthropic: three estimated turns + one measured turn (tokens count,
    // cost does not) spread across the day; openai: two estimated turns.
    const anthropic = [
      { ts: NOW - 90 * 60000, input: 100_000 },   // 1.5h ago
      { ts: NOW - 10.5 * 3600000, input: 50_000 }, // 10.5h ago
      { ts: NOW - 22 * 3600000, input: 25_000 },  // 22h ago, safely inside the window
    ];
    for (const r of anthropic) {
      seed(dir, store.encodeRecord, {
        ts: r.ts, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
        session_id: `sp-${r.ts}`, input_tokens: r.input, estimated_cost: (r.input * 2) / 1e6,
      });
    }
    seed(dir, store.encodeRecord, { // measured: tokens count, cost must not
      ts: NOW - 5 * 3600000, source: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-5',
      session_id: 'sp-measured', input_tokens: 10_000, estimated_cost: 0.5, cost_basis: 'measured',
    });
    const openai = [
      { ts: NOW - 3 * 3600000, input: 40_000 },
      { ts: NOW - 15 * 3600000, input: 20_000 },
    ];
    for (const r of openai) {
      seed(dir, store.encodeRecord, {
        ts: r.ts, source: 'openai', provider: 'openai', model: 'gpt-5.6-sol',
        session_id: `sp-oai-${r.ts}`, input_tokens: r.input, estimated_cost: (r.input * 2.5) / 1e6,
      });
    }

    const cfg = structuredClone(config.DEFAULT_CONFIG);
    const status = live.buildLiveStatus({ config: cfg, nowMs: NOW });
    const sp = status.sparklines;

    assert.equal(sp.hours.length, 24);
    for (let i = 1; i < 24; i++) assert.ok(Date.parse(sp.hours[i]) > Date.parse(sp.hours[i - 1]), 'oldest first, strictly increasing');
    for (const h of sp.hours) assert.ok(!Number.isNaN(Date.parse(h)));

    assert.equal(sp.bySource.anthropic.length, 24);
    assert.equal(sp.bySource.openai.length, 24);
    closeTo(sp.bySource.anthropic.reduce((a, b) => a + b, 0), 100_000 + 50_000 + 25_000 + 10_000, 1e-6);
    closeTo(sp.bySource.openai.reduce((a, b) => a + b, 0), 40_000 + 20_000, 1e-6);

    closeTo(sp.costBySource.anthropic.reduce((a, b) => a + b, 0), 0.2 + 0.1 + 0.05, 1e-6, 'measured turn excluded from estimated cost');
    closeTo(sp.costBySource.openai.reduce((a, b) => a + b, 0), 0.1 + 0.05, 1e-6);
  });
});

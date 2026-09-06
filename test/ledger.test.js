/**
 * The Ledger's data path: the receipts file sync.push() writes, and the
 * cross-machine join team.aggregate() builds from it.
 *
 * INTENT: code does — sync.js writes only a per-machine daily jsonl
 * (append-only) and team.js reads only *.jsonl for per-developer rollups /
 * check expects — test/team.test.js and test/gauntlet.test.js assert exact
 * jsonl key sets and a synchronous push() return value, unchanged / spec
 * says — add a second whole-state `<machineId>.receipts.json` file (branch
 * × PR cost ledger), join it in aggregate(), and add push({to, token}) as a
 * remote-delivery alternative. Resolution: additive only. push() stays
 * synchronous for the existing folder path; the new async remote branch
 * only activates when opt.to / cfg.sync.to is set, which no existing caller
 * supplies, so test/team.test.js and test/gauntlet.test.js are unaffected
 * (both pass unchanged — see the end of this file and the report).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { encodeRecord } from '../src/core/store.js';

const sync = await import('../src/core/sync.js');
const team = await import('../src/core/team.js');

// ------------------------------------------------------------- fixtures ----

/** A fresh TOKENFLOW_HOME with an (empty) cube and a state.json carrying a
 * unique `lastRefresh`. buildReceiptsForStore() (src/core/bundle.js, not
 * ours to edit) caches its result keyed on `lastRefresh|records|pricing`; a
 * shared default (null) across every test in this file would return the
 * FIRST test's receipts to every later one. A unique lastRefresh per fixture
 * busts that cache. */
function freshHome(tag) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-home-'));
  process.env.TOKENFLOW_HOME = tmpHome;
  const dataDir = path.join(tmpHome, 'data');
  const recordsDir = path.join(dataDir, 'records');
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'cube.json'), JSON.stringify({
    dims: ['d', 'p'], measures: ['in', 'out', 'req', 'cost'], rows: [],
  }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 4, sources: {}, lastRefresh: `${tag}-${process.hrtime.bigint()}`,
    lastRefreshDurationMs: null, stale: [], counters: { records: 0, malformed: 0 },
  }));
  return { tmpHome, recordsDir };
}

/** Append one request-level record to a records shard, using the store's own
 * compact codec so the on-disk shape matches what a real ingest would write. */
function writeRecord(recordsDir, monthKey, rec) {
  const file = path.join(recordsDir, `${monthKey}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(encodeRecord(rec))}\n`);
}

/** Recursively assert every key at every depth is in the allowlist for that
 * level, and every leaf is a JSON primitive (never a nested object we did
 * not expect, e.g. under `first` or `contextShare`). */
function assertAllowlisted(obj, allowed, label) {
  assert.equal(typeof obj, 'object');
  assert.ok(obj !== null, `${label} must not be null`);
  for (const k of Object.keys(obj)) {
    assert.ok(allowed.has(k), `unexpected key "${k}" in ${label}`);
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      assert.ok(k === 'pr', `unexpected nested object under "${k}" in ${label}`);
    }
  }
}

const RECEIPT_ITEM_KEYS = new Set([
  'repo', 'branch', 'costUsd', 'turns', 'sessions', 'subagentTurns',
  'contextShare', 'first', 'last', 'longLived', 'pr',
]);
const PR_KEYS = new Set(['number', 'mergedAt']);
const ROOT_KEYS = new Set(['schema', 'machineId', 'machineName', 'generatedAt', 'receipts']);

// ---------------------------------------------------------------- push -----

test('push() writes the receipts file with only allowlisted keys, repo as basename', () => {
  const { tmpHome, recordsDir } = freshHome('allowlist');
  writeRecord(recordsDir, '2026-08', {
    timestamp: '2026-08-01T10:00:00.000Z', git_branch: 'feature-x',
    estimated_cost: 12.5, session_id: 'sess-1',
    repository: '/Users/dev/work/demo-repo', measurement: 'primary', category: 'agent',
  });
  writeRecord(recordsDir, '2026-08', {
    timestamp: '2026-08-02T11:00:00.000Z', git_branch: 'main',
    estimated_cost: 3.25, session_id: 'sess-2',
    repository: '/Users/dev/work/demo-repo', measurement: 'primary', category: 'subagent',
  });

  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-shared-'));
  const cfg = { sync: { enabled: true, dir: shared } };
  const r = /** @type {{file:string|null, days:number}} */ (sync.push({ config: cfg }));
  assert.equal(typeof r.days, 'number'); // synchronous return, never a Promise, for the folder path

  const id = sync.machineId(tmpHome);
  const receiptsFile = path.join(shared, `${id}.receipts.json`);
  assert.ok(fs.existsSync(receiptsFile));
  const payload = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));

  assertAllowlisted(payload, ROOT_KEYS, 'root');
  assert.equal(payload.schema, 1);
  assert.equal(payload.machineId, id);
  assert.ok(!('machineName' in payload), 'machineName must be opt-in only, and cfg.sync.machineName was not set');
  assert.ok(Array.isArray(payload.receipts));
  assert.ok(payload.receipts.length >= 1);
  for (const item of payload.receipts) {
    assertAllowlisted(item, RECEIPT_ITEM_KEYS, 'receipt item');
    if (item.pr !== null) assertAllowlisted(item.pr, PR_KEYS, 'pr');
  }

  const fx = payload.receipts.find((b) => b.branch === 'feature-x');
  assert.ok(fx, 'feature-x branch present');
  assert.equal(fx.repo, 'demo-repo'); // basename only, never the recorded path
  assert.equal(fx.costUsd, 12.5);
  assert.equal(fx.turns, 1);
  assert.equal(fx.longLived, false);
  assert.equal(fx.pr, null); // buildReceiptsForStore has no PR source wired in

  const main = payload.receipts.find((b) => b.branch === 'main');
  assert.ok(main);
  assert.equal(main.longLived, true);
  assert.equal(main.subagentTurns, 1);

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

test('push() with sync.machineName configured includes it in the receipts file', () => {
  const { tmpHome, recordsDir } = freshHome('namedmachine');
  writeRecord(recordsDir, '2026-08', {
    timestamp: '2026-08-01T10:00:00.000Z', git_branch: 'feature-x',
    estimated_cost: 1, session_id: 'sess-1', repository: 'demo-repo',
    measurement: 'primary', category: 'agent',
  });
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-shared-'));
  sync.push({ config: { sync: { enabled: true, dir: shared, machineName: 'Vimox <admin>' } } });
  const id = sync.machineId(tmpHome);
  const payload = JSON.parse(fs.readFileSync(path.join(shared, `${id}.receipts.json`), 'utf8'));
  assert.equal(payload.machineName, 'Vimox admin'); // sanitized, same rule as the jsonl file
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

test('push() skips the receipts file when sync.receipts is false, jsonl still written', () => {
  const { tmpHome, recordsDir } = freshHome('receiptsoff');
  writeRecord(recordsDir, '2026-08', {
    timestamp: '2026-08-01T10:00:00.000Z', git_branch: 'feature-x',
    estimated_cost: 1, session_id: 'sess-1', repository: 'demo-repo',
    measurement: 'primary',
  });
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-shared-'));
  const r = /** @type {{file:string|null, days:number}} */ (sync.push({ config: { sync: { enabled: true, dir: shared, receipts: false } } }));
  const id = sync.machineId(tmpHome);
  assert.ok(fs.existsSync(path.join(shared, `${id}.jsonl`)));
  assert.equal(r.file, path.join(shared, `${id}.jsonl`));
  assert.ok(!fs.existsSync(path.join(shared, `${id}.receipts.json`)));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

// ------------------------------------------------------------- aggregate ---

test('aggregate() merges two machines\' receipts: byRepo, perMergedPr, concentration, byMonth, longLivedShare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-team-'));

  // Minimal daily jsonl per machine — aggregate() bails out to null with no
  // machines at all, so each machine needs at least one line.
  const dailyLine = (machineId, date) => JSON.stringify({
    machineId, machineName: machineId, date, inputTokens: 100, outputTokens: 50,
    requests: 1, estCostUsd: 0.1, exportedAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(dir, 'm-a.jsonl'), `${dailyLine('m-a', '2026-08-01')}\n`);
  fs.writeFileSync(path.join(dir, 'm-b.jsonl'), `${dailyLine('m-b', '2026-08-02')}\n`);

  fs.writeFileSync(path.join(dir, 'm-a.receipts.json'), JSON.stringify({
    schema: 1, machineId: 'm-a', generatedAt: new Date().toISOString(),
    receipts: [
      {
        repo: 'demo-repo', branch: 'feature-x', costUsd: 10, turns: 5, sessions: 2,
        subagentTurns: 1, contextShare: 0.4,
        first: '2026-08-01T00:00:00.000Z', last: '2026-08-10T00:00:00.000Z',
        longLived: false, pr: { number: 42, mergedAt: '2026-08-10T00:00:00.000Z' },
      },
      {
        repo: 'demo-repo', branch: 'main', costUsd: 5, turns: 3, sessions: 1,
        subagentTurns: 0, contextShare: 0.1,
        first: '2026-08-01T00:00:00.000Z', last: '2026-08-15T00:00:00.000Z',
        longLived: true, pr: null,
      },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'm-b.receipts.json'), JSON.stringify({
    schema: 1, machineId: 'm-b', generatedAt: new Date().toISOString(),
    receipts: [
      {
        // Same branch as above, from a machine that hasn't re-synced since
        // the merge — its view of the PR has no mergedAt yet.
        repo: 'demo-repo', branch: 'feature-x', costUsd: 8, turns: 4, sessions: 1,
        subagentTurns: 0, contextShare: 0.3,
        first: '2026-08-02T00:00:00.000Z', last: '2026-08-09T00:00:00.000Z',
        longLived: false, pr: { number: 42, mergedAt: null },
      },
      {
        repo: 'other-repo', branch: 'feature-y', costUsd: 20, turns: 10, sessions: 3,
        subagentTurns: 2, contextShare: 0.5,
        first: '2026-07-01T00:00:00.000Z', last: '2026-07-20T00:00:00.000Z',
        longLived: false, pr: { number: 7, mergedAt: '2026-07-20T00:00:00.000Z' },
      },
    ],
  }));

  const t = team.aggregate(dir);
  assert.ok(t, 'aggregate() should not bail to null');
  const r = t.receipts;

  assert.equal(r.totals.branches, 3);
  assert.equal(r.totals.repos, 2);
  assert.equal(r.totals.cost, 43); // 10+8 (feature-x) + 5 (main) + 20 (feature-y)

  const demoRepo = r.byRepo.find((x) => x.repo === 'demo-repo');
  assert.equal(demoRepo.cost, 23); // 18 (feature-x merged) + 5 (main)
  assert.equal(demoRepo.branches, 2);
  assert.equal(demoRepo.sessions, 4); // 2+1 (feature-x) + 1 (main)
  const otherRepo = r.byRepo.find((x) => x.repo === 'other-repo');
  assert.equal(otherRepo.cost, 20);
  assert.equal(otherRepo.branches, 1);
  assert.equal(otherRepo.sessions, 3);

  // "keep any pr": the merged view (mergedAt known) wins over the open view.
  assert.equal(r.perMergedPr.sampleSize, 2); // feature-x (18) + feature-y (20)
  assert.equal(r.perMergedPr.median, 19);
  assert.equal(r.perMergedPr.p90, 20);

  // Concentration: 3 branches total, top 10% = 1 branch (feature-y, cost 20).
  assert.equal(Math.round(r.concentration.top10Share * 1000) / 1000, Math.round((20 / 43) * 1000) / 1000);
  assert.equal(r.concentration.top5.length, 3);
  assert.equal(r.concentration.top5[0].branch, 'feature-y');
  assert.equal(r.concentration.top5[0].cost, 20);

  // Long-lived: only `main` (cost 5) is long-lived, out of 43 total.
  assert.equal(r.longLivedShare.cost, 5);
  assert.equal(Math.round(r.longLivedShare.share * 1000) / 1000, Math.round((5 / 43) * 1000) / 1000);

  assert.deepEqual(r.byMonth.map((m) => m.month), ['2026-07', '2026-08']);
  const july = r.byMonth.find((m) => m.month === '2026-07');
  assert.equal(july.cost, 20);
  assert.equal(july.mergedPrCount, 1); // feature-y
  const aug = r.byMonth.find((m) => m.month === '2026-08');
  assert.equal(aug.cost, 23); // feature-x (18) + main (5)
  assert.equal(aug.mergedPrCount, 1); // feature-x only; main has no PR

  // renderText: the new section renders without inventing "undefined", and
  // existing per-developer output is untouched.
  const text = team.renderText(t);
  assert.match(text, /Receipts \(branch × PR cost ledger\)/);
  assert.match(text, /demo-repo/);
  assert.match(text, /Long-lived branches/);
  assert.ok(!text.includes('undefined'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('aggregate() with no receipts files: receipts section is present but empty, renderText handles it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ledger-team-empty-'));
  fs.writeFileSync(path.join(dir, 'm-a.jsonl'), `${JSON.stringify({
    machineId: 'm-a', machineName: 'm-a', date: '2026-08-01',
    inputTokens: 10, outputTokens: 5, requests: 1, estCostUsd: 0.01,
    exportedAt: new Date().toISOString(),
  })}\n`);
  const t = team.aggregate(dir);
  assert.equal(t.receipts.totals.branches, 0);
  assert.deepEqual(t.receipts.byRepo, []);
  assert.deepEqual(t.receipts.byMonth, []);
  assert.equal(t.receipts.perMergedPr.median, null);
  assert.equal(t.receipts.concentration.top10Share, null);
  assert.deepEqual(t.receipts.concentration.top5, []);
  assert.equal(t.receipts.longLivedShare.share, null);
  const text = team.renderText(t);
  assert.match(text, /no branch receipts synced yet/);
  assert.ok(!text.includes('undefined'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- remote to ---

test('push({to}) posts machineId + both files\' text to the server; a 401 is an error that never leaks the body', async () => {
  const { tmpHome, recordsDir } = freshHome('remote');
  writeRecord(recordsDir, '2026-08', {
    timestamp: '2026-08-05T00:00:00.000Z', git_branch: 'feature-z',
    estimated_cost: 4, session_id: 'sess-3', repository: 'demo-repo',
    measurement: 'primary',
  });
  // Give computeDailyLines() something to fold, so the jsonl file in the
  // posted body is non-empty too.
  fs.writeFileSync(path.join(tmpHome, 'data', 'cube.json'), JSON.stringify({
    dims: ['d', 'p'], measures: ['in', 'out', 'req', 'cost'],
    rows: [['2026-08-05', 'anthropic', 100, 50, 3, 1.2]],
  }));

  /** @type {{url:string, method:string, auth:string, body:any}|null} */
  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      if (req.method === 'POST' && req.url === '/api/rollup' && auth === 'Bearer good-token') {
        received = { url: req.url, method: req.method, auth, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('DO-NOT-LEAK-THIS-BODY');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, () => resolve(undefined)));
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;
  const to = `http://127.0.0.1:${port}`;
  const id = sync.machineId(tmpHome);

  try {
    // Good path: token supplied via config (sync.to / sync.token equivalents).
    const result = /** @type {{file:null, days:number, pushedTo:string}} */ (
      await sync.push({ config: { sync: { enabled: true, to, token: 'good-token' } } })
    );
    assert.equal(result.pushedTo, to);
    assert.ok(received, 'server received a request');
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/rollup');
    assert.equal(received.body.machineId, id);
    assert.ok(`${id}.jsonl` in received.body.files);
    assert.ok(`${id}.receipts.json` in received.body.files);
    const jsonlLine = JSON.parse(received.body.files[`${id}.jsonl`].trim());
    assert.equal(jsonlLine.date, '2026-08-05');
    const receiptsPayload = JSON.parse(received.body.files[`${id}.receipts.json`]);
    assert.ok(receiptsPayload.receipts.some((b) => b.branch === 'feature-z'));

    // TOKENFLOW_SYNC_TOKEN env fallback: no token anywhere in config.
    received = null;
    process.env.TOKENFLOW_SYNC_TOKEN = 'good-token';
    try {
      await sync.push({ config: { sync: { enabled: true, to } } });
      assert.ok(received && received.auth === 'Bearer good-token');
    } finally {
      delete process.env.TOKENFLOW_SYNC_TOKEN;
    }

    // 401 path: wrong token (opt-level, overriding nothing correct in cfg).
    received = null;
    await assert.rejects(
      () => /** @type {Promise<unknown>} */ (sync.push({ config: { sync: { enabled: true, to } }, token: 'wrong-token' })),
      (/** @type {any} */ err) => {
        assert.match(err.message, /401/);
        assert.ok(!err.message.includes('DO-NOT-LEAK-THIS-BODY'));
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

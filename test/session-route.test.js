/**
 * GET /api/session — the only route that hands request-level records to a tab.
 *
 * Each case stands for a way it could go wrong in a way nobody would notice:
 * a session whose records live in a month the range calculation skipped, a
 * source with no session id of its own, an overlay record double-counted into
 * a per-turn chart, an unbounded response, or a metadata field that quietly
 * carries a user's prompt into the browser.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before anything that resolves the store is imported: paths() reads
// TOKENFLOW_HOME at call time and a test must never touch a real store.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-session-home-'));
process.env.TOKENFLOW_HOME = HOME;

const { CUBE_VERSION } = await import('../src/core/store.js');
const { RECORD_CAP } = await import('../src/server/routes/session.js');
const { startServer } = await import('../src/server/server.js');

/** One encoded record, in the store's on-disk short-key codec. */
function row(over = {}) {
  return {
    ts: '2026-08-14T10:00:00.000Z',
    d: '2026-08-14',
    h: 10,
    w: 4,
    p: 'anthropic',
    pl: 'Anthropic',
    m: 'claude-opus-4-1-20250805',
    mf: 'Claude Opus 4.1',
    c: 'claude-code',
    ap: 'Claude Code',
    i: 'CLI',
    in: 100,
    ou: 200,
    cr: 300,
    cw: 400,
    tt: 1000,
    s: 'sess-a',
    rq: 'req-1',
    pj: 'billing-service',
    rp: 'billing-service',
    br: 'main',
    k: 'main',
    so: 'mock',
    ms: 'primary',
    x: { cwd: '/Users/demo/src/billing-service', title: 'SECRET USER PROMPT' },
    id: 'rec-1',
    f: 'file-1',
    gn: 1,
    ...over,
  };
}

/** One session row, in the shape Store#upsertSession writes. */
function session(over = {}) {
  return {
    id: 'sess-a',
    so: 'mock',
    p: 'anthropic',
    m: 'claude-opus-4-1-20250805',
    mf: 'Claude Opus 4.1',
    c: 'claude-code',
    i: 'CLI',
    g: 'direct',
    pj: 'billing-service',
    rp: 'billing-service',
    br: 'main',
    st: 'unspecified',
    ms: 'primary',
    start: '2026-08-14T10:00:00.000Z',
    end: '2026-08-14T11:00:00.000Z',
    d: '2026-08-14',
    h: 10,
    w: 4,
    req: 3,
    in: 300, out: 600, cr: 900, cw: 1200, cf: 0, rs: 0, cost: 1,
    models: { 'claude-opus-4-1-20250805': 3 },
    ...over,
  };
}

function writeStore({ sessions, shards }) {
  fs.mkdirSync(path.join(HOME, 'data', 'records'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'state.json'), JSON.stringify({
    version: CUBE_VERSION, sources: {}, lastRefresh: null, stale: [], counters: { records: 0, malformed: 0 },
  }));
  fs.writeFileSync(path.join(HOME, 'data', 'sessions.json'), JSON.stringify({
    version: CUBE_VERSION,
    rows: Object.fromEntries(sessions.map((s) => [s.id, s])),
  }));
  for (const [month, rows] of Object.entries(shards)) {
    fs.writeFileSync(
      path.join(HOME, 'data', 'records', `${month}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
}

let server = null;
let base = '';

before(async () => {
  writeStore({
    sessions: [
      // Starts on the 1st in local time; its first record's UTC timestamp is
      // still in July, which is exactly the case the ±1 day widening covers.
      session({ id: 'sess-a', start: '2026-08-01T00:30:00.000Z', end: '2026-08-01T02:00:00.000Z', d: '2026-08-01', req: 4 }),
      // A source with no session id of its own: Store#upsertSession files it
      // under source:date:project, and the route must match the same way.
      session({ id: 'mock:2026-08-14:billing-service', req: 1 }),
      session({ id: 'sess-big', d: '2026-09-01', start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T09:00:00.000Z', req: RECORD_CAP + 1 }),
      // No adapter writes these keys yet. The route carries them so the fan-out
      // becomes a real tree the day one does, and this session is the proof.
      session({ id: 'sess-linked', d: '2026-08-20', start: '2026-08-20T10:00:00.000Z', end: '2026-08-20T10:30:00.000Z', req: 3 }),
    ],
    shards: {
      '2026-07': [
        row({ s: 'sess-a', d: '2026-07-31', ts: '2026-07-31T23:30:00.000Z', rq: 'req-first', id: 'rec-first' }),
      ],
      '2026-08': [
        // Deliberately out of timestamp order on disk.
        row({ s: 'sess-a', d: '2026-08-01', ts: '2026-08-01T02:00:00.000Z', rq: 'req-late', id: 'rec-late', k: 'subagent' }),
        row({ s: 'sess-a', d: '2026-08-01', ts: '2026-08-01T00:30:00.000Z', rq: 'req-early', id: 'rec-early' }),
        // Same session, but an overlay view of traffic already counted.
        row({ s: 'sess-a', d: '2026-08-01', ts: '2026-08-01T01:00:00.000Z', ms: 'overlay', rq: 'req-overlay', id: 'rec-overlay' }),
        // Another session entirely.
        row({ s: 'sess-other', d: '2026-08-01', ts: '2026-08-01T01:15:00.000Z', rq: 'req-other', id: 'rec-other' }),
        // No session id: filed under the synthetic key.
        row({ s: undefined, d: '2026-08-14', ts: '2026-08-14T10:00:00.000Z', rq: 'req-synthetic', id: 'rec-synthetic' }),
        // The agent / parent link pair, in both spellings, plus a row with
        // neither, all carrying metadata that must not come back.
        row({
          s: 'sess-linked', d: '2026-08-20', ts: '2026-08-20T10:00:00.000Z', rq: 'req-root', id: 'rec-root',
          x: { cwd: '/Users/demo/secret-repo', title: 'SECRET USER PROMPT' },
        }),
        row({
          s: 'sess-linked', d: '2026-08-20', ts: '2026-08-20T10:10:00.000Z', rq: 'req-child', id: 'rec-child', k: 'subagent',
          x: { agent: 'reviewer', parent_id: 'req-root', cwd: '/Users/demo/secret-repo' },
        }),
        row({
          s: 'sess-linked', d: '2026-08-20', ts: '2026-08-20T10:20:00.000Z', rq: 'req-grandchild', id: 'rec-grandchild', k: 'subagent',
          x: { agent_role: 'luna_worker', parent_session_id: 'req-child', title: 'SECRET USER PROMPT' },
        }),
      ],
      '2026-09': Array.from({ length: RECORD_CAP + 1 }, (_, i) => row({
        s: 'sess-big',
        d: '2026-09-01',
        ts: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(4, '0').slice(-3)}Z`,
        rq: `req-big-${i}`,
        id: `rec-big-${i}`,
        x: undefined,
      })),
    },
  });
  server = await startServer({ port: 0, token: false });
  base = server.url;
});

after(async () => {
  if (server) await server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('the route is registered and answers on /api/session', async () => {
  const { ROUTES } = await import('../src/server/routes/index.js');
  const mine = ROUTES.filter((r) => r.path === '/api/session');
  assert.equal(mine.length, 1, 'exactly one /api/session route');
  assert.equal(mine[0].method, 'GET');
});

test('a missing id is a 400, an unknown id is a 404', async () => {
  const noId = await fetch(`${base}/api/session`);
  assert.equal(noId.status, 400);
  assert.match((await noId.json()).error, /id is required/);

  const unknown = await fetch(`${base}/api/session?id=does-not-exist`);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /no session/);
});

test('returns the session\'s primary records in timestamp order, across a month boundary', async () => {
  const res = await fetch(`${base}/api/session?id=sess-a`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.records.map((r) => r.request_id), ['req-first', 'req-early', 'req-late']);
  assert.ok(body.months.includes('2026-07'), 'the widened range reaches back a day into July');
  assert.ok(body.months.includes('2026-08'));
  assert.equal(body.total, 3);
  assert.equal(body.returned, 3);
  assert.equal(body.truncated, false);
  assert.equal(body.cap, RECORD_CAP, 'the cap is stated in the response');
  assert.equal(body.session.project, 'billing-service');
  assert.equal(body.session.branch, 'main');
  assert.equal(body.records[2].category, 'subagent');
});

test('an overlay record never reaches a per-turn view, and neither does another session', async () => {
  const body = await (await fetch(`${base}/api/session?id=sess-a`)).json();
  const ids = body.records.map((r) => r.request_id);
  assert.ok(!ids.includes('req-overlay'), 'overlay records are a second view of counted traffic');
  assert.ok(!ids.includes('req-other'), 'another session must not leak in');
});

test('a session with no session id of its own is found under its synthetic key', async () => {
  const body = await (await fetch(`${base}/api/session?id=mock:2026-08-14:billing-service`)).json();
  assert.equal(body.total, 1);
  assert.equal(body.records[0].request_id, 'req-synthetic');
});

test('the projection is an allow-list: no metadata, no prompt content', async () => {
  const raw = await (await fetch(`${base}/api/session?id=sess-a`)).text();
  assert.ok(!raw.includes('SECRET USER PROMPT'), 'a metadata title must never be served');
  assert.ok(!raw.includes('/Users/demo/src'), 'a working directory must never be served');

  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body.records[0]).sort(), [
    'agent', 'cache_read_tokens', 'cache_refresh_tokens', 'cache_write_tokens',
    'category', 'input_tokens', 'model', 'output_tokens', 'parent', 'provider',
    'reasoning_tokens', 'request_id', 'service_tier', 'source', 'ts',
  ]);
  // A field the source did not report stays not-available, never zero.
  assert.equal(body.records[0].cache_refresh_tokens, null);
  assert.equal(body.records[0].reasoning_tokens, null);
  assert.equal(body.records[0].input_tokens, 100);
});

test('the agent and parent link are lifted out of metadata, and nothing else is', async () => {
  const raw = await (await fetch(`${base}/api/session?id=sess-linked`)).text();
  assert.ok(!raw.includes('SECRET USER PROMPT'), 'the rest of metadata stays on disk');
  assert.ok(!raw.includes('secret-repo'), 'the working directory stays on disk');

  const body = JSON.parse(raw);
  const [root, child, grandchild] = body.records;
  assert.equal(root.agent, null, 'a record with neither key reports not-available');
  assert.equal(root.parent, null);

  assert.equal(child.agent, 'reviewer', 'metadata.agent (OpenCode)');
  assert.equal(child.parent, 'req-root', 'metadata.parent_id (OpenCode)');

  assert.equal(grandchild.agent, 'luna_worker', 'metadata.agent_role (Codex)');
  assert.equal(grandchild.parent, 'req-child', 'metadata.parent_session_id (Hermes)');

  // The pair is what turns fanOut from grouping-by-position into a tree.
  const { fanOut, turnSeries } = await import('../src/analytics/anatomy.js');
  const f = fanOut(turnSeries(body.records, null));
  assert.equal(f.grouped, false, 'a link in the payload must reach the tree branch');
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].children[0].label, 'reviewer');
  assert.equal(f.roots[0].children[0].children[0].label, 'luna_worker');
});

test('the response is capped at 5,000 records and says that it was', async () => {
  const body = await (await fetch(`${base}/api/session?id=sess-big`)).json();
  assert.equal(body.total, RECORD_CAP + 1);
  assert.equal(body.returned, RECORD_CAP);
  assert.equal(body.cap, RECORD_CAP);
  assert.equal(body.truncated, true);
});

/**
 * `tokenflow team serve` — self-hosted team server tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const { startTeamServer } = await import('../src/commands/team-serve.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withServer(opt, fn) {
  const dir = opt.dir || tmpDir('tf-team-serve-');
  const s = await startTeamServer({ port: 0, host: '127.0.0.1', ...opt, dir });
  try {
    await fn(s, dir);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('team-serve: valid rollup is written and reflected by GET /api/team', async () => {
  await withServer({ token: 'shh-secret' }, async (s, dir) => {
    const machineId = 'm-abc12345';
    const jsonl = [
      JSON.stringify({ machineId, machineName: 'Test Box', date: '2026-09-01', inputTokens: 1000, outputTokens: 200, requests: 5, estCostUsd: 1.23 }),
    ].join('\n') + '\n';
    const receipts = JSON.stringify({ generatedAt: new Date().toISOString(), repos: [] });

    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh-secret' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.jsonl`]: jsonl, [`${machineId}.receipts.json`]: receipts } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.files.sort(), [`${machineId}.jsonl`, `${machineId}.receipts.json`].sort());

    // Written atomically into dir — no leftover temp files, real content present.
    assert.equal(fs.readFileSync(path.join(dir, `${machineId}.jsonl`), 'utf8'), jsonl);
    assert.equal(fs.readFileSync(path.join(dir, `${machineId}.receipts.json`), 'utf8'), receipts);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

    const teamRes = await fetch(`${s.url}/api/team`, { headers: { authorization: 'Bearer shh-secret' } });
    assert.equal(teamRes.headers.get('cache-control'), 'no-store');
    const team = await teamRes.json();
    assert.ok(team, 'aggregate() found the machine we just wrote');
    assert.equal(team.totals.activeMachines, 1);

    const healthRes = await fetch(`${s.url}/health`, { headers: { authorization: 'Bearer shh-secret' } });
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.machines, 1);
    assert.ok(health.updatedAt);
  });
});

test('team-serve: POST with wrong token is 401', async () => {
  await withServer({ token: 'right-token' }, async (s) => {
    const machineId = 'm-abc12345';
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.jsonl`]: '' } }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('team-serve: POST with no Authorization header when a token is configured is 401', async () => {
  await withServer({ token: 'right-token' }, async (s) => {
    const machineId = 'm-abc12345';
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.jsonl`]: '' } }),
    });
    assert.equal(res.status, 401);
  });
});

test('team-serve: bad machineId is 400', async () => {
  await withServer({ token: 't' }, async (s) => {
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ machineId: 'short', files: { 'short.jsonl': '' } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /machineId/);
  });
});

test('team-serve: bad file name is 400', async () => {
  await withServer({ token: 't' }, async (s) => {
    const machineId = 'm-abc12345';
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ machineId, files: { 'not-the-right-name.jsonl': '' } }),
    });
    assert.equal(res.status, 400);
  });
});

test('team-serve: a JSONL line that is not valid JSON is 400', async () => {
  await withServer({ token: 't' }, async (s) => {
    const machineId = 'm-abc12345';
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.jsonl`]: 'not json\n' } }),
    });
    assert.equal(res.status, 400);
  });
});

test('team-serve: a malformed .receipts.json file is 400', async () => {
  await withServer({ token: 't' }, async (s) => {
    const machineId = 'm-abc12345';
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.receipts.json`]: 'not json' } }),
    });
    assert.equal(res.status, 400);
  });
});

test('team-serve: oversize body is 413', async () => {
  await withServer({ token: 't' }, async (s) => {
    const machineId = 'm-abc12345';
    const bigLine = JSON.stringify({ date: '2026-09-01', inputTokens: 1, pad: 'x'.repeat(9 * 1024 * 1024) });
    const res = await fetch(`${s.url}/api/rollup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ machineId, files: { [`${machineId}.jsonl`]: bigLine } }),
    });
    assert.equal(res.status, 413);
  });
});

test('team-serve: GET / returns HTML containing the token block marker', async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.ok(body.includes('@generated design-tokens:start'), 'HTML must inline the generated token block');
    assert.ok(body.includes('<pre>'), 'HTML must render the plain-text team view');
  });
});

test('team-serve: GET /api/team requires auth when a token is configured', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const anon = await fetch(`${s.url}/api/team`);
    assert.equal(anon.status, 401);
    const anonBody = await anon.json();
    assert.ok(anonBody.error);

    const authed = await fetch(`${s.url}/api/team`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(authed.status, 200);
  });
});

test('team-serve: GET /api/team is open when no token is configured (unchanged default behaviour)', async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${s.url}/api/team`);
    assert.equal(res.status, 200);
  });
});

test('team-serve: GET / without a token is a minimal "token required" page, no aggregate content', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /token is required/i);
    assert.ok(!body.includes('<pre>'), 'the unauthenticated page must not carry aggregate content');
  });
});

test('team-serve: /?token=<token> mints a tf_token cookie and redirects with the query stripped', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const res = await fetch(`${s.url}/?token=secret`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('tf_token=secret'), 'cookie must carry the token');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);

    // Honoured on the next request: the browser would resend the cookie automatically.
    const cookiePair = setCookie.split(';')[0];
    const next = await fetch(`${s.url}/`, { headers: { cookie: cookiePair } });
    assert.equal(next.status, 200);
    const body = await next.text();
    assert.ok(body.includes('<pre>'), 'the cookie must unlock the full aggregate view');
  });
});

test('team-serve: a wrong tf_token cookie is rejected', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const res = await fetch(`${s.url}/`, { headers: { cookie: 'tf_token=nope' } });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.ok(!body.includes('<pre>'));
  });
});

test('team-serve: /health shape depends on auth once a token is configured', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const anon = await fetch(`${s.url}/health`);
    assert.equal(anon.status, 200);
    const anonBody = await anon.json();
    assert.deepEqual(Object.keys(anonBody).sort(), ['ok']);
    assert.equal(anonBody.ok, true);

    const authed = await fetch(`${s.url}/health`, { headers: { authorization: 'Bearer secret' } });
    const authedBody = await authed.json();
    assert.deepEqual(Object.keys(authedBody).sort(), ['machines', 'ok', 'updatedAt']);
  });
});

test('team-serve: /health returns the full shape with no auth when no token is configured', async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${s.url}/health`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['machines', 'ok', 'updatedAt']);
  });
});

test('team-serve: starting on 0.0.0.0 without a token throws', async () => {
  const dir = tmpDir('tf-team-serve-nohost-');
  await assert.rejects(
    () => startTeamServer({ host: '0.0.0.0', port: 0, dir }),
    /token/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team-serve: dir defaults to <TOKENFLOW_HOME>/team', async () => {
  const home = tmpDir('tf-team-serve-home-');
  const prevHome = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = home;
  try {
    const { startTeamServer: freshStart } = await import(`../src/commands/team-serve.js?t=${Date.now()}${Math.random()}`);
    const s = await freshStart({ port: 0, host: '127.0.0.1' });
    try {
      assert.ok(fs.existsSync(path.join(home, 'team')));
    } finally {
      await s.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.TOKENFLOW_HOME;
    else process.env.TOKENFLOW_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ============================================================= /api/policy ==

test('team-serve: GET /api/policy serves the org policy.yaml as text/yaml once authorized', async () => {
  await withServer({ token: 'secret' }, async (s, dir) => {
    const yaml = 'guard:\n  maxCostUsd: 50\nreceipt:\n  maxCostUsd: 25\n';
    fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml);

    const anon = await fetch(`${s.url}/api/policy`);
    assert.equal(anon.status, 401);
    assert.ok((await anon.json()).error);

    const authed = await fetch(`${s.url}/api/policy`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(authed.status, 200);
    assert.match(authed.headers.get('content-type'), /text\/yaml/);
    assert.equal(authed.headers.get('cache-control'), 'no-store');
    assert.ok(authed.headers.get('etag'), 'an etag lets a client skip an unchanged pull');
    assert.equal(await authed.text(), yaml, 'the file is served verbatim, never re-serialized');
  });
});

test('team-serve: GET /api/policy is 404 JSON when the org has declared no policy', async () => {
  await withServer({ token: 'secret' }, async (s) => {
    const res = await fetch(`${s.url}/api/policy`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.ok((await res.json()).error);
  });
});

test('team-serve: GET /api/policy honours the tf_token cookie, and is open with no token configured', async () => {
  await withServer({ token: 'secret' }, async (s, dir) => {
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'receipt:\n  maxCostUsd: 5\n');
    const res = await fetch(`${s.url}/api/policy`, { headers: { cookie: 'tf_token=secret' } });
    assert.equal(res.status, 200);
  });
  await withServer({}, async (s, dir) => {
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'receipt:\n  maxCostUsd: 5\n');
    const res = await fetch(`${s.url}/api/policy`);
    assert.equal(res.status, 200);
  });
});

// ========================================================= GitHub App route ==

const GH_PORT = 7852;
const GH_SECRET = 'webhook-secret-for-tests';
const GH_SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const { privateKey: ghKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GH_PEM = ghKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The `X-Hub-Signature-256` GitHub would send for this body and secret. */
function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** A receipt.v0 object that passes validateReceiptV0(). */
function ghReceipt() {
  return {
    schemaVersion: 0,
    generatedAt: '2026-09-05T10:00:00.000Z',
    toolVersion: '1.3.0',
    repo: 'widgets',
    branch: 'feat/checkout',
    headSha: GH_SHA,
    window: { first: '2026-09-01T09:00:00.000Z', last: '2026-09-05T09:00:00.000Z' },
    costUsd: 8.25,
    contextShare: 0.5,
    turns: 12,
    sessions: 2,
    subagentTurns: 0,
    models: [{ model: 'claude-opus-5', costUsd: 8.25, share: 1 }],
    coverage: 1,
    largestPromptTokens: 90000,
    changedLines: 300,
    pr: { number: 3, mergedAt: null },
    longLived: false,
    costPer100Lines: 2.75,
    notes: ['Estimated locally by TokenFlow.'],
  };
}

/**
 * Just enough of the GitHub REST API for one pull_request delivery. Records
 * every request so the assertions read what actually left the server.
 */
async function startMockGitHub(opt = {}) {
  const calls = [];
  const order = opt.order || [];
  const gate = opt.gate || null;
  const notesCommit = 'e'.repeat(40);
  const notesTree = 'f'.repeat(40);
  let nextId = 500;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      calls.push({ method: req.method, path: url.pathname, body });
      // Recorded the instant the request ARRIVES, before anything is served,
      // so an ordering assertion sees when GitHub was first touched.
      order.push(`github:${url.pathname}`);
      if (gate) await gate.promise;
      const p = url.pathname;
      // `connection: close` keeps undici from pooling a socket to a server
      // the next test has already replaced on the same port.
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && p.endsWith('/access_tokens')) return send(201, { token: 'ghs_x', expires_at: null });
      if (p === '/repos/acme/widgets/git/ref/notes/tokenflow') return send(200, { object: { sha: notesCommit } });
      if (p === `/repos/acme/widgets/git/commits/${notesCommit}`) return send(200, { tree: { sha: notesTree } });
      if (p === `/repos/acme/widgets/git/trees/${notesTree}`) {
        return send(200, { tree: [{ path: `${GH_SHA.slice(0, 2)}/${GH_SHA.slice(2)}`, type: 'blob', sha: 'blob-1' }], truncated: false });
      }
      if (p === '/repos/acme/widgets/git/blobs/blob-1') {
        return send(200, { encoding: 'base64', content: Buffer.from(JSON.stringify(ghReceipt()), 'utf8').toString('base64') });
      }
      if (p === '/repos/acme/widgets/contents/.tokenflow/policy.yaml') return send(404, { message: 'Not Found' });
      if (req.method === 'GET' && p === '/repos/acme/widgets/issues/3/comments') return send(200, []);
      if (req.method === 'POST' && p === '/repos/acme/widgets/issues/3/comments') return send(201, { id: nextId++ });
      if (req.method === 'GET' && p.endsWith('/check-runs')) return send(200, { total_count: 0, check_runs: [] });
      if (req.method === 'POST' && p === '/repos/acme/widgets/check-runs') return send(201, { id: nextId++ });
      return send(404, { message: 'Not Found' });
    });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(GH_PORT, '127.0.0.1', () => resolve(undefined));
  });
  return {
    url: `http://127.0.0.1:${GH_PORT}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

const ghOptions = (over = {}) => ({
  githubAppId: '424242',
  githubPrivateKeyPem: GH_PEM,
  githubWebhookSecret: GH_SECRET,
  githubNotesRef: 'tokenflow',
  ...over,
});

const prDelivery = () => JSON.stringify({
  action: 'opened',
  number: 3,
  pull_request: { number: 3, head: { sha: GH_SHA } },
  repository: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
  installation: { id: 99 },
});

test('team-serve: GET /github/health says whether the App is configured, and carries no secret', async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${s.url}/github/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, appConfigured: false });
  });
  await withServer(ghOptions(), async (s) => {
    const res = await fetch(`${s.url}/github/health`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, appConfigured: true });
    assert.ok(!JSON.stringify(body).includes(GH_SECRET));
    assert.ok(!JSON.stringify(body).includes('PRIVATE KEY'));
  });
});

test('team-serve: POST /github/webhook is 404 while the App is not configured', async () => {
  await withServer({}, async (s) => {
    const body = prDelivery();
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-404',
        'x-hub-signature-256': sign(GH_SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 404);
  });
});

test('team-serve: POST /github/webhook is 401 for a missing, wrong-secret or tampered signature', async () => {
  await withServer(ghOptions(), async (s) => {
    const body = prDelivery();
    const post = (headers) => fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', ...headers },
      body,
    });

    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'x-hub-signature-256': sign('the-wrong-secret', body) })).status, 401);
    assert.equal((await post({ 'x-hub-signature-256': sign(GH_SECRET, `${body} `) })).status, 401);
    assert.equal((await post({ 'x-hub-signature-256': 'sha256=not-a-digest' })).status, 401);
  });
});

test('team-serve: POST /github/webhook is 202 and the delivery reaches the GitHub API', async () => {
  const gh = await startMockGitHub();
  const dir = tmpDir('tf-team-serve-gh-');
  const s = await startTeamServer({ port: 0, host: '127.0.0.1', dir, ...ghOptions({ githubApiUrl: gh.url }) });
  try {
    const body = prDelivery();
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-202',
        'x-hub-signature-256': sign(GH_SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 202);
    const ack = await res.json();
    assert.equal(ack.ok, true);
    assert.equal(ack.delivery, 'd-202');
  } finally {
    // close() drains the work started after the 202, so the assertions below
    // need no sleep and no polling.
    await s.close();
    await gh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const comment = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/widgets/issues/3/comments');
  assert.ok(comment, 'the receipt comment must have been posted');
  assert.ok(comment.body.body.startsWith('<!-- tokenflow-receipt -->'));

  const check = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/widgets/check-runs');
  assert.ok(check, 'the check run must have been published');
  assert.equal(check.body.name, 'TokenFlow spend');
  assert.equal(check.body.head_sha, GH_SHA);
  assert.equal(check.body.conclusion, 'success');
  assert.equal(check.body.status, 'completed');
});

test('team-serve: POST /github/webhook rejects a non-JSON content type and a body that is not JSON', async () => {
  await withServer(ghOptions(), async (s) => {
    const form = 'payload=%7B%7D';
    const wrongType = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(GH_SECRET, form),
      },
      body: form,
    });
    assert.equal(wrongType.status, 415);

    const notJson = 'this is not json';
    const bad = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(GH_SECRET, notJson),
      },
      body: notJson,
    });
    assert.equal(bad.status, 400);
  });
});

test('team-serve: POST /github/webhook needs no team bearer token, and an oversize delivery is 413', async () => {
  await withServer(ghOptions({ token: 'team-secret' }), async (s) => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'd-ping',
        'x-hub-signature-256': sign(GH_SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 202, 'GitHub cannot send the team token, so this route must not require it');

    const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
    const tooBig = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(GH_SECRET, big),
      },
      body: big,
    });
    assert.equal(tooBig.status, 413);
  });
});

test('team-serve: the App turns on from the TOKENFLOW_GH_* environment variables alone', async () => {
  const keyDir = tmpDir('tf-team-serve-key-');
  const keyFile = path.join(keyDir, 'app.pem');
  fs.writeFileSync(keyFile, GH_PEM);
  const prev = {
    TOKENFLOW_GH_APP_ID: process.env.TOKENFLOW_GH_APP_ID,
    TOKENFLOW_GH_PRIVATE_KEY_FILE: process.env.TOKENFLOW_GH_PRIVATE_KEY_FILE,
    TOKENFLOW_GH_WEBHOOK_SECRET: process.env.TOKENFLOW_GH_WEBHOOK_SECRET,
  };
  process.env.TOKENFLOW_GH_APP_ID = '777';
  process.env.TOKENFLOW_GH_PRIVATE_KEY_FILE = keyFile;
  process.env.TOKENFLOW_GH_WEBHOOK_SECRET = GH_SECRET;
  try {
    await withServer({}, async (s) => {
      assert.equal(s.githubConfigured, true);
      assert.deepEqual(await (await fetch(`${s.url}/github/health`)).json(), { ok: true, appConfigured: true });
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});

test('team-serve: two of the three App settings leaves the route off rather than half on', async () => {
  await withServer({ githubAppId: '1', githubWebhookSecret: GH_SECRET }, async (s) => {
    assert.equal(s.githubConfigured, false);
    const body = prDelivery();
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(GH_SECRET, body) },
      body,
    });
    assert.equal(res.status, 404);
  });
});

test('team-serve: a named but unreadable private key file fails at startup, not on the first delivery', async () => {
  const dir = tmpDir('tf-team-serve-badkey-');
  await assert.rejects(
    () => startTeamServer({
      port: 0, host: '127.0.0.1', dir,
      githubAppId: '1', githubWebhookSecret: 's', githubKeyFile: path.join(dir, 'missing.pem'),
    }),
    /private key/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team-serve: the 202 is written before the first GitHub call, and does not wait for it', async () => {
  const order = [];
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((r) => { gate.resolve = r; });

  const gh = await startMockGitHub({ order, gate });
  const dir = tmpDir('tf-team-serve-order-');
  const s = await startTeamServer({ port: 0, host: '127.0.0.1', dir, ...ghOptions({ githubApiUrl: gh.url }) });
  try {
    const body = prDelivery();
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-order',
        'x-hub-signature-256': sign(GH_SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 202);
    await res.json();
    order.push('202');

    // Every GitHub request is held open by the gate, so the 202 above cannot
    // have been waiting on any of them: the response is not merely present,
    // it is not blocked.
    assert.ok(order.includes('202'));
    assert.equal(order[0], '202', 'the 202 is written before the first GitHub call arrives');
  } finally {
    gate.resolve();
    await s.close();
    await gh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('team-serve: GET /api/policy answers 304 for a matching If-None-Match', async () => {
  await withServer({ token: 'secret' }, async (s, dir) => {
    const yaml = 'receipt:\n  maxCostUsd: 25\n';
    fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml);
    const auth = { authorization: 'Bearer secret' };

    const first = await fetch(`${s.url}/api/policy`, { headers: auth });
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.ok(etag);

    const again = await fetch(`${s.url}/api/policy`, { headers: { ...auth, 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(await again.text(), '', 'a 304 carries no body');

    const weak = await fetch(`${s.url}/api/policy`, { headers: { ...auth, 'if-none-match': `W/${etag}` } });
    assert.equal(weak.status, 304, 'a weak validator still matches');

    const list = await fetch(`${s.url}/api/policy`, { headers: { ...auth, 'if-none-match': `"other", ${etag}` } });
    assert.equal(list.status, 304, 'If-None-Match is a list');

    const stale = await fetch(`${s.url}/api/policy`, { headers: { ...auth, 'if-none-match': '"not-the-one"' } });
    assert.equal(stale.status, 200, 'a stale validator gets the file');
    assert.equal(await stale.text(), yaml);

    // The etag tracks the content, so an edit invalidates the client's copy.
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'receipt:\n  maxCostUsd: 30\n');
    const changed = await fetch(`${s.url}/api/policy`, { headers: { ...auth, 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
  });
});

test('team-serve: a webhook secret with surrounding whitespace still verifies', async () => {
  // Pasting a secret into a systemd unit or a Docker env file picks up a
  // trailing newline more often than not.
  await withServer(ghOptions({ githubWebhookSecret: `  ${GH_SECRET}\n` }), async (s) => {
    const body = JSON.stringify({ zen: 'Practicality beats purity.' });
    const res = await fetch(`${s.url}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'd-trim',
        'x-hub-signature-256': sign(GH_SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 202, 'the configured secret is trimmed before it is compared');
  });
});

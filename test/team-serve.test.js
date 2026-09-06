/**
 * `tokenflow team serve` — self-hosted team server tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * `tokenflow team check` — laptop-side diagnostic for a self-hosted team
 * server, plus a drift check tying deploy/ back to what
 * src/commands/team-serve.js actually reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { check, render, run } from '../src/commands/team-check.js';
import { parseYaml } from '../src/core/yaml.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/**
 * A fake `fetch` standing in for a `tokenflow team serve` instance.
 * `serverToken` null means the server has no token configured at all (every
 * route open); otherwise GET /health only returns the full shape once the
 * request's Authorization header carries exactly that token, and
 * GET /api/policy answers 401 when it does not.
 */
function fakeTeamServer({ serverToken = null, policyPresent = true } = {}) {
  const fn = async (reqUrl, opts = {}) => {
    const u = new URL(reqUrl);
    const headers = opts.headers || {};
    const authHeader = headers.authorization;
    const authed = !serverToken || authHeader === `Bearer ${serverToken}`;

    if (u.pathname === '/health') {
      const full = authed;
      const body = full ? { ok: true, machines: 2, updatedAt: '2026-09-01T00:00:00.000Z' } : { ok: true };
      return { status: 200, json: async () => body };
    }
    if (u.pathname === '/api/policy') {
      if (serverToken && !authed) return { status: 401, json: async () => ({ error: 'unauthorized' }) };
      if (policyPresent) return { status: 200, json: async () => { throw new SyntaxError('not json, this route serves text/yaml'); } };
      return { status: 404, json: async () => ({ error: 'no org policy configured' }) };
    }
    return { status: 404, json: async () => ({ error: 'not found' }) };
  };
  // check() only ever reads `.status` and awaits `.json()` off what fetchImpl
  // resolves to (see safeGet in src/commands/team-check.js), so this stand-in
  // never needs the rest of the real Response shape; cast past the mismatch.
  return /** @type {typeof fetch} */ (fn);
}

// ============================================================== check() ==

test('team-check: reachable, authenticated, policy present with the right token', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: 'right-token', policyPresent: true });
  const result = await check({ url: 'http://team.example:7790', token: 'right-token', config: { sync: {} }, fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.policy, true);
  assert.equal(result.openNoToken, false);
  assert.equal(result.machines, 2);
  assert.deepEqual(result.fixes, []);
});

test('team-check: a wrong token is rejected (401 on /api/policy) and reported as such', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: 'right-token' });
  const result = await check({ url: 'http://team.example:7790', token: 'wrong-token', config: { sync: {} }, fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.fixes.length, 1);
  assert.match(result.fixes[0], /rejected/i);
  assert.match(result.fixes[0], /TOKENFLOW_TEAM_TOKEN/);
});

test('team-check: no token on the laptop, but the server requires one, gives a different fix than a wrong token', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: 'right-token' });
  const result = await check({ url: 'http://team.example:7790', token: undefined, config: { sync: {} }, fetchImpl });
  assert.equal(result.authenticated, false);
  assert.match(result.fixes[0], /this laptop has none configured/i);
  assert.doesNotMatch(result.fixes[0], /rejected/i);
});

test('team-check: an unreachable host is reported with a fix, not a throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 127.0.0.1:9999'); };
  const result = await check({ url: 'http://nowhere.invalid:9999', token: 't', config: { sync: {} }, fetchImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.fixes.length, 1);
  assert.match(result.fixes[0], /could not reach/i);
});

test('team-check: policy absent (404) is still authenticated, just reports the policy as absent', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: 'right-token', policyPresent: false });
  const result = await check({ url: 'http://team.example:7790', token: 'right-token', config: { sync: {} }, fetchImpl });
  assert.equal(result.authenticated, true);
  assert.equal(result.policy, false);
  assert.deepEqual(result.fixes, []);
});

test('team-check: a server with no token configured is flagged as wide open (openNoToken)', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: null });
  const result = await check({ url: 'http://team.example:7790', token: undefined, config: { sync: {} }, fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.openNoToken, true);
  assert.ok(result.fixes.some((f) => /no token configured/i.test(f)));
});

test('team-check: a non-JSON /health response is reported, not thrown', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (async (reqUrl) => {
    const u = new URL(reqUrl);
    if (u.pathname === '/health') return { status: 200, json: async () => { throw new SyntaxError('not json'); } };
    return { status: 404, json: async () => ({ error: 'not found' }) };
  });
  const result = await check({ url: 'http://not-tokenflow.example:9999', token: 't', config: { sync: {} }, fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.authenticated, false);
  assert.match(result.fixes[0], /does not look like a tokenflow team serve endpoint/i);
});

test('team-check: with no server configured anywhere, no network call is made', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const result = await check({ config: { sync: {} }, fetchImpl });
  assert.equal(result.url, null);
  assert.equal(result.reachable, false);
  assert.match(result.fixes[0], /no team server is configured/i);
});

test('team-check: reads sync.to and sync.token from config when flags are absent', async () => {
  const fetchImpl = fakeTeamServer({ serverToken: 'from-config' });
  const config = { sync: { to: 'http://from-config.example:7790', token: 'from-config' } };
  const result = await check({ config, fetchImpl });
  assert.equal(result.url, 'http://from-config.example:7790');
  assert.equal(result.authenticated, true);
});

// =============================================================== render() ==

test('team-check render(): prints all four headline fields', () => {
  const result = {
    url: 'http://team.example:7790', tokenConfigured: true,
    reachable: true, authenticated: true, policy: true, version: null,
    machines: 5, updatedAt: '2026-09-01T00:00:00.000Z', openNoToken: false, fixes: [],
  };
  const text = render(result);
  assert.match(text, /reachable\s+true/);
  assert.match(text, /authenticated\s+true/);
  assert.match(text, /policy\s+present/);
  assert.match(text, /server version\s+unknown/);
});

test('team-check render(): an absent policy prints "absent", not "unknown"', () => {
  const result = {
    url: 'http://team.example:7790', tokenConfigured: true,
    reachable: true, authenticated: true, policy: false, version: '1.3.0',
    machines: null, updatedAt: null, openNoToken: false, fixes: [],
  };
  const text = render(result);
  assert.match(text, /policy\s+absent/);
  assert.match(text, /server version\s+1\.3\.0/);
});

// ================================================================= run() ==

test('team-check run(): exit code 0 and a report on stdout when everything checks out', async () => {
  const prevFetch = globalThis.fetch;
  const prevHome = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-check-home-'));
  process.env.TOKENFLOW_HOME = home;
  globalThis.fetch = fakeTeamServer({ serverToken: 'shared-secret' });
  try {
    const result = await run({ url: 'http://team.example:7790', token: 'shared-secret' });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /reachable\s+true/);
    assert.match(result.stdout, /authenticated\s+true/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('team-check run(): exit code 1 when the token is rejected', async () => {
  const prevFetch = globalThis.fetch;
  const prevHome = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-check-home-'));
  process.env.TOKENFLOW_HOME = home;
  globalThis.fetch = fakeTeamServer({ serverToken: 'shared-secret' });
  try {
    const result = await run({ url: 'http://team.example:7790', token: 'wrong' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /fix:.*rejected/is);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ================================================ against a real server ==

test('team-check: end to end against a real tokenflow team serve on 7857', async () => {
  const { startTeamServer } = await import('../src/commands/team-serve.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-check-real-'));
  const s = await startTeamServer({ host: '127.0.0.1', port: 7857, dir, token: 'real-secret' });
  try {
    // config: { sync: {} } so check() never falls back to loadConfig() and
    // touches the real ~/.tokenflow on whatever machine runs this suite.
    const ok = await check({ url: s.url, token: 'real-secret', config: { sync: {} } });
    assert.equal(ok.reachable, true);
    assert.equal(ok.authenticated, true);
    assert.equal(ok.policy, false, 'no policy.yaml written in this fixture dir');

    const bad = await check({ url: s.url, token: 'nope', config: { sync: {} } });
    assert.equal(bad.reachable, true);
    assert.equal(bad.authenticated, false);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ======================================================= deploy/ drift ==

/** Every `process.env.TOKENFLOW_*` name team-serve.js actually reads. */
function envNamesFromTeamServe() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'team-serve.js'), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/process\.env\.(TOKENFLOW_[A-Z_]+)/g)) names.add(m[1]);
  return names;
}

/** Names declared (even if left blank) in an env-file-shaped text: `NAME=...` at the start of a line. */
function envNamesFromFile(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

test('deploy/team.env.example declares every TOKENFLOW_* variable team-serve.js reads from process.env', () => {
  const fromCode = envNamesFromTeamServe();
  assert.ok(fromCode.size > 0, 'sanity: the source must actually reference some TOKENFLOW_ env vars');
  const exampleText = fs.readFileSync(path.join(ROOT, 'deploy', 'team.env.example'), 'utf8');
  const fromExample = envNamesFromFile(exampleText);
  const missing = [...fromCode].filter((n) => !fromExample.has(n));
  assert.deepEqual(missing, [], `deploy/team.env.example is missing: ${missing.join(', ')}`);
});

test('deploy/team.env.example carries no TOKENFLOW_ name that does not exist anywhere under src/', () => {
  const exampleText = fs.readFileSync(path.join(ROOT, 'deploy', 'team.env.example'), 'utf8');
  const fromExample = [...envNamesFromFile(exampleText)].filter((n) => n.startsWith('TOKENFLOW_'));
  const srcDir = path.join(ROOT, 'src');
  const allSrc = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) allSrc.push(fs.readFileSync(p, 'utf8'));
    }
  })(srcDir);
  const combined = allSrc.join('\n');
  const stale = fromExample.filter((n) => !combined.includes(n));
  assert.deepEqual(stale, [], `deploy/team.env.example has a name no source file references: ${stale.join(', ')}`);
});

test('deploy/docker-compose.yml parses and shapes the team server as documented', () => {
  const text = fs.readFileSync(path.join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');
  const doc = parseYaml(text);
  const svc = doc.services['tokenflow-team'];
  assert.ok(svc, 'a tokenflow-team service must exist');
  assert.equal(svc.build.dockerfile, 'Dockerfile.team');
  assert.ok(svc.env_file.includes('team.env'));
  assert.ok(svc.ports.some((p) => p.startsWith('127.0.0.1:')), 'must bind 127.0.0.1 only');
  assert.ok(svc.healthcheck, 'must declare a healthcheck');
  assert.equal(svc.restart, 'unless-stopped');

  const caddy = doc.services.caddy;
  assert.ok(caddy, 'the optional TLS proxy service must exist');
  assert.deepEqual(caddy.profiles, ['tls']);
});

test('deploy/docker-compose.yml: `docker compose config` validates it, when docker is available', () => {
  let dockerAvailable = false;
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    dockerAvailable = true;
  } catch { /* docker (or the compose plugin) is not on PATH here */ }

  if (!dockerAvailable) {
    console.log('  (skipped: docker is not on PATH in this environment)');
    return;
  }

  const exampleEnv = path.join(ROOT, 'deploy', 'team.env');
  const hadEnv = fs.existsSync(exampleEnv);
  const prevEnv = hadEnv ? fs.readFileSync(exampleEnv, 'utf8') : null;
  fs.copyFileSync(path.join(ROOT, 'deploy', 'team.env.example'), exampleEnv);
  try {
    const out = execFileSync('docker', ['compose', '-f', 'deploy/docker-compose.yml', 'config'], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env, TOKENFLOW_TEAM_TOKEN: 'ci-check-token' },
    });
    assert.match(out.toString('utf8'), /tokenflow-team/);
  } finally {
    if (hadEnv) fs.writeFileSync(exampleEnv, prevEnv); else fs.rmSync(exampleEnv, { force: true });
  }
});

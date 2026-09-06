/**
 * The org policy layer: a cap the team declares on a team server, cached at
 * `<TOKENFLOW_HOME>/policy/org.yaml` (+ `org.meta.json`), fetched ONLY by
 * `tokenflow policy pull` / `refreshOrgPolicyIfStale`, and applied by
 * `effectivePolicy()` as a CEILING — it can lower an effective max* (or
 * warn*) value, never raise one. The guard hook itself (`evaluateSession`,
 * `evaluateCodexNotify`) never fetches; it reads the cache only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GUARD_KEYS, orgPolicyPath, orgMetaPath, loadOrgPolicy, fetchOrgPolicy, effectivePolicy,
} from '../src/core/policy.js';
import { evaluateSession, hookOutput } from '../src/commands/guard.js';
import { show, renderShow, run as policyRun, pull, refreshOrgPolicyIfStale } from '../src/commands/policy.js';
import { loadProviders } from '../src/core/registry.js';
import { buildPriceBook } from '../src/core/pricing.js';
import { FIXTURES } from './helpers.js';

/**
 * Run work inside a fresh TOKENFLOW_HOME, cleaned up after. Unlike a plain
 * `try { return fn(home) } finally { ...cleanup } }`, this AWAITS `fn(home)`
 * before running cleanup — required here because several tests genuinely
 * await across multiple ticks (`fetchOrgPolicy`'s network call), and a
 * cleanup that fires the instant the callback yields its first pending
 * promise (rather than once it actually settles) would delete the temp home
 * out from under a still-running fetch.
 */
async function withHome(fn) {
  const prev = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policy-org-home-'));
  process.env.TOKENFLOW_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policy-org-repo-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function writeRepoPolicy(root, yaml) {
  const dir = path.join(root, '.tokenflow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml);
}

/** Write the org cache directly (bypassing fetchOrgPolicy) for tests that only care about effectivePolicy's ceiling math. */
function writeOrgCache(home, { guard = {}, note = null, fetchedAt = new Date().toISOString(), source = 'https://team.example/tf' } = {}) {
  const lines = [];
  if (Object.keys(guard).length) {
    lines.push('guard:');
    for (const [k, v] of Object.entries(guard)) lines.push(`  ${k}: ${v}`);
  }
  if (note) lines.push(`note: "${note}"`);
  fs.mkdirSync(path.dirname(orgPolicyPath(home)), { recursive: true });
  fs.writeFileSync(orgPolicyPath(home), lines.join('\n') + '\n');
  fs.writeFileSync(orgMetaPath(home), JSON.stringify({ fetchedAt, source }));
}

function clearOrgCache(home) {
  fs.rmSync(orgPolicyPath(home), { force: true });
  fs.rmSync(orgMetaPath(home), { force: true });
}

/**
 * A minimal fetch mock: `text/yaml` body, or a status/throw, recording every
 * call it received. Cast once here (rather than at every call site) to
 * `typeof fetch` — the mock's return value is Response-SHAPED for what
 * `fetchOrgPolicy` actually reads (`status`, `ok`, `statusText`, `text()`,
 * `headers.get()`), never a real `Response`.
 * @returns {typeof fetch & {calls: Array<{url:string, options:object}>}}
 */
function mockFetch({ status = 200, body = '', statusText = '', etag = null, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    if (throwErr) throw throwErr;
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText,
      text: async () => body,
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    };
  };
  fn.calls = calls;
  return /** @type {typeof fetch & {calls: Array<{url:string, options:object}>}} */ (fn);
}

// --------------------------------------------------------- ceiling math ---

test('effectivePolicy: for every guard key, the org value ceilings the layer beneath it — never raises it', async () => {
  await withHome(async (home) => {
    for (const k of GUARD_KEYS) {
      // org lower than personal -> org wins
      writeOrgCache(home, { guard: { [k]: 10 } });
      let eff = effectivePolicy({ cwd: null, home, config: { guard: { [k]: 100 } } });
      assert.equal(eff.policy[k], 10, `${k}: a lower org value must win`);
      assert.equal(eff.sources[k], 'org');

      // org higher than personal -> the org must never raise the cap
      writeOrgCache(home, { guard: { [k]: 1000 } });
      eff = effectivePolicy({ cwd: null, home, config: { guard: { [k]: 100 } } });
      assert.equal(eff.policy[k], 100, `${k}: a higher org value must not apply`);
      assert.equal(eff.sources[k], 'personal');

      // org declares it, personal declares nothing -> org still applies as the only cap
      writeOrgCache(home, { guard: { [k]: 42 } });
      eff = effectivePolicy({ cwd: null, home, config: { guard: {} } });
      assert.equal(eff.policy[k], 42, `${k}: org alone still applies`);
      assert.equal(eff.sources[k], 'org');

      // personal declares it, org declares nothing -> personal applies, untouched
      clearOrgCache(home);
      eff = effectivePolicy({ cwd: null, home, config: { guard: { [k]: 55 } } });
      assert.equal(eff.policy[k], 55, `${k}: personal alone still applies`);
      assert.equal(eff.sources[k], 'personal');
    }
  });
});

test('effectivePolicy: source attribution across all four layers — personal, repo (wins over personal), org (ceilings both), and default', async () => {
  await withHome(async (home) => {
    const root = makeRepo();
    writeRepoPolicy(root, ['guard:', '  maxCostUsd: 80', '  warnCostUsd: 20', ''].join('\n'));
    const config = { guard: { maxCostUsd: 200, warnCostUsd: 5, maxContextTokens: 500000 } };

    let eff = effectivePolicy({ cwd: root, home, config });
    assert.equal(eff.policy.maxCostUsd, 80);
    assert.equal(eff.sources.maxCostUsd, 'repo', 'repo wins over personal');
    assert.equal(eff.policy.warnCostUsd, 20);
    assert.equal(eff.sources.warnCostUsd, 'repo');
    assert.equal(eff.policy.maxContextTokens, 500000);
    assert.equal(eff.sources.maxContextTokens, 'personal', 'declared only in config');
    assert.equal(eff.policy.warnContextTokens, null);
    assert.equal(eff.sources.warnContextTokens, 'default', 'declared nowhere');

    // Org ceilings maxCostUsd below the repo's 80, but its warnCostUsd (999)
    // is HIGHER than the repo's 20 and must have no effect.
    writeOrgCache(home, { guard: { maxCostUsd: 30, warnCostUsd: 999 } });
    eff = effectivePolicy({ cwd: root, home, config });
    assert.equal(eff.policy.maxCostUsd, 30);
    assert.equal(eff.sources.maxCostUsd, 'org');
    assert.equal(eff.policy.warnCostUsd, 20, 'the org would have raised it — must not apply');
    assert.equal(eff.sources.warnCostUsd, 'repo');
    assert.equal(eff.org.found, true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('effectivePolicy: an org value equal to the base value keeps the base source (no spurious "org" attribution)', async () => {
  await withHome(async (home) => {
    writeOrgCache(home, { guard: { maxCostUsd: 100 } });
    const eff = effectivePolicy({ cwd: null, home, config: { guard: { maxCostUsd: 100 } } });
    assert.equal(eff.policy.maxCostUsd, 100);
    assert.equal(eff.sources.maxCostUsd, 'personal');
  });
});

test('effectivePolicy: an invalid org value (non-number, negative) is reported and never applied', async () => {
  await withHome(async (home) => {
    fs.mkdirSync(path.dirname(orgPolicyPath(home)), { recursive: true });
    fs.writeFileSync(orgPolicyPath(home), 'guard:\n  maxCostUsd: -5\n  bogus: 1\n');
    fs.writeFileSync(orgMetaPath(home), JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'https://team.example/tf' }));

    const eff = effectivePolicy({ cwd: null, home, config: { guard: { maxCostUsd: 40 } } });
    assert.equal(eff.policy.maxCostUsd, 40, 'the bad org value must fall back to the layer beneath it');
    assert.equal(eff.sources.maxCostUsd, 'personal');
    assert.ok(eff.errors.some((e) => /maxCostUsd must be a positive number/.test(e)));
    assert.ok(eff.errors.some((e) => /unknown guard key "bogus"/.test(e)));
  });
});

// --------------------------------------------------------------- loadOrgPolicy ---

test('loadOrgPolicy: reads only the cache, never fetches — a missing file is "not found", not an error', async () => {
  await withHome(async (home) => {
    const p = loadOrgPolicy(home);
    assert.equal(p.found, false);
    assert.deepEqual(p.guard, {});
    assert.equal(p.meta, null);
  });
});

// ---------------------------------------------------------------- fetchOrgPolicy ---

test('fetchOrgPolicy: fetches, writes the cache atomically, and reports the exact source URL used', async () => {
  await withHome(async (home) => {
    const fetchImpl = mockFetch({ status: 200, body: 'guard:\n  maxCostUsd: 10\n' });
    const res = await fetchOrgPolicy({ url: 'https://team.example/tf/', token: 'shh', home, fetchImpl, now: Date.now() });

    assert.equal(res.updated, true);
    assert.equal(res.fromCache, false);
    assert.equal(res.error, null);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://team.example/tf/api/policy', 'a trailing slash on sync.to must not double up');
    assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer shh');

    assert.equal(fs.existsSync(`${orgPolicyPath(home)}.tmp`), false, 'no leftover temp file');
    assert.equal(fs.existsSync(`${orgMetaPath(home)}.tmp`), false);
    assert.equal(fs.readFileSync(orgPolicyPath(home), 'utf8'), 'guard:\n  maxCostUsd: 10\n');
    const meta = JSON.parse(fs.readFileSync(orgMetaPath(home), 'utf8'));
    assert.equal(meta.source, 'https://team.example/tf/');
    assert.ok(meta.fetchedAt);

    const loaded = loadOrgPolicy(home);
    assert.equal(loaded.found, true);
    assert.equal(loaded.guard.maxCostUsd, 10);
  });
});

test('fetchOrgPolicy: within the TTL, no network call is made; --force or an elapsed TTL triggers one', async () => {
  await withHome(async (home) => {
    const fetchImpl = mockFetch({ status: 200, body: 'guard:\n  maxCostUsd: 10\n' });
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');

    const first = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0, ttlSeconds: 3600 });
    assert.equal(first.fromCache, false);
    assert.equal(fetchImpl.calls.length, 1);

    const withinTtl = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0 + 60_000, ttlSeconds: 3600 });
    assert.equal(withinTtl.fromCache, true);
    assert.equal(withinTtl.updated, false);
    assert.equal(fetchImpl.calls.length, 1, 'no network call while the cache is still fresh');

    const forced = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0 + 60_000, ttlSeconds: 3600, force: true });
    assert.equal(fetchImpl.calls.length, 2, '--force fetches even inside the TTL');
    assert.equal(forced.updated, false, 'identical content: nothing actually changed');
    assert.equal(forced.fromCache, false);
    // The forced fetch above also bumped meta.fetchedAt to t0+60_000 (a real
    // fetch happened, so the clock restarts from there) — the next TTL
    // boundary is relative to THAT timestamp, not the original t0.
    const afterTtl = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0 + 60_000 + 3601_000, ttlSeconds: 3600 });
    assert.equal(fetchImpl.calls.length, 3, 'TTL elapsed: fetches again');
    assert.equal(afterTtl.fromCache, false);
  });
});

test('fetchOrgPolicy: a network error, a non-2xx status, and an unparsable body all keep the old cache untouched', async () => {
  await withHome(async (home) => {
    writeOrgCache(home, { guard: { maxCostUsd: 10 } });
    const before = fs.readFileSync(orgPolicyPath(home), 'utf8');
    // Force a re-fetch attempt each time by backdating fetchedAt past the TTL.
    const stale = () => fs.writeFileSync(orgMetaPath(home), JSON.stringify({ fetchedAt: '2000-01-01T00:00:00.000Z', source: 'https://team.example/tf' }));

    stale();
    const netErr = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl: mockFetch({ throwErr: new Error('ECONNREFUSED') }) });
    assert.equal(netErr.updated, false);
    assert.match(netErr.error, /ECONNREFUSED/);
    assert.equal(fs.readFileSync(orgPolicyPath(home), 'utf8'), before);

    stale();
    const serverErr = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl: mockFetch({ status: 500, statusText: 'Internal Server Error' }) });
    assert.equal(serverErr.updated, false);
    assert.match(serverErr.error, /500/);
    assert.equal(fs.readFileSync(orgPolicyPath(home), 'utf8'), before);

    stale();
    // A server error page instead of YAML: no colon on the line, so this
    // project's YAML subset rejects it as "expected key: value" rather than
    // silently parsing it as some scalar.
    const badBody = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl: mockFetch({ status: 200, body: '<html>Service Unavailable</html>\n' }) });
    assert.equal(badBody.updated, false);
    assert.match(badBody.error, /invalid policy\.yaml/);
    assert.equal(fs.readFileSync(orgPolicyPath(home), 'utf8'), before, 'a malformed body from the server must never overwrite a good cache');
  });
});

test('fetchOrgPolicy: a 404 clears the cached policy.yaml (the org removed its policy), and the TTL still gates re-fetching', async () => {
  await withHome(async (home) => {
    writeOrgCache(home, { guard: { maxCostUsd: 10 } });
    const fetchImpl = mockFetch({ status: 404 });
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');

    // `force` makes this call unconditional, regardless of the cache's actual
    // age — the point here is the 404 handling, not the TTL gate (covered below).
    const res = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0, force: true });
    assert.equal(res.updated, true, 'a cache existed and was cleared');
    assert.equal(res.error, null);
    assert.equal(fs.existsSync(orgPolicyPath(home)), false);
    assert.equal(loadOrgPolicy(home).found, false);

    // A second 404 with nothing left to clear reports no change...
    const stillGone = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0, force: true });
    assert.equal(stillGone.updated, false);

    // ...and, crucially, the TTL was refreshed on the FIRST 404, so a later
    // call inside that window makes no network call at all.
    const within = await fetchOrgPolicy({ url: 'https://team.example/tf', home, fetchImpl, now: t0 + 1000, ttlSeconds: 3600 });
    assert.equal(within.fromCache, true);
    assert.equal(fetchImpl.calls.length, 2, 'only the two forced/explicit calls above — the TTL-gated one made no request');
  });
});

// -------------------------------------------------------------------- guard exit 2 ---

test('guard hook (Claude Code, PreToolUse): exits 2 when the org ceiling is lower than the personal cap and the session cost sits between them — and never fetches', async () => {
  await loadProviders();
  await withHome(async (home) => {
    const book = buildPriceBook({});
    const transcriptPath = path.join(FIXTURES, 'anthropic-session.jsonl');

    // Learn the fixture's real cost with no policy at all, so the two caps
    // bracket it regardless of the pricing table's exact numbers.
    const baseline = evaluateSession(
      { transcript_path: transcriptPath, session_id: 'exit2-baseline', cwd: null },
      { config: { guard: {} }, book, cache: false },
    );
    const cost = baseline.verdict.cost;
    assert.ok(cost > 0, 'the fixture must carry a priced session for this proof to mean anything');

    const personalMax = cost * 10; // the personal cap alone would NOT block
    const orgMax = cost / 2; // the org ceiling alone WOULD block
    writeOrgCache(home, { guard: { maxCostUsd: orgMax } });

    // Prove the hook path never fetches to get there. evaluateSession is
    // synchronous, so a stub that THROWS would only matter if something
    // awaited it; count calls instead, which proves the absence of a call
    // regardless of whether anything would have awaited its result.
    let fetchCalls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalls++; return /** @type {Response} */ ({}); };
    try {
      const config = { guard: { maxCostUsd: personalMax } };
      const { verdict } = evaluateSession(
        { transcript_path: transcriptPath, session_id: 'exit2', cwd: null },
        { config, book, cache: false },
      );
      assert.equal(verdict.level, 'block', 'the org ceiling, not the personal cap, must be the one that fires');
      assert.match(verdict.reasons.join(' '), /org policy/);

      const out = hookOutput(verdict, 'PreToolUse');
      assert.equal(out.exitCode, 2);
      assert.match(out.stderr, /reached the declared cap/);
      assert.equal(out.stdout, null);
      // `guard --set` writes the personal config, which cannot lift an org
      // ceiling: the hint must not send the user to a command that does nothing.
      assert.equal(verdict.firedSources.maxCostUsd, 'org');
      assert.match(out.stderr, /maxCostUsd comes from your org policy/);
      assert.match(out.stderr, /docs\/policy\.md/);
      assert.doesNotMatch(out.stderr, /guard --set maxCostUsd=<n>/);
      assert.equal(fetchCalls, 0, 'the guard hook must never fetch — it reads the org cache only');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

test('guard hook: a personal cap keeps the `guard --set` hint, because there the command does work', async () => {
  await loadProviders();
  await withHome(async () => {
    const book = buildPriceBook({});
    const transcriptPath = path.join(FIXTURES, 'anthropic-session.jsonl');
    const baseline = evaluateSession(
      { transcript_path: transcriptPath, session_id: 'hint-baseline', cwd: null },
      { config: { guard: {} }, book, cache: false },
    );
    // No org cache is written here, so the only cap in force is the personal one.
    const { verdict } = evaluateSession(
      { transcript_path: transcriptPath, session_id: 'hint-personal', cwd: null },
      { config: { guard: { maxCostUsd: baseline.verdict.cost / 2 } }, book, cache: false },
    );
    assert.equal(verdict.level, 'block');
    assert.equal(verdict.firedSources.maxCostUsd, 'personal');

    const out = hookOutput(verdict, 'PreToolUse');
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /guard --set maxCostUsd=<n>/);
    assert.doesNotMatch(out.stderr, /org policy/);
  });
});

// -------------------------------------------------------------- policy show / pull ---

test('policy show: renders every guard key with its source, and names the org source when it applied', async () => {
  await withHome(async (home) => {
    const root = makeRepo();
    writeRepoPolicy(root, ['guard:', '  maxCostUsd: 80', ''].join('\n'));
    writeOrgCache(home, { guard: { maxCostUsd: 30 } });

    const eff = show({ cwd: root, home, config: { guard: { warnCostUsd: 5 } } });
    assert.equal(eff.policy.maxCostUsd, 30);
    assert.equal(eff.sources.maxCostUsd, 'org');
    assert.equal(eff.policy.warnCostUsd, 5);
    assert.equal(eff.sources.warnCostUsd, 'personal');

    const text = renderShow(eff, root);
    assert.match(text, /maxCostUsd\s+30\s+\[org\]/);
    assert.match(text, /warnCostUsd\s+5\s+\[personal\]/);
    assert.match(text, /warnContextTokens\s+—\s+\[default\]/);
    assert.match(text, /org policy\s+https:\/\/team\.example\/tf/);
    assert.match(text, /lowering at least one cap above/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('policy show: an org cache present but not lowering anything says so, rather than implying it applied', async () => {
  await withHome(async (home) => {
    writeOrgCache(home, { guard: { maxCostUsd: 999 } });
    const eff = show({ cwd: null, home, config: { guard: { maxCostUsd: 50 } } });
    const text = renderShow(eff, '/some/dir');
    assert.match(text, /org policy .* \(cached; none lower than the personal\/repo value\)/);
  });
});

test('policy pull: reports "updated", then "unchanged" on the next call within the TTL', async () => {
  await withHome(async (home) => {
    const fetchImpl = mockFetch({ status: 200, body: 'guard:\n  maxCostUsd: 15\n' });
    const config = { sync: { to: 'https://team.example/tf', token: 'shh' } };

    const first = await pull({ config, home, fetchImpl });
    assert.equal(first.updated, true);

    const second = await pull({ config, home, fetchImpl });
    assert.equal(second.fromCache, true, 'still within the default TTL');
  });
});

test('policy pull: no sync.to configured is reported as an error, not a throw', async () => {
  await withHome(async (home) => {
    const res = await pull({ config: {}, home });
    assert.match(res.error, /no team server configured/);
  });
});

test('tokenflow policy pull (CLI): exits 1 only when the fetch fails AND there is no cache to fall back on', async () => {
  await withHome(async (home) => {
    const { saveConfig } = await import('../src/core/config.js');
    saveConfig({ sync: { to: 'https://team.example/tf', token: 'shh' } });

    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try {
      assert.equal(loadOrgPolicy(home).found, false);
      const noCache = await policyRun({ action: 'pull' });
      assert.equal(noCache.exitCode, 1);
      assert.match(noCache.stderr, /offline/);
      assert.equal(noCache.stdout, null);
      assert.equal(loadOrgPolicy(home).found, false, 'a failed pull with nothing to fall back on writes no cache');

      // Seed a cache directly (bypassing the network), then fail again: this
      // time the cache survives and the CLI reports the error without a
      // nonzero exit.
      writeOrgCache(home, { guard: { maxCostUsd: 10 } });
      const withCache = await policyRun({ action: 'pull', force: true });
      assert.equal(withCache.exitCode, 0);
      assert.match(withCache.stdout, /offline/);
      assert.equal(loadOrgPolicy(home).found, true, 'the cache survives a failed pull');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

test('refreshOrgPolicyIfStale: a no-op when no team server is configured; never throws', async () => {
  await withHome(async (home) => {
    const res = await refreshOrgPolicyIfStale({ config: {}, home });
    assert.deepEqual(res, { skipped: true });
  });
});

test('refreshOrgPolicyIfStale: with sync.to configured, it fetches and updates the cache', async () => {
  await withHome(async (home) => {
    const fetchImpl = mockFetch({ status: 200, body: 'guard:\n  maxCostUsd: 20\n' });
    const config = { sync: { to: 'https://team.example/tf', token: 'shh' } };
    const res = /** @type {{updated:boolean, fromCache:boolean, error:string|null}} */ (await refreshOrgPolicyIfStale({ config, home, fetchImpl }));
    assert.equal(res.updated, true);
    assert.equal(loadOrgPolicy(home).guard.maxCostUsd, 20);
  });
});

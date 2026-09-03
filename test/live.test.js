import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The live layer: status snapshot file, menu-bar formatting, and the watch
 * daemon's pure decision logic + instance lock. Each filesystem test runs in
 * its own TOKENFLOW_HOME so nothing here can touch a real installation.
 */
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-live-'));
  const prev = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = dir;
  const bust = `?t=${Date.now()}${Math.random()}`;
  const mods = {
    live: await import(`../src/core/live-status.js${bust}`),
    watch: await import(`../src/core/watch.js${bust}`),
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

const { countdown, compactTokens, money, barLine } = await import('../src/core/live-status.js');
const { computeDelayMs, detectTransitions } = await import('../src/core/watch.js');

// ------------------------------------------------------------ formatting ----

test('countdown renders human intervals and refuses to invent one', () => {
  assert.equal(countdown(null), null);
  assert.equal(countdown(45_000), '45s');
  assert.equal(countdown(90_000), '1m');
  assert.equal(countdown((2 * 3600 + 13 * 60) * 1000), '2h 13m');
  assert.equal(countdown((3 * 86400 + 4 * 3600) * 1000), '3d 4h');
});

test('compactTokens matches the dashboard formatter family', () => {
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(128_000), '128K');
  assert.equal(compactTokens(1_742_000_000), '1.74B');
  assert.equal(compactTokens(null), null);
});

test('money stays short and honest', () => {
  assert.equal(money(4.83), '$4.83');
  assert.equal(money(12.5), '$12.50'); // cents survive under $100 — $13 would be a lie
  assert.equal(money(1500), '$1.5K');
  assert.equal(money(null), null);
});

/** A minimal but structurally complete status for the bar-line tests. */
function status(over = {}) {
  return {
    usage: {
      today: { tokens: { total: 128_000 }, cost: 4.83, costMeasured: null },
      weekToDate: { tokens: { total: 900_000 } },
      ...over.usage,
    },
    capacity: { summary: over.capacity?.summary ?? { worst: null } },
    freshness: { stale: false, ageMs: 4000, lastRefresh: new Date().toISOString(), ...(over.freshness || {}) },
  };
}

test('barLine auto mode surfaces the most urgent signal first', () => {
  // No limits configured, priced data: today's cost wins.
  assert.equal(barLine(status()).text, 'TF $4.83');

  // A warn-state limit outranks the dollar figure.
  const s2 = status({
    capacity: { summary: { worst: { label: 'claude-monthly', status: 'warn', pctUsed: 0.82, resetsInMs: 12 * 60000 } } },
  });
  assert.equal(barLine(s2).text, 'TF ⚠ claude-monthly 82% · 12m');

  // Exceeded gets the hard glyph, and no second signal dilutes it.
  const s3 = status({
    capacity: { summary: { worst: { label: 'openai-day', status: 'exceeded', pctUsed: 1.05, resetsInMs: 5 * 3600000 } } },
  });
  const line3 = barLine(s3);
  assert.equal(line3.text, 'TF ✗ openai-day 105% · 5h');
});

test('barLine explicit modes do exactly what they are told', () => {
  assert.equal(barLine(status(), 'tokens').text, 'TF 128K');
  assert.equal(barLine(status(), 'cost').text, 'TF $4.83');
  // limit mode with nothing configured says so instead of inventing a number
  const none = barLine(status(), 'limit');
  assert.equal(none.text, 'TF —');
  assert.match(none.tooltip, /No limits configured/);
  // unpriced data falls back from cost to tokens rather than showing "—"
  const unpriced = barLine(
    status({ usage: { today: { tokens: { total: 5000 }, cost: null, costMeasured: null } } }),
    'cost',
  );
  assert.equal(unpriced.text, 'TF 5K');
});

test('barLine reports staleness in the tooltip, never silently', () => {
  const stale = barLine(status({ freshness: { stale: true, ageMs: 7 * 60000, lastRefresh: null } }));
  assert.match(stale.tooltip, /stale/);
});

test('freshness is recomputed against the current clock, not frozen at write time', async () => {
  const { withComputedFreshness } = await import('../src/core/live-status.js');
  const written = {
    freshness: { lastRefresh: new Date(Date.now() - 45 * 60000).toISOString(), staleAfterMs: 600000, ageMs: 5, stale: false },
  };
  const now = withComputedFreshness(written);
  assert.equal(now.freshness.stale, true, 'a 45-minute-old refresh must read as stale');
  assert.ok(now.freshness.ageMs > 40 * 60000);
  // A genuinely recent write stays fresh.
  const fresh = withComputedFreshness({
    freshness: { lastRefresh: new Date(Date.now() - 5000).toISOString(), staleAfterMs: 600000, ageMs: 1, stale: false },
  });
  assert.equal(fresh.freshness.stale, false);
  // No refresh ever -> permanently stale, never "fresh by default".
  assert.equal(withComputedFreshness({ freshness: { lastRefresh: null } }).freshness.stale, true);
});

test('currentStatus trusts the watcher cadence and never forgets the daemon', async () => {
  await withHome(async (_dir, { live, watch }) => {
    // Daemon-written snapshot with watcher identity. The lock is part of the
    // setup because it is the authority on liveness: only a watcher holding it
    // gets its identity carried into a fallback compute.
    watch.acquireWatchLock();
    await watch.runCycle({ registry: [], providers: [], daemon: { intervalSeconds: 120 } });
    let r = live.currentStatus();
    assert.equal(r.fromWatch, true);
    assert.equal(r.status.watcher?.mode, 'daemon');

    // A snapshot older than the cache window but still within its own
    // staleness budget must keep serving — with daemon facts intact even when
    // a fresh compute happens for other reasons.
    const st = live.readLiveStatus();
    st.generatedAt = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min old
    st.freshness.lastRefresh = new Date(Date.now() - 5 * 60000).toISOString();
    live.writeLiveStatus(st);
    r = live.currentStatus(); // window = interval(120s)+60s < 5min -> compute path
    assert.equal(r.fromWatch, false);
    assert.equal(r.status.watcher?.pid, st.watcher.pid, 'fallback compute preserves watcher identity');

    // …and drops it once the watcher is gone, so a paused TokenFlow never
    // reports itself live.
    watch.releaseWatchLock();
    assert.ok(!live.currentStatus().status.watcher, 'a released lock leaves no watcher claim');
  });
});

// ------------------------------------------------------- watch decisions ----

test('computeDelayMs backs off exponentially and caps at 15 minutes', () => {
  const base = 120_000;
  assert.equal(computeDelayMs(base, 0), base);
  assert.equal(computeDelayMs(base, 1), 240_000);
  assert.equal(computeDelayMs(base, 2), 480_000);
  assert.equal(computeDelayMs(base, 3), 900_000); // capped
  assert.equal(computeDelayMs(base, 50), 900_000);
});

test('detectTransitions announces crossings, recoveries and same-day anomalies only', () => {
  const prev = {
    generatedAt: '2026-08-22T10:00:00Z',
    capacity: { states: [
      { id: 'a', label: 'A', status: 'ok' },
      { id: 'b', label: 'B', status: 'warn' },
      { id: 'd', label: 'D', status: 'exceeded' },
    ] },
    /** @type {any[]} */ anomalies: [{ id: 'spike:2026-08-22', severity: 'high' }],
  };
  const next = {
    generatedAt: '2026-08-22T11:00:00Z', // today is 2026-08-22
    capacity: { states: [
      { id: 'a', label: 'A', status: 'warn', pctUsed: 0.85, scope: 'day', metric: 'tokens' },
      { id: 'b', label: 'B', status: 'exceeded', pctUsed: 1.1, scope: 'day', metric: 'cost', resetsInMs: 3600_000 },
      { id: 'c', label: 'C', status: 'ok', pctUsed: 0.1 },
      { id: 'd', label: 'D', status: 'ok', pctUsed: 0.2 },
    ] },
    /** @type {any[]} */ anomalies: [
      { id: 'spike:2026-08-22', severity: 'high' },                    // already announced
      { id: 'spike:2026-08-21', severity: 'high', type: 'token_spike', detail: 'yesterday’s news' }, // dated history
      { id: 'gap:2026-08-22', severity: 'info', type: 'possible_gap', detail: 'ignored severity' },
    ],
  };

  const events = detectTransitions(prev, next);
  const kinds = events.map((e) => `${e.kind}:${e.id}`).sort();
  assert.deepEqual(kinds, ['limit:a', 'limit:b', 'recovered:d']);
  const b = events.find((e) => e.id === 'b');
  assert.ok(b.title.includes('Limit exceeded'));
  assert.ok(b.body.includes('Resets in'));

  // Nothing changed -> nothing announced.
  assert.deepEqual(detectTransitions(next, structuredClone(next)), []);

  // A genuinely fresh anomaly (dated today, never announced) does alert.
  const withFresh = structuredClone(next);
  withFresh.anomalies.push({ id: 'spike:2026-08-22b', severity: 'high', type: 'cost_spike', date: '2026-08-22', detail: 'fresh' });
  const ev2 = detectTransitions(prev, withFresh);
  assert.deepEqual(ev2.filter((e) => e.kind === 'anomaly').map((e) => e.id), ['spike:2026-08-22b']);

  // First-ever snapshot: limit breaches alert (current state), historical
  // anomalies do NOT replay as notifications.
  const first = detectTransitions(null, next);
  assert.ok(first.some((e) => e.id === 'b' && e.kind === 'limit'));
  assert.deepEqual(first.filter((e) => e.kind === 'anomaly'), []);
});

// ------------------------------------------------------- watch lifecycle ----

test('watch lock: single instance, stale replacement, clean release', async () => {
  await withHome(async (_dir, { watch }) => {
    assert.equal(watch.watchIsRunning(), false);
    watch.acquireWatchLock();
    assert.equal(watch.watchIsRunning(), true);
    assert.throws(() => watch.acquireWatchLock(), /already running/);
    watch.releaseWatchLock();
    assert.equal(watch.watchIsRunning(), false);
    // Acquire again after release — the normal restart path.
    watch.acquireWatchLock();
    watch.releaseWatchLock();

    // A crashed watcher leaves a dead pid behind; the next start replaces it.
    fs.mkdirSync(path.join(process.env.TOKENFLOW_HOME, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.TOKENFLOW_HOME, 'data', 'watch.pid'), '2147000000');
    assert.equal(watch.watchIsRunning(), false);
    watch.acquireWatchLock(); // must not throw
    watch.releaseWatchLock();
  });
});

test('watch lock: a pid recycled across a reboot does not hold the lock', async () => {
  await withHome(async (dir, { watch }) => {
    const lockFile = path.join(dir, 'data', 'watch.pid');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

    // The real failure this guards: a lock file written before a reboot, whose
    // pid the kernel has since handed to an unrelated daemon. `kill(pid, 0)`
    // keeps succeeding, so a pid-only check refuses to start a watcher forever.
    // pid 1 (launchd/init) is always alive and is definitely not ours.
    fs.writeFileSync(lockFile, '1');
    assert.equal(watch.watchIsRunning(), false, 'a live non-tokenflow pid must not read as our watcher');
    watch.acquireWatchLock(); // must not throw
    watch.releaseWatchLock();

    // Same story in the JSON form: the pid is alive, but its boot stamp
    // belongs to an earlier boot, so the lock cannot describe a live process.
    fs.writeFileSync(lockFile, JSON.stringify({ v: 2, pid: process.pid, boot: 1000 }));
    assert.equal(watch.watchIsRunning(), false, 'a lock from a previous boot is stale');
    watch.acquireWatchLock(); // must not throw
    assert.equal(watch.watchIsRunning(), true);

    // What we write carries the identity a future reader needs.
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.ok(Math.abs(held.boot - watch.bootTimeMs()) < 30_000, 'boot stamp names this boot');
    watch.releaseWatchLock();

    // `--stop` is the escape hatch: it clears a lock it judges stale.
    fs.writeFileSync(lockFile, JSON.stringify({ v: 2, pid: process.pid, boot: 1000 }));
    const r = watch.stopWatch();
    assert.equal(r.stopped, false);
    assert.match(r.reason, /stale/);
    assert.equal(fs.existsSync(lockFile), false);
  });
});

test('runCycle produces a valid status file even with zero sources', async () => {
  await withHome(async (dir, { watch, live, config }) => {
    const cfg = structuredClone(config.DEFAULT_CONFIG);
    const r = await watch.runCycle({
      config: cfg,
      registry: [], // hermetic: no adapters, nothing on disk gets touched
      providers: [],
    });
    assert.equal(r.skipped, false);
    assert.deepEqual(r.transitions, []);

    const st = live.readLiveStatus();
    assert.equal(st.schema, 1);
    assert.equal(st.usage.today.tokens.total, 0);
    assert.equal(st.capacity.states.length, 0);
    // A one-shot cycle must NOT claim a watcher is running.
    assert.equal(st.watcher, null);
    assert.ok(st.lastCycle?.at);

    // And the file is where every live surface expects it.
    assert.equal(fs.existsSync(path.join(dir, 'data', 'status.json')), true);
  });
});

test('cycle failures land in lastError without a watcher claim', async () => {
  await withHome(async (_dir, { watch, live }) => {
    watch.recordCycleError(new Error('disk full (simulated)'));
    const st = live.readLiveStatus();
    assert.match(st.lastError.message, /disk full/);
    assert.equal(st.watcher ?? null, null);
  });
});

test('daemon-owned cycles identify themselves in the snapshot', async () => {
  await withHome(async (_dir, { watch, live }) => {
    await watch.runCycle({ registry: [], providers: [], daemon: { intervalSeconds: 45 } });
    const st = live.readLiveStatus();
    assert.equal(st.watcher.mode, 'daemon');
    assert.equal(st.watcher.intervalSeconds, 45);
    assert.equal(st.watcher.cycles, 1);
  });
});

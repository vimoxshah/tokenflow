/**
 * The watch daemon — `tokenflow watch`.
 *
 * A single background process that keeps TokenFlow live: incremental refresh
 * on an interval, a live status snapshot after every cycle, and (opt-in) OS
 * notifications when a limit crosses its threshold or a high-severity anomaly
 * appears.
 *
 * Design constraints this file takes seriously:
 *
 * Single instance.  A pidfile guards against two watchers racing on the same
 *   store; a stale pidfile from a crashed run is detected and replaced.
 * Failure isolation. One bad provider cannot stop the loop: refresh errors
 *   are recorded into the status file and back off exponentially instead.
 * Sleep/wake. The loop reschedules from wall-clock reality every tick, so a
 *   laptop that slept for three hours simply refreshes once on wake rather
 *   than trying to "catch up" with a burst of cycles.
 * Nothing leaves the machine. Refresh reads local logs; notifications go to
 *   the local OS; the status file stays in $TOKENFLOW_HOME.
 */
import fs from 'node:fs';
import { loadConfig, paths, ensureDirs } from './config.js';
import { refresh } from './ingest.js';
import { listProviders } from './registry.js';
import { buildLiveStatus, writeLiveStatus, readLiveStatus } from './live-status.js';
import { notify as osNotify } from './notify.js';

const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** Exponential backoff between cycles: base × 2^failures, capped. */
export function computeDelayMs(baseMs, consecutiveFailures) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return MAX_BACKOFF_MS;
  const f = Math.max(0, Math.floor(consecutiveFailures || 0));
  return Math.min(baseMs * 2 ** f, MAX_BACKOFF_MS);
}

/**
 * Compare two live-status snapshots and return the alert-worthy transitions.
 *
 * Pure function — the daemon's notification policy lives here so it can be
 * tested without spawning anything:
 *   - a configured limit moving ok→warn / warn→exceeded / ok→exceeded
 *   - a limit recovering back to ok
 *   - high-severity anomalies dated TODAY that were not in the previous
 *     snapshot. Historical highs are data, not news: a first cycle must not
 *     replay last week's spikes as notifications.
 */
export function detectTransitions(prev, next) {
  const out = [];
  if (!next) return out;
  const today = String(next.generatedAt || '').slice(0, 10);
  const prevLimits = new Map((prev?.capacity?.states || []).map((s) => [s.id, s.status]));
  for (const s of next.capacity?.states || []) {
    const before = prevLimits.get(s.id);
    if (before === s.status) continue;
    if (s.status === 'exceeded') {
      out.push({
        kind: 'limit', id: s.id,
        title: `Limit exceeded: ${s.label}`,
        body: `${Math.round((s.pctUsed ?? 1) * 100)}% of ${s.scope} ${s.metric}. Resets in ${humanize(s.resetsInMs)}.`,
      });
    } else if (s.status === 'warn' && before !== undefined && before !== 'warn') {
      out.push({
        kind: 'limit', id: s.id,
        title: `Approaching limit: ${s.label}`,
        body: `${Math.round(s.pctUsed * 100)}% of ${s.scope} ${s.metric} used.`,
      });
    } else if (s.status === 'ok' && (before === 'warn' || before === 'exceeded')) {
      out.push({ kind: 'recovered', id: s.id, title: `Limit recovered: ${s.label}`, body: 'Window reset or usage revised.' });
    }
  }
  // Anomalies alert only when they happened today AND we have not announced
  // them before. A rebuilt status file therefore stays quiet about history.
  const prevAnomalies = new Set((prev?.anomalies || []).map((a) => a.id));
  for (const a of next.anomalies || []) {
    if (a.severity !== 'high') continue;
    if (!today || a.date !== today) continue;
    if (prevAnomalies.has(a.id)) continue;
    out.push({ kind: 'anomaly', id: a.id, title: `Unusual ${(a.type || 'event').replace(/_/g, ' ')}`, body: a.detail });
  }
  return out;
}

function humanize(ms) {
  if (!Number.isFinite(ms)) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ------------------------------------------------------------- instance ----

function readLockPid() {
  try {
    const pid = Number(fs.readFileSync(paths().watchPid, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but owned by someone else.
    return err.code !== 'ESRCH';
  }
}
export { processAlive };

/** Set while THIS process runs a watcher loop — guards same-process double start. */
let ownedHere = false;

/**
 * Guard the single-instance rule. Throws with a readable hint when another
 * watcher already owns this store (including an earlier startWatch in this
 * very process); silently replaces a dead one left by a crash.
 */
export function acquireWatchLock() {
  if (ownedHere) {
    throw new Error('a watcher is already running in this process');
  }
  ensureDirs();
  const existing = readLockPid();
  if (existing && processAlive(existing)) {
    throw Object.assign(new Error(`a watcher is already running (pid ${existing})`), {
      hint: '`tokenflow watch --status` shows it; `tokenflow watch --stop` stops it.',
    });
  }
  fs.writeFileSync(paths().watchPid, String(process.pid));
  ownedHere = true;
}

export function releaseWatchLock() {
  const p = paths().watchPid;
  const pid = readLockPid();
  if (pid === process.pid) {
    try { fs.unlinkSync(p); } catch { /* already gone — that is fine */ }
  }
  ownedHere = false;
}

/** Is a watcher running right now (and does it own the lock)? */
export function watchIsRunning() {
  const pid = readLockPid();
  return !!(pid && processAlive(pid));
}

export function stopWatch() {
  const pid = readLockPid();
  if (!pid || !processAlive(pid)) {
    try { fs.unlinkSync(paths().watchPid); } catch { /* nothing to clean */ }
    return { stopped: false, reason: 'not running' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch (err) {
    return { stopped: false, reason: err.message };
  }
}

// ---------------------------------------------------------------- cycle ----

let inCycle = false;

/**
 * One pass: refresh → build status → notify transitions → persist.
 *
 * `daemon` identifies the caller: a long-running watcher (startWatch) passes
 * `{ intervalSeconds }` so the snapshot can say "running"; one-shot callers
 * (`watch --once`, tests, CI) pass nothing and the snapshot honestly reports
 * that no watcher is running.
 */
export async function runCycle(opt = {}) {
  if (inCycle) return { skipped: true }; // coalesce overlapping triggers
  inCycle = true;
  const t0 = Date.now();
  try {
    const prev = readLiveStatus();
    const report = await refresh({
      // An explicit registry/providers override keeps tests and embedded uses
      // hermetic: `registry: [], providers: []` touches no source at all.
      registry: opt.registry || listProviders(),
      providers: opt.providers,
      deadlineMs: opt.refreshBudgetMs ?? 45000,
      onProgress: opt.onProgress,
    });

    const status = buildLiveStatus({ config: opt.config });
    status.watcher = opt.daemon
      ? {
        ...(prev?.watcher || {}),
        pid: process.pid,
        mode: 'daemon',
        intervalSeconds: opt.daemon.intervalSeconds ?? null,
        startedAt: prev?.watcher?.startedAt || new Date().toISOString(),
        cycles: (prev?.watcher?.cycles || 0) + 1,
        lastCycleAt: new Date().toISOString(),
        lastCycleMs: Date.now() - t0,
        lastRefreshReport: {
          done: report.done,
          newRecords: report.newRecords,
          providers: (report.providers || []).map((p) => ({ id: p.id, status: p.status, records: p.records })),
        },
      }
      : null;

    const transitions = detectTransitions(prev, status);
    status.lastCycle = { at: status.generatedAt, durationMs: Date.now() - t0, newRecords: report.newRecords };
    writeLiveStatus(status);

    if (opt.notifications && transitions.length) {
      for (const tr of transitions.slice(0, 4)) await osNotify(tr);
    }
    return { skipped: false, transitions, report, durationMs: Date.now() - t0 };
  } finally {
    inCycle = false;
  }
}

/** Record a failed cycle into the status file without losing the last good data. */
export function recordCycleError(err) {
  const cur = readLiveStatus() || {};
  cur.lastError = { message: String(err.message || err).slice(0, 300), at: new Date().toISOString() };
  try {
    writeLiveStatus(cur);
  } catch {
    /* disk-level failure: nothing more a watcher can do here */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the daemon until SIGINT/SIGTERM.
 *
 * @param {{intervalSeconds?:number, notifications?:boolean, config?:object,
 *          onCycle?:Function, maxCycles?:number}} opt
 *   `maxCycles` exists for tests/CI only — a production watcher never stops
 *   on its own.
 */
export async function startWatch(opt = {}) {
  const config = opt.config || loadConfig();
  const intervalSeconds = Number(
    opt.intervalSeconds ?? config.watch?.intervalSeconds ?? 120,
  );
  const notifications = opt.notifications ?? !!config.watch?.notifications;
  acquireWatchLock();

  let failures = 0;
  let cycles = 0;
  const baseMs = Math.max(10, intervalSeconds) * 1000;

  while (true) {
    try {
      const r = await runCycle({
        config,
        daemon: { intervalSeconds },
        notifications,
      });
      failures = 0;
      cycles++;
      opt.onCycle?.(r);
    } catch (err) {
      failures++;
      recordCycleError(err);
      opt.onCycle?.({ error: err.message });
    }
    if (opt.maxCycles && cycles >= opt.maxCycles) break;
    // Reschedule from now, never from a schedule built at startup: a machine
    // that slept through six intervals wakes to exactly one refresh.
    await sleep(computeDelayMs(baseMs, failures));
  }
}

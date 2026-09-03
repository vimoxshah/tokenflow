/**
 * The watcher's single-instance lock.
 *
 * A pidfile alone cannot answer "is my watcher running?". PID numbers restart
 * at boot and the kernel reuses them, so a pidfile that outlives a reboot
 * eventually names somebody else's process. That is not hypothetical: a lock
 * left at pid 810 was inherited by `/usr/libexec/mobilerepaird` after a
 * restart, `kill(810, 0)` kept succeeding, and every `tokenflow watch` — from
 * the launch agent and from the menu bar's play button alike — refused to
 * start with "a watcher is already running" for days. The data silently went
 * stale behind a lock held by a phantom.
 *
 * So the lock records an IDENTITY, not just a number:
 *
 *   pid        the process to signal
 *   boot       epoch ms of the boot the pid was issued by
 *   startedAt  when the watcher took the lock (human-readable diagnostics)
 *
 * A lock is live only when the pid is alive AND its boot stamp matches this
 * boot. A pidfile from an earlier boot is stale by construction, whoever holds
 * that number now.
 *
 * Legacy bare-number pidfiles carry no boot stamp, so they fall back to asking
 * the OS who owns the number: a command line without "tokenflow" in it is
 * somebody else's process and the lock is stale.
 *
 * This module owns the lock so that both the watcher and the read-only status
 * surfaces can consult it without importing each other.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { paths } from './config.js';

export const LOCK_VERSION = 2;

/**
 * Boot stamps are derived from uptime, which the OS reports in whole seconds,
 * so two readings inside one boot can differ by a second or two. Anything
 * inside this window is the same boot; a reboot moves the stamp by at least
 * the previous session's uptime.
 */
const BOOT_TOLERANCE_MS = 30000;

/** Epoch ms of the last boot. Stable to ~1s for the life of the boot. */
export function bootTimeMs() {
  return Date.now() - os.uptime() * 1000;
}

/**
 * @typedef {{pid:number, boot:number|null, startedAt:string|null, legacy:boolean}} WatchLock
 */

/** Read the lock file. Accepts both the JSON form and the legacy bare number. */
export function readLock() {
  let raw;
  try {
    raw = fs.readFileSync(paths().watchPid, 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      const pid = Number(o.pid);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      const boot = Number(o.boot);
      return {
        pid,
        boot: Number.isFinite(boot) ? boot : null,
        startedAt: typeof o.startedAt === 'string' ? o.startedAt : null,
        legacy: false,
      };
    } catch {
      return null;
    }
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, boot: null, startedAt: null, legacy: true };
}

/** Just the pid, for callers that only want to signal it. */
export function readLockPid() {
  return readLock()?.pid ?? null;
}

/** Does SOME process hold this pid? (EPERM = alive, owned by someone else.) */
export function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * The command line behind a pid, or null when the OS will not say.
 * Cheap enough for lock checks; never called in a loop.
 */
export function processCommand(pid) {
  try {
    if (process.platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.replace(/\0/g, ' ').trim() || null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Is this lock held by a live watcher of OURS?
 *
 * @param {WatchLock|null} lock
 */
export function lockIsLive(lock) {
  if (!lock || !processAlive(lock.pid)) return false;
  if (lock.boot !== null) {
    return Math.abs(lock.boot - bootTimeMs()) <= BOOT_TOLERANCE_MS;
  }
  // No boot stamp to check: ask who owns the number instead. When the OS
  // will not say, keep the lock — refusing to start is safer than two
  // watchers racing on one store.
  const cmd = processCommand(lock.pid);
  if (cmd === null) return true;
  return /tokenflow/i.test(cmd);
}

/** Write this process in as the lock holder. */
export function writeLock() {
  fs.writeFileSync(
    paths().watchPid,
    `${JSON.stringify({
      v: LOCK_VERSION,
      pid: process.pid,
      boot: Math.round(bootTimeMs()),
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

/** Remove the lock file. */
export function clearLock() {
  try {
    fs.unlinkSync(paths().watchPid);
    return true;
  } catch {
    return false; // already gone — that is fine
  }
}

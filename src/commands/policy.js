/**
 * `tokenflow policy` — show the effective guard policy (personal < repo <
 * org ceiling), and refresh the cached org policy from a team server.
 *
 *   tokenflow policy show [--cwd <dir>] [--json]   the effective policy and each value's source
 *   tokenflow policy pull [--force]                 fetch <sync.to>/api/policy now
 *
 * `pull` is the ONLY thing in this file that makes a network call.
 * `refreshOrgPolicyIfStale()` wraps it for a caller (the watcher, or
 * `tokenflow refresh`) that wants the cache kept current on its own schedule
 * without ever blocking on the network itself — see the module doc on
 * `src/core/policy.js` and docs/policy.md.
 */
import path from 'node:path';
import { loadConfig, homeDir } from '../core/config.js';
import { effectivePolicy, fetchOrgPolicy, loadOrgPolicy, GUARD_KEYS } from '../core/policy.js';

/**
 * The effective policy for one directory — the same computation `guard`
 * uses to judge a session, exposed here for `policy show` and for anything
 * else that wants to display it without going through the CLI.
 * @param {{cwd?:string, config?:object, home?:string}} [opt]
 */
export function show(opt = {}) {
  const cwd = opt.cwd ? path.resolve(opt.cwd) : process.cwd();
  const config = opt.config || loadConfig();
  const home = opt.home || homeDir();
  return effectivePolicy({ cwd, home, config });
}

/** Render `show()`'s result as the plain-text `guard --policy` view (same shape, same wording). */
export function renderShow(eff, cwd) {
  const lines = [
    `guard policy for ${cwd}`,
    eff.repoRoot ? `  repository        ${eff.repoRoot}` : '  repository        (none found above this directory)',
    ...GUARD_KEYS.map((k) => `  ${k.padEnd(18)} ${eff.policy[k] === null ? '—' : eff.policy[k]}  [${eff.sources[k]}]`),
  ];
  if (eff.note) lines.push(`  note              ${eff.note}`);
  const orgApplied = GUARD_KEYS.some((k) => eff.sources[k] === 'org');
  if (eff.org.found) {
    const src = (eff.org.meta && eff.org.meta.source) || eff.org.path;
    lines.push(`  org policy        ${src}${orgApplied ? ' (lowering at least one cap above)' : ' (cached; none lower than the personal/repo value)'}`);
  }
  for (const e of eff.errors) lines.push(`  ! ${e}`);
  return lines.join('\n');
}

/**
 * Fetch `<sync.to>/api/policy` now and refresh the local cache. A thin wrapper
 * over `fetchOrgPolicy` that supplies `sync.to`/`sync.token` from config —
 * everything else (TTL, atomic write, "keep the old cache on failure") lives
 * in `core/policy.js`.
 * @param {{config?:object, home?:string, force?:boolean, fetchImpl?:typeof fetch, now?:number|(()=>number)}} [opt]
 * @returns {Promise<{updated:boolean, fromCache:boolean, error:string|null}>}
 */
export async function pull(opt = {}) {
  const config = opt.config || loadConfig();
  const home = opt.home || homeDir();
  const url = config?.sync?.to || null;
  if (!url) return { updated: false, fromCache: false, error: 'no team server configured (sync.to), nothing to pull' };
  const token = config?.sync?.token || process.env.TOKENFLOW_SYNC_TOKEN || null;
  return fetchOrgPolicy({ url, token, home, fetchImpl: opt.fetchImpl, now: opt.now, force: !!opt.force });
}

/**
 * Refresh the cached org policy only if the TTL has elapsed (or there is no
 * cache yet) — safe to call every cycle from `tokenflow watch` or
 * `tokenflow refresh`. Never throws, and does nothing (not even check the
 * cache's age) when no team server is configured, so a machine that never
 * opted into a team server pays zero cost for this. Not yet wired into
 * either caller — the intended call sites are `runCycle()` in
 * `src/core/watch.js` and `cmdRefresh()` in `bin/tokenflow.js`.
 * @param {{config?:object, home?:string, fetchImpl?:typeof fetch, now?:number|(()=>number), ttlSeconds?:number}} [opt]
 * @returns {Promise<{skipped:true}|{updated:boolean, fromCache:boolean, error:string|null}>}
 */
export async function refreshOrgPolicyIfStale(opt = {}) {
  const config = opt.config || loadConfig();
  const url = config?.sync?.to || null;
  if (!url) return { skipped: true };
  const home = opt.home || homeDir();
  const token = config?.sync?.token || process.env.TOKENFLOW_SYNC_TOKEN || null;
  try {
    return await fetchOrgPolicy({ url, token, home, fetchImpl: opt.fetchImpl, now: opt.now, ttlSeconds: opt.ttlSeconds });
  } catch (err) {
    return { updated: false, fromCache: false, error: err.message };
  }
}

/**
 * CLI entry for `tokenflow policy <show|pull>`.
 * @param {object} flags parsed CLI flags, plus `action` ('show' | 'pull', default 'show')
 * @returns {Promise<{stdout:string|null, stderr:string|null, exitCode:number}>}
 */
export async function run(flags = {}) {
  const action = flags.action || 'show';
  const config = loadConfig();
  const home = homeDir();

  if (action === 'pull') {
    const res = await pull({ config, home, force: !!flags.force });
    if (res.error) {
      const hasCache = loadOrgPolicy(home).found;
      const msg = `tokenflow policy pull: ${res.error}`;
      if (!hasCache) return { stdout: null, stderr: msg, exitCode: 1 };
      return { stdout: `${msg} (keeping the cached policy)`, stderr: null, exitCode: 0 };
    }
    const state = res.updated ? 'updated' : res.fromCache ? 'unchanged (cache still within TTL, no fetch made)' : 'unchanged (server has nothing new)';
    return { stdout: `org policy: ${state}`, stderr: null, exitCode: 0 };
  }

  const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();
  const eff = show({ cwd, config, home });
  if (flags.json) return { stdout: JSON.stringify(eff, null, 2), stderr: null, exitCode: 0 };
  return { stdout: renderShow(eff, cwd), stderr: null, exitCode: 0 };
}

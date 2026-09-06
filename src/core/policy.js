/**
 * Guard policy — three layers, each one a ceiling on the layer beneath it.
 *
 * A cap declared with `tokenflow guard --set` lives in ~/.tokenflow/config.yaml:
 * one machine, one person ("personal"). A repository-level cap travels with
 * the repo itself (checked in, reviewed in a PR, the same for everyone who
 * clones it — `.tokenflow/policy.yaml`) and wins over the personal default —
 * a data-heavy repo's sessions legitimately carry a bigger prompt than a
 * docs repo's, and that is a fact about the repo, not about who happens to be
 * sitting at the keyboard. An org layer sits above both: a cap the team
 * declares on a team server (`GET <sync.to>/api/policy`), cached locally, and
 * applied as a CEILING — it can only lower an effective max* (or warn*)
 * value, never raise one. The guard NEVER fetches this cache itself; it reads
 * whatever `tokenflow policy pull` (or the watcher, on its own schedule) last
 * wrote, so a session is never blocked on the network.
 *
 * Nothing here throws on a malformed file: a broken policy.yaml (repo or
 * cached org) degrades to "reported, not applied" — the same posture the
 * rest of TokenFlow takes toward bad input — rather than breaking the hook
 * it is meant to configure.
 *
 * A repository's `.tokenflow/policy.yaml` also carries a `receipt:` block —
 * `receipt.maxCostUsd`, `receipt.maxCostPer100Lines` — parsed and validated
 * here with the same posture, but never merged into `effectivePolicy()`:
 * those two names are a contract with the Action and App streams (which read
 * them directly off `loadRepoPolicy()`), not inputs to the in-session guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.js';
import { repoRootOf } from './repo.js';
import { loadConfig, homeDir } from './config.js';

/** The five thresholds `evaluateGuard` understands. Canonical list — guard.js re-exports this. */
export const GUARD_KEYS = ['warnCostUsd', 'maxCostUsd', 'warnContextTokens', 'maxContextTokens', 'warnMarginalUsd'];

/**
 * The two `receipt:` keys a repo's policy.yaml may declare. A contract with
 * the Action and App streams — do not rename these.
 */
export const RECEIPT_KEYS = ['maxCostUsd', 'maxCostPer100Lines'];

const POLICY_RELATIVE_PATH = path.join('.tokenflow', 'policy.yaml');
const ORG_DIR = 'policy';
const ORG_POLICY_FILE = 'org.yaml';
const ORG_META_FILE = 'org.meta.json';

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Where the cached org policy lives: `<TOKENFLOW_HOME>/policy/org.yaml`. */
export function orgPolicyPath(home) {
  return path.join(home, ORG_DIR, ORG_POLICY_FILE);
}

/** Where the org cache's metadata (`{fetchedAt, source, etag?}`) lives, beside `org.yaml`. */
export function orgMetaPath(home) {
  return path.join(home, ORG_DIR, ORG_META_FILE);
}

/**
 * Validate one block (`guard:` or `receipt:`) against its known key list.
 * An unknown key or an invalid value is reported in `errors` and dropped —
 * never thrown, and never allowed to take the rest of the block down with it.
 */
function parseKeyedBlock(raw, keys, blockName, label, errors) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'note') continue; // accepted alongside guard's thresholds; handled separately
    if (!keys.includes(k)) { errors.push(`${label}: unknown ${blockName} key "${k}"`); continue; }
    if (v === null || v === undefined) continue; // not declared
    if (!isPositiveNumber(v)) { errors.push(`${label}: ${blockName}.${k} must be a positive number, got ${JSON.stringify(v)}`); continue; }
    out[k] = v;
  }
  return out;
}

/** Read a policy YAML file's raw text, tolerating "does not exist" and "unparsable" without throwing. */
function readPolicyYaml(file) {
  if (!fs.existsSync(file)) return { doc: null, missing: true, errors: [] };
  try {
    return { doc: parseYaml(fs.readFileSync(file, 'utf8')) || {}, missing: false, errors: [] };
  } catch (err) {
    return { doc: null, missing: false, errors: [`${file}: ${err.message}`] };
  }
}

/** Turn a parsed YAML document into `{guard, receipt, note, errors}` — shared by the repo file and the org cache. */
function parsePolicyDoc(doc, label) {
  const errors = [];
  const guard = parseKeyedBlock(doc.guard, GUARD_KEYS, 'guard', label, errors);
  const receipt = parseKeyedBlock(doc.receipt, RECEIPT_KEYS, 'receipt', label, errors);

  // `note:` can sit at the top level or beside the guard block — accept both
  // rather than guess which one a hand-written file used.
  const rawGuard = doc.guard && typeof doc.guard === 'object' && !Array.isArray(doc.guard) ? doc.guard : {};
  const noteRaw = doc.note !== undefined ? doc.note : rawGuard.note;
  let note = null;
  if (noteRaw !== undefined && noteRaw !== null) {
    if (typeof noteRaw === 'string') note = noteRaw;
    else errors.push(`${label}: note must be a string`);
  }

  return { guard, receipt, note, errors };
}

const EMPTY_DOC = { guard: {}, receipt: {}, note: null, errors: [] };

/**
 * Read `<repo root>/.tokenflow/policy.yaml`, if this cwd sits inside a
 * repository and that file exists. Invalid values are reported in `errors`
 * and left out of `guard`/`receipt`, never thrown — a typo in a checked-in
 * policy file must not take the hook down for everyone who clones the repo.
 * @param {string|null|undefined} cwd
 * @returns {{repoRoot:string|null, path:string|null, found:boolean, guard:object, receipt:object, note:string|null, errors:string[]}}
 */
export function loadRepoPolicy(cwd) {
  const repoRoot = cwd ? repoRootOf(cwd) : null;
  if (!repoRoot) return { repoRoot: null, path: null, found: false, ...EMPTY_DOC };

  const file = path.join(repoRoot, POLICY_RELATIVE_PATH);
  const { doc, missing, errors: readErrors } = readPolicyYaml(file);
  if (missing) return { repoRoot, path: file, found: false, ...EMPTY_DOC };
  if (!doc) return { repoRoot, path: file, found: true, guard: {}, receipt: {}, note: null, errors: readErrors };

  const parsed = parsePolicyDoc(doc, file);
  return { repoRoot, path: file, found: true, ...parsed };
}

/**
 * Read the CACHED org policy only — never fetches. Safe to call from a
 * Claude Code hook: worst case is a missing or stale file, never a network
 * wait. Use `fetchOrgPolicy()` (from `tokenflow policy pull`, or a periodic
 * refresh) to update the cache.
 * @param {string} home TOKENFLOW_HOME
 * @returns {{path:string, found:boolean, guard:object, receipt:object, note:string|null, errors:string[], meta:{fetchedAt?:string, source?:string, etag?:string}|null}}
 */
export function loadOrgPolicy(home) {
  const file = orgPolicyPath(home);
  const meta = readJsonSafe(orgMetaPath(home));
  const { doc, missing, errors: readErrors } = readPolicyYaml(file);
  if (missing) return { path: file, found: false, ...EMPTY_DOC, meta };
  if (!doc) return { path: file, found: true, guard: {}, receipt: {}, note: null, errors: readErrors, meta };

  const parsed = parsePolicyDoc(doc, file);
  return { path: file, found: true, ...parsed, meta };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Temp-file + rename, same posture as `core/store.js`'s `writeJson`: some
 * mounts refuse rename, so fall back to writing in place rather than failing
 * the whole pull.
 */
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* leave the temp file */ }
    if (!['EPERM', 'EXDEV', 'EACCES', 'ENOTSUP', 'EBUSY'].includes(err.code)) throw err;
  }
  fs.writeFileSync(file, text);
}

/**
 * Fetch the org's `policy.yaml` from the team server and refresh the local
 * cache — the ONLY function in this module that makes a network call. The
 * guard hook never calls this; it is reached from `tokenflow policy pull`
 * and (optionally) a periodic refresh (`refreshOrgPolicyIfStale` in
 * `src/commands/policy.js`).
 *
 * Contract: `GET <url>/api/policy` returns the text of the org's
 * `policy.yaml` as `text/yaml` (404 JSON when the org has none), authenticated
 * with `Authorization: Bearer <token>` — the same auth model `sync.js` uses
 * for `/api/rollup`.
 *
 * On any failure (network error, non-2xx/404 status, unparsable body) the
 * existing cache is left exactly as it was — a bad round-trip must never
 * replace a good cache with nothing, or with garbage. A 404 means the org
 * removed its policy: the cached `org.yaml` is cleared, but `org.meta.json`
 * is still refreshed so the TTL keeps gating re-fetches (otherwise a watcher
 * with no org policy would hit the server every cycle, forever).
 *
 * @param {{url:string, token?:string|null, home:string, fetchImpl?:typeof fetch,
 *   now?:number|(()=>number), ttlSeconds?:number, force?:boolean}} opt
 *   `url` and `home` are required — there is no sensible default for either,
 *   so (unlike most `opt = {}` helpers in this project) this takes no default.
 * @returns {Promise<{updated:boolean, fromCache:boolean, error:string|null}>}
 */
export async function fetchOrgPolicy(opt) {
  const { url, token = null, home, ttlSeconds = 3600, force = false } = opt;
  if (!url) return { updated: false, fromCache: false, error: 'no org policy URL configured' };
  const fetchFn = opt.fetchImpl || globalThis.fetch;
  const nowMs = typeof opt.now === 'function' ? opt.now() : (typeof opt.now === 'number' ? opt.now : Date.now());

  const yamlFile = orgPolicyPath(home);
  const metaFile = orgMetaPath(home);
  const meta = readJsonSafe(metaFile);

  if (!force && meta && typeof meta.fetchedAt === 'string') {
    const age = nowMs - Date.parse(meta.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < ttlSeconds * 1000) {
      return { updated: false, fromCache: true, error: null };
    }
  }

  const endpoint = `${String(url).replace(/\/+$/, '')}/api/policy`;
  let res;
  try {
    res = await fetchFn(endpoint, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch (err) {
    return { updated: false, fromCache: false, error: `org policy fetch failed: ${err.message}` };
  }

  if (res.status === 404) {
    const hadCache = fs.existsSync(yamlFile);
    if (hadCache) { try { fs.rmSync(yamlFile, { force: true }); } catch { /* leave it; next pull retries */ } }
    atomicWriteText(metaFile, JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), source: url }));
    return { updated: hadCache, fromCache: false, error: null };
  }

  if (!res.ok) {
    try { await res.text(); } catch { /* drain; a server's error page is never ours to print */ }
    return { updated: false, fromCache: false, error: `org policy fetch failed: ${res.status} ${res.statusText || ''}`.trim() };
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { updated: false, fromCache: false, error: `org policy fetch failed: ${err.message}` };
  }

  // Validate before ever touching disk: a malformed body from a misbehaving
  // server must never overwrite a good cache — same "reported, never
  // applied" posture as a bad value inside the file itself.
  try {
    parseYaml(text);
  } catch (err) {
    return { updated: false, fromCache: false, error: `invalid policy.yaml from server: ${err.message}` };
  }

  const prevText = readTextSafe(yamlFile);
  const changed = prevText !== text;
  if (changed) atomicWriteText(yamlFile, text);

  const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null;
  atomicWriteText(metaFile, JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), source: url, ...(etag ? { etag } : {}) }));

  return { updated: changed, fromCache: false, error: null };
}

/**
 * Merge a repository's declared policy over `config.guard`: the repo wins
 * key-by-key, the personal config is the fallback, and an undeclared key is
 * `null` — informational only, the same contract `evaluateGuard` already has.
 *
 * This function is unchanged by the org layer (see `effectivePolicy` for
 * that) — kept exactly as-is so every existing caller/test keeps working.
 * @param {{cwd?:string|null, config?:object}} [opt]
 * @returns {{policy:object, sources:Record<string,'repo'|'config'|'default'>, repoRoot:string|null, note:string|null, errors:string[]}}
 */
export function effectiveGuardPolicy({ cwd = null, config } = {}) {
  const cfg = config || loadConfig();
  const repo = loadRepoPolicy(cwd);
  const cfgGuard = cfg.guard || {};
  const policy = {};
  /** @type {Record<string, 'repo'|'config'|'default'>} */
  const sources = {};
  for (const k of GUARD_KEYS) {
    if (isPositiveNumber(repo.guard[k])) {
      policy[k] = repo.guard[k];
      sources[k] = 'repo';
    } else if (isPositiveNumber(cfgGuard[k])) {
      policy[k] = cfgGuard[k];
      sources[k] = 'config';
    } else {
      policy[k] = null;
      sources[k] = 'default';
    }
  }
  return { policy, sources, repoRoot: repo.repoRoot, note: repo.note, errors: repo.errors };
}

/**
 * The full three-layer policy: personal (`config.guard`) < repo
 * (`.tokenflow/policy.yaml`, wins over personal — same as `effectiveGuardPolicy`)
 * < org (the cached team-server policy, applied as a CEILING). For each of
 * the five `GUARD_KEYS`, the org's declared value only ever LOWERS the
 * effective cap — `Math.min(layerValue, orgValue)` — never raises one; a
 * key the org does not declare leaves the personal/repo value untouched.
 *
 * Reads the org cache only (`loadOrgPolicy`) — never fetches. Use
 * `tokenflow policy pull` (or a periodic `refreshOrgPolicyIfStale`) to keep
 * that cache current; this function's job is to apply whatever is already
 * on disk, instantly, so a guard hook is never blocked on the network.
 * @param {{cwd?:string|null, home?:string|null, config?:object}} [opt]
 * @returns {{policy:object, sources:Record<string,'personal'|'repo'|'org'|'default'>,
 *   repoRoot:string|null, note:string|null, errors:string[],
 *   org:{found:boolean, path:string, meta:object|null}}}
 */
export function effectivePolicy({ cwd = null, home = null, config } = {}) {
  const cfg = config || loadConfig();
  const base = effectiveGuardPolicy({ cwd, config: cfg });
  const resolvedHome = home || homeDir();
  const org = loadOrgPolicy(resolvedHome);

  const policy = {};
  /** @type {Record<string, 'personal'|'repo'|'org'|'default'>} */
  const sources = {};
  for (const k of GUARD_KEYS) {
    const baseValue = base.policy[k];
    const baseSource = base.sources[k] === 'config' ? 'personal' : base.sources[k];
    const orgValue = isPositiveNumber(org.guard[k]) ? org.guard[k] : null;

    if (orgValue === null) {
      policy[k] = baseValue;
      sources[k] = baseSource;
    } else if (baseValue === null || orgValue < baseValue) {
      policy[k] = orgValue;
      sources[k] = 'org';
    } else {
      policy[k] = baseValue;
      sources[k] = baseSource;
    }
  }

  return {
    policy,
    sources,
    repoRoot: base.repoRoot,
    note: base.note,
    errors: [...base.errors, ...org.errors],
    org: { found: org.found, path: org.path, meta: org.meta },
  };
}

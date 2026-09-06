/**
 * Per-repository guard policy — `.tokenflow/policy.yaml` at a repository root.
 *
 * A cap declared with `tokenflow guard --set` lives in ~/.tokenflow/config.yaml:
 * one machine, one person. A repository-level cap travels with the repo itself
 * (checked in, reviewed in a PR, the same for everyone who clones it) and wins
 * over the personal default — a data-heavy repo's sessions legitimately carry a
 * bigger prompt than a docs repo's, and that is a fact about the repo, not
 * about who happens to be sitting at the keyboard.
 *
 * Nothing here throws on a malformed file: a broken policy.yaml degrades to
 * "reported, not applied" — the same posture the rest of TokenFlow takes
 * toward bad input — rather than breaking the hook it is meant to configure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.js';
import { repoRootOf } from './repo.js';
import { loadConfig } from './config.js';

/** The five thresholds `evaluateGuard` understands. Canonical list — guard.js re-exports this. */
export const GUARD_KEYS = ['warnCostUsd', 'maxCostUsd', 'warnContextTokens', 'maxContextTokens', 'warnMarginalUsd'];

const POLICY_RELATIVE_PATH = path.join('.tokenflow', 'policy.yaml');

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Read `<repo root>/.tokenflow/policy.yaml`, if this cwd sits inside a
 * repository and that file exists. Invalid values are reported in `errors`
 * and left out of `guard`, never thrown — a typo in a checked-in policy file
 * must not take the hook down for everyone who clones the repo.
 * @param {string|null|undefined} cwd
 * @returns {{repoRoot:string|null, path:string|null, found:boolean, guard:object, note:string|null, errors:string[]}}
 */
export function loadRepoPolicy(cwd) {
  const errors = [];
  const repoRoot = cwd ? repoRootOf(cwd) : null;
  if (!repoRoot) return { repoRoot: null, path: null, found: false, guard: {}, note: null, errors };

  const file = path.join(repoRoot, POLICY_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { repoRoot, path: file, found: false, guard: {}, note: null, errors };

  let doc;
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    errors.push(`${file}: ${err.message}`);
    return { repoRoot, path: file, found: true, guard: {}, note: null, errors };
  }

  const rawGuard = doc.guard && typeof doc.guard === 'object' && !Array.isArray(doc.guard) ? doc.guard : {};
  const guard = {};
  for (const [k, v] of Object.entries(rawGuard)) {
    if (k === 'note') continue; // accepted alongside the thresholds; handled below
    if (!GUARD_KEYS.includes(k)) { errors.push(`${file}: unknown guard key "${k}"`); continue; }
    if (v === null || v === undefined) continue; // not declared
    if (!isPositiveNumber(v)) { errors.push(`${file}: guard.${k} must be a positive number, got ${JSON.stringify(v)}`); continue; }
    guard[k] = v;
  }

  // `note:` can sit at the top level or beside the guard block — accept both
  // rather than guess which one a hand-written file used.
  const noteRaw = doc.note !== undefined ? doc.note : rawGuard.note;
  let note = null;
  if (noteRaw !== undefined && noteRaw !== null) {
    if (typeof noteRaw === 'string') note = noteRaw;
    else errors.push(`${file}: note must be a string`);
  }

  return { repoRoot, path: file, found: true, guard, note, errors };
}

/**
 * Merge a repository's declared policy over `config.guard`: the repo wins
 * key-by-key, the personal config is the fallback, and an undeclared key is
 * `null` — informational only, the same contract `evaluateGuard` already has.
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

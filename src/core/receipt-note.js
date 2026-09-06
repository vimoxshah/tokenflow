/**
 * Receipts as git notes — a branch's TokenFlow receipt attached to the commit
 * being pushed, under `refs/notes/tokenflow`, so it travels with the code
 * with no server involved. `src/commands/hooks.js` is the only caller in this
 * package (the pre-push hook body); everything here also works standalone.
 *
 * Every `git` invocation uses `execFileSync` with an argument array — never a
 * shell string — so a branch name or path can never be interpreted as shell
 * syntax.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, loadConfig } from './config.js';
import { readJson } from './store.js';
import { buildPriceBook } from './pricing.js';
import { repoRootOf, makeRepoResolver } from './repo.js';
import { loadRepoPolicy } from './policy.js';
import { buildReceipts, toReceiptV1 } from '../analytics/receipt.js';
import { loadPrimaryRecords } from '../commands/receipt.js';

/** The git notes ref every receipt note in this package lives under. */
export const NOTES_REF = 'tokenflow';

/** This package's own version, read from its package.json (not the target repo's). */
function toolVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0'; // package.json missing or unreadable: still return a usable receipt
  }
}

function resolveSha(repoPath, branch) {
  return execFileSync('git', ['rev-parse', `refs/heads/${branch}`], {
    cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Compute the receipt.v1 object for one branch of one repository checkout.
 * Scans every primary record this machine has recorded, then narrows to the
 * repository identified from `repoPath` (the same worktree-aware resolution
 * `tokenflow receipt` uses) and to the named branch.
 *
 * No pull request is looked up here — attaching a note happens at push time,
 * before any PR necessarily exists — so the returned receipt always carries
 * `pr: null` and `changedLines: null`.
 *
 * v1 adds two fields on top of v0 (docs/receipt-schema.md): the `ticket` the
 * branch name names, resolved with the user's own `tickets:` config, and the
 * `verdict` against the `receipt:` caps that repository committed in its
 * `.tokenflow/policy.yaml`. A reader that only knows v0 is unaffected —
 * `validateReceipt()` dispatches on `schemaVersion`, and every field v0
 * requires is still present and unmoved.
 *
 * @param {{repoPath:string, branch:string, store?:import('./store.js').Store,
 *   config?:object, sha?:string}} opt
 *   `config` is the pricing-overrides object (the shape of pricing.json /
 *   buildPriceBook's argument); defaults to what's on disk. The `tickets:`
 *   block is read from the user's own config.yaml, not from here. `sha`
 *   defaults to `git rev-parse refs/heads/<branch>` in repoPath.
 * @returns {object|null} a receipt.v1 object, or null when this branch has no local sessions
 */
export function buildBranchReceipt({ repoPath, branch, store, config, sha }) {
  const pricingConfig = config || readJson(paths().pricing, {});
  const book = buildPriceBook(pricingConfig);
  const repoRoot = repoRootOf(repoPath) || repoPath;
  const repoName = path.basename(repoRoot);

  const records = loadPrimaryRecords({ store });
  const result = buildReceipts(records, {
    book, repoOf: makeRepoResolver(), minTurns: 1, tickets: loadConfig().tickets || {},
  });
  const R = result.repos.find((r) => r.repo === repoName);
  const b = R ? R.branches.find((x) => x.key === branch) : null;
  if (!b) return null;

  const headSha = sha || resolveSha(repoPath, branch);
  const caps = loadRepoPolicy(repoRoot).receipt;
  return toReceiptV1(b, { repo: repoName, headSha, toolVersion: toolVersion() }, { caps });
}

/**
 * Attach `receipt` to `sha` as a git note under refs/notes/tokenflow,
 * overwriting any note already there (a re-push of the same sha updates it).
 * @param {{repoPath:string, sha:string, receipt:object}} opt
 */
export function writeNote({ repoPath, sha, receipt }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenflow-note-'));
  const file = path.join(dir, 'receipt.json');
  try {
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    execFileSync('git', ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', file, sha], {
      cwd: repoPath, stdio: ['ignore', 'ignore', 'pipe'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read back the receipt attached to `sha`, or null when there isn't one.
 * @param {{repoPath:string, sha:string}} opt
 * @returns {object|null}
 */
export function readNote({ repoPath, sha }) {
  try {
    const out = execFileSync('git', ['notes', `--ref=${NOTES_REF}`, 'show', sha], {
      cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch {
    return null; // no note on this sha (or a git/JSON error) — nothing to read back
  }
}

/**
 * Push refs/notes/tokenflow to `remote`. Runs with `TOKENFLOW_HOOK_NESTED=1`
 * in the child's environment so a pre-push hook this triggers on the same
 * repo can recognize this as the nested notes push and return immediately
 * instead of recursing.
 * @param {{repoPath:string, remote:string}} opt
 */
export function pushNotes({ repoPath, remote }) {
  execFileSync('git', ['push', remote, `refs/notes/${NOTES_REF}`], {
    cwd: repoPath,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TOKENFLOW_HOOK_NESTED: '1' },
  });
}

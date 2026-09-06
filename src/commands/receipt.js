/**
 * `tokenflow receipt` — what a branch or pull request cost.
 *
 * Joins the two things only this machine has side by side: the session logs
 * (which turn ran on which branch) and the repository (which branch became
 * which pull request). The analytics live in src/analytics/receipt.js and are
 * pure; this file does the Node work — scanning the store, seeing through git
 * worktrees, and optionally asking `gh` for the merged pull requests.
 *
 *   tokenflow receipt                              every repo, top branches by spend
 *   tokenflow receipt --repo ~/code/api --gh       one repo, joined to its merged PRs
 *   tokenflow receipt --repo api --branch feat/x   one branch
 *   tokenflow receipt --repo ~/code/api --gh --pr 478 --md   a PR-comment receipt
 *   tokenflow receipt --sessions                   where the money goes across sessions
 *   tokenflow receipt --prs prs.json               PR list from `gh pr list --json ...`
 *
 * Repository identity: a worktree under `.worktrees/<x>` is the SAME repository
 * as its main checkout. The adapters record `project` as the basename of the
 * working directory, which splits one repo's spend across every worktree, so
 * this command walks up from each recorded cwd to `.git`, follows a worktree's
 * `gitdir:` pointer back to the main checkout, and names the repo by that
 * directory. No subprocess, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { paths, loadConfig } from '../core/config.js';
import { Store, decodeRecord, readJson } from '../core/store.js';
import { buildPriceBook } from '../core/pricing.js';
import { MEASUREMENT } from '../core/schema.js';
import { repoRootOf, makeRepoResolver } from '../core/repo.js';
import { loadRepoPolicy } from '../core/policy.js';
import {
  buildReceipts, sessionStats, toReceiptV1,
  renderReceiptMarkdown, renderReceiptsTable, renderSessionStats,
} from '../analytics/receipt.js';
import { csvLine } from '../export/csv.js';
import { renderReceiptCardSvg, renderSvgToPng } from '../export/receipt-card.js';

// Repository identity lives in core so the bundle can use it too; re-exported
// here because this command is where callers first met it.
export { repoRootOf, makeRepoResolver } from '../core/repo.js';

function monthsBetween(from, to) {
  if (!from && !to) return null;
  const a = (from || '2000-01-01').slice(0, 7);
  const b = (to || '2999-12-31').slice(0, 7);
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  while (y < by || (y === by && m <= bm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Stream the store's primary records, decoded, within an optional date window.
 * @param {{from?:string|null, to?:string|null, store?:Store}} [opt]
 * @returns {object[]}
 */
export function loadPrimaryRecords(opt = {}) {
  const store = opt.store || new Store();
  const months = monthsBetween(opt.from, opt.to);
  const out = [];
  store.scanRecords((o) => {
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    if (opt.from && o.d < opt.from) return;
    if (opt.to && o.d > opt.to) return;
    out.push(decodeRecord(o));
  }, months ? { months } : {});
  return out;
}

/**
 * Merged pull requests for a repository checkout, via the GitHub CLI.
 * Returns null (with a hint on the error) when `gh` is unavailable or fails.
 * @param {string} repoPath
 * @param {{limit?:number}} [opt]
 */
export function fetchMergedPrs(repoPath, opt = {}) {
  const limit = String(opt.limit || 200);
  try {
    const out = execFileSync('gh', [
      'pr', 'list', '--state', 'merged', '--limit', limit,
      '--json', 'number,headRefName,additions,deletions,title,createdAt,mergedAt',
    ], { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (err) {
    const e = /** @type {Error & {hint?:string}} */ (new Error(`could not list pull requests with gh: ${String(err.stderr || err.message).trim().split('\n')[0]}`));
    e.hint = 'Install the GitHub CLI and run `gh auth login`, or pass --prs <file.json> exported with `gh pr list --state merged --json number,headRefName,additions,deletions,title,createdAt,mergedAt`.';
    throw e;
  }
}

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** This package's own version, stamped into every portable receipt this command prints. */
function toolVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0'; // package.json missing or unreadable: still print a usable receipt
  }
}

/**
 * The commit a branch points at, or null when there is no checkout to ask.
 * `--repo <name>` names a repository without giving a path, and a receipt is
 * still worth printing without a sha, so this never throws.
 * @param {string|null} repoPath
 * @param {string} branch
 * @returns {string|null}
 */
function resolveHeadSha(repoPath, branch) {
  if (!repoPath) return null;
  try {
    return execFileSync('git', ['rev-parse', `refs/heads/${branch}`], {
      cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null; // the branch is gone locally, or this is not a git checkout
  }
}

const RECEIPT_CSV_COLUMNS = [
  'repo', 'branch', 'costUsd', 'contextShare', 'sessions', 'turns', 'subagentTurns',
  'first', 'last', 'longLived', 'prNumber', 'mergedAt', 'changedLines', 'costPer100Lines',
];

/**
 * One row per branch, across every repository in `result`.
 * @param {ReturnType<typeof buildReceipts>} result
 */
export function renderReceiptsCsv(result) {
  let out = csvLine(RECEIPT_CSV_COLUMNS);
  for (const R of result.repos) {
    for (const b of R.branches) {
      out += csvLine([
        R.repo, b.key, b.cost, b.contextShare, b.sessions, b.turns, b.subagentTurns,
        b.first, b.last, b.longLived, b.pr ? b.pr.number : null, b.pr ? b.pr.mergedAt : null,
        b.changedLines, b.costPer100Lines,
      ]);
    }
  }
  return out;
}

/**
 * @param {object} flags parsed CLI flags
 * @returns {{text:string, json:object}}
 */
export function run(flags = {}) {
  const cfg = loadConfig();
  const book = buildPriceBook(readJson(paths().pricing, {}));
  const from = typeof flags.from === 'string' ? flags.from : null;
  const to = typeof flags.to === 'string' ? flags.to : null;
  const records = loadPrimaryRecords({ from, to });

  if (flags.sessions) {
    const caps = typeof flags.cap === 'string'
      ? flags.cap.split(',').map(Number).filter((n) => n > 0)
      : undefined;
    const s = sessionStats(records, { book, caps });
    return { text: renderSessionStats(s), json: s };
  }

  // --repo: a path (has a separator or exists) or a bare repository name.
  let repoName = null;
  let repoPath = null;
  if (typeof flags.repo === 'string') {
    const p = expandHome(flags.repo);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      repoPath = fs.realpathSync(p);
      repoName = path.basename(repoRootOf(repoPath) || repoPath);
    } else {
      repoName = flags.repo;
    }
  }

  let prs = [];
  if (typeof flags.prs === 'string') {
    prs = JSON.parse(fs.readFileSync(expandHome(flags.prs), 'utf8'));
  } else if (flags.gh) {
    if (!repoPath) {
      const e = /** @type {Error & {hint?:string}} */ (new Error('--gh needs --repo <path to a checkout> so gh knows which repository to ask'));
      e.hint = 'e.g. tokenflow receipt --repo ~/code/api --gh';
      throw e;
    }
    prs = fetchMergedPrs(repoPath, { limit: Number(flags.limit) || 200 });
  }
  if (repoName) for (const p of prs) p.repo = repoName;

  const automated = typeof flags.automated === 'string' ? new RegExp(flags.automated) : null;
  const result = buildReceipts(records, {
    book,
    prs,
    repoOf: makeRepoResolver(),
    minTurns: Number(flags['min-turns']) || 1,
    automated,
    tickets: cfg.tickets || {},
  });
  if (repoName) result.repos = result.repos.filter((R) => R.repo === repoName);

  if (flags.csv) {
    return { text: renderReceiptsCsv(result), json: result };
  }

  // Single receipt: --branch <name> or --pr <number>
  const wantBranch = typeof flags.branch === 'string' ? flags.branch : null;
  const wantPr = flags.pr !== undefined && flags.pr !== true ? Number(flags.pr) : null;
  if (wantBranch || wantPr !== null) {
    for (const R of result.repos) {
      const b = R.branches.find((x) => (wantBranch && x.key === wantBranch) || (wantPr !== null && x.pr && x.pr.number === wantPr));
      if (b) {
        const md = renderReceiptMarkdown(b, { repo: R.repo, pricingVersion: book.version });
        let text = md;
        if (typeof flags.svg === 'string' || typeof flags.png === 'string') {
          const skin = cfg.ui?.skin || 'aurora';
          const mode = cfg.ui?.mode || cfg.ui?.theme || 'dark';
          const svgPath = typeof flags.svg === 'string'
            ? expandHome(flags.svg)
            : `${expandHome(flags.png)}.svg`;
          fs.writeFileSync(svgPath, renderReceiptCardSvg(b, { repo: R.repo, skin, mode }));
          text += `\n\nWrote SVG receipt card to ${svgPath}`;
          if (typeof flags.png === 'string') {
            const pngPath = expandHome(flags.png);
            // Matches renderReceiptCardSvg's own default aspect ratio (640x460).
            const res = renderSvgToPng(svgPath, pngPath, { width: 640, height: 460 });
            text += res.ok ? `\nWrote PNG receipt card to ${pngPath}` : `\n${res.message}`;
          }
        }
        // `--json` on a single receipt is the portable receipt.v1 document
        // (schemas/receipt.v1.json) — the same shape the pre-push hook
        // attaches as a git note and the Action reads back — so a script can
        // pipe it straight into anything that already speaks that schema.
        // `headSha` needs a checkout to resolve, so it is null unless --repo
        // named a path.
        const caps = repoPath ? loadRepoPolicy(repoPath).receipt : null;
        const meta = { repo: R.repo, headSha: resolveHeadSha(repoPath, b.key), toolVersion: toolVersion() };
        return { text, json: { repo: R.repo, receipt: toReceiptV1(b, meta, { caps }) } };
      }
    }
    const what = wantBranch ? `branch ${wantBranch}` : `PR #${wantPr}`;
    const e = /** @type {Error & {hint?:string}} */ (new Error(`no local sessions found for ${what}`));
    e.hint = wantPr !== null && !prs.length
      ? 'Matching a PR number needs the PR list: add --gh (with --repo <path>) or --prs <file.json>.'
      : 'Sessions on a detached HEAD or with no branch recorded cannot be attributed. `tokenflow receipt --repo <name>` lists what was.';
    throw e;
  }

  if (flags.md) {
    // Every branch as a PR-comment block, most expensive first.
    const blocks = [];
    for (const R of result.repos) for (const b of R.branches.slice(0, Number(flags.top) || 10)) blocks.push(renderReceiptMarkdown(b, { repo: R.repo, pricingVersion: book.version }));
    return { text: blocks.join('\n\n'), json: result };
  }
  return { text: renderReceiptsTable(result, { top: Number(flags.top) || 20 }), json: result };
}

/**
 * TokenFlow receipt comment — the GitHub Action body.
 *
 * On a `pull_request` event: fetch refs/notes/tokenflow, read the note
 * attached to the PR's head sha, validate it against whichever receipt schema
 * that note declares (v0 or v1 - `validateReceipt` dispatches on
 * `schemaVersion`, so a note written by an older TokenFlow keeps working), judge it
 * against a declared budget (an action input or a repo policy file), render
 * it, and upsert (PATCH if a marked comment already exists, else POST) one
 * PR comment. No note on that sha, or the event isn't a pull request: log
 * one line and exit 0 — a missing receipt is opt-in decoration, never a
 * required check. An over-budget receipt, with `fail-on-over-budget`, fails
 * the job instead — that is what lets this action gate a merge.
 *
 * Zero npm dependencies: only Node builtins plus this repo's own
 * src/analytics/receipt-schema.js, src/core/yaml.js and src/core/units.js
 * (relative imports, since the action runs from this repo's own checkout in
 * CI). Every side effect (env, fetch, git) is a parameter of run(), so tests
 * can inject fakes without touching the network or a real git remote.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceipt, renderReceiptV0Markdown } from '../src/analytics/receipt-schema.js';
import { parseYaml } from '../src/core/yaml.js';
import { usd } from '../src/core/units.js';

const API = 'https://api.github.com';

/** Returned by run() when there is nothing to judge (no event, no PR, no note, invalid receipt). */
const NO_RECEIPT = { posted: false, costUsd: null, overBudget: false, verdict: 'no receipt to judge', failJob: false };

/**
 * Read one Action input the way GitHub Actions exposes it: `INPUT_<NAME>`,
 * uppercased, with spaces (never hyphens) turned into underscores.
 * @param {object} env
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function input(env, name, fallback) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tokenflow-receipt-action',
  };
}

/**
 * Read back the receipt git attached to `sha` under `notesRef`, or null.
 * @param {{sha:string, notesRef:string, cwd:string, execFileSyncImpl?:typeof execFileSync}} opt
 * @returns {object|null}
 */
export function readNoteForSha({ sha, notesRef, cwd, execFileSyncImpl = execFileSync }) {
  try {
    const out = execFileSyncImpl('git', ['notes', `--ref=${notesRef}`, 'show', sha], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch {
    return null; // no note on this sha, or it is not valid JSON
  }
}

/**
 * Find the PR comment already carrying `marker`, if there is one.
 * @param {{fetchImpl:typeof fetch, repoFull:string, prNumber:number, token:string, marker:string}} opt
 * @returns {Promise<object|null>}
 */
export async function findExistingComment({ fetchImpl, repoFull, prNumber, token, marker }) {
  const res = await fetchImpl(`${API}/repos/${repoFull}/issues/${prNumber}/comments?per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`listing PR comments failed: ${res.status} ${await res.text()}`);
  const comments = await res.json();
  return comments.find((c) => typeof c.body === 'string' && c.body.includes(marker)) || null;
}

/**
 * Create the receipt comment, or update it in place when one already exists.
 * @param {{fetchImpl:typeof fetch, repoFull:string, prNumber:number, token:string, existing:object|null, body:string}} opt
 * @returns {Promise<object>}
 */
export async function upsertComment({ fetchImpl, repoFull, prNumber, token, existing, body }) {
  const url = existing
    ? `${API}/repos/${repoFull}/issues/comments/${existing.id}`
    : `${API}/repos/${repoFull}/issues/${prNumber}/comments`;
  const method = existing ? 'PATCH' : 'POST';
  const res = await fetchImpl(url, {
    method,
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * A finite, strictly positive number, or null for anything else (missing,
 * blank, NaN, zero, negative). A bad or absent cap is the same as no cap,
 * never a crash and never a false trigger.
 * @param {*} v
 * @returns {number|null}
 */
function positiveNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read `<cwd>/<policyFile>`'s `receipt.maxCostUsd` / `receipt.maxCostPer100Lines`.
 * A missing file, a malformed file, or a value that is not a positive number
 * all mean no cap from this source — never a crash, matching src/core/policy.js's
 * posture toward a broken checked-in file.
 * @param {{cwd:string, policyFile:string}} opt
 * @returns {{maxCostUsd:number|null, maxCostPer100Lines:number|null}}
 */
export function readPolicyCaps({ cwd, policyFile }) {
  const none = { maxCostUsd: null, maxCostPer100Lines: null };
  const file = path.join(cwd, policyFile);
  if (!fs.existsSync(file)) return none;
  try {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    const receipt = doc && typeof doc === 'object' && !Array.isArray(doc) && doc.receipt
      && typeof doc.receipt === 'object' && !Array.isArray(doc.receipt) ? doc.receipt : {};
    return {
      maxCostUsd: positiveNumber(receipt.maxCostUsd),
      maxCostPer100Lines: positiveNumber(receipt.maxCostPer100Lines),
    };
  } catch {
    return none; // malformed policy file: no cap, never a crash
  }
}

/**
 * Judge one receipt against the declared caps.
 * `overBudget` per cap requires a measured value on the receipt; a cap with
 * no matching measurement (e.g. `costPer100Lines` on a receipt with no
 * matched pull request) is reported as not evaluated rather than guessed as
 * either pass or fail.
 * @param {object} receipt a validated receipt.v0 or receipt.v1 object
 * @param {{maxCostUsd:number|null, maxCostPer100Lines:number|null}} caps
 * @returns {{overBudget:boolean, anyDeclared:boolean, heading:string|null, details:string[]}}
 */
export function judgeBudget(receipt, caps) {
  const details = [];
  let anyOver = false;
  let anyWithin = false;
  let anyDeclared = false;

  if (caps.maxCostUsd !== null) {
    anyDeclared = true;
    if (receipt.costUsd === null) {
      details.push(`cost cap ${usd(caps.maxCostUsd)} not evaluated (no priced turns on this receipt)`);
    } else if (receipt.costUsd > caps.maxCostUsd) {
      anyOver = true;
      details.push(`cost ${usd(receipt.costUsd)} is over the ${usd(caps.maxCostUsd)} cap`);
    } else {
      anyWithin = true;
      details.push(`cost ${usd(receipt.costUsd)} is within the ${usd(caps.maxCostUsd)} cap`);
    }
  }

  if (caps.maxCostPer100Lines !== null) {
    anyDeclared = true;
    if (receipt.costPer100Lines === null) {
      details.push(`per-100-lines cap ${usd(caps.maxCostPer100Lines)} not evaluated (no changed-line cost on this receipt)`);
    } else if (receipt.costPer100Lines > caps.maxCostPer100Lines) {
      anyOver = true;
      details.push(`${usd(receipt.costPer100Lines)} per 100 lines is over the ${usd(caps.maxCostPer100Lines)} cap`);
    } else {
      anyWithin = true;
      details.push(`${usd(receipt.costPer100Lines)} per 100 lines is within the ${usd(caps.maxCostPer100Lines)} cap`);
    }
  }

  const heading = anyOver ? 'Over budget' : anyWithin ? 'Within budget' : anyDeclared ? 'Budget cap not evaluated' : null;
  return { overBudget: anyOver, anyDeclared, heading, details };
}

/**
 * Write `name=value` pairs to the file at `env.GITHUB_OUTPUT`, if set.
 * Appends, because every step in a job shares the same file.
 * @param {object} env
 * @param {Record<string,string>} fields
 */
function writeGithubOutput(env, fields) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const text = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.appendFileSync(file, text);
}

/**
 * Append a markdown block to the file at `env.GITHUB_STEP_SUMMARY`, if set.
 * @param {object} env
 * @param {string} markdown
 */
function writeGithubStepSummary(env, markdown) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown + '\n');
}

/**
 * The action's entry point. Every side effect is injectable so tests never
 * touch the network or a real git remote.
 * @param {{env?:object, fetchImpl?:typeof fetch, execFileSyncImpl?:typeof execFileSync, cwd?:string}} [opt]
 * @returns {Promise<{posted:boolean, costUsd:number|null, overBudget:boolean, verdict:string, failJob:boolean}>}
 */
export async function run(opt = {}) {
  const env = opt.env || process.env;
  const fetchImpl = opt.fetchImpl || fetch;
  const execFileSyncImpl = opt.execFileSyncImpl || execFileSync;
  const cwd = opt.cwd || process.cwd();

  const token = input(env, 'token', env.GITHUB_TOKEN || '');
  const notesRef = input(env, 'notes-ref', 'tokenflow');
  const marker = input(env, 'comment-marker', '<!-- tokenflow-receipt -->');
  const maxUsdInput = input(env, 'max-usd', '');
  const maxUsdPer100LinesInput = input(env, 'max-usd-per-100-lines', '');
  const failOnOverBudget = input(env, 'fail-on-over-budget', 'true').toLowerCase() === 'true';
  const policyFile = input(env, 'policy-file', '.tokenflow/policy.yaml');

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log('tokenflow-receipt: no GITHUB_EVENT_PATH; nothing to do');
    return NO_RECEIPT;
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = payload.pull_request;
  if (!pr || !pr.head || !pr.head.sha || !pr.number) {
    console.log('tokenflow-receipt: not a pull_request event; nothing to do');
    return NO_RECEIPT;
  }
  const sha = pr.head.sha;
  const prNumber = pr.number;
  const repoFull = env.GITHUB_REPOSITORY;

  try {
    execFileSyncImpl('git', ['fetch', 'origin', `+refs/notes/${notesRef}:refs/notes/${notesRef}`], { cwd, stdio: 'ignore' });
  } catch {
    // no origin remote, offline, or nothing pushed yet: still try the local read below
  }

  const receipt = readNoteForSha({ sha, notesRef, cwd, execFileSyncImpl });
  if (!receipt) {
    console.log(`tokenflow-receipt: no receipt note on ${sha}; nothing to do`);
    return NO_RECEIPT;
  }
  const { ok, errors } = validateReceipt(receipt);
  if (!ok) {
    console.log(`tokenflow-receipt: receipt on ${sha} failed validation (${errors.join('; ')}); not posting`);
    return NO_RECEIPT;
  }

  const policyCaps = readPolicyCaps({ cwd, policyFile });
  const caps = {
    maxCostUsd: positiveNumber(maxUsdInput) !== null ? positiveNumber(maxUsdInput) : policyCaps.maxCostUsd,
    maxCostPer100Lines: positiveNumber(maxUsdPer100LinesInput) !== null ? positiveNumber(maxUsdPer100LinesInput) : policyCaps.maxCostPer100Lines,
  };
  const budget = judgeBudget(receipt, caps);
  const verdict = budget.anyDeclared ? `${budget.heading}: ${budget.details.join('; ')}` : 'No budget cap declared';
  const failJob = budget.overBudget && failOnOverBudget;

  let body = renderReceiptV0Markdown(receipt);
  if (budget.anyDeclared) {
    const [markerLine, ...rest] = body.split('\n');
    body = [markerLine, '', `**${budget.heading}**: ${budget.details.join('; ')}`, ...rest].join('\n');
  }

  const existing = await findExistingComment({ fetchImpl, repoFull, prNumber, token, marker });
  await upsertComment({ fetchImpl, repoFull, prNumber, token, existing, body });
  console.log(`tokenflow-receipt: ${existing ? 'updated' : 'posted'} the receipt comment on PR #${prNumber}`);

  writeGithubOutput(env, {
    'cost-usd': receipt.costUsd === null ? '' : String(receipt.costUsd),
    'over-budget': String(budget.overBudget),
    verdict,
  });
  writeGithubStepSummary(env, body);

  if (failJob) {
    console.log(`::error::tokenflow-receipt: over budget on PR #${prNumber} - ${verdict}`);
  }

  return { posted: true, costUsd: receipt.costUsd, overBudget: budget.overBudget, verdict, failJob };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().then((result) => {
    if (result && result.failJob) process.exitCode = 1;
  }).catch((err) => {
    console.error(`tokenflow-receipt: ${err.message}`);
    process.exitCode = 1;
  });
}

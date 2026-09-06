/**
 * TokenFlow receipt comment — the GitHub Action body.
 *
 * On a `pull_request` event: fetch refs/notes/tokenflow, read the note
 * attached to the PR's head sha, validate it against receipt.v0, render it,
 * and upsert (PATCH if a marked comment already exists, else POST) one PR
 * comment. No note on that sha, or the event isn't a pull request: log one
 * line and exit 0 — this is opt-in decoration, never a required check.
 *
 * Zero npm dependencies: only Node builtins plus this repo's own
 * src/analytics/receipt-schema.js (a relative import, since the action runs
 * from this repo's own checkout in CI). Every side effect (env, fetch, git)
 * is a parameter of run(), so tests can inject fakes without touching the
 * network or a real git remote.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceiptV0, renderReceiptV0Markdown } from '../src/analytics/receipt-schema.js';

const API = 'https://api.github.com';

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
 * The action's entry point. Every side effect is injectable so tests never
 * touch the network or a real git remote.
 * @param {{env?:object, fetchImpl?:typeof fetch, execFileSyncImpl?:typeof execFileSync, cwd?:string}} [opt]
 */
export async function run(opt = {}) {
  const env = opt.env || process.env;
  const fetchImpl = opt.fetchImpl || fetch;
  const execFileSyncImpl = opt.execFileSyncImpl || execFileSync;
  const cwd = opt.cwd || process.cwd();

  const token = input(env, 'token', env.GITHUB_TOKEN || '');
  const notesRef = input(env, 'notes-ref', 'tokenflow');
  const marker = input(env, 'comment-marker', '<!-- tokenflow-receipt -->');

  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log('tokenflow-receipt: no GITHUB_EVENT_PATH; nothing to do');
    return;
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = payload.pull_request;
  if (!pr || !pr.head || !pr.head.sha || !pr.number) {
    console.log('tokenflow-receipt: not a pull_request event; nothing to do');
    return;
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
    return;
  }
  const { ok, errors } = validateReceiptV0(receipt);
  if (!ok) {
    console.log(`tokenflow-receipt: receipt on ${sha} failed validation (${errors.join('; ')}); not posting`);
    return;
  }

  const body = renderReceiptV0Markdown(receipt);
  const existing = await findExistingComment({ fetchImpl, repoFull, prNumber, token, marker });
  await upsertComment({ fetchImpl, repoFull, prNumber, token, existing, body });
  console.log(`tokenflow-receipt: ${existing ? 'updated' : 'posted'} the receipt comment on PR #${prNumber}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().catch((err) => {
    console.error(`tokenflow-receipt: ${err.message}`);
    process.exitCode = 1;
  });
}

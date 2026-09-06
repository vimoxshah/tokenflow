/**
 * A self-hosted GitHub App receiver — the pure half.
 *
 * We host nothing. A customer runs `tokenflow team serve` on a machine they
 * own, registers their OWN GitHub App against it, and this module is what
 * that server calls once a delivery arrives. Everything here is a plain
 * function: `fetch` is injected and the API base URL is injected, so the
 * tests drive it against a mock server on localhost and GitHub Enterprise
 * Server works by pointing `apiUrl` at `https://<host>/api/v3`.
 *
 * What it does with a pull request:
 *   1. resolve `refs/notes/<ref>` to its commit, that commit's tree, and the
 *      blob whose path is the head sha (git fans a notes tree out once it
 *      grows, so the path may be `ab/cdef…` or deeper);
 *   2. decode that blob and validate it against whichever receipt schema it
 *      declares — `validateReceipt()` in `src/analytics/receipt-schema.js`
 *      dispatches on `schemaVersion`, so a v1 note from today's pre-push hook
 *      and a v0 note already pushed to an older repository both work;
 *   3. upsert ONE PR comment, found by the same `<!-- tokenflow-receipt -->`
 *      marker the Action uses, rendered by the same renderer;
 *   4. upsert ONE "TokenFlow spend" check run: neutral while no receipt has
 *      landed, failure when the repo's own `.tokenflow/policy.yaml` declares
 *      a cap the receipt is over, success otherwise.
 *
 * Two deliveries for the same pull request routinely overlap, because the
 * pre-push hook pushes the branch and then pushes `refs/notes/<ref>` as a
 * second ref: the `pull_request` event arrives first and finds no note, and
 * the notes `push` arrives moments later. Work for one pull request is
 * therefore serialized through `createReceiverQueue()`, and a handler that
 * found no note looks once more, without its cached tree index, right before
 * it would stamp a neutral check. Between them a late note always wins, so a
 * green check is never overwritten by a stale neutral one.
 *
 * Nothing here is persisted. A receipt is read, rendered, posted back to the
 * repository it came from, and dropped: the team server keeps no copy. No
 * request or response body is ever logged — errors carry a method, a URL and
 * a status code, never a payload.
 */
import crypto from 'node:crypto';
import { parseYaml } from './yaml.js';
import { usd } from './units.js';
import * as receiptSchema from '../analytics/receipt-schema.js';

/** github.com. A GitHub Enterprise Server is `https://<host>/api/v3`. */
export const DEFAULT_API_URL = 'https://api.github.com';
/** The git notes ref receipts are attached to (`src/core/receipt-note.js`). */
export const DEFAULT_NOTES_REF = 'tokenflow';
/** The one check run this receiver publishes. */
export const CHECK_NAME = 'TokenFlow spend';
/** The marker that identifies our own PR comment, shared with action/index.js. */
export const RECEIPT_MARKER = '<!-- tokenflow-receipt -->';
/** Where a repository declares its own caps, relative to the repo root. */
export const POLICY_PATH = '.tokenflow/policy.yaml';

/** The `pull_request` actions worth a receipt: the head sha is new or newly interesting. */
const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
/** Backdated to absorb clock drift between this machine and GitHub, per GitHub's own examples. */
const JWT_BACKDATE_SECONDS = 60;
/** Under GitHub's 10-minute ceiling with a minute to spare. */
const JWT_LIFETIME_SECONDS = 540;
/**
 * A notes ref is interpolated into the API path rather than escaped (a `/`
 * inside it is meaningful), so the shape is checked instead: slash-separated
 * segments that each start with a letter or digit. That rules out a leading
 * slash, a trailing slash, an empty segment (`//`) and a `.`-only segment;
 * `..` is rejected separately, since it is legal inside a segment by this
 * pattern but is neither a valid git ref name nor safe in a URL path.
 */
const NOTES_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const NOTES_REF_MAX = 100;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'tokenflow-team-server';
/**
 * How many pages of a list endpoint to walk before giving up. 20 pages of 100
 * is 2000 comments or 2000 open pull requests; past that the receipt comment
 * is not found and a fresh one is posted rather than the walk running forever.
 */
const MAX_LIST_PAGES = 20;
const PER_PAGE = 100;

/** True when `ref` is a git ref name safe to interpolate into an API path. */
function isSafeNotesRef(ref) {
  const s = String(ref);
  return s.length > 0 && s.length <= NOTES_REF_MAX && !s.includes('..') && NOTES_REF_RE.test(s);
}

// ----------------------------------------------------------- webhook auth ---

/**
 * Constant-time check of GitHub's `X-Hub-Signature-256` header over the raw
 * request bytes. The body MUST be the bytes as received: re-serializing the
 * parsed JSON changes the digest.
 * @param {{secret:string, rawBody:Buffer|string, signatureHeader:string|null|undefined}} opt
 * @returns {boolean}
 */
export function verifyWebhookSignature({ secret, rawBody, signatureHeader }) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const expected = Buffer.from(`sha256=${digest}`, 'utf8');
  const got = Buffer.from(signatureHeader, 'utf8');
  // timingSafeEqual throws on a length mismatch, and a wrong length is not a
  // secret worth protecting: it is visible from the header itself.
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

// -------------------------------------------------------------- app auth ---

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A signed RS256 JWT that authenticates as the App itself (not an
 * installation). Issued 60 seconds in the past for clock drift and expiring
 * inside GitHub's 10-minute maximum.
 * @param {{appId:string|number, privateKeyPem:string, now?:number}} opt `now` is epoch milliseconds
 * @returns {string}
 */
export function appJwt({ appId, privateKeyPem, now = Date.now() }) {
  if (appId === undefined || appId === null || String(appId) === '') throw new Error('appJwt: appId is required');
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('appJwt: privateKeyPem must be a PEM-encoded RSA private key');
  }
  const seconds = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iat: seconds - JWT_BACKDATE_SECONDS,
    exp: seconds + JWT_LIFETIME_SECONDS,
    iss: String(appId),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${b64url(signer.sign(privateKeyPem))}`;
}

/**
 * Trade the App JWT for a short-lived installation access token. GitHub
 * expires these an hour after issue, so one is minted per delivery and
 * dropped afterwards rather than cached.
 * @param {{apiUrl?:string, appId:string|number, privateKeyPem:string, installationId:string|number,
 *   fetchImpl?:typeof fetch, now?:number}} opt
 * @returns {Promise<{token:string, expiresAt:string|null}>}
 */
export async function installationToken({ apiUrl = DEFAULT_API_URL, appId, privateKeyPem, installationId, fetchImpl = fetch, now = Date.now() }) {
  const jwt = appJwt({ appId, privateKeyPem, now });
  const url = `${trimUrl(apiUrl)}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...apiHeaders(jwt), 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.token !== 'string') throw new Error('installation access token response carried no token');
  return { token: body.token, expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null };
}

// ------------------------------------------------------------ API plumbing ---

function trimUrl(u) {
  return String(u || DEFAULT_API_URL).replace(/\/+$/, '');
}

function repoBase(apiUrl, owner, repo) {
  return `${trimUrl(apiUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
}

/**
 * One GitHub API call. Errors carry the method, URL and status only — never
 * the response body, which can hold repository content.
 * @param {{fetchImpl:typeof fetch, url:string, token:string, method?:string, body?:object|null, allow404?:boolean}} opt
 * @returns {Promise<any>} the parsed JSON, or null for an allowed 404
 */
async function githubJson({ fetchImpl, url, token, method = 'GET', body = null, allow404 = false }) {
  /** @type {RequestInit} */
  const init = { method, headers: apiHeaders(token) };
  if (body !== null) {
    init.headers = { ...apiHeaders(token), 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status}`);
  return res.json();
}

/** The `next` URL out of a GitHub `Link` header, or null when there is no next page. */
function parseNextLink(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    if (m) return m[1];
  }
  return null;
}

/**
 * Walk every page of a list endpoint, calling `onPage` with each page's items.
 * `onPage` returning true stops the walk (the receipt comment is normally on
 * page one, so a busy pull request costs one request, not twenty).
 *
 * Paging follows the `Link: rel="next"` header, which is the documented
 * contract. A server that omits it is still walked, by asking for the next
 * page number while pages keep coming back full — GitHub Enterprise Server
 * behind a proxy that strips headers is the case that matters.
 * @param {{fetchImpl:typeof fetch, url:string, token:string, onPage:(items:any[])=>boolean}} opt
 * @returns {Promise<boolean>} true when `onPage` stopped the walk
 */
async function githubPaged({ fetchImpl, url, token, onPage }) {
  let next = url;
  for (let page = 1; next && page <= MAX_LIST_PAGES; page++) {
    const res = await fetchImpl(next, { method: 'GET', headers: apiHeaders(token) });
    if (!res.ok) throw new Error(`GET ${next} failed: ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : [];
    if (onPage(items) === true) return true;

    const link = res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null;
    const fromLink = parseNextLink(link);
    if (fromLink) { next = fromLink; continue; }
    if (items.length < PER_PAGE) return false; // a short page is the last page
    const u = new URL(next);
    u.searchParams.set('page', String(page + 1));
    next = u.toString();
  }
  return false;
}

// --------------------------------------------------------------- receipts ---

/**
 * Validate a decoded note against the schema this build speaks.
 * `src/analytics/receipt-schema.js` now ships `validateReceipt`, which
 * dispatches on `schemaVersion`, so this receiver accepts both the v1 notes
 * the pre-push hook writes today and the v0 notes already pushed to older
 * repositories. The fallback below is kept for a build of that module that
 * predates the dispatcher.
 * @param {*} obj
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateReceipt(obj) {
  const mod = /** @type {any} */ (receiptSchema);
  if (typeof mod.validateReceipt === 'function') return mod.validateReceipt(obj);
  return receiptSchema.validateReceiptV0(obj);
}

/**
 * Render a receipt the way the Action renders it, so the comment a customer
 * sees is byte-identical whichever path posted it.
 * @param {object} receipt
 * @returns {string}
 */
function renderReceipt(receipt) {
  return receiptSchema.renderReceiptV0Markdown(receipt);
}

/**
 * The whole `refs/notes/<ref>` tree as `annotated sha -> blob sha`.
 *
 * git stores a note under the sha of the object it annotates, and fans that
 * name out into directories once the tree grows: `abcdef…` becomes `ab/cdef…`
 * and, on a very large repository, `ab/cd/ef…`. Joining a path's components
 * back together handles every depth with one comparison instead of guessing
 * at the fanout in use.
 * @param {{apiUrl?:string, token:string, owner:string, repo:string, notesRef?:string, fetchImpl?:typeof fetch}} opt
 * @returns {Promise<{index:Map<string,string>|null, reason:string}>}
 */
export async function readNotesIndex({ apiUrl = DEFAULT_API_URL, token, owner, repo, notesRef = DEFAULT_NOTES_REF, fetchImpl = fetch }) {
  if (!isSafeNotesRef(notesRef)) return { index: null, reason: 'bad-notes-ref' };
  const base = repoBase(apiUrl, owner, repo);

  const ref = await githubJson({ fetchImpl, token, url: `${base}/git/ref/notes/${notesRef}`, allow404: true });
  if (!ref || !ref.object || typeof ref.object.sha !== 'string') return { index: null, reason: 'no-notes-ref' };

  const commit = await githubJson({ fetchImpl, token, url: `${base}/git/commits/${ref.object.sha}`, allow404: true });
  if (!commit || !commit.tree || typeof commit.tree.sha !== 'string') return { index: null, reason: 'no-notes-ref' };

  const tree = await githubJson({ fetchImpl, token, url: `${base}/git/trees/${commit.tree.sha}?recursive=1`, allow404: true });
  const entries = tree && Array.isArray(tree.tree) ? tree.tree : [];
  /** @type {Map<string,string>} */
  const index = new Map();
  for (const e of entries) {
    if (!e || e.type !== 'blob' || typeof e.path !== 'string' || typeof e.sha !== 'string') continue;
    index.set(e.path.replace(/\//g, '').toLowerCase(), e.sha);
  }
  return { index, reason: tree && tree.truncated ? 'notes-tree-truncated' : 'ok' };
}

/**
 * The receipt attached to `sha` as a git note, or null with the reason why.
 *
 * Pass `index` (from `readNotesIndex`) to reuse one tree read across several
 * commits — a notes push checks every open pull request at once.
 * @param {{apiUrl?:string, token:string, owner:string, repo:string, sha:string,
 *   notesRef?:string, fetchImpl?:typeof fetch, index?:Map<string,string>|null}} opt
 * @returns {Promise<{receipt:object|null, reason:string, errors?:string[]}>}
 */
export async function readReceiptNote({ apiUrl = DEFAULT_API_URL, token, owner, repo, sha, notesRef = DEFAULT_NOTES_REF, fetchImpl = fetch, index = null }) {
  let notes = index;
  let reason = 'ok';
  if (!notes) {
    const found = await readNotesIndex({ apiUrl, token, owner, repo, notesRef, fetchImpl });
    notes = found.index;
    reason = found.reason;
    if (!notes) return { receipt: null, reason };
  }

  const blobSha = notes.get(String(sha).toLowerCase());
  if (!blobSha) return { receipt: null, reason: reason === 'notes-tree-truncated' ? 'notes-tree-truncated' : 'no-note' };

  const base = repoBase(apiUrl, owner, repo);
  const blob = await githubJson({ fetchImpl, token, url: `${base}/git/blobs/${blobSha}`, allow404: true });
  if (!blob || typeof blob.content !== 'string') return { receipt: null, reason: 'no-note' };
  const text = blob.encoding === 'base64' || blob.encoding === undefined
    ? Buffer.from(blob.content, 'base64').toString('utf8')
    : blob.content;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { receipt: null, reason: 'unparsable' }; // a note that is not JSON is not ours to render
  }
  const { ok, errors } = validateReceipt(parsed);
  if (!ok) return { receipt: null, reason: 'invalid', errors };
  return { receipt: parsed, reason: 'ok' };
}

// ----------------------------------------------------------------- policy ---

/**
 * A finite, strictly positive number, or null for anything else. Mirrors the
 * Action's own reader (action/index.js) so a cap written as `"25"` in YAML
 * means the same thing on both paths.
 */
function positiveNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The repository's own receipt caps, read from `.tokenflow/policy.yaml` at
 * `ref` through the Contents API.
 *
 * The caps live in a top-level `receipt:` block, NOT in `guard:` — `guard:`
 * holds the five per-session live thresholds and `src/core/policy.js` reports
 * any other key there as an error, so a whole-receipt cap declared there
 * would make every clone complain. `receipt.maxCostUsd` and
 * `receipt.maxCostPer100Lines` are the same two names `RECEIPT_KEYS` in
 * `src/core/policy.js` and `readPolicyCaps()` in `action/index.js` already
 * read, so one committed file drives the hook, the Action and this receiver.
 *
 *     receipt:
 *       maxCostUsd: 25
 *       maxCostPer100Lines: 4
 *
 * A missing, unreadable or malformed file means no cap, never a failed
 * check — the same posture `loadRepoPolicy` takes toward a broken policy.
 * @param {{apiUrl?:string, token:string, owner:string, repo:string, ref?:string|null, fetchImpl?:typeof fetch}} opt
 * @returns {Promise<{maxCostUsd:number|null, maxCostPer100Lines:number|null}>}
 */
export async function readRepoCap({ apiUrl = DEFAULT_API_URL, token, owner, repo, ref = null, fetchImpl = fetch }) {
  const none = { maxCostUsd: null, maxCostPer100Lines: null };
  const url = `${repoBase(apiUrl, owner, repo)}/contents/${POLICY_PATH}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;

  let file;
  try {
    file = await githubJson({ fetchImpl, token, url, allow404: true });
  } catch {
    return none; // a policy the server cannot read is no cap at all
  }
  if (!file || typeof file.content !== 'string' || (file.type && file.type !== 'file')) return none;

  let doc;
  try {
    doc = parseYaml(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    return none; // malformed YAML means no cap, never a blocked pull request
  }
  const receipt = doc && typeof doc === 'object' && !Array.isArray(doc) && doc.receipt
    && typeof doc.receipt === 'object' && !Array.isArray(doc.receipt) ? doc.receipt : {};
  return {
    maxCostUsd: positiveNumber(receipt.maxCostUsd),
    maxCostPer100Lines: positiveNumber(receipt.maxCostPer100Lines),
  };
}

// --------------------------------------------------------------- comments ---

/**
 * Post the receipt comment, or edit the one already there. Found by the same
 * marker the Action uses, so the two never post over each other.
 *
 * The search walks EVERY page of the conversation, not just the first: on a
 * pull request with more than a hundred comments ours drops off page one, and
 * a search that stopped there would post a fresh duplicate on every push. The
 * walk stops at the page the marker is on, so the usual case still costs one
 * request.
 * @param {{apiUrl?:string, token:string, owner:string, repo:string, prNumber:number,
 *   receipt:object, marker?:string, fetchImpl?:typeof fetch}} opt
 * @returns {Promise<{action:'created'|'updated', id:number|null}>}
 */
export async function upsertReceiptComment({ apiUrl = DEFAULT_API_URL, token, owner, repo, prNumber, receipt, marker = RECEIPT_MARKER, fetchImpl = fetch }) {
  const base = repoBase(apiUrl, owner, repo);
  const body = renderReceipt(receipt);

  /** @type {any} */
  let existing = null;
  await githubPaged({
    fetchImpl,
    token,
    url: `${base}/issues/${prNumber}/comments?per_page=${PER_PAGE}`,
    onPage: (items) => {
      const found = items.find((c) => c && typeof c.body === 'string' && c.body.includes(marker));
      if (!found) return false;
      existing = found;
      return true;
    },
  });

  const url = existing ? `${base}/issues/comments/${existing.id}` : `${base}/issues/${prNumber}/comments`;
  const method = existing ? 'PATCH' : 'POST';
  const out = await githubJson({ fetchImpl, token, url, method, body: { body } });
  const id = out && out.id !== undefined ? out.id : (existing ? existing.id : null);
  return { action: existing ? 'updated' : 'created', id };
}

// ------------------------------------------------------------- check runs ---

/**
 * Publish the "TokenFlow spend" check run on `headSha`, editing the one
 * already on that commit rather than stacking a second one — a pull request
 * gets a neutral check the moment it opens and the same check turns green (or
 * red) once the receipt note lands.
 * @param {{apiUrl?:string, token:string, owner:string, repo:string, headSha:string,
 *   conclusion:'success'|'failure'|'neutral', output:{title:string, summary:string},
 *   name?:string, detailsUrl?:string|null, completedAt?:string, fetchImpl?:typeof fetch}} opt
 * @returns {Promise<{action:'created'|'updated', id:number|null, conclusion:string}>}
 */
export async function publishCheckRun({ apiUrl = DEFAULT_API_URL, token, owner, repo, headSha, conclusion, output, name = CHECK_NAME, detailsUrl = null, completedAt, fetchImpl = fetch }) {
  const base = repoBase(apiUrl, owner, repo);

  let existing = null;
  try {
    const listed = await githubJson({
      fetchImpl,
      token,
      url: `${base}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
      allow404: true,
    });
    const runs = listed && Array.isArray(listed.check_runs) ? listed.check_runs : [];
    existing = runs.find((r) => r && r.name === name) || null;
  } catch {
    existing = null; // cannot list: create a new run rather than skip the check entirely
  }

  const payload = {
    name,
    head_sha: headSha,
    status: 'completed',
    completed_at: completedAt || new Date().toISOString(),
    conclusion,
    output: { title: output.title, summary: output.summary },
  };
  if (detailsUrl) payload.details_url = detailsUrl;

  const url = existing ? `${base}/check-runs/${existing.id}` : `${base}/check-runs`;
  const method = existing ? 'PATCH' : 'POST';
  const out = await githubJson({ fetchImpl, token, url, method, body: payload });
  const id = out && out.id !== undefined ? out.id : (existing ? existing.id : null);
  return { action: existing ? 'updated' : 'created', id, conclusion };
}

// ---------------------------------------------------------------- verdict ---

const money = (v) => usd(v, 'not priced');

/**
 * What the check run should say about one receipt.
 *
 * The verdict matches `judgeBudget()` in `action/index.js` in outcome, so the
 * App and the Action never disagree about the same committed cap: a cap only
 * ever fires on a number the receipt actually carries, and a cap with no
 * matching measurement is reported as "not evaluated" rather than guessed as
 * a pass or a failure. (The two null tests are written differently — this one
 * also rejects a non-finite number — but `validateReceiptV0` refuses a NaN
 * cost, so no receipt can reach here and be judged differently.)
 * @param {{receipt:object, cap:{maxCostUsd:number|null, maxCostPer100Lines:number|null}}} opt
 * @returns {{conclusion:'success'|'failure', output:{title:string, summary:string}, breaches:string[], details:string[]}}
 */
export function evaluateCap({ receipt, cap }) {
  const breaches = [];
  const details = [];
  const cost = typeof receipt.costUsd === 'number' && Number.isFinite(receipt.costUsd) ? receipt.costUsd : null;
  const per100 = typeof receipt.costPer100Lines === 'number' && Number.isFinite(receipt.costPer100Lines) ? receipt.costPer100Lines : null;

  if (cap.maxCostUsd !== null) {
    if (cost === null) {
      details.push(`The ${money(cap.maxCostUsd)} \`receipt.maxCostUsd\` cap was not evaluated: this receipt has no priced turns.`);
    } else if (cost > cap.maxCostUsd) {
      breaches.push(`${money(cost)} is over the ${money(cap.maxCostUsd)} \`receipt.maxCostUsd\` cap in \`${POLICY_PATH}\`.`);
    } else {
      details.push(`${money(cost)} is within the ${money(cap.maxCostUsd)} \`receipt.maxCostUsd\` cap.`);
    }
  }
  if (cap.maxCostPer100Lines !== null) {
    if (per100 === null) {
      details.push(`The ${money(cap.maxCostPer100Lines)} \`receipt.maxCostPer100Lines\` cap was not evaluated: this receipt has no changed-line cost.`);
    } else if (per100 > cap.maxCostPer100Lines) {
      breaches.push(`${money(per100)} per 100 lines is over the ${money(cap.maxCostPer100Lines)} \`receipt.maxCostPer100Lines\` cap in \`${POLICY_PATH}\`.`);
    } else {
      details.push(`${money(per100)} per 100 lines is within the ${money(cap.maxCostPer100Lines)} \`receipt.maxCostPer100Lines\` cap.`);
    }
  }

  const spend = cost === null ? 'No priced spend' : `Estimated ${money(cost)}`;
  const lines = [`${spend} on \`${receipt.branch}\`, over ${receipt.sessions} session(s) and ${receipt.turns} turn(s).`];
  if (per100 !== null) lines.push(`That is ${money(per100)} per 100 changed lines.`);
  if (breaches.length || details.length) lines.push('', ...breaches, ...details);
  lines.push('', 'Estimated locally from session logs against a local price table. Never measured billing, and no prompt or code content was read.');

  const headline = cost === null ? 'Receipt attached, no priced turns' : `${money(cost)} estimated`;
  return {
    conclusion: breaches.length ? 'failure' : 'success',
    output: {
      title: breaches.length ? `Over this repository's cap: ${money(cost)}` : headline,
      summary: lines.join('\n'),
    },
    breaches,
    details,
  };
}

/**
 * What the check run says while no usable receipt exists on a commit.
 * @param {{reason:string, sha:string, notesRef:string}} opt
 * @returns {{title:string, summary:string}}
 */
export function noReceiptOutput({ reason, sha, notesRef }) {
  const ref = `refs/notes/${notesRef}`;
  const summaries = {
    'no-notes-ref': `This repository has no ${ref} yet. Install the TokenFlow pre-push hook (\`tokenflow hooks install\`) so every push attaches its receipt, then push the notes ref.`,
    'no-note': `No TokenFlow receipt is attached to \`${sha}\` yet. It appears here as soon as ${ref} carries a note for that commit.`,
    unparsable: `The note on \`${sha}\` is not valid JSON, so no receipt was published.`,
    invalid: `The note on \`${sha}\` is not a valid TokenFlow receipt, so nothing was published.`,
    'notes-tree-truncated': `The ${ref} tree is too large to read in one request, so the note for \`${sha}\` could not be located.`,
    'bad-notes-ref': 'The configured notes ref is not a usable git ref name.',
  };
  return {
    title: 'No receipt yet',
    summary: summaries[reason] || summaries['no-note'],
  };
}

// -------------------------------------------------------------- deliveries ---

/**
 * A bounded memory of `X-GitHub-Delivery` ids, so a redelivery (GitHub
 * retries, and an operator can replay by hand) does not post a second
 * comment. In memory only: a restart forgets, which costs one duplicate edit
 * of a comment that is upserted anyway.
 * @param {number} [limit] how many ids to keep, oldest dropped first
 * @returns {{remember:(id:string|null|undefined)=>boolean, size:()=>number}}
 */
export function createDeliveryMemory(limit = 1000) {
  /** @type {Set<string>} */
  const seen = new Set();
  return {
    remember(id) {
      if (typeof id !== 'string' || !id) return true; // no id to dedupe on: always process
      if (seen.has(id)) return false;
      seen.add(id);
      while (seen.size > limit) {
        const oldest = seen.values().next().value; // a Set iterates in insertion order
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      return true;
    },
    size: () => seen.size,
  };
}

/**
 * Serializes work per key, so two deliveries about the same pull request run
 * one after the other instead of racing.
 *
 * The race this exists for is the ordinary one: `tokenflow hooks install`
 * pushes the branch and then pushes `refs/notes/<ref>`, so a `pull_request`
 * delivery that finds no note is often still in flight when the notes `push`
 * delivery arrives. Unserialized, the first can PATCH a green check back to
 * neutral seconds after the second turned it green.
 *
 * A failing job never blocks the next one on the same key, and a key is
 * dropped once its chain drains, so the map does not grow per pull request
 * forever.
 * @returns {{run:<T>(key:string, fn:()=>Promise<T>)=>Promise<T>, size:()=>number}}
 */
export function createReceiverQueue() {
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  return {
    run(key, fn) {
      const prev = chains.get(key) || Promise.resolve();
      const next = prev.then(() => fn(), () => fn());
      const settled = next.then(() => {}, () => {});
      chains.set(key, settled);
      settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
      return next;
    },
    size: () => chains.size,
  };
}

// ----------------------------------------------------------------- webhook ---

/**
 * Reasons a note might simply not have arrived yet. A second look is worth an
 * API round trip for these; `invalid` and `unparsable` describe a note that IS
 * there and is broken, so re-reading it would only find the same bad blob.
 */
const RETRYABLE_MISS = new Set(['no-note', 'no-notes-ref', 'notes-tree-truncated']);

/**
 * Process one pull request end to end: read its note, read the repository's
 * caps, upsert the comment, upsert the check run.
 *
 * When the first read finds nothing, it looks once more WITHOUT the cached
 * tree index before stamping a neutral check. `index` may have been read
 * seconds ago, and in that window the pre-push hook's notes push may have
 * landed; publishing neutral on a stale read would overwrite a green check
 * with a wrong one. A late note wins.
 * @returns {Promise<{pr:number, sha:string, outcome:string}>}
 */
async function processPullRequest({ apiUrl, token, owner, repo, prNumber, headSha, notesRef, checkName, index, fetchImpl }) {
  let { receipt, reason } = await readReceiptNote({ apiUrl, token, owner, repo, sha: headSha, notesRef, fetchImpl, index });

  if (!receipt && RETRYABLE_MISS.has(reason)) {
    const late = await readReceiptNote({ apiUrl, token, owner, repo, sha: headSha, notesRef, fetchImpl, index: null });
    receipt = late.receipt;
    reason = late.reason;
  }

  if (!receipt) {
    await publishCheckRun({
      apiUrl, token, owner, repo, headSha, fetchImpl, name: checkName,
      conclusion: 'neutral',
      output: noReceiptOutput({ reason, sha: headSha, notesRef }),
    });
    return { pr: prNumber, sha: headSha, outcome: `neutral (${reason})` };
  }

  const cap = await readRepoCap({ apiUrl, token, owner, repo, ref: headSha, fetchImpl });
  const verdict = evaluateCap({ receipt, cap });
  await upsertReceiptComment({ apiUrl, token, owner, repo, prNumber, receipt, fetchImpl });
  await publishCheckRun({
    apiUrl, token, owner, repo, headSha, fetchImpl, name: checkName,
    conclusion: verdict.conclusion,
    output: verdict.output,
  });
  return { pr: prNumber, sha: headSha, outcome: verdict.conclusion };
}

/**
 * The receiver. Handles two events and ignores the rest:
 *
 *   `pull_request` opened/synchronize/reopened — the head sha is new, so read
 *     its note (there may not be one yet) and publish.
 *   `push` to `refs/notes/<ref>` — a receipt landed AFTER the pull request
 *     event, which is the common order: the note is written by the pre-push
 *     hook and pushed as a second ref. Every open pull request whose head sha
 *     now has a note is processed; the rest are left alone, so an unrelated
 *     notes push never touches a pull request it has nothing to say about.
 *
 * Idempotent per `X-GitHub-Delivery`. Nothing is persisted and no body is
 * logged: the caller's `log` receives one assembled line per pull request.
 *
 * Pass the SAME `queue` (from `createReceiverQueue()`) on every call to
 * serialize work per pull request; without one, overlapping deliveries for
 * one pull request can publish out of order.
 * @param {{event:string, deliveryId?:string|null, payload:object,
 *   app:{apiUrl?:string, appId:string|number, privateKeyPem:string, notesRef?:string, checkName?:string},
 *   fetchImpl?:typeof fetch, log?:(line:string)=>void,
 *   deliveries?:{remember:(id:string|null|undefined)=>boolean}|null,
 *   queue?:{run:<T>(key:string, fn:()=>Promise<T>)=>Promise<T>}|null, now?:number}} opt
 * @returns {Promise<{outcome:string, event:string, repo:string|null, results:Array<{pr:number, sha:string, outcome:string}>}>}
 */
export async function handleWebhook({ event, deliveryId = null, payload, app, fetchImpl = fetch, log = () => {}, deliveries = null, queue = null, now = Date.now() }) {
  const apiUrl = app.apiUrl || DEFAULT_API_URL;
  const notesRef = app.notesRef || DEFAULT_NOTES_REF;
  const checkName = app.checkName || CHECK_NAME;

  const repository = payload && payload.repository ? payload.repository : null;
  const full = repository && typeof repository.full_name === 'string' ? repository.full_name : null;
  const owner = repository && repository.owner && repository.owner.login ? repository.owner.login : (full ? full.split('/')[0] : null);
  const repo = repository && typeof repository.name === 'string' ? repository.name : (full ? full.split('/')[1] : null);
  const repoLabel = full || (owner && repo ? `${owner}/${repo}` : null);

  const done = (outcome, results = []) => {
    if (!results.length) log(`[tokenflow github] event=${event} repo=${repoLabel || '-'} pr=- outcome=${outcome}`);
    return { outcome, event, repo: repoLabel, results };
  };

  if (deliveries && !deliveries.remember(deliveryId)) return done('duplicate');
  if (event === 'ping') return done('ping');

  /** @type {Array<{number:number, sha:string}>} */
  let targets = [];
  /** @type {Map<string,string>|null} */
  let index = null;

  if (event === 'pull_request') {
    const action = payload && typeof payload.action === 'string' ? payload.action : '';
    if (!PR_ACTIONS.has(action)) return done(`ignored (action=${action || 'none'})`);
    const pr = payload.pull_request;
    if (!pr || !pr.number || !pr.head || typeof pr.head.sha !== 'string') return done('ignored (no head sha)');
    targets = [{ number: pr.number, sha: pr.head.sha }];
  } else if (event === 'push') {
    if (payload.ref !== `refs/notes/${notesRef}`) return done(`ignored (ref=${payload.ref || 'none'})`);
  } else {
    return done('ignored (event)');
  }

  if (!owner || !repo) return done('ignored (no repository)');
  const installationId = payload && payload.installation && payload.installation.id !== undefined ? payload.installation.id : null;
  if (installationId === null) return done('ignored (no installation)');

  const { token } = await installationToken({ apiUrl, appId: app.appId, privateKeyPem: app.privateKeyPem, installationId, fetchImpl, now });

  if (event === 'push') {
    // One tree read, then only the open pull requests whose head sha the
    // notes ref now covers. Everything else on this push is not ours.
    const found = await readNotesIndex({ apiUrl, token, owner, repo, notesRef, fetchImpl });
    index = found.index;
    if (!index) return done(`ignored (${found.reason})`);
    // Paged: an organization repository can carry more than a hundred open
    // pull requests, and stopping at page one would silently skip the rest.
    const open = [];
    await githubPaged({
      fetchImpl,
      token,
      url: `${repoBase(apiUrl, owner, repo)}/pulls?state=open&per_page=${PER_PAGE}`,
      onPage: (items) => { open.push(...items); return false; },
    });
    targets = open
      .filter((pr) => pr && pr.number && pr.head && typeof pr.head.sha === 'string' && index.has(pr.head.sha.toLowerCase()))
      .map((pr) => ({ number: pr.number, sha: pr.head.sha }));
    if (!targets.length) return done('no matching open pull request');
  }

  const results = [];
  for (const t of targets) {
    let outcome;
    // One pull request at a time, across deliveries as well as within one:
    // the notes push and the pull_request event for the same PR overlap by
    // design, and whichever wins the race must not be undone by the other.
    const job = () => processPullRequest({ apiUrl, token, owner, repo, prNumber: t.number, headSha: t.sha, notesRef, checkName, index, fetchImpl });
    try {
      const r = queue ? await queue.run(`${owner}/${repo}#${t.number}`, job) : await job();
      outcome = r.outcome;
      results.push(r);
    } catch (err) {
      // One failing pull request must not take the rest of the delivery down.
      outcome = `error (${err.message})`;
      results.push({ pr: t.number, sha: t.sha, outcome });
    }
    log(`[tokenflow github] event=${event} repo=${repoLabel || '-'} pr=${t.number} outcome=${outcome}`);
  }
  return { outcome: results.length === 1 ? results[0].outcome : `processed ${results.length}`, event, repo: repoLabel, results };
}

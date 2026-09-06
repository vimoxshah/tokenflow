/**
 * `tokenflow team serve` — a self-hosted team server.
 *
 * One process on a machine the team owns (LAN or Docker), fed by the SAME
 * per-machine files the folder sync writes (`src/core/sync.js`): each
 * machine POSTs its own `<machineId>.jsonl` (daily rollups) and
 * `<machineId>.receipts.json` here instead of writing them into a shared
 * folder. Everything downstream — `aggregate()`/`renderText()` — is the
 * exact code the folder-sync `tokenflow team` view already uses, so this is
 * a second transport for the same contract, not a new data model.
 *
 * Auth model: a single shared bearer token, checked two ways.
 *   - `POST /api/rollup` always requires it (Bearer header) once configured.
 *   - `GET /api/team` and `GET /` require it too, once configured — the
 *     aggregate carries repo/branch/machine names and costs, which a LAN
 *     peer should not see without the secret. Either `Authorization: Bearer
 *     <token>` or a `tf_token` cookie satisfies this; visiting `/?token=
 *     <token>` once from a browser mints that cookie (HttpOnly, SameSite
 *     Strict) and redirects to `/` with the query stripped, so the secret
 *     never lingers in the address bar or history.
 *   - `GET /health` always answers, but only `{ ok: true }` until
 *     authenticated — machine counts and freshness are withheld like
 *     everything else the aggregate would carry.
 * With no token configured (the loopback default), every read stays open —
 * there is no per-viewer identity to check on a machine only its owner can
 * reach. A non-loopback bind address always requires a token, so an operator
 * cannot accidentally expose an open server on 0.0.0.0.
 *
 * Nothing here reads prompt or code content: the request bodies are daily
 * token/cost rollups and receipt summaries, the same coarse shape the folder
 * sync already produces. Request bodies are never logged.
 *
 *   tokenflow team serve                          loopback, no auth, port 7790
 *   tokenflow team serve --token <shared-secret>   required for --host 0.0.0.0
 *   TOKENFLOW_TEAM_TOKEN=<shared-secret> tokenflow team serve --host 0.0.0.0
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, renderText } from '../core/team.js';
import { paths } from '../core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PORT = 7790;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB, per the rollup contract
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Mirrors scripts/design-build.js's START/END markers (the source of truth
// for the generated block). Duplicated here as plain strings so this runtime
// command has no import dependency on the design build tooling.
const TOKEN_BLOCK_START = '/* @generated design-tokens:start';
const TOKEN_BLOCK_END = '/* @generated design-tokens:end */';

/**
 * Start the team server: accepts rollup uploads from each machine and serves
 * the aggregated team view over HTTP.
 * @param {{dir?:string, host?:string, port?:number, token?:string|null}} [opt]
 *   dir defaults to `<paths().root>/team` (created if missing); host defaults
 *   to 127.0.0.1; port defaults to 7790; token falls back to the
 *   TOKENFLOW_TEAM_TOKEN env var when not passed explicitly.
 * @returns {Promise<{server:import('node:http').Server, url:string, close:()=>Promise<void>}>}
 */
export async function startTeamServer(opt = {}) {
  const host = opt.host || '127.0.0.1';
  const port = opt.port ?? DEFAULT_PORT;
  const dir = opt.dir || path.join(paths().root, 'team');
  const token = typeof opt.token === 'string' && opt.token
    ? opt.token
    : (process.env.TOKENFLOW_TEAM_TOKEN || null);

  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error('refusing to bind a non-loopback host without a token — pass --token or set TOKENFLOW_TEAM_TOKEN');
  }

  fs.mkdirSync(dir, { recursive: true });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { dir, token }).catch(() => {
      // Never echo the triggering error: it may embed request-derived text
      // (e.g. a JSON.parse SyntaxError snippet of the body).
      try { json(res, { error: 'internal error' }, 500); } catch { /* response already sent or socket gone */ }
      console.error('[tokenflow team-serve] request handler failed');
    });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });

  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
  const url = `http://${host}:${boundPort}`;
  return { server, url, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

/**
 * `tokenflow team serve` CLI entry point. Starts the server and keeps the
 * process alive (Ctrl+C to stop), matching `tokenflow dashboard`'s pattern.
 * @param {object} flags parsed CLI flags: --host, --port, --dir, --token
 */
export async function run(flags = {}) {
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT;
  const dir = typeof flags.dir === 'string' ? flags.dir : undefined;
  const token = typeof flags.token === 'string' ? flags.token : undefined;

  const { url } = await startTeamServer({ host, port, dir, token });
  const resolvedDir = dir || path.join(paths().root, 'team');
  const hasToken = !!(token || process.env.TOKENFLOW_TEAM_TOKEN);

  console.log(`\n  TokenFlow team server`);
  console.log(`  ${url}`);
  console.log(`  folder: ${resolvedDir}`);
  console.log(hasToken
    ? '  auth: bearer token (or the tf_token cookie minted by /?token=<token>) required for writes and reads'
    : '  auth: none configured — every route is open. Set --token or TOKENFLOW_TEAM_TOKEN to require one.');
  console.log('  /health always answers, but only { ok: true } until authenticated.');
  console.log('  Ctrl+C to stop\n');
  await new Promise(() => {}); // keep the process alive until interrupted
}

// ------------------------------------------------------------- routing ---

/** @param {{dir:string, token:string|null}} ctx */
async function handleRequest(req, res, ctx) {
  const { dir, token } = ctx;
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, { error: 'bad request' }, 400);
  }
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    if (token && !isAuthorized(req, token)) return json(res, { ok: true });
    return json(res, healthPayload(dir));
  }
  if (req.method === 'GET' && p === '/api/team') {
    if (token && !isAuthorized(req, token)) return json(res, { error: 'unauthorized' }, 401);
    return json(res, aggregate(dir));
  }
  if (req.method === 'GET' && p === '/') return handleIndex(req, res, url, { dir, token });
  if (req.method === 'POST' && p === '/api/rollup') return handleRollup(req, res, { dir, token });
  return json(res, { error: 'not found' }, 404);
}

/**
 * `GET /`: mints the `tf_token` cookie from `?token=` (once, then redirects
 * with the query stripped), otherwise serves the full aggregate view when
 * authorized or a minimal "token required" page when not.
 */
function handleIndex(req, res, url, { dir, token }) {
  if (token) {
    const qToken = url.searchParams.get('token');
    if (qToken && qToken === token) {
      res.setHeader('set-cookie', `tf_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }
    if (!isAuthorized(req, token)) return html(res, renderUnauthorizedHtml(), 401);
  }
  return html(res, renderHtml(dir));
}

/** True whenever no token is configured, or the request carries the right Bearer header or `tf_token` cookie. */
function isAuthorized(req, token) {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m && m[1] === token) return true;
  return parseCookies(req.headers.cookie).tf_token === token;
}

/** Minimal `Cookie:` header parser — name/value pairs only, no attributes (those are only ever set by us). */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { out[k] = part.slice(eq + 1).trim(); }
  }
  return out;
}

/**
 * Validate and atomically write a machine's rollup upload.
 * Never serves files from `dir` directly and never logs the body.
 */
async function handleRollup(req, res, { dir, token }) {
  if (token) {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m || m[1] !== token) return json(res, { error: 'unauthorized' }, 401);
  }

  let raw;
  try {
    raw = await readBodyLimited(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') return json(res, { error: 'payload too large' }, 413);
    return json(res, { error: 'bad request' }, 400);
  }

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(res, { error: 'invalid JSON body' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, { error: 'invalid JSON body' }, 400);
  }

  const machineId = body.machineId;
  if (typeof machineId !== 'string' || !MACHINE_ID_RE.test(machineId)) {
    return json(res, { error: 'invalid machineId' }, 400);
  }

  const files = body.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return json(res, { error: 'files must be an object of name -> text' }, 400);
  }
  const names = Object.keys(files);
  if (!names.length) return json(res, { error: 'no files provided' }, 400);

  const allowed = new Set([`${machineId}.jsonl`, `${machineId}.receipts.json`]);
  for (const name of names) {
    if (!allowed.has(name)) return json(res, { error: 'unexpected file name' }, 400);
    if (typeof files[name] !== 'string') return json(res, { error: 'file content must be a string' }, 400);
  }
  for (const name of names) {
    const text = files[name];
    if (name.endsWith('.jsonl')) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { JSON.parse(line); } catch { return json(res, { error: 'malformed JSONL line' }, 400); }
      }
    } else {
      try { JSON.parse(text); } catch { return json(res, { error: 'malformed receipts JSON' }, 400); }
    }
  }

  for (const name of names) writeAtomic(path.join(dir, name), files[name]);
  return json(res, { ok: true, files: names });
}

// ------------------------------------------------------------------ i/o ---

/**
 * Read the request body, capped at maxBytes. Once the cap is passed the
 * chunks collected so far are dropped (no unbounded buffering) but the
 * stream keeps being drained to `end` before rejecting with
 * `code: 'PAYLOAD_TOO_LARGE'` — responding while the client still has
 * unsent body bytes in flight resets the connection instead of delivering
 * the 413.
 */
function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = /** @type {Error & {code?:string}} */ (new Error('payload too large'));
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', reject);
  });
}

/** Write-then-rename so a reader never observes a partial file. */
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** What the server has received: file count and freshest mtime, no aggregation. */
function healthPayload(dir) {
  let machines = 0;
  let updatedAt = null;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue; // one rollup file per machine
      machines++;
      const iso = fs.statSync(path.join(dir, f)).mtime.toISOString();
      if (!updatedAt || iso > updatedAt) updatedAt = iso;
    }
  }
  return { ok: true, machines, updatedAt };
}

function json(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function html(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// ------------------------------------------------------------------ HTML ---

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Extract the generated design-token block verbatim, read fresh on every request. */
function extractTokenBlock() {
  let css = '';
  try { css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'styles.css'), 'utf8'); } catch { return ''; }
  const a = css.indexOf(TOKEN_BLOCK_START);
  const b = css.indexOf(TOKEN_BLOCK_END);
  if (a === -1 || b === -1 || b < a) return '';
  return css.slice(a, b + TOKEN_BLOCK_END.length);
}

/** The unauthenticated view of `/` when a token is configured: no aggregate content. */
function renderUnauthorizedHtml() {
  const tokenBlock = extractTokenBlock();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>TokenFlow team server</title>
<style>
${tokenBlock}
body { background: var(--plane); color: var(--text-primary); font-family: var(--sans); padding: var(--sp-24); }
h1 { font-family: var(--display); }
code { font-family: var(--mono); }
</style>
</head>
<body>
<h1>TokenFlow team server</h1>
<p>A token is required to view this page. Visit <code>/?token=&lt;your-team-token&gt;</code> once from a browser you trust —
it sets a private cookie and the token never appears in the address bar again.</p>
</body>
</html>`;
}

/**
 * Self-contained HTML view: no external requests, no scripts. Renders the
 * same text the CLI's `tokenflow team` prints, plus a top-repos table when
 * the aggregate exposes `receipts.byRepo` (degrades to the <pre> alone when
 * that shape is absent — the receipts pipeline is landing separately).
 */
function renderHtml(dir) {
  const tokenBlock = extractTokenBlock();
  const agg = aggregate(dir);
  const health = healthPayload(dir);
  const text = renderText(agg);

  let repoSection = '';
  const byRepo = agg && agg.receipts && Array.isArray(agg.receipts.byRepo) ? agg.receipts.byRepo : null;
  if (byRepo && byRepo.length) {
    const rows = byRepo.slice(0, 20).map((r) => {
      const repo = esc(r.repo ?? r.name ?? '(unknown)');
      const tok = r.tokens != null ? esc(r.tokens) : '';
      const costVal = r.estCostUsd ?? r.cost;
      const cost = costVal != null ? esc(`$${Number(costVal).toFixed(2)}`) : '';
      return `      <tr><td>${repo}</td><td>${tok}</td><td>${cost}</td></tr>`;
    }).join('\n');
    repoSection = `
    <h2>Top repositories</h2>
    <table>
      <thead><tr><th>Repo</th><th>Tokens</th><th>Est. cost</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>TokenFlow team server</title>
<style>
${tokenBlock}
body { background: var(--plane); color: var(--text-primary); font-family: var(--sans); padding: var(--sp-24); }
h1, h2 { font-family: var(--display); }
pre { background: var(--surface-1); color: var(--text-primary); padding: var(--sp-16); border-radius: var(--radius); overflow-x: auto; white-space: pre-wrap; }
table { border-collapse: collapse; margin-top: var(--sp-16); }
th, td { border: 1px solid var(--border); padding: var(--sp-8); text-align: left; }
.meta { color: var(--text-secondary); font-family: var(--mono); }
</style>
</head>
<body>
<h1>TokenFlow team server</h1>
<p class="meta">${health.machines} machine(s) reporting &middot; updated ${health.updatedAt ? esc(health.updatedAt) : 'never'}</p>
<pre>${esc(text)}</pre>${repoSection}
</body>
</html>`;
}

/**
 * `tokenflow team check` — verify a self-hosted team server from a laptop.
 *
 *   tokenflow team check [--url <server-url>] [--token <shared-secret>]
 *
 * Reads `sync.to` and `sync.token` from config when the matching flag is
 * absent (the same fields `tokenflow sync` itself pushes with, see
 * src/core/sync.js). Calls GET /health twice, once with no Authorization
 * header and once with the bearer, then GET /api/policy once, and reports:
 *
 *   - reachable      the server answered at all
 *   - authenticated  the token (if any) was accepted, or none is required
 *   - policy         "present", "absent", or null when auth failed
 *   - version        whatever /health exposes under `version`, or null
 *                     (team-serve.js does not expose one today; this reads
 *                     it defensively so a future server can add it for free)
 *
 * `/health` never answers 401 (see team-serve.js): a wrong or missing token
 * just gets the coarse, unauthenticated shape back. The authoritative
 * "was this token accepted" signal is GET /api/policy, which does answer
 * 401 once a token is configured on the server, so that is what decides
 * `authenticated` here. The two /health calls exist to compare shapes: if
 * the call with NO Authorization header already gets the full shape back,
 * the server has no token configured at all, and every route on it is open.
 *
 * Exit code is 1 when the server is unreachable or the token was rejected;
 * 0 otherwise, since an absent org policy is a fact, not a failure.
 */
import { loadConfig } from '../core/config.js';

const TIMEOUT_MS = 5000;

/**
 * One GET, tolerating a network failure or a non-JSON body. Never throws.
 * @returns {Promise<{ok:boolean, status:number|null, body:object|null, error?:string}>}
 */
async function safeGet(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, status: null, body: null, error: err.message };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: true, status: res.status, body };
}

/** `body.version` when it is a string, else null. Defensive: no server exposes this field yet. */
function readVersion(body) {
  return body && typeof body.version === 'string' ? body.version : null;
}

/** A result object with every field present, so every return path has the same shape. */
function baseResult(url, tokenConfigured) {
  return {
    url, tokenConfigured,
    reachable: false, authenticated: false, policy: null, version: null,
    machines: null, updatedAt: null, openNoToken: false, fixes: [],
  };
}

/**
 * Run the checks against one team server.
 * @param {{url?:string, token?:string, config?:object, fetchImpl?:typeof fetch}} [opt]
 * @returns {Promise<object>} see the module doc for the shape
 */
export async function check(opt = {}) {
  const config = opt.config || loadConfig();
  const url = typeof opt.url === 'string' && opt.url ? opt.url : (config?.sync?.to || null);
  const token = typeof opt.token === 'string' && opt.token
    ? opt.token
    : (config?.sync?.token || process.env.TOKENFLOW_SYNC_TOKEN || null);
  const fetchImpl = opt.fetchImpl || fetch;

  const result = baseResult(url, !!token);
  if (!url) {
    result.fixes.push('No team server is configured. Set sync.to in config.yaml, or pass --url <server-url>.');
    return result;
  }

  const base = url.replace(/\/+$/, '');
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  const noAuth = await safeGet(fetchImpl, `${base}/health`, {});
  if (!noAuth.ok) {
    result.fixes.push(`Could not reach ${url}. Check the server is running, the host and port are correct, and this machine can reach it on the network (LAN, VPN, or a Docker network). (${noAuth.error})`);
    return result;
  }
  result.reachable = true;
  if (noAuth.body === null) {
    result.fixes.push(`${url} answered, but the response body was not JSON. This does not look like a tokenflow team serve endpoint; check the URL and port.`);
    return result;
  }

  result.openNoToken = Object.prototype.hasOwnProperty.call(noAuth.body, 'machines');
  if (result.openNoToken) {
    result.fixes.push('The server has no token configured, so every route is open to anything that can reach it. Set TOKENFLOW_TEAM_TOKEN on the server unless this network is fully private and trusted.');
  }

  const withAuth = token ? await safeGet(fetchImpl, `${base}/health`, authHeaders) : noAuth;

  const policyRes = await safeGet(fetchImpl, `${base}/api/policy`, authHeaders);
  if (!policyRes.ok) {
    result.fixes.push(`Could not reach ${url}/api/policy. (${policyRes.error})`);
    return result;
  }
  if (policyRes.status === 401) {
    result.authenticated = false;
    result.fixes.push(token
      ? "The token was rejected. Check it matches the server's TOKENFLOW_TEAM_TOKEN exactly (a copy and paste often carries stray whitespace)."
      : "The server requires a token and this laptop has none configured. Set sync.token in config.yaml (or TOKENFLOW_SYNC_TOKEN) to match the server's TOKENFLOW_TEAM_TOKEN.");
    return result;
  }
  result.authenticated = true;
  if (policyRes.status === 200) result.policy = true;
  else if (policyRes.status === 404) result.policy = false;
  // any other status: leave policy null (unknown) without failing the check

  result.version = readVersion(withAuth.body) || readVersion(noAuth.body);
  if (withAuth.body && typeof withAuth.body.machines === 'number') result.machines = withAuth.body.machines;
  if (withAuth.body && withAuth.body.updatedAt !== undefined) result.updatedAt = withAuth.body.updatedAt;

  return result;
}

/** Plain-text report for `tokenflow team check`. */
export function render(result) {
  const lines = [`tokenflow team check ${result.url || '(no server configured)'}`];
  if (!result.url) {
    lines.push('  reachable        false');
    for (const f of result.fixes) lines.push(`  fix: ${f}`);
    return lines.join('\n');
  }
  lines.push(`  reachable        ${result.reachable}`);
  lines.push(`  authenticated    ${result.authenticated}`);
  lines.push(`  policy           ${result.policy === null ? 'unknown' : (result.policy ? 'present' : 'absent')}`);
  lines.push(`  server version   ${result.version || 'unknown, not exposed by this server'}`);
  if (result.machines !== null) lines.push(`  machines         ${result.machines} reporting`);
  for (const f of result.fixes) lines.push(`  fix: ${f}`);
  return lines.join('\n');
}

/**
 * CLI entry for `tokenflow team check`.
 * @param {object} flags parsed CLI flags: --url, --token
 * @returns {Promise<{stdout:string|null, stderr:string|null, exitCode:number}>}
 */
export async function run(flags = {}) {
  const config = loadConfig();
  const result = await check({
    url: typeof flags.url === 'string' ? flags.url : undefined,
    token: typeof flags.token === 'string' ? flags.token : undefined,
    config,
  });
  const exitCode = result.reachable && result.authenticated ? 0 : 1;
  return { stdout: render(result), stderr: null, exitCode };
}

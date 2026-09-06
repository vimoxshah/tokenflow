/**
 * `tokenflow mcp` — the MCP server an agent talks to over stdio.
 *
 * Two levels of proof here. Most tests drive `serve()` through a pair of
 * PassThrough streams, which is fast and lets one test hold the whole
 * conversation. The last one spawns a real child process and speaks the same
 * protocol down real pipes, because in-memory streams cannot show that the
 * framing survives chunk boundaries, that nothing but JSON reaches stdout, or
 * that the process exits 0 when the client hangs up.
 *
 * The store is a synthetic one, seeded into a throwaway $TOKENFLOW_HOME by the
 * same mock provider `tokenflow demo` uses. Nothing in this file reads or
 * writes a real home.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const MCP_MODULE = path.join(ROOT, 'src', 'commands', 'mcp.js');

/** @type {string} the throwaway store every test reads */
let HOME = '';
/** @type {typeof import('../src/commands/mcp.js').serve} */
let serve;
/** @type {typeof import('../src/commands/mcp.js').TOOLS} */
let TOOLS;
let LATEST_PROTOCOL_VERSION = '';
let PKG_VERSION = '';

const TOOL_NAMES = ['tokenflow_receipt', 'tokenflow_policy', 'tokenflow_usage', 'tokenflow_budget'];

/** Everything under a directory as `path -> size:mtime`, for the read-only check. */
function snapshotTree(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[p] = 'dir'; walk(p); } else {
        const st = fs.statSync(p);
        out[p] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mcp-home-'));
  process.env.TOKENFLOW_HOME = HOME;
  process.env.TOKENFLOW_DEMO = '1';

  const { loadConfig, saveConfig } = await import('../src/core/config.js');
  const { loadProviders, listProviders } = await import('../src/core/registry.js');
  const { refresh } = await import('../src/core/ingest.js');

  const cfg = loadConfig();
  cfg.providers = ['mock'];
  cfg.sources.mock = { days: 14, seed: 20260814 };
  cfg.timezone = 'UTC';
  cfg.budget = { monthly: 200, warnAtPct: 80, notify: false };
  saveConfig(cfg);

  await loadProviders();
  await refresh({ registry: listProviders(), providers: ['mock'], full: true, config: loadConfig() });

  const mod = await import('../src/commands/mcp.js');
  serve = mod.serve;
  TOOLS = mod.TOOLS;
  LATEST_PROTOCOL_VERSION = mod.LATEST_PROTOCOL_VERSION;
  PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
});

after(() => {
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

/**
 * A client for one server, over a pair of in-memory pipes. Responses arrive in
 * the order the requests were sent, so `next()` reads the conversation the way
 * it was written.
 */
function connect({ cwd = ROOT, env = null } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {any[]} */
  const seen = [];
  /** @type {((m:any)=>void)[]} */
  const waiting = [];
  let cursor = 0;
  let buf = '';

  const pump = () => {
    while (waiting.length && cursor < seen.length) waiting.shift()(seen[cursor++]);
  };
  output.on('data', (chunk) => {
    buf += chunk.toString();
    let i = buf.indexOf('\n');
    while (i > -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) seen.push(JSON.parse(line));
      i = buf.indexOf('\n');
    }
    pump();
  });

  const done = serve({ input, output, env: env || process.env, cwd, log: () => {} });
  let nextId = 0;

  const send = (msg) => input.write(`${JSON.stringify(msg)}\n`);
  const raw = (text) => input.write(`${text}\n`);
  const next = () => new Promise((resolve) => { waiting.push(resolve); pump(); });

  const request = async (method, params) => {
    const id = ++nextId;
    send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    const msg = await next();
    assert.equal(msg.id, id, `expected the response to request ${id}, got ${JSON.stringify(msg)}`);
    return msg;
  };

  const handshake = async (protocolVersion = LATEST_PROTOCOL_VERSION) => {
    const res = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'tokenflow-test', version: '0.0.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return res.result;
  };

  /** A tools/call that is expected to succeed: returns the parsed JSON payload. */
  const call = async (name, args = {}) => {
    const res = await request('tools/call', { name, arguments: args });
    assert.ok(res.result, `tools/call ${name} returned an error: ${JSON.stringify(res.error)}`);
    assert.equal(res.result.isError, false, `tools/call ${name} failed: ${res.result.content?.[0]?.text}`);
    assert.equal(res.result.content.length, 1);
    assert.equal(res.result.content[0].type, 'text');
    return JSON.parse(res.result.content[0].text);
  };

  const close = async () => {
    input.end();
    return done;
  };

  return { send, raw, next, request, handshake, call, close, seen };
}

// ------------------------------------------------------------- handshake ---

test('initialize: answers with the client version when it is one this server speaks', async () => {
  const c = connect();
  const r = await c.handshake('2025-06-18');
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.deepEqual(r.serverInfo, { name: 'tokenflow', version: PKG_VERSION });
  assert.match(r.instructions, /read-only/);
  assert.equal(await c.close(), 0);
});

test('initialize: a version this server does not speak is answered with its latest', async () => {
  const c = connect();
  const r = await c.handshake('1999-01-01');
  assert.equal(r.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(await c.close(), 0);
});

test('tools/list: four tools, each with an object input schema an agent can fill in', async () => {
  const c = connect();
  await c.handshake();
  const res = await c.request('tools/list');
  const tools = res.result.tools;
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} needs a description written for an agent`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  const receipt = tools.find((t) => t.name === 'tokenflow_receipt');
  assert.deepEqual(Object.keys(receipt.inputSchema.properties), ['repo', 'branch']);
  const usage = tools.find((t) => t.name === 'tokenflow_usage');
  assert.deepEqual(usage.inputSchema.properties.days, {
    type: 'integer',
    minimum: 1,
    maximum: 90,
    default: 7,
    description: usage.inputSchema.properties.days.description,
  });
  assert.deepEqual(tools.find((t) => t.name === 'tokenflow_budget').inputSchema.properties, {});
  // What tools/list reports is exactly the exported table, nothing rebuilt.
  assert.deepEqual(tools, JSON.parse(JSON.stringify(TOOLS)));
  assert.equal(await c.close(), 0);
});

// ----------------------------------------------------------------- tools ---

test('tools/call tokenflow_usage: totals by bucket, cost, sessions and the top models', async () => {
  const c = connect();
  await c.handshake();
  const u = await c.call('tokenflow_usage', { days: 7 });

  assert.equal(u.window.days, 7);
  assert.equal(u.timezone, 'UTC');
  assert.ok(u.window.from < u.window.to);
  assert.ok(u.tokens.total > 0);
  assert.equal(u.tokens.total, u.tokens.input + u.tokens.output + u.tokens.cacheRead + u.tokens.cacheWrite);
  assert.ok(u.cost.estimatedUsd > 0);
  assert.equal(u.cost.measuredUsd, null, 'the demo corpus has no gateway-measured cost to report');
  assert.ok(u.requests > 0);
  assert.ok(u.sessions > 0);
  assert.ok(u.topModels.length > 0 && u.topModels.length <= 5);
  assert.ok(u.topModels[0].tokens >= u.topModels[u.topModels.length - 1].tokens);
  assert.equal(u.demoData, true);

  // A shorter window can only be a subset of a longer one.
  const day = await c.call('tokenflow_usage', { days: 1 });
  assert.equal(day.window.from, day.window.to);
  assert.ok(day.tokens.total <= u.tokens.total);

  // The default is 7 days, so it must match the explicit 7.
  const dflt = await c.call('tokenflow_usage');
  assert.deepEqual(dflt.window, u.window);
  assert.equal(await c.close(), 0);
});

test('tools/call tokenflow_usage: a window outside 1..90 is a tool error, not a protocol error', async () => {
  const c = connect();
  await c.handshake();
  for (const days of [0, 91, 2.5, 'seven']) {
    const res = await c.request('tools/call', { name: 'tokenflow_usage', arguments: { days } });
    assert.equal(res.error, undefined, 'a bad argument must reach the model, not the transport');
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /between 1 and 90/);
  }
  assert.equal(await c.close(), 0);
});

test('tools/call tokenflow_receipt: names the branches it knows, then costs one of them', async () => {
  const c = connect();
  await c.handshake();

  // No branch given and a bare repository name, so no HEAD to read: the answer
  // says why, and offers the branches that do have receipts.
  const list = await c.call('tokenflow_receipt', { repo: 'billing-service' });
  assert.equal(list.found, false);
  assert.equal(list.repo, 'billing-service');
  assert.equal(list.branch, null);
  assert.match(list.reason, /no branch/);
  assert.ok(list.branches.length > 0);
  const names = list.branches.map((b) => b.branch);
  assert.ok(names.includes('feat/receipts-view'), `expected the demo hot branch, got ${names.join(', ')}`);
  assert.ok(list.branches[0].costUsd >= list.branches[list.branches.length - 1].costUsd);

  const one = await c.call('tokenflow_receipt', { repo: 'billing-service', branch: 'feat/receipts-view' });
  assert.equal(one.found, true);
  assert.equal(one.repo, 'billing-service');
  assert.equal(one.branch, 'feat/receipts-view');
  assert.equal(one.receipt.key, 'feat/receipts-view');
  assert.ok(one.receipt.cost > 0);
  assert.ok(one.receipt.turns > 0);
  assert.ok(one.receipt.sessions > 0);
  // The context/work split is what makes a receipt actionable.
  assert.ok(Math.abs((one.receipt.contextCost + one.receipt.workCost) - one.receipt.cost) < 1e-6);
  assert.equal(one.receipt.cost, list.branches.find((b) => b.branch === 'feat/receipts-view').costUsd);
  assert.equal(await c.close(), 0);
});

test('tools/call tokenflow_receipt: a repository or branch with no sessions is reported, never invented', async () => {
  const c = connect();
  await c.handshake();

  const noRepo = await c.call('tokenflow_receipt', { repo: 'no-such-repository', branch: 'main' });
  assert.equal(noRepo.found, false);
  assert.match(noRepo.reason, /no local sessions/);
  assert.deepEqual(noRepo.branches, []);

  const noBranch = await c.call('tokenflow_receipt', { repo: 'billing-service', branch: 'feat/never-existed' });
  assert.equal(noBranch.found, false);
  assert.equal(noBranch.branch, 'feat/never-existed');
  assert.match(noBranch.reason, /no local sessions/);
  assert.ok(noBranch.branches.length > 0, 'a missing branch should still show what the repository does have');
  assert.equal(await c.close(), 0);
});

test('tools/call tokenflow_receipt: with no repo it uses the directory the server was given', async () => {
  const c = connect({ cwd: ROOT });
  await c.handshake();
  const r = await c.call('tokenflow_receipt');
  // This checkout has no synthetic sessions, so the honest answer is "none",
  // but it must have resolved THIS repository and read its checked-out branch.
  assert.equal(r.found, false);
  assert.equal(r.repo, 'tokenflow');
  assert.equal(typeof r.branch, 'string');
  assert.equal(await c.close(), 0);
});

test('tools/call tokenflow_policy: every cap, and the layer each one came from', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mcp-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.tokenflow'));
  fs.writeFileSync(path.join(repo, '.tokenflow', 'policy.yaml'), [
    'guard:',
    '  maxCostUsd: 50',
    '  warnContextTokens: 120000',
    'note: "Data-heavy repo; sessions run long."',
    '',
  ].join('\n'));

  const c = connect();
  await c.handshake();
  const p = await c.call('tokenflow_policy', { cwd: repo });

  assert.equal(p.cwd, path.resolve(repo));
  assert.equal(p.repoRoot, repo);
  assert.equal(p.declared, true);
  assert.equal(p.caps.maxCostUsd.value, 50);
  assert.equal(p.caps.maxCostUsd.source, 'repo');
  assert.equal(p.caps.warnContextTokens.value, 120000);
  assert.equal(p.caps.warnContextTokens.source, 'repo');
  assert.equal(p.caps.warnCostUsd.value, null, 'an undeclared cap is null, never 0');
  assert.equal(p.caps.warnCostUsd.source, 'default');
  assert.deepEqual(Object.keys(p.caps).sort(), [
    'maxContextTokens', 'maxCostUsd', 'warnContextTokens', 'warnCostUsd', 'warnMarginalUsd',
  ]);
  assert.equal(p.note, 'Data-heavy repo; sessions run long.');
  assert.deepEqual(p.errors, []);

  // A repository that declares no policy declares nothing: every cap is null
  // and sourced from the default, and no cap is invented from the other repo.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mcp-bare-'));
  fs.mkdirSync(path.join(bare, '.git'));
  const q = await c.call('tokenflow_policy', { cwd: bare });
  assert.equal(q.declared, false);
  assert.equal(q.note, null);
  for (const k of Object.keys(q.caps)) {
    assert.equal(q.caps[k].value, null);
    assert.equal(q.caps[k].source, 'default');
  }

  assert.equal(await c.close(), 0);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

test('tools/call tokenflow_budget: the cap, the month so far, and a projection labelled as one', async () => {
  const c = connect();
  await c.handshake();
  const b = await c.call('tokenflow_budget');
  assert.equal(b.configured, true);
  assert.equal(b.monthlyUsd, 200);
  assert.equal(b.warnAtPct, 80);
  assert.ok(['safe', 'approaching', 'over_budget_projected', 'over_budget_actual', 'unknown'].includes(b.state));
  assert.match(b.month, /^\d{4}-\d{2}$/);
  assert.ok(b.spentUsd > 0);
  assert.match(b.note, /not a charge/);
  assert.equal(await c.close(), 0);
});

test('tools/call: unknown tool is an invalid params error, not a tool result', async () => {
  const c = connect();
  await c.handshake();
  const res = await c.request('tools/call', { name: 'tokenflow_nope', arguments: {} });
  assert.equal(res.result, undefined);
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /Unknown tool/);
  assert.deepEqual(res.error.data.available, TOOL_NAMES);

  const missing = await c.request('tools/call', { arguments: {} });
  assert.equal(missing.error.code, -32602);
  assert.equal(await c.close(), 0);
});

// -------------------------------------------------------------- framing ----

test('a line that is not JSON is a parse error, and the connection survives it', async () => {
  const c = connect();
  await c.handshake();
  c.raw('{ this is not json');
  const err = await c.next();
  assert.equal(err.id, null);
  assert.equal(err.error.code, -32700);
  assert.match(err.error.message, /Parse error/);

  const pong = await c.request('ping');
  // The default handshake negotiates 2026-07-28, so an empty result is not empty.
  assert.deepEqual(pong.result, { resultType: 'complete' });
  assert.equal(await c.close(), 0);
});

test('an unknown method is method not found; a batch and a bare value are invalid requests', async () => {
  const c = connect();
  await c.handshake();

  const unknown = await c.request('resources/list');
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /Method not found/);

  c.raw(JSON.stringify([{ jsonrpc: '2.0', id: 9, method: 'ping' }]));
  const batch = await c.next();
  assert.equal(batch.id, null);
  assert.equal(batch.error.code, -32600);

  c.raw(JSON.stringify({ id: 10, method: 'ping' })); // no jsonrpc member
  const bare = await c.next();
  assert.equal(bare.id, 10);
  assert.equal(bare.error.code, -32600);
  assert.equal(await c.close(), 0);
});

test('notifications and client responses get no reply at all', async () => {
  const c = connect();
  const r = await c.request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(r.id, 1);

  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  c.send({ jsonrpc: '2.0', id: 99, result: { ok: true } }); // a response, not a request
  c.send({ jsonrpc: '2.0', method: 'tools/list' }); // tools/list AS a notification

  const pong = await c.request('ping');
  // The default handshake negotiates 2026-07-28, so an empty result is not empty.
  assert.deepEqual(pong.result, { resultType: 'complete' });
  assert.equal(await c.close(), 0);
  // initialize + ping, and nothing in between.
  assert.equal(c.seen.length, 2, `unexpected output: ${JSON.stringify(c.seen)}`);
});

test('2026-07-28: every result carries resultType, including the initialize reply itself', async () => {
  const c = connect();
  // The handshake's own reply must already be stamped: from 2026-07-28 the
  // field is on the base Result type, so the first response is either
  // conformant or the server is not.
  const init = await c.request('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'tokenflow-test', version: '0.0.0' },
  });
  assert.equal(init.result.resultType, 'complete');
  assert.equal(init.result.protocolVersion, '2026-07-28');
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const ping = await c.request('ping');
  assert.equal(ping.result.resultType, 'complete');

  const list = await c.request('tools/list');
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.tools.length, 4);

  const call = await c.request('tools/call', { name: 'tokenflow_budget', arguments: {} });
  assert.equal(call.result.resultType, 'complete');
  assert.equal(call.result.isError, false);

  // An error is not a result and must not be stamped.
  const err = await c.request('tools/call', { name: 'tokenflow_nope', arguments: {} });
  assert.equal(err.result, undefined);
  assert.equal('resultType' in err.error, false);
  assert.equal(await c.close(), 0);
});

test('an earlier negotiated version gets no resultType, which its own schema reads as complete', async () => {
  for (const version of ['2025-11-25', '2025-06-18']) {
    const c = connect();
    const init = await c.request('initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'tokenflow-test', version: '0.0.0' },
    });
    assert.equal(init.result.protocolVersion, version);
    assert.equal('resultType' in init.result, false, `${version} must not be sent a field it does not know`);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const ping = await c.request('ping');
    assert.deepEqual(ping.result, {});

    const list = await c.request('tools/list');
    assert.equal('resultType' in list.result, false);

    const call = await c.request('tools/call', { name: 'tokenflow_budget', arguments: {} });
    assert.equal('resultType' in call.result, false);
    assert.equal(await c.close(), 0);
  }
});

test('a request id of 0 or of the empty string is still a request, and is answered', async () => {
  const c = connect();
  await c.handshake();

  // Both are falsy, and both are legal JSON-RPC ids. Only null and a missing
  // id make a notification.
  c.send({ jsonrpc: '2.0', id: 0, method: 'ping' });
  const zero = await c.next();
  assert.equal(zero.id, 0);
  assert.deepEqual(zero.result, { resultType: 'complete' });

  c.send({ jsonrpc: '2.0', id: '', method: 'tools/list' });
  const empty = await c.next();
  assert.equal(empty.id, '');
  assert.equal(empty.result.tools.length, 4);

  // The same holds on the error path: an id of 0 must come back, not null.
  c.send({ jsonrpc: '2.0', id: 0, method: 'no/such/method' });
  const failed = await c.next();
  assert.equal(failed.id, 0);
  assert.equal(failed.error.code, -32601);
  assert.equal(await c.close(), 0);
});

test('a broken output pipe ends the session with exit code 0 instead of crashing it', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve({ input, output, env: process.env, cwd: ROOT, log: () => {} });
  output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  assert.equal(await done, 0);
});

// ------------------------------------------------------------- read-only ---

test('every tool is read-only: not one byte of the store changes', async () => {
  const before = snapshotTree(HOME);
  const c = connect();
  await c.handshake();
  await c.call('tokenflow_usage', { days: 30 });
  await c.call('tokenflow_budget');
  await c.call('tokenflow_policy', { cwd: ROOT });
  await c.call('tokenflow_receipt', { repo: 'billing-service', branch: 'feat/receipts-view' });
  assert.equal(await c.close(), 0);
  assert.deepEqual(snapshotTree(HOME), before);
});

test('serve reads the store named by the env it was handed', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mcp-empty-'));
  const previous = process.env.TOKENFLOW_HOME;
  try {
    const c = connect({ env: { ...process.env, TOKENFLOW_HOME: empty } });
    await c.handshake();
    assert.equal(process.env.TOKENFLOW_HOME, empty, 'serve must adopt the home it was given');

    const b = await c.call('tokenflow_budget');
    assert.equal(b.configured, false);
    assert.match(b.message, /No monthly budget/);

    const u = await c.call('tokenflow_usage', { days: 7 });
    assert.equal(u.tokens.total, 0);
    assert.equal(u.cost.estimatedUsd, null, 'an empty store has no cost, which is null and not $0');
    assert.equal(u.sessions, 0);
    assert.deepEqual(u.topModels, []);
    assert.equal(await c.close(), 0);
  } finally {
    process.env.TOKENFLOW_HOME = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- over real pipes --

test('over real pipes: a child process speaks the protocol and exits 0 when stdin ends', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mcp-child-'));
  const script = path.join(dir, 'server.mjs');
  fs.writeFileSync(script, [
    `import { serve } from ${JSON.stringify(url.pathToFileURL(MCP_MODULE).href)};`,
    'await serve({ input: process.stdin, output: process.stdout, env: process.env, cwd: process.cwd() });',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, TOKENFLOW_HOME: HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const line = (o) => `${JSON.stringify(o)}\n`;
  child.stdin.write(line({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pipe-test', version: '0' } },
  }));
  child.stdin.write(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  // Two messages in one write, to prove the reader splits on newlines rather
  // than on chunk boundaries.
  child.stdin.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    + line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tokenflow_usage', arguments: { days: 7 } } }));
  child.stdin.end();

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  assert.equal(code, 0, `child exited ${code}; stderr: ${err}`);
  assert.equal(err, '', `nothing should be logged on a clean run, got: ${err}`);

  const messages = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3], 'one response per request, in order, and none for the notification');
  assert.equal(messages[0].result.serverInfo.name, 'tokenflow');
  assert.equal(messages[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(messages[1].result.tools.map((t) => t.name), TOOL_NAMES);
  const usage = JSON.parse(messages[2].result.content[0].text);
  assert.equal(usage.window.days, 7);
  assert.ok(usage.tokens.total > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

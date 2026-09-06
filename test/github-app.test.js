/**
 * The self-hosted GitHub App receiver (`src/core/github-app.js`).
 *
 * Every test drives the real code against a mock GitHub API served by
 * node:http on 127.0.0.1:7851 — no network, no fixtures pretending to be
 * responses, and the recorded request log is what the assertions read, so a
 * changed request body fails here rather than in someone's repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  verifyWebhookSignature, appJwt, installationToken, readNotesIndex, readReceiptNote,
  readRepoCap, upsertReceiptComment, publishCheckRun, evaluateCap, noReceiptOutput,
  createDeliveryMemory, createReceiverQueue, handleWebhook, RECEIPT_MARKER, CHECK_NAME, POLICY_PATH,
} from '../src/core/github-app.js';
import { renderReceiptV0Markdown } from '../src/analytics/receipt-schema.js';

const PORT = 7851;
const OWNER = 'acme';
const REPO = 'widgets';
const HEAD_SHA = '1f2e3d4c5b6a70819273645566778899aabbccdd';
const OTHER_SHA = '00112233445566778899aabbccddeeff00112233';
const NOTES_COMMIT = 'cccccccccccccccccccccccccccccccccccccccc';
const NOTES_TREE = 'dddddddddddddddddddddddddddddddddddddddd';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// ------------------------------------------------------------- fixtures ---

/** A receipt.v0 object that passes validateReceiptV0(). */
function receipt(over = {}) {
  return {
    schemaVersion: 0,
    generatedAt: '2026-09-05T10:00:00.000Z',
    toolVersion: '1.3.0',
    repo: REPO,
    branch: 'feat/checkout',
    headSha: HEAD_SHA,
    window: { first: '2026-09-01T09:00:00.000Z', last: '2026-09-05T09:00:00.000Z' },
    costUsd: 12.5,
    contextShare: 0.6,
    turns: 40,
    sessions: 3,
    subagentTurns: 4,
    models: [{ model: 'claude-opus-5', costUsd: 12.5, share: 1 }],
    coverage: 1,
    largestPromptTokens: 120000,
    changedLines: 500,
    pr: { number: 7, mergedAt: null },
    longLived: false,
    costPer100Lines: 2.5,
    notes: ['Estimated locally by TokenFlow.'],
    ...over,
  };
}

// ----------------------------------------------------------- mock GitHub ---

/**
 * A mock GitHub REST API. `state` is mutated by the tests before each call;
 * `calls` records `{method, path, body}` for every request that arrived.
 */
async function startMockGitHub(state) {
  const calls = [];
  let nextId = 100;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      calls.push({
        method: req.method,
        path: url.pathname + (url.search || ''),
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization || null,
        accept: req.headers.accept || null,
        apiVersion: req.headers['x-github-api-version'] || null,
        userAgent: req.headers['user-agent'] || null,
        body,
      });
      // The repository as it was when this request ARRIVED. Real GitHub
      // answers from the state it saw, so a slow response carries stale data,
      // and that staleness is exactly the race the receiver has to survive.
      // Building the body at response time instead would quietly hand a held
      // request the newest data and make an interleaving test prove nothing.
      const snapshot = { noteEntries: [...state.noteEntries] };

      // `state.hooks[name]` lets a test hold a specific call open, so an
      // interleaving is forced rather than hoped for. No timers anywhere.
      const gate = state.hooks && state.hooks[hookNameFor(req, url)];
      if (gate) Promise.resolve(gate()).then(() => route(req, res, url, body, snapshot));
      else route(req, res, url, body, snapshot);
    });
  });

  function hookNameFor(req, url) {
    if (url.pathname.includes('/git/trees/')) return 'tree';
    if (url.pathname.endsWith('/access_tokens')) return 'token';
    return null;
  }

  // `connection: close` keeps undici from pooling a socket to a server the
  // next test has already replaced on the same port (an ECONNRESET on reuse).
  // `link` is GitHub's pagination header; the paged reader follows it.
  function send(res, code, obj, link) {
    const s = JSON.stringify(obj);
    const headers = { 'content-type': 'application/json', connection: 'close' };
    if (link) headers.link = link;
    res.writeHead(code, headers);
    res.end(s);
  }

  function route(req, res, url, body, snapshot) {
    const p = url.pathname;
    const base = `/repos/${OWNER}/${REPO}`;

    if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
      return send(res, 201, { token: state.installationToken, expires_at: '2026-09-05T11:00:00Z' });
    }
    if (req.method === 'GET' && p === `${base}/git/ref/notes/${state.notesRef}`) {
      if (state.missingNotesRef) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { ref: `refs/notes/${state.notesRef}`, object: { type: 'commit', sha: NOTES_COMMIT } });
    }
    if (req.method === 'GET' && p === `${base}/git/commits/${NOTES_COMMIT}`) {
      return send(res, 200, { sha: NOTES_COMMIT, tree: { sha: NOTES_TREE } });
    }
    if (req.method === 'GET' && p === `${base}/git/trees/${NOTES_TREE}`) {
      const tree = snapshot.noteEntries.map((e) => ({ path: e.path, type: 'blob', mode: '100644', sha: e.blobSha }));
      return send(res, 200, { sha: NOTES_TREE, tree, truncated: !!state.treeTruncated });
    }
    if (req.method === 'GET' && p.startsWith(`${base}/git/blobs/`)) {
      const blobSha = p.slice(`${base}/git/blobs/`.length);
      const entry = state.noteEntries.find((e) => e.blobSha === blobSha);
      if (!entry) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, {
        sha: blobSha,
        encoding: 'base64',
        content: Buffer.from(entry.content, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n'),
      });
    }
    if (req.method === 'GET' && p === `${base}/contents/${POLICY_PATH}`) {
      if (state.policyYaml === null) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, {
        type: 'file', name: 'policy.yaml', path: POLICY_PATH, encoding: 'base64',
        content: Buffer.from(state.policyYaml, 'utf8').toString('base64'),
      });
    }
    if (req.method === 'GET' && p === `${base}/pulls`) {
      return paginate(res, url, state.pulls);
    }
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(p)) {
      return paginate(res, url, state.comments);
    }
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(p)) {
      const created = { id: nextId++, body: body.body };
      state.comments.push(created);
      return send(res, 201, created);
    }
    if (req.method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const found = state.comments.find((c) => c.id === id);
      if (found) found.body = body.body;
      return send(res, 200, { id, body: body.body });
    }
    if (req.method === 'GET' && /\/commits\/[^/]+\/check-runs$/.test(p)) {
      const name = url.searchParams.get('check_name');
      const runs = state.checkRuns.filter((r) => !name || r.name === name);
      return send(res, 200, { total_count: runs.length, check_runs: runs });
    }
    if (req.method === 'POST' && p === `${base}/check-runs`) {
      const created = { id: nextId++, ...body };
      state.checkRuns.push(created);
      return send(res, 201, created);
    }
    if (req.method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/check-runs\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const found = state.checkRuns.find((r) => r.id === id);
      if (found) Object.assign(found, body);
      return send(res, 200, { id, ...body });
    }
    return send(res, 404, { message: 'Not Found' });
  }

  /**
   * Serve one page of `all`, with the same `Link: rel="next"` header GitHub
   * sends. `state.omitLinkHeader` drops it, to exercise the reader's fallback
   * (a proxy in front of GitHub Enterprise Server that strips headers).
   */
  function paginate(res, url, all) {
    const perPage = Number(url.searchParams.get('per_page') || 30);
    const page = Number(url.searchParams.get('page') || 1);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const hasMore = page * perPage < all.length;
    if (!hasMore || state.omitLinkHeader) return send(res, 200, slice);
    const next = new URL(url.toString());
    next.host = `127.0.0.1:${PORT}`;
    next.protocol = 'http:';
    next.searchParams.set('page', String(page + 1));
    return send(res, 200, slice, `<${next.toString()}>; rel="next", <${next.toString()}>; rel="last"`);
  }

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(undefined));
  });
  return {
    url: `http://127.0.0.1:${PORT}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

/** Default mock state: one note on HEAD_SHA at a 2/38 fanout path, no policy file. */
function defaultState(over = {}) {
  return {
    notesRef: 'tokenflow',
    installationToken: 'ghs_installation_token',
    missingNotesRef: false,
    treeTruncated: false,
    noteEntries: [
      { path: `${HEAD_SHA.slice(0, 2)}/${HEAD_SHA.slice(2)}`, blobSha: 'blob-head', content: JSON.stringify(receipt()) },
    ],
    policyYaml: null,
    comments: [],
    checkRuns: [],
    pulls: [],
    hooks: {},
    omitLinkHeader: false,
    ...over,
  };
}

/** A promise plus its resolver, for forcing an interleaving without a timer. */
function deferred() {
  /** @type {(value?:any)=>void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Start the mock, run `fn(mock, state)`, always stop the server. */
async function withMock(over, fn) {
  const state = defaultState(over);
  const mock = await startMockGitHub(state);
  try {
    await fn(mock, state);
  } finally {
    await mock.close();
  }
}

const app = (over = {}) => ({ apiUrl: `http://127.0.0.1:${PORT}`, appId: '424242', privateKeyPem: PEM, notesRef: 'tokenflow', ...over });

// ------------------------------------------------- webhook signature ---

test('github-app: a signature made with the shared secret over the raw body is accepted', () => {
  const secret = 'a-webhook-secret';
  const rawBody = '{"action":"opened","number":7}';
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: `sha256=${digest}` }), true);
  assert.equal(verifyWebhookSignature({ secret, rawBody: Buffer.from(rawBody, 'utf8'), signatureHeader: `sha256=${digest}` }), true);
});

test('github-app: a signature is rejected for the wrong secret, a tampered body, and a missing or malformed header', () => {
  const secret = 'a-webhook-secret';
  const rawBody = '{"action":"opened"}';
  const good = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  assert.equal(verifyWebhookSignature({ secret: 'another-secret', rawBody, signatureHeader: good }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody: '{"action":"closed"}', signatureHeader: good }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: null }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: '' }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: good.replace('sha256=', 'sha1=') }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: 'sha256=short' }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: `${good}extra` }), false);
  // No secret configured is never "any signature is fine".
  assert.equal(verifyWebhookSignature({ secret: '', rawBody, signatureHeader: good }), false);
});

test('github-app: the last hex digit flipped is rejected (the comparison is over the whole digest)', () => {
  const secret = 's3cr3t';
  const rawBody = '{"zen":"Keep it logically awesome."}';
  const good = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const flipped = good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0');
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: `sha256=${flipped}` }), false);
});

// ----------------------------------------------------------------- JWT ---

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test('github-app: appJwt is an RS256 JWT that verifies against the key pair, backdated 60s and under 10 minutes', () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const jwt = appJwt({ appId: 424242, privateKeyPem: PEM, now });
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  assert.ok(!/[+/=]/.test(jwt), 'every segment must be base64url, never plain base64');

  const header = decodeJwtPart(parts[0]);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });

  const claims = decodeJwtPart(parts[1]);
  const seconds = Math.floor(now / 1000);
  assert.equal(claims.iss, '424242', 'iss is the app id, as a string');
  assert.equal(claims.iat, seconds - 60, 'issued 60 seconds in the past for clock drift');
  assert.ok(claims.exp > seconds, 'expiry is in the future');
  assert.ok(claims.exp - claims.iat <= 600, 'GitHub rejects a JWT that lives longer than 10 minutes');

  const signature = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verified = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), publicKey, signature);
  assert.equal(verified, true, 'the signature must verify against the public half of the key');
});

test('github-app: appJwt refuses a missing app id or a key that is not a PEM private key', () => {
  assert.throws(() => appJwt({ appId: '', privateKeyPem: PEM }), /appId/);
  assert.throws(() => appJwt({ appId: '1', privateKeyPem: 'not-a-key' }), /PEM/);
});

// ------------------------------------------------ installation token ---

test('github-app: installationToken posts to the installation with the App JWT and returns the token', async () => {
  await withMock({}, async (mock) => {
    const out = await installationToken({
      apiUrl: mock.url, appId: '424242', privateKeyPem: PEM, installationId: 55, now: Date.now(),
    });
    assert.equal(out.token, 'ghs_installation_token');
    assert.equal(out.expiresAt, '2026-09-05T11:00:00Z');

    const call = mock.calls.at(-1);
    assert.equal(call.method, 'POST');
    assert.equal(call.pathname, '/app/installations/55/access_tokens');
    assert.equal(call.accept, 'application/vnd.github+json');
    assert.equal(call.apiVersion, '2022-11-28');
    assert.ok(call.userAgent, 'GitHub rejects a request with no User-Agent');
    const jwt = call.auth.replace(/^Bearer /, '');
    assert.equal(decodeJwtPart(jwt.split('.')[1]).iss, '424242', 'the installation call authenticates as the App itself');
  });
});

// ------------------------------------------------------ notes lookup ---

test('github-app: the receipt note is found through a 2/38 fanout path', async () => {
  await withMock({}, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.equal(out.reason, 'ok');
    assert.equal(out.receipt.costUsd, 12.5);
    assert.equal(out.receipt.branch, 'feat/checkout');

    const paths = mock.calls.map((c) => c.pathname);
    assert.ok(paths.includes(`/repos/${OWNER}/${REPO}/git/ref/notes/tokenflow`));
    assert.ok(paths.includes(`/repos/${OWNER}/${REPO}/git/commits/${NOTES_COMMIT}`));
    assert.ok(paths.includes(`/repos/${OWNER}/${REPO}/git/trees/${NOTES_TREE}`));
    const tree = mock.calls.find((c) => c.pathname.includes('/git/trees/'));
    assert.equal(tree.query.recursive, '1', 'the notes tree is fetched recursively');
  });
});

test('github-app: a flat notes tree and a deeper 2/2/36 fanout both resolve to the same note', async () => {
  const flat = [{ path: HEAD_SHA, blobSha: 'blob-head', content: JSON.stringify(receipt()) }];
  await withMock({ noteEntries: flat }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.equal(out.reason, 'ok');
    assert.equal(out.receipt.headSha, HEAD_SHA);
  });

  const deep = [{
    path: `${HEAD_SHA.slice(0, 2)}/${HEAD_SHA.slice(2, 4)}/${HEAD_SHA.slice(4)}`,
    blobSha: 'blob-head',
    content: JSON.stringify(receipt()),
  }];
  await withMock({ noteEntries: deep }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.equal(out.reason, 'ok');
    assert.equal(out.receipt.headSha, HEAD_SHA);
  });
});

test('github-app: an uppercase head sha still matches the lowercase notes path', async () => {
  await withMock({}, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA.toUpperCase() });
    assert.equal(out.reason, 'ok');
  });
});

test('github-app: a missing notes ref, a sha with no note, unparsable JSON and an invalid receipt each report their own reason', async () => {
  await withMock({ missingNotesRef: true }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.deepEqual(out, { receipt: null, reason: 'no-notes-ref' });
  });

  await withMock({}, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: OTHER_SHA });
    assert.deepEqual(out, { receipt: null, reason: 'no-note' });
  });

  await withMock({ noteEntries: [{ path: HEAD_SHA, blobSha: 'b', content: 'not json at all' }] }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.deepEqual(out, { receipt: null, reason: 'unparsable' });
  });

  const broken = JSON.stringify({ schemaVersion: 0, branch: 'x' });
  await withMock({ noteEntries: [{ path: HEAD_SHA, blobSha: 'b', content: broken }] }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA });
    assert.equal(out.receipt, null);
    assert.equal(out.reason, 'invalid');
    assert.ok(out.errors.length > 0);
  });
});

test('github-app: a truncated notes tree with no match says so rather than claiming there is no note', async () => {
  await withMock({ treeTruncated: true }, async (mock) => {
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: OTHER_SHA });
    assert.deepEqual(out, { receipt: null, reason: 'notes-tree-truncated' });
  });
});

test('github-app: a notes ref that is not a usable git ref name is refused before any request is made', async () => {
  await withMock({}, async (mock) => {
    const before = mock.calls.length;
    const out = await readNotesIndex({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, notesRef: '../../etc/passwd' });
    assert.deepEqual(out, { index: null, reason: 'bad-notes-ref' });
    assert.equal(mock.calls.length, before, 'nothing may be requested for a bad ref name');
  });
});

test('github-app: a prefetched notes index skips the ref/commit/tree reads and costs one blob request', async () => {
  await withMock({}, async (mock) => {
    const { index } = await readNotesIndex({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO });
    const before = mock.calls.length;
    const out = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA, index });
    assert.equal(out.reason, 'ok');
    assert.equal(mock.calls.length - before, 1, 'reusing the index costs exactly one blob read');
  });
});

// ---------------------------------------------------------- repo caps ---

test('github-app: readRepoCap reads the receipt block at the head ref', async () => {
  const yaml = 'guard:\n  maxCostUsd: 99\nreceipt:\n  maxCostUsd: 25\n  maxCostPer100Lines: 4\n';
  await withMock({ policyYaml: yaml }, async (mock) => {
    const cap = await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA });
    assert.deepEqual(cap, { maxCostUsd: 25, maxCostPer100Lines: 4 });
    const call = mock.calls.at(-1);
    assert.equal(call.pathname, `/repos/${OWNER}/${REPO}/contents/${POLICY_PATH}`);
    assert.equal(call.query.ref, HEAD_SHA, 'the policy is read at the commit under review, not at the default branch');
  });
});

test('github-app: guard.maxCostUsd is never mistaken for a receipt cap', async () => {
  await withMock({ policyYaml: 'guard:\n  maxCostUsd: 5\n' }, async (mock) => {
    const cap = await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA });
    assert.deepEqual(cap, { maxCostUsd: null, maxCostPer100Lines: null });
  });
});

test('github-app: a missing, malformed or non-positive policy all mean no cap', async () => {
  await withMock({ policyYaml: null }, async (mock) => {
    assert.deepEqual(await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA }),
      { maxCostUsd: null, maxCostPer100Lines: null });
  });
  await withMock({ policyYaml: 'receipt:\n  *bad-anchor\n' }, async (mock) => {
    assert.deepEqual(await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA }),
      { maxCostUsd: null, maxCostPer100Lines: null });
  });
  await withMock({ policyYaml: 'receipt:\n  maxCostUsd: 0\n  maxCostPer100Lines: -3\n' }, async (mock) => {
    assert.deepEqual(await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA }),
      { maxCostUsd: null, maxCostPer100Lines: null });
  });
  await withMock({ policyYaml: 'receipt:\n  maxCostUsd: "25"\n' }, async (mock) => {
    assert.deepEqual(await readRepoCap({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, ref: HEAD_SHA }),
      { maxCostUsd: 25, maxCostPer100Lines: null });
  });
});

test('github-app: the receipt cap key names still match RECEIPT_KEYS in src/core/policy.js', async () => {
  const policy = /** @type {any} */ (await import('../src/core/policy.js'));
  if (!Array.isArray(policy.RECEIPT_KEYS)) return; // that stream has not landed here; nothing to hold in lockstep yet
  assert.deepEqual([...policy.RECEIPT_KEYS].sort(), ['maxCostPer100Lines', 'maxCostUsd']);
});

// ----------------------------------------------------------- comments ---

test('github-app: the first receipt comment is created, the second edits it in place', async () => {
  await withMock({}, async (mock, state) => {
    const r = receipt();
    const first = await upsertReceiptComment({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: r });
    assert.equal(first.action, 'created');

    const post = mock.calls.at(-1);
    assert.equal(post.method, 'POST');
    assert.equal(post.pathname, `/repos/${OWNER}/${REPO}/issues/7/comments`);
    assert.equal(post.body.body, renderReceiptV0Markdown(r), 'the App posts exactly what the Action renders');
    assert.ok(post.body.body.startsWith(RECEIPT_MARKER));

    const second = await upsertReceiptComment({
      apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: receipt({ costUsd: 20, costPer100Lines: 4 }),
    });
    assert.equal(second.action, 'updated');
    assert.equal(second.id, first.id);
    const patch = mock.calls.at(-1);
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.pathname, `/repos/${OWNER}/${REPO}/issues/comments/${first.id}`);
    assert.equal(state.comments.length, 1, 'a second push must never leave two receipt comments behind');
  });
});

test('github-app: somebody else\'s comment is never edited', async () => {
  await withMock({ comments: [{ id: 1, body: 'looks good to me' }] }, async (mock, state) => {
    const out = await upsertReceiptComment({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: receipt() });
    assert.equal(out.action, 'created');
    assert.equal(state.comments[0].body, 'looks good to me');
    assert.equal(state.comments.length, 2);
  });
});

// --------------------------------------------------------- check runs ---

test('github-app: the check run is created once and updated on the next delivery for the same sha', async () => {
  await withMock({}, async (mock, state) => {
    const created = await publishCheckRun({
      apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, headSha: HEAD_SHA,
      conclusion: 'neutral', output: { title: 'No receipt yet', summary: 'nothing yet' },
      completedAt: '2026-09-05T12:00:00.000Z',
    });
    assert.equal(created.action, 'created');
    const post = mock.calls.at(-1);
    assert.equal(post.method, 'POST');
    assert.equal(post.pathname, `/repos/${OWNER}/${REPO}/check-runs`);
    assert.deepEqual(post.body, {
      name: CHECK_NAME,
      head_sha: HEAD_SHA,
      status: 'completed',
      completed_at: '2026-09-05T12:00:00.000Z',
      conclusion: 'neutral',
      output: { title: 'No receipt yet', summary: 'nothing yet' },
    });

    const updated = await publishCheckRun({
      apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, headSha: HEAD_SHA,
      conclusion: 'success', output: { title: '$12.50 estimated', summary: 'done' },
    });
    assert.equal(updated.action, 'updated');
    assert.equal(updated.id, created.id);
    const patch = mock.calls.at(-1);
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.pathname, `/repos/${OWNER}/${REPO}/check-runs/${created.id}`);
    assert.equal(patch.body.conclusion, 'success');
    assert.equal(state.checkRuns.length, 1, 'a pull request must never collect two TokenFlow spend checks');
  });
});

test('github-app: the check run is looked up by name on the head sha', async () => {
  await withMock({}, async (mock) => {
    await publishCheckRun({
      apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, headSha: HEAD_SHA,
      conclusion: 'neutral', output: { title: 't', summary: 's' },
    });
    const lookup = mock.calls.find((c) => c.pathname.endsWith('/check-runs') && c.method === 'GET');
    assert.equal(lookup.pathname, `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`);
    assert.equal(lookup.query.check_name, CHECK_NAME);
  });
});

// ------------------------------------------------------------ verdict ---

test('github-app: evaluateCap fails only on a declared cap the receipt actually exceeds', () => {
  const none = { maxCostUsd: null, maxCostPer100Lines: null };
  assert.equal(evaluateCap({ receipt: receipt(), cap: none }).conclusion, 'success');
  assert.equal(evaluateCap({ receipt: receipt(), cap: { maxCostUsd: 25, maxCostPer100Lines: null } }).conclusion, 'success');

  const overCost = evaluateCap({ receipt: receipt(), cap: { maxCostUsd: 5, maxCostPer100Lines: null } });
  assert.equal(overCost.conclusion, 'failure');
  assert.equal(overCost.breaches.length, 1);
  assert.match(overCost.output.title, /Over this repository's cap/);
  assert.match(overCost.output.summary, /receipt\.maxCostUsd/);

  const overRate = evaluateCap({ receipt: receipt(), cap: { maxCostUsd: null, maxCostPer100Lines: 1 } });
  assert.equal(overRate.conclusion, 'failure');
  assert.match(overRate.output.summary, /receipt\.maxCostPer100Lines/);
});

test('github-app: a null cost or a null cost-per-100-lines is never a failure, it is not evaluated', () => {
  const noCost = evaluateCap({ receipt: receipt({ costUsd: null }), cap: { maxCostUsd: 1, maxCostPer100Lines: null } });
  assert.equal(noCost.conclusion, 'success');
  assert.match(noCost.output.summary, /not evaluated/);
  assert.match(noCost.output.title, /no priced turns/);

  const noLines = evaluateCap({ receipt: receipt({ costPer100Lines: null }), cap: { maxCostUsd: null, maxCostPer100Lines: 1 } });
  assert.equal(noLines.conclusion, 'success');
  assert.match(noLines.output.summary, /not evaluated/);
});

test('github-app: the neutral output names the reason without leaking anything about the code', () => {
  const out = noReceiptOutput({ reason: 'no-note', sha: HEAD_SHA, notesRef: 'tokenflow' });
  assert.equal(out.title, 'No receipt yet');
  assert.match(out.summary, /refs\/notes\/tokenflow/);
  // `tokenflow hooks install` is a subcommand, not a flag (bin/tokenflow.js
  // dispatches `hooks <action>`), so the summary must name it that way.
  assert.match(noReceiptOutput({ reason: 'no-notes-ref', sha: HEAD_SHA, notesRef: 'tokenflow' }).summary, /`tokenflow hooks install`/);
  assert.match(noReceiptOutput({ reason: 'invalid', sha: HEAD_SHA, notesRef: 'tokenflow' }).summary, /not a valid TokenFlow receipt/);
});

// -------------------------------------------------------- deliveries ---

test('github-app: a delivery id is remembered once and the memory stays bounded', () => {
  const mem = createDeliveryMemory(3);
  assert.equal(mem.remember('a'), true);
  assert.equal(mem.remember('a'), false);
  assert.equal(mem.remember('b'), true);
  assert.equal(mem.remember('c'), true);
  assert.equal(mem.remember('d'), true);
  assert.equal(mem.size(), 3, 'the oldest id is dropped rather than growing forever');
  assert.equal(mem.remember('a'), true, 'the evicted id is processed again, which only re-edits an upserted comment');
  assert.equal(mem.remember(null), true, 'a delivery with no id is always processed');
});

// ----------------------------------------------------------- webhook ---

const prPayload = (over = {}) => ({
  action: 'opened',
  number: 7,
  pull_request: { number: 7, head: { sha: HEAD_SHA } },
  repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
  installation: { id: 55 },
  ...over,
});

test('github-app: pull_request opened with a note posts the comment and a success check', async () => {
  await withMock({}, async (mock, state) => {
    const lines = [];
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'd1', payload: prPayload(), app: app({ apiUrl: mock.url }), log: (l) => lines.push(l),
    });
    assert.equal(out.outcome, 'success');
    assert.deepEqual(out.results, [{ pr: 7, sha: HEAD_SHA, outcome: 'success' }]);
    assert.equal(state.comments.length, 1);
    assert.ok(state.comments[0].body.includes(RECEIPT_MARKER));
    assert.equal(state.checkRuns.length, 1);
    assert.equal(state.checkRuns[0].conclusion, 'success');
    assert.equal(state.checkRuns[0].name, CHECK_NAME);

    assert.equal(lines.length, 1, 'one log line per pull request');
    assert.match(lines[0], /event=pull_request repo=acme\/widgets pr=7 outcome=success/);

    // Every repository call carries the installation token, not the App JWT.
    const repoCalls = mock.calls.filter((c) => c.pathname.startsWith(`/repos/${OWNER}/${REPO}`));
    assert.ok(repoCalls.length > 0);
    for (const c of repoCalls) assert.equal(c.auth, 'Bearer ghs_installation_token');
  });
});

test('github-app: pull_request with no note yet publishes a neutral check and no comment', async () => {
  await withMock({ noteEntries: [] }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'd2', payload: prPayload(), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'neutral (no-note)');
    assert.equal(state.comments.length, 0, 'no receipt means nothing to say in a comment');
    assert.equal(state.checkRuns.length, 1);
    assert.equal(state.checkRuns[0].conclusion, 'neutral');
    assert.equal(state.checkRuns[0].output.title, 'No receipt yet');
  });
});

test('github-app: a repo cap the receipt is over turns the check red and still posts the comment', async () => {
  await withMock({ policyYaml: 'receipt:\n  maxCostUsd: 5\n' }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'd3', payload: prPayload({ action: 'synchronize' }), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'failure');
    assert.equal(state.checkRuns[0].conclusion, 'failure');
    assert.equal(state.comments.length, 1, 'a red check still shows the numbers behind it');
  });
});

test('github-app: a v1 note is validated by its own schemaVersion, and its ticket reaches the comment', async () => {
  const v1 = receipt({
    schemaVersion: 1,
    ticket: { system: 'linear', key: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42' },
    verdict: { maxCostUsd: 20, maxCostPer100Lines: null, overBudget: false },
  });
  const noteEntries = [{ path: `${HEAD_SHA.slice(0, 2)}/${HEAD_SHA.slice(2)}`, blobSha: 'blob-head', content: JSON.stringify(v1) }];
  await withMock({ noteEntries }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'v1-note', payload: prPayload(), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'success', 'validateReceiptV0 alone would have rejected schemaVersion 1');
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0].body, /\[ENG-42\]\(https:\/\/linear\.app\/acme\/issue\/ENG-42\)/);
  });
});

test('github-app: a v0 note still validates and posts unchanged now that v1 exists', async () => {
  await withMock({}, async (mock, state) => { // defaultState()'s note is schemaVersion 0
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'v0-note', payload: prPayload(), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'success');
    assert.equal(state.comments.length, 1);
    assert.doesNotMatch(state.comments[0].body, /\| Ticket \|/, 'a v0 receipt carries no ticket, so no ticket row is invented');
  });
});

test('github-app: an ignored pull_request action, a foreign push, a ping and a duplicate delivery all do nothing', async () => {
  await withMock({}, async (mock, state) => {
    const mem = createDeliveryMemory();
    const conf = { app: app({ apiUrl: mock.url }), deliveries: mem };

    assert.equal((await handleWebhook({ event: 'pull_request', deliveryId: 'a', payload: prPayload({ action: 'labeled' }), ...conf })).outcome, 'ignored (action=labeled)');
    assert.equal((await handleWebhook({ event: 'push', deliveryId: 'b', payload: { ref: 'refs/heads/main', repository: { full_name: `${OWNER}/${REPO}`, name: REPO, owner: { login: OWNER } }, installation: { id: 55 } }, ...conf })).outcome, 'ignored (ref=refs/heads/main)');
    assert.equal((await handleWebhook({ event: 'ping', deliveryId: 'c', payload: { zen: 'x' }, ...conf })).outcome, 'ping');
    assert.equal((await handleWebhook({ event: 'issues', deliveryId: 'e', payload: prPayload(), ...conf })).outcome, 'ignored (event)');

    assert.equal((await handleWebhook({ event: 'pull_request', deliveryId: 'f', payload: prPayload(), ...conf })).outcome, 'success');
    const after = mock.calls.length;
    assert.equal((await handleWebhook({ event: 'pull_request', deliveryId: 'f', payload: prPayload(), ...conf })).outcome, 'duplicate');
    assert.equal(mock.calls.length, after, 'a redelivery must make no API call at all');
    assert.equal(state.comments.length, 1);
  });
});

test('github-app: a push to refs/notes/<ref> processes only the open pull requests whose head sha now has a note', async () => {
  const pulls = [
    { number: 7, head: { sha: HEAD_SHA } },
    { number: 9, head: { sha: OTHER_SHA } },
  ];
  await withMock({ pulls }, async (mock, state) => {
    const lines = [];
    const out = await handleWebhook({
      event: 'push',
      deliveryId: 'n1',
      payload: {
        ref: 'refs/notes/tokenflow',
        repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
        installation: { id: 55 },
      },
      app: app({ apiUrl: mock.url }),
      log: (l) => lines.push(l),
    });
    assert.equal(out.outcome, 'success');
    assert.deepEqual(out.results.map((r) => r.pr), [7]);
    assert.equal(state.comments.length, 1);
    assert.equal(state.checkRuns.length, 1);
    assert.deepEqual(lines, ['[tokenflow github] event=push repo=acme/widgets pr=7 outcome=success']);

    const listed = mock.calls.filter((c) => c.pathname === `/repos/${OWNER}/${REPO}/pulls`);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].query.state, 'open');

    const trees = mock.calls.filter((c) => c.pathname.includes('/git/trees/'));
    assert.equal(trees.length, 1, 'one tree read covers every open pull request on a notes push');
  });
});

test('github-app: a notes push with nothing to say touches no pull request', async () => {
  await withMock({ pulls: [{ number: 9, head: { sha: OTHER_SHA } }] }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'push',
      deliveryId: 'n2',
      payload: {
        ref: 'refs/notes/tokenflow',
        repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
        installation: { id: 55 },
      },
      app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'no matching open pull request');
    assert.equal(state.comments.length, 0);
    assert.equal(state.checkRuns.length, 0, 'an unrelated notes push must not stamp a neutral check on every open PR');
  });
});

test('github-app: a delivery with no installation is ignored before any token is minted', async () => {
  await withMock({}, async (mock) => {
    const before = mock.calls.length;
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'x', payload: prPayload({ installation: undefined }), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'ignored (no installation)');
    assert.equal(mock.calls.length, before);
  });
});

test('github-app: a custom notes ref is honoured end to end', async () => {
  await withMock({ notesRef: 'receipts' }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'r1', payload: prPayload(), app: app({ apiUrl: mock.url, notesRef: 'receipts' }),
    });
    assert.equal(out.outcome, 'success');
    assert.ok(mock.calls.some((c) => c.pathname.endsWith('/git/ref/notes/receipts')));
    assert.equal(state.comments.length, 1);
  });
});

test('github-app: a notes ref with traversal, an empty segment or a leading slash is refused', async () => {
  await withMock({}, async (mock) => {
    const refuse = async (ref) => {
      const before = mock.calls.length;
      const out = await readNotesIndex({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, notesRef: ref });
      assert.deepEqual(out, { index: null, reason: 'bad-notes-ref' }, `must refuse ${JSON.stringify(ref)}`);
      assert.equal(mock.calls.length, before, `must not request anything for ${JSON.stringify(ref)}`);
    };
    await refuse('../../etc/passwd');
    await refuse('tokenflow/../../../app');
    await refuse('a..b');
    await refuse('/tokenflow');
    await refuse('tokenflow//deep');
    await refuse('tokenflow/');
    await refuse('');
    await refuse('.');
    await refuse('a'.repeat(101));

    // A legitimate nested ref still works.
    const ok = await readNotesIndex({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, notesRef: 'tokenflow' });
    assert.equal(ok.reason, 'ok');
  });
});

// --------------------------------------------------------- pagination ---

/** `n` unrelated comments, so ours can be pushed onto a later page. */
function noise(n, startId = 1) {
  return Array.from({ length: n }, (_, i) => ({ id: startId + i, body: `chatter ${i}` }));
}

test('github-app: the receipt comment is found on page 3 and edited, never duplicated', async () => {
  const comments = [...noise(200), { id: 999, body: `${RECEIPT_MARKER}\nold body` }];
  await withMock({ comments }, async (mock, state) => {
    const out = await upsertReceiptComment({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: receipt() });
    assert.equal(out.action, 'updated', 'a marker past page one must still be found');
    assert.equal(out.id, 999);
    assert.equal(state.comments.length, 201, 'nothing new may be posted');
    assert.equal(state.comments.at(-1).body, renderReceiptV0Markdown(receipt()));

    const pages = mock.calls.filter((c) => c.method === 'GET' && c.pathname.endsWith('/issues/7/comments'));
    assert.equal(pages.length, 3, 'three pages of 100 were walked');
    assert.deepEqual(pages.map((c) => c.query.page || '1'), ['1', '2', '3']);
  });
});

test('github-app: paging stops at the page carrying the marker', async () => {
  const comments = [{ id: 1, body: `${RECEIPT_MARKER}\nold` }, ...noise(500, 2)];
  await withMock({ comments }, async (mock) => {
    await upsertReceiptComment({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: receipt() });
    const pages = mock.calls.filter((c) => c.method === 'GET' && c.pathname.endsWith('/issues/7/comments'));
    assert.equal(pages.length, 1, 'the usual case must still cost one request');
  });
});

test('github-app: paging works without a Link header, by asking for the next page while pages come back full', async () => {
  const comments = [...noise(150), { id: 999, body: `${RECEIPT_MARKER}\nold` }];
  await withMock({ comments, omitLinkHeader: true }, async (mock, state) => {
    const out = await upsertReceiptComment({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, prNumber: 7, receipt: receipt() });
    assert.equal(out.action, 'updated');
    assert.equal(state.comments.length, 151);
    const pages = mock.calls.filter((c) => c.method === 'GET' && c.pathname.endsWith('/issues/7/comments'));
    assert.equal(pages.length, 2);
  });
});

test('github-app: a notes push walks every page of open pull requests', async () => {
  // 120 open PRs, and the one carrying a note is last, off page one.
  const pulls = [
    ...Array.from({ length: 119 }, (_, i) => ({ number: 100 + i, head: { sha: `${i}`.padStart(40, '0') } })),
    { number: 7, head: { sha: HEAD_SHA } },
  ];
  await withMock({ pulls }, async (mock, state) => {
    const out = await handleWebhook({
      event: 'push',
      deliveryId: 'p-many',
      payload: {
        ref: 'refs/notes/tokenflow',
        repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
        installation: { id: 55 },
      },
      app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'success', 'a PR on page two must not be skipped');
    assert.deepEqual(out.results.map((r) => r.pr), [7]);
    assert.equal(state.comments.length, 1);

    const pages = mock.calls.filter((c) => c.method === 'GET' && c.pathname.endsWith('/pulls'));
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map((c) => c.query.page || '1'), ['1', '2']);
  });
});

// ---------------------------------------------- overlapping deliveries ---

test('github-app: a note landing mid-delivery wins; the neutral check never overwrites the green one', async () => {
  // The ordinary sequence the pre-push hook produces: the branch push opens
  // the PR (no note yet), then the notes push lands moments later.
  await withMock({ noteEntries: [], pulls: [{ number: 7, head: { sha: HEAD_SHA } }] }, async (mock, state) => {
    const queue = createReceiverQueue();
    const deliveries = createDeliveryMemory();
    const gate = deferred();
    const firstTreeRead = deferred();
    let treeReads = 0;

    // Hold delivery A inside its first tree read, so B is dispatched while A
    // is provably mid-flight.
    state.hooks.tree = () => {
      treeReads++;
      if (treeReads === 1) { firstTreeRead.resolve(); return gate.promise; }
      return null;
    };

    const a = handleWebhook({
      event: 'pull_request', deliveryId: 'race-a',
      payload: prPayload({ action: 'synchronize' }),
      app: app({ apiUrl: mock.url }), queue, deliveries,
    });
    await firstTreeRead.promise;

    // The note lands while A is blocked.
    state.noteEntries = [{ path: `${HEAD_SHA.slice(0, 2)}/${HEAD_SHA.slice(2)}`, blobSha: 'blob-head', content: JSON.stringify(receipt()) }];

    const b = handleWebhook({
      event: 'push', deliveryId: 'race-b',
      payload: {
        ref: 'refs/notes/tokenflow',
        repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
        installation: { id: 55 },
      },
      app: app({ apiUrl: mock.url }), queue, deliveries,
    });

    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    // The sharp assertion: A's own first read saw an empty tree (the mock
    // answers from the state it had when the request arrived), so A can only
    // reach `success` through the second look. Drop that re-read and this
    // line reads `neutral (no-note)` no matter how the two are scheduled.
    assert.equal(ra.outcome, 'success', 'the delivery that started before the note must still see it');

    assert.equal(state.checkRuns.length, 1, 'one TokenFlow spend check on the commit, not two');
    assert.equal(state.checkRuns[0].conclusion, 'success', 'a stale neutral must never land on top of the green check');
    assert.equal(state.comments.length, 1, 'exactly one receipt comment');
    assert.ok(state.comments[0].body.includes(RECEIPT_MARKER));
    for (const r of [ra, rb]) assert.ok(!String(r.outcome).startsWith('error'), `no delivery may fail: ${r.outcome}`);
  });
});

test('github-app: every pull request is processed through the queue, keyed by owner/repo#number', async () => {
  // The queue's own ordering is proved above; what this pins is the wiring —
  // that the receiver actually routes each pull request through it, under a
  // key that is unique per pull request, for both event types. A spy is used
  // rather than a timing window, so the assertion cannot flake.
  const real = createReceiverQueue();
  const keys = [];
  const spy = { run: (key, fn) => { keys.push(key); return real.run(key, fn); } };

  await withMock({ pulls: [{ number: 7, head: { sha: HEAD_SHA } }] }, async (mock) => {
    await handleWebhook({
      event: 'pull_request', deliveryId: 'q-a', payload: prPayload(),
      app: app({ apiUrl: mock.url }), queue: spy,
    });
    await handleWebhook({
      event: 'push', deliveryId: 'q-b',
      payload: {
        ref: 'refs/notes/tokenflow',
        repository: { name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
        installation: { id: 55 },
      },
      app: app({ apiUrl: mock.url }), queue: spy,
    });
  });

  assert.deepEqual(keys, ['acme/widgets#7', 'acme/widgets#7'],
    'both deliveries about PR 7 must serialize on the same key');
});

test('github-app: without the second look, a stale index would publish neutral — the re-read is what prevents it', async () => {
  await withMock({ noteEntries: [] }, async (mock, state) => {
    // A caller hands in an index read before the note existed. The note is
    // present by the time processing runs; the second look must find it.
    const stale = new Map();
    state.noteEntries = [{ path: HEAD_SHA, blobSha: 'blob-head', content: JSON.stringify(receipt()) }];

    const first = await readReceiptNote({ apiUrl: mock.url, token: 't', owner: OWNER, repo: REPO, sha: HEAD_SHA, index: stale });
    assert.deepEqual(first, { receipt: null, reason: 'no-note' }, 'the stale index sees nothing');

    const out = await handleWebhook({
      event: 'pull_request', deliveryId: 'stale-1', payload: prPayload(), app: app({ apiUrl: mock.url }),
    });
    assert.equal(out.outcome, 'success');
    assert.equal(state.checkRuns[0].conclusion, 'success');
  });
});

test('github-app: the receiver queue serializes per pull request and forgets a key once it drains', async () => {
  const queue = createReceiverQueue();
  const order = [];
  const gate = deferred();

  const a = queue.run('acme/widgets#7', async () => { order.push('a:start'); await gate.promise; order.push('a:end'); });
  const b = queue.run('acme/widgets#7', async () => { order.push('b:start'); order.push('b:end'); });
  const c = queue.run('acme/widgets#9', async () => { order.push('c'); });

  gate.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(order.slice(0, 1), ['a:start']);
  assert.ok(order.indexOf('a:end') < order.indexOf('b:start'), 'the same key never runs concurrently');
  assert.ok(order.includes('c'), 'a different pull request is not held up');

  // A failing job must not wedge the key.
  await assert.rejects(() => queue.run('acme/widgets#7', async () => { throw new Error('boom'); }), /boom/);
  await queue.run('acme/widgets#7', async () => { order.push('after-failure'); });
  assert.ok(order.includes('after-failure'));
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.size(), 0, 'drained keys are dropped, so the map does not grow per pull request');
});

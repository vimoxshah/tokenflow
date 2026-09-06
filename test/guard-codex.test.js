/**
 * Codex CLI has no blocking hook — its `notify` setting runs a program after
 * every turn with one JSON argument. `guard --codex-notify` reads that
 * payload, locates the matching rollout file, ingests it with the openai
 * adapter through the same incremental cache the Claude Code path uses, and
 * warns (never blocks) through an OS notification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCodexNotify, codexNotifySnippet, applyCodexInstall } from '../src/commands/guard.js';
import { loadProviders } from '../src/core/registry.js';
import { FIXTURES } from './helpers.js';

const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'codex-session.jsonl'), 'utf8');
const THREAD_ID = '019f2747-7d85-7641-b774-fake0thread';
const CWD = '/nonexistent/dev/projects/web-app'; // not a real repo on this machine: policy falls back to config everywhere

/** Run TOKENFLOW_HOME-scoped work in a fresh temp home, cleaned up after. */
function withHome(fn) {
  const prev = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-guard-codex-home-'));
  process.env.TOKENFLOW_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A rollout file at the real Codex naming convention: rollout-<ts>-<thread-id>.jsonl under sessions/<Y>/<M>/<D>/. */
function makeSessionsRoot(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-codex-sessions-'));
  const dir = path.join(root, '2026', '08', '02');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-02T09-00-00-${THREAD_ID}.jsonl`);
  fs.writeFileSync(file, contents);
  return { root, file };
}

/**
 * Wrap a parsed notify payload so any access to the message-content fields
 * throws instead of silently succeeding — proof that `evaluateCodexNotify`
 * never reads, logs or stores them.
 */
function guardedPayload(obj) {
  const forbidden = new Set(['input-messages', 'last-assistant-message']);
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && forbidden.has(prop)) {
        throw new Error(`payload['${prop}'] must never be read`);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && forbidden.has(prop)) {
        throw new Error(`payload['${prop}'] must never be probed`);
      }
      return Reflect.has(target, prop);
    },
  });
}

function notifyPayload(threadId = THREAD_ID, cwd = CWD) {
  return guardedPayload({
    type: 'agent-turn-complete',
    'thread-id': threadId,
    'turn-id': 'turn-B',
    cwd,
    'input-messages': ['do not read me'],
    'last-assistant-message': 'do not read me either',
  });
}

test('evaluateCodexNotify: locates the rollout by thread id, warns past a declared context cap, and never touches message fields', async () => {
  await loadProviders();
  await withHome(async () => {
    const { root } = makeSessionsRoot(FIXTURE);
    const calls = [];
    const config = { guard: { warnContextTokens: 30000 } };

    const r = await evaluateCodexNotify(notifyPayload(), {
      config,
      sessionsRoot: root,
      notify: async (n) => { calls.push(n); },
    });

    assert.equal(r.error, undefined);
    assert.equal(r.skipped, undefined);
    assert.equal(r.verdict.level, 'warn');
    assert.equal(r.verdict.turns, 2);
    assert.equal(r.verdict.contextTokens, 37500, 'the last turn (turn-B) carries the running prompt size');
    assert.match(r.verdict.reasons.join(' '), /prompt now carries/);
    assert.equal(r.notified, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].title, /TokenFlow guard \(Codex\)/);
    assert.match(calls[0].body, /\[WARN\]/);
    // The rendered notification must never contain the forbidden fields' text.
    assert.doesNotMatch(calls[0].body, /do not read me/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('evaluateCodexNotify: it cannot block — a cap crossed at the "max" level still only sends a warning notification', async () => {
  await loadProviders();
  await withHome(async () => {
    const { root } = makeSessionsRoot(FIXTURE);
    const calls = [];
    const config = { guard: { maxContextTokens: 30000 } };

    const r = await evaluateCodexNotify(notifyPayload(), { config, sessionsRoot: root, notify: async (n) => { calls.push(n); } });

    assert.equal(r.verdict.level, 'block', 'evaluateGuard itself still reports "block" — the policy math is unchanged');
    assert.equal(r.notified, true);
    assert.match(calls[0].title, /over the declared cap \(warning only — Codex has no blocking hook\)/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('evaluateCodexNotify: with nothing declared it is informational and sends no notification', async () => {
  await loadProviders();
  await withHome(async () => {
    const { root } = makeSessionsRoot(FIXTURE);
    const calls = [];
    const r = await evaluateCodexNotify(notifyPayload(), { config: {}, sessionsRoot: root, notify: async (n) => { calls.push(n); } });
    assert.equal(r.verdict.level, 'ok');
    assert.equal(r.notified, false);
    assert.equal(calls.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('evaluateCodexNotify: resumes incrementally — a rollout seen only up to turn-A does not yet warn, and the cache remembers the rollout path', async () => {
  await loadProviders();
  await withHome(async () => {
    const lines = FIXTURE.trim().split('\n');
    const turnAOnly = lines.slice(0, 7).join('\n') + '\n'; // through turn-A's task_complete
    const { root, file } = makeSessionsRoot(turnAOnly);
    const config = { guard: { warnContextTokens: 30000 } };

    const a = await evaluateCodexNotify(notifyPayload(), { config, sessionsRoot: root, notify: async () => {} });
    assert.equal(a.verdict.level, 'ok', 'turn-A alone (28,000 prompt tokens) is below the 30,000 warning level');
    assert.equal(a.verdict.turns, 1);

    fs.writeFileSync(file, lines.join('\n') + '\n'); // append turn-B
    const calls = [];
    const b = await evaluateCodexNotify(notifyPayload(), { config, sessionsRoot: root, notify: async (n) => { calls.push(n); } });
    assert.equal(b.verdict.level, 'warn');
    assert.equal(b.verdict.turns, 2);
    assert.equal(calls.length, 1);

    // A third call resolves the rollout from the cached path rather than by
    // walking sessionsRoot again: point sessionsRoot somewhere wrong and
    // confirm the file is still found (through the cache) and unchanged.
    const c = await evaluateCodexNotify(notifyPayload(), { config, sessionsRoot: '/does/not/exist', notify: async () => {} });
    assert.equal(c.skipped, undefined, 'not a skip: the cached path resolved even though sessionsRoot alone would not have found it');
    assert.equal(c.verdict.turns, 2, 'the cached rollout path was reused instead of re-searching sessionsRoot');

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('evaluateCodexNotify: no thread-id or no rollout file is a skip, never a throw', async () => {
  await loadProviders();
  await withHome(async () => {
    const noId = await evaluateCodexNotify(guardedPayload({ type: 'agent-turn-complete', cwd: CWD }), {});
    assert.equal(noId.skipped, true);

    const noRollout = await evaluateCodexNotify(notifyPayload('thread-with-no-rollout'), { sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'tf-codex-empty-')) });
    assert.equal(noRollout.skipped, true);
  });
});

// ------------------------------------------------------------- guard install --codex ---

test('codexNotifySnippet: the exact TOML line, using the given execPath and bin path', () => {
  const line = codexNotifySnippet({ execPath: '/usr/local/bin/node', binPath: '/opt/tokenflow/bin/tokenflow.js' });
  assert.equal(line, 'notify = ["/usr/local/bin/node","/opt/tokenflow/bin/tokenflow.js","guard","--codex-notify"]');
});

test('applyCodexInstall: appends the line when there is no existing notify key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-codex-config-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
  const line = codexNotifySnippet({ execPath: '/bin/node', binPath: '/x/tokenflow.js' });

  const res = applyCodexInstall({ configPath, snippet: line });
  assert.equal(res.applied, true);
  const written = fs.readFileSync(configPath, 'utf8');
  assert.match(written, /model = "gpt-5\.6-sol"/, 'the existing content is preserved');
  assert.match(written, /notify = \["\/bin\/node","\/x\/tokenflow\.js","guard","--codex-notify"\]/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall: never overwrites an existing notify key — including the real multi-line TOML array shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-codex-config-existing-'));
  const configPath = path.join(dir, 'config.toml');
  // The exact shape codex CLI itself writes when notify targets a multi-arg program.
  fs.writeFileSync(configPath, [
    '# --- some other tool, auto-injected ---',
    'notify = [',
    '    "/Users/dev/.codex/some-app/SomeClient.app/Contents/MacOS/SomeClient",',
    '    "turn-ended",',
    ']',
    'model = "gpt-5.6-sol"',
    '',
  ].join('\n'));

  const res = applyCodexInstall({ configPath, snippet: codexNotifySnippet() });
  assert.equal(res.applied, false);
  assert.match(res.reason, /already declares a "notify" key/);
  const unchanged = fs.readFileSync(configPath, 'utf8');
  assert.match(unchanged, /SomeClient\.app/, 'the original notify target is untouched');
  assert.doesNotMatch(unchanged, /codex-notify/, 'nothing of ours was appended');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall: no ~/.codex directory on this machine prints instructions instead of creating one', () => {
  const configPath = path.join(os.tmpdir(), `tf-codex-missing-${Date.now()}`, 'config.toml');
  const res = applyCodexInstall({ configPath });
  assert.equal(res.applied, false);
  assert.match(res.reason, /does not exist/);
  assert.equal(fs.existsSync(configPath), false);
});

/**
 * `tokenflow hooks`: install/uninstall of the pre-push git hook (chaining a
 * pre-existing one and restoring it), and the pre-push body itself — parsing
 * git's stdin, writing a receipt note, pushing it to a remote (a local bare
 * repo stands in for one, so this runs fully offline), and never recursing
 * into itself when TOKENFLOW_HOOK_NESTED=1 is set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  install, uninstall, status, prePush, run, renderHookScript,
} from '../src/commands/hooks.js';
import { buildBranchReceipt, readNote } from '../src/core/receipt-note.js';
import { validateReceipt } from '../src/analytics/receipt-schema.js';
import { Store, encodeRecord } from '../src/core/store.js';

const ALL_ZERO_SHA = '0'.repeat(40);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repo with one commit on main (pushed to a local bare "remote"), plus a feat/x commit. */
function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hooks-'));
  const repo = path.join(tmp, 'repo');
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'tester@example.com'], repo);
  git(['config', 'user.name', 'Tester'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['init', '-q', '--bare', bare], tmp);
  git(['remote', 'add', 'origin', bare], repo);
  git(['push', '-q', 'origin', 'main'], repo);
  git(['checkout', '-q', '-b', 'feat/x'], repo);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'work\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'feature work'], repo);
  const sha = git(['rev-parse', 'feat/x'], repo);
  return { tmp, repo, bare, sha };
}

function withHome(fn) {
  const prev = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hooks-home-'));
  process.env.TOKENFLOW_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** One priced primary record on `feat/x`, attributed to `repoPath` via metadata.cwd. */
function seedRecord(repoPath, overrides = {}) {
  const store = new Store();
  const rec = {
    timestamp: '2026-08-01T10:00:00.000Z', date: '2026-08-01', hour: 10, dow: 6, tz_offset: null,
    provider: 'anthropic', provider_label: null, gateway: null,
    model: 'claude-opus-5', model_family: 'Claude Opus 5',
    client: 'claude-code', application: null, interface: 'CLI',
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 100_000, cache_write_tokens: 2000,
    cache_refresh_tokens: null, reasoning_tokens: null, total_tokens: null, total_is_partial: false,
    session_id: 's1', conversation_id: null, request_id: 'req1',
    project: 'repo', repository: 'repo', git_branch: 'feat/x', category: 'main', service_tier: null,
    estimated_cost: 0.02, cost_basis: 'estimated',
    source: 'anthropic', measurement: 'primary', user: 'tester', machine: 'test-machine',
    duration_ms: null, metadata: { cwd: repoPath }, id: 'r1',
    ...overrides,
  };
  store.writer(rec.date).write(encodeRecord(rec));
  store.closeWriters();
}

function stdinFor(sha, branch = 'feat/x', remoteSha = ALL_ZERO_SHA) {
  return `refs/heads/${branch} ${sha} refs/heads/${branch} ${remoteSha}\n`;
}

// -------------------------------------------------------------- renderHookScript ---

test('renderHookScript: never-recurse guard, chaining, and an unconditional exit 0', () => {
  const s = renderHookScript();
  assert.match(s, /^#!\/bin\/sh/);
  assert.match(s, /TOKENFLOW_HOOK_NESTED/);
  assert.match(s, /pre-push\.tokenflow-chained/);
  assert.match(s, /hooks pre-push "\$@"/);
  assert.match(s, /exit 0\s*$/, 'the script must end by forcing exit 0');
  assert.ok(s.includes(process.execPath), 'bakes in the node binary that ran install');
  assert.match(s, /bin[\\/]tokenflow\.js/);
});

// -------------------------------------------------------------------- install ---

test('install: writes a fresh hook when none existed', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = install({ repo });
  assert.match(fs.readFileSync(r.path, 'utf8'), /tokenflow:pre-push/);
  assert.equal(r.chained, false);
  // NTFS has no execute bit, so the mode reads 0 there; Git for Windows runs
  // hooks through sh regardless of mode.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.path).mode & 0o111, 0o111, 'hook must be executable');
  }
});

test('install: chains a pre-existing foreign hook instead of clobbering it', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-push');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign-hook\nexit 3\n');
  fs.chmodSync(hookPath, 0o755);

  const r = install({ repo });
  assert.equal(r.chained, true);
  const chainedPath = path.join(hooksDir, 'pre-push.tokenflow-chained');
  assert.match(fs.readFileSync(chainedPath, 'utf8'), /foreign-hook/);
  assert.match(fs.readFileSync(hookPath, 'utf8'), /tokenflow:pre-push/);

  const s = status({ repo });
  assert.equal(s.installed, true);
  assert.equal(s.chained, true);
});

test('install: running it again is idempotent and does not re-chain itself', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  install({ repo });
  const r2 = install({ repo });
  assert.equal(r2.chained, false, 'our own hook is recognized and not treated as foreign');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push.tokenflow-chained')), false);
});

// ------------------------------------------------------------------ uninstall ---

test('uninstall: restores the chained foreign hook', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hookPath = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign-hook\nexit 3\n');
  fs.chmodSync(hookPath, 0o755);
  install({ repo });

  const r = uninstall({ repo });
  assert.equal(r.restored, true);
  assert.match(fs.readFileSync(hookPath, 'utf8'), /foreign-hook/);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push.tokenflow-chained')), false);
});

test('uninstall: with nothing chained, just removes our hook', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  install({ repo });
  const r = uninstall({ repo });
  assert.equal(r.restored, false);
  assert.equal(fs.existsSync(r.path), false);
});

test('uninstall: leaves a foreign (non-tokenflow) hook untouched', (t) => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hookPath = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, '#!/bin/sh\necho not-ours\n');
  fs.chmodSync(hookPath, 0o755);
  const r = uninstall({ repo }); // never installed by us on this repo
  assert.equal(r.restored, false);
  assert.match(fs.readFileSync(hookPath, 'utf8'), /not-ours/);
});

// -------------------------------------------------------------------- pre-push ---

test('pre-push: parses stdin, writes a receipt note, and pushes it to the remote', (t) => withHome(() => {
  const { tmp, repo, bare, sha } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seedRecord(repo);

  const result = prePush({ repo, args: ['origin'], stdin: stdinFor(sha) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, null);

  const note = readNote({ repoPath: repo, sha });
  assert.ok(note, 'a note should be attached locally');
  assert.equal(note.schemaVersion, 1);
  assert.equal(note.branch, 'feat/x');
  assert.equal(note.headSha, sha);
  assert.ok(note.costUsd > 0);
  assert.equal(note.pr, null, 'no PR is known at push time');

  assert.equal(note.ticket, null, '"feat/x" names no ticket, and an absent ticket is null, not omitted');
  assert.equal(note.verdict, null, 'this repo declares no receipt cap, so nothing judged it');
  assert.equal(validateReceipt(note).ok, true, validateReceipt(note).errors.join('; '));

  // Pushed to the (local, bare) remote too — offline, no network involved.
  const pushed = execFileSync('git', ['notes', '--ref=tokenflow', 'show', sha], { cwd: bare, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(pushed), note);
}));

test('receipt note: v1 carries the ticket the branch names and the verdict against the repo cap', (t) => withHome(() => {
  const { tmp, repo } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const branch = 'feat/ENG-42-widget';
  git(['checkout', '-q', '-b', branch], repo);
  fs.writeFileSync(path.join(repo, 'widget.txt'), 'work\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'widget'], repo);
  seedRecord(repo, { git_branch: branch, id: 'r2', session_id: 's2' });

  const writeCap = (usd) => {
    fs.mkdirSync(path.join(repo, '.tokenflow'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tokenflow', 'policy.yaml'), `receipt:\n  maxCostUsd: ${usd}\n`);
  };

  const uncapped = buildBranchReceipt({ repoPath: repo, branch });
  assert.equal(uncapped.schemaVersion, 1);
  assert.deepEqual(uncapped.ticket, { system: 'other', key: 'ENG-42', url: null });
  assert.equal(uncapped.verdict, null, 'no cap declared is "nobody judged this", never "it passed"');
  assert.ok(uncapped.costUsd > 0, 'the seeded turn must price for the caps below to mean anything');

  // The caps bracket the receipt's own cost, so this holds whatever the price table says.
  writeCap(Number((uncapped.costUsd / 2).toFixed(6)));
  const over = buildBranchReceipt({ repoPath: repo, branch });
  assert.equal(over.verdict.overBudget, true);
  assert.equal(over.verdict.maxCostPer100Lines, null, 'an undeclared cap stays null rather than being invented');
  assert.equal(validateReceipt(over).ok, true, validateReceipt(over).errors.join('; '));

  writeCap(Number((uncapped.costUsd * 2).toFixed(6)));
  const within = buildBranchReceipt({ repoPath: repo, branch });
  assert.equal(within.verdict.overBudget, false);
}));

test('pre-push: a branch with no local sessions writes no note and never blocks', (t) => withHome(() => {
  const { tmp, repo, sha } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // No seedRecord() this time: nothing local attributes to feat/x.
  const result = prePush({ repo, args: ['origin'], stdin: stdinFor(sha) });
  assert.equal(result.exitCode, 0);
  assert.equal(readNote({ repoPath: repo, sha }), null);
}));

test('pre-push: skips ref deletes and non-branch refs, never crashing', (t) => withHome(() => {
  const { tmp, repo, sha } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seedRecord(repo);
  const stdin = [
    `refs/heads/feat/x ${ALL_ZERO_SHA} refs/heads/feat/x ${sha}`, // a delete
    `refs/tags/v1 ${sha} refs/tags/v1 ${ALL_ZERO_SHA}`, // a tag, not a branch
    '',
  ].join('\n');
  const result = prePush({ repo, args: ['origin'], stdin });
  assert.equal(result.exitCode, 0);
  assert.equal(readNote({ repoPath: repo, sha }), null, 'neither line names a branch update to attach a note to');
}));

test('pre-push: a nested invocation (TOKENFLOW_HOOK_NESTED=1) exits immediately without writing anything', (t) => withHome(() => {
  const { tmp, repo, sha } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seedRecord(repo);
  const prev = process.env.TOKENFLOW_HOOK_NESTED;
  process.env.TOKENFLOW_HOOK_NESTED = '1';
  try {
    const result = prePush({ repo, args: ['origin'], stdin: stdinFor(sha) });
    assert.deepEqual(result, { stdout: null, stderr: null, exitCode: 0 });
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOOK_NESTED; else process.env.TOKENFLOW_HOOK_NESTED = prev;
  }
  assert.equal(readNote({ repoPath: repo, sha }), null, 'the nested guard must short-circuit before any note is written');
}));

// -------------------------------------------------------------------------- run ---

test('run: dispatches action to install/uninstall/status/pre-push, and rejects an unknown action', (t) => withHome(() => {
  const { tmp, repo, sha } = makeRepo();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seedRecord(repo);

  const installed = run({ action: 'install', repo });
  assert.equal(installed.exitCode, 0);
  assert.match(installed.stdout, /installed/);

  const st = run({ action: 'status', repo });
  assert.match(st.stdout, /installed: yes/);

  const pushed = run({ action: 'pre-push', repo, args: ['origin'], stdin: stdinFor(sha) });
  assert.equal(pushed.exitCode, 0);
  assert.ok(readNote({ repoPath: repo, sha }));

  const uninstalled = run({ action: 'uninstall', repo });
  assert.match(uninstalled.stdout, /uninstalled/);

  const bogus = run({ action: 'nonsense', repo });
  assert.equal(bogus.exitCode, 1);
  assert.match(bogus.stderr, /usage: tokenflow hooks/);
}));

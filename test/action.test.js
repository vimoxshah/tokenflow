/**
 * The GitHub Action's upsert logic (action/index.js), with every side effect
 * injected: a fake `fetch` that records calls instead of touching the
 * network, and a real (but local, offline) git repo for the notes read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  run, readNoteForSha, findExistingComment, upsertComment,
} from '../action/index.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A one-commit repo, with a receipt note optionally attached to its head sha. */
function makeRepo({ withNote = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-action-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'tester@example.com'], repo);
  git(['config', 'user.name', 'Tester'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const sha = git(['rev-parse', 'HEAD'], repo);

  if (withNote) {
    const receipt = {
      schemaVersion: 0,
      generatedAt: '2026-08-01T00:00:00.000Z',
      toolVersion: '1.0.0',
      repo: 'repo',
      branch: 'feat/x',
      headSha: sha,
      window: { first: '2026-08-01T00:00:00.000Z', last: '2026-08-01T01:00:00.000Z' },
      costUsd: 1.23,
      contextShare: 0.5,
      turns: 3,
      sessions: 1,
      subagentTurns: 0,
      models: [{ model: 'Claude Opus 5', costUsd: 1.23, share: 1 }],
      coverage: 1,
      largestPromptTokens: 1000,
      changedLines: null,
      pr: null,
      longLived: false,
      costPer100Lines: null,
      notes: ['Estimated locally by TokenFlow. No prompt or code content was read.'],
    };
    const noteFile = path.join(tmp, 'note.json');
    fs.writeFileSync(noteFile, JSON.stringify(receipt));
    git(['notes', '--ref=tokenflow', 'add', '-F', noteFile, sha], repo);
  }
  return { tmp, repo, sha };
}

function makeEventFile(tmp, { sha, number = 7 }) {
  const file = path.join(tmp, 'event.json');
  fs.writeFileSync(file, JSON.stringify({ pull_request: { number, head: { sha } } }));
  return file;
}

function baseEnv(eventPath) {
  return {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'octo/repo',
    'INPUT_TOKEN': 'ghs_test_token',
    'INPUT_NOTES-REF': 'tokenflow',
    'INPUT_COMMENT-MARKER': '<!-- tokenflow-receipt -->',
  };
}

/** A fetch stub that records every call and answers GET with `comments`. */
function fakeFetch(comments) {
  const calls = [];
  const fetchImpl = async (url, opt = {}) => {
    const method = opt.method || 'GET';
    calls.push({ url, method, body: opt.body ? JSON.parse(opt.body) : undefined });
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => comments, text: async () => '' };
    }
    return {
      ok: true,
      status: method === 'POST' ? 201 : 200,
      json: async () => ({ id: 999, body: JSON.parse(opt.body).body }),
      text: async () => '',
    };
  };
  // The real signature is `typeof fetch`, but the mock returns only the
  // subset of Response every caller here actually reads (ok/status/json/text).
  return { fetchImpl: /** @type {typeof fetch} */ (fetchImpl), calls };
}

// ------------------------------------------------------------------ readNoteForSha ---

test('readNoteForSha: reads back a real note, and returns null when there is none', (t) => {
  const withNote = makeRepo({ withNote: true });
  const withoutNote = makeRepo({ withNote: false });
  t.after(() => {
    fs.rmSync(withNote.tmp, { recursive: true, force: true });
    fs.rmSync(withoutNote.tmp, { recursive: true, force: true });
  });
  const note = readNoteForSha({ sha: withNote.sha, notesRef: 'tokenflow', cwd: withNote.repo });
  assert.equal(note.branch, 'feat/x');
  assert.equal(readNoteForSha({ sha: withoutNote.sha, notesRef: 'tokenflow', cwd: withoutNote.repo }), null);
});

// -------------------------------------------------------------------------- run ---

test('run: PATCHes the existing comment when one already carries the marker', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 7 });
  const { fetchImpl, calls } = fakeFetch([
    { id: 55, body: 'unrelated comment' },
    { id: 56, body: '<!-- tokenflow-receipt -->\nold content' },
  ]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 2, 'one GET to list comments, one write to update the match');
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/issues\/7\/comments/);
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /\/issues\/comments\/56$/);
  assert.match(calls[1].body.body, /<!-- tokenflow-receipt -->/);
  assert.match(calls[1].body.body, /feat\/x/);
});

test('run: POSTs a new comment when no existing comment carries the marker', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 9 });
  const { fetchImpl, calls } = fakeFetch([{ id: 1, body: 'totally unrelated' }]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/issues\/9\/comments$/);
  assert.match(calls[1].body.body, /<!-- tokenflow-receipt -->/);
});

test('run: no note on the head sha is a no-op — no fetch call at all', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: false });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 3 });
  const { fetchImpl, calls } = fakeFetch([]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 0);
});

test('run: an event that is not a pull_request is a no-op', async (t) => {
  const { tmp, repo } = makeRepo({ withNote: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = path.join(tmp, 'push-event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ ref: 'refs/heads/main' }));
  const { fetchImpl, calls } = fakeFetch([]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 0);
});

test('run: a receipt that fails schema validation is not posted', async (t) => {
  const { tmp, repo } = makeRepo({ withNote: false });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  git(['config', 'user.email', 'tester@example.com'], repo);
  const sha = git(['rev-parse', 'HEAD'], repo);
  const noteFile = path.join(tmp, 'bad-note.json');
  fs.writeFileSync(noteFile, JSON.stringify({ schemaVersion: 1, branch: 'feat/x' })); // missing required fields, wrong version
  git(['notes', '--ref=tokenflow', 'add', '-F', noteFile, sha], repo);
  const eventPath = makeEventFile(tmp, { sha, number: 4 });
  const { fetchImpl, calls } = fakeFetch([]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 0, 'an invalid receipt must never be posted');
});

test('run: missing GITHUB_EVENT_PATH is a no-op', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  await run({ env: { GITHUB_REPOSITORY: 'octo/repo' }, fetchImpl, cwd: process.cwd() });
  assert.equal(calls.length, 0);
});

// --------------------------------------------------- findExistingComment / upsert ---

test('findExistingComment: matches on the marker substring, not exact equality', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { id: 1, body: 'no marker here' },
    { id: 2, body: 'intro text\n<!-- tokenflow-receipt -->\nmore text' },
  ]);
  const found = await findExistingComment({
    fetchImpl, repoFull: 'octo/repo', prNumber: 5, token: 't', marker: '<!-- tokenflow-receipt -->',
  });
  assert.equal(found.id, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('upsertComment: PATCHes with an existing comment, POSTs without one', async () => {
  const post = fakeFetch([]);
  await upsertComment({
    fetchImpl: post.fetchImpl, repoFull: 'octo/repo', prNumber: 5, token: 't', existing: null, body: 'hello',
  });
  assert.equal(post.calls[0].method, 'POST');
  assert.match(post.calls[0].url, /\/issues\/5\/comments$/);

  const patch = fakeFetch([]);
  await upsertComment({
    fetchImpl: patch.fetchImpl, repoFull: 'octo/repo', prNumber: 5, token: 't', existing: { id: 77 }, body: 'hello',
  });
  assert.equal(patch.calls[0].method, 'PATCH');
  assert.match(patch.calls[0].url, /\/issues\/comments\/77$/);
});

test('upsertComment: a non-ok response is not swallowed', async () => {
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (
    async () => ({ ok: false, status: 403, text: async () => 'forbidden' })
  ));
  await assert.rejects(
    () => upsertComment({ fetchImpl, repoFull: 'octo/repo', prNumber: 5, token: 't', existing: null, body: 'x' }),
    /403/,
  );
});

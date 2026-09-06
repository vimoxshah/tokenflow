/**
 * Attribution fixes:
 *   1. Codex branch/repository capture from `session_meta.git`.
 *   2. Worktree checkouts filed under their main checkout at normalisation
 *      time (not query time).
 *   3. A `metadata.repoResolved` marker for cwds that resolve to no
 *      repository at all, so the doctor can find them later.
 *
 * Existing behaviour for records with no `metadata.cwd` at all must be
 * unchanged (asserted with a synthetic record, not a real adapter, so it
 * cannot be invalidated by an unrelated adapter change).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import openai, { repoNameFromUrl } from '../src/providers/openai/index.js';
import { enrich } from '../src/core/ingest.js';
import { validateUsage } from '../src/core/validate.js';
import { MEASUREMENT } from '../src/core/schema.js';
import { ingestFixtureAsync, ctx, FIXTURES } from './helpers.js';

// ===================================================== Codex branch capture ==

test('codex: session_meta.git.branch and repository_url become git_branch / repository', async () => {
  const { records } = await ingestFixtureAsync(openai, 'codex-session-git.jsonl');
  const withGit = records.find((r) => r.request_id === 'turn-git-1');
  assert.ok(withGit, 'the with-git turn was emitted');
  assert.equal(withGit.git_branch, 'feature/attribution-fix');
  assert.equal(withGit.repository, 'upstream-repo-name', 'basename of repository_url, .git suffix stripped');
  assert.equal(withGit.project, 'proj-checkout', 'project logic is unchanged: basename of cwd');
  assert.equal(withGit.metadata.cwd, '/Users/dev/workspaces/proj-checkout');

  const dump = JSON.stringify(withGit);
  assert.equal(dump.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false, 'the commit hash is never stored');
  assert.equal(dump.includes('example.invalid'), false, 'the repository URL itself is never stored');

  const v = validateUsage(withGit);
  assert.ok(v.ok, `invalid record: ${v.errors.join('; ')}`);
});

test('codex: a session_meta with no git block falls back to the pre-existing behaviour', async () => {
  // Slice the same fixture at the byte offset where the second, git-less
  // session starts, and re-ingest it with fresh state — exactly what a
  // resumed read of an independent file looks like.
  const raw = fs.readFileSync(path.join(FIXTURES, 'codex-session-git.jsonl'), 'utf8');
  const marker = '{"timestamp": "2026-08-05T10:00:00.000Z"';
  const idx = raw.indexOf(marker);
  assert.ok(idx > 0, 'fixture layout changed — test marker not found');
  const start = Buffer.byteLength(raw.slice(0, idx), 'utf8');

  const { records } = await ingestFixtureAsync(openai, 'codex-session-git.jsonl', { start, state: {} });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.request_id, 'turn-nogit-1');
  assert.equal(r.git_branch, null, 'no git block on session_meta -> no branch');
  assert.equal(r.repository, 'no-git-checkout', 'falls back to the cwd basename, same as project');
  assert.equal(r.project, 'no-git-checkout');

  const v = validateUsage(r);
  assert.ok(v.ok, `invalid record: ${v.errors.join('; ')}`);
});

test('codex: repoNameFromUrl keeps only the basename, .git suffix stripped', () => {
  assert.equal(repoNameFromUrl('https://example.invalid/org/my-repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl('git@example.invalid:org/my-repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl('https://example.invalid/org/my-repo'), 'my-repo', 'no suffix to strip');
  assert.equal(repoNameFromUrl(null), null);
  assert.equal(repoNameFromUrl(''), null);
  assert.equal(repoNameFromUrl(42), null, 'non-string input never throws');
});

// ============================================================ worktrees =====

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A one-commit repo plus one worktree, for exercising repoRootOf end to end. */
function makeRepoWithWorktree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-attribution-'));
  const main = path.join(tmp, 'main-repo');
  fs.mkdirSync(main, { recursive: true });
  git(['init', '-q'], main);
  git(['config', 'user.email', 'test@example.invalid'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), 'hello\n');
  git(['add', 'README.md'], main);
  git(['commit', '-q', '-m', 'init'], main);
  const worktree = path.join(tmp, 'wt-checkout');
  git(['worktree', 'add', '-q', worktree, '-b', 'feature/wt'], main);
  return { tmp, main, worktree };
}

const testProvider = { id: 'test-src', name: 'Test Source', measurement: MEASUREMENT.PRIMARY };

function partialFor(cwd, overrides = {}) {
  return {
    timestamp: '2026-08-05T12:00:00.000Z',
    model: 'gpt-5.6-sol',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: null,
    cache_write_tokens: null,
    session_id: `sess-${path.basename(cwd)}`,
    project: path.basename(cwd),
    repository: path.basename(cwd),
    metadata: { cwd },
    ...overrides,
  };
}

test('ingest: a worktree checkout is filed under the main checkout, not its own basename', () => {
  const { tmp, main, worktree } = makeRepoWithWorktree();
  try {
    const c = ctx();
    let seq = 0;
    const recMain = enrich(partialFor(main), { ctx: c, provider: testProvider, seq: seq++ });
    const recWt = enrich(partialFor(worktree), { ctx: c, provider: testProvider, seq: seq++ });

    assert.equal(recMain.project, 'main-repo');
    assert.equal(recWt.project, 'main-repo', 'the worktree lands on the same project as the main checkout');
    assert.equal(recMain.metadata.repoResolved, true);
    assert.equal(recWt.metadata.repoResolved, true);

    // The adapter derived `repository` the same way it derived the (broken)
    // `project` — basename of cwd, i.e. `repository === project` — so it is
    // just as wrong, and follows `project` to the main checkout.
    assert.equal(recWt.repository, 'main-repo', "repository derived from the directory name is corrected along with project");

    // When the adapter left `repository` null, it follows `project` too.
    const recWtNullRepo = enrich(partialFor(worktree, { repository: null }), {
      ctx: c, provider: testProvider, seq: seq++,
    });
    assert.equal(recWtNullRepo.repository, 'main-repo');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ingest: a repository derived from real evidence (a git remote) is authoritative and survives a worktree cwd', () => {
  const { tmp, main, worktree } = makeRepoWithWorktree();
  try {
    const c = ctx();
    // Mirrors what the openai adapter now emits when `session_meta.git` was
    // present: `repository` came from the remote URL, not from the checkout
    // directory's name, so it differs from `project` (basename of cwd).
    const partial = partialFor(worktree, { repository: 'upstream-repo-name' });
    const rec = enrich(partial, { ctx: c, provider: testProvider, seq: 0 });
    assert.equal(rec.project, 'main-repo', 'project still moves to the main checkout');
    assert.equal(rec.repository, 'upstream-repo-name', "a repository that differs from the adapter's own project is real evidence, not a directory-name guess, and is left alone");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ingest: the repo cache is shared across records for the same ctx (repoRootOf runs once)', () => {
  const { tmp, main, worktree } = makeRepoWithWorktree();
  try {
    /** @type {ReturnType<typeof ctx> & {repoCache?: Map<string, string|null>}} */
    const c = ctx();
    let seq = 0;
    // enrich() lazily creates ctx.repoCache (per src/core/repo.js's contract:
    // "cached per cwd"); the same ctx object must carry it across records.
    enrich(partialFor(worktree), { ctx: c, provider: testProvider, seq: seq++ });
    assert.ok(c.repoCache instanceof Map, 'a cache is attached to ctx');
    assert.ok(c.repoCache.has(worktree), 'the worktree cwd was resolved and cached');
    assert.equal(path.basename(c.repoCache.get(worktree)), 'main-repo');
    const rec = enrich(partialFor(worktree), { ctx: c, provider: testProvider, seq: seq++ });
    assert.equal(rec.project, 'main-repo', 'the cached lookup still resolves the same way');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===================================================== cwd basename marker ==

test('ingest: a cwd outside any repository keeps the adapter value and marks repoResolved: false', () => {
  // Pre-seed the cache with the "no root found" answer for a cwd that does
  // not exist on disk at all. `repoRootOf` checks its cache before touching
  // the filesystem (src/core/repo.js), so this deterministically exercises
  // the "no root" branch without depending on the host's temp directory
  // being free of a stray `.git` somewhere above it (which real hosts can
  // have — see the same caveat in test/receipt.test.js's `repoRootOf` test).
  /** @type {ReturnType<typeof ctx> & {repoCache?: Map<string, string|null>}} */
  const c = ctx();
  const cwd = '/no/such/repository/anywhere';
  c.repoCache = new Map([[cwd, null]]);
  const rec = enrich(partialFor(cwd), { ctx: c, provider: testProvider, seq: 0 });
  assert.equal(rec.project, path.basename(cwd), "no repo root found -> the adapter's own value is kept");
  assert.equal(rec.repository, path.basename(cwd));
  assert.equal(rec.metadata.repoResolved, false);
});

test('ingest: records without metadata.cwd are unaffected (no repoResolved key at all)', () => {
  // Built directly with enrich() + a synthetic provider rather than a real
  // adapter, so this stays true regardless of what any given adapter decides
  // to put in `metadata` later.
  const partial = {
    timestamp: '2026-08-05T12:00:00.000Z',
    model: 'gpt-5.6-sol',
    input_tokens: 10,
    output_tokens: 5,
    project: 'some-project',
    repository: 'some-project',
    metadata: { note: 'no cwd on this record' },
  };
  const rec = enrich(partial, { ctx: ctx(), provider: testProvider, seq: 0 });
  assert.equal(rec.project, 'some-project', "no cwd -> the adapter's own project is untouched");
  assert.equal(rec.repository, 'some-project');
  assert.equal('repoResolved' in rec.metadata, false, 'no cwd -> normalisation is a no-op, marker is not added');
});

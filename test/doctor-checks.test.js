import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, encodeRecord } from '../src/core/store.js';
import { createRecord } from '../src/core/schema.js';
import { auditChecks, renderChecks } from '../src/commands/doctor-checks.js';

/** Fresh $TOKENFLOW_HOME per test, so nothing here touches a real install. */
function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-doctor-'));
  const prev = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME;
    else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Write records straight to the store's shards, the same way ingest.js does. */
function writeRecords(store, records) {
  for (const rec of records) store.writer(rec.date).write(encodeRecord(rec));
  store.closeWriters();
}

/**
 * A real main checkout + a real worktree on disk, so `repoRootOf` (which
 * walks the filesystem) resolves them for real. Built OUTSIDE this repo and
 * outside $TOKENFLOW_HOME, under its own mkdtemp, so walking up 12 levels can
 * never accidentally land on the tokenflow repo's own .git.
 */
function makeWorktreeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-repo-'));
  const repoRoot = path.join(base, 'myrepo');
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  const worktreeDir = path.join(base, 'myrepo-worktrees', 'feature-x');
  fs.mkdirSync(worktreeDir, { recursive: true });
  const gitdir = path.join(repoRoot, '.git', 'worktrees', 'feature-x');
  fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${gitdir}\n`);
  return { base, repoRoot, worktreeDir };
}

/** `/tmp` (verified clean of a `.git` up to filesystem root), falling back to `os.tmpdir()` if it does not exist (e.g. Windows). */
function noRepoTmpRoot() {
  return fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
}

function checkById(rows, id) {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, `expected a check with id "${id}"`);
  return row;
}

test('auditChecks: worktree split, cwd-basename, unpriced model, Codex without branch, hermes, repoResolved marker', () => {
  // withHome's callback receives the fresh $TOKENFLOW_HOME dir; this test
  // reaches the store through `new Store()` instead, so the dir itself is unused.
  withHome(() => {
    const { base, repoRoot, worktreeDir } = makeWorktreeFixture();
    try {
      // `repoRootOf` walks real ancestors looking for `.git`. `os.tmpdir()`
      // (the per-user `$TMPDIR`) is not a safe "definitely no repo above
      // here" location — on a shared machine another process can leave a
      // stray `.git` right at its root. `/tmp` (== `/private/tmp` on macOS)
      // and everything above it up to `/` are verified clean, so the
      // "cwd resolves to no repository" fixture is anchored there instead.
      const plainDir = fs.mkdtempSync(path.join(noRepoTmpRoot(), 'aud-plain-'));
      try {
        const store = new Store();
        const now = new Date('2026-09-05T00:00:00Z');

        const records = [
          // (a) worktree-split: filed under the worktree's own leaf name.
          createRecord({
            timestamp: '2026-09-01T10:00:00.000Z', date: '2026-09-01', hour: 10, dow: 1,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50,
            source: 'x', project: 'feature-x', estimated_cost: 8, cost_basis: 'estimated',
            metadata: { cwd: worktreeDir },
          }),
          // Correctly filed under the resolved repo name — same true repo,
          // used to prove totalSpend/share are computed across both.
          createRecord({
            timestamp: '2026-09-02T10:00:00.000Z', date: '2026-09-02', hour: 10, dow: 2,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50,
            source: 'x', project: 'myrepo', estimated_cost: 2, cost_basis: 'estimated',
            metadata: { cwd: repoRoot },
          }),
          // (b) cwd resolves to no repository at all.
          createRecord({
            timestamp: '2026-09-01T11:00:00.000Z', date: '2026-09-01', hour: 11, dow: 1,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5,
            source: 'x', project: path.basename(plainDir),
            metadata: { cwd: plainDir },
          }),
          // (c) Codex (openai) primary record with no git_branch.
          createRecord({
            timestamp: '2026-09-03T09:00:00.000Z', date: '2026-09-03', hour: 9, dow: 3,
            provider: 'openai', model: 'gpt-5.6-terra', input_tokens: 10, output_tokens: 5,
            source: 'openai', measurement: 'primary', git_branch: null,
          }),
          // Codex record WITH a branch, same month — proves the share is partial, not 100%.
          createRecord({
            timestamp: '2026-09-03T09:30:00.000Z', date: '2026-09-03', hour: 9, dow: 3,
            provider: 'openai', model: 'gpt-5.6-terra', input_tokens: 10, output_tokens: 5,
            source: 'openai', measurement: 'primary', git_branch: 'main',
          }),
          // Non-Codex record with no branch — must NOT count toward the Codex check.
          createRecord({
            timestamp: '2026-09-03T09:00:00.000Z', date: '2026-09-03', hour: 9, dow: 3,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5,
            source: 'x', git_branch: null,
          }),
          // (d) unpriced model: no BUILTIN_PRICES pattern matches this string.
          createRecord({
            timestamp: '2026-09-04T10:00:00.000Z', date: '2026-09-04', hour: 10, dow: 4,
            provider: 'unknown', model: 'totally-unpriced-model-xyz', input_tokens: 1000, output_tokens: 1000,
            source: 'generic', measurement: 'primary',
          }),
          // A priced model in the same window, so the unpriced share is partial.
          createRecord({
            timestamp: '2026-09-04T10:30:00.000Z', date: '2026-09-04', hour: 10, dow: 4,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 1000,
            source: 'x', measurement: 'primary',
          }),
          // (f) hermes: a session-level source.
          createRecord({
            timestamp: '2026-09-04T12:00:00.000Z', date: '2026-09-04', hour: 12, dow: 4,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 5, output_tokens: 5,
            source: 'hermes', measurement: 'primary',
          }),
          // (g) an explicit repoResolved: false marker from some other agent's code.
          createRecord({
            timestamp: '2026-09-04T13:00:00.000Z', date: '2026-09-04', hour: 13, dow: 4,
            provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 5, output_tokens: 5,
            source: 'x', metadata: { repoResolved: false },
          }),
        ];
        writeRecords(store, records);

        const rows = auditChecks({ store: new Store(), config: {}, now });
        assert.equal(rows.length, 7, 'one row per check');

        // (a)
        const worktree = checkById(rows, 'worktree-split-projects');
        assert.equal(worktree.level, 'warn', 'a repo with a hidden majority of its spend warns');
        assert.equal(worktree.data.repoCount, 1);
        const g = worktree.data.groups[0];
        assert.equal(g.repo, 'myrepo');
        assert.equal(g.misfiledRecords, 1);
        assert.equal(g.misfiledSpend, 8);
        assert.equal(g.totalSpend, 10);
        assert.equal(g.share, 0.8);

        // (b)
        const cwdCheck = checkById(rows, 'cwd-basename-projects');
        assert.equal(cwdCheck.level, 'info');
        assert.equal(cwdCheck.data.count, 1);
        assert.equal(cwdCheck.data.topNames[0].name, path.basename(plainDir));

        // (c)
        const codex = checkById(rows, 'codex-missing-branch');
        assert.equal(codex.level, 'warn', 'a partial share of missing branches warns, not fails');
        assert.equal(codex.data.totalRecords, 2);
        assert.equal(codex.data.noBranchRecords, 1);
        assert.equal(codex.data.overallShare, 0.5);
        const sept = codex.data.months.find((m) => m.month === '2026-09');
        assert.ok(sept);
        assert.equal(sept.total, 2);
        assert.equal(sept.noBranch, 1);

        // (d)
        const unpriced = checkById(rows, 'unpriced-models');
        assert.equal(unpriced.data.unpricedCount, 1);
        assert.equal(unpriced.data.models[0].model, 'totally-unpriced-model-xyz');
        assert.equal(unpriced.data.unpricedTokens, 2000);
        // Every primary-measurement record's total_tokens, summed across the whole
        // scan: 150+150+15+15+15+15+2000+2000+10+10 = 4380.
        assert.equal(unpriced.data.totalTokens, 4380, 'sums total_tokens of every primary record scanned');
        assert.equal(unpriced.data.share, 2000 / 4380);
        assert.equal(unpriced.level, 'fail', '~45.7% unpriced is over the 30% fail threshold');

        // (f)
        const sessionLevel = checkById(rows, 'session-level-sources');
        assert.equal(sessionLevel.level, 'info');
        assert.deepEqual(sessionLevel.data.sources, [{ id: 'hermes', count: 1 }]);

        // (g)
        const repoResolved = checkById(rows, 'repo-resolved-false');
        assert.equal(repoResolved.level, 'warn');
        assert.equal(repoResolved.data.present, true);
        assert.equal(repoResolved.data.count, 1);

        // renderChecks: one line per check title, no console noise when print:false.
        const text = renderChecks(rows, { print: false, color: false });
        for (const row of rows) assert.ok(text.includes(row.title), `renders "${row.title}"`);
        assert.ok(text.includes('fix:'), 'a fix line is present for at least one non-ok check');
      } finally {
        fs.rmSync(plainDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test('auditChecks: repoResolved marker absent from every record is "ok", not an error', () => {
  withHome(() => {
    const store = new Store();
    writeRecords(store, [
      createRecord({
        timestamp: '2026-09-01T10:00:00.000Z', date: '2026-09-01', hour: 10, dow: 1,
        provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 1, output_tokens: 1, source: 'x',
      }),
    ]);
    const rows = auditChecks({ store: new Store(), now: new Date('2026-09-05T00:00:00Z') });
    const row = checkById(rows, 'repo-resolved-false');
    assert.equal(row.level, 'ok');
    assert.equal(row.data.present, false);
    assert.equal(row.data.count, 0);
  });
});

test('auditChecks: empty store is clean across every check', () => {
  withHome(() => {
    const store = new Store();
    const rows = auditChecks({ store, now: new Date('2026-09-05T00:00:00Z') });
    assert.equal(rows.length, 7);
    for (const row of rows) {
      if (row.id === 'stale-price-table') continue; // depends only on the calendar, not the store
      assert.equal(row.level, 'ok', `${row.id} should be ok on an empty store, got ${row.level}: ${row.detail}`);
    }
  });
});

test('auditChecks: stale-price-table flags an old built-in table', () => {
  withHome(() => {
    const store = new Store();
    const soon = auditChecks({ store, now: new Date('2026-08-25T00:00:00Z') });
    assert.equal(checkById(soon, 'stale-price-table').level, 'ok');

    const later = auditChecks({ store, now: new Date('2026-11-15T00:00:00Z') }); // ~87 days after 2026-08-20
    assert.equal(checkById(later, 'stale-price-table').level, 'warn');

    const muchLater = auditChecks({ store, now: new Date('2027-06-01T00:00:00Z') }); // > 180 days after
    assert.equal(checkById(muchLater, 'stale-price-table').level, 'fail');
  });
});

test('auditChecks: maxScanRecords caps the scan, and records past the cap are not counted', () => {
  withHome(() => {
    const store = new Store();
    const records = [];
    // First 3 records (the cap): plain, nothing for any check to flag.
    for (let i = 0; i < 3; i++) {
      records.push(createRecord({
        timestamp: `2026-09-0${i + 1}T10:00:00.000Z`, date: `2026-09-0${i + 1}`, hour: 10, dow: 1,
        provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 1, output_tokens: 1, source: 'x',
      }));
    }
    // Records 4-6, past the cap: an unpriced model that WOULD trip the
    // unpriced-models check if it were ever scanned.
    for (let i = 3; i < 6; i++) {
      records.push(createRecord({
        timestamp: `2026-09-0${i + 1}T10:00:00.000Z`, date: `2026-09-0${i + 1}`, hour: 10, dow: 1,
        provider: 'unknown', model: 'past-the-cap-unpriced-model', input_tokens: 100, output_tokens: 100,
        source: 'generic', measurement: 'primary',
      }));
    }
    writeRecords(store, records);

    const rows = auditChecks({ store: new Store(), now: new Date('2026-09-06T00:00:00Z'), maxScanRecords: 3 });
    const unpriced = checkById(rows, 'unpriced-models');
    assert.equal(unpriced.data.unpricedCount, 0, 'the unpriced record past the cap was never scanned');
    assert.equal(unpriced.level, 'ok');
    assert.ok(unpriced.detail.includes('capped at 3 records scanned'), `expected a truncation note, got: ${unpriced.detail}`);

    const uncapped = auditChecks({ store: new Store(), now: new Date('2026-09-06T00:00:00Z') });
    const unpricedUncapped = checkById(uncapped, 'unpriced-models');
    assert.equal(unpricedUncapped.data.unpricedCount, 1, 'without a cap, the same record is found');
    assert.ok(!unpricedUncapped.detail.includes('capped at'), 'no truncation note when the scan was not capped');
  });
});

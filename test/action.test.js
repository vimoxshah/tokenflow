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
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  run, readNoteForSha, findExistingComment, upsertComment, readPolicyCaps, judgeBudget,
} from '../action/index.js';
import { parseYaml } from '../src/core/yaml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A one-commit repo, with a receipt note optionally attached to its head sha. */
function makeRepo({ withNote = true, receiptOverrides = {} } = {}) {
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
      ...receiptOverrides,
    };
    const noteFile = path.join(tmp, 'note.json');
    fs.writeFileSync(noteFile, JSON.stringify(receipt));
    git(['notes', '--ref=tokenflow', 'add', '-F', noteFile, sha], repo);
  }
  return { tmp, repo, sha };
}

/** Writes `<repo>/<policyFile>` (default `.tokenflow/policy.yaml`) with the given yaml text. */
function writePolicyFile(repo, yamlText, policyFile = '.tokenflow/policy.yaml') {
  const file = path.join(repo, policyFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlText);
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
  fs.writeFileSync(noteFile, JSON.stringify({ schemaVersion: 1, branch: 'feat/x' })); // a known version, but almost every required field is missing
  git(['notes', '--ref=tokenflow', 'add', '-F', noteFile, sha], repo);
  const eventPath = makeEventFile(tmp, { sha, number: 4 });
  const { fetchImpl, calls } = fakeFetch([]);

  await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(calls.length, 0, 'an invalid receipt must never be posted');
});

test('run: a v1 note is validated by its own schemaVersion and its ticket and verdict reach the comment', async (t) => {
  const { tmp, repo, sha } = makeRepo({
    receiptOverrides: {
      schemaVersion: 1,
      ticket: { system: 'jira', key: 'ENG-42', url: 'https://jira.example/browse/ENG-42' },
      verdict: { maxCostUsd: 5, maxCostPer100Lines: null, overBudget: false },
    },
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 11 });
  const { fetchImpl, calls } = fakeFetch([]);

  const res = await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(res.posted, true, 'validateReceiptV0 would have rejected schemaVersion 1; the dispatcher must not');
  assert.equal(calls[1].method, 'POST');
  const body = calls[1].body.body;
  assert.match(body, /\[ENG-42\]\(https:\/\/jira\.example\/browse\/ENG-42\)/);
  assert.match(body, /within budget/);
});

test('run: a v0 note still posts unchanged now that v1 exists', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // schemaVersion 0 by default
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 12 });
  const { fetchImpl, calls } = fakeFetch([]);

  const res = await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(res.posted, true);
  const body = calls[1].body.body;
  assert.match(body, /feat\/x/);
  assert.doesNotMatch(body, /\| Ticket \|/, 'a v0 receipt carries no ticket, so no ticket row is invented');
  assert.doesNotMatch(body, /\| Budget \|/, 'and no verdict row either');
});

test('run: missing GITHUB_EVENT_PATH is a no-op', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  await run({ env: { GITHUB_REPOSITORY: 'octo/repo' }, fetchImpl, cwd: process.cwd() });
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ budget/verdict ---

test('run: over budget (max-usd input) fails the job and renders the verdict', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // fixture costUsd is 1.23
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 11 });
  const { fetchImpl, calls } = fakeFetch([]);
  const outputFile = path.join(tmp, 'output.txt');
  const summaryFile = path.join(tmp, 'summary.md');

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD': '1', GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, true);
  assert.equal(result.failJob, true, 'fail-on-over-budget defaults to true');
  assert.equal(result.costUsd, 1.23);
  assert.match(result.verdict, /^Over budget:/);
  assert.match(calls[1].body.body, /\*\*Over budget\*\*: cost \$1\.23 is over the \$1\.00 cap/);

  const output = fs.readFileSync(outputFile, 'utf8');
  assert.match(output, /^cost-usd=1\.23$/m);
  assert.match(output, /^over-budget=true$/m);
  assert.match(output, /^verdict=Over budget:/m);
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /\*\*Over budget\*\*/);
});

test('run: under budget (max-usd input) passes the job', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // fixture costUsd is 1.23
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 12 });
  const { fetchImpl, calls } = fakeFetch([]);

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD': '5' },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, false);
  assert.equal(result.failJob, false);
  assert.match(result.verdict, /^Within budget:/);
  assert.match(calls[1].body.body, /\*\*Within budget\*\*: cost \$1\.23 is within the \$5\.00 cap/);
});

test('run: fail-on-over-budget "false" reports over budget without failing the job', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // fixture costUsd is 1.23
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 13 });
  const { fetchImpl } = fakeFetch([]);

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD': '1', 'INPUT_FAIL-ON-OVER-BUDGET': 'false' },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, true);
  assert.equal(result.failJob, false, 'fail-on-over-budget=false must never fail the job');
});

test('run: cap read from the policy file when no input is set', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // fixture costUsd is 1.23
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  writePolicyFile(repo, ['receipt:', '  maxCostUsd: 1', ''].join('\n'));
  const eventPath = makeEventFile(tmp, { sha, number: 14 });
  const { fetchImpl, calls } = fakeFetch([]);

  const result = await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(result.overBudget, true, 'the policy file cap (1) is under the fixture cost (1.23)');
  assert.match(calls[1].body.body, /\*\*Over budget\*\*/);
});

test('run: an action input wins over the policy file for the same cap', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true }); // fixture costUsd is 1.23
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  writePolicyFile(repo, ['receipt:', '  maxCostUsd: 1', ''].join('\n'));
  const eventPath = makeEventFile(tmp, { sha, number: 15 });
  const { fetchImpl } = fakeFetch([]);

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD': '5' },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, false, 'the 5 input cap wins over the 1 policy cap');
});

test('run: no input and no policy file means no cap and no verdict added to the comment', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 16 });
  const { fetchImpl, calls } = fakeFetch([]);

  const result = await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(result.overBudget, false);
  assert.equal(result.failJob, false);
  assert.equal(result.verdict, 'No budget cap declared');
  assert.doesNotMatch(calls[1].body.body, /Over budget|Within budget|Budget cap not evaluated/);
});

test('run: a malformed policy file is treated as no cap, never a crash', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A flow mapping: parseYaml throws on this ("flow mappings are not supported"),
  // which is exactly the parse-failure path readPolicyCaps must swallow.
  writePolicyFile(repo, 'receipt: {maxCostUsd: 1}\n');
  const eventPath = makeEventFile(tmp, { sha, number: 17 });
  const { fetchImpl } = fakeFetch([]);

  const result = await run({ env: baseEnv(eventPath), fetchImpl, cwd: repo });

  assert.equal(result.overBudget, false);
  assert.equal(result.verdict, 'No budget cap declared');
});

test('run: a per-100-lines cap on a receipt with no changed-line cost is reported as not evaluated', async (t) => {
  const { tmp, repo, sha } = makeRepo({ withNote: true, receiptOverrides: { costPer100Lines: null } });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 18 });
  const { fetchImpl, calls } = fakeFetch([]);

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD-PER-100-LINES': '5' },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, false, 'a cap with nothing to compare against is never "over"');
  assert.equal(result.failJob, false);
  assert.equal(result.verdict, 'Budget cap not evaluated: per-100-lines cap $5.00 not evaluated (no changed-line cost on this receipt)');
  assert.match(calls[1].body.body, /\*\*Budget cap not evaluated\*\*/);
});

test('run: a per-100-lines cap on a receipt with a matched PR is evaluated', async (t) => {
  const { tmp, repo, sha } = makeRepo({
    withNote: true,
    receiptOverrides: { pr: { number: 42, mergedAt: null }, changedLines: 400, costPer100Lines: 8 },
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const eventPath = makeEventFile(tmp, { sha, number: 19 });
  const { fetchImpl, calls } = fakeFetch([]);

  const result = await run({
    env: { ...baseEnv(eventPath), 'INPUT_MAX-USD-PER-100-LINES': '5' },
    fetchImpl,
    cwd: repo,
  });

  assert.equal(result.overBudget, true, '$8 per 100 lines is over the $5 cap');
  assert.match(calls[1].body.body, /\$8\.00 per 100 lines is over the \$5\.00 cap/);
});

test('readPolicyCaps: a missing file means no cap for either key', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policycaps-'));
  try {
    assert.deepEqual(readPolicyCaps({ cwd: tmp, policyFile: '.tokenflow/policy.yaml' }), { maxCostUsd: null, maxCostPer100Lines: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPolicyCaps: reads both receipt keys, ignoring an unrelated guard block', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policycaps-'));
  try {
    writePolicyFile(tmp, ['guard:', '  maxCostUsd: 999', 'receipt:', '  maxCostUsd: 10', '  maxCostPer100Lines: 2', ''].join('\n'));
    assert.deepEqual(readPolicyCaps({ cwd: tmp, policyFile: '.tokenflow/policy.yaml' }), { maxCostUsd: 10, maxCostPer100Lines: 2 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPolicyCaps: a negative or non-numeric declared value is treated as no cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policycaps-'));
  try {
    writePolicyFile(tmp, ['receipt:', '  maxCostUsd: -5', '  maxCostPer100Lines: "not a number"', ''].join('\n'));
    assert.deepEqual(readPolicyCaps({ cwd: tmp, policyFile: '.tokenflow/policy.yaml' }), { maxCostUsd: null, maxCostPer100Lines: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPolicyCaps: a file parseYaml cannot parse at all is treated as no cap, never a crash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policycaps-'));
  try {
    // A flow mapping: parseYaml throws ("flow mappings are not supported").
    writePolicyFile(tmp, 'receipt: {maxCostUsd: 1}\n');
    assert.doesNotThrow(() => readPolicyCaps({ cwd: tmp, policyFile: '.tokenflow/policy.yaml' }));
    assert.deepEqual(readPolicyCaps({ cwd: tmp, policyFile: '.tokenflow/policy.yaml' }), { maxCostUsd: null, maxCostPer100Lines: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('judgeBudget: no cap declared reports anyDeclared false and a null heading', () => {
  const budget = judgeBudget({ costUsd: 1, costPer100Lines: null }, { maxCostUsd: null, maxCostPer100Lines: null });
  assert.equal(budget.anyDeclared, false);
  assert.equal(budget.overBudget, false);
  assert.equal(budget.heading, null);
});

test('judgeBudget: exactly at the cap counts as within budget, not over', () => {
  const budget = judgeBudget({ costUsd: 10, costPer100Lines: null }, { maxCostUsd: 10, maxCostPer100Lines: null });
  assert.equal(budget.overBudget, false);
  assert.equal(budget.heading, 'Within budget');
});

test('action.yml files: root and action/ agree on everything except runs.main', () => {
  const root = parseYaml(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
  const nested = parseYaml(fs.readFileSync(path.join(ROOT, 'action', 'action.yml'), 'utf8'));
  assert.equal(root.runs.main, 'action/index.js');
  assert.equal(nested.runs.main, 'index.js');
  delete root.runs.main;
  delete nested.runs.main;
  assert.deepEqual(root, nested, 'the two action metadata files must otherwise be identical');
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

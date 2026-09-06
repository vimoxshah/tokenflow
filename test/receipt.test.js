/**
 * Receipts and the guard: attribution to a branch / PR, the context-vs-work
 * split, session concentration, and the in-session circuit breaker — the
 * pure analytics plus the Node commands that feed them (worktree resolution,
 * incremental transcript reads, hook output).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitCost, promptTokens, isAttributableBranch, buildReceipts, sessionStats, evaluateGuard,
  renderReceiptMarkdown, renderReceiptsTable, renderSessionStats, renderGuard, UNATTRIBUTED,
} from '../src/analytics/receipt.js';
import { buildPriceBook, estimateCost } from '../src/core/pricing.js';
import { repoRootOf, makeRepoResolver, run as runReceiptCommand } from '../src/commands/receipt.js';
import { Store, encodeRecord } from '../src/core/store.js';
import { validateReceipt } from '../src/analytics/receipt-schema.js';
import { readTranscript, evaluateSession, hookOutput, applySet, installSnippet, GUARD_KEYS } from '../src/commands/guard.js';
import { loadProviders } from '../src/core/registry.js';
import { loadConfig } from '../src/core/config.js';
import { FIXTURES } from './helpers.js';

const book = buildPriceBook({});

/** A priced Opus 5 record; override anything. */
function rec(o = {}) {
  const base = /** @type {any} */ ({
    measurement: 'primary', provider: 'anthropic', model: 'claude-opus-5', model_family: 'Claude Opus 5',
    source: 'anthropic', category: 'main', session_id: 's1', git_branch: 'feat/x',
    timestamp: '2026-08-01T10:00:00.000Z', service_tier: null, cost_basis: 'estimated',
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 100_000, cache_write_tokens: 2000, cache_refresh_tokens: null,
    metadata: {}, repository: 'repo', project: 'repo',
    ...o,
  });
  if (base.estimated_cost === undefined) base.estimated_cost = estimateCost(base, base.model, base.provider, book).cost;
  return base;
}

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ------------------------------------------------------------ splitCost ---

test('splitCost: context + work equals the stored estimate, and context is the cache buckets', () => {
  const r = rec();
  // Opus 5: in $5, out $25, cache read $0.5, cache write $6.25 per MTok
  close(r.estimated_cost, 0.005 + 0.0125 + 0.05 + 0.0125);
  const s = splitCost(r, book);
  close(s.context + s.work, r.estimated_cost);
  close(s.context, 0.05 + 0.0125);
  close(s.work, 0.005 + 0.0125);
});

test('splitCost: unpriced and measured records split to null, never to zero', () => {
  assert.deepEqual(splitCost(rec({ estimated_cost: null }), book), { context: null, work: null });
  assert.deepEqual(splitCost(rec({ cost_basis: 'measured', estimated_cost: 1.5 }), book), { context: null, work: null });
  assert.deepEqual(splitCost(rec(), null), { context: null, work: null });
});

test('promptTokens: null when nothing is reported, partial sums otherwise', () => {
  assert.equal(promptTokens({ input_tokens: null, cache_read_tokens: null, cache_write_tokens: null }), null);
  assert.equal(promptTokens({ input_tokens: 10, cache_read_tokens: null, cache_write_tokens: 5 }), 15);
});

test('isAttributableBranch: detached HEAD and missing branches name no unit of work', () => {
  assert.equal(isAttributableBranch('HEAD'), false);
  assert.equal(isAttributableBranch(null), false);
  assert.equal(isAttributableBranch(''), false);
  assert.equal(isAttributableBranch('main'), true);
});

// -------------------------------------------------------- buildReceipts ---

const corpus = () => [
  rec({ session_id: 's1' }),
  rec({ session_id: 's1', category: 'subagent', timestamp: '2026-08-01T11:00:00.000Z' }),
  rec({ session_id: 's2', timestamp: '2026-08-02T09:00:00.000Z' }),
  rec({ git_branch: 'feat/y', session_id: 's3', cache_read_tokens: 10_000 }),
  rec({ git_branch: 'HEAD', session_id: 's4' }),
  rec({ git_branch: null, session_id: 's5' }),
  rec({ measurement: 'activity', source: 'git', estimated_cost: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null }),
];

test('buildReceipts: groups by branch, parks HEAD/null as unattributed, ignores activity records', () => {
  const res = buildReceipts(corpus(), { book });
  assert.equal(res.repos.length, 1);
  const R = res.repos[0];
  assert.equal(R.repo, 'repo');
  assert.deepEqual(R.branches.map((b) => b.key), ['feat/x', 'feat/y']);
  const x = R.branches[0];
  assert.equal(x.turns, 3);
  assert.equal(x.sessions, 2);
  assert.equal(x.subagentTurns, 1);
  close(x.subagentShare, 1 / 3);
  close(x.cost, 3 * rec().estimated_cost);
  close(x.contextShare, (0.05 + 0.0125) / rec().estimated_cost);
  assert.equal(x.models[0].model, 'Claude Opus 5');
  assert.equal(R.unattributed.key, UNATTRIBUTED);
  assert.equal(R.unattributed.turns, 2);
  assert.equal(R.unattributed.sessions, 2);
  close(res.totals.attributedShare, (x.cost + R.branches[1].cost) / res.totals.cost);
});

test('buildReceipts: joins pull requests by head branch, prices per 100 changed lines, ranks vs the median', () => {
  const prs = [
    { number: 7, headRefName: 'feat/x', additions: 80, deletions: 20, title: 'x', mergedAt: '2026-08-03T00:00:00Z' },
    { number: 8, headRefName: 'release/cut-1', additions: 3, deletions: 1 },
    { number: 9, headRefName: 'feat/elsewhere', additions: 1, deletions: 1 },
  ];
  const res = buildReceipts(corpus(), { book, prs, automated: /^release\// });
  const R = res.repos[0];
  const x = R.branches.find((b) => b.key === 'feat/x');
  const y = R.branches.find((b) => b.key === 'feat/y');
  assert.equal(x.pr.number, 7);
  assert.equal(x.changedLines, 100);
  close(x.costPer100Lines, x.cost);
  assert.equal(y.pr, null);
  const med = (x.cost + y.cost) / 2;
  close(x.vsMedian, x.cost / med);
  assert.equal(R.prs.supplied, 3);
  assert.equal(R.prs.matched, 1);
  assert.deepEqual(R.prs.unmatched.map((u) => [u.number, u.automated]), [[8, true], [9, false]]);
});

test('buildReceipts: a PR owns the turns up to its merge; turns after the merge sit beside it, not inside it', () => {
  const recs = [
    rec({ session_id: 'a', timestamp: '2026-08-20T09:00:00.000Z', estimated_cost: 10 }), // before the PR opened
    rec({ session_id: 'a', timestamp: '2026-08-21T09:00:00.000Z', estimated_cost: 5 }),  // while open
    rec({ session_id: 'b', timestamp: '2026-08-25T09:00:00.000Z', estimated_cost: 100 }), // after merge, stale checkout
    rec({ session_id: 'c', timestamp: '2026-08-26T09:00:00.000Z', estimated_cost: 100 }),
    rec({ git_branch: 'feat/y', session_id: 'd', estimated_cost: 3 }),
  ];
  const prs = [{ number: 478, headRefName: 'feat/x', additions: 101, deletions: 1, createdAt: '2026-08-21T00:00:00Z', mergedAt: '2026-08-21T12:00:00Z' }];
  const res = buildReceipts(recs, { book, prs });
  const R = res.repos[0];
  const x = R.branches.find((b) => b.key === 'feat/x');
  assert.equal(x.pr.number, 478);
  assert.equal(x.cost, 15, 'headline = before-opened + within');
  assert.equal(x.turns, 2);
  assert.equal(x.sessions, 1);
  close(x.costPer100Lines, 15 / 102 * 100);
  assert.equal(x.branch.cost, 215, 'the whole branch is still visible');
  assert.equal(x.prWindow.afterMerge.cost, 200);
  assert.equal(x.prWindow.afterMerge.sessions, 2);
  assert.equal(x.prWindow.beforeOpened.cost, 10);
  assert.equal(x.longLived, false);
  // the repo total and the attributed share still count every turn
  assert.equal(R.cost, 218);
  close(res.totals.attributedShare, 1);
  // the median ranks PR-scoped headlines, so the stale follow-up does not inflate "vs median"
  close(x.vsMedian, 15 / ((15 + 3) / 2));
  const md = renderReceiptMarkdown(x);
  assert.match(md, /After the merge, same branch \| \$200\.00 · 2 session\(s\) · 2 turn\(s\)/);
  assert.match(md, /\*\*not\*\* counted above/);
  assert.match(renderReceiptsTable(res), /spent after a merge on a branch that kept its name/);
});

test('buildReceipts: several merged PRs on one branch each own their slice; long-lived branches are flagged', () => {
  const recs = [
    rec({ git_branch: 'staging', session_id: 'a', timestamp: '2026-08-01T09:00:00.000Z', estimated_cost: 7 }),
    rec({ git_branch: 'staging', session_id: 'b', timestamp: '2026-08-10T09:00:00.000Z', estimated_cost: 20 }),
    rec({ git_branch: 'staging', session_id: 'c', timestamp: '2026-08-20T09:00:00.000Z', estimated_cost: 300 }),
  ];
  const prs = [
    { number: 2, headRefName: 'staging', mergedAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T00:00:00Z' },
    { number: 1, headRefName: 'staging', mergedAt: '2026-08-05T00:00:00Z', createdAt: '2026-08-04T00:00:00Z' },
  ];
  const b = buildReceipts(recs, { book, prs }).repos[0].branches[0];
  assert.equal(b.pr.number, 2, 'the latest merged PR is the receipt');
  assert.equal(b.cost, 20);
  assert.equal(b.prWindow.priorPrs.count, 1);
  assert.equal(b.prWindow.priorPrs.cost, 7);
  assert.equal(b.prWindow.afterMerge.cost, 300);
  assert.equal(b.longLived, true);
  assert.match(renderReceiptMarkdown(b), /long-lived branch/);
  assert.match(renderReceiptMarkdown(b), /1 earlier merged PR\(s\) on this branch hold another \$7\.00/);
});

test('createReceiptBuilder: streaming records one at a time gives the same receipts as the array form', async () => {
  const { createReceiptBuilder } = await import('../src/analytics/receipt.js');
  const recs = corpus();
  const b = createReceiptBuilder({ book });
  for (const r of recs) b.add(r);
  const streamed = b.finish();
  const batch = buildReceipts(recs, { book });
  assert.deepEqual(JSON.parse(JSON.stringify(streamed)), JSON.parse(JSON.stringify(batch)));
  assert.equal(streamed.totals.records, 6, 'the activity record was not counted');
});

test('buildReceipts: a repo resolver merges worktree leaves into one repository', () => {
  const recs = [
    rec({ project: 'main-checkout', repository: 'main-checkout', metadata: { cwd: '/r/main-checkout' } }),
    rec({ project: 'my-feature', repository: 'my-feature', metadata: { cwd: '/r/main-checkout/.worktrees/my-feature' }, git_branch: 'feat/z' }),
  ];
  const split = buildReceipts(recs, { book });
  assert.equal(split.repos.length, 2);
  const joined = buildReceipts(recs, { book, repoOf: (r) => (r.metadata.cwd.startsWith('/r/main-checkout') ? 'main-checkout' : null) });
  assert.equal(joined.repos.length, 1);
  assert.equal(joined.repos[0].branches.length, 2);
});

test('buildReceipts: a branch with only unpriced turns reports null cost, not $0', () => {
  const res = buildReceipts([rec({ git_branch: 'feat/unpriced', model: 'mystery-model', model_family: 'Unknown', estimated_cost: null })], { book });
  const b = res.repos[0].branches[0];
  assert.equal(b.cost, null);
  assert.equal(b.unpricedTurns, 1);
  assert.equal(b.coverage, 0);
  assert.match(renderReceiptMarkdown(b), /no priced turns/);
});

// --------------------------------------------------------- sessionStats ---

test('sessionStats: concentration, cap table, and per-turn stats limited to per-request sources', () => {
  const recs = [];
  // one whale: 60 turns, each $2 → $120, prompt grows past 200K on later turns
  for (let i = 0; i < 60; i++) {
    recs.push(rec({ session_id: 'whale', estimated_cost: 2, cache_read_tokens: i < 30 ? 50_000 : 300_000, timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z` }));
  }
  recs.push(rec({ session_id: 'small-a', estimated_cost: 1 }));
  recs.push(rec({ session_id: 'small-b', estimated_cost: 1 }));
  // a session-level aggregate source: must not enter per-turn stats
  recs.push(rec({ session_id: 'hermes-1', source: 'hermes', estimated_cost: 5, cache_read_tokens: 5_000_000 }));
  const s = sessionStats(recs, { book, caps: [50, 100] });
  assert.equal(s.sessions, 4);
  close(s.totalCost, 127);
  close(s.top1pctShare, 120 / 127); // n=4 → the top session
  assert.equal(s.medianSessionCost, 3); // [120, 5, 1, 1] → (5 + 1) / 2
  const c50 = s.capTable.find((c) => c.cap === 50);
  assert.equal(c50.sessionsOver, 1);
  close(c50.costAbove, 70);
  const first = s.marginalByTurnIndex.find((m) => m.turns === '1–50');
  assert.equal(first.samples, 52); // 50 whale turns + 2 small sessions' first turns
  assert.equal(first.medianCostPerTurn, 2);
  assert.equal(s.largePromptTurns.turns, 30);
  close(s.largePromptTurns.turnShare, 30 / 62);
  assert.deepEqual(s.largePromptTurns.sources, ['anthropic']);
  assert.match(renderSessionStats(s), /upper bound/);
});

// -------------------------------------------------------- evaluateGuard ---

const session = (n, cost = 0.5, ctxTokens = 150_000) => Array.from({ length: n }, (_, i) => rec({
  session_id: 'live', estimated_cost: cost, cache_read_tokens: ctxTokens, input_tokens: 0, cache_write_tokens: 0,
  timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z`,
}));

test('evaluateGuard: with nothing declared it informs and never blocks', () => {
  const v = evaluateGuard(session(20), {}, book);
  assert.equal(v.level, 'ok');
  assert.equal(v.declared, false);
  assert.equal(v.turns, 20);
  close(v.cost, 10);
  assert.equal(v.contextTokens, 150_000);
  assert.equal(v.marginalCostPerTurn, 0.5);
  assert.equal(v.recentTurns, 10);
  assert.match(renderGuard(v), /informational only/);
});

test('evaluateGuard: warns past a declared warning level, blocks at a declared cap', () => {
  const warn = evaluateGuard(session(20), { warnCostUsd: 5 }, book);
  assert.equal(warn.level, 'warn');
  assert.match(warn.reasons[0], /passed the warning level/);
  const block = evaluateGuard(session(20), { warnCostUsd: 5, maxCostUsd: 10 }, book);
  assert.equal(block.level, 'block');
  assert.match(block.reasons[0], /reached the declared cap/);
  const ctx = evaluateGuard(session(3), { maxContextTokens: 100_000 }, book);
  assert.equal(ctx.level, 'block');
  assert.match(ctx.reasons[0], /150(\.0)?K tokens/);
  assert.match(ctx.suggestion, /re-send earlier context/);
  const marginal = evaluateGuard(session(12, 0.9), { warnMarginalUsd: 0.5 }, book);
  assert.equal(marginal.level, 'warn');
  assert.match(marginal.reasons[0], /last 10 turns/);
});

test('evaluateGuard: non-positive or malformed thresholds are treated as undeclared', () => {
  const v = evaluateGuard(session(5), /** @type {any} */ ({ warnCostUsd: 0, maxCostUsd: 'lots', warnContextTokens: -1 }), book);
  assert.equal(v.level, 'ok');
  assert.equal(v.declared, false);
});

// ----------------------------------------------------------- rendering ---

test('renderReceiptMarkdown: a PR comment carries spend, split, lines and provenance', () => {
  const prs = [{ number: 42, headRefName: 'feat/x', additions: 300, deletions: 100 }];
  const b = buildReceipts(corpus(), { book, prs }).repos[0].branches[0];
  const md = renderReceiptMarkdown(b, { repo: 'repo', pricingVersion: '2026-08-20' });
  assert.match(md, /AI cost receipt/);
  assert.match(md, /PR #42/);
  assert.match(md, /re-sent context/);
  assert.match(md, /\+300 \/ −100 → \$[\d.]+ per 100 lines/);
  assert.match(md, /price table 2026-08-20/);
  assert.match(md, /No prompt or code content was read/);
  const table = renderReceiptsTable(buildReceipts(corpus(), { book }));
  assert.match(table, /feat\/x/);
  assert.match(table, /unattributed/);
});

// ------------------------------------------------- receipt command bits ---

test('repoRootOf: a worktree resolves to its main checkout; a plain dir to itself', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-receipt-'));
  const main = path.join(tmp, 'main');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  const wt = path.join(main, '.worktrees', 'wt', 'deep', 'er');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(main, '.worktrees', 'wt', '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(repoRootOf(wt), main);
  assert.equal(repoRootOf(path.join(main, 'src')), main);
  // A sibling outside the checkout must not resolve to it (the temp root itself
  // may sit under some repository on the host, so only the negative is asserted).
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.notEqual(repoRootOf(plain), main);
  const resolve = makeRepoResolver();
  assert.equal(resolve({ metadata: { cwd: wt }, repository: 'er', project: 'er' }), 'main');
  assert.equal(resolve({ metadata: {}, repository: 'fallback', project: 'p' }), 'fallback');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------- receipt command: portable JSON ---

test('receipt --branch --json: the portable receipt.v1 document, with the ticket the branch names', () => {
  const prev = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-receipt-home-'));
  process.env.TOKENFLOW_HOME = home;
  try {
    const store = new Store();
    store.writer('2026-08-01').write(encodeRecord(rec({
      date: '2026-08-01', hour: 10, dow: 6, client: 'claude-code', interface: 'CLI',
      git_branch: 'feat/ENG-42-widget', request_id: 'req1', id: 'r1',
    })));
    store.closeWriters();

    const out = runReceiptCommand({ branch: 'feat/ENG-42-widget', json: true });
    const r = out.json.receipt;
    assert.equal(r.schemaVersion, 1, 'a single receipt is emitted as v1, not as the raw builder entry');
    assert.equal(r.branch, 'feat/ENG-42-widget');
    assert.ok(r.costUsd > 0);

    // Proves run() threads config.tickets into the builder: without it b.ticket is null.
    assert.deepEqual(r.ticket, { system: 'other', key: 'ENG-42', url: null });
    assert.equal(r.verdict, null, 'no --repo means no repository policy to judge against');

    // Honest null rather than an invented sha: naming a commit needs a checkout.
    assert.equal(r.headSha, null);
    assert.equal(validateReceipt(r).ok, false, 'and that null is exactly why this one is not schema-valid');
    assert.match(validateReceipt(r).errors.join('; '), /headSha/);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- guard ---

function withHome(fn) {
  const prev = process.env.TOKENFLOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-guard-home-'));
  process.env.TOKENFLOW_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('readTranscript: prices a Claude Code transcript with the adapter — streaming snapshots collapse to one turn', async () => {
  await loadProviders();
  const { records } = readTranscript(path.join(FIXTURES, 'anthropic-session.jsonl'), { config: loadConfig(), book });
  assert.equal(records.length, 2); // req_1 (three snapshots) + req_2 (sidechain)
  assert.equal(records[0].output_tokens, 250);
  assert.ok(records[0].estimated_cost > 0);
  assert.equal(records[1].category, 'subagent');
  const v = evaluateGuard(records, { warnCostUsd: 0.0001 }, book);
  assert.equal(v.level, 'warn');
  assert.equal(v.turns, 2);
});

test('evaluateSession: resumes from the cached offset and folds a continued stream as a delta, not a new turn', async () => {
  await loadProviders();
  await withHome(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-guard-'));
    const file = path.join(tmp, 'live.jsonl');
    const lines = fs.readFileSync(path.join(FIXTURES, 'anthropic-session.jsonl'), 'utf8').trim().split('\n');
    fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n'); // req_1 mid-stream (output 80)
    const cfg = loadConfig();
    const a = evaluateSession({ transcript_path: file, session_id: 'live' }, { config: cfg, book });
    assert.equal(a.verdict.turns, 1);
    assert.equal(a.records[0].output_tokens, 80);

    fs.appendFileSync(file, lines.slice(2).join('\n') + '\n'); // req_1 final (250) + synthetic + req_2
    const b = evaluateSession({ transcript_path: file, session_id: 'live' }, { config: cfg, book });
    assert.equal(b.verdict.turns, 2, 'continued stream merged into the same turn');
    assert.equal(b.records.find((r) => r.request_id === 'req_1').output_tokens, 250, 'delta folded to the final snapshot');
    assert.ok(b.offset > a.offset);

    const c = evaluateSession({ transcript_path: file, session_id: 'live' }, { config: cfg, book });
    assert.equal(c.verdict.turns, 2);
    close(c.verdict.cost, b.verdict.cost);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('hookOutput: ok is silent, warn injects context, block exits 2 only on blockable events', () => {
  const ok = evaluateGuard(session(2), {}, book);
  assert.deepEqual(hookOutput(ok, 'PreToolUse'), { exitCode: 0, stdout: null, stderr: null });

  const warn = evaluateGuard(session(20), { warnCostUsd: 1 }, book);
  const w = hookOutput(warn, 'UserPromptSubmit');
  assert.equal(w.exitCode, 0);
  const parsed = JSON.parse(w.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /TokenFlow guard/);
  assert.match(parsed.hookSpecificOutput.systemMessage, /passed the warning level/);

  const block = evaluateGuard(session(20), { maxCostUsd: 1 }, book);
  const pre = hookOutput(block, 'PreToolUse');
  assert.equal(pre.exitCode, 2);
  assert.match(pre.stderr, /reached the declared cap/);
  assert.equal(pre.stdout, null);
  const stop = hookOutput(block, 'Stop');
  assert.equal(stop.exitCode, 0, 'a Stop hook is never blocked');
  assert.match(stop.stdout, /systemMessage/);
});

test('guard --set: writes declared thresholds, clears with an empty value, rejects unknown keys', () => {
  withHome(() => {
    const g = applySet('warnCostUsd=25,maxCostUsd=200');
    assert.equal(g.warnCostUsd, 25);
    assert.equal(g.maxCostUsd, 200);
    assert.equal(loadConfig().guard.maxCostUsd, 200);
    const g2 = applySet('maxCostUsd=');
    assert.equal(g2.maxCostUsd, null);
    assert.equal(g2.warnCostUsd, 25);
    assert.throws(() => applySet('bogus=1'), /unknown guard key/);
    assert.throws(() => applySet('warnCostUsd=-3'), /positive number/);
  });
});

test('guard --install: prints a hooks block and never claims to have written it', () => {
  const s = installSnippet('/usr/bin/node /x/tokenflow.js');
  assert.match(s, /"UserPromptSubmit"/);
  assert.match(s, /"matcher": "Agent\|Task"/);
  assert.match(s, /\/usr\/bin\/node \/x\/tokenflow\.js guard/);
  assert.match(s, /Add this to ~\/.claude\/settings.json/);
  assert.ok(GUARD_KEYS.every((k) => /Usd|Tokens/.test(k)));
});

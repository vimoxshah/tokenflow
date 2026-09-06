/**
 * Receipt schema v0: the mapping from a buildReceipts() branch entry, the
 * hand-written validator, and the markdown render — kept in lockstep with
 * schemas/receipt.v0.json (see the "required fields drift" test below).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  toReceiptV0, validateReceiptV0, renderReceiptV0Markdown, RECEIPT_SCHEMA_VERSION,
} from '../src/analytics/receipt-schema.js';
import { buildReceipts } from '../src/analytics/receipt.js';
import { buildPriceBook, estimateCost } from '../src/core/pricing.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
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

const corpus = () => [
  rec({ session_id: 's1' }),
  rec({ session_id: 's1', category: 'subagent', timestamp: '2026-08-01T11:00:00.000Z' }),
  rec({ session_id: 's2', timestamp: '2026-08-02T09:00:00.000Z' }),
];

/** A branch entry straight out of buildReceipts(), for mapping tests. */
function branchReceipt(opt = {}) {
  const prs = opt.prs;
  const res = buildReceipts(corpus(), { book, prs });
  return res.repos[0].branches[0];
}

// ------------------------------------------------------------- toReceiptV0 ---

test('toReceiptV0: maps a plain branch (no PR) into the receipt.v0 shape', () => {
  const b = branchReceipt();
  const r = toReceiptV0(b, { repo: 'my-repo', headSha: 'abc1234', toolVersion: '1.2.3', generatedAt: '2026-08-05T00:00:00.000Z' });

  assert.equal(r.schemaVersion, RECEIPT_SCHEMA_VERSION);
  assert.equal(r.schemaVersion, 0);
  assert.equal(r.generatedAt, '2026-08-05T00:00:00.000Z');
  assert.equal(r.toolVersion, '1.2.3');
  assert.equal(r.repo, 'my-repo');
  assert.equal(r.branch, 'feat/x');
  assert.equal(r.headSha, 'abc1234');
  assert.deepEqual(r.window, { first: b.first, last: b.last });
  assert.equal(r.costUsd, b.cost);
  assert.equal(r.contextShare, b.contextShare);
  assert.equal(r.turns, 3);
  assert.equal(r.sessions, 2);
  assert.equal(r.subagentTurns, 1);
  assert.equal(r.models.length, b.models.length);
  assert.deepEqual(r.models[0], { model: b.models[0].model, costUsd: b.models[0].cost, share: b.models[0].share });
  assert.equal(r.coverage, b.coverage);
  assert.equal(r.largestPromptTokens, b.maxPrompt);
  assert.equal(r.changedLines, null, 'no PR supplied');
  assert.equal(r.pr, null);
  assert.equal(r.longLived, false);
  assert.equal(r.costPer100Lines, null);
  assert.ok(Array.isArray(r.notes) && r.notes.length > 0);
  assert.match(r.notes[r.notes.length - 1], /Estimated locally by TokenFlow/);
  assert.match(r.notes[r.notes.length - 1], /no prompt or code content was read/);
});

test('toReceiptV0: a matched PR carries number/mergedAt, changed lines, and cost per 100 lines', () => {
  const prs = [{ number: 42, headRefName: 'feat/x', additions: 300, deletions: 100, mergedAt: '2026-08-03T00:00:00Z' }];
  const b = branchReceipt({ prs });
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'deadbeef', toolVersion: '9.9.9' });
  assert.deepEqual(r.pr, { number: 42, mergedAt: '2026-08-03T00:00:00Z' });
  assert.equal(r.changedLines, 400);
  assert.equal(r.costPer100Lines, b.costPer100Lines);
});

test('toReceiptV0: a long-lived branch is flagged and notes say so', () => {
  const recs = [
    rec({ git_branch: 'staging', session_id: 'a', timestamp: '2026-08-01T09:00:00.000Z', estimated_cost: 7 }),
  ];
  const b = buildReceipts(recs, { book }).repos[0].branches[0];
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'cafe123', toolVersion: '1.0.0' });
  assert.equal(r.longLived, true);
  assert.ok(r.notes.some((n) => /long-lived branch/.test(n)));
});

test('toReceiptV0: a branch with only unpriced turns reports costUsd null, never 0, with a note', () => {
  const res = buildReceipts([rec({ git_branch: 'feat/unpriced', model: 'mystery-model', model_family: 'Unknown', estimated_cost: null })], { book });
  const b = res.repos[0].branches[0];
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'f00d', toolVersion: '1.0.0' });
  assert.equal(r.costUsd, null);
  assert.equal(r.coverage, 0);
  assert.ok(r.notes.some((n) => /no configured price/.test(n)));
});

test('toReceiptV0: no priced turn at all leaves window null', () => {
  const recs = [rec({ git_branch: 'feat/empty', timestamp: null, model: 'mystery', estimated_cost: null })];
  const b = buildReceipts(recs, { book }).repos[0].branches[0];
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'f00d', toolVersion: '1.0.0' });
  assert.equal(r.window, null);
});

// --------------------------------------------------------- validateReceiptV0 ---

/** A receipt that should pass validation as-is. */
function validReceipt() {
  return toReceiptV0(branchReceipt(), { repo: 'repo', headSha: 'abc1234', toolVersion: '1.0.0' });
}

test('validateReceiptV0: accepts a receipt produced by toReceiptV0', () => {
  const { ok, errors } = validateReceiptV0(validReceipt());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('validateReceiptV0: rejects non-objects', () => {
  assert.equal(validateReceiptV0(null).ok, false);
  assert.equal(validateReceiptV0('a string').ok, false);
  assert.equal(validateReceiptV0([1, 2]).ok, false);
  assert.equal(validateReceiptV0(42).ok, false);
});

test('validateReceiptV0: rejects a wrong schemaVersion, and bad field types', () => {
  const bad1 = { ...validReceipt(), schemaVersion: 1 };
  const r1 = validateReceiptV0(bad1);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /schemaVersion/.test(e)));

  const bad2 = { ...validReceipt(), costUsd: '5.00' };
  assert.equal(validateReceiptV0(bad2).ok, false);

  const bad3 = { ...validReceipt(), contextShare: 1.5 };
  assert.equal(validateReceiptV0(bad3).ok, false);

  const bad4 = { ...validReceipt(), turns: 1.5 };
  assert.equal(validateReceiptV0(bad4).ok, false);

  const bad5 = { ...validReceipt(), longLived: 'yes' };
  assert.equal(validateReceiptV0(bad5).ok, false);

  const bad6 = { ...validReceipt(), models: [{ model: 'x', costUsd: 1, share: 2 }] };
  assert.equal(validateReceiptV0(bad6).ok, false);

  const bad7 = { ...validReceipt(), notes: ['fine', 5] };
  assert.equal(validateReceiptV0(bad7).ok, false);

  const bad8 = { ...validReceipt(), pr: { number: 'x', mergedAt: null } };
  assert.equal(validateReceiptV0(bad8).ok, false);

  const bad9 = { ...validReceipt(), headSha: 'not-hex!!' };
  assert.equal(validateReceiptV0(bad9).ok, false);
});

test('validateReceiptV0: accepts null for every nullable field', () => {
  const r = {
    ...validReceipt(),
    window: null,
    costUsd: null,
    contextShare: null,
    coverage: null,
    largestPromptTokens: null,
    changedLines: null,
    pr: null,
    costPer100Lines: null,
  };
  const { ok, errors } = validateReceiptV0(r);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('required fields do not drift from schemas/receipt.v0.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'receipt.v0.json'), 'utf8'));
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
  const good = validReceipt();
  assert.equal(validateReceiptV0(good).ok, true, 'sanity: a full receipt validates first');
  for (const key of schema.required) {
    const bad = { ...good };
    delete bad[key];
    const { ok, errors } = validateReceiptV0(bad);
    assert.equal(ok, false, `removing required field "${key}" should fail validation`);
    assert.ok(errors.some((e) => e.includes(key)), `error should mention "${key}": ${errors.join('; ')}`);
  }
});

// --------------------------------------------------------- markdown render ---

test('renderReceiptV0Markdown: marker is the first line, table carries spend/turns/models', () => {
  const prs = [{ number: 42, headRefName: 'feat/x', additions: 300, deletions: 100, mergedAt: '2026-08-03T00:00:00Z' }];
  const b = branchReceipt({ prs });
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'abc1234', toolVersion: '1.0.0' });
  const md = renderReceiptV0Markdown(r);
  const lines = md.split('\n');
  assert.equal(lines[0], '<!-- tokenflow-receipt -->');
  assert.match(md, /AI cost receipt/);
  assert.match(md, /PR #42/);
  assert.match(md, /re-sent context/);
  assert.match(md, /Changed lines \| 400/);
  assert.match(md, /Sessions · turns \| 2 · 3/);
  assert.match(md, /Claude Opus 5/);
  assert.match(md, /no prompt or code content was read/);
});

test('renderReceiptV0Markdown: no priced turns renders the explicit "no priced turns" line', () => {
  const res = buildReceipts([rec({ git_branch: 'feat/unpriced', model: 'mystery-model', model_family: 'Unknown', estimated_cost: null })], { book });
  const b = res.repos[0].branches[0];
  const r = toReceiptV0(b, { repo: 'repo', headSha: 'f00dcafe', toolVersion: '1.0.0' });
  const md = renderReceiptV0Markdown(r);
  assert.match(md, /no priced turns/);
  assert.equal(md.split('\n')[0], '<!-- tokenflow-receipt -->');
});

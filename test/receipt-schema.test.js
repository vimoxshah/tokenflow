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
  validateReceiptV1, validateReceipt, RECEIPT_SCHEMA_VERSION_V1,
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

// ============================================================== v1 schema ===

/** A v1 receipt: a valid v0 receipt with schemaVersion bumped and optional ticket/verdict merged in. */
function v1Receipt(extra = {}) {
  return { ...validReceipt(), schemaVersion: RECEIPT_SCHEMA_VERSION_V1, ticket: null, verdict: null, ...extra };
}

test('RECEIPT_SCHEMA_VERSION_V1 is 1', () => {
  assert.equal(RECEIPT_SCHEMA_VERSION_V1, 1);
});

test('required fields do not drift from schemas/receipt.v1.json, and v1 requires everything v0 requires', () => {
  const v0Schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'receipt.v0.json'), 'utf8'));
  const v1Schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'receipt.v1.json'), 'utf8'));
  assert.deepEqual(v1Schema.required, v0Schema.required, 'v1 must require everything v0 required — nothing dropped');

  const good = v1Receipt();
  assert.equal(validateReceiptV1(good).ok, true, 'sanity: a full v1 receipt validates first');
  for (const key of v1Schema.required) {
    const bad = { ...good };
    delete bad[key];
    const { ok, errors } = validateReceiptV1(bad);
    assert.equal(ok, false, `removing required field "${key}" should fail v1 validation`);
    assert.ok(errors.some((e) => e.includes(key)), `error should mention "${key}": ${errors.join('; ')}`);
  }
});

test('validateReceiptV1: accepts a v0-shaped receipt with schemaVersion bumped to 1 (ticket/verdict absent)', () => {
  const r = { ...validReceipt(), schemaVersion: RECEIPT_SCHEMA_VERSION_V1 };
  const { ok, errors } = validateReceiptV1(r);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('validateReceiptV1: accepts null ticket and null verdict', () => {
  const { ok, errors } = validateReceiptV1(v1Receipt({ ticket: null, verdict: null }));
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('validateReceiptV1: accepts a populated ticket (with and without a url) and a populated verdict', () => {
  const withUrl = v1Receipt({ ticket: { system: 'jira', key: 'ENG-123', url: 'https://example.atlassian.net/browse/ENG-123' } });
  assert.equal(validateReceiptV1(withUrl).ok, true);

  const noUrl = v1Receipt({ ticket: { system: 'github', key: '#42', url: null } });
  assert.equal(validateReceiptV1(noUrl).ok, true);

  const verdict = v1Receipt({ verdict: { maxCostUsd: 25, maxCostPer100Lines: null, overBudget: true } });
  assert.equal(validateReceiptV1(verdict).ok, true);
});

test('validateReceiptV1: rejects a bad ticket.system, a missing/empty key, and a bad url type', () => {
  const bad1 = v1Receipt({ ticket: { system: 'trello', key: 'X-1', url: null } });
  const r1 = validateReceiptV1(bad1);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /ticket\.system/.test(e)));

  const bad2 = v1Receipt({ ticket: { system: 'jira', key: '', url: null } });
  assert.equal(validateReceiptV1(bad2).ok, false);

  const bad3 = v1Receipt({ ticket: { system: 'jira', key: 'X-1', url: 42 } });
  assert.equal(validateReceiptV1(bad3).ok, false);

  const bad4 = v1Receipt({ ticket: 'not-an-object' });
  assert.equal(validateReceiptV1(bad4).ok, false);
});

test('validateReceiptV1: rejects a bad verdict shape', () => {
  const bad1 = v1Receipt({ verdict: { maxCostUsd: '25', maxCostPer100Lines: null, overBudget: true } });
  assert.equal(validateReceiptV1(bad1).ok, false);

  const bad2 = v1Receipt({ verdict: { maxCostUsd: null, maxCostPer100Lines: null, overBudget: 'yes' } });
  assert.equal(validateReceiptV1(bad2).ok, false);

  const bad3 = v1Receipt({ verdict: [1, 2, 3] });
  assert.equal(validateReceiptV1(bad3).ok, false);
});

test('validateReceiptV1: rejects a v0-versioned receipt (schemaVersion must be 1)', () => {
  const r = validateReceiptV1(validReceipt());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /schemaVersion must be 1/.test(e)));
});

test('validateReceiptV0: unchanged — still rejects a v1-versioned receipt, ticket/verdict never checked', () => {
  const r = validateReceiptV0(v1Receipt());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /schemaVersion must be 0/.test(e)));
});

test('validateReceipt: dispatches on schemaVersion — 0 to the v0 validator, 1 to the v1 validator', () => {
  const v0 = validateReceipt(validReceipt());
  assert.equal(v0.ok, true);

  const v1 = validateReceipt(v1Receipt({ ticket: { system: 'linear', key: 'ENG-9', url: null } }));
  assert.equal(v1.ok, true);

  const brokenV0 = validateReceipt({ ...validReceipt(), turns: 1.5 });
  assert.equal(brokenV0.ok, false);

  const brokenV1 = validateReceipt(v1Receipt({ verdict: { maxCostUsd: null, maxCostPer100Lines: null, overBudget: 'nope' } }));
  assert.equal(brokenV1.ok, false);
});

test('validateReceipt: an unsupported schemaVersion fails clearly, and non-objects are rejected', () => {
  const r = validateReceipt({ ...validReceipt(), schemaVersion: 7 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unsupported schemaVersion/.test(e)));

  assert.equal(validateReceipt(null).ok, false);
  assert.equal(validateReceipt('nope').ok, false);
  assert.equal(validateReceipt([1, 2]).ok, false);
});

test('renderReceiptV0Markdown: renders a ticket line, linked when a url is set and plain when it is not', () => {
  const withUrl = v1Receipt({ ticket: { system: 'jira', key: 'ENG-123', url: 'https://example.atlassian.net/browse/ENG-123' } });
  const mdLinked = renderReceiptV0Markdown(withUrl);
  assert.match(mdLinked, /\| Ticket \| \[ENG-123\]\(https:\/\/example\.atlassian\.net\/browse\/ENG-123\) \|/);

  const noUrl = v1Receipt({ ticket: { system: 'github', key: '#42', url: null } });
  const mdPlain = renderReceiptV0Markdown(noUrl);
  assert.match(mdPlain, /\| Ticket \| #42 \|/);
});

test('renderReceiptV0Markdown: renders a verdict line for both over-budget and within-budget, and neither line for a plain v0 receipt', () => {
  const over = v1Receipt({ verdict: { maxCostUsd: 10, maxCostPer100Lines: null, overBudget: true } });
  assert.match(renderReceiptV0Markdown(over), /\| Budget \| over budget \(cap \$10\.00\) \|/);

  const under = v1Receipt({ verdict: { maxCostUsd: null, maxCostPer100Lines: 5, overBudget: false } });
  assert.match(renderReceiptV0Markdown(under), /\| Budget \| within budget \(cap \$5\.00 per 100 lines\) \|/);

  const v0Only = validReceipt();
  const mdV0 = renderReceiptV0Markdown(v0Only);
  assert.doesNotMatch(mdV0, /\| Ticket \|/);
  assert.doesNotMatch(mdV0, /\| Budget \|/);
});

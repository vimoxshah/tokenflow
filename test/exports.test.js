/**
 * Exports that travel (SVG / PNG receipt and week cards, CSV of receipts) and
 * budgets scoped to a repo or a team.
 *
 * SVG cards are checked three ways: they carry the numbers they claim to
 * (cost, branch), every colour traces back to design/tokens.yaml (no
 * hardcoded hex), and the markup is well-formed (a simple balanced-tag walk,
 * not a full XML parser — good enough to catch an unclosed tag).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

// Full isolation from any real ~/.tokenflow on this machine — none of these
// tests should read or write outside a fresh temp dir.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-exports-'));
process.env.TOKENFLOW_HOME = TMP_HOME;
after(() => { fs.rmSync(TMP_HOME, { recursive: true, force: true }); });

import { buildReceipts } from '../src/analytics/receipt.js';
import { buildPriceBook, estimateCost } from '../src/core/pricing.js';
import { usd } from '../src/core/units.js';
import {
  loadDesignTokens, resolveTheme, renderReceiptCardSvg, findChromiumBinary, renderSvgToPng,
} from '../src/export/receipt-card.js';
import { computeWeek, renderWeekCardSvg } from '../src/export/week-card.js';
import { renderReceiptsCsv } from '../src/commands/receipt.js';
import { evaluateScopedBudgets, renderScopedBudgets } from '../src/commands/budget-scopes.js';
import { weekStart, addDays } from '../src/analytics/aggregate.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKENS_TEXT = fs.readFileSync(path.join(ROOT, 'design', 'tokens.yaml'), 'utf8');
const TOKEN_HEXES = new Set((TOKENS_TEXT.match(/#[0-9a-fA-F]{6}/g) || []).map((h) => h.toLowerCase()));

const book = buildPriceBook({});

/** A priced decoded record; override anything. Same shape `buildReceipts` and `computeWeek` read. */
function decRec(o = {}) {
  const base = /** @type {any} */ ({
    measurement: 'primary', provider: 'anthropic', model: 'claude-opus-5', model_family: 'Claude Opus 5',
    source: 'anthropic', category: 'main', session_id: 's1', git_branch: 'feat/receipts',
    timestamp: '2026-08-01T10:00:00.000Z', service_tier: null, cost_basis: 'estimated',
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 10_000, cache_write_tokens: 500, cache_refresh_tokens: null,
    metadata: {}, repository: 'demo-repo', project: 'demo-repo',
    ...o,
  });
  if (base.estimated_cost === undefined) base.estimated_cost = estimateCost(base, base.model, base.provider, book).cost;
  return base;
}

/** An encoded record (store shard shape, short REC_KEYS); override anything. */
function encRec(o = {}) {
  return {
    ms: 'primary', d: '2026-08-10', ts: '2026-08-10T09:00:00.000Z',
    p: 'anthropic', m: 'claude-opus-5', s: 's1',
    rp: 'demo-repo', pj: 'demo-repo', br: 'feat/a',
    co: 1, cb: 'estimated',
    ...o,
  };
}

function fakeStore(records, key) {
  return {
    state: { lastRefresh: key, records: records.length },
    scanRecords(onRec) { for (const o of records) onRec(o); },
  };
}

// ---------------------------------------------------------- XML helpers ---

/** A simple balanced-tag walk: every opening tag has a matching close, in order. */
function assertBalancedXml(svg) {
  assert.ok(svg.startsWith('<svg'), 'starts with <svg');
  assert.ok(svg.trim().endsWith('</svg>'), 'ends with </svg>');
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const [, closing, name, selfClose] = m;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `mismatched closing tag </${name}>, expected </${top}>`);
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, `unclosed tag(s): ${stack.join(', ')}`);
}

/** Every #hex colour in the SVG must be a literal value from design/tokens.yaml. */
function assertHexFromTokens(svg) {
  const hexes = svg.match(/#[0-9a-fA-F]{6}/g) || [];
  assert.ok(hexes.length > 0, 'card should draw at least one token colour');
  for (const h of hexes) assert.ok(TOKEN_HEXES.has(h.toLowerCase()), `${h} does not appear in design/tokens.yaml`);
}

// ----------------------------------------------------------- receipt card ---

test('renderReceiptCardSvg: carries the cost and the branch, is well-formed, colours trace to tokens.yaml', () => {
  const records = [
    decRec({ session_id: 's1', estimated_cost: 42.5 }),
    decRec({ session_id: 's2', estimated_cost: 10 }),
  ];
  const result = buildReceipts(records, { book });
  const b = result.repos[0].branches[0];
  assert.equal(b.key, 'feat/receipts');

  const svg = renderReceiptCardSvg(b, { repo: 'demo-repo', skin: 'aurora', mode: 'dark' });
  assert.ok(svg.includes('feat/receipts'), 'branch name present');
  assert.ok(svg.includes(usd(b.cost)), 'cost figure present');
  assert.ok(svg.includes('demo-repo'), 'repo name present');
  assert.ok(svg.includes('text-anchor="end"'), 'fact values are right-aligned, like the landing page card');
  assertBalancedXml(svg);
  assertHexFromTokens(svg);
});

test('renderReceiptCardSvg: every skin x mode combination stays inside the token palette', () => {
  const records = [decRec({ estimated_cost: 7 })];
  const result = buildReceipts(records, { book });
  const b = result.repos[0].branches[0];
  const tokens = loadDesignTokens();
  for (const skin of Object.keys(tokens.skins)) {
    for (const mode of ['dark', 'light']) {
      const theme = resolveTheme(tokens, skin, mode);
      assert.ok(theme.surface1, `${skin}/${mode} resolves a surface`);
      const svg = renderReceiptCardSvg(b, { repo: 'demo-repo', skin, mode });
      assertBalancedXml(svg);
      assertHexFromTokens(svg);
    }
  }
});

test('renderReceiptCardSvg: no priced turns and no PR renders "n/a" and the "estimated spend" caption, never a dash or a lie', () => {
  const records = [decRec({ estimated_cost: null })];
  const result = buildReceipts(records, { book });
  const b = result.repos[0].branches[0];
  assert.equal(b.cost, null);
  assert.equal(b.pr, null);
  const svg = renderReceiptCardSvg(b, { repo: 'demo-repo' });
  assert.ok(svg.includes('n/a'));
  assert.ok(svg.includes('estimated spend'));
  assert.ok(!svg.includes('estimated spend, up to the merge'));
  assert.ok(!svg.includes('—') && !svg.includes('–'), 'no em or en dash in card copy');
  assertBalancedXml(svg);
});

test('renderReceiptCardSvg: caption reads "estimated spend, up to the merge" only once the PR is merged', () => {
  const records = [decRec({ git_branch: 'feat/receipts', estimated_cost: 12, timestamp: '2026-07-31T09:00:00.000Z' })];

  const merged = buildReceipts(records, {
    book,
    prs: [{ number: 1, headRefName: 'feat/receipts', createdAt: '2026-07-30T00:00:00.000Z', mergedAt: '2026-08-02T00:00:00.000Z', additions: 10, deletions: 2 }],
  });
  const mergedBranch = merged.repos[0].branches[0];
  assert.ok(mergedBranch.pr && mergedBranch.pr.mergedAt);
  const mergedSvg = renderReceiptCardSvg(mergedBranch, { repo: 'demo-repo' });
  assert.ok(mergedSvg.includes('estimated spend, up to the merge'));

  const open = buildReceipts(records, {
    book,
    prs: [{ number: 1, headRefName: 'feat/receipts', createdAt: '2026-07-30T00:00:00.000Z', mergedAt: null, additions: 10, deletions: 2 }],
  });
  const openBranch = open.repos[0].branches[0];
  assert.ok(openBranch.pr && !openBranch.pr.mergedAt);
  const openSvg = renderReceiptCardSvg(openBranch, { repo: 'demo-repo' });
  assert.ok(openSvg.includes('estimated spend'));
  assert.ok(!openSvg.includes('estimated spend, up to the merge'));
});

// ------------------------------------------------------------------ PNG ---

test('renderSvgToPng: no local Chromium found reports the fallback and still leaves the SVG named', () => {
  const svgPath = path.join(TMP_HOME, 'card.svg');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const pngPath = path.join(TMP_HOME, 'card.png');
  const res = renderSvgToPng(svgPath, pngPath, { candidates: ['/definitely/not/a/real/binary-xyz'] });
  assert.equal(res.ok, false);
  assert.ok(res.message.includes(svgPath));
  assert.ok(!fs.existsSync(pngPath));
  assert.equal(findChromiumBinary({ candidates: ['/definitely/not/a/real/binary-xyz'] }), null);
});

// --------------------------------------------------------------------- CSV ---

test('renderReceiptsCsv: header row and one row per branch, quoting a repo name with a comma', () => {
  const records = [decRec({ repository: 'repo, inc', project: 'repo, inc', git_branch: 'feat/a', estimated_cost: 5 })];
  const result = buildReceipts(records, { book });
  const csv = renderReceiptsCsv(result);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'repo,branch,costUsd,contextShare,sessions,turns,subagentTurns,first,last,longLived,prNumber,mergedAt,changedLines,costPer100Lines');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith('"repo, inc",feat/a,5,'), lines[1]);
});

test('renderReceiptsCsv: missing values (no PR) are empty cells, never 0', () => {
  const records = [decRec({ estimated_cost: 3 })];
  const result = buildReceipts(records, { book });
  const csv = renderReceiptsCsv(result);
  const cells = csv.trim().split('\n')[1].split(',');
  // prNumber, mergedAt, changedLines, costPer100Lines are the last four columns.
  assert.deepEqual(cells.slice(-4), ['', '', '', '']);
});

// ------------------------------------------------------------------- week ---

test('computeWeek: spend this week vs last week, top branches, the most expensive session, an insight with a number', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');
  const today = now.toISOString().slice(0, 10);
  const thisFrom = weekStart(today);
  const lastFrom = addDays(thisFrom, -7);
  const lastTo = addDays(thisFrom, -1);

  const records = [
    decRec({ timestamp: `${thisFrom}T09:00:00.000Z`, session_id: 's1', git_branch: 'feat/a', estimated_cost: 5 }),
    decRec({ timestamp: `${thisFrom}T10:00:00.000Z`, session_id: 's1', git_branch: 'feat/a', estimated_cost: 2 }),
    decRec({ timestamp: `${today}T09:00:00.000Z`, session_id: 's2', git_branch: 'feat/b', estimated_cost: 3 }),
    decRec({ timestamp: `${lastFrom}T09:00:00.000Z`, session_id: 's3', git_branch: 'feat/a', estimated_cost: 4 }),
    decRec({ timestamp: `${lastTo}T09:00:00.000Z`, session_id: 's4', git_branch: 'feat/c', estimated_cost: 1 }),
  ];

  const week = computeWeek({ records, now, book, repoOf: (r) => r.repository });

  assert.equal(week.thisWeek.from, thisFrom);
  assert.equal(week.thisWeek.to, today);
  assert.equal(week.thisWeek.cost, 10);
  assert.equal(week.thisWeek.turns, 3);
  assert.equal(week.thisWeek.sessions, 2);
  assert.equal(week.lastWeek.cost, 5);
  assert.ok(Math.abs(week.deltaPct - 1) < 1e-9);

  assert.equal(week.topBranches[0].branch, 'feat/a');
  assert.equal(week.topBranches[0].cost, 7);
  assert.equal(week.topBranches[1].branch, 'feat/b');

  assert.ok(week.maxSession);
  assert.equal(week.maxSession.cost, 7);

  // "no adjectives without a number": the insight names the percentage and both dollar figures.
  assert.ok(week.insight.includes('100%'), week.insight);
  assert.ok(week.insight.includes(usd(10)), week.insight);
  assert.ok(week.insight.includes(usd(5)), week.insight);
  assert.ok(!week.insight.includes('—') && !week.insight.includes('–'));
});

test('computeWeek: no records at all stays honest ("no priced turns"), never $0', () => {
  const week = computeWeek({ records: [], now: new Date('2026-08-19T00:00:00.000Z'), book });
  assert.equal(week.thisWeek.cost, null);
  assert.equal(week.lastWeek.cost, null);
  assert.equal(week.deltaPct, null);
  assert.deepEqual(week.topBranches, []);
  assert.equal(week.maxSession, null);
  assert.match(week.insight, /no priced turns/i);
});

test('renderWeekCardSvg: well-formed, colours trace to tokens.yaml', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');
  const today = now.toISOString().slice(0, 10);
  const records = [decRec({ timestamp: `${today}T09:00:00.000Z`, estimated_cost: 9 })];
  const week = computeWeek({ records, now, book, repoOf: (r) => r.repository });
  const svg = renderWeekCardSvg(week, { skin: 'terminal', mode: 'light' });
  assert.ok(svg.includes(usd(9)));
  assert.ok(svg.includes('text-anchor="end"'), 'fact values are right-aligned, like the landing page card');
  assertBalancedXml(svg);
  assertHexFromTokens(svg);
});

// ------------------------------------------------------------ scoped budgets ---

test('evaluateScopedBudgets: a repo over its monthly cap, unaffected by another repo\'s spend', () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  const records = [
    encRec({ rp: 'demo-repo', co: 20, d: '2026-08-05' }),
    encRec({ rp: 'demo-repo', co: 15, d: '2026-08-10' }),
    encRec({ rp: 'other-repo', co: 999, d: '2026-08-10' }),
  ];
  const store = fakeStore(records, 'repo-over-test');
  const config = { budgets: [{ id: 'demo-repo-cap', scope: 'repo', repo: 'demo-repo', monthlyUsd: 25, warnAt: 0.8 }] };

  const rows = evaluateScopedBudgets({ config, store, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'repo');
  assert.equal(rows[0].label, 'demo-repo');
  assert.equal(rows[0].spentUsd, 35);
  assert.equal(rows[0].monthlyUsd, 25);
  assert.equal(rows[0].state, 'over');
  assert.ok(rows[0].share > 1);
});

test('evaluateScopedBudgets: total scope, safely under cap', () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  const records = [
    encRec({ rp: 'demo-repo', co: 10, d: '2026-08-05' }),
    encRec({ rp: 'other-repo', co: 5, d: '2026-08-10' }),
    encRec({ rp: 'demo-repo', co: 3, d: '2026-07-20' }), // last month: out of the window
  ];
  const store = fakeStore(records, 'total-ok-test');
  const config = { budgets: [{ id: 'total-cap', scope: 'total', monthlyUsd: 1000 }] };

  const rows = evaluateScopedBudgets({ config, store, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'total');
  assert.equal(rows[0].spentUsd, 15);
  assert.equal(rows[0].state, 'ok');
});

test('evaluateScopedBudgets: team scope with sync disabled reports "no team data", never a fabricated number', () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  const store = fakeStore([], 'team-none-test');
  const config = { budgets: [{ id: 'team-cap', scope: 'team', monthlyUsd: 500 }], sync: { enabled: false, dir: null } };

  const rows = evaluateScopedBudgets({ config, store, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'team');
  assert.equal(rows[0].spentUsd, 0);
  assert.equal(rows[0].state, 'ok');
  assert.equal(rows[0].note, 'no team data');
});

test('evaluateScopedBudgets: repo scope with no spend this month is distinguished from an unseen repo', () => {
  const now = new Date('2026-08-24T00:00:00.000Z');
  // demo-repo exists in the store, but not inside this month's window.
  const records = [encRec({ rp: 'demo-repo', co: 8, d: '2026-06-01' })];
  const store = fakeStore(records, 'repo-no-spend-test');
  const config = { budgets: [{ id: 'demo-repo-cap', scope: 'repo', repo: 'demo-repo', monthlyUsd: 25 }] };

  const rows = evaluateScopedBudgets({ config, store, now });
  assert.equal(rows[0].spentUsd, 0);
  assert.equal(rows[0].state, 'ok');
  assert.equal(rows[0].note, 'no spend this month');
});

test('renderScopedBudgets: renders every row with its state tag, no em or en dash', () => {
  const rows = [
    { id: 'a', scope: 'repo', label: 'demo-repo', spentUsd: 35, monthlyUsd: 25, share: 1.4, state: 'over', note: null },
    { id: 'b', scope: 'team', label: 'Team', spentUsd: 0, monthlyUsd: 500, share: 0, state: 'ok', note: 'no team data' },
  ];
  const text = renderScopedBudgets(rows);
  assert.ok(text.includes('OVER'));
  assert.ok(text.includes('ok'));
  assert.ok(text.includes('no team data'));
  assert.ok(!text.includes('—') && !text.includes('–'));
});

test('renderScopedBudgets: no budgets configured says so plainly', () => {
  assert.match(renderScopedBudgets([]), /no scoped budgets configured/i);
});

/**
 * src/analytics/branch-compare.js — pure metric-by-metric comparison of two
 * branch receipts, plus the default-pair picker. Synthetic branch receipts
 * only: this module never touches records, so it doesn't need fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBranches, pickDefault, findBranch } from '../src/analytics/branch-compare.js';

/** A branch receipt shaped like one entry from buildReceipts().repos[].branches[]. */
function branch(overrides = {}) {
  return {
    key: 'feat/x',
    cost: 100,
    turns: 20,
    sessions: 2,
    contextShare: 0.5,
    subagentShare: 0.1,
    subagentTurns: 2,
    models: [{ model: 'gpt-5', cost: 100, share: 1 }],
    vsMedian: 1.5,
    changedLines: 200,
    costPer100Lines: 50,
    longLived: false,
    first: '2026-01-01T00:00:00Z',
    last: '2026-01-02T00:00:00Z',
    pr: null,
    ...overrides,
  };
}

// -------------------------------------------------------------- compareBranches

test('compareBranches: ratio and position follow the symmetric log scale', () => {
  const cases = [
    [100, 100, 1, 0],
    [200, 100, 2, 0.5],
    [400, 100, 4, 1],
    [1600, 100, 16, 1],
    [25, 100, 0.25, -1],
    [6.25, 100, 0.0625, -1],
    [0, 100, 0, -1],
  ];
  for (const [a, b, wantRatio, wantPosition] of cases) {
    const rows = compareBranches(branch({ cost: a }), branch({ cost: b }));
    const cost = rows.find((r) => r.key === 'cost');
    assert.equal(cost.ratio, wantRatio, `ratio for ${a}/${b}`);
    assert.ok(Math.abs(cost.position - wantPosition) < 1e-9, `position for ${a}/${b}: got ${cost.position}`);
  }
});

test('compareBranches: a null cost on either side gives a null ratio and position, never a NaN', () => {
  const rows = compareBranches(branch({ cost: null }), branch({ cost: 100 }));
  const cost = rows.find((r) => r.key === 'cost');
  assert.equal(cost.valueA, null);
  assert.equal(cost.valueB, 100);
  assert.equal(cost.ratio, null);
  assert.equal(cost.position, null);

  const rows2 = compareBranches(branch({ cost: 100 }), branch({ cost: null }));
  const cost2 = rows2.find((r) => r.key === 'cost');
  assert.equal(cost2.ratio, null);
  assert.equal(cost2.position, null);
});

test('compareBranches: B at zero gives a null ratio rather than Infinity', () => {
  const rows = compareBranches(branch({ turns: 5 }), branch({ turns: 0 }));
  const turns = rows.find((r) => r.key === 'turns');
  assert.equal(turns.valueB, 0);
  assert.equal(turns.ratio, null);
  assert.equal(turns.position, null);
});

test('compareBranches: costPer100Lines is null when lines are unknown on either side', () => {
  const rows = compareBranches(branch({ changedLines: null, costPer100Lines: null }), branch());
  const row = rows.find((r) => r.key === 'costPer100Lines');
  assert.equal(row.valueA, null);
  assert.equal(row.valueB, 50);
  assert.equal(row.ratio, null);
});

test('compareBranches: costPerTurn is derived from cost and turns, not read off the receipt', () => {
  const rows = compareBranches(branch({ cost: 300, turns: 30 }), branch({ cost: 100, turns: 20 }));
  const row = rows.find((r) => r.key === 'costPerTurn');
  assert.equal(row.valueA, 10);
  assert.equal(row.valueB, 5);
  assert.equal(row.ratio, 2);
});

test('compareBranches: costPerTurn is null with zero turns or an unpriced branch', () => {
  const rows = compareBranches(branch({ cost: 100, turns: 0 }), branch({ cost: null, turns: 20 }));
  const row = rows.find((r) => r.key === 'costPerTurn');
  assert.equal(row.valueA, null);
  assert.equal(row.valueB, null);
  assert.equal(row.ratio, null);
});

test('compareBranches: a models row lists each side\'s models with no ratio', () => {
  const a = branch({ models: [{ model: 'gpt-5', cost: 80, share: 0.8 }, { model: 'gpt-5-mini', cost: 20, share: 0.2 }] });
  const b = branch({ models: [{ model: 'claude', cost: 100, share: 1 }] });
  const rows = compareBranches(a, b);
  const models = rows.find((r) => r.key === 'models');
  assert.equal(models.kind, 'models');
  assert.deepEqual(models.valueA, a.models);
  assert.deepEqual(models.valueB, b.models);
  assert.equal(models.ratio, null);
  assert.equal(models.position, null);
});

test('compareBranches: a null side (nothing picked yet) degrades every row to null values, not a throw', () => {
  const rows = compareBranches(null, branch());
  for (const r of rows) {
    if (r.key === 'models') { assert.deepEqual(r.valueA, []); continue; }
    assert.equal(r.valueA, null);
  }
});

test('compareBranches: every declared metric is present, in a stable order, plus the models row', () => {
  const rows = compareBranches(branch(), branch());
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, [
    'cost', 'turns', 'sessions', 'contextShare', 'subagentShare',
    'costPerTurn', 'costPer100Lines', 'vsMedian', 'models',
  ]);
});

// ------------------------------------------------------------------ pickDefault

test('pickDefault: the most expensive feature branch vs the median-cost feature branch of the same repo', () => {
  const receipts = {
    repos: [
      {
        repo: 'r1',
        branches: [
          branch({ key: 'feat/expensive', cost: 900 }),
          branch({ key: 'feat/mid-low', cost: 200 }),
          branch({ key: 'feat/mid-high', cost: 300 }),
          branch({ key: 'feat/cheap', cost: 50 }),
        ],
      },
      { repo: 'r2', branches: [branch({ key: 'feat/other', cost: 10 })] },
    ],
  };
  const def = pickDefault(receipts);
  assert.deepEqual(def.a, { repo: 'r1', key: 'feat/expensive' });
  // sorted ascending: cheap(50), mid-low(200), mid-high(300), expensive(900) — index floor(3/2)=1 -> mid-low
  assert.deepEqual(def.b, { repo: 'r1', key: 'feat/mid-low' });
});

test('pickDefault: skips a long-lived branch even when it is the highest-cost branch overall', () => {
  const receipts = {
    repos: [
      {
        repo: 'r1',
        branches: [
          branch({ key: 'main', cost: 5000, longLived: true }),
          branch({ key: 'feat/a', cost: 400 }),
          branch({ key: 'feat/b', cost: 100 }),
        ],
      },
    ],
  };
  const def = pickDefault(receipts);
  assert.deepEqual(def.a, { repo: 'r1', key: 'feat/a' });
  assert.deepEqual(def.b, { repo: 'r1', key: 'feat/b' });
});

test('pickDefault: falls back to the two highest-cost branches when the top repo has no second feature branch', () => {
  const receipts = {
    repos: [
      { repo: 'r1', branches: [branch({ key: 'main', cost: 5000, longLived: true }), branch({ key: 'feat/lonely', cost: 400 })] },
      { repo: 'r2', branches: [branch({ key: 'feat/x', cost: 300 })] },
    ],
  };
  const def = pickDefault(receipts);
  // No repo has 2+ feature branches, so fall back to the two highest-cost
  // branches overall, ignoring longLived/unpriced.
  assert.deepEqual(def.a, { repo: 'r1', key: 'main' });
  assert.deepEqual(def.b, { repo: 'r1', key: 'feat/lonely' });
});

test('pickDefault: all branches long-lived or unpriced still falls back to any two branches', () => {
  const receipts = {
    repos: [
      { repo: 'r1', branches: [branch({ key: 'main', cost: null, longLived: true }), branch({ key: 'develop', cost: null, longLived: true })] },
    ],
  };
  const def = pickDefault(receipts);
  assert.ok(def);
  assert.equal(def.a.repo, 'r1');
  assert.equal(def.b.repo, 'r1');
  assert.notEqual(def.a.key, def.b.key);
});

test('pickDefault: null with fewer than two branches anywhere', () => {
  assert.equal(pickDefault(null), null);
  assert.equal(pickDefault({ repos: [] }), null);
  assert.equal(pickDefault({ repos: [{ repo: 'r1', branches: [branch()] }] }), null);
});

// -------------------------------------------------------------------- findBranch

test('findBranch: looks up by (repo, key); a miss on either returns null', () => {
  const receipts = { repos: [{ repo: 'r1', branches: [branch({ key: 'feat/x' })] }] };
  assert.equal(findBranch(receipts, 'r1', 'feat/x').key, 'feat/x');
  assert.equal(findBranch(receipts, 'r1', 'feat/gone'), null);
  assert.equal(findBranch(receipts, 'r-gone', 'feat/x'), null);
  assert.equal(findBranch(null, 'r1', 'feat/x'), null);
});

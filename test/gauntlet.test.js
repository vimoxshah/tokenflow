/**
 * Tests for the gauntlet features: budget alerts, sync, prompt analytics,
 * model comparison, schedule parsing. All pure-function level — no network,
 * no launchd, no real filesystem outside a temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- budget ---
import { computeBudgetState, shouldAlert } from '../src/core/budget.js';

const status = (mtdCost, projected) => ({
  usage: { monthToDate: { cost: mtdCost } },
  forecast: { monthEndCost: projected },
  velocity: {},
});

test('budget: safe when projection under warn threshold', () => {
  const s = computeBudgetState(status(100, 150), { monthly: 200 }, '2026-08-24');
  assert.equal(s.state, 'safe');
});

test('budget: approaching at/above warnAtPct', () => {
  const s = computeBudgetState(status(100, 170), { monthly: 200, warnAtPct: 80 }, '2026-08-24');
  assert.equal(s.state, 'approaching');
  assert.ok(/projected/i.test(s.message));
});

test('budget: over_budget_projected at >=100%', () => {
  const s = computeBudgetState(status(100, 240), { monthly: 200 }, '2026-08-24');
  assert.equal(s.state, 'over_budget_projected');
});

test('budget: over_budget_actual when MTD spend >= budget', () => {
  const s = computeBudgetState(status(250, null), { monthly: 200 }, '2026-08-24');
  assert.equal(s.state, 'over_budget_actual');
});

test('budget honesty: unknown state when no forecast data', () => {
  const s = computeBudgetState({ usage: { monthToDate: { cost: null } } }, { monthly: 200 }, '2026-08-24');
  assert.equal(s.state, 'unknown');
});

test('budget dedup: same state fires once per month', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-budget-'));
  process.env.TOKENFLOW_HOME = tmp;
  // config.js caches paths() on first import; point the state file at the
  // temp home explicitly via resetBudgetState after seeding env, and clear
  // any real state that could leak into this test.
  fs.rmSync(path.join(tmp, 'data'), { recursive: true, force: true });

  return import('../src/core/budget.js').then(async (m) => {
    m.resetBudgetState();
    const st = computeBudgetState(status(100, 170), { monthly: 200 }, '2026-08-24');
    const first = m.shouldAlert(st);
    assert.equal(first.fire, true);
    const second = m.shouldAlert(st);
    assert.equal(second.fire, false); // suppressed — already alerted this month

    // escalation re-fires
    const worse = computeBudgetState(status(100, 240), { monthly: 200 }, '2026-08-24');
    const esc = m.shouldAlert(worse);
    assert.equal(esc.fire, true);

    // new month re-fires
    const nextMonth = computeBudgetState(status(0, 180), { monthly: 200 }, '2026-09-24');
    const nm = m.shouldAlert(nextMonth);
    assert.equal(nm.fire, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ sync ---
import { isEnabled, machineId } from '../src/core/sync.js';

test('sync: OFF by default', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ sync: { enabled: false, dir: '/tmp' } }), false);
});

test('sync: enabled only with enabled+dir', () => {
  assert.equal(isEnabled({ sync: { enabled: true, dir: '/tmp/x' } }), true);
});

test('sync: push writes per-machine file, pull merges siblings', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-shared-'));
  process.env.TOKENFLOW_HOME = tmpHome;

  return import('../src/core/sync.js').then(async (m) => {
    const cfg = { sync: { enabled: true, dir: shared, machineName: 'TestBox' } };
    // seed a fake cube for push to read
    const dataDir = path.join(tmpHome, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const dims = ['d', 'p'];
    const measures = ['in', 'out', 'req', 'cost'];
    fs.writeFileSync(path.join(dataDir, 'cube.json'), JSON.stringify({
      dims, measures,
      rows: [
        ['2026-08-23', 'anthropic', 1000, 500, 10, 1.5],
        ['2026-08-24', 'openai', 2000, 800, 5, 2.0],
      ],
    }));

    const r = m.push({ config: cfg });
    assert.ok(r.days >= 2);
    const id = m.machineId(tmpHome);
    const pushed = fs.readFileSync(path.join(shared, `${id}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(pushed.length, 2);

    // simulate a sibling machine
    fs.writeFileSync(path.join(shared, 'm-sibling.jsonl'),
      '{"machineId":"m-sibling","machineName":"Desktop","date":"2026-08-23","inputTokens":9000,"outputTokens":400,"requests":77,"estCostUsd":9.9}\n');

    const merged = m.pull({ config: cfg });
    const day = merged.days.find((d) => d.date === '2026-08-23');
    assert.equal(day.machineCount, 2);
    assert.equal(day.requests, 87); // 10 local + 77 sibling
    assert.equal(day.estCost, 11.4); // 1.5 + 9.9

    // privacy: synced lines contain no raw content fields
    for (const line of pushed) {
      const rec = JSON.parse(line);
      assert.ok(!('raw' in rec));
      assert.ok(!('promptHash' in rec));
      assert.deepEqual(Object.keys(rec).sort(),
        ['date', 'estCostUsd', 'exportedAt', 'inputTokens', 'machineId', 'machineName', 'outputTokens', 'requests']);
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
  });
});

// -------------------------------------------------------- prompt analytics --
import { hashPrompt, normalizePrompt, categorize, aggregate, makePromptRecord } from '../src/core/prompt-analytics.js';

test('prompt analytics: normalization is case/punctuation insensitive', () => {
  assert.equal(normalizePrompt('Review THIS PR!'), normalizePrompt('review this pr'));
});

test('prompt analytics: hash is one-way and stable', () => {
  assert.equal(hashPrompt('Fix the bug'), hashPrompt('fix the bug'));
  assert.notEqual(hashPrompt('Fix the bug'), hashPrompt('Fix the bugs'));
  assert.equal(hashPrompt('x').length, 16);
});

test('prompt analytics: categorization by keywords, else uncategorized', () => {
  assert.equal(categorize('please review my pull request'), 'code-review');
  assert.equal(categorize('the test suite fails'), 'testing');
  assert.equal(categorize('what time is it'), 'uncategorized');
});

test('prompt analytics: aggregation computes cost-by-category and repeat rate', () => {
  const recs = [
    makePromptRecord({ promptText: 'Review this PR', model: 'a', tokens: 100, cost: 1 }),
    makePromptRecord({ promptText: 'review this pr', model: 'b', tokens: 120, cost: 2 }),
    makePromptRecord({ promptText: 'write docs', model: 'a', tokens: 50, cost: 0.1 }),
  ];
  const agg = aggregate(recs);
  assert.equal(agg.totalPrompts, 3);
  assert.equal(agg.uniquePrompts, 2);          // first two are the same normalized prompt
  assert.equal(agg.repeatRatePct, 33.3);
  const review = agg.categories.find((c) => c.category === 'code-review');
  assert.equal(review.requests, 2);
  assert.equal(review.estCostUsd, 3);
});

test('prompt privacy: makePromptRecord stores NO raw text by default', () => {
  const rec = makePromptRecord({ promptText: 'super secret internal prompt', tokens: 10 });
  assert.ok(!('raw' in rec));
  assert.ok(!JSON.stringify(rec).includes('super secret'));
  assert.match(rec.promptHash, /^[0-9a-f]{16}$/);
});

// ------------------------------------------------------ models comparison ---
import { compare, renderText } from '../src/commands/models-compare.js';

test('models-compare: real data produces non-NaN derived metrics', () => {
  const c = compare({});
  if (!c) return; // no data on this machine — skip
  for (const m of c.models) {
    assert.equal(Number.isNaN(m.avgTokensPerRequest), false, `tok/req NaN for ${m.key}`);
    if (m.cacheHitPct != null) assert.ok(m.cacheHitPct >= 0 && m.cacheHitPct <= 100);
  }
  const text = renderText(c);
  assert.ok(!text.includes('NaN'), 'rendered text must not contain NaN');
});

// ---------------------------------------------------------------- schedule ---
import { parseWhen } from '../src/core/schedule.js';

test('schedule: parses "Monday 09:00" style inputs', () => {
  assert.deepEqual(parseWhen('Monday 09:00'), { Weekday: 1, Hour: 9, Minute: 0 });
  assert.deepEqual(parseWhen('sun 23:59'), { Weekday: 0, Hour: 23, Minute: 59 });
  assert.equal(parseWhen('nonsense'), null);
  assert.equal(parseWhen('Monday 25:00'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffPriceTables, applyCandidate, run } from '../src/commands/pricing-diff.js';
import { readJson } from '../src/core/store.js';
import { PRICING_SOURCES } from '../src/core/pricing.js';

/**
 * `fn` may be async — the cleanup must `await` it before removing the temp
 * dir, or an async `fn` still mid-flight loses its overrides file out from
 * under it (a bare `return fn(...)` in a sync `try/finally` runs the
 * `finally` immediately, before the returned promise ever settles).
 */
async function withOverridesFile(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-'));
  const overridesPath = path.join(dir, 'pricing.json');
  fs.writeFileSync(overridesPath, JSON.stringify(initial));
  try {
    return await fn(overridesPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('diffPriceTables: added — a model with no current rate anywhere', () => {
  const current = { models: {} };
  const candidate = { models: { 'brand-new-model-x': { in: 3, out: 9 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].model, 'brand-new-model-x');
  assert.equal(diff.added[0].to.in, 3);
  assert.equal(diff.added[0].to.out, 9);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.removed.length, 0);
});

test('diffPriceTables: removed — an existing override the candidate does not mention', () => {
  const current = { models: { 'old-model': { in: 1, out: 2 } } };
  const candidate = { models: { 'brand-new-model-x': { in: 3, out: 9 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].model, 'old-model');
  assert.equal(diff.removed[0].rates.in, 1);
});

test('diffPriceTables: changed — an existing override, with percent change per field', () => {
  const current = { models: { 'my-model': { in: 10, out: 20 } } };
  const candidate = { models: { 'my-model': { in: 11, out: 20 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.changed.length, 1);
  const c = diff.changed[0];
  assert.equal(c.model, 'my-model');
  assert.ok(c.deltas.in);
  assert.equal(c.deltas.in.from, 10);
  assert.equal(c.deltas.in.to, 11);
  assert.ok(Math.abs(c.deltas.in.pct - 0.1) < 1e-9, 'a $10 -> $11 input rate is +10%');
  assert.ok(!c.deltas.out, 'the unchanged output rate does not appear in deltas');
});

test('diffPriceTables: changed — compares against the built-in rate when there is no override yet', () => {
  const current = { models: {} };
  // claude-opus-5 matches a BUILTIN_PRICES entry (in:5, out:25) with no user override.
  const candidate = { models: { 'claude-opus-5': { in: 6, out: 25 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.added.length, 0, 'a model priced by the builtin table is "changed", not "added"');
  assert.equal(diff.changed.length, 1);
  const c = diff.changed[0];
  assert.equal(c.deltas.in.from, 5);
  assert.equal(c.deltas.in.to, 6);
  assert.ok(Math.abs(c.deltas.in.pct - 0.2) < 1e-9);
  assert.equal(c.currentOrigin, 'builtin');
});

test('diffPriceTables: a candidate "match" override that does not match its own key is reported invalid, not a crash', () => {
  const current = { models: {} };
  const candidate = { models: { 'my-alias': { match: '^gpt-9', in: 1, out: 2 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.invalid.length, 1);
  assert.equal(diff.invalid[0].model, 'my-alias');
  assert.equal(diff.added.length, 0);
  assert.equal(diff.changed.length, 0);
});

test('diffPriceTables: an identical rate is neither added nor changed', () => {
  const current = { models: { 'same-model': { in: 4, out: 8 } } };
  const candidate = { models: { 'same-model': { in: 4, out: 8 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.changed.length, 0);
  assert.deepEqual(diff.unchanged, ['same-model']);
});

test('diffPriceTables: an invalid candidate entry (no numeric in/out) is reported, not silently dropped', () => {
  const current = { models: {} };
  const candidate = { models: { 'broken-model': { cacheRead: 0.5 } } };
  const diff = diffPriceTables(current, candidate);
  assert.equal(diff.invalid.length, 1);
  assert.equal(diff.invalid[0].model, 'broken-model');
  assert.equal(diff.added.length, 0);
  assert.equal(diff.changed.length, 0);
});

test('diffPriceTables: candidate sources are carried through untouched', () => {
  const diff = diffPriceTables({ models: {} }, {
    models: { m: { in: 1, out: 2 } },
    sources: ['https://vendor.example.com/pricing'],
    version: '2026-09-01',
  });
  assert.deepEqual(diff.candidateSources, ['https://vendor.example.com/pricing']);
  assert.equal(diff.candidateVersion, '2026-09-01');
});

test('run(): prints the diff, showing the candidate sources next to the current PRICING_SOURCES', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({
      models: { 'brand-new-model-x': { in: 3, out: 9 } },
      sources: ['https://vendor.example.com/pricing'],
      version: '2026-09-01',
    }));
    try {
      const res = await run({ file, overridesPath });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('brand-new-model-x'));
      assert.ok(res.stdout.includes('https://vendor.example.com/pricing'), 'candidate source shown');
      for (const key of Object.keys(PRICING_SOURCES)) {
        assert.ok(res.stdout.includes(key), `current source group "${key}" shown`);
      }
      // A plain diff (no --apply) never writes.
      assert.deepEqual(readJson(overridesPath, null), { models: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('applyCandidate: merges, preserving overrides the candidate does not mention', async () => {
  await withOverridesFile({ models: { 'model-a': { in: 1, out: 2 }, 'model-b': { in: 5, out: 10 } } }, (overridesPath) => {
    const candidate = { models: { 'model-a': { in: 1.5, out: 2 } } };
    const res = applyCandidate({ candidate, overridesPath });
    assert.equal(res.modelCount, 2);
    const saved = readJson(overridesPath, null);
    assert.equal(saved.models['model-a'].in, 1.5, 'the mentioned model is updated');
    assert.deepEqual(saved.models['model-b'], { in: 5, out: 10 }, 'the unmentioned model survives untouched');
    assert.ok(saved.updatedAt);
  });
});

test('run(): --apply without --yes is refused when stdin is not a TTY, and nothing is written', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand2-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'brand-new-model-x': { in: 3, out: 9 } } }));
    try {
      const res = await run({ file, overridesPath, apply: true, isTTY: false });
      assert.equal(res.exitCode, 1);
      assert.match(res.stderr, /--yes/);
      assert.deepEqual(readJson(overridesPath, null), { models: {} }, 'refused apply writes nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('run(): --apply --yes writes even when stdin is not a TTY', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand3-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'brand-new-model-x': { in: 3, out: 9 } } }));
    try {
      const res = await run({ file, overridesPath, apply: true, yes: true, isTTY: false });
      assert.equal(res.exitCode, 0);
      const saved = readJson(overridesPath, null);
      assert.equal(saved.models['brand-new-model-x'].in, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('run(): on a TTY without --yes, an interactive confirm gates the apply', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand4-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'brand-new-model-x': { in: 3, out: 9 } } }));
    try {
      const declined = await run({ file, overridesPath, apply: true, isTTY: true, confirm: async () => false, write: () => {} });
      assert.equal(declined.exitCode, 0);
      assert.match(declined.stdout, /cancelled/);
      assert.deepEqual(readJson(overridesPath, null), { models: {} }, 'declining the prompt writes nothing');

      const accepted = await run({ file, overridesPath, apply: true, isTTY: true, confirm: async () => true, write: () => {} });
      assert.equal(accepted.exitCode, 0);
      const saved = readJson(overridesPath, null);
      assert.equal(saved.models['brand-new-model-x'].in, 3, 'accepting the prompt applies the candidate');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('run(): on the interactive-confirm path, the diff reaches the terminal before the confirm prompt does', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand4b-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'brand-new-model-x': { in: 3, out: 9 } } }));
    try {
      const events = [];
      const res = await run({
        file,
        overridesPath,
        apply: true,
        isTTY: true,
        write: (s) => events.push({ type: 'write', s }),
        confirm: async (question) => { events.push({ type: 'confirm', question }); return true; },
      });
      assert.equal(res.exitCode, 0);
      assert.equal(events.length, 2, 'exactly one diff write and one confirm call');
      assert.equal(events[0].type, 'write', 'the diff is written before the prompt appears');
      assert.ok(events[0].s.includes('brand-new-model-x'), 'the write carries the actual diff text');
      assert.equal(events[1].type, 'confirm');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('run(): --apply refuses when the candidate has an invalid entry', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-pricing-cand5-'));
    const file = path.join(dir, 'candidate.json');
    fs.writeFileSync(file, JSON.stringify({ models: { 'broken-model': { cacheRead: 0.5 } } }));
    try {
      const res = await run({ file, overridesPath, apply: true, yes: true });
      assert.equal(res.exitCode, 1);
      assert.match(res.stderr, /invalid/);
      assert.deepEqual(readJson(overridesPath, null), { models: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('run(): reads the candidate from stdin ("-") via the injectable stdinReader', async () => {
  await withOverridesFile({ models: {} }, async (overridesPath) => {
    const res = await run({
      file: '-',
      overridesPath,
      stdinReader: () => JSON.stringify({ models: { 'from-stdin-model': { in: 2, out: 4 } } }),
    });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('from-stdin-model'));
  });
});

test('run(): no file argument is a usage error', async () => {
  const res = await run({});
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /usage/);
});

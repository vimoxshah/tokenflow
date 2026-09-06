/**
 * Per-repository guard policy: `.tokenflow/policy.yaml` overriding
 * ~/.tokenflow/config.yaml's `guard` section, key by key, with the source of
 * each effective value reported so `guard --policy` can show its work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRepoPolicy, effectiveGuardPolicy, GUARD_KEYS } from '../src/core/policy.js';

/** A bare `.git` directory is enough to be a repository root — no `git init` needed. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policy-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function writePolicy(root, yaml) {
  const dir = path.join(root, '.tokenflow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml);
}

test('loadRepoPolicy: overrides two keys, ignores an unknown key, and carries a note', () => {
  const root = makeRepo();
  writePolicy(root, [
    'guard:',
    '  warnCostUsd: 10',
    '  maxCostUsd: 50',
    '  bogusKey: 3',
    'note: "Data-heavy repo; sessions run long."',
    '',
  ].join('\n'));

  const p = loadRepoPolicy(root);
  assert.equal(p.found, true);
  assert.equal(p.repoRoot, root);
  assert.equal(p.guard.warnCostUsd, 10);
  assert.equal(p.guard.maxCostUsd, 50);
  assert.equal(p.guard.warnContextTokens, undefined);
  assert.equal(p.note, 'Data-heavy repo; sessions run long.');
  assert.match(p.errors[0], /unknown guard key "bogusKey"/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepoPolicy: invalid values (non-numbers, negatives) are reported, not thrown', () => {
  const root = makeRepo();
  writePolicy(root, [
    'guard:',
    '  warnCostUsd: "lots"',
    '  maxCostUsd: -5',
    '  warnContextTokens: 100000',
    '',
  ].join('\n'));

  assert.doesNotThrow(() => loadRepoPolicy(root));
  const p = loadRepoPolicy(root);
  assert.equal(p.guard.warnContextTokens, 100000, 'the one valid key still applies');
  assert.equal(p.guard.warnCostUsd, undefined);
  assert.equal(p.guard.maxCostUsd, undefined);
  assert.equal(p.errors.length, 2);
  assert.match(p.errors.find((e) => /warnCostUsd/.test(e)), /must be a positive number/);
  assert.match(p.errors.find((e) => /maxCostUsd/.test(e)), /must be a positive number/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepoPolicy: no file found means an empty (not thrown) result', () => {
  const root = makeRepo();
  const p = loadRepoPolicy(root);
  assert.equal(p.found, false);
  assert.deepEqual(p.guard, {});
  assert.equal(p.note, null);
  assert.deepEqual(p.errors, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepoPolicy: a cwd outside any repository finds no policy.yaml', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policy-none-'));
  const p = loadRepoPolicy(outside);
  // The temp root itself may sit under some repository on the host (a stray
  // `.git` in the OS tmpdir, seen on this machine), so only the negative is
  // asserted: whatever repo (if any) is found there declares no policy file.
  assert.equal(p.found, false);
  assert.deepEqual(p.guard, {});
  fs.rmSync(outside, { recursive: true, force: true });
});

test('loadRepoPolicy: no cwd at all (undefined) behaves like "outside any repo"', () => {
  const p = loadRepoPolicy(undefined);
  assert.equal(p.repoRoot, null);
  assert.equal(p.found, false);
});

// ------------------------------------------------------- effectiveGuardPolicy ---

test('effectiveGuardPolicy: the repo overrides two keys, config supplies the rest, sources are reported per key', () => {
  const root = makeRepo();
  writePolicy(root, ['guard:', '  warnCostUsd: 10', '  maxCostUsd: 50', ''].join('\n'));
  const config = { guard: { warnCostUsd: 999, warnContextTokens: 150000 } };

  const eff = effectiveGuardPolicy({ cwd: root, config });
  assert.equal(eff.repoRoot, root);
  assert.equal(eff.policy.warnCostUsd, 10, 'repo wins over config for a key both declare');
  assert.equal(eff.sources.warnCostUsd, 'repo');
  assert.equal(eff.policy.maxCostUsd, 50);
  assert.equal(eff.sources.maxCostUsd, 'repo');
  assert.equal(eff.policy.warnContextTokens, 150000, 'config fills in a key the repo does not declare');
  assert.equal(eff.sources.warnContextTokens, 'config');
  assert.equal(eff.policy.maxContextTokens, null);
  assert.equal(eff.sources.maxContextTokens, 'default');
  assert.equal(eff.policy.warnMarginalUsd, null);
  assert.equal(eff.sources.warnMarginalUsd, 'default');
  assert.ok(GUARD_KEYS.every((k) => k in eff.policy));

  fs.rmSync(root, { recursive: true, force: true });
});

test('effectiveGuardPolicy: no policy.yaml means config wins for every key', () => {
  const root = makeRepo();
  const config = { guard: { warnCostUsd: 25, maxCostUsd: 200 } };
  const eff = effectiveGuardPolicy({ cwd: root, config });
  assert.equal(eff.policy.warnCostUsd, 25);
  assert.equal(eff.sources.warnCostUsd, 'config');
  assert.equal(eff.policy.maxCostUsd, 200);
  assert.equal(eff.sources.maxCostUsd, 'config');
  assert.equal(eff.policy.warnContextTokens, null);
  assert.equal(eff.sources.warnContextTokens, 'default');
  fs.rmSync(root, { recursive: true, force: true });
});

test('effectiveGuardPolicy: an invalid repo value falls back to config rather than the bad value', () => {
  const root = makeRepo();
  writePolicy(root, ['guard:', '  warnCostUsd: -5', ''].join('\n'));
  const config = { guard: { warnCostUsd: 25 } };
  const eff = effectiveGuardPolicy({ cwd: root, config });
  assert.equal(eff.policy.warnCostUsd, 25);
  assert.equal(eff.sources.warnCostUsd, 'config');
  assert.equal(eff.errors.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('effectiveGuardPolicy: a cwd outside any repository falls back to config for every key', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-policy-none2-'));
  const config = { guard: { maxCostUsd: 200 } };
  const eff = effectiveGuardPolicy({ cwd: outside, config });
  // As above: only the negative is asserted, because the temp root may sit
  // under some repository on the host — it just must not declare a policy.
  for (const k of GUARD_KEYS) assert.notEqual(eff.sources[k], 'repo');
  assert.equal(eff.sources.maxCostUsd, 'config');
  assert.equal(eff.sources.warnCostUsd, 'default');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('effectiveGuardPolicy: with no cwd and no config.guard, every key is default/null', () => {
  const eff = effectiveGuardPolicy({ config: {} });
  assert.equal(eff.repoRoot, null);
  for (const k of GUARD_KEYS) {
    assert.equal(eff.policy[k], null);
    assert.equal(eff.sources[k], 'default');
  }
});

// ------------------------------------------------------- loadRepoPolicy: receipt ---
//
// `receipt.maxCostUsd` / `receipt.maxCostPer100Lines` are a contract with the
// Action and App streams (docs/policy.md) — parsed and validated here with
// the same "reported, never thrown" posture as `guard:`, but never merged
// into `effectivePolicy()` (see test/policy-org.test.js).

test('loadRepoPolicy: parses a receipt block alongside guard, and rejects an unknown receipt key', () => {
  const root = makeRepo();
  writePolicy(root, [
    'guard:',
    '  maxCostUsd: 50',
    'receipt:',
    '  maxCostUsd: 25',
    '  maxCostPer100Lines: 2.5',
    '  bogusReceiptKey: 1',
    '',
  ].join('\n'));

  const p = loadRepoPolicy(root);
  assert.equal(p.found, true);
  assert.equal(p.guard.maxCostUsd, 50);
  assert.equal(p.receipt.maxCostUsd, 25);
  assert.equal(p.receipt.maxCostPer100Lines, 2.5);
  assert.match(p.errors.find((e) => /bogusReceiptKey/.test(e)), /unknown receipt key "bogusReceiptKey"/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepoPolicy: an invalid receipt value is reported and left out, the rest of the block still applies', () => {
  const root = makeRepo();
  writePolicy(root, [
    'receipt:',
    '  maxCostUsd: -10',
    '  maxCostPer100Lines: "a lot"',
    '',
  ].join('\n'));

  const p = loadRepoPolicy(root);
  assert.deepEqual(p.receipt, {});
  assert.equal(p.errors.length, 2);
  assert.match(p.errors.find((e) => /maxCostUsd/.test(e)), /receipt\.maxCostUsd must be a positive number/);
  assert.match(p.errors.find((e) => /maxCostPer100Lines/.test(e)), /receipt\.maxCostPer100Lines must be a positive number/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadRepoPolicy: no policy.yaml means an empty receipt block too', () => {
  const root = makeRepo();
  const p = loadRepoPolicy(root);
  assert.deepEqual(p.receipt, {});
  fs.rmSync(root, { recursive: true, force: true });
});

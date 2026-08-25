/**
 * Regression test: `tokenflow demo` must be isolated.
 *
 * History: cmdDemo used to overwrite the *default* store's config.yaml with
 * providers:['mock'] and ingest synthetic records into ~/.tokenflow, silently
 * polluting real data. The fix sandboxes the run behind a throwaway
 * $TOKENFLOW_HOME unless the caller set one explicitly.
 *
 * This test spawns the real CLI as a subprocess with HOME pointed at an empty
 * temp dir, then asserts nothing appeared under <home>/.tokenflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo: never writes to the default store when TOKENFLOW_HOME is unset', { timeout: 120_000 }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-demo-home-'));
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'tokenflow.js'), 'demo', '--no-serve', '--no-dashboard', '--days', '2'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 110_000,
      env: {
        ...process.env,
        TOKENFLOW_HOME: '',   // exercise the bare-invocation path the bug lived on
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    },
  );

  // the CLI must announce the sandbox instead of touching the default home
  assert.match(out, /sandboxed demo store/i);

  // nothing may exist under the (fake) default home
  assert.equal(fs.existsSync(path.join(fakeHome, '.tokenflow')), false,
    'demo wrote into the default home — isolation broken');

  // the sandbox itself got a self-contained store
  const m = out.match(/sandboxed demo store: (\S+)/);
  assert.ok(m, 'sandbox path not printed');
  assert.ok(fs.existsSync(path.join(m[1], 'config.yaml')), 'sandbox store missing config');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('demo: explicit TOKENFLOW_HOME wins over sandboxing', { timeout: 120_000 }, () => {
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-demo-chosen-'));
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'tokenflow.js'), 'demo', '--no-serve', '--no-dashboard', '--days', '2'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 110_000,
      env: { ...process.env, TOKENFLOW_HOME: chosen },
    },
  );
  assert.ok(fs.existsSync(path.join(chosen, 'config.yaml')));
  const cfg = fs.readFileSync(path.join(chosen, 'config.yaml'), 'utf8');
  assert.match(cfg, /mock/, 'chosen home should hold the mock provider');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * The app bundle's contract with the CLI it ships.
 *
 * 1.1.1 shipped an app whose Info.plist named `/Users/runner/work/...` — the
 * CI machine that built it — and shipped no CLI at all, so a cask-only install
 * had a menu bar app with nothing to drive. Both are build-script properties,
 * invisible to every other test, and only a real build can prove them.
 *
 * Building takes swiftc, so this suite skips anywhere it cannot run: off
 * macOS, or on a macOS box without the Command Line Tools.
 */
const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function canBuild() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

const skip = canBuild() ? false : 'needs macOS with swiftc';

function build(outDir, { portable }) {
  execFileSync('bash', [path.join(REPO, 'scripts', 'build-menubar-app.sh'), outDir], {
    cwd: REPO,
    stdio: 'ignore',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, ...(portable ? { TOKENFLOW_PORTABLE: '1' } : {}) },
  });
  return path.join(outDir, 'TokenFlow.app');
}

function plistKey(app, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // key absent
  }
}

test('app bundle: a portable build embeds no path from the machine that built it', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bundle-'));
  try {
    const app = build(out, { portable: true });
    // The exact 1.1.1 regression: these named the CI runner's filesystem.
    assert.equal(plistKey(app, 'TokenFlowCLIPath'), null, 'a distributable build must not name a CLI path');
    assert.equal(plistKey(app, 'TokenFlowNodePath'), null, 'a distributable build must not name a node path');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('app bundle: ships a working CLI, so a cask-only install can do something', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bundle-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bundle-home-'));
  try {
    const app = build(out, { portable: true });
    const cli = path.join(app, 'Contents', 'Resources', 'cli', 'package', 'bin', 'tokenflow.js');
    assert.ok(fs.existsSync(cli), 'the app must carry its own CLI');

    const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 60000 }).trim();
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(version, pkg.version, 'the bundled CLI must be this version, not a stray one');

    // Running, not merely present: the bundle is pruned to what the CLI
    // executes, so prove the pruning did not cut something it loads.
    const env = { ...process.env, TOKENFLOW_HOME: home };
    execFileSync(process.execPath, [cli, 'demo', '--no-serve', '--days', '5'], { stdio: 'ignore', timeout: 180000, env });
    const usage = execFileSync(process.execPath, [cli, 'usage', '--json'], { encoding: 'utf8', timeout: 120000, env });
    assert.ok(JSON.parse(usage).usage.today.tokens.total > 0, 'the bundled CLI must be able to read data back');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('app bundle: a local build still drives the working tree', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bundle-'));
  try {
    const app = build(out, { portable: false });
    // Without this a developer's installed app would silently drive the frozen
    // copy inside itself rather than the checkout they are editing.
    assert.equal(plistKey(app, 'TokenFlowCLIPath'), path.join(REPO, 'bin', 'tokenflow.js'));
    assert.ok(plistKey(app, 'TokenFlowNodePath'), 'a local build names a node binary');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

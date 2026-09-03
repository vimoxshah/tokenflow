/**
 * The watcher's login agent — launchd-supervised `tokenflow watch`.
 *
 * "Live" needs a resident process, and until now nothing installed one. The
 * play button could start a watcher for the length of the session, and that
 * was all: nothing survived a reboot, so a machine woke up with stale data and
 * a paused menu bar. Every user who wanted live data had to hand-roll a
 * LaunchAgent, and a hand-rolled one is where two real defects came from.
 *
 * ## KeepAlive is not a boolean here
 *
 * `KeepAlive: true` restarts the job whatever happens — including after a
 * clean exit. On a supervised watcher that silently defeats the stop button:
 * `tokenflow watch --stop` sends SIGTERM, the watcher releases its lock and
 * exits 0, and launchd starts it again about two seconds later. Measured, not
 * assumed. So the rule is `KeepAlive: { SuccessfulExit: false }` — a crash
 * comes back, a deliberate stop stays stopped until the next login.
 *
 * ## ThrottleInterval is a safety belt, not a tuning knob
 *
 * A watcher that cannot take the lock exits 1, which under the rule above is a
 * restart. If something ever holds the lock persistently, that is an infinite
 * respawn loop writing to the log every time — exactly what filled one user's
 * watch.log with 2.2 MB of the same refusal. 60 seconds keeps a stuck state
 * quiet enough to diagnose.
 *
 * ## One watcher, one agent
 *
 * Two agents both running `tokenflow watch` is the same trap: the loser exits
 * 1 forever. Installing therefore hunts down any OTHER agent that runs a
 * tokenflow watcher and removes it — by reading what each plist actually runs,
 * not by trusting a label, because a hand-rolled one can be called anything.
 * Leaving the file on disk is not enough either: launchd reloads it at the next
 * login and the race comes back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const LABEL = 'app.tokenflow.watch';

/** launchd restarts a crash after this many seconds, never faster. */
const THROTTLE_SECONDS = 60;

export function agentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export function plistPath() {
  return path.join(agentsDir(), `${LABEL}.plist`);
}

export function supported() {
  return process.platform === 'darwin';
}

function homeDir() {
  return process.env.TOKENFLOW_HOME || path.join(os.homedir(), '.tokenflow');
}

/** The CLI this module was loaded from: src/core/watch-agent.js → ../../bin */
export function cliPath() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', 'bin', 'tokenflow.js');
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPlist({ nodeBin, cli, home, workingDir }) {
  // A launchd plist always carries POSIX paths, so build them with path.posix
  // rather than the host's separator. Rendering is then identical everywhere,
  // which is what makes it testable on a machine that could never run it.
  const bin = path.posix.dirname(nodeBin);
  const PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(nodeBin)}</string>
        <string>${xml(cli)}</string>
        <string>watch</string>
    </array>
    <key>RunAtLoad</key><true/>
    <!-- A crash restarts; a clean stop stays stopped. See watch-agent.js. -->
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>${THROTTLE_SECONDS}</integer>
    <key>WorkingDirectory</key><string>${xml(workingDir)}</string>
    <key>StandardOutPath</key><string>${xml(path.posix.join(home, 'watch.log'))}</string>
    <key>StandardErrorPath</key><string>${xml(path.posix.join(home, 'watch.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENFLOW_HOME</key><string>${xml(home)}</string>
        <key>PATH</key><string>${xml(PATH)}</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Every OTHER launch agent that runs a tokenflow watcher.
 *
 * Reads what each plist RUNS rather than matching a label: a hand-rolled agent
 * can be named anything, and one that keeps respawning against our lock is
 * indistinguishable from a broken install.
 *
 * @param {string} [dir]
 * @returns {{label:string, file:string}[]}
 */
export function findForeignAgents(dir = agentsDir()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.plist'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name === `${LABEL}.plist`) continue;
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Runs a tokenflow CLI, and runs it with the `watch` subcommand.
    const runsCli = /<string>[^<]*\/(?:tokenflow\.js|tokenflow)<\/string>/.test(text);
    const runsWatch = /<string>\s*watch\s*<\/string>/.test(text);
    if (!runsCli || !runsWatch) continue;
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] || name.replace(/\.plist$/, '');
    out.push({ label, file });
  }
  return out;
}

function launchctl(args, { quiet = true } = {}) {
  try {
    execFileSync('launchctl', args, { stdio: quiet ? 'ignore' : 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function domain() {
  return `gui/${process.getuid?.() ?? ''}`;
}

/** Load a plist, preferring the modern API and falling back to the legacy one. */
function bootstrap(file) {
  if (launchctl(['bootstrap', domain(), file])) return true;
  return launchctl(['load', file]);
}

function bootout(label, file) {
  const byLabel = launchctl(['bootout', `${domain()}/${label}`]);
  const byFile = launchctl(['unload', file]);
  return byLabel || byFile;
}

/**
 * Install (or reinstall) the agent and start it.
 * @returns {{plist:string, removed:{label:string,file:string}[], started:boolean}}
 */
export function install() {
  if (!supported()) {
    throw Object.assign(new Error('a launch agent needs macOS'), {
      hint: 'On Linux, run `tokenflow watch` from a systemd --user unit, or `tokenflow watch --once` from cron.',
    });
  }
  const home = homeDir();
  const cli = cliPath();
  if (!fs.existsSync(cli)) throw new Error(`cannot find the CLI at ${cli}`);
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // Any other watcher agent would fight this one for the lock forever. Unload
  // it AND delete its plist — an unloaded file returns at the next login.
  const removed = findForeignAgents();
  for (const a of removed) {
    bootout(a.label, a.file);
    try { fs.unlinkSync(a.file); } catch { /* already gone */ }
  }

  const file = plistPath();
  fs.writeFileSync(file, renderPlist({
    nodeBin: process.execPath,
    cli,
    home,
    workingDir: path.resolve(path.dirname(cli), '..'),
  }));
  bootout(LABEL, file); // a reinstall must replace, not duplicate
  const started = bootstrap(file);
  return { plist: file, removed, started };
}

export function uninstall() {
  const file = plistPath();
  const had = fs.existsSync(file);
  bootout(LABEL, file);
  if (had) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
  return { removed: had, plist: file };
}

/** @returns {{supported:boolean, installed:boolean, loaded:boolean, plist:string, foreign:{label:string,file:string}[]}} */
export function status() {
  const file = plistPath();
  let loaded = false;
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    loaded = out.split('\n').some((l) => l.trim().endsWith(LABEL));
  } catch { /* launchctl unavailable */ }
  return {
    supported: supported(),
    installed: fs.existsSync(file),
    loaded,
    plist: file,
    foreign: findForeignAgents(),
  };
}

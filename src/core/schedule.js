/**
 * Digest scheduling — launchd-based, no resident Node process.
 *
 * Installs a per-user LaunchAgent that runs `tokenflow digest` on a schedule
 * (default: every Monday at 09:00) and optionally delivers it via a
 * configured channel (email/telegram/webhook — see delivery.js). The digest
 * is also always written to $TOKENFLOW_HOME/digests/<date>.md so there is a
 * local record even if delivery fails.
 *
 *   tokenflow schedule --install                # weekly, Monday 09:00
 *   tokenflow schedule --install --at "Sunday 18:00"
 *   tokenflow schedule --uninstall
 *   tokenflow schedule --status
 *
 * Design notes:
 *  - launchd StartCalendarInterval = native macOS scheduling; the agent only
 *    wakes Node for the seconds the digest takes to build.
 *  - Delivery adapters live in delivery.js and are entirely opt-in. With no
 *    delivery configured, the digest is still written locally.
 *  - The plist embeds an absolute node path captured at install time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from './config.js';

const LABEL = 'app.tokenflow.digest';

export function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/** Parse "Sunday 18:00" / "Mon 09:15" → { Weekday, Hour, Minute } */
export function parseWhen(when) {
  const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const m = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2}):(\d{2})$/i.exec((when || '').trim());
  if (!m) return null;
  const wd = DAYS[m[1].toLowerCase()];
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return { Weekday: wd, Hour: hour, Minute: minute };
}

export function renderPlist({ nodeBin, cliPath, when, home }) {
  const cal = when || { Weekday: 1, Hour: 9, Minute: 0 };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${cliPath}</string>
        <string>digest</string>
        <string>--deliver</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key><integer>${cal.Weekday}</integer>
        <key>Hour</key><integer>${cal.Hour}</integer>
        <key>Minute</key><integer>${cal.Minute}</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENFLOW_HOME</key><string>${home}</string>
    </dict>
    <key>StandardErrorPath</key><string>${home}/digests/schedule.err.log</string>
</dict>
</plist>
`;
}

export function install({ when }) {
  const cal = parseWhen(when);
  if (when && !cal) {
    throw new Error(`could not parse --at "${when}" — expected e.g. "Monday 09:00"`);
  }
  const nodeBin = process.execPath;
  // CLI lives next to this module: src/core/…/schedule.js → ../../bin
  const here = path.dirname(new URL(import.meta.url).pathname);
  const cliPath = path.resolve(here, '..', '..', 'bin', 'tokenflow.js');
  const home = process.env.TOKENFLOW_HOME || path.join(os.homedir(), '.tokenflow');
  ensureDigestDir(home);

  fs.writeFileSync(plistPath(), renderPlist({ nodeBin, cliPath, when: cal, home }));
  execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' });
  execFileSync('launchctl', ['load', plistPath()]);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][(cal || { Weekday: 1 }).Weekday];
  const hh = String((cal || { Hour: 9 }).Hour).padStart(2, '0');
  const mm = String((cal || { Minute: 0 }).Minute).padStart(2, '0');
  return `installed — runs every ${day} at ${hh}:${mm}; digests saved to ${home}/digests/`;
}

export function uninstall() {
  try { execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (fs.existsSync(plistPath())) fs.unlinkSync(plistPath());
  return 'uninstalled';
}

export function status() {
  const installed = fs.existsSync(plistPath());
  let loaded = false;
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    loaded = out.split('\n').some((l) => l.includes(LABEL));
  } catch { /* launchctl unavailable */ }
  const dir = path.join(process.env.TOKENFLOW_HOME || path.join(os.homedir(), '.tokenflow'), 'digests');
  const latest = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().pop() || null
    : null;
  return { installed, loaded, latestDigest: latest ? path.join(dir, latest) : null };
}

function ensureDigestDir(home) {
  const dir = path.join(home, 'digests');
  fs.mkdirSync(dir, { recursive: true });
}

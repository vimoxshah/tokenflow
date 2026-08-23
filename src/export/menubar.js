/**
 * Menu-bar surfaces for external bars (SwiftBar / xbar and compatible).
 *
 * TokenFlow stays zero-dependency and out of your way: rather than shipping an
 * always-running Electron tray, it renders the same live status snapshot into
 * whatever menu bar you already run. One text protocol covers them all —
 * SwiftBar, xbar, Argos, Waybar's custom modules — so this file is pure string
 * shaping over `buildLiveStatus()` output.
 *
 *   line 1            becomes the menu-bar title
 *   "--" prefixed     become dropdown items ("----" alone is a separator)
 *   "| key=value…"    attach actions (href, bash, refresh…)
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { barLine, countdown, compactTokens, money } from '../core/live-status.js';
import { processAlive } from '../core/watch.js';

/** Absolute path of this clone's CLI — stable across working directories. */
export function cliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tokenflow.js');
}

const GLYPH = { ok: '', warn: '⚠ ', exceeded: '✗' };

/**
 * Render the full xbar-format text for a live status snapshot.
 * @param {object} status live status (see core/live-status.js)
 * @param {{mode?:string, dashboardUrl?:string}} opt
 */
export function renderXbar(status, opt = {}) {
  const mode = opt.mode || 'auto';
  const url = opt.dashboardUrl || 'http://127.0.0.1:7799';
  const lines = [];

  const head = barLine(status, mode);
  const empty = head.text.trim().endsWith('—');
  // SwiftBar re-renders on any stdout change; the href makes the whole bar
  // clickable into the dashboard.
  lines.push(head.text + (empty ? '' : ` | href=${url}`));
  if (!status.usage && !status.capacity) {
    lines.push('No data yet — run `tokenflow setup && tokenflow refresh`', `Open docs | href=${url}`);
    return lines.join('\n');
  }
  lines.push('---');

  const u = status.usage?.today || {};
  const t = u.tokens || {};
  lines.push(
    `Today: ${compactTokens(t.total ?? 0)} tokens${costSuffix(u)} · ${u.requests ?? 0} requests | href=${url}`,
  );
  const w = status.usage?.weekToDate || {};
  const m = status.usage?.monthToDate || {};
  lines.push(`Week: ${compactTokens(w.tokens?.total ?? 0)}${costSuffix(w)}`);
  lines.push(`Month: ${compactTokens(m.tokens?.total ?? 0)}${costSuffix(m)}`);
  if (u.sessions != null) lines.push(`Sessions today: ${u.sessions}`);

  // ---- by source / by model -------------------------------------------------
  // Source = the tool that wrote the log (claude-code, opencode, hermes…).
  // Provider rows name each model's vendor, so Hermes traffic appears under
  // its vendors there; "by source" is where Hermes shows as itself.
  const sources = status.sourcesToday || [];
  const models = status.modelsToday || [];
  if (sources.length || models.length) {
    lines.push('---');
    for (const p of sources.slice(0, 6)) {
      lines.push(`source ${p.key}: ${compactTokens(p.tokens ?? 0)}${costSuffix(p)} · ${p.requests ?? 0} req | font-size=12`);
    }
    for (const mrow of models.slice(0, 5)) {
      lines.push(`model ${mrow.key}: ${compactTokens(mrow.tokens ?? 0)}${costSuffix(mrow)} | font-size=12`);
    }
  }

  // ---- limits -------------------------------------------------------------
  const states = status.capacity?.states || [];
  if (states.length) {
    lines.push('---');
    for (const s of states.slice(0, 6)) {
      const pctText = s.pctUsed == null ? '—' : `${Math.round(s.pctUsed * 100)}%`;
      const resetIn = s.resetsInMs != null ? `, resets in ${countdown(s.resetsInMs)}` : '';
      const eta = s.etaHours != null ? ` · ETA ${countdown(s.etaHours * 3600000)}` : '';
      lines.push(`${GLYPH[s.status] || ''}${s.label}: ${pctText}${resetIn}${eta} | font-size=12`);
    }
  }

  // ---- forecast -----------------------------------------------------------
  const f = status.forecast;
  if (f && f.tomorrow !== null && f.confidence) {
    lines.push('---');
    lines.push(`Tomorrow (projected): ${compactTokens(f.tomorrow)} | font-size=12`);
    if (f.monthEnd !== null) lines.push(`Month-end (projected): ${compactTokens(f.monthEnd)} | font-size=12`);
    if (f.monthEndCost !== null) lines.push(`Month-end spend (projected): ${money(f.monthEndCost)} est. | font-size=12`);
    lines.push(`Confidence: ${f.confidence}${f.n ? ` (${f.n}-day trend)` : ''} | font-size=11`);
  }

  // ---- anomalies ----------------------------------------------------------
  const alerts = (status.anomalies || []).filter((a) => a.severity === 'high' || a.severity === 'warn');
  if (alerts.length) {
    lines.push('---');
    for (const a of alerts.slice(0, 3)) {
      lines.push(`${a.severity === 'high' ? '‼️' : '⚠️'} ${a.detail.replace(/\|/g, '/')} | font-size=12`);
    }
  }

  // ---- freshness + actions ------------------------------------------------
  lines.push('---');
  const fr = status.freshness || {};
  const age = fr.ageMs != null ? countdown(fr.ageMs) : null;
  lines.push(
    `${fr.stale ? 'Data stale' : 'Updated'}${age ? ` ${age} ago` : ''} | font-size=11`,
  );
  const watcher = status.watcher;
  const alive = !!(watcher?.pid && processAlive(watcher.pid));
  lines.push(
    alive
      ? `Watcher: running (pid ${watcher.pid}, every ${watcher.intervalSeconds ?? '?'}s) | font-size=11`
      : 'Watcher: not running — `tokenflow watch` | font-size=11',
  );
  lines.push(`Refresh now | bash=/usr/bin/env param1=node param2=${cliPath()} param3=refresh terminal=true refresh=true`);
  lines.push(`Open Dashboard | href=${url}`);
  return lines.join('\n');
}

function costSuffix(slice) {
  const c = slice?.cost ?? slice?.costMeasured;
  return c != null ? ` · ${money(c)}` : '';
}

/**
 * The tiny shell wrapper SwiftBar/xbar execute on their own schedule.
 * Kept minimal on purpose: everything dynamic happens inside Node.
 */
export function swiftBarScript({ nodeBin = 'node', cli = 'bin/tokenflow.js', mode = 'auto', intervalMinutes = 2 } = {}) {
  return `#!/bin/bash
# TokenFlow menu-bar plugin — generated by \`tokenflow menubar --swiftbar\`.
# Refreshes every ${intervalMinutes} min (filename convention). Requires nothing but Node.
export TOKENFLOW_MENUBAR_MODE="${mode}"
exec "${nodeBin}" "${cli}" menubar --render
`;
}

/**
 * Install (or refresh) the plugin into a SwiftBar plugin directory.
 * Returns the written path.
 */
export function installSwiftBarPlugin({ dir, mode = 'auto', intervalMinutes = 2 }) {
  const file = path.join(dir, `tokenflow.${intervalMinutes}m.sh`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, swiftBarScript({
    nodeBin: process.execPath,
    cli: cliPath(),
    mode,
    intervalMinutes,
  }));
  fs.chmodSync(file, 0o755);
  return file;
}

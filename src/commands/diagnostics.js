/**
 * `tokenflow diagnostics` — local observability without telemetry.
 *
 * Everything a support request or a debugging session needs, printed from
 * local state only. Nothing is transmitted; `--out <file>` writes the same
 * content to a file the user can choose to share voluntarily.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, paths } from '../core/config.js';

/**
 * @param {{includePaths?: boolean}} opt
 * @returns {object} diagnostics snapshot (plain JSON-able)
 */
export function collect(opt = {}) {
  const cfg = loadConfig();
  const p = paths();
  const showPaths = !!opt.includePaths;

  const dataDir = p.data;
  const fileStat = (f) => {
    try { const s = fs.statSync(f); return { exists: true, sizeBytes: s.size, modified: s.mtime.toISOString() }; }
    catch { return { exists: false }; }
  };

  return {
    version: process.env.npm_package_version || '1.1.0',
    node: process.version,
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    providers: {
      enabled: cfg.providers.length ? cfg.providers : 'all detected',
      configuredSources: Object.keys(cfg.sources || {}),
    },
    store: {
      records: fileStat(`${dataDir}/cube.json`),
      sessions: fileStat(`${dataDir}/sessions.json`),
      status: fileStat(`${dataDir}/status.json`),
    },
    freshness: (() => {
      try {
        const s = JSON.parse(fs.readFileSync(`${dataDir}/status.json`, 'utf8'));
        return { lastRefresh: s.freshness?.lastRefresh ?? null, stale: s.freshness?.stale ?? null };
      } catch { return { lastRefresh: null, stale: 'unknown' }; }
    })(),
    features: {
      budgetConfigured: !!(cfg.budget?.monthly),
      digestScheduleInstalled: fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'app.tokenflow.digest.plist')),
      promptAnalyticsEnabled: !!cfg.promptAnalytics?.enabled,
      rawPromptCaptureEnabled: !!cfg.promptAnalytics?.storeRaw,
      syncEnabled: !!cfg.sync?.enabled,
      syncDir: cfg.sync?.enabled ? (showPaths ? cfg.sync.dir : '<configured>') : null,
      deliveryChannels: Object.entries(cfg.delivery || {})
        .filter(([, v]) => v && Object.values(v).some(Boolean))
        .map(([k]) => k),
    },
    paths: showPaths
      ? { home: p.root, data: dataDir, config: p.config }
      : undefined,
  };
}

export function renderText(d) {
  const L = [];
  L.push('TokenFlow diagnostics');
  L.push(`  version:   ${d.version}   node: ${d.node}`);
  L.push(`  platform:  ${d.platform}   tz: ${d.timezone}`);
  L.push('');
  L.push('Providers');
  L.push(`  enabled: ${Array.isArray(d.providers.enabled) ? d.providers.enabled.join(', ') : d.providers.enabled}`);
  L.push('');
  L.push('Store');
  for (const [k, v] of Object.entries(d.store)) {
    L.push(`  ${k}: ${v.exists ? `${v.sizeBytes} bytes, modified ${v.modified}` : 'MISSING'}`);
  }
  L.push(`  last refresh: ${d.freshness.lastRefresh || 'never'}${d.freshness.stale === true ? ' (STALE)' : ''}`);
  L.push('');
  L.push('Features');
  L.push(`  budget alerts:     ${d.features.budgetConfigured ? 'configured' : 'not configured'}`);
  L.push(`  digest schedule:   ${d.features.digestScheduleInstalled ? 'installed' : 'not installed'}`);
  L.push(`  prompt analytics:  ${d.features.promptAnalyticsEnabled ? `ON${d.features.rawPromptCaptureEnabled ? ' (+RAW)' : ''}` : 'off'}`);
  L.push(`  sync:              ${d.features.syncEnabled ? `ON → ${d.features.syncDir}` : 'off'}`);
  L.push(`  delivery channels: ${d.features.deliveryChannels.length ? d.features.deliveryChannels.join(', ') : 'none'}`);
  if (d.paths) L.push('', 'Paths', `  home: ${d.paths.home}`, `  data: ${d.paths.data}`, `  config: ${d.paths.config}`);
  return L.join('\n');
}

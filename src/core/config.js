/**
 * Portable configuration.
 *
 *   ~/.tokenflow/
 *     config.yaml        providers, sources, preferences  (config.json also read)
 *     pricing.json       user-defined pricing overrides
 *     mappings/          saved generic-import field mappings
 *     data/              normalized records, cube, sessions, ingest state
 *     cache/             adapter scratch
 *
 * Override the root with TOKENFLOW_HOME. Everything is local; nothing here is
 * ever transmitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseYaml, stringifyYaml } from './yaml.js';

export const CONFIG_VERSION = 1;

/**
 * Where everything lives.
 *
 * `TOKENFLOW_HOME` wins, then `~/.tokenflow`. The two legacy names are still
 * honoured so an install that predates the rename keeps its ingested data
 * instead of silently starting from an empty store — which, with an incremental
 * engine keyed on per-file offsets, would look like "all my history vanished".
 * Legacy is only used when the current location does not exist yet.
 */
export function homeDir() {
  if (process.env.TOKENFLOW_HOME) return process.env.TOKENFLOW_HOME;
  if (process.env.AI_USAGE_HOME) return process.env.AI_USAGE_HOME;
  const current = path.join(os.homedir(), '.tokenflow');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(os.homedir(), '.ai-usage-dashboard');
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

export const paths = () => {
  const root = homeDir();
  return {
    root,
    configYaml: path.join(root, 'config.yaml'),
    configJson: path.join(root, 'config.json'),
    pricing: path.join(root, 'pricing.json'),
    mappings: path.join(root, 'mappings'),
    data: path.join(root, 'data'),
    records: path.join(root, 'data', 'records'),
    cube: path.join(root, 'data', 'cube.json'),
    sessions: path.join(root, 'data', 'sessions.json'),
    activity: path.join(root, 'data', 'activity.json'),
    state: path.join(root, 'data', 'state.json'),
    cache: path.join(root, 'cache'),
    prefs: path.join(root, 'preferences.json'),
  };
};

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  timezone: null, // null = this machine's zone
  identity: { user: null, machine: null, team: null },
  providers: [], // populated by `tokenflow setup` / `provider add`
  sources: {}, // per-provider source options; `{type: auto}` by default
  store: {
    keepRaw: true, // keep request-level records for the Data Explorer + full export
    rawRetentionDays: null, // null = forever
  },
  analytics: {
    includeOverlaySources: false, // proxy/gateway views excluded from totals by default
    minSessionGapMinutes: 30, // used only for sources without a session id
  },
  modelMappings: [], // user rules, prepended to the built-ins
  interfaceOverrides: {}, // { "<client>": "CLI" }
  ui: {
    // Visual theme: skin restyles the chrome, mode flips light/dark. The series
    // colours belong to the mode and are validated per surface, so a skin never
    // changes what a colour means.
    skin: 'aurora', // aurora | terminal | editorial
    mode: 'dark', // dark | light
    theme: 'dark', // legacy single-axis alias, kept for older configs
    // Port the local dashboard binds to (and the port a saved snapshot probes
    // when it looks for a live dashboard to hand over to).
    port: 7799,
    // Which quick range the dashboard opens on: all | 7d | 30d | 90d | mtd
    defaultRange: 'all',
    // Optional hard floor for the default view (YYYY-MM-DD), for when the store
    // holds older records you don't normally want in scope.
    defaultFrom: null,
  },
};

export function loadConfig() {
  const p = paths();
  let cfg = structuredClone(DEFAULT_CONFIG);
  try {
    if (fs.existsSync(p.configYaml)) {
      cfg = merge(cfg, parseYaml(fs.readFileSync(p.configYaml, 'utf8')) || {});
    } else if (fs.existsSync(p.configJson)) {
      cfg = merge(cfg, JSON.parse(fs.readFileSync(p.configJson, 'utf8')));
    }
  } catch (err) {
    const e = /** @type {Error & {hint?:string}} */ (new Error(`Could not read config at ${p.configYaml}: ${err.message}`));
    e.hint = 'Fix the syntax, or delete the file and re-run `tokenflow setup`.';
    throw e;
  }
  return cfg;
}

export function saveConfig(cfg) {
  const p = paths();
  ensureDirs();
  const header = [
    '# tokenflow configuration',
    '# Local-first: nothing in this directory is uploaded anywhere.',
    '# Docs: docs/providers.md   Regenerate: tokenflow setup',
    '',
  ].join('\n');
  fs.writeFileSync(p.configYaml, header + stringifyYaml(cfg) + '\n');
  return p.configYaml;
}

export function ensureDirs() {
  const p = paths();
  for (const d of [p.root, p.data, p.records, p.cache, p.mappings]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

export function loadPrefs() {
  const p = paths();
  try {
    return JSON.parse(fs.readFileSync(p.prefs, 'utf8'));
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  const p = paths();
  ensureDirs();
  fs.writeFileSync(p.prefs, JSON.stringify(prefs, null, 2));
}

/** Deep merge where arrays replace and plain objects merge. */
export function merge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out;
}

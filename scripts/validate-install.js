#!/usr/bin/env node
/**
 * `npm run validate` — a self-check an agent or a new contributor can run to
 * confirm the install is sound before blaming the data.
 *
 * It verifies the runtime, the config directory, every adapter's detect(), the
 * store's internal consistency, and that the analytics layer agrees with the
 * stored facts. It never writes anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import { loadProviders, listProviders } from '../src/core/registry.js';
import { loadConfig, paths } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { buildBundle } from '../src/core/bundle.js';
import { computeView, indexCube, filterCube, sumRows } from '../src/analytics/index.js';
import { validateUsage } from '../src/core/validate.js';
import { decodeRecord } from '../src/core/store.js';

const checks = [];
const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

// ---- runtime ---------------------------------------------------------------
const [maj, min] = process.version.slice(1).split('.').map(Number);
add('Node >= 22.5 (node:sqlite, built-in test runner)', maj > 22 || (maj === 22 && min >= 5), process.version);
let sqliteOk = false;
try {
  const { sqliteAvailable } = await import('../src/core/sqlite.js');
  sqliteOk = sqliteAvailable();
} catch { /* module unavailable on this runtime */ }
add('node:sqlite available (SQLite-backed sources)', sqliteOk, sqliteOk ? '' : 'SQLite adapters will report as unavailable');

// ---- config ----------------------------------------------------------------
const p = paths();
let cfg = null;
try {
  cfg = loadConfig();
  add('config parses', true, p.configYaml);
} catch (err) {
  add('config parses', false, err.message);
}
add('data home writable', canWrite(p.root), p.root);

// ---- adapters --------------------------------------------------------------
await loadProviders();
const provs = listProviders();
add('providers load', provs.length > 0, `${provs.length} registered: ${provs.map((x) => x.id).join(', ')}`);
let detected = 0;
for (const pr of provs) {
  let det;
  try {
    det = await pr.detect({ config: cfg || {}, home: os.homedir() });
    add(`  detect(${pr.id})`, true, det?.available ? `available — ${det.detail || ''}` : `not available — ${det?.detail || ''}`);
    if (det?.available && pr.id !== 'mock') detected++;
  } catch (err) {
    add(`  detect(${pr.id})`, false, err.message);
  }
}
add('at least one real source detected', detected > 0 || !!process.env.TOKENFLOW_DEMO,
  detected ? `${detected} source(s)` : 'none — run `tokenflow demo` or `tokenflow import <file>`');

// ---- store consistency -----------------------------------------------------
const store = new Store();
const cube = store.cube();
const bundle = buildBundle();
add('cube loads', Array.isArray(cube.rows), `${cube.rows.length} rows`);

// ---- live layer ------------------------------------------------------------
try {
  const { normalizeLimits } = await import('../src/analytics/capacity.js');
  const { limits, invalid } = normalizeLimits(cfg?.limits || []);
  add('limits config valid', invalid.length === 0,
    invalid.length ? invalid.map((x) => `${x.id ?? `#${x.index}`}: ${x.errors.join('; ')}`).join(' | ')
      : `${limits.length} limit(s) declared`);
  const statusFile = p.status;
  const st = fs.existsSync(statusFile)
    ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    : null;
  add('live status file readable', st === null || (st && typeof st === 'object' && !!st.schema),
    st === null ? 'not present — run `tokenflow watch` or `watch --once` to create it'
      : `schema ${st.schema}, generatedAt ${st.generatedAt}`);
} catch (err) {
  add('live layer checks', false, err.message);
}

if (cube.rows.length) {
  // Sum the request-level facts and compare with the cube. If these disagree,
  // the aggregates are stale and `tokenflow compact` should be run.
  let recTotal = 0;
  let recCount = 0;
  let invalid = 0;
  store.scanRecords((o) => {
    recCount++;
    const r = decodeRecord(o);
    if (recCount <= 5000 && !validateUsage(r).ok) invalid++;
    for (const k of ['in', 'ou', 'cr', 'cw']) recTotal += o[k] || 0;
  });
  const ix = indexCube(cube);
  const cubeTotal = sumRows(filterCube(ix, { includeOverlay: true }), ix).total;
  const drift = recTotal ? Math.abs(cubeTotal - recTotal) / recTotal : 0;
  add('cube agrees with stored records', drift < 1e-9,
    recCount ? `records ${recTotal.toLocaleString()} vs cube ${cubeTotal.toLocaleString()}${drift ? ` (drift ${(drift * 100).toFixed(4)}% — run "tokenflow compact")` : ''}` : 'no raw records kept');
  add('stored records validate', invalid === 0, invalid ? `${invalid} invalid in the first 5000` : `${Math.min(recCount, 5000)} checked`);

  const v = computeView(bundle, {});
  const seriesTotal = v.daily.reduce((a, d) => a + d.total, 0);
  add('daily series sums to the headline total', seriesTotal === v.totals.total,
    `${seriesTotal.toLocaleString()} vs ${v.totals.total.toLocaleString()}`);
  const dimTotal = v.dimensions.providers.reduce((a, x) => a + x.total, 0);
  add('provider breakdown sums to the headline total', dimTotal === v.totals.total,
    `${dimTotal.toLocaleString()} vs ${v.totals.total.toLocaleString()}`);
  const comp = v.composition.input + v.composition.output + v.composition.cacheRead + v.composition.cacheWrite;
  add('composition is exhaustive and non-overlapping', comp === v.totals.total,
    `${comp.toLocaleString()} vs ${v.totals.total.toLocaleString()}`);
  add('no superseded records pending compaction', (store.state.stale || []).length === 0,
    (store.state.stale || []).length ? `${store.state.stale.length} stale generation(s) — run "tokenflow compact"` : '');
} else {
  add('data present', false, 'no usage ingested yet — run `tokenflow refresh`');
}

// ---- report ----------------------------------------------------------------
const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
console.log('');
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${pad(c.name, 48)} \x1b[2m${c.detail}\x1b[0m`);
}
console.log(`\n  ${failed ? `\x1b[31m${failed} check(s) failed\x1b[0m` : '\x1b[32mall checks passed\x1b[0m'}\n`);
process.exit(failed ? 1 : 0);

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

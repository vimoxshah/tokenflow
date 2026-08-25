#!/usr/bin/env node
/**
 * tokenflow — the CLI.
 *
 * Every command is safe to run repeatedly and never writes outside
 * $TOKENFLOW_HOME (default ~/.tokenflow). Nothing here makes a network
 * request.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadProviders, listProviders, getProvider } from '../src/core/registry.js';
import { loadConfig, saveConfig, paths, ensureDirs, DEFAULT_CONFIG, merge } from '../src/core/config.js';
import { refresh } from '../src/core/ingest.js';
import { buildBundle, queryRecords } from '../src/core/bundle.js';
import { Store, readJson, writeJson } from '../src/core/store.js';
import { computeView } from '../src/analytics/index.js';
import { compact, int, usd, pct, signedPct, longDate, shortDate, relativeTime, humanDuration } from '../src/core/units.js';
import { streamRecordsCsv, exportFilename } from '../src/export/csv.js';
import { buildSnapshot } from '../src/export/html-snapshot.js';
import { startServer } from '../src/server/server.js';
import { validateUsage } from '../src/core/validate.js';
import { MAPPABLE_FIELDS, parseDelimited } from '../src/providers/generic/index.js';
import { stringifyYaml, parseYaml } from '../src/core/yaml.js';
import { PRICING_TABLE_VERSION, PRICING_SOURCES, TIER_MULTIPLIERS, buildPriceBook } from '../src/core/pricing.js';
import {
  buildLiveStatus, currentStatus, readLiveStatus, withComputedFreshness, barLine,
} from '../src/core/live-status.js';
import {
  startWatch, runCycle, stopWatch, watchIsRunning, releaseWatchLock,
} from '../src/core/watch.js';
import { renderXbar, installSwiftBarPlugin } from '../src/export/menubar.js';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', c: '\x1b[36m', mag: '\x1b[35m' }
  : { r: '', b: '', dim: '', g: '', y: '', red: '', c: '', mag: '' };

const argv = process.argv.slice(2);
const cmd = (argv[0] || '').replace(/^-+/, '') || 'status';
const flags = parseFlags(argv.slice(1));

main().catch((err) => {
  console.error(`${C.red}✗ ${err.message}${C.r}`);
  if (err.hint) console.error(`  ${C.dim}${err.hint}${C.r}`);
  if (flags.debug) console.error(err.stack);
  process.exit(1);
});

async function main() {
  if (['help', 'h', '?'].includes(cmd) || flags.help) return help();
  if (cmd === 'version' || flags.version) {
    const pkg = readJson(path.join(root(), 'package.json'), {});
    return console.log(pkg.version || '0.0.0');
  }
  await loadProviders();
  switch (cmd) {
    case 'setup': return cmdSetup();
    case 'providers': return cmdProviders();
    case 'provider': return cmdProvider();
    case 'refresh': return cmdRefresh();
    case 'status': return cmdStatus();
    case 'dashboard': case 'serve': case 'ui': return cmdDashboard();
    case 'up': case 'open': return cmdUp();
    case 'export': return cmdExport();
    case 'pricing': return cmdPricing();
    case 'import': return cmdImport();
    case 'restore': return cmdRestore();
    case 'config': return cmdConfig();
    case 'demo': return cmdDemo();
    case 'validate': return cmdValidate();
    case 'doctor': return cmdDoctor();
    case 'compact': return cmdCompact();
    case 'reset': return cmdReset();
    case 'watch': return cmdWatch();
    case 'usage': return cmdUsage();
    case 'cost': return cmdCost();
    case 'capacity': return cmdCapacity();
    case 'forecast': return cmdForecast();
    case 'menubar': return cmdMenubar();
    case 'digest': return cmdDigest();
    case 'schedule': return cmdSchedule();
    case 'budget': return cmdBudget();
    case 'sync': return cmdSync();
    case 'models-compare': return cmdModelsCompare();
    case 'diagnostics': return cmdDiagnostics();
    case 'team': return cmdTeam();
    default:
      console.error(`${C.red}Unknown command "${cmd}".${C.r}\n`);
      return help(1);
  }
}

// ==================================================================== setup ==

async function cmdSetup() {
  const p = ensureDirs();
  const cfg = loadConfig();
  const ctx = { config: cfg, home: os.homedir() };
  console.log(`\n${C.b}Tokenflow — setup${C.r}`);
  console.log(`${C.dim}config home: ${p.root}${C.r}\n`);

  const detected = [];
  for (const pr of listProviders()) {
    let det;
    try { det = await pr.detect(ctx); } catch (e) { det = { available: false, detail: e.message }; }
    const mark = det.available ? `${C.g}✓${C.r}` : `${C.dim}○${C.r}`;
    console.log(`  ${mark} ${pad(pr.name, 42)} ${C.dim}${det.detail || ''}${C.r}`);
    if (det.available && pr.id !== 'mock') detected.push(pr.id);
  }

  if (!detected.length) {
    console.log(`\n${C.y}No usage sources found on this machine.${C.r}`);
    console.log('  Options:');
    console.log('    · tokenflow demo                 explore with synthetic data');
    console.log('    · tokenflow import <file>        import a CSV/JSON/JSONL/SQLite export');
    console.log('    · docs/providers.md             what each adapter looks for\n');
  }

  cfg.providers = detected;
  cfg.timezone = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  cfg.identity = { user: cfg.identity?.user || os.userInfo().username, machine: cfg.identity?.machine || os.hostname(), team: cfg.identity?.team || null };
  for (const id of detected) if (!cfg.sources[id]) cfg.sources[id] = { type: 'auto' };
  const file = saveConfig(cfg);

  console.log(`\n${C.g}✓${C.r} wrote ${file}`);
  console.log(`  enabled providers: ${detected.length ? detected.join(', ') : '(none)'}`);
  console.log(`  timezone: ${cfg.timezone}\n`);
  console.log(`Next:  ${C.c}tokenflow refresh${C.r}   then   ${C.c}tokenflow dashboard${C.r}\n`);
}

// ================================================================ providers ==

async function cmdProviders() {
  const cfg = loadConfig();
  const ctx = { config: cfg, home: os.homedir() };
  const rows = [];
  for (const pr of listProviders()) {
    let det;
    try { det = await pr.detect(ctx); } catch (e) { det = { available: false, detail: e.message }; }
    const enabled = !cfg.providers.length || cfg.providers.includes(pr.id);
    rows.push({ id: pr.id, name: pr.name, ...pr.getMetadata(), ...det, enabled });
  }
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  console.log('');
  for (const r of rows) {
    const status = !r.available ? `${C.dim}Not detected${C.r}` : r.enabled ? `${C.g}Connected${C.r}` : `${C.y}Detected (disabled)${C.r}`;
    const mark = r.available ? (r.enabled ? `${C.g}✓${C.r}` : `${C.y}!${C.r}`) : `${C.dim}○${C.r}`;
    console.log(`  ${mark} ${pad(r.name, 40)} ${pad(stripAnsi(status), 22)} ${C.dim}${r.detail || ''}${C.r}`.replace(stripAnsi(status), status));
    if (r.measurement !== 'primary') console.log(`      ${C.dim}measurement: ${r.measurement} — ${r.measurement === 'overlay' ? 'excluded from token totals by default' : 'no token counts; activity only'}${C.r}`);
  }
  console.log(`\n  ${C.dim}enable/disable:  tokenflow provider add <id> | tokenflow provider remove <id>${C.r}\n`);
}

async function cmdProvider() {
  const action = argv[1];
  const id = argv[2];
  const cfg = loadConfig();
  if (!['add', 'remove', 'rm', 'list'].includes(action)) {
    throw new Error('usage: tokenflow provider <add|remove|list> [id]');
  }
  if (action === 'list') return cmdProviders();
  if (!id) throw new Error(`usage: tokenflow provider ${action} <id>`);
  if (action === 'add') {
    if (!getProvider(id)) {
      throw Object.assign(new Error(`no provider "${id}"`), { hint: `available: ${listProviders().map((p) => p.id).join(', ')}` });
    }
    if (!cfg.providers.includes(id)) cfg.providers.push(id);
    if (!cfg.sources[id]) cfg.sources[id] = { type: 'auto' };
  } else {
    cfg.providers = cfg.providers.filter((x) => x !== id);
  }
  saveConfig(cfg);
  console.log(`${C.g}✓${C.r} providers: ${cfg.providers.join(', ') || '(none)'}`);
}

// ================================================================== refresh ==

async function cmdRefresh() {
  const t0 = Date.now();
  const providers = flags.provider ? String(flags.provider).split(',') : null;
  const budget = flags.budget ? Number(flags.budget) * 1000 : undefined;
  let lastLine = '';
  const report = await refresh({
    registry: listProviders(),
    providers,
    full: !!flags.full,
    force: !!flags.force,
    strict: !!flags.strict,
    deadlineMs: budget,
    onProgress: (ev) => {
      if (flags.quiet || flags.json) return;
      if (ev.type === 'progress') {
        lastLine = `  ${C.dim}${ev.provider}: ${int(ev.files)} files · ${int(ev.records)} records${C.r}`;
        rewrite(lastLine);
      } else if (ev.type === 'log') {
        rewrite(`  ${C.dim}${ev.message}${C.r}`);
      }
    },
  });
  if (lastLine) rewrite('');
  if (flags.json) return console.log(JSON.stringify(report, null, 2));

  console.log('');
  for (const p of report.providers) {
    const mark = p.status === 'ok' ? `${C.g}✓${C.r}` : p.status === 'not-detected' ? `${C.dim}○${C.r}` : p.status === 'partial' ? `${C.y}◐${C.r}` : `${C.red}✗${C.r}`;
    const detail = p.status === 'not-detected'
      ? `${C.dim}${p.detail || 'not detected'}${C.r}`
      : `${int(p.records)} new records · ${int(p.processed ?? 0)} files read, ${int(p.skipped)} unchanged`
        + (p.files ? ` of ${int(p.files)} found` : '') + ` · ${bytes(p.bytes)}`;
    console.log(`  ${mark} ${pad(p.id, 12)} ${detail}`);
    for (const n of p.notes.slice(0, 3)) console.log(`      ${C.y}${n}${C.r}`);
    if (p.notes.length > 3) console.log(`      ${C.dim}…${p.notes.length - 3} more notes${C.r}`);
  }
  console.log(`\n  ${C.b}${int(report.newRecords)}${C.r} new records · ${bytes(report.bytesRead)} read · ${int(report.filesSkipped)} files skipped as unchanged · ${humanDuration(Date.now() - t0)}`);
  if (report.malformed) console.log(`  ${C.y}${int(report.malformed)} malformed lines skipped${C.r}`);
  if (report.invalid.length) {
    console.log(`  ${C.red}${report.invalid.length} records failed validation:${C.r}`);
    for (const v of report.invalid.slice(0, 5)) console.log(`      ${v.source} ${v.id}: ${v.errors[0]}`);
  }
  if (report.rebuilt) {
    console.log(`  ${C.dim}rebuilt aggregates from ${int(report.rebuilt.records)} stored records; dropped ${int(report.rebuilt.dropped || 0)} superseded${C.r}`);
  }
  if (!report.done) console.log(`  ${C.y}◐ time budget reached — run 'tokenflow refresh' again to continue${C.r}`);
  console.log('');
}

// =================================================================== status ==

async function cmdStatus() {
  // Menu-bar / wrapper fast path: one compact line from the live snapshot,
  // without building a full analytics view.
  if (flags.bar) {
    const st = await liveStatus();
    const line = barLine(st, String(flags.mode || 'auto'), String(flags.prefix || 'TF'));
    return console.log(flags.json ? JSON.stringify(line, null, 2) : line.text);
  }
  const b = buildBundle();
  if (flags.json) return console.log(JSON.stringify({ meta: b.meta, health: b.health }, null, 2));
  const h = b.health;
  if (!h.records) {
    console.log(`\n  ${C.y}No usage data yet.${C.r}`);
    console.log(`  Run ${C.c}tokenflow setup${C.r} then ${C.c}tokenflow refresh${C.r}, or ${C.c}tokenflow demo${C.r} to try it with synthetic data.\n`);
    return;
  }
  const v = computeView(b, {});
  console.log(`\n  ${C.b}Tokenflow${C.r}${b.meta.demo ? `  ${C.red}[CONTAINS DEMO DATA]${C.r}` : ''}\n`);
  const row = (k, val) => console.log(`  ${pad(k, 16)} ${val}`);
  row('Records:', int(h.records));
  row('Providers:', `${h.providers}  ${C.dim}${v.dimensions.providers.slice(0, 4).map((p) => p.key).join(', ')}${C.r}`);
  row('Models:', `${h.models}  ${C.dim}${v.dimensions.models.slice(0, 3).map((m) => m.key).join(', ')}${C.r}`);
  row('Date Range:', `${longDate(h.coverage.from)} → ${longDate(h.coverage.to)}`);
  row('Total tokens:', `${compact(v.totals.total)}  ${C.dim}(${int(v.totals.total)})${C.r}`);
  row('  input', `${compact(v.totals.in)}  ${pct(v.composition.shares.input)}`);
  row('  output', `${compact(v.totals.out)}  ${pct(v.composition.shares.output)}`);
  row('  cache', `${compact(v.totals.cr + v.totals.cw)}  ${pct(v.composition.shares.cache)}`);
  row('Sessions:', int(h.sessions));
  row('Active days:', `${v.averages.activeDays} of ${v.daily.length}`);
  row('Avg / day:', compact(v.averages.perActiveDay));
  row('Peak day:', v.peaks.peakDay ? `${compact(v.peaks.peakDay.total)}  ${longDate(v.peaks.peakDay.date)}` : '—');
  row('Est. cost:', v.cost.estimated === null
    ? `${C.dim}not available (no configured pricing)${C.r}`
    : `${usd(v.cost.estimated)} ${C.dim}est. · covers ${pct(v.cost.coverage)} of requests${C.r}`);
  if (v.cost.measured !== null) {
    row('Measured cost:', `${usd(v.cost.measured)} ${C.dim}reported by the source/gateway itself${C.r}`);
  }
  row('Last Refresh:', relativeTime(h.lastRefresh));
  const gradeColor = h.grade === 'Excellent' ? C.g : h.grade === 'Good' ? C.c : C.y;
  row('Data Health:', `${gradeColor}${h.grade}${C.r} ${C.dim}· ${pct(h.missingTokenFieldRate)} of token fields unreported by source${C.r}`);
  console.log('');
  if (v.insights.length) {
    console.log(`  ${C.b}Insights${C.r}`);
    for (const i of v.insights.slice(0, 6)) console.log(`   ${i.icon} ${wrap(i.text, 92, 6)}`);
    console.log('');
  }
  if (v.cost.unpriced.length) {
    console.log(`  ${C.dim}${v.cost.unpriced.length} model(s) have no configured price. Run 'tokenflow pricing' to add rates.${C.r}\n`);
  }
}

// ================================================================ dashboard ==

async function cmdDashboard() {
  const port = Number(flags.port) || 7799;
  const host = flags.host || '127.0.0.1';
  const b = buildBundle();
  const s = await startServer({ port, host, token: flags.token === false ? false : undefined });
  console.log(`\n  ${C.b}Tokenflow${C.r}`);
  console.log(`  ${C.c}${s.url}${C.r}`);
  console.log(`  ${C.dim}${int(b.health.records)} records · ${b.health.coverage.from ? `${shortDate(b.health.coverage.from)} → ${shortDate(b.health.coverage.to)}` : 'no data'} · loopback only, nothing leaves this machine${C.r}`);
  if (!b.health.records) console.log(`  ${C.y}No data yet — click ↻ Refresh in the dashboard, or run 'tokenflow refresh'.${C.r}`);
  console.log(`  ${C.dim}Ctrl+C to stop${C.r}\n`);
  if (flags.open !== false && flags['no-open'] !== true) tryOpen(s.url);
  await new Promise(() => {});
}

/**
 * The "I just want to look at it" command: bring the data up to date, refresh
 * the offline snapshot beside it, then serve and open the live dashboard.
 *
 * Refresh is time-budgeted and resumable, so this loops until the engine
 * reports done instead of assuming one pass is enough — a first run over a
 * multi-gigabyte log directory legitimately takes several passes.
 */
async function cmdUp() {
  const budget = Number(flags.budget) || 60;
  const maxPasses = Number(flags.passes) || 20;
  let pass = 0;
  let total = 0;
  if (flags.refresh !== false && flags['no-refresh'] !== true) {
    for (;;) {
      pass++;
      const report = await refresh({
        registry: listProviders(),
        deadlineMs: budget * 1000,
        onProgress: (ev) => {
          if (ev.type === 'progress') rewrite(`  ${C.dim}pass ${pass}: ${int(ev.files)} files · ${int(ev.records)} records${C.r}`);
        },
      });
      total += report.newRecords;
      rewrite('');
      const unreachable = report.providers.filter((x) => x.status === 'error' || x.status === 'detect-error');
      for (const u of unreachable) console.log(`  ${C.y}! ${u.id}: ${u.notes[0] || 'failed'}${C.r}`);
      if (report.done) break;
      if (pass >= maxPasses) {
        console.log(`  ${C.y}◐ stopped after ${pass} passes — run 'tokenflow refresh' again to finish the backlog${C.r}`);
        break;
      }
    }
    console.log(`  ${C.g}✓${C.r} data current ${C.dim}(${int(total)} new record(s) in ${pass} pass(es))${C.r}`);
  }

  // Keep the offline copy next to the live one: whoever opens the .html file
  // later gets the same numbers, and its freshness bar has something recent
  // to report.
  if (flags.snapshot !== false && flags['no-snapshot'] !== true) {
    const file = path.join(process.cwd(), typeof flags.snapshot === 'string' ? flags.snapshot : 'tokenflow-dashboard.html');
    try {
      const { html, stats } = buildSnapshot({ maxRecords: Number(flags.maxRecords) || 20000 });
      fs.writeFileSync(file, html);
      console.log(`  ${C.g}✓${C.r} offline snapshot refreshed ${C.dim}${file} · ${bytes(stats.bytes)}${C.r}`);
    } catch (err) {
      console.log(`  ${C.y}! snapshot skipped: ${err.message}${C.r}`);
    }
  }

  if (flags.serve === false || flags['no-serve'] === true) {
    console.log(`  ${C.dim}not serving (--no-serve). Open the offline file, or run 'tokenflow dashboard'.${C.r}\n`);
    return undefined;
  }
  return cmdDashboard();
}

function tryOpen(url) {
  const cmds = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  import('node:child_process').then(({ spawn }) => {
    try {
      spawn(cmds[0], [...cmds.slice(1), url], { stdio: 'ignore', detached: true }).unref();
    } catch { /* headless: the URL is printed above */ }
  });
}

// =================================================================== export ==

async function cmdExport() {
  const outDir = flags.out ? String(flags.out) : process.cwd();
  if (flags.html !== undefined) {
    const file = typeof flags.html === 'string' ? flags.html : path.join(outDir, exportFilename('tokenflow', new Date(), 'html'));
    const { html, stats } = buildSnapshot({ maxRecords: Number(flags.maxRecords) || 20000 });
    fs.writeFileSync(file, html);
    console.log(`${C.g}✓${C.r} ${file}  ${C.dim}${bytes(stats.bytes)} · ${int(stats.cubeRows)} cube rows · ${int(stats.records)} records${stats.recordsTruncated ? ' (capped)' : ''} · fully offline${C.r}`);
    return;
  }
  const file = typeof flags.csv === 'string' ? flags.csv : path.join(outDir, exportFilename());
  const filter = flags.all ? {} : {
    from: flags.from || null, to: flags.to || null,
    provider: flags.provider, model: flags.model, client: flags.client,
    interface: flags.interface, project: flags.project,
  };
  const fd = fs.openSync(file, 'w');
  let n = 0;
  try {
    n = streamRecordsCsv((chunk) => fs.writeSync(fd, chunk), filter);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`${C.g}✓${C.r} ${file}  ${C.dim}${int(n)} records${flags.all ? ' (all data)' : ' (current filter)'}${C.r}`);
}

// ================================================================== pricing ==

async function cmdPricing() {
  const p = paths();
  const cur = readJson(p.pricing, { models: {} });
  if (flags.set) {
    // --set "claude-opus-5=15,75,1.5,18.75"  (input,output,cacheRead,cacheWrite)
    for (const spec of [].concat(flags.set)) {
      const [model, csv] = String(spec).split('=');
      if (!model || !csv) throw new Error('usage: --set "<model>=<input>,<output>[,<cacheRead>[,<cacheWrite>]]"');
      const [i, o, cr, cw] = csv.split(',').map((x) => (x === '' ? null : Number(x)));
      cur.models = cur.models || {};
      cur.models[model] = { in: i, out: o, ...(cr !== undefined && cr !== null ? { cacheRead: cr } : {}), ...(cw !== undefined && cw !== null ? { cacheWrite: cw } : {}) };
      console.log(`${C.g}✓${C.r} ${model}: $${i}/1M in, $${o}/1M out${cr ? `, $${cr} cache read` : ''}${cw ? `, $${cw} cache write` : ''}`);
    }
    cur.updatedAt = new Date().toISOString();
    writeJson(p.pricing, cur);
    console.log(`${C.dim}saved to ${p.pricing} — run 'tokenflow refresh --full' to re-cost history${C.r}`);
    return;
  }
  if (flags.unset) {
    delete (cur.models || {})[String(flags.unset)];
    writeJson(p.pricing, cur);
    return console.log(`${C.g}✓${C.r} removed ${flags.unset}`);
  }
  if (flags.sources) {
    console.log(`\n  ${C.b}Where the built-in rates come from${C.r}  ${C.dim}table ${PRICING_TABLE_VERSION}${C.r}\n`);
    for (const [key, src] of Object.entries(PRICING_SOURCES)) {
      const tag = src.confidence === 'official' ? `${C.g}official${C.r}`
        : src.confidence === 'third-party' ? `${C.y}third-party${C.r}` : `${C.c}official (historical)${C.r}`;
      console.log(`  ${pad(key, 20)} ${tag}  ${C.dim}fetched ${src.fetched}${C.r}`);
      console.log(`  ${' '.repeat(20)} ${C.dim}${src.url}${C.r}`);
      if (src.note) console.log(`  ${' '.repeat(20)} ${C.y}${wrap(src.note, 76, 22)}${C.r}`);
    }
    console.log(`\n  ${C.b}Service-tier multipliers${C.r}  ${C.dim}applied per request from metadata.service_tier${C.r}`);
    for (const [prov, tiers] of Object.entries(TIER_MULTIPLIERS)) {
      const shown = Object.entries(tiers).filter(([, v]) => v !== 1).map(([k, v]) => `${k}=${v}x`);
      console.log(`  ${pad(prov, 20)} ${shown.length ? shown.join('  ') : C.dim + 'all tiers 1x' + C.r}`);
    }
    console.log(`\n  ${C.y}Not applied:${C.r} long-context premium tiers (Anthropic >200K, OpenAI long-context).`);
    console.log(`  ${C.dim}They need a per-request prompt size plus a per-model threshold and premium, which`);
    console.log(`  are not uniformly published. A long-context-heavy workload is therefore UNDER-estimated.${C.r}\n`);
    return;
  }

  const b = buildBundle();
  const v = computeView(b, {});
  const book = buildPriceBook(readJson(p.pricing, {}));
  console.log(`\n  ${C.b}Pricing${C.r}  ${C.dim}built-in table ${PRICING_TABLE_VERSION} · overrides in ${p.pricing}${C.r}\n`);
  console.log(`  ${pad('MODEL', 30)} ${pad('TOKENS', 9)} ${pad('EST. COST', 12)} ${pad('$/1M', 9)} SOURCE`);
  for (const m of v.dimensions.models) {
    const entry = book.lookup(m.key, m.provider || undefined) || book.lookup(m.key, 'unknown');
    const ok = m.cost !== null;
    const per1m = ok && m.total ? usd(m.cost / (m.total / 1e6)) : '—';
    const src = entry ? (entry.origin === 'user' ? `${C.c}your override${C.r}` : `${C.dim}${entry.src}${C.r}`) : `${C.y}unpriced${C.r}`;
    console.log(`  ${pad(m.key, 30)} ${pad(compact(m.total), 9)} ${pad(ok ? usd(m.cost) : '—', 12)} ${pad(per1m, 9)} ${src}`);
  }
  console.log(`\n  ${C.dim}provenance:  tokenflow pricing --sources${C.r}`);
  console.log(`  ${C.dim}add a rate:  tokenflow pricing --set "<model>=<input$/1M>,<output$/1M>[,<cacheRead>[,<cacheWrite>]]"${C.r}`);
  console.log(`  ${C.dim}or use the Pricing dialog in the dashboard.${C.r}\n`);
}

// =================================================================== import ==

async function cmdImport() {
  const file = argv[1];
  if (!file) {
    console.log(`\n  ${C.b}Generic import${C.r}`);
    console.log('  usage: tokenflow import <file> [--name <mapping>] [--format csv|tsv|json|jsonl|sqlite] [--table t]');
    console.log('                            [--field <schemaField>=<sourceColumn>]... [--default <field>=<value>]...');
    console.log('                            [--timestamp-format iso|epoch_ms|epoch_s] [--dry-run]\n');
    console.log(`  mappable fields: ${C.dim}${MAPPABLE_FIELDS.join(', ')}${C.r}`);
    console.log(`  ${C.dim}A mapping is saved to ${paths().mappings}/<name>.json and reused on every later refresh.${C.r}\n`);
    return;
  }
  const abs = path.resolve(file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  const name = String(flags.name || path.basename(abs).replace(/\.[^.]+$/, '')).replace(/[^\w.-]/g, '_');
  const fields = {};
  for (const f of [].concat(flags.field || [])) {
    const [k, v] = String(f).split('=');
    if (!MAPPABLE_FIELDS.includes(k)) throw new Error(`"${k}" is not a mappable field. Options: ${MAPPABLE_FIELDS.join(', ')}`);
    fields[k] = v;
  }
  const defaults = {};
  for (const d of [].concat(flags.default || [])) {
    const [k, v] = String(d).split('=');
    defaults[k] = v;
  }

  // Suggest a mapping from the header row when the user gave none.
  if (!Object.keys(fields).length) {
    const cols = sniffColumns(abs, flags.format);
    console.log(`\n  ${C.b}Columns found${C.r}: ${cols.join(', ') || '(none)'}\n`);
    const guess = guessMapping(cols);
    for (const [k, v] of Object.entries(guess)) console.log(`  ${C.dim}--field ${k}=${v}${C.r}`);
    if (!Object.keys(guess).length) {
      throw Object.assign(new Error('could not infer a mapping'), { hint: 'pass --field <schemaField>=<column> for at least timestamp and the token fields' });
    }
    Object.assign(fields, guess);
    console.log(`\n  ${C.y}Using the inferred mapping above.${C.r} Re-run with explicit --field flags to change it.\n`);
  }
  if (!fields.timestamp) throw new Error('a timestamp field is required (--field timestamp=<column>)');

  const mapping = {
    name,
    format: flags.format || undefined,
    files: [abs],
    table: flags.table || undefined,
    query: flags.query || undefined,
    timestampFormat: flags['timestamp-format'] || undefined,
    fields,
    defaults,
  };

  const gen = getProvider('generic');
  const sample = sniffRows(abs, flags.format, 5).map((r) => gen.normalize(r, mapping));
  console.log(`  ${C.b}Preview${C.r} (${sample.length} rows)`);
  for (const s of sample) {
    if (!s) { console.log(`   ${C.red}row skipped: unparseable timestamp${C.r}`); continue; }
    console.log(`   ${s.timestamp}  ${pad(String(s.model), 24)} in=${fmtNull(s.input_tokens)} out=${fmtNull(s.output_tokens)} cacheR=${fmtNull(s.cache_read_tokens)}`);
  }
  console.log(`  ${C.dim}"n/a" means the mapping leaves that field unset — it is stored as not-available, never as 0.${C.r}`);
  if (flags['dry-run']) return console.log(`\n  ${C.y}dry run — nothing saved${C.r}\n`);

  ensureDirs();
  const dest = path.join(paths().mappings, `${name}.json`);
  writeJson(dest, mapping);
  const cfg = loadConfig();
  if (!cfg.providers.includes('generic')) { cfg.providers.push('generic'); saveConfig(cfg); }
  console.log(`\n${C.g}✓${C.r} saved mapping ${dest}`);
  console.log(`  running refresh for the generic provider…\n`);
  argv[0] = 'refresh';
  flags.provider = 'generic';
  await cmdRefresh();
}

function fmtNull(v) {
  return v === null || v === undefined ? `${C.dim}n/a${C.r}` : String(v);
}

function sniffColumns(file, fmt) {
  const rows = sniffRows(file, fmt, 1);
  return rows.length ? Object.keys(rows[0]) : [];
}

function sniffRows(file, fmt, n) {
  const ext = (fmt || path.extname(file).slice(1)).toLowerCase();
  if (ext === 'jsonl' || ext === 'ndjson') {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  }
  if (ext === 'json') {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(d) ? d : (d.records || d.data || d.usage || []);
    return arr.slice(0, n);
  }
  if (ext === 'db' || ext === 'sqlite' || ext === 'sqlite3') {
    return [];
  }
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, n + 1).join('\n');
  return parseDelimited(head, ext === 'tsv' ? '\t' : ',').slice(0, n);
}

function guessMapping(cols) {
  const pick = (...pats) => cols.find((c) => pats.some((p) => new RegExp(p, 'i').test(c)));
  const out = {};
  const put = (k, v) => { if (v) out[k] = v; };
  put('timestamp', pick('^(timestamp|ts|created_?at|date_?time|time)$', 'timestamp', 'created'));
  put('model', pick('^model', 'model'));
  put('provider', pick('^provider$', 'vendor'));
  put('input_tokens', pick('^(input|prompt)_?tokens$', 'prompt_tokens', 'input_tokens'));
  put('output_tokens', pick('^(output|completion|generated)_?tokens$', 'completion_tokens'));
  put('cache_read_tokens', pick('cache_?read', 'cached_?(input_?)?tokens', 'cache_?hit'));
  put('cache_write_tokens', pick('cache_?(write|creation)'));
  put('reasoning_tokens', pick('reasoning', 'thinking'));
  put('estimated_cost', pick('^cost', 'cost_usd', 'total_cost', 'amount'));
  put('session_id', pick('session', 'conversation_?id', 'generation_?id', '^id$'));
  put('project', pick('^project', 'repo'));
  put('client', pick('^client$', '^app$', 'application'));
  return out;
}

// =================================================================== config ==

async function cmdConfig() {
  const action = argv[1] || 'show';
  const p = paths();
  if (action === 'path') return console.log(p.root);
  if (action === 'show') {
    return console.log(stringifyYaml(loadConfig()));
  }
  if (action === 'export') {
    const dest = argv[2] || path.join(process.cwd(), `tokenflow-config-${new Date().toISOString().slice(0, 10)}.json`);
    const payload = {
      exportedAt: new Date().toISOString(),
      config: loadConfig(),
      pricing: readJson(p.pricing, {}),
      mappings: Object.fromEntries((safeReaddir(p.mappings)).map((f) => [f, readJson(path.join(p.mappings, f), null)])),
    };
    writeJson(dest, payload);
    return console.log(`${C.g}✓${C.r} ${dest}  ${C.dim}(config + pricing + import mappings; no usage data)${C.r}`);
  }
  if (action === 'import') {
    const src = argv[2];
    if (!src) throw new Error('usage: tokenflow config import <file>');
    const d = readJson(path.resolve(src), null);
    if (!d || !d.config) throw new Error('not a config export');
    ensureDirs();
    saveConfig(merge(DEFAULT_CONFIG, d.config));
    if (d.pricing) writeJson(p.pricing, d.pricing);
    for (const [name, m] of Object.entries(d.mappings || {})) if (m) writeJson(path.join(p.mappings, name), m);
    return console.log(`${C.g}✓${C.r} imported config, pricing and ${Object.keys(d.mappings || {}).length} mapping(s) into ${p.root}`);
  }
  throw new Error('usage: tokenflow config <show|path|export|import>');
}

function safeReaddir(d) {
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { return []; }
}

// ===================================================================== demo ==

async function cmdDemo() {
  // Synthetic data must never mix into a real store: `demo` used to overwrite
  // ~/.tokenflow/config.yaml with providers:['mock'] and ingest demo records
  // into whatever home was active. An explicit $TOKENFLOW_HOME wins (scripted
  // setups that want exactly that); otherwise a throwaway home under tmpdir()
  // is created for this run, leaving the default store untouched.
  if (!process.env.TOKENFLOW_HOME) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenflow-demo-'));
    process.env.TOKENFLOW_HOME = sandbox;
    console.log(`\n  ${C.dim}sandboxed demo store: ${sandbox}`);
    console.log(`  reopen later with:   TOKENFLOW_HOME=${sandbox} tokenflow dashboard${C.r}`);
  }
  process.env.TOKENFLOW_DEMO = '1';
  const cfg = loadConfig();
  cfg.providers = ['mock'];
  cfg.sources.mock = { days: Number(flags.days) || 160, seed: Number(flags.seed) || 20260814 };
  saveConfig(cfg);
  console.log(`\n  ${C.red}Generating SYNTHETIC DEMO DATA${C.r} ${C.dim}(clearly labelled everywhere in the UI)${C.r}\n`);
  argv[0] = 'refresh';
  flags.full = true;
  flags.provider = 'mock';
  await cmdRefresh();
  // `--no-serve` / `--no-dashboard` keep this non-interactive, which is what CI
  // and scripted setups need.
  if (flags.dashboard !== false && flags['no-dashboard'] !== true && flags.serve !== false && flags['no-serve'] !== true) {
    flags.port = flags.port || 7799;
    await cmdDashboard();
  } else {
    console.log(`  Next: ${C.c}tokenflow dashboard${C.r}\n`);
  }
}

// ================================================================= validate ==

async function cmdValidate() {
  const store = new Store();
  let n = 0;
  let bad = 0;
  const errors = new Map();
  const { decodeRecord } = await import('../src/core/store.js');
  store.scanRecords((o) => {
    n++;
    const r = decodeRecord(o);
    const v = validateUsage(r);
    if (!v.ok) {
      bad++;
      for (const e of v.errors) errors.set(e, (errors.get(e) || 0) + 1);
    }
  });
  console.log(`\n  checked ${int(n)} records · ${bad ? `${C.red}${int(bad)} invalid${C.r}` : `${C.g}all valid${C.r}`}`);
  for (const [e, c] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${C.y}${int(c)}×${C.r} ${e}`);
  console.log('');
  if (bad) process.exitCode = 1;
}

// =================================================================== doctor ==

async function cmdDoctor() {
  const p = paths();
  const cfg = loadConfig();
  console.log(`\n  ${C.b}Environment${C.r}`);
  console.log(`   node          ${process.version} ${major() >= 22 ? `${C.g}ok${C.r}` : `${C.red}needs >= 22.5${C.r}`}`);
  let sqliteOk = false;
  try { const { sqliteAvailable } = await import('../src/core/sqlite.js'); sqliteOk = sqliteAvailable(); } catch { /* unavailable */ }
  console.log(`   node:sqlite   ${sqliteOk ? `${C.g}available${C.r}` : `${C.y}unavailable — SQLite sources will be skipped${C.r}`}`);
  console.log(`   platform      ${process.platform}/${process.arch}`);
  console.log(`   timezone      ${cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log(`\n  ${C.b}Paths${C.r}`);
  for (const [k, v] of Object.entries(p)) {
    const exists = fs.existsSync(v);
    console.log(`   ${pad(k, 12)} ${exists ? `${C.g}✓${C.r}` : `${C.dim}·${C.r}`} ${v}`);
  }
  const store = new Store();
  const shards = store.listShards();
  let raw = 0;
  for (const s of shards) { try { raw += fs.statSync(path.join(p.records, s)).size; } catch { /* gone */ } }
  console.log(`\n  ${C.b}Store${C.r}`);
  console.log(`   shards        ${shards.length} (${bytes(raw)} of request-level records)`);
  console.log(`   cube          ${int(store.cube().rows.length)} rows`);
  console.log(`   sessions      ${int(Object.keys(store.sessions().rows).length)}`);
  console.log(`   stale gens    ${(store.state.stale || []).length}${(store.state.stale || []).length ? `  ${C.y}run 'tokenflow compact'${C.r}` : ''}`);
  console.log(`\n  ${C.b}Providers${C.r}`);
  await cmdProviders();
  console.log(`  ${C.dim}Troubleshooting guide: docs/troubleshooting.md${C.r}\n`);
}

function major() {
  return Number(process.version.slice(1).split('.')[0]) + Number(process.version.slice(1).split('.')[1]) / 100;
}

// ================================================================== compact ==

async function cmdCompact() {
  const { compactShards } = await import('../src/core/store.js');
  const { rebuildAggregates } = await import('../src/core/ingest.js');
  const store = new Store();
  const stale = store.staleSet().size;
  if (!stale && !flags.recount) {
    console.log(`  ${C.g}nothing to compact${C.r} — no superseded records.`);
    console.log(`  ${C.dim}pass --recount to rebuild the aggregates and re-derive the record counts anyway.${C.r}`);
    return;
  }
  if (stale) {
    const res = compactShards(store);
    console.log(`  ${C.g}✓${C.r} compacted ${res.shards} shard(s): kept ${int(res.kept)}, dropped ${int(res.dropped)}.`);
  }
  const before = store.state.counters?.records || 0;
  const rb = rebuildAggregates(store);
  // Counts are derived from the records that actually survived, so a store that
  // has been restored, re-ingested or compacted stops reporting a lifetime
  // total in place of its real size.
  store.state.counters.records = rb.records;
  for (const id of Object.keys(store.state.sources)) store.state.sources[id].records = rb.bySource[id] || 0;
  store.saveCube();
  store.saveSessions();
  store.saveActivity();
  store.saveState();
  console.log(`  ${C.g}✓${C.r} rebuilt aggregates from ${int(rb.records)} records.`);
  if (before !== rb.records) console.log(`  ${C.g}✓${C.r} re-derived record counts ${C.dim}(state said ${int(before)}, the store holds ${int(rb.records)})${C.r}`);
  for (const [id, n] of Object.entries(rb.bySource).sort((a, b) => b[1] - a[1])) console.log(`      ${id.padEnd(12)} ${int(n).padStart(9)}`);
}

async function cmdRestore() {
  const file = argv[1] && !argv[1].startsWith('-') ? argv[1] : (typeof flags.file === 'string' ? flags.file : null);
  if (!file) {
    throw Object.assign(new Error('usage: tokenflow restore <full-export.csv>'), {
      hint: 'Rebuilds the store from a `tokenflow export --csv --all` file and re-prices every estimate with the current table.',
    });
  }
  const store = new Store();
  const held = store.state.counters?.records || 0;
  if (held > 0 && !flags.yes) {
    throw Object.assign(new Error(`this replaces the ${int(held)} record(s) already in the store`), {
      hint: 'A restore is a whole-dataset operation, not an increment. Re-run with --yes to confirm.',
    });
  }
  const { restoreFromCsv } = await import('../src/core/restore.js');
  console.log(`\n  restoring from ${C.b}${file}${C.r}${flags['no-reprice'] ? '' : ' · re-pricing estimates with the current table'}`);
  const r = restoreFromCsv(path.resolve(file), {
    reprice: !flags['no-reprice'],
    onProgress: (e) => {
      if (e.type === 'progress') process.stdout.write(`\r  ${C.dim}${int(e.records)} records…${C.r}`);
    },
  });
  process.stdout.write('\r\x1b[K');
  console.log(`  ${C.g}✓${C.r} ${int(r.records)} records restored ${C.dim}in ${(r.durationMs / 1000).toFixed(1)}s${C.r}`);
  for (const [id, n] of Object.entries(r.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${id.padEnd(12)} ${int(n).padStart(9)}`);
  }
  console.log(`  ${C.dim}re-priced ${int(r.repriced)} · measured costs kept ${int(r.measuredKept)} · no price found ${int(r.unpriced)} · table ${r.pricingVersion}${C.r}`);
  if (r.malformed || r.dropped.noTimestamp || r.dropped.noDate) {
    console.log(`  ${C.y}!${C.r} skipped ${int(r.malformed)} malformed row(s), ${int(r.dropped.noTimestamp + r.dropped.noDate)} row(s) without a usable timestamp`);
  }
  console.log(`  ${C.dim}Per-record metadata (working directory, audit trail) is not part of a CSV export and is not restored.${C.r}`);
  console.log(`  ${C.dim}Restored records are provisional: a refresh that reaches a source's real logs supersedes them automatically.${C.r}\n`);
}

async function cmdReset() {
  if (!flags.yes) {
    throw Object.assign(new Error('this deletes all ingested data'), { hint: `re-run with --yes to confirm. Config and pricing are kept. Data home: ${paths().root}` });
  }
  const p = paths();
  fs.rmSync(p.data, { recursive: true, force: true });
  ensureDirs();
  console.log(`${C.g}✓${C.r} cleared ${p.data} (config and pricing kept)`);
}

// ==================================================================== live ==

/** Fast path for live commands: watch snapshot when fresh, else compute now. */
async function liveStatus() {
  const { status } = currentStatus();
  return status;
}

/**
 * `tokenflow watch` — keep the store + status file current in the background.
 *
 *   --interval <s>  seconds between cycles (config: watch.intervalSeconds)
 *   --once          one refresh+status cycle and exit (cron-friendly)
 *   --notify        OS notifications on threshold crossings (also: config)
 *   --status        is a watcher running? how fresh is it?
 *   --stop          stop a running watcher
 */
async function cmdWatch() {
  if (flags.stop) {
    const r = stopWatch();
    console.log(r.stopped ? `${C.g}✓${C.r} stopped watcher ${C.dim}(pid ${r.pid})${C.r}` : `${C.dim}○ ${r.reason}${C.r}`);
    return;
  }
  if (flags.status) {
    const running = watchIsRunning();
    const st = readLiveStatus();
    console.log(`  watcher   ${running ? `${C.g}running${C.r}` : `${C.dim}not running${C.r}`}`);
    // Identity lines only describe a live process — a dead watcher's leftovers
    // are history, not status.
    if (running && st?.watcher?.pid != null) {
      console.log(`  pid       ${st.watcher.pid} · every ${st.watcher.intervalSeconds ?? '?'}s · ${int(st.watcher.cycles)} cycle(s)`);
    }
    const lastErr = st?.lastError;
    if (lastErr) console.log(`  ${C.y}last error${C.r} ${relativeTime(lastErr.at)}: ${lastErr.message}`);
    if (st?.freshness) {
      const fresh = withComputedFreshness(st).freshness;
      console.log(`  data      ${fresh.stale ? `${C.y}stale${C.r}` : `${C.g}fresh${C.r}`} ${st.freshness.lastRefresh ? `· updated ${relativeTime(st.freshness.lastRefresh)}` : '(never refreshed)'}`);
      console.log(`  status    ${paths().status}`);
    }
    if (!running && !flags.json) {
      console.log(`\n  ${C.dim}start one:  tokenflow watch${C.r}`);
    }
    return;
  }

  const cfg = loadConfig();
  const interval = Number(flags.interval) || cfg.watch?.intervalSeconds || 120;
  const notifyOn = flags.notify === true || !!cfg.watch?.notifications;

  if (flags.once) {
    const r = await runCycle({ config: cfg, notifications: notifyOn });
    if (r.skipped) return console.log(`${C.dim}○ another cycle is already running${C.r}`);
    const st = readLiveStatus();
    console.log(`${C.g}✓${C.r} cycle done · ${barLine(st).text.replace(/^TF /, '')} · status written`);
    for (const tr of r.transitions) console.log(`  ${C.y}!${C.r} ${tr.title}`);
    return;
  }

  process.on('SIGINT', () => { releaseWatchLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseWatchLock(); process.exit(0); });
  console.log(`${C.b}Tokenflow watcher${C.r} ${C.dim}· every ${interval}s${notifyOn ? ' · notifications on' : ''} · Ctrl+C to stop${C.r}`);
  await startWatch({
    intervalSeconds: interval,
    notifications: notifyOn,
    config: cfg,
    onCycle: (r) => {
      if (process.stdout.isTTY && !r?.error) {
        const line = r?.report ? `✓ refreshed (${int(r.report.newRecords)} new)` : 'cycle complete';
        rewrite(`  ${C.dim}${line}${C.r}`);
      }
    },
  });
}

function printUsageRows(rows, { demo = false } = {}) {
  const row = (k, u) => {
    const c = u.cost ?? u.costMeasured;
    console.log(`  ${pad(k, 12)} ${pad(compact(u.tokens?.total ?? 0), 9)} ${pad(int(u.requests ?? 0), 8)} sessions=${u.sessions ?? '—'}  cost=${c != null ? usd(c) : `${C.dim}n/a${C.r}`}`);
  };
  console.log(`\n  ${C.b}Usage${C.r}${demo ? `  ${C.red}[demo]${C.r}` : ''}`);
  row('Today', rows.today);
  row('Yesterday', rows.yesterday);
  row('Week', rows.weekToDate);
  row('Month', rows.monthToDate);
  const cov = rows.coverage;
  if (cov?.from) console.log(`  ${C.dim}coverage ${cov.from} → ${cov.to}${C.r}\n`);
}

/** `tokenflow usage` — the token/cost answer for today, week, month. */
async function cmdUsage() {
  const st = await liveStatus();
  const payload = { freshness: st.freshness, usage: st.usage, providersToday: st.providersToday, modelsToday: st.modelsToday };
  if (flags.json) return console.log(JSON.stringify(payload, null, 2));
  if (!st.health.records) return console.log(`\n  ${C.y}No usage data yet.${C.r} Run ${C.c}tokenflow setup${C.r}, then ${C.c}tokenflow refresh${C.r}.\n`);
  printUsageRows({ ...st.usage, coverage: st.health.coverage }, { demo: st.demo });
  if (st.providersToday.length) {
    console.log(`  ${C.dim}today's top: ${st.providersToday.map((p) => `${p.key} ${compact(p.tokens)}`).join(' · ')}${C.r}\n`);
  }
}

/** `tokenflow cost` — estimated vs measured spend, who costs what. */
async function cmdCost() {
  const st = await liveStatus();
  if (flags.json) {
    return console.log(JSON.stringify({ cost: { today: pick2(st.usage.today), weekToDate: pick2(st.usage.weekToDate), monthToDate: pick2(st.usage.monthToDate) }, providersToday: st.providersToday, modelsToday: st.modelsToday }, null, 2));
  }
  if (!st.health.records) return console.log(`\n  ${C.y}No usage data yet.${C.r}\n`);
  console.log(`\n  ${C.b}Cost${C.r}  ${C.dim}(estimated from the price table; measured = reported by a gateway)${C.r}`);
  const line = (k, u) => console.log(`  ${pad(k, 12)} est=${u.cost != null ? usd(u.cost) : `${C.dim}n/a${C.r}`}  measured=${u.costMeasured != null ? usd(u.costMeasured) : '—'}`);
  line('Today', st.usage.today);
  line('Week', st.usage.weekToDate);
  line('Month', st.usage.monthToDate);
  const f = st.forecast;
  if (f?.monthEndCost !== null) {
    console.log(`  ${pad('Projection', 12)} month-end ≈ ${C.b}${usd(f.monthEndCost)}${C.r} ${C.dim}(${f.confidence} confidence)${C.r}`);
  }
  if (st.providersToday.length) {
    console.log(`\n  ${C.dim}today by provider:${C.r} ${st.providersToday.filter((p) => p.cost != null).map((p) => `${p.key} ${usd(p.cost)}`).join(' · ') || 'no priced usage'}`);
  }
  console.log('');
}

function pick2(u) {
  return { tokens: u.tokens, requests: u.requests, cost: u.cost ?? null, costMeasured: u.costMeasured ?? null };
}

const CAP_BAR_W = 24;

function capacityBar(pctUsed) {
  if (pctUsed == null) return `${C.dim}${'·'.repeat(CAP_BAR_W)}${C.r}`;
  const filled = Math.min(CAP_BAR_W, Math.round(pctUsed * CAP_BAR_W));
  const color = pctUsed >= 1 ? C.red : pctUsed >= 0.8 ? C.y : C.g;
  return `${color}${'█'.repeat(filled)}${C.r}${C.dim}${'░'.repeat(CAP_BAR_W - filled)}${C.r}`;
}

/** `tokenflow capacity` — where each configured limit stands right now. */
async function cmdCapacity() {
  const st = await liveStatus();
  if (flags.json) return console.log(JSON.stringify(st.capacity, null, 2));
  const states = st.capacity?.states || [];
  if (!states.length) {
    console.log(`\n  No limits configured. TokenFlow never guesses vendor quotas — declare your own caps:`);
    console.log(`  ${C.dim}# ~/.tokenflow/config.yaml${C.r}`);
    console.log(`  ${C.dim}limits:${C.r}`);
    console.log(`  ${C.dim}  - id: anthropic-month${C.r}`);
    console.log(`  ${C.dim}    provider: anthropic      # optional filter${C.r}`);
    console.log(`  ${C.dim}    scope: month             # day | week | month${C.r}`);
    console.log(`  ${C.dim}    metric: tokens           # tokens | input | output | requests | cost${C.r}`);
    console.log(`  ${C.dim}    cap: 120000000${C.r}\n`);
    return;
  }
  console.log(`\n  ${C.b}Capacity${C.r}  ${C.dim}${st.timezone} · resets are local-calendar${C.r}\n`);
  for (const s of states) {
    const glyph = s.status === 'exceeded' ? `${C.red}✗${C.r}` : s.status === 'warn' ? `${C.y}⚠${C.r}` : `${C.g}✓${C.r}`;
    const scopeLabel = s.provider ? ` [${s.provider}]` : '';
    console.log(`  ${glyph} ${C.b}${s.label}${C.r} ${C.dim}(${s.scope}${scopeLabel})${C.r}`);
    console.log(`     ${capacityBar(s.pctUsed)} ${s.pctUsed != null ? `${Math.round(s.pctUsed * 100)}%` : '—'} of ${compact(s.cap)}`);
    const bits = [`used ${compact(s.used)}`, `remaining ${compact(Math.max(0, s.remaining))}`];
    if (s.etaHours !== null && s.status !== 'exceeded') {
      bits.push(`projected exhaustion in ${humanDuration(s.etaHours * 3600000)}`);
    }
    if (s.resetsInMs > 0) bits.push(`resets in ${humanDuration(s.resetsInMs)}`);
    console.log(`     ${bits.join(' · ')}`);
  }
  if ((st.anomalies || []).some((a) => a.severity !== 'info')) {
    console.log(`\n  ${C.y}${(st.anomalies || []).filter((a) => a.severity !== 'info').length} active alert(s) — see 'tokenflow forecast --alerts' or the dashboard Live tab.${C.r}`);
  }
  console.log('');
}

/** `tokenflow forecast` — where usage is heading, with stated confidence. */
async function cmdForecast() {
  const st = await liveStatus();
  if (flags.json) {
    return console.log(JSON.stringify({ forecast: st.forecast, anomalies: st.anomalies }, null, 2));
  }
  const f = st.forecast;
  if (!f || f.tomorrow === null) {
    return console.log(`\n  ${C.y}Not enough history to forecast yet.${C.r} ${f?.reason || ''}\n`);
  }
  console.log(`\n  ${C.b}Forecast${C.r}  ${C.dim}linear trend over the last ${f.n} days · ${f.confidence} confidence${C.r}`);
  console.log(`  ${pad('Tomorrow', 14)} ≈ ${compact(f.tomorrow)} tokens`);
  console.log(`  ${pad('Next 7 days', 14)} ≈ ${compact(f.next7days)} tokens${f.next7daysCost != null ? ` · ${usd(f.next7daysCost)}` : ''}`);
  if (f.monthEnd !== null) console.log(`  ${pad('Month-end', 14)} ≈ ${compact(f.monthEnd)} tokens${f.monthEndCost !== null ? ` · ${usd(f.monthEndCost)}` : ''}`);
  if (Array.isArray(f.tomorrowInterval)) {
    console.log(`  ${C.dim}tomorrow's likely range: ${compact(f.tomorrowInterval[0])} – ${compact(f.tomorrowInterval[1])}${C.r}`);
  }
  const alerts = (st.anomalies || []);
  if (alerts.length) {
    console.log(`\n  ${C.b}Alerts${C.r}`);
    for (const a of alerts.slice(0, 6)) {
      const tag = a.severity === 'high' ? C.red : a.severity === 'warn' ? C.y : C.dim;
      console.log(`   ${tag}●${C.r} [${a.date}] ${wrap(a.detail, 88, 8)}`);
    }
  }
  console.log(`\n  ${C.dim}Projections are trends, not promises — they assume the recent pattern continues.${C.r}\n`);
}

/** `tokenflow digest` — build (and optionally deliver) the shareable summary. */
async function cmdDigest() {
  const { run: runDigest } = await import('../src/commands/digest.js');
  const f = {};
  for (const [k, v] of Object.entries(flags)) if (v != null) f[k] = v;
  const out = await runDigest({
    from: f.from, to: f.to,
    format: f.format === 'text' ? 'text' : 'markdown',
  });

  // Always persist to $TOKENFLOW_HOME/digests/ when delivering or asked to,
  // so there is a local record even if every delivery channel fails.
  if (f.deliver || f.save) {
    const { paths } = await import('../src/core/config.js');
    const dir = `${paths().root}/digests`;
    fs.mkdirSync(dir, { recursive: true });
    const file = `${dir}/${f.to || new Date().toISOString().slice(0, 10)}.md`;
    fs.writeFileSync(file, out + '\n');
    console.log(`${C.dim}saved ${file}${C.r}`);
  }

  if (f.deliver) {
    const { loadConfig } = await import('../src/core/config.js');
    const { deliverAll } = await import('../src/core/delivery.js');
    const results = await deliverAll(loadConfig(), out, { subject: `TokenFlow digest ${f.to || ''}`.trim() });
    for (const r of results) {
      if (r.skipped) console.log(`${C.dim}  ${r.channel}: not configured${C.r}`);
      else if (r.ok) console.log(`${C.g}✓${C.r} delivered via ${r.channel}`);
      else console.log(`${C.red}✗${C.r} ${r.channel}: ${r.error}`);
    }
  } else if (typeof f.out === 'string') {
    fs.writeFileSync(f.out, out + '\n');
    console.log(`${C.g}✓${C.r} wrote ${f.out}`);
  } else {
    console.log(out);
  }
}

/** `tokenflow schedule` — install/remove the weekly digest LaunchAgent. */
async function cmdSchedule() {
  const sched = await import('../src/core/schedule.js');
  if (flags.uninstall) { console.log(sched.uninstall()); return; }
  if (flags.status !== undefined && Object.prototype.hasOwnProperty.call(flags, 'status')) {
    const s = sched.status();
    console.log(`installed: ${s.installed ? 'yes' : 'no'}   loaded: ${s.loaded ? 'yes' : 'no'}`);
    console.log(`latest digest: ${s.latestDigest || 'none yet'}`);
    return;
  }
  // --install (default when neither flag given? no — require explicit intent)
  console.log(sched.install({ when: flags.at }));
}

/** `tokenflow budget` — monthly budget status + forecast alerts with dedup. */
async function cmdBudget() {
  const cfg = loadConfig();
  const budget = { ...cfg.budget };
  if (flags.set) {
    const v = Number(flags.set);
    if (!(v > 0)) throw new Error('--set expects a positive number, e.g. budget --set 200');
    budget.monthly = v;
    saveConfig(merge(cfg, { budget }));
    console.log(`${C.g}✓${C.r} monthly budget set to $${v.toLocaleString('en-US')}`);
  }
  if (!budget.monthly) {
    console.log('No monthly budget configured. Set one:');
    console.log(`  ${C.b}tokenflow budget --set 200${C.r}   # $200/month, warn at 80% projected`);
    return;
  }

  const { currentStatus } = await import('../src/core/live-status.js');
  const { computeBudgetState, shouldAlert } = await import('../src/core/budget.js');
  const { notify } = await import('../src/core/notify.js');
  const { status } = currentStatus();
  const today = new Date().toISOString().slice(0, 10);

  const st = computeBudgetState(status, { monthly: budget.monthly, warnAtPct: budget.warnAtPct }, today);
  if (!st) { console.log('No usage data yet.'); return; }

  const { fire } = shouldAlert(st, { force: !!flags.force });

  console.log(`${C.b}Budget — ${today.slice(0, 7)}${C.r}`);
  console.log(`  Monthly cap:      $${budget.monthly.toLocaleString('en-US')} (warn at ${budget.warnAtPct ?? 80}%)`);
  if (st.spent != null) console.log(`  Spent (est. MTD): $${st.spent.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  if (st.projected != null) console.log(`  Projected EOM:    $${st.projected.toLocaleString('en-US', { maximumFractionDigits: 2 })}  ${C.dim}(projection)${C.r}`);

  const color = st.state === 'safe' ? C.g : st.state === 'unknown' ? C.dim : C.red;
  console.log(`\n  State: ${color}${st.state.toUpperCase()}${C.r}`);
  if (st.message || st.reason) console.log(`  ${(st.message || st.reason)}`);

  if (fire && (budget.notify || flags.notify)) {
    try { notify({ title: `TokenFlow budget: ${st.state.replace(/_/g, ' ')}`, body: st.message || '' }); console.log(`${C.g}✓${C.r} OS notification sent`); }
    catch { /* notification is best-effort */ }
    if (cfg.delivery && Object.values(cfg.delivery).some((ch) => ch && Object.values(ch).some(Boolean))) {
      const { deliverAll } = await import('../src/core/delivery.js');
      const results = await deliverAll(cfg, `**TokenFlow budget alert** — ${st.state}\n\n${st.message || ''}`, { subject: `TokenFlow budget: ${st.state}` });
      for (const r of results) if (!r.skipped) console.log(r.ok ? `${C.g}✓${C.r} delivered via ${r.channel}` : `${C.red}✗${C.r} ${r.channel}: ${r.error}`);
    }
  } else if (st.state !== 'safe' && st.state !== 'unknown') {
    console.log(C.dim + '  (already alerted for this state this month — no spam)');
  }
}

/** `tokenflow sync` — optional multi-machine aggregation via a shared folder. */
async function cmdSync() {
  const { isEnabled, push, pull, machineId } = await import('../src/core/sync.js');
  const cfg = loadConfig();

  if (flags.off) {
    saveConfig(merge(cfg, { sync: { ...cfg.sync, enabled: false } }));
    console.log(`${C.g}✓${C.r} sync disabled — nothing leaves this machine`);
    return;
  }

  if (!isEnabled(cfg)) {
    console.log(`Multi-machine sync is ${C.b}OFF${C.r} by default. To enable it:

  1. Pick a folder that syncs between your machines
     (iCloud Drive, Dropbox, Syncthing mount…)
  2. Add to ~/.tokenflow/config.yaml:

       sync:
         enabled: true
         dir: ~/Sync/TokenFlow        # that shared folder
         machineName: MacBook Pro     # label shown in aggregated views

  3. Run ${C.b}tokenflow sync --push${C.r} on each machine.

What is shared: daily totals only (date, tokens, requests, est. cost).
What is never shared: prompts, code, file paths, credentials.`);
    return;
  }

  const id = machineId();
  if (flags.push || flags.pull === undefined) {
    // default action with no sub-flag = push + pull
  }
  try {
    if (!flags.pull) {
      const r = push({ config: cfg });
      console.log(r.days
        ? `${C.g}✓${C.r} pushed ${r.days} days → ${path.basename(r.file)}`
        : `${C.dim}nothing to push yet${C.r}`);
    }
    const merged = pull({ config: cfg });
    const totalReq = merged.days.reduce((a, d) => a + d.requests, 0);
    const totalCost = merged.days.reduce((a, d) => a + d.estCost, 0);
    console.log(`\n${C.b}Aggregated (${merged.machines.length} machine${merged.machines.length === 1 ? '' : 's'})${C.r}`);
    for (const d of merged.days.slice(-14)) {
      console.log(`  ${d.date}  ${d.machineCount} mach  ${String(d.requests).padStart(6)} req`);
    }
    if (merged.days.length) {
      console.log(`\n  Totals across all machines: ${totalReq.toLocaleString('en-US')} requests · $${totalCost.toFixed(2)} est.`);
    }
    console.log(C.dim + `  this machine's id: ${id}${C.r}`);
  } catch (e) {
    throw Object.assign(new Error(e.message), { exitCode: 1 });
  }
}

/** `tokenflow models-compare` — cost/usage efficiency per model, own data. */
async function cmdModelsCompare() {
  const { compare, renderText } = await import('../src/commands/models-compare.js');
  const f = {};
  for (const [k, v] of Object.entries(flags)) if (v != null) f[k] = v;
  const cmp = compare({ from: f.from, to: f.to });
  console.log(renderText(cmp));
}

/** `tokenflow diagnostics` — local observability, nothing transmitted. */
async function cmdDiagnostics() {
  const { collect, renderText } = await import('../src/commands/diagnostics.js');
  const d = collect({ includePaths: !!flags.paths });
  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, JSON.stringify(d, null, 2) + '\n');
    console.log(`${C.g}✓${C.r} wrote ${flags.out} — review it before sharing (paths included: ${!!flags.paths})`);
  } else if (flags.json) {
    console.log(JSON.stringify(d, null, 2));
  } else {
    console.log(renderText(d));
  }
}

/** `tokenflow team` — per-developer usage from the shared sync folder (P4-B). */
async function cmdTeam() {
  const cfg = loadConfig();
  if (!cfg.sync?.enabled || !cfg.sync?.dir) {
    console.error(`${C.red}Team view reads the shared sync folder.${C.r}
Enable multi-machine sync first — every team member points at the SAME folder:

  sync:
    enabled: true
    dir: /path/to/shared/TokenFlow      # same folder for everyone
    machineName: MacBook Pro            # this machine's label
    developerName: Your Name            # ← opt-in per person; omit to stay anonymous

Then run \`tokenflow sync\` on each machine and \`tokenflow team\` here.`);
    return;
  }
  const { aggregate, renderText } = await import('../src/core/team.js');
  const dir = cfg.sync.dir.replace(/^~(?=$|\/)/, os.homedir());
  const t = aggregate(dir, {
    from: typeof flags.from === 'string' ? flags.from : null,
    to: typeof flags.to === 'string' ? flags.to : null,
    includeAnonymous: !!flags['include-anonymous'],
  });
  if (flags.json) { console.log(JSON.stringify(t, null, 2)); return; }
  console.log(renderText(t));
}

async function cmdMenubar() {
  const mode = String(flags.mode || loadConfig().ui?.menubarMode || 'auto');

  // ---- the real thing: TokenFlow's own native menu bar app -----------------
  if (flags.app) {
    if (process.platform !== 'darwin') {
      throw Object.assign(new Error('the native menu bar app requires macOS'), {
        hint: 'on Linux/Windows use --swiftbar/--xbar/--out with a compatible bar.',
      });
    }
    const script = path.join(root(), 'scripts', 'build-menubar-app.sh');
    console.log(`  building TokenFlow.app with swiftc…`);
    execFileSync('bash', [script], { stdio: 'inherit' });
    const src = path.join(root(), 'dist', 'TokenFlow.app');
    const dest = path.join(os.homedir(), 'Applications', 'TokenFlow.app');
    try { execFileSync('osascript', ['-e', 'quit app "TokenFlow"'], { stdio: 'ignore' }); } catch { /* not running */ }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    execFileSync('open', [dest]);
    console.log(`${C.g}✓${C.r} installed: ${dest}`);
    console.log(`  ${C.dim}Look for "TF" (or TF $… / a percentage) in your menu bar — click it for the full dropdown.${C.r}`);
    if (flags['login-item']) {
      try {
        execFileSync('osascript', ['-e',
          `tell application "System Events" to make login item at end with properties {path:"${dest}", hidden:false}`,
        ], { stdio: 'ignore' });
        console.log(`  ${C.g}✓${C.r} added to Login Items (starts on every login)`);
      } catch {
        console.log(`  ${C.y}!${C.r} could not add the login item automatically — add "${dest}" in System Settings › Login Items.`);
      }
    }
    return;
  }

  // ---- cross-platform text-protocol fallback --------------------------------
  if (flags.render) {
    const st = await liveStatus();
    return console.log(renderXbar(st, { mode }));
  }
  if (flags.swiftbar || flags.xbar || typeof flags.out === 'string') {
    const home = os.homedir();
    const dir = typeof flags.out === 'string'
      ? flags.out
      : flags.xbar
        ? path.join(home, 'Library', 'Application Support', 'xbar', 'plugins')
        : path.join(home, 'Library', 'Plugins');
    const intervalMin = Math.max(1, Math.round(intervalSeconds() / 60));
    const file = installSwiftBarPlugin({ dir, mode, intervalMinutes: intervalMin });
    console.log(`${C.g}✓${C.r} plugin written: ${file}`);
    console.log(`  ${C.dim}Point SwiftBar/xbar at "${dir}" (or restart it) and "tokenflow" appears in your menu bar.`);
    console.log(`  Refresh cadence: every ${intervalMin} min via filename convention; display mode: ${mode}.${C.r}\n`);
    return;
  }

  console.log(`
  ${C.b}Menu bar${C.r}
  usage: tokenflow menubar [--app | --render | --swiftbar | --xbar | --out <dir>]
                           [--mode auto|tokens|cost|limit] [--login-item]

  ${C.b}macOS — native app (recommended)${C.r}
    --app           build TokenFlow.app with swiftc, install to ~/Applications
                    and launch. Rich dropdown: usage, providers, capacity
                    meters, forecast, alerts, refresh — no third-party app.
    --login-item    also add it to Login Items

  ${C.b}Other bars / platforms${C.r}
    --render        print the xbar/SwiftBar-format text (used by the plugin)
    --swiftbar      install the plugin script into ~/Library/Plugins
    --xbar          install into the xbar plugin directory instead
    --out <dir>     install into any compatible bar's plugin directory
    --mode          what the bar shows: auto picks the most urgent signal${C.r}
`);
}

function intervalSeconds() {
  return Number(flags.interval) || loadConfig().watch?.intervalSeconds || 120;
}

// ===================================================================== help ==

function help(code = 0) {
  console.log(`
  ${C.b}tokenflow${C.r} — local-first AI token usage & activity analytics

  ${C.b}Getting started${C.r}
    tokenflow setup                 detect local AI tools and write config
    tokenflow up                    refresh + rebuild the offline file + open it
    tokenflow refresh               ingest new usage (incremental, resumable)
    tokenflow dashboard             open the local dashboard (no refresh)
    tokenflow demo                  explore with clearly-labelled synthetic data
                                   (--no-serve to generate the data and exit)

  ${C.b}Live${C.r}
    tokenflow watch                 keep data + status current in the background
    tokenflow watch --once          one cycle and exit (cron-friendly)
    tokenflow watch --status        is a watcher running? how fresh is the data?
    tokenflow watch --stop          stop a running watcher
    tokenflow usage                 today / week / month tokens & cost (--json)
    tokenflow cost                  estimated vs measured spend, projections
    tokenflow capacity              configured limits: %, burn, reset countdowns
    tokenflow forecast              trend projection + active alerts
    tokenflow menubar --swiftbar    install a SwiftBar/xbar menu-bar plugin
    tokenflow status --bar          the one-line menu-bar summary

  ${C.b}Everyday${C.r}
    tokenflow status                totals, coverage, data health, insights
    tokenflow providers             what is detected / connected
    tokenflow provider add <id>     enable an adapter
    tokenflow refresh --full        re-ingest everything from scratch
                                   (refuses if a source's logs are unreachable;
                                    --force discards those records anyway)
    tokenflow refresh --budget 30   stop cleanly after 30s and resume next run
    tokenflow export --csv          current view as CSV
    tokenflow export --csv --all    every normalized record
    tokenflow export --html         one self-contained offline dashboard file

  ${C.b}Intelligence${C.r}
    tokenflow models-compare        cost/request, tokens/request, cache-hit% per model
                                   (--from/--to <date> to pick the window)
    tokenflow budget --set 200      monthly cap → projected-overrun alerts (dedup'd)
    tokenflow budget                current state: safe / approaching / over
    tokenflow digest --deliver      build "Your AI Week" and send via configured channels
    tokenflow schedule --install --at "Monday 09:00"   weekly digest via launchd
    tokenflow schedule --status     is the digest schedule installed?
    tokenflow team                  per-developer usage from the shared sync folder
    tokenflow diagnostics           version, providers, store freshness, feature states

  ${C.b}Sync (optional, off by default)${C.r}
    tokenflow sync                  push this machine's daily rollups + show merged view
    tokenflow sync --off            disable sync entirely

  ${C.b}Configure${C.r}
    tokenflow pricing               show which models have a price, and from where
    tokenflow pricing --sources     provenance of every built-in rate + tier multipliers
    tokenflow pricing --set "m=3,15,0.3,3.75"
    tokenflow import <file>         CSV / JSON / JSONL / SQLite with field mapping
    tokenflow restore <file.csv>    rebuild the store from a full export, re-priced
    tokenflow config show|path|export|import

  ${C.b}Maintain${C.r}
    tokenflow doctor                environment, paths, store, adapters
    tokenflow validate              re-validate every stored record
    tokenflow compact               drop superseded records after a rewrite
    tokenflow reset --yes           delete ingested data (keeps config)

  ${C.b}Flags${C.r}  --json  --quiet  --provider <id>  --from/--to <date>  --port <n>  --no-open  --debug

  ${C.dim}Everything runs locally. No usage data, prompt or file content ever leaves this machine.
  Data home: ${paths().root}${C.r}
`);
  process.exitCode = code;
}

// ===================================================================== util ==

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    if (a.startsWith('--no-')) { out[a.slice(5)] = false; continue; }
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq > -1) { key = a.slice(2, eq); val = a.slice(eq + 1); } else {
      key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) { val = next; i++; } else val = true;
    }
    if (out[key] === undefined) out[key] = val;
    else out[key] = [].concat(out[key], val);
  }
  return out;
}

function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}
function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function rewrite(line) {
  if (!process.stdout.isTTY) { if (line) console.log(stripAnsi(line)); return; }
  process.stdout.write('\r\x1b[2K' + line);
}
function wrap(text, width, indent) {
  const words = String(text).split(' ');
  const pre = ' '.repeat(indent);
  let line = '';
  const lines = [];
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + pre);
}
function root() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The ingestion engine.
 *
 * Adapters parse; the engine does everything else — classification, timezone
 * resolution, cost estimation, id assignment, dedup bookkeeping, shard writes,
 * cube and session rollups. That split is what keeps a new adapter to ~80
 * lines and keeps the analytics layer from ever seeing vendor-specific shapes.
 *
 * The engine is time-budgeted and resumable: pass `deadlineMs` and it stops
 * cleanly on a file boundary, persists state, and reports `done: false`.
 * Calling it again picks up exactly where it stopped. That is what lets a
 * multi-gigabyte first ingest run inside short-lived shells or a UI request.
 */
import fs from 'node:fs';
import os from 'node:os';
import { Store, encodeRecord, decodeRecord, fileId, compactShards } from './store.js';
import { createRecord, dateParts, hashId, MEASUREMENT, INTERFACE } from './schema.js';
import { classifyModel, BUILTIN_MODEL_RULES } from './model-map.js';
import { classifyInterface } from './interface-map.js';
import { buildPriceBook, estimateCost } from './pricing.js';
import { validateUsage } from './validate.js';
import { loadConfig, paths } from './config.js';
import { readJson, writeJson, truncateFile } from './store.js';

/**
 * @param {object} opt
 * @param {string[]} [opt.providers] provider ids; defaults to config.providers or all detected
 * @param {number}   [opt.deadlineMs] wall-clock budget for this call
 * @param {boolean}  [opt.full] ignore incremental state and re-ingest everything
 * @param {boolean}  [opt.strict] run full record validation (slower)
 * @param {(e:object)=>void} [opt.onProgress]
 * @param {object[]} [opt.registry] provider objects
 * @param {object} [opt.config] pre-loaded config; defaults to loadConfig()
 * @param {boolean} [opt.force] allow a full re-ingest even when a source is unreachable
 */
export async function refresh(opt = {}) {
  const t0 = Date.now();
  const deadline = opt.deadlineMs ? t0 + opt.deadlineMs : Infinity;
  const config = opt.config || loadConfig();
  const store = new Store();
  const progress = opt.onProgress || (() => {});

  const userPricing = readJson(paths().pricing, {});
  const priceBook = buildPriceBook(userPricing);
  const rules = [
    ...(config.modelMappings || []).map((r) => ({ ...r, label: r.label || r.provider })),
    ...BUILTIN_MODEL_RULES,
  ];

  const all = opt.registry || [];
  const wanted = (opt.providers && opt.providers.length ? opt.providers
    : config.providers && config.providers.length ? config.providers
      : all.map((p) => p.id));

  const ctx = {
    config,
    tz: config.timezone || null,
    home: os.homedir(),
    user: config.identity?.user || os.userInfo().username,
    machine: config.identity?.machine || os.hostname(),
    priceBook,
    rules,
    log: (m) => progress({ type: 'log', message: m }),
  };

  // ------------------------------------------------------------ preflight ---
  // Detection runs BEFORE anything destructive. A `--full` re-ingest drops the
  // stored records for the sources in scope and rebuilds them from the source
  // logs, which is only safe if those logs are actually reachable: run the same
  // command in a sandbox, on another machine, or after the log directory has
  // been moved, and the sources silently detect as unavailable — an unguarded
  // reset would then delete a corpus it cannot rebuild. So refuse instead, and
  // require an explicit --force from someone who really does mean "discard".
  const detected = new Map();
  for (const id of wanted) {
    const p = all.find((x) => x.id === id);
    if (!p) continue;
    try {
      detected.set(id, await p.detect(ctx));
    } catch (err) {
      detected.set(id, { available: false, detail: err.message, error: true });
    }
  }

  const scopedFull = opt.full && opt.providers && opt.providers.length;
  if (opt.full && !opt.force) {
    const restoredBy = store.state.restored?.bySource || {};
    const atRisk = wanted.filter((id) => (
      ((store.state.sources[id]?.records || 0) > 0 || (restoredBy[id] || 0) > 0)
      && !detected.get(id)?.available
    ));
    if (atRisk.length) {
      const held = atRisk.reduce((a, id) => a + (store.state.sources[id]?.records || 0) + (restoredBy[id] || 0), 0);
      const why = atRisk.map((id) => `${id}: ${detected.get(id)?.detail || 'not detected'}`);
      const err = /** @type {Error & {code?:string, sources?:string[]}} */ (new Error(
        `refusing a full re-ingest: ${held.toLocaleString()} stored record(s) come from source(s) that are not reachable right now, `
        + `so they could not be rebuilt after being dropped.\n  ${why.join('\n  ')}\n`
        + '  Fix the source path(s) and retry, run an incremental `refresh` instead, '
        + 'or pass --force to discard those records anyway.',
      ));
      err.code = 'FULL_REFRESH_UNSAFE';
      err.sources = atRisk;
      throw err;
    }
  }

  // A restored slice (see `tokenflow restore`) stands in for a source until the
  // real logs are read again. The moment a provider ingests for real, its
  // restored records are marked stale so the two can never be double counted.
  let supersededRestore = false;
  if (store.state.restored?.bySource) {
    for (const id of wanted) {
      if (!detected.get(id)?.available) continue;
      if (!store.state.restored.bySource[id]) continue;
      store.state.stale.push([fileId('restore', id), store.state.restored.gen || 1]);
      delete store.state.restored.bySource[id];
      supersededRestore = true;
      progress({ type: 'log', message: `superseding restored ${id} records with a fresh read of the source logs` });
    }
    if (!Object.keys(store.state.restored.bySource).length) store.state.restored.supersededAt = new Date().toISOString();
  }

  if (opt.full && !scopedFull) {
    // Global re-ingest: everything goes.
    store.state.sources = {};
    store.state.stale = [];
    store.state.counters = { records: 0, malformed: 0 };
    store.resetCube();
    store.resetSessions();
    store.resetActivity();
    for (const s of store.listShards()) truncateFile(`${paths().records}/${s}`);
  } else if (scopedFull) {
    // Re-ingest ONE provider without touching the others. Its existing records
    // are marked stale (rather than deleted, which would mean rewriting shared
    // shards mid-ingest) and the aggregates are rebuilt from the shards
    // afterwards, skipping the stale generations.
    for (const id of opt.providers) {
      const st = store.state.sources[id];
      if (!st) continue;
      for (const [key, f] of Object.entries(st.files || {})) {
        store.state.stale.push([fileId(id, key), f.gen || 1]);
        st.files[key] = { size: -1, mtimeMs: -1, offset: 0, gen: (f.gen || 1) + 1, records: 0 };
      }
      // Fetch-based adapters (SQLite, APIs, generators) have no per-file state,
      // so they carry a source-level generation for exactly this purpose.
      store.state.stale.push([fileId(id, id), st.gen || 1]);
      st.gen = (st.gen || 1) + 1;
      st.cursor = null;
      st.records = 0;
    }
  }

  /** Working directories seen in usage records — lets the git adapter
   *  auto-discover repositories with zero configuration. */
  const projectPaths = new Set(readJson(`${paths().data}/project-paths.json`, { paths: [] }).paths || []);

  const report = {
    startedAt: new Date(t0).toISOString(),
    done: true,
    providers: [],
    newRecords: 0,
    filesScanned: 0,
    filesSkipped: 0,
    bytesRead: 0,
    malformed: 0,
    invalid: [],
    durationMs: 0,
  };

  for (const id of wanted) {
    const p = all.find((x) => x.id === id);
    if (!p) {
      report.providers.push({ id, status: 'unknown-provider' });
      continue;
    }
    const pr = { id, name: p.name, status: 'ok', records: 0, files: 0, processed: 0, skipped: 0, bytes: 0, notes: [], detail: null };
    report.providers.push(pr);

    const det = detected.has(id) ? detected.get(id) : await p.detect(ctx).catch((e) => ({ available: false, detail: e.message, error: true }));
    if (det && det.error) {
      pr.status = 'detect-error';
      pr.notes.push(det.detail);
      continue;
    }
    if (!det || !det.available) {
      pr.status = 'not-detected';
      pr.detail = det?.detail || null;
      continue;
    }
    pr.detail = det.detail || null;

    const sourceState = store.sourceState(p.id);
    let seq = 0;

    const makeEmit = (fileRef) => (partial) => {
      const rec = enrich(partial, {
        ctx, provider: p, seq: seq++, fileRef,
      });
      if (!rec) return;
      if (opt.strict) {
        const v = validateUsage(rec);
        if (!v.ok && report.invalid.length < 20) report.invalid.push({ id: rec.id, source: p.id, errors: v.errors });
      }
      if (rec.metadata && rec.metadata.cwd && projectPaths.size < 5000) projectPaths.add(rec.metadata.cwd);
      const enc = encodeRecord(rec);
      if (config.store?.keepRaw !== false) store.writer(rec.date).write(enc);
      store.addToCube(rec);
      store.upsertSession(rec);
      store.addToActivity(rec);
      report.newRecords++;
      pr.records++;
      sourceState.records = (sourceState.records || 0) + 1;
    };

    try {
      if (typeof p.discover === 'function' && typeof p.ingestFile === 'function') {
        const files = (await p.discover(ctx)) || [];
        pr.files = files.length;
        // Oldest first: history fills in monotonically, so a budget-limited
        // first run always leaves a contiguous, explainable dataset.
        files.sort((a, b) => (a.stat?.mtimeMs || 0) - (b.stat?.mtimeMs || 0));
        for (const f of files) {
          if (Date.now() > deadline) { report.done = false; pr.status = 'partial'; break; }
          const stat = f.stat || safeStat(f.path);
          if (!stat) continue;
          const plan = store.planFile(p.id, f.key, stat);
          if (plan.action === 'skip' && !opt.full) { pr.skipped++; report.filesSkipped++; continue; }
          const fileRef = {
            ...f, stat, gen: plan.gen,
            start: plan.action === 'append' ? plan.start : 0,
            state: plan.action === 'rewrite' ? {} : (plan.prev?.adapter ?? {}),
          };
          let res;
          try {
            res = (await p.ingestFile(fileRef, ctx, makeEmit(fileRef))) || {};
          } catch (err) {
            pr.notes.push(`${f.key}: ${err.message}`);
            continue;
          }
          report.filesScanned++;
          pr.processed++;
          const bytes = (res.offset ?? stat.size) - fileRef.start;
          pr.bytes += Math.max(0, bytes);
          report.bytesRead += Math.max(0, bytes);
          report.malformed += res.malformed || 0;
          store.commitFile(p.id, f.key, stat, plan.gen, res.offset ?? stat.size, res.records ?? 0, plan.prev?.gen);
          store.sourceState(p.id).files[f.key].adapter = fileRef.state;
          if (report.filesScanned % 200 === 0) {
            progress({ type: 'progress', provider: p.id, files: report.filesScanned, records: report.newRecords });
          }
        }
      } else if (typeof p.fetchUsage === 'function') {
        const fetchRef = { key: p.id, path: null, gen: sourceState.gen || 1, state: sourceState.adapter ?? {} };
        const res = (await p.fetchUsage(ctx, makeEmit(fetchRef), sourceState)) || {};
        sourceState.adapter = fetchRef.state;
        if (res.cursor !== undefined) sourceState.cursor = res.cursor;
        if (res.notes) pr.notes.push(...res.notes);
        report.malformed += res.malformed || 0;
      }
    } catch (err) {
      pr.status = 'error';
      pr.notes.push(err.message);
    }
    sourceState.lastRefresh = new Date().toISOString();
  }

  store.closeWriters();
  store.state.counters.malformed = (store.state.counters.malformed || 0) + report.malformed;
  store.state.counters.records = (store.state.counters.records || 0) + report.newRecords;
  store.state.lastRefresh = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  store.state.lastRefreshDurationMs = report.durationMs;
  writeJson(`${paths().data}/project-paths.json`, { paths: [...projectPaths] });
  if (scopedFull || supersededRestore) {
    progress({ type: 'log', message: 'compacting superseded records…' });
    store.closeWriters();
    const compacted = compactShards(store);
    progress({ type: 'log', message: 'rebuilding aggregates from stored records…' });
    const stats = rebuildAggregates(store);
    report.rebuilt = { ...stats, ...compacted };
    // Record counts are now derived from what actually survived rather than
    // from a running total. Without this they keep counting superseded and
    // restored records that no longer exist, and `state.json` ends up claiming
    // a corpus larger than the one on disk — which then misinforms the `--full`
    // safety check, which reads exactly these numbers to decide what is at risk.
    store.state.counters.records = stats.records;
    for (const id of Object.keys(store.state.sources)) {
      store.state.sources[id].records = stats.bySource[id] || 0;
    }
    report.recounted = true;
  }
  store.saveCube({ tz: ctx.tz, pricingVersion: priceBook.version });
  store.saveSessions();
  store.saveActivity();
  store.saveState();

  report.finishedAt = new Date().toISOString();
  progress({ type: 'done', report });
  return report;
}

/**
 * Turn an adapter's partial into a fully classified, priced, dated record.
 * Exported so adapter tests can assert normalization in isolation.
 */
export function enrich(partial, { ctx, provider, seq = 0, fileRef = null }) {
  if (!partial) return null;
  const ts = partial.timestamp;
  const dp = dateParts(ts, ctx.tz);
  if (!dp) return null;

  const cls = partial.provider
    ? {
      provider: partial.provider,
      provider_label: partial.provider_label || partial.provider,
      model: partial.model || 'unknown',
      model_family: partial.model_family || 'Unknown',
    }
    : classifyModel(partial.model, { rules: ctx.rules, providerHint: partial.providerHint || null });

  let iface = partial.interface;
  if (!iface) {
    const override = ctx.config.interfaceOverrides?.[partial.client];
    iface = override || classifyInterface(partial.interfaceSignals || []).interface;
  }

  const base = {
    timestamp: dp.iso,
    date: dp.date,
    hour: dp.hour,
    dow: dp.dow,
    tz_offset: dp.tz_offset,
    provider: cls.provider,
    provider_label: cls.provider_label,
    model: cls.model,
    model_family: partial.model_family || cls.model_family,
    gateway: partial.gateway ?? null,
    client: partial.client || provider.id,
    application: partial.application || provider.name,
    interface: iface || INTERFACE.UNKNOWN,
    input_tokens: partial.input_tokens,
    output_tokens: partial.output_tokens,
    cache_read_tokens: partial.cache_read_tokens,
    cache_write_tokens: partial.cache_write_tokens,
    cache_refresh_tokens: partial.cache_refresh_tokens,
    reasoning_tokens: partial.reasoning_tokens,
    session_id: partial.session_id ?? null,
    conversation_id: partial.conversation_id ?? null,
    request_id: partial.request_id ?? null,
    project: partial.project ?? null,
    repository: partial.repository ?? null,
    git_branch: partial.git_branch ?? null,
    category: partial.category ?? null,
    service_tier: partial.service_tier ?? partial.metadata?.service_tier ?? null,
    duration_ms: partial.duration_ms ?? null,
    source: provider.id,
    measurement: partial.measurement || provider.measurement || MEASUREMENT.PRIMARY,
    user: partial.user ?? ctx.user,
    machine: partial.machine ?? ctx.machine,
    metadata: partial.metadata || {},
  };

  // Cost: a measured cost from the source always wins; otherwise estimate,
  // and leave null when the model has no configured price.
  if (partial.measured_cost !== undefined && partial.measured_cost !== null) {
    base.estimated_cost = partial.measured_cost;
    base.cost_basis = 'measured';
  } else {
    // The service tier is a real multiplier, not a footnote: OpenAI's Fast mode
    // bills at 4x standard, Anthropic's Batch API at 0.5x.
    const c = estimateCost(base, base.model, base.provider, ctx.priceBook, { tier: base.service_tier });
    base.estimated_cost = c.cost;
    base.cost_basis = c.basis;
    if (c.partial || (c.tierMult && c.tierMult !== 1) || c.src) {
      base.metadata = {
        ...base.metadata,
        ...(c.partial ? { cost_partial: true } : {}),
        ...(c.tierMult !== 1 ? { cost_tier_multiplier: c.tierMult } : {}),
        ...(c.src ? { price_source: c.src } : {}),
      };
    }
  }

  const rec = createRecord(base);
  rec.id = partial.id || hashId(
    provider.id,
    rec.session_id || fileRef?.key || '',
    rec.request_id || rec.timestamp,
    rec.model,
    String(seq),
  );
  if (fileRef) {
    rec._fileId = fileId(provider.id, fileRef.key);
    rec._gen = fileRef.gen ?? 1;
  }
  return rec;
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Walk a directory tree, returning files that match `test`. Symlink-safe. */
export function walk(root, test, { maxDepth = 12, limit = 200000 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < limit) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        stack.push([full, depth + 1]);
      } else if (e.isFile() && test(e.name, full)) {
        out.push(full);
      }
    }
  }
  return out;
}


/**
 * Rebuild the cube, sessions and activity rollups from the stored
 * request-level records, skipping stale generations.
 *
 * This is what makes a per-provider `--full` safe: one adapter can be
 * re-ingested from scratch without disturbing any other adapter's numbers,
 * because the aggregates are always derivable from the facts on disk.
 */
export function rebuildAggregates(store) {
  const stale = store.staleSet();
  store.resetCube();
  store.resetSessions();
  store.resetActivity();
  let kept = 0;
  const bySource = {};
  store.scanRecords((o) => {
    const rec = decodeRecord(o);
    store.addToCube(rec);
    store.upsertSession(rec);
    store.addToActivity(rec);
    bySource[rec.source] = (bySource[rec.source] || 0) + 1;
    kept++;
  }, { stale });
  return { records: kept, bySource };
}

/**
 * The data bundle handed to a dashboard (browser or snapshot).
 *
 * It is deliberately small: the pre-aggregated cube, one row per session, the
 * daily work-activity rollup, and metadata. Request-level records stay on disk
 * and are streamed on demand by the Data Explorer, so opening the dashboard
 * never means shipping a gigabyte into a browser tab.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Store, readJson } from './store.js';
import { paths, loadConfig } from './config.js';
import { summarizeQuality } from './validate.js';
import { tzOffsetMinutes } from './schema.js';
import { PRICING_TABLE_VERSION, PRICING_SOURCES, TIER_MULTIPLIERS, buildPriceBook } from './pricing.js';
import { decodeRecord } from './store.js';
import { MEASUREMENT } from './schema.js';
import { createReceiptBuilder } from '../analytics/receipt.js';
import { makeRepoResolver } from './repo.js';
import { readAnnotations } from './annotations.js';

/**
 * Receipts for the whole store, attributed per repository and branch. A full
 * record scan costs seconds on a large store, so the result is cached against
 * the store's refresh stamp and streamed through the builder rather than
 * materialized. Shipped in the bundle so the offline snapshot has them too.
 *
 * `tickets` is the user's `tickets:` config block (system, baseUrl, pattern).
 * It changes which ticket key each branch resolves to, so it is part of the
 * cache key: editing the config and reopening the dashboard must not serve
 * receipts built under the old pattern. It defaults to what is on disk so a
 * caller that has no config object in hand still gets the user's own setting.
 *
 * @param {import('./store.js').Store} store
 * @param {object} pricing pricing overrides (the shape of pricing.json)
 * @param {{system?:string|null, baseUrl?:string|null, pattern?:string|null}} [tickets]
 */
let receiptsCache = { key: null, value: null };
export function buildReceiptsForStore(store, pricing, tickets = loadConfig().tickets || {}) {
  const key = `${store.state.lastRefresh || ''}|${store.state.records || ''}|${JSON.stringify(pricing || {})}|${JSON.stringify(tickets || {})}`;
  if (receiptsCache.key === key) return receiptsCache.value;
  const t0 = Date.now();
  const builder = createReceiptBuilder({ book: buildPriceBook(pricing || {}), repoOf: makeRepoResolver(), tickets: tickets || {} });
  store.scanRecords((o) => {
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    builder.add(decodeRecord(o));
  });
  const r = builder.finish();
  const value = {
    ...r,
    computedAt: new Date().toISOString(),
    computeMs: Date.now() - t0,
    // The dashboard shows the whole store; the PR join stays a CLI concern
    // (`tokenflow receipt --gh`) until cached PR lists exist.
    scope: 'store',
  };
  receiptsCache = { key, value };
  return value;
}

/**
 * @param {{config?:object, receipts?:boolean}} [opt] `receipts: false` skips the
 *   whole-store receipt scan; the watcher's status snapshot and one-line CLI
 *   summaries never read them, so they should not pay seconds for them.
 */
export function buildBundle({ config = loadConfig(), receipts = true } = {}) {
  const store = new Store();
  const p = paths();
  const cube = store.cube();
  const sessions = store.sessionList();
  const activity = store.activity();
  const pricing = readJson(p.pricing, {});
  const health = summarizeQuality(cube, store.sessions(), store.state);

  // Per-adapter date coverage, so "Date range" is never read as if every
  // source covered all of it.
  const perSource = new Map();
  for (const s of sessions) {
    const e = perSource.get(s.so) || { from: null, to: null, sessions: 0, tokens: 0 };
    if (e.from === null || s.d < e.from) e.from = s.d;
    if (e.to === null || s.d > e.to) e.to = s.d;
    e.sessions++;
    e.tokens += s.total || 0;
    perSource.set(s.so, e);
  }
  const providersState = Object.entries(store.state.sources || {}).map(([id, s]) => ({
    id,
    records: s.records || 0,
    files: Object.keys(s.files || {}).length,
    lastRefresh: s.lastRefresh || null,
    coverage: perSource.get(id) ? { from: perSource.get(id).from, to: perSource.get(id).to } : null,
    sessions: perSource.get(id)?.sessions ?? 0,
    tokens: perSource.get(id)?.tokens ?? 0,
  }));

  const demo = sessions.some((s) => s.so === 'mock') || cube.rows.some((r) => r[6] === 'mock');
  const coverage = health.coverage;
  const tz = cube.tz || config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      appVersion: readJson(path.join(rootDir(), 'package.json'), {}).version || '0.0.0',
      cubeVersion: cube.version,
      timezone: tz,
      today: localToday(tz),
      // Wall-clock offset of the dataset's timezone right now. Capacity reset
      // countdowns and burn-rate hours are computed against this, so a limit
      // resets when the *user's* calendar rolls over.
      tzOffsetMinutes: tzOffsetMinutes(new Date(), tz),
      pricingTableVersion: PRICING_TABLE_VERSION,
      pricingSources: PRICING_SOURCES,
      tierMultipliers: TIER_MULTIPLIERS,
      lastRefresh: store.state.lastRefresh,
      lastRefreshDurationMs: store.state.lastRefreshDurationMs,
      coverage,
      demo,
      includeOverlayDefault: !!config.analytics?.includeOverlaySources,
      defaultRange: config.ui?.defaultRange || 'all',
      defaultFrom: config.ui?.defaultFrom || null,
      // Theme defaults from config; the browser's own choice wins once set.
      skin: config.ui?.skin || 'aurora',
      mode: config.ui?.mode || config.ui?.theme || 'dark',
      builtAt: cube.builtAt || store.state.lastRefresh || null,
      dataHome: p.root,
      sources: providersState,
    },
    cube,
    sessions,
    activity,
    pricing,
    // User-declared quota/budget caps; analytics/capacity.js evaluates them
    // against the same cube every other surface reads.
    limits: Array.isArray(config.limits) ? config.limits : [],
    health,
    receipts: receipts ? buildReceiptsForStore(store, pricing, config.tickets || {}) : null,
    // User-marked calendar days ("switched to Opus 5"), drawn on every daily
    // chart. A missing annotations.json yields an empty list, never a throw.
    annotations: readAnnotations().items,
  };
}

/** Records for the Data Explorer, filtered and paginated server-side. */
export function queryRecords(q = {}) {
  const store = new Store();
  const limit = Math.min(Number(q.limit) || 100, 5000);
  const offset = Number(q.offset) || 0;
  const search = (q.search || '').toLowerCase();
  const sortKey = q.sort || 'ts';
  const desc = q.dir !== 'asc';
  const wanted = {
    from: q.from || null, to: q.to || null,
    p: split(q.provider), m: split(q.model), c: split(q.client),
    i: split(q.interface), pj: split(q.project), so: split(q.source),
    ms: split(q.measurement),
  };
  const months = monthsBetween(wanted.from, wanted.to);
  const matched = [];
  let scanned = 0;
  let total = 0;

  // Keep only what a page could need, plus enough to sort: a bounded top-K
  // buffer means a 100-record page never materialises a million objects.
  const cap = offset + limit;
  store.scanRecords((o) => {
    scanned++;
    if (wanted.from && o.d < wanted.from) return;
    if (wanted.to && o.d > wanted.to) return;
    for (const k of ['p', 'm', 'c', 'i', 'pj', 'so', 'ms']) {
      if (wanted[k] && !wanted[k].includes(o[k])) return;
    }
    if (search) {
      const hay = `${o.m} ${o.p} ${o.c} ${o.pj} ${o.s} ${o.i} ${o.rq || ''} ${o.br || ''}`.toLowerCase();
      if (!hay.includes(search)) return;
    }
    total++;
    matched.push(o);
    if (matched.length > cap * 4 + 4000) {
      matched.sort(cmp(sortKey, desc));
      matched.length = cap;
    }
  }, { months });

  matched.sort(cmp(sortKey, desc));
  return {
    total,
    scanned,
    offset,
    limit,
    rows: matched.slice(offset, offset + limit),
  };
}

function cmp(key, desc) {
  return (a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return 0;
    if (x === undefined || x === null) return 1;
    if (y === undefined || y === null) return -1;
    const r = x < y ? -1 : 1;
    return desc ? -r : r;
  };
}

function split(v) {
  if (!v) return null;
  const a = Array.isArray(v) ? v : String(v).split(',');
  const out = a.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : null;
}

function monthsBetween(from, to) {
  if (!from || !to) return null;
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function localToday(tz) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = {};
    for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function rootDir() {
  // src/core -> project root
  return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
}

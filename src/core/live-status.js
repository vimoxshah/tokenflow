/**
 * The live status snapshot.
 *
 * One small JSON file — `$TOKENFLOW_HOME/data/status.json` — that every
 * "right now" surface reads: the menu bar plugin, `tokenflow status --bar`,
 * `--live`, and the dashboard's freshness pill. The watch daemon refreshes it
 * after every cycle; anything can also build it on demand.
 *
 * It answers, with sources: what happened today / this week / this month, who
 * consumed it, where each configured limit stands, where usage is heading,
 * and how fresh all of it is. Numbers come from the same cube + analytics as
 * the dashboard, so no surface can disagree with another.
 *
 * Formatting helpers (bar line, countdowns) are pure and exported for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBundle } from './bundle.js';
import { computeView } from '../analytics/index.js';
import { filterCube, filterSessions, indexCube, rank, finalize, sumRows, weekStart, addDays } from '../analytics/aggregate.js';
import { loadConfig, paths, ensureDirs } from './config.js';
import { readJson, Store, decodeRecord } from './store.js';
import { compact, usd, countdown } from './units.js';
import { detectMilestones } from '../analytics/milestones.js';
import { lockIsLive, readLock } from './watch-lock.js';
import { evaluateGuard, createReceiptBuilder } from '../analytics/receipt.js';
import { buildPriceBook } from './pricing.js';
import { MEASUREMENT } from './schema.js';

// Formatting adapters over the shared units.js formatters (which the browser
// bundle also uses): null means "nothing to show", never "—", never 0.
const compactTokens = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : compact(n));
const money = (n) => (n === null || n === undefined ? null : usd(n));
export { countdown, compactTokens, money };

const STATUS_SCHEMA = 1;

function costOf(m) {
  // Estimated and measured stay separate everywhere in this codebase; a live
  // surface must not silently merge a price-table estimate with a gateway's
  // billed number. `cost` is null when nothing was priced.
  return {
    cost: m.costReq > 0 ? m.cost : null,
    costMeasured: m.costMeasured > 0 ? m.costMeasured : null,
  };
}

function usageSlice(m, extra = {}) {
  return {
    tokens: { total: m.total, input: m.in, output: m.out, cacheRead: m.cr, cacheWrite: m.cw },
    requests: m.req,
    ...costOf(m),
    ...extra,
  };
}

/**
 * Build the status object from the store (or an existing bundle).
 * @param {{config?:object, bundle?:object, nowMs?:number}} opt
 */
export function buildLiveStatus(opt = {}) {
  const config = opt.config || loadConfig();
  const b = opt.bundle || buildBundle({ config, receipts: false });
  const nowMs = opt.nowMs ?? Date.now();
  const v = computeView(b, {});
  const ix = indexCube(b.cube);
  const today = b.meta.today;
  const tzOffsetMinutes = b.meta.tzOffsetMinutes ?? 0;
  const includeOverlay = !!b.meta.includeOverlayDefault;

  const measuresFor = (from, to) =>
    finalize(sumRows(filterCube(ix, { from, to, includeOverlay }), ix));
  const todayM = measuresFor(today, today);
  const yesterday = addDays(today, -1);
  const yesterdayM = measuresFor(yesterday, yesterday);
  const wtdM = measuresFor(weekStart(today), today);
  const mtdM = measuresFor(`${today.slice(0, 7)}-01`, today);

  const todayRows = filterCube(ix, { from: today, to: today, includeOverlay });
  // Zero-token rows (activity-only sources) never earn a slot in token
  // rankings — an "unknown · 0 tok" row is noise, not information.
  const providersToday = rank(todayRows, ix, (r) => r[ix.d.p])
    .filter((g) => g.m.total > 0).slice(0, 5)
    .map((g) => ({ key: g.key, tokens: g.m.total, requests: g.m.req, ...costOf(g.m) }));
  const modelsToday = rank(todayRows, ix, (r) => r[ix.d.m])
    .filter((g) => g.m.total > 0).slice(0, 5)
    .map((g) => ({ key: g.key, tokens: g.m.total, requests: g.m.req, ...costOf(g.m) }));
  // By SOURCE (the tool that wrote the log: claude-code, opencode, hermes,
  // git, …). Provider answers "who made the model"; source answers "which
  // app did I use" — hermes traffic shows here even when its models belong
  // to other vendors.
  const sourcesToday = rank(todayRows, ix, (r) => r[ix.d.c])
    .filter((g) => g.m.total > 0).slice(0, 6)
    .map((g) => ({ key: g.key, tokens: g.m.total, requests: g.m.req, ...costOf(g.m) }));

  // ---- rolling windows (measured locally — CodexBar-style "current window") --
  // Hour-granular slices of the cube: the boundary is the top of an hour, so a
  // window may be up to 59 minutes conservative. That approximation is stated
  // here rather than hidden.
  const sumSince = (hoursBack) => {
    const cutoff = new Date(nowMs + tzOffsetMinutes * 60000 - hoursBack * 3600000);
    const cutoffKey = `${cutoff.toISOString().slice(0, 10)}T${String(cutoff.getUTCHours()).padStart(2, '0')}`;
    const rows = ix.rows.filter((r) => `${r[ix.d.d]}T${String(r[ix.d.h]).padStart(2, '0')}` >= cutoffKey);
    return usageSlice(finalize(sumRows(rows, ix)));
  };
  const windows = {
    last5h: sumSince(5),
    last24h: sumSince(24),
  };

  // ---- per-provider rolling windows ------------------------------------------
  // Same hour-granular slices as the totals above, scoped to one provider.
  const sumSinceFor = (hoursBack, provider) => {
    const cutoff = new Date(nowMs + tzOffsetMinutes * 60000 - hoursBack * 3600000);
    const cutoffKey = `${cutoff.toISOString().slice(0, 10)}T${String(cutoff.getUTCHours()).padStart(2, '0')}`;
    const rows = ix.rows.filter((r) =>
      r[ix.d.p] === provider &&
      `${r[ix.d.d]}T${String(r[ix.d.h]).padStart(2, '0')}` >= cutoffKey);
    return usageSlice(finalize(sumRows(rows, ix)));
  };

  const providerWindows = providersToday.slice(0, 4).map((p) => ({
    key: p.key,
    h5: sumSinceFor(5, p.key),
    d1: sumSinceFor(24, p.key),
    d7: sumSinceFor(168, p.key),
  }));

  // ---- Claude/Codex-style 5h session blocks -----------------------------------
  // Measured locally from activity clusters: a new block starts after >=5h of
  // silence, each block spans exactly 5h from its first active hour. This is
  // a model of how session windows behave — stated here, not hidden.
  const sessionBlockFor = (provider, label) => {
    const cutoff48Key = new Date(nowMs + tzOffsetMinutes * 60000 - 48 * 3600000)
      .toISOString().slice(0, 13) + ':00';
    const GAP = 5 * 3600000;
    const keyToMs = (k) => Date.parse(`${k}:00:00Z`) - tzOffsetMinutes * 60000;
    const msToKey = (ms) => {
      const local = new Date(ms + tzOffsetMinutes * 60000);
      return `${local.toISOString().slice(0, 10)}T${String(local.getUTCHours()).padStart(2, '0')}`;
    };
    const active = [];
    for (const r of ix.rows) {
      if (r[ix.d.p] !== provider) continue;
      const t = r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
      if (!(t > 0)) continue;
      const k = `${r[ix.d.d]}T${String(r[ix.d.h]).padStart(2, '0')}`;
      if (k >= cutoff48Key.slice(0, 16)) active.push(k);
    }
    active.sort();
    let startMs = null; let endActiveMs = null;
    for (const k of active) {
      const ms = keyToMs(k);
      if (startMs === null || ms - endActiveMs >= GAP) startMs = ms;
      endActiveMs = ms;
    }
    if (startMs === null) return null;
    const resetsInMs = Math.max(0, startMs + GAP - nowMs);
    const rows = ix.rows.filter((r) => {
      const k = `${r[ix.d.d]}T${String(r[ix.d.h]).padStart(2, '0')}`;
      return r[ix.d.p] === provider && k >= msToKey(startMs);
    });
    const m = finalize(sumRows(rows, ix));
    return {
      key: provider,
      label,
      startMs,
      resetsInMs,
      windowTokens: m.total,
      windowRequests: m.req,
      windowCost: m.costReq > 0 ? m.cost : null,
      blocksToday: blocksTodayCount(active, keyToMs, GAP),
    };
  };
  function blocksTodayCount(activeKeys, keyToMs, gap) {
    let count = 0; let prevEnd = null;
    for (const k of activeKeys) {
      const ms = keyToMs(k);
      if (prevEnd === null || ms - prevEnd >= gap) count++;
      prevEnd = ms;
    }
    return count;
  }
  const sessionBlocks = [
    sessionBlockFor('anthropic', 'Claude'),
    sessionBlockFor('openai', 'Codex'),
  ].filter(Boolean);

  // ---- velocity: today's pace vs your trailing-14-day average -----------------
  const trailing14 = v.daily.slice(-15, -1);
  const avgDaily14 = trailing14.length
    ? trailing14.reduce((a, d) => a + (d.total || 0), 0) / trailing14.length
    : null;
  const hoursElapsedToday = Math.max(((nowMs / 60000 + tzOffsetMinutes) % 1440) / 60, 0.25);
  const velocity = {
    todayTokensPerHour: todayM.total / hoursElapsedToday,
    avgTokensPerHour: avgDaily14 !== null ? avgDaily14 / 24 : null,
    ratio: avgDaily14 > 0 ? (todayM.total / hoursElapsedToday) / (avgDaily14 / 24) : null,
  };

  // ---- recent days for sparklines + milestones -------------------------------
  const recentDays = v.daily.slice(-14).map((d) => ({
    key: d.key,
    total: d.total || 0,
    cost: Number(d.cost) || 0,
    active: !!d.tokenActive,
  }));
  const milestones = detectMilestones(v.daily);

  const lastRefresh = b.meta.lastRefresh || null;
  const ageMs = lastRefresh ? Math.max(0, nowMs - new Date(lastRefresh).getTime()) : null;
  const staleAfterMs = (config.watch?.staleAfterSeconds ?? 600) * 1000;

  // A second, record-level pass: the cube above is pre-aggregated and carries
  // no session id, branch or per-turn guard verdict, so live sessions,
  // today's receipts, guard state and sparklines are derived straight from
  // the store's shard files rather than from `b.cube`.
  const recent = buildRecentActivity({
    pricing: b.pricing,
    guardPolicy: config.guard || {},
    referenceMs: lastRefresh ? new Date(lastRefresh).getTime() : nowMs,
    lastRefresh,
    today,
    tzOffsetMinutes,
  });

  return {
    schema: STATUS_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    appVersion: b.meta.appVersion,
    demo: b.meta.demo,
    timezone: b.meta.timezone,
    freshness: {
      lastRefresh,
      ageMs,
      staleAfterMs,
      stale: ageMs === null ? true : ageMs > staleAfterMs,
      computeMs: Date.now() - nowMs > 0 ? Date.now() - nowMs : null,
    },
    health: {
      records: b.health.records,
      sessions: b.health.sessions,
      grade: b.health.grade,
      coverage: b.health.coverage,
    },
    usage: {
      today: usageSlice(todayM, { date: today, sessions: filterSessions(b.sessions, { from: today, to: today, includeOverlay }).length }),
      yesterday: usageSlice(yesterdayM, { date: yesterday }),
      weekToDate: usageSlice(wtdM),
      monthToDate: usageSlice(mtdM),
    },
    providersToday,
    modelsToday,
    sourcesToday,
    windows,
    providerWindows,
    velocity,
    sessionBlocks,
    recentDays,
    milestones,
    capacity: {
      summary: trimSummary(v.capacity.summary),
      states: v.capacity.states.map(trimLimitState),
      invalidCount: v.capacity.invalid.length,
    },
    forecast: v.forecast,
    anomalies: v.anomalies.slice(0, 8).map((a) => ({
      id: a.id, type: a.type, date: a.date, severity: a.severity, detail: a.detail,
    })),
    firstSeen: v.firstSeen,
    insights: v.insights.slice(0, 3).map((i) => ({ icon: i.icon, text: i.text })),
    liveSessions: recent.liveSessions,
    receiptsToday: recent.receiptsToday,
    guard: recent.guard,
    sparklines: recent.sparklines,
  };
}

function trimSummary(s) {
  if (!s) return s;
  return {
    anyExceeded: s.anyExceeded,
    anyWarn: s.anyWarn,
    counts: s.counts ?? null,
    worst: s.worst ? trimLimitState(s.worst) : null,
    firstToHit: s.firstToHit ? trimLimitState(s.firstToHit) : null,
  };
}

function trimLimitState(s) {
  return {
    id: s.id, label: s.label, scope: s.scope, metric: s.metric,
    provider: s.provider, model: s.model, project: s.project,
    used: s.used, cap: s.cap, remaining: s.remaining, pctUsed: s.pctUsed,
    status: s.status, unit: s.unit,
    burn: s.burn,
    etaHours: s.etaHours, etaVia: s.etaVia,
    resetsAtMs: s.resetsAtMs, resetsInMs: s.resetsInMs,
  };
}

// ------------------------------------------------------- recent activity ----

/** Sessions "live" within this many minutes of `asOf` show up in `liveSessions`. */
const LIVE_WINDOW_MINUTES = 10;
/** Hourly sparkline depth. */
const SPARK_HOURS = 24;
/** `liveSessions.sessions` is capped here — a menu bar row, not a table. */
const MAX_LIVE_SESSIONS = 8;

/** `YYYY-MM` shard key a UTC instant falls into, in a timezone `offsetMinutes` east of UTC. */
function monthKeyOf(ms, offsetMs) {
  return new Date(ms + offsetMs).toISOString().slice(0, 7);
}

/**
 * Start-of-local-hour instant (as a UTC epoch ms) containing `ms`, in a
 * timezone `offsetMs` (== tzOffsetMinutes*60000) east of UTC. Like the
 * hour-granular windows above, this is a fixed-offset approximation — a
 * timezone whose offset changes (DST) mid-window is not modelled.
 */
function hourStartMs(ms, offsetMs) {
  return Math.floor((ms + offsetMs) / 3600000) * 3600000 - offsetMs;
}

const GUARD_LEVEL_RANK = { ok: 0, warn: 1, block: 2 };

/**
 * Most recently modified guard-cache file's verdict, if the cache stores one.
 *
 * As of this writing `tokenflow guard`'s cache (`$TOKENFLOW_HOME/guard/*.json`,
 * see `src/commands/guard.js`) persists `{offset, state, records, updated}` —
 * no verdict — so this always falls through to `null` today; the read stays
 * here so a future cache format that adds one is picked up without a change
 * here, and `lastVerdict.source` tells a reader which path produced it.
 * @returns {{level:string, sessionId:string|null, at:string|null, reasons:string[], source:'cache'}|null}
 */
function readGuardCacheVerdict() {
  const dir = path.join(paths().root, 'guard');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  let latest = null;
  let latestMtime = -1;
  for (const f of files) {
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = f; }
  }
  if (!latest) return null;
  const data = readJson(path.join(dir, latest), null);
  if (!data || !data.verdict) return null;
  const v = data.verdict;
  return {
    level: v.level ?? 'ok',
    sessionId: v.sessionId ?? data.records?.[0]?.session_id ?? null,
    at: data.updated ?? null,
    reasons: Array.isArray(v.reasons) ? v.reasons : [],
    source: 'cache',
  };
}

/**
 * Live sessions, today's receipts, guard state and hourly sparklines.
 *
 * A second, record-level scan of the store (the cube `buildLiveStatus` reads
 * above is pre-aggregated and has no session id, branch or per-turn guard
 * verdict). Restricted to the shards the window can touch — current +
 * previous month by `referenceMs`, plus `today`'s month if a stale
 * `lastRefresh` has drifted away from it — and within those shards, to
 * records timestamped in the last `SPARK_HOURS` hours (sessions + sparklines)
 * or dated `today` in the dataset timezone (receipts).
 *
 * "Live" and every `asOf` here anchor on `referenceMs` (the store's last
 * refresh, falling back to the current clock only when it has never
 * refreshed) rather than the real clock: a reader of this file is only ever
 * as current as the last completed refresh, and the field name says so
 * rather than quietly assuming "now".
 *
 * @param {{pricing:object, guardPolicy:object, referenceMs:number,
 *   lastRefresh:string|null, today:string, tzOffsetMinutes:number}} opt
 */
export function buildRecentActivity(opt) {
  const { pricing, guardPolicy, referenceMs, lastRefresh, today, tzOffsetMinutes: tzOff } = opt;
  const offsetMs = (tzOff || 0) * 60000;
  const book = buildPriceBook(pricing || {});
  const store = new Store();

  const firstBucket = hourStartMs(referenceMs, offsetMs) - (SPARK_HOURS - 1) * 3600000;
  const liveCutoffMs = referenceMs - LIVE_WINDOW_MINUTES * 60000;
  const months = [...new Set([
    monthKeyOf(firstBucket, offsetMs),
    monthKeyOf(referenceMs, offsetMs),
    today.slice(0, 7),
  ])];

  /** @type {Map<string, {tokens:number[], cost:number[]}>} */
  const perSource = new Map();
  const sessions = new Map();
  const receiptBuilder = createReceiptBuilder({
    book,
    repoOf: (rec) => {
      const raw = rec.repository || rec.project;
      return raw ? path.basename(raw) : null;
    },
  });

  store.scanRecords((o) => {
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    const ts = Date.parse(o.ts);
    if (!Number.isFinite(ts)) return;
    if (o.d === today) receiptBuilder.add(decodeRecord(o));

    if (ts < firstBucket || ts > referenceMs) return;
    const src = o.so || 'unknown';
    let sp = perSource.get(src);
    if (!sp) { sp = { tokens: new Array(SPARK_HOURS).fill(0), cost: new Array(SPARK_HOURS).fill(0) }; perSource.set(src, sp); }
    const idx = Math.round((hourStartMs(ts, offsetMs) - firstBucket) / 3600000);
    if (idx >= 0 && idx < SPARK_HOURS) {
      sp.tokens[idx] += (o.in || 0) + (o.ou || 0) + (o.cr || 0) + (o.cw || 0);
      if (o.co !== null && o.co !== undefined && o.cb !== 'measured') sp.cost[idx] += o.co;
    }

    if (!o.s) return; // no session id: still in the sparklines/receipts above, never a "live session"
    let e = sessions.get(o.s);
    if (!e) { e = { records: [], maxTs: -Infinity }; sessions.set(o.s, e); }
    e.records.push(decodeRecord(o));
    if (ts > e.maxTs) e.maxTs = ts;
  }, { months });

  // ---- live sessions ----------------------------------------------------
  const liveEntries = [...sessions.entries()]
    .filter(([, e]) => e.maxTs >= liveCutoffMs)
    .sort((a, b) => b[1].maxTs - a[1].maxTs)
    .slice(0, MAX_LIVE_SESSIONS);

  const liveSessionsList = liveEntries.map(([sid, e]) => {
    const recs = e.records.slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const last = recs[recs.length - 1];
    const v = evaluateGuard(recs, guardPolicy || {}, book);
    return {
      sessionId: sid,
      source: last.source ?? null,
      provider: last.provider ?? null,
      model: last.model ?? null,
      project: last.project ?? null,
      repository: last.repository ? path.basename(last.repository) : null,
      branch: last.git_branch ?? null,
      startedAt: v.first,
      lastActivityAt: v.last,
      turns: v.turns,
      subagentTurns: v.subagentTurns,
      costUsd: v.cost,
      coverage: v.coverage,
      contextTokens: v.contextTokens,
      contextShare: v.contextShare,
      guard: { level: v.level, reasons: v.reasons, declared: v.declared },
    };
  });

  // ---- today's receipts ---------------------------------------------------
  const receipts = receiptBuilder.finish();
  const items = [];
  for (const R of receipts.repos) {
    for (const br of R.branches) items.push({ repo: R.repo, branch: br.key, costUsd: br.cost, turns: br.turns, sessions: br.sessions });
    if (R.unattributed.turns > 0) {
      items.push({ repo: R.repo, branch: null, costUsd: R.unattributed.cost, turns: R.unattributed.turns, sessions: R.unattributed.sessions });
    }
  }
  items.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

  // ---- guard ----------------------------------------------------------------
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const gp = guardPolicy || {};
  const policy = {
    warnCostUsd: numOrNull(gp.warnCostUsd),
    maxCostUsd: numOrNull(gp.maxCostUsd),
    warnContextTokens: numOrNull(gp.warnContextTokens),
    maxContextTokens: numOrNull(gp.maxContextTokens),
    warnMarginalUsd: numOrNull(gp.warnMarginalUsd),
  };
  const declared = Object.values(policy).some((val) => val !== null);

  /** @type {{level:string, sessionId:string|null, at:string|null, reasons:string[], source:'cache'|'derived'}|null} */
  let lastVerdict = readGuardCacheVerdict();
  if (!lastVerdict) {
    let worst = null;
    for (const s of liveSessionsList) {
      if (!worst || GUARD_LEVEL_RANK[s.guard.level] > GUARD_LEVEL_RANK[worst.guard.level]) worst = s;
    }
    lastVerdict = worst
      ? { level: worst.guard.level, sessionId: worst.sessionId, at: worst.lastActivityAt, reasons: worst.guard.reasons, source: 'derived' }
      : null;
  }

  return {
    liveSessions: { asOf: lastRefresh, windowMinutes: LIVE_WINDOW_MINUTES, sessions: liveSessionsList },
    receiptsToday: { asOf: lastRefresh, totalCostUsd: receipts.totals.cost, items: items.slice(0, 3) },
    guard: { policy, declared, lastVerdict },
    sparklines: {
      hours: Array.from({ length: SPARK_HOURS }, (_, i) => new Date(firstBucket + i * 3600000).toISOString()),
      bySource: Object.fromEntries([...perSource].map(([k, v]) => [k, v.tokens])),
      costBySource: Object.fromEntries([...perSource].map(([k, v]) => [k, v.cost.map((n) => Math.round(n * 100) / 100)])),
    },
  };
}

/** Atomic write: tmp file + rename, so readers never see a half-file. */
export function writeLiveStatus(status) {
  const p = paths();
  ensureDirs();
  const tmp = `${p.status}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, p.status);
  return p.status;
}

/** Latest written status, or null when absent/corrupt (never throws). */
export function readLiveStatus() {
  try {
    return JSON.parse(fs.readFileSync(paths().status, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Recompute freshness against the CURRENT clock.
 *
 * A stored status file carries the staleness verdict of the moment it was
 * written — left alone, "updated just now" stays true forever while the data
 * underneath quietly ages. Every read path passes through here so "fresh"
 * always means fresh right now.
 */
export function withComputedFreshness(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') return status;
  const f = status.freshness || {};
  const lastRefresh = f.lastRefresh ?? null;
  const ageMs = lastRefresh ? Math.max(0, nowMs - new Date(lastRefresh).getTime()) : null;
  const staleAfterMs = f.staleAfterMs ?? 600000;
  return {
    ...status,
    freshness: { ...f, ageMs, staleAfterMs, stale: ageMs === null ? true : ageMs > staleAfterMs },
  };
}

/**
 * Freshness-aware status for live surfaces: prefer the watch daemon's file,
 * fall back to computing fresh right now. Returns `{status, fromWatch}`.
 *
 * The cache window derives from the watcher's own cadence (interval + slack),
 * because a snapshot written 90 seconds into a 120-second cycle is exactly as
 * current as the product promised — not stale. When a fallback compute does
 * happen, daemon identity (pid, cycles) is carried over from the cached file
 * so a slow poll never makes the UI claim no watcher is running — but only
 * while the watcher lock is actually live, so a dead daemon's identity does
 * not linger either.
 */
export function currentStatus(opt = {}) {
  const cached = readLiveStatus();
  const cfg = opt.config || loadConfig();
  const maxAgeMs = opt.maxAgeMs
    ?? ((cfg.watch?.intervalSeconds ?? 120) * 1000) + 60000;
  if (cached && !withComputedFreshness(cached).freshness.stale) {
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    if (age <= maxAgeMs) return { status: withComputedFreshness(cached), fromWatch: true };
  }
  const fresh = buildLiveStatus({ config: cfg });
  // Carry daemon identity over ONLY while THAT daemon is really there. A
  // watcher block outlives the process that wrote it, and repeating it after
  // the watcher died is how a paused TokenFlow came to look live. Matching the
  // pid against the lock holder also stops a restarted watcher from being
  // described with its predecessor's pid and cycle count.
  const lock = readLock();
  if (cached?.watcher && lockIsLive(lock) && cached.watcher.pid === lock.pid) {
    fresh.watcher = cached.watcher;
  }
  if (!fresh.lastCycle && cached?.lastCycle) fresh.lastCycle = cached.lastCycle;
  if (!fresh.lastError && cached?.lastError) fresh.lastError = cached.lastError;
  return { status: fresh, fromWatch: false };
}

// ---------------------------------------------------------------- format ----

/**
 * The one-line menu-bar summary.
 *
 * Display modes:
 *   auto   — the most urgent signal wins: worst limit % when limits exist,
 *            else today's cost when priced, else today's tokens
 *   limit  — worst limit only (— when none configured)
 *   cost   — today's estimated cost (falls back through measured/tokens)
 *   tokens — today's total tokens
 *
 * Alert glyphs travel with their state: ⚠ approaching, ✗ exceeded.
 *
 * @returns {{text:string, tooltip:string}} empty text when there is nothing honest to show
 */
export function barLine(status, mode = 'auto', prefix = 'TF') {
  const parts = [];
  const warnGlyph = (s) => (s === 'exceeded' ? '✗ ' : s === 'warn' ? '⚠ ' : '');

  const worst = status.capacity?.summary?.worst || null;
  const showLimit = mode === 'limit' || ((mode === 'auto') && worst && worst.pctUsed !== null);
  if (mode === 'limit' && (!worst || worst.pctUsed === null)) {
    return { text: `${prefix} —`, tooltip: 'No limits configured' };
  }
  if (showLimit && worst && worst.pctUsed !== null) {
    const pctText = `${Math.round(worst.pctUsed * 100)}%`;
    const resetIn = countdown(worst.resetsInMs);
    parts.push(`${warnGlyph(worst.status)}${worst.label} ${pctText}${resetIn ? ` · ${resetIn}` : ''}`);
  }

  const t = status.usage?.today;
  if (!t) return { text: `${prefix} —`, tooltip: 'No data yet' };

  if (mode === 'cost' || (mode === 'auto' && !showLimit)) {
    const c = t.cost ?? t.costMeasured;
    if (c !== null && c !== undefined) parts.push(money(c));
  }
  if (mode === 'tokens' || ((mode === 'auto' || mode === 'cost') && parts.length === 0)) {
    const todayTotal = t.tokens?.total ?? 0;
    if (todayTotal > 0 || mode !== 'auto') {
      parts.push(compactTokens(todayTotal));
    } else if ((status.usage?.weekToDate?.tokens?.total ?? 0) > 0) {
      // A day that simply hasn't started yet is not a zero-usage day; say what
      // the week looks like instead of showing a misleading "0".
      parts.push(`7d ${compactTokens(status.usage.weekToDate.tokens.total)}`);
    } else {
      parts.push('0');
    }
  }

  if (!parts.length) return { text: `${prefix} —`, tooltip: 'Nothing measurable today' };
  return {
    text: `${prefix} ${parts.join(' · ')}`,
    tooltip: tooltipFor(status),
  };
}

function tooltipFor(status) {
  const u = status.usage?.today || {};
  const bits = [];
  bits.push(`Today ${compactTokens(u.tokens?.total ?? 0)} tokens`);
  const c = u.cost ?? u.costMeasured;
  if (c != null) bits.push(money(c));
  if (status.usage?.weekToDate?.tokens?.total != null) {
    bits.push(`Week ${compactTokens(status.usage.weekToDate.tokens.total)}`);
  }
  const f = status.freshness;
  if (f?.stale) bits.push(`data stale (${countdown(f.ageMs) ?? 'unknown'} old)`);
  else if (f?.lastRefresh) bits.push(`updated ${new Date(f.lastRefresh).toLocaleTimeString()}`);
  return bits.join(' · ');
}

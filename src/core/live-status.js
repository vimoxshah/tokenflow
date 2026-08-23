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
import { readJson } from './store.js';
import { compact, usd, countdown } from './units.js';
import { detectMilestones } from '../analytics/milestones.js';

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
  const b = opt.bundle || buildBundle({ config });
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
 * happen, daemon identity (pid, cycles, last error) is carried over from the
 * cached file: a slow poll must never make the UI claim no watcher is running.
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
  if (cached?.watcher) fresh.watcher = cached.watcher;
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

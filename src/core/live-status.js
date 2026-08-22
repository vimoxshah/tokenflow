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
  const includeOverlay = !!b.meta.includeOverlayDefault;

  const measuresFor = (from, to) =>
    finalize(sumRows(filterCube(ix, { from, to, includeOverlay }), ix));
  const todayM = measuresFor(today, today);
  const yesterday = addDays(today, -1);
  const yesterdayM = measuresFor(yesterday, yesterday);
  const wtdM = measuresFor(weekStart(today), today);
  const mtdM = measuresFor(`${today.slice(0, 7)}-01`, today);

  const todayRows = filterCube(ix, { from: today, to: today, includeOverlay });
  const providersToday = rank(todayRows, ix, (r) => r[ix.d.p]).slice(0, 5)
    .map((g) => ({ key: g.key, tokens: g.m.total, requests: g.m.req, ...costOf(g.m) }));
  const modelsToday = rank(todayRows, ix, (r) => r[ix.d.m]).slice(0, 5)
    .map((g) => ({ key: g.key, tokens: g.m.total, requests: g.m.req, ...costOf(g.m) }));

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
 */
export function currentStatus({ maxAgeMs = 15000 } = {}) {
  const cached = readLiveStatus();
  if (cached && !cached.freshness?.stale) {
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    if (age <= maxAgeMs) return { status: withComputedFreshness(cached), fromWatch: true };
  }
  return { status: buildLiveStatus(), fromWatch: false };
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

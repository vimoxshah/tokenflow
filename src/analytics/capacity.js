/**
 * Capacity planning over user-declared limits.
 *
 * The engine never invents vendor quota data — no screen here claims to know
 * what Anthropic or OpenAI think your remaining balance is. Instead this module
 * answers the question with data TokenFlow actually has: a limit you declared
 * in config, evaluated against the measured consumption in the store.
 *
 * ```yaml
 * limits:
 *   - id: anthropic-monthly
 *     provider: anthropic        # optional cube filters: provider | model | project
 *     scope: month               # day | week | month
 *     metric: tokens             # tokens | input | output | requests | cost
 *     cap: 120000000             # tokens (or dollars when metric: cost)
 *     warnAt: 0.8                # optional warn threshold, default 0.8
 * ```
 *
 * From that it derives, per limit: consumption in the current window, percent
 * used, remaining capacity, burn rate (today's hourly pace and the trailing
 * 7-day average), projected exhaustion, and exactly when the window resets.
 *
 * Pure module: all wall-clock facts enter through arguments (`nowMs`,
 * `tzOffsetMinutes`, `today`) so results are testable and identical across
 * CLI, server and browser.
 */
import { indexCube, filterCube, sumRows, finalize, weekStart } from './aggregate.js';

export const LIMIT_SCOPES = /** @type {const} */ ({ DAY: 'day', WEEK: 'week', MONTH: 'month' });
export const LIMIT_METRICS = /** @type {const} */ ({
  TOKENS: 'tokens', INPUT: 'input', OUTPUT: 'output', REQUESTS: 'requests', COST: 'cost',
});

/** Validate one limit definition from config. @returns {{ok:boolean, errors:string[], value?:object}} */
export function normalizeLimit(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['limit must be an object'] };
  const id = typeof def.id === 'string' && def.id.trim() ? def.id.trim() : null;
  if (!id) errors.push('id is required');
  const scope = String(def.scope || '').toLowerCase();
  const knownScopes = /** @type {string[]} */ (Object.values(LIMIT_SCOPES));
  if (!knownScopes.includes(scope)) {
    errors.push(`scope must be one of ${knownScopes.join(' | ')}`);
  }
  const metric = String(def.metric || LIMIT_METRICS.TOKENS).toLowerCase();
  const knownMetrics = /** @type {string[]} */ (Object.values(LIMIT_METRICS));
  if (!knownMetrics.includes(metric)) {
    errors.push(`metric must be one of ${knownMetrics.join(' | ')}`);
  }
  const cap = Number(def.cap);
  if (!Number.isFinite(cap) || cap <= 0) errors.push('cap must be a positive number');
  let warnAt = def.warnAt === undefined || def.warnAt === null ? 0.8 : Number(def.warnAt);
  if (!Number.isFinite(warnAt) || warnAt <= 0 || warnAt > 1) errors.push('warnAt must be a fraction between 0 and 1');
  for (const k of ['provider', 'model', 'project']) {
    if (def[k] !== undefined && def[k] !== null && typeof def[k] !== 'string') {
      errors.push(`${k} must be a string`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      id,
      label: typeof def.label === 'string' && def.label.trim() ? def.label.trim() : id,
      scope,
      metric,
      cap,
      warnAt,
      provider: def.provider ?? null,
      model: def.model ?? null,
      project: def.project ?? null,
    },
  };
}

/** Validate a whole limits array. Used by config import + the settings dialog. */
export function normalizeLimits(list) {
  const out = [];
  const invalid = [];
  if (!Array.isArray(list)) return { limits: out, invalid };
  const seen = new Set();
  list.forEach((def, i) => {
    const v = normalizeLimit(def);
    if (!v.ok) { invalid.push({ index: i, id: def?.id ?? null, errors: v.errors }); return; }
    if (seen.has(v.value.id)) {
      invalid.push({ index: i, id: v.value.id, errors: ['duplicate id'] });
      return;
    }
    seen.add(v.value.id);
    out.push(v.value);
  });
  return { limits: out, invalid };
}

/**
 * Local midnight of `iso` expressed as a UTC epoch ms, given the timezone's
 * offset in minutes east of UTC. This is the anchor for every reset countdown:
 * a window ends when the *user's* calendar rolls over, not the machine's.
 */
export function localMidnightMs(iso, tzOffsetMinutes) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - tzOffsetMinutes * 60000;
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** @param {string} scope @param {string} todayIso */
export function windowFor(scope, todayIso) {
  switch (scope) {
    case LIMIT_SCOPES.DAY: return { from: todayIso, to: todayIso };
    case LIMIT_SCOPES.WEEK: return { from: weekStart(todayIso), to: todayIso };
    case LIMIT_SCOPES.MONTH: return { from: `${todayIso.slice(0, 7)}-01`, to: todayIso };
    default: throw new Error(`unknown scope ${scope}`);
  }
}

/** When the current window ends, as UTC ms + a human interval. */
export function resetFor(scope, todayIso, tzOffsetMinutes, nowMs) {  const midnight = localMidnightMs(todayIso, tzOffsetMinutes);
  let end;
  if (scope === LIMIT_SCOPES.DAY) {
    end = localMidnightMs(addDaysISO(todayIso, 1), tzOffsetMinutes);
  } else if (scope === LIMIT_SCOPES.WEEK) {
    end = localMidnightMs(addDaysISO(weekStart(todayIso), 7), tzOffsetMinutes);
  } else {
    const nextMonth = addDaysISO(`${todayIso.slice(0, 7)}-01`, 32).slice(0, 7) + '-01';
    end = localMidnightMs(nextMonth, tzOffsetMinutes);
  }
  return { atMs: end, inMs: Math.max(0, end - nowMs), midnightMs: midnight };
}

/** @param {object} m @param {string} metric */
function usedFromMeasures(m, metric) {
  switch (metric) {
    case LIMIT_METRICS.INPUT: return { used: m.in, unit: 'tokens' };
    case LIMIT_METRICS.OUTPUT: return { used: m.out, unit: 'tokens' };
    case LIMIT_METRICS.REQUESTS: return { used: m.req, unit: 'requests' };
    case LIMIT_METRICS.COST: return { used: m.cost, unit: 'usd' };
    case LIMIT_METRICS.TOKENS:
    default: return { used: m.total, unit: 'tokens' };
  }
}

/**
 * Evaluate every configured limit against the dataset.
 *
 * @param {object[]} rawLimits limit definitions straight from config
 * @param {{
 *   cube: object, today: string, nowMs?: number, tzOffsetMinutes?: number,
 *   coverageFrom?: string | null,
 * }} p
 *   `coverageFrom` (optional, YYYY-MM-DD) trims the trailing-burn denominator
 *    when the dataset is younger than the 7-day window, so a three-day-old
 *    store does not understate its own pace.
 */
export function evaluateLimits(rawLimits, p) {
  const { limits, invalid } = normalizeLimits(rawLimits);
  const nowMs = p.nowMs ?? Date.now();
  const tzOff = p.tzOffsetMinutes ?? 0;
  const states = [];
  if (!limits.length) return { states, invalid };

  const ix = indexCube(p.cube);
  const trailingTo = addDaysISO(p.today, -1);
  const trailingFrom = addDaysISO(p.today, -7);
  // Quota pacing does not pause on weekends, so zeros count — but a store with
  // less history than the window must not dilute its own burn rate with days
  // it could not possibly have measured.
  const effectiveFrom = p.coverageFrom && p.coverageFrom > trailingFrom ? p.coverageFrom : trailingFrom;
  const basisDays = Math.max(1, daysInclusive(effectiveFrom, trailingTo));

  for (const lim of limits) {
    const scopeFilters = {
      provider: lim.provider ? [lim.provider] : null,
      model: lim.model ? [lim.model] : null,
      project: lim.project ? [lim.project] : null,
    };
    const win = windowFor(lim.scope, p.today);
    const rows = filterCube(ix, {
      from: win.from, to: win.to, includeOverlay: false, ...scopeFilters,
    });
    const m = finalize(sumRows(rows, ix));
    const { used, unit } = usedFromMeasures(m, lim.metric);

    const pctUsed = lim.cap > 0 ? used / lim.cap : null;
    let status = 'unknown';
    if (pctUsed !== null) status = pctUsed >= 1 ? 'exceeded' : pctUsed >= lim.warnAt ? 'warn' : 'ok';

    // Today's slice for the hourly burn (same filters, single day).
    const todayRows = filterCube(ix, {
      from: p.today, to: p.today, includeOverlay: false, ...scopeFilters,
    });
    const tm = finalize(sumRows(todayRows, ix));
    const todayUsed = usedFromMeasures(tm, lim.metric).used;

    const localMinutes = ((nowMs / 60000 + tzOff) % 1440 + 1440) % 1440;
    const hoursElapsed = Math.max(localMinutes / 60, 0.25); // floor avoids a midnight divide-by-zero
    const burnPerHour = todayUsed > 0 ? todayUsed / hoursElapsed : 0;

    const trailRows = filterCube(ix, {
      from: effectiveFrom, to: trailingTo, includeOverlay: false, ...scopeFilters,
    });
    const trailM = finalize(sumRows(trailRows, ix));
    const burnPerDay = usedFromMeasures(trailM, lim.metric).used / basisDays;

    const remaining = Math.max(0, lim.cap - used);
    const eta = exhaustionFor(remaining, burnPerHour, burnPerDay);
    const reset = resetFor(lim.scope, p.today, tzOff, nowMs);

    states.push({
      ...lim,
      unit,
      window: win,
      used,
      remaining,
      pctUsed,
      status,
      requests: m.req,
      ...(lim.metric === LIMIT_METRICS.COST
        ? { priceCoverage: m.req ? m.costReq / m.req : null }
        : {}),
      burn: {
        perHourToday: burnPerHour || null,
        perDayTrailing: burnPerDay || null,
        basisDays,
      },
      etaHours: eta ? eta.hours : null,
      etaVia: eta ? eta.via : null,
      resetsAtMs: reset.atMs,
      resetsInMs: reset.inMs,
    });
  }

  states.sort((a, b) => urgency(b) - urgency(a));
  return { states, invalid };
}

function daysInclusive(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

function exhaustionFor(remaining, burnPerHour, burnPerDay) {
  if (!(remaining > 0)) return null;
  if (burnPerHour > 0 && Number.isFinite(burnPerHour)) return { hours: remaining / burnPerHour, via: 'hourly' };
  if (burnPerDay !== null && burnPerDay > 0) return { hours: (remaining / burnPerDay) * 24, via: 'daily' };
  return null;
}

function urgency(s) {
  if (s.status === 'exceeded') return 1000;
  const base = (s.pctUsed ?? 0) * 100;
  // A limit that will be crossed before its reset outranks one that will not.
  const beforeReset = s.etaHours !== null && s.resetsInMs > 0 && s.etaHours * 3600000 <= s.resetsInMs ? 200 : 0;
  return base + beforeReset;
}

/** Cross-limit rollup for headers and menu bars. */
export function summarizeCapacity(states) {
  if (!states.length) return { anyExceeded: false, anyWarn: false, worst: null, firstToHit: null };
  const exceeded = states.filter((s) => s.status === 'exceeded');
  const warned = states.filter((s) => s.status === 'warn');
  const firstToHit = states
    .filter((s) => s.status !== 'exceeded' && s.etaHours !== null && s.resetsInMs > 0 && s.etaHours * 3600000 <= s.resetsInMs)
    .sort((a, b) => a.etaHours - b.etaHours)[0] || null;
  return {
    anyExceeded: exceeded.length > 0,
    anyWarn: warned.length > 0,
    worst: states[0],
    firstToHit,
    counts: { total: states.length, exceeded: exceeded.length, warn: warned.length },
  };
}

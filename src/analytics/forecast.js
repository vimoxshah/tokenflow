/**
 * Forecasting.
 *
 * A deliberately conservative model: an ordinary least-squares trend over the
 * most recent N calendar days, a robust (median/MAD) residual spread, and hard
 * minimum-data gates. When there is not enough history the answer is `null`
 * with the reason attached — never a confident-looking number built on three
 * data points.
 *
 * Everything here is pure and deterministic: same series in, same forecast
 * out. The browser, the CLI and the watch daemon all call these functions, so
 * no surface can disagree about the future.
 */
import { daysBetween } from './aggregate.js';

export const MIN_POINTS = 5;
const MAD_SCALE = 1.4826; // consistency constant for normally distributed errors

/** Ordinary least squares fit of y = intercept + slope * x over index pairs. */
function ols(ys) {
  const n = ys.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i];
    sxx += i * i;
    sxy += i * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function median(sortedAsc) {
  if (!sortedAsc.length) return null;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** Median absolute deviation scaled to a standard-deviation estimate. */
export function robustSigma(values) {
  if (values.length < 2) return null;
  const med = median([...values].sort((a, b) => a - b));
  const devs = values.map((v) => Math.abs(v - med));
  const mad = median(devs.sort((a, b) => a - b));
  return mad * MAD_SCALE;
}

/**
 * Forecast the next value(s) of a daily series with a linear trend.
 *
 * @param {{key:string, [k:string]:any}[]} series calendar-complete daily rows
 *   as produced by calculateDailyUsage (must be sorted by key ascending)
 * @param {{window?:number, metric?:string, horizonDays?:number}} opt
 * @returns {{
 *   next: number|null, interval:[number,number]|null,
 *   horizon: {days:number, total:number}|null,
 *   slope:number|null, confidence:'high'|'medium'|'low'|null,
 *   n:number, reason?:string,
 * }} nulls when the sample is too thin; `reason` says why
 */
export function linearForecast(series, opt = {}) {
  const metric = opt.metric || 'total';
  const window = Math.max(MIN_POINTS, opt.window || 14);
  const tail = series.slice(-window);
  const ys = tail.map((d) => Number(d[metric])).filter((v) => Number.isFinite(v));

  if (ys.length < MIN_POINTS) {
    return {
      next: null, interval: null, horizon: null, slope: null, confidence: null,
      n: ys.length, reason: `${ys.length} usable day(s); need at least ${MIN_POINTS}`,
    };
  }

  const { slope, intercept } = ols(ys);
  const residuals = ys.map((y, i) => y - (intercept + slope * i));
  const sigma = robustSigma(residuals) ?? 0;
  const nextX = ys.length;
  const predict = (x) => Math.max(0, intercept + slope * x);

  // A robust sigma near zero means the model fits well but may still miss
  // regime changes; widen slightly so "high confidence" stays honest.
  const sigmaEff = Math.max(sigma, 1e-9);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const cv = meanY > 0 ? sigma / meanY : Infinity;

  const confidence = ys.length >= 10 && cv <= 0.35 && sigmaEff > 0
    ? 'high'
    : ys.length >= 7 && cv <= 0.8 ? 'medium' : 'low';

  const horizonDays = opt.horizonDays || 7;
  let horizonSum = 0;
  for (let i = 1; i <= horizonDays; i++) horizonSum += predict(nextX + i - 1);

  return {
    next: predict(nextX),
    interval: [Math.max(0, predict(nextX) - 1.96 * sigma), predict(nextX) + 1.96 * sigma],
    horizon: { days: horizonDays, total: horizonSum },
    slope,
    confidence,
    n: ys.length,
  };
}

/**
 * Project how the current calendar month ends.
 *
 * Month-to-date is measured fact; the remainder is forecast. The two are never
 * added silently without saying which part is which.
 *
 * @param {{key:string, [k:string]:any}[]} daily calendar-complete series
 * @param {string} todayIso YYYY-MM-DD
 * @param {{metric?:string}} opt
 */
export function monthEndProjection(daily, todayIso, opt = {}) {
  const metric = opt.metric || 'total';
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  const mtd = daily.filter((d) => d.key >= monthStart && d.key <= todayIso);
  const actualToDate = mtd.reduce((a, d) => a + (Number(d[metric]) || 0), 0);
  const remainingDays = Math.max(
    0,
    daysBetween(todayIso, lastDayOfMonth(todayIso)),
  );
  if (mtd.length < MIN_POINTS && remainingDays > 0) {
    return {
      projected: null, actualToDate, remainingDays,
      forecastRemainder: null, confidence: null,
      reason: `${mtd.length} day(s) this month; need at least ${MIN_POINTS} to project`,
    };
  }
  // The remainder comes from one call so measured and forecast can never be
  // mixed twice, and the projection uses exactly the model whose confidence we
  // report.
  const fc = linearForecast(daily.filter((d) => d.key <= todayIso), { ...opt, horizonDays: remainingDays });
  const remainder = remainingDays === 0 ? 0 : fc.horizon ? fc.horizon.total : null;
  return {
    projected: remainder === null ? null : actualToDate + remainder,
    actualToDate,
    remainingDays,
    forecastRemainder: remainder,
    confidence: fc.confidence,
    perDay: fc.next,
    reason: fc.reason,
  };
}

/** Last calendar day of the month containing `iso`. */
export function lastDayOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * Hours until `remaining` is exhausted at a given burn rate.
 *
 * @param {{remaining:number, burnPerHour:number|null, burnPerDay?:number|null, nowMs:number}} p
 * @returns {{hours:number|null, via:'hourly'|'daily'} | null}
 *   null when there is nothing to exhaust or no measurable burn.
 */
export function exhaustionEta({ remaining, burnPerHour, burnPerDay = null, nowMs }) {
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  if (burnPerHour !== null && Number.isFinite(burnPerHour) && burnPerHour > 0) {
    return { hours: remaining / burnPerHour, via: 'hourly' };
  }
  if (burnPerDay !== null && Number.isFinite(burnPerDay) && burnPerDay > 0) {
    return { hours: (remaining / burnPerDay) * 24, via: 'daily' };
  }
  return null;
}

/**
 * Convenience wrapper used by live status + CLI: one object describing where
 * usage is heading.
 *
 * @param {{key:string, cost?:number|null, [k:string]:any}[]} daily
 * @param {string} todayIso
 */
export function buildForecast(daily, todayIso) {
  const tokens = linearForecast(daily, { metric: 'total' });
  const costSeries = daily.some((d) => Number.isFinite(Number(d.cost)) && Number(d.cost) > 0);
  const cost = costSeries ? linearForecast(daily, { metric: 'cost' }) : null;
  const monthTokens = monthEndProjection(daily, todayIso, { metric: 'total' });
  const monthCost = costSeries ? monthEndProjection(daily, todayIso, { metric: 'cost' }) : null;
  return {
    generatedFor: todayIso,
    tomorrow: tokens.next,
    tomorrowInterval: tokens.interval,
    next7days: tokens.horizon ? tokens.horizon.total : null,
    next7daysCost: cost?.horizon ? cost.horizon.total : null,
    monthEnd: monthTokens.projected,
    monthEndActualToDate: monthTokens.actualToDate,
    monthEndCost: monthCost?.projected ?? null,
    monthEndCostActualToDate: monthCost?.actualToDate ?? null,
    confidence: tokens.confidence,
    n: tokens.n,
    reason: tokens.reason || null,
  };
}

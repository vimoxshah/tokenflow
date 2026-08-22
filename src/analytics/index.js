/**
 * The analytics facade + plugin registry.
 *
 * `computeView(bundle, filters)` is the single entry point that turns a data
 * bundle plus a filter state into everything a dashboard needs. The browser
 * calls it on every filter change; the CLI calls it for `status`; the snapshot
 * exporter calls it once. One implementation, so the numbers can never disagree
 * between surfaces.
 *
 * ## Plugin model
 *
 * Analytics modules register themselves with `registerAnalytics({id, section,
 * compute})`. `compute` receives the fully prepared slice and returns whatever
 * shape it likes, exposed at `view.plugins[id]`. That is how cost, git,
 * carbon, team, or prompt-efficiency analytics get added later without
 * touching this file.
 */
import {
  indexCube, filterCube, filterSessions, sumRows, facet, EMPTY_FILTERS,
  weekStart, monthKey, dateRange, daysBetween, addDays,
} from './aggregate.js';
import {
  calculateDailyUsage, movingAverage, calculateAverageUsage, calculateComposition,
  calculateUsageTrend, calculateHourlyUsage, calculateDowUsage, calculateHourDow,
  calendarLevels, calculateStreaks,
} from './token-usage.js';
import {
  calculateDimensionUsage, calculateDimensionSeries, calculateDimensionGrowth,
  calculateModelEfficiency, calculateInterfaceTrend,
} from './dimensions.js';
import { calculatePeakUsage, dayDetail } from './peak.js';
import { calculateEfficiency, calculateCost, unpricedModels, calculateSessionProfile } from './efficiency.js';
import { calculatePeriodComparison, previousPeriod } from './comparison.js';
import { calculateActivityProxies, calculateWorkSeries, calculateCorrelations, calculateActivityContrast } from './productivity.js';
import { generateInsights } from './insights.js';
import { buildForecast, linearForecast, monthEndProjection, exhaustionEta } from './forecast.js';
import { detectAnomalies, firstSeenEntities } from './anomalies.js';
import { evaluateLimits, summarizeCapacity, normalizeLimits } from './capacity.js';
import { buildPriceBook } from '../core/pricing.js';

const plugins = new Map();

/** @param {{id:string, section?:string, title?:string, compute:(slice:object)=>any}} def */
export function registerAnalytics(def) {
  if (!def || !def.id || typeof def.compute !== 'function') {
    throw new Error('registerAnalytics requires { id, compute }');
  }
  plugins.set(def.id, { section: 'custom', title: def.id, ...def });
  return def;
}
export function listAnalytics() {
  return [...plugins.values()].map((p) => ({ id: p.id, section: p.section, title: p.title }));
}
export function clearAnalytics() {
  plugins.clear();
}

export const QUICK_RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'mtd', label: 'This month' },
  { id: 'lastmonth', label: 'Last month' },
  { id: 'all', label: 'All data' },
  { id: 'custom', label: 'Custom' },
];

/**
 * Resolve a quick range against the dataset's own coverage, so "last 30 days"
 * means the last 30 days of the calendar, and "all data" means exactly what is
 * in the store.
 */
export function resolveRange(id, coverage, today) {
  const to = today || coverage.to;
  const from = coverage.from;
  switch (id) {
    case 'today': return { from: to, to };
    case 'yesterday': return { from: addDays(to, -1), to: addDays(to, -1) };
    case '7d': return { from: addDays(to, -6), to };
    case '30d': return { from: addDays(to, -29), to };
    case '90d': return { from: addDays(to, -89), to };
    case 'mtd': return { from: `${to.slice(0, 7)}-01`, to };
    case 'lastmonth': {
      const first = `${to.slice(0, 7)}-01`;
      const lastMonthEnd = addDays(first, -1);
      return { from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd };
    }
    case 'all':
    default:
      return { from, to };
  }
}

/**
 * @param {{cube:object, sessions:any[], activity:object, meta?:object,
 *          pricing?:object, limits?:object[]}} bundle
 * @param {Partial<typeof EMPTY_FILTERS> & {granularity?:'day'|'week'|'month', compare?:{a:object,b:object}, drillDate?:string}} [filters]
 */
export function computeView(bundle, filters = {}) {
  const ix = indexCube(bundle.cube);
  const f = { ...EMPTY_FILTERS, ...filters };
  const coverage = bundle.meta?.coverage || datasetCoverage(ix);
  const range = {
    from: f.from || coverage.from,
    to: f.to || coverage.to,
  };
  const eff = { ...f, from: range.from, to: range.to };

  const rows = filterCube(ix, eff);
  const sessions = filterSessions(bundle.sessions || [], eff);
  const totals = sumRows(rows, ix);
  const granularity = filters.granularity || 'day';

  const daily = calculateDailyUsage(rows, ix, { granularity: 'day', from: range.from, to: range.to });
  const series = granularity === 'day'
    ? daily
    : calculateDailyUsage(rows, ix, { granularity, from: range.from, to: range.to, fill: false });
  const bucketOf = granularity === 'week' ? weekStart : granularity === 'month' ? monthKey : (d) => d;
  const buckets = series.map((s) => s.key);

  const averages = calculateAverageUsage(daily);
  const composition = calculateComposition(totals);
  const trend = calculateUsageTrend(daily, 30);
  const hourly = calculateHourlyUsage(rows, ix);
  const dowUsage = calculateDowUsage(rows, ix, daily);
  const hourDow = calculateHourDow(rows, ix);
  const levels = calendarLevels(daily);
  const streaks = calculateStreaks(daily);
  const peaks = calculatePeakUsage(rows, ix, { series: daily, sessions, topN: 10 });

  const providers = calculateDimensionUsage(rows, ix, 'p', { sessions, grandTotal: totals.total });
  const models = calculateDimensionUsage(rows, ix, 'm', { sessions, grandTotal: totals.total });
  const families = calculateDimensionUsage(rows, ix, 'mf', { sessions, grandTotal: totals.total });
  const clients = calculateDimensionUsage(rows, ix, 'c', { sessions, grandTotal: totals.total });
  const interfaces = calculateDimensionUsage(rows, ix, 'i', { sessions, grandTotal: totals.total });
  const projects = calculateDimensionUsage(rows, ix, 'pj', { sessions, grandTotal: totals.total, limit: 25 });
  const gateways = calculateDimensionUsage(rows, ix, 'g', { sessions, grandTotal: totals.total });
  const tiers = calculateDimensionUsage(rows, ix, 'st', { sessions, grandTotal: totals.total });

  const providerSeries = calculateDimensionSeries(rows, ix, 'p', buckets, { topN: 6, bucketOf });
  const modelSeries = calculateDimensionSeries(rows, ix, 'm', buckets, { topN: 6, bucketOf });
  const interfaceTrend = calculateInterfaceTrend(rows, ix, buckets, bucketOf);
  const efficiency = calculateEfficiency(totals, { sessions: sessions.length, activeDays: averages.activeDays });
  const sessionProfile = calculateSessionProfile(sessions);
  const modelEfficiency = calculateModelEfficiency(rows, ix, sessions, { limit: 24 });

  const book = buildPriceBook(bundle.pricing || {});
  const unpriced = unpricedModels(rows, ix, (m, p) => book.lookup(m, p));
  // Attach the rate provenance to each model row so the Cost page can show
  // where every number came from rather than asserting it.
  // Rows are decorated in place with rate provenance the dimension helper
  // does not know about.
  for (const m of /** @type {Record<string, any>[]} */ (models)) {
    const entry = book.lookup(m.key, m.provider) || book.lookup(m.key, 'unknown');
    m.priceSource = entry ? (entry.origin === 'user' ? 'your override' : entry.src) : null;
    m.rates = entry ? { in: entry.in, out: entry.out, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, cacheRefresh: entry.cacheRefresh } : null;
  }
  // An overlay source is a gateway's own billing log: its tokens describe
  // traffic a client adapter already counted, so they stay out of the totals —
  // but its cost is *measured*, not estimated, and dropping it would throw away
  // the only hard money number in the dataset. Sum it from an overlay-only
  // slice and report it beside the estimate, never inside it.
  const overlayRows = f.includeOverlay ? [] : filterCube(ix, { ...eff, includeOverlay: true }).filter((r) => r[ix.d.ms] === 'overlay');
  const overlay = overlayRows.length ? sumRows(overlayRows, ix) : null;
  const cost = calculateCost(totals, {
    sessions: sessions.length, activeDays: averages.activeDays, unpriced, tiers,
    // Tiers billed above the standard rate, so the UI can call them out.
    premiumTiers: ['priority', 'fast'],
    overlayMeasured: overlay ? (overlay.costMeasured || 0) + (overlay.cost || 0) : null,
    overlayRequests: overlay ? overlay.req : 0,
  });

  const providerGrowth = calculateDimensionGrowth(ix, 'p', eff, range);
  const modelGrowth = calculateDimensionGrowth(ix, 'm', eff, range);

  const work = calculateWorkSeries(bundle.activity || { rows: {} }, { from: range.from, to: range.to, projects: f.project });
  const correlations = calculateCorrelations(daily, work);
  const contrast = calculateActivityContrast(daily, work, 'insertions');
  const proxies = calculateActivityProxies(daily, sessions, totals);

  const comparison = filters.compare
    ? calculatePeriodComparison(ix, bundle.sessions || [], eff, filters.compare.a, filters.compare.b)
    : null;

  const drill = filters.drillDate ? dayDetail(rows, ix, filters.drillDate, sessions) : null;

  // ---- forward-looking + structural intelligence --------------------------
  // `today` is the dataset timezone's calendar today (meta), so "this month"
  // and reset windows mean the user's local calendar, never the host's.
  const todayIso = bundle.meta?.today || range.to;
  const forecast = buildForecast(daily, todayIso);
  const anomalies = detectAnomalies(daily);
  const firstSeen = {
    models: firstSeenEntities(ix, { today: todayIso, dim: 'm', withinDays: 7 }).slice(0, 3),
    providers: firstSeenEntities(ix, { today: todayIso, dim: 'p', withinDays: 7 }).slice(0, 3),
  };
  // Capacity is evaluated against the WHOLE primary dataset on purpose: a
  // quota window is a fact about your accounts, not about the dashboard's
  // current filter state. Per-limit provider/model/project scoping happens
  // inside evaluateLimits.
  const capEval = evaluateLimits(bundle.limits || [], {
    cube: bundle.cube,
    today: todayIso,
    nowMs: Date.now(),
    tzOffsetMinutes: bundle.meta?.tzOffsetMinutes ?? 0,
    coverageFrom: coverage.from,
  });
  const capacity = { ...capEval, summary: summarizeCapacity(capEval.states) };

  const view = {
    range,
    coverage,
    filters: eff,
    granularity,
    kpis: buildKpis(totals, averages, peaks, sessions, providers, models, daily),
    totals,
    series,
    daily,
    movingAverages: {
      ma7: movingAverage(daily, 7),
      ma30: movingAverage(daily, 30),
    },
    averages,
    composition,
    trend,
    hourly,
    dowUsage,
    hourDow,
    calendar: { days: daily, levels },
    streaks,
    peaks,
    dimensions: { providers, models, families, clients, interfaces, projects, gateways, tiers },
    stacks: { providerSeries, modelSeries, interfaceTrend },
    growth: { providers: providerGrowth, models: modelGrowth },
    efficiency,
    sessionProfile,
    modelEfficiency,
    cost,
    productivity: { proxies, work, correlations, contrast },
    comparison,
    drill,
    forecast,
    anomalies,
    firstSeen,
    capacity,
    facets: {
      provider: facet(ix, 'p'),
      model: facet(ix, 'm'),
      model_family: facet(ix, 'mf'),
      client: facet(ix, 'c'),
      interface: facet(ix, 'i'),
      gateway: facet(ix, 'g'),
      project: facet(ix, 'pj'),
      repository: facet(ix, 'rp'),
      service_tier: facet(ix, 'st'),
    },
    plugins: {},
  };

  view.insights = generateInsights({
    ix, rows, totals, series: daily, sessions, filters: eff, range,
    hourly, peaks, composition, trend, cost, correlations,
  });

  const slice = { ix, rows, sessions, totals, view, bundle, filters: eff, range };
  for (const p of plugins.values()) {
    try {
      view.plugins[p.id] = p.compute(slice);
    } catch (err) {
      view.plugins[p.id] = { error: err.message };
    }
  }
  return view;
}

function buildKpis(totals, averages, peaks, sessions, providers, models, daily) {
  const activeDays = averages.activeDays;
  return {
    total: { value: totals.total, label: 'Total usage', unit: 'tokens', measured: true },
    input: { value: totals.in, label: 'Input', unit: 'tokens', na: totals.naIn },
    output: { value: totals.out, label: 'Output', unit: 'tokens', na: totals.naOut },
    cache: { value: totals.cr + totals.cw, label: 'Cache', unit: 'tokens', na: totals.naCr + totals.naCw },
    avgPerDay: { value: averages.perActiveDay, label: 'Avg / active day', unit: 'tokens' },
    peak: {
      value: peaks.peakDay?.total ?? null,
      label: 'Peak day',
      unit: 'tokens',
      detail: peaks.peakDay?.date ?? null,
    },
    activeDays: { value: activeDays, label: 'Active days', unit: 'days', detail: `${daily.length} in range` },
    sessions: { value: sessions.length, label: 'Sessions', unit: 'sessions' },
    sessionsPerDay: { value: activeDays ? sessions.length / activeDays : null, label: 'Avg sessions / day', unit: '' },
    providers: { value: providers.length, label: 'Providers', unit: '' },
    models: { value: models.length, label: 'Models', unit: '' },
    requests: { value: totals.req, label: 'Requests', unit: '' },
  };
}

export function datasetCoverage(ix) {
  let from = null;
  let to = null;
  for (const r of ix.rows) {
    const d = r[ix.d.d];
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
  }
  return { from, to };
}

export {
  indexCube, filterCube, filterSessions, sumRows, facet, EMPTY_FILTERS,
  calculateDailyUsage, movingAverage, calculateAverageUsage, calculateComposition,
  calculateUsageTrend, calculateHourlyUsage, calculateDowUsage, calculateHourDow,
  calendarLevels, calculateStreaks,
  calculateDimensionUsage, calculateDimensionSeries, calculateDimensionGrowth,
  calculateModelEfficiency, calculateInterfaceTrend,
  calculatePeakUsage, dayDetail,
  calculateEfficiency, calculateCost, unpricedModels, calculateSessionProfile,
  calculatePeriodComparison, previousPeriod,
  calculateActivityProxies, calculateWorkSeries, calculateCorrelations, calculateActivityContrast,
  generateInsights, daysBetween, addDays, dateRange, weekStart, monthKey,
  buildForecast, linearForecast, monthEndProjection, exhaustionEta,
  detectAnomalies, firstSeenEntities,
  evaluateLimits, summarizeCapacity, normalizeLimits,
};

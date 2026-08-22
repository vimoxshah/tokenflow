/**
 * Anomaly detection.
 *
 * Robust (median / MAD, Iglewicz–Hoaglin modified z-score) detection over the
 * daily series, plus structural events the statistical layer cannot see:
 * calendar gaps in an otherwise-active pattern and entities that appeared for
 * the first time recently.
 *
 * Every anomaly carries its own arithmetic — observed value, baseline median,
 * modified z — so a reader can check the call instead of trusting it. A quiet
 * dataset produces an empty list; that is the honest answer, not a failure.
 *
 * Pure module: no Node imports, deterministic output.
 */

const MAD_SCALE = 1.4826;
const SPIKE_Z = 3.5;      // Iglewicz–Hoaglin threshold for a modified z-score
const HIGH_Z = 6;         // well past that: call it high severity
const BASELINE_WINDOW = 60;
const MIN_BASELINE = 10;

/**
 * @typedef {Object} Anomaly
 * @property {string} id
 * @property {string} type
 * @property {string} date
 * @property {'high'|'warn'|'info'} severity
 * @property {number|null} observed
 * @property {number|null} [expectedMedian]
 * @property {number|null} [ratio]
 * @property {number|null} [z]
 * @property {string} detail
 * @property {string} [metric]
 */

function median(sortedAsc) {
  if (!sortedAsc.length) return null;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Baseline stats for index i computed over the preceding window, excluding i
 * itself so an event can never drag its own baseline toward it.
 */
function baseline(values, i, window = BASELINE_WINDOW) {
  const lo = Math.max(0, i - window);
  const hist = values.slice(lo, i).filter((v) => Number.isFinite(v));
  if (hist.length < MIN_BASELINE) return null;
  const med = median([...hist].sort((a, b) => a - b));
  const mad = median(hist.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
  return { n: hist.length, med, mad };
}

/** Modified z-score; null when the MAD is degenerate (e.g. flat history). */
export function modifiedZ(x, { med, mad }) {
  if (!Number.isFinite(x)) return null;
  if (mad === 0) {
    // Perfectly flat history: any deviation is infinitely surprising
    // statistically, but capping keeps severity honest — this surfaces as a
    // warning, never as "high".
    if (x === med) return 0;
    return x > med ? 4.99 : -4.99;
  }
  return (0.6745 * (x - med)) / mad;
}

const SEV_ORDER = { high: 0, warn: 1, info: 2 };

/** @param {Anomaly[]} out */
function addSpikeEvents(out, series, values, metric, kind, label, fmt) {
  for (let i = 0; i < series.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x) || x <= 0) continue;
    const base = baseline(values, i);
    if (!base || base.med <= 0) continue;
    const z = modifiedZ(x, base);
    if (z === null || z < SPIKE_Z) continue;
    const ratio = x / base.med;
    out.push({
      id: `${kind}:${series[i].key}`,
      type: kind,
      date: series[i].key,
      severity: z >= HIGH_Z ? 'high' : 'warn',
      observed: x,
      expectedMedian: base.med,
      ratio,
      z,
      detail: `${label} of ${fmt(x)} is ${ratio.toFixed(1)}× the trailing ${base.n}-day median (${fmt(base.med)}) — a robust z-score of ${z.toFixed(1)}.`,
      metric,
    });
  }
}

function valuesOf(series, metric) {
  return series.map((d) => Number(d[metric]));
}

function isWeekend(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Detect anomalies over a calendar-complete daily series.
 *
 * @param {{key:string,total:number,cost?:number|null,req:number,active:boolean,
 *           tokenActive:boolean,[k:string]:any}[]} daily
 * @returns {Anomaly[]}
 */
export function detectAnomalies(daily, opt = {}) {
  /** @type {Anomaly[]} */
  const out = [];
  if (!Array.isArray(daily) || daily.length < MIN_BASELINE + 1) return out;

  const totals = valuesOf(daily, 'total');
  addSpikeEvents(out, daily, totals, 'total', 'token_spike', 'Token usage', (n) => compact(n));
  const hasCost = daily.some((d) => Number.isFinite(Number(d.cost)) && Number(d.cost) > 0);
  if (hasCost) addSpikeEvents(out, daily, valuesOf(daily, 'cost'), 'cost', 'cost_spike', 'Estimated cost', (n) => `$${Number(n).toFixed(2)}`);

  // ---- request-rate spikes -----------------------------------------------
  addSpikeEvents(out, daily, valuesOf(daily, 'req'), 'req', 'request_spike', 'Request volume', (n) => String(Math.round(n)));

  // ---- ingestion-gap candidates ------------------------------------------
  // A zero day is normal (weekends, holidays). It is only interesting when it
  // sits inside a stretch where this dataset was otherwise active every
  // weekday — hence "possible gap", never "gap".
  for (let i = 1; i < daily.length - 1; i++) {
    const d = daily[i];
    if (d.total > 0 || d.active || isWeekend(d.key)) continue;
    const around = [daily[i - 1], daily[i + 1]];
    if (!around.every((x) => x.tokenActive)) continue;
    out.push({
      id: `gap:${d.key}`,
      type: 'possible_gap',
      date: d.key,
      severity: 'info',
      observed: 0,
      expectedMedian: null,
      z: null,
      detail: `No activity at all on ${d.key}, a weekday between two active days — possible ingestion gap or a genuine day off.`,
    });
  }

  // ---- sudden drops ------------------------------------------------------
  // The mirror of a spike, but only meaningful on weekdays with real history:
  // usage halving on a Saturday is a pattern, not an anomaly.
  for (let i = 0; i < daily.length; i++) {
    const x = totals[i];
    if (!(x > 0) || isWeekend(daily[i].key)) continue;
    const base = baseline(totals, i);
    if (!base || base.med <= 0) continue;
    const z = modifiedZ(x, base);
    if (z === null || z > -SPIKE_Z) continue;
    out.push({
      id: `drop:${daily[i].key}`,
      type: 'usage_drop',
      date: daily[i].key,
      severity: z <= -HIGH_Z ? 'high' : 'warn',
      observed: x,
      expectedMedian: base.med,
      ratio: x / base.med,
      z,
      detail: `Weekday usage fell to ${compact(x)} — ${(x / base.med).toFixed(2)}× the trailing ${base.n}-day median (${compact(base.med)}), a robust z-score of ${z.toFixed(1)}.`,
    });
  }

  const cap = opt.limit ?? 12;
  return out
    .sort((a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
      || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
      || (b.z ?? 0) - (a.z ?? 0))
    .slice(0, cap);
}

/**
 * Entities (models or providers) seen for the first time within `withinDays`
 * of `today`. First-seen is derived from the full cube rows, independent of
 * the filtered range, because "new" means new to the whole dataset.
 *
 * @param {ReturnType<import('./aggregate.js').indexCube>} ix
 * @param {{today:string, withinDays?:number, dim?:'m'|'p'}} opt
 */
export function firstSeenEntities(ix, opt) {
  const dimKey = opt.dim === 'p' ? ix.d.p : ix.d.m;
  const noun = opt.dim === 'p' ? 'provider' : 'model';
  const cutoff = isoMinusDays(opt.today, opt.withinDays ?? 7);
  /** @type {Map<string,{first:string,last:string,tokens:number}>} */
  const seen = new Map();
  for (const r of ix.rows) {
    const date = r[ix.d.d];
    if (date > opt.today) continue;
    const key = r[dimKey];
    let e = seen.get(key);
    if (!e) { e = { first: date, last: date, tokens: 0 }; seen.set(key, e); }
    if (date < e.first) e.first = date;
    if (date > e.last) e.last = date;
    e.tokens += r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
  }
  const out = [];
  for (const [key, e] of seen) {
    if (e.first < cutoff) continue;
    out.push({ entity: key, noun, firstSeen: e.first, lastUsed: e.last, tokens: e.tokens });
  }
  return out.sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1));
}

function isoMinusDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function compact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

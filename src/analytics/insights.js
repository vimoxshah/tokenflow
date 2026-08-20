/**
 * Insight generation.
 *
 * Every insight is derived from the slice at render time. Nothing here is a
 * template with a number dropped in — each generator computes its own
 * condition and simply produces no insight when the condition isn't met or
 * when the supporting sample is too small. That is why the panel can be empty:
 * an empty insight panel is the honest output for a thin slice.
 */
import { compact, pct, signedPct, shortDate, hourWindow } from '../core/units.js';
import { previousPeriod } from './comparison.js';
import { filterCube, groupRows, sumRows, daysBetween } from './aggregate.js';
import { interfaceClass } from '../core/schema.js';

const MIN_DAYS_FOR_TREND = 14;
const MIN_REQUESTS = 20;

/**
 * @param {object} c context
 * @param {object} c.ix cube index
 * @param {any[]} c.rows filtered rows
 * @param {object} c.totals
 * @param {any[]} c.series daily series
 * @param {any[]} c.sessions
 * @param {object} c.filters
 * @param {{from:string,to:string}} c.range
 * @param {object} c.hourly
 * @param {object} c.peaks
 * @param {object} c.composition
 * @param {object} c.trend
 * @param {object} [c.correlations]
 * @param {object} [c.cost]
 * @returns {{icon:string,text:string,kind:string,weight:number}[]}
 */
export function generateInsights(c) {
  const out = [];
  const add = (icon, text, kind, weight) => out.push({ icon, text, kind, weight });
  const { ix, rows, totals, series, sessions, range, hourly, peaks, composition, trend } = c;
  const activeDays = series.filter((d) => d.tokenActive).length;

  if (!rows.length || totals.req < 1) {
    return [{ icon: 'ℹ', text: 'No usage records match the current filters.', kind: 'empty', weight: 0 }];
  }

  // ---- trend -------------------------------------------------------------
  if (trend && trend.change !== null && activeDays >= MIN_DAYS_FOR_TREND) {
    const up = trend.change > 0;
    add(
      up ? '📈' : '📉',
      `Token usage ${up ? 'increased' : 'decreased'} ${signedPct(trend.change)} over the last ${trend.window} days versus the ${trend.window} before.`,
      'trend',
      Math.abs(trend.change) * 100,
    );
  }

  // ---- peak --------------------------------------------------------------
  if (peaks?.peakDay) {
    const median = series.filter((d) => d.tokenActive).map((d) => d.total).sort((a, b) => a - b)[Math.floor(activeDays / 2)] || 0;
    const times = median ? peaks.peakDay.total / median : null;
    add(
      '🔥',
      `Highest usage day was ${shortDate(peaks.peakDay.date)} at ${compact(peaks.peakDay.total)} tokens` +
        (times && times > 1.5 ? ` — ${times.toFixed(1)}× a typical active day.` : '.'),
      'peak',
      60,
    );
  }

  // ---- provider concentration -------------------------------------------
  const byProvider = [...groupRows(rows, ix, (r) => r[ix.d.p]).values()].sort((a, b) => b.m.total - a.m.total);
  if (byProvider.length && totals.total > 0) {
    const top = byProvider[0];
    add(
      '🤖',
      byProvider.length === 1
        ? `All measured usage in this slice went to one provider: ${label(top.key)}.`
        : `${label(top.key)} accounts for ${pct(top.m.total / totals.total)} of tokens across ${byProvider.length} providers.`,
      'provider',
      50,
    );
  }

  // ---- interface shift ---------------------------------------------------
  const shift = interfaceShift(c);
  if (shift) {
    add('💻', shift, 'interface', 55);
  }

  // ---- cache -------------------------------------------------------------
  if (composition?.cacheRatio !== null && composition?.cacheRatio !== undefined) {
    const hit = composition.cacheHitRate;
    add(
      '⚡',
      `Cache was ${pct(composition.cacheRatio)} of all token activity` +
        (hit !== null ? `, and ${pct(hit)} of prompt tokens were served from cache rather than re-sent.` : '.'),
      'cache',
      45,
    );
  }

  // ---- output vs prompt --------------------------------------------------
  if (composition?.outputPerPromptToken) {
    const r = composition.outputPerPromptToken;
    const per = 1 / r;
    add(
      '🧮',
      `Every generated token costs about ${per >= 10 ? Math.round(per) : per.toFixed(1)} prompt tokens sent (output is ${pct(r)} of all token activity` +
        (composition.outputPerInput !== null ? `; output/fresh-input ratio ${composition.outputPerInput.toFixed(2)}` : '') +
        `) — this usage is ${r < 0.1 ? 'strongly prompt-heavy' : r < 0.25 ? 'prompt-heavy' : 'output-heavy'}.`,
      'composition',
      35,
    );
  }
  if (composition?.reasoningShareOfOutput > 0.05) {
    add('🧠', `Reasoning accounted for ${pct(composition.reasoningShareOfOutput)} of generated tokens.`, 'composition', 30);
  }

  // ---- time of day -------------------------------------------------------
  if (hourly?.peakWindow && hourly.peakWindow.share > 0.15) {
    const w = hourly.peakWindow;
    let text = `Your busiest window is ${hourWindow(w.from, w.to)} (${pct(w.share)} of tokens).`;
    if (hourly.secondaryWindow && hourly.secondaryWindow.share > 0.1) {
      text += ` A second peak sits at ${hourWindow(hourly.secondaryWindow.from, hourly.secondaryWindow.to)}.`;
    }
    add(hourly.peakWindow.from >= 18 || hourly.peakWindow.from < 6 ? '🌙' : '☀️', text, 'hour', 40);
  }

  // ---- weekend behaviour -------------------------------------------------
  const weekend = series.filter((d) => d.tokenActive && [5, 6].includes(dow(d.date)));
  if (activeDays >= 14) {
    if (weekend.length === 0) {
      add('📅', 'No weekend usage at all in this period — your AI use is entirely on weekdays.', 'rhythm', 25);
    } else if (weekend.length / activeDays > 0.25) {
      add('📅', `${pct(weekend.length / activeDays)} of your active days were weekends.`, 'rhythm', 25);
    }
  }

  // ---- model migration ---------------------------------------------------
  for (const m of modelMigrations(c)) add('🔄', m.text, 'migration', m.weight);

  // ---- new / dropped providers ------------------------------------------
  for (const t of newOrStopped(c)) add(t.icon, t.text, 'change', t.weight);

  // ---- sessions ----------------------------------------------------------
  if (sessions.length >= 10 && activeDays > 0) {
    const perDay = sessions.length / activeDays;
    add('🧵', `${sessions.length.toLocaleString('en-US')} sessions over ${activeDays} active days — ${perDay.toFixed(1)} per day, ${compact(totals.total / sessions.length)} tokens each.`, 'sessions', 20);
  }

  // ---- data-honesty notes -----------------------------------------------
  const naRate = totals.req ? totals.naAny / (totals.req * 4) : 0;
  if (naRate > 0.05) {
    add('⚠', `${pct(naRate)} of token fields in this slice were not reported by their source; those gaps are excluded from totals rather than counted as zero.`, 'quality', 15);
  }

  // ---- cost --------------------------------------------------------------
  if (c.cost) {
    if (c.cost.estimated !== null && c.cost.coverage !== null && c.cost.coverage > 0.5) {
      add('💵', `Estimated spend ${money(c.cost.estimated)} (${pct(c.cost.coverage)} of requests priced) — about ${money(c.cost.perMillionTokens)} per million tokens.`, 'cost', 33);
    } else if (c.cost.unpriced?.length) {
      const top = c.cost.unpriced[0];
      add('💵', `Cost is not shown because ${c.cost.unpriced.length} model(s) have no configured price — the largest is ${top.model} at ${compact(top.total)} tokens. Add pricing to enable cost analysis.`, 'cost', 33);
    }
    if (c.cost.measured !== null && c.cost.estimated !== null) {
      const d = c.cost.estimated ? (c.cost.measured - c.cost.estimated) / c.cost.estimated : null;
      if (d !== null && Math.abs(d) > 0.1) {
        add('🔍', `Gateway-measured cost differs from the price-table estimate by ${signedPct(d)} — the measured figure covers only proxy-routed traffic.`, 'cost', 28);
      }
    }
  }

  // ---- correlation ------------------------------------------------------
  if (c.correlations?.available) {
    const top = c.correlations.metrics[0];
    add(
      '🔗',
      `Daily AI usage and ${metricLabel(top.metric)} show a ${top.strength} ${top.direction} correlation (r = ${top.r.toFixed(2)}, n = ${top.n} days). Correlation only — not evidence that one caused the other.`,
      'correlation',
      48,
    );
  }

  out.sort((a, b) => b.weight - a.weight);
  return out;
}

// ---------------------------------------------------------------- helpers ---

function interfaceShift(c) {
  const { ix, filters, range, totals } = c;
  if (!range?.from || !range?.to) return null;
  const len = daysBetween(range.from, range.to) + 1;
  if (len < MIN_DAYS_FOR_TREND * 2) return null;
  const prev = previousPeriod(range.from, range.to);
  const share = (from, to) => {
    const rows = filterCube(ix, { ...filters, from, to });
    let cli = 0, all = 0;
    for (const r of rows) {
      const t = r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
      all += t;
      if (interfaceClass(r[ix.d.i]) === 'CLI / headless') cli += t;
    }
    return { share: all ? cli / all : null, total: all };
  };
  const now = share(range.from, range.to);
  const before = share(prev.from, prev.to);
  if (now.share === null || before.share === null || before.total < 1000) return null;
  const diff = now.share - before.share;
  if (Math.abs(diff) < 0.05) return null;
  return `CLI / headless usage moved from ${pct(before.share)} to ${pct(now.share)} of tokens versus the previous ${len} days.`;
}

function modelMigrations(c) {
  const { ix, filters, range } = c;
  const out = [];
  if (!range?.from || !range?.to) return out;
  const len = daysBetween(range.from, range.to) + 1;
  if (len < MIN_DAYS_FOR_TREND * 2) return out;
  const prev = previousPeriod(range.from, range.to);
  const totalsOf = (from, to) => {
    const rows = filterCube(ix, { ...filters, from, to });
    const g = groupRows(rows, ix, (r) => r[ix.d.m]);
    const all = [...g.values()].reduce((a, x) => a + x.m.total, 0);
    return { g, all };
  };
  const a = totalsOf(prev.from, prev.to);
  const b = totalsOf(range.from, range.to);
  if (!a.all || !b.all) return out;
  const keys = new Set([...a.g.keys(), ...b.g.keys()]);
  const moves = [];
  for (const k of keys) {
    const sa = (a.g.get(k)?.m.total ?? 0) / a.all;
    const sb = (b.g.get(k)?.m.total ?? 0) / b.all;
    if (Math.abs(sb - sa) < 0.08) continue;
    moves.push({ model: k, from: sa, to: sb, diff: sb - sa });
  }
  moves.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const risers = moves.filter((m) => m.diff > 0).slice(0, 1);
  const fallers = moves.filter((m) => m.diff < 0).slice(0, 1);
  if (risers.length && fallers.length) {
    out.push({
      text: `Model mix is shifting: ${fallers[0].model} fell from ${pct(fallers[0].from)} to ${pct(fallers[0].to)} of tokens while ${risers[0].model} rose from ${pct(risers[0].from)} to ${pct(risers[0].to)}.`,
      weight: 52,
    });
  } else if (risers.length) {
    out.push({ text: `${risers[0].model} grew from ${pct(risers[0].from)} to ${pct(risers[0].to)} of tokens versus the previous period.`, weight: 44 });
  }
  return out;
}

function newOrStopped(c) {
  const { ix, filters, range } = c;
  const out = [];
  if (!range?.from || !range?.to) return out;
  const len = daysBetween(range.from, range.to) + 1;
  if (len < 7) return out;
  const prev = previousPeriod(range.from, range.to);
  const keysOf = (from, to, dim) => new Set(filterCube(ix, { ...filters, from, to }).map((r) => r[ix.d[dim]]));
  for (const [dim, noun] of [['p', 'provider'], ['c', 'client']]) {
    const before = keysOf(prev.from, prev.to, dim);
    const now = keysOf(range.from, range.to, dim);
    const added = [...now].filter((k) => !before.has(k));
    const gone = [...before].filter((k) => !now.has(k));
    if (before.size && added.length) out.push({ icon: '✨', text: `New ${noun}${added.length > 1 ? 's' : ''} this period: ${added.map(label).join(', ')}.`, weight: 42 });
    if (before.size && gone.length) out.push({ icon: '🚪', text: `No usage this period from ${noun}${gone.length > 1 ? 's' : ''} you used before: ${gone.map(label).join(', ')}.`, weight: 38 });
  }
  return out;
}

function metricLabel(k) {
  return { commits: 'git commits', insertions: 'lines added', files: 'files changed', aiLines: 'AI-authored lines', edits: 'AI edit events' }[k] || k;
}
function label(s) {
  return String(s).replace(/^\w/, (m) => m.toUpperCase());
}
function money(n) {
  if (n === null || n === undefined) return '—';
  return n < 1 ? `$${n.toFixed(3)}` : n < 1000 ? `$${n.toFixed(2)}` : `$${(n / 1000).toFixed(1)}K`;
}
function dow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

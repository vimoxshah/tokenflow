/**
 * Pure shaping for the Live tab's "right now" sections.
 *
 * `src/core/live-status.js` writes four sections into `data/status.json` every
 * watcher cycle — `liveSessions`, `receiptsToday`, `guard`, `sparklines`. This
 * module turns that JSON into the small display facts the view needs: a gauge
 * ratio, a stable colour order for sparkline sources, the resolved context cap,
 * and the labels that must not be assembled twice in two places.
 *
 * Nothing here touches the DOM, so it runs under `node --test` unchanged. Every
 * label routes through `core/units.js`, the same formatters the CLI uses, with
 * `n/a` passed for the missing case: a dash is not a number and neither is 0.
 */
import { compact, int, pct, relativeTime, usd } from '../core/units.js';

/**
 * Context window assumed when no `maxContextTokens` cap is declared.
 *
 * It is a drawing scale, not a claim about the model: the gauge needs a
 * denominator, and 200K is the common frontier context length. `declared`
 * comes back false so the view can say which one the reader is looking at.
 */
export const DEFAULT_CONTEXT_CAP = 200000;

/** The five guard policy keys, in the order `live-status.js` writes them. */
const CAP_FIELDS = [
  { key: 'warnCostUsd', label: 'Warn at session spend', kind: 'usd' },
  { key: 'maxCostUsd', label: 'Block at session spend', kind: 'usd' },
  { key: 'warnContextTokens', label: 'Warn at context', kind: 'tokens' },
  { key: 'maxContextTokens', label: 'Block at context', kind: 'tokens' },
  { key: 'warnMarginalUsd', label: 'Warn at cost per turn', kind: 'usd' },
];

/** A positive finite number, or null. Mirrors the guard policy's own rule. */
function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Deterministic id ordering: plain code-unit compare, never locale-dependent. */
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The denominator the context gauge draws against.
 *
 * A declared `maxContextTokens` wins, because that is the number the guard
 * will actually block on. Otherwise the default scale, flagged as undeclared.
 *
 * @param {object|null|undefined} policy `status.guard.policy`
 * @returns {{cap:number, label:string, declared:boolean}}
 */
export function resolveContextCap(policy) {
  const declaredCap = positive(policy ? policy.maxContextTokens : null);
  const cap = declaredCap ?? DEFAULT_CONTEXT_CAP;
  return { cap, label: `of ${compact(cap, { na: 'n/a' })}`, declared: declaredCap !== null };
}

/**
 * Fraction of `cap` that `value` fills, clamped to 0..1.
 *
 * Null when either side is unknown, so a gauge with no measurement draws
 * empty and says "n/a" rather than sitting at zero as if it had measured one.
 *
 * @param {number|null|undefined} value
 * @param {number|null|undefined} cap
 * @returns {number|null}
 */
export function gaugeRatio(value, cap) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const c = positive(cap);
  if (c === null) return null;
  return Math.max(0, Math.min(1, value / c));
}

/**
 * Everything the context gauge shows for one session.
 *
 * @param {{contextTokens?:number|null, policy?:object|null}} opt
 * @returns {{ratio:number|null, cap:number, declared:boolean, value:string,
 *   capLabel:string, text:string, pctText:string}}
 */
export function contextGauge(opt) {
  const o = opt || {};
  const { cap, label, declared } = resolveContextCap(o.policy);
  const tokens = typeof o.contextTokens === 'number' && Number.isFinite(o.contextTokens) ? o.contextTokens : null;
  const ratio = gaugeRatio(tokens, cap);
  const value = tokens === null ? 'n/a' : compact(tokens, { na: 'n/a' });
  return {
    ratio,
    cap,
    declared,
    value,
    capLabel: label,
    text: tokens === null ? 'n/a' : `${value} ${label}`,
    pctText: ratio === null ? 'n/a' : pct(ratio, 0, 'n/a'),
  };
}

/**
 * "3 min ago" for an `asOf` stamp, or "n/a" when there is none.
 *
 * `relativeTime` answers "never" for a missing timestamp, which reads as a
 * claim about the watcher rather than about the field. An absent asOf is a
 * missing value, so it says so the way every other missing value here does.
 *
 * @param {string|null|undefined} iso
 * @param {number} [now] epoch ms, injectable for tests
 */
export function asOfLabel(iso, now = Date.now()) {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'n/a';
  return relativeTime(iso, now);
}

/**
 * Session spend, with its pricing coverage when some turns had no price.
 *
 * @param {{costUsd?:number|null, coverage?:number|null}} opt
 * @returns {{text:string, coverageText:string|null, priced:boolean}}
 */
export function costLabel(opt) {
  const o = opt || {};
  const cost = typeof o.costUsd === 'number' && Number.isFinite(o.costUsd) ? o.costUsd : null;
  const coverage = typeof o.coverage === 'number' && Number.isFinite(o.coverage) ? o.coverage : null;
  return {
    text: cost === null ? 'n/a' : usd(cost, 'n/a'),
    coverageText: coverage !== null && coverage < 1 ? `priced ${pct(coverage, 0, 'n/a')} of turns` : null,
    priced: cost !== null,
  };
}

/**
 * "179 turns", "1 turn", "n/a". A counted noun agrees with its count.
 * @param {number|null|undefined} n
 * @param {string} singular
 */
export function countLabel(n, singular) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return `${int(n, 'n/a')} ${singular}${n === 1 ? '' : 's'}`;
}

/**
 * "260 turns, 4 by subagents". Subagents appear only when there are any.
 * @param {{turns?:number|null, subagentTurns?:number|null}} session
 */
export function turnsLabel(session) {
  const s = session || {};
  const sub = typeof s.subagentTurns === 'number' && Number.isFinite(s.subagentTurns) ? s.subagentTurns : 0;
  const base = countLabel(s.turns, 'turn');
  return sub > 0 ? `${base}, ${int(sub, 'n/a')} by subagents` : base;
}

/**
 * Where a session is working: project first, repository as the fallback.
 * @param {object} session one entry of `status.liveSessions.sessions`
 * @returns {{where:string, branch:string}}
 */
export function sessionPlace(session) {
  const s = session || {};
  return {
    where: s.project || s.repository || 'n/a',
    branch: s.branch || 'n/a',
  };
}

/**
 * The guard chip for one session or for the last verdict.
 *
 * `title` is the first reason, or null when there is none — an empty string
 * would render an empty tooltip box on hover.
 *
 * @param {{level?:string, reasons?:string[]}|null|undefined} guard
 * @returns {{level:string, text:string, title:string|null}}
 */
export function guardChip(guard) {
  const g = guard || {};
  const level = g.level === 'block' || g.level === 'warn' ? g.level : 'ok';
  const reasons = Array.isArray(g.reasons) ? g.reasons : [];
  return { level, text: `guard ${level}`, title: reasons.length ? reasons[0] : null };
}

/**
 * The declared caps, in policy order. Empty when nothing is declared.
 * @param {object|null|undefined} policy `status.guard.policy`
 * @returns {{key:string, label:string, value:number, text:string}[]}
 */
export function capRows(policy) {
  const p = policy || {};
  const rows = [];
  for (const f of CAP_FIELDS) {
    const v = positive(p[f.key]);
    if (v === null) continue;
    rows.push({
      key: f.key,
      label: f.label,
      value: v,
      text: f.kind === 'usd' ? usd(v, 'n/a') : compact(v, { na: 'n/a' }),
    });
  }
  return rows;
}

/** Sum of the finite entries of a bucket array. */
function sumFinite(values) {
  let t = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) t += v;
  return t;
}

/**
 * Which sparkline sources get their own chart, and which colour each keeps.
 *
 * Two orderings, deliberately different:
 *
 *  - **Selection** is by volume, because a chart per source is only worth its
 *    space for the sources that moved tokens. Everything past `max` folds into
 *    one summed "other" series rather than disappearing.
 *  - **Colour** is by alphabetical position among *all* sources present, so a
 *    source keeps its colour when a quiet day drops it out of the top five and
 *    a busy one brings it back. `colorIndex` is null for "other", which the
 *    view draws in the muted no-series colour.
 *
 * Series come back in alphabetical order with "other" last, so a series never
 * jumps position as its numbers change.
 *
 * @param {{bySource?:object, max?:number}} [opt] `status.sparklines.bySource`
 * @returns {{series:{id:string, values:number[], colorIndex:number|null,
 *   total:number, folded?:string[]}[], folded:string[]}}
 */
export function orderSparkSources(opt) {
  const o = opt || {};
  const bySource = o.bySource && typeof o.bySource === 'object' ? o.bySource : {};
  const max = typeof o.max === 'number' && Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 5;

  const keys = Object.keys(bySource).filter((k) => Array.isArray(bySource[k])).sort(compareIds);
  const rank = new Map(keys.map((k, i) => [k, i]));
  const totals = new Map(keys.map((k) => [k, sumFinite(bySource[k])]));

  const kept = new Set(
    keys.slice()
      .sort((a, b) => (totals.get(b) - totals.get(a)) || compareIds(a, b))
      .slice(0, max),
  );

  /** @type {{id:string, values:number[], colorIndex:number|null, total:number, folded?:string[]}[]} */
  const series = keys.filter((k) => kept.has(k)).map((k) => ({
    id: k,
    values: bySource[k].slice(),
    colorIndex: rank.get(k),
    total: totals.get(k),
  }));

  const folded = keys.filter((k) => !kept.has(k));
  if (folded.length) {
    const width = Math.max(...folded.map((k) => bySource[k].length));
    const values = new Array(width).fill(0);
    for (const k of folded) {
      bySource[k].forEach((v, i) => {
        if (typeof v === 'number' && Number.isFinite(v)) values[i] += v;
      });
    }
    series.push({ id: 'other', values, colorIndex: null, total: sumFinite(values), folded });
  }

  return { series, folded };
}

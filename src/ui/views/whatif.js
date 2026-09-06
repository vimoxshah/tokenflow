/**
 * The What-if tab: reprice the same tokens at another model's rates.
 *
 * This is a what-if about PRICE ONLY. It says nothing about quality, latency
 * or output length. Swapping a model changes all three, and this tab has no
 * opinion on any of them.
 *
 * Everything here comes from the cube plus the shipped price book, so it
 * works fully offline. The price book is built the exact same way the Cost
 * tab builds it (`buildPriceBook(ctx.bundle.pricing || {})`, see
 * src/analytics/index.js), so the two tabs never disagree about a rate.
 */
import { el } from '../charts.js';
import { buildPriceBook } from '../../core/pricing.js';
import { reprice, targetModelOptions } from '../../analytics/whatif.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'whatif';
export const label = 'What-if';
export const order = 105;
export const css = './styles/whatif.css';

/** How many of the current filters' top-cost models get their own row. Matches
 * the eight-slot series/colour cap used elsewhere in the dashboard. */
const TOP_N = 8;
const FLAT_EPSILON = 0.005;

/**
 * `ctx.S.whatif.mapping` is `{ fromModel: toModel }`, owned by this view, so a
 * filter change or a re-render never loses the choices already made.
 * @param {ViewContext} ctx
 * @returns {{mapping: Record<string,string>}}
 */
function state(ctx) {
  if (!ctx.S.whatif) ctx.S.whatif = { mapping: {} };
  return ctx.S.whatif;
}

/**
 * The top-cost models for the current filters, ranked by the same
 * `.cost` field the Cost tab ranks and shows. Never re-derived, so the two
 * tabs list the same models in the same order.
 * @param {ViewContext} ctx
 */
function topModels(ctx) {
  const models = ctx.view.dimensions.models || [];
  return [...models]
    .sort((a, b) => (b.cost ?? -Infinity) - (a.cost ?? -Infinity))
    .slice(0, TOP_N);
}

function deltaClass(delta) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return 'whatif-flat';
  if (Math.abs(delta) < FLAT_EPSILON) return 'whatif-flat';
  return delta > 0 ? 'whatif-extra' : 'whatif-save';
}

/** `usd()` never signs a negative value on its own ("$-5.00"); the sign is
 * what tells savings from extra cost here, so it is added explicitly. A
 * missing delta delegates straight to `fmt.usd`, so it gets the same
 * placeholder every other missing value on the dashboard gets. */
function signedUsd(v, fmt) {
  if (v === null || v === undefined || !Number.isFinite(v)) return fmt.usd(v);
  if (Math.abs(v) < FLAT_EPSILON) return fmt.usd(0);
  const sign = v > 0 ? '+' : '-';
  return sign + fmt.usd(Math.abs(v));
}

/**
 * The target select for one model row: its own model is always an option
 * (so the identity default always exists, even for an unpriced model), union
 * the price table's own models and every priced model seen anywhere in the
 * dataset, grouped into `<optgroup>`s by provider.
 * @param {ViewContext} ctx
 * @param {{name:string, provider:string}[]} targetOptions
 * @param {object} row a `view.dimensions.models` row
 * @param {number} idx position, for a stable DOM id
 */
function targetSelect(ctx, targetOptions, row, idx) {
  const s = state(ctx);
  const own = { name: row.key, provider: row.provider || 'Other' };
  const all = [own, ...targetOptions.filter((o) => o.name !== row.key)];
  const groups = new Map();
  for (const o of all) {
    if (!groups.has(o.provider)) groups.set(o.provider, new Set());
    groups.get(o.provider).add(o.name);
  }
  const sel = el('select', { class: 'whatif-target', id: `whatif-target-${idx}`, 'aria-label': `Reprice ${row.key} at` });
  for (const provider of [...groups.keys()].sort()) {
    const grp = el('optgroup', { label: provider });
    for (const name of [...groups.get(provider)].sort()) grp.appendChild(el('option', { value: name, text: name }));
    sel.appendChild(grp);
  }
  const persisted = s.mapping[row.key];
  // A persisted target that is no longer offered (e.g. a stale mapping from a
  // very different dataset) falls back to identity rather than a select that
  // shows nothing selected.
  sel.value = persisted && all.some((o) => o.name === persisted) ? persisted : row.key;
  sel.addEventListener('change', () => {
    s.mapping[row.key] = sel.value;
    ctx.rerender({ recompute: false });
  });
  return sel;
}

/** @param {ViewContext} ctx */
export function view(ctx) {
  const root = el('div', { class: 'grid whatif' });
  root.appendChild(ctx.sectionTitle('What-if pricing'));
  root.appendChild(el('p', { class: 'hint', text: 'This is a what-if about price. It says nothing about quality, latency, or output length.' }));

  const rows = topModels(ctx);
  if (!rows.length) {
    root.appendChild(ctx.emptyCard('No priced usage in the current filters.', 'Widen the date range or clear a filter to see models here.'));
    return root;
  }

  const book = buildPriceBook(ctx.bundle.pricing || {});
  const s = state(ctx);
  const targetOptions = targetModelOptions({ book, seenModels: ctx.view.facets.model || [] });
  const out = reprice({ rows, book, mapping: s.mapping });

  root.appendChild(kpiRow(ctx, out));
  root.appendChild(el('p', { class: 'hint whatif-footnote', text: `Estimated from the shipped price table ${book.version}. Same tokens, different rates. Not a claim about quality.` }));
  if (out.overall.excluded > 0) {
    root.appendChild(el('p', { class: 'hint whatif-footnote', text: `${out.overall.excluded} model(s) have no source price at all. They show no value and are excluded from the totals above.` }));
  }
  root.appendChild(pickerCard(ctx, rows, targetOptions));
  root.appendChild(deltaChartCard(ctx, out));
  return root;
}

function kpiRow(ctx, out) {
  const { usd } = ctx.fmt;
  const box = el('div', { class: 'cards' });
  box.appendChild(ctx.kpi('Current (top models)', usd(out.overall.current), 'at each model\'s own rate'));
  box.appendChild(ctx.kpi('What-if', usd(out.overall.whatif), 'at the selected targets'));
  const delta = ctx.kpi('Delta', signedUsd(out.overall.delta, ctx.fmt), out.overall.partial ? 'partial: some rates are missing' : null);
  delta.classList.add('whatif-delta-kpi', deltaClass(out.overall.delta));
  box.appendChild(delta);
  return box;
}

function pickerCard(ctx, rows, targetOptions) {
  const body = el('div', { class: 'whatif-pickers' });
  rows.forEach((row, idx) => {
    const line = el('div', { class: 'whatif-picker-row' });
    line.appendChild(el('span', { class: 'whatif-picker-label', text: row.key }));
    line.appendChild(el('span', { class: 'whatif-picker-arrow', text: '→' }));
    line.appendChild(targetSelect(ctx, targetOptions, row, idx));
    body.appendChild(line);
  });
  return ctx.card('Reprice at', 'Pick a target model for each of the top models by estimated cost in the current filters. Defaults to the same model, which is a zero delta.', body);
}

function deltaChartCard(ctx, out) {
  const { usd, compact } = ctx.fmt;
  const models = out.models;

  const tableSpec = {
    columns: [
      { key: 'model', label: 'Model', text: true },
      { key: 'target', label: 'Target', text: true },
      { key: 'tokens', label: 'Tokens', value: (r) => compact(r.tokens) },
      { key: 'current', label: 'Current', value: (r) => (r.current === null ? null : usd(r.current)) },
      { key: 'whatif', label: 'What-if', value: (r) => (r.whatif === null ? null : usd(r.whatif)) },
      { key: 'delta', label: 'Delta', value: (r) => (r.delta === null ? null : signedUsd(r.delta, ctx.fmt)) },
      { key: 'partial', label: 'Partial', value: (r) => (r.partial ? 'partial' : null) },
    ],
    rows: models,
  };
  return ctx.chartCard(
    'whatif-delta',
    'Delta per model',
    'What-if minus current, per model. Orange is extra cost, blue is savings.',
    // hbars' label formatter only ever sees one bar's numeric value, with no
    // way back to the row, so a null delta is passed through as NaN (falsy,
    // so it still draws a zero-width bar). `usd()` already renders NaN with
    // the same placeholder it renders null with, so the label needs no
    // special-casing here.
    () => ctx.charts.hbars(models.map((m) => ({
      label: m.model === m.target ? m.model : `${m.model} → ${m.target}`,
      value: m.delta === null ? NaN : Math.abs(m.delta),
      color: deltaClass(m.delta) === 'whatif-extra' ? 'var(--div-1)' : deltaClass(m.delta) === 'whatif-save' ? 'var(--div-5)' : 'var(--div-3)',
      title: m.partial ? `${m.model}: partial, at least one rate is missing` : m.model,
      rows: [
        { color: null, name: 'Tokens', value: compact(m.tokens) },
        { color: null, name: 'Current', value: usd(m.current) },
        { color: null, name: 'What-if', value: usd(m.whatif) },
        { color: null, name: 'Delta', value: signedUsd(m.delta, ctx.fmt) },
      ],
    })), { fmt: (v) => usd(v), valueLabel: 'Delta (magnitude)' }),
    tableSpec,
  );
}

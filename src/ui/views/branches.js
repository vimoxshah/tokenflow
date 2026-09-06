/**
 * The Compare branches tab: any two branch receipts from buildReceipts()
 * (src/analytics/receipt.js), side by side on a symmetric log scale.
 *
 * Reads ctx.bundle.receipts directly, never ctx.view: a branch receipt is
 * bounded by its branch, not by the date/provider filter bar (see
 * viewReceipts in app.js). That also means this tab needs nothing from the
 * server — everything here is already in the bundle the exporter embeds, so
 * it works the same in the live dashboard and in a saved offline snapshot.
 */
import { el } from '../charts.js';
import { compareBranches, pickDefault, findBranch } from '../../analytics/branch-compare.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'branches';
export const label = 'Compare branches';
export const order = 125;
export const css = './styles/branches.css';

const AXIS_TICKS = [
  { position: -1, label: '1/4x or less' },
  { position: -0.5, label: '1/2x' },
  { position: 0, label: 'parity' },
  { position: 0.5, label: '2x' },
  { position: 1, label: '4x or more' },
];

/** `>= 10` rounds to a whole multiple; below that a decimal still means something. */
function timesFmt(v) {
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}x`;
}

function fmtByKind(ctx, kind, v) {
  const { usd, int, pct } = ctx.fmt;
  if (kind === 'cost') return usd(v);
  if (kind === 'count') return int(v);
  if (kind === 'share') return pct(v, 0);
  if (kind === 'ratio') return timesFmt(v);
  return String(v);
}

/** A value formatted for one end of a bar row; never a bare 0 for "missing". */
function endText(ctx, row, value) {
  return value === null || value === undefined ? '—' : fmtByKind(ctx, row.kind, value);
}

function modelsText(ctx, models) {
  if (!models || !models.length) return null;
  const top = models.slice(0, 3).map((m) => `${m.model} ${ctx.fmt.pct(m.share, 0)}`).join(', ');
  return models.length > 3 ? `${top}, …` : top;
}

/**
 * Read the persisted selection, or fall back to pickDefault() — checked
 * against the current bundle every render, so a branch that disappeared
 * after a refresh never leaves a dead selector behind.
 * @param {ViewContext} ctx
 * @param {object} receipts
 * @returns {{a:{repo:string,key:string}, b:{repo:string,key:string}}|null}
 */
function ensureSelection(ctx, receipts) {
  const valid = (ref) => ref && findBranch(receipts, ref.repo, ref.key);
  const cur = ctx.S.branchCompare;
  if (cur && valid(cur.a) && valid(cur.b)) return cur;
  const def = pickDefault(receipts);
  if (!def) return null;
  ctx.S.branchCompare = def;
  return def;
}

/**
 * The Compare branches tab body.
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  const receipts = ctx.bundle.receipts;
  const root = el('div', { class: 'grid' });

  if (!receipts || !Array.isArray(receipts.repos) || !receipts.repos.length) {
    root.appendChild(ctx.card('Compare branches', 'Any two branches, side by side.', ctx.emptyCard(
      'No branch receipts yet',
      'Receipts need sessions that recorded a git branch and a priced model. See the Receipts tab.',
    )));
    return root;
  }

  const sel = ensureSelection(ctx, receipts);
  if (!sel) {
    root.appendChild(ctx.card('Compare branches', 'Any two branches, side by side.', ctx.emptyCard(
      'Need at least two branches to compare',
      'Only one branch has been attributed to a receipt so far on this machine.',
    )));
    return root;
  }

  const a = findBranch(receipts, sel.a.repo, sel.a.key);
  const b = findBranch(receipts, sel.b.repo, sel.b.key);

  root.appendChild(selectorCard(ctx, receipts, sel, a, b));
  root.appendChild(divergingCard(ctx, a, b));
  root.appendChild(sideCards(ctx, sel, a, b));
  root.appendChild(el('p', { class: 'hint branches-foot', text: 'Branch receipts are estimated from the logs on this machine. Cost per 100 lines needs a pull request join from the CLI.' }));
  return root;
}

// ------------------------------------------------------------------ selectors

function headerRow(sel, a, b) {
  const row = el('div', { class: 'branches-head' });
  const nameBlock = (repo, key, br) => {
    const parts = [el('span', { class: 'branches-head-name', text: `${repo} · ${key}` })];
    if (br && br.longLived) {
      parts.push(el('span', { class: 'badge', text: 'long-lived', title: 'A branch that lives forever: this is a receipt for a period of work on it, not for one change.' }));
    }
    if (br && br.pr) parts.push(el('span', { class: 'badge', text: `PR #${br.pr.number}` }));
    return el('div', {}, parts);
  };
  row.appendChild(nameBlock(sel.a.repo, sel.a.key, a));
  row.appendChild(el('span', { class: 'branches-head-vs', text: 'vs' }));
  row.appendChild(nameBlock(sel.b.repo, sel.b.key, b));
  return row;
}

function sideSelector(ctx, receipts, sel, side) {
  const wrap = el('div', { class: 'branches-side' });
  wrap.appendChild(el('div', { class: 'branches-side-label', text: side === 'a' ? 'Side A' : 'Side B' }));
  const fields = el('div', { class: 'branches-fields' });

  const repoSel = el('select', { 'aria-label': `Repository ${side.toUpperCase()}` });
  for (const R of receipts.repos) repoSel.appendChild(el('option', { value: R.repo, text: R.repo }));
  repoSel.value = sel[side].repo;

  const branchSel = el('select', { 'aria-label': `Branch ${side.toUpperCase()}` });
  const fillBranches = (repoName) => {
    branchSel.textContent = '';
    const R = receipts.repos.find((r) => r.repo === repoName);
    for (const br of (R ? R.branches : [])) {
      branchSel.appendChild(el('option', { value: br.key, text: `${br.key} · ${br.cost === null ? '—' : ctx.fmt.usd(br.cost)}` }));
    }
  };
  fillBranches(sel[side].repo);
  branchSel.value = sel[side].key;

  repoSel.addEventListener('change', () => {
    fillBranches(repoSel.value);
    const R = receipts.repos.find((r) => r.repo === repoSel.value);
    const firstKey = R && R.branches.length ? R.branches[0].key : null;
    if (!firstKey) return;
    ctx.S.branchCompare = { ...ctx.S.branchCompare, [side]: { repo: repoSel.value, key: firstKey } };
    ctx.rerender({ recompute: false });
  });
  branchSel.addEventListener('change', () => {
    ctx.S.branchCompare = { ...ctx.S.branchCompare, [side]: { repo: repoSel.value, key: branchSel.value } };
    ctx.rerender({ recompute: false });
  });

  fields.appendChild(repoSel);
  fields.appendChild(branchSel);
  wrap.appendChild(fields);
  return wrap;
}

function selectorCard(ctx, receipts, sel, a, b) {
  const body = el('div');
  body.appendChild(headerRow(sel, a, b));
  const selRow = el('div', { class: 'branches-select-row' });
  selRow.appendChild(sideSelector(ctx, receipts, sel, 'a'));
  selRow.appendChild(sideSelector(ctx, receipts, sel, 'b'));
  body.appendChild(selRow);
  return ctx.card(
    'Compare branches',
    "Any two branches, side by side. Defaults to the most expensive feature branch against the median-cost feature branch in the same repository.",
    body,
  );
}

// -------------------------------------------------------------- diverging bar

function barColor(position, side) {
  const p = Math.abs(position);
  if (p < 0.1) return 'var(--div-3)';
  if (p < 0.5) return side === 'a' ? 'var(--div-2)' : 'var(--div-4)';
  return side === 'a' ? 'var(--div-1)' : 'var(--div-5)';
}

function axisRow() {
  const row = el('div', { class: 'branches-axis' });
  row.appendChild(el('div', { class: 'branches-axis-spacer' }));
  row.appendChild(el('div', { class: 'branches-axis-ends' }));
  const track = el('div', { class: 'branches-axis-track' });
  for (const t of AXIS_TICKS) {
    const tick = el('div', { class: 'branches-axis-tick', text: t.label });
    tick.style.left = `${((t.position + 1) / 2) * 100}%`;
    track.appendChild(tick);
  }
  row.appendChild(track);
  row.appendChild(el('div', { class: 'branches-axis-ends' }));
  return row;
}

function barRow(ctx, row) {
  const wrap = el('div', { class: 'branches-row' });
  wrap.appendChild(el('div', { class: 'branches-row-label', text: row.label }));
  const bar = el('div', { class: 'branches-bar' });
  bar.appendChild(el('span', { class: 'branches-end branches-end-a', text: endText(ctx, row, row.valueA) }));

  const track = el('div', { class: 'branches-track' });
  const halfA = el('div', { class: 'branches-half branches-half-a' });
  const halfB = el('div', { class: 'branches-half branches-half-b' });
  if (row.position !== null) {
    const fill = el('div', { class: 'branches-fill' });
    fill.style.width = `${Math.abs(row.position) * 100}%`;
    if (row.position >= 0) {
      fill.style.background = barColor(row.position, 'a');
      halfA.appendChild(fill);
    } else {
      fill.style.background = barColor(row.position, 'b');
      halfB.appendChild(fill);
    }
  }
  track.appendChild(halfA);
  track.appendChild(el('div', { class: 'branches-centre' }));
  track.appendChild(halfB);
  bar.appendChild(track);

  bar.appendChild(el('span', { class: 'branches-end branches-end-b', text: endText(ctx, row, row.valueB) }));
  wrap.appendChild(bar);
  return wrap;
}

function legendRow() {
  const row = el('div', { class: 'branches-legend' });
  const swatch = (color) => el('span', { class: 'branches-swatch', style: `background:${color}` });
  row.appendChild(el('span', {}, [swatch('var(--div-1)'), 'A costs more']));
  row.appendChild(el('span', {}, [swatch('var(--div-3)'), 'parity']));
  row.appendChild(el('span', {}, [swatch('var(--div-5)'), 'B costs more']));
  return row;
}

function renderDivergingChart(ctx, rows) {
  const root = el('div');
  root.appendChild(axisRow());
  for (const row of rows) root.appendChild(barRow(ctx, row));
  root.appendChild(legendRow());
  return root;
}

function tableCell(ctx, row, value) {
  if (row.kind === 'models') return modelsText(ctx, value);
  return value === null || value === undefined ? null : fmtByKind(ctx, row.kind, value);
}

function divergingCard(ctx, a, b) {
  const rows = compareBranches(a, b);
  const barRows = rows.filter((r) => r.kind !== 'models');
  const tableSpec = {
    columns: [
      { key: 'label', label: 'Metric', text: true, value: (r) => r.label },
      { key: 'a', label: 'A', value: (r) => tableCell(ctx, r, r.valueA) },
      { key: 'b', label: 'B', value: (r) => tableCell(ctx, r, r.valueB) },
      { key: 'ratio', label: 'Ratio (A / B)', value: (r) => (r.ratio === null ? null : timesFmt(r.ratio)) },
    ],
    rows,
  };
  return ctx.chartCard(
    'branches-diverging',
    'Branch comparison',
    'A on the left, B on the right. Bar length is a symmetric log scale: twice as expensive moves the same distance whichever side it is on.',
    () => renderDivergingChart(ctx, barRows),
    tableSpec,
  );
}

// ------------------------------------------------------------------ side cards

function sideSummary(ctx, sideLabel, repo, key, br) {
  const { usd, pct, int, shortDate } = ctx.fmt;
  const card = el('div', { class: 'branches-side-card' });
  card.appendChild(el('h4', { text: `${sideLabel}: ${repo} · ${key}` }));
  if (!br) {
    card.appendChild(el('p', { text: 'This branch is no longer in the receipt store.' }));
    return card;
  }
  const costText = usd(br.cost);
  const shareText = br.contextShare === null ? '' : ` (${pct(br.contextShare, 0)} re-sent context, ${pct(1 - br.contextShare, 0)} fresh work)`;
  card.appendChild(el('p', { text: `${costText} across ${int(br.sessions)} session(s) and ${int(br.turns)} turn(s)${shareText}.` }));
  if (br.subagentTurns > 0) card.appendChild(el('p', { text: `${pct(br.subagentShare, 0)} of turns ran as a subagent.` }));
  const modelsLine = modelsText(ctx, br.models);
  if (modelsLine) card.appendChild(el('p', { text: `Models: ${modelsLine}.` }));
  if (br.vsMedian !== null) card.appendChild(el('p', { text: `${timesFmt(br.vsMedian)} this repo's median branch cost.` }));
  if (br.first && br.last) card.appendChild(el('p', { text: `Active ${shortDate(br.first.slice(0, 10))} to ${shortDate(br.last.slice(0, 10))}.` }));
  if (br.longLived) card.appendChild(el('p', { text: 'Long-lived branch: this is a receipt for a period of work on it, not for one change.' }));
  if (br.pr) card.appendChild(el('p', { text: `PR #${br.pr.number}${br.pr.mergedAt ? ` merged ${shortDate(br.pr.mergedAt.slice(0, 10))}` : ' still open'}.` }));
  return card;
}

function sideCards(ctx, sel, a, b) {
  const wrap = el('div', { class: 'branches-side-cards' });
  wrap.appendChild(sideSummary(ctx, 'A', sel.a.repo, sel.a.key, a));
  wrap.appendChild(sideSummary(ctx, 'B', sel.b.repo, sel.b.key, b));
  return ctx.card('Receipts', "The same numbers as the Receipts tab, for just these two branches.", wrap);
}

/**
 * The Tickets tab: cost per ticket, from the key found in a branch name or a
 * merged pull request's title.
 *
 * Reads ctx.bundle.receipts directly, never ctx.view: a ticket's cost spans
 * every branch that names it, in every repository, not just what the current
 * date/provider filter bar shows (see the Compare branches tab for the same
 * reasoning). costPerTicket() (src/analytics/tickets.js) is pure and reads
 * only the bundle already shipped, so this tab needs no server and works the
 * same in the live dashboard and in a saved offline snapshot.
 */
import { el } from '../charts.js';
import { costPerTicket } from '../../analytics/tickets.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'tickets';
export const label = 'Tickets';
export const order = 128;
export const css = './styles/tickets.css';

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The Tickets tab body.
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  const receipts = ctx.bundle.receipts;
  const root = el('div', { class: 'grid' });
  const hint = 'Cost per ticket, from a key found in a branch name or a merged pull request title.';

  if (!receipts || !Array.isArray(receipts.repos) || !receipts.repos.length) {
    root.appendChild(ctx.card('Tickets', hint, ctx.emptyCard(
      'No branch receipts yet',
      'Receipts need sessions that recorded a git branch and a priced model. See the Receipts tab.',
    )));
    return root;
  }

  const result = costPerTicket(receipts);
  if (!result.tickets.length) {
    root.appendChild(ctx.card('Tickets', hint, ctx.emptyCard(
      'No ticket key found in any branch name or pull request title',
      'A ticket key in a branch name is a convention, for example feat/ENG-1234-add-x, and TokenFlow never invents one. ' +
      'Set tickets.system in config.yaml (jira, linear or github) so a plain key is read with confidence, or tickets.pattern for a custom shape. See docs/tickets.md.',
    )));
    return root;
  }

  root.appendChild(kpiRow(ctx, result));
  root.appendChild(ticketsBarCard(ctx, result));
  root.appendChild(ticketsTableCard(ctx, result));
  root.appendChild(el('p', { class: 'hint tickets-foot', text: 'A ticket key in a branch name is a convention. A branch with no key stays unattributed here even when the work clearly belongs to a ticket.' }));
  return root;
}

// --------------------------------------------------------------------- kpis

function kpiRow(ctx, result) {
  const { usd, pct, int } = ctx.fmt;
  const box = el('div', { class: 'cards' });
  box.appendChild(ctx.kpi(
    'Attributed to a ticket',
    pct(result.totals.attributedShare, 0),
    `${usd(result.totals.attributedCostUsd)} of ${usd(result.totals.costUsd)}`,
  ));
  box.appendChild(ctx.kpi('Tickets', int(result.totals.tickets)));
  const costs = result.tickets.map((t) => t.costUsd).filter((v) => v !== null);
  box.appendChild(ctx.kpi('Median ticket cost', usd(median(costs))));
  const top = result.tickets[0] || null;
  box.appendChild(ctx.kpi('Most expensive ticket', top ? usd(top.costUsd) : usd(null), top ? top.key : null));
  box.appendChild(ctx.kpi(
    'Unattributed',
    usd(result.unattributed.costUsd),
    result.unattributed.turns > 0 ? `${int(result.unattributed.turns)} turn(s), no ticket key` : 'none',
  ));
  return box;
}

// ------------------------------------------------------------------- chart

function ticketsBarCard(ctx, result) {
  const { usd, int } = ctx.fmt;
  const top = result.tickets.slice(0, 10);
  const tableSpec = {
    columns: [
      { key: 'key', label: 'Ticket', text: true, value: (t) => t.key },
      { key: 'system', label: 'System', text: true, value: (t) => t.system },
      { key: 'cost', label: 'Cost', value: (t) => usd(t.costUsd) },
    ],
    rows: top,
  };
  return ctx.chartCard(
    'tickets-bar',
    'Top tickets by cost',
    'The most expensive tickets, summed across every branch and repository that names them.',
    () => ctx.charts.hbars(top.map((t) => ({
      label: t.key,
      value: t.costUsd === null ? NaN : t.costUsd,
      title: t.system ? `${t.key} (${t.system})` : t.key,
      rows: [
        { color: null, name: 'Cost', value: usd(t.costUsd) },
        { color: null, name: 'Turns', value: int(t.turns) },
        { color: null, name: 'Sessions', value: int(t.sessions) },
        { color: null, name: 'Branches', value: int(t.branches.length) },
      ],
    })), { fmt: (v) => usd(v), valueLabel: 'Cost' }),
    tableSpec,
  );
}

// ------------------------------------------------------------------- table

function ticketsTableCard(ctx, result) {
  const { usd, int, shortDate } = ctx.fmt;
  const columns = [
    {
      key: 'key',
      label: 'Ticket',
      text: true,
      value: (t) => (t.url ? el('a', { href: t.url, target: '_blank', rel: 'noopener', text: t.key }) : t.key),
    },
    { key: 'system', label: 'System', text: true, value: (t) => t.system },
    { key: 'cost', label: 'Cost', value: (t) => usd(t.costUsd) },
    { key: 'turns', label: 'Turns', value: (t) => int(t.turns) },
    { key: 'sessions', label: 'Sessions', value: (t) => int(t.sessions) },
    {
      key: 'branches',
      label: 'Branches',
      value: (t) => (t.branches.length ? el('span', { text: String(t.branches.length), title: t.branches.join(', ') }) : null),
    },
    { key: 'last', label: 'Last activity', value: (t) => (t.last ? shortDate(t.last.slice(0, 10)) : null) },
  ];
  return ctx.card('Tickets', 'Every ticket found in a branch name or pull request title, most expensive first.', ctx.charts.table(columns, result.tickets, { emptyText: 'No tickets in the current receipts.' }));
}

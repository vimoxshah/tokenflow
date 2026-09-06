/**
 * `tokenflow tickets` — spend grouped by the ticket key found in a branch
 * name or a merged pull request's title.
 *
 *   tokenflow tickets                every ticket, most expensive first
 *   tokenflow tickets --top 10       narrow the printed table
 *   tokenflow tickets --csv          one row per ticket, as CSV
 *   tokenflow tickets --json         the full result as JSON
 *
 * Builds the same buildReceipts() result `tokenflow receipt` builds (same
 * config, same price book, same repository resolver), so a ticket's cost
 * here always agrees with its branches' costs on the Receipts tab. The
 * analytics live in src/analytics/tickets.js and are pure; this file does
 * the Node work of loading records and config.
 */
import { paths, loadConfig } from '../core/config.js';
import { readJson } from '../core/store.js';
import { buildPriceBook } from '../core/pricing.js';
import { makeRepoResolver } from '../core/repo.js';
import { buildReceipts } from '../analytics/receipt.js';
import { costPerTicket, renderTicketsTable } from '../analytics/tickets.js';
import { csvLine } from '../export/csv.js';
import { loadPrimaryRecords } from './receipt.js';

const TICKETS_CSV_COLUMNS = [
  'system', 'key', 'costUsd', 'share', 'turns', 'sessions', 'repos', 'branches', 'first', 'last',
];

/**
 * One row per ticket, plus a final unattributed row when there is spend with
 * no ticket key.
 * @param {ReturnType<typeof costPerTicket>} result
 */
export function renderTicketsCsv(result) {
  let out = csvLine(TICKETS_CSV_COLUMNS);
  const row = (t) => csvLine([
    t.system, t.key, t.costUsd, t.share, t.turns, t.sessions,
    t.repos.join('|'), t.branches.join('|'), t.first, t.last,
  ]);
  for (const t of result.tickets) out += row(t);
  if (result.unattributed.turns > 0) out += row({ ...result.unattributed, system: null, key: '(unattributed)' });
  return out;
}

/**
 * @param {object} flags parsed CLI flags
 * @returns {{text:string, json:object}}
 */
export function run(flags = {}) {
  const cfg = loadConfig();
  const book = buildPriceBook(readJson(paths().pricing, {}));
  const from = typeof flags.from === 'string' ? flags.from : null;
  const to = typeof flags.to === 'string' ? flags.to : null;
  const records = loadPrimaryRecords({ from, to });

  const receipts = buildReceipts(records, {
    book,
    repoOf: makeRepoResolver(),
    tickets: cfg.tickets || {},
  });
  const result = costPerTicket(receipts);

  if (flags.csv) return { text: renderTicketsCsv(result), json: result };
  return { text: renderTicketsTable(result, { top: Number(flags.top) || 20 }), json: result };
}

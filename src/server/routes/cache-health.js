/**
 * GET /api/cache-health?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Churn detection: scans primary records in the given window, groups them by
 * session in timestamp order, and reports every turn that invalidated and
 * rewrote the prompt cache at a premium (src/analytics/cache-health.js has
 * the exact rule). This needs request-level records, which never leave the
 * machine and never ship in a snapshot, so it is a live-dashboard-only route.
 *
 * A record with no session_id cannot be placed in a turn sequence, so it is
 * left out of every group rather than guessed at.
 */
import { Store, decodeRecord, readJson } from '../../core/store.js';
import { buildPriceBook } from '../../core/pricing.js';
import { MEASUREMENT } from '../../core/schema.js';
import { detectChurn, summarize } from '../../analytics/cache-health.js';

/** Hard ceiling on how many records one request scans. */
const MAX_SCAN_RECORDS = 200000;

/**
 * `YYYY-MM` for every month between `from` and `to`, inclusive. Returns
 * `undefined` (no restriction) when either bound is missing, matching how
 * `Store#scanRecords`'s `months` option treats a falsy value.
 * @param {string|null} from
 * @param {string|null} to
 */
function monthsBetween(from, to) {
  if (!from || !to) return undefined;
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function handleCacheHealth(req, res, url, ctx) {
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;

  const store = new Store();
  const book = buildPriceBook(readJson(ctx.paths.pricing, {}));
  const months = monthsBetween(from, to);

  const bySession = new Map();
  let scanned = 0;
  let truncated = false;
  store.scanRecords((o) => {
    scanned++;
    if (scanned > MAX_SCAN_RECORDS) { truncated = true; return false; }
    if (from && o.d < from) return;
    if (to && o.d > to) return;
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    if (!o.s) return; // no session id: cannot be placed in a turn sequence
    const r = decodeRecord(o);
    let group = bySession.get(r.session_id);
    if (!group) { group = []; bySession.set(r.session_id, group); }
    group.push(r);
  }, { months });

  const events = [];
  for (const group of bySession.values()) events.push(...detectChurn(group, book));
  // Highest estimated premium first; unpriced events (premiumUsd: null) sink
  // to the bottom rather than sorting arbitrarily.
  events.sort((a, b) => {
    if (a.premiumUsd === null && b.premiumUsd === null) return 0;
    if (a.premiumUsd === null) return 1;
    if (b.premiumUsd === null) return -1;
    return b.premiumUsd - a.premiumUsd;
  });

  ctx.json({
    from,
    to,
    scanned,
    truncated,
    events,
    summary: summarize(events),
  });
}

export const CACHE_HEALTH_ROUTES = [
  {
    method: 'GET',
    path: '/api/cache-health',
    handler: handleCacheHealth,
  },
];

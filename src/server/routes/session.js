/**
 * GET /api/session?id=<sessionId>
 *
 * One session's primary records, in timestamp order, for the Session anatomy
 * tab. The cube has no notion of a turn, so this is the only way to see where
 * a single session's money went — and request-level records never ship in the
 * bundle or the snapshot, which is why this is a live-dashboard-only route.
 *
 * Two things this route deliberately does not do:
 *
 *   - It never returns prompt or code content. The stored records hold none,
 *     and the projection below is an allow-list rather than a delete-list so
 *     that a future metadata field cannot leak in by being added upstream.
 *   - It never scans the whole store. The session's own date range comes from
 *     the bundle's session rows, and only the months that range touches are
 *     read (widened by a day at each end, because a session row's date is a
 *     local calendar date and a record's timestamp is UTC).
 *
 * One field is served beyond the set this route was specified with:
 * `service_tier`. The browser prices each turn itself from the price book, and
 * the tier is a multiplier on that price (OpenAI priority and fast are 4x,
 * batch is 0.5x). Without it the anatomy tab would quietly disagree with the
 * Cost tab on exactly the sessions that cost the most. It is a billing
 * dimension the cube already carries, not content.
 */
import { Store } from '../../core/store.js';
import { MEASUREMENT } from '../../core/schema.js';
import { addDays } from '../../analytics/aggregate.js';

/** Most turns one response will carry. Reported in the body, never silent. */
export const RECORD_CAP = 5000;

/**
 * The key `Store#upsertSession` filed a record under. A source with no session
 * id gets a synthetic one, so matching on `o.s` alone would never find those
 * sessions.
 * @param {object} o an encoded record
 */
function sessionKeyOf(o) {
  return o.s || `${o.so}:${o.d}:${o.pj || 'unknown'}`;
}

/** `YYYY-MM` for every month between two dates, inclusive. */
function monthsBetween(from, to) {
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

/** The calendar date part of an ISO timestamp, or null. */
function dateOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : null;
}

/**
 * The fields the anatomy view is allowed to see. Everything else — metadata,
 * cwd, titles, ids that identify a machine or a person — stays on disk.
 * @param {object} o an encoded record
 */
function slim(o) {
  const meta = o.x || {};
  return {
    ts: o.ts ?? null,
    model: o.m ?? null,
    provider: o.p ?? null,
    source: o.so ?? null,
    input_tokens: o.in ?? null,
    cache_read_tokens: o.cr ?? null,
    cache_write_tokens: o.cw ?? null,
    cache_refresh_tokens: o.cf ?? null,
    output_tokens: o.ou ?? null,
    reasoning_tokens: o.rs ?? null,
    // The billing tier changes what an identical turn costs (OpenAI priority
    // is 4x), so pricing in the browser needs it to agree with the Cost tab.
    service_tier: o.tr ?? null,
    category: o.k ?? null,
    request_id: o.rq ?? null,
    // No adapter records a parent link today: Claude Code marks a sidechain and
    // OpenCode/Hermes fold their parent id into `category`. The pair is carried
    // anyway so the fan-out becomes a real tree the day one does.
    agent: meta.agent ?? meta.agent_role ?? null,
    parent: meta.parent_id ?? meta.parent_session_id ?? null,
  };
}

function handleSession(req, res, url, ctx) {
  const id = url.searchParams.get('id');
  if (!id) return ctx.json({ error: 'id is required' }, 400);

  // Session rows only; the receipt scan behind the full bundle costs seconds
  // and this route never looks at it.
  const sessions = ctx.buildBundle({ receipts: false }).sessions || [];
  const row = sessions.find((s) => s.id === id);
  if (!row) return ctx.json({ error: `no session "${id}"` }, 404);

  const first = row.d || dateOf(row.start);
  const last = dateOf(row.end) || first;
  if (!first || !last) return ctx.json({ error: `session "${id}" has no date range` }, 404);
  const from = addDays(first < last ? first : last, -1);
  const to = addDays(first > last ? first : last, 1);
  const months = monthsBetween(from, to);

  const store = new Store();
  const matched = [];
  let scanned = 0;
  store.scanRecords((o) => {
    scanned++;
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    if (sessionKeyOf(o) !== id) return;
    matched.push(o);
  }, { months });

  matched.sort((a, b) => (a.ts === b.ts ? 0 : (a.ts ?? '') < (b.ts ?? '') ? -1 : 1));
  const records = matched.slice(0, RECORD_CAP).map(slim);

  ctx.json({
    id,
    session: {
      id: row.id,
      source: row.so ?? null,
      project: row.pj ?? null,
      repository: row.rp ?? null,
      branch: row.br ?? null,
      model: row.m ?? null,
      provider: row.p ?? null,
      client: row.c ?? null,
      interface: row.i ?? null,
      start: row.start ?? null,
      end: row.end ?? null,
      date: row.d ?? null,
      requests: row.req ?? null,
    },
    months,
    scanned,
    total: matched.length,
    returned: records.length,
    cap: RECORD_CAP,
    truncated: matched.length > RECORD_CAP,
    records,
  });
}

/** @type {import('./index.js').Route} */
export const SESSION_ROUTE = {
  method: 'GET',
  path: '/api/session',
  handler: handleSession,
};

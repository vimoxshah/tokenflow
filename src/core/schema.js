/**
 * The unified usage schema.
 *
 * Every provider adapter emits objects of this shape. Nothing downstream —
 * analytics, UI, export — knows anything about a specific vendor.
 *
 * ## Missing-value contract (this is load-bearing)
 *
 *   null       the source does not report this field  -> "not available"
 *   undefined  normalised to null on construction
 *   0          the source reported zero                -> a real, measured zero
 *
 * Analytics NEVER coerce null to 0. Sums skip nulls and carry a parallel
 * `na` (not-available) counter so the UI can say "cache tokens unreported by
 * 22% of records in this slice" instead of silently drawing a zero.
 *
 * ## Token accounting (this is the part everyone gets wrong)
 *
 * BILLABLE_TOKEN_FIELDS are mutually exclusive and sum to total_tokens:
 *   input_tokens        fresh, uncached prompt tokens
 *   cache_read_tokens   prompt tokens served from a prompt cache (cheap)
 *   cache_write_tokens  prompt tokens written into a prompt cache (premium)
 *   output_tokens       generated tokens
 *
 * BREAKDOWN_TOKEN_FIELDS are SUBSETS of the above and must never be added
 * into a total:
 *   cache_refresh_tokens  subset of cache_write_tokens (long-TTL / refreshed
 *                         cache writes, e.g. Anthropic's ephemeral_1h)
 *   reasoning_tokens      subset of output_tokens (thinking / reasoning)
 *
 * Providers differ on whether `input_tokens` is inclusive of cache reads.
 * Anthropic reports them separately; OpenAI/Codex reports a single
 * `input_tokens` that INCLUDES `cached_input_tokens`. Each adapter is
 * responsible for converting to the exclusive convention above, and the
 * adapter tests assert it.
 */

export const BILLABLE_TOKEN_FIELDS = /** @type {const} */ ([
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'output_tokens',
]);

export const BREAKDOWN_TOKEN_FIELDS = /** @type {const} */ ([
  'cache_refresh_tokens',
  'reasoning_tokens',
]);

export const TOKEN_FIELDS = [...BILLABLE_TOKEN_FIELDS, ...BREAKDOWN_TOKEN_FIELDS];

/** How much a record can be trusted to contribute to token totals. */
export const MEASUREMENT = /** @type {const} */ ({
  /** Authoritative per-request usage reported by the model API. Counted in totals. */
  PRIMARY: 'primary',
  /** A second view of traffic already counted elsewhere (gateway/proxy logs).
   *  Excluded from totals by default to avoid double counting; used for
   *  independent cost cross-checks. */
  OVERLAY: 'overlay',
  /** AI activity with no token accounting at all (IDE edits, sessions with no
   *  usage block, git commits). Contributes to activity metrics only. */
  ACTIVITY: 'activity',
});

/** Interface / surface the request came from. Never inferred from the model. */
export const INTERFACE = /** @type {const} */ ({
  CLI: 'CLI',
  IDE: 'IDE',
  DESKTOP: 'Desktop App',
  WEB: 'Web',
  API: 'API',
  SDK: 'SDK',
  EXTENSION: 'Extension',
  UNKNOWN: 'Unknown',
});

export const INTERFACE_ORDER = [
  INTERFACE.CLI,
  INTERFACE.SDK,
  INTERFACE.IDE,
  INTERFACE.DESKTOP,
  INTERFACE.WEB,
  INTERFACE.API,
  INTERFACE.EXTENSION,
  INTERFACE.UNKNOWN,
];

/** Coarse grouping used by the "CLI vs GUI" comparison. */
export function interfaceClass(iface) {
  if (iface === INTERFACE.CLI || iface === INTERFACE.SDK) return 'CLI / headless';
  if (iface === INTERFACE.IDE || iface === INTERFACE.EXTENSION) return 'IDE';
  if (iface === INTERFACE.DESKTOP || iface === INTERFACE.WEB) return 'Desktop / Web';
  if (iface === INTERFACE.API) return 'API';
  return 'Unknown';
}

export const UNKNOWN = 'unknown';
export const NOT_AVAILABLE = null;

const NUM = (v) => (v === undefined || v === null || Number.isNaN(v) ? null : Number(v));
const STR = (v) => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * @typedef {Object} UsageRecord
 * @property {string}  id                 stable dedup key
 * @property {string}  timestamp          ISO-8601 UTC
 * @property {string}  date               YYYY-MM-DD in the capture timezone
 * @property {number}  hour               0-23 in the capture timezone
 * @property {number}  dow                0=Mon .. 6=Sun in the capture timezone
 * @property {number}  tz_offset          capture tz offset in minutes
 * @property {string}  provider           canonical vendor slug
 * @property {string}  provider_label
 * @property {string|null} gateway        routing layer (proxy/router), if any
 * @property {string}  model              raw model identifier from the source
 * @property {string}  model_family
 * @property {string}  client             tool that made the call
 * @property {string}  application        human label for the client
 * @property {string}  interface          one of INTERFACE
 * @property {number|null} input_tokens
 * @property {number|null} output_tokens
 * @property {number|null} cache_read_tokens
 * @property {number|null} cache_write_tokens
 * @property {number|null} cache_refresh_tokens
 * @property {number|null} reasoning_tokens
 * @property {number|null} total_tokens
 * @property {boolean} total_is_partial   true when some billable field was N/A
 * @property {string|null} session_id
 * @property {string|null} conversation_id
 * @property {string|null} request_id
 * @property {string|null} project
 * @property {string|null} repository
 * @property {string|null} git_branch
 * @property {string|null} category
 * @property {string|null} service_tier   billing tier (standard / priority / batch / ...)
 * @property {number|null} estimated_cost
 * @property {'measured'|'estimated'|null} cost_basis
 * @property {string}  source             adapter id
 * @property {string}  measurement        one of MEASUREMENT
 * @property {string|null} user
 * @property {string|null} machine
 * @property {number|null} duration_ms
 * @property {Object}  metadata
 */

/**
 * Build a fully-populated record from a partial one. Missing fields become
 * `null` (not available) rather than 0, and totals are derived, never trusted
 * from the source unless the source is the only thing that has them.
 * @param {Partial<UsageRecord>} p
 * @returns {UsageRecord}
 */
export function createRecord(p) {
  const r = /** @type {UsageRecord} */ ({
    id: p.id ?? '',
    timestamp: p.timestamp ?? null,
    date: p.date ?? null,
    hour: p.hour ?? null,
    dow: p.dow ?? null,
    tz_offset: p.tz_offset ?? null,

    provider: p.provider ?? UNKNOWN,
    provider_label: p.provider_label ?? 'Unknown',
    gateway: STR(p.gateway),
    model: p.model ?? UNKNOWN,
    model_family: p.model_family ?? 'Unknown',
    client: p.client ?? UNKNOWN,
    application: p.application ?? 'Unknown',
    interface: p.interface ?? INTERFACE.UNKNOWN,

    input_tokens: NUM(p.input_tokens),
    output_tokens: NUM(p.output_tokens),
    cache_read_tokens: NUM(p.cache_read_tokens),
    cache_write_tokens: NUM(p.cache_write_tokens),
    cache_refresh_tokens: NUM(p.cache_refresh_tokens),
    reasoning_tokens: NUM(p.reasoning_tokens),
    total_tokens: null,
    total_is_partial: false,

    session_id: STR(p.session_id),
    conversation_id: STR(p.conversation_id),
    request_id: STR(p.request_id),
    project: STR(p.project),
    repository: STR(p.repository),
    git_branch: STR(p.git_branch),
    category: STR(p.category),
    // A billing tier, not incidental metadata: OpenAI's Fast mode is 4x the
    // standard rate, so this changes the cost of an otherwise identical request.
    service_tier: STR(p.service_tier),

    estimated_cost: NUM(p.estimated_cost),
    cost_basis: p.cost_basis ?? null,

    source: p.source ?? UNKNOWN,
    measurement: p.measurement ?? MEASUREMENT.PRIMARY,
    user: STR(p.user),
    machine: STR(p.machine),
    duration_ms: NUM(p.duration_ms),
    metadata: p.metadata ?? {},
  });

  const t = computeTotal(r);
  r.total_tokens = t.total;
  r.total_is_partial = t.partial;
  return r;
}

/**
 * Total = sum of the four mutually-exclusive billable buckets.
 * Returns `{total: null}` only when EVERY billable field is unavailable —
 * a record that reports some fields still gets a total, flagged partial.
 * @param {Partial<UsageRecord>} r
 */
export function computeTotal(r) {
  let total = 0;
  let seen = 0;
  let partial = false;
  for (const f of BILLABLE_TOKEN_FIELDS) {
    const v = r[f];
    if (v === null || v === undefined) partial = true;
    else {
      total += v;
      seen++;
    }
  }
  if (seen === 0) return { total: null, partial: true };
  return { total, partial };
}

/** Timezone-aware date parts, computed once at ingest so the UI never guesses. */
export function dateParts(timestamp, tz) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  // Use Intl to resolve the wall-clock in the capture timezone. `tz`
  // undefined means "this machine's zone", which is what a local-first
  // ingest wants.
  const fmt = partsFormatter(tz);
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour) % 24;
  // 0=Mon..6=Sun
  const jsDow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dow = (jsDow + 6) % 7;
  const offset = tzOffsetMinutes(d, tz);
  return { date, hour, dow, tz_offset: offset, iso: d.toISOString() };
}

const _fmtCache = new Map();
function partsFormatter(tz) {
  const key = tz || 'local';
  let f = _fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
    _fmtCache.set(key, f);
  }
  return f;
}

function tzOffsetMinutes(d, tz) {
  if (!tz) return -d.getTimezoneOffset();
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const x of dtf.formatToParts(d)) p[x.type] = x.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUTC - d.getTime()) / 60000);
  } catch {
    return -d.getTimezoneOffset();
  }
}

/**
 * Fast, stable, non-cryptographic 64-bit id. Used for dedup across refreshes.
 * Two independent 32-bit FNV-1a passes; ~1e-10 collision risk at 10^6 keys.
 */
export function hashId(...parts) {
  const s = parts.join(' ');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(36).padStart(7, '0') + h2.toString(36).padStart(7, '0');
}

/** Dimensions the cube and the filter bar share. Order matters for the UI. */
export const DIMENSIONS = [
  { key: 'provider', label: 'Provider', cube: 'p' },
  { key: 'model', label: 'Model', cube: 'm' },
  { key: 'model_family', label: 'Model family', cube: 'mf' },
  { key: 'client', label: 'Client', cube: 'c' },
  { key: 'interface', label: 'Interface', cube: 'i' },
  { key: 'gateway', label: 'Gateway', cube: 'g' },
  { key: 'project', label: 'Project', cube: 'pj' },
  { key: 'repository', label: 'Repository', cube: 'rp' },
  { key: 'service_tier', label: 'Service tier', cube: 'st' },
];

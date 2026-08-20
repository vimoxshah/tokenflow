/**
 * Validation for normalized records and for provider definitions.
 * Used by the adapter tests, by `tokenflow validate`, and by the generic
 * importer before it accepts a mapped file.
 */
import { BILLABLE_TOKEN_FIELDS, BREAKDOWN_TOKEN_FIELDS, INTERFACE, MEASUREMENT, computeTotal } from './schema.js';

const IFACES = new Set(Object.values(INTERFACE));
const MEAS = new Set(Object.values(MEASUREMENT));

/**
 * @param {object} r
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateUsage(r) {
  const errors = [];
  const warnings = [];

  if (!r || typeof r !== 'object') return { ok: false, errors: ['record is not an object'], warnings };

  if (!r.timestamp || Number.isNaN(new Date(r.timestamp).getTime())) errors.push('timestamp missing or unparseable');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) errors.push('date must be YYYY-MM-DD');
  if (!(Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23)) errors.push('hour must be 0-23');
  if (!(Number.isInteger(r.dow) && r.dow >= 0 && r.dow <= 6)) errors.push('dow must be 0-6 (0=Mon)');
  if (!r.provider) errors.push('provider missing');
  if (!r.model) errors.push('model missing');
  if (!IFACES.has(r.interface)) errors.push(`interface "${r.interface}" is not one of ${[...IFACES].join('|')}`);
  if (!MEAS.has(r.measurement)) errors.push(`measurement "${r.measurement}" is invalid`);
  if (!r.source) errors.push('source missing');
  if (!r.id) errors.push('id missing');

  for (const f of [...BILLABLE_TOKEN_FIELDS, ...BREAKDOWN_TOKEN_FIELDS]) {
    const v = r[f];
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${f} must be a finite number or null`);
    else if (v < 0) errors.push(`${f} must not be negative`);
  }

  // Subset invariants — the whole point of separating breakdown fields.
  if (r.reasoning_tokens !== null && r.output_tokens !== null && r.reasoning_tokens > r.output_tokens) {
    errors.push('reasoning_tokens exceeds output_tokens (it must be a subset)');
  }
  if (r.cache_refresh_tokens !== null && r.cache_write_tokens !== null && r.cache_refresh_tokens > r.cache_write_tokens) {
    errors.push('cache_refresh_tokens exceeds cache_write_tokens (it must be a subset)');
  }

  const t = computeTotal(r);
  if (r.total_tokens !== t.total) errors.push(`total_tokens (${r.total_tokens}) != sum of billable fields (${t.total})`);
  if (!!r.total_is_partial !== t.partial) errors.push('total_is_partial disagrees with the field availability');

  if (r.measurement === MEASUREMENT.PRIMARY && t.total === null) {
    warnings.push('primary record with no token data at all — consider measurement "activity"');
  }
  if (r.estimated_cost !== null && !r.cost_basis) errors.push('estimated_cost present but cost_basis is null');
  if (r.cost_basis && r.estimated_cost === null) errors.push('cost_basis present but estimated_cost is null');

  return { ok: errors.length === 0, errors, warnings };
}

/** @param {object} p provider definition */
export function validateProvider(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['provider is not an object'] };
  if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) errors.push('id must be a lowercase slug');
  if (!p.name) errors.push('name is required');
  if (typeof p.detect !== 'function') errors.push('detect() is required');
  const hasIngest = typeof p.ingestFile === 'function' || typeof p.fetchUsage === 'function';
  if (!hasIngest) errors.push('either ingestFile() or fetchUsage() is required');
  if (typeof p.ingestFile === 'function' && typeof p.discover !== 'function') {
    errors.push('ingestFile() requires discover() to enumerate source files');
  }
  if (p.measurement && !MEAS.has(p.measurement)) errors.push(`measurement "${p.measurement}" is invalid`);
  return { ok: errors.length === 0, errors };
}

/** Aggregate data-quality report used by the Data Health indicator. */
export function summarizeQuality(cube, sessions, state) {
  const D = cube.dims.length;
  const mi = (n) => D + cube.measures.indexOf(n);
  let req = 0, naIn = 0, naOut = 0, naCr = 0, naCw = 0, tokens = 0;
  const providers = new Set(), models = new Set(), clients = new Set(), ifaces = new Set();
  let minD = null, maxD = null;
  for (const r of cube.rows) {
    req += r[mi('req')];
    naIn += r[mi('naIn')]; naOut += r[mi('naOut')]; naCr += r[mi('naCr')]; naCw += r[mi('naCw')];
    tokens += r[mi('in')] + r[mi('out')] + r[mi('cr')] + r[mi('cw')];
    providers.add(r[3]); models.add(r[4]); clients.add(r[6]); ifaces.add(r[7]);
    if (minD === null || r[0] < minD) minD = r[0];
    if (maxD === null || r[0] > maxD) maxD = r[0];
  }
  const cells = req * 4;
  const missing = cells ? (naIn + naOut + naCr + naCw) / cells : 0;
  const files = Object.values(state.sources || {}).reduce((a, s) => a + Object.keys(s.files || {}).length, 0);
  let grade = 'Excellent';
  if (missing > 0.4) grade = 'Fair';
  else if (missing > 0.12) grade = 'Good';
  if (req === 0) grade = 'No data';
  return {
    grade,
    records: req,
    tokens,
    sessions: Object.keys(sessions.rows || {}).length,
    sourceFiles: files,
    coverage: { from: minD, to: maxD },
    providers: providers.size,
    models: models.size,
    clients: clients.size,
    interfaces: ifaces.size,
    missingTokenFieldRate: missing,
    missingByField: {
      input_tokens: req ? naIn / req : 0,
      output_tokens: req ? naOut / req : 0,
      cache_read_tokens: req ? naCr / req : 0,
      cache_write_tokens: req ? naCw / req : 0,
    },
    // Structural dedup: identical bytes are never read twice, so the duplicate
    // count is a fact about the ingest model, not an estimate.
    duplicateRecords: 0,
    malformedLines: state.counters?.malformed ?? 0,
    staleGenerations: (state.stale || []).length,
    lastRefresh: state.lastRefresh,
  };
}

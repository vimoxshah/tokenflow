/**
 * CSV export.
 *
 * Two modes, both streamed so a full export never buffers the dataset:
 *   - "view"  the current filtered slice, at request granularity
 *   - "all"   every normalized record in the store
 *
 * Missing values are written as an empty cell, never as 0 — the whole point of
 * the null contract survives the export, so a spreadsheet can't silently turn
 * "not reported" into "zero".
 */
import { Store, decodeRecord } from '../core/store.js';

export const RECORD_COLUMNS = [
  ['timestamp', 'ts'],
  ['date', 'd'],
  ['hour', 'h'],
  ['provider', 'p'],
  ['model', 'm'],
  ['model_family', 'mf'],
  ['gateway', 'g'],
  ['client', 'c'],
  ['interface', 'i'],
  ['input_tokens', 'in'],
  ['output_tokens', 'ou'],
  ['cache_read_tokens', 'cr'],
  ['cache_write_tokens', 'cw'],
  ['cache_refresh_tokens', 'cf'],
  ['reasoning_tokens', 'rs'],
  ['total_tokens', 'tt'],
  ['total_is_partial', 'tp'],
  ['session_id', 's'],
  ['conversation_id', 'cv'],
  ['request_id', 'rq'],
  ['project', 'pj'],
  ['repository', 'rp'],
  ['git_branch', 'br'],
  ['category', 'k'],
  ['service_tier', 'tr'],
  ['estimated_cost', 'co'],
  ['cost_basis', 'cb'],
  ['measurement', 'ms'],
  ['source', 'so'],
  ['duration_ms', 'du'],
  ['user', 'u'],
  ['machine', 'mc'],
];

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvLine(values) {
  return values.map(csvCell).join(',') + '\n';
}

/**
 * Stream records as CSV.
 * @param {(chunk:string)=>void} write
 * @param {object} filter same shape as queryRecords
 */
export function streamRecordsCsv(write, filter = {}) {
  const store = new Store();
  write(csvLine(RECORD_COLUMNS.map(([name]) => name)));
  let n = 0;
  const from = filter.from || null;
  const to = filter.to || null;
  const sets = {};
  for (const [k, key] of [['provider', 'p'], ['model', 'm'], ['client', 'c'], ['interface', 'i'], ['project', 'pj'], ['source', 'so'], ['measurement', 'ms']]) {
    const v = filter[k];
    if (v) sets[key] = new Set(Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()));
  }
  let buf = '';
  store.scanRecords((o) => {
    if (from && o.d < from) return;
    if (to && o.d > to) return;
    for (const [key, set] of Object.entries(sets)) if (!set.has(o[key])) return;
    buf += csvLine(RECORD_COLUMNS.map(([, k]) => (k === 'tp' ? !!o[k] : o[k])));
    n++;
    if (buf.length > 1 << 18) { write(buf); buf = ''; }
  });
  if (buf) write(buf);
  return n;
}

/** Aggregated CSV of any computed table (used by per-chart "export table"). */
export function tableToCsv(columns, rows) {
  let out = csvLine(columns.map((c) => c.label ?? c.key));
  for (const r of rows) out += csvLine(columns.map((c) => (typeof c.value === 'function' ? c.value(r) : r[c.key])));
  return out;
}

/** tokenflow-usage-2026-08-20.csv */
export function exportFilename(prefix = 'tokenflow-usage', date = new Date(), ext = 'csv') {
  const d = date.toISOString().slice(0, 10);
  return `${prefix}-${d}.${ext}`;
}

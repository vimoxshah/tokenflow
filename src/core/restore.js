/**
 * Rebuild the store from a full CSV export.
 *
 * Why this exists: `tokenflow export --all` writes every normalized record at
 * request granularity, so that file is a complete, portable, human-readable
 * snapshot of the dataset. Restore turns it back into a store — which makes it
 * three useful things at once:
 *
 *   - portability     move a dataset to another machine, or into a team roll-up,
 *                     without shipping the vendors' raw session logs (which
 *                     contain prompts and source code; the CSV does not)
 *   - recovery        rebuild after the source logs have been rotated, pruned,
 *                     or moved out of reach
 *   - re-pricing      the cost of every *estimated* record is recomputed with
 *                     the current price table, so a pricing update can be
 *                     applied to history without re-reading gigabytes of logs
 *
 * What a restore honestly cannot recover: per-record `metadata` (working
 * directory, streaming audit trail, price provenance) is not part of the CSV
 * contract, so restored records carry `metadata.restored_from` and nothing
 * else. Measured costs are preserved verbatim and never re-estimated — a
 * gateway's own billing number is evidence, not an estimate.
 *
 * A restored slice is provisional: `refresh()` marks it stale as soon as the
 * real logs for that source are read again, so the two are never double
 * counted.
 */
import fs from 'node:fs';
import { Store, encodeRecord, fileId, writeJson, truncateFile, readJson } from './store.js';
import { paths, loadConfig } from './config.js';
import { computeTotal, hashId, MEASUREMENT } from './schema.js';
import { buildPriceBook, estimateCost } from './pricing.js';
import { RECORD_COLUMNS } from '../export/csv.js';

const NUM = new Set([
  'hour', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'cache_refresh_tokens', 'reasoning_tokens', 'total_tokens', 'estimated_cost', 'duration_ms',
]);

/**
 * Stream a CSV file row-by-row without materialising it.
 * Handles quoted cells, escaped quotes and newlines inside quotes.
 * @param {string} file
 * @param {(row:object, i:number)=>void} onRow
 * @returns {{rows:number, malformed:number, columns:string[]}}
 */
export function streamCsv(file, onRow) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let rest = '';
  let cell = '';
  let row = [];
  let quoted = false;
  let pendingQuote = false; // a '"' at a chunk boundary, escape or close unknown
  let columns = null;
  let rows = 0;
  let malformed = 0;

  const endRow = () => {
    row.push(cell);
    cell = '';
    const r = row;
    row = [];
    if (r.length === 1 && r[0] === '') return;
    if (!columns) { columns = r.map((h) => h.trim().replace(/^﻿/, '')); return; }
    if (r.length !== columns.length) { malformed++; return; }
    const o = {};
    for (let i = 0; i < columns.length; i++) o[columns[i]] = r[i];
    onRow(o, rows++);
  };

  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const text = rest + buf.toString('utf8', 0, n);
      // Keep a trailing partial UTF-8 sequence out of the parse.
      let end = text.length;
      while (end > 0 && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
      rest = text.slice(end);
      const chunk = text.slice(0, end);
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') { cell += '"'; continue; }
          quoted = false;
          // fall through and handle c as an unquoted character
        }
        if (quoted) {
          if (c === '"') {
            if (i + 1 < chunk.length) {
              if (chunk[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else pendingQuote = true;
          } else cell += c;
          continue;
        }
        if (c === '"') { quoted = true; continue; }
        if (c === ',') { row.push(cell); cell = ''; continue; }
        if (c === '\n') { endRow(); continue; }
        if (c === '\r') continue;
        cell += c;
      }
    }
    if (cell !== '' || row.length) endRow();
  } finally {
    fs.closeSync(fd);
  }
  return { rows, malformed, columns: columns || [] };
}

/** CSV cell -> record field, honouring the null contract ('' is not 0). */
function cellToField(name, raw) {
  if (raw === undefined || raw === '') return null;
  if (name === 'total_is_partial') return raw === 'true';
  if (NUM.has(name)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

/**
 * @param {string} file path to a full CSV export
 * @param {object} [opt]
 * @param {boolean} [opt.reprice=true] recompute estimated costs with the current table
 * @param {(e:object)=>void} [opt.onProgress]
 */
export function restoreFromCsv(file, opt = {}) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const t0 = Date.now();
  const progress = opt.onProgress || (() => {});
  const config = opt.config || loadConfig();
  const reprice = opt.reprice !== false;
  const priceBook = buildPriceBook(readJson(paths().pricing, {}));
  const store = new Store();

  const required = ['timestamp', 'date', 'provider', 'model'];
  const store_p = paths();

  // A restore replaces the contents of the store: it is the whole dataset, not
  // an increment, and mixing it with per-file offsets from a different machine
  // would be meaningless.
  store.state.sources = {};
  store.state.stale = [];
  store.state.counters = { records: 0, malformed: 0 };
  store.resetCube();
  store.resetSessions();
  store.resetActivity();
  for (const s of store.listShards()) truncateFile(`${store_p.records}/${s}`);

  const gen = (store.state.restored?.gen || 0) + 1;
  const bySource = {};
  const dropped = { noTimestamp: 0, noDate: 0 };
  let repriced = 0;
  let measuredKept = 0;
  let unpriced = 0;
  let checkedHeader = false;

  const res = streamCsv(file, (o, i) => {
    if (!checkedHeader) {
      checkedHeader = true;
      const missing = required.filter((c) => !(c in o));
      if (missing.length) throw new Error(`not a full tokenflow export — missing column(s): ${missing.join(', ')}`);
    }
    const rec = {};
    for (const [name] of RECORD_COLUMNS) rec[name] = cellToField(name, o[name]);
    if (!rec.timestamp) { dropped.noTimestamp++; return; }
    if (!rec.date) { dropped.noDate++; return; }

    rec.provider_label = rec.provider;
    rec.application = null;
    rec.tz_offset = null;
    rec.dow = dowOf(rec.date);
    rec.measurement = rec.measurement || MEASUREMENT.PRIMARY;
    rec.total_is_partial = !!rec.total_is_partial;
    rec.metadata = { restored_from: file.replace(/^.*\//, '') };

    const total = computeTotal(rec);
    if (total !== null) rec.total_tokens = total;

    if (rec.cost_basis === 'measured') {
      measuredKept++;
    } else if (reprice) {
      const c = estimateCost(rec, rec.model, rec.provider, priceBook, { tier: rec.service_tier });
      rec.estimated_cost = c.cost;
      rec.cost_basis = c.cost === null ? null : c.basis;
      if (c.cost === null) unpriced++;
      else {
        repriced++;
        if (c.partial) rec.metadata.cost_partial = true;
        if (c.tierMult !== 1) rec.metadata.cost_tier_multiplier = c.tierMult;
        if (c.src) rec.metadata.price_source = c.src;
      }
    }

    const src = rec.source || 'restore';
    rec.id = rec.id || hashId(`restore|${src}|${rec.timestamp}|${rec.request_id || rec.session_id || ''}|${i}`);
    rec._fileId = fileId('restore', src);
    rec._gen = gen;
    bySource[src] = (bySource[src] || 0) + 1;

    if (config.store?.keepRaw !== false) store.writer(rec.date).write(encodeRecord(rec));
    store.addToCube(rec);
    store.upsertSession(rec);
    store.addToActivity(rec);

    if ((i + 1) % 20000 === 0) progress({ type: 'progress', records: i + 1 });
  });

  store.closeWriters();
  const records = Object.values(bySource).reduce((a, b) => a + b, 0);
  store.state.counters = { records, malformed: res.malformed };
  store.state.restored = {
    file, at: new Date().toISOString(), gen, records, bySource, repriced,
    pricingVersion: priceBook.version,
  };
  store.state.lastRefresh = new Date().toISOString();
  // Every restored source gets a state entry so `status` can explain where the
  // data came from, with no file offsets — an incremental refresh must not
  // believe it has already read logs it has never seen.
  for (const [id, n] of Object.entries(bySource)) {
    const st = store.sourceState(id);
    st.files = {};
    st.cursor = null;
    st.records = n;
    st.restored = true;
    st.lastRefresh = store.state.restored.at;
  }
  store.saveCube({ tz: config.timezone || null, pricingVersion: priceBook.version });
  store.saveSessions();
  store.saveActivity();
  store.saveState();
  writeJson(`${store_p.data}/project-paths.json`, readJson(`${store_p.data}/project-paths.json`, { paths: [] }));

  return {
    file,
    records,
    bySource,
    malformed: res.malformed,
    dropped,
    repriced,
    measuredKept,
    unpriced,
    pricingVersion: priceBook.version,
    durationMs: Date.now() - t0,
  };
}

/** 0 = Monday, matching schema.dateParts(). */
function dowOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(+d)) return 0;
  return (d.getUTCDay() + 6) % 7;
}

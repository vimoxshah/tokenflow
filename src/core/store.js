/**
 * Persistence + the aggregate cube.
 *
 * Three artefacts, each with a different job:
 *
 *   data/records/YYYY-MM.jsonl   request-level facts (Data Explorer, full CSV)
 *   data/cube.json               the pre-aggregated fact table the dashboard
 *                                loads once and then filters entirely in the
 *                                browser — so changing a filter costs zero
 *                                API calls
 *   data/sessions.json           one row per session (session counts, tokens
 *                                per session, long/short session analysis)
 *
 * ## How incremental refresh stays exact
 *
 * Session transcripts are append-only files. `state.json` remembers each
 * file's `{size, mtimeMs, offset, gen}`. On refresh:
 *   - unchanged (same size+mtime)      -> skipped entirely, zero reads
 *   - grew                             -> read resumes at `offset`; the bytes
 *                                         already ingested are never re-read,
 *                                         so no dedup index is needed
 *   - shrank / rewritten               -> `gen` is bumped and the file's old
 *                                         records become stale; a compaction
 *                                         pass rewrites the shards without
 *                                         them and rebuilds the cube
 *
 * Because dedup is structural rather than probabilistic, the cube can be
 * updated by pure addition, which is what makes a 1.5 GB corpus refreshable
 * in seconds instead of minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDirs } from './config.js';
import { JsonlWriter, readLines } from './jsonl.js';
import { hashId, BILLABLE_TOKEN_FIELDS, MEASUREMENT } from './schema.js';

export const CUBE_VERSION = 4;

/** Cube dimension order — also the on-disk column order. */
export const CUBE_DIMS = ['d', 'h', 'w', 'p', 'm', 'mf', 'c', 'i', 'g', 'pj', 'rp', 'st', 'ms'];
/** Cube measure order. */
export const CUBE_MEASURES = [
  'in', 'out', 'cr', 'cw', 'cf', 'rs',
  'req', 'cost', 'costMeasured', 'costReq',
  'naIn', 'naOut', 'naCr', 'naCw',
];

/** Compact on-disk record codec (short keys, nulls omitted). */
const REC_KEYS = [
  ['ts', 'timestamp'], ['d', 'date'], ['h', 'hour'], ['w', 'dow'], ['tz', 'tz_offset'],
  ['p', 'provider'], ['pl', 'provider_label'], ['g', 'gateway'],
  ['m', 'model'], ['mf', 'model_family'],
  ['c', 'client'], ['ap', 'application'], ['i', 'interface'],
  ['in', 'input_tokens'], ['ou', 'output_tokens'], ['cr', 'cache_read_tokens'],
  ['cw', 'cache_write_tokens'], ['cf', 'cache_refresh_tokens'], ['rs', 'reasoning_tokens'],
  ['tt', 'total_tokens'], ['tp', 'total_is_partial'],
  ['s', 'session_id'], ['cv', 'conversation_id'], ['rq', 'request_id'],
  ['pj', 'project'], ['rp', 'repository'], ['br', 'git_branch'], ['k', 'category'],
  ['tr', 'service_tier'],
  ['co', 'estimated_cost'], ['cb', 'cost_basis'],
  ['so', 'source'], ['ms', 'measurement'], ['u', 'user'], ['mc', 'machine'],
  ['du', 'duration_ms'], ['x', 'metadata'], ['id', 'id'],
  ['f', '_fileId'], ['gn', '_gen'],
];

export function encodeRecord(r) {
  const o = {};
  for (const [k, full] of REC_KEYS) {
    const v = r[full];
    if (v === null || v === undefined || v === false) continue;
    if (full === 'metadata' && (!v || Object.keys(v).length === 0)) continue;
    o[k] = v;
  }
  return o;
}

export function decodeRecord(o) {
  const r = {};
  for (const [k, full] of REC_KEYS) r[full] = o[k] === undefined ? null : o[k];
  r.total_is_partial = !!o.tp;
  if (!r.metadata) r.metadata = {};
  return r;
}

export class Store {
  constructor() {
    this.p = ensureDirs();
    this.state = readJson(this.p.state, {
      version: CUBE_VERSION,
      sources: {},
      lastRefresh: null,
      lastRefreshDurationMs: null,
      stale: [],
      counters: { records: 0, malformed: 0 },
    });
    this._cube = null;
    this._sessions = null;
    this._writers = new Map();
  }

  // -------------------------------------------------------------- state ----
  sourceState(id) {
    if (!this.state.sources[id]) {
      this.state.sources[id] = { files: {}, cursor: null, lastRefresh: null, records: 0, notes: [] };
    }
    return this.state.sources[id];
  }

  /**
   * Decide what to do with a source file.
   * @returns {{action:'skip'|'append'|'rewrite', start:number, gen:number, prev:object|null}}
   */
  planFile(sourceId, key, stat) {
    const st = this.sourceState(sourceId);
    const prev = st.files[key];
    if (!prev) return { action: 'rewrite', start: 0, gen: 1, prev: null };
    if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
      return { action: 'skip', start: prev.offset || 0, gen: prev.gen, prev };
    }
    if (stat.size >= prev.size) {
      return { action: 'append', start: prev.offset || 0, gen: prev.gen, prev };
    }
    // Truncated or rewritten: everything previously ingested from this file is
    // now suspect. Bump the generation and mark the old one stale.
    return { action: 'rewrite', start: 0, gen: (prev.gen || 1) + 1, prev };
  }

  commitFile(sourceId, key, stat, gen, offset, records, prevGen) {
    const st = this.sourceState(sourceId);
    if (prevGen && prevGen !== gen) {
      this.state.stale.push([fileId(sourceId, key), prevGen]);
    }
    st.files[key] = { size: stat.size, mtimeMs: stat.mtimeMs, offset, gen, records: (st.files[key]?.gen === gen ? (st.files[key].records || 0) : 0) + records, at: new Date().toISOString() };
  }

  saveState() {
    writeJson(this.p.state, this.state);
  }

  // ------------------------------------------------------------- records ---
  shardFor(date) {
    return path.join(this.p.records, `${date.slice(0, 7)}.jsonl`);
  }

  writer(date) {
    const f = this.shardFor(date);
    let w = this._writers.get(f);
    if (!w) {
      w = new JsonlWriter(f);
      this._writers.set(f, w);
    }
    return w;
  }

  closeWriters() {
    for (const w of this._writers.values()) w.close();
    this._writers.clear();
  }

  listShards() {
    try {
      return fs.readdirSync(this.p.records).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
  }

  /**
   * Stream request-level records. `onRec` may return `false` to stop early.
   * @param {(r:object)=>boolean|void} onRec
   * @param {{months?:string[], stale?:Set<string>}} [opt]
   */
  scanRecords(onRec, opt = {}) {
    const stale = opt.stale || this.staleSet();
    let n = 0;
    for (const shard of this.listShards()) {
      if (opt.months && !opt.months.includes(shard.slice(0, 7))) continue;
      let stop = false;
      readLines(path.join(this.p.records, shard), (line) => {
        if (stop) return;
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (stale.size && stale.has(`${o.f}:${o.gn}`)) return;
        n++;
        if (onRec(o) === false) stop = true;
      });
      if (stop) break;
    }
    return n;
  }

  staleSet() {
    return new Set((this.state.stale || []).map(([f, g]) => `${f}:${g}`));
  }

  // ---------------------------------------------------------------- cube ---
  cube() {
    if (!this._cube) {
      const raw = readJson(this.p.cube, null);
      this._cube = raw && raw.version === CUBE_VERSION ? raw : emptyCube();
    }
    return this._cube;
  }

  /** In-memory Map keyed by the dimension tuple, for additive updates. */
  cubeMap() {
    if (!this._cubeMap) {
      const c = this.cube();
      const map = new Map();
      for (const row of c.rows) map.set(row.slice(0, CUBE_DIMS.length).join(''), row);
      this._cubeMap = map;
    }
    return this._cubeMap;
  }

  addToCube(rec) {
    const map = this.cubeMap();
    const dims = [
      rec.date, rec.hour, rec.dow, rec.provider, rec.model, rec.model_family,
      rec.client, rec.interface, rec.gateway || 'direct', rec.project || 'unknown',
      rec.repository || rec.project || 'unknown', rec.service_tier || 'unspecified',
      rec.measurement,
    ];
    const key = dims.join('');
    let row = map.get(key);
    if (!row) {
      row = [...dims, ...CUBE_MEASURES.map(() => 0)];
      map.set(key, row);
    }
    const B = CUBE_DIMS.length;
    const M = (name) => B + CUBE_MEASURES.indexOf(name);
    addNullable(row, M('in'), rec.input_tokens, M('naIn'));
    addNullable(row, M('out'), rec.output_tokens, M('naOut'));
    addNullable(row, M('cr'), rec.cache_read_tokens, M('naCr'));
    addNullable(row, M('cw'), rec.cache_write_tokens, M('naCw'));
    if (rec.cache_refresh_tokens !== null) row[M('cf')] += rec.cache_refresh_tokens;
    if (rec.reasoning_tokens !== null) row[M('rs')] += rec.reasoning_tokens;
    row[M('req')] += 1;
    if (rec.estimated_cost !== null) {
      if (rec.cost_basis === 'measured') row[M('costMeasured')] += rec.estimated_cost;
      else { row[M('cost')] += rec.estimated_cost; row[M('costReq')] += 1; }
    }
  }

  saveCube(meta = {}) {
    const rows = [...this.cubeMap().values()];
    // Round floats so the JSON stays small and stable across refreshes.
    const ci = CUBE_DIMS.length + CUBE_MEASURES.indexOf('cost');
    const cmi = CUBE_DIMS.length + CUBE_MEASURES.indexOf('costMeasured');
    for (const r of rows) {
      r[ci] = round6(r[ci]);
      r[cmi] = round6(r[cmi]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const cube = {
      version: CUBE_VERSION,
      dims: CUBE_DIMS,
      measures: CUBE_MEASURES,
      builtAt: new Date().toISOString(),
      ...meta,
      rows,
    };
    writeJson(this.p.cube, cube);
    this._cube = cube;
    return cube;
  }

  resetCube() {
    this._cube = emptyCube();
    this._cubeMap = new Map();
  }

  // ------------------------------------------------------------ activity ---
  /**
   * Daily rollup of *work* signals (commits, line churn, AI-authored edits).
   * Kept separate from the token cube because these are a different kind of
   * measurement — they belong in the correlation panel, never in a token total.
   */
  activity() {
    if (!this._activity) {
      const raw = readJson(this.p.activity ?? path.join(this.p.data, 'activity.json'), null);
      this._activity = raw && raw.version === CUBE_VERSION ? raw : { version: CUBE_VERSION, rows: {} };
    }
    return this._activity;
  }

  addToActivity(rec) {
    const md = rec.metadata || {};
    const isCommit = rec.category === 'commit';
    const isEdit = typeof rec.category === 'string' && rec.category.startsWith('ai-edit');
    if (!isCommit && !isEdit) return;
    const key = `${rec.date}|${rec.source}|${rec.project || 'unknown'}`;
    const rows = this.activity().rows;
    let a = rows[key];
    if (!a) {
      a = rows[key] = {
        d: rec.date, so: rec.source, pj: rec.project || 'unknown',
        commits: 0, files: 0, ins: 0, del: 0, aiLines: 0, tabLines: 0, humanLines: 0, edits: 0,
      };
    }
    if (isCommit) {
      a.commits++;
      a.files += num(md.files_changed);
      a.ins += num(md.insertions ?? md.lines_added);
      a.del += num(md.deletions ?? md.lines_deleted);
      a.aiLines += num(md.ai_lines_added);
      a.tabLines += num(md.tab_lines_added);
      a.humanLines += num(md.human_lines_added);
    } else {
      a.edits++;
    }
  }

  saveActivity() {
    writeJson(this.p.activity ?? path.join(this.p.data, 'activity.json'), this.activity());
  }

  resetActivity() {
    this._activity = { version: CUBE_VERSION, rows: {} };
  }

  // ------------------------------------------------------------ sessions ---
  sessions() {
    if (!this._sessions) {
      const raw = readJson(this.p.sessions, null);
      this._sessions = raw && raw.version === CUBE_VERSION ? raw : { version: CUBE_VERSION, rows: {} };
    }
    return this._sessions;
  }

  upsertSession(rec) {
    const sid = rec.session_id || `${rec.source}:${rec.date}:${rec.project || 'unknown'}`;
    const rows = this.sessions().rows;
    let s = rows[sid];
    if (!s) {
      s = rows[sid] = {
        id: sid, so: rec.source, p: rec.provider, m: rec.model, mf: rec.model_family,
        c: rec.client, i: rec.interface, g: rec.gateway || 'direct',
        pj: rec.project || 'unknown', rp: rec.repository || rec.project || 'unknown',
        br: rec.git_branch || null, st: rec.service_tier || 'unspecified', ms: rec.measurement,
        start: rec.timestamp, end: rec.timestamp, d: rec.date, h: rec.hour, w: rec.dow,
        req: 0, in: 0, out: 0, cr: 0, cw: 0, cf: 0, rs: 0, cost: 0, models: {},
      };
    }
    if (rec.timestamp < s.start) { s.start = rec.timestamp; s.d = rec.date; s.h = rec.hour; s.w = rec.dow; }
    if (rec.timestamp > s.end) s.end = rec.timestamp;
    s.req++;
    for (const [k, f] of [['in', 'input_tokens'], ['out', 'output_tokens'], ['cr', 'cache_read_tokens'], ['cw', 'cache_write_tokens'], ['cf', 'cache_refresh_tokens'], ['rs', 'reasoning_tokens']]) {
      if (rec[f] !== null) s[k] += rec[f];
    }
    if (rec.estimated_cost !== null) s.cost += rec.estimated_cost;
    if (rec.model) s.models[rec.model] = (s.models[rec.model] || 0) + 1;
    // Session-level model is the one it spent most requests on.
    let top = null, best = -1;
    for (const [mm, n] of Object.entries(s.models)) if (n > best) { best = n; top = mm; }
    s.m = top;
    return s;
  }

  saveSessions() {
    const s = this.sessions();
    for (const row of Object.values(s.rows)) row.cost = round6(row.cost);
    writeJson(this.p.sessions, s);
  }

  resetSessions() {
    this._sessions = { version: CUBE_VERSION, rows: {} };
  }

  /**
   * Sessions as a flat array with derived duration + total.
   * The per-session model histogram is dropped: `m` already carries the model
   * the session spent most of its requests on, and keeping the histogram would
   * roughly double the size of the bundle the browser downloads.
   */
  sessionList() {
    return Object.values(this.sessions().rows).map((s) => {
      const { models, ...rest } = s;
      return {
        ...rest,
        total: s.in + s.out + s.cr + s.cw,
        durationMs: new Date(s.end).getTime() - new Date(s.start).getTime(),
      };
    });
  }
}

function num(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v);
}

function addNullable(row, idx, v, naIdx) {
  if (v === null || v === undefined) row[naIdx] += 1;
  else row[idx] += v;
}

function emptyCube() {
  return { version: CUBE_VERSION, dims: CUBE_DIMS, measures: CUBE_MEASURES, builtAt: null, rows: [] };
}

/**
 * Rewrite the shards without records from stale generations.
 *
 * Called automatically after a per-provider re-ingest, and available as
 * `tokenflow compact`. Falls back to an in-place rewrite on mounts that refuse
 * rename.
 */
export function compactShards(store) {
  const stale = store.staleSet();
  if (!stale.size) return { kept: 0, dropped: 0, shards: 0 };
  let kept = 0;
  let dropped = 0;
  let shards = 0;
  for (const shard of store.listShards()) {
    const src = path.join(store.p.records, shard);
    const tmp = src + '.compact';
    let buf = '';
    const out = fs.openSync(tmp, 'w');
    try {
      readLines(src, (line) => {
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (stale.has(`${o.f}:${o.gn}`)) { dropped++; return; }
        kept++;
        buf += line + '\n';
        if (buf.length > 1 << 20) { fs.writeSync(out, buf); buf = ''; }
      });
      if (buf) fs.writeSync(out, buf);
    } finally {
      fs.closeSync(out);
    }
    try {
      fs.renameSync(tmp, src);
    } catch (err) {
      if (!['EPERM', 'EXDEV', 'EACCES', 'ENOTSUP'].includes(err.code)) throw err;
      fs.writeFileSync(src, fs.readFileSync(tmp));
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave the temp file */ }
    }
    shards++;
  }
  store.state.stale = [];
  return { kept, dropped, shards };
}

export function fileId(sourceId, key) {
  return hashId(sourceId, key);
}

export function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Atomic-ish write: temp file + rename, which is the right thing on a local
 * disk. Some mounts (network shares, FUSE bridges, sandboxed volumes) refuse
 * rename or unlink, so fall back to writing in place rather than failing the
 * whole refresh.
 */
export function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = JSON.stringify(v);
  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, f);
    return;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* leave the temp file */ }
    if (!['EPERM', 'EXDEV', 'EACCES', 'ENOTSUP', 'EBUSY'].includes(err.code)) throw err;
  }
  fs.writeFileSync(f, body);
}

/** Empty a file without unlinking it — mounts that block unlink allow this. */
export function truncateFile(f) {
  try {
    fs.rmSync(f, { force: true });
    return;
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EBUSY'].includes(err.code)) throw err;
  }
  try {
    fs.truncateSync(f, 0);
  } catch { /* nothing we can do; the shard will be rewritten in place */ }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

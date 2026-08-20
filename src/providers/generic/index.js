/**
 * Generic importer — the escape hatch that keeps this project useful for
 * providers nobody has written an adapter for yet.
 *
 * Accepts CSV / TSV / JSON / JSONL / SQLite, driven by a saved field mapping
 * so the second import of the same export needs no configuration at all.
 *
 * A mapping lives at $TOKENFLOW_HOME/mappings/<name>.json:
 *
 * {
 *   "name": "openrouter-export",
 *   "format": "csv",                  // csv | tsv | json | jsonl | sqlite
 *   "files": ["~/Downloads/openrouter-*.csv"],
 *   "table": "usage",                 // sqlite only
 *   "timestampFormat": "iso",         // iso | epoch_ms | epoch_s
 *   "defaults": { "client": "openrouter", "interface": "API" },
 *   "fields": {
 *     "timestamp":          "created_at",
 *     "model":              "model",
 *     "input_tokens":       "prompt_tokens",
 *     "output_tokens":      "completion_tokens",
 *     "cache_read_tokens":  "cached_tokens",
 *     "estimated_cost":     "cost_usd",
 *     "session_id":         "generation_id"
 *   }
 * }
 *
 * Unmapped token fields stay `null` — the importer never fills a gap with 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { readLines } from '../../core/jsonl.js';
import { paths } from '../../core/config.js';
import { MEASUREMENT } from '../../core/schema.js';
import { openReadOnly } from '../../core/sqlite.js';

export const MAPPABLE_FIELDS = [
  'timestamp', 'model', 'provider', 'client', 'application', 'interface',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'cache_refresh_tokens', 'reasoning_tokens', 'total_tokens',
  'session_id', 'conversation_id', 'request_id',
  'project', 'repository', 'git_branch', 'category', 'estimated_cost', 'user',
];

export function loadMappings(ctx) {
  const dir = paths().mappings;
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      m.name = m.name || f.replace(/\.json$/, '');
      out.push(m);
    } catch { /* skip unreadable mapping */ }
  }
  for (const m of ctx?.config?.sources?.generic?.imports || []) out.push(m);
  return out;
}

function expandGlobs(patterns) {
  const out = [];
  for (const raw of patterns || []) {
    const p = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (!p.includes('*')) {
      if (fs.existsSync(p)) out.push(p);
      continue;
    }
    const dir = path.dirname(p);
    const rx = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    try {
      for (const f of fs.readdirSync(dir)) if (rx.test(f)) out.push(path.join(dir, f));
    } catch { /* directory missing */ }
  }
  return out;
}

export default createProvider({
  id: 'generic',
  name: 'Generic import (CSV / JSON / JSONL / SQLite)',
  description: 'Import any usage export with a saved field mapping. Use this for providers without a dedicated adapter.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['a mapping in $TOKENFLOW_HOME/mappings/*.json'],

  async detect(ctx) {
    const maps = loadMappings(ctx);
    if (!maps.length) {
      return { available: false, detail: 'no import mappings defined (see `tokenflow import --help`)' };
    }
    const files = maps.flatMap((m) => expandGlobs(m.files));
    return {
      available: files.length > 0,
      detail: `${maps.length} mapping(s), ${files.length} file(s)`,
      paths: files,
    };
  },

  async discover(ctx) {
    const out = [];
    for (const m of loadMappings(ctx)) {
      for (const f of expandGlobs(m.files)) {
        let stat;
        try { stat = fs.statSync(f); } catch { continue; }
        out.push({ key: `${m.name}:${path.basename(f)}`, path: f, stat, mapping: m });
      }
    }
    return out;
  },

  async ingestFile(ref, ctx, emit) {
    const m = ref.mapping;
    const fmt = (m.format || inferFormat(ref.path)).toLowerCase();
    let records = 0;
    let malformed = 0;
    let offset = ref.stat.size;
    let seq = 0;

    const push = (row) => {
      const rec = mapRow(row, m, seq++);
      if (!rec) { malformed++; return; }
      emit(rec);
      records++;
    };

    if (fmt === 'jsonl') {
      const res = readLines(ref.path, (line) => {
        try { push(JSON.parse(line)); } catch { malformed++; }
      }, { start: ref.start });
      offset = res.offset;
    } else if (fmt === 'json') {
      const d = JSON.parse(fs.readFileSync(ref.path, 'utf8'));
      const rows = Array.isArray(d) ? d : (d.records || d.data || d.usage || []);
      for (const r of rows) push(r);
    } else if (fmt === 'csv' || fmt === 'tsv') {
      const rows = parseDelimited(fs.readFileSync(ref.path, 'utf8'), fmt === 'tsv' ? '\t' : ',');
      for (const r of rows) push(r);
    } else if (fmt === 'sqlite') {
      const db = openReadOnly(ref.path);
      try {
        const sql = m.query || `SELECT * FROM "${String(m.table).replace(/"/g, '""')}"`;
        for (const r of db.prepare(sql).all()) push(r);
      } finally {
        db.close();
      }
    } else {
      throw new Error(`unsupported format "${fmt}" for ${ref.path}`);
    }
    return { offset, records, malformed };
  },

  /** Exposed for tests and for `tokenflow import --dry-run`. */
  normalize(row, mapping) {
    return mapRow(row, mapping, 0);
  },
});

export function mapRow(row, m, seq) {
  const f = m.fields || {};
  const get = (name) => {
    const src = f[name];
    if (!src) return undefined;
    if (typeof src === 'string') return row[src];
    if (src && typeof src === 'object' && src.const !== undefined) return src.const;
    return undefined;
  };
  const ts = normalizeTs(get('timestamp'), m.timestampFormat);
  if (!ts) return null;

  const out = {
    id: m.idField && row[m.idField] ? `generic-${m.name}-${row[m.idField]}` : undefined,
    timestamp: ts,
    model: str(get('model')) ?? m.defaults?.model ?? null,
    provider: str(get('provider')) ?? m.defaults?.provider ?? undefined,
    client: str(get('client')) ?? m.defaults?.client ?? 'generic',
    application: str(get('application')) ?? m.defaults?.application ?? m.name,
    interface: str(get('interface')) ?? m.defaults?.interface ?? undefined,
    interfaceSignals: [str(get('interface')), m.defaults?.interface, str(get('client')), m.defaults?.client],
    session_id: str(get('session_id')),
    conversation_id: str(get('conversation_id')),
    request_id: str(get('request_id')),
    project: str(get('project')) ?? m.defaults?.project ?? null,
    repository: str(get('repository')),
    git_branch: str(get('git_branch')),
    category: str(get('category')),
    user: str(get('user')) ?? m.defaults?.user ?? null,
    measurement: m.measurement || MEASUREMENT.PRIMARY,
    metadata: { import: m.name, ...(m.metadata || {}) },
  };
  for (const tf of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_refresh_tokens', 'reasoning_tokens']) {
    out[tf] = numOrNull(get(tf));
  }
  const cost = numOrNull(get('estimated_cost'));
  if (cost !== null) out.measured_cost = cost;
  return out;
}

function inferFormat(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.jsonl' || e === '.ndjson') return 'jsonl';
  if (e === '.json') return 'json';
  if (e === '.tsv') return 'tsv';
  if (e === '.db' || e === '.sqlite' || e === '.sqlite3') return 'sqlite';
  return 'csv';
}

export function normalizeTs(v, format) {
  if (v === undefined || v === null || v === '') return null;
  if (format === 'epoch_ms' || (typeof v === 'number' && v > 1e11)) {
    const d = new Date(Number(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (format === 'epoch_s' || (typeof v === 'number' && v > 1e8)) {
    const d = new Date(Number(v) * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** RFC4180-ish delimited parser: quotes, escaped quotes, embedded newlines. */
export function parseDelimited(text, delim = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === delim) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ''));
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function str(v) {
  return v === undefined || v === null || v === '' ? null : String(v);
}
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

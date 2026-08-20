/**
 * Test helpers: run a real adapter over a fixture and collect the fully
 * normalized records, without touching the on-disk store.
 */
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { enrich } from '../src/core/ingest.js';
import { buildPriceBook } from '../src/core/pricing.js';
import { BUILTIN_MODEL_RULES } from '../src/core/model-map.js';

export const FIXTURES = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures');

export function ctx(overrides = {}) {
  return {
    config: { sources: {}, interfaceOverrides: {} },
    tz: 'UTC',
    home: FIXTURES,
    user: 'tester',
    machine: 'test-machine',
    priceBook: buildPriceBook({}),
    rules: BUILTIN_MODEL_RULES,
    log: () => {},
    ...overrides,
  };
}

/**
 * Drive an adapter's ingestFile over one fixture file.
 * @returns {{records: object[], result: object, state: object, promise: any}}
 */
export function ingestFixture(provider, file, { start = 0, state = {}, c = ctx(), key = null } = {}) {
  const abs = path.isAbsolute(file) ? file : path.join(FIXTURES, file);
  const records = [];
  let seq = 0;
  const ref = { key: key || path.basename(abs), path: abs, stat: fs.statSync(abs), start, state, gen: 1, label: 'fixture' };
  const emit = (partial) => {
    const rec = enrich(partial, { ctx: c, provider, seq: seq++, fileRef: ref });
    if (rec) records.push(rec);
  };
  const result = provider.ingestFile(ref, c, emit);
  return { records, result: result && typeof result.then === 'function' ? null : result, state: ref.state, promise: result };
}

/** Same, but awaits an async adapter. */
export async function ingestFixtureAsync(provider, file, opt = {}) {
  const r = ingestFixture(provider, file, opt);
  const result = await r.promise;
  return { ...r, result };
}

export async function fetchAll(provider, c = ctx(), sourceState = {}) {
  const records = [];
  let seq = 0;
  const ref = { key: provider.id, path: null, gen: 1, state: {} };
  const emit = (partial) => {
    const rec = enrich(partial, { ctx: c, provider, seq: seq++, fileRef: ref });
    if (rec) records.push(rec);
  };
  const result = await provider.fetchUsage(c, emit, sourceState);
  return { records, result };
}

/** Build a cube from records the same way the store does, for analytics tests. */
export async function cubeFrom(records) {
  const { CUBE_DIMS, CUBE_MEASURES } = await import('../src/core/store.js');
  const map = new Map();
  const B = CUBE_DIMS.length;
  const M = (n) => B + CUBE_MEASURES.indexOf(n);
  for (const rec of records) {
    const dims = [
      rec.date, rec.hour, rec.dow, rec.provider, rec.model, rec.model_family,
      rec.client, rec.interface, rec.gateway || 'direct', rec.project || 'unknown',
      rec.repository || rec.project || 'unknown', rec.service_tier || 'unspecified',
      rec.measurement,
    ];
    const k = dims.join('');
    let row = map.get(k);
    if (!row) { row = [...dims, ...CUBE_MEASURES.map(() => 0)]; map.set(k, row); }
    const add = (name, v, naName) => {
      if (v === null || v === undefined) row[M(naName)] += 1;
      else row[M(name)] += v;
    };
    add('in', rec.input_tokens, 'naIn');
    add('out', rec.output_tokens, 'naOut');
    add('cr', rec.cache_read_tokens, 'naCr');
    add('cw', rec.cache_write_tokens, 'naCw');
    if (rec.cache_refresh_tokens !== null) row[M('cf')] += rec.cache_refresh_tokens;
    if (rec.reasoning_tokens !== null) row[M('rs')] += rec.reasoning_tokens;
    row[M('req')] += 1;
    if (rec.estimated_cost !== null) {
      if (rec.cost_basis === 'measured') row[M('costMeasured')] += rec.estimated_cost;
      else { row[M('cost')] += rec.estimated_cost; row[M('costReq')] += 1; }
    }
  }
  return {
    version: 4, dims: CUBE_DIMS, measures: CUBE_MEASURES, builtAt: null,
    rows: [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}

export function sessionsFrom(records) {
  const by = new Map();
  for (const r of records) {
    const id = r.session_id || `${r.source}:${r.date}`;
    let s = by.get(id);
    if (!s) {
      s = {
        id, so: r.source, p: r.provider, m: r.model, mf: r.model_family, c: r.client,
        i: r.interface, g: r.gateway || 'direct', pj: r.project || 'unknown',
        rp: r.repository || r.project || 'unknown', st: r.service_tier || 'unspecified',
        ms: r.measurement,
        start: r.timestamp, end: r.timestamp, d: r.date, h: r.hour, w: r.dow,
        req: 0, in: 0, out: 0, cr: 0, cw: 0, cf: 0, rs: 0, cost: 0,
      };
      by.set(id, s);
    }
    s.req++;
    for (const [k, f] of [['in', 'input_tokens'], ['out', 'output_tokens'], ['cr', 'cache_read_tokens'], ['cw', 'cache_write_tokens']]) {
      if (r[f] !== null) s[k] += r[f];
    }
    if (r.timestamp < s.start) s.start = r.timestamp;
    if (r.timestamp > s.end) s.end = r.timestamp;
  }
  return [...by.values()].map((s) => ({ ...s, total: s.in + s.out + s.cr + s.cw, durationMs: new Date(s.end).getTime() - new Date(s.start).getTime() }));
}

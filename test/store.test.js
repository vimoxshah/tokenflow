import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Store + end-to-end refresh behaviour. Each test gets its own TOKENFLOW_HOME so
 * nothing here can touch a real installation.
 */
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-test-'));
  const prev = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = dir;
  // Fresh module graph so config paths are re-resolved for this home.
  const bust = `?t=${Date.now()}${Math.random()}`;
  const mods = {
    store: await import(`../src/core/store.js${bust}`),
    ingest: await import(`../src/core/ingest.js${bust}`),
    bundle: await import(`../src/core/bundle.js${bust}`),
    registry: await import(`../src/core/registry.js${bust}`),
    jsonl: await import(`../src/core/jsonl.js${bust}`),
    restore: await import(`../src/core/restore.js${bust}`),
    csv: await import(`../src/export/csv.js${bust}`),
  };
  try {
    return await fn(dir, mods);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME;
    else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A tiny file-based provider whose source file we control from the test. */
function makeProvider(createProvider, file, id = 'testsrc') {
  return createProvider({
    id,
    name: 'Test source',
    async detect() { return { available: fs.existsSync(file), detail: file }; },
    async discover() {
      return fs.existsSync(file) ? [{ key: 'f1', path: file, stat: fs.statSync(file) }] : [];
    },
    async ingestFile(ref, ctx, emit) {
      const { readLines } = ref._readLines;
      let records = 0;
      const res = readLines(ref.path, (line) => {
        const o = JSON.parse(line);
        emit({
          timestamp: o.ts, model: 'claude-opus-5', client: 'claude-code',
          interfaceSignals: ['cli'], input_tokens: o.in, output_tokens: o.out,
          cache_read_tokens: o.cr ?? null, cache_write_tokens: null,
          session_id: o.s, project: 'p', request_id: o.id,
        });
        records++;
      }, { start: ref.start });
      return { offset: res.offset, records };
    },
  });
}

test('an unchanged file is skipped entirely on the next refresh', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 100, s: 's1', id: 'r1' }),
      JSON.stringify({ ts: '2026-08-01T11:00:00Z', in: 20, out: 6, cr: 200, s: 's1', id: 'r2' }),
    ].join('\n') + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    // hand the reader in so the fake provider stays dependency-free
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };

    const r1 = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r1.newRecords, 2);
    const r2 = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r2.newRecords, 0, 'no duplicates');
    assert.equal(r2.filesSkipped, 1, 'the unchanged file was not even read');
    assert.equal(r2.bytesRead, 0);

    const b = m.bundle.buildBundle();
    assert.equal(b.health.records, 2);
  });
});

test('an appended file yields only the appended records', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 100, s: 's1', id: 'r1' }) + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };

    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    // Append, and make sure the mtime actually moves.
    fs.appendFileSync(file, JSON.stringify({ ts: '2026-08-02T10:00:00Z', in: 30, out: 7, cr: 300, s: 's2', id: 'r2' }) + '\n');
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(file, t, t);

    const r2 = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r2.newRecords, 1, 'only the new line');

    const b = m.bundle.buildBundle();
    assert.equal(b.health.records, 2);
    const total = b.cube.rows.reduce((a, row) => {
      const off = b.cube.dims.length;
      const i = (n) => off + b.cube.measures.indexOf(n);
      return a + row[i('in')] + row[i('out')] + row[i('cr')] + row[i('cw')];
    }, 0);
    assert.equal(total, 10 + 5 + 100 + 30 + 7 + 300, 'nothing double counted');
  });
});

test('a partially written trailing line is not consumed until it is complete', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    const good = JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 0, s: 's1', id: 'r1' }) + '\n';
    fs.writeFileSync(file, good + '{"ts":"2026-08-01T11:00:00Z","in":2'); // truncated
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };

    const r1 = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r1.newRecords, 1, 'the incomplete line is left alone');

    fs.appendFileSync(file, '0,"out":6,"cr":0,"s":"s1","id":"r2"}\n');
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(file, t, t);
    const r2 = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r2.newRecords, 1, 'and picked up once it is whole');
  });
});

test('a rewritten (shrunk) file supersedes its old records instead of adding to them', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 0, s: 's1', id: 'r1' }),
      JSON.stringify({ ts: '2026-08-01T11:00:00Z', in: 20, out: 5, cr: 0, s: 's1', id: 'r2' }),
      JSON.stringify({ ts: '2026-08-01T12:00:00Z', in: 30, out: 5, cr: 0, s: 's1', id: 'r3' }),
    ].join('\n') + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };
    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });

    fs.writeFileSync(file, JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 99, out: 1, cr: 0, s: 's1', id: 'r1' }) + '\n');
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(file, t, t);
    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });

    const store = new m.store.Store();
    assert.ok(store.state.stale.length > 0, 'the old generation is marked stale');
    const { compactShards } = m.store;
    const res = compactShards(store);
    assert.equal(res.dropped, 3, 'the three superseded records are dropped');
    const rb = m.ingest.rebuildAggregates(store);
    assert.equal(rb.records, 1);
  });
});

test('a scoped --full re-ingest is idempotent and leaves other sources alone', async () => {
  await withHome(async (dir, m) => {
    const fileA = path.join(dir, 'a.jsonl');
    const fileB = path.join(dir, 'b.jsonl');
    fs.writeFileSync(fileA, JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 0, s: 'a1', id: 'a1' }) + '\n');
    fs.writeFileSync(fileB, JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 70, out: 5, cr: 0, s: 'b1', id: 'b1' }) + '\n');
    const pa = makeProvider(m.registry.createProvider, fileA, 'src-a');
    const pb = makeProvider(m.registry.createProvider, fileB, 'src-b');
    const wrap = (p) => ({ ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) });
    const reg = [wrap(pa), wrap(pb)];

    await m.ingest.refresh({ registry: reg, providers: ['src-a', 'src-b'] });
    const before = m.bundle.buildBundle().health;
    assert.equal(before.records, 2);

    for (let i = 0; i < 3; i++) {
      await m.ingest.refresh({ registry: reg, providers: ['src-a'], full: true });
      const after = m.bundle.buildBundle().health;
      assert.equal(after.records, 2, `still 2 records after scoped full #${i + 1}`);
      assert.equal(after.tokens, before.tokens, 'token totals unchanged');
    }
  });
});

test('keepRaw:false skips the record shards but still builds the cube', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 0, s: 's1', id: 'r1' }) + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };
    await m.ingest.refresh({
      registry: [patched], providers: ['testsrc'],
      config: { providers: ['testsrc'], sources: {}, store: { keepRaw: false }, analytics: {}, modelMappings: [], interfaceOverrides: {}, identity: {}, ui: {} },
    });
    const store = new m.store.Store();
    assert.equal(store.listShards().length, 0, 'no request-level shards written');
    assert.ok(store.cube().rows.length > 0, 'but the cube is still built');
  });
});

test('the encode/decode codec round-trips and drops nothing meaningful', async () => {
  const { encodeRecord, decodeRecord } = await import('../src/core/store.js');
  const { createRecord } = await import('../src/core/schema.js');
  const r = createRecord({
    timestamp: '2026-08-01T10:00:00.000Z', date: '2026-08-01', hour: 10, dow: 5, tz_offset: 0,
    provider: 'anthropic', model: 'claude-opus-5', input_tokens: 1, output_tokens: 2,
    cache_read_tokens: 0, cache_write_tokens: null, session_id: 's', project: 'p',
    estimated_cost: 0.5, cost_basis: 'estimated', source: 'x', metadata: { cwd: '/tmp' },
  });
  r.id = 'abc';
  const back = decodeRecord(encodeRecord(r));
  for (const k of ['timestamp', 'date', 'hour', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'session_id', 'project', 'estimated_cost', 'cost_basis', 'source', 'id']) {
    assert.deepEqual(back[k], r[k], `field ${k} survived`);
  }
  assert.equal(back.cache_read_tokens, 0, 'a measured zero survives');
  assert.equal(back.cache_write_tokens, null, 'a not-available stays not-available');
  assert.deepEqual(back.metadata, { cwd: '/tmp' });
});

test('a time budget stops cleanly and the next call finishes the job', async () => {
  await withHome(async (dir, m) => {
    const files = [];
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ ts: `2026-08-0${i + 1}T10:00:00Z`, in: 10, out: 1, cr: 0, s: `s${i}`, id: `r${i}` }) + '\n');
      files.push(f);
    }
    const p = m.registry.createProvider({
      id: 'slow',
      name: 'Slow source',
      async detect() { return { available: true }; },
      async discover() { return files.map((f, i) => ({ key: `k${i}`, path: f, stat: fs.statSync(f) })); },
      async ingestFile(ref, ctx, emit) {
        const start = Date.now();
        while (Date.now() - start < 12) { /* burn a little wall clock */ }
        let records = 0;
        const res = m.jsonl.readLines(ref.path, (line) => {
          const o = JSON.parse(line);
          emit({ timestamp: o.ts, model: 'gpt-4o', client: 'codex', interfaceSignals: ['cli'], input_tokens: o.in, output_tokens: o.out, session_id: o.s });
          records++;
        }, { start: ref.start });
        return { offset: res.offset, records };
      },
    });
    const r1 = await m.ingest.refresh({ registry: [p], providers: ['slow'], deadlineMs: 25 });
    assert.equal(r1.done, false, 'the budget was reached');
    assert.ok(r1.newRecords < 6 && r1.newRecords > 0, 'partial progress was made and saved');
    let guard = 0;
    let total = r1.newRecords;
    let done = r1.done;
    while (!done && guard++ < 20) {
      const r = await m.ingest.refresh({ registry: [p], providers: ['slow'], deadlineMs: 25 });
      total += r.newRecords;
      done = r.done;
    }
    assert.equal(done, true);
    assert.equal(m.bundle.buildBundle().health.records, 6, 'every record landed exactly once');
  });
});

test('a full re-ingest refuses to drop records it cannot rebuild', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 100, s: 's1', id: 'r1' }),
      JSON.stringify({ ts: '2026-08-02T10:00:00Z', in: 20, out: 6, cr: 200, s: 's2', id: 'r2' }),
    ].join('\n') + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };
    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(m.bundle.buildBundle().health.records, 2);

    // The source moves out of reach — a different machine, a sandbox, a
    // rotated log directory. detect() now returns unavailable.
    fs.rmSync(file);
    await assert.rejects(
      () => m.ingest.refresh({ registry: [patched], providers: ['testsrc'], full: true }),
      (/** @type {any} */ err) => err.code === 'FULL_REFRESH_UNSAFE' && /2 stored record/.test(err.message),
    );
    assert.equal(m.bundle.buildBundle().health.records, 2, 'the data survived the refused reset');

    // An incremental refresh is still allowed, and is a no-op.
    const inc = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(inc.newRecords, 0);
    assert.equal(m.bundle.buildBundle().health.records, 2);

    // --force is the escape hatch for someone who really means it.
    const forced = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'], full: true, force: true });
    assert.equal(forced.newRecords, 0);
    assert.equal(m.bundle.buildBundle().health.records, 0);
  });
});

test('a full export round-trips through restore, re-priced with the current table', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 1e6, out: 2e6, cr: 4e6, s: 's1', id: 'r1' }),
      JSON.stringify({ ts: '2026-08-02T11:00:00Z', in: 3e6, out: 1e6, cr: 0, s: 's2', id: 'r2' }),
    ].join('\n') + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };
    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });

    const before = m.bundle.buildBundle();
    const csvFile = path.join(dir, 'export.csv');
    const fd = fs.openSync(csvFile, 'w');
    const n = m.csv.streamRecordsCsv((chunk) => fs.writeSync(fd, chunk), {});
    fs.closeSync(fd);
    assert.equal(n, 2);

    const r = m.restore.restoreFromCsv(csvFile, { reprice: true });
    assert.equal(r.records, 2);
    assert.equal(r.bySource.testsrc, 2);
    assert.equal(r.repriced, 2, 'both estimates recomputed from the current table');

    const after = m.bundle.buildBundle();
    assert.equal(after.health.records, 2);

    // computeTotal returns {total, partial}. Assigning the whole object stored
    // total_tokens as an object on every restored record, which re-exported as
    // "[object Object]". The cube measures above cannot catch that, because
    // total_tokens is per-record and is not one of them.
    for (const row of m.bundle.queryRecords({ limit: 100 }).rows) {
      const tt = row.total_tokens ?? row.tt;
      assert.equal(typeof tt, 'number', `restored total_tokens must be a number, got ${JSON.stringify(tt)}`);
    }
    const sum = (b, name) => b.cube.rows.reduce((a, row) => a + row[b.cube.dims.length + b.cube.measures.indexOf(name)], 0);
    for (const measure of ['in', 'out', 'cr', 'cw', 'req', 'cost']) {
      assert.equal(sum(after, measure), sum(before, measure), `${measure} survived the round trip`);
    }
    // claude-opus-5: 4M in @ $5, 3M out @ $25, 4M cache read @ $0.50 = $97
    assert.equal(Math.round(sum(after, 'cost') * 100) / 100, 97);
  });
});

test('a restored slice is superseded, not duplicated, when the real logs come back', async () => {
  await withHome(async (dir, m) => {
    const file = path.join(dir, 'src.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2026-08-01T10:00:00Z', in: 10, out: 5, cr: 100, s: 's1', id: 'r1' }),
      JSON.stringify({ ts: '2026-08-02T10:00:00Z', in: 20, out: 6, cr: 200, s: 's2', id: 'r2' }),
    ].join('\n') + '\n');
    const p = makeProvider(m.registry.createProvider, file);
    const patched = { ...p, ingestFile: (ref, c, emit) => p.ingestFile({ ...ref, _readLines: m.jsonl }, c, emit) };
    await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });

    const csvFile = path.join(dir, 'export.csv');
    const fd = fs.openSync(csvFile, 'w');
    m.csv.streamRecordsCsv((chunk) => fs.writeSync(fd, chunk), {});
    fs.closeSync(fd);

    m.restore.restoreFromCsv(csvFile, { reprice: true });
    assert.equal(m.bundle.buildBundle().health.records, 2, 'restore replaced the store');

    // The logs are readable again: a refresh must read them and drop the
    // restored stand-ins, not add to them.
    const r = await m.ingest.refresh({ registry: [patched], providers: ['testsrc'] });
    assert.equal(r.newRecords, 2, 'source re-read from scratch — restore left no offsets');
    const b = m.bundle.buildBundle();
    assert.equal(b.health.records, 2, 'restored records were superseded, not double counted');
    // The stored counts describe the store, not the sum of everything ever written.
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
    assert.equal(state.counters.records, 2, 'record count re-derived from the survivors');
    assert.equal(state.sources.testsrc.records, 2);
    const sum = (name) => b.cube.rows.reduce((a, row) => a + row[b.cube.dims.length + b.cube.measures.indexOf(name)], 0);
    assert.equal(sum('in') + sum('out') + sum('cr'), 10 + 5 + 100 + 20 + 6 + 200);
  });
});

test('the loopback ping endpoint is a liveness probe and nothing more', async () => {
  await withHome(async (dir, m) => {
    const { startServer } = await import(`../src/server/server.js?t=${Date.now()}`);
    const s = await startServer({ port: 0, host: '127.0.0.1', open: false });
    try {
      const r = await fetch(`${s.url}/api/ping`);
      const j = await r.json();
      // What a file:// snapshot needs to decide "is a live dashboard running?"
      assert.equal(j.app, 'tokenflow');
      assert.equal(j.ok, true);
      assert.equal(typeof j.port, 'number');
      // ...and nothing else. No usage data, no config, no filesystem paths.
      assert.deepEqual(
        Object.keys(j).sort(),
        ['app', 'lastRefresh', 'ok', 'port', 'records'],
      );
      // Open to a file:// page (origin null), which is the whole point.
      assert.equal(r.headers.get('access-control-allow-origin'), '*');

      // A cross-origin POST must still be refused: the snapshot hands over by
      // navigating, it never writes across origins.
      const post = await fetch(`${s.url}/api/refresh`, { method: 'POST', headers: { origin: 'http://evil.example' } });
      assert.equal(post.status, 403);
    } finally {
      s.close();
    }
  });
});

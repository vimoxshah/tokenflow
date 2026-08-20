# Creating a provider

An adapter parses; the engine does everything else. That split is why a new adapter is ~80 lines
and why the analytics layer never sees a vendor-specific shape.

The engine handles: model → vendor classification, interface classification, timezone resolution,
cost estimation, id assignment, dedup bookkeeping, shard writes, and the cube / session /
activity rollups. **Do not do any of that in an adapter.**

## The contract

```ts
interface UsageProvider {
  id: string;                       // lowercase slug, unique
  name: string;                     // human name shown in `tokenflow providers`
  description?: string;
  measurement?: 'primary' | 'overlay' | 'activity';   // default 'primary'
  requires?: string[];              // human prerequisites, shown on failure

  /** Can this adapter run here? Reads nothing but existence/metadata. */
  detect(ctx): Promise<{ available: boolean; detail?: string; paths?: string[] }>;

  // ---- EITHER a file-based source: implement both -------------------------
  discover?(ctx): Promise<Array<{ key: string; path: string; stat: fs.Stats }>>;
  ingestFile?(ref, ctx, emit): Promise<{ offset: number; records?: number; malformed?: number }>;

  // ---- OR a fetch-based source (SQLite, API, generator) -------------------
  fetchUsage?(ctx, emit, sourceState): Promise<{ cursor?: any; records?: number; notes?: string[] }>;

  /** Optional: exposed for tests and dry-run importers. */
  normalize?(raw: unknown, opts?: unknown): object;
  getMetadata?(): object;           // provided by createProvider()
}
```

`createProvider()` validates this up front, so a broken adapter fails at load with a readable
message instead of halfway through a multi-gigabyte ingest.

## Minimal file-based adapter

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider, readLines, walk, MEASUREMENT } from 'tokenflow/sdk';

const root = (ctx) => ctx?.config?.sources?.['my-provider']?.path
  || path.join(ctx?.home || os.homedir(), '.my-tool', 'logs');

export default createProvider({
  id: 'my-provider',
  name: 'My AI Provider',
  description: 'Per-request usage from My Tool.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.my-tool/logs/*.jsonl'],

  async detect(ctx) {
    const dir = root(ctx);
    if (!fs.existsSync(dir)) return { available: false, detail: `no ${dir}` };
    return { available: true, detail: dir, paths: [dir] };
  },

  async discover(ctx) {
    return walk(root(ctx), (name) => name.endsWith('.jsonl')).map((p) => ({
      key: path.relative(root(ctx), p),   // stable identity for incremental state
      path: p,
      stat: fs.statSync(p),
    }));
  },

  async ingestFile(ref, ctx, emit) {
    let records = 0;
    let malformed = 0;
    const res = readLines(ref.path, (line) => {
      let o;
      try { o = JSON.parse(line); } catch { malformed++; return; }
      if (!o.usage) return;
      emit({
        timestamp: o.created_at,
        model: o.model,
        input_tokens: o.usage.prompt_tokens,
        cache_read_tokens: o.usage.cached_tokens ?? null,
        cache_write_tokens: null,
        output_tokens: o.usage.completion_tokens,
        session_id: o.conversation_id,
        request_id: o.id,
        project: o.cwd ? path.basename(o.cwd) : null,
        interfaceSignals: [o.client, o.surface],
      });
      records++;
    }, {
      start: ref.start,           // ALWAYS resume from here
      must: ['"usage"'],          // cheap prefilter: skip lines that cannot match
    });
    return { offset: res.offset, records, malformed };
  },
});
```

## The five rules

### 1. Resume from `ref.start` and return `offset`

```js
const res = readLines(ref.path, handler, { start: ref.start });
return { offset: res.offset };
```

This is what makes refresh incremental and exact. `readLines` returns the offset of the last
**complete** line, so a partially-written trailing line is never consumed. Ignoring `ref.start`
means every refresh re-emits the whole file.

### 2. Unreported is `null`, not `0`

```js
cache_write_tokens: o.usage.cache_write ?? null,   // right
cache_write_tokens: o.usage.cache_write || 0,      // WRONG — the linter fails the build
```

If the source *does* report zero, pass `0`. The difference is the entire point of the schema.

### 3. Convert to the exclusive convention

`input_tokens` must be **fresh** prompt tokens. If your vendor's `input_tokens` includes cached
tokens (OpenAI's does), subtract:

```js
const fresh = input === null ? null : cached === null ? input : Math.max(0, input - cached);
```

`cache_refresh_tokens` must be a subset of `cache_write_tokens`, and `reasoning_tokens` a subset
of `output_tokens`. `validateUsage` rejects records that break this.

### 4. Never infer the interface from the model

Pass `interfaceSignals: [...]` — an ordered, strongest-first list of **surface** fields
(`entrypoint`, `originator`, `source`, an IDE marker, a client name). The engine classifies them.
With no signal the interface is `Unknown`, which is the correct answer.

Pass `interface: 'CLI'` directly only when your source *is* the surface (the git adapter does).

### 5. Watch for re-reported usage

If your source streams progress updates that re-report a growing total, summing them will inflate
everything. Check whether a series of usage events for one logical call is monotonically growing
(→ take the maximum) or genuinely disjoint (→ sum). Both real adapters in this repo needed the
former; one was inflating by 45x before it was fixed. Record the event count in `metadata` so the
reconstruction is auditable.

## Fetch-based adapters

For SQLite, APIs, or generators, implement `fetchUsage` and keep a cursor:

```js
async fetchUsage(ctx, emit, sourceState) {
  const cursor = sourceState?.cursor || { lastId: 0 };
  const db = openReadOnly(dbPath(ctx));            // snapshots + never writes
  try {
    for (const row of db.prepare('SELECT * FROM usage WHERE id > ? ORDER BY id').all(cursor.lastId)) {
      emit({ timestamp: new Date(row.ts).toISOString(), model: row.model, /* … */ });
      cursor.lastId = row.id;
    }
  } finally {
    db.close();
  }
  return { cursor, notes: [] };
}
```

The cursor is persisted by the engine, so the next run only reads new rows.

## Per-file adapter state

`ref.state` is a plain object persisted per source file across refreshes. Use it for header
context that a mid-file resume would otherwise lose — Codex keeps the session metadata there,
because `session_meta` is on line 1 and a resumed read starts at line 40,000.

```js
async ingestFile(ref, ctx, emit) {
  const s = ref.state;                 // survives between refreshes
  if (d.type === 'session_meta') { s.sessionId = d.payload.session_id; return; }
  // …
}
```

## Testing your adapter

Put a small, realistic fixture in `test/fixtures/` — include the awkward cases: a re-reported
usage series, a row with a missing field, a synthetic/zero row.

```js
import my from '../src/providers/my-provider/index.js';
import { ingestFixtureAsync } from './helpers.js';
import { validateUsage } from '../src/core/validate.js';

test('my-provider: token semantics', async () => {
  const { records, result } = await ingestFixtureAsync(my, 'my-provider.jsonl');
  assert.equal(records.length, 2);
  assert.equal(records[0].input_tokens, 6000, 'fresh input excludes the cached portion');
  assert.equal(records[0].cache_write_tokens, null, 'unreported stays null');
  for (const r of records) assert.ok(validateUsage(r).ok);
});

test('my-provider: re-reading the same bytes emits nothing new', async () => {
  const first = await ingestFixtureAsync(my, 'my-provider.jsonl');
  const again = await ingestFixtureAsync(my, 'my-provider.jsonl', {
    start: first.result.offset, state: first.state,
  });
  assert.equal(again.records.length, 0);
});
```

That second test is the one that catches the expensive class of bug.

## Installing it

**For yourself** — drop it in `$TOKENFLOW_HOME/providers/my-provider.js`. Loaded on the next run;
a user adapter shadows a built-in with the same id.

**For everyone** — add `src/providers/my-provider/index.js`, a fixture, and tests, then:

```bash
npm test && npm run lint && npm run validate
```

Please document, in the adapter's header comment, what each vendor field means and which
convention it follows. That header is the most valuable part of an adapter.

## SDK surface

```js
import {
  createProvider, registerProvider, listProviders,
  normalizeUsage, validateUsage, validateProvider,
  createRecord, computeTotal, dateParts, hashId,
  MEASUREMENT, INTERFACE, interfaceClass,
  classifyModel, classifyInterface,
  readLines, readJsonLines, walk,
  openReadOnly, tables, columns, sqliteAvailable,
  registerAnalytics,
} from 'tokenflow/sdk';
```

## Adding analytics instead

If you want a new *metric* rather than a new source, register an analytics plugin — no core
changes either:

```js
import { registerAnalytics } from 'tokenflow/sdk';

registerAnalytics({
  id: 'carbon',
  section: 'sustainability',
  title: 'Estimated energy',
  compute({ rows, ix, totals, sessions, range }) {
    return { kwh: totals.total * 0.0000003, basis: 'estimated', note: '...' };
  },
});
```

The result appears at `view.plugins.carbon`. See [architecture.md](architecture.md#plugin-points).

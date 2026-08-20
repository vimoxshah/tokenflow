# Architecture

```
Data sources            ~/.claude*  ~/.codex  ~/.cline  ~/.cursor  ~/.headroom  git  *.csv
      │
      ▼
Ingestion layer         src/providers/*/index.js        ← adapters PARSE, nothing else
      │                 src/core/registry.js            ← discovery + contract validation
      ▼
Normalization layer     src/core/ingest.js  (enrich)    ← classify, date, price, id, dedup
      │                 src/core/schema.js              ← the unified record + null contract
      ▼
Store                   src/core/store.js
      │                   data/records/YYYY-MM.jsonl      request-level facts
      │                   data/cube.json                  additive pre-aggregate
      │                   data/sessions.json               one row per session
      │                   data/activity.json               daily work rollup
      │                   data/state.json                  per-file offsets (incremental engine)
      ▼
Analytics engine        src/analytics/*.js              ← pure, no Node imports
      │                   computeView(bundle, filters)    the single entry point
      ▼
Filtering / aggregation in-process, in the browser      ← zero API calls per filter change
      │
      ▼
Dashboard UI            src/ui/{index.html,app.js,charts.js,styles.css}
      │
      ▼
Export                  src/export/{csv.js,html-snapshot.js,bundler.js}
```

## Layer boundaries, and why they hold

**Adapters parse; the engine enriches.** An adapter emits a partial record and nothing else. The
engine does model→vendor classification, interface classification, timezone resolution, cost
estimation, id assignment, dedup bookkeeping, and every rollup. That is why an adapter is ~80
lines and why adding one cannot change how anything is counted.

**Analytics are pure and Node-free.** `src/analytics/*` imports only from `src/core/schema.js` and
`src/core/pricing.js` — no `fs`, no `path`. That is what lets the **exact same modules** run in the
CLI, in the API, and in the browser. There is no "backend calculation" and "frontend calculation"
to drift apart: `tokenflow status` and the dashboard cannot disagree, because they call the same
function.

**No logic in UI components.** `src/ui/app.js` renders `computeView()` output. It contains no
arithmetic beyond formatting. Every number on screen has a named function behind it —
`calculateDailyUsage`, `calculateProviderUsage`, `calculatePeakUsage`,
`calculateAverageUsage`, `calculateCacheRatio`, `calculateUsageTrend`, `calculateHourlyUsage`,
`calculateInterfaceUsage`, `calculatePeriodComparison`, `calculateCorrelations`,
`generateInsights` — and each is unit-tested against its formula.

## Why a cube

A dashboard that filters must either round-trip to a server on every interaction or hold the data
locally. Holding a million request-level records in a browser tab is not viable; holding a
pre-aggregated fact table is.

```
dims:     date, hour, dow, provider, model, model_family, client,
          interface, gateway, project, repository, measurement
measures: in, out, cr, cw, cf, rs, req, cost, costMeasured, costReq,
          naIn, naOut, naCr, naCw
```

Properties that matter:

- **Additive.** An incremental refresh adds into cells; no rebuild needed. This is what makes a
  2-second no-op refresh possible on a multi-gigabyte corpus.
- **Small.** Real cardinality on a heavy 8-month corpus of 69,520 records: **2,470 rows**. The whole
  bundle, including 4,359 sessions, is a few hundred KB.
- **Complete for every question the UI asks.** Every filter dimension is a column, so any
  combination of filters is one linear scan — microseconds, in the browser, offline.
- **Honest.** The four `na*` counters travel with the measures, so "not reported" survives
  aggregation instead of being flattened into a zero.

Request-level facts stay on disk for the Data Explorer and full CSV export, streamed and filtered
server-side with a bounded top-K buffer so a 100-row page never materialises a million objects.

## Why incremental refresh is exact

Session transcripts are append-only, so `state.json` remembers each file's
`{size, mtimeMs, offset, gen}`:

| Observation | Action |
|---|---|
| same size **and** mtime | skip entirely — zero reads |
| grew | resume reading at `offset`; ingested bytes are never re-read |
| shrank / rewritten | bump `gen`; the old generation's records become stale |

Dedup is therefore **structural**, not probabilistic — there is no hash index to size, tune or
outgrow, and "duplicate records: 0" is a property of the design rather than a measurement.

Two refinements make it airtight:

1. `readLines` returns the offset of the last **complete** line, so a partially-written trailing
   line is never consumed.
2. An adapter whose logical unit can straddle EOF (a streaming message, an in-flight turn)
   persists what it already emitted in `ref.state`, and emits only the **delta** when the unit
   continues. Without this, every settled file silently lost its last record forever — which is
   exactly the bug this mechanism was built to fix.

A scoped `--full` (one adapter) marks that adapter's generations stale, re-ingests, compacts the
shards, and rebuilds the aggregates from the surviving facts — so one adapter can be re-read from
scratch without disturbing any other adapter's numbers. A test asserts three consecutive scoped
re-ingests leave the totals unchanged.

## Time budget and resumability

`refresh({ deadlineMs })` checks the clock on every file boundary, persists state, and returns
`done: false`. The CLI, the HTTP endpoint and CI all use the same path. This is what lets a 5 GB
first ingest complete inside 45-second shells, or a browser request, without ever leaving the
store in a half-written condition.

## Plugin points

Four extension seams, none of which require touching the core:

| Extend | How | Discovered from |
|---|---|---|
| **Sources** | `createProvider({...})` | `src/providers/*/index.js`, `$TOKENFLOW_HOME/providers/*.js` |
| **Metrics** | `registerAnalytics({id, compute})` | result appears at `view.plugins.<id>` |
| **Model → vendor** | `modelMappings:` in config | prepended to the built-in ruleset |
| **Prices** | `pricing.json` / `tokenflow pricing --set` | overrides the built-in table |

A user adapter shadows a built-in with the same id, which makes local experimentation cheap and
reversible.

## Zero dependencies, on purpose

Not minimalism for its own sake — three concrete properties:

- **It installs and runs where a package manager can't.** Sandboxes, air-gapped machines, and
  short-lived shells with no network. A tool for auditing your own data should not need to phone
  a registry first.
- **There is no supply chain.** A dashboard that reads your session logs is exactly the wrong
  place for 400 transitive packages.
- **There is no build step in the dev path.** The browser imports the same ES modules the CLI
  does, straight from `src/`. Edit, reload, done.

The cost is a hand-written SVG chart library (`src/ui/charts.js`, ~800 lines) and a ~100-line
ES-module bundler used *only* for the offline HTML snapshot. Both are honest trades. `node:sqlite`
covers SQLite sources; `node:test` covers testing.

The snapshot bundler keeps each module in its own function scope and wires exports through a tiny
require registry, rather than renaming identifiers — which is where naive concatenating bundlers
break. `buildSnapshot` parses the result with `vm.Script` before writing, because a snapshot that
doesn't parse is worse than a failed export.

## Charts

`src/ui/charts.js` implements the mark specs directly: thin marks, hairline solid gridlines, a 2px
surface gap between touching fills, a 2px surface ring on overlapping markers, selective direct
labels, hit targets larger than the marks, and a crosshair that snaps to the nearest X.

Colour is assigned **by entity, in fixed order, never by rank**, so filtering a series out never
repaints the survivors. Past eight keys everything folds into one muted "Other" rather than
generating a ninth hue. Scatter and bubble forms cap colour groups at three, because they need
all-pairs colour separation rather than adjacent-pair. Both palettes (dark primary, light
selected) were checked against the lightness band, chroma floor, adjacent-pair CVD separation,
normal-vision floor and surface contrast before being written down.

Every chart ships a **table twin** toggled per card, so no value is reachable only by hovering.

## Privacy by construction

There is no HTTP client anywhere in this codebase — not for telemetry, not for pricing, not for
updates. The server binds to loopback and refuses non-GET requests from a foreign origin without a
token. Adapters read token counts and metadata and discard content; the schema has nowhere to put
a prompt. SQLite sources are read from a temp snapshot so a live editor is never disturbed.

## Team-readiness without team infrastructure

`user`, `machine`, `session_id`, `project` and `repository` are first-class, and the cube is
additive — so cubes from several machines can be merged by concatenating rows and re-summing
duplicated dimension tuples. V1 ships no identity, auth or sync, deliberately. Nothing here makes
them impossible to add.

# Data model

Every adapter emits the same record shape. Nothing downstream — analytics, UI, export — knows
anything about a specific vendor. This document is the contract.

## The normalized record

```ts
interface NormalizedUsageRecord {
  id: string;                 // stable dedup key
  timestamp: string;          // ISO-8601, UTC
  date: string;               // YYYY-MM-DD in the capture timezone
  hour: number;               // 0-23 in the capture timezone
  dow: number;                // 0=Mon .. 6=Sun in the capture timezone
  tz_offset: number;          // capture tz offset, minutes

  provider: string;           // canonical vendor slug: anthropic | openai | deepseek | zai | ...
  provider_label: string;
  gateway: string | null;     // routing layer (proxy/router), if any — NOT the vendor
  model: string;              // raw model identifier from the source
  model_family: string;       // human tier, e.g. "Claude Opus 5", "GPT 5.6 (sol)"

  client: string;             // tool that made the call: claude-code | codex | cline | cursor
  application: string;        // human label for the client
  interface: Interface;       // CLI | IDE | Desktop App | Web | API | SDK | Extension | Unknown

  input_tokens:         number | null;   // fresh prompt tokens, EXCLUDING cache
  cache_read_tokens:    number | null;   // prompt tokens served from cache
  cache_write_tokens:   number | null;   // prompt tokens written into cache
  output_tokens:        number | null;   // generated tokens
  cache_refresh_tokens: number | null;   // SUBSET of cache_write (long-TTL / refreshed)
  reasoning_tokens:     number | null;   // SUBSET of output (thinking / reasoning)
  total_tokens:         number | null;   // derived, never trusted from the source
  total_is_partial:     boolean;         // some billable field was not available

  session_id: string | null;
  conversation_id: string | null;
  request_id: string | null;

  project: string | null;
  repository: string | null;
  git_branch: string | null;
  category: string | null;    // main | subagent | commit | ai-edit:* | ...

  estimated_cost: number | null;
  cost_basis: 'measured' | 'estimated' | null;

  source: string;             // adapter id
  measurement: Measurement;   // primary | overlay | activity
  user: string | null;        // multi-user ready
  machine: string | null;
  duration_ms: number | null;
  metadata: object;           // source-specific, never interpreted by analytics
}
```

## Missing-value contract

This is the load-bearing rule of the whole project.

| Value | Meaning |
|---|---|
| `null` | the source does not report this field — **not available** |
| `undefined` | normalised to `null` on construction |
| `0` | the source reported zero — a real, **measured** zero |

Analytics **never** coerce `null` to `0`. Sums skip nulls and carry a parallel not-available
counter per field (`naIn`, `naOut`, `naCr`, `naCw`), which is why the UI can say
"cache tokens unreported by 22% of records in this slice" instead of drawing a confident zero.
The linter enforces this: `|| 0` on a line mentioning a token field is a build error.

Practical consequence: Cline logs sessions but no token counts, so **every** Cline token field is
`null`, the record is `measurement: activity`, and its sessions count towards activity metrics
without dragging every token average towards zero.

## Token accounting

### The four billable buckets are mutually exclusive

```
total_tokens = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens
```

### The two breakdown fields are subsets and are never added again

```
cache_refresh_tokens ⊆ cache_write_tokens      (long-TTL / refreshed cache writes)
reasoning_tokens     ⊆ output_tokens           (thinking / reasoning)
```

`validateUsage` rejects a record where a subset exceeds its parent, and the test suite asserts
both invariants.

### Vendors disagree about `input_tokens`

| Vendor | What the source calls `input_tokens` | Adapter must |
|---|---|---|
| Anthropic | fresh prompt tokens, **excluding** cache read and cache creation | pass through |
| OpenAI / Codex | prompt tokens **including** `cached_input_tokens` | subtract: `fresh = input − cached` |

Getting this wrong double-counts every cached prompt token — once as fresh input and once as
cache read. Each adapter's test asserts its own convention.

### Ratios and what they actually divide by

| Metric | Formula | Read it as |
|---|---|---|
| Output / input | `out / in` | generated per **fresh** prompt token. With a cache-heavy agent, `in` is tiny, so this number is large and not very meaningful on its own. |
| Output / prompt sent | `out / (in + cr + cw)` | generated per prompt token **actually sent**. This is the honest "prompt-heavy vs output-heavy" measure. |
| Cache / total | `(cr + cw) / total` | share of all token activity that was cache traffic |
| Cache hit rate | `cr / (in + cr)` | share of prompt tokens served from cache rather than re-sent |
| Fresh per cached prompt | `in / cr` | below 1 means the cache is carrying the context |

## Cost, and what an estimate is allowed to claim

`estimated_cost` + `cost_basis` are the only cost fields, and they mean two different things:

| `cost_basis` | Meaning |
|---|---|
| `measured` | a source actually billed this request (a gateway's own `cost_usd`) |
| `estimated` | computed here, from a published rate table |
| `null` | the model has no configured rate — **and no number is shown** |

Three things make the estimate defensible rather than decorative:

1. **Every rate names a source.** Each entry in the built-in table carries a `src` key into
   `PRICING_SOURCES`, which records the URL, the date it was fetched, and whether the source is
   official or third-party. `tokenflow pricing --sources` prints it; the Cost page shows it.
2. **Service tier is a multiplier, not a label.** OpenAI's Fast mode (renamed from "priority" on
   2026-07-30) bills at **4x** standard; Anthropic's Batch API at 0.5x. `service_tier` is a
   first-class field and a cube dimension, and the multiplier is applied per request. Ignoring it
   under-reports a Fast-mode-heavy workload by up to 4x.
3. **The cache write tiers are priced separately.** `cache_refresh_tokens` (the long-TTL subset) is
   billed at the 1-hour rate and the remainder at the 5-minute rate — for Claude Opus 5 that is
   $10 vs $6.25 per MTok, so on a cache-heavy workload the split is worth real money.

**Known gap, stated rather than hidden:** long-context premium tiers (Anthropic above 200K,
OpenAI's long-context rows) are *not* applied, because doing so needs a per-request prompt size
plus a per-model threshold and premium that are not uniformly published. A long-context-heavy
workload is therefore **under**-estimated, and the Cost page says so.

## Measurement kinds

| `measurement` | Meaning | Counted in token totals? |
|---|---|---|
| `primary` | authoritative per-request usage from the model API | yes |
| `overlay` | a second view of traffic a client adapter already recorded (gateway/proxy logs) | **no** by default — it would double count. Used for measured cost. |
| `activity` | AI activity with no token accounting at all (IDE edits, sessions without a usage block, commits) | never — activity and correlation only |

Both non-primary kinds are toggleable in the filter bar, and the Data Health page explains each
one in place.

## Provider vs gateway

A local proxy or router is **not** a model vendor. When Codex reports
`model_provider: "headroom"`, the record gets `gateway: "headroom"` and `provider: "openai"` —
the vendor is derived from the model string, which is the only real evidence of who made the
model. This keeps "who served this request" and "who built this model" as separate, filterable
dimensions, and lets you answer "how much of my OpenAI traffic goes through the proxy?".

A provider hint from a source **never** overrides evidence in the model name.

## Interface classification

`interface` is derived **only** from an explicit surface field in the source record — `entrypoint`,
`originator`, `source`, an IDE marker, a client name. It is never inferred from the model or the
provider: "it's a Claude model so it must be Claude Desktop" is exactly the mistake this rule
exists to prevent. With no signal, the value is `Unknown` and the UI says what share that is.

`interfaceClass()` groups the eight values into the four buckets the CLI-vs-GUI comparison uses:
`CLI / headless` (CLI, SDK), `IDE` (IDE, Extension), `Desktop / Web`, `API`.

## Time and timezone

`date`, `hour` and `dow` are resolved **once at ingest**, in the capture timezone
(`config.timezone`, defaulting to the machine's zone), and stored. The UI never re-derives them,
so "my peak hour" means your local peak hour and a late-evening UTC event is filed on the right
local day. `dow` is Monday-first (0=Mon), matching how the charts are labelled.

## Dedup and identity

`id` is a stable 64-bit hash of `(source, session, request||timestamp, model, sequence)`.

Dedup is **structural**, not probabilistic: ingest resumes at a per-file byte offset, so a byte is
never read twice and a record cannot be ingested twice. That is why the Data Health page can state
`Duplicate records: 0` as a fact about the design rather than an estimate. Streaming duplicates
*within* a source file are a different problem, solved inside each adapter — see
[providers.md](providers.md).

## Storage layout

```
data/records/YYYY-MM.jsonl   request-level facts, short-key codec, nulls omitted
data/cube.json               pre-aggregated fact table (dims + measures), what the browser loads
data/sessions.json           one row per session
data/activity.json           daily work-activity rollup (commits, churn, AI edits)
data/state.json              per-file {size, mtime, offset, gen} — the incremental engine
```

The cube's dimensions are `date, hour, dow, provider, model, model_family, client, interface,
gateway, project, repository, measurement`; its measures are the six token fields plus
`requests`, `cost`, `costMeasured`, `costReq` and the four not-available counters. It is
**additive**, which is what lets an incremental refresh update it without a rebuild.

Set `store.keepRaw: false` to skip the request-level shards entirely — the cube, sessions and the
whole dashboard still work; only the Data Explorer and full CSV export need the raw facts.

## Multi-user readiness

`user`, `machine` and `session_id` are first-class fields, and `project` / `repository` are
dimensions. A future team deployment can aggregate the same records across machines without a
schema change. V1 deliberately ships no server-side identity, auth or sync — but nothing here
makes those impossible to add later.

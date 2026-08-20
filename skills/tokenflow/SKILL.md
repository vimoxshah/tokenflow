---
name: tokenflow
description: Install, configure, extend or debug the Tokenflow — a local-first analytics platform for AI token usage across Claude Code, Codex, Cline, Cursor, gateways and generic exports. Use when the user wants to see their own AI token usage, connect a new usage source, add a provider adapter, import a usage export, configure pricing, or when usage numbers look wrong.
---

# Tokenflow

A local-first, provider-agnostic analytics platform for AI token usage. Zero dependencies, Node
22.5+. Your job is to get it running against whatever AI tools this machine actually has, and to
be honest about what the data can and cannot support.

```
Clone → Configure → Connect sources → Refresh → Dashboard
```

---

## Read this first: the six invariants

Every mistake worth making here is a violation of one of these. They are stated with the failure
each one prevents, because you will meet cases the rules don't enumerate.

**1. Missing is not zero.** A token field is `number | null`. `null` = "this source does not
report it"; `0` = "it reported zero". Never write `|| 0` on a token field (the linter fails the
build). *Prevents:* Cline logs sessions with no token counts at all — zero-filling them would drag
every average toward zero and invent thousands of free requests.

**2. Cache tokens are not input tokens.** Four mutually exclusive billable buckets sum to the
total: fresh `input`, `cache_read`, `cache_write`, `output`. `cache_refresh` ⊆ `cache_write` and
`reasoning` ⊆ `output` are *subsets* and are never added again. *Prevents:* double counting every
cached prompt token — which on cache-heavy agent usage is >90% of all traffic.

**3. Vendors disagree about `input_tokens`.** Anthropic reports it *excluding* cache; OpenAI
reports it *including* `cached_input_tokens`. An adapter for an OpenAI-convention source must
subtract. *Prevents:* the same double count as (2), arriving through a different door.

**4. Streaming logs re-report the same usage.** A Claude Code transcript writes one assistant
message several times with a growing `output_tokens`; a Codex rollout re-reports a turn's context
as it grows. Take the **maximum of each monotonic run**, never the sum. *Prevents:* a measured
**45x** inflation — one real day read as 82.8 B tokens instead of 1.8 B, and one 2.5-minute
subagent session claiming 7.5 B tokens across 49,739 events for 266 actual turns.

**5. A gateway is not a vendor, and its log is not extra usage.** A proxy (`model_provider:
"headroom"`) is recorded as `gateway`; the vendor comes from the model name. Proxy records are
`measurement: overlay` and excluded from token totals. *Prevents:* counting the same request
twice — once from the client, once from the proxy — while still keeping the one thing only the
gateway knows: a *measured* dollar cost.

**6. Interface is never inferred from the model.** It comes only from an explicit surface field
(`entrypoint`, `originator`, `source`, an IDE marker). No signal → `Unknown`. *Prevents:*
"it's a Claude model so it must be Claude Desktop".

**7. A price needs a source, and a tier is a multiplier.** Every built-in rate names where it was
fetched from and when. Service tier is a *price multiplier* applied per request — OpenAI's Fast
mode (renamed from "priority" on 2026-07-30) is **4x** standard, Anthropic's Batch is 0.5x — and
the long-TTL cache write tier is billed above the 5-minute one. *Prevents:* under-reporting a
Fast-mode-heavy workload by up to 4x, and quoting a confident total built on rates nobody can
check. Long-context premium tiers are knowingly **not** applied, so the estimate is a documented
under-count rather than an unexplained one.

And one framing rule: **token usage is not productivity.** The Productivity section reports
activity *proxies*, and correlations with an independent work signal, with `n` stated. Never
present a token count as an achievement.

---

## Task: install and configure on this machine

### 1. Check the runtime

```bash
node -v          # must be >= 22.5 (node:sqlite, node:test)
```

There are no dependencies to install. `npm install` is a no-op.

### 2. Find out what this machine actually has

Don't guess — probe. See `providers/detection-matrix.md` for locations per tool and OS. The
high-value checks:

```bash
ls -d ~/.claude ~/.claude-* ~/.config/claude 2>/dev/null   # Claude Code (several homes are common)
ls -d ~/.codex/sessions 2>/dev/null                        # Codex CLI/IDE/Desktop
ls -d ~/.cline/data/sessions 2>/dev/null                   # Cline
ls ~/.cursor/ai-tracking/ai-code-tracking.db 2>/dev/null   # Cursor activity
ls ~/.headroom/savings_events.jsonl 2>/dev/null            # local gateway
```

Then let the tool confirm it:

```bash
node bin/tokenflow.js setup
node bin/tokenflow.js providers
```

Two things to notice, and to report to the user:

- **A user may have several Claude Code homes** (`~/.claude-work`, `~/.claude-personal`). The
  adapter auto-discovers any `~/.claude*` containing `projects/`. If they keep one elsewhere, add
  it to `sources.anthropic.paths`.
- **A tool being absent is a normal outcome**, not an error. Say which were found and which
  weren't, and why.

### 3. Handle non-standard locations

```yaml
# ~/.tokenflow/config.yaml
providers: [anthropic, openai, cline, cursor, headroom]
sources:
  anthropic:
    paths: ["/custom/claude-home", "~/.claude-work"]
  openai:
    paths: ["/custom/codex-home"]
  cursor:
    db: "~/.cursor/ai-tracking/ai-code-tracking.db"
timezone: "Asia/Kolkata"        # dates and hours are resolved in this zone at ingest
ui:
  defaultRange: all
  defaultFrom: "2026-03-14"     # optional floor for the default view
```

A full worked example is in `examples/config.yaml`. `config.json` is also accepted.

### 4. Ingest — in chunks if your shell is short-lived

```bash
node bin/tokenflow.js refresh --budget 30      # stops cleanly, saves state
node bin/tokenflow.js refresh --budget 30      # continues at the byte offset
```

Repeat until the report no longer says "time budget reached". This is the right pattern in a
sandbox, a CI step, or any 45-second shell: a multi-gigabyte first ingest completes across several
calls with no partial writes. A first pass on ~5,000 session files typically reads several GB in
under a minute; the second refresh is ~2 seconds because unchanged files are skipped without
being read.

### 5. Verify before you report

```bash
npm run validate      # runtime, adapters, and cube↔records agreement
node bin/tokenflow.js status
```

`validate` is the one that matters: it re-sums the stored facts and compares them with the
aggregates. If they've drifted it tells you to run `tokenflow compact`.

**Then sanity-check the shape of the result.** If one day is 10–100x every other day, treat it as
suspect and investigate before presenting it (see *Task: numbers look wrong*). Reporting a
plausible-looking wrong number is worse than reporting that you're unsure.

### 6. Serve it

```bash
node bin/tokenflow.js up                 # refresh + rebuild the offline file + serve (one command)
node bin/tokenflow.js dashboard          # http://127.0.0.1:7799, loopback only
node bin/tokenflow.js export --html      # one self-contained offline file
```

Use `--html` when the user can't reach a localhost port (remote shell, container, sandbox) — it
inlines the CSS, the analytics and chart code, and the data, and opens from `file://`.

Tell the user how to come back to it, because this is the question they always ask next:

- **`npm start`** (or double-click `Refresh & Open Dashboard.command` on macOS) refreshes,
  rebuilds `tokenflow-dashboard.html`, and opens the live dashboard.
- The offline file cannot re-read logs — it is a file. It reports its own age and probes loopback
  for a live dashboard; if one is running it offers to hand over and refresh there.
- For hands-off freshness, schedule `tokenflow up --no-serve` (launchd/systemd/cron — the plist
  and cron line are in `docs/cli.md`).

If the user wants a particular look, set it in config rather than editing CSS:

```yaml
ui:
  skin: aurora    # aurora | terminal | editorial
  mode: dark      # dark | light
```

Never hand-edit the series colours to match a skin. They belong to the mode, they were validated
for colour-blind separation against every skin's surface, and a "nicer" hue that fails that gate
makes two adjacent stack segments indistinguishable for ~8% of male readers.

---

## Task: connect a source with no adapter

Two routes. Prefer **import** if the tool can export; write an **adapter** if it writes a log
continuously.

### Route A — generic import

```bash
node bin/tokenflow.js import ~/Downloads/usage.csv --dry-run
```

With no `--field` flags it prints the columns, infers a mapping, and previews five normalized
rows. Check the preview: `n/a` means that field is unmapped and will be stored as not-available,
which is correct if the source truly lacks it and wrong if you just didn't map it.

```bash
node bin/tokenflow.js import ~/Downloads/usage.csv \
  --field timestamp=created_at \
  --field model=model \
  --field input_tokens=prompt_tokens \
  --field output_tokens=completion_tokens \
  --field cache_read_tokens=cached_tokens \
  --field estimated_cost=cost_usd \
  --default client=openrouter --default interface=API
```

The mapping is saved and reused on every later refresh. Supports CSV/TSV/JSON/JSONL/SQLite; see
`examples/generic-mapping.json`.

**Before mapping, determine whether the source's input column includes cached tokens.** If it
does, you cannot fix that with a mapping — write an adapter (Route B) so the subtraction happens.

### Route B — write an adapter

Start from `providers/adapter-template.js`. Then, in order:

1. **Read a real sample first.** `head -3 <logfile> | python3 -m json.tool`. Identify: the
   timestamp, the model, every token field, the session id, and any *surface* field.
2. **Work out the token convention.** Does the input field include cached tokens? Is there a
   separate cache-write? Is `reasoning` inside `output`? Write what you concluded in the adapter's
   header comment — that header is the most valuable part of an adapter.
3. **Check for re-reported usage.** Group the events of one logical call and look at the series.
   Monotonically growing → snapshots, take the max. Genuinely disjoint → sum. Getting this
   backwards is invariant 4, and it is the expensive mistake.
4. **Always resume from `ref.start` and return `offset`.** Otherwise every refresh re-emits the
   whole file.
5. **Emit `interfaceSignals: [...]`**, never a guessed `interface`.

Install to `$TOKENFLOW_HOME/providers/<id>.js` (loaded automatically, shadows a built-in with the
same id) or to `src/providers/<id>/index.js` with a fixture and tests.

**Write these two tests.** The first proves the semantics; the second catches the expensive bug:

```js
test('token semantics', async () => {
  const { records } = await ingestFixtureAsync(mine, 'mine.jsonl');
  assert.equal(records[0].input_tokens, 6000);      // fresh, excludes cache
  assert.equal(records[0].cache_write_tokens, null); // unreported stays null
  for (const r of records) assert.ok(validateUsage(r).ok);
});

test('re-reading the same bytes emits nothing new', async () => {
  const first = await ingestFixtureAsync(mine, 'mine.jsonl');
  const again = await ingestFixtureAsync(mine, 'mine.jsonl', {
    start: first.result.offset, state: first.state,
  });
  assert.equal(again.records.length, 0);
});
```

`schemas/normalized-record.json` is the authoritative field list.

---

## Task: numbers look wrong

Work down this list; the causes are ordered by how often they're the answer.

### Too high

1. **Re-reported usage in an adapter** (invariant 4). Symptom: one day or session dwarfs the rest
   by 10–100x. Check `metadata.token_count_events` / `metadata.usage_segments` in the Data
   Explorer — a record reconstructed from hundreds of events is suspect if your adapter summed
   them. Reproduce from the raw source with a throwaway script that computes both the naive sum
   and the sum-of-run-maxima; the gap is the inflation.
2. **Overlay double counting** (invariant 5). Is "Include gateway overlay" on? It adds proxy
   records to client records for the same traffic. Off by default.
3. **Cache read counted as input** (invariants 2, 3). `input + cache_read` should be the prompt
   side with no overlap.

**Cross-check against something independent** — a gateway log, a billing page, a second tool.
Two sources agreeing is worth far more than one source being plausible. When the Codex
reconstruction in this repo was validated, the corrected figure (1.80 B input for a day) matched a
gateway's own billing log (~2.1 B lifetime) while the naive reading (82.8 B) did not.

### Too low / missing

1. **The date filter.** `ui.defaultFrom` sets a floor for the *default view*; the data is still
   in the store and in `--all` exports.
2. **"Active days" means token-active days.** Days where only a no-token source (Cline, Cursor,
   git) was active are counted separately as "activity-only".
3. **Per-adapter coverage.** Data health → Sources lists each adapter's real window. A source that
   started logging in July does not cover March.
4. **The source pruned its own logs.** Claude Code defaults to ~30 days. Nothing can recover data
   the source deleted. Say so plainly.

### Cost is blank

By design — no rate, no number, never a `$0`. `tokenflow pricing` lists models by volume with
their pricing status. Add rates in USD per million tokens:

```bash
node bin/tokenflow.js pricing --sources                              # what is already known, and from where
node bin/tokenflow.js pricing --set "some-model=5,25,0.5,6.25"       # in,out,cacheRead,cacheWrite
node bin/tokenflow.js refresh --full
```

Check `--sources` first: the built-in table already covers the current Anthropic, OpenAI,
DeepSeek, Z.ai and Google line-ups from their own published pages. If a model is genuinely
missing, fetch the vendor's own pricing page — not an aggregator — and add the rate. If you cannot
source it, leave it unpriced and tell the user which models are missing: a made-up rate silently
corrupts every cost figure on the page, and unlike a blank it cannot be spotted.

Do **not** bake a service-tier multiplier into a rate. The tier is recorded per request and the
multiplier is applied automatically.

### Aggregates disagree with the records

```bash
npm run validate
node bin/tokenflow.js compact     # rewrites shards, rebuilds aggregates; always safe
```

---

## Task: explain a number

Be precise about the denominator, and about what the number does not claim.

| Metric | Formula | What it does NOT mean |
|---|---|---|
| Output / input | `out / in` (in = **fresh** input) | not "efficiency" — with a cache-heavy agent `in` is tiny, so this is large and near-meaningless alone |
| Output / prompt sent | `out / (in + cr + cw)` | the honest prompt-heavy vs output-heavy measure |
| Cache hit rate | `cr / (in + cr)` | not cache *savings* — that needs prices |
| Cache / total | `(cr + cw) / total` | share of token activity, not of cost |
| Avg / active day | total ÷ days with **measured tokens** | not ÷ calendar days, and not ÷ activity-only days |
| Peak day | argmax over the filtered slice | may be an artefact — check it against the raw source before celebrating it |
| Estimated cost | Σ tokens × configured rate | an estimate from a price table, covering only priced requests; the coverage % is always shown |
| Measured cost | a gateway's own `cost_usd` | covers only gateway-routed traffic, so it is not comparable to a total |
| Correlation r | Pearson over overlapping days | a correlation, never causation, and never a productivity claim |

If a metric is unavailable, explain *why* rather than showing zero. The dashboard is built to do
this; match its tone.

---

## Command reference

```bash
node bin/tokenflow.js setup                       # detect and write config
node bin/tokenflow.js providers                   # what's connected, and why not
node bin/tokenflow.js provider add|remove <id>
node bin/tokenflow.js refresh [--full] [--provider x] [--budget 30] [--strict]
node bin/tokenflow.js status [--json]
node bin/tokenflow.js dashboard [--port n] [--no-open]
node bin/tokenflow.js up [--budget 60] [--no-serve] [--no-snapshot]
node bin/tokenflow.js restore <full-export.csv> --yes    # rebuild a store from an export
node bin/tokenflow.js export --csv [--all] | --html
node bin/tokenflow.js pricing [--set "model=in,out[,cr[,cw]]"]
node bin/tokenflow.js import <file> [--field a=b] [--dry-run]
node bin/tokenflow.js config show|path|export|import
node bin/tokenflow.js doctor | validate | compact | reset --yes
node bin/tokenflow.js demo
npm test && npm run lint && npm run validate
```

`--json` on `refresh`, `status` and `providers` for scripting.

---

## Working style for this project

- **Verify, don't assert.** Run `npm run validate` and read the shape of the data before
  reporting. If a number surprises you, it is more likely a bug than a discovery.
- **Say what you couldn't determine.** "Cline reports no token counts, so its 22 sessions appear
  in activity metrics only" is a better answer than a total that quietly includes zeros.
- **Never invent a rate, a vendor, or an interface.** Unknown is a valid, supported value
  throughout the schema, and the UI is designed to display it.
- **Prefer fixing the adapter over patching the analytics.** If a number is wrong, it is almost
  always wrong at ingest. The analytics layer is unit-tested against its formulas.
- **Nothing leaves the machine.** There is no HTTP client in this codebase. Don't add one, and
  don't paste session contents anywhere.

## Reference files

| File | Use |
|---|---|
| `providers/detection-matrix.md` | where each tool stores usage, per OS |
| `providers/adapter-template.js` | commented starting point for a new adapter |
| `schemas/normalized-record.json` | authoritative field list + missing-value contract |
| `schemas/config.schema.json` | every config option |
| `examples/config.yaml` | a fully worked multi-source configuration |
| `examples/generic-mapping.json` | a saved import mapping |
| `examples/session-transcript.md` | the awkward real-world log shapes, annotated |

Project docs: `docs/data-model.md`, `docs/providers.md`, `docs/creating-provider.md`,
`docs/architecture.md`, `docs/troubleshooting.md`.

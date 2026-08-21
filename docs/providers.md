# Providers

Every adapter answers three questions honestly: **where it looks**, **what it can report**, and
**what it cannot know**. The third one matters most — a source that doesn't log token counts must
say so rather than emit zeros.

Enable and disable adapters with:

```bash
tokenflow providers
tokenflow provider add <id>
tokenflow provider remove <id>
```

---

## `anthropic` — Claude Code / Claude Agent SDK

| | |
|---|---|
| Reads | `<claude-home>/projects/<slug>/<sessionId>.jsonl` |
| Homes | `$CLAUDE_CONFIG_DIR`, `~/.claude`, `~/.config/claude`, and any `~/.claude-*` sibling containing `projects/` (people running several accounts keep them side by side) |
| Measurement | `primary` |
| Reports | `input`, `output`, `cache_read`, `cache_write`, `cache_refresh` (1h ephemeral), `reasoning` (thinking), session, project (from `cwd`), git branch, interface (from `entrypoint`), sidechain/subagent flag, CLI version, service tier |
| Cannot know | cost (no rate in the transcript) |

### The two traps it handles

**Streaming snapshots.** A single assistant message is written to the transcript several times as
it streams. Every line carries the same `requestId` + `message.id` with a *growing*
`output_tokens` and constant prompt-side counts. Measured on a real corpus: 2,493 of 5,060 usage
rows were re-reports. Summing them inflates output by 3–5x. The adapter groups by
`(requestId, message.id)` and keeps the **per-field maximum**.

**Synthetic messages.** Locally generated assistant entries have `requestId: null` and an
all-zero usage block — they are not API calls. Counting them would add fake zero-token requests
and skew "requests" and "tokens per request". They are skipped and counted separately as
`synthetic`.

A group can straddle the end of a live file. Rather than defer it (which would silently drop the
last record of every settled file, forever), it is emitted at EOF and its totals are remembered;
if the file grows and the same group reappears with larger counts, only the **delta** is emitted.

### Configuration

```yaml
sources:
  anthropic:
    paths: ["~/.claude", "~/.claude-work"]   # skip auto-discovery
```

---

## `openai` — Codex CLI / Codex IDE / Codex Desktop

| | |
|---|---|
| Reads | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**` (`$CODEX_HOME` respected) |
| Measurement | `primary` |
| Reports | fresh `input`, `cache_read`, `cache_write`, `output`, `reasoning`, session, thread, turn id, project (from `cwd`), interface (from `source` / `originator`), gateway, reasoning effort, service tier, context window, time-to-first-token, subagent role |
| Cannot know | cost; `cache_write` on older CLI builds that never emitted the field (recorded as `null`, not `0`) |

### Token semantics

Codex uses OpenAI's convention where `input_tokens` **includes** `cached_input_tokens`. The
adapter converts:

```
input_tokens      = input_tokens − cached_input_tokens     (fresh only)
cache_read_tokens = cached_input_tokens
```

### One record per turn, and why the obvious reading is wrong

Codex emits a `token_count` event repeatedly while a turn runs, and `last_token_usage` is
**re-reported as the turn's context grows** — 27k, then 29k, then 30k, all describing the same
growing conversation. `total_token_usage` is a running **sum** of those re-reports, so it is not a
usable cumulative counter.

On a real corpus that error is enormous: one subagent session claimed **7.5 B tokens in
2.5 minutes** (49,739 `token_count` events for 266 actual turns), and a single day totalled
**82.8 B** instead of **1.8 B** — a **45x** inflation.

The adapter instead splits each turn's `last_token_usage` series into monotonically
non-decreasing **runs** (a drop means a context compaction or a new call) and sums each run's
maximum. This reduces to the identity for simple sessions with one event per turn, and was
cross-checked against an independent gateway billing log which agreed with the reconstruction
and not with the naive sum.

Each record carries `metadata.token_count_events` and `metadata.usage_segments` so the
reconstruction is auditable rather than a hidden fudge.

### Gateways

`model_provider: "headroom"` (or any non-vendor value) is recorded as `gateway`, not as the
vendor. The vendor comes from the model name.

---

## `cline` — Cline CLI

| | |
|---|---|
| Reads | `~/.cline/data/sessions/<id>/<id>.json` (+ `.messages.json` for a message count) |
| Measurement | `activity` |
| Reports | session, model (so the vendor is derived — e.g. `deepseek/deepseek-v4-flash` → DeepSeek), provider, duration, status, exit code, project, git branch, team, agent message count |
| **Cannot know** | **any token count — Cline's session files contain none** |

Every token field is `null`. The dashboard counts these sessions in activity metrics and excludes
them from token totals, rather than adding a session's worth of zeros. `metadata.tokens_reported`
is `false` so this is visible in the Data Explorer.

---

## `cursor` — AI code activity

| | |
|---|---|
| Reads | `~/.cursor/ai-tracking/ai-code-tracking.db` (read-only, via `node:sqlite`) |
| Measurement | `activity` |
| Reports | AI-authored code hashes (model, file, extension, conversation, attribution source: `composer` / `tab` / `human`), and per-commit AI vs human line attribution (`linesAdded`, `composerLinesAdded`, `humanLinesAdded`, AI percentage) |
| Cannot know | token counts (Cursor does not store them locally) |

This is the productivity-correlation source: it measures **work output**, which is the thing token
counts are so often wrongly assumed to prove. `model: "default"` and `NULL` are Cursor's own
placeholders and are recorded as unknown rather than guessed.

The database is snapshotted to a temp directory before reading (with its `-wal`/`-shm` sidecars)
so a live editor is never disturbed and a hot transaction never yields a stale page.

---

## `opencode` — OpenCode

| | |
|---|---|
| Reads | `$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode/opencode.db`), via `node:sqlite` |
| Measurement | `primary` |
| Reports | per-request tokens: fresh input, cache read, cache write, output, reasoning; model, provider/gateway, session, project, agent mode, duration |
| Cannot know | git branch (not stored per message); a surface field — interface stays `Unknown` |

One record per assistant message. Token semantics were verified against a live corpus: `input`
is **exclusive** of cache reads (on long sessions `cache.read` exceeds `input`, which is
impossible under OpenAI's inclusive convention), and the five reported fields are disjoint
addends of the source's own total.

Two things the adapter handles that would otherwise corrupt the numbers:

- **Rows are updated in place.** An assistant row is inserted when the request starts and its
  totals are revised as the response finalises — on a real corpus every token-bearing row had
  `time_updated != time_created`. A naive cursor would freeze the first partial snapshot. The
  adapter re-reads a recent window ordered by `time_updated` and emits only the *delta* for a
  message whose totals grew — the same tails mechanism the Anthropic adapter uses for streamed
  snapshots.
- **Reasoning is sometimes additive.** Most providers report reasoning as a subset of output,
  but some report it on top. Where `reasoning > output` the only reading that satisfies the
  schema's subset invariant without losing tokens is `output += reasoning`.

A non-vendor `providerID` (e.g. `opencode`'s own gateway) is recorded as `gateway`; vendor
slugs route direct. Zero-token assistant rows are aborted requests, not free API calls, and are
skipped.

```yaml
sources:
  opencode:
    db: "~/.local/share/opencode/opencode.db"   # override auto-discovery
```

---

## `hermes` — Hermes agent

| | |
|---|---|
| Reads | `~/.hermes/state.db` (`$HERMES_HOME` honoured), via `node:sqlite` |
| Measurement | `primary` |
| Reports | per-session-per-model tokens: input, cache read, cache write, output, reasoning; billing provider (as gateway), measured cost when recorded, session source (cli/cron/whatsapp/telegram), cwd, git branch/repo, task, call count, duration |
| Cannot know | per-request granularity — usage is aggregated per session × model; within-group timing |

Hermes records its own LLM traffic in `session_model_usage` (one row per session × model ×
billing provider × task) joined to `sessions`. There is no per-request log — `messages.token_count`
is unpopulated — so the finest honest granularity is one record per group, timestamped at the
group's first API call.

Token semantics: `input_tokens` is already **exclusive** of cache reads (verified: cache reads
exceed input many-fold on real sessions). The columns are `NOT NULL DEFAULT 0`, so an
unreported split and a true zero are indistinguishable in this source; zeros are passed through
as zeros rather than invented into nulls.

Three things worth knowing:

- **Rows grow.** A session's usage rows are upserted as it makes more calls. Like the opencode
  adapter, this one re-reads a recent window ordered by `last_seen` and emits only deltas; the
  base record sits at `first_seen`, a delta at the `last_seen` that revealed it.
- **Gateway vs vendor.** `billing_provider` ("nous", "openrouter", "openai-codex") is routing,
  so it becomes `gateway` — unless it IS the vendor ("anthropic" billing for a claude model is
  a direct call). Unmapped models stay provider `unknown` with their gateway preserved;
  `"default"` is treated as the placeholder it is.
- **Measured cost wins.** When hermes recorded `actual_cost_usd > 0` that is passed through as
  a measured cost and the price-table estimate stands down. Its `estimated_cost_usd` is ignored:
  two competing estimates would make the Cost page unauditable.

```yaml
sources:
  hermes:
    db: "~/.hermes/state.db"   # override auto-discovery
```

---

## `headroom` — local LLM gateway (overlay)

| | |
|---|---|
| Reads | `~/.headroom/savings_events.jsonl` |
| Measurement | `overlay` — **excluded from token totals by default** |
| Reports | **measured** `cost_usd` per request, post-compression prompt tokens actually sent, the compression delta (`before` → `after`), model, client |
| Cannot know | output tokens, cache split (the savings log has neither) |

The proxy sees the same requests the Codex adapter already recorded. Adding both would double
count every routed token — hence `overlay`. What only the gateway knows is what the request
actually **cost**, which gives the Cost page an independent cross-check against the price-table
estimate instead of a single unverifiable number.

---

## `git` — activity correlation

| | |
|---|---|
| Reads | `git log --numstat` per repository |
| Measurement | `activity` |
| Reports | commits, files changed, insertions, deletions, author, branch, message |
| Cannot know | anything about tokens |

Repositories come from, in order: `sources.git.repos`, `sources.git.scanRoots` (searched for
`.git`, depth 3), and `autoFromUsage: true` — the working directories already observed in ingested
usage records, which means zero configuration for the common case where you code where you prompt.

```yaml
sources:
  git:
    scanRoots: ["~/code"]
    author: "you@example.com"    # optional
    since: "2026-01-01"          # optional
    autoFromUsage: true
```

---

## `generic` — CSV / TSV / JSON / JSONL / SQLite

The escape hatch that keeps this project useful for providers nobody has written an adapter for.

```bash
tokenflow import ~/Downloads/openrouter.csv          # infers a mapping and previews it
tokenflow import usage.jsonl --field timestamp=ts --field input_tokens=prompt_tokens
tokenflow import app.db --format sqlite --table usage --field timestamp=created_at
```

The mapping is saved to `$TOKENFLOW_HOME/mappings/<name>.json` and reused automatically:

```json
{
  "name": "openrouter-export",
  "format": "csv",
  "files": ["~/Downloads/openrouter-*.csv"],
  "timestampFormat": "iso",
  "defaults": { "client": "openrouter", "interface": "API" },
  "fields": {
    "timestamp": "created_at",
    "model": "model",
    "input_tokens": "prompt_tokens",
    "output_tokens": "completion_tokens",
    "cache_read_tokens": "cached_tokens",
    "estimated_cost": "cost_usd",
    "session_id": "generation_id"
  }
}
```

Unmapped token fields stay `null`. A row whose timestamp cannot be parsed is rejected rather than
defaulted to "now". `timestampFormat` accepts `iso`, `epoch_ms`, `epoch_s`.

---

## `mock` — demo data

Deterministic synthetic usage so a new contributor can run `npm run demo` and see a realistic
dashboard without connecting anything. Only activates when explicitly asked for
(`TOKENFLOW_DEMO=1` or `providers: [mock]`), so it can never contaminate a real dataset by
accident. Every record carries `metadata.demo = true` and `machine: "demo-machine"`, and the
dashboard shows a persistent banner whenever any of it is in scope.

---

## What is deliberately not here

- **Vendor billing APIs.** They would need credentials and a network client. This project has
  neither by design. If you can export a CSV from a billing console, `tokenflow import` will take it.
- **Prompt or completion text.** Adapters read counts and metadata and discard content. There is
  nowhere in the schema to put a prompt.
- **Anything that writes to a source.** Adapters open source files read-only, and SQLite sources
  are read from a temp copy.

## Adding your own

See [creating-provider.md](creating-provider.md). Drop a file in
`$TOKENFLOW_HOME/providers/<id>.js` and it is loaded on the next run — no core changes.

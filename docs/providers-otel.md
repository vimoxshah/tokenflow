# `otel` — OpenTelemetry (GenAI)

A machine sweep of common local coding-agent tools found none that write per-request token
counts to disk in a proprietary format for several of them — Gemini CLI among them. Several of
them CAN write [OpenTelemetry](https://opentelemetry.io/) data to a local file, though, so this
adapter reads that instead: point a tool's OTLP file exporter, or Gemini CLI's own file
telemetry, at a file this adapter can see, and it becomes a TokenFlow source with zero
vendor-specific code on the tool's side.

| | |
|---|---|
| Reads | `~/.gemini/telemetry.log` (best-effort default — see below) and `~/.tokenflow/otel/*.{jsonl,ndjson,json,log}` |
| Measurement | `primary` |
| Reports | `input`, `output`, `cache_read`, `cache_write` (standards-based path only), `reasoning`, session/conversation id, request id (span id), duration, model, provider |
| Cannot know | interface/surface (no OTel GenAI attribute carries it — every record classifies as `Unknown` unless a resource attribute happens to match a known IDE/CLI name) |

## What actually lands on disk — two shapes, not one

This adapter reads two genuinely different file shapes, and it matters which one a given tool
produces:

**A. Standards-based OTLP JSON.** A compliant OTLP file exporter (for example the [OpenTelemetry
Collector's `file` exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib))
writes the real wire protocol: `resourceSpans[].scopeSpans[].spans[]` or
`resourceLogs[].scopeLogs[].logRecords[]`, with attributes as
`[{key, value: {stringValue|intValue|doubleValue|boolValue}}]`. Usage lives under
`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.usage.cache_read.input_tokens`
/ `gen_ai.usage.cache_write.input_tokens` / `gen_ai.usage.reasoning.output_tokens`, per the
[GenAI spans semantic conventions](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md).
This is the shape any *other* instrumented tool should target if you want it to show up here.

**B. Gemini CLI's own file telemetry.** Verified against Gemini CLI's source
(`packages/core/src/telemetry/file-exporters.ts`), Gemini CLI does **not** write the OTLP wire
format to its outfile. Its `FileLogExporter`/`FileSpanExporter` pretty-print
(`JSON.stringify(record, null, 2)`) the OpenTelemetry JS SDK's own internal `ReadableLogRecord`/
`ReadableSpan` objects, one JSON value per flush — so a "record" in that file can span many text
lines, and the file is not, strictly, JSON Lines. This adapter's `ingestFile` scans for balanced
top-level JSON values by brace/bracket depth (not by newline), so both shapes are read correctly
from the same file, including a file that is a single JSON document with no line breaks at all.

## Enabling Gemini CLI's file telemetry

Quoting the setting names from Gemini CLI's own docs
(`docs/cli/telemetry.md`, `GEMINI_TELEMETRY_*` env vars):

```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "outfile": ".gemini/telemetry.log"
  }
}
```

in `.gemini/settings.json` (or the equivalent `GEMINI_TELEMETRY_ENABLED=true`,
`GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OUTFILE=...` environment variables). The docs'
own worked example uses `.gemini/telemetry.log`, a path **relative to the CLI's working
directory** — the setting has no fixed default (`-` in the settings table until you set it), so
there is no single home-level location TokenFlow can rely on. This adapter's best-effort default
looks for `~/.gemini/telemetry.log`, but the reliable setup is either:

- an **absolute** `outfile` path pointed at the drop folder below, or
- `sources.otel.paths` in your TokenFlow config, pointed at wherever your project's
  `outfile` actually is.

```yaml
sources:
  otel:
    paths: ["~/code/my-project/.gemini/telemetry.log"]
```

Gemini CLI logs two records per API call to the same file when telemetry is on: the
`gemini_cli.api_response` event (all the token fields) and a semantic twin,
`gen_ai.client.inference.operation.details`, that repeats the same usage under the
standards-based attribute names. This adapter recognizes the pairing and counts the call once,
from `gemini_cli.api_response` only.

## Pointing another tool's OTLP file exporter here

Any tool whose OpenTelemetry SDK setup lets you choose a file-based (or a `file://`) exporter for
traces or logs can use the same drop folder:

```
~/.tokenflow/otel/<anything>.jsonl
```

Anything ending in `.jsonl`, `.ndjson`, `.json`, or `.log` under that folder is picked up. Point
the OTel Collector's `file` exporter, or an OTLP/HTTP exporter aimed at a local static file
server that happens to append to disk, at a file under that folder, and it becomes a TokenFlow
source with no code change here — that is the point of reading the standards-based shape.

## Token semantics

**Standards-based (`gen_ai.usage.*`).** Per the GenAI semantic conventions' own notes,
`gen_ai.usage.input_tokens` is documented to *include* both `cache_read.input_tokens` and
`cache_write.input_tokens` (the same inclusive convention OpenAI/Codex uses) — this adapter
subtracts both to get the schema's exclusive `input_tokens`. `reasoning.output_tokens` is
documented as already included in `output_tokens`, so it is copied through unmodified as a
subset.

**Gemini's own event.** Verified against
[the Generate Content API reference](https://ai.google.dev/api/generate-content):
`promptTokenCount` "is still the total effective prompt size ... includes the number of tokens
in the cached content" (inclusive of the cache, like the standards-based path), and
`totalTokenCount` is "prompt + thoughts + response candidates" — three **separate**, additive
terms. That second fact matters: it means the candidate/output count does NOT already include
thinking tokens, so to keep `reasoning_tokens` a subset of `output_tokens` (a schema invariant),
this adapter reports `output_tokens = output_token_count + thoughts_token_count` and
`reasoning_tokens = thoughts_token_count`.

**Left unverified, on purpose.** Whether `toolUsePromptTokenCount` is already folded into
`promptTokenCount`, or is additive and simply omitted from the documented `totalTokenCount`
formula, is not stated anywhere in the sources checked for this adapter. `tool_token_count` is
therefore recorded only in `metadata` (for a manual audit against `total_token_count`), never
added into `input_tokens` or `output_tokens`.

## Privacy

OTel GenAI attributes, and Gemini CLI's own events, can carry full prompt/response text
(`gen_ai.input.messages`, `gen_ai.output.messages`, `response_text`, a human-readable log `body`
describing the call). This adapter never reads those keys, and never spreads a source record's
attributes into `metadata` — every metadata field is written one at a time, from an explicit
allow-list (`model`/`provider`/`operation`/`status`/`session_id`/`conversation_id`, matching this
product's data-collection rule for OTel sources specifically). Fields present on the source but
NOT retained include `auth_type`, `finish_reasons`, `installation.id`, and `user.email` — those
are on the wire, but not on the allow-list, so they are dropped even though nothing forces you to
turn on `telemetry.logPrompts: false` upstream.

## `docs/providers.md` integration

Row for the provider table (`docs/providers.md` is not edited by this change — see the
CHANGELOG/report for the exact snippet a maintainer can paste in):

````markdown
## `otel` — OpenTelemetry (GenAI)

| | |
|---|---|
| Reads | `~/.gemini/telemetry.log` (best-effort) and `~/.tokenflow/otel/*.{jsonl,ndjson,json,log}` |
| Measurement | `primary` |
| Reports | `input`, `output`, `cache_read`, `cache_write`, `reasoning`, session/conversation id, request id, duration, model, provider |
| Cannot know | interface/surface (no OTel GenAI attribute carries it) |

Standards-based: point any tool's OTLP file/collector exporter at the drop folder. Gemini-CLI
specific: enable `telemetry.enabled`/`target: "local"`/`outfile` in `.gemini/settings.json`; see
[docs/providers-otel.md](providers-otel.md) for the field mapping, the double-count-avoidance
rule for Gemini's paired events, and the privacy allow-list.

### Configuration

```yaml
sources:
  otel:
    paths: ["~/code/my-project/.gemini/telemetry.log", "~/.tokenflow/otel"]
```

---
````

## Tools with no known on-disk usage log (needs a sample)

These tools were not verified for this adapter — either they have no documented local usage
export, or checking would have required an account/install this task didn't have. If you run one
of these and can point it at an OTLP file exporter (or find where it already writes per-request
token counts), a fixture line from a **synthetic** run is what turns this from a guess into a
supported source.

| Tool | Status |
|---|---|
| Aider | No documented on-disk per-request usage log found; Aider prints session totals to the terminal. Needs a sample. |
| Ollama | No documented usage-log file; token counts are only in the API response body, not persisted. Needs a sample. |
| LM Studio | No documented on-disk usage log found. Needs a sample. |
| Zed | Connects to Gemini CLI via ACP (surface tag `zed` per Gemini CLI's telemetry docs) but Zed itself was not checked for its own OTel/usage export. Needs a sample. |
| Windsurf / Codeium | No documented on-disk usage log found. Needs a sample. |
| JetBrains AI Assistant | Gemini CLI's ACP integration reports a `jetbrains` surface tag, but the JetBrains plugin's own usage/telemetry export was not checked. Needs a sample. |
| Continue | No documented on-disk usage log found. Needs a sample. |
| Copilot CLI | No documented on-disk usage log found. Needs a sample. |
| Antigravity | No public documentation found for this task; needs a sample or a pointer to its docs. |

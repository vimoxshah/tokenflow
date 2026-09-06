/**
 * OpenTelemetry (GenAI) — any tool that writes an OTLP-shaped export, or
 * Gemini CLI's own file telemetry, to a local file.
 *
 * A machine sweep found no tool that writes per-request token counts to disk
 * in a proprietary format for several agent CLIs (Gemini CLI among them), but
 * several of them CAN write OpenTelemetry data to a local file. This adapter
 * is the capture path for that: point a tool's OTLP file exporter, or Gemini
 * CLI's `telemetry.outfile`, at a file this adapter reads, and it becomes a
 * TokenFlow source with zero vendor-specific code on the tool's side.
 *
 * ## Verified primary sources (fetched 2026-09-05)
 *
 *  - OTel GenAI spans:  raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md
 *    (the copy that used to live in open-telemetry/semantic-conventions has moved here)
 *  - OTel GenAI events: .../semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md
 *  - OTLP JSON wire example (resourceSpans/attributes-as-array): raw.githubusercontent.com/open-telemetry/opentelemetry-proto/main/examples/trace.json
 *  - Gemini CLI telemetry settings: raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md
 *  - Gemini CLI's own file writer (ground truth for what actually lands on disk):
 *    raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/telemetry/file-exporters.ts,
 *    .../packages/core/src/telemetry/types.ts (`ApiResponseEvent`, EVENT_API_RESPONSE,
 *    EVENT_GEN_AI_OPERATION_DETAILS), .../loggers.ts (logApiResponse emits both records),
 *    .../telemetryAttributes.ts (getCommonAttributes: `session.id`, `installation.id`),
 *    .../metrics.ts (GenAiProviderName.GCP_GEN_AI = 'gcp.gen_ai' — confirms Gemini's OWN
 *    gen_ai.provider.name is not the literal "google"), and the gemini-cli `docs/` tree
 *    listing (github api repos/google-gemini/gemini-cli/contents/docs) used to locate
 *    docs/cli/telemetry.md in the first place.
 *  - Gemini `usage.promptTokenCount` cache-inclusion and the `total = prompt + thoughts +
 *    candidates` formula: ai.google.dev/api/generate-content ("promptTokenCount ...
 *    includes the number of tokens in the cached content"; "totalTokenCount ... prompt +
 *    thoughts + response candidates").
 *  - OTel JS SDK internals used ONLY to establish what `safeJsonStringify` on a raw
 *    ReadableLogRecord/ReadableSpan actually serializes (own vs. getter-backed fields):
 *    opentelemetry-js experimental/packages/sdk-logs/src/LogRecordImpl.ts (`attributes` is
 *    an own field; `hrTime`/`body`/`severityText` are getters, dropped by plain
 *    JSON.stringify) and packages/opentelemetry-resources/src/ResourceImpl.ts (`attributes`
 *    is a getter over a private `_rawAttributes`, so a raw dump's `resource.attributes` is
 *    unreliable — used best-effort only, never for a required field).
 *
 * ## Two on-disk shapes, not one — this is the load-bearing finding
 *
 * The task that produced this adapter assumed every source here writes
 * standard OTLP wire JSON (`resourceSpans`/`resourceLogs` with attributes as
 * `[{key, value:{stringValue|intValue|...}}]`). That is true for a compliant
 * OTLP file exporter (e.g. the OTel Collector's `file` exporter), and this
 * adapter reads it (shapes A/B below). It is NOT true for Gemini CLI: its
 * `FileLogExporter`/`FileSpanExporter` (file-exporters.ts) call
 * `safeJsonStringify(data, 2) + '\n'` on the OTel JS SDK's own internal
 * `ReadableLogRecord`/`ReadableSpan` objects — a pretty-printed (indent 2,
 * so individual records span MANY lines), vendor-internal dump, not the wire
 * protocol. Its `attributes` field is a flat plain object (own property on
 * `LogRecordImpl`, confirmed against opentelemetry-js's
 * `experimental/packages/sdk-logs/src/LogRecordImpl.ts`), not an array of
 * `{key,value}`. Its `hrTime`/`body`/`severityText` are GETTERS over private
 * `_`-prefixed fields and a plain `JSON.stringify` (no `toJSON()` on that
 * class) silently drops them — so for Gemini's own dump the only reliable
 * timestamp is the plain string the CLI puts INSIDE `attributes` itself:
 * `attributes['event.timestamp']`. This adapter therefore parses three
 * concrete shapes, not one file format:
 *
 *   A. OTLP JSON `resourceSpans[].scopeSpans[].spans[]`, attributes as
 *      `[{key, value:{stringValue|intValue|doubleValue|boolValue}}]`.
 *   B. OTLP JSON `resourceLogs[].scopeLogs[].logRecords[]` (or a span's
 *      `events[]`), same wire attribute shape.
 *   C. A bare, single JSON object per record — either Gemini's raw SDK dump
 *      (`{attributes:{...}, resource:{...}, ...}`, attributes already flat)
 *      or a hand-rolled line that IS the flat attributes map directly.
 *
 * `normalize(doc)` dispatches on which shape a top-level JSON value is; the
 * same attribute-flattening code (`flattenAttrs`) accepts either the wire
 * array or an already-flat object, so B and C share one code path.
 *
 * ## The file is not JSON Lines — it is concatenated JSON values
 *
 * Because Gemini pretty-prints, a "line" of Gemini's outfile is not one JSON
 * value; one JSON value spans many text lines. `ingestFile` does NOT use the
 * codebase's line-oriented `readLines` — it scans the byte buffer for
 * balanced top-level `{...}`/`[...]` values (comments on `scanJsonDocuments`
 * explain the brace-depth/string-aware walk and its EOF/resync rules), which
 * transparently handles compact JSONL, pretty-printed concatenation, and a
 * file that is a single JSON document, with exact byte offsets for resume.
 *
 * **Known limitation.** `readTail` reads the unread delta (`ref.start` ..
 * EOF) into memory in one call, like the generic importer's `json` format
 * does. That delta is normally small (incremental resume), but Gemini's
 * `telemetry.logPrompts` defaults to `true`, so a first ingest of a large,
 * long-lived outfile that has never been read before can be a large read —
 * full prompt/response text is still on disk in that file even though this
 * adapter never stores it.
 *
 * ## Avoiding a 2–3x double count from Gemini CLI's own file
 *
 * `logApiResponse()` (loggers.ts) emits TWO log records per API call: the
 * `gemini_cli.api_response` event (all the token fields) AND a semantic twin,
 * `gen_ai.client.inference.operation.details` (types.ts `toSemanticLogRecord`),
 * which repeats `gen_ai.usage.input_tokens`/`output_tokens` under the
 * standards-based attribute names. If `telemetry.traces` is also on
 * (default `false`), an `llm_call` SPAN with its own `gen_ai.usage.*` — and
 * no `event.name` at all — can land in the same file too. Reading all of
 * "shape A", "shape B" and "the Gemini event" naively would count one real
 * API call two or three times. The rule applied here, in `recordFromAttrs`:
 * a record whose `attributes['event.name']` starts with `gemini_cli.` or
 * equals `gen_ai.client.inference.operation.details` is recognised as
 * Gemini-native, and ONLY `gemini_cli.api_response` yields a usage record;
 * a record with NO `event.name` is still recognised as Gemini-native (and
 * skipped) when it carries `gen_ai.agent.name: 'gemini-cli'` (quoted
 * verbatim in telemetry.md's span attribute list) or `installation.id`
 * (only ever set by Gemini's own `getCommonAttributes()`). Every Gemini-
 * native record other than `gemini_cli.api_response` is silently skipped,
 * the same as any other record with no usage to report.
 *
 * ## Token semantics
 *
 * **Standards-based path (gen_ai.usage.*).** Per gen-ai-spans.md notes
 * [23]/[24]/[28]: `gen_ai.usage.input_tokens` "SHOULD include" BOTH
 * `cache_read.input_tokens` and `cache_write.input_tokens` — the same
 * inclusive convention as OpenAI/Codex. `input_tokens` (schema) = usage
 * input minus cache_read minus cache_write, clamped to >= 0.
 * `gen_ai.usage.reasoning.output_tokens` note [30] says it is ALREADY
 * included in `output_tokens`, so it is a direct, unmodified sub-field — no
 * arithmetic needed (unlike Gemini's own event, next).
 *
 * **Gemini's own event (`gemini_cli.api_response`).** Verified against
 * ai.google.dev/api/generate-content: `promptTokenCount` ("this is still the
 * total effective prompt size ... includes the number of tokens in the
 * cached content") is INCLUSIVE of `cachedContentTokenCount`, so
 * `input_tokens` = `input_token_count` - `cached_content_token_count`
 * (clamped >= 0); `cache_read_tokens` = `cached_content_token_count` (Gemini
 * always reports this field — even as a measured 0 — so it is never
 * "unreported" for this source). There is no cache-write count in this
 * event (creating a `CachedContent` is a separate call), so
 * `cache_write_tokens` stays `null`. `totalTokenCount` is documented as
 * "prompt + thoughts + response candidates" — three SEPARATE, additive
 * terms, which means `candidatesTokenCount` (-> output_token_count) does
 * NOT already include `thoughtsTokenCount`. The schema requires
 * `reasoning_tokens` to be a SUBSET of `output_tokens`, so:
 * `output_tokens` = `output_token_count` + `thoughts_token_count`,
 * `reasoning_tokens` = `thoughts_token_count`.
 *
 * **Unverified — kept out of the totals on purpose.** Whether
 * `toolUsePromptTokenCount` is folded into `promptTokenCount` already, or is
 * additive and simply omitted from the documented `totalTokenCount` formula,
 * is not stated anywhere fetched for this adapter. `tool_token_count` is
 * therefore recorded only in `metadata` (for an audit cross-check against
 * `total_token_count`), never added into `input_tokens` or `output_tokens`.
 *
 * ## Privacy
 *
 * OTel GenAI attributes and Gemini CLI's own events can carry full prompt/
 * response text (`gen_ai.input.messages`, `gen_ai.output.messages`,
 * `response_text`, a log `body` describing the call). None of those keys are
 * ever read by the mapping functions below, and `metadata` is built field by
 * field from an explicit allow-list (never `{...attrs}`), so nothing "extra"
 * can leak through even if a future attribute is added upstream. Per the
 * product privacy rule, `metadata` string fields are limited to `model`
 * (top-level schema field, not metadata), `provider`/`operation`/`status`,
 * and `session_id`/`conversation_id` (also top-level) — `auth_type` and
 * `finish_reasons` are deliberately NOT retained even though they are on the
 * source records, because they are not on that allow-list.
 *
 * ## Discovery
 *
 * `sources.otel.paths` (array), if configured, is used verbatim (files or
 * directories). Otherwise: `~/.gemini/telemetry.log` (the path from Gemini
 * CLI's own worked example in docs/cli/telemetry.md — the setting has no
 * fixed default there, `outfile` is `-` unless set, and a relative value
 * resolves against the CLI's working directory, so this home-level guess is
 * best-effort, not a documented default) and `~/.tokenflow/otel/` — a plain
 * drop folder for any tool's OTLP file exporter, matching `*.jsonl`,
 * `*.ndjson`, `*.json`, `*.log`. An explicit `outfile`/collector `file`
 * exporter path pointed at that folder is the reliable setup; see
 * docs/providers-otel.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { walk } from '../../core/ingest.js';
import { MEASUREMENT } from '../../core/schema.js';

const EXTS = ['.jsonl', '.ndjson', '.json', '.log'];

const GEMINI_API_RESPONSE = 'gemini_cli.api_response';
const GEMINI_SEMANTIC_TWIN = 'gen_ai.client.inference.operation.details';
const GEMINI_EVENT_PREFIX = 'gemini_cli.';

// ---------------------------------------------------------------- helpers --

function str(v) {
  return v === undefined || v === null || v === '' ? null : String(v);
}
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function expand(p, home) {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

/** 19-digit nanosecond epoch string -> ISO. BigInt division avoids the
 *  precision loss `Number(nanoString)` would silently introduce. */
export function fromUnixNano(v) {
  if (v === undefined || v === null) return null;
  try {
    const ns = typeof v === 'bigint' ? v : BigInt(String(v));
    if (ns === 0n) return null;
    const d = new Date(Number(ns / 1000000n));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** Millisecond duration between two nanosecond epoch strings, or null. */
export function nanoDiffMs(startV, endV) {
  try {
    const s = BigInt(String(startV));
    const e = BigInt(String(endV));
    if (e <= s) return null;
    return Number((e - s) / 1000000n);
  } catch {
    return null;
  }
}

/** OTLP wire `AnyValue` -> a plain JS scalar/array/object. */
function scalarFromOtlpValue(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(scalarFromOtlpValue);
  if ('kvlistValue' in v) return flattenAttrs(v.kvlistValue?.values);
  return null;
}

/**
 * Accepts EITHER the OTLP wire shape (`[{key, value:{stringValue}}, ...]`)
 * or an already-flat object (Gemini's own dump, or a hand-rolled line) and
 * returns a flat `{key: scalar}` map either way.
 */
export function flattenAttrs(x) {
  if (!x) return {};
  if (Array.isArray(x)) {
    const out = {};
    for (const kv of x) {
      if (kv && typeof kv === 'object' && 'key' in kv) out[kv.key] = scalarFromOtlpValue(kv.value);
    }
    return out;
  }
  if (typeof x === 'object') return x;
  return {};
}

function hasUsage(attrs) {
  return (
    attrs['gen_ai.usage.input_tokens'] !== undefined
    || attrs['gen_ai.usage.output_tokens'] !== undefined
    || attrs.input_token_count !== undefined
    || attrs.output_token_count !== undefined
    || attrs.cached_content_token_count !== undefined
    || attrs.thoughts_token_count !== undefined
  );
}

// --------------------------------------------------------- field mappers --

/**
 * Gemini CLI's own `gemini_cli.api_response` event. See the module header
 * for the verified token-inclusion rules this implements.
 */
function fromGeminiApiResponse(attrs, { timestamp, durationMs }) {
  const input = numOrNull(attrs.input_token_count);
  const output = numOrNull(attrs.output_token_count);
  const cached = numOrNull(attrs.cached_content_token_count);
  const thoughts = numOrNull(attrs.thoughts_token_count);
  const tool = numOrNull(attrs.tool_token_count);
  const total = numOrNull(attrs.total_token_count);
  if (input === null && output === null && cached === null && thoughts === null) return null;

  const freshInput = input === null ? null : Math.max(0, input - (cached ?? 0));
  const combinedOutput = output === null && thoughts === null ? null : (output ?? 0) + (thoughts ?? 0);

  return {
    timestamp: str(attrs['event.timestamp']) ?? timestamp ?? null,
    model: str(attrs.model),
    providerHint: 'google',
    input_tokens: freshInput,
    cache_read_tokens: cached,
    cache_write_tokens: null,
    output_tokens: combinedOutput,
    reasoning_tokens: thoughts,
    cache_refresh_tokens: null,
    session_id: str(attrs['session.id']),
    conversation_id: str(attrs['gen_ai.conversation.id']),
    request_id: str(attrs.prompt_id),
    duration_ms: numOrNull(attrs.duration_ms) ?? durationMs,
    client: 'gemini-cli',
    application: 'Gemini CLI',
    interfaceSignals: [],
    metadata: {
      transport: 'otel',
      operation: GEMINI_API_RESPONSE,
      status: attrs.status_code ?? null,
      tool_token_count: tool,
      total_token_count_reported: total,
    },
  };
}

/** Standards-based `gen_ai.usage.*` — a span, a log record, or a span event. */
function fromGenAiUsage(attrs, { timestamp, requestId, resourceAttrs = {}, durationMs = null }) {
  const inputRaw = numOrNull(attrs['gen_ai.usage.input_tokens']);
  const output = numOrNull(attrs['gen_ai.usage.output_tokens']);
  const cacheRead = numOrNull(attrs['gen_ai.usage.cache_read.input_tokens']);
  const cacheWrite = numOrNull(attrs['gen_ai.usage.cache_write.input_tokens']);
  const reasoning = numOrNull(attrs['gen_ai.usage.reasoning.output_tokens']);
  if (inputRaw === null && output === null) return null;

  const freshInput = inputRaw === null ? null : Math.max(0, inputRaw - (cacheRead ?? 0) - (cacheWrite ?? 0));
  const model = str(attrs['gen_ai.response.model']) ?? str(attrs['gen_ai.request.model']);
  // gen_ai.system is the pre-1.x attribute name; kept as a legacy fallback —
  // it has zero references left in the current semantic-conventions-genai spec.
  const providerHint = str(attrs['gen_ai.provider.name']) ?? str(attrs['gen_ai.system']);
  const serviceName = str(resourceAttrs['service.name']);

  return {
    timestamp: timestamp ?? str(attrs['event.timestamp']),
    model,
    providerHint,
    input_tokens: freshInput,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_refresh_tokens: null,
    session_id: str(attrs['gen_ai.conversation.id']) ?? str(attrs['session.id']) ?? str(resourceAttrs['session.id']),
    conversation_id: str(attrs['gen_ai.conversation.id']),
    request_id: requestId ?? str(attrs['gen_ai.response.id']),
    duration_ms: durationMs,
    client: serviceName,
    application: serviceName,
    interfaceSignals: [serviceName],
    metadata: {
      transport: 'otel',
      operation: str(attrs['gen_ai.operation.name']),
      status: str(attrs['error.type']),
    },
  };
}

/** Dispatch: Gemini-native dedup rule, then the standards-based mapping. */
function recordFromAttrs(attrs, opts) {
  if (!attrs || typeof attrs !== 'object') return null;
  const eventName = str(attrs['event.name']);
  if (eventName === GEMINI_API_RESPONSE) return fromGeminiApiResponse(attrs, opts);
  if (eventName && (eventName.startsWith(GEMINI_EVENT_PREFIX) || eventName === GEMINI_SEMANTIC_TWIN)) {
    // A Gemini-native event that is not the api_response event, or the
    // semantic twin of one we already counted — skip, not malformed.
    return null;
  }
  // `telemetry.traces` (default false) also emits an `llm_call` SPAN with its
  // own gen_ai.usage.* — same call, third copy. `gen_ai.agent.name: gemini-cli`
  // is documented verbatim in telemetry.md's span attribute list, and
  // `installation.id` is only ever set by Gemini's own getCommonAttributes(),
  // so either one identifies a Gemini-native span with no event.name at all.
  if (attrs['gen_ai.agent.name'] === 'gemini-cli' || attrs['installation.id'] !== undefined) return null;
  if (!hasUsage(attrs)) return null;
  return fromGenAiUsage(attrs, opts);
}

// -------------------------------------------------------- shape dispatch --

function collectResourceSpans(rs, out) {
  const resourceAttrs = flattenAttrs(rs?.resource?.attributes);
  for (const scope of rs?.scopeSpans || []) {
    for (const sp of scope?.spans || []) {
      const spanAttrs = flattenAttrs(sp.attributes);
      const ts = fromUnixNano(sp.endTimeUnixNano) ?? fromUnixNano(sp.startTimeUnixNano);
      const durationMs = nanoDiffMs(sp.startTimeUnixNano, sp.endTimeUnixNano);
      const requestId = str(sp.spanId);
      if (hasUsage(spanAttrs) || spanAttrs['event.name']) {
        const rec = recordFromAttrs(spanAttrs, { timestamp: ts, requestId, resourceAttrs, durationMs });
        if (rec) { out.push(rec); continue; }
      }
      // Usage sometimes lives on a span EVENT instead of the span's own
      // attributes (e.g. a streamed call). Only look here when the span
      // itself had nothing, so one call is never counted from both places.
      for (const ev of sp.events || []) {
        const evAttrs = { ...spanAttrs, ...flattenAttrs(ev.attributes) };
        const rec = recordFromAttrs(evAttrs, {
          timestamp: fromUnixNano(ev.timeUnixNano) ?? ts,
          requestId,
          resourceAttrs,
          durationMs: null,
        });
        if (rec) out.push(rec);
      }
    }
  }
}

function collectResourceLogs(rl, out) {
  const resourceAttrs = flattenAttrs(rl?.resource?.attributes);
  for (const scope of rl?.scopeLogs || []) {
    for (const lr of scope?.logRecords || []) {
      const attrs = flattenAttrs(lr.attributes);
      const ts = fromUnixNano(lr.timeUnixNano) ?? fromUnixNano(lr.observedTimeUnixNano);
      const rec = recordFromAttrs(attrs, {
        timestamp: ts,
        requestId: str(lr.spanId),
        resourceAttrs,
        durationMs: null,
      });
      if (rec) out.push(rec);
    }
  }
}

/**
 * A bare, single-record JSON document: Gemini's raw `FileLogExporter` dump
 * (`{attributes:{...}, resource:{...}, ...}`), or a hand-rolled line that IS
 * the flat attributes map already.
 */
function collectBare(doc, out) {
  let attrs = flattenAttrs(doc.attributes);
  if (!Object.keys(attrs).length && (doc['event.name'] !== undefined || hasUsage(doc))) attrs = doc;
  if (!Object.keys(attrs).length) return;
  // Best-effort only: a raw ReadableLogRecord/ReadableSpan's `resource` is an
  // OTel-JS `Resource` instance whose `.attributes` is a getter over a
  // private field, so `JSON.stringify` typically drops it — this succeeds
  // only when the shape happens to already be a plain object.
  const resourceAttrs = flattenAttrs(doc.resource?.attributes);
  const ts = fromUnixNano(doc.timeUnixNano)
    ?? fromUnixNano(doc.observedTimeUnixNano)
    ?? fromUnixNano(doc.endTimeUnixNano)
    ?? fromUnixNano(doc.startTimeUnixNano);
  const durationMs = nanoDiffMs(doc.startTimeUnixNano, doc.endTimeUnixNano);
  const rec = recordFromAttrs(attrs, {
    timestamp: ts,
    requestId: str(doc.spanId),
    resourceAttrs,
    durationMs,
  });
  if (rec) out.push(rec);
}

/**
 * Turn one parsed top-level JSON value into zero or more partial usage
 * records. Exposed for tests and dry-run importers, per the provider
 * contract's optional `normalize()` hook.
 * @param {unknown} doc
 * @returns {object[]}
 */
export function normalize(doc) {
  const out = [];
  if (Array.isArray(doc)) {
    for (const d of doc) out.push(...normalize(d));
    return out;
  }
  if (!doc || typeof doc !== 'object') return out;
  const d = /** @type {{resourceSpans?:unknown[], resourceLogs?:unknown[]}} */ (doc);
  if (Array.isArray(d.resourceSpans)) {
    for (const rs of d.resourceSpans) collectResourceSpans(rs, out);
    return out;
  }
  if (Array.isArray(d.resourceLogs)) {
    for (const rl of d.resourceLogs) collectResourceLogs(rl, out);
    return out;
  }
  collectBare(doc, out);
  return out;
}

// ------------------------------------------------------------- scanning --

const OPEN = new Set([0x7b, 0x5b]); // '{' '['
const CLOSE = new Set([0x7d, 0x5d]); // '}' ']'

/**
 * Scan a buffer for complete, balanced top-level JSON values. Handles
 * compact JSON Lines, pretty-printed multi-line JSON concatenated with no
 * separator, and a buffer that is a single JSON document, uniformly — a
 * value only "completes" when its brace/bracket depth returns to 0, so a
 * pretty-printed record spanning many lines is not mistaken for many
 * records.
 *
 * Recovery: pretty-printed JSON (`JSON.stringify(x, null, N)`) and JSON
 * Lines both share one property — a NESTED value is always indented, so a
 * `{`/`[` at the very start of a line is always the start of a fresh
 * top-level value. If the previously-open value never balances before that
 * happens, it is abandoned (counted in `resynced`) rather than swallowing
 * every byte after it for the rest of the file.
 * @param {Buffer} buf
 * @returns {{docs: {start:number,end:number,text:string}[], consumedEnd:number, resynced:number}}
 */
export function scanJsonDocuments(buf) {
  const docs = [];
  let resynced = 0;
  const n = buf.length;
  let i = 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  let docStart = -1;
  let atLineStart = true;

  while (i < n) {
    const c = buf[i];

    if (docStart === -1) {
      if (c === 0x20 || c === 0x09 || c === 0x0d) { i++; atLineStart = false; continue; }
      if (c === 0x0a) { i++; atLineStart = true; continue; }
      if (OPEN.has(c)) {
        docStart = i;
        depth = 0; inString = false; escape = false;
        // fall through: process this byte below in the same pass
      } else {
        i++; atLineStart = false; continue; // stray byte with nothing open: ignore
      }
    } else if (!inString && OPEN.has(c) && atLineStart) {
      // The document that was open never balanced — abandon it.
      resynced++;
      docStart = i;
      depth = 0; inString = false; escape = false;
    }

    if (inString) {
      if (escape) escape = false;
      else if (c === 0x5c) escape = true;
      else if (c === 0x22) inString = false;
      i++; atLineStart = false;
      continue;
    }
    if (c === 0x22) { inString = true; i++; atLineStart = false; continue; }
    if (OPEN.has(c)) { depth++; i++; atLineStart = false; continue; }
    if (CLOSE.has(c)) {
      depth--; i++; atLineStart = false;
      if (depth === 0) {
        docs.push({ start: docStart, end: i, text: buf.subarray(docStart, i).toString('utf8') });
        docStart = -1;
      }
      continue;
    }
    if (c === 0x0a) { atLineStart = true; i++; continue; }
    atLineStart = false;
    i++;
  }

  const consumedEnd = docs.length ? docs[docs.length - 1].end : 0;
  return { docs, consumedEnd, resynced };
}

// -------------------------------------------------------------- discover --

function candidatePaths(ctx) {
  const home = ctx?.home || os.homedir();
  const configured = ctx?.config?.sources?.otel?.paths;
  if (Array.isArray(configured) && configured.length) return configured.map((p) => expand(p, home));
  return [
    path.join(home, '.gemini', 'telemetry.log'),
    path.join(home, '.tokenflow', 'otel'),
  ];
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ ingest --

/** Read only the new bytes (`start` .. EOF) of a file into a Buffer. */
function readTail(file, start) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const from = Math.min(start, stat.size);
    const len = stat.size - from;
    if (len <= 0) return { buf: Buffer.alloc(0), from };
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, from);
    return { buf, from };
  } finally {
    fs.closeSync(fd);
  }
}

export default createProvider({
  id: 'otel',
  name: 'OpenTelemetry (GenAI)',
  description: 'Per-request usage from an OTLP file export, or from Gemini CLI\'s own file telemetry.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.gemini/telemetry.log (Gemini CLI, telemetry.outfile) or an OTLP file export under ~/.tokenflow/otel/'],

  async detect(ctx) {
    const found = candidatePaths(ctx).filter((p) => {
      const st = statSafe(p);
      return st && (st.isFile() || st.isDirectory());
    });
    if (!found.length) {
      return { available: false, detail: `no OTel GenAI export found (looked in ${candidatePaths(ctx).join(', ')})` };
    }
    return { available: true, detail: found.join(', '), paths: found };
  },

  async discover(ctx) {
    const out = [];
    for (const p of candidatePaths(ctx)) {
      const st = statSafe(p);
      if (!st) continue;
      if (st.isFile()) {
        if (st.size) out.push({ key: p, path: p, stat: st });
        continue;
      }
      if (st.isDirectory()) {
        for (const f of walk(p, (name) => EXTS.some((e) => name.endsWith(e)))) {
          const fstat = statSafe(f);
          if (!fstat || !fstat.size) continue;
          out.push({ key: path.relative(p, f), path: f, stat: fstat });
        }
      }
    }
    return out;
  },

  async ingestFile(ref, ctx, emit) {
    const { buf, from } = readTail(ref.path, ref.start || 0);
    if (!buf.length) return { offset: from, records: 0, malformed: 0 };

    const { docs, consumedEnd, resynced } = scanJsonDocuments(buf);
    let records = 0;
    let malformed = resynced;

    for (const doc of docs) {
      let parsed;
      try {
        parsed = JSON.parse(doc.text);
      } catch {
        malformed++;
        continue;
      }
      for (const partial of normalize(parsed)) {
        emit(partial);
        records++;
      }
    }

    return { offset: from + consumedEnd, records, malformed };
  },
});

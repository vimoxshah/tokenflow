/**
 * Tests for the `otel` provider (src/providers/otel/index.js).
 *
 * Fixtures used (synthetic values only, never a captured real line):
 *   test/fixtures/otel-genai.jsonl        — mixed shapes, one file:
 *     1. an OTLP resourceSpans document (compact JSON) with gen_ai.usage.*
 *        on the span itself, including both cache_read and cache_write.
 *     2. a truncated/unbalanced document — never closes — followed
 *        immediately by more valid content, to exercise the scanner's
 *        line-start resync instead of swallowing the rest of the file.
 *     3. an OTLP resourceLogs document (compact JSON) with an unmapped
 *        model, a `gen_ai.provider.name` hint, `reasoning.output_tokens`,
 *        and a resource-level `session.id` fallback.
 *     4. Gemini CLI's raw `gemini_cli.api_response` file-exporter dump
 *        (pretty-printed, spans many lines — proves the scanner does not
 *        mistake one multi-line record for several).
 *     5. its paired semantic twin, `gen_ai.client.inference.operation.details`
 *        (also pretty-printed) — must be skipped, or the same API call
 *        would be counted twice.
 *     6. a plain span with no gen_ai attributes at all (unrelated tracing)
 *        — must be skipped silently, not counted as malformed.
 *     7. a span carrying `gen_ai.input.messages`/`gen_ai.output.messages`
 *        with a sentinel string standing in for real prompt/response text —
 *        must never appear anywhere in the emitted record.
 *     8. a span with NO gen_ai.usage.* of its own, but a span EVENT that
 *        carries it — task shape (b)'s "span events" case; model/provider
 *        come from the span, tokens from the event, merged exactly once.
 *     9. a bare Gemini-style span dump (`gen_ai.agent.name: 'gemini-cli'`,
 *        no `event.name` at all) carrying gen_ai.usage.* — this is the
 *        `telemetry.traces` case: still Gemini-native, still skipped, so
 *        the same call is never counted a second (or third) time.
 *   test/fixtures/otel-genai-single.json — the whole file is ONE JSON
 *     document (no trailing newline needed), to prove that shape is read
 *     the same way as a JSON-Lines file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import otel, { flattenAttrs, scanJsonDocuments } from '../src/providers/otel/index.js';
import { ingestFixtureAsync } from './helpers.js';
import { validateUsage } from '../src/core/validate.js';
import { INTERFACE } from '../src/core/schema.js';

const SENTINEL = 'SENTINEL_PROMPT_TEXT_MUST_NOT_LEAK';

test('otel: mixed fixture — field mapping, cache-token exclusivity, resource fallback, malformed accounting', async () => {
  const { records, result } = await ingestFixtureAsync(otel, 'otel-genai.jsonl');

  assert.equal(records.length, 5, 'twin, plain span, the bare gemini-agent span dump, and the truncated document contribute no records');
  assert.equal(result.malformed, 1, 'exactly one malformed unit: the truncated document that was abandoned');
  for (const r of records) {
    const v = validateUsage(r);
    assert.ok(v.ok, `record ${r.id} fails validateUsage: ${v.errors.join('; ')}`);
  }

  // --- 1. OTLP span with both cache_read and cache_write on gen_ai.usage.input_tokens
  const span = records.find((r) => r.request_id === 'EEE19B7EC3C1B174');
  assert.ok(span, 'span-level record found');
  assert.equal(span.model, 'gpt-4o-mini-2024-07-18', 'response.model wins over request.model');
  assert.equal(span.provider, 'openai');
  assert.equal(span.input_tokens, 600, 'fresh input = 1000 - cache_read(300) - cache_write(100)');
  assert.equal(span.cache_read_tokens, 300);
  assert.equal(span.cache_write_tokens, 100);
  assert.equal(span.output_tokens, 200);
  assert.equal(span.reasoning_tokens, null, 'not reported on this span — null, not 0');
  assert.equal(span.session_id, 'conv-synthetic-abc');
  assert.equal(span.conversation_id, 'conv-synthetic-abc');
  assert.equal(span.duration_ms, 1500, '(endTimeUnixNano - startTimeUnixNano) / 1e6, computed with BigInt');
  assert.equal(span.timestamp, '2023-11-14T22:13:21.500Z');
  assert.equal(span.client, 'acme-agent', 'client from the resource service.name');
  assert.equal(span.measurement, 'primary');

  // --- 3. unmapped model -> gen_ai.provider.name hint; reasoning subset of output;
  //        resource-level session.id fallback since the log has no conversation.id
  const unmapped = records.find((r) => r.model === 'acme-internal-llm-v9');
  assert.ok(unmapped, 'unmapped-model record found');
  assert.equal(unmapped.provider, 'acme-cloud', 'providerHint used only because the model matched no rule');
  assert.equal(unmapped.provider_label, 'Acme Cloud');
  assert.equal(unmapped.input_tokens, 500, 'no cache attributes reported -> unchanged');
  assert.equal(unmapped.cache_read_tokens, null);
  assert.equal(unmapped.cache_write_tokens, null);
  assert.equal(unmapped.output_tokens, 150);
  assert.equal(unmapped.reasoning_tokens, 40, 'gen_ai.usage.reasoning.output_tokens is already a subset, no arithmetic');
  assert.equal(unmapped.session_id, 'session-synthetic-002', 'falls back to the resource-level session.id');
  assert.equal(unmapped.conversation_id, null);
  assert.equal(unmapped.duration_ms, null, 'log records carry no duration');

  // --- 8. usage on a span EVENT, not the span's own attributes: model/provider
  //        come from the span, tokens from the event, merged exactly once
  const viaEvent = records.find((r) => r.request_id === 'CCC19B7EC3C1B1A0');
  assert.ok(viaEvent, 'span-event record found');
  assert.equal(viaEvent.model, 'claude-3-5-haiku-20241022', 'model inherited from the span, not the event');
  assert.equal(viaEvent.provider, 'anthropic');
  assert.equal(viaEvent.input_tokens, 250, 'tokens come from the event, not the (usage-less) span');
  assert.equal(viaEvent.output_tokens, 60);
  assert.equal(viaEvent.timestamp, '2023-11-14T22:13:45.000Z', "the event's own timeUnixNano, not the span's");
  assert.equal(viaEvent.duration_ms, null, 'span-event usage carries no duration of its own');

  // --- 6/7/9. the plain span, the sentinel content, and the bare
  //        gen_ai.agent.name:'gemini-cli' span dump all contribute nothing
  const dump = JSON.stringify(records);
  assert.ok(!dump.includes(SENTINEL), 'gen_ai.input.messages / gen_ai.output.messages content never stored');
  assert.ok(!dump.includes('acme-web'), 'the plain non-GenAI span (no usage) produced no record at all');
  assert.ok(!dump.includes('999'), 'the bare gemini-agent span dump (telemetry.traces case) is recognised and skipped, not double counted');
});

test('otel: Gemini gemini_cli.api_response token semantics, and its semantic twin (and its traces-span twin) are not double counted', async () => {
  const { records } = await ingestFixtureAsync(otel, 'otel-genai.jsonl');
  const gemini = records.filter((r) => r.client === 'gemini-cli');
  assert.equal(gemini.length, 1, 'exactly one record for the api_response event, its semantic-twin log, and its telemetry.traces span twin');

  const r = gemini[0];
  assert.equal(r.model, 'gemini-2.0-flash');
  assert.equal(r.provider, 'google');
  assert.equal(r.application, 'Gemini CLI');
  // promptTokenCount (ai.google.dev/api/generate-content) is documented as
  // INCLUSIVE of cachedContentTokenCount: 900 - 200 = 700.
  assert.equal(r.input_tokens, 700);
  assert.equal(r.cache_read_tokens, 200);
  assert.equal(r.cache_write_tokens, null, 'Gemini reports no cache-write count in this event');
  // totalTokenCount = prompt + thoughts + candidates (three separate additive
  // terms per the same doc), so output = candidates + thoughts to keep
  // reasoning_tokens a subset of output_tokens.
  assert.equal(r.output_tokens, 150, '120 candidates + 30 thoughts');
  assert.equal(r.reasoning_tokens, 30);
  assert.equal(r.session_id, 'session-synthetic-001');
  assert.equal(r.request_id, 'prompt-synthetic-001');
  assert.equal(r.duration_ms, 842);
  assert.equal(r.timestamp, '2026-01-15T10:00:00.000Z', 'from attributes["event.timestamp"], the one reliable field on a raw dump');
  assert.equal(r.total_tokens, 1050, 'cross-checks against the source total_token_count even though cache_write is unreported (partial)');
  assert.equal(r.metadata.total_token_count_reported, 1050);
  assert.equal(r.metadata.tool_token_count, 15, 'kept only in metadata — unverified whether it belongs in a total');

  // Never retained, even though present on the source records: installation
  // id, auth type, finish reasons, active_approval_mode.
  const dump = JSON.stringify(records);
  assert.ok(!dump.includes('install-synthetic-xyz'));
  assert.ok(!dump.includes('oauth-personal'));
  assert.ok(!dump.includes('auto_edit'));
  assert.ok(!dump.includes('STOP'), 'finish_reasons is not on the metadata allow-list');
});

test('otel: a file that is a single JSON document (no JSON Lines) is read the same way', async () => {
  const { records, result } = await ingestFixtureAsync(otel, 'otel-genai-single.json');
  assert.equal(records.length, 1);
  assert.equal(result.malformed, 0);
  const r = records[0];
  assert.equal(r.model, 'mistral-large-2411');
  assert.equal(r.provider, 'mistral');
  assert.equal(r.input_tokens, 300);
  assert.equal(r.output_tokens, 90);
  assert.equal(r.session_id, 'conv-synthetic-single');
  assert.equal(r.interface, INTERFACE.UNKNOWN, 'no surface signal in a generic gen_ai record — Unknown is the honest answer');
});

test('otel: re-reading the same bytes emits nothing new', async () => {
  const first = await ingestFixtureAsync(otel, 'otel-genai.jsonl');
  const again = await ingestFixtureAsync(otel, 'otel-genai.jsonl', {
    start: first.result.offset, state: first.state,
  });
  assert.equal(again.records.length, 0);
  assert.equal(again.result.malformed, 0);
});

test('otel: byte-offset resume tolerates a partially written trailing document', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenflow-otel-'));
  const file = path.join(dir, 'live.jsonl');
  try {
    const complete = '{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{"name":"x"},'
      + '"logRecords":[{"timeUnixNano":"1700000040000000000","attributes":['
      + '{"key":"gen_ai.provider.name","value":{"stringValue":"openai"}},'
      + '{"key":"gen_ai.request.model","value":{"stringValue":"gpt-4o"}},'
      + '{"key":"gen_ai.usage.input_tokens","value":{"intValue":"10"}},'
      + '{"key":"gen_ai.usage.output_tokens","value":{"intValue":"5"}}'
      + ']}]}]}]}\n';
    const partialStart = '{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{"name":"x"},'
      + '"logRecords":[{"timeUnixNano":"1700000041000000000","attributes":['
      + '{"key":"gen_ai.provider.name"';
    fs.writeFileSync(file, complete + partialStart);

    const first = await ingestFixtureAsync(otel, file);
    assert.equal(first.records.length, 1, 'only the complete document is emitted');
    assert.ok(first.result.offset < fs.statSync(file).size, 'the partial trailing document is left unconsumed');
    assert.equal(first.result.malformed, 0, 'an in-progress document is not malformed — it may still be being written');

    const partialRest = ',"value":{"stringValue":"anthropic"}},'
      + '{"key":"gen_ai.request.model","value":{"stringValue":"claude-3-5-haiku-20241022"}},'
      + '{"key":"gen_ai.usage.input_tokens","value":{"intValue":"20"}},'
      + '{"key":"gen_ai.usage.output_tokens","value":{"intValue":"8"}}'
      + ']}]}]}]}\n';
    fs.appendFileSync(file, partialRest);

    const second = await ingestFixtureAsync(otel, file, { start: first.result.offset, state: first.state });
    assert.equal(second.records.length, 1, 'exactly one new record, from the now-completed document');
    assert.equal(second.records[0].model, 'claude-3-5-haiku-20241022');
    assert.equal(second.records[0].input_tokens, 20);
    // The offset lands right after the document's closing brace, not after
    // its trailing newline — that byte of whitespace is simply not part of
    // any document.
    assert.equal(second.result.offset, fs.statSync(file).size - 1, 'stops after the closing brace; the trailing newline is not part of any document');
    // Confirm the one unconsumed byte is harmless: reading again from here
    // finds no further documents and emits nothing new.
    const third = await ingestFixtureAsync(otel, file, { start: second.result.offset, state: second.state });
    assert.equal(third.records.length, 0, 'nothing left to read once the completed document is consumed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('otel: scanJsonDocuments resyncs on a corrupt document instead of swallowing the rest of the file', () => {
  const buf = Buffer.from('{"a": 1\n{"b": 2}\n{"c": 3}\n', 'utf8');
  const { docs, resynced } = scanJsonDocuments(buf);
  assert.equal(resynced, 1, 'the unbalanced {"a": 1 is abandoned when {"b": 2} starts at the next line');
  assert.deepEqual(docs.map((d) => d.text), ['{"b": 2}', '{"c": 3}']);
});

test('otel: flattenAttrs accepts both the OTLP wire array and an already-flat object', () => {
  const wire = [
    { key: 'gen_ai.usage.input_tokens', value: { intValue: '42' } },
    { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
  ];
  assert.deepEqual(flattenAttrs(wire), { 'gen_ai.usage.input_tokens': 42, 'gen_ai.provider.name': 'openai' });

  const flat = { 'gen_ai.usage.input_tokens': 42, 'gen_ai.provider.name': 'openai' };
  assert.deepEqual(flattenAttrs(flat), flat);

  assert.deepEqual(flattenAttrs(null), {});
  assert.deepEqual(flattenAttrs(undefined), {});
});

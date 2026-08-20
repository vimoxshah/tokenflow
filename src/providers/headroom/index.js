/**
 * Headroom — local LLM gateway / prompt-compression proxy.
 *
 * This is an **overlay** source, and the distinction matters. The proxy sees
 * the same requests that the Codex adapter already recorded from the client
 * side. Adding both into one total would double-count every routed token, so
 * overlay records are excluded from token totals by default
 * (`analytics.includeOverlaySources: false`) and used for what only the
 * gateway knows:
 *
 *   - a **measured** dollar cost per request (`cost_usd`), as opposed to our
 *     own price-table estimate — which gives the Cost section an independent
 *     cross-check instead of a single unverifiable number
 *   - the compression delta (`before` -> `after` prompt tokens), i.e. tokens
 *     the client believed it sent versus tokens actually billed
 *
 * `input_tokens` is the post-compression count that was really sent. Output
 * and cache are `null`: the savings log does not carry them.
 *
 * Source: ~/.headroom/savings_events.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { readLines } from '../../core/jsonl.js';
import { MEASUREMENT } from '../../core/schema.js';

function dir(ctx) {
  const c = ctx?.config?.sources?.headroom?.path;
  if (c) return c.startsWith('~') ? path.join(os.homedir(), c.slice(1)) : c;
  return path.join(ctx?.home || os.homedir(), '.headroom');
}

export default createProvider({
  id: 'headroom',
  name: 'Headroom gateway (overlay)',
  description: 'Measured per-request cost and prompt-compression savings from a local LLM proxy. Overlay: excluded from token totals to avoid double counting.',
  measurement: MEASUREMENT.OVERLAY,
  requires: ['~/.headroom/savings_events.jsonl'],

  async detect(ctx) {
    const f = path.join(dir(ctx), 'savings_events.jsonl');
    if (!fs.existsSync(f)) return { available: false, detail: 'No ~/.headroom/savings_events.jsonl found' };
    return { available: true, detail: 'overlay source — measured cost, excluded from token totals', paths: [f] };
  },

  async discover(ctx) {
    const d = dir(ctx);
    const out = [];
    for (const name of ['savings_events.jsonl']) {
      const f = path.join(d, name);
      try {
        out.push({ key: name, path: f, stat: fs.statSync(f) });
      } catch { /* absent */ }
    }
    return out;
  },

  async ingestFile(ref, ctx, emit) {
    let records = 0;
    let malformed = 0;
    let seq = 0;
    const res = readLines(
      ref.path,
      (line) => {
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          malformed++;
          return;
        }
        if (!d.ts && !d.timestamp) return;
        const after = num(d.after);
        emit({
          id: `headroom-${d.ts || d.timestamp}-${seq++}`,
          timestamp: d.ts || d.timestamp,
          model: d.model || null,
          gateway: 'headroom',
          client: d.client || 'unknown',
          application: d.client ? `${d.client} via Headroom` : 'Headroom gateway',
          // The proxy log has no surface field of its own; the client name is
          // the only surface evidence available.
          interfaceSignals: [d.client],
          input_tokens: after,
          output_tokens: null,
          cache_read_tokens: null,
          cache_write_tokens: null,
          cache_refresh_tokens: null,
          reasoning_tokens: null,
          measured_cost: d.cost_usd === undefined || d.cost_usd === null ? null : Number(d.cost_usd),
          session_id: null,
          request_id: null,
          measurement: MEASUREMENT.OVERLAY,
          metadata: {
            prompt_tokens_before_compression: num(d.before),
            prompt_tokens_after_compression: after,
            tokens_saved: num(d.saved),
            proxy_source: d.source ?? null,
            pid: d.pid ?? null,
          },
        });
        records++;
      },
      { start: ref.start },
    );
    return { offset: res.offset, records, malformed };
  },
});

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

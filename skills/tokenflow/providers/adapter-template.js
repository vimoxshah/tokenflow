/**
 * <PROVIDER NAME> — <what this tool is>
 *
 * Source: <exact path pattern>
 *
 * ## Token semantics  ← FILL THIS IN. It is the most valuable part of the file.
 *
 *   <vendor field>  ->  input_tokens          (fresh only? or inclusive of cache?)
 *   <vendor field>  ->  cache_read_tokens
 *   <vendor field>  ->  cache_write_tokens    (null if this version never emits it)
 *   <vendor field>  ->  output_tokens
 *   <vendor field>  ->  reasoning_tokens      (a SUBSET of output)
 *
 * ## Known quirks
 *
 *   - <does it re-report usage as a call streams? then take the max of each
 *      monotonic run, never the sum>
 *   - <are there synthetic/local entries with no real API call? skip them>
 *   - <which fields does it simply not have? those stay null, never 0>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider, readLines, walk, MEASUREMENT } from 'tokenflow/sdk';

const ID = 'my-provider';

function root(ctx) {
  const configured = ctx?.config?.sources?.[ID]?.path;
  if (configured) {
    return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
  }
  return path.join(ctx?.home || os.homedir(), '.my-tool', 'logs');
}

export default createProvider({
  id: ID,
  name: 'My AI Provider',
  description: 'Per-request token usage from My Tool.',
  // primary  = authoritative per-request usage      (counted in totals)
  // overlay  = a gateway's view of the same traffic (excluded from totals by default)
  // activity = no token accounting at all           (activity + correlation only)
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.my-tool/logs/*.jsonl'],

  /** Existence check only. Read no data, write nothing. */
  async detect(ctx) {
    const dir = root(ctx);
    if (!fs.existsSync(dir)) return { available: false, detail: `no ${dir}` };
    return { available: true, detail: dir, paths: [dir] };
  },

  /** Enumerate source files. `key` must be stable — it identifies incremental state. */
  async discover(ctx) {
    const dir = root(ctx);
    return walk(dir, (name) => name.endsWith('.jsonl')).flatMap((p) => {
      let stat;
      try { stat = fs.statSync(p); } catch { return []; }   // vanished mid-scan
      if (!stat.size) return [];
      return [{ key: path.relative(dir, p), path: p, stat }];
    });
  },

  async ingestFile(ref, ctx, emit) {
    // `ref.state` is a plain object persisted per file across refreshes. Use it
    // for header context a mid-file resume would otherwise lose.
    const s = ref.state;
    let records = 0;
    let malformed = 0;

    const res = readLines(
      ref.path,
      (line) => {
        let o;
        try { o = JSON.parse(line); } catch { malformed++; return; }

        // Header/metadata lines: stash what later records need.
        if (o.type === 'session_start') { s.sessionId = o.session_id; s.cwd = o.cwd; return; }
        if (!o.usage) return;

        // Skip entries that are not real API calls (no id AND all-zero usage).
        // Counting them adds fake zero-token requests.
        // if (!o.id && !o.usage.prompt_tokens && !o.usage.completion_tokens) return;

        // If this vendor's input INCLUDES cached tokens, subtract here.
        const inTotal = num(o.usage.prompt_tokens);
        const cached = num(o.usage.cached_tokens);
        const fresh = inTotal === null ? null : cached === null ? inTotal : Math.max(0, inTotal - cached);

        emit({
          timestamp: o.created_at,          // ISO or epoch; the engine normalises
          model: o.model,                   // the vendor is derived FROM THIS
          input_tokens: fresh,
          cache_read_tokens: cached,
          cache_write_tokens: num(o.usage.cache_write),   // null when unreported
          output_tokens: num(o.usage.completion_tokens),
          reasoning_tokens: num(o.usage.reasoning_tokens),
          cache_refresh_tokens: null,
          session_id: s.sessionId || ref.key,
          request_id: o.id || null,
          project: s.cwd ? path.basename(s.cwd) : null,
          repository: s.cwd ? path.basename(s.cwd) : null,
          git_branch: o.branch || null,
          category: 'main',
          client: 'my-tool',
          application: 'My Tool',
          // ORDERED, strongest first. Surface fields only — never the model.
          interfaceSignals: [o.surface, o.client, o.entrypoint],
          // Measured cost from the source, if it has one. Omit otherwise and the
          // engine estimates from the price table (or leaves it null).
          // measured_cost: o.cost_usd,
          metadata: {
            cwd: s.cwd || null,
            version: o.version || null,
            // Record anything that makes your reconstruction auditable:
            // usage_events: n, usage_segments: k,
          },
        });
        records++;
      },
      {
        start: ref.start,          // ALWAYS. This is what makes refresh incremental.
        must: ['"usage"'],         // cheap prefilter — skip lines that cannot match
      },
    );

    // Return the offset of the last COMPLETE line so the next refresh resumes here.
    return { offset: res.offset, records, malformed };
  },
});

/** null, never 0, for an absent value. */
function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

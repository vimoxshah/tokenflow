/**
 * OpenAI — Codex CLI / Codex IDE / Codex Desktop rollout transcripts.
 *
 * Source: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 *         (+ ~/.codex/archived_sessions)
 *
 * ## Token semantics — the important difference from Anthropic
 *
 * Codex reports OpenAI's convention, where `input_tokens` is INCLUSIVE of
 * `cached_input_tokens`. Copying it straight into the schema would count every
 * cached prompt token twice: once as fresh input and once as cache read. So:
 *
 *   input_tokens      = input_tokens - cached_input_tokens   (fresh only)
 *   cache_read_tokens = cached_input_tokens
 *   cache_write_tokens = cache_write_input_tokens, or **null** on older
 *                        sessions that never emitted the field — not 0, because
 *                        "the CLI didn't report it" and "no cache was written"
 *                        are different facts
 *   reasoning_tokens  = reasoning_output_tokens  (a subset of output_tokens)
 *
 * ## One record per turn, and why the obvious reading is wrong
 *
 * Codex emits a `token_count` event repeatedly while a turn runs, and
 * `last_token_usage` is **re-reported as the turn's context grows** — 27k, then
 * 29k, then 30k, ... all describing the same growing conversation. Its
 * `total_token_usage` is simply a running SUM of those re-reports, so it is not
 * a usable cumulative counter: on this corpus it over-reports a heavy agent day
 * by ~45x (82.8B claimed vs 1.8B real), and one 2.5-minute subagent session
 * "spends" 7.5B tokens.
 *
 * The reliable structure is the same streaming-snapshot pattern Anthropic's
 * transcripts have. Within a turn, the `last_token_usage` series is split into
 * monotonically non-decreasing RUNS. A run is one growing context; a DROP means
 * a new one (a context compaction, or a fresh call). The turn's usage is the
 * sum of each run's maximum.
 *
 * That reduces to the identity for simple sessions (one event per turn -> the
 * event itself) and was cross-checked against an independent gateway billing
 * log, which agreed to within the same order of magnitude where the naive
 * reading was off by 45x.
 *
 * `metadata.token_count_events` and `metadata.usage_segments` are recorded on
 * every turn so this reconstruction is auditable rather than a hidden fudge.
 *
 * A `model_provider` that is not a known model vendor is recorded as a
 * **gateway** (a proxy/router) rather than as the vendor, so "who served this"
 * and "who made this model" stay separate dimensions.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { readLines } from '../../core/jsonl.js';
import { walk } from '../../core/ingest.js';
import { MEASUREMENT } from '../../core/schema.js';

const MARKS = ['"token_count"', '"session_meta"', '"thread_settings_applied"', '"turn_context"', '"task_started"', '"task_complete"'];
const VENDORS = new Set(['openai', 'anthropic', 'google', 'gemini', 'deepseek', 'zai', 'z.ai', 'xai', 'mistral', 'azure', 'bedrock', 'vertex', 'ollama']);

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];

export function codexHomes(ctx) {
  const configured = ctx?.config?.sources?.openai?.paths;
  if (Array.isArray(configured) && configured.length) return configured.map(expand);
  const home = ctx?.home || os.homedir();
  const out = [];
  if (process.env.CODEX_HOME) out.push(process.env.CODEX_HOME);
  out.push(path.join(home, '.codex'));
  return [...new Set(out)].filter((d) => {
    try {
      return fs.statSync(path.join(d, 'sessions')).isDirectory();
    } catch {
      return false;
    }
  });
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Accumulate a turn's `last_token_usage` series into disjoint totals.
 *
 * Fields are tracked independently but segmented by `total_tokens`, because
 * that is the value whose monotonicity tells us whether we are still looking at
 * the same growing context.
 *
 * A field that never appears in ANY event stays `null` — "the CLI didn't report
 * cache writes" is a different fact from "no cache was written".
 */
export class TurnUsage {
  constructor() {
    this.acc = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]));
    this.seen = Object.fromEntries(USAGE_FIELDS.map((f) => [f, false]));
    this.run = null;
    this.prevTotal = -1;
    this.events = 0;
    this.segments = 0;
  }

  add(last) {
    if (!last) return;
    const total = num(last.total_tokens);
    this.events++;
    if (this.run === null || total >= this.prevTotal) {
      if (this.run === null) {
        this.run = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]));
        this.segments++;
      }
      for (const f of USAGE_FIELDS) {
        const v = last[f];
        if (v === undefined || v === null) continue;
        this.seen[f] = true;
        this.run[f] = Math.max(this.run[f], Number(v));
      }
    } else {
      // The context shrank: the previous run is finished.
      this.closeRun();
      this.segments++;
      this.run = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]));
      for (const f of USAGE_FIELDS) {
        const v = last[f];
        if (v === undefined || v === null) continue;
        this.seen[f] = true;
        this.run[f] = Number(v);
      }
    }
    this.prevTotal = total;
  }

  closeRun() {
    if (!this.run) return;
    for (const f of USAGE_FIELDS) this.acc[f] += this.run[f];
    this.run = null;
  }

  /** @returns {Record<string, number|null>} */
  finish() {
    this.closeRun();
    /** @type {Record<string, number|null>} */
    const out = {};
    for (const f of USAGE_FIELDS) out[f] = this.seen[f] ? this.acc[f] : null;
    return out;
  }

  toJSON() {
    return { acc: this.acc, seen: this.seen, run: this.run, prevTotal: this.prevTotal, events: this.events, segments: this.segments };
  }

  static from(o) {
    const t = new TurnUsage();
    if (!o) return t;
    Object.assign(t, { acc: o.acc || t.acc, seen: o.seen || t.seen, run: o.run ?? null, prevTotal: o.prevTotal ?? -1, events: o.events || 0, segments: o.segments || 0 });
    return t;
  }
}

export default createProvider({
  id: 'openai',
  name: 'OpenAI (Codex CLI / IDE / Desktop)',
  description: 'Per-turn token usage from Codex rollout transcripts, including gateway-routed models.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.codex/sessions (Codex CLI 0.1x+)'],

  async detect(ctx) {
    const homes = codexHomes(ctx);
    if (!homes.length) return { available: false, detail: 'No ~/.codex/sessions directory found' };
    return { available: true, detail: homes.join(', '), paths: homes };
  },

  async discover(ctx) {
    const files = [];
    for (const home of codexHomes(ctx)) {
      for (const sub of ['sessions', 'archived_sessions']) {
        const root = path.join(home, sub);
        if (!fs.existsSync(root)) continue;
        for (const f of walk(root, (n) => n.endsWith('.jsonl'))) {
          let stat;
          try { stat = fs.statSync(f); } catch { continue; }
          if (!stat.size) continue;
          files.push({ key: `${sub}:${path.relative(root, f)}`, path: f, stat });
        }
      }
    }
    return files;
  },

  async ingestFile(ref, ctx, emit) {
    const s = ref.state;
    let records = 0;
    let malformed = 0;

    /** The turn currently being accumulated. */
    let turn = s.openTurn
      ? { id: s.openTurn.id, firstTs: s.openTurn.firstTs, lastTs: s.openTurn.lastTs, usage: TurnUsage.from(s.openTurn.usage), continued: true }
      : null;

    const newTurn = (id, ts) => ({ id: id || null, firstTs: ts, lastTs: ts, usage: new TurnUsage(), continued: false });

    const flushTurn = () => {
      if (!turn || !turn.usage.events) { turn = null; return; }
      const u = turn.usage.finish();
      const routeProvider = (s.routeProvider || '').toLowerCase();
      const isVendor = VENDORS.has(routeProvider);
      const project = s.cwd ? path.basename(s.cwd) : null;
      const inTotal = u.input_tokens;
      const cached = u.cached_input_tokens;
      // OpenAI's input_tokens INCLUDES cached_input_tokens; the schema wants
      // them mutually exclusive.
      const fresh = inTotal === null ? null : cached === null ? inTotal : Math.max(0, inTotal - cached);
      if (!fresh && !cached && !u.output_tokens && !u.cache_write_input_tokens) { turn = null; return; }
      emit({
        timestamp: turn.lastTs,
        model: s.model || null,
        providerHint: isVendor ? routeProvider : null,
        gateway: routeProvider && !isVendor ? routeProvider : null,
        input_tokens: fresh,
        cache_read_tokens: cached,
        cache_write_tokens: u.cache_write_input_tokens,
        output_tokens: u.output_tokens,
        reasoning_tokens: u.reasoning_output_tokens,
        cache_refresh_tokens: null,
        session_id: s.sessionId || ref.key,
        conversation_id: s.threadId || null,
        request_id: turn.id,
        project,
        repository: project,
        category: s.threadSource === 'subagent' ? 'subagent' : 'main',
        client: 'codex',
        application: 'Codex',
        interfaceSignals: [s.source, s.originator, s.threadSource],
        duration_ms: s.lastDuration ?? null,
        metadata: {
          cwd: s.cwd || null,
          cli_version: s.cliVersion || null,
          originator: s.originator || null,
          source: s.source || null,
          agent_role: s.agentRole || null,
          reasoning_effort: s.effort || null,
          service_tier: s.tier || null,
          context_window: s.contextWindow ?? null,
          time_to_first_token_ms: s.lastTtft ?? null,
          plan_type: s.planType ?? null,
          token_count_events: turn.usage.events,
          usage_segments: turn.usage.segments,
          turn_continued: turn.continued || undefined,
        },
      });
      records++;
      s.lastDuration = null;
      s.lastTtft = null;
      turn = null;
    };

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
        const p = d.payload || {};

        if (d.type === 'session_meta') {
          s.sessionId = p.session_id || p.id || null;
          s.threadId = p.id || null;
          s.cwd = p.cwd || s.cwd || null;
          s.originator = p.originator || s.originator || null;
          s.source = flattenSource(p.source) || s.source || null;
          s.agentRole = agentRole(p.source) || s.agentRole || null;
          s.threadSource = p.thread_source || s.threadSource || null;
          s.cliVersion = p.cli_version || s.cliVersion || null;
          s.routeProvider = p.model_provider || s.routeProvider || null;
          if (p.model) s.model = p.model;
          return;
        }
        if (d.type === 'turn_context') {
          if (p.cwd) s.cwd = p.cwd;
          if (p.model) s.model = p.model;
          if (p.turn_id && (!turn || turn.id !== p.turn_id)) {
            flushTurn();
            turn = newTurn(p.turn_id, d.timestamp);
          }
          return;
        }
        if (d.type === 'event_msg' && p.type === 'thread_settings_applied') {
          const t = p.thread_settings || {};
          if (t.model) s.model = t.model;
          if (t.model_provider_id) s.routeProvider = t.model_provider_id;
          if (t.cwd) s.cwd = t.cwd;
          if (t.reasoning_effort) s.effort = t.reasoning_effort;
          if (t.service_tier) s.tier = t.service_tier;
          return;
        }
        if (d.type === 'event_msg' && p.type === 'task_started') {
          if (!turn || turn.id !== p.turn_id) {
            flushTurn();
            turn = newTurn(p.turn_id, d.timestamp);
          }
          if (p.model_context_window) s.contextWindow = p.model_context_window;
          return;
        }
        if (d.type === 'event_msg' && p.type === 'task_complete') {
          s.lastDuration = p.duration_ms ?? null;
          s.lastTtft = p.time_to_first_token_ms ?? null;
          if (turn && (turn.id === null || !p.turn_id || turn.id === p.turn_id)) flushTurn();
          return;
        }
        if (!(d.type === 'event_msg' && p.type === 'token_count')) return;

        const info = p.info || {};
        const last = info.last_token_usage || info.total_token_usage;
        if (!last) return;
        if (info.model_context_window) s.contextWindow = info.model_context_window;
        if (p.rate_limits?.plan_type) s.planType = p.rate_limits.plan_type;

        // Sessions from older builds have no turn markers; treat each event as
        // its own turn rather than dropping the usage.
        if (!turn) turn = newTurn(null, d.timestamp);
        turn.usage.add(last);
        turn.lastTs = d.timestamp;
        if (turn.id === null) flushTurn();
      },
      { start: ref.start, must: MARKS },
    );

    // A turn still open at EOF keeps accumulating on the next refresh, so no
    // partial record is written for it and none is written twice.
    s.openTurn = turn && turn.usage.events
      ? { id: turn.id, firstTs: turn.firstTs, lastTs: turn.lastTs, usage: turn.usage.toJSON() }
      : null;
    if (turn && !turn.id) flushTurn();

    return { offset: res.offset, records, malformed, openTurn: s.openTurn ? 1 : 0 };
  },
});

function flattenSource(src) {
  if (!src) return null;
  if (typeof src === 'string') return src;
  if (typeof src === 'object') {
    const k = Object.keys(src)[0];
    if (!k) return null;
    const v = src[k];
    if (typeof v === 'string') return `${k}:${v}`;
    if (v && typeof v === 'object') {
      const inner = Object.values(v)[0];
      return typeof inner === 'string' ? `${k}:${inner}` : k;
    }
    return k;
  }
  return null;
}

/** "luna_worker" from a subagent thread_spawn descriptor, when present. */
function agentRole(src) {
  try {
    return src?.subagent?.thread_spawn?.agent_role ?? src?.subagent?.other ?? null;
  } catch {
    return null;
  }
}

function num(v) {
  return v === undefined || v === null ? 0 : Number(v);
}

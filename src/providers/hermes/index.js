/**
 * Hermes — local agent state database.
 *
 * Source: <hermes-home>/state.db  (SQLite; ~/.hermes by default, $HERMES_HOME
 * honoured). Read-only, via node:sqlite, read from a snapshot like every
 * SQLite adapter here.
 *
 * ## What this source is
 *
 * Hermes records its own LLM traffic in two tables:
 *
 *   sessions             one row per conversation: source (cli/cron/whatsapp/
 *                        telegram), cwd, git branch/repo, parent link, timing
 *   session_model_usage  one row per (session × model × billing_provider ×
 *                        task): token totals, API call count, and hermes' own
 *                        estimated_cost_usd / actual_cost_usd
 *
 * There is no per-request log to read — `messages.token_count` is unpopulated
 * — so the finest honest granularity is one record per session×model row,
 * timestamped at the first API call of that group. Sessions and requests are
 * still counted correctly; within-group time shape is not knowable.
 *
 * ## Token semantics (verified against a live corpus)
 *
 *   input_tokens        fresh prompt tokens, EXCLUSIVE of cache reads. On a
 *                       real corpus cache_read exceeds input many times over
 *                       on long sessions, which is impossible under OpenAI's
 *                       inclusive convention, so this is the Anthropic-style
 *                       exclusive one. No subtraction needed.
 *   cache_read_tokens   -> cache_read_tokens
 *   cache_write_tokens  -> cache_write_tokens (0 when the backend reports none)
 *   reasoning_tokens    -> reasoning_tokens, folded into output when a backend
 *                          reports it additively rather than as a subset
 *                          (same rule as the opencode adapter)
 *
 * ## Gateway vs vendor
 *
 * billing_provider ("nous", "openrouter", "openai-codex", "anthropic", ...) is
 * the routing layer the call went through. When it is NOT the model's vendor
 * it is recorded as `gateway`; a claude model billed by "anthropic" is a
 * direct call and gets no gateway. The vendor comes from classifying the
 * model string with the same rules the engine uses, and an unmapped model
 * stays provider "unknown" with its gateway preserved.
 *
 * ## Measured cost
 *
 * When hermes recorded actual_cost_usd > 0 that is a MEASURED price from the
 * billing provider, so it is passed as measured cost (cost_basis "measured")
 * and the engine's estimate stands down. estimated_cost_usd is ignored: it is
 * someone else's estimate, and mixing two estimate sources would make the
 * Cost page unauditable.
 *
 * ## The incremental trap: rows are UPSERTED in place
 *
 * A session's usage rows grow every time the session makes another call —
 * same primary key, bigger totals, later last_seen. A naive
 * "last_seen > cursor" cursor would freeze the totals as of the first read.
 * So this adapter uses the same tails mechanism as the Anthropic adapter:
 * re-read a recent window ordered by last_seen, remember per row what has
 * already been emitted, and emit only the DELTA when a row grew. The base
 * record carries the group's first_seen; a delta carries the last_seen at
 * which the new usage was observed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT, hashId } from '../../core/schema.js';
import { classifyModel } from '../../core/model-map.js';
import { openReadOnly, sqliteAvailable } from '../../core/sqlite.js';

const ROW_CAP = 500000;
/** How far behind the watermark to re-read, to catch upserted rows. */
const OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
/** Emitted-tail entries older than this, relative to the watermark, are pruned. */
const TAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];

export function dbPath(ctx) {
  const c = ctx?.config?.sources?.hermes;
  const p = c?.db || (Array.isArray(c?.paths) ? c.paths[0] : null);
  if (p) return expand(p);
  const home = process.env.HERMES_HOME || path.join(ctx?.home || os.homedir(), '.hermes');
  return path.join(home, 'state.db');
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export default createProvider({
  id: 'hermes',
  name: 'Hermes',
  description: 'Per-session-per-model token usage from the Hermes agent state database.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.hermes/state.db', 'Node 22.5+ (node:sqlite)'],

  async detect(ctx) {
    if (!sqliteAvailable()) return { available: false, detail: 'node:sqlite unavailable — needs Node 22.5+' };
    const f = dbPath(ctx);
    if (!fs.existsSync(f)) return { available: false, detail: 'No Hermes state.db found (looked for ~/.hermes)' };
    return { available: true, detail: shortPath(f, ctx), paths: [f] };
  },

  async fetchUsage(ctx, emit, sourceState) {
    const f = dbPath(ctx);
    const db = openReadOnly(f);
    let records = 0;
    let skipped = 0;
    const notes = [];

    try {
      const cursor = sourceState.cursor || { seen: 0 };
      // Tails: per-row totals already emitted, keyed by the table's own
      // composite key. They make re-reading the overlap window idempotent.
      const tails = sourceState.tails || (sourceState.tails = {});

      const rows = db.prepare(
        `SELECT u.session_id AS session_id, u.model AS model, u.billing_provider AS billing_provider,
                u.task AS task, u.api_call_count AS api_call_count,
                u.input_tokens AS input_tokens, u.output_tokens AS output_tokens,
                u.cache_read_tokens AS cache_read_tokens, u.cache_write_tokens AS cache_write_tokens,
                u.reasoning_tokens AS reasoning_tokens,
                u.actual_cost_usd AS actual_cost_usd, u.cost_status AS cost_status,
                u.first_seen AS first_seen, u.last_seen AS last_seen,
                s.source AS source, s.cwd AS cwd, s.git_branch AS git_branch,
                s.git_repo_root AS git_repo_root, s.parent_session_id AS parent_session_id,
                s.started_at AS started_at, s.ended_at AS ended_at, s.title AS title
           FROM session_model_usage u
           LEFT JOIN sessions s ON s.id = u.session_id
          WHERE u.last_seen > ?
          ORDER BY u.last_seen ASC
          LIMIT ?`,
      ).all(Math.max(0, ((cursor.seen || 0) - OVERLAP_MS) / 1000), ROW_CAP);
      if (rows.length === ROW_CAP) notes.push('row cap hit — run refresh again to continue');

      let watermark = cursor.seen || 0;

      for (const r of rows) {
        const lastSeen = secToMs(r.last_seen);
        if (lastSeen !== null) watermark = Math.max(watermark, lastSeen);

        const base = {
          input_tokens: intOrNull(r.input_tokens),
          output_tokens: intOrNull(r.output_tokens),
          cache_read_tokens: intOrNull(r.cache_read_tokens),
          cache_write_tokens: intOrNull(r.cache_write_tokens),
          reasoning_tokens: intOrNull(r.reasoning_tokens),
        };
        // Additive-reasoning backends: fold so the subset invariant holds.
        if (base.reasoning_tokens !== null && base.output_tokens !== null && base.reasoning_tokens > base.output_tokens) {
          base.output_tokens += base.reasoning_tokens;
        }

        const measuredCost = r.actual_cost_usd !== null && Number(r.actual_cost_usd) > 0 ? Number(r.actual_cost_usd) : null;

        // A group with no counts and no measured cost contributes nothing a
        // dashboard can show; skip it rather than emit an empty request.
        if (FIELDS.every((k) => !base[k]) && measuredCost === null) { skipped++; continue; }

        const key = [r.session_id, r.model ?? '', r.billing_provider ?? '', r.task ?? ''].join('|');
        const prev = tails[key];
        const delta = {};
        let any = false;
        for (const k of FIELDS) {
          const was = prev ? (prev.f[k] ?? 0) : 0;
          const now = base[k] ?? 0;
          delta[k] = Math.max(0, now - was);
          if (delta[k] > 0) any = true;
        }
        // Nothing token-wise since the last emission: an unchanged re-read
        // must stay a no-op forever.
        if (prev && !any) continue;

        // Measured-cost delta against what has already been EMITTED for this
        // row (not against its current total), so cost never double counts.
        const costDelta = prev && measuredCost !== null ? Math.max(0, round6(measuredCost - (prev.c || 0))) : measuredCost;

        // Remember what this row accounts for. The emission index keeps each
        // delta's record id distinct and stable across runs.
        const emissionIndex = prev ? (prev.n || 0) : 0;
        tails[key] = { ls: lastSeen ?? (prev?.ls || 0), f: { ...base }, c: measuredCost, n: emissionIndex + 1 };
        records++;

        const model = str(r.model);
        const firstSeen = secToMs(r.first_seen);
        if (firstSeen === null && lastSeen === null) { skipped++; records--; delete tails[key]; continue; }

        // billing_provider is the routing layer — unless it IS the vendor
        // ("anthropic" billing for a claude model is a direct call, not a
        // gateway). Classify with the same rules the engine will use so the
        // two never disagree.
        const billing = str(r.billing_provider)?.toLowerCase() || null;
        const vendor = classifyModel(model && model !== 'default' ? model : null, { rules: ctx.rules }).provider;
        const gateway = billing && billing !== vendor ? billing : null;

        const project = projectOf(r.git_repo_root || r.cwd);
        const startedAt = secToMs(r.started_at);
        const endedAt = secToMs(r.ended_at);

        emit({
          id: hashId('hermes', key, '#', emissionIndex),
          // Base emissions sit at the group's first API call; a delta lands at
          // the last_seen that revealed it, which is when that usage happened.
          timestamp: new Date((prev ? lastSeen : firstSeen) ?? lastSeen ?? firstSeen).toISOString(),
          model: model && model !== 'default' ? model : null,
          gateway,
          ...pick(delta),
          measured_cost: costDelta,
          session_id: str(r.session_id),
          conversation_id: str(r.session_id),
          request_id: `${key}#${emissionIndex}`,
          project,
          repository: project,
          git_branch: str(r.git_branch),
          category: r.parent_session_id ? 'subagent' : (str(r.task) || 'main'),
          client: 'hermes',
          application: 'Hermes',
          interfaceSignals: [str(r.source)],
          duration_ms: startedAt !== null && endedAt !== null && endedAt >= startedAt ? Math.round(endedAt - startedAt) : null,
          metadata: {
            title: str(r.title),
            source: str(r.source),
            hermes_task: str(r.task),
            api_calls: intOrNull(r.api_call_count),
            billing_provider: str(r.billing_provider),
            cost_status: str(r.cost_status),
            session_open: r.ended_at === null || r.ended_at === undefined ? true : undefined,
            ...(prev ? { continuation_of: key } : {}),
          },
        });
      }

      // Bound the tail state: anything this far behind the watermark cannot
      // reappear inside the overlap window, so its emitted totals are final.
      const floor = watermark - TAIL_TTL_MS;
      for (const k of Object.keys(tails)) if ((tails[k].ls || 0) < floor) delete tails[k];

      cursor.seen = watermark;
      sourceState.cursor = cursor;
    } finally {
      db.close();
    }
    return { records, cursor: sourceState.cursor, notes };
  },
});

function pick(delta) {
  const out = {};
  for (const k of FIELDS) out[k] = delta[k];
  return out;
}

/** REAL seconds in, epoch milliseconds out. */
function secToMs(v) {
  if (v === null || v === undefined) return null;
  const ms = Number(v) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function projectOf(dir) {
  if (!dir) return null;
  const parts = String(dir).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function shortPath(p, ctx) {
  const home = ctx?.home || os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function intOrNull(v) {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function str(v) {
  return v === undefined || v === null || v === '' ? null : String(v);
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

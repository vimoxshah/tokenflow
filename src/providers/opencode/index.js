/**
 * OpenCode — opencode session/message database.
 *
 * Source: <data-home>/opencode/opencode.db  (SQLite; $XDG_DATA_HOME-aware,
 * so ~/.local/share/opencode/opencode.db by default). Read-only, via
 * node:sqlite, read from a snapshot like every SQLite adapter here.
 *
 * ## What this source is
 *
 * One row per message in `message`, with a JSON `data` column. Assistant rows
 * carry the usage block the provider returned:
 *
 *     data.tokens = { input, output, reasoning, cache: { read, write }, total }
 *     data.modelID / data.providerID / data.cost / data.time.{created,completed}
 *
 * The `session` table adds directory, agent and parent (subagent) links; the
 * `project` table adds the worktree.
 *
 * ## Token semantics (verified against a live corpus)
 *
 *   input        fresh prompt tokens, EXCLUSIVE of cache reads. Confirmed
 *                empirically: cache_read regularly exceeds input on long
 *                sessions, which is impossible under an inclusive convention,
 *                and data.tokens.total == input+output+reasoning+read+write
 *                exactly, i.e. the fields are disjoint addends.
 *   output       generated tokens. `reasoning` is USUALLY a subset of output
 *                (OpenAI/Anthropic convention) but some providers behind the
 *                gateway report it additively — 5% of a real corpus had
 *                reasoning > output. Where that happens the only reading that
 *                satisfies the schema's subset invariant without losing tokens
 *                is output += reasoning, with reasoning kept as the subset.
 *   cache.read   -> cache_read_tokens
 *   cache.write  -> cache_write_tokens
 *
 * ## The incremental trap: rows are UPDATED in place
 *
 * An assistant row is inserted when the request starts and its tokens are
 * revised as the response finalises — on a real corpus every single
 * token-bearing row had time_updated != time_created. A naive
 * "time_created > cursor" cursor would freeze the first, partial snapshot
 * forever. So this adapter uses the same tails mechanism as the Anthropic
 * adapter: re-read a recent window ordered by time_updated, remember per
 * message what has already been emitted, and emit only the DELTA when a
 * message's totals grew. Each emission carries the message's own
 * time.created, so usage stays attributed to the request that produced it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT, hashId } from '../../core/schema.js';
import { openReadOnly, sqliteAvailable } from '../../core/sqlite.js';

const ROW_CAP = 500000;
/** How far behind the watermark to re-read, to catch in-place updates. */
const OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
/** Emitted-tail entries older than this, relative to the watermark, are pruned. */
const TAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];

/** providerID values that ARE the model vendor; anything else routes through a gateway. */
const VENDORS = new Set([
  'anthropic', 'openai', 'google', 'gemini', 'deepseek', 'xai', 'groq',
  'mistral', 'azure', 'bedrock', 'vertex', 'ollama', 'amazon', 'moonshot',
  'alibaba', 'qwen', 'zai', 'github-copilot',
]);

export function dbPath(ctx) {
  const c = ctx?.config?.sources?.opencode;
  const p = c?.db || (Array.isArray(c?.paths) ? c.paths[0] : null);
  if (p) return expand(p);
  const dataHome = process.env.XDG_DATA_HOME || path.join(ctx?.home || os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export default createProvider({
  id: 'opencode',
  name: 'OpenCode',
  description: 'Per-request token usage from the opencode message database.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['~/.local/share/opencode/opencode.db', 'Node 22.5+ (node:sqlite)'],

  async detect(ctx) {
    if (!sqliteAvailable()) return { available: false, detail: 'node:sqlite unavailable — needs Node 22.5+' };
    const f = dbPath(ctx);
    if (!fs.existsSync(f)) {
      return { available: false, detail: 'No opencode.db found (looked in $XDG_DATA_HOME/opencode)' };
    }
    return { available: true, detail: shortPath(f, ctx), paths: [f] };
  },

  async fetchUsage(ctx, emit, sourceState) {
    const f = dbPath(ctx);
    const db = openReadOnly(f);
    let records = 0;
    let skipped = 0;
    let updated = 0;
    const notes = [];

    try {
      const cursor = sourceState.cursor || { updated: 0 };
      // Tails: per-message totals already emitted. Keyed by message id, they
      // make re-reading the overlap window idempotent (delta 0 => no record).
      const tails = sourceState.tails || (sourceState.tails = {});

      const rows = db.prepare(
        `SELECT m.id AS msg_id, m.session_id AS session_id, m.time_created AS time_created,
                m.time_updated AS time_updated, m.data AS data,
                s.directory AS directory, s.parent_id AS parent_id, s.agent AS agent,
                s.version AS cli_version, p.worktree AS worktree
           FROM message m
           LEFT JOIN session s ON s.id = m.session_id
           LEFT JOIN project p ON p.id = s.project_id
          WHERE json_extract(m.data,'$.role') = 'assistant'
            AND json_extract(m.data,'$.tokens') IS NOT NULL
            AND m.time_updated > ?
          ORDER BY m.time_updated ASC
          LIMIT ?`,
      ).all(Math.max(0, (cursor.updated || 0) - OVERLAP_MS), ROW_CAP);
      if (rows.length === ROW_CAP) notes.push('row cap hit — run refresh again to continue');

      let watermark = cursor.updated || 0;

      for (const r of rows) {
        watermark = Math.max(watermark, Number(r.time_updated) || 0);
        let d;
        try { d = JSON.parse(r.data); } catch { continue; }
        const t = d.tokens || {};
        const created = Number(r.time_created);
        if (!created) continue;

        const base = {
          input_tokens: n(t.input),
          output_tokens: n(t.output),
          cache_read_tokens: n(t.cache?.read),
          cache_write_tokens: n(t.cache?.write),
          reasoning_tokens: n(t.reasoning),
        };
        // Some providers report reasoning additively rather than as a subset
        // of output. Folding keeps the subset invariant without losing tokens.
        if (base.reasoning_tokens !== null && base.output_tokens !== null && base.reasoning_tokens > base.output_tokens) {
          base.output_tokens += base.reasoning_tokens;
        }

        // An assistant row with no counts at all is an aborted request, not a
        // zero-cost API call. Skip it; if tokens arrive later the row's
        // time_updated advances and the next pass picks it up fresh.
        if (FIELDS.every((k) => !base[k])) { skipped++; continue; }

        const key = String(r.msg_id || `${r.session_id}:${created}`);
        const prev = tails[key];
        const delta = {};
        let any = false;
        for (const k of FIELDS) {
          const was = prev ? (prev.f[k] ?? 0) : 0;
          const now = base[k] ?? 0;
          delta[k] = Math.max(0, now - was);
          if (delta[k] > 0) any = true;
        }
        // Remember what this message accounts for, whether or not it grew —
        // an unchanged re-read must stay a no-op forever. The emission index
        // keeps each delta's record id distinct and stable across runs.
        const emissionIndex = prev ? (prev.n || 0) : 0;
        tails[key] = { u: Number(r.time_updated) || created, f: { ...base }, n: emissionIndex + 1 };
        if (prev && !any) continue;
        updated++;

        const providerID = str(d.providerID)?.toLowerCase() || null;
        const isVendor = providerID && VENDORS.has(providerID);
        const project = projectOf(r.worktree || r.directory);
        const completed = n(d.time?.completed);

        emit({
          id: hashId('opencode', key, '#', emissionIndex),
          timestamp: new Date(created).toISOString(),
          model: str(d.modelID),
          gateway: providerID && !isVendor ? providerID : null,
          ...pick(delta),
          session_id: r.session_id || null,
          conversation_id: r.session_id || null,
          request_id: r.msg_id || null,
          project,
          repository: project,
          category: r.parent_id ? 'subagent' : (str(r.agent) || 'main'),
          client: 'opencode',
          application: 'OpenCode',
          interfaceSignals: [],
          duration_ms: completed !== null && completed >= created ? completed - created : null,
          metadata: {
            cwd: str(r.directory),
            provider_id: providerID,
            mode: str(d.mode),
            agent: str(r.agent),
            finish: str(d.finish),
            cli_version: str(r.cli_version),
            reported_total: n(t.total),
            ...(prev ? { continuation_of: key } : {}),
          },
        });
        records++;
      }

      // Bound the tail state: anything this far behind the watermark cannot
      // reappear inside the overlap window, so its emitted totals are final.
      const floor = watermark - TAIL_TTL_MS;
      for (const k of Object.keys(tails)) if ((tails[k].u || 0) < floor) delete tails[k];

      cursor.updated = watermark;
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

function projectOf(dir) {
  if (!dir) return null;
  const parts = String(dir).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function shortPath(p, ctx) {
  const home = ctx?.home || os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function n(v) {
  return v === undefined || v === null ? null : Number(v);
}

function str(v) {
  return v === undefined || v === null || v === '' ? null : String(v);
}

/**
 * Anthropic — Claude Code / Claude Agent SDK session transcripts.
 *
 * Source: <claude-home>/projects/<slugified-cwd>/<sessionId>.jsonl
 * Homes are auto-discovered: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.config/claude,
 * and any ~/.claude-* sibling that contains a `projects/` directory (people
 * who run several accounts keep them side by side).
 *
 * ## Two correctness traps this adapter exists to handle
 *
 * 1. **Streaming snapshots.** A single assistant message is written to the
 *    transcript several times as it streams. Every line carries the SAME
 *    `requestId` + `message.id` and a *growing* `output_tokens`, with input and
 *    cache counts constant. Summing them inflates output by 3-5x. The correct
 *    value is the final snapshot, so we group by (requestId, message.id) and
 *    keep the per-field maximum.
 *
 *    A group can straddle the end of the file, because a live session is still
 *    being written. Rather than defer it (which would silently drop the last
 *    record of every settled file, forever), the group is emitted at EOF and
 *    its emitted totals are remembered as that file's `tails`. If the file
 *    later grows and the same (requestId, message.id) reappears with larger
 *    counts, only the DELTA is emitted. So the record is complete, never
 *    duplicated, and never double counted.
 *
 * 2. **Synthetic messages.** Locally generated assistant entries have
 *    `requestId: null` and an all-zero usage block. They are not API calls;
 *    counting them would add fake zero-token requests and skew "requests" and
 *    "tokens per request". They are skipped and counted separately.
 *
 * Token semantics (already the exclusive convention the schema wants):
 *   input_tokens                 fresh prompt tokens, EXCLUDING cache
 *   cache_read_input_tokens      -> cache_read_tokens
 *   cache_creation_input_tokens  -> cache_write_tokens
 *   cache_creation.ephemeral_1h  -> cache_refresh_tokens (subset of writes)
 *   output_tokens_details.thinking_tokens -> reasoning_tokens (subset of output)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { readLines } from '../../core/jsonl.js';
import { walk } from '../../core/ingest.js';
import { MEASUREMENT } from '../../core/schema.js';

const USAGE_MARK = '"usage"';
/** Groups this far behind the read head cannot still be open. */
const GROUP_FLUSH_LAG = 2 << 20;

export function candidateHomes(ctx) {
  const configured = ctx?.config?.sources?.anthropic?.paths;
  if (Array.isArray(configured) && configured.length) return configured.map(expand);
  const home = ctx?.home || os.homedir();
  const out = [];
  if (process.env.CLAUDE_CONFIG_DIR) out.push(...process.env.CLAUDE_CONFIG_DIR.split(path.delimiter));
  out.push(path.join(home, '.claude'), path.join(home, '.config', 'claude'));
  // Sibling homes: ~/.claude-work, ~/.claude-personal, ...
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (!/^\.claude([-.].+)?$/.test(e.name)) continue;
      out.push(path.join(home, e.name));
    }
  } catch { /* home unreadable: fall through to the explicit list */ }
  return [...new Set(out)].filter((d) => {
    try {
      return fs.statSync(path.join(d, 'projects')).isDirectory();
    } catch {
      return false;
    }
  });
}

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** "-Users-me-projects-checkout-api" -> "checkout-api" */
export function projectFromSlug(slug, cwd) {
  const base = cwd || slug.replace(/^-/, '/').replace(/-/g, '/');
  const parts = String(cwd || base).split('/').filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  // A temp dir tells us nothing useful about the project.
  if (/^(T|tmp|temp)$/i.test(last) && parts.length > 1) return parts[parts.length - 2];
  return last;
}

export default createProvider({
  id: 'anthropic',
  name: 'Anthropic (Claude Code / Agent SDK)',
  description: 'Per-request token usage from Claude Code and Claude Agent SDK session transcripts.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['A Claude Code home directory with a projects/ folder'],

  async detect(ctx) {
    const homes = candidateHomes(ctx);
    if (!homes.length) {
      return { available: false, detail: 'No Claude Code home found (looked for ~/.claude*/projects)' };
    }
    return {
      available: true,
      detail: homes.map((h) => shortHome(h, ctx)).join(', '),
      paths: homes,
    };
  },

  async discover(ctx) {
    const files = [];
    for (const home of candidateHomes(ctx)) {
      const label = path.basename(home);
      const root = path.join(home, 'projects');
      for (const f of walk(root, (n) => n.endsWith('.jsonl'))) {
        let stat;
        try { stat = fs.statSync(f); } catch { continue; }
        if (!stat.size) continue;
        files.push({ key: `${label}:${path.relative(root, f)}`, path: f, stat, home, label });
      }
    }
    return files;
  },

  async ingestFile(ref, ctx, emit) {
    /** @type {Map<string, {rec:object, start:number}>} */
    const open = new Map();
    /** Totals already emitted for a group that straddled a previous EOF. */
    const tails = ref.state.tails || {};
    let records = 0;
    let malformed = 0;
    let synthetic = 0;

    const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_refresh_tokens', 'reasoning_tokens'];

    /**
     * Emit a group.
     *
     * One logical message can be split across two flushes: once because it fell
     * far behind the read head, once at EOF. `carried` holds the absolute totals
     * already emitted for a key, so a reappearance emits only the delta and the
     * two halves sum to the true maximum rather than to their sum.
     */
    const carried = { ...tails };
    const flush = (key, remember = false) => {
      const g = open.get(key);
      if (!g) return;
      open.delete(key);
      const rec = g.rec;
      const base = carried[key];

      const absolute = {};
      for (const f of FIELDS) {
        const prev = base ? (base[f] ?? 0) : 0;
        absolute[f] = rec[f] === null ? prev : Math.max(prev, rec[f]);
      }
      if (remember) carried[key] = absolute;

      if (base) {
        let any = false;
        for (const f of FIELDS) {
          if (rec[f] === null) continue;
          rec[f] = Math.max(0, rec[f] - (base[f] ?? 0));
          if (rec[f] > 0) any = true;
        }
        rec.metadata = { ...rec.metadata, continuation_of: key };
        if (!any) return; // nothing new in this group
      }
      emit(rec);
      records++;
    };

    const res = readLines(
      ref.path,
      (line, offsetAfter) => {
        const lineStart = offsetAfter - Buffer.byteLength(line) - 1;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          malformed++;
          return;
        }
        if (d.type !== 'assistant') return;
        const msg = d.message;
        const u = msg && msg.usage;
        if (!u) return;

        const inTok = n(u.input_tokens);
        const outTok = n(u.output_tokens);
        const crTok = n(u.cache_read_input_tokens);
        const cwTok = n(u.cache_creation_input_tokens);

        // Synthetic / locally generated entry: no API call happened. Claude Code
        // marks these either by omitting requestId with an all-zero usage block,
        // or by naming the model `<synthetic>` outright.
        if (msg.model === '<synthetic>' || (!d.requestId && !inTok && !outTok && !crTok && !cwTok)) {
          synthetic++;
          return;
        }

        const key = `${d.requestId || 'na'}|${msg.id || d.uuid}`;
        const cwd = d.cwd || null;
        const partial = {
          timestamp: d.timestamp,
          model: msg.model || null,
          input_tokens: inTok,
          output_tokens: outTok,
          cache_read_tokens: crTok,
          cache_write_tokens: cwTok,
          cache_refresh_tokens: u.cache_creation ? n(u.cache_creation.ephemeral_1h_input_tokens) : null,
          reasoning_tokens: u.output_tokens_details ? n(u.output_tokens_details.thinking_tokens) : null,
          session_id: d.sessionId || null,
          conversation_id: d.sessionId || null,
          request_id: d.requestId || null,
          project: projectFromSlug(ref.key, cwd),
          repository: projectFromSlug(ref.key, cwd),
          git_branch: d.gitBranch || null,
          category: d.isSidechain ? 'subagent' : 'main',
          client: 'claude-code',
          application: 'Claude Code',
          interfaceSignals: [d.entrypoint, d.userType === 'external' ? null : d.userType],
          metadata: {
            cwd,
            version: d.version || null,
            entrypoint: d.entrypoint || null,
            service_tier: u.service_tier ?? null,
            speed: u.speed ?? null,
            stop_reason: msg.stop_reason ?? null,
            sidechain: !!d.isSidechain,
            home: ref.label,
            cache_write_5m: u.cache_creation ? n(u.cache_creation.ephemeral_5m_input_tokens) : null,
            web_search_requests: u.server_tool_use ? n(u.server_tool_use.web_search_requests) : null,
            web_fetch_requests: u.server_tool_use ? n(u.server_tool_use.web_fetch_requests) : null,
          },
        };

        const g = open.get(key);
        if (!g) {
          open.set(key, { rec: partial, start: lineStart });
        } else {
          // Keep the largest snapshot of every field; output grows as it streams.
          const r = g.rec;
          r.output_tokens = maxN(r.output_tokens, partial.output_tokens);
          r.input_tokens = maxN(r.input_tokens, partial.input_tokens);
          r.cache_read_tokens = maxN(r.cache_read_tokens, partial.cache_read_tokens);
          r.cache_write_tokens = maxN(r.cache_write_tokens, partial.cache_write_tokens);
          r.cache_refresh_tokens = maxN(r.cache_refresh_tokens, partial.cache_refresh_tokens);
          r.reasoning_tokens = maxN(r.reasoning_tokens, partial.reasoning_tokens);
          r.timestamp = partial.timestamp || r.timestamp;
          r.metadata.stop_reason = partial.metadata.stop_reason ?? r.metadata.stop_reason;
        }

        // Anything far enough behind the read head is provably finished.
        for (const [k, v] of open) {
          // Far enough behind the read head that it is almost certainly done —
          // but remember it, in case a sidechain interleaves it back in.
          if (k !== key && offsetAfter - v.start > GROUP_FLUSH_LAG) flush(k, true);
        }
      },
      { start: ref.start, must: [USAGE_MARK] },
    );

    // Emit whatever is still open, and remember what we emitted for each of
    // those groups. If the file grows and one of them continues, only the
    // delta will be emitted next time (see `flush`).
    // Only groups still open at EOF can continue in a later append, so only
    // those are worth persisting. Groups flushed mid-read are finished.
    const openKeys = [...open.keys()];
    for (const key of openKeys) flush(key, true);
    const nextTails = {};
    for (const key of openKeys) if (carried[key]) nextTails[key] = carried[key];
    ref.state.tails = nextTails;

    return {
      offset: res.offset,
      records,
      malformed,
      openAtEof: openKeys.length,
      synthetic,
    };
  },
});

function shortHome(h, ctx) {
  const home = ctx?.home || os.homedir();
  return h.startsWith(home) ? '~' + h.slice(home.length) : h;
}
function n(v) {
  return v === undefined || v === null ? null : Number(v);
}
function maxN(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

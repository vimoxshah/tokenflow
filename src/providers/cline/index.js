/**
 * Cline CLI — session records.
 *
 * Cline's session files record which provider/model was used and when, but
 * they contain **no token accounting at all**. That is exactly the case the
 * schema's missing-value contract exists for: every token field is `null`
 * ("the source does not report this"), the record is marked
 * `measurement: activity`, and the dashboard counts these sessions in activity
 * metrics while explicitly excluding them from token totals — rather than
 * quietly adding a session's worth of zeros and dragging every average down.
 *
 * Source: ~/.cline/data/sessions/<id>/<id>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT } from '../../core/schema.js';

function root(ctx) {
  const configured = ctx?.config?.sources?.cline?.path;
  if (configured) return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
  return path.join(ctx?.home || os.homedir(), '.cline', 'data', 'sessions');
}

export default createProvider({
  id: 'cline',
  name: 'Cline CLI',
  description: 'Session-level AI activity (model, provider, duration). Cline does not log token counts.',
  measurement: MEASUREMENT.ACTIVITY,
  requires: ['~/.cline/data/sessions'],

  async detect(ctx) {
    const d = root(ctx);
    try {
      const n = fs.readdirSync(d).length;
      return { available: n > 0, detail: `${n} session directories · no token fields reported by this source`, paths: [d] };
    } catch {
      return { available: false, detail: 'No ~/.cline/data/sessions directory found' };
    }
  },

  async discover(ctx) {
    const d = root(ctx);
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of dirs) {
      if (!e.isDirectory()) continue;
      const f = path.join(d, e.name, `${e.name}.json`);
      let stat;
      try { stat = fs.statSync(f); } catch { continue; }
      out.push({ key: e.name, path: f, stat });
    }
    return out;
  },

  async ingestFile(ref, ctx, emit) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(ref.path, 'utf8'));
    } catch (err) {
      return { offset: ref.stat.size, records: 0, malformed: 1 };
    }
    const ts = d.started_at || d.ended_at;
    if (!ts) return { offset: ref.stat.size, records: 0 };

    const project = d.workspace_root || d.cwd ? path.basename(d.workspace_root || d.cwd) : null;
    const git = d.metadata?.git || {};
    const messages = countMessages(ref.path.replace(/\.json$/, '.messages.json'));

    emit({
      timestamp: ts,
      model: d.model || null,
      // `provider: "cline"` in the file names the *client*, not the model
      // vendor — the vendor is derived from the model string.
      client: 'cline',
      application: 'Cline CLI',
      interfaceSignals: [d.source, d.interactive ? 'cli' : null],
      // Every token field stays null: not available, not zero.
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cache_refresh_tokens: null,
      reasoning_tokens: null,
      session_id: d.session_id || ref.key,
      project,
      repository: git.repo || project,
      git_branch: git.branch || null,
      category: d.status || null,
      duration_ms: d.started_at && d.ended_at ? new Date(d.ended_at).getTime() - new Date(d.started_at).getTime() : null,
      measurement: MEASUREMENT.ACTIVITY,
      metadata: {
        cwd: d.workspace_root || d.cwd || null,
        status: d.status ?? null,
        exit_code: d.exit_code ?? null,
        team: d.team_name ?? null,
        agent_messages: messages.assistant,
        total_messages: messages.total,
        tokens_reported: false,
      },
    });
    return { offset: ref.stat.size, records: 1 };
  },
});

function countMessages(f) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    return { total: msgs.length, assistant: msgs.filter((m) => m.role === 'assistant').length };
  } catch {
    return { total: null, assistant: null };
  }
}

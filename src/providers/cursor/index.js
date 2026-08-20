/**
 * Cursor — AI code-authorship tracking database.
 *
 * Cursor does not expose token counts locally, but it does record what the AI
 * actually *did*: every AI-authored code hash (with model, file, and
 * conversation) and per-commit authorship attribution (AI vs human lines).
 *
 * That makes it the productivity-correlation source: it measures work output,
 * which is the thing token counts are so often wrongly assumed to prove. These
 * records are `measurement: activity` with all token fields null, so they can
 * never leak into a token total.
 *
 * Source: ~/.cursor/ai-tracking/ai-code-tracking.db  (read-only, via node:sqlite)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT } from '../../core/schema.js';
import { openReadOnly } from '../../core/sqlite.js';

function dbPath(ctx) {
  const c = ctx?.config?.sources?.cursor?.db;
  if (c) return c.startsWith('~') ? path.join(os.homedir(), c.slice(1)) : c;
  return path.join(ctx?.home || os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

export default createProvider({
  id: 'cursor',
  name: 'Cursor (AI code activity)',
  description: 'AI-authored edits and per-commit AI/human line attribution. Activity only — Cursor does not log tokens locally.',
  measurement: MEASUREMENT.ACTIVITY,
  requires: ['~/.cursor/ai-tracking/ai-code-tracking.db', 'Node 22.5+ (node:sqlite)'],

  async detect(ctx) {
    const f = dbPath(ctx);
    if (!fs.existsSync(f)) return { available: false, detail: 'No Cursor ai-code-tracking.db found' };
    return { available: true, detail: 'activity source — AI-authored edits + commit attribution', paths: [f] };
  },

  async fetchUsage(ctx, emit, sourceState) {
    const f = dbPath(ctx);
    const db = openReadOnly(f);
    let records = 0;
    const notes = [];
    const cursor = sourceState?.cursor || { edits: 0, commits: 0 };

    try {
      const edits = db.prepare(
        `SELECT hash, source, fileExtension, fileName, requestId, conversationId, timestamp, createdAt, model
           FROM ai_code_hashes WHERE createdAt > ? ORDER BY createdAt ASC LIMIT 200000`,
      ).all(cursor.edits || 0);

      for (const r of edits) {
        const ts = r.timestamp || r.createdAt;
        if (!ts) continue;
        const project = projectOf(r.fileName);
        emit({
          id: `cursor-edit-${r.hash}-${r.createdAt}`,
          timestamp: new Date(Number(ts)).toISOString(),
          // `default` / null are Cursor's own placeholders; do not guess a model.
          model: r.model && r.model !== 'default' ? r.model : null,
          providerHint: null,
          client: 'cursor',
          application: 'Cursor',
          interfaceSignals: ['cursor'],
          input_tokens: null, output_tokens: null, cache_read_tokens: null,
          cache_write_tokens: null, cache_refresh_tokens: null, reasoning_tokens: null,
          conversation_id: r.conversationId || null,
          session_id: r.conversationId || null,
          request_id: r.requestId || null,
          project,
          repository: project,
          category: `ai-edit:${r.source || 'unknown'}`,
          measurement: MEASUREMENT.ACTIVITY,
          metadata: {
            file: r.fileName || null,
            ext: r.fileExtension || null,
            attribution_source: r.source || null,
            tokens_reported: false,
          },
        });
        records++;
        cursor.edits = Math.max(cursor.edits || 0, Number(r.createdAt));
      }

      const commits = db.prepare(
        `SELECT commitHash, branchName, scoredAt, commitDate, commitMessage, linesAdded, linesDeleted,
                composerLinesAdded, tabLinesAdded, humanLinesAdded, v2AiPercentage
           FROM scored_commits WHERE scoredAt > ? ORDER BY scoredAt ASC LIMIT 100000`,
      ).all(cursor.commits || 0);

      for (const r of commits) {
        const ts = r.commitDate ? Date.parse(r.commitDate) : Number(r.scoredAt);
        if (!ts || Number.isNaN(ts)) continue;
        emit({
          id: `cursor-commit-${r.commitHash}-${r.branchName}`,
          timestamp: new Date(ts).toISOString(),
          model: null,
          client: 'cursor',
          application: 'Cursor',
          interfaceSignals: ['cursor'],
          input_tokens: null, output_tokens: null, cache_read_tokens: null,
          cache_write_tokens: null, cache_refresh_tokens: null, reasoning_tokens: null,
          git_branch: r.branchName || null,
          category: 'commit',
          measurement: MEASUREMENT.ACTIVITY,
          metadata: {
            commit: r.commitHash,
            message: r.commitMessage || null,
            lines_added: nOrNull(r.linesAdded),
            lines_deleted: nOrNull(r.linesDeleted),
            ai_lines_added: nOrNull(r.composerLinesAdded),
            tab_lines_added: nOrNull(r.tabLinesAdded),
            human_lines_added: nOrNull(r.humanLinesAdded),
            ai_percentage: r.v2AiPercentage === null || r.v2AiPercentage === undefined ? null : Number(r.v2AiPercentage),
            tokens_reported: false,
          },
        });
        records++;
        cursor.commits = Math.max(cursor.commits || 0, Number(r.scoredAt));
      }
      if (edits.length === 200000) notes.push('edit batch hit the 200k row cap — run refresh again to continue');
    } finally {
      db.close();
    }
    return { records, cursor, notes };
  },
});

function projectOf(file) {
  if (!file) return null;
  const parts = String(file).split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'projects' || p === 'repos' || p === 'src' || p === 'work');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return parts.length > 1 ? parts[parts.length - 2] : null;
}
function nOrNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

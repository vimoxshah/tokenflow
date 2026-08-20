/**
 * Git activity — the correlation source.
 *
 * Emits one `activity` record per commit (files changed, insertions,
 * deletions) so the Productivity section can put AI usage next to actual
 * shipped work. It never claims causation: the analytics layer labels these
 * relationships as correlations and refuses to compute one at all when the
 * two series don't overlap in time.
 *
 * Repositories come from, in order:
 *   1. config `sources.git.repos: [ ... ]`
 *   2. config `sources.git.scanRoots: [ ... ]` (searched for .git, depth 3)
 *   3. `sources.git.autoFromUsage: true` — the working directories already
 *      observed in ingested usage records, which means zero configuration for
 *      the common case where you code where you prompt
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT } from '../../core/schema.js';
import { paths } from '../../core/config.js';
import { readJson } from '../../core/store.js';

const SEP = '';

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function resolveRepos(ctx) {
  const cfg = ctx?.config?.sources?.git || {};
  const out = new Set();
  for (const r of cfg.repos || []) if (isRepo(expand(r))) out.add(expand(r));
  for (const root of cfg.scanRoots || []) {
    for (const r of scan(expand(root), 3)) out.add(r);
  }
  if (cfg.autoFromUsage !== false) {
    const known = readJson(path.join(paths().data, 'project-paths.json'), { paths: [] });
    for (const p of known.paths || []) {
      const r = repoRoot(p);
      if (r) out.add(r);
    }
  }
  return [...out];
}

function isRepo(d) {
  try {
    return fs.statSync(path.join(d, '.git')).isDirectory() || fs.statSync(path.join(d, '.git')).isFile();
  } catch {
    return false;
  }
}

function repoRoot(p) {
  let d = p;
  for (let i = 0; i < 8 && d && d !== '/'; i++) {
    if (isRepo(d)) return d;
    d = path.dirname(d);
  }
  return null;
}

function scan(root, depth) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [d, lvl] = stack.pop();
    if (lvl > depth) continue;
    if (isRepo(d)) { out.push(d); continue; }
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push([path.join(d, e.name), lvl + 1]);
    }
  }
  return out;
}

export default createProvider({
  id: 'git',
  name: 'Git activity (correlation)',
  description: 'Commits, files changed and line churn per repository. Activity only — used to correlate AI usage with shipped work.',
  measurement: MEASUREMENT.ACTIVITY,
  requires: ['git on PATH', 'at least one repository configured or discoverable'],

  async detect(ctx) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      return { available: false, detail: 'git is not on PATH' };
    }
    const repos = resolveRepos(ctx);
    if (!repos.length) {
      return {
        available: false,
        detail: 'no repositories found — set sources.git.repos or sources.git.scanRoots in config.yaml',
      };
    }
    return { available: true, detail: `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`, paths: repos };
  },

  async fetchUsage(ctx, emit, sourceState) {
    const repos = resolveRepos(ctx);
    const cursor = sourceState?.cursor || {};
    const author = ctx.config?.sources?.git?.author || null;
    let records = 0;
    const notes = [];

    for (const repo of repos) {
      const name = path.basename(repo);
      const since = cursor[repo] || ctx.config?.sources?.git?.since || null;
      const args = [
        '-C', repo, 'log', '--no-merges', '--numstat', '--date=iso-strict',
        `--pretty=format:C${SEP}%H${SEP}%aI${SEP}%an${SEP}%ae${SEP}%D${SEP}%s`,
      ];
      if (since) args.push(`--since=${since}`);
      if (author) args.push(`--author=${author}`);
      let out;
      try {
        out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      } catch (err) {
        notes.push(`${name}: ${String(err.message).split('\n')[0]}`);
        continue;
      }
      let cur = null;
      let newest = since;
      const flush = () => {
        if (!cur) return;
        emit({
          id: `git-${cur.hash}`,
          timestamp: cur.date,
          model: null,
          client: 'git',
          application: 'Git',
          interface: 'CLI',
          input_tokens: null, output_tokens: null, cache_read_tokens: null,
          cache_write_tokens: null, cache_refresh_tokens: null, reasoning_tokens: null,
          project: name,
          repository: name,
          git_branch: cur.branch || null,
          category: 'commit',
          measurement: MEASUREMENT.ACTIVITY,
          metadata: {
            commit: cur.hash,
            message: cur.subject,
            author: cur.author,
            files_changed: cur.files,
            insertions: cur.ins,
            deletions: cur.del,
            repo_path: repo,
            tokens_reported: false,
          },
        });
        records++;
        cur = null;
      };
      for (const line of out.split('\n')) {
        if (line.startsWith('C' + SEP)) {
          flush();
          const [, hash, date, an, ae, refs, subject] = line.split(SEP);
          cur = { hash, date, author: an, email: ae, branch: parseRefs(refs), subject: subject || '', files: 0, ins: 0, del: 0 };
          if (!newest || date > newest) newest = date;
          continue;
        }
        if (!cur || !line.trim()) continue;
        const m = line.split('\t');
        if (m.length < 3) continue;
        cur.files++;
        if (m[0] !== '-') cur.ins += Number(m[0]) || 0;
        if (m[1] !== '-') cur.del += Number(m[1]) || 0;
      }
      flush();
      if (newest) cursor[repo] = newest;
    }
    return { records, cursor, notes };
  },
});

function parseRefs(refs) {
  if (!refs) return null;
  const m = refs.match(/HEAD -> ([^,]+)/);
  if (m) return m[1].trim();
  const first = refs.split(',')[0].trim();
  return first && !first.startsWith('tag:') ? first : null;
}

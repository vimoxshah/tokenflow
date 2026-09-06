/**
 * Repository identity from a working directory, seeing through git worktrees.
 *
 * The adapters record `project` as the basename of the working directory, so a
 * session in `<repo>/.worktrees/<x>` is filed under `x` and one repository's
 * spend is split across every worktree it ever had. Walking up from the cwd
 * to `.git` and following a worktree's `gitdir:` pointer back to the main
 * checkout puts them back together. No subprocess, no network; results are
 * cached per cwd because a store holds thousands of distinct ones.
 *
 * `src/core/ingest.js` applies `repoRootOf` at ingest time too, not only when
 * a receipt is built later: `project`/`repository` are corrected to the
 * resolved repo name as each record is normalized, and `metadata.repoResolved`
 * records whether a root was found, so a record's stored fields already carry
 * the correction rather than needing every reader to redo this walk.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} cwd
 * @param {Map<string,string|null>} [cache]
 * @returns {string|null} the main checkout's root, or null when no `.git` is found above `cwd`
 */
export function repoRootOf(cwd, cache = new Map()) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  let d = cwd;
  let out = null;
  for (let i = 0; i < 12 && d && d !== path.dirname(d); i++) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* not here; keep walking up */ }
    if (st) {
      if (st.isDirectory()) { out = d; break; }
      // A worktree: `.git` is a file "gitdir: /main/checkout/.git/worktrees/<name>"
      let txt = '';
      try { txt = fs.readFileSync(g, 'utf8'); } catch { /* unreadable; fall back to this dir */ }
      const m = /gitdir:\s*(.+)\s*$/m.exec(txt);
      if (m) {
        const gitdir = path.resolve(d, m[1].trim());
        const wt = gitdir.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        out = wt > -1 ? gitdir.slice(0, wt) : d;
      } else {
        out = d;
      }
      break;
    }
    d = path.dirname(d);
  }
  cache.set(cwd, out);
  return out;
}

/** A resolver for the receipt builder: repository name from the recorded cwd, else what the adapter said. */
export function makeRepoResolver() {
  const cache = new Map();
  return (rec) => {
    const cwd = rec.metadata && rec.metadata.cwd;
    const root = cwd ? repoRootOf(cwd, cache) : null;
    if (root) return path.basename(root);
    return rec.repository || rec.project || null;
  };
}

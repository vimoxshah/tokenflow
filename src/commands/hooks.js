/**
 * `tokenflow hooks` — a pre-push git hook that attaches a TokenFlow receipt
 * to the commit being pushed, as a git note, with no server involved.
 *
 *   tokenflow hooks install                  write .git/hooks/pre-push
 *   tokenflow hooks uninstall                 remove it, restoring anything it replaced
 *   tokenflow hooks status                    installed? chained? where?
 *   tokenflow hooks pre-push <remote> <url>    the hook body (reads stdin)
 *
 * `pre-push` is never invoked by a person: it is what the installed script
 * calls (see renderHookScript()). It must never block a push of its own
 * accord — every failure here is reported on stderr with exit 0, and the
 * installed shell script forces exit 0 after this step regardless, as a
 * second line of defense. A hook this replaced is kept as
 * `pre-push.tokenflow-chained` and always runs first, keeping its own exit
 * code: that gate belongs to whoever configured it, not to TokenFlow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRootOf } from '../core/repo.js';
import { buildBranchReceipt, writeNote, pushNotes } from '../core/receipt-note.js';

const HOOK_NAME = 'pre-push';
const CHAINED_NAME = 'pre-push.tokenflow-chained';
const MARKER = '# tokenflow:pre-push v1 -- installed by `tokenflow hooks install`';
const ALL_ZERO_SHA = '0'.repeat(40);

function cliPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'bin', 'tokenflow.js');
}

function hooksDirFor(repoPath) {
  const root = repoRootOf(repoPath) || repoPath;
  return path.join(root, '.git', 'hooks');
}

/**
 * The installed hook script's contents. Buffers stdin once (so it can be
 * replayed to a chained hook and to the tokenflow step), runs a chained hook
 * first and keeps its exit code, then runs the tokenflow step and always
 * exits 0 after it.
 * @returns {string}
 */
export function renderHookScript() {
  const node = process.execPath;
  const cli = cliPath();
  return `#!/bin/sh
${MARKER}
# Re-run \`tokenflow hooks install\` / \`tokenflow hooks uninstall\` to change this file by hand.

# The notes push below re-triggers this same hook; stop immediately instead of recursing.
if [ "$TOKENFLOW_HOOK_NESTED" = "1" ]; then
  exit 0
fi

TOKENFLOW_STDIN="$(mktemp)"
trap 'rm -f "$TOKENFLOW_STDIN"' EXIT
cat > "$TOKENFLOW_STDIN"

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$HOOK_DIR/${CHAINED_NAME}" ]; then
  "$HOOK_DIR/${CHAINED_NAME}" "$@" < "$TOKENFLOW_STDIN"
  chained_status=$?
  if [ "$chained_status" -ne 0 ]; then
    exit "$chained_status"
  fi
fi

if [ -x "${node}" ]; then
  "${node}" "${cli}" hooks pre-push "$@" < "$TOKENFLOW_STDIN"
else
  echo "tokenflow: node not found at ${node}; skipping receipt" >&2
fi
exit 0
`;
}

/** True when the file at `p` is a hook TokenFlow installed (carries our marker). */
function isOurs(p) {
  try {
    return fs.readFileSync(p, 'utf8').includes(MARKER);
  } catch {
    return false; // unreadable: treat as foreign so it is never silently overwritten
  }
}

/**
 * `tokenflow hooks install` — write the pre-push hook. A pre-existing hook
 * that is not already ours is kept as `pre-push.tokenflow-chained`.
 * @param {{repo?:string}} [flags]
 * @returns {{path:string, chained:boolean}}
 */
export function install(flags = {}) {
  const repoPath = flags.repo || process.cwd();
  const dir = hooksDirFor(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  const hookPath = path.join(dir, HOOK_NAME);
  const chainedPath = path.join(dir, CHAINED_NAME);
  let chained = fs.existsSync(chainedPath);
  if (fs.existsSync(hookPath) && !isOurs(hookPath)) {
    fs.copyFileSync(hookPath, chainedPath);
    fs.chmodSync(chainedPath, 0o755);
    chained = true;
  }
  fs.writeFileSync(hookPath, renderHookScript());
  fs.chmodSync(hookPath, 0o755);
  return { path: hookPath, chained };
}

/**
 * `tokenflow hooks uninstall` — remove our hook, restoring a chained one.
 * Leaves a foreign (non-tokenflow) hook untouched.
 * @param {{repo?:string}} [flags]
 * @returns {{path:string, restored:boolean}}
 */
export function uninstall(flags = {}) {
  const repoPath = flags.repo || process.cwd();
  const dir = hooksDirFor(repoPath);
  const hookPath = path.join(dir, HOOK_NAME);
  const chainedPath = path.join(dir, CHAINED_NAME);
  let restored = false;
  if (fs.existsSync(hookPath) && isOurs(hookPath)) {
    fs.unlinkSync(hookPath);
    if (fs.existsSync(chainedPath)) {
      fs.renameSync(chainedPath, hookPath);
      fs.chmodSync(hookPath, 0o755);
      restored = true;
    }
  }
  return { path: hookPath, restored };
}

/**
 * `tokenflow hooks status` — installed? chained? where?
 * @param {{repo?:string}} [flags]
 * @returns {{installed:boolean, chained:boolean, path:string}}
 */
export function status(flags = {}) {
  const repoPath = flags.repo || process.cwd();
  const dir = hooksDirFor(repoPath);
  const hookPath = path.join(dir, HOOK_NAME);
  const chainedPath = path.join(dir, CHAINED_NAME);
  return {
    installed: fs.existsSync(hookPath) && isOurs(hookPath),
    chained: fs.existsSync(chainedPath),
    path: hookPath,
  };
}

function readStdin(flags) {
  if (typeof flags.stdin === 'string') return flags.stdin;
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return ''; // no stdin piped in (e.g. a manual run outside of git)
  }
}

/**
 * The `pre-push` hook body. Reads git's standard stdin lines
 * (`<local ref> <local sha> <remote ref> <remote sha>`), attaches a receipt
 * note to each pushed branch's local sha, then pushes the notes ref once, if
 * anything was written. Never blocks: every failure is reported on stderr
 * with exit 0.
 * @param {{repo?:string, args?:string[], stdin?:string}} [flags]
 * @returns {{stdout:string|null, stderr:string|null, exitCode:number}}
 */
export function prePush(flags = {}) {
  if (process.env.TOKENFLOW_HOOK_NESTED === '1') {
    // This is the notes push this same command triggers; do not recurse.
    return { stdout: null, stderr: null, exitCode: 0 };
  }
  const repoPath = flags.repo || process.cwd();
  const remote = (flags.args && flags.args[0]) || 'origin';
  const stdin = readStdin(flags);
  const errors = [];
  let wrote = 0;

  for (const line of stdin.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length !== 4) continue; // not a well-formed ref-update line
    const [localRef, localSha] = parts;
    if (!localRef.startsWith('refs/heads/')) continue; // tags and other refs carry no branch receipt
    if (localSha === ALL_ZERO_SHA) continue; // a delete: nothing to attach a receipt to
    const branch = localRef.slice('refs/heads/'.length);
    try {
      const receipt = buildBranchReceipt({ repoPath, branch, sha: localSha });
      if (!receipt) continue; // no local sessions for this branch: nothing to attach
      writeNote({ repoPath, sha: localSha, receipt });
      wrote += 1;
    } catch (err) {
      errors.push(`${branch}: ${err.message}`);
    }
  }

  if (wrote > 0) {
    try {
      pushNotes({ repoPath, remote });
    } catch (err) {
      errors.push(`push refs/notes/tokenflow: ${err.message}`);
    }
  }

  if (errors.length) return { stdout: null, stderr: `tokenflow: ${errors.join('; ')}`, exitCode: 0 };
  return { stdout: null, stderr: null, exitCode: 0 };
}

/**
 * CLI entry. Dispatches on `flags.action` (`install` / `uninstall` /
 * `status` / `pre-push`), set by the bin from the `hooks <action>` argv.
 * @param {object} flags
 * @returns {{stdout:string|null, stderr:string|null, exitCode:number}}
 */
export function run(flags = {}) {
  switch (flags.action) {
    case 'install': {
      const r = install(flags);
      const chainedNote = r.chained ? ` (chained the existing hook as ${CHAINED_NAME})` : '';
      return { stdout: `installed ${r.path}${chainedNote}`, stderr: null, exitCode: 0 };
    }
    case 'uninstall': {
      const r = uninstall(flags);
      return { stdout: `uninstalled${r.restored ? `; restored the previous hook at ${r.path}` : ''}`, stderr: null, exitCode: 0 };
    }
    case 'status': {
      const s = status(flags);
      return { stdout: `installed: ${s.installed ? 'yes' : 'no'}   chained: ${s.chained ? 'yes' : 'no'}   ${s.path}`, stderr: null, exitCode: 0 };
    }
    case 'pre-push':
      return prePush(flags);
    default:
      return { stdout: null, stderr: 'usage: tokenflow hooks <install|uninstall|status|pre-push>', exitCode: 1 };
  }
}

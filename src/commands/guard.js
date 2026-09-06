/**
 * `tokenflow guard` — a circuit breaker for the session you are in.
 *
 * Spend across agent sessions follows a power law: a handful of long,
 * subagent-heavy sessions carry most of the bill, and each of their turns
 * costs more than the last because it re-sends everything so far. Every
 * dashboard shows that after the fact. This command runs *during* the session,
 * as a Claude Code hook: it reads the live transcript the same way the
 * anthropic adapter does, prices it with the same table, and reports the
 * running spend, the size of the prompt now being re-sent, and the cost of the
 * last few turns — then warns or blocks against thresholds YOU declared.
 *
 *   tokenflow guard                    as a hook: reads the hook JSON on stdin
 *   tokenflow guard --session <f>      judge one transcript file, print a report
 *   tokenflow guard --set warnCostUsd=25,maxCostUsd=200
 *   tokenflow guard --install          print the settings.json hooks block (does not write it)
 *   tokenflow guard --policy [--cwd <dir>]   show the effective policy and where each value came from
 *   tokenflow guard --install --codex [--apply]   wire up Codex CLI's `notify` (warns only, see docs/guard-codex.md)
 *   tokenflow guard --codex-notify <json>         Codex's notify program, called after every turn
 *
 * Contract with Claude Code hooks (code.claude.com/docs/en/hooks):
 *   - stdin carries {session_id, transcript_path, cwd, hook_event_name, ...}
 *   - exit 0 + JSON on stdout: `hookSpecificOutput.additionalContext` reaches
 *     the model, `systemMessage` reaches the user
 *   - exit 2 blocks (PreToolUse blocks the tool call, UserPromptSubmit rejects
 *     the prompt) with stderr as the reason. Stop and SessionStart are never
 *     blocked here: preventing a session from stopping is not a saving.
 *
 * Nothing is invented: with no `guard:` thresholds in config, in a repo's
 * `.tokenflow/policy.yaml`, or in a cached org policy (src/core/policy.js's
 * `effectivePolicy()` — personal < repo < org, the org applied only as a
 * ceiling that lowers a cap, never raises one) the hook is informational and
 * never blocks. The org layer is read from its local cache ONLY: this hook
 * never makes a network call, no matter how stale that cache is — see
 * `tokenflow policy pull` and docs/policy.md. Incremental: the transcript's
 * byte offset and open streaming groups are remembered per session under
 * $TOKENFLOW_HOME/guard/, so a 500 MB transcript is read once, not per tool
 * call.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { loadConfig, saveConfig, merge, paths, homeDir } from '../core/config.js';
import { readJson, writeJson } from '../core/store.js';
import { buildPriceBook } from '../core/pricing.js';
import { BUILTIN_MODEL_RULES } from '../core/model-map.js';
import { enrich, walk } from '../core/ingest.js';
import { getProvider } from '../core/registry.js';
import { evaluateGuard, renderGuard } from '../analytics/receipt.js';
import { GUARD_KEYS, effectivePolicy } from '../core/policy.js';
import { show as policyShow, renderShow as renderPolicyShow } from './policy.js';
import { notify } from '../core/notify.js';

export { GUARD_KEYS };
const BLOCKABLE_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit']);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
/** The bin this repo ships, resolved from this module rather than trusted CLI plumbing. */
const DEFAULT_BIN_PATH = path.join(HERE, '..', '..', 'bin', 'tokenflow.js');

function makeCtx(config, book) {
  return {
    config,
    tz: config.timezone || null,
    home: os.homedir(),
    user: config.identity?.user || os.userInfo().username,
    machine: config.identity?.machine || os.hostname(),
    priceBook: book,
    rules: [...(config.modelMappings || []).map((r) => ({ ...r, label: r.label || r.provider })), ...BUILTIN_MODEL_RULES],
    log: () => {},
  };
}

/**
 * Read one transcript (or the part of it not read before) into normalized records.
 * @param {string} file transcript path
 * @param {{config?:object, book?:object, start?:number, state?:object}} [opt]
 * @returns {{records:object[], offset:number, state:object}}
 */
export function readTranscript(file, opt = {}) {
  const config = opt.config || loadConfig();
  const book = opt.book || buildPriceBook(readJson(paths().pricing, {}));
  const provider = getProvider('anthropic');
  if (!provider) throw new Error('the anthropic adapter is not loaded');
  const stat = fs.statSync(file);
  const ref = {
    key: path.basename(path.dirname(file)),
    path: file,
    stat,
    start: opt.start || 0,
    state: opt.state ? structuredClone(opt.state) : {},
    gen: 1,
    label: 'guard',
  };
  const ctx = makeCtx(config, book);
  const records = [];
  let seq = 0;
  const emit = (partial) => {
    const rec = enrich(partial, { ctx, provider, seq: seq++, fileRef: ref });
    if (rec) records.push(rec);
  };
  const res = provider.ingestFile(ref, ctx, emit);
  return { records, offset: res && typeof res.offset === 'number' ? res.offset : stat.size, state: ref.state };
}

function guardDir() {
  return path.join(paths().root, 'guard');
}

/**
 * Records kept from earlier reads are replayed into the verdict so the running
 * totals are exact without re-reading the file. Streaming groups that continued
 * arrive as deltas carrying the same request id: merge, do not append. Shared
 * by the Claude Code transcript path and the Codex rollout path — the two
 * sources produce the same shape of streaming deltas.
 * @param {object[]} kept records carried over from the cache
 * @param {object[]} records freshly read records (may re-report an open group)
 */
function mergeReplayed(kept, records) {
  const byId = new Map(kept.map((r) => [r.request_id || r.id, r]));
  for (const r of records) {
    const k = r.request_id || r.id;
    const prev = byId.get(k);
    if (prev && r.request_id) {
      for (const f of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_refresh_tokens', 'reasoning_tokens']) {
        if (r[f] !== null && r[f] !== undefined) prev[f] = (prev[f] === null || prev[f] === undefined ? 0 : prev[f]) + r[f];
      }
      if (r.estimated_cost !== null && r.estimated_cost !== undefined) prev.estimated_cost = (prev.estimated_cost ?? 0) + r.estimated_cost;
      prev.timestamp = r.timestamp || prev.timestamp;
    } else {
      byId.set(k, r);
    }
  }
  return [...byId.values()];
}

/**
 * `evaluateGuard` is pure and knows nothing about where a threshold came
 * from. This reproduces its own `>=` comparisons (max checked before warn,
 * same order: cost, context, marginal) against the SAME numbers the verdict
 * already carries, purely to find out which keys fired — then appends a
 * reason for any that came from a repo's `.tokenflow/policy.yaml` and/or the
 * cached org policy, rather than the user's own config.
 * @param {ReturnType<typeof evaluateGuard>} verdict
 * @param {ReturnType<typeof effectivePolicy>} eff
 */
function annotateSource(verdict, eff) {
  const p = eff.policy;
  const fired = [];
  if (p.maxCostUsd !== null && verdict.cost !== null && verdict.cost >= p.maxCostUsd) fired.push('maxCostUsd');
  else if (p.warnCostUsd !== null && verdict.cost !== null && verdict.cost >= p.warnCostUsd) fired.push('warnCostUsd');
  if (p.maxContextTokens !== null && verdict.contextTokens !== null && verdict.contextTokens >= p.maxContextTokens) fired.push('maxContextTokens');
  else if (p.warnContextTokens !== null && verdict.contextTokens !== null && verdict.contextTokens >= p.warnContextTokens) fired.push('warnContextTokens');
  if (p.warnMarginalUsd !== null && verdict.marginalCostPerTurn !== null && verdict.marginalCostPerTurn >= p.warnMarginalUsd) fired.push('warnMarginalUsd');

  // Which declared key fired, and which layer it came from. `hookOutput` reads
  // this to tell the user how to get past the cap: `guard --set` writes the
  // personal config and cannot raise a cap the org ceiling already lowered.
  /** @type {Record<string,'personal'|'repo'|'org'|'default'>} */
  const firedSources = {};
  for (const k of fired) firedSources[k] = eff.sources[k];

  const reasons = [...verdict.reasons];
  const repoKeys = fired.filter((k) => eff.sources[k] === 'repo');
  if (repoKeys.length) {
    const label = repoKeys.length > 1 ? `caps ${repoKeys.join(', ')}` : `cap ${repoKeys[0]}`;
    const note = eff.note ? `: ${eff.note}` : '';
    reasons.push(`${label} from .tokenflow/policy.yaml${note}`);
  }
  const orgKeys = fired.filter((k) => eff.sources[k] === 'org');
  if (orgKeys.length) {
    const label = orgKeys.length > 1 ? `caps ${orgKeys.join(', ')}` : `cap ${orgKeys[0]}`;
    const src = eff.org && eff.org.meta && eff.org.meta.source ? ` (${eff.org.meta.source})` : '';
    reasons.push(`${label} from the org policy${src}, a ceiling your team declared, lower than the personal/repo value`);
  }
  return { ...verdict, reasons, firedSources };
}

/**
 * Evaluate a session from its transcript, resuming from the cached read position.
 * @param {{transcript_path:string, session_id?:string, cwd?:string}} payload
 * @param {{config?:object, book?:object, cache?:boolean}} [opt]
 */
export function evaluateSession(payload, opt = {}) {
  const config = opt.config || loadConfig();
  const book = opt.book || buildPriceBook(readJson(paths().pricing, {}));
  const file = payload.transcript_path;
  const sid = payload.session_id || path.basename(file, '.jsonl');
  const useCache = opt.cache !== false;
  const cacheFile = path.join(guardDir(), `${sid.replace(/[^\w.-]/g, '_')}.json`);
  const cached = useCache ? readJson(cacheFile, null) : null;
  const stat = fs.statSync(file);

  // A transcript that shrank was rewritten: start over.
  const resume = cached && cached.offset <= stat.size ? cached : null;
  const { records, offset, state } = readTranscript(file, { config, book, start: resume ? resume.offset : 0, state: resume ? resume.state : {} });

  const kept = resume ? resume.records : [];
  const all = mergeReplayed(kept, records);
  // Claude Code sends `cwd` in the hook payload (see the module doc above);
  // a repo's `.tokenflow/policy.yaml` at that cwd wins over ~/.tokenflow/config.yaml,
  // and a cached org ceiling (never fetched here — see core/policy.js) wins over both.
  const eff = effectivePolicy({ cwd: payload.cwd, home: homeDir(), config });
  const verdict = annotateSource(evaluateGuard(all, eff.policy, book), eff);

  if (useCache) {
    fs.mkdirSync(guardDir(), { recursive: true });
    writeJson(cacheFile, { offset, state, records: all.map(slim), updated: new Date().toISOString() });
  }
  return { verdict, records: all, offset };
}

/** Only the fields the verdict needs; a transcript's metadata stays in the transcript. */
function slim(r) {
  return {
    id: r.id, request_id: r.request_id, timestamp: r.timestamp, model: r.model, model_family: r.model_family,
    provider: r.provider, source: r.source, measurement: r.measurement, category: r.category,
    session_id: r.session_id, service_tier: r.service_tier,
    input_tokens: r.input_tokens, output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens,
    cache_refresh_tokens: r.cache_refresh_tokens, reasoning_tokens: r.reasoning_tokens,
    estimated_cost: r.estimated_cost, cost_basis: r.cost_basis,
  };
}

// ============================================================ Codex guard ===
//
// Codex CLI (~/.codex) has no blocking hook: its `notify` setting in
// ~/.codex/config.toml runs a program once after every turn, with one JSON
// argument (docs.openai.com/codex → config-advanced.md, "Notifications").
// That JSON currently looks like:
//   {"type":"agent-turn-complete","thread-id":"...","turn-id":"...",
//    "cwd":"...","input-messages":[...],"last-assistant-message":"..."}
// The last two carry the user's and the model's own words. TokenFlow reads
// counts and metadata only — never prompt or code content — so this path
// touches exactly `thread-id` and `cwd` and nothing else in that object.
// Because there is no blocking hook, this can only WARN (an OS notification);
// it never stops a Codex turn.

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Where to look for rollout files. Overridable (`opt.sessionsRoot` or `TOKENFLOW_CODEX_SESSIONS`) so tests never touch a real ~/.codex. */
function codexSessionsRoots(opt = {}) {
  if (opt.sessionsRoot) return [opt.sessionsRoot];
  if (process.env.TOKENFLOW_CODEX_SESSIONS) return [process.env.TOKENFLOW_CODEX_SESSIONS];
  const home = opt.codexHome || defaultCodexHome();
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

/** `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<thread-id>.jsonl` — the newest match if more than one exists. */
function findCodexRollout(threadId, opt = {}) {
  const suffix = `-${threadId}.jsonl`;
  for (const root of codexSessionsRoots(opt)) {
    if (!fs.existsSync(root)) continue;
    const hits = walk(root, (name) => name.startsWith('rollout-') && name.endsWith(suffix));
    if (hits.length) return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  return null;
}

/**
 * Evaluate one Codex `notify` payload: locate its rollout file, ingest it
 * incrementally with the same openai adapter `tokenflow refresh` uses, judge
 * it against the effective policy for that cwd, and notify on warn/block.
 *
 * Never rejects — every failure mode (no thread id, no rollout file yet, the
 * adapter missing) resolves to `{ skipped: true, reason }` or `{ error }` so
 * a caller that does not await this (see `run()`) never produces an unhandled
 * rejection.
 *
 * @param {object} payload Codex's notify JSON, already parsed. Only
 *   `payload['thread-id']` and `payload['cwd']` are ever read.
 * @param {{config?:object, book?:object, cache?:boolean, sessionsRoot?:string,
 *   rolloutFile?:string, notify?:Function}} [opt]
 */
export async function evaluateCodexNotify(payload, opt = {}) {
  try {
    const threadId = payload['thread-id'];
    const cwd = payload['cwd'] ?? null;
    if (!threadId || typeof threadId !== 'string') {
      return { skipped: true, reason: 'the notify payload has no "thread-id"' };
    }

    const config = opt.config || loadConfig();
    const book = opt.book || buildPriceBook(readJson(paths().pricing, {}));
    // Resolved once, up front, before any `await` below: TOKENFLOW_HOME could
    // in principle change between calls, and every env-derived path this
    // function touches (the cache file, and later the org policy cache) must
    // agree on which home they mean.
    const home = homeDir();
    const cacheFile = path.join(guardDir(), `codex-${threadId.replace(/[^\w.-]/g, '_')}.json`);
    const useCache = opt.cache !== false;
    const cached = useCache ? readJson(cacheFile, null) : null;

    // The resolved path is cached too, so a live session's later turns do not
    // repay the cost of walking ~/.codex/sessions on every single notify call.
    let file = cached && cached.file && fs.existsSync(cached.file) ? cached.file : null;
    if (!file) file = opt.rolloutFile || findCodexRollout(threadId, opt);
    if (!file) return { skipped: true, reason: `no rollout file found for thread ${threadId}` };

    const provider = getProvider('openai');
    if (!provider) return { skipped: true, reason: 'the openai adapter is not loaded' };

    const stat = fs.statSync(file);
    const resume = cached && cached.offset <= stat.size ? cached : null;

    const ctx = makeCtx(config, book);
    const ref = {
      key: threadId,
      path: file,
      stat,
      start: resume ? resume.offset : 0,
      state: resume ? structuredClone(resume.state) : {},
      gen: 1,
      label: 'guard-codex',
    };
    const fresh = [];
    let seq = 0;
    const emit = (partial) => {
      const rec = enrich(partial, { ctx, provider, seq: seq++, fileRef: ref });
      if (rec) fresh.push(rec);
    };
    const res = await provider.ingestFile(ref, ctx, emit);
    const offset = res && typeof res.offset === 'number' ? res.offset : stat.size;

    const kept = resume ? resume.records : [];
    const all = mergeReplayed(kept, fresh);
    const eff = effectivePolicy({ cwd, home, config });
    const verdict = annotateSource(evaluateGuard(all, eff.policy, book), eff);

    // Persist the cache before notifying: notify() is fire-and-forget by
    // design (spawns a detached process), and a caller that does not await
    // this whole function (the CLI path, since Codex ignores our exit code)
    // may let the process exit before that continuation runs. The bookkeeping
    // that matters for correctness must not depend on it.
    if (useCache) {
      fs.mkdirSync(guardDir(), { recursive: true });
      writeJson(cacheFile, { file, offset, state: ref.state, records: all.map(slim), updated: new Date().toISOString() });
    }

    let notified = false;
    if (verdict.level !== 'ok') {
      const send = opt.notify || notify;
      const codexLevel = verdict.level === 'block' ? 'over the declared cap (warning only — Codex has no blocking hook)' : 'warning';
      try {
        await send({ title: `TokenFlow guard (Codex) — ${codexLevel}`, body: renderGuard(verdict) });
        notified = true;
      } catch { /* best-effort, same posture as every other notify() call in this project */ }
    }

    return { verdict, notified, file, threadId, cwd, policySources: eff.sources, repoRoot: eff.repoRoot };
  } catch (err) {
    return { error: err.message };
  }
}

/** The exact `notify = [...]` TOML line for ~/.codex/config.toml. */
export function codexNotifySnippet({ execPath = process.execPath, binPath = DEFAULT_BIN_PATH } = {}) {
  return `notify = ${JSON.stringify([execPath, binPath, 'guard', '--codex-notify'])}`;
}

function codexInstallInstructions(line) {
  return [
    'Add this to ~/.codex/config.toml (Codex allows exactly one `notify` program —',
    'do not add this if a `notify = [...]` line is already there):',
    '',
    line,
    '',
    'Codex runs this once after every turn with one JSON argument on the command line.',
    '`tokenflow guard --codex-notify` reads only "thread-id" and "cwd" from it, judges that',
    'session against the same guard policy (~/.tokenflow/config.yaml, overridden by that',
    'repository\'s .tokenflow/policy.yaml), and sends one OS notification on warn or block.',
    'Codex CLI has no blocking hook, so this can only WARN — see docs/guard-codex.md.',
    '',
    'Apply this automatically:  tokenflow guard --install --codex --apply',
  ].join('\n');
}

/**
 * Append the `notify` line to ~/.codex/config.toml — but only when the file
 * exists and declares no `notify` key yet. Never overwrites an existing key.
 * @param {{configPath?:string, snippet?:string}} [opt]
 */
export function applyCodexInstall(opt = {}) {
  const line = opt.snippet || codexNotifySnippet();
  const configPath = opt.configPath || path.join(defaultCodexHome(), 'config.toml');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    return { applied: false, reason: `${dir} does not exist — Codex CLI does not look installed on this machine`, line, configPath };
  }
  let existing = '';
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, 'utf8');
    if (/^\s*notify\s*=/m.test(existing)) {
      return { applied: false, reason: `${configPath} already declares a "notify" key — not overwriting it`, line, configPath };
    }
  }
  const sep = !existing ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(configPath, `${existing}${sep}${line}\n`);
  return { applied: true, line, configPath };
}

/** The two keys that can raise `level` to 'block'; a warn* key never stops a tool call. */
const BLOCKING_KEYS = ['maxCostUsd', 'maxContextTokens'];

/**
 * How to get past the cap that just blocked — which depends on WHERE that cap
 * came from. `tokenflow guard --set` writes the personal config only, and
 * `effectivePolicy()` applies the org value as a ceiling (src/core/policy.js),
 * so raising a personal number can never lift an org cap. Pointing someone at
 * a command that changes nothing is worse than saying so.
 * @param {ReturnType<typeof evaluateGuard> & {firedSources?:Record<string,string>}} v
 * @returns {string}
 */
function capHint(v) {
  const sources = v.firedSources || {};
  const fromOrg = BLOCKING_KEYS.filter((k) => sources[k] === 'org');
  if (fromOrg.length) {
    const subject = fromOrg.length > 1 ? `${fromOrg.join(' and ')} come` : `${fromOrg[0]} comes`;
    return `${subject} from your org policy, a ceiling your team declared: \`tokenflow guard --set\` writes your own config and cannot raise it. Ask whoever maintains the team server, or see docs/policy.md.`;
  }
  return 'Raise the cap with `tokenflow guard --set maxCostUsd=<n>` or clear it with `tokenflow guard --set maxCostUsd=`.';
}

/**
 * Translate a verdict into what a Claude Code hook must print and how it must exit.
 * @param {ReturnType<typeof evaluateGuard> & {firedSources?:Record<string,string>}} v
 * @param {string|null} eventName hook_event_name from the payload
 * @returns {{exitCode:number, stdout:string|null, stderr:string|null}}
 */
export function hookOutput(v, eventName) {
  if (v.level === 'ok') return { exitCode: 0, stdout: null, stderr: null };
  const headline = `TokenFlow guard: ${v.reasons.join('; ')}.`;
  const advice = v.suggestion ? ` ${v.suggestion}` : '';
  if (v.level === 'block' && eventName && BLOCKABLE_EVENTS.has(eventName)) {
    return {
      exitCode: 2,
      stdout: null,
      stderr: `${headline}${advice} ${capHint(v)}`,
    };
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: eventName || 'UserPromptSubmit',
      additionalContext: `${headline}${advice} Prefer the smallest next step; avoid re-reading files already in context.`,
      systemMessage: `${headline}${advice}`,
    },
  };
  return { exitCode: 0, stdout: JSON.stringify(out), stderr: null };
}

/** The hooks block to add to ~/.claude/settings.json. Printed, never written. */
export function installSnippet(binPath = 'tokenflow') {
  const cmd = `${binPath} guard`;
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd, timeout: 20 }] }],
      PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: cmd, timeout: 20 }] }],
    },
  };
  return [
    'Add this to ~/.claude/settings.json (merge into an existing "hooks" object):',
    '',
    JSON.stringify(settings, null, 2),
    '',
    'UserPromptSubmit runs once per prompt you send; PreToolUse on Agent|Task runs before each',
    'subagent is spawned — the two moments where a session\'s cost curve bends.',
    'Then declare what you want guarded, e.g.:',
    '  tokenflow guard --set warnCostUsd=25,warnContextTokens=200000,maxCostUsd=200',
    'Without thresholds the hook is informational and never blocks.',
  ].join('\n');
}

/**
 * @param {string} spec "k=v,k=v" — an empty value clears the key
 * @returns {object} the new guard section
 */
export function applySet(spec, cfg = loadConfig()) {
  const guard = { ...(cfg.guard || {}) };
  for (const part of String(spec).split(',')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const k = (eq > -1 ? part.slice(0, eq) : part).trim();
    const v = eq > -1 ? part.slice(eq + 1).trim() : '';
    if (!GUARD_KEYS.includes(k)) {
      const e = /** @type {Error & {hint?:string}} */ (new Error(`unknown guard key "${k}"`));
      e.hint = `known keys: ${GUARD_KEYS.join(', ')}`;
      throw e;
    }
    if (v === '') { guard[k] = null; continue; }
    const n = Number(v);
    if (!(n > 0)) throw new Error(`${k} must be a positive number, got "${v}"`);
    guard[k] = n;
  }
  saveConfig(merge(cfg, { guard }));
  return guard;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null; // no stdin, or not JSON: not a hook invocation
  }
}

/**
 * CLI entry. Returns what to print and the exit code; the bin decides the stream.
 * The `--codex-notify` branch returns a Promise (see the note at its call site);
 * every other branch returns synchronously.
 * @param {object} flags
 * @returns {{stdout:string|null, stderr:string|null, exitCode:number}|Promise<{stdout:string|null, stderr:string|null, exitCode:number}>}
 */
export function run(flags = {}) {
  if (flags.install && flags.codex) {
    const line = codexNotifySnippet();
    if (!flags.apply) return { stdout: codexInstallInstructions(line), stderr: null, exitCode: 0 };
    const res = applyCodexInstall({ snippet: line });
    if (!res.applied) return { stdout: `${res.reason}\n\n${codexInstallInstructions(line)}`, stderr: null, exitCode: 0 };
    return { stdout: `✓ appended to ${res.configPath}:\n  ${res.line}\n\nRestart Codex CLI for it to take effect.`, stderr: null, exitCode: 0 };
  }
  if (flags.install) return { stdout: installSnippet(flags.bin || 'tokenflow'), stderr: null, exitCode: 0 };
  if (typeof flags.set === 'string') {
    const g = applySet(flags.set);
    const lines = GUARD_KEYS.map((k) => `  ${k.padEnd(18)} ${g[k] === null || g[k] === undefined ? '—' : g[k]}`);
    return { stdout: ['guard thresholds:', ...lines].join('\n'), stderr: null, exitCode: 0 };
  }
  if (flags.policy) {
    // Same computation `tokenflow policy show` uses — kept in one place
    // (src/commands/policy.js) so the two views can never drift apart.
    const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();
    const eff = policyShow({ cwd, config: loadConfig() });
    return { stdout: renderPolicyShow(eff, cwd), stderr: null, exitCode: 0 };
  }
  if (typeof flags['codex-notify'] === 'string') {
    let payload;
    try {
      payload = JSON.parse(flags['codex-notify']);
    } catch (err) {
      return { stdout: null, stderr: `tokenflow guard --codex-notify: invalid JSON payload (${err.message})`, exitCode: 1 };
    }
    // Codex ignores this program's stdout/exit code (it is a fire-and-forget
    // `notify` side-channel), so there is nothing to lose by returning the
    // promise rather than detaching from it — see docs/guard-codex.md and
    // the "Integration edits" note about awaiting `run()` in bin/tokenflow.js.
    return evaluateCodexNotify(payload).then((r) => {
      if (r.error) return { stdout: null, stderr: `tokenflow guard --codex-notify: ${r.error}`, exitCode: 0 };
      if (r.skipped || r.verdict.level === 'ok') return { stdout: null, stderr: null, exitCode: 0 };
      return { stdout: renderGuard(r.verdict), stderr: null, exitCode: 0 };
    });
  }
  if (typeof flags.session === 'string') {
    const file = flags.session.startsWith('~') ? path.join(os.homedir(), flags.session.slice(1)) : flags.session;
    const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();
    const { verdict } = evaluateSession({ transcript_path: file, cwd }, { cache: false });
    return { stdout: renderGuard(verdict), stderr: null, exitCode: 0 };
  }

  const payload = readStdinJson();
  if (!payload || typeof payload.transcript_path !== 'string') {
    return {
      stdout: null,
      stderr: 'tokenflow guard expects a Claude Code hook payload on stdin, or --session <transcript.jsonl>, --set k=v, --install, --policy, --codex-notify <json>',
      exitCode: 1,
    };
  }
  if (!fs.existsSync(payload.transcript_path)) return { stdout: null, stderr: null, exitCode: 0 };
  const { verdict } = evaluateSession(payload);
  const out = hookOutput(verdict, payload.hook_event_name || null);
  return out;
}

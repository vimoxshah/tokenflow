/**
 * `tokenflow mcp` — an MCP server over stdio, so a coding agent can read its
 * own spend and its own caps.
 *
 * Every other surface in TokenFlow reports to a human after the fact: a
 * dashboard, a receipt in a pull request, a menu bar. The agent that actually
 * spends the money has never been able to see any of it. This server closes
 * that loop. An agent that can ask "what has this branch cost so far" and
 * "what cap is in force here" can plan around the answer: batch its edits,
 * stop re-reading a file it already read, or say out loud that the work it is
 * about to do will cross the repository's declared limit.
 *
 * Four tools, all read-only, all local:
 *
 *   tokenflow_receipt   what a branch has cost
 *   tokenflow_policy    the guard caps in force here, and where each came from
 *   tokenflow_usage     totals for the last N days, and the top models
 *   tokenflow_budget    the monthly budget and where this month stands
 *
 * Nothing here writes to the store, sends a notification, or makes a network
 * request. The one filesystem side effect is `ensureDirs()` inside the `Store`
 * constructor, which creates the (empty) data directories under
 * $TOKENFLOW_HOME the same way every read command already does.
 *
 * Protocol: MCP over stdio is newline-delimited JSON-RPC 2.0 (see
 * src/core/jsonrpc.js for the framing). The latest protocol version this
 * server names is 2026-07-28; on `initialize` it echoes the client's version
 * when that version is one it supports, which is what the lifecycle rules ask
 * for, and otherwise answers with its own latest.
 *
 * stdout carries JSON-RPC and nothing else. Diagnostics go to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createConnection, invalidParams } from '../core/jsonrpc.js';
import { readJson } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { buildBundle } from '../core/bundle.js';
import { computeBudgetState } from '../core/budget.js';
import { currentStatus } from '../core/live-status.js';
import { GUARD_KEYS, effectiveGuardPolicy } from '../core/policy.js';
import * as policyModule from '../core/policy.js';
import { repoRootOf } from '../core/repo.js';
import { run as runReceiptCommand } from './receipt.js';
import {
  indexCube, filterCube, filterSessions, sumRows, finalize, rank, addDays,
} from '../analytics/aggregate.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_JSON = path.join(HERE, '..', '..', 'package.json');

export const SERVER_NAME = 'tokenflow';

/**
 * Protocol versions this server speaks, newest first. Every entry is a version
 * the Model Context Protocol specification names; the first is the default
 * answer when a client asks for one that is not on this list.
 */
export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** The version at which a tool result carries `resultType`. */
const RESULT_TYPE_FROM = '2026-07-28';

export const SERVER_INSTRUCTIONS = [
  'TokenFlow reports what this machine has spent on AI tokens. Every tool is read-only and local:',
  'nothing is uploaded and nothing is written to the store.',
  'Use tokenflow_receipt before a long piece of work to see what the branch has already cost,',
  'tokenflow_policy to learn the caps this repository declared, tokenflow_usage for recent totals,',
  'and tokenflow_budget for the monthly cap. Costs are estimates from a local price table unless a',
  'field says "measured". A null number means "not known", never zero.',
].join(' ');

/** The tools, exactly as `tools/list` reports them. */
export const TOOLS = [
  {
    name: 'tokenflow_receipt',
    description: [
      'What one branch of one repository has cost in AI spend so far.',
      'Returns estimated dollars, the split between context (re-sending the conversation so far)',
      'and work (fresh input and output), turns, sessions, and the dates the work ran.',
      'Call it before a long piece of work to know what the branch has already spent.',
      'When the branch has no recorded sessions the result says so and lists the branches that do.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Path to a checkout, or a bare repository name. Defaults to the directory the server runs in.',
        },
        branch: {
          type: 'string',
          description: 'Branch name. Defaults to the branch checked out in that repository right now.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tokenflow_policy',
    description: [
      'The guard caps in force for a directory, and where each one came from.',
      'A source of "org" is a team cap (a ceiling, it can only lower a cap), "repo" is a',
      '.tokenflow/policy.yaml checked into the repository, "personal" or "config" is this',
      'machine\'s own setting, and "default" means nothing is declared, so the cap is null and',
      'nothing will be blocked. Use it to size a session against the limits this repository set.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to resolve the policy for. Defaults to the directory the server runs in.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tokenflow_usage',
    description: [
      'Token and cost totals for the last N days from the local store:',
      'tokens by bucket (input, output, cache read, cache write), estimated and measured cost,',
      'requests, sessions, and the models that used the most tokens.',
      'Estimated cost comes from a local price table; measured cost is what a gateway reported.',
      'They are never added together.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 90,
          default: 7,
          description: 'Length of the window in days, counting back from today. Defaults to 7.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tokenflow_budget',
    description: [
      'The monthly spend budget and where this month stands: the cap, spend so far this month,',
      'the projected month end total, and the state (safe, approaching, over_budget_projected,',
      'over_budget_actual, or unknown when there is too little history to project).',
      'The projection is a trend, not a charge. Returns configured:false when no cap is set.',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ------------------------------------------------------------ git helpers ---

/**
 * The branch checked out in `startDir`, read from `.git/HEAD` without a
 * subprocess (the same posture as src/core/repo.js). A worktree's `.git` is a
 * file pointing at its own gitdir, and that gitdir holds the worktree's HEAD,
 * so the branch reported is the one checked out *here*, not in the main
 * checkout. A detached HEAD names no branch and returns null.
 * @param {string} startDir
 * @returns {string|null}
 */
export function currentBranchOf(startDir) {
  let d = startDir;
  for (let i = 0; i < 12 && d && d !== path.dirname(d); i++) {
    const g = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(g);
    } catch {
      st = null; // no .git here, keep walking up
    }
    if (st) {
      let headFile = path.join(g, 'HEAD');
      if (!st.isDirectory()) {
        let txt = '';
        try {
          txt = fs.readFileSync(g, 'utf8');
        } catch {
          return null; // unreadable worktree pointer; no branch to report
        }
        const m = /gitdir:\s*(.+)\s*$/m.exec(txt);
        if (!m) return null;
        headFile = path.join(path.resolve(d, m[1].trim()), 'HEAD');
      }
      let head = '';
      try {
        head = fs.readFileSync(headFile, 'utf8');
      } catch {
        return null; // no HEAD to read; no branch to report
      }
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
      return ref ? ref[1].trim() : null;
    }
    d = path.dirname(d);
  }
  return null;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // not a path on this machine, so treat it as a bare name
  }
}

// -------------------------------------------------------------- the tools ---

/**
 * `tokenflow_receipt` — one branch's receipt, through the same code path as
 * `tokenflow receipt`. The whole store is scanned once: with `repo` set,
 * `run()` already filters its result to that repository, so the branch to
 * return and the fallback list of branches come out of the same pass.
 */
function toolReceipt(args, ctx) {
  const repoArg = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : ctx.cwd;
  const repoPath = isDirectory(repoArg) ? fs.realpathSync(repoArg) : null;
  const repoRoot = repoPath ? repoRootOf(repoPath) : null;
  const branch = typeof args.branch === 'string' && args.branch.trim()
    ? args.branch.trim()
    : (repoPath ? currentBranchOf(repoPath) : null);

  const { json } = runReceiptCommand({ repo: repoArg });
  const R = json.repos && json.repos.length ? json.repos[0] : null;
  const repo = R ? R.repo : (repoRoot ? path.basename(repoRoot) : repoArg);

  const known = R
    ? R.branches.map((b) => ({ branch: b.key, costUsd: b.cost, turns: b.turns, sessions: b.sessions }))
    : [];

  if (!R) {
    return {
      found: false,
      repo,
      branch,
      reason: 'no local sessions are recorded for this repository',
      branches: known,
    };
  }
  if (!branch) {
    return {
      found: false,
      repo,
      branch: null,
      reason: 'no branch was given and none is checked out here, so no single receipt can be named',
      branches: known,
    };
  }
  const b = R.branches.find((x) => x.key === branch);
  if (!b) {
    return {
      found: false,
      repo,
      branch,
      reason: 'no local sessions are recorded for this branch',
      branches: known,
    };
  }
  return { found: true, repo, branch, repoRoot, receipt: b };
}

/**
 * `tokenflow_policy` — the effective guard caps for a directory.
 *
 * The org layer (a team-server cap, cached locally and applied as a ceiling)
 * is feature-detected rather than imported by name: `effectivePolicy` is a
 * newer export of src/core/policy.js, and this tool must keep working against
 * an installation whose policy module only has the two-layer
 * `effectiveGuardPolicy`. Either way the `source` beside every cap says which
 * layer the number came from.
 */
function toolPolicy(args, ctx) {
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? path.resolve(args.cwd.trim()) : ctx.cwd;
  const config = loadConfig();
  const withOrg = /** @type {any} */ (policyModule).effectivePolicy;
  const eff = typeof withOrg === 'function'
    ? withOrg({ cwd, config })
    : effectiveGuardPolicy({ cwd, config });

  /** @type {Record<string, {value:number|null, source:string}>} */
  const caps = {};
  for (const k of GUARD_KEYS) caps[k] = { value: eff.policy[k], source: eff.sources[k] };

  const out = {
    cwd,
    repoRoot: eff.repoRoot,
    declared: GUARD_KEYS.some((k) => eff.policy[k] !== null),
    caps,
    note: eff.note,
    errors: eff.errors,
  };
  if (eff.org) out.org = eff.org;
  return out;
}

/** `tokenflow_usage` — totals and top models for a window of days. */
function toolUsage(args) {
  const days = args.days === undefined ? 7 : args.days;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(`days must be a whole number between 1 and 90, got ${JSON.stringify(args.days)}`);
  }
  const config = loadConfig();
  const bundle = buildBundle({ config, receipts: false });
  const to = bundle.meta.today;
  const from = addDays(to, -(days - 1));
  const includeOverlay = !!bundle.meta.includeOverlayDefault;

  const ix = indexCube(bundle.cube);
  const rows = filterCube(ix, { from, to, includeOverlay });
  const m = finalize(sumRows(rows, ix));
  const sessions = filterSessions(bundle.sessions, { from, to, includeOverlay });

  const topModels = rank(rows, ix, (r) => r[ix.d.m], { limit: 5 })
    .filter((g) => g.m.total > 0)
    .map((g) => ({
      model: g.key,
      tokens: g.m.total,
      requests: g.m.req,
      estimatedCostUsd: g.m.costReq > 0 ? g.m.cost : null,
    }));

  return {
    window: { from, to, days },
    timezone: bundle.meta.timezone,
    tokens: {
      total: m.total,
      input: m.in,
      output: m.out,
      cacheRead: m.cr,
      cacheWrite: m.cw,
      cacheRefresh: m.cf,
      reasoning: m.rs,
    },
    // Estimated and measured never merge: one is this machine's price table,
    // the other is what a gateway billed.
    cost: {
      estimatedUsd: m.costReq > 0 ? m.cost : null,
      measuredUsd: m.costMeasured > 0 ? m.costMeasured : null,
      unpricedRequests: m.req - m.costReq,
    },
    requests: m.req,
    sessions: sessions.length,
    topModels,
    lastRefresh: bundle.meta.lastRefresh,
    demoData: !!bundle.meta.demo,
  };
}

/** `tokenflow_budget` — the monthly budget state, computed the way `tokenflow budget` computes it. */
function toolBudget() {
  const config = loadConfig();
  const budget = /** @type {{monthly?:number|null, warnAtPct?:number|null}} */ (config.budget || {});
  if (!(budget.monthly > 0)) {
    return {
      configured: false,
      monthlyUsd: null,
      message: 'No monthly budget is configured. Set one with: tokenflow budget --set 200',
    };
  }
  const { status } = currentStatus({ config });
  const today = new Date().toISOString().slice(0, 10);
  const st = computeBudgetState(status, { monthly: budget.monthly, warnAtPct: budget.warnAtPct }, today);
  const base = {
    configured: true,
    monthlyUsd: budget.monthly,
    warnAtPct: budget.warnAtPct ?? 80,
  };
  if (!st) return { ...base, state: null, message: 'No usage data yet, so there is nothing to measure against the cap.' };
  return {
    ...base,
    state: st.state,
    month: st.monthKey ?? null,
    spentUsd: st.spent ?? null,
    projectedUsd: st.projected ?? null,
    message: st.message ?? st.reason ?? null,
    note: 'spentUsd is estimated from the local price table; projectedUsd is a trend, not a charge.',
  };
}

/** @type {Record<string, (args:any, ctx:any)=>any>} */
const RUNNERS = {
  tokenflow_receipt: toolReceipt,
  tokenflow_policy: toolPolicy,
  tokenflow_usage: toolUsage,
  tokenflow_budget: toolBudget,
};

// ------------------------------------------------------------- the server ---

function serverVersion() {
  return readJson(PACKAGE_JSON, {}).version || '0.0.0';
}

/**
 * A tools/call result. Success carries one text block holding compact JSON, so
 * an agent can parse it; failure carries the message instead, with isError set
 * rather than a JSON-RPC error, because a model can only correct a mistake it
 * is allowed to see.
 */
function toolResult(text, isError) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * `resultType` lives on the BASE `Result` type from 2026-07-28 onward, where
 * the schema says a server implementing that version MUST include it, so it
 * belongs on every result and not only on a tool call. A client on an earlier
 * version must read an absent field as "complete", which is why older
 * negotiations are left alone rather than given a field their schema does not
 * know. Errors are not results and never carry it.
 * Every handler here returns an object or nothing, and nothing becomes the
 * empty result the transport would have written anyway.
 * @param {any} result
 * @param {string} protocolVersion
 */
function withResultType(result, protocolVersion) {
  if (protocolVersion < RESULT_TYPE_FROM) return result;
  return { resultType: 'complete', ...result };
}

/**
 * The JSON-RPC method table.
 * @param {{cwd:string, env:NodeJS.ProcessEnv}} ctx
 */
export function createHandlers(ctx) {
  const state = { protocolVersion: LATEST_PROTOCOL_VERSION };

  /** @type {Record<string, (params?:any, msg?:any)=>any>} */
  const methods = {
    initialize(params) {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      // Accept the client's version when it is one we support. For anything
      // else we answer with our own latest and let the client decide whether
      // to continue, which is the lifecycle rule up to 2025-11-25. The
      // 2026-07-28 lifecycle asks a server to refuse instead, with error
      // -32022 and `data: {supported, requested}`. That is deliberately NOT
      // what happens here: this server is read-only and harmless to talk to,
      // and refusing the handshake would lock out every client that predates
      // the newer rule for no gain. It is a compatibility choice, not an
      // oversight.
      state.protocolVersion = asked && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion: state.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
        instructions: SERVER_INSTRUCTIONS,
      };
    },

    'notifications/initialized'() {
      // Handshake complete. There is nothing to set up: every tool reads the
      // store on demand, so there is no state to warm.
    },

    ping() {
      return {};
    },

    'tools/list'() {
      return { tools: TOOLS };
    },

    async 'tools/call'(params) {
      const name = params.name;
      if (typeof name !== 'string' || !name) throw invalidParams('tools/call needs a "name" string');
      // "Errors in finding the tool" are protocol errors, not tool errors.
      if (!TOOL_NAMES.has(name)) {
        throw invalidParams(`Unknown tool: ${name}`, { available: [...TOOL_NAMES] });
      }
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw invalidParams('tools/call "arguments" must be an object');
      }
      try {
        const payload = await RUNNERS[name](args, ctx);
        return toolResult(JSON.stringify(payload), false);
      } catch (err) {
        const hint = err && err.hint ? ` ${err.hint}` : '';
        return toolResult(`${name} failed: ${err.message}${hint}`, true);
      }
    },
  };

  // One wrapper rather than a line in every handler: `resultType` is a
  // property of every result, so forgetting it in one place is the whole bug.
  // `initialize` sets the negotiated version before this reads it, so its own
  // reply is stamped with the version it just agreed to.
  /** @type {Record<string, (params:any, msg:any)=>any>} */
  const handlers = {};
  for (const [method, fn] of Object.entries(methods)) {
    handlers[method] = async (params, msg) => withResultType(await fn(params, msg), state.protocolVersion);
  }
  return handlers;
}

/**
 * Serve MCP over a pair of streams until the input ends or the output pipe
 * breaks. `tokenflow mcp` passes process.stdin/process.stdout; the tests pass
 * a pair of PassThrough streams and a real child process's pipes.
 *
 * @param {object} [opt]
 * @param {import('node:stream').Readable} [opt.input]
 * @param {import('node:stream').Writable} [opt.output]
 * @param {NodeJS.ProcessEnv} [opt.env]
 * @param {string} [opt.cwd] the directory `tokenflow_receipt` and `tokenflow_policy` default to
 * @param {(message:string)=>void} [opt.log]
 * @returns {Promise<number>} the exit code, always 0: a client hanging up is not a failure
 */
export async function serve(opt = {}) {
  const input = opt.input || process.stdin;
  const output = opt.output || process.stdout;
  const env = opt.env || process.env;
  const cwd = opt.cwd || process.cwd();

  // The store modules resolve TOKENFLOW_HOME from process.env at call time, so
  // a caller-supplied env has to reach them that way. This process exists only
  // to serve one client, so adopting its home for the lifetime of the server
  // is safe, and it keeps `env` from being a parameter that quietly does
  // nothing.
  if (env.TOKENFLOW_HOME && process.env.TOKENFLOW_HOME !== env.TOKENFLOW_HOME) {
    process.env.TOKENFLOW_HOME = env.TOKENFLOW_HOME;
  }

  const log = opt.log || ((message) => {
    try {
      process.stderr.write(`tokenflow mcp: ${message}\n`);
    } catch {
      // stderr is gone too; there is nowhere left to report anything.
    }
  });

  const conn = createConnection({ input, output, handlers: createHandlers({ cwd, env }), log });
  await conn.done;
  return 0;
}

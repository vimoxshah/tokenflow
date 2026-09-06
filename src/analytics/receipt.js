/**
 * Receipts — AI spend attributed to the unit of work, and the guard that
 * watches a session while it is still running.
 *
 * Every other surface in this project answers "how much did I use?" This
 * module answers three questions nobody's console can, because they need the
 * session transcript AND the repository on the same machine:
 *
 *   1. What did this branch / pull request cost?          buildReceipts()
 *   2. Where does the money go inside a session?           splitCost(), sessionStats()
 *   3. Is the session I am in right now getting expensive? evaluateGuard()
 *
 * Two framing rules, stated because the numbers invite the wrong reading:
 *
 *   - "Context" dollars are what it cost to re-send the conversation so far
 *     (cache reads + cache writes). "Work" dollars are fresh input + output.
 *     Context is the CHEAP path per token — a high context share is not waste,
 *     it is the price of a long session. What it tells you is where the lever
 *     is: the marginal cost of a turn is set by how much context it carries.
 *   - A cap simulation reports the dollars ABOVE a threshold. That is an upper
 *     bound on what a guard could have saved, never a saving: some of that work
 *     would have happened anyway in a fresh session.
 *
 * Pure: no Node imports, so the CLI, the server and the browser get identical
 * answers. Attribution is per record, by the branch checked out when the turn
 * ran — a long session that moves across branches is split across them.
 */
import { estimateCost } from '../core/pricing.js';
import { MEASUREMENT } from '../core/schema.js';
import { usd, compact, pct, shortDate } from '../core/units.js';

/** @typedef {ReturnType<typeof import('../core/pricing.js').buildPriceBook>} PriceBook */

export const UNATTRIBUTED = '(unattributed)';

/** Per-request sources. Session-level aggregates (Hermes) would skew per-turn statistics. */
export const PER_REQUEST_SOURCES = ['anthropic', 'openai', 'opencode', 'mock'];

/** A branch that names a unit of work. Detached HEAD and null do not. */
export function isAttributableBranch(br) {
  return typeof br === 'string' && br.length > 0 && br !== 'HEAD';
}

/** Sum of the prompt-side buckets, or null when the source reports none of them. */
export function promptTokens(rec) {
  let t = null;
  for (const k of ['input_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    const v = rec[k];
    if (v !== null && v !== undefined) t = (t === null ? 0 : t) + v;
  }
  return t;
}

/**
 * Split one record's estimated cost into context dollars (cache read + write)
 * and work dollars (fresh input + output), scaled so the two sum exactly to
 * the stored estimate. Null when the record is unpriced or the cost was
 * measured by a gateway (a measured total has no bucket breakdown).
 * @param {object} rec normalized record
 * @param {PriceBook|null} book price book
 * @returns {{context:number|null, work:number|null}}
 */
export function splitCost(rec, book) {
  const cost = rec.estimated_cost;
  if (cost === null || cost === undefined || !(cost >= 0)) return { context: null, work: null };
  if (rec.cost_basis === 'measured' || !book) return { context: null, work: null };
  const opt = { tier: rec.service_tier ?? null };
  const ctx = estimateCost({
    cache_read_tokens: rec.cache_read_tokens,
    cache_write_tokens: rec.cache_write_tokens,
    cache_refresh_tokens: rec.cache_refresh_tokens,
  }, rec.model, rec.provider, book, opt);
  const wk = estimateCost({
    input_tokens: rec.input_tokens,
    output_tokens: rec.output_tokens,
  }, rec.model, rec.provider, book, opt);
  if (ctx.cost === null || wk.cost === null) return { context: null, work: null };
  const sum = ctx.cost + wk.cost;
  if (!(sum > 0)) return { context: 0, work: cost };
  const k = cost / sum;
  return { context: ctx.cost * k, work: wk.cost * k };
}

// ------------------------------------------------------------ accumulate ---

function newAcc(key) {
  return {
    key,
    cost: 0, pricedTurns: 0, unpricedTurns: 0,
    context: 0, work: 0, splitTurns: 0,
    turns: 0, subagentTurns: 0,
    sessions: new Set(), models: new Map(), providers: new Set(), sources: new Set(),
    first: null, last: null, maxPrompt: null,
    tok: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function addRec(acc, rec, split) {
  acc.turns += 1;
  if (rec.category === 'subagent') acc.subagentTurns += 1;
  if (rec.session_id) acc.sessions.add(rec.session_id);
  if (rec.provider) acc.providers.add(rec.provider);
  if (rec.source) acc.sources.add(rec.source);
  const cost = rec.estimated_cost;
  if (cost !== null && cost !== undefined) {
    acc.cost += cost;
    acc.pricedTurns += 1;
    const mf = rec.model_family || rec.model || 'unknown';
    acc.models.set(mf, (acc.models.get(mf) ?? 0) + cost);
  } else {
    acc.unpricedTurns += 1;
  }
  if (split.context !== null) {
    acc.context += split.context;
    acc.work += split.work;
    acc.splitTurns += 1;
  }
  const ts = rec.timestamp;
  if (ts) {
    if (acc.first === null || ts < acc.first) acc.first = ts;
    if (acc.last === null || ts > acc.last) acc.last = ts;
  }
  const p = promptTokens(rec);
  if (p !== null && (acc.maxPrompt === null || p > acc.maxPrompt)) acc.maxPrompt = p;
  addTok(acc.tok, 'input', rec.input_tokens);
  addTok(acc.tok, 'output', rec.output_tokens);
  addTok(acc.tok, 'cacheRead', rec.cache_read_tokens);
  addTok(acc.tok, 'cacheWrite', rec.cache_write_tokens);
}

function addTok(t, k, v) {
  if (v !== null && v !== undefined) t[k] += v;
}

function finish(acc) {
  const models = [...acc.models.entries()]
    .map(([model, cost]) => ({ model, cost, share: acc.cost > 0 ? cost / acc.cost : null }))
    .sort((a, b) => b.cost - a.cost);
  const ctxWork = acc.context + acc.work;
  return {
    key: acc.key,
    cost: acc.pricedTurns > 0 ? acc.cost : null,
    pricedTurns: acc.pricedTurns,
    unpricedTurns: acc.unpricedTurns,
    coverage: acc.turns > 0 ? acc.pricedTurns / acc.turns : null,
    contextCost: acc.splitTurns > 0 ? acc.context : null,
    workCost: acc.splitTurns > 0 ? acc.work : null,
    contextShare: ctxWork > 0 ? acc.context / ctxWork : null,
    turns: acc.turns,
    subagentTurns: acc.subagentTurns,
    subagentShare: acc.turns > 0 ? acc.subagentTurns / acc.turns : null,
    sessions: acc.sessions.size,
    models,
    providers: [...acc.providers].sort(),
    sources: [...acc.sources].sort(),
    first: acc.first,
    last: acc.last,
    maxPrompt: acc.maxPrompt,
    tokens: { ...acc.tok },
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------- receipts ---

/** Default repo identity: what the adapter recorded. The CLI supplies a resolver that sees through worktrees. */
export function defaultRepoOf(rec) {
  return rec.repository || rec.project || null;
}

/**
 * @typedef {{number:number, headRefName:string, additions?:number, deletions?:number,
 *   title?:string, createdAt?:string|null, mergedAt?:string|null, repo?:string|null}} PullRequest
 */

/** Branch names that live forever. A receipt for one is a receipt for a period, not a unit of work. */
export const LONG_LIVED_BRANCH = /^(main|master|trunk|develop|dev|staging|release_staging|production|prod)$/i;

/**
 * Which merged PR a turn on this branch belongs to, given the branch's merged
 * PRs sorted by merge time: the first PR merged at or after the turn, provided
 * the turn came after the previous PR's merge. Work done before a PR is opened
 * still belongs to it — the PR is how that work shipped. Work after the last
 * merge belongs to nothing yet: `after`.
 * @param {string} ts record timestamp
 * @param {PullRequest[]} sorted PRs with mergedAt, ascending
 * @returns {{idx:number}|'after'}
 */
function prSlot(ts, sorted) {
  for (let i = 0; i < sorted.length; i++) {
    // An open PR (no mergedAt) owns everything after the last merge.
    if (!sorted[i].mergedAt || ts <= sorted[i].mergedAt) return { idx: i };
  }
  return 'after';
}

function daysBetween(a, b) {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Attribute spend to (repo, branch), join to pull requests when supplied, and
 * rank each branch against its repository's median.
 *
 * With a merged PR on the branch, the receipt's headline covers the turns up to
 * that merge (work before the PR opened included). Turns after the merge are
 * follow-up on a checkout that kept the old branch name; they are reported
 * beside the receipt as `prWindow.afterMerge`, never inside it. A branch with
 * several merged PRs attributes each turn to the PR it shipped in; the receipt
 * shows the latest and counts the earlier ones.
 *
 * @param {Iterable<object>} records normalized records (any measurement; only primary count)
 * @param {{book?:PriceBook|null, prs?:PullRequest[], repoOf?:(rec:object)=>string|null,
 *   minTurns?:number, automated?:RegExp|null}} [opt]
 */
export function buildReceipts(records, opt = {}) {
  const b = createReceiptBuilder(opt);
  for (const rec of records) b.add(rec);
  return b.finish();
}

/**
 * The streaming form of buildReceipts(): feed records one at a time (a store
 * scan never has to materialize every record), then finish(). Same result.
 * @param {{book?:PriceBook|null, prs?:PullRequest[], repoOf?:(rec:object)=>string|null,
 *   minTurns?:number, automated?:RegExp|null}} [opt]
 */
export function createReceiptBuilder(opt = {}) {
  const book = opt.book ?? null;
  const repoOf = opt.repoOf || defaultRepoOf;
  const minTurns = opt.minTurns ?? 1;
  const prs = opt.prs || [];
  const automated = opt.automated ?? null;

  // PRs per (repo-or-any, branch), merged ones sorted by merge time.
  const prIndex = new Map();
  for (const p of prs) {
    const k = `${p.repo || ''} ${p.headRefName}`;
    if (!prIndex.has(k)) prIndex.set(k, []);
    prIndex.get(k).push(p);
  }
  // Merged PRs by merge time, then any open PR last (it owns what follows the last merge).
  for (const list of prIndex.values()) list.sort((a, b) => String(a.mergedAt || '9999') < String(b.mergedAt || '9999') ? -1 : 1);
  const prsFor = (repo, branch) => prIndex.get(`${repo} ${branch}`) || prIndex.get(` ${branch}`) || null;

  const repos = new Map();
  let seen = 0;

  function add(rec) {
    if (rec.measurement !== MEASUREMENT.PRIMARY) return;
    seen += 1;
    const repo = repoOf(rec) || 'unknown';
    let R = repos.get(repo);
    if (!R) {
      R = { repo, branches: new Map(), unattributed: newAcc(UNATTRIBUTED) };
      repos.set(repo, R);
    }
    const br = rec.git_branch;
    const split = splitCost(rec, book);
    if (!isAttributableBranch(br)) { addRec(R.unattributed, rec, split); return; }

    let B = R.branches.get(br);
    if (!B) {
      const list = prsFor(repo, br) || [];
      B = { all: newAcc(br), prs: list, perPr: list.map(() => newAcc(br)), after: newAcc(br), beforeOpened: newAcc(br) };
      R.branches.set(br, B);
    }
    addRec(B.all, rec, split);
    if (B.prs.length) {
      const slot = prSlot(rec.timestamp, B.prs);
      if (slot === 'after') {
        addRec(B.after, rec, split);
      } else {
        addRec(B.perPr[slot.idx], rec, split);
        const created = B.prs[slot.idx].createdAt;
        if (slot.idx === B.prs.length - 1 && created && rec.timestamp < created) addRec(B.beforeOpened, rec, split);
      }
    }
  }

  return { add, finish: () => finishReceipts(repos, { prs, minTurns, automated, seen }) };
}

function finishReceipts(repos, { prs, minTurns, automated, seen }) {
  const out = [];
  const seenBranches = new Set();
  let total = 0;
  let attributed = 0;
  for (const R of repos.values()) {
    const branches = [];
    for (const B of R.branches.values()) {
      const whole = finish(B.all);
      if (whole.turns < minTurns) continue;
      let b;
      if (B.prs.length) {
        const last = B.prs.length - 1;
        const pr = B.prs[last];
        b = finish(B.perPr[last]);
        const after = finish(B.after);
        const before = finish(B.beforeOpened);
        let priorCost = 0;
        let priorTurns = 0;
        for (let i = 0; i < last; i++) { const f = finish(B.perPr[i]); priorCost += f.cost ?? 0; priorTurns += f.turns; }
        const adds = pr.additions ?? null;
        const dels = pr.deletions ?? null;
        const lines = adds !== null && dels !== null ? adds + dels : null;
        b.pr = { number: pr.number, title: pr.title ?? null, additions: adds, deletions: dels, createdAt: pr.createdAt ?? null, mergedAt: pr.mergedAt ?? null };
        b.changedLines = lines;
        b.costPer100Lines = lines !== null && lines > 0 && b.cost !== null ? (b.cost / lines) * 100 : null;
        b.branch = { cost: whole.cost, turns: whole.turns, sessions: whole.sessions };
        b.prWindow = {
          createdAt: pr.createdAt ?? null,
          mergedAt: pr.mergedAt ?? null,
          beforeOpened: { cost: before.cost, turns: before.turns, days: pr.createdAt && before.first ? daysBetween(before.first, pr.createdAt) : null },
          afterMerge: { cost: after.cost, turns: after.turns, sessions: after.sessions, last: after.last },
          priorPrs: { count: last, cost: priorCost, turns: priorTurns },
        };
      } else {
        b = whole;
        b.pr = null;
        b.changedLines = null;
        b.costPer100Lines = null;
        b.branch = null;
        b.prWindow = null;
      }
      b.longLived = LONG_LIVED_BRANCH.test(b.key);
      branches.push(b);
    }
    const prFor = new Map();
    for (const p of prs) {
      if (p.repo && p.repo !== R.repo) continue;
      prFor.set(p.headRefName, p);
    }
    for (const b of branches) seenBranches.add(b.key);
    const priced = branches.filter((b) => b.cost !== null && b.cost > 0).map((b) => b.cost);
    const med = median(priced);
    for (const b of branches) b.vsMedian = med !== null && med > 0 && b.cost !== null ? b.cost / med : null;
    branches.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));

    const un = finish(R.unattributed);
    // Repo totals count every turn on every branch, including turns after a merge.
    const branchTotal = branches.reduce((a, b) => a + ((b.branch ? b.branch.cost : b.cost) ?? 0), 0);
    const repoCost = branchTotal + (un.cost ?? 0);
    total += repoCost;
    attributed += branchTotal;

    const matched = branches.filter((b) => b.pr).length;
    const unmatched = [];
    for (const p of prs) {
      if (p.repo && p.repo !== R.repo) continue;
      if (!R.branches.has(p.headRefName)) unmatched.push({ number: p.number, headRefName: p.headRefName, automated: automated ? automated.test(p.headRefName) : null });
    }

    out.push({
      repo: R.repo,
      cost: repoCost > 0 ? repoCost : null,
      medianBranchCost: med,
      branches,
      unattributed: un,
      prs: { supplied: prFor.size, matched, unmatched },
    });
  }
  out.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));

  return {
    repos: out,
    totals: {
      cost: total > 0 ? total : null,
      attributedCost: attributed,
      unattributedCost: total - attributed,
      attributedShare: total > 0 ? attributed / total : null,
      branches: seenBranches.size,
      records: seen,
    },
  };
}

// ---------------------------------------------------------------- sessions ---

/** @type {[string, number, number][]} */
const TURN_BUCKETS = [
  ['1–50', 0, 50],
  ['51–200', 50, 200],
  ['201–1000', 200, 1000],
  ['1000+', 1000, Infinity],
];

/**
 * Where the money goes across sessions: the concentration curve, the split
 * between context and work dollars, the marginal cost of a turn as a session
 * ages, and the dollars sitting above each candidate per-session cap.
 *
 * Per-turn statistics use per-request sources only; a source that reports one
 * row per session would make every "turn" look enormous.
 *
 * @param {Iterable<object>} records
 * @param {{book?:PriceBook|null, caps?:number[], perRequestSources?:string[]}} [opt]
 */
export function sessionStats(records, opt = {}) {
  const book = opt.book ?? null;
  const caps = opt.caps || [50, 100, 200, 500];
  const perRequest = new Set(opt.perRequestSources || PER_REQUEST_SOURCES);

  const sessions = new Map();
  let total = 0;
  let context = 0;
  let work = 0;
  let splitTurns = 0;
  const bucketCosts = TURN_BUCKETS.map(() => []);
  let bigTurns = 0;
  let bigTurnCost = 0;
  let perReqTurns = 0;
  let perReqCost = 0;
  const seenSources = new Set();

  for (const rec of records) {
    if (rec.measurement !== MEASUREMENT.PRIMARY) continue;
    const cost = rec.estimated_cost;
    const priced = cost !== null && cost !== undefined;
    if (priced) total += cost;
    const s = splitCost(rec, book);
    if (s.context !== null) { context += s.context; work += s.work; splitTurns += 1; }

    const key = rec.session_id || `~${rec.source}`;
    let e = sessions.get(key);
    if (!e) {
      e = { cost: 0, turns: 0, branches: new Set(), first: rec.timestamp, last: rec.timestamp, perRequest: perRequest.has(rec.source), turnCosts: [] };
      sessions.set(key, e);
    }
    e.turns += 1;
    if (priced) e.cost += cost;
    if (isAttributableBranch(rec.git_branch)) e.branches.add(rec.git_branch);
    if (rec.timestamp < e.first) e.first = rec.timestamp;
    if (rec.timestamp > e.last) e.last = rec.timestamp;
    if (e.perRequest && priced) {
      seenSources.add(rec.source);
      e.turnCosts.push(cost);
      perReqTurns += 1;
      perReqCost += cost;
      const p = promptTokens(rec);
      if (p !== null && p > 200_000) { bigTurns += 1; bigTurnCost += cost; }
    }
  }

  for (const e of sessions.values()) {
    if (!e.perRequest) continue;
    e.turnCosts.forEach((c, i) => {
      const b = TURN_BUCKETS.findIndex(([, lo, hi]) => i >= lo && i < hi);
      if (b >= 0) bucketCosts[b].push(c);
    });
  }

  const all = [...sessions.values()];
  const costs = all.map((e) => e.cost).sort((a, b) => b - a);
  const n = costs.length;
  const shareOfTop = (frac) => {
    if (!n || !(total > 0)) return null;
    const k = Math.max(1, Math.floor(n * frac));
    return costs.slice(0, k).reduce((a, b) => a + b, 0) / total;
  };
  const capTable = caps.map((cap) => {
    let over = 0;
    let above = 0;
    for (const c of costs) if (c > cap) { over += 1; above += c - cap; }
    return { cap, sessionsOver: over, costAbove: above, shareAbove: total > 0 ? above / total : null };
  });

  return {
    sessions: n,
    totalCost: total > 0 ? total : null,
    contextCost: splitTurns > 0 ? context : null,
    workCost: splitTurns > 0 ? work : null,
    contextShare: context + work > 0 ? context / (context + work) : null,
    medianSessionCost: median(costs),
    p90SessionCost: n ? costs[Math.floor(n * 0.1)] : null,
    top1pctShare: shareOfTop(0.01),
    top10pctShare: shareOfTop(0.10),
    multiBranchSessions: all.filter((e) => e.branches.size > 1).length,
    capTable,
    marginalByTurnIndex: TURN_BUCKETS.map(([label], i) => ({ turns: label, medianCostPerTurn: median(bucketCosts[i]), samples: bucketCosts[i].length })),
    largePromptTurns: {
      threshold: 200_000,
      turns: bigTurns,
      turnShare: perReqTurns > 0 ? bigTurns / perReqTurns : null,
      cost: bigTurnCost,
      costShare: perReqCost > 0 ? bigTurnCost / perReqCost : null,
      sources: [...seenSources].sort(),
    },
  };
}

// ------------------------------------------------------------------- guard ---

/**
 * @typedef {Object} GuardPolicy
 * @property {number|null} [warnCostUsd]        session spend at which to warn
 * @property {number|null} [maxCostUsd]         session spend at which to block
 * @property {number|null} [warnContextTokens]  prompt size (tokens) at which to warn
 * @property {number|null} [maxContextTokens]   prompt size at which to block
 * @property {number|null} [warnMarginalUsd]    median cost of the last turns at which to warn
 */

const RECENT_TURNS = 10;

/**
 * Judge one running session. Every threshold comes from the policy the user
 * declared; with none declared the verdict is informational and never blocks.
 *
 * @param {object[]} sessionRecords normalized records of ONE session, any order
 * @param {GuardPolicy} [policy]
 * @param {PriceBook|null} [book]
 */
export function evaluateGuard(sessionRecords, policy = {}, book = null) {
  const recs = sessionRecords
    .filter((r) => r.measurement === MEASUREMENT.PRIMARY)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const acc = newAcc('session');
  for (const r of recs) addRec(acc, r, splitCost(r, book));
  const f = finish(acc);

  const last = recs.length ? recs[recs.length - 1] : null;
  const contextTokens = last ? promptTokens(last) : null;
  const recent = recs.slice(-RECENT_TURNS).map((r) => r.estimated_cost).filter((c) => c !== null && c !== undefined);
  const marginal = median(recent);

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const p = {
    warnCostUsd: num(policy.warnCostUsd),
    maxCostUsd: num(policy.maxCostUsd),
    warnContextTokens: num(policy.warnContextTokens),
    maxContextTokens: num(policy.maxContextTokens),
    warnMarginalUsd: num(policy.warnMarginalUsd),
  };

  const reasons = [];
  let level = 'ok';
  const cost = f.cost;
  if (p.maxCostUsd !== null && cost !== null && cost >= p.maxCostUsd) {
    level = 'block';
    reasons.push(`session spend ${usd(cost)} has reached the declared cap of ${usd(p.maxCostUsd)}`);
  } else if (p.warnCostUsd !== null && cost !== null && cost >= p.warnCostUsd) {
    level = 'warn';
    reasons.push(`session spend ${usd(cost)} passed the warning level of ${usd(p.warnCostUsd)}`);
  }
  if (p.maxContextTokens !== null && contextTokens !== null && contextTokens >= p.maxContextTokens) {
    level = 'block';
    reasons.push(`the prompt now carries ${compact(contextTokens)} tokens, at or above the declared cap of ${compact(p.maxContextTokens)}`);
  } else if (p.warnContextTokens !== null && contextTokens !== null && contextTokens >= p.warnContextTokens) {
    if (level === 'ok') level = 'warn';
    reasons.push(`the prompt now carries ${compact(contextTokens)} tokens (warning level ${compact(p.warnContextTokens)})`);
  }
  if (p.warnMarginalUsd !== null && marginal !== null && marginal >= p.warnMarginalUsd) {
    if (level === 'ok') level = 'warn';
    reasons.push(`each of the last ${recent.length} turns cost about ${usd(marginal)} (warning level ${usd(p.warnMarginalUsd)})`);
  }

  const declared = Object.values(p).some((v) => v !== null);
  let suggestion = null;
  if (level !== 'ok') {
    suggestion = contextTokens !== null && contextTokens > 100_000
      ? 'Most of each turn now pays to re-send earlier context. Compact, or start a fresh session with a short brief, and the per-turn cost drops with it.'
      : 'Consider finishing this task in a fresh session with a short brief, or narrowing the remaining scope.';
  }

  return {
    level,
    declared,
    reasons,
    suggestion,
    cost,
    coverage: f.coverage,
    turns: f.turns,
    subagentTurns: f.subagentTurns,
    contextTokens,
    marginalCostPerTurn: marginal,
    recentTurns: recent.length,
    contextShare: f.contextShare,
    models: f.models,
    first: f.first,
    last: f.last,
  };
}

// -------------------------------------------------------------- rendering ---

const money = (v) => (v === null || v === undefined ? '—' : usd(v));
const share = (v) => (v === null || v === undefined ? '—' : pct(v, 0));
const times = (v) => (v === null || v === undefined ? '—' : `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`);

/**
 * A receipt shaped for a pull-request comment.
 * @param {object} b one branch receipt from buildReceipts()
 * @param {{repo?:string, pricingVersion?:string}} [opt]
 */
export function renderReceiptMarkdown(b, opt = {}) {
  const L = [];
  const title = b.pr ? `\`${b.key}\` · PR #${b.pr.number}` : `\`${b.key}\``;
  L.push(`### 🧾 AI cost receipt — ${title}`);
  if (opt.repo) L.push(`_${opt.repo}_`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  const costLine = b.cost === null
    ? '— (no priced turns)'
    : `**${money(b.cost)}**${b.contextShare !== null ? ` · ${share(b.contextShare)} re-sent context, ${share(1 - b.contextShare)} fresh work` : ''}`;
  L.push(`| Estimated spend | ${costLine} |`);
  L.push(`| Sessions · turns | ${b.sessions} · ${b.turns}${b.subagentShare !== null && b.subagentTurns > 0 ? ` (${share(b.subagentShare)} subagent)` : ''} |`);
  if (b.models.length) {
    L.push(`| Models | ${b.models.slice(0, 3).map((m) => `${m.model} ${share(m.share)}`).join(', ')}${b.models.length > 3 ? ', …' : ''} |`);
  }
  if (b.pr && b.changedLines !== null) {
    L.push(`| Changed lines | +${b.pr.additions} / −${b.pr.deletions}${b.costPer100Lines !== null ? ` → ${money(b.costPer100Lines)} per 100 lines` : ''} |`);
  }
  if (b.vsMedian !== null) L.push(`| vs this repo's median branch | ${times(b.vsMedian)} |`);
  if (b.maxPrompt !== null) L.push(`| Largest prompt | ${compact(b.maxPrompt)} tokens |`);
  if (b.first && b.last) L.push(`| Window | ${shortDate(b.first.slice(0, 10))} → ${shortDate(b.last.slice(0, 10))}${b.prWindow && b.prWindow.mergedAt ? ` (merged ${shortDate(b.prWindow.mergedAt.slice(0, 10))})` : b.pr ? ' (PR open)' : ''} |`);
  const w = b.prWindow;
  if (w && w.afterMerge.turns > 0) {
    L.push(`| After the merge, same branch | ${money(w.afterMerge.cost)} · ${w.afterMerge.sessions} session(s) · ${w.afterMerge.turns} turn(s) — follow-up on a checkout that kept this branch name; **not** counted above |`);
  }
  L.push('');
  const notes = [];
  if (w && w.beforeOpened.turns > 0 && w.beforeOpened.days !== null && w.beforeOpened.days > 14) {
    notes.push(`${share(b.cost ? (w.beforeOpened.cost ?? 0) / b.cost : null)} of the total predates the PR by up to ${Math.round(w.beforeOpened.days)} days; on a long-lived branch that is earlier work, not this PR's.`);
  }
  if (b.longLived) notes.push(`\`${b.key}\` is a long-lived branch: this is a receipt for a period of work on it, not for one change.`);
  if (w && w.priorPrs.count > 0) notes.push(`${w.priorPrs.count} earlier merged PR(s) on this branch hold another ${money(w.priorPrs.cost)}.`);
  if (b.unpricedTurns > 0) notes.push(`${b.unpricedTurns} turn(s) used a model with no configured price and are not in the total.`);
  notes.push(`Estimated locally by TokenFlow${opt.pricingVersion ? ` (price table ${opt.pricingVersion})` : ''} from the session logs already on this machine. No prompt or code content was read.`);
  L.push(`<sub>${notes.join(' ')}</sub>`);
  return L.join('\n');
}

/**
 * Terminal table of branch receipts for one or more repositories.
 * @param {ReturnType<typeof buildReceipts>} result
 * @param {{top?:number}} [opt]
 */
export function renderReceiptsTable(result, opt = {}) {
  const top = opt.top ?? 20;
  const L = [];
  for (const R of result.repos) {
    L.push(`${R.repo}  —  ${money(R.cost)} across ${R.branches.length} branch(es)${R.medianBranchCost !== null ? `, median branch ${money(R.medianBranchCost)}` : ''}`);
    if (R.prs.supplied) L.push(`  pull requests: ${R.prs.matched} of ${R.prs.supplied} matched to local sessions`);
    const hdr = `  ${'cost'.padStart(10)}  ${'ctx%'.padStart(4)}  ${'sess'.padStart(4)}  ${'turns'.padStart(6)}  ${'sub%'.padStart(4)}  ${'×med'.padStart(5)}  ${'PR'.padStart(5)}  ${'lines'.padStart(7)}  ${'after-merge'.padStart(11)}  branch`;
    L.push(hdr);
    for (const b of R.branches.slice(0, top)) {
      const after = b.prWindow && b.prWindow.afterMerge.turns > 0 ? money(b.prWindow.afterMerge.cost) : (b.pr ? '—' : '');
      L.push(`  ${money(b.cost).padStart(10)}  ${share(b.contextShare).padStart(4)}  ${String(b.sessions).padStart(4)}  ${String(b.turns).padStart(6)}  ${share(b.subagentShare).padStart(4)}  ${times(b.vsMedian).padStart(5)}  ${(b.pr ? `#${b.pr.number}` : '—').padStart(5)}  ${(b.changedLines === null ? '—' : String(b.changedLines)).padStart(7)}  ${after.padStart(11)}  ${b.key}${b.longLived ? '  (long-lived)' : ''}`);
    }
    if (R.branches.length > top) L.push(`  … ${R.branches.length - top} more`);
    const afterTotal = R.branches.reduce((a, b) => a + (b.prWindow ? (b.prWindow.afterMerge.cost ?? 0) : 0), 0);
    if (afterTotal > 0) L.push(`  spent after a merge on a branch that kept its name (not in any PR above): ${money(afterTotal)}`);
    const un = R.unattributed;
    if (un.turns > 0) L.push(`  unattributed (detached HEAD / no branch): ${money(un.cost)} · ${un.sessions} session(s) · ${un.turns} turn(s)`);
    if (R.prs.unmatched.length) {
      const auto = R.prs.unmatched.filter((u) => u.automated === true).length;
      const rest = R.prs.unmatched.length - auto;
      L.push(`  PRs with no local session: ${R.prs.unmatched.length}${auto ? ` (${auto} automated, ${rest} unexplained)` : ''}`);
    }
    L.push('');
  }
  const t = result.totals;
  if (t.cost !== null) L.push(`Total ${money(t.cost)} · attributed to a branch ${share(t.attributedShare)} · ${t.branches} branch(es)`);
  return L.join('\n');
}

/**
 * @param {ReturnType<typeof sessionStats>} s
 */
export function renderSessionStats(s) {
  const L = [];
  L.push(`Sessions: ${s.sessions.toLocaleString('en-US')}   estimated spend ${money(s.totalCost)}`);
  if (s.contextShare !== null) {
    L.push(`  context (re-sent prompt) ${money(s.contextCost)} = ${share(s.contextShare)}   fresh input + output ${money(s.workCost)} = ${share(1 - s.contextShare)}`);
  }
  L.push(`  median session ${money(s.medianSessionCost)} · p90 ${money(s.p90SessionCost)} · top 1% of sessions = ${share(s.top1pctShare)} of spend · top 10% = ${share(s.top10pctShare)}`);
  L.push(`  sessions that moved across branches: ${s.multiBranchSessions}`);
  L.push('');
  L.push('Median cost of a turn, by how deep into the session it is (per-request sources only):');
  for (const m of s.marginalByTurnIndex) L.push(`  turns ${String(m.turns).padEnd(9)} ${money(m.medianCostPerTurn).padStart(8)}   (n=${m.samples.toLocaleString('en-US')})`);
  const lp = s.largePromptTurns;
  if (lp.turnShare !== null) {
    L.push(`  turns carrying >${compact(lp.threshold)} prompt tokens: ${share(lp.turnShare)} of turns, ${share(lp.costShare)} of their spend   [sources: ${lp.sources.join(', ')}]`);
  }
  L.push('');
  L.push('Dollars above a per-session cap (an upper bound on what a guard could have held back, not a saving):');
  for (const c of s.capTable) L.push(`  cap ${money(c.cap).padStart(6)}: ${String(c.sessionsOver).padStart(5)} session(s) over · ${money(c.costAbove).padStart(10)} above the cap · ${share(c.shareAbove)} of spend`);
  return L.join('\n');
}

/** Human-readable guard verdict. */
export function renderGuard(v) {
  const L = [];
  const tag = v.level === 'block' ? 'BLOCK' : v.level === 'warn' ? 'WARN' : 'ok';
  L.push(`[${tag}] session spend ${money(v.cost)}${v.coverage !== null && v.coverage < 1 ? ` (priced ${share(v.coverage)} of turns)` : ''} · ${v.turns} turn(s)${v.subagentTurns ? ` (${v.subagentTurns} subagent)` : ''}`);
  if (v.contextTokens !== null) L.push(`  prompt now carries ${compact(v.contextTokens)} tokens · median cost of the last ${v.recentTurns} turn(s) ${money(v.marginalCostPerTurn)}${v.contextShare !== null ? ` · ${share(v.contextShare)} of spend re-sent context` : ''}`);
  if (v.models.length) L.push(`  models: ${v.models.slice(0, 3).map((m) => `${m.model} ${share(m.share)}`).join(', ')}`);
  for (const r of v.reasons) L.push(`  ! ${r}`);
  if (v.suggestion) L.push(`  → ${v.suggestion}`);
  if (!v.declared) L.push('  (no guard thresholds declared — informational only; see `tokenflow guard --set`)');
  return L.join('\n');
}

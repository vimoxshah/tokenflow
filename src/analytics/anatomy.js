/**
 * Session anatomy: where one session's money went, turn by turn.
 *
 * The rest of the analytics layer works on the pre-aggregated cube, which has
 * no notion of a turn. This module works on the request-level records of ONE
 * session, which is the only place the shape of a session is visible: the turn
 * where the context stopped being cheap, the block of subagent turns that
 * doubled the bill, the point where per-turn cost stepped up and stayed there.
 *
 * Pure: no Node imports and no DOM, so the server route, the browser view and
 * the tests all get identical answers. Cost is estimated from the same price
 * book the Cost tab prices with (core/pricing.js), never from a stored total,
 * so a turn whose model is unpriced reports null and is counted as unpriced —
 * it never reports 0.
 */
import { estimateCost } from '../core/pricing.js';

/** @typedef {ReturnType<typeof import('../core/pricing.js').buildPriceBook>} PriceBook */

/** Turns of history on each side of a candidate step. */
export const STEP_WINDOW = 20;
/** How much higher the next window's median must be to count as a step. */
export const STEP_RATIO = 2;
/** …and by how many dollars, so a step from $0.0001 to $0.0004 is not news. */
export const STEP_MIN_ABS = 0.02;

/**
 * One turn of a session, priced.
 *
 * @typedef {object} Turn
 * @property {number} index 0-based position in the session
 * @property {number} turn 1-based turn number — what the UI shows
 * @property {string|null} ts ISO timestamp
 * @property {string|null} model
 * @property {string|null} provider
 * @property {string|null} source adapter id
 * @property {string|null} category record category ('main', 'subagent', …)
 * @property {boolean} subagent true when the category marks a subagent turn
 * @property {string|null} agent agent name the source recorded, if any
 * @property {string|null} parent parent link the source recorded, if any
 * @property {string|null} requestId
 * @property {number|null} cost estimated dollars for this turn; null when unpriced
 * @property {number|null} cumulative running total over the priced turns so far
 * @property {number|null} input fresh input tokens
 * @property {number|null} cacheRead
 * @property {number|null} cacheWrite
 * @property {number|null} cacheRefresh subset of cacheWrite
 * @property {number|null} output
 * @property {number|null} reasoning subset of output
 * @property {number|null} promptTokens input + cache read + cache write
 * @property {number|null} cacheReadShare cache read / prompt tokens
 */

/**
 * Price every turn of a session and carry the running total.
 *
 * Records are sorted by timestamp first, so a caller that read them out of a
 * shard in file order still gets a chronological series. `cumulative` stays
 * null until the first priced turn and then holds flat across unpriced ones:
 * an unknown turn must not look like a free one.
 *
 * @param {object[]} records slimmed records, or anything with the same fields
 * @param {PriceBook|null} book the price book the Cost tab uses
 * @returns {Turn[]}
 */
export function turnSeries(records, book) {
  const rows = [...(records || [])].sort(byTimestamp);
  const out = [];
  let cumulative = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const input = num(r.input_tokens);
    const cacheRead = num(r.cache_read_tokens);
    const cacheWrite = num(r.cache_write_tokens);
    const cacheRefresh = num(r.cache_refresh_tokens);
    const output = num(r.output_tokens);
    const reasoning = num(r.reasoning_tokens);
    const cost = priceOf(r, book, { input, cacheRead, cacheWrite, cacheRefresh, output });
    if (cost !== null) cumulative = (cumulative === null ? 0 : cumulative) + cost;
    const promptTokens = sumOrNull([input, cacheRead, cacheWrite]);
    out.push({
      index: i,
      turn: i + 1,
      ts: tsOf(r),
      model: str(r.model),
      provider: str(r.provider),
      source: str(r.source),
      category: str(r.category),
      subagent: r.category === 'subagent',
      agent: str(r.agent),
      parent: parentOf(r),
      requestId: str(r.request_id),
      cost,
      cumulative,
      input,
      cacheRead,
      cacheWrite,
      cacheRefresh,
      output,
      reasoning,
      promptTokens,
      cacheReadShare: promptTokens !== null && promptTokens > 0 && cacheRead !== null
        ? cacheRead / promptTokens
        : null,
    });
  }
  return out;
}

/**
 * Roll a priced series up into the numbers a header needs.
 * @param {Turn[]} series
 */
export function summarizeTurns(series) {
  const turns = series.length;
  let cost = null;
  let priced = 0;
  let subagentTurns = 0;
  let subagentCost = null;
  let cacheRead = 0;
  let prompt = 0;
  let promptTurns = 0;
  for (const t of series) {
    if (t.cost !== null) {
      cost = (cost === null ? 0 : cost) + t.cost;
      priced++;
      if (t.subagent) subagentCost = (subagentCost === null ? 0 : subagentCost) + t.cost;
    }
    if (t.subagent) subagentTurns++;
    if (t.promptTokens !== null) {
      prompt += t.promptTokens;
      promptTurns++;
      if (t.cacheRead !== null) cacheRead += t.cacheRead;
    }
  }
  const first = series.find((t) => t.promptTokens !== null) || null;
  let last = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].promptTokens !== null) { last = series[i]; break; }
  }
  return {
    turns,
    priced,
    unpriced: turns - priced,
    cost,
    subagentTurns,
    subagentCost,
    subagentShare: cost !== null && cost > 0 && subagentCost !== null ? subagentCost / cost : null,
    avgCost: priced > 0 && cost !== null ? cost / priced : null,
    cacheReadShare: prompt > 0 ? cacheRead / prompt : null,
    promptFirst: first ? first.promptTokens : null,
    promptLast: last ? last.promptTokens : null,
    promptPeak: promptTurns ? Math.max(...series.filter((t) => t.promptTokens !== null).map((t) => t.promptTokens)) : null,
    from: series.length ? series[0].ts : null,
    to: series.length ? series[series.length - 1].ts : null,
  };
}

/**
 * The turn where per-turn cost stepped up and stayed up.
 *
 * A rolling median of the previous 20 turns against the next 20: robust to the
 * one enormous turn that a mean would chase, and blind to a spike that comes
 * straight back down, which is the point — a step is a change in the regime,
 * not an outlier. Both windows must be full AND at least half of each window
 * must be priced, so a session shorter than 40 turns has no answer, and a
 * window holding one priced turn among nineteen unknown ones is not allowed to
 * pass a one-point "median" off as a regime.
 *
 * @param {Turn[]} series from {@link turnSeries}
 * @param {{window?:number, ratio?:number, minAbs?:number, minPriced?:number}} [opt]
 * @returns {{index:number, turn:number, from:number, to:number, ratio:number, step:number, window:number}|null}
 */
export function detectStep(series, opt = {}) {
  const w = opt.window ?? STEP_WINDOW;
  const minRatio = opt.ratio ?? STEP_RATIO;
  const minAbs = opt.minAbs ?? STEP_MIN_ABS;
  const minPriced = Math.min(w, opt.minPriced ?? Math.ceil(w / 2));
  const costs = (series || []).map((t) => t.cost);
  for (let i = w; i + w <= costs.length; i++) {
    const lhs = costs.slice(i - w, i);
    const rhs = costs.slice(i, i + w);
    if (priced(lhs) < minPriced || priced(rhs) < minPriced) continue;
    const before = median(lhs);
    const after = median(rhs);
    if (before === null || after === null) continue;
    const step = after - before;
    if (step < minAbs) continue;
    // A rise from a measured zero has no finite ratio; the absolute test above
    // is what keeps it honest.
    const ratio = before > 0 ? after / before : Infinity;
    if (ratio < minRatio) continue;
    return { index: i, turn: i + 1, from: before, to: after, ratio, step, window: w };
  }
  return null;
}

/**
 * How the session fanned out into subagents.
 *
 * No adapter records a parent link today — Claude Code marks a sidechain,
 * OpenCode and Hermes fold their parent id into `category` — so the honest
 * fallback is position: contiguous runs of subagent turns, labelled as
 * grouped so the UI never presents a guess as a hierarchy. If a source ever
 * does carry a link, the tree is built from it instead.
 *
 * Pass the turns from {@link turnSeries} to get cost shares; raw records with
 * no cost fall back to a share of turns, which `shareBasis` reports.
 *
 * @param {(Turn|object)[]} records turns or slimmed records, in order
 * @returns {{grouped:boolean, shareBasis:'cost'|'turns', groups:object[], roots:object[],
 *            turns:number, subagentTurns:number, cost:number|null, subagentCost:number|null}}
 */
export function fanOut(records) {
  const rows = [...(records || [])].sort(byTimestamp);
  const total = totals(rows);
  const linked = rows.some((r) => parentOf(r) !== null);
  const base = {
    turns: rows.length,
    subagentTurns: rows.filter(isSubagent).length,
    cost: total.cost,
    subagentCost: total.subagentCost,
    shareBasis: /** @type {'cost'|'turns'} */ (total.cost !== null && total.cost > 0 ? 'cost' : 'turns'),
  };
  const shareOf = (cost, turns) => {
    if (base.shareBasis === 'cost') return cost === null ? null : cost / /** @type {number} */ (base.cost);
    return base.turns > 0 ? turns / base.turns : null;
  };

  if (!linked) {
    const groups = contiguousGroups(rows).map((g) => ({ ...g, share: shareOf(g.cost, g.turns) }));
    return { ...base, grouped: true, groups, roots: [] };
  }
  return { ...base, grouped: false, groups: [], roots: buildTree(rows, shareOf) };
}

/**
 * Sources that write one row per session rather than one per request. Hermes
 * is the only one: its `messages.token_count` is unpopulated, so the finest
 * honest granularity it can offer is session x model (see its adapter header).
 *
 * This is a deny-list on purpose. receipt.js keeps the mirror-image allow-list
 * (PER_REQUEST_SOURCES) because a statistic that would be *skewed* by an
 * aggregate row should only trust sources it knows. Here the cost of being
 * wrong runs the other way: an unlisted per-request adapter (otel, generic, or
 * the next one written) must not lose its charts to a card claiming it reports
 * one row per session. So the unknown case fails open to 'per-turn', where the
 * worst outcome is a chart of one point rather than a false statement.
 */
export const SESSION_LEVEL_SOURCES = ['hermes'];

/**
 * 'session-level' when every record comes from a source that writes one row
 * per session, 'per-turn' otherwise, including when the source is unknown.
 *
 * @param {object[]} records
 * @returns {'per-turn'|'session-level'}
 */
export function sessionKind(records) {
  const rows = records || [];
  if (!rows.length) return 'per-turn';
  let sawAggregate = false;
  for (const r of rows) {
    const so = str(r.source);
    if (so === null) continue;
    if (!SESSION_LEVEL_SOURCES.includes(so)) return 'per-turn';
    sawAggregate = true;
  }
  return sawAggregate ? 'session-level' : 'per-turn';
}

// ------------------------------------------------------------------ internals

/** Contiguous runs of subagent turns, and the main-agent runs between them. */
function contiguousGroups(rows) {
  const out = [];
  let cur = null;
  rows.forEach((r, i) => {
    const kind = isSubagent(r) ? 'subagent' : 'main';
    if (!cur || cur.kind !== kind) {
      cur = {
        kind,
        key: `${kind}-${out.length + 1}`,
        startTurn: i + 1,
        endTurn: i + 1,
        turns: 0,
        cost: null,
        agents: [],
      };
      out.push(cur);
    }
    cur.endTurn = i + 1;
    cur.turns++;
    const c = costOf(r);
    if (c !== null) cur.cost = (cur.cost === null ? 0 : cur.cost) + c;
    const a = str(r.agent);
    if (a !== null && !cur.agents.includes(a)) cur.agents.push(a);
  });
  return out;
}

/**
 * A tree over the parent links a source recorded. One node per distinct parent
 * value: the turns that name it as their parent. A node nests under the group
 * that owns the turn its key points at, so a subagent that spawned its own
 * subagent nests two deep.
 */
function buildTree(rows, shareOf) {
  const byKey = new Map();
  const ownerOf = new Map();
  for (const r of rows) {
    const id = linkIdOf(r);
    if (id !== null && !ownerOf.has(id)) ownerOf.set(id, r);
  }
  rows.forEach((r, i) => {
    const key = parentOf(r);
    let node = byKey.get(key);
    if (!node) {
      node = {
        key,
        label: null,
        startTurn: i + 1,
        endTurn: i + 1,
        turns: 0,
        cost: null,
        depth: 0,
        agents: [],
        children: [],
      };
      byKey.set(key, node);
    }
    node.endTurn = i + 1;
    node.turns++;
    const c = costOf(r);
    if (c !== null) node.cost = (node.cost === null ? 0 : node.cost) + c;
    const a = str(r.agent);
    if (a !== null && !node.agents.includes(a)) node.agents.push(a);
  });

  const roots = [];
  const parentNodeOf = new Map();
  for (const [key, node] of byKey) {
    node.label = node.agents[0] ?? (key === null ? 'main' : String(key));
    node.share = shareOf(node.cost, node.turns);
    const owner = key === null ? null : ownerOf.get(key);
    const parentKey = owner ? parentOf(owner) : null;
    const parentNode = owner && parentKey !== key ? byKey.get(parentKey) : null;
    if (parentNode && parentNode !== node) {
      parentNode.children.push(node);
      parentNodeOf.set(node, parentNode);
    } else {
      roots.push(node);
    }
  }
  // Every node in a link cycle is some other node's child, so no root reaches
  // it and the whole branch would silently disappear. Promote the first
  // unreachable node, cut the edge that pointed at it, and repeat.
  const reachable = new Set();
  const mark = (n) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    for (const c of n.children) mark(c);
  };
  for (const r of roots) mark(r);
  for (const node of byKey.values()) {
    if (reachable.has(node)) continue;
    const parentNode = parentNodeOf.get(node);
    if (parentNode) parentNode.children.splice(parentNode.children.indexOf(node), 1);
    roots.push(node);
    mark(node);
  }
  // Depth is what the view indents by, so it has to be finite.
  for (const r of roots) setDepth(r, 0, new Set());
  return roots;
}

function setDepth(node, depth, ancestors) {
  node.depth = depth;
  if (depth >= 12) { node.children = []; return; }
  const path = new Set(ancestors).add(node);
  node.children = node.children.filter((c) => !path.has(c));
  for (const c of node.children) setDepth(c, depth + 1, path);
}

function totals(rows) {
  let cost = null;
  let subagentCost = null;
  for (const r of rows) {
    const c = costOf(r);
    if (c === null) continue;
    cost = (cost === null ? 0 : cost) + c;
    if (isSubagent(r)) subagentCost = (subagentCost === null ? 0 : subagentCost) + c;
  }
  return { cost, subagentCost };
}

/** A turn already carries its price; a raw record may carry the stored estimate. */
function costOf(r) {
  const v = r.cost ?? r.estimated_cost ?? null;
  return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

function isSubagent(r) {
  return r.subagent === true || r.category === 'subagent';
}

function priceOf(r, book, tok) {
  if (!book) return null;
  const est = estimateCost({
    input_tokens: tok.input,
    output_tokens: tok.output,
    cache_read_tokens: tok.cacheRead,
    cache_write_tokens: tok.cacheWrite,
    cache_refresh_tokens: tok.cacheRefresh,
  }, r.model, r.provider, book, { tier: r.service_tier ?? null });
  return est.cost;
}

/** The id another record's parent link would point at. */
function linkIdOf(r) {
  return str(r.id) ?? str(r.requestId) ?? str(r.request_id);
}

function parentOf(r) {
  return str(r.parent) ?? str(r.parent_id) ?? str(r.parent_session_id);
}

function tsOf(r) {
  return str(r.ts) ?? str(r.timestamp);
}

function byTimestamp(a, b) {
  const x = tsOf(a);
  const y = tsOf(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
}

/** How many of these turns carry a cost at all. */
function priced(values) {
  let n = 0;
  for (const v of values) if (v !== null && v !== undefined && !Number.isNaN(v)) n++;
  return n;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function sumOrNull(parts) {
  let t = null;
  for (const v of parts) if (v !== null) t = (t === null ? 0 : t) + v;
  return t;
}

function num(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

function str(v) {
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * Branch-vs-branch comparison — any two branch receipts from buildReceipts()
 * (src/analytics/receipt.js), side by side.
 *
 * Every metric gets a signed position on a symmetric log scale: a 4x cost
 * difference reads the same distance from parity whichever side is bigger,
 * and "twice as expensive" and "half as expensive" are mirror images instead
 * of a percentage that blows up on one side and flattens on the other.
 *
 * Pure: no Node imports, so the CLI, the server and the browser agree.
 */

/**
 * @typedef {object} BranchReceipt one entry from buildReceipts().repos[].branches[]
 * @property {string} key
 * @property {number|null} cost
 * @property {number} turns
 * @property {number} sessions
 * @property {number|null} contextShare
 * @property {number|null} subagentShare
 * @property {number} subagentTurns
 * @property {{model:string,cost:number,share:number|null}[]} models
 * @property {number|null} vsMedian
 * @property {number|null} changedLines
 * @property {number|null} costPer100Lines
 * @property {boolean} longLived
 * @property {string|null} first
 * @property {string|null} last
 * @property {object|null} pr
 */

/**
 * @typedef {object} CompareRow
 * @property {string} key metric identifier
 * @property {string} label display label
 * @property {'cost'|'count'|'share'|'ratio'|'models'} kind how the UI should format valueA/valueB
 * @property {number|any} valueA
 * @property {number|any} valueB
 * @property {number|null} ratio A over B; null when either side is null or B is zero
 * @property {number|null} position signed log2(ratio)/2, clamped to [-1, 1]; null when ratio is null
 */

/** @type {[string, string, 'cost'|'count'|'share'|'ratio'][]} */
const METRICS = [
  ['cost', 'Cost', 'cost'],
  ['turns', 'Turns', 'count'],
  ['sessions', 'Sessions', 'count'],
  ['contextShare', 'Context share', 'share'],
  ['subagentShare', 'Subagent share', 'share'],
  ['costPerTurn', 'Cost per turn', 'cost'],
  ['costPer100Lines', 'Cost per 100 lines', 'cost'],
  ['vsMedian', "vs this repo's median branch", 'ratio'],
];

/** Cost per turn is not stored on the receipt; derive it from cost and turns. */
function costPerTurn(b) {
  if (!b || b.cost === null || b.cost === undefined || !(b.turns > 0)) return null;
  return b.cost / b.turns;
}

function valueFor(b, key) {
  if (key === 'costPerTurn') return costPerTurn(b);
  if (!b) return null;
  const v = b[key];
  return v === null || v === undefined ? null : v;
}

/**
 * A over B, and its signed position on the symmetric log scale.
 * Ratio 1 sits at 0, ratio 4 or more clamps to +1, ratio 0.25 or less clamps
 * to -1 — a doubling always moves the same distance, in either direction.
 * @param {number|null} valueA
 * @param {number|null} valueB
 */
function ratioAndPosition(valueA, valueB) {
  if (valueA === null || valueB === null || valueB === 0) return { ratio: null, position: null };
  const ratio = valueA / valueB;
  const position = Math.max(-1, Math.min(1, Math.log2(ratio) / 2));
  return { ratio, position };
}

/**
 * Compare two branch receipts metric by metric. Either side may be `null`
 * (nothing picked yet); every row degrades to null values rather than
 * throwing.
 * @param {BranchReceipt|null} a
 * @param {BranchReceipt|null} b
 * @returns {CompareRow[]}
 */
export function compareBranches(a, b) {
  /** @type {CompareRow[]} */
  const rows = [];
  for (const [key, label, kind] of METRICS) {
    const valueA = valueFor(a, key);
    const valueB = valueFor(b, key);
    const { ratio, position } = ratioAndPosition(valueA, valueB);
    rows.push({ key, label, kind, valueA, valueB, ratio, position });
  }
  rows.push({
    key: 'models',
    label: 'Models',
    kind: 'models',
    valueA: a ? a.models || [] : [],
    valueB: b ? b.models || [] : [],
    ratio: null,
    position: null,
  });
  return rows;
}

/**
 * Look up one branch receipt by (repo, branch key). Returns null on a miss —
 * the store may have moved on since a selection was persisted.
 * @param {{repos:{repo:string,branches:BranchReceipt[]}[]}|null|undefined} receipts
 * @param {string} repo
 * @param {string} key
 * @returns {BranchReceipt|null}
 */
export function findBranch(receipts, repo, key) {
  if (!receipts || !Array.isArray(receipts.repos)) return null;
  const R = receipts.repos.find((r) => r.repo === repo);
  if (!R) return null;
  return R.branches.find((b) => b.key === key) || null;
}

/**
 * A reasonable default pair to open the tab with: the most expensive feature
 * branch (any repo) versus the median-cost feature branch of that same repo —
 * "feature branch" meaning not long-lived and with a priced cost. Falls back
 * to the two highest-cost branches overall (ignoring the feature-branch
 * filter) when the repo that owns the top branch has no second feature
 * branch to compare it to. Returns null when there are fewer than two
 * branches anywhere.
 * @param {{repos:{repo:string,branches:BranchReceipt[]}[]}|null|undefined} receipts
 * @returns {{a:{repo:string,key:string}, b:{repo:string,key:string}}|null}
 */
export function pickDefault(receipts) {
  if (!receipts || !Array.isArray(receipts.repos)) return null;
  const all = [];
  for (const R of receipts.repos) for (const b of R.branches) all.push({ repo: R.repo, b });
  if (all.length < 2) return null;

  const pool = all.filter((x) => !x.b.longLived && x.b.cost !== null);
  if (pool.length >= 2) {
    const top = pool.reduce((best, x) => (x.b.cost > best.b.cost ? x : best));
    const sameRepo = pool.filter((x) => x.repo === top.repo).sort((p, q) => p.b.cost - q.b.cost);
    // `top` is the globally most expensive feature branch, so it is also the
    // most expensive within its own repo — it always lands last in
    // `sameRepo`, never at the median index, so the pair is never one branch
    // against itself.
    if (sameRepo.length >= 2) {
      const median = sameRepo[Math.floor((sameRepo.length - 1) / 2)];
      return { a: { repo: top.repo, key: top.b.key }, b: { repo: median.repo, key: median.b.key } };
    }
  }

  const byCost = [...all].sort((p, q) => (q.b.cost ?? -1) - (p.b.cost ?? -1));
  return { a: { repo: byCost[0].repo, key: byCost[0].b.key }, b: { repo: byCost[1].repo, key: byCost[1].b.key } };
}

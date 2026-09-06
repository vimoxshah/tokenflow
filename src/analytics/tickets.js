/**
 * Ticket extraction and cost-per-ticket rollup.
 *
 * A branch name or a pull request title sometimes carries a ticket key from
 * an issue tracker. This module finds that key, builds a URL to it when a
 * base URL is configured, and groups branch receipts (buildReceipts() in
 * ./receipt.js) by the ticket they name, across every repository and branch
 * that mentions it.
 *
 * Matching a ticket key in a branch name is a convention, not a guarantee.
 * A branch with no key in its name stays unattributed here even when a
 * human would recognize the work as belonging to a ticket. See
 * docs/tickets.md.
 *
 * Pure: no Node imports, so the CLI, the server and the browser get
 * identical answers.
 */
import { usd, pct } from '../core/units.js';

/** @typedef {{system:'jira'|'linear'|'github'|'other'|null, baseUrl:string|null, pattern:string|null}} TicketConfig */
/** @typedef {{system:string, key:string, url:string|null}} Ticket */

const KNOWN_SYSTEMS = ['jira', 'linear', 'github', 'other'];

/**
 * The shape Jira and Linear share: a letters-only project prefix (at least
 * two letters, so a single leading initial never counts), a dash, and a
 * number of at least two digits. Bounded so the key is not read out of a
 * larger identifier (`_ENG-123_` still matches; `XENG-123` does not).
 *
 * The two-or-more-digit number is a deliberate tightening beyond the bare
 * "letters-dash-digits" shape: without it, a common tech acronym followed by
 * a single digit (`UTF-8`) is structurally indistinguishable from a real
 * ticket key, in either a branch name or a PR title. It costs single-digit
 * ticket numbers (ticket 1 through 9 read as no match) and does not catch
 * every acronym (`UTF-16`, `ISO-8859` still match); see docs/tickets.md.
 */
const JIRA_LINEAR_RE = /(?<![A-Za-z0-9])[A-Z]{2,}-[0-9]{2,}(?![A-Za-z0-9])/i;

/**
 * The four conventional ways a GitHub issue/PR number shows up in a branch
 * name or title, tried in this order. Each is unambiguous on its own (no
 * ticket-tracker prefix collides with a literal "gh-", "issue-" or
 * "issues/"), so a match is always reported as `github` even with no
 * `tickets.system` configured.
 */
const GITHUB_PATTERNS = [
  /(?<![A-Za-z0-9])#([0-9]+)(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])gh-([0-9]+)(?![A-Za-z0-9])/i,
  /(?<![A-Za-z0-9])issue-([0-9]+)(?![A-Za-z0-9])/i,
  /(?<![A-Za-z0-9])issues\/([0-9]+)(?![A-Za-z0-9])/i,
];

function matchJiraLinear(text) {
  const m = JIRA_LINEAR_RE.exec(text);
  return m ? m[0].toUpperCase() : null;
}

/** Canonicalized as `#<n>` regardless of which alias matched, so `gh-123` and `issue-123` group as the same ticket. */
function matchGithub(text) {
  for (const re of GITHUB_PATTERNS) {
    const m = re.exec(text);
    if (m) return `#${m[1]}`;
  }
  return null;
}

/**
 * Run a user-supplied regex (config `tickets.pattern`) against `text`. The
 * first capture group is the key when the pattern has one; otherwise the
 * whole match is the key. An invalid pattern is treated as no match rather
 * than thrown, since a typo in config should not break every receipt.
 */
function matchCustom(text, patternSource) {
  let re;
  try {
    re = new RegExp(patternSource, 'i');
  } catch {
    return null;
  }
  const m = re.exec(text);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[0];
}

/**
 * @param {string} system
 * @param {string} key
 * @param {string|null} baseUrl
 * @returns {string|null}
 */
function buildUrl(system, key, baseUrl) {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  if (system === 'jira') return `${base}/browse/${key}`;
  if (system === 'linear') return `${base}/issue/${key}`;
  if (system === 'github') return `${base}/issues/${key.replace(/^#/, '')}`;
  return null;
}

/**
 * Find a ticket key in one piece of text (a branch name or a PR title).
 *
 * With `tickets.pattern` set, that regex alone decides a match; otherwise
 * `tickets.system` decides which built-in shape to look for. With no system
 * declared, both shapes are tried: a GitHub-style reference is unambiguous
 * and is always labelled `github`; a letters-dash-digits key is reported as
 * `other`, since without a declared system there is no way to say whether it
 * is Jira or Linear.
 *
 * @param {string} text
 * @param {Partial<TicketConfig>} [opt]
 * @returns {Ticket|null}
 */
export function extractTicket(text, opt = {}) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const system = opt.system && KNOWN_SYSTEMS.includes(opt.system) ? opt.system : null;
  const baseUrl = opt.baseUrl || null;

  if (opt.pattern) {
    const key = matchCustom(text, opt.pattern);
    if (!key) return null;
    const sys = system || 'other';
    return { system: sys, key, url: buildUrl(sys, key, baseUrl) };
  }

  if (system === 'jira' || system === 'linear') {
    const key = matchJiraLinear(text);
    return key ? { system, key, url: buildUrl(system, key, baseUrl) } : null;
  }

  if (system === 'github') {
    const key = matchGithub(text);
    return key ? { system: 'github', key, url: buildUrl('github', key, baseUrl) } : null;
  }

  // No system declared (or explicitly "other"): detect structurally.
  const gh = matchGithub(text);
  if (gh) return { system: 'github', key: gh, url: buildUrl('github', gh, baseUrl) };

  const jl = matchJiraLinear(text);
  if (jl) return { system: 'other', key: jl, url: buildUrl('other', jl, baseUrl) };

  return null;
}

// ---------------------------------------------------------------- rollup ---

/** The whole-branch totals: the PR-narrowed window when a PR exists, the branch's own totals otherwise. Mirrors the repo-total formula in receipt.js. */
function wholeOf(b) {
  return b.branch ? b.branch : { cost: b.cost, turns: b.turns, sessions: b.sessions };
}

function newTicketAcc(t) {
  return {
    system: t ? t.system : null,
    key: t ? t.key : null,
    url: t ? t.url : null,
    cost: 0,
    anyPriced: false,
    turns: 0,
    sessions: 0,
    branchKeys: new Set(),
    repoKeys: new Set(),
    first: null,
    last: null,
  };
}

function addWhole(acc, repo, branchKey, whole, first, last) {
  if (whole.cost !== null && whole.cost !== undefined) {
    acc.cost += whole.cost;
    acc.anyPriced = true;
  }
  acc.turns += whole.turns || 0;
  acc.sessions += whole.sessions || 0;
  if (repo !== null && repo !== undefined) acc.repoKeys.add(repo);
  if (branchKey !== null && branchKey !== undefined) acc.branchKeys.add(branchKey);
  if (first) { if (acc.first === null || first < acc.first) acc.first = first; }
  if (last) { if (acc.last === null || last > acc.last) acc.last = last; }
}

function finishTicketAcc(acc) {
  return {
    system: acc.system,
    key: acc.key,
    url: acc.url,
    costUsd: acc.anyPriced ? acc.cost : null,
    turns: acc.turns,
    sessions: acc.sessions,
    branches: [...acc.branchKeys].sort(),
    repos: [...acc.repoKeys].sort(),
    first: acc.first,
    last: acc.last,
    share: null, // filled in once the grand total is known
  };
}

/**
 * Group branch receipts by the ticket key found on them (buildReceipts()
 * already ran extractTicket() over each branch and its merged PR's title;
 * see receipt.js). A ticket referenced from more than one branch, in more
 * than one repository, rolls up into a single row.
 *
 * The whole-branch total is used per branch (the PR-narrowed figure when a
 * branch shipped in a merged PR, the branch's own total otherwise), so the
 * sum of every ticket's costUsd plus the unattributed bucket equals
 * `receipts.totals.cost` — the same total the Receipts tab shows.
 *
 * @param {ReturnType<typeof import('./receipt.js').buildReceipts>} receipts
 * @param {object} [opt] reserved for future filtering; currently unused
 * @returns {{tickets:object[], unattributed:object, totals:object}}
 */
export function costPerTicket(receipts, opt = {}) { // eslint-disable-line no-unused-vars
  const byKey = new Map();
  const unattributed = newTicketAcc(null);
  let total = 0;

  if (receipts && Array.isArray(receipts.repos)) {
    for (const R of receipts.repos) {
      for (const b of R.branches) {
        const whole = wholeOf(b);
        const branchKey = `${R.repo}#${b.key}`;
        if (b.ticket) {
          const gk = `${b.ticket.system || 'other'}:${b.ticket.key}`;
          let acc = byKey.get(gk);
          if (!acc) { acc = newTicketAcc(b.ticket); byKey.set(gk, acc); }
          addWhole(acc, R.repo, branchKey, whole, b.first, b.last);
        } else {
          addWhole(unattributed, R.repo, branchKey, whole, b.first, b.last);
        }
        if (whole.cost !== null && whole.cost !== undefined) total += whole.cost;
      }
      // Detached-HEAD / no-branch turns: no branch name ever existed for
      // extractTicket() to read, so they are unattributed by definition.
      const un = R.unattributed;
      if (un && un.turns > 0) {
        addWhole(unattributed, R.repo, null, { cost: un.cost, turns: un.turns, sessions: un.sessions }, un.first, un.last);
        if (un.cost !== null && un.cost !== undefined) total += un.cost;
      }
    }
  }

  const tickets = [...byKey.values()].map(finishTicketAcc);
  for (const t of tickets) t.share = total > 0 && t.costUsd !== null ? t.costUsd / total : null;
  tickets.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

  const unattributedRow = finishTicketAcc(unattributed);
  unattributedRow.share = total > 0 && unattributedRow.costUsd !== null ? unattributedRow.costUsd / total : null;

  const attributed = tickets.reduce((a, t) => a + (t.costUsd ?? 0), 0);

  return {
    tickets,
    unattributed: unattributedRow,
    totals: {
      costUsd: total > 0 ? total : null,
      attributedCostUsd: attributed,
      unattributedCostUsd: total - attributed,
      attributedShare: total > 0 ? attributed / total : null,
      tickets: tickets.length,
    },
  };
}

// -------------------------------------------------------------- rendering ---

const money = (v) => (v === null || v === undefined ? '—' : usd(v));
const share = (v) => (v === null || v === undefined ? '—' : pct(v, 0));

/**
 * Terminal table of cost-per-ticket, most expensive first.
 * @param {ReturnType<typeof costPerTicket>} result
 * @param {{top?:number}} [opt]
 */
export function renderTicketsTable(result, opt = {}) {
  const top = opt.top ?? 20;
  const L = [];
  const hdr = `  ${'cost'.padStart(10)}  ${'share'.padStart(5)}  ${'turns'.padStart(6)}  ${'sess'.padStart(4)}  ${'branches'.padStart(8)}  key`;
  L.push(hdr);
  for (const t of result.tickets.slice(0, top)) {
    const label = t.system ? `${t.key} (${t.system})` : t.key;
    L.push(`  ${money(t.costUsd).padStart(10)}  ${share(t.share).padStart(5)}  ${String(t.turns).padStart(6)}  ${String(t.sessions).padStart(4)}  ${String(t.branches.length).padStart(8)}  ${label}`);
  }
  if (result.tickets.length > top) L.push(`  … ${result.tickets.length - top} more`);
  const u = result.unattributed;
  if (u.turns > 0) {
    L.push(`  ${money(u.costUsd).padStart(10)}  ${share(u.share).padStart(5)}  ${String(u.turns).padStart(6)}  ${String(u.sessions).padStart(4)}  ${String(u.branches.length).padStart(8)}  (unattributed)`);
  }
  L.push('');
  const t = result.totals;
  if (t.costUsd !== null) L.push(`Total ${money(t.costUsd)} attributed to a ticket ${share(t.attributedShare)}, ${t.tickets} ticket(s)`);
  return L.join('\n');
}

/**
 * `tokenflow doctor` audit checks — the defects the 2026-09 data-quality audit
 * found on a real store, expressed as automated checks so `doctor` reports
 * them on every run instead of needing another manual pass.
 *
 * `auditChecks` takes a single pass over the last three months of records
 * (`Store#scanRecords` already supports a `months` filter) and feeds every
 * check below from that one scan, so adding a check never costs another scan.
 * A store with more than `maxScanRecords` records in that window is sampled:
 * the scan stops there and every affected check's detail says so.
 *
 * Each check returns `{ id, level, title, detail, fix }` as the task
 * requires, plus a `data` object carrying the structured counts behind the
 * human-readable `detail` string — `renderChecks` never reads `data`, but a
 * caller that wants exact numbers (a test, a `--json` mode) does not have to
 * parse the sentence back out.
 */
import path from 'node:path';
import { decodeRecord, readJson } from '../core/store.js';
import { repoRootOf } from '../core/repo.js';
import { buildPriceBook, PRICING_TABLE_VERSION } from '../core/pricing.js';
import { paths } from '../core/config.js';
import { int, compact, pct, usd } from '../core/units.js';

/** Hard ceiling on how much of the store one `doctor` run reads. */
const MAX_SCAN_RECORDS = 200000;
/** How many trailing months `scanRecords` is asked for. */
const MONTHS_BACK = 3;
/**
 * Sources known to report one row per session (or per session×model), not per
 * request/turn — so any per-turn statistic under-counts them. There is no
 * registry-level flag for this (see src/core/registry.js#getMetadata), so this
 * is a short, explicitly named list; today that is only Hermes
 * (src/providers/hermes/index.js: "There is no per-request log to read").
 */
const SESSION_LEVEL_SOURCES = ['hermes'];

/** Age, in days, past which the built-in price table is flagged. */
const STALE_WARN_DAYS = 60;
const STALE_FAIL_DAYS = 180;

/** Share of a repo's spend hidden across worktrees before it is a `warn`. */
const WORKTREE_WARN_SHARE = 0.2;
/** Share of scanned tokens with no price before it is `warn` / `fail`. */
const UNPRICED_WARN_SHARE = 0.1;
const UNPRICED_FAIL_SHARE = 0.3;

/**
 * `YYYY-MM` for `now`'s month and the `n - 1` months before it, newest first —
 * the same granularity `Store#shardFor` uses, so it can be passed straight to
 * `scanRecords`'s `months` filter.
 * @param {Date} now
 * @param {number} n
 * @returns {string[]}
 */
function lastMonths(now, n) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function withScanNote(detail, truncated, maxScanRecords) {
  return truncated ? `${detail} (capped at ${int(maxScanRecords)} records scanned — some may be missed)` : detail;
}

/** @typedef {{id:string, level:'ok'|'info'|'warn'|'fail', title:string, detail:string, fix:string|null, data:object}} DoctorCheck */

/**
 * Run every audit check over the last `MONTHS_BACK` months of the store.
 *
 * @param {{store: import('../core/store.js').Store, config?: object, now?: Date, maxScanRecords?: number}} opt
 *   `config` is accepted for interface parity with the rest of the `doctor`
 *   surface (and in case a future check needs a configured preference); no
 *   check currently reads it. `maxScanRecords` defaults to `MAX_SCAN_RECORDS`
 *   and exists mainly so a test can exercise the cap cheaply.
 * @returns {DoctorCheck[]}
 */
export function auditChecks({ store, config = {}, now = new Date(), maxScanRecords = MAX_SCAN_RECORDS }) {
  const months = lastMonths(now, MONTHS_BACK);
  const repoCache = new Map();
  const book = buildPriceBook(readJson(paths().pricing, {}));

  /** trueRepo (basename of the resolved main checkout) -> aggregate */
  const worktree = new Map();
  /** records whose cwd resolves to no repository at all */
  const cwdBasename = { count: 0, names: new Map() };
  /** month ('YYYY-MM') -> { total, noBranch } for openai-source primary records */
  const codex = new Map();
  /** model -> { tokens, provider } for primary-measurement records */
  const modelTokens = new Map();
  let totalPricedScopeTokens = 0;
  /** session-level source id -> record count */
  const sessionLevel = new Map();
  let repoResolvedFieldSeen = false;
  let repoResolvedFalse = 0;

  let scanned = 0;
  let truncated = false;
  store.scanRecords((o) => {
    scanned++;
    if (scanned > maxScanRecords) { truncated = true; return false; }

    const r = decodeRecord(o);
    const md = r.metadata || {};

    // (a) / (b) — repo identity derived from the recorded cwd.
    if (md.cwd) {
      const root = repoRootOf(md.cwd, repoCache);
      if (root) {
        const trueRepo = path.basename(root);
        let g = worktree.get(trueRepo);
        if (!g) { g = { totalRecords: 0, totalSpend: 0, misfiledRecords: 0, misfiledSpend: 0 }; worktree.set(trueRepo, g); }
        const spend = r.estimated_cost ?? 0;
        g.totalRecords++;
        g.totalSpend += spend;
        if ((r.project || null) !== trueRepo) {
          g.misfiledRecords++;
          g.misfiledSpend += spend;
        }
      } else {
        cwdBasename.count++;
        const name = r.project || path.basename(md.cwd);
        cwdBasename.names.set(name, (cwdBasename.names.get(name) || 0) + 1);
      }
    }

    // (c) — Codex (the openai adapter) records carrying no git_branch.
    if (r.source === 'openai' && r.measurement === 'primary') {
      const month = (r.date || '').slice(0, 7);
      if (months.includes(month)) {
        let c = codex.get(month);
        if (!c) { c = { total: 0, noBranch: 0 }; codex.set(month, c); }
        c.total++;
        if (!r.git_branch) c.noBranch++;
      }
    }

    // (d) — token volume per model, primary measurement only (the app's
    // default in-scope view; overlay records are excluded from totals
    // everywhere else and would double-count here too).
    if (r.measurement === 'primary' && r.total_tokens !== null && r.total_tokens !== undefined) {
      totalPricedScopeTokens += r.total_tokens;
      const m = modelTokens.get(r.model);
      if (m) m.tokens += r.total_tokens;
      else modelTokens.set(r.model, { tokens: r.total_tokens, provider: r.provider });
    }

    // (f) — session-level sources present in this window.
    if (SESSION_LEVEL_SOURCES.includes(r.source)) {
      sessionLevel.set(r.source, (sessionLevel.get(r.source) || 0) + 1);
    }

    // (g) — an explicit metadata.repoResolved === false marker, if present.
    // Absence is normal (no adapter sets it yet) and must not be an error.
    if (Object.prototype.hasOwnProperty.call(md, 'repoResolved')) {
      repoResolvedFieldSeen = true;
      if (md.repoResolved === false) repoResolvedFalse++;
    }
  }, { months });

  return [
    checkWorktreeSplit(worktree, truncated, maxScanRecords),
    checkCwdBasename(cwdBasename, truncated, maxScanRecords),
    checkCodexBranch(codex, truncated, maxScanRecords),
    checkUnpricedModels(modelTokens, totalPricedScopeTokens, book, truncated, maxScanRecords),
    checkStalePriceTable(now),
    checkSessionLevelSources(sessionLevel),
    checkRepoResolvedFalse(repoResolvedFieldSeen, repoResolvedFalse),
  ];
}

/** @returns {DoctorCheck} */
function checkWorktreeSplit(worktree, truncated, maxScanRecords) {
  const groups = [...worktree.entries()]
    .filter(([, g]) => g.misfiledRecords > 0)
    .map(([repo, g]) => ({
      repo,
      misfiledRecords: g.misfiledRecords,
      misfiledSpend: round2(g.misfiledSpend),
      totalRecords: g.totalRecords,
      totalSpend: round2(g.totalSpend),
      // Share of THIS repo's own resolved spend hidden across worktree names —
      // not a share of the whole store, which would read as near-zero for
      // every individual repo regardless of how badly it is fragmented.
      share: g.totalSpend > 0 ? g.misfiledSpend / g.totalSpend : null,
    }))
    .sort((a, b) => b.misfiledSpend - a.misfiledSpend);
  const top = groups.slice(0, 5);
  const totalMisfiledRecords = groups.reduce((a, g) => a + g.misfiledRecords, 0);
  const totalMisfiledSpend = round2(groups.reduce((a, g) => a + g.misfiledSpend, 0));
  const level = groups.length === 0 ? 'ok' : groups.some((g) => g.share !== null && g.share >= WORKTREE_WARN_SHARE) ? 'warn' : 'info';
  const detail = groups.length
    ? `${groups.length} repo(s) split across git worktrees — ${int(totalMisfiledRecords)} record(s) / ${usd(totalMisfiledSpend)} filed under a worktree name instead of the repo: `
      + top.map((g) => `${g.repo} (${int(g.misfiledRecords)} rec, ${usd(g.misfiledSpend)}${g.share !== null ? `, ${pct(g.share)} of its spend` : ''})`).join('; ')
    : 'no worktree-split projects found in the scanned window';
  return {
    id: 'worktree-split-projects',
    level,
    title: "Git worktrees fragmenting a repo's spend",
    detail: withScanNote(detail, truncated, maxScanRecords),
    fix: groups.length
      ? 'adapters record project as basename(cwd); resolve through repoRootOf() (src/core/repo.js) before filing a record, or merge worktrees by resolved repo before reporting.'
      : null,
    data: { groups: top, totalMisfiledRecords, totalMisfiledSpend, repoCount: groups.length },
  };
}

/** @returns {DoctorCheck} */
function checkCwdBasename(acc, truncated, maxScanRecords) {
  const names = [...acc.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  const level = acc.count === 0 ? 'ok' : 'info';
  const detail = acc.count
    ? `${int(acc.count)} record(s) have a cwd outside any git repository, so their project is just a directory name: `
      + names.map((n) => `${n.name} (${int(n.count)})`).join(', ')
    : 'every recorded cwd resolves inside a repository';
  return {
    id: 'cwd-basename-projects',
    level,
    title: 'Projects that are really just a directory name',
    detail: withScanNote(detail, truncated, maxScanRecords),
    fix: acc.count
      ? 'expected for ad hoc / non-repo directories; if any name above is actually a repo, confirm it has a .git it can see (or a worktree gitdir pointing at one).'
      : null,
    data: { count: acc.count, topNames: names },
  };
}

/** @returns {DoctorCheck} */
function checkCodexBranch(codex, truncated, maxScanRecords) {
  const monthRows = [...codex.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, c]) => ({ month, total: c.total, noBranch: c.noBranch, share: c.total ? c.noBranch / c.total : null }));
  const totalRecords = monthRows.reduce((a, m) => a + m.total, 0);
  const noBranchRecords = monthRows.reduce((a, m) => a + m.noBranch, 0);
  const overallShare = totalRecords ? noBranchRecords / totalRecords : null;
  /** @type {'ok'|'info'|'warn'|'fail'} */
  let level = 'ok';
  if (totalRecords > 0) {
    if (overallShare >= 0.99) level = 'fail';
    else if (overallShare > 0) level = 'warn';
  }
  const detail = totalRecords === 0
    ? 'no Codex (openai-source) records in the scanned window'
    : `${pct(overallShare)} of ${int(totalRecords)} Codex record(s) have no git_branch — `
      + monthRows.map((m) => `${m.month}: ${pct(m.share)} of ${int(m.total)}`).join(', ');
  return {
    id: 'codex-missing-branch',
    level,
    title: 'Codex records cannot be attributed to a branch',
    detail: withScanNote(detail, truncated, maxScanRecords),
    fix: noBranchRecords > 0
      ? 'src/providers/openai/index.js does not record git_branch; derive it from the rollout\'s turn_context/cwd via git, the way the worktree resolver already does.'
      : null,
    data: { months: monthRows, totalRecords, noBranchRecords, overallShare },
  };
}

/** @returns {DoctorCheck} */
function checkUnpricedModels(modelTokens, totalTokens, book, truncated, maxScanRecords) {
  const unpriced = [];
  for (const [model, m] of modelTokens.entries()) {
    if (!m.tokens) continue;
    if (book.lookup(model, m.provider) === null) unpriced.push({ model, tokens: m.tokens, provider: m.provider });
  }
  unpriced.sort((a, b) => b.tokens - a.tokens);
  const unpricedTokens = unpriced.reduce((a, m) => a + m.tokens, 0);
  const share = totalTokens ? unpricedTokens / totalTokens : null;
  /** @type {'ok'|'info'|'warn'|'fail'} */
  let level = 'ok';
  if (unpriced.length > 0) {
    if (share !== null && share >= UNPRICED_FAIL_SHARE) level = 'fail';
    else if (share !== null && share >= UNPRICED_WARN_SHARE) level = 'warn';
    else level = 'info';
  }
  const top = unpriced.slice(0, 10).map((m) => ({ ...m, share: totalTokens ? m.tokens / totalTokens : null }));
  const detail = unpriced.length
    ? `${unpriced.length} model(s) with no price cover ${pct(share)} of scanned tokens — `
      + top.slice(0, 5).map((m) => `${m.model} (${compact(m.tokens)}, ${pct(m.share)})`).join(', ')
    : 'every model with token volume in the scanned window has a price';
  return {
    id: 'unpriced-models',
    level,
    title: 'Unpriced models',
    detail: withScanNote(detail, truncated, maxScanRecords),
    fix: unpriced.length
      ? 'tokenflow pricing --set "<model>=<input$/1M>,<output$/1M>" for the models above, or tokenflow pricing diff <table.json> --apply once you have rates.'
      : null,
    data: { models: top, unpricedCount: unpriced.length, unpricedTokens, totalTokens, share },
  };
}

/** @returns {DoctorCheck} */
function checkStalePriceTable(now) {
  const versionDate = new Date(`${PRICING_TABLE_VERSION}T00:00:00Z`);
  const ageDays = Number.isNaN(versionDate.getTime()) ? null : Math.floor((now.getTime() - versionDate.getTime()) / 86400000);
  /** @type {'ok'|'info'|'warn'|'fail'} */
  let level = 'ok';
  if (ageDays === null) level = 'warn';
  else if (ageDays > STALE_FAIL_DAYS) level = 'fail';
  else if (ageDays > STALE_WARN_DAYS) level = 'warn';
  const detail = ageDays === null
    ? `could not parse the price table version "${PRICING_TABLE_VERSION}"`
    : `built-in price table ${PRICING_TABLE_VERSION} is ${int(ageDays)} day(s) old`;
  return {
    id: 'stale-price-table',
    level,
    title: 'Built-in price table freshness',
    detail,
    fix: level !== 'ok'
      ? 'refresh BUILTIN_PRICES / PRICING_TABLE_VERSION in src/core/pricing.js against current vendor pricing pages, or apply an updated table with tokenflow pricing diff --apply.'
      : null,
    data: { version: PRICING_TABLE_VERSION, ageDays },
  };
}

/** @returns {DoctorCheck} */
function checkSessionLevelSources(sessionLevel) {
  const sources = [...sessionLevel.entries()].map(([id, count]) => ({ id, count }));
  const level = sources.length ? 'info' : 'ok';
  const detail = sources.length
    ? `session-level source(s) present — one row per session, not per request/turn, so per-turn views under-count them: `
      + sources.map((s) => `${s.id} (${int(s.count)} record(s))`).join(', ')
    : 'no session-level sources in the scanned window';
  return {
    id: 'session-level-sources',
    level,
    title: 'Session-level sources present',
    detail,
    fix: sources.length ? 'filter these sources out of any per-turn/per-request statistic (see src/analytics/receipt.js for the pattern).' : null,
    data: { sources },
  };
}

/** @returns {DoctorCheck} */
function checkRepoResolvedFalse(seen, count) {
  const level = seen && count > 0 ? 'warn' : 'ok';
  const detail = !seen
    ? 'no record carries a metadata.repoResolved marker (not set by anything in this store)'
    : count > 0
      ? `${int(count)} record(s) carry metadata.repoResolved === false`
      : 'metadata.repoResolved is present and never false on the records seen';
  return {
    id: 'repo-resolved-false',
    level,
    title: 'Records flagged as unresolved by repository',
    detail,
    fix: count > 0 ? 'these records could not be attributed to a repository by whatever set the marker; see its source for why.' : null,
    data: { present: seen, count },
  };
}

const MARK = { ok: '✓', info: '○', warn: '!', fail: '✗' };
const TITLE_COL = 44;

function colorFor(level) {
  if (level === 'ok') return 'g';
  if (level === 'info') return 'dim';
  if (level === 'warn') return 'y';
  return 'red';
}

function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

/**
 * Format the checks the way `cmdDoctor`'s existing lines read: one line per
 * check (mark, title, detail), with a dim `fix:` continuation line only when
 * the check is not clean — the same shape `cmdRefresh` uses for its notes.
 * @param {ReturnType<typeof auditChecks>} rows
 * @param {{print?: boolean, color?: boolean}} [opt] `print: false` returns the
 *   text without writing it to stdout — useful for tests and for a future
 *   `--json`-adjacent text capture.
 * @returns {string}
 */
export function renderChecks(rows, opt = {}) {
  const useColor = opt.color ?? (typeof process !== 'undefined' && !!(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR);
  const C = useColor
    ? { r: '\x1b[0m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' }
    : { r: '', dim: '', g: '', y: '', red: '' };
  const lines = [];
  for (const row of rows) {
    const mark = MARK[row.level] || '?';
    const color = C[colorFor(row.level)];
    lines.push(`   ${color}${mark}${C.r} ${pad(row.title, TITLE_COL)} ${C.dim}${row.detail || ''}${C.r}`);
    if (row.fix && row.level !== 'ok') lines.push(`      ${C.dim}fix: ${row.fix}${C.r}`);
  }
  const text = lines.join('\n');
  if (opt.print !== false) console.log(text);
  return text;
}

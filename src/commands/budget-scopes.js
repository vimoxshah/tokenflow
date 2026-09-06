/**
 * `tokenflow budget` scoped budgets — repo and team caps alongside the single
 * monthly budget in src/core/budget.js.
 *
 * Config (config.yaml):
 *
 *   budgets:
 *     - id: api-monthly
 *       scope: repo            # total | repo | team
 *       repo: api                # required when scope is repo; matched against
 *                                # the same repository identity `receipt` uses
 *                                # (worktrees folded into their main checkout)
 *       monthlyUsd: 150
 *       warnAt: 0.8             # optional, default 0.8 (a fraction, like limits[].warnAt)
 *
 * "Spent" per scope, this calendar month (UTC date, same convention `tokenflow
 * budget` already uses for the single monthly cap):
 *   - total: every priced turn in the store this month.
 *   - repo:  turns this month attributed to that repository, resolved the same
 *            way `tokenflow receipt` resolves it (worktrees folded into their
 *            main checkout) — a plain `project`/`repository` field match would
 *            split one repo's spend across every worktree it ever had.
 *   - team:  this machine's shared sync folder (`sync.dir`), if enabled; the
 *            budget engine never invents a team total nobody's synced.
 *
 * Repo/team scope needs a fresh, month-bounded receipt pass (buildReceiptsForStore
 * caches the *whole* store with no date window, so it cannot answer "this
 * month" by itself) — built here with the exact same pieces buildReceiptsForStore
 * uses internally (createReceiptBuilder + makeRepoResolver). buildReceiptsForStore
 * itself is still called, to tell "this repo has no spend yet this month" apart
 * from "this repo has never been seen in the store" in the row's note.
 */
import { paths } from '../core/config.js';
import { Store, readJson, decodeRecord } from '../core/store.js';
import { buildPriceBook } from '../core/pricing.js';
import { MEASUREMENT } from '../core/schema.js';
import { makeRepoResolver } from '../core/repo.js';
import { createReceiptBuilder } from '../analytics/receipt.js';
import { buildReceiptsForStore } from '../core/bundle.js';
import { isEnabled, syncDir } from '../core/sync.js';
import { aggregate } from '../core/team.js';
import { scopedBudgetState } from '../core/budget.js';
import { usd, pct } from '../core/units.js';

function monthWindow(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const today = d.toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/**
 * @param {object} b configured budget entry
 * @param {{spentUsd:number, note?:string}} extra
 */
function row(b, { spentUsd, note }) {
  const st = scopedBudgetState({
    spentUsd,
    monthlyUsd: b.monthlyUsd,
    warnAt: typeof b.warnAt === 'number' ? b.warnAt : 0.8,
  });
  const label = b.scope === 'repo' ? (b.repo || b.id) : b.scope === 'team' ? 'Team' : 'Total';
  return {
    id: b.id,
    scope: b.scope,
    label,
    spentUsd: st.spentUsd,
    monthlyUsd: st.monthlyUsd,
    share: st.share,
    state: st.state,
    note: note || null,
  };
}

/**
 * Evaluate every configured scoped budget against this month's spend.
 * @param {{config?:object, store?:object, now?:Date|string}} [opt]
 * @returns {object[]} rows: `{id, scope, label, spentUsd, monthlyUsd, share, state, note}`
 */
export function evaluateScopedBudgets({ config, store, now } = {}) {
  const cfg = config || {};
  const budgets = Array.isArray(cfg.budgets) ? cfg.budgets : [];
  const valid = budgets.filter((b) => b && b.id && b.scope && b.monthlyUsd > 0);
  if (!valid.length) return [];

  const st = store || new Store();
  const { from, to } = monthWindow(now);
  const pricing = readJson(paths().pricing, {});
  const book = buildPriceBook(pricing);

  // One month-bounded receipts pass, reused by every total/repo row below.
  const builder = createReceiptBuilder({ book, repoOf: makeRepoResolver() });
  st.scanRecords((o) => {
    if (o.ms !== MEASUREMENT.PRIMARY) return;
    if (o.d < from || o.d > to) return;
    builder.add(decodeRecord(o));
  });
  const scoped = builder.finish();

  const rows = [];
  for (const b of valid) {
    if (b.scope === 'total') {
      rows.push(row(b, { spentUsd: scoped.totals.cost ?? 0 }));
    } else if (b.scope === 'repo') {
      const R = scoped.repos.find((r) => r.repo === b.repo);
      if (R) {
        rows.push(row(b, { spentUsd: R.cost ?? 0 }));
      } else {
        const allTime = buildReceiptsForStore(st, pricing);
        const known = allTime.repos.some((r) => r.repo === b.repo);
        rows.push(row(b, { spentUsd: 0, note: known ? 'no spend this month' : 'repository not seen in the store' }));
      }
    } else if (b.scope === 'team') {
      if (!isEnabled(cfg)) { rows.push(row(b, { spentUsd: 0, note: 'no team data' })); continue; }
      const dir = syncDir(cfg);
      const team = aggregate(dir, { from, to });
      if (!team) { rows.push(row(b, { spentUsd: 0, note: 'no team data' })); continue; }
      rows.push(row(b, { spentUsd: team.totals.estCostUsd || 0 }));
    }
  }
  return rows;
}

/** @param {object[]} rows from evaluateScopedBudgets() */
export function renderScopedBudgets(rows) {
  if (!rows.length) return 'No scoped budgets configured. Add one to config.yaml under `budgets:`.';
  const L = [];
  for (const r of rows) {
    const tag = r.state === 'over' ? 'OVER' : r.state === 'warn' ? 'WARN' : 'ok';
    const shareTxt = pct(r.share, 0, 'n/a');
    L.push(`[${tag}] ${r.label} (${r.scope}): ${usd(r.spentUsd, 'n/a')} of ${usd(r.monthlyUsd, 'n/a')} (${shareTxt})${r.note ? `  ${r.note}` : ''}`);
  }
  return L.join('\n');
}

/**
 * Budget forecasting alerts — projected month-end spend vs a configured
 * budget, with persisted alert state to prevent notification spam.
 *
 * Config (config.yaml):
 *
 *   budget:
 *     monthly: 200          # USD — your monthly cap
 *     warnAtPct: 80         # alert when PROJECTED month-end >= 80% of budget
 *
 * States (monotonic per month, tracked in $TOKENFLOW_HOME/data/budget-state.json):
 *   safe          — projection < warn threshold
 *   approaching   — projection >= warnAtPct% of budget (fires once per month)
 *   over_budget_projected — projection >= 100% of budget (fires once per month)
 *   over_budget_actual    — measured MTD spend >= budget (fires once per month)
 *
 * Honesty rules:
 *  - "projected" is always labelled as a projection; never shown as charged.
 *  - If there is insufficient history for a forecast (< 3 days of data this
 *    month), the state is "unknown" and no alert fires. Never fabricate $0.
 *  - State resets when the calendar month changes, so each month can fire
 *    its own approaching/over alerts exactly once.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// State file resolves from TOKENFLOW_HOME at CALL time (not import time) so
// tests can isolate state via env without fighting module-level caching.
const STATE_FILE = () => {
  const home = process.env.TOKENFLOW_HOME || path.join(os.homedir(), '.tokenflow');
  return path.join(home, 'data', 'budget-state.json');
};

/**
 * Compute the current budget state from a live status snapshot.
 * @param {object} status live status (usage.monthToDate, velocity, forecast)
 * @param {{monthly:number, warnAtPct?:number}} budget config.budget
 * @param {string} today YYYY-MM-DD
 */
export function computeBudgetState(status, budget, today) {
  if (!budget?.monthly || !(budget.monthly > 0)) return null;
  const mtd = status.usage?.monthToDate;
  if (!mtd) return null;

  const spent = mtd.cost ?? null;                    // estimated; measured kept separate
  if (spent == null) return { state: 'unknown', reason: 'no priced usage yet this month' };

  const warnPct = (budget.warnAtPct ?? 80) / 100;
  const monthKey = today.slice(0, 7);

  // Actual overage is checkable immediately and needs no forecast.
  if (spent >= budget.monthly) {
    return {
      state: 'over_budget_actual', monthKey,
      spent, budget: budget.monthly,
      message: `Month-to-date spend ${fmt(spent)} has reached your ${fmt(budget.monthly)} budget.`,
    };
  }

  // Projected month-end: prefer the engine's linear-trend forecast cost;
  // fall back to pace-based extrapolation only if velocity exists.
  const projected = status.forecast?.monthEndCost ?? projectFromPace(status, today);
  if (projected == null) {
    return {
      state: 'unknown', monthKey,
      spent, budget: budget.monthly,
      reason: 'not enough history this month for a forecast',
    };
  }

  const pct = projected / budget.monthly;
  if (pct >= 1) {
    return {
      state: 'over_budget_projected', monthKey,
      spent, projected, budget: budget.monthly,
      message: `Projected month-end spend ${fmt(projected)} exceeds your ${fmt(budget.monthly)} budget (projection, not an actual charge).`,
    };
  }
  if (pct >= warnPct) {
    return {
      state: 'approaching', monthKey,
      spent, projected, budget: budget.monthly,
      message: `Projected month-end spend ${fmt(projected)} is ${Math.round(pct * 100)}% of your ${fmt(budget.monthly)} budget.`,
    };
  }
  return { state: 'safe', monthKey, spent, projected, budget: budget.monthly };
}

function projectFromPace(status, today) {
  const v = status.velocity;
  if (!v?.todayTokensPerHour || !status.usage?.monthToDate?.cost) return null;
  // Pace-based cost projection needs cost-per-token which we do not track
  // here; defer to the engine's forecast rather than inventing a rate.
  return null;
}

function fmt(n) { return `$${(Math.round(n * 100) / 100).toLocaleString('en-US')}`; }

/**
 * Decide whether an alert should FIRE now, given persisted state.
 * Dedup: each state fires once per calendar month. Escalation
 * (approaching → over_budget_projected / over_budget_actual) re-fires because
 * it is strictly more urgent than what was already sent.
 * @returns {{fire: boolean, state: object}}
 */
export function shouldAlert(newState, opt = {}) {
  if (!newState || newState.state === 'safe' || newState.state === 'unknown') {
    persist({ state: newState?.state || 'safe', monthKey: newState?.monthKey });
    return { fire: false, state: newState };
  }
  const prev = loadState();
  const sameMonth = prev?.monthKey === newState.monthKey;
  const RANK = { safe: 0, unknown: 0, approaching: 1, over_budget_projected: 2, over_budget_actual: 3 };

  let fire;
  if (!sameMonth) {
    fire = true;                                   // new month → alert again
  } else if ((RANK[newState.state] ?? 0) > (RANK[prev.state] ?? 0)) {
    fire = true;                                   // escalated urgency
  } else {
    fire = false;                                  // already alerted at this level
  }

  if (opt.force) fire = true;
  if (fire) persist({ state: newState.state, monthKey: newState.monthKey });
  return { fire, state: newState };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return null; }
}
function persist(s) {
  try {
    const file = STATE_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
  } catch { /* best-effort */ }
}

/** Reset state (new month detected by callers, or user command). */
export function resetBudgetState() { try { fs.unlinkSync(STATE_FILE()); } catch { /* absent */ } }

/**
 * Milestones — moments worth celebrating, computed from the daily series.
 *
 * Rules of the road:
 *   - every milestone is a MEASURED fact about the dataset (a record broken,
 *     a round spend threshold reached for the first time, a streak hitting a
 *     multiple of seven), never flattery;
 *   - ids are stable (`type:date`), so the watcher can announce exactly the
 *     ones it has never announced before;
 *   - quiet data produces an empty list. No participation trophies.
 */
import { compact } from '../core/units.js';

export const COST_STEPS = [10, 25, 50, 100, 250, 500, 1000];
export const STREAK_STEP = 7;

/** @typedef {{id:string, type:'biggest_day'|'cost_threshold'|'streak', icon:string, title:string, detail:string, date:string}} Milestone */

function money(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

const isActiveDay = (d) => Boolean(d.tokenActive) || Boolean(d.active);

/**
 * @param {{key:string,total:number,cost?:number|null,tokenActive?:boolean,
 *          active?:boolean}[]} daily calendar-complete series whose LAST entry
 *        is today (today may still be partial)
 * @returns {Milestone[]}
 */
export function detectMilestones(daily) {
  const out = [];
  if (!Array.isArray(daily) || daily.length < 2) return out;

  const today = daily[daily.length - 1];
  const past = daily.slice(0, -1);
  const todayTotal = today.total || 0;

  // ---- biggest measured day -------------------------------------------------
  // Requires real history above zero so day one is not a hollow record.
  const prevMax = past.reduce((m, d) => Math.max(m, d.total || 0), 0);
  if (prevMax > 0 && todayTotal > prevMax) {
    out.push({
      id: `biggest_day:${today.key}`,
      type: 'biggest_day',
      icon: '🏆',
      title: 'Biggest day yet',
      date: today.key,
      detail: `${compact(todayTotal)} tokens — above your previous best of ${compact(prevMax)}.`,
    });
  }

  // ---- first-ever spend threshold ---------------------------------------------
  const todayCost = Number(today.cost) || 0;
  if (todayCost > 0) {
    // Highest newly-reached step wins: a single $120 day after a $8 peak is
    // "First $100 day", not two celebrations.
    for (const step of [...COST_STEPS].reverse()) {
      const crossedBefore = past.some((d) => (Number(d.cost) || 0) >= step);
      if (!crossedBefore && todayCost >= step) {
        out.push({
          id: `cost_${step}:${today.key}`,
          type: 'cost_threshold',
          icon: '💰',
          title: `First $${step} day`,
          date: today.key,
          detail: `Estimated spend reached ${money(todayCost)} today — past $${step} for the first time.`,
        });
        break;
      }
    }
  }

  // ---- consecutive active days -------------------------------------------------
  let streak = 0;
  for (let i = daily.length - 1; i >= 0 && isActiveDay(daily[i]); i--) streak++;
  if (streak >= STREAK_STEP && streak % STREAK_STEP === 0) {
    out.push({
      id: `streak_${streak}:${today.key}`,
      type: 'streak',
      icon: '🔥',
      title: `${streak}-day streak`,
      date: today.key,
      detail: `${streak} consecutive active days.`,
    });
  }

  return out;
}

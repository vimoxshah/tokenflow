/**
 * "Your AI week" — spend this calendar week vs last, computed from decoded
 * primary records the caller already scanned. Pure, like `analytics/receipt.js`:
 * no store or filesystem access here beyond what `receipt-card.js` needs to
 * read the design tokens for a card.
 *
 * "This week" runs Monday → today (partial); "last week" is the full prior
 * Monday → Sunday, so the two are comparable even mid-week.
 */
import { weekStart, addDays } from '../analytics/aggregate.js';
import { splitCost, isAttributableBranch } from '../analytics/receipt.js';
import { usd, pct } from '../core/units.js';
import { loadDesignTokens, resolveTheme, escapeXml, orNA } from './receipt-card.js';

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function newSide() {
  return { cost: 0, priced: 0, turns: 0, sessions: new Set(), context: 0, work: 0, splitTurns: 0 };
}

function finishSide(s) {
  const ctxWork = s.context + s.work;
  return {
    cost: s.priced > 0 ? s.cost : null,
    turns: s.turns,
    sessions: s.sessions.size,
    contextShare: s.splitTurns > 0 && ctxWork > 0 ? s.context / ctxWork : null,
  };
}

/**
 * @param {{thisWeek:object, lastWeek:object, deltaPct:number|null, topBranches:object[], maxSession:object|null}} w
 */
function buildInsight(w) {
  const { thisWeek, lastWeek, deltaPct, topBranches } = w;
  if (thisWeek.cost === null) return 'No priced turns this week yet.';
  if (lastWeek.cost === null) {
    return `${usd(thisWeek.cost)} across ${thisWeek.turns} turn(s) this week; no priced data from last week to compare.`;
  }
  if (lastWeek.cost === 0) {
    return `${usd(thisWeek.cost)} this week versus ${usd(0)} last week.`;
  }
  const dir = deltaPct >= 0 ? 'up' : 'down';
  let s = `Spend is ${dir} ${pct(Math.abs(deltaPct), 0, 'n/a')} versus last week (${usd(thisWeek.cost)} vs ${usd(lastWeek.cost)}).`;
  if (topBranches.length) s += ` ${topBranches[0].branch} is the biggest line at ${usd(topBranches[0].cost)}.`;
  return s;
}

/**
 * @param {{records?:object[], now?:Date|string, book?:object|null, repoOf?:(rec:object)=>string|null}} [opt]
 * @returns {{thisWeek:object, lastWeek:object, deltaPct:number|null, topBranches:object[], maxSession:object|null, insight:string}}
 */
export function computeWeek(opt = {}) {
  const records = opt.records || [];
  const book = opt.book ?? null;
  const repoOf = opt.repoOf || ((rec) => rec.repository || rec.project || null);
  const now = opt.now instanceof Date ? opt.now : new Date(opt.now || Date.now());
  const today = toISODate(now);
  const thisFrom = weekStart(today);
  const thisTo = today;
  const lastTo = addDays(thisFrom, -1);
  const lastFrom = addDays(thisFrom, -7);

  const thisWk = newSide();
  const lastWk = newSide();
  const branchCost = new Map();
  const sessionCost = new Map();

  for (const rec of records) {
    const d = rec.date || (rec.timestamp ? rec.timestamp.slice(0, 10) : null);
    if (!d) continue;
    let bucket = null;
    let isThisWeek = false;
    if (d >= thisFrom && d <= thisTo) { bucket = thisWk; isThisWeek = true; }
    else if (d >= lastFrom && d <= lastTo) bucket = lastWk;
    if (!bucket) continue;

    bucket.turns += 1;
    if (rec.session_id) bucket.sessions.add(rec.session_id);
    const cost = rec.estimated_cost;
    const priced = cost !== null && cost !== undefined;
    if (priced) { bucket.cost += cost; bucket.priced += 1; }
    const split = splitCost(rec, book);
    if (split.context !== null) { bucket.context += split.context; bucket.work += split.work; bucket.splitTurns += 1; }

    if (isThisWeek && priced) {
      if (isAttributableBranch(rec.git_branch)) {
        const repo = repoOf(rec) || 'unknown';
        const key = `${repo}/${rec.git_branch}`;
        const e = branchCost.get(key) || { repo, branch: rec.git_branch, cost: 0 };
        e.cost += cost;
        branchCost.set(key, e);
      }
      if (rec.session_id) sessionCost.set(rec.session_id, (sessionCost.get(rec.session_id) || 0) + cost);
    }
  }

  const thisWeek = { ...finishSide(thisWk), from: thisFrom, to: thisTo };
  const lastWeek = { ...finishSide(lastWk), from: lastFrom, to: lastTo };

  const deltaPct = thisWeek.cost !== null && lastWeek.cost !== null && lastWeek.cost > 0
    ? (thisWeek.cost - lastWeek.cost) / lastWeek.cost
    : null;

  const topBranches = [...branchCost.values()].sort((a, b) => b.cost - a.cost).slice(0, 3);

  let maxSession = null;
  for (const [id, cost] of sessionCost) {
    if (!maxSession || cost > maxSession.cost) maxSession = { id, cost };
  }

  const week = { thisWeek, lastWeek, deltaPct, topBranches, maxSession };
  return { ...week, insight: buildInsight(week) };
}

/**
 * Render `computeWeek()`'s result as a self-contained SVG card. Same colour
 * and font contract as `renderReceiptCardSvg`.
 * @param {ReturnType<typeof computeWeek>} week
 * @param {{skin?:string, mode?:string, width?:number, tokens?:object}} [opt]
 */
export function renderWeekCardSvg(week, opt = {}) {
  const tokens = opt.tokens || loadDesignTokens();
  const theme = resolveTheme(tokens, opt.skin, opt.mode);
  const W0 = 640;
  const H0 = 400;
  const width = opt.width || W0;
  const height = Math.round(width * (H0 / W0));

  const cost = orNA(week.thisWeek.cost, (v) => usd(v));
  const sub = week.lastWeek.cost !== null ? `${usd(week.lastWeek.cost)} last week` : 'no priced data last week';
  const ctxShare = week.thisWeek.contextShare;
  const barX = 16;
  const barW = W0 - barX * 2;
  const ctxPct = ctxShare === null || ctxShare === undefined ? 0.5 : ctxShare;
  const ctxW = Math.max(0, Math.round(barW * ctxPct));
  const workW = Math.max(0, barW - ctxW);

  const branchesLine = week.topBranches.length
    ? week.topBranches.map((b) => `${b.branch} ${usd(b.cost)}`).join(', ')
    : 'n/a';
  const maxSessionLine = week.maxSession ? usd(week.maxSession.cost) : 'n/a';

  const rows = [
    ['Turns', String(week.thisWeek.turns ?? 0)],
    ['Sessions', String(week.thisWeek.sessions ?? 0)],
    ['Top branches', branchesLine],
    ['Most expensive session', maxSessionLine],
  ];

  const heroY = 116;
  const barY = heroY + 40;
  const legendY = barY + 26;

  const L = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W0} ${H0}" font-family="${escapeXml(theme.sans)}">`);
  L.push(`<rect x="0.5" y="0.5" width="${W0 - 1}" height="${H0 - 1}" rx="16" fill="${theme.surface1}" stroke="${theme.borderStrong}"/>`);
  L.push(`<rect x="16" y="40" width="40" height="4" rx="2" fill="${theme.accent}"/>`);
  L.push(`<text x="16" y="30" font-size="11.5" letter-spacing="0.08em" fill="${theme.textMuted}">YOUR AI WEEK</text>`);
  L.push(`<text x="16" y="66" font-size="12.5" fill="${theme.textMuted}">${escapeXml(week.thisWeek.from)} to ${escapeXml(week.thisWeek.to)}</text>`);
  L.push(`<text x="16" y="${heroY}" font-size="42" font-family="${escapeXml(theme.mono)}" fill="${theme.textPrimary}">${escapeXml(cost)}</text>`);
  L.push(`<text x="16" y="${heroY + 20}" font-size="12.5" fill="${theme.textMuted}">${escapeXml(sub)}</text>`);

  L.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" fill="${theme.surface3}"/>`);
  if (ctxW > 0) L.push(`<rect x="${barX}" y="${barY}" width="${ctxW}" height="10" rx="5" fill="${theme.context}"/>`);
  if (workW > 0) L.push(`<rect x="${barX + ctxW}" y="${barY}" width="${workW}" height="10" rx="5" fill="${theme.work}"/>`);
  L.push(`<circle cx="20" cy="${legendY - 4}" r="4" fill="${theme.context}"/>`);
  L.push(`<text x="30" y="${legendY}" font-size="12.5" fill="${theme.textSecondary}">${escapeXml(orNA(ctxShare, (v) => pct(v, 0, 'n/a')))} re-sent context</text>`);
  L.push(`<circle cx="220" cy="${legendY - 4}" r="4" fill="${theme.work}"/>`);
  L.push(`<text x="230" y="${legendY}" font-size="12.5" fill="${theme.textSecondary}">${escapeXml(orNA(ctxShare, (v) => pct(1 - v, 0, 'n/a')))} fresh work</text>`);

  let y = legendY + 34;
  const rowH = 24;
  for (const [label, value] of rows) {
    L.push(`<text x="16" y="${y}" font-size="13" fill="${theme.textMuted}">${escapeXml(label)}</text>`);
    L.push(`<text x="${W0 - 16}" y="${y}" text-anchor="end" font-family="${escapeXml(theme.mono)}" font-size="13" fill="${theme.textPrimary}">${escapeXml(value)}</text>`);
    y += rowH;
  }
  L.push(`<line x1="16" y1="${y + 6}" x2="${W0 - 16}" y2="${y + 6}" stroke="${theme.border}"/>`);
  L.push(`<text x="16" y="${y + 26}" font-size="11.5" fill="${theme.textMuted}">${escapeXml(week.insight)}</text>`);
  L.push('</svg>');
  return L.join('');
}

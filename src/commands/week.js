/**
 * `tokenflow week` -- "Your AI week": spend this calendar week vs last week,
 * computed from the same store every other surface reads.
 *
 *   tokenflow week                      text summary
 *   tokenflow week --svg week.svg       a shareable card
 *   tokenflow week --svg week.svg --png week.png   card + a local screenshot
 *   tokenflow week --json               everything, machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, paths } from '../core/config.js';
import { readJson } from '../core/store.js';
import { buildPriceBook } from '../core/pricing.js';
import { makeRepoResolver } from '../core/repo.js';
import { weekStart, addDays } from '../analytics/aggregate.js';
import { loadPrimaryRecords } from './receipt.js';
import { computeWeek, renderWeekCardSvg } from '../export/week-card.js';
import { renderSvgToPng } from '../export/receipt-card.js';
import { usd, pct } from '../core/units.js';

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function renderWeekText(week) {
  const L = [];
  L.push(`Your AI week: ${week.thisWeek.from} to ${week.thisWeek.to}`);
  L.push(`  Spend: ${usd(week.thisWeek.cost, 'n/a')} (last week ${usd(week.lastWeek.cost, 'n/a')})`);
  if (week.thisWeek.contextShare !== null) L.push(`  Context share: ${pct(week.thisWeek.contextShare, 0, 'n/a')}`);
  L.push(`  Turns: ${week.thisWeek.turns}   Sessions: ${week.thisWeek.sessions}`);
  if (week.topBranches.length) {
    L.push('  Top branches:');
    for (const b of week.topBranches) L.push(`    ${b.repo}/${b.branch}  ${usd(b.cost)}`);
  }
  if (week.maxSession) L.push(`  Most expensive session: ${usd(week.maxSession.cost)}`);
  L.push(`  ${week.insight}`);
  return L.join('\n');
}

/**
 * @param {object} flags parsed CLI flags
 * @returns {{text:string, json:object}}
 */
export function run(flags = {}) {
  const cfg = loadConfig();
  const pricing = readJson(paths().pricing, {});
  const book = buildPriceBook(pricing);
  const now = new Date();

  // A single scan covers this week and last week even across a month
  // boundary; loadPrimaryRecords already prunes shards outside the window.
  const today = now.toISOString().slice(0, 10);
  const thisFrom = weekStart(today);
  const from = addDays(thisFrom, -7);
  const records = loadPrimaryRecords({ from, to: today });

  const week = computeWeek({ records, now, book, repoOf: makeRepoResolver() });

  const skin = cfg.ui?.skin || 'aurora';
  const mode = cfg.ui?.mode || cfg.ui?.theme || 'dark';
  let text = renderWeekText(week);

  if (typeof flags.svg === 'string') {
    const svgPath = expandHome(flags.svg);
    fs.writeFileSync(svgPath, renderWeekCardSvg(week, { skin, mode }));
    text += `\n\nWrote SVG week card to ${svgPath}`;
    if (typeof flags.png === 'string') {
      const pngPath = expandHome(flags.png);
      // Matches renderWeekCardSvg's own default aspect ratio (640x400).
      const res = renderSvgToPng(svgPath, pngPath, { width: 640, height: 400 });
      text += res.ok ? `\nWrote PNG week card to ${pngPath}` : `\n${res.message}`;
    }
  } else if (typeof flags.png === 'string') {
    // --png with no --svg: the SVG is written alongside it, and named, so
    // there is always a deliverable even without a local Chromium.
    const pngPath = expandHome(flags.png);
    const svgPath = `${pngPath}.svg`;
    fs.writeFileSync(svgPath, renderWeekCardSvg(week, { skin, mode }));
    const res = renderSvgToPng(svgPath, pngPath, { width: 640, height: 400 });
    text += res.ok ? `\nWrote PNG week card to ${pngPath} (SVG at ${svgPath})` : `\n${res.message}`;
  }

  return { text, json: week };
}

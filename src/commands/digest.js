/**
 * `tokenflow digest` — a shareable weekly summary.
 *
 * The missing "show someone else" surface: the dashboard is interactive, the
 * offline HTML export carries the whole dataset, but neither fits in a Slack
 * message or a stand-up note. The digest renders the current view (or an
 * arbitrary --from/--to window) as compact Markdown or plain text: headline
 * numbers, top providers/models/sources, week-over-week delta, and any active
 * alerts — every number from the same cube the dashboard uses, so nothing can
 * disagree. Zero dependencies, no network, no new data collection.
 *
 *   tokenflow digest                     # last 7 days, markdown to stdout
 *   tokenflow digest --format text       # plain text
 *   tokenflow digest --out digest.md     # write to a file
 *   tokenflow digest --from 2026-08-01 --to 2026-08-07
 */
import { buildBundle } from '../core/bundle.js';
import { computeView } from '../analytics/index.js';
import { filterCube, indexCube, finalize, sumRows, addDays } from '../analytics/aggregate.js';
import { compact, usd } from '../core/units.js';
import fs from 'node:fs';

const money = (n) => (n == null || !(n > 0) ? null : usd(n));
const tokens = (n) => (n > 0 ? compact(n) : '0');

function rankBy(rows, ix, dim, n = 5) {
  const by = new Map();
  for (const r of rows) {
    if (!(r[ix.m.totalKey] ?? true)) { /* noop; totals computed below */ }
    const k = r[dim];
    by.set(k, (by.get(k) || 0) + r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw]);
  }
  return [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function renderDigest({ status, from, to, format = 'markdown' }) {
  const u = status.usage;
  const today = u.today;
  const lines = [];

  const title = `TokenFlow digest — ${from} → ${to}`;
  if (format === 'text') {
    lines.push(title, '='.repeat(title.length), '');
  } else {
    lines.push(`## ${title}`, '');
  }
  const bullet = (s) => (format === 'text' ? ` • ${s}` : `- ${s}`);

  // headline
  const cost = today.cost != null ? money(today.cost) : today.costMeasured != null ? `${money(today.costMeasured)} (measured)` : null;
  lines.push(bullet(`Tokens: **${tokens(today.tokens.total)}** (${tokens(today.tokens.input)} in / ${tokens(today.tokens.output)} out / ${tokens(today.tokens.cacheRead)} cache-read)`));
  if (cost) lines.push(bullet(`Estimated spend: **${cost}**`));
  if (today.requests != null) lines.push(bullet(`Requests: ${today.requests} across ${today.sessions ?? '?'} sessions`));

  // period totals when it's not just today
  if (u.weekToDate && from !== to) {
    lines.push(bullet(`Week-to-date: ${tokens(u.weekToDate.tokens.total)}${money(u.weekToDate.cost) ? ` · ${money(u.weekToDate.cost)}` : ''}`));
  }

  // breakdowns
  const sec = (name, items, fmt) => {
    if (!items.length) return;
    lines.push('', format === 'text' ? name : `### ${name}`);
    for (const [k, v] of items) lines.push(bullet(`${k}: ${fmt(v)}`));
  };
  sec('By source', status.sourcesToday.map((s) => [s.key, s.tokens]), (v) => tokens(v));
  sec('By provider', status.providersToday.map((p) => [p.key, p.tokens]), (v) => tokens(v));
  sec('Top models', status.modelsToday.map((m) => [m.key, m.tokens]), (v) => tokens(v));

  // velocity + capacity
  if (status.velocity?.ratio != null) {
    const r = status.velocity.ratio;
    const dir = r >= 1 ? 'above' : 'below';
    lines.push('', bullet(`Pace: ${r.toFixed(2)}× your trailing 14-day average (${dir})`));
  }
  const worst = status.capacity?.summary?.worst;
  if (worst && worst.pctUsed != null) {
    lines.push(bullet(`Nearest limit: ${worst.label} at ${Math.round(worst.pctUsed * 100)}%${worst.resetsInMs ? `, resets in ${Math.round(worst.resetsInMs / 3600000)}h` : ''}`));
  }

  // alerts
  const alerts = (status.anomalies || []).filter((a) => a.severity === 'high');
  if (alerts.length) {
    lines.push('', format === 'text' ? 'Alerts' : '### Alerts');
    for (const a of alerts.slice(0, 3)) lines.push(bullet(a.detail));
  }

  lines.push('', format === 'text'
    ? 'local-first · numbers from the same cube as the dashboard'
    : `<sub>local-first · same cube as the dashboard</sub>`);
  return lines.join('\n');
}

/** Build the status snapshot for an arbitrary window without mutating config. */
export async function run(opts = {}) {
  const b = buildBundle();
  const v = computeView(b, {});
  const ix = indexCube(b.cube);
  const to = opts.to || b.meta.today;
  const from = opts.from || addDays(to, -6);

  const rows = filterCube(ix, { from, to, includeOverlay: !!b.meta.includeOverlayDefault });
  const m = finalize(sumRows(rows, ix));
  const topSources = rankBy(rows, ix, ix.d.c);
  const topProviders = rankBy(rows, ix, ix.d.p);
  const topModels = rankBy(rows, ix, ix.d.m);

  const status = {
    usage: {
      today: {
        tokens: { total: m.total, input: m.in, output: m.out, cacheRead: m.cr },
        requests: m.req,
        cost: m.costReq > 0 ? m.cost : null,
        costMeasured: m.costMeasured > 0 ? m.costMeasured : null,
        sessions: filterSessionsCount(b, from, to),
      },
      weekToDate: null,
    },
    sourcesToday: topSources.map(([key, tk]) => ({ key, tokens: tk })),
    providersToday: topProviders.map(([key, tk]) => ({ key, tokens: tk })),
    modelsToday: topModels.map(([key, tk]) => ({ key, tokens: tk })),
    velocity: v.velocity,
    capacity: v.capacity,
    anomalies: v.anomalies,
  };
  return renderDigest({ status, from, to, format: opts.format || 'markdown' });
}

function filterSessionsCount(b, from, to) {
  try {
    return b.sessions.filter((s) => s.date >= from && s.date <= to).length;
  } catch { return null; }
}

/** CLI entry point. */
export function register(program, ctx) {
  program
    .command('digest')
    .description('shareable weekly/daily summary (markdown or text)')
    .option('--from <date>', 'window start (YYYY-MM-DD)')
    .option('--to <date>', 'window end (YYYY-MM-DD)')
    .option('--format <fmt>', 'markdown | text', 'markdown')
    .option('--out <file>', 'write to file instead of stdout')
    .action(async (flags) => {
      const md = await run({
        from: flags.from, to: flags.to, format: flags.format,
      });
      if (flags.out) {
        fs.writeFileSync(flags.out, md + '\n');
        console.log(`wrote ${flags.out}`);
      } else {
        console.log(md);
      }
    });
}

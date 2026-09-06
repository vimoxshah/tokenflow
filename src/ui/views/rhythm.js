/**
 * The Rhythm tab: how the work happens — focus, switching, and when a turn
 * costs most.
 *
 * Derived only from `ctx.bundle.sessions` and the per-hour rollup behind
 * `ctx.view` (`view.hourly.buckets`, the same rollup the Time patterns tab
 * charts). All the arithmetic lives in `src/analytics/rhythm.js`, a pure
 * module with its own tests; this file only turns that into markup.
 */
import { el, columns, table, SEQ } from '../charts.js';
import { filterSessions } from '../../analytics/aggregate.js';
import { deepWork, switching, costliestHour, focusDays, rhythmSummary } from '../../analytics/rhythm.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'rhythm';
export const label = 'Rhythm';
export const order = 115;
export const css = './styles/rhythm.css';

// The same number-bolding pass the Overview's story strip uses, so a figure
// (a number with its unit — "50.0%", "01:00", "$2.10") gets the figure face
// and the words around it stay words. Copied rather than imported: a view
// must not import app.js.
const FIGURE_RE = /((?:\$|[+\-−]|r = )?\d+(?:[.,]\d+)*(?:\s?(?:[KMB](?![a-z])|×|x(?![a-z])|%|days?|hours?|min(?![a-z])))?)/g;
const STORY_ICONS = ['🎯', '🔀', '💰'];

/**
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  const { fmt } = ctx;
  const { compact, usd, pct, int, hourLabel, shortDate, longDate, humanDuration } = fmt;
  const v = ctx.view;

  // filterSessions applies the date, provider, model and other dimension
  // filters — the same predicate set the cube uses — but not hourFrom/hourTo:
  // that filter narrows which token EVENTS count, and a whole session cannot
  // be half inside an hour window. The banner below says this plainly rather
  // than letting the hour filter look like it silently does nothing.
  const sessions = filterSessions(ctx.bundle.sessions || [], ctx.view.filters);

  const deep = deepWork(sessions);
  const sw = switching(sessions);
  const costliest = costliestHour(v.hourly?.buckets || []);
  const focus = focusDays(sessions);
  const sentences = rhythmSummary({ deep, switching: sw, costliest });

  const root = el('div', { class: 'grid' });
  root.appendChild(storyStrip(sentences));
  root.appendChild(el('div', { class: 'banner info' }, [el('span', {
    text: 'Deep-work, switching and focus-day metrics use sessions filtered by date, provider, model and the other dimension filters. The hour-of-day filter narrows the charts on other tabs but does not apply to a whole session here, so it is left out of these three metrics; the cost-per-hour chart below still follows it.',
  })]));
  root.appendChild(kpiCard(ctx, { deep, sw, costliest }, { compact, usd, pct, int, hourLabel, shortDate }));
  root.appendChild(costliestHourCard(ctx, costliest, { compact, usd, int, hourLabel }));
  root.appendChild(switchingCard(ctx, sw, { int, shortDate, longDate }));
  root.appendChild(focusDaysCard(ctx, focus, { compact, pct, int, shortDate, longDate }));
  return root;
}

function storyStrip(sentences) {
  const strip = el('div', { class: 'story' });
  sentences.forEach((text, i) => {
    const p = el('p', { class: 'story-text' });
    let last = 0;
    for (const m of text.matchAll(FIGURE_RE)) {
      if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)));
      p.appendChild(el('strong', { text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
    strip.appendChild(el('div', { class: 'story-line' }, [
      el('span', { class: 'story-ico', text: STORY_ICONS[i] || '•', 'aria-hidden': 'true' }),
      p,
    ]));
  });
  return strip;
}

function kpiCard(ctx, { deep, sw, costliest }, { compact, usd, pct, int, hourLabel, shortDate }) {
  const box = el('div', { class: 'cards' });
  box.appendChild(ctx.kpi('Deep-work sessions', int(deep.count), deep.total ? `${pct(deep.shareOfSessions, 1)} of sessions` : '—'));
  box.appendChild(ctx.kpi('Share of tokens', pct(deep.shareOfTokens, 1), deep.longest ? `longest ran ${ctx.fmt.humanDuration(deep.longest.durationMs)}` : '—'));
  box.appendChild(ctx.kpi('Avg project switches / day', sw.average !== null ? sw.average.toFixed(1) : '—', sw.worst ? `worst ${int(sw.worst.switches)} on ${shortDate(sw.worst.date)}` : '—'));
  const cHour = costliest?.costliest;
  box.appendChild(ctx.kpi(
    'Costliest hour',
    cHour ? `${hourLabel(cHour.hour)}:00` : '—',
    cHour
      ? (costliest.metric === 'cost' ? `${usd(cHour.value)} / priced request` : `${compact(cHour.value)} tokens / request`)
      : (costliest ? 'no priced requests in this slice' : 'not derivable from the aggregate'),
  ));
  return ctx.card(
    'Rhythm at a glance',
    'Deep work: 45 minutes or more of continuous activity, or 40 or more turns when duration is unknown. Switching: distinct projects touched in a day, minus one. Costliest hour: highest estimated cost per priced request (tokens per request when no price is configured), by hour of day.',
    box,
  );
}

function seqColor(value, max) {
  if (value === null || value === undefined || !max) return 'var(--hairline)';
  const t = Math.max(0, Math.min(1, value / max));
  return SEQ[Math.round(t * (SEQ.length - 1))];
}

function costliestHourCard(ctx, costliest, { compact, usd, int, hourLabel }) {
  if (!costliest) {
    return ctx.card(
      'Cost per request by hour',
      'Estimated cost per priced request by hour of day, from the per-hour rollup behind this dashboard.',
      ctx.emptyCard('Not derivable from the aggregate', 'This slice’s per-hour rollup carries neither a cost nor a token count to divide by requests.'),
    );
  }
  const isCost = costliest.metric === 'cost';
  const maxV = Math.max(0, ...costliest.hours.map((h) => h.value || 0));
  const chartData = costliest.hours.map((h) => {
    const marked = costliest.costliest && h.hour === costliest.costliest.hour;
    return {
      label: hourLabel(h.hour) + (marked ? '★' : ''),
      value: h.value,
      hour: h.hour,
      color: seqColor(h.value, maxV),
      fmtXLong: `${hourLabel(h.hour)}:00${marked ? ', the costliest hour' : ''}`,
      extra: [{ color: null, name: isCost ? 'Priced requests' : 'Requests', value: int(h.requests) }],
    };
  });
  const hint = !costliest.costliest
    ? (isCost
      ? 'ESTIMATE. No priced requests anywhere in this slice, so cost per request is not shown. Configure pricing to see it. Unpriced requests are excluded from the average rather than counted as free.'
      : 'No requests in this slice.')
    : (isCost
      ? `ESTIMATE. Divides estimated cost by PRICED requests only, per hour. An unpriced request is excluded, never counted as free. ★ marks the costliest hour, ${hourLabel(costliest.costliest.hour)}:00.`
      : `No pricing configured, so this shows tokens per request instead. ★ marks the heaviest hour, ${hourLabel(costliest.costliest.hour)}:00.`);
  return ctx.chartCard(
    'rhythm-cost-hour',
    isCost ? 'Cost per request by hour' : 'Tokens per request by hour',
    hint,
    (w) => columns({
      data: chartData, width: w, height: 220,
      fmtY: (x) => (isCost ? usd(x) : compact(x)),
      valueLabel: isCost ? 'Cost / priced request' : 'Tokens / request',
      ariaLabel: isCost ? 'Estimated cost per priced request by hour of day' : 'Tokens per request by hour of day',
    }),
    {
      columns: [
        { key: 'hour', label: 'Hour', text: true, value: (r) => hourLabel(r.hour) + ':00' },
        { key: 'value', label: isCost ? 'Cost / priced request' : 'Tokens / request', value: (r) => (r.value === null ? null : (isCost ? usd(r.value) : compact(r.value))) },
        { key: 'requests', label: isCost ? 'Priced requests' : 'Requests', value: (r) => int(r.requests) },
      ],
      rows: costliest.hours,
    },
  );
}

function switchingCard(ctx, sw, { int, shortDate, longDate }) {
  if (!sw.days.length) {
    return ctx.card(
      'Project switches per day',
      'Switches = distinct projects touched in a day, minus one. Days with no sessions are not shown.',
      ctx.emptyCard('No sessions with a known day', 'Project switching needs at least one session with a date in this slice.'),
    );
  }
  const maxSwitch = Math.max(0, ...sw.days.map((d) => d.switches));
  const data = sw.days.map((d) => ({
    label: shortDate(d.date), value: d.switches, date: d.date,
    color: seqColor(d.switches, maxSwitch),
    fmtXLong: longDate(d.date),
    extra: [{ color: null, name: 'Projects touched', value: int(d.projects) }],
  }));
  return ctx.chartCard(
    'rhythm-switching',
    'Project switches per day',
    'Switches = distinct projects touched that day, minus one. Only days with at least one session are shown; a day with no sessions has no measurable switching, so it is left out rather than shown as zero.',
    (w) => columns({
      // Switches are always whole numbers, but the chart's own gridline
      // picker can land on a half-step for a small max (e.g. 0, 0.5, 1, 1.5,
      // 2) — rounding those through int() would print "1" twice. Showing the
      // real half-step value keeps every gridline label distinct.
      data, width: w, height: 200, fmtY: (x) => (Number.isInteger(x) ? int(x) : x.toFixed(1)), valueLabel: 'Switches',
      ariaLabel: 'Project switches per day',
    }),
    {
      columns: [
        { key: 'date', label: 'Date', text: true, value: (r) => longDate(r.date) },
        { key: 'projects', label: 'Projects touched', value: (r) => int(r.projects) },
        { key: 'switches', label: 'Switches', value: (r) => int(r.switches) },
      ],
      rows: sw.days,
    },
  );
}

function focusDaysCard(ctx, focus, { compact, pct, int, shortDate, longDate }) {
  const hint = 'Days ranked by the share of that day’s tokens spent in deep-work sessions (45+ minutes continuous, or 40+ turns when duration is unknown). Days with zero tokens are excluded: a 0/0 share is not a real 0%.';
  if (!focus.length) {
    return ctx.card('Focus days', hint, ctx.emptyCard('No days to rank', 'Needs at least one session with tokens and a known day in this slice.'));
  }
  return ctx.card('Focus days', hint, table([
    { key: 'date', label: 'Date', text: true, value: (r) => longDate(r.date) },
    { key: 'share', label: 'Deep-work share of tokens', value: (r) => pct(r.share, 1) },
    { key: 'deepTokens', label: 'Deep-work tokens', value: (r) => compact(r.deepTokens) },
    { key: 'total', label: 'Total tokens', value: (r) => compact(r.total) },
    { key: 'sessions', label: 'Sessions', value: (r) => int(r.sessions) },
  ], focus, { emptyText: 'No focus days in this slice.' }));
}

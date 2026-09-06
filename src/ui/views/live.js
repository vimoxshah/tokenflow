/**
 * The Live tab: what is running right now, today's receipts, the guard, the
 * last 24 hours by source, then watcher status, declared capacity limits,
 * forecast and anomalies.
 *
 * This is the exemplar registered view. Everything it uses from the host comes
 * in as a ViewContext, so it imports no application state and app.js never
 * imports it back. Chart primitives are imported directly from ../charts.js and
 * the pure shaping from ../../analytics/live-view.js: a view may import
 * anything that does not lead back to app.js.
 *
 * The header live pill's own /api/live loop stays in app.js — it runs whichever
 * tab is open. This view keeps a second, faster poll of the same endpoint for
 * the four "right now" sections, and holds the result in module state so a
 * filter change repaints them without refetching.
 *
 * Nothing here animates toward a number it was not given. Every value on this
 * tab is the last thing `data/status.json` said, and it changes when that file
 * changes and at no other moment.
 */
import { el, miniBar, columns, observeWidth, sparkline, SERIES_VARS, OTHER_COLOR } from '../charts.js';
import {
  asOfLabel, capRows, contextGauge, costLabel, countLabel, guardChip,
  orderSparkSources, sessionPlace, turnsLabel,
} from '../../analytics/live-view.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'live';
export const label = 'Live';
export const order = 30;
export const css = './styles/live.css';

/** How often the four "right now" sections refetch /api/live, in ms. */
const POLL_MS = 30000;
/** Session cards shown at once. The producer already caps its list here too. */
const MAX_SESSION_CARDS = 8;
/** Sparkline charts before the remaining sources fold into one "other". */
const MAX_SPARK_SERIES = 5;
/** Receipt rows on this card. The producer caps its list at the same number. */
const MAX_RECEIPT_ROWS = 3;

/**
 * The last /api/live payload, or null before the first one arrives.
 *
 * Module state rather than ctx.S: `view()` runs on every filter and theme
 * change, and refetching there would make the numbers flicker for reasons that
 * have nothing to do with the store.
 * @type {any}
 */
let status = null;
/** True between onEnter and onLeave: a late fetch must not repaint a left tab. */
let active = false;

const SEV = {
  high: { label: 'high', cls: 'sev-high' },
  warn: { label: 'watch', cls: 'sev-warn' },
  info: { label: 'info', cls: 'sev-info' },
};

/**
 * The Live tab body.
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  const root = el('div', { class: 'grid' });
  // The four "right now" sections read data/status.json, which only a running
  // watcher writes. A saved file has neither, so offline this tab stays exactly
  // what it was: capacity, forecast and anomalies out of the embedded bundle.
  if (!ctx.snapshot && status) {
    for (const node of recentSections(ctx, status)) root.appendChild(node);
  }
  if (!ctx.snapshot) root.appendChild(liveWatcherCard(ctx));
  root.appendChild(capacityCard(ctx));
  root.appendChild(forecastCard(ctx));
  root.appendChild(anomaliesCard(ctx));
  return root;
}

/**
 * Fetch the live status, then repaint. Called once on entry and every 30s.
 * @param {ViewContext} ctx
 */
async function refreshStatus(ctx) {
  let next = null;
  try {
    next = await ctx.fetchJson('/api/live');
  } catch {
    // The server is gone or answered an error. Keep the last status: blanking
    // the sections would be a change in what this tab claims, and the status
    // file never said anything of the kind.
    return;
  }
  if (!active || !next) return;
  status = next;
  ctx.rerender({ recompute: false });
}

/**
 * Start the poll. Registered synchronously, before any await, because app.js
 * only files a timer under the tab's lifetime while `onEnter` is on the stack —
 * one registered after an await would be cleared by the very next render.
 * @param {ViewContext} ctx
 */
export function onEnter(ctx) {
  if (ctx.snapshot) return;
  active = true;
  ctx.schedule(() => { void refreshStatus(ctx); }, POLL_MS);
  void refreshStatus(ctx);
}

/** Stop accepting an in-flight fetch. app.js clears the interval itself. */
export function onLeave() {
  active = false;
}

// ------------------------------------------------------- right now sections --

/**
 * Live sessions, today's receipts, the guard and the last 24 hours by source.
 * @param {ViewContext} ctx
 * @param {any} st the /api/live payload
 * @returns {Node[]}
 */
function recentSections(ctx, st) {
  const out = [];
  const asOf = st.liveSessions?.asOf ?? st.receiptsToday?.asOf ?? st.freshness?.lastRefresh ?? null;
  if (st.liveSessions) out.push(...liveSessionsSection(ctx, st));
  if (st.receiptsToday) out.push(receiptsTodayCard(ctx, st.receiptsToday, asOf));
  if (st.guard) out.push(guardCard(ctx, st.guard));
  if (st.sparklines) out.push(...sparklinesSection(ctx, st.sparklines, asOf));
  return out;
}

/**
 * One card per live session, under a header that dates itself.
 *
 * The header carries the relative asOf because this is a file read on a cycle,
 * not a stream: "as of 3 min ago" is the honest claim, and "Live sessions" on
 * its own would not be.
 * @param {ViewContext} ctx
 * @param {any} st
 * @returns {Node[]}
 */
function liveSessionsSection(ctx, st) {
  const ls = st.liveSessions;
  const policy = st.guard?.policy ?? null;
  const sessions = Array.isArray(ls.sessions) ? ls.sessions.slice(0, MAX_SESSION_CARDS) : [];
  const head = ctx.sectionTitle(`Live sessions, as of ${asOfLabel(ls.asOf)}`);
  if (!sessions.length) {
    const minutes = Number.isFinite(ls.windowMinutes) ? ls.windowMinutes : null;
    // The section title above is the heading, so the empty state gets the card
    // surface without a second one.
    return [head, el('div', { class: 'card' }, [ctx.emptyCard(
      minutes === null ? 'No session active in the last few minutes.' : `No session active in the last ${minutes} minutes.`,
      'A session appears here while its log is still being written.',
    )])];
  }
  const grid = el('div', { class: 'live-sessions' });
  for (const s of sessions) grid.appendChild(sessionCard(ctx, s, policy));
  return [head, grid];
}

/**
 * @param {ViewContext} ctx
 * @param {any} s one entry of liveSessions.sessions
 * @param {any} policy status.guard.policy, for the context cap
 */
function sessionCard(ctx, s, policy) {
  const place = sessionPlace(s);
  const chip = guardChip(s.guard);
  const cost = costLabel({ costUsd: s.costUsd, coverage: s.coverage });
  const gauge = contextGauge({ contextTokens: s.contextTokens, policy });

  const card = el('div', { class: 'card live-session' });

  const head = el('div', { class: 'live-session-head' });
  const where = el('div', { class: 'live-session-where' });
  where.appendChild(el('div', { class: 'live-session-project', text: place.where }));
  where.appendChild(el('div', { class: 'hint live-session-branch', text: place.branch }));
  head.appendChild(where);
  head.appendChild(el('span', {
    class: `badge live-guard live-guard-${chip.level}`,
    text: chip.text,
    title: chip.title,
  }));
  card.appendChild(head);

  card.appendChild(el('div', { class: 'hint live-session-meta', text: `${s.model || 'n/a'} · ${s.source || 'n/a'}` }));

  card.appendChild(statRow('turns', el('span', { text: turnsLabel(s) })));

  const spend = el('span', {}, [
    document.createTextNode(cost.text),
    cost.priced ? el('span', { class: 'badge est live-est', text: 'est.', title: 'Estimated from the price book, not billed by the vendor.' }) : null,
  ]);
  card.appendChild(statRow('spend', spend));
  if (cost.coverageText) card.appendChild(el('div', { class: 'hint live-session-note', text: cost.coverageText }));

  const gaugeBox = el('div', { class: 'live-gauge' });
  const gaugeTop = el('div', { class: 'live-gauge-top' }, [
    el('span', { class: 'live-k', text: 'context' }),
    el('span', { class: 'live-gauge-value', text: gauge.text }),
  ]);
  gaugeBox.appendChild(gaugeTop);
  const track = el('div', {
    class: 'live-gauge-track',
    role: 'img',
    'aria-label': `Context window ${gauge.pctText} used, ${gauge.text}`,
  });
  const fill = el('div', { class: 'live-gauge-fill' });
  // No transition on this width: the fill may only ever show a value the status
  // file actually reported, never a sweep toward one.
  fill.style.width = `${(gauge.ratio ?? 0) * 100}%`;
  track.appendChild(fill);
  gaugeBox.appendChild(track);
  gaugeBox.appendChild(el('div', { class: 'hint live-gauge-foot' }, [
    document.createTextNode(gauge.pctText),
    el('span', {
      class: 'live-gauge-scale',
      text: gauge.declared ? 'declared cap' : 'assumed 200K window',
      title: gauge.declared
        ? 'The cap you declared with tokenflow guard --set maxContextTokens=<n>.'
        : 'No context cap is declared, so the gauge draws against a 200K window. It is a scale, not a limit.',
    }),
  ]));
  card.appendChild(gaugeBox);

  card.appendChild(el('div', {
    class: 'hint live-session-note',
    text: `started ${asOfLabel(s.startedAt)} · last turn ${asOfLabel(s.lastActivityAt)}`,
  }));
  return card;
}

/** A `label   value` line inside a session card. */
function statRow(k, valueNode) {
  return el('div', { class: 'live-stat' }, [
    el('span', { class: 'live-k', text: k }),
    el('span', { class: 'live-v' }, [valueNode]),
  ]);
}

/**
 * Today's receipts: what each repository and branch cost so far today.
 * @param {ViewContext} ctx
 * @param {any} r status.receiptsToday
 * @param {string|null} asOf
 */
function receiptsTodayCard(ctx, r, asOf) {
  const { usd } = ctx.fmt;
  // Three rows is this card's own contract. The producer already caps its list
  // at three, but a view that trusts that would grow silently if it stopped.
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_RECEIPT_ROWS);
  const hint = `Cost by repository and branch since local midnight, as of ${asOfLabel(r.asOf ?? asOf)}.`;
  if (!items.length) {
    return ctx.card("Today's receipts", hint, ctx.emptyCard(
      'Nothing recorded today yet.',
      'A row appears here for each repository and branch as soon as a turn lands in the store.',
    ));
  }
  const body = el('div', { class: 'live-receipts' });
  for (const it of items) {
    const row = el('div', { class: 'live-receipt' });
    const where = el('div', { class: 'live-receipt-where' });
    where.appendChild(el('div', { class: 'live-receipt-repo', text: it.repo || 'n/a' }));
    where.appendChild(el('div', { class: 'hint', text: it.branch || 'n/a' }));
    row.appendChild(where);
    row.appendChild(el('div', { class: 'live-receipt-cost' }, [
      document.createTextNode(it.costUsd === null || it.costUsd === undefined ? 'n/a' : usd(it.costUsd, 'n/a')),
    ]));
    row.appendChild(el('div', { class: 'hint live-receipt-n', text: countLabel(it.turns, 'turn') }));
    row.appendChild(el('div', { class: 'hint live-receipt-n', text: countLabel(it.sessions, 'session') }));
    body.appendChild(row);
  }
  const total = el('div', { class: 'live-receipt live-receipt-total' });
  total.appendChild(el('div', { class: 'live-receipt-where' }, [el('div', { text: 'Day total' })]));
  const totalPriced = typeof r.totalCostUsd === 'number' && Number.isFinite(r.totalCostUsd);
  total.appendChild(el('div', { class: 'live-receipt-cost' }, [
    document.createTextNode(totalPriced ? usd(r.totalCostUsd, 'n/a') : 'n/a'),
    // "est." qualifies a figure. With no figure there is nothing to qualify.
    totalPriced ? el('span', { class: 'badge est live-est', text: 'est.', title: 'Estimated from the price book, not billed by the vendor.' }) : null,
  ]));
  // Two empty cells so the total lines up with the rows above it.
  total.appendChild(el('div', { class: 'live-receipt-n' }));
  total.appendChild(el('div', { class: 'live-receipt-n' }));
  body.appendChild(total);
  return ctx.card("Today's receipts", hint, body);
}

/**
 * The guard: the caps you declared, the last verdict, and the one command that
 * changes them.
 *
 * There is no form here on purpose. The guard runs as a Claude Code hook out of
 * config.yaml, so a cap edited anywhere but config would let the hook and this
 * page disagree about what is allowed.
 * @param {ViewContext} ctx
 * @param {any} g status.guard
 */
function guardCard(ctx, g) {
  const caps = capRows(g.policy);
  const body = el('div', { class: 'live-guard-body' });

  body.appendChild(el('div', { class: 'live-sub', text: 'Declared caps' }));
  if (!caps.length) {
    body.appendChild(el('p', { class: 'hint live-none', text: 'No caps set. Nothing can trip until you declare one.' }));
  } else {
    const list = el('div', { class: 'live-caps' });
    for (const c of caps) {
      list.appendChild(el('div', { class: 'live-cap' }, [
        el('span', { class: 'live-k', text: c.label }),
        el('span', { class: 'live-v', text: c.text }),
      ]));
    }
    body.appendChild(list);
  }

  body.appendChild(el('div', { class: 'live-sub', text: 'Last verdict' }));
  const v = g.lastVerdict;
  if (!v) {
    body.appendChild(el('p', { class: 'hint live-none', text: 'No verdict yet.' }));
  } else {
    const chip = guardChip(v);
    const line = el('div', { class: 'live-verdict' });
    line.appendChild(el('span', { class: `badge live-guard live-guard-${chip.level}`, text: chip.text, title: chip.title }));
    line.appendChild(el('span', { class: 'mono live-verdict-id', text: v.sessionId || 'n/a' }));
    line.appendChild(el('span', { class: 'hint', text: asOfLabel(v.at) }));
    body.appendChild(line);
    if (chip.title) body.appendChild(el('p', { class: 'hint live-reason', text: chip.title }));
    body.appendChild(el('p', {
      class: 'hint live-source',
      text: v.source === 'derived'
        ? 'Source: derived, which means computed from the live sessions above.'
        : `Source: ${v.source || 'n/a'}.`,
    }));
  }

  body.appendChild(el('div', { class: 'live-sub', text: 'Declare a cap' }));
  body.appendChild(el('pre', { class: 'mono live-cmd', text: 'tokenflow guard --set maxCostUsd=50' }));
  body.appendChild(el('p', { class: 'hint', text: 'Caps are declared in config so the hook and this page agree about what is allowed.' }));

  return ctx.card('Guard', 'The in-session circuit breaker: what it may stop, and what it last decided.', body);
}

/**
 * One small chart per source over the last 24 hourly buckets.
 *
 * Sources past the fifth fold into a summed "other" rather than disappearing,
 * and every colour comes from the source's alphabetical position, so a quiet
 * hour cannot repaint the chart above it.
 * @param {ViewContext} ctx
 * @param {any} sp status.sparklines
 * @param {string|null} asOf
 * @returns {Node[]}
 */
function sparklinesSection(ctx, sp, asOf) {
  const { compact, hourLabel } = ctx.fmt;
  const hours = Array.isArray(sp.hours) ? sp.hours : [];
  const { series, folded } = orderSparkSources({ bySource: sp.bySource, max: MAX_SPARK_SERIES });
  const head = ctx.sectionTitle('Tokens per hour, by source');
  const caption = `tokens per hour, last 24 h, as of ${asOfLabel(asOf)}`;
  if (!series.length) {
    return [head, el('div', { class: 'card' }, [ctx.emptyCard('No tokens recorded in the last 24 hours.', caption)])];
  }

  const hourText = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? 'n/a' : `${hourLabel(t.getHours())}:00`;
  };

  const grid = el('div', { class: 'live-sparks' });
  for (const s of series) {
    // Wrap rather than fall through to the muted colour: past eight sources a
    // ninth would otherwise be indistinguishable from the folded "other". Each
    // source owns its own chart, so a repeated hue costs nothing, and the
    // modulo keeps the assignment as stable as the rank it comes from.
    const color = s.colorIndex === null ? OTHER_COLOR : SERIES_VARS[s.colorIndex % SERIES_VARS.length];
    const title = s.id === 'other' ? `other (${folded.length} sources)` : s.id;
    const peak = s.values.length ? Math.max(...s.values.map((n) => (Number.isFinite(n) ? n : 0))) : null;
    const rows = s.values.map((n, i) => ({
      hour: i < hours.length ? hourText(hours[i]) : 'n/a',
      tokens: compact(n, { na: 'n/a' }),
    }));
    grid.appendChild(ctx.chartCard(
      `live-spark-${s.id}`,
      title,
      caption,
      (w) => {
        const wrap = el('div', { class: 'live-spark' });
        wrap.appendChild(sparkline(s.values, { color, width: w, height: 48 }));
        wrap.appendChild(el('div', {
          class: 'hint live-spark-foot',
          text: `peak ${compact(peak, { na: 'n/a' })} in an hour · ${compact(s.total, { na: 'n/a' })} in 24 h`,
        }));
        return wrap;
      },
      {
        columns: [
          { key: 'hour', label: 'Hour', text: true, na: 'n/a' },
          { key: 'tokens', label: 'Tokens', na: 'n/a' },
        ],
        rows,
        emptyText: 'The status file carried no hourly buckets.',
      },
    ));
  }
  return [head, grid];
}

function liveWatcherCard(ctx) {
  const { int, relativeTime } = ctx.fmt;
  const body = el('div');
  const w = ctx.S.live?.watcher;
  if (w) {
    const age = ctx.S.live.freshness?.ageMs;
    body.appendChild(el('div', { class: 'chips', style: 'padding:10px 14px' }, [
      el('span', { class: 'badge ok', text: `● watcher running · pid ${w.pid}` }),
      el('span', { class: 'muted', text: `every ${w.intervalSeconds ?? '?'}s · ${int(w.cycles)} cycles` + (age != null ? ` · snapshot ${relativeTime(ctx.S.live.generatedAt)}` : '') }),
    ]));
  } else {
    const c = el('code', { text: 'tokenflow watch', style: 'font-size:12px' });
    body.appendChild(el('div', { class: 'chips', style: 'padding:10px 14px;gap:8px;flex-wrap:wrap' }, [
      el('span', { class: 'badge stale', text: '○ watcher not running' }),
      el('span', { class: 'muted', text: 'run ' }),
      c,
      el('span', { class: 'muted', text: ' to keep the status file, menu bar and alerts current' }),
    ]));
  }
  return ctx.card('Real-time engine', 'The watcher refreshes incrementally and rewrites data/status.json after every cycle.', body);
}

function limitRow(ctx, s) {
  const { compact, countdown } = ctx.fmt;
  // Past ~10× a cap, percentages stop communicating; multiples do.
  const pctText = s.pctUsed == null ? '—'
    : s.pctUsed >= 10 ? `${Math.round(s.pctUsed)}×`
    : `${(s.pctUsed * 100).toFixed(1)}%`;
  const color = s.status === 'exceeded' ? 'var(--critical)' : s.status === 'warn' ? 'var(--warning)' : 'var(--series-1)';
  const row = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--hairline)' });
  const glyph = s.status === 'exceeded' ? '✗' : s.status === 'warn' ? '⚠' : '✓';
  const left = el('div', { style: 'min-width:220px' });
  left.appendChild(el('div', {}, [document.createTextNode(`${glyph} ${s.label}`), s.provider ? el('span', { class: 'muted', text: `  [${s.provider}]` }) : null]));
  left.appendChild(el('div', { class: 'hint', text: `${s.scope} · ${s.metric}` }));
  row.appendChild(left);
  const barWrap = el('div', { style: 'flex:1;min-width:120px' });
  barWrap.appendChild(miniBar(Math.max(0, Math.min(1, s.pctUsed ?? 0)), color));
  row.appendChild(barWrap);
  const right = el('div', { style: 'text-align:right;min-width:190px' });
  right.appendChild(el('div', { text: `${pctText} of ${compact(s.cap)}` }));
  const sub = [];
  if (s.status !== 'exceeded' && s.etaHours != null) sub.push(`ETA ${countdown(s.etaHours * 3600000)}`);
  if (s.resetsInMs > 0) sub.push(`resets in ${countdown(s.resetsInMs)}`);
  if (sub.length) right.appendChild(el('div', { class: 'hint', text: sub.join(' · ') }));
  row.appendChild(right);
  return row;
}

function capacityCard(ctx) {
  const { compact, countdown } = ctx.fmt;
  const cap = ctx.view.capacity || { states: [], invalid: [], summary: {} };
  const body = el('div', { style: 'padding:6px 14px 14px' });

  if (!cap.states.length) {
    const yaml = [
      '# ~/.tokenflow/config.yaml',
      'limits:',
      '  - id: anthropic-monthly',
      '    provider: anthropic        # optional: provider | model | project',
      '    scope: month               # day | week | month',
      '    metric: tokens             # tokens | input | output | requests | cost',
      '    cap: 120000000             # tokens (or $ for metric: cost)',
      '    warnAt: 0.8                # optional warn threshold',
    ].join('\n');
    body.appendChild(el('p', { class: 'hint', text: 'TokenFlow never invents vendor quota numbers — a limit exists only if you declare it. Declare one here or paste this into your config:' }));
    const pre = el('pre', { class: 'mono', text: yaml, style: 'background:var(--surface-2);padding:10px;border-radius:8px;overflow:auto;font-size:11.5px;line-height:1.55' });
    body.appendChild(pre);
    const actions = ctx.btn('⧉ Copy YAML', () => {
      navigator.clipboard.writeText(yaml).then(() => { actions.textContent = '✓ Copied'; setTimeout(() => { actions.textContent = '⧉ Copy YAML'; }, 1500); }).catch(() => {});
    }, 'ghost sm');
    return ctx.card('Capacity & budgets', 'Burn rate, exhaustion ETA and reset countdowns for your declared limits.', body, actions);
  }

  const sum = cap.summary || {};
  if (sum.counts && (sum.counts.exceeded || sum.counts.warn)) {
    body.appendChild(el('div', { class: 'chips', style: 'padding:2px 0 8px' }, [
      sum.counts.exceeded ? el('span', { class: 'badge demo', text: `${sum.counts.exceeded} exceeded` }) : null,
      sum.counts.warn ? el('span', { class: 'badge warn', text: `${sum.counts.warn} approaching` }) : null,
      sum.firstToHit ? el('span', { class: 'muted', text: `first projected hit: ${sum.firstToHit.label} in ${countdown(sum.firstToHit.etaHours * 3600000)}` }) : null,
    ].filter(Boolean)));
  }
  for (const s of cap.states) body.appendChild(limitRow(ctx, s));
  if (cap.invalid?.length) {
    body.appendChild(el('p', { class: 'hint', text: `${cap.invalid.length} invalid limit definition(s) in config were ignored — check \`tokenflow capacity\`.` }));
  }
  // Editing limits writes to the local API, which a saved file does not have.
  const manage = ctx.snapshot
    ? null
    : ctx.btn('⚙ Manage limits', () => openLimitEditor(ctx), 'ghost sm');
  return ctx.card('Capacity & budgets', 'Evaluated against all primary usage regardless of dashboard filters — quota windows are facts about your accounts, not filter states.', body, manage);
}

function openLimitEditor(ctx) {
  const { compact } = ctx.fmt;
  const cur = (ctx.bundle.limits || []).map((l) => ({ ...l }));
  const body = el('div');

  // A simple editable list is clearer than a grid here.
  const rows = el('div');
  const renderRows = () => {
    rows.textContent = '';
    for (const l of cur) {
      const r = el('div', { style: 'display:flex;gap:8px;align-items:center;padding:4px 0' });
      r.appendChild(el('span', { class: 'mono', text: `${l.id}`, style: 'min-width:140px' }));
      r.appendChild(el('span', { class: 'muted', text: `${[l.provider, l.model, l.project].filter(Boolean).join('/') || 'all sources'} · ${l.scope} · ${l.metric} · cap ${compact(l.cap)}` }));
      const spacer = el('div', { style: 'flex:1' });
      r.appendChild(spacer);
      r.appendChild(ctx.btn('Remove', () => { cur.splice(cur.indexOf(l), 1); renderRows(); }, 'ghost sm'));
      rows.appendChild(r);
    }
    if (!cur.length) rows.appendChild(el('p', { class: 'hint', text: 'No limits yet — add one below.' }));
  };
  renderRows();
  body.appendChild(rows);

  const f = {};
  const field = (key, placeholder, type = 'text') => {
    const input = el('input', { class: 'tf-input', placeholder, type, 'aria-label': key });
    input.style.cssText = 'flex:1;min-width:90px';
    f[key] = input;
    return input;
  };
  const scopeSel = el('select', { 'aria-label': 'scope' });
  for (const o of ['day', 'week', 'month']) scopeSel.appendChild(el('option', { value: o, text: o }));
  const metricSel = el('select', { 'aria-label': 'metric' });
  for (const o of ['tokens', 'input', 'output', 'requests', 'cost']) metricSel.appendChild(el('option', { value: o, text: o }));

  const form = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' }, [
    field('id', 'id (required)'),
    field('provider', 'provider (optional)'),
    field('model', 'model (optional)'),
    scopeSel, metricSel,
    field('cap', 'cap', 'number'),
    field('warnAt', 'warnAt 0–1', 'number'),
  ]);
  for (const c of form.children) c.style.flexGrow = '0';
  body.appendChild(form);

  const errBox = el('p', { class: 'hint', style: 'color:var(--critical)' });
  body.appendChild(errBox);

  const foot = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' });
  foot.appendChild(ctx.btn('Cancel', () => ctx.closeModal(), 'ghost sm'));
  foot.appendChild(ctx.btn('Save limits', async () => {
    errBox.textContent = '';
    // The form is only part of the save when the user actually named a new
    // limit. Removal-only saves must not inject an empty draft — that bug
    // made every "remove" also POST a junk row and fail validation.
    const wantsAdd = f.id.value.trim() !== '' || f.cap.value !== '';
    if (wantsAdd && f.id.value.trim() === '') {
      errBox.textContent = 'New limit needs an id (or clear the form to save removals only).';
      return;
    }
    const def = {
      id: f.id.value.trim(),
      provider: f.provider.value.trim() || undefined,
      model: f.model.value.trim() || undefined,
      scope: scopeSel.value,
      metric: metricSel.value,
      cap: Number(f.cap.value),
      ...(f.warnAt.value !== '' ? { warnAt: Number(f.warnAt.value) } : {}),
    };
    const next = wantsAdd ? [...cur, def] : [...cur];
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limits: next }),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        errBox.textContent = `Invalid: ${(out.invalid || []).map((x) => `${x.id ? x.id + ': ' : ''}${x.errors.join('; ')}`).join(' | ')}`;
        return;
      }
      ctx.bundle.limits = out.limits;
      ctx.rerender();
      ctx.closeModal();
    } catch (e) {
      errBox.textContent = `Save failed: ${e.message}`;
    }
  }, 'sm'));
  body.appendChild(foot);

  ctx.openModal('Manage capacity limits', body);
}

function forecastCard(ctx) {
  const { compact, usd, shortDate } = ctx.fmt;
  const v = ctx.view;
  const f = v.forecast;
  const body = el('div');

  if (!f || f.tomorrow === null) {
    body.appendChild(el('p', { class: 'hint', text: f?.reason || 'Not enough history yet.' }));
    return ctx.card('Forecast', 'A conservative linear trend over recent days — never a promise.', body);
  }

  const kpis = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:10px 14px 2px' });
  const kpiTile = (tileLabel, val, sub) => {
    const d = el('div', { style: 'background:var(--surface-2);border-radius:8px;padding:10px' });
    d.appendChild(el('div', { class: 'hint', text: tileLabel }));
    d.appendChild(el('div', { class: 'k-value str', text: val, style: 'font-size:20px' }));
    if (sub) d.appendChild(el('div', { class: 'hint', text: sub }));
    return d;
  };
  kpis.appendChild(kpiTile('Tomorrow (projected)', compact(f.tomorrow), f.tomorrowInterval ? `${compact(f.tomorrowInterval[0])} – ${compact(f.tomorrowInterval[1])}` : null));
  kpis.appendChild(kpiTile('Next 7 days', compact(f.next7days), f.next7daysCost != null ? usd(f.next7daysCost) : null));
  if (f.monthEnd !== null) {
    kpis.appendChild(kpiTile('Month-end', compact(f.monthEnd), `measured so far ${compact(f.monthEndActualToDate)}${f.monthEndCost !== null ? ` · ≈${usd(f.monthEndCost)} est.` : ''}`));
  }
  kpis.appendChild(kpiTile('Confidence', f.confidence, f.n ? `${f.n}-day trend` : null));
  body.appendChild(kpis);

  // History + projection side by side: measured bars, then forecast bars in a
  // dashed-looking muted tone, clearly separated by an empty slot.
  const daily = v.daily.slice(-14);
  const data = daily.map((d) => ({
    label: shortDate(d.key),
    value: d.total,
    fmtXLong: d.key,
    color: 'var(--series-1)',
  }));
  if (f.tomorrow !== null) {
    data.push({ label: 'tomorrow*', value: f.tomorrow, color: 'var(--hairline)', extra: [{ name: 'Projected', value: compact(f.tomorrow) }] });
  }
  // The month-end projection deliberately stays OUT of the chart: a whole-
  // month total beside daily bars would flatten the history into unreadability.
  // It lives in the KPI tiles above, labelled as a projection.
  const wrapChart = el('div', { style: 'padding:6px 14px 12px' });
  requestAnimationFrame(() => observeWidth(wrapChart, (w) => {
    wrapChart.textContent = '';
    wrapChart.appendChild(columns({
      data, width: w, height: 200, fmtY: (x) => compact(x), valueLabel: 'Tokens',
      ariaLabel: 'Recent daily usage with projections appended',
    }));
  }));
  body.appendChild(wrapChart);
  body.appendChild(el('p', { class: 'hint', style: 'padding:0 14px 12px', text: '* Projected, not measured. The trend assumes the recent pattern continues; confidence is stated above and drops sharply on thin or volatile history.' }));

  return ctx.card('Forecast', 'Measured history first; projections always labelled and kept apart.', body);
}

function anomaliesCard(ctx) {
  const { shortDate } = ctx.fmt;
  const v = ctx.view;
  const body = el('div', { style: 'padding:6px 14px 14px' });
  const anomalies = v.anomalies || [];

  if (!anomalies.length) {
    body.appendChild(el('p', { class: 'hint', text: 'No anomalies detected in the current dataset. Detection covers token/cost/request spikes, weekday gaps and sudden drops — each reported with its own arithmetic.' }));
  } else {
    for (const a of anomalies) {
      const sev = SEV[a.severity] || SEV.info;
      const row = el('div', { style: 'display:flex;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid var(--hairline)' });
      row.appendChild(el('span', { class: `badge ${sev.cls}`, text: sev.label }));
      row.appendChild(el('span', { class: 'mono muted', text: a.date, style: 'min-width:86px;font-size:11px' }));
      row.appendChild(el('span', { text: a.detail }));
      body.appendChild(row);
    }
  }

  const fresh = [...(v.firstSeen?.models || []).map((m) => ({ kind: 'model', ...m })), ...(v.firstSeen?.providers || []).map((p) => ({ kind: 'provider', ...p }))];
  if (fresh.length) {
    const chips = el('div', { class: 'chips', style: 'padding-top:10px' });
    chips.appendChild(el('span', { class: 'muted', text: 'New this week: ' }));
    for (const x of fresh) {
      chips.appendChild(el('span', { class: 'chip', text: `${x.kind} ${x.entity} (${shortDate(x.firstSeen)})` }));
    }
    body.appendChild(chips);
  }
  return ctx.card('Anomalies & changes', 'Robust median/MAD detection — every alert shows observed vs expected so you can check it.', body);
}

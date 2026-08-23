/**
 * Dashboard application.
 *
 * The browser loads the aggregate bundle exactly once and then does all
 * filtering and aggregation locally by calling the SAME analytics modules the
 * CLI uses. Changing a filter therefore costs zero API calls and cannot
 * produce a number that disagrees with `tokenflow status`.
 */
import { computeView, resolveRange, QUICK_RANGES, EMPTY_FILTERS, addDays, daysBetween, previousPeriod } from '../analytics/index.js';
import { indexCube, filterCube } from '../analytics/aggregate.js';
import { calculateDimensionSeries } from '../analytics/dimensions.js';
import { compact, int, usd, pct, signedPct, shortDate, longDate, hourLabel, hourWindow, relativeTime, humanDuration, countdown, DOW } from '../core/units.js';
import { INTERFACE_ORDER } from '../core/schema.js';
import {
  el, svg, timeSeries, columns, hbars, donut, compositionBar, calendarHeatmap,
  matrix, scatter, sparkline, legend, table, miniBar, tooltip, observeWidth,
  ColorScale, SERIES_VARS, OTHER_COLOR, scaleLegend,
} from './charts.js';

const SNAPSHOT = typeof window !== 'undefined' && !!window.__TOKENFLOW_BUNDLE__;

const S = {
  bundle: null,
  view: null,
  tab: 'overview',
  /** @type {'day'|'week'|'month'} */
  granularity: 'day',
  /** @type {'line'|'stacked'} */
  seriesMode: 'stacked',
  /** @type {'tokens'|'requests'|'cost'} metric shown by the provider daily chart */
  providerMetric: 'tokens',
  rangeId: 'all',
  filters: { ...EMPTY_FILTERS },
  hidden: new Set(),
  drillDate: null,
  compare: null,
  tables: new Set(),
  refreshing: false,
  explorer: { page: 0, limit: 50, sort: 'ts', dir: 'desc', search: '', rows: [], total: 0, loading: false },
  /** Latest /api/live snapshot (live mode only; null in a static snapshot). */
  live: null,
  colors: {
    provider: new ColorScale(),
    model: new ColorScale(),
    iface: new ColorScale(),
    client: new ColorScale(),
    family: new ColorScale(),
  },
};

const COMP_COLORS = {
  input: 'var(--series-1)',
  output: 'var(--series-2)',
  cacheRead: 'var(--series-3)',
  cacheWrite: 'var(--series-4)',
};

const TABS = [
  ['overview', 'Overview'],
  ['live', 'Live'],
  ['providers', 'Providers'],
  ['models', 'Models'],
  ['interfaces', 'Interfaces'],
  ['time', 'Time patterns'],
  ['peaks', 'Peaks'],
  ['efficiency', 'Efficiency'],
  ['cost', 'Cost'],
  ['productivity', 'Productivity'],
  ['compare', 'Compare'],
  ['explorer', 'Data explorer'],
  ['health', 'Data health'],
];

/**
 * Skins restyle the room; they never restyle the data. The categorical series
 * steps live in the mode (dark/light) and were validated against every skin's
 * chart surface, so switching skin cannot change what a colour means — a real
 * risk with themeable dashboards, and the reason this is two axes and not six
 * unrelated stylesheets.
 */
export const SKINS = [
  { id: 'aurora', name: 'Aurora', note: 'Indigo-slate, layered, luminous' },
  { id: 'terminal', name: 'Terminal', note: 'Near-black, hairlines, mono' },
  { id: 'editorial', name: 'Editorial', note: 'Warm charcoal, serif figures' },
];

// ============================================================ bootstrapping ==

boot().catch((err) => {
  document.getElementById('view').appendChild(
    el('div', { class: 'banner' }, [el('span', { text: 'Could not start: ' + err.message })]),
  );
  console.error(err);
});

async function boot() {
  const prefs = loadPrefs();
  S.bundle = SNAPSHOT ? window.__TOKENFLOW_BUNDLE__ : await fetchJson('/api/bundle');
  // Config supplies the default look; a choice made in the browser wins.
  applyTheme(
    prefs.skin || S.bundle.meta?.skin || SKINS[0].id,
    prefs.mode || (prefs.theme === 'light' ? 'light' : null) || S.bundle.meta?.mode || 'dark',
  );
  if (prefs.filters) S.filters = { ...S.filters, ...prefs.filters };
  S.rangeId = prefs.rangeId || S.bundle.meta.defaultRange || 'all';
  if (prefs.granularity) S.granularity = prefs.granularity;
  if (prefs.tab) S.tab = prefs.tab;
  if (S.bundle.meta?.includeOverlayDefault) S.filters.includeOverlay = true;
  applyRange(S.rangeId, { silent: true });
  recompute();
  renderShell();
  render();
  // Handed over from a saved snapshot's "Refresh & open live" button. The
  // refresh runs here, same-origin, with this page's own token.
  if (!SNAPSHOT && new URLSearchParams(location.search).get('refresh') === '1') {
    history.replaceState(null, '', location.pathname);
    doRefresh();
  }
  ensureLiveLoop();
}

// ============================================================ live polling ==

let liveTimer = null;

/**
 * Poll the live snapshot once a minute while the dashboard is open. This is
 * what makes the header pill and the Live tab's watcher strip current without
 * any user action. In a static snapshot there is no server: the loop never
 * starts, and the Live tab renders purely from the bundle.
 */
function ensureLiveLoop() {
  if (SNAPSHOT || liveTimer) return;
  const tick = async () => {
    try {
      const r = await fetch('/api/live', { cache: 'no-store' });
      if (r.ok) { S.live = await r.json(); updateLivePill(); }
    } catch { /* server gone (dashboard closed): pill just stays absent */ }
  };
  tick();
  liveTimer = setInterval(tick, 60000);
}

function updateLivePill() {
  const host = document.getElementById('header-actions');
  let pill = document.getElementById('live-pill');
  const w = S.live?.watcher;
  const fresh = S.live && !S.live.freshness?.stale;
  if (!w) { if (pill) pill.remove(); return; }
  if (!pill) {
    pill = el('span', { class: 'live-pill', id: 'live-pill' });
    host.appendChild(pill);
  }
  const age = S.live.freshness?.ageMs;
  pill.textContent = `● live · ${age != null ? relativeTime(S.live.generatedAt).replace(' ago', '') : ''}`;
  pill.title = `Watcher running (pid ${w.pid}, every ${w.intervalSeconds ?? '?'}s). Data ${fresh ? 'is fresh' : 'may be stale'}.`;
}

/**
 * @param {string} id
 * @param {{silent?:boolean}} [o]
 */
function applyRange(id, { silent } = {}) {
  S.rangeId = id;
  if (id !== 'custom') {
    const cov = S.bundle.meta.coverage;
    const today = S.bundle.meta.today && S.bundle.meta.today > cov.to ? S.bundle.meta.today : cov.to;
    const r = resolveRange(id, cov, today);
    const floor = S.bundle.meta.defaultFrom;
    S.filters.from = floor && r.from && r.from < floor ? floor : r.from;
    S.filters.to = r.to;
  }
  if (!silent) { recompute(); render(); }
}

function recompute() {
  const t0 = performance.now();
  S.view = computeView(S.bundle, {
    ...S.filters,
    granularity: S.granularity,
    drillDate: S.drillDate,
    compare: S.compare,
  });
  S.computeMs = performance.now() - t0;
  // Assign colours in a stable, data-driven order the first time we see them.
  S.view.dimensions.providers.forEach((p) => S.colors.provider.get(p.key));
  S.view.dimensions.models.forEach((m) => S.colors.model.get(m.key));
  S.view.dimensions.interfaces.forEach((i) => S.colors.iface.get(i.key));
  S.view.dimensions.clients.forEach((c) => S.colors.client.get(c.key));
  S.view.dimensions.families.forEach((f) => S.colors.family.get(f.key));
  savePrefs();
}

// ==================================================================== theme ==

function applyTheme(skin, mode) {
  const r = document.documentElement;
  r.dataset.skin = SKINS.some((s) => s.id === skin) ? skin : 'aurora';
  r.dataset.mode = mode === 'light' ? 'light' : 'dark';
  // Kept for anything still reading the old single-axis attribute.
  r.dataset.theme = r.dataset.mode;
}

function themePicker() {
  const r = document.documentElement;
  const wrap = el('div', { class: 'theme' });
  const b = btn(`◑ ${SKINS.find((s) => s.id === r.dataset.skin)?.name || 'Theme'}`, (ev) => {
    ev.stopPropagation();
    wrap.classList.toggle('open');
  }, 'ghost');
  const pop = el('div', { class: 'theme-pop' });
  pop.addEventListener('click', (ev) => ev.stopPropagation());

  for (const sk of SKINS) {
    const row = el('button', { class: 'theme-row', 'aria-pressed': String(r.dataset.skin === sk.id) }, [
      el('span', { class: 'nm' }, [el('span', { text: sk.name }), el('small', { text: sk.note })]),
      el('span', { class: 'swatches' }, ['1', '2', '3'].map((n) => {
        const i = el('i');
        i.style.background = `var(--series-${n})`;
        return i;
      })),
    ]);
    row.addEventListener('click', () => {
      applyTheme(sk.id, r.dataset.mode);
      savePrefs();
      renderShell();
      render();
    });
    pop.appendChild(row);
  }

  const seg = el('div', { class: 'seg' });
  for (const [id, label] of [['dark', '◐ Dark'], ['light', '◑ Light']]) {
    const mb = el('button', { text: label, 'aria-pressed': String(r.dataset.mode === id) });
    mb.addEventListener('click', () => {
      applyTheme(r.dataset.skin, id);
      savePrefs();
      renderShell();
      render();
    });
    seg.appendChild(mb);
  }
  pop.appendChild(seg);
  pop.appendChild(el('div', { class: 'theme-note', text: 'Series colours are fixed per mode and validated for colour-blind separation, so a skin never changes what a colour means.' }));

  wrap.appendChild(b);
  wrap.appendChild(pop);
  document.addEventListener('click', () => wrap.classList.remove('open'));
  return wrap;
}

// ==================================================================== shell ==

function renderShell() {
  const acts = document.getElementById('header-actions');
  acts.textContent = '';
  if (!SNAPSHOT) {
    acts.appendChild(btn('↻ Refresh data', () => doRefresh(), 'primary', 'refresh-btn'));
  }
  acts.appendChild(btn('Export CSV ▾', (ev) => exportMenu(ev), 'ghost'));
  acts.appendChild(btn('Pricing', () => pricingModal(), 'ghost'));
  acts.appendChild(themePicker());

  const tabs = document.getElementById('tabs');
  tabs.textContent = '';
  for (const [id, label] of TABS) {
    const b = el('button', { role: 'tab', text: label, 'aria-selected': String(S.tab === id) });
    b.addEventListener('click', () => { S.tab = id; savePrefs(); renderShell(); render(); });
    tabs.appendChild(b);
  }

  const foot = document.getElementById('footer');
  foot.textContent = '';
  const m = S.bundle.meta;
  foot.appendChild(el('div', {
    text: `Local-first: every number on this page was computed in this browser from ${m.dataHome}. Nothing is uploaded.`,
  }));
  foot.appendChild(el('div', {
    text: `v${m.appVersion} · cube v${m.cubeVersion} · timezone ${m.timezone} · pricing table ${m.pricingTableVersion} · view computed in ${Math.round(S.computeMs || 0)} ms`,
  }));
}

function render() {
  renderHeaderMeta();
  renderBanners();
  renderFilters();
  renderCrumbs();
  const host = document.getElementById('view');
  host.textContent = '';
  const fn = {
    overview: viewOverview,
    live: viewLive,
    providers: () => viewDimension('provider', 'Provider intelligence'),
    models: viewModels,
    interfaces: viewInterfaces,
    time: viewTime,
    peaks: viewPeaks,
    efficiency: viewEfficiency,
    cost: viewCost,
    productivity: viewProductivity,
    compare: viewCompare,
    explorer: viewExplorer,
    health: viewHealth,
  }[S.tab] || viewOverview;
  host.appendChild(fn());
}

function renderHeaderMeta() {
  const m = S.bundle.meta;
  const h = S.bundle.health;
  document.getElementById('coverage').textContent =
    `${h.coverage.from ? longDate(h.coverage.from) : '—'} → ${h.coverage.to ? longDate(h.coverage.to) : '—'}  ·  ${int(h.records)} records  ·  refreshed ${relativeTime(m.lastRefresh)}`;
  const dot = document.getElementById('health-dot');
  dot.className = 'dot' + (S.refreshing ? ' busy' : h.grade === 'Excellent' ? '' : ' stale');
  dot.title = `Data health: ${h.grade}`;
}

function renderBanners() {
  const box = document.getElementById('banners');
  box.textContent = '';
  if (S.bundle.meta.demo) {
    box.appendChild(el('div', { class: 'banner' }, [
      el('span', { class: 'badge demo', text: 'DEMO DATA' }),
      el('span', { text: 'This dataset contains synthetic records generated for demonstration. Run `tokenflow refresh --full` after removing the mock provider to see real usage.' }),
    ]));
  }
  if (!S.bundle.cube.rows.length) {
    box.appendChild(el('div', { class: 'banner info' }, [
      el('span', { text: 'No usage data yet. Run `tokenflow setup` then `tokenflow refresh`, or `npm run demo` to explore with synthetic data.' }),
    ]));
  }
  if (SNAPSHOT) box.appendChild(freshnessBar());
}

/**
 * A saved snapshot is a file, and a file cannot re-read your logs — so instead
 * of a dead ↻ button it states its own age and offers the two honest ways to
 * get current data.
 *
 * It probes the loopback API for a running dashboard. If one answers, the
 * button hands over to it with ?refresh=1 (a navigation, not a cross-origin
 * POST — the live page then refreshes with its own token). If nothing answers,
 * it shows the one command that starts everything.
 */
function freshnessBar() {
  const snapAt = typeof window !== 'undefined' ? window.__TOKENFLOW_SNAPSHOT_AT__ : null;
  const dataAt = S.bundle.meta?.builtAt || snapAt;
  const ageDays = dataAt ? Math.floor((Date.now() - new Date(dataAt).getTime()) / 86400000) : null;
  const stale = ageDays !== null && ageDays >= 2;

  const bar = el('div', { class: 'freshness' + (stale ? ' warn' : '') });
  bar.appendChild(el('span', { class: 'badge', text: 'SNAPSHOT' }));
  bar.appendChild(el('span', {}, [
    el('span', { class: 'age', text: ageDays === null ? 'Age unknown' : ageDays === 0 ? 'Data from today' : ageDays === 1 ? 'Data from yesterday' : `Data is ${ageDays} days old` }),
    document.createTextNode(dataAt ? ` · captured ${new Date(dataAt).toLocaleString()}` : ''),
  ]));
  bar.appendChild(el('span', { class: 'spacer' }));
  const slot = el('span', { class: 'chips' }, [el('span', { class: 'k-sub', text: 'looking for a live dashboard…' })]);
  bar.appendChild(slot);

  findLiveServer().then((live) => {
    slot.textContent = '';
    if (live) {
      slot.appendChild(el('span', { class: 'k-sub', text: `live dashboard on port ${live.port}` }));
      const go = btn('↻ Refresh & open live', () => {
        window.location.href = `${live.origin}/?refresh=1`;
      }, 'primary sm');
      slot.appendChild(go);
      return;
    }
    slot.appendChild(el('span', { class: 'k-sub', text: 'no live dashboard running — start one:' }));
    slot.appendChild(el('code', { text: 'npm start' }));
    const copy = btn('Copy', async () => {
      try { await navigator.clipboard.writeText('npm start'); copy.textContent = 'Copied'; } catch { copy.textContent = 'npm start'; }
    }, 'ghost sm');
    slot.appendChild(copy);
  });
  return bar;
}

/** Probe the usual loopback ports for a running dashboard. */
async function findLiveServer() {
  const ports = (typeof window !== 'undefined' && window.__TOKENFLOW_PORTS__) || [7799, 7800, 8799];
  const tryPort = async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 900);
    try {
      const r = await fetch(`${origin}/api/ping`, { signal: ctrl.signal, cache: 'no-store' });
      const j = await r.json();
      if (j && j.app === 'tokenflow') return { ...j, origin, port };
    } catch { /* nothing there, or blocked — treat as absent */ } finally { clearTimeout(t); }
    return null;
  };
  const results = await Promise.all(ports.map(tryPort));
  return results.find(Boolean) || null;
}

// ================================================================== filters ==

function renderFilters() {
  const box = document.getElementById('filters');
  box.textContent = '';
  const cov = S.bundle.meta.coverage;

  const quick = el('div', { class: 'chips' });
  for (const r of QUICK_RANGES) {
    if (r.id === 'custom') continue;
    const allFrom = S.bundle.meta.defaultFrom && S.bundle.meta.defaultFrom > (cov.from || '') ? S.bundle.meta.defaultFrom : cov.from;
    const c = el('button', { class: 'chip', text: r.id === 'all' ? `Since ${shortDate(allFrom || '')}` : r.label, 'aria-pressed': String(S.rangeId === r.id) });
    c.addEventListener('click', () => applyRange(r.id));
    quick.appendChild(c);
  }
  box.appendChild(el('div', { class: 'grp' }, [el('label', { class: 'fld' }, [el('span', { text: 'Quick range' }), quick])]));

  box.appendChild(dateField('Date from', S.filters.from, (v) => { S.filters.from = v; S.rangeId = 'custom'; recompute(); render(); }));
  box.appendChild(dateField('Date to', S.filters.to, (v) => { S.filters.to = v; S.rangeId = 'custom'; recompute(); render(); }));
  box.appendChild(hourField('Hour from', S.filters.hourFrom, (v) => { S.filters.hourFrom = v; recompute(); render(); }));
  box.appendChild(hourField('Hour to', S.filters.hourTo, (v) => { S.filters.hourTo = v; recompute(); render(); }));

  const f = S.view.facets;
  box.appendChild(multi('Provider', f.provider, S.filters.provider, (v) => { S.filters.provider = v; recompute(); render(); }));
  box.appendChild(multi('Model', f.model, S.filters.model, (v) => { S.filters.model = v; recompute(); render(); }));
  box.appendChild(multi('Client', f.client, S.filters.client, (v) => { S.filters.client = v; recompute(); render(); }));
  box.appendChild(multi('Interface', f.interface, S.filters.interface, (v) => { S.filters.interface = v; recompute(); render(); }));
  box.appendChild(multi('Project', f.project, S.filters.project, (v) => { S.filters.project = v; recompute(); render(); }));
  box.appendChild(multi('Gateway', f.gateway, S.filters.gateway, (v) => { S.filters.gateway = v; recompute(); render(); }));
  box.appendChild(multi('Service tier', f.service_tier, S.filters.service_tier, (v) => { S.filters.service_tier = v; recompute(); render(); }));

  const toggles = el('div', { class: 'chips' });
  toggles.appendChild(toggleChip('Include gateway overlay', S.filters.includeOverlay, (v) => {
    S.filters.includeOverlay = v; recompute(); render();
  }, 'Proxy/gateway logs describe traffic already counted by the client adapter. Including them double-counts tokens, but exposes measured cost.'));
  toggles.appendChild(toggleChip('Include activity-only', S.filters.includeActivity, (v) => {
    S.filters.includeActivity = v; recompute(); render();
  }, 'Records from sources that report no token counts (Cline sessions, IDE edits, commits). They never add tokens, only activity.'));
  box.appendChild(el('div', { class: 'grp' }, [el('label', { class: 'fld' }, [el('span', { text: 'Scope' }), toggles])]));

  if (activeFilterCount()) {
    box.appendChild(btn(`Clear ${activeFilterCount()} filter(s)`, () => {
      S.filters = { ...EMPTY_FILTERS, includeOverlay: S.filters.includeOverlay, includeActivity: S.filters.includeActivity };
      S.drillDate = null;
      applyRange('all');
    }, 'ghost sm'));
  }
}

function activeFilterCount() {
  let n = 0;
  for (const k of ['provider', 'model', 'model_family', 'client', 'interface', 'gateway', 'project', 'repository', 'service_tier']) {
    if (S.filters[k] && S.filters[k].length) n++;
  }
  if (S.filters.hourFrom !== null || S.filters.hourTo !== null) n++;
  if (S.drillDate) n++;
  return n;
}

function dateField(label, value, onChange) {
  const i = el('input', { type: 'date', value: value || '' });
  i.min = S.bundle.meta.coverage.from || '';
  i.addEventListener('change', () => onChange(i.value || null));
  return el('label', { class: 'fld' }, [el('span', { text: label }), i]);
}

function hourField(label, value, onChange) {
  const s = el('select');
  s.appendChild(el('option', { value: '', text: 'any' }));
  for (let h = 0; h < 24; h++) s.appendChild(el('option', { value: String(h), text: hourLabel(h) + ':00' }));
  s.value = value === null || value === undefined ? '' : String(value);
  s.addEventListener('change', () => onChange(s.value === '' ? null : Number(s.value)));
  return el('label', { class: 'fld' }, [el('span', { text: label }), s]);
}

function toggleChip(label, on, onChange, title) {
  const c = el('button', { class: 'chip', text: (on ? '✓ ' : '') + label, 'aria-pressed': String(!!on), title: title || '' });
  c.addEventListener('click', () => onChange(!on));
  return c;
}

function multi(label, options, selected, onChange) {
  const sel = new Set(selected || []);
  const wrap = el('div', { class: 'ms' });
  const b = el('button', {
    class: 'btn ms-btn',
    text: sel.size ? `${label}: ${sel.size}` : label,
  });
  b.appendChild(el('span', { class: 'muted', text: '▾' }));
  const pop = el('div', { class: 'ms-pop' });
  const search = el('input', { type: 'text', placeholder: `Filter ${label.toLowerCase()}…` });
  const list = el('div', { class: 'ms-list' });
  const paint = () => {
    list.textContent = '';
    const q = search.value.toLowerCase();
    for (const o of options) {
      const name = String(o.value);
      if (q && !name.toLowerCase().includes(q)) continue;
      const row = el('div', { class: 'ms-row', role: 'option', 'aria-selected': String(sel.has(o.value)) }, [
        el('span', { class: 'tick', text: sel.has(o.value) ? '✓' : '' }),
        el('span', { class: 'nm', text: name, title: name }),
        el('span', { class: 'ct', text: compact(o.total) }),
      ]);
      row.addEventListener('click', () => {
        if (sel.has(o.value)) sel.delete(o.value); else sel.add(o.value);
        paint();
        b.firstChild.textContent = sel.size ? `${label}: ${sel.size}` : label;
      });
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(el('div', { class: 'empty', text: 'No matches' }));
  };
  search.addEventListener('input', paint);
  paint();
  pop.appendChild(search);
  pop.appendChild(list);
  pop.appendChild(el('div', { class: 'ms-foot' }, [
    btn('Clear', () => { sel.clear(); paint(); onChange(null); wrap.classList.remove('open'); }, 'ghost sm'),
    btn('Apply', () => { onChange([...sel]); wrap.classList.remove('open'); }, 'primary sm'),
  ]));
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('.ms.open').forEach((x) => { if (x !== wrap) x.classList.remove('open'); });
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', (ev) => { if (!wrap.contains(ev.target)) wrap.classList.remove('open'); });
  wrap.appendChild(b);
  wrap.appendChild(pop);
  return el('label', { class: 'fld' }, [el('span', { text: label }), wrap]);
}

// ============================================================== breadcrumbs ==

function renderCrumbs() {
  const box = document.getElementById('crumbs');
  box.textContent = '';
  const parts = [{ label: 'All data', reset: () => { S.filters = { ...EMPTY_FILTERS, includeOverlay: S.filters.includeOverlay, includeActivity: S.filters.includeActivity }; S.drillDate = null; applyRange('all'); } }];
  for (const [key, label] of [['provider', 'Provider'], ['model', 'Model'], ['client', 'Client'], ['interface', 'Interface'], ['project', 'Project'], ['gateway', 'Gateway'], ['service_tier', 'Tier']]) {
    const v = S.filters[key];
    if (v && v.length) {
      parts.push({
        label: `${label}: ${v.join(', ')}`,
        reset: () => { S.filters[key] = null; recompute(); render(); },
      });
    }
  }
  if (S.filters.hourFrom !== null || S.filters.hourTo !== null) {
    parts.push({
      label: `Hours ${S.filters.hourFrom ?? 0}–${S.filters.hourTo ?? 23}`,
      reset: () => { S.filters.hourFrom = null; S.filters.hourTo = null; recompute(); render(); },
    });
  }
  if (S.drillDate) parts.push({ label: longDate(S.drillDate), reset: () => { S.drillDate = null; recompute(); render(); } });

  parts.forEach((p, i) => {
    if (i) box.appendChild(el('span', { class: 'sep', text: '→' }));
    const c = el('span', { class: 'cr', text: p.label });
    c.addEventListener('click', p.reset);
    box.appendChild(c);
  });
  if (parts.length > 1) box.appendChild(el('span', { class: 'muted', text: ` · click a crumb to remove it` }));
}

// ==================================================== card / chart plumbing ==

function card(title, hint, body, actions) {
  const c = el('div', { class: 'card pad0' });
  const head = el('div', { class: 'card-head' });
  const tt = el('div', { style: 'min-width:0' });
  tt.appendChild(el('h3', {}, [document.createTextNode(title)]));
  if (hint) tt.appendChild(el('p', { class: 'hint', text: hint }));
  head.appendChild(tt);
  head.appendChild(el('div', { class: 'spacer' }));
  if (actions) for (const a of [].concat(actions)) head.appendChild(a);
  c.appendChild(head);
  const b = el('div', { class: 'card-body' });
  b.appendChild(body);
  c.appendChild(b);
  return c;
}

/**
 * A chart card with its mandatory table twin. The toggle is per card and the
 * table is the WCAG-clean equivalent, so no value is hover-only.
 */
function chartCard(id, title, hint, renderChart, tableSpec, extraActions) {
  const showTable = S.tables.has(id);
  const body = el('div');
  const toggle = btn(showTable ? '▤ Chart' : '▦ Table', () => {
    if (showTable) S.tables.delete(id); else S.tables.add(id);
    render();
  }, 'ghost sm');
  const actions = [].concat(extraActions || []).concat([toggle]);
  if (showTable && tableSpec) {
    body.appendChild(table(tableSpec.columns, tableSpec.rows, tableSpec));
    if (tableSpec.rows.length) {
      actions.unshift(btn('⇩ CSV', () => downloadCsv(`${id}.csv`, tableSpec.columns, tableSpec.rows), 'ghost sm'));
    }
  } else {
    const host = el('div');
    body.appendChild(host);
    requestAnimationFrame(() => observeWidth(host, (w) => {
      host.textContent = '';
      const n = renderChart(w);
      if (n) host.appendChild(n);
    }));
  }
  return card(title, hint, body, actions);
}

function btn(label, onClick, cls = '', id = null) {
  const b = el('button', { class: 'btn ' + cls, text: label });
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

function kpi(label, value, sub, opt = {}) {
  const c = el('div', { class: 'card' + (opt.hero ? ' hero-card' : '') });
  const k = el('div', { class: 'kpi' + (opt.onClick ? ' clickable' : '') });
  k.appendChild(el('span', { class: 'k-label' }, [
    document.createTextNode(label),
    opt.badge ? el('span', { class: 'badge ' + (opt.badgeKind || ''), text: opt.badge, title: opt.badgeTitle || '' }) : null,
  ]));
  k.appendChild(el('span', {
    class: 'k-value' + (opt.hero ? ' hero' : '') + (opt.str ? ' str' : ''),
    text: value,
  }));
  if (sub) k.appendChild(el('span', { class: 'k-sub' }, [typeof sub === 'string' ? document.createTextNode(sub) : sub]));
  if (opt.spark && opt.spark.length) {
    const s = el('div', { class: 'k-spark' });
    s.appendChild(sparkline(opt.spark, { color: opt.sparkColor, width: 140, height: 26 }));
    k.appendChild(s);
  }
  if (opt.onClick) k.addEventListener('click', opt.onClick);
  if (opt.title) c.title = opt.title;
  c.appendChild(k);
  return c;
}

function deltaChip(change, { goodUp = true } = {}) {
  if (change === null || change === undefined || !isFinite(change)) {
    return el('span', { class: 'delta flat', text: 'no prior period' });
  }
  const dir = Math.abs(change) < 0.005 ? 'flat' : change > 0 === goodUp ? 'up' : 'down';
  return el('span', { class: 'delta ' + dir, text: `${change > 0 ? '▲' : change < 0 ? '▼' : '■'} ${signedPct(change)}` });
}

function sectionTitle(t) {
  return el('div', { class: 'sec-title', text: t });
}

function emptyCard(text, detail) {
  const b = el('div', { class: 'empty' });
  b.appendChild(el('strong', { text }));
  if (detail) b.appendChild(el('span', { text: detail }));
  return b;
}

// ================================================================= overview ==

function viewOverview() {
  const v = S.view;
  const root = el('div', { class: 'grid' });
  root.appendChild(kpiRow());

  const gran = el('div', { class: 'chips' });
  for (const g of /** @type {('day'|'week'|'month')[]} */ (['day', 'week', 'month'])) {
    const c = el('button', { class: 'chip', text: g[0].toUpperCase() + g.slice(1) + 'ly', 'aria-pressed': String(S.granularity === g) });
    c.addEventListener('click', () => { S.granularity = g; recompute(); render(); });
    gran.appendChild(c);
  }
  for (const m of /** @type {[('stacked'|'line'), string][]} */ ([['stacked', 'Stacked'], ['line', 'Lines']])) {
    const c = el('button', { class: 'chip', text: m[1], 'aria-pressed': String(S.seriesMode === m[0]) });
    c.addEventListener('click', () => { S.seriesMode = m[0]; render(); });
    gran.appendChild(c);
  }

  root.appendChild(mainSeriesCard(gran));
  root.appendChild(compositionCard());
  root.appendChild(providerDailyCard());

  const two = el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(420px,1fr))' });
  two.appendChild(shareCard('provider', 'Provider distribution', v.dimensions.providers, S.colors.provider, 'provider'));
  two.appendChild(shareCard('model', 'Model distribution', v.dimensions.models, S.colors.model, 'model'));
  two.appendChild(interfaceCard());
  two.appendChild(topModelsCard());
  root.appendChild(two);

  root.appendChild(calendarCard());
  root.appendChild(insightsCard());
  return root;
}

function kpiRow() {
  const v = S.view;
  const k = v.kpis;
  const daily = v.daily.map((d) => d.total);
  const box = el('div', { class: 'cards' });
  const prev = previousPeriod(v.range.from, v.range.to);
  const prevView = computeView(S.bundle, { ...v.filters, from: prev.from, to: prev.to, granularity: 'day' });
  const chg = (a, b) => (b > 0 ? (a - b) / b : null);

  const totalCard = kpi('Total usage', compact(k.total.value), deltaChip(chg(k.total.value, prevView.totals.total)), { hero: true, spark: daily, title: int(k.total.value) + ' tokens' });
  totalCard.classList.add('wide');
  box.appendChild(totalCard);
  box.appendChild(kpi('Input', compact(k.input.value), naSub(k.input.na, v.totals.req, pct(v.composition.shares.input)), { spark: v.daily.map((d) => d.in), sparkColor: COMP_COLORS.input }));
  box.appendChild(kpi('Output', compact(k.output.value), naSub(k.output.na, v.totals.req, pct(v.composition.shares.output)), { spark: v.daily.map((d) => d.out), sparkColor: COMP_COLORS.output }));
  box.appendChild(kpi('Cache', compact(k.cache.value), naSub(k.cache.na, v.totals.req * 2, pct(v.composition.shares.cache)), { spark: v.daily.map((d) => d.cr + d.cw), sparkColor: COMP_COLORS.cacheRead }));
  box.appendChild(kpi('Avg / active day', compact(k.avgPerDay.value), `median ${compact(v.averages.medianActiveDay)}`));
  box.appendChild(kpi('Peak day', compact(k.peak.value), k.peak.detail ? shortDate(k.peak.detail) : '—', {
    onClick: k.peak.detail ? () => { S.drillDate = k.peak.detail; S.tab = 'peaks'; renderShell(); recompute(); render(); } : null,
  }));
  box.appendChild(kpi('Active days', int(k.activeDays.value),
    `of ${v.daily.length} in range · streak ${v.streaks.longest}`
    + (v.averages.activityOnlyDays ? ` · +${v.averages.activityOnlyDays} activity-only` : ''),
    { title: 'Days with measured token usage. Days where only a no-token source (IDE edits, sessions without a usage block) was active are counted separately.' }));
  box.appendChild(kpi('Avg sessions / day', k.sessionsPerDay.value === null ? '—' : k.sessionsPerDay.value.toFixed(1), `${int(k.sessions.value)} sessions`));
  box.appendChild(kpi('Providers', int(k.providers.value), v.dimensions.providers.slice(0, 2).map((p) => p.key).join(', ')));
  box.appendChild(kpi('Models', int(k.models.value), `${int(k.requests.value)} requests`));
  return box;
}

function naSub(na, denom, share) {
  if (na > 0 && denom > 0 && na / denom >= 0.005) {
    const frag = el('span');
    frag.appendChild(document.createTextNode(share + ' of total · '));
    frag.appendChild(el('span', { class: 'badge na', text: `${pct(na / denom, 0)} n/a`, title: 'Records whose source did not report this field. Excluded from the total rather than counted as zero.' }));
    return frag;
  }
  return share + ' of total';
}

function mainSeriesCard(granChips) {
  const v = S.view;
  const keys = [
    { key: 'in', label: 'Input', color: COMP_COLORS.input },
    { key: 'out', label: 'Output', color: COMP_COLORS.output },
    { key: 'cr', label: 'Cache read', color: COMP_COLORS.cacheRead },
    { key: 'cw', label: 'Cache write', color: COMP_COLORS.cacheWrite },
  ].map((k) => ({ ...k, hidden: S.hidden.has(k.key) }));

  const peakIdx = [];
  if (v.peaks.peakDay && S.granularity === 'day') {
    const i = v.series.findIndex((d) => d.key === v.peaks.peakDay.date);
    if (i >= 0) peakIdx.push(i);
  }
  const overlays = S.granularity === 'day' && S.seriesMode === 'line'
    ? [
      { values: v.movingAverages.ma7, label: '7-day average', color: 'var(--series-7)' },
      { values: v.movingAverages.ma30, label: '30-day average', color: 'var(--series-8)' },
    ]
    : [];

  const trendLine = v.trend.change === null
    ? el('span', { class: 'muted', text: v.trend.reason || '' })
    : el('span', {}, [
      document.createTextNode(`Trend over the last ${v.trend.window} days: `),
      deltaChip(v.trend.change),
      document.createTextNode(` · daily avg ${compact(v.averages.perActiveDay)} · 7-day ${compact(lastNonNull(v.movingAverages.ma7))} · lowest active ${compact(v.peaks.lowestActiveDay?.total)}`),
    ]);

  const body = el('div');
  const host = el('div');
  body.appendChild(host);

  const tbl = {
    columns: [
      { key: 'key', label: S.granularity === 'day' ? 'Date' : S.granularity === 'week' ? 'Week of' : 'Month', text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'in', label: 'Input', value: (r) => compact(r.in) },
      { key: 'out', label: 'Output', value: (r) => compact(r.out) },
      { key: 'cr', label: 'Cache read', value: (r) => compact(r.cr) },
      { key: 'cw', label: 'Cache write', value: (r) => compact(r.cw) },
      { key: 'req', label: 'Requests', value: (r) => int(r.req) },
    ],
    rows: [...v.series].reverse(),
    onRowClick: S.granularity === 'day' ? (r) => { S.drillDate = r.key; recompute(); render(); } : null,
  };

  const c = chartCard('main-series', 'Daily token usage', `${longDate(v.range.from)} → ${longDate(v.range.to)} · drag to zoom, click a point for the day`, (w) => {
    const wrap = el('div');
    wrap.appendChild(timeSeries({
      data: v.series, keys: keys.filter((k) => !k.hidden), mode: S.seriesMode, width: w, height: 320,
      overlays, peaks: peakIdx, fillArea: true, endLabel: true,
      fmtY: (x) => compact(x), fmtX: (k) => (S.granularity === 'month' ? k : shortDate(k)),
      fmtXLong: (k) => (S.granularity === 'day' ? longDate(k) : k),
      ariaLabel: 'Token usage over time',
      onBrush: (a, b) => {
        S.filters.from = v.series[a].key.length === 10 ? v.series[a].key : S.filters.from;
        S.filters.to = v.series[b].key.length === 10 ? v.series[b].key : S.filters.to;
        S.rangeId = 'custom';
        recompute(); render();
      },
      onClick: (i) => { if (S.granularity === 'day') { S.drillDate = v.series[i].key; recompute(); render(); } },
    }));
    wrap.appendChild(legend([...keys, ...overlays.map((o) => ({ label: o.label, color: o.color, line: true }))], {
      onToggle: (it) => { if (it.key) { if (S.hidden.has(it.key)) S.hidden.delete(it.key); else S.hidden.add(it.key); render(); } },
    }));
    return wrap;
  }, tbl, granChips);
  c.querySelector('.card-body').appendChild(el('div', { class: 'hint', style: 'padding-top:8px' }, [trendLine]));
  return c;
}

function lastNonNull(a) {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return a[i];
  return null;
}

function compositionCard() {
  const c = S.view.composition;
  const segs = [
    { label: 'Input', value: c.input, color: COMP_COLORS.input },
    { label: 'Output', value: c.output, color: COMP_COLORS.output },
    { label: 'Cache read', value: c.cacheRead, color: COMP_COLORS.cacheRead },
    { label: 'Cache write', value: c.cacheWrite, color: COMP_COLORS.cacheWrite },
  ];
  const body = el('div');
  body.appendChild(compositionBar(segs, { fmt: compact }));
  const kv = el('dl', { class: 'kv', style: 'margin-top:14px' });
  const add = (k, v, title) => {
    kv.appendChild(el('dt', { text: k, title: title || '' }));
    kv.appendChild(el('dd', { text: v }));
  };
  add('Output / input ratio', c.outputPerInput === null ? '—' : c.outputPerInput.toFixed(3), 'Generated tokens per FRESH prompt token (the literal output/input ratio)');
  add('Output / all prompt tokens', c.outputPerPromptToken === null ? '—' : c.outputPerPromptToken.toFixed(4), 'Generated tokens per prompt token actually sent, including cache reads and writes — the honest picture for a cache-heavy agent');
  add('Cache / total', pct(c.cacheRatio));
  add('Cache hit rate', pct(c.cacheHitRate), 'Cache reads as a share of all prompt tokens (fresh input + cache read)');
  add('Refresh share of cache writes', pct(c.refreshShareOfCacheWrite), 'Long-TTL cache writes as a share of all cache writes');
  add('Reasoning share of output', pct(c.reasoningShareOfOutput), 'Thinking/reasoning tokens as a share of generated tokens');
  body.appendChild(kv);
  const verdict = c.shares.cache > 0.5 ? 'cache-heavy' : c.shares.output > 0.3 ? 'output-heavy' : 'prompt-heavy';
  return card('Token composition', `This usage is ${verdict}. Cache read, cache write, fresh input and output are mutually exclusive and sum to the total.`, body);
}

function shareCard(id, title, rows, scale, filterKey) {
  // Values present only through activity-only sources have no tokens to show.
  // Listing them as zero-length bars reads as a bug; they stay in the table and
  // are counted in a footnote instead.
  const withTokens = rows.filter((r) => r.total > 0);
  const zero = rows.filter((r) => r.total <= 0);
  const top = withTokens.slice(0, 6);
  const rest = withTokens.slice(6);
  const segs = top.map((r) => ({ label: r.key, value: r.total, color: scale.get(r.key) }));
  if (rest.length) segs.push({ label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.total, 0), color: OTHER_COLOR });

  const tbl = {
    columns: [
      { key: 'key', label: title.split(' ')[0], text: true, onClick: (r) => drillTo(filterKey, r.key) },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'input', label: 'Input', value: (r) => compact(r.input) },
      { key: 'output', label: 'Output', value: (r) => compact(r.output) },
      { key: 'cache', label: 'Cache', value: (r) => compact(r.cache) },
      { key: 'avgPerActiveDay', label: 'Avg/day', value: (r) => compact(r.avgPerActiveDay) },
      { key: 'share', label: '% share', value: (r) => pct(r.share) },
    ],
    rows,
  };
  const hint = `${rows.length} distinct · click a segment to drill in`
    + (zero.length ? ` · ${zero.length} reported no tokens (activity-only sources) — see the table` : '');
  return chartCard(id + '-share', title, hint, () => {
    const wrap = el('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap' });
    wrap.appendChild(donut(segs, {
      fmt: compact, size: 176,
      center: { value: compact(S.view.totals.total), label: 'tokens' },
      onClick: (s) => { if (!s.label.startsWith('Other')) drillTo(filterKey, s.label); },
    }));
    wrap.appendChild(el('div', { style: 'flex:1;min-width:220px' }, [
      hbars(segs.map((s) => ({ label: s.label, value: s.value, color: s.color })), {
        fmt: compact,
        onClick: (r) => { if (!r.label.startsWith('Other')) drillTo(filterKey, r.label); },
      }),
    ]));
    return wrap;
  }, tbl);
}

function topModelsCard() {
  const rows = S.view.dimensions.models.slice(0, 10);
  return chartCard('top-models', 'Top models by usage', 'Horizontal bars, one colour per entity', () => hbars(
    rows.map((r) => ({
      label: r.key, value: r.total, color: S.colors.model.get(r.key),
      rows: [
        { color: S.colors.model.get(r.key), name: 'Total', value: compact(r.total) },
        { color: null, name: 'Requests', value: int(r.requests) },
        { color: null, name: 'Avg/request', value: compact(r.avgPerRequest) },
      ],
    })),
    { fmt: compact, onClick: (r) => drillTo('model', r.label) },
  ), {
    columns: [
      { key: 'key', label: 'Model', text: true, onClick: (r) => drillTo('model', r.key) },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
      { key: 'avgPerRequest', label: 'Avg/request', value: (r) => compact(r.avgPerRequest) },
    ],
    rows,
  });
}

function interfaceCard() {
  const rows = S.view.dimensions.interfaces;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const ordered = INTERFACE_ORDER.map((k) => rows.find((r) => r.key === k)).filter(Boolean)
    .concat(rows.filter((r) => !INTERFACE_ORDER.includes(r.key)));
  const body = el('div');
  body.appendChild(hbars(ordered.map((r) => ({
    label: r.key, value: r.total, color: S.colors.iface.get(r.key),
    rows: [
      { color: S.colors.iface.get(r.key), name: 'Tokens', value: compact(r.total) },
      { color: null, name: 'Share', value: pct(r.share) },
      { color: null, name: 'Sessions', value: r.sessions === null ? 'n/a' : int(r.sessions) },
    ],
  })), { fmt: compact, onClick: (r) => drillTo('interface', r.label) }));
  const unknown = rows.find((r) => r.key === 'Unknown');
  if (unknown) {
    body.appendChild(el('p', { class: 'hint', style: 'margin-top:10px', text: `${pct(unknown.share)} of tokens came from records with no surface field to classify. Interface is never inferred from the model, so these stay Unknown rather than being guessed into a bucket.` }));
  }
  return chartCard('iface', 'CLI vs Desktop vs Web vs API', 'Classified only from an explicit surface field in the source record', () => body, {
    columns: [
      { key: 'key', label: 'Interface', text: true, onClick: (r) => drillTo('interface', r.key) },
      { key: 'total', label: 'Tokens', value: (r) => compact(r.total) },
      { key: 'share', label: 'Share', value: (r) => pct(r.share) },
      { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
      { key: 'sessions', label: 'Sessions', value: (r) => (r.sessions === null ? null : int(r.sessions)) },
      { key: 'activeDays', label: 'Active days', value: (r) => int(r.activeDays) },
    ],
    rows: ordered,
  });
}

function calendarCard() {
  const v = S.view;
  const lv = v.calendar.levels;
  return chartCard('calendar', 'Daily usage heatmap', `Intensity is percentile-based within this slice (median ${compact(lv.median)}, max ${compact(lv.max)}) — not fixed thresholds, so it reads correctly at any scale.`, () => {
    const wrap = el('div');
    wrap.appendChild(calendarHeatmap(v.calendar.days, {
      levelOf: (t, a) => lv.levelOf(t, a),
      fmt: compact, fmtDate: longDate, selected: S.drillDate,
      onClick: (d) => { S.drillDate = S.drillDate === d ? null : d; recompute(); render(); },
      note: `${v.averages.activeDays} active of ${v.calendar.days.length} days`,
    }));
    if (S.drillDate && v.drill) wrap.appendChild(dayDetailBox(v.drill));
    else if (S.drillDate) wrap.appendChild(el('div', { class: 'empty', text: `No records on ${longDate(S.drillDate)} within the current filters.` }));
    return wrap;
  }, {
    columns: [
      { key: 'date', label: 'Date', text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'in', label: 'Input', value: (r) => compact(r.in) },
      { key: 'out', label: 'Output', value: (r) => compact(r.out) },
      { key: 'cache', label: 'Cache', value: (r) => compact(r.cr + r.cw) },
      { key: 'req', label: 'Requests', value: (r) => int(r.req) },
      { key: 'active', label: 'Active', value: (r) => (r.active ? 'yes' : 'no'), text: true },
    ],
    rows: [...v.calendar.days].reverse(),
    onRowClick: (r) => { S.drillDate = r.date; recompute(); render(); },
  });
}

function dayDetailBox(d) {
  const box = el('div', { class: 'card', style: 'margin-top:14px;background:var(--surface-2)' });
  box.appendChild(el('h3', {}, [document.createTextNode(longDate(d.date))]));
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-top:8px' });
  const kv = el('dl', { class: 'kv' });
  const add = (k, val) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(el('dd', { text: val })); };
  add('Total', compact(d.total));
  add('Input', compact(d.input));
  add('Output', compact(d.output));
  add('Cache read', compact(d.cacheRead));
  add('Cache write', compact(d.cacheWrite));
  add('Requests', int(d.requests));
  add('Sessions', int(d.sessions));
  if (d.cost !== null) add('Est. cost', usd(d.cost));
  grid.appendChild(kv);
  for (const [label, arr, scale, key] of [['Top providers', d.providers, S.colors.provider, 'provider'], ['Top models', d.models, S.colors.model, 'model'], ['Interfaces', d.interfaces, S.colors.iface, 'interface']]) {
    const col = el('div');
    col.appendChild(el('div', { class: 'hint', text: label }));
    col.appendChild(hbars(arr.map((x) => ({ label: x.key, value: x.total, color: scale.get(x.key) })), {
      fmt: compact, onClick: (r) => drillTo(key, r.label),
    }));
    grid.appendChild(col);
  }
  box.appendChild(grid);
  const hostH = el('div', { style: 'margin-top:12px' });
  box.appendChild(hostH);
  requestAnimationFrame(() => observeWidth(hostH, (w) => {
    hostH.textContent = '';
    hostH.appendChild(el('div', { class: 'hint', text: 'Tokens by hour on this day' }));
    hostH.appendChild(columns({
      data: d.hours.map((v, h) => ({ label: hourLabel(h), value: v, color: 'var(--series-1)' })),
      width: w, height: 150, fmtY: compact, valueLabel: 'Tokens',
      fmtXLong: (x) => `${x.label}:00`,
    }));
  }));
  return box;
}

function insightsCard() {
  const body = el('div', { class: 'insights' });
  for (const i of S.view.insights) {
    body.appendChild(el('div', { class: 'ins ' + i.kind }, [
      el('span', { class: 'i-ico', text: i.icon }),
      el('span', { text: i.text }),
    ]));
  }
  return card('AI activity insights', 'Generated from the current slice. An insight only appears when its own condition holds — the panel is deliberately allowed to be short.', body);
}

function drillTo(key, value) {
  S.filters[key] = [value];
  recompute();
  render();
}

// ================================================== dimension detail views ==

function viewDimension(kind, title) {
  const v = S.view;
  const rows = kind === 'provider' ? v.dimensions.providers : v.dimensions.models;
  const scale = kind === 'provider' ? S.colors.provider : S.colors.model;
  const growth = kind === 'provider' ? v.growth.providers : v.growth.models;
  const stack = kind === 'provider' ? v.stacks.providerSeries : v.stacks.modelSeries;
  const filterKey = kind;

  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle(title));

  const cards = el('div', { class: 'cards' });
  cards.appendChild(kpi(`${title.split(' ')[0]}s in slice`, int(rows.length), rows.slice(0, 3).map((r) => r.key).join(', ')));
  if (rows[0]) {
    cards.appendChild(kpi('Leader', rows[0].key, `${pct(rows[0].share)} of tokens`, { str: true }));
    cards.appendChild(kpi('Leader avg / active day', compact(rows[0].avgPerActiveDay), `${int(rows[0].activeDays)} active days`));
  }
  const newest = growth.rows.filter((r) => r.status === 'new');
  if (newest.length) cards.appendChild(kpi('New this period', int(newest.length), newest.slice(0, 2).map((r) => r.key).join(', ')));
  root.appendChild(cards);

  root.appendChild(shareCard(kind + '-detail', `${title.split(' ')[0]} token share`, rows, scale, filterKey));
  root.appendChild(stackCard(kind + '-trend', `${title.split(' ')[0]} daily trend`, stack, scale));

  root.appendChild(card(`${title.split(' ')[0]} comparison`, 'Full table — every measured field, plus the not-available counts behind each one.', table([
    { key: 'key', label: title.split(' ')[0], text: true, onClick: (r) => drillTo(filterKey, r.key) },
    { key: 'total', label: 'Total', value: (r) => compact(r.total) },
    { key: 'input', label: 'Input', value: (r) => compact(r.input) },
    { key: 'output', label: 'Output', value: (r) => compact(r.output) },
    { key: 'cache', label: 'Cache', value: (r) => compact(r.cache) },
    { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
    { key: 'sessions', label: 'Sessions', value: (r) => (r.sessions === null ? null : int(r.sessions)) },
    { key: 'activeDays', label: 'Active days', value: (r) => int(r.activeDays) },
    { key: 'avgPerActiveDay', label: 'Avg/day', value: (r) => compact(r.avgPerActiveDay) },
    { key: 'avgPerSession', label: 'Avg/session', value: (r) => compact(r.avgPerSession) },
    { key: 'peakDay', label: 'Peak day', value: (r) => (r.peakDay ? `${shortDate(r.peakDay)} (${compact(r.peakDayTotal)})` : null), text: true },
    { key: 'cost', label: 'Est. cost', value: (r) => (r.cost === null ? null : usd(r.cost)), na: 'no price' },
    { key: 'share', label: '% share', value: (r) => pct(r.share) },
  ], rows)));

  root.appendChild(growthCard(`${title.split(' ')[0]} growth`, growth));
  return root;
}

/**
 * CodexBar-style multi-provider day-wise chart. One stacked bar per day, one
 * segment per provider, switchable between Tokens / Requests / Cost. The
 * series is recomputed for the chosen metric — the same cube rows, measured
 * differently — so switching can never show a number the data does not back.
 */
function providerDailyCard() {
  const v = S.view;
  const metric = S.providerMetric;

  // Recompute the stack under the selected metric from the same filtered rows
  // computeView used; indexCube of the bundle gives us the accessor layout.
  const ix = indexCube(S.bundle.cube);
  const rows = filterCube(ix, { ...v.filters, from: v.range.from, to: v.range.to });
  const bucketOf = (d) => d;
  const buckets = v.series.map((s) => s.key);
  const stack = calculateDimensionSeries(rows, ix, 'p', buckets, { topN: 6, bucketOf, metric });

  const scale = S.colors.provider;
  const keys = stack.keys.map((k) => ({ key: k, label: k, color: k === 'Other' ? OTHER_COLOR : scale.get(k) }));
  const fmtY = metric === 'cost' ? usd : metric === 'requests' ? int : compact;
  const unit = metric === 'cost' ? 'estimated cost' : metric;

  const chips = el('div', { class: 'chips' });
  for (const m of /** @type {['tokens'|'requests'|'cost', string][]} */ ([['tokens', 'Tokens'], ['requests', 'Requests'], ['cost', 'Cost']])) {
    const c = el('button', { class: 'chip', text: m[1], 'aria-pressed': String(metric === m[0]) });
    c.addEventListener('click', () => { S.providerMetric = m[0]; render(); });
    chips.appendChild(c);
  }

  return chartCard('provider-daily', 'Provider usage — daily', `Stacked ${unit} per provider per day. Top 6 by volume; the rest fold into Other.`, (w) => {
    const wrap = el('div');
    wrap.appendChild(chips);
    wrap.appendChild(timeSeries({
      data: stack.series, keys, mode: 'stacked', width: w, height: 260,
      fmtY, fmtX: (k) => (k.length === 10 ? shortDate(k) : k), fmtXLong: (k) => (k.length === 10 ? longDate(k) : k),
      ariaLabel: `Daily usage by provider in ${unit}`,
    }));
    wrap.appendChild(legend(keys));
    return wrap;
  }, {
    columns: [{ key: 'key', label: 'Date', text: true }, ...stack.keys.map((k) => ({ key: k, label: k, value: (r) => fmtY(r[k]) }))],
    rows: [...stack.series].reverse(),
  });
}

function stackCard(id, title, stack, scale) {
  const keys = stack.keys.map((k) => ({ key: k, label: k, color: k === 'Other' ? OTHER_COLOR : scale.get(k) }));
  return chartCard(id, title, 'Top 6 by volume; everything else folded into Other rather than given a generated colour.', (w) => {
    const wrap = el('div');
    wrap.appendChild(timeSeries({
      data: stack.series, keys, mode: 'stacked', width: w, height: 260,
      fmtY: compact, fmtX: (k) => (k.length === 10 ? shortDate(k) : k), fmtXLong: (k) => (k.length === 10 ? longDate(k) : k),
      ariaLabel: title,
    }));
    wrap.appendChild(legend(keys));
    return wrap;
  }, {
    columns: [{ key: 'key', label: 'Bucket', text: true }, ...stack.keys.map((k) => ({ key: k, label: k, value: (r) => compact(r[k]) }))],
    rows: [...stack.series].reverse(),
  });
}

function growthCard(title, growth) {
  const rows = growth.rows.filter((r) => r.current > 0 || r.previous > 0);
  return card(title, `Current window ${shortDate(growth.window.from)} → ${shortDate(growth.window.to)} vs the equally long window before it (${shortDate(growth.previousWindow.from)} → ${shortDate(growth.previousWindow.to)}).`, table([
    { key: 'key', label: 'Key', text: true },
    { key: 'previous', label: 'Previous', value: (r) => compact(r.previous) },
    { key: 'current', label: 'Current', value: (r) => compact(r.current) },
    { key: 'absolute', label: 'Change', value: (r) => (r.absolute >= 0 ? '+' : '') + compact(r.absolute) },
    { key: 'change', label: '%', value: (r) => (r.change === null ? null : deltaChip(r.change)), na: 'new base' },
    { key: 'status', label: 'Status', text: true },
  ], rows, { emptyText: 'No comparable previous window inside the dataset.' }));
}

function viewModels() {
  const v = S.view;
  const root = viewDimension('model', 'Model intelligence');
  // Model efficiency scatter: all-pairs colour separation caps groups at 3.
  const topProviders = v.dimensions.providers.slice(0, ColorScale.ALLPAIRS_LIMIT).map((p) => p.key);
  const pts = v.modelEfficiency
    .filter((m) => m.tokensPerSession !== null && m.sessionsPerDay !== null)
    .map((m) => ({
      x: m.tokensPerSession, y: m.sessionsPerDay, r: m.total,
      color: topProviders.includes(m.provider) ? SERIES_VARS[topProviders.indexOf(m.provider)] : OTHER_COLOR,
      label: m.model, short: m.model.length > 18 ? m.model.slice(0, 17) + '…' : m.model,
      rows: [
        { color: null, name: 'Total', value: compact(m.total) },
        { color: null, name: 'Tokens / session', value: compact(m.tokensPerSession) },
        { color: null, name: 'Sessions / day', value: m.sessionsPerDay.toFixed(2) },
        { color: null, name: 'Sessions', value: int(m.sessions) },
        { color: null, name: 'Provider', value: m.provider },
      ],
    }));
  root.appendChild(chartCard('model-eff', 'Model efficiency', 'x = tokens per session · y = sessions per active day · bubble = total tokens. Colour groups are capped at three: a scatter needs all-pairs colour separation, so the rest are grouped as Other and named in the tooltip and table.', (w) => {
    const wrap = el('div');
    if (!pts.length) return emptyCard('Not enough session data', 'Model efficiency needs sessions with token counts.');
    wrap.appendChild(scatter(pts, {
      width: w, height: 330, fmtX: compact, fmtY: (v2) => v2.toFixed(1),
      xLabel: 'Tokens per session', yLabel: 'Sessions per active day',
      onClick: (p) => drillTo('model', p.label),
    }));
    wrap.appendChild(legend(topProviders.map((p, i) => ({ label: p, color: SERIES_VARS[i] })).concat(v.dimensions.providers.length > ColorScale.ALLPAIRS_LIMIT ? [{ label: 'Other providers', color: OTHER_COLOR }] : [])));
    return wrap;
  }, {
    columns: [
      { key: 'model', label: 'Model', text: true, onClick: (r) => drillTo('model', r.model) },
      { key: 'provider', label: 'Provider', text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'sessions', label: 'Sessions', value: (r) => (r.sessions === null ? null : int(r.sessions)) },
      { key: 'tokensPerSession', label: 'Tokens/session', value: (r) => compact(r.tokensPerSession) },
      { key: 'sessionsPerDay', label: 'Sessions/day', value: (r) => (r.sessionsPerDay === null ? null : r.sessionsPerDay.toFixed(2)) },
      { key: 'tokensPerRequest', label: 'Tokens/request', value: (r) => compact(r.tokensPerRequest) },
      { key: 'medianSessionMs', label: 'Median session', value: (r) => (r.medianSessionMs === null ? null : humanDuration(r.medianSessionMs)) },
    ],
    rows: v.modelEfficiency,
  }));

  root.appendChild(shareCard('family', 'Model family share', v.dimensions.families, S.colors.family, 'model_family'));
  return root;
}

function viewInterfaces() {
  const v = S.view;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Interface & client analysis'));

  const cls = v.stacks.interfaceTrend;
  const clsColors = new ColorScale(['CLI / headless', 'IDE', 'Desktop / Web', 'API', 'Unknown']);
  const cards = el('div', { class: 'cards' });
  const last = cls.shares[cls.shares.length - 1] || {};
  for (const k of cls.keys) {
    const totalK = cls.series.reduce((a, r) => a + (r[k] || 0), 0);
    cards.appendChild(kpi(k, pct(v.totals.total ? totalK / v.totals.total : null), compact(totalK) + ' tokens'));
  }
  root.appendChild(cards);

  root.appendChild(interfaceCard());
  root.appendChild(stackCard('iface-trend', 'CLI vs GUI trend', { keys: cls.keys, series: cls.series }, clsColors));
  root.appendChild(chartCard('iface-share-trend', 'Interface share over time', 'Share of tokens per bucket — the shape that makes a tooling shift legible.', (w) => {
    const keys = cls.keys.map((k) => ({ key: k, label: k, color: clsColors.get(k) }));
    const wrap = el('div');
    wrap.appendChild(timeSeries({
      data: cls.shares, keys, mode: 'stacked', width: w, height: 220,
      fmtY: (x) => (x * 100).toFixed(0) + '%', fmtX: (k) => (k.length === 10 ? shortDate(k) : k),
      fmtXLong: (k) => (k.length === 10 ? longDate(k) : k), ariaLabel: 'Interface share over time',
    }));
    wrap.appendChild(legend(keys));
    return wrap;
  }, {
    columns: [{ key: 'key', label: 'Bucket', text: true }, ...cls.keys.map((k) => ({ key: k, label: k, value: (r) => pct(r[k]) }))],
    rows: [...cls.shares].reverse(),
  }));

  root.appendChild(shareCard('client', 'Client distribution', v.dimensions.clients, S.colors.client, 'client'));
  if (v.dimensions.gateways.length > 1) {
    root.appendChild(shareCard('gateway', 'Gateway / routing', v.dimensions.gateways, new ColorScale(), 'gateway'));
  }
  root.appendChild(card('Projects', 'Top projects by token usage — derived from each record\'s working directory.', table([
    { key: 'key', label: 'Project', text: true, onClick: (r) => drillTo('project', r.key) },
    { key: 'total', label: 'Total', value: (r) => compact(r.total) },
    { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
    { key: 'sessions', label: 'Sessions', value: (r) => (r.sessions === null ? null : int(r.sessions)) },
    { key: 'activeDays', label: 'Active days', value: (r) => int(r.activeDays) },
    { key: 'share', label: 'Share', value: (r) => pct(r.share) },
  ], v.dimensions.projects)));
  return root;
}

// ============================================================ time patterns ==

function viewTime() {
  const v = S.view;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('When you use AI'));

  const cards = el('div', { class: 'cards' });
  const pw = v.hourly.peakWindow;
  const sw = v.hourly.secondaryWindow;
  cards.appendChild(kpi('Peak usage window', pw ? hourWindow(pw.from, pw.to) : '—', pw ? `${pct(pw.share)} of tokens` : 'no timestamped data'));
  cards.appendChild(kpi('Secondary peak', sw ? hourWindow(sw.from, sw.to) : '—', sw ? `${pct(sw.share)} of tokens` : '—'));
  const busiestDow = [...v.dowUsage].sort((a, b) => b.total - a.total)[0];
  cards.appendChild(kpi('Busiest day of week', busiestDow ? DOW[busiestDow.dow] : '—', busiestDow ? compact(busiestDow.total) : '—'));
  cards.appendChild(kpi('Weekend share', pct(v.productivity.proxies.weekendShare), `${v.productivity.proxies.weekendActiveDays} weekend active days`));
  cards.appendChild(kpi('Longest active streak', int(v.streaks.longest) + ' days', v.streaks.longestEndedOn ? `ended ${shortDate(v.streaks.longestEndedOn)}` : ''));
  root.appendChild(cards);

  root.appendChild(chartCard('hourly', 'Usage by hour of day', `24-hour profile in ${S.bundle.meta.timezone}. Click a bar to filter to that hour.`, (w) => columns({
    data: v.hourly.buckets.map((b) => ({ label: hourLabel(b.hour), value: b.total, color: 'var(--series-1)', hour: b.hour, extra: [{ color: null, name: 'Requests', value: int(b.req) }] })),
    width: w, height: 220, fmtY: compact, valueLabel: 'Tokens',
    fmtXLong: (d) => `${d.label}:00 – ${hourLabel((d.hour + 1) % 24)}:00`,
    onClick: (d) => { S.filters.hourFrom = d.hour; S.filters.hourTo = d.hour; recompute(); render(); },
  }), {
    columns: [
      { key: 'hour', label: 'Hour', value: (r) => hourLabel(r.hour) + ':00', text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'in', label: 'Input', value: (r) => compact(r.in) },
      { key: 'out', label: 'Output', value: (r) => compact(r.out) },
      { key: 'req', label: 'Requests', value: (r) => int(r.req) },
    ],
    rows: v.hourly.buckets,
  }));

  root.appendChild(chartCard('dow', 'Usage by day of week', 'Monday first. Per-active-day averages remove the effect of how many of each weekday fall in the range.', (w) => {
    const wrap = el('div');
    wrap.appendChild(columns({
      data: v.dowUsage.map((b) => ({ label: DOW[b.dow], value: b.total, color: b.dow >= 5 ? 'var(--series-2)' : 'var(--series-1)', extra: [{ color: null, name: 'Avg / active day', value: compact(b.perActiveDay) }, { color: null, name: 'Active days', value: int(b.days) }] })),
      width: w, height: 200, fmtY: compact, valueLabel: 'Tokens',
    }));
    wrap.appendChild(legend([{ label: 'Weekday', color: 'var(--series-1)' }, { label: 'Weekend', color: 'var(--series-2)' }]));
    return wrap;
  }, {
    columns: [
      { key: 'dow', label: 'Day', value: (r) => DOW[r.dow], text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'days', label: 'Active days', value: (r) => int(r.days) },
      { key: 'perActiveDay', label: 'Avg / active day', value: (r) => compact(r.perActiveDay) },
      { key: 'req', label: 'Requests', value: (r) => int(r.req) },
    ],
    rows: v.dowUsage,
  }));

  const cells = v.hourDow.cells.map((c) => ({
    row: c.dow, col: c.hour, value: c.total,
    label: `${DOW[c.dow]} ${hourLabel(c.hour)}:00`,
    extra: [{ color: null, name: 'Requests', value: int(c.req) }],
    dow: c.dow, hour: c.hour,
  }));
  root.appendChild(chartCard('hourdow', 'Hour × day-of-week heatmap', 'One hue, light→dark. Click a cell to filter to that hour and weekday.', (w) => {
    const wrap = el('div', { style: 'overflow:auto' });
    wrap.appendChild(matrix(cells, {
      rows: DOW, cols: Array.from({ length: 24 }, (_, h) => hourLabel(h)),
      max: v.hourDow.max, fmt: compact, cellW: Math.max(22, Math.min(46, (w - 40) / 24)), cellH: 22,
      ariaLabel: 'Hour by weekday heatmap',
      onClick: (c) => { S.filters.hourFrom = c.hour; S.filters.hourTo = c.hour; S.filters.dows = [c.dow]; recompute(); render(); },
    }));
    wrap.appendChild(scaleLegend(v.hourDow.max, compact));
    return wrap;
  }, {
    columns: [
      { key: 'label', label: 'Slot', text: true },
      { key: 'value', label: 'Tokens', value: (r) => compact(r.value) },
    ],
    rows: [...cells].sort((a, b) => b.value - a.value).slice(0, 60),
  }));

  root.appendChild(calendarCard());
  return root;
}

// ==================================================================== peaks ==

function viewPeaks() {
  const v = S.view;
  const p = v.peaks;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Peak usage analysis'));

  const cards = el('div', { class: 'cards' });
  const add = (label, obj, keyName, fmt = compact) => {
    if (!obj) { cards.appendChild(kpi(label, '—', 'no data')); return; }
    cards.appendChild(kpi(label, fmt(obj.total ?? obj.value), String(obj[keyName] ?? obj.key ?? ''), { str: false }));
  };
  cards.appendChild(kpi('Peak day', compact(p.peakDay?.total), p.peakDay ? longDate(p.peakDay.date) : '—', {
    hero: true, onClick: p.peakDay ? () => { S.drillDate = p.peakDay.date; recompute(); render(); } : null,
  }));
  add('Peak week', p.peakWeek && { total: p.peakWeek.total, key: 'week of ' + shortDate(p.peakWeek.weekStart) }, 'key');
  add('Peak month', p.peakMonth && { total: p.peakMonth.total, key: p.peakMonth.month }, 'key');
  cards.appendChild(kpi('Peak hour', p.peakHour ? hourLabel(p.peakHour.hour) + ':00' : '—', p.peakHour ? compact(p.peakHour.total) : '—'));
  add('Peak provider', p.peakProvider && { total: p.peakProvider.total, key: p.peakProvider.provider }, 'key');
  add('Peak model', p.peakModel && { total: p.peakModel.total, key: p.peakModel.model }, 'key');
  add('Peak interface', p.peakInterface && { total: p.peakInterface.total, key: p.peakInterface.interface }, 'key');
  add('Peak project', p.peakProject && { total: p.peakProject.total, key: p.peakProject.project }, 'key');
  cards.appendChild(kpi('Highest output day', compact(p.highestOutputDay?.value), p.highestOutputDay ? shortDate(p.highestOutputDay.key) : '—'));
  cards.appendChild(kpi('Highest input day', compact(p.highestInputDay?.value), p.highestInputDay ? shortDate(p.highestInputDay.key) : '—'));
  cards.appendChild(kpi('Highest cache day', compact(p.highestCacheDay?.value), p.highestCacheDay ? shortDate(p.highestCacheDay.key) : '—'));
  cards.appendChild(kpi('Lowest active day', compact(p.lowestActiveDay?.total), p.lowestActiveDay ? shortDate(p.lowestActiveDay.date) : '—', { title: 'Days with no usage are excluded — a calendar gap is not a low day.' }));
  root.appendChild(cards);

  root.appendChild(chartCard('top-days', 'Top 10 peak days', 'Click a row to open that day.', () => hbars(p.topDays.map((d, i) => ({
    label: `${i + 1}. ${shortDate(d.date)}`, value: d.total, color: 'var(--series-1)',
    rows: [
      { color: 'var(--series-1)', name: 'Total', value: compact(d.total) },
      { color: COMP_COLORS.input, name: 'Input', value: compact(d.input) },
      { color: COMP_COLORS.output, name: 'Output', value: compact(d.output) },
      { color: COMP_COLORS.cacheRead, name: 'Cache', value: compact(d.cache) },
    ],
    date: d.date,
  })), { fmt: compact, onClick: (r) => { S.drillDate = r.date; recompute(); render(); } }), {
    columns: [
      { key: 'date', label: 'Date', value: (r) => longDate(r.date), text: true },
      { key: 'total', label: 'Total', value: (r) => compact(r.total) },
      { key: 'input', label: 'Input', value: (r) => compact(r.input) },
      { key: 'output', label: 'Output', value: (r) => compact(r.output) },
      { key: 'cache', label: 'Cache', value: (r) => compact(r.cache) },
      { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
    ],
    rows: p.topDays,
    onRowClick: (r) => { S.drillDate = r.date; recompute(); render(); },
  }));

  if (p.peakSession) {
    const body = el('dl', { class: 'kv' });
    const add2 = (k, v2) => { body.appendChild(el('dt', { text: k })); body.appendChild(el('dd', { text: v2 })); };
    add2('Tokens', compact(p.peakSession.total));
    add2('Model', String(p.peakSession.model));
    add2('Project', String(p.peakSession.project));
    add2('Date', longDate(p.peakSession.date));
    add2('Requests', int(p.peakSession.requests));
    add2('Duration', humanDuration(p.peakSession.durationMs));
    root.appendChild(card('Largest single session', 'The heaviest individual session in this slice.', body));
  }
  root.appendChild(calendarCard());
  return root;
}

// =============================================================== efficiency ==

function viewEfficiency() {
  const v = S.view;
  const e = v.efficiency;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Usage efficiency'));
  root.appendChild(el('div', { class: 'banner info' }, [el('span', {
    text: 'These are measurements, not a score. A high output/input ratio is not automatically better — long cached contexts are how agentic tools work, and a low ratio can be exactly right.',
  })]));

  const cards = el('div', { class: 'cards' });
  cards.appendChild(kpi('Output / input', e.outputPerInput === null ? '—' : e.outputPerInput.toFixed(3), 'generated per FRESH prompt token'));
  cards.appendChild(kpi('Output / prompt sent', e.outputPerPromptToken === null ? '—' : e.outputPerPromptToken.toFixed(4), 'generated per prompt token actually sent (incl. cache)'));
  cards.appendChild(kpi('Cache / total', pct(e.cacheRatio), 'cache share of all token activity'));
  cards.appendChild(kpi('Cache hit rate', pct(e.cacheHitRate), 'cache reads / all prompt tokens'));
  cards.appendChild(kpi('Fresh per cached prompt', e.freshPerCachedPrompt === null ? '—' : e.freshPerCachedPrompt.toFixed(2), 'below 1 means cache is carrying the context'));
  cards.appendChild(kpi('Tokens / session', compact(e.tokensPerSession)));
  cards.appendChild(kpi('Output / session', compact(e.outputPerSession)));
  cards.appendChild(kpi('Requests / session', e.requestsPerSession === null ? '—' : e.requestsPerSession.toFixed(1)));
  cards.appendChild(kpi('Tokens / active day', compact(e.tokensPerActiveDay)));
  cards.appendChild(kpi('Tokens / request', compact(e.tokensPerRequest)));
  cards.appendChild(kpi('Output / request', compact(e.outputPerRequest)));
  cards.appendChild(kpi('Reasoning share of output', pct(e.reasoningShareOfOutput)));
  cards.appendChild(kpi('Refresh share of cache writes', pct(e.refreshShareOfCacheWrite)));
  root.appendChild(cards);

  const sp = v.sessionProfile;
  root.appendChild(chartCard('session-profile', 'Session size distribution', `Buckets are percentiles of this dataset, not fixed sizes. Median session ${compact(sp.medianTokens)} tokens${sp.medianDurationMs ? `, ${humanDuration(sp.medianDurationMs)}` : ''}.`, (w) => columns({
    data: sp.buckets.map((b) => ({ label: b.label, value: b.tokens, color: 'var(--series-1)', extra: [{ color: null, name: 'Sessions', value: int(b.sessions) }] })),
    width: w, height: 210, fmtY: compact, valueLabel: 'Tokens',
  }), {
    columns: [
      { key: 'label', label: 'Bucket', text: true },
      { key: 'sessions', label: 'Sessions', value: (r) => int(r.sessions) },
      { key: 'tokens', label: 'Tokens', value: (r) => compact(r.tokens) },
      { key: 'share', label: 'Share of tokens', value: (r) => pct(r.share) },
      { key: 'upperEdge', label: 'Upper edge', value: (r) => (r.upperEdge === null ? null : compact(r.upperEdge)) },
    ],
    rows: sp.buckets,
  }));

  root.appendChild(card('Per-model efficiency', 'Same measurements, per model.', table([
    { key: 'key', label: 'Model', text: true, onClick: (r) => drillTo('model', r.key) },
    { key: 'total', label: 'Total', value: (r) => compact(r.total) },
    { key: 'outIn', label: 'Output/input', value: (r) => (r.input ? (r.output / r.input).toFixed(3) : null) },
    { key: 'cacheRatio', label: 'Cache/total', value: (r) => (r.total ? pct(r.cache / r.total) : null) },
    { key: 'avgPerRequest', label: 'Tokens/request', value: (r) => compact(r.avgPerRequest) },
    { key: 'avgPerSession', label: 'Tokens/session', value: (r) => compact(r.avgPerSession) },
    { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
  ], v.dimensions.models)));
  return root;
}

// ===================================================================== cost ==

function viewCost() {
  const v = S.view;
  const c = v.cost;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Cost analysis'));

  if (c.estimated === null && c.measured === null) {
    root.appendChild(el('div', { class: 'banner warn' }, [
      el('span', { text: 'No cost is shown because no model in this slice has a configured price. Rather than invent a rate, the dashboard leaves cost blank.' }),
      btn('Configure pricing', () => pricingModal(), 'primary sm'),
    ]));
  } else {
    root.appendChild(el('div', { class: 'banner info' }, [
      el('span', { class: 'badge est', text: 'ESTIMATE' }),
      el('span', { text: c.basisNote }),
    ]));
  }

  const cards = el('div', { class: 'cards' });
  cards.appendChild(kpi('Estimated cost', usd(c.estimated), c.coverage === null ? '' : `${pct(c.coverage)} of requests priced`, { hero: true, badge: 'est.', badgeKind: 'est', badgeTitle: 'Computed from a published price table, not from a bill.' }));
  if (c.measured !== null) {
    cards.appendChild(kpi('Gateway-measured cost', usd(c.measured), 'from proxy billing logs', { badge: 'measured', badgeKind: 'meas', badgeTitle: c.measuredNote || 'Reported by a gateway that actually billed the request. Covers proxy-routed traffic only.' }));
  }
  cards.appendChild(kpi('Cost / active day', usd(c.perDay)));
  cards.appendChild(kpi('Cost / session', usd(c.perSession)));
  cards.appendChild(kpi('Cost / 1M tokens', usd(c.perMillionTokens)));
  cards.appendChild(kpi('Cost / 1M output', usd(c.perMillionOutput)));
  if (c.premiumTierShare) {
    cards.appendChild(kpi('At a premium tier', pct(c.premiumTierShare),
      `${compact(c.premiumTierTokens)} tokens · ${c.premiumTierNames.join(', ')}`,
      { title: 'Requests billed above the standard rate. OpenAI\'s Fast mode (formerly "priority") is 4x standard; Anthropic\'s Batch API is 0.5x. The multiplier is applied per request.' }));
  }
  root.appendChild(cards);

  if (c.measuredNote) {
    root.appendChild(el('div', { class: 'banner info' }, [
      el('span', { class: 'badge meas', text: 'MEASURED' }),
      el('span', { text: c.measuredNote }),
    ]));
  }

  root.appendChild(el('div', { class: 'banner warn' }, [
    el('span', { text: c.underEstimateNote }),
  ]));

  // Service tier is a billing dimension, so it gets its own breakdown.
  const tiers = v.dimensions.tiers.filter((t) => t.total > 0);
  if (tiers.length > 1) {
    const multFor = (t) => {
      const tm = S.bundle.meta.tierMultipliers || {};
      const found = Object.values(tm).map((x) => x[t]).filter((x) => x !== undefined);
      return found.length ? Math.max(...found) : 1;
    };
    root.appendChild(chartCard('cost-tier', 'Cost by service tier',
      'A tier is a price multiplier, not a label. The estimate applies it per request.',
      () => hbars(tiers.map((t) => ({
        label: `${t.key}${multFor(t.key) !== 1 ? ` (${multFor(t.key)}x)` : ''}`,
        value: t.cost === null ? 0 : t.cost,
        color: multFor(t.key) > 1 ? 'var(--series-2)' : 'var(--series-1)',
        rows: [
          { color: null, name: 'Est. cost', value: usd(t.cost) },
          { color: null, name: 'Tokens', value: compact(t.total) },
          { color: null, name: 'Requests', value: int(t.requests) },
          { color: null, name: 'Multiplier', value: multFor(t.key) + 'x' },
        ],
        tier: t.key,
      })), { fmt: usd, valueLabel: 'Est. cost', onClick: (r) => drillTo('service_tier', r.tier) }), {
      columns: [
        { key: 'key', label: 'Tier', text: true, onClick: (r) => drillTo('service_tier', r.key) },
        { key: 'mult', label: 'Multiplier', value: (r) => multFor(r.key) + 'x' },
        { key: 'total', label: 'Tokens', value: (r) => compact(r.total) },
        { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
        { key: 'cost', label: 'Est. cost', value: (r) => (r.cost === null ? null : usd(r.cost)), na: 'no price' },
        { key: 'share', label: 'Share of tokens', value: (r) => pct(r.share) },
      ],
      rows: tiers,
    }));
  }

  const priced = v.dimensions.providers.filter((p) => p.cost !== null);
  if (priced.length) {
    root.appendChild(chartCard('cost-provider', 'Cost by provider', 'Estimated, from the configured price table.', () => hbars(priced.map((p) => ({
      label: p.key, value: p.cost, color: S.colors.provider.get(p.key),
    })), { fmt: usd, valueLabel: 'Est. cost', onClick: (r) => drillTo('provider', r.label) }), {
      columns: [
        { key: 'key', label: 'Provider', text: true },
        { key: 'cost', label: 'Est. cost', value: (r) => usd(r.cost) },
        { key: 'total', label: 'Tokens', value: (r) => compact(r.total) },
        { key: 'per1m', label: '$/1M tokens', value: (r) => (r.total ? usd(r.cost / (r.total / 1e6)) : null) },
      ],
      rows: priced,
    }));
    root.appendChild(card('Cost by model', 'Estimated, from the configured price table.', table([
      { key: 'key', label: 'Model', text: true, onClick: (r) => drillTo('model', r.key) },
      { key: 'priceSource', label: 'Rate from', text: true, na: 'unpriced' },
      { key: 'cost', label: 'Est. cost', value: (r) => (r.cost === null ? null : usd(r.cost)), na: 'no price' },
      { key: 'costMeasured', label: 'Measured', value: (r) => (r.costMeasured === null ? null : usd(r.costMeasured)), na: '—' },
      { key: 'total', label: 'Tokens', value: (r) => compact(r.total) },
      { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
      { key: 'per1m', label: '$/1M', value: (r) => (r.cost !== null && r.total ? usd(r.cost / (r.total / 1e6)) : null), na: '—' },
    ], v.dimensions.models)));
  }

  const srcs = S.bundle.meta.pricingSources || {};
  if (Object.keys(srcs).length) {
    root.appendChild(card('Where these rates come from',
      `Built-in table ${S.bundle.meta.pricingTableVersion}. Your own overrides in the Pricing dialog always win.`,
      table([
        { key: 'key', label: 'Source', text: true },
        { key: 'confidence', label: 'Confidence', value: (r) => el('span', {
          class: 'badge ' + (r.confidence === 'official' ? 'meas' : r.confidence === 'third-party' ? 'est' : ''),
          text: r.confidence,
        }) },
        { key: 'fetched', label: 'Fetched', text: true },
        { key: 'url', label: 'Published at', value: (r) => el('a', { href: r.url, target: '_blank', rel: 'noreferrer noopener', text: shorten(r.url) }), text: true },
        { key: 'note', label: 'Caveat', text: true, na: '—' },
      ], Object.entries(srcs).map(([key, s2]) => ({ key, ...s2 })))));
  }

  if (c.unpriced.length) {
    root.appendChild(card('Models with no configured price', `${c.unpriced.length} model(s) covering ${compact(c.unpriced.reduce((a, u) => a + u.total, 0))} tokens. Add a price and every cost figure above updates.`, (() => {
      const box = el('div');
      box.appendChild(table([
        { key: 'model', label: 'Model', text: true },
        { key: 'provider', label: 'Provider', text: true },
        { key: 'total', label: 'Tokens', value: (r) => compact(r.total) },
        { key: 'requests', label: 'Requests', value: (r) => int(r.requests) },
      ], c.unpriced.slice(0, 40)));
      box.appendChild(el('div', { style: 'padding-top:10px' }, [btn('Configure pricing', () => pricingModal(), 'primary sm')]));
      return box;
    })()));
  }
  return root;
}

// ============================================================= productivity ==

function viewProductivity() {
  const v = S.view;
  const pr = v.productivity;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('AI activity / productivity proxies'));
  root.appendChild(el('div', { class: 'banner info' }, [el('span', {
    text: 'Token usage is not a measure of productivity. Everything on this page is either a description of AI activity or a correlation with an independent work signal — never a claim that AI usage caused an outcome.',
  })]));

  const cards = el('div', { class: 'cards' });
  const p = pr.proxies;
  cards.appendChild(kpi('AI sessions', int(p.sessions), `${p.sessionsPerActiveDay === null ? '—' : p.sessionsPerActiveDay.toFixed(1)} per active day`));
  cards.appendChild(kpi('AI-assisted days', int(p.activeDays), `${p.weekdayActiveDays} weekday · ${p.weekendActiveDays} weekend`));
  cards.appendChild(kpi('Tokens / session', compact(p.tokensPerSession)));
  cards.appendChild(kpi('Output / session', compact(p.outputPerSession)));
  cards.appendChild(kpi('Requests / session', p.requestsPerSession === null ? '—' : p.requestsPerSession.toFixed(1)));
  cards.appendChild(kpi('Projects touched', int(p.projects), `${int(p.repositories)} repositories`));
  cards.appendChild(kpi('Long sessions (>30m)', int(v.sessionProfile.longSessions), `${int(v.sessionProfile.shortSessions)} under 2 minutes`));
  cards.appendChild(kpi('Median sessions / day', p.medianSessionsPerDay === null ? '—' : int(p.medianSessionsPerDay)));
  root.appendChild(cards);

  const corr = pr.correlations;
  if (!corr.available) {
    root.appendChild(card('Work correlation', 'Unavailable — and here is exactly why.', emptyCard('Not enough overlapping data', corr.reason || '')));
  } else {
    for (const m of corr.metrics.slice(0, 3)) {
      root.appendChild(chartCard('corr-' + m.metric, `AI usage vs ${metricLabel(m.metric)}`, `Pearson r = ${m.r.toFixed(2)} (${m.strength} ${m.direction}) over ${m.n} overlapping days. ${corr.note}`, (w) => {
        const pts = m.series.map((s) => ({
          x: s.usage, y: s.work, r: 1, color: 'var(--series-1)', label: longDate(s.date),
          rows: [{ color: null, name: 'AI tokens', value: compact(s.usage) }, { color: null, name: metricLabel(m.metric), value: int(s.work) }],
        }));
        return scatter(pts, {
          width: w, height: 300, fmtX: compact, fmtY: int,
          xLabel: 'AI tokens that day', yLabel: metricLabel(m.metric),
        });
      }, {
        columns: [
          { key: 'date', label: 'Date', value: (r) => longDate(r.date), text: true },
          { key: 'usage', label: 'AI tokens', value: (r) => compact(r.usage) },
          { key: 'work', label: metricLabel(m.metric), value: (r) => int(r.work) },
        ],
        rows: [...m.series].reverse(),
      }));
    }
    if (pr.contrast && pr.contrast.difference !== null) {
      root.appendChild(card('Higher- vs lower-usage days', pr.contrast.note, (() => {
        const kv = el('dl', { class: 'kv' });
        const add = (k, val) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(el('dd', { text: val })); };
        add('Days compared', int(pr.contrast.n));
        add(`Mean ${metricLabel(pr.contrast.metric)} — lower-usage half`, int(pr.contrast.lowUsageMean));
        add(`Mean ${metricLabel(pr.contrast.metric)} — higher-usage half`, int(pr.contrast.highUsageMean));
        add('Difference between groups', signedPct(pr.contrast.difference));
        return kv;
      })()));
    }
  }

  if (pr.work.length) {
    root.appendChild(chartCard('work-series', 'Work activity over time', 'From the git / IDE activity adapters. These records carry no token counts and never enter a token total.', (w) => {
      const keys = [
        { key: 'insertions', label: 'Lines added', color: 'var(--series-3)' },
        { key: 'deletions', label: 'Lines removed', color: 'var(--series-8)' },
      ];
      const wrap = el('div');
      wrap.appendChild(timeSeries({
        data: pr.work.map((wd) => ({ key: wd.date, ...wd })), keys, mode: 'line', width: w, height: 220,
        fmtY: int, fmtX: shortDate, fmtXLong: longDate, fillArea: true, ariaLabel: 'work activity',
      }));
      wrap.appendChild(legend(keys));
      return wrap;
    }, {
      columns: [
        { key: 'date', label: 'Date', value: (r) => longDate(r.date), text: true },
        { key: 'commits', label: 'Commits', value: (r) => int(r.commits) },
        { key: 'files', label: 'Files', value: (r) => int(r.files) },
        { key: 'insertions', label: 'Lines +', value: (r) => int(r.insertions) },
        { key: 'deletions', label: 'Lines −', value: (r) => int(r.deletions) },
        { key: 'aiLines', label: 'AI lines', value: (r) => int(r.aiLines) },
        { key: 'edits', label: 'AI edits', value: (r) => int(r.edits) },
      ],
      rows: [...pr.work].reverse(),
    }));
  }
  return root;
}

function shorten(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function metricLabel(k) {
  return { commits: 'git commits', insertions: 'lines added', files: 'files changed', aiLines: 'AI-authored lines', edits: 'AI edit events' }[k] || k;
}

// ================================================================== compare ==

function viewCompare() {
  const v = S.view;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Comparison mode'));

  const def = defaultCompare();
  const a = S.compare?.a || def.a;
  const b = S.compare?.b || def.b;

  const bar = el('div', { class: 'filters', style: 'padding-top:0' });
  const mk = (label, obj, k) => dateFieldRaw(label, obj[k], (val) => {
    obj[k] = val;
    S.compare = { a, b };
    recompute();
    render();
  });
  bar.appendChild(mk('Period A from', a, 'from'));
  bar.appendChild(mk('Period A to', a, 'to'));
  bar.appendChild(mk('Period B from', b, 'from'));
  bar.appendChild(mk('Period B to', b, 'to'));
  bar.appendChild(btn('Previous vs current', () => {
    const prev = previousPeriod(v.range.from, v.range.to);
    S.compare = { a: { ...prev }, b: { from: v.range.from, to: v.range.to } };
    recompute(); render();
  }, 'ghost'));
  bar.appendChild(btn('Split range in half', () => {
    const mid = addDays(v.range.from, Math.floor((daysBetween(v.range.from, v.range.to)) / 2));
    S.compare = { a: { from: v.range.from, to: mid }, b: { from: addDays(mid, 1), to: v.range.to } };
    recompute(); render();
  }, 'ghost'));
  root.appendChild(bar);

  if (!S.compare) { S.compare = { a, b }; recompute(); }
  const cmp = S.view.comparison;
  if (!cmp) return root;

  const head = el('div', { class: 'cards' });
  head.appendChild(kpi('Period A', `${shortDate(cmp.a.period.from)} – ${shortDate(cmp.a.period.to)}`, `${cmp.a.activeDays} active days · ${compact(cmp.a.total)} tokens`));
  head.appendChild(kpi('Period B', `${shortDate(cmp.b.period.from)} – ${shortDate(cmp.b.period.to)}`, `${cmp.b.activeDays} active days · ${compact(cmp.b.total)} tokens`));
  root.appendChild(head);

  root.appendChild(card('Metric comparison', 'B relative to A. A metric with no comparable base shows "no comparable period" rather than a fabricated percentage.', table([
    { key: 'label', label: 'Metric', text: true },
    { key: 'a', label: 'Period A', value: (r) => fmtByKind(r.a, r.kind) },
    { key: 'b', label: 'Period B', value: (r) => fmtByKind(r.b, r.kind) },
    { key: 'change', label: 'Change', value: (r) => deltaChip(r.change) },
  ], cmp.deltas)));

  for (const [title, rows, key] of [['Provider shift', cmp.providerShift, 'provider'], ['Model shift', cmp.modelShift, 'model'], ['Interface shift', cmp.interfaceShift, 'interface']]) {
    root.appendChild(card(title, 'Ordered by absolute change.', table([
      { key: 'key', label: 'Key', text: true, onClick: (r) => drillTo(key, r.key) },
      { key: 'a', label: 'Period A', value: (r) => compact(r.a) },
      { key: 'b', label: 'Period B', value: (r) => compact(r.b) },
      { key: 'absolute', label: 'Change', value: (r) => (r.absolute >= 0 ? '+' : '') + compact(r.absolute) },
      { key: 'change', label: '%', value: (r) => deltaChip(r.change) },
    ], rows.filter((r) => r.a || r.b).slice(0, 15))));
  }
  return root;
}

function fmtByKind(v, kind) {
  if (v === null || v === undefined) return null;
  if (kind === 'share') return pct(v);
  if (kind === 'cost') return usd(v);
  return typeof v === 'number' && v > 9999 ? compact(v) : int(v);
}

function defaultCompare() {
  const v = S.view;
  const mid = addDays(v.range.from, Math.floor(daysBetween(v.range.from, v.range.to) / 2));
  return { a: { from: v.range.from, to: mid }, b: { from: addDays(mid, 1), to: v.range.to } };
}

function dateFieldRaw(label, value, onChange) {
  const i = el('input', { type: 'date', value: value || '' });
  i.addEventListener('change', () => onChange(i.value || null));
  return el('label', { class: 'fld' }, [el('span', { text: label }), i]);
}

// ================================================================= explorer ==

function viewExplorer() {
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Raw data explorer'));
  const ex = S.explorer;

  const bar = el('div', { class: 'filters', style: 'padding-top:0' });
  const search = el('input', { type: 'text', placeholder: 'Search model, project, session, branch…', value: ex.search });
  search.style.minWidth = '280px';
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { ex.search = search.value; ex.page = 0; loadExplorer(); }, 260);
  });
  bar.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Search' }), search]));
  const lim = el('select');
  for (const n of [25, 50, 100, 250, 500]) lim.appendChild(el('option', { value: String(n), text: `${n} / page` }));
  lim.value = String(ex.limit);
  lim.addEventListener('change', () => { ex.limit = Number(lim.value); ex.page = 0; loadExplorer(); });
  bar.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Page size' }), lim]));
  bar.appendChild(btn('⇩ Export current view', () => exportCsv('view'), 'ghost'));
  bar.appendChild(btn('⇩ Export all data', () => exportCsv('all'), 'ghost'));
  root.appendChild(bar);

  const info = el('div', { class: 'hint' });
  info.textContent = ex.loading ? 'loading…' : `${int(ex.total)} matching records · showing ${ex.rows.length} · sorted by ${ex.sort} ${ex.dir}`;
  root.appendChild(info);

  const cols = [
    { key: 'ts', label: 'Timestamp', value: (r) => (r.ts || '').replace('T', ' ').slice(0, 19), text: true },
    { key: 'p', label: 'Provider', text: true, onClick: (r) => drillTo('provider', r.p) },
    { key: 'm', label: 'Model', text: true, onClick: (r) => drillTo('model', r.m) },
    { key: 'c', label: 'Client', text: true },
    { key: 'i', label: 'Interface', text: true },
    { key: 'in', label: 'Input', value: (r) => (r.in === undefined ? null : int(r.in)) },
    { key: 'ou', label: 'Output', value: (r) => (r.ou === undefined ? null : int(r.ou)) },
    { key: 'cr', label: 'Cache R', value: (r) => (r.cr === undefined ? null : int(r.cr)) },
    { key: 'cw', label: 'Cache W', value: (r) => (r.cw === undefined ? null : int(r.cw)) },
    { key: 'tt', label: 'Total', value: (r) => (r.tt === undefined ? null : int(r.tt)) },
    { key: 's', label: 'Session', value: (r) => (r.s ? String(r.s).slice(0, 8) : null), text: true },
    { key: 'pj', label: 'Project', text: true },
    { key: 'tr', label: 'Tier', text: true, onClick: (r) => (r.tr ? drillTo('service_tier', r.tr) : null) },
    { key: 'co', label: 'Cost', value: (r) => (r.co === undefined ? null : usd(r.co)), na: 'no price' },
    { key: 'ms', label: 'Kind', text: true },
  ];
  root.appendChild(card('Normalized records', 'Streamed from disk, filtered server-side. An empty cell means the source did not report that field — it is never shown as 0.', (() => {
    const box = el('div');
    box.appendChild(table(cols, ex.rows, {
      onSort: (k) => { if (ex.sort === k) ex.dir = ex.dir === 'asc' ? 'desc' : 'asc'; else { ex.sort = k; ex.dir = 'desc'; } loadExplorer(); },
      sortKey: ex.sort, sortDir: ex.dir,
      onRowClick: (r) => recordModal(r),
      tall: true,
      emptyText: ex.loading ? 'loading…' : 'No records match the current filters.',
    }));
    const nav = el('div', { style: 'display:flex;gap:8px;align-items:center;padding-top:10px' });
    nav.appendChild(btn('← Previous', () => { if (ex.page > 0) { ex.page--; loadExplorer(); } }, 'ghost sm'));
    nav.appendChild(el('span', { class: 'muted', text: `page ${ex.page + 1} of ${Math.max(1, Math.ceil(ex.total / ex.limit))}` }));
    nav.appendChild(btn('Next →', () => { if ((ex.page + 1) * ex.limit < ex.total) { ex.page++; loadExplorer(); } }, 'ghost sm'));
    box.appendChild(nav);
    return box;
  })()));

  if (!ex.rows.length && !ex.loading) loadExplorer();
  return root;
}

async function loadExplorer() {
  const ex = S.explorer;
  ex.loading = true;
  render();
  try {
    if (SNAPSHOT) {
      ex.rows = (window.__TOKENFLOW_RECORDS__ || []).slice(ex.page * ex.limit, (ex.page + 1) * ex.limit);
      ex.total = (window.__TOKENFLOW_RECORDS__ || []).length;
    } else {
      const q = new URLSearchParams({
        offset: String(ex.page * ex.limit), limit: String(ex.limit),
        sort: ex.sort, dir: ex.dir, search: ex.search,
        from: S.filters.from || '', to: S.filters.to || '',
      });
      for (const [k, fk] of [['provider', 'provider'], ['model', 'model'], ['client', 'client'], ['interface', 'interface'], ['project', 'project']]) {
        if (S.filters[fk] && S.filters[fk].length) q.set(k, S.filters[fk].join(','));
      }
      const res = await fetchJson('/api/records?' + q.toString());
      ex.rows = res.rows;
      ex.total = res.total;
    }
  } catch (err) {
    ex.rows = [];
    ex.total = 0;
    console.error(err);
  }
  ex.loading = false;
  render();
}

function recordModal(r) {
  const body = el('div');
  const kv = el('dl', { class: 'kv' });
  const NAMES = {
    ts: 'Timestamp', d: 'Date', h: 'Hour', p: 'Provider', m: 'Model', mf: 'Family', g: 'Gateway', tr: 'Service tier',
    c: 'Client', ap: 'Application', i: 'Interface', in: 'Input tokens', ou: 'Output tokens',
    cr: 'Cache read', cw: 'Cache write', cf: 'Cache refresh', rs: 'Reasoning', tt: 'Total',
    s: 'Session', cv: 'Conversation', rq: 'Request id', pj: 'Project', rp: 'Repository',
    br: 'Branch', k: 'Category', co: 'Cost', cb: 'Cost basis', ms: 'Measurement', so: 'Source',
    du: 'Duration ms', u: 'User', mc: 'Machine',
  };
  for (const [k, label] of Object.entries(NAMES)) {
    kv.appendChild(el('dt', { text: label }));
    const v = r[k];
    kv.appendChild(el('dd', v === undefined || v === null
      ? { class: 'na', text: 'not available', title: 'The source did not report this field' }
      : { text: String(v) }));
  }
  body.appendChild(kv);
  if (r.x) {
    body.appendChild(el('h3', { style: 'margin-top:16px', text: 'Source metadata' }));
    body.appendChild(el('pre', { class: 'mono', style: 'white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:6px', text: JSON.stringify(r.x, null, 2) }));
  }
  openModal('Record ' + (r.id || ''), body);
}

// ============================================================== data health ==

function viewHealth() {
  const h = S.bundle.health;
  const m = S.bundle.meta;
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Data health'));

  const cards = el('div', { class: 'cards' });
  cards.appendChild(kpi('Data health', h.grade, `${pct(h.missingTokenFieldRate)} of token fields not reported`, { hero: true }));
  cards.appendChild(kpi('Records', int(h.records), `${int(h.sourceFiles)} source files tracked`));
  cards.appendChild(kpi('Date coverage', h.coverage.from ? `${shortDate(h.coverage.from)} → ${shortDate(h.coverage.to)}` : '—', `${h.coverage.from ? daysBetween(h.coverage.from, h.coverage.to) + 1 : 0} days`));
  cards.appendChild(kpi('Providers', int(h.providers), `${int(h.models)} models · ${int(h.clients)} clients`));
  cards.appendChild(kpi('Sessions', int(h.sessions)));
  cards.appendChild(kpi('Duplicate records', int(h.duplicateRecords), 'structural dedup: bytes are never read twice', { title: 'Ingest resumes at a byte offset per source file, so a record cannot be ingested twice. Streaming duplicates within a source are collapsed by the adapter.' }));
  cards.appendChild(kpi('Malformed lines skipped', int(h.malformedLines)));
  cards.appendChild(kpi('Last refresh', relativeTime(m.lastRefresh), m.lastRefreshDurationMs ? `took ${humanDuration(m.lastRefreshDurationMs)}` : ''));
  root.appendChild(cards);

  // ---- request geography: honest unavailability ------------------------------
  // No supported source exposes the network region a request was served to:
  // local session logs record tokens, models and timestamps, not IP egress.
  // Rather than infer geography from model names (wrong) or show zeros, this
  // panel states plainly what is and is not knowable from local logs.
  // ---- request geography: honest unavailability ------------------------------
  // No supported source exposes the network region a request was served to:
  // local session logs record tokens, models and timestamps, not IP egress.
  // Rather than infer geography from model names (wrong) or show zeros, this
  // panel states plainly what is and is not knowable from local logs.
  const geoBody = el('div');
  geoBody.appendChild(el('p', { class: 'muted', text: 'Region data: not provided by provider for all connected sources.' }));
  const geoDetail = el('p', { class: 'muted' });
  const geoStrong = document.createElement('strong');
  geoStrong.textContent = 'What is known instead: ';
  geoDetail.appendChild(geoStrong);
  geoDetail.appendChild(document.createTextNode('requests by provider, model, interface and client — all measured from your own logs on the Providers and Interfaces pages.'));
  geoBody.appendChild(geoDetail);
  root.appendChild(card('Request geography', 'Where requests are served is a property of vendor infrastructure, and none of the local sources report it. TokenFlow will surface per-region breakdowns the day a connected source exposes region data; until then every request is recorded with region not available, never guessed.', geoBody));

  root.appendChild(card('Field availability', 'Per-field share of records where the source reported nothing. These gaps are excluded from totals, never counted as zero.', table([
    { key: 'field', label: 'Field', text: true },
    { key: 'missing', label: 'Not reported', value: (r) => pct(r.missing) },
    { key: 'bar', label: '', value: (r) => miniBar(r.missing, r.missing > 0.3 ? 'var(--warning)' : 'var(--series-1)') },
  ], Object.entries(h.missingByField).map(([field, missing]) => ({ field, missing })))));

  root.appendChild(card('Sources', 'What each adapter contributed, and the window it actually covers — a source that only started logging in July does not cover the whole range.', table([
    { key: 'id', label: 'Adapter', text: true },
    { key: 'records', label: 'Records', value: (r) => int(r.records) },
    { key: 'tokens', label: 'Tokens', value: (r) => (r.tokens ? compact(r.tokens) : null), na: 'none reported' },
    { key: 'sessions', label: 'Sessions', value: (r) => int(r.sessions) },
    { key: 'coverage', label: 'Covers', value: (r) => (r.coverage?.from ? `${shortDate(r.coverage.from)} → ${shortDate(r.coverage.to)}` : null), text: true },
    { key: 'files', label: 'Files tracked', value: (r) => int(r.files) },
    { key: 'lastRefresh', label: 'Last refresh', value: (r) => relativeTime(r.lastRefresh), text: true },
  ], m.sources)));

  root.appendChild(card('Measurement kinds', 'Why some records never contribute tokens.', (() => {
    const box = el('div');
    box.appendChild(el('p', { class: 'hint', text: 'primary — authoritative per-request usage from the model API; counted in every total.' }));
    box.appendChild(el('p', { class: 'hint', text: 'overlay — a gateway/proxy view of traffic already counted by a client adapter. Excluded from totals by default so tokens are not double counted; contributes measured cost.' }));
    box.appendChild(el('p', { class: 'hint', text: 'activity — AI activity with no token accounting (IDE edits, sessions without a usage block, commits). Contributes to activity and correlation only.' }));
    return box;
  })()));
  return root;
}

// ================================================================= refresh ===

async function doRefresh() {
  if (S.refreshing) return;
  S.refreshing = true;
  const b = /** @type {HTMLButtonElement|null} */ (document.getElementById('refresh-btn'));
  if (b) { b.disabled = true; b.textContent = '↻ Refreshing…'; }
  document.getElementById('view').classList.add('refreshing');
  renderHeaderMeta();
  const status = el('div', { class: 'banner info' }, [el('span', { text: 'Scanning sources…' })]);
  document.getElementById('banners').prepend(status);
  try {
    // Stream progress so a multi-gigabyte first scan shows life, and keep the
    // previous render on screen at reduced opacity — no skeleton, no jump.
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let report = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'progress') status.firstChild.textContent = `${ev.provider}: ${int(ev.files)} files, ${int(ev.records)} new records…`;
        else if (ev.type === 'log') status.firstChild.textContent = ev.message;
        else if (ev.type === 'done') report = ev.report;
      }
    }
    // Preserve filters across the reload — the whole point of a refresh button.
    const keep = { ...S.filters };
    const keepRange = S.rangeId;
    S.bundle = await fetchJson('/api/bundle');
    S.filters = keep;
    if (keepRange !== 'custom') applyRange(keepRange, { silent: true });
    recompute();
    status.textContent = '';
    status.appendChild(el('span', {
      text: report
        ? `Refresh complete: ${int(report.newRecords)} new records from ${int(report.filesScanned)} changed files (${int(report.filesSkipped)} unchanged files skipped) in ${humanDuration(report.durationMs)}.${report.done ? '' : ' Budget reached — run refresh again to continue.'}`
        : 'Refresh complete.',
    }));
    if (report && !report.done) status.appendChild(btn('Continue', () => doRefresh(), 'primary sm'));
    setTimeout(() => status.remove(), 9000);
  } catch (err) {
    status.className = 'banner';
    status.textContent = 'Refresh failed: ' + err.message;
  } finally {
    S.refreshing = false;
    document.getElementById('view').classList.remove('refreshing');
    if (b) { b.disabled = false; b.textContent = '↻ Refresh data'; }
    render();
  }
}

// ================================================================== exports ==

function exportMenu(ev) {
  const body = el('div');
  body.appendChild(el('p', { class: 'hint', text: 'Missing values export as empty cells, never as 0, so a spreadsheet cannot turn "not reported" into "zero".' }));
  const list = el('div', { style: 'display:grid;gap:8px' });
  list.appendChild(btn('Export current view (filtered records)', () => { exportCsv('view'); closeModal(); }, 'primary'));
  list.appendChild(btn('Export all data (every record)', () => { exportCsv('all'); closeModal(); }, 'ghost'));
  list.appendChild(btn('Export daily series', () => {
    downloadCsv('tokenflow-daily.csv', [
      { key: 'key', label: 'date' }, { key: 'total', label: 'total_tokens' }, { key: 'in', label: 'input_tokens' },
      { key: 'out', label: 'output_tokens' }, { key: 'cr', label: 'cache_read_tokens' }, { key: 'cw', label: 'cache_write_tokens' },
      { key: 'cf', label: 'cache_refresh_tokens' }, { key: 'rs', label: 'reasoning_tokens' }, { key: 'req', label: 'requests' },
      { key: 'active', label: 'active_day' },
    ], S.view.daily);
    closeModal();
  }, 'ghost'));
  list.appendChild(btn('Export provider table', () => { downloadCsv('tokenflow-providers.csv', providerCsvCols(), S.view.dimensions.providers); closeModal(); }, 'ghost'));
  list.appendChild(btn('Export model table', () => { downloadCsv('tokenflow-models.csv', providerCsvCols(), S.view.dimensions.models); closeModal(); }, 'ghost'));
  body.appendChild(list);
  openModal('Export CSV', body);
}

function providerCsvCols() {
  return [
    { key: 'key', label: 'key' }, { key: 'total', label: 'total_tokens' }, { key: 'input', label: 'input_tokens' },
    { key: 'output', label: 'output_tokens' }, { key: 'cacheRead', label: 'cache_read_tokens' },
    { key: 'cacheWrite', label: 'cache_write_tokens' }, { key: 'requests', label: 'requests' },
    { key: 'sessions', label: 'sessions' }, { key: 'activeDays', label: 'active_days' },
    { key: 'avgPerActiveDay', label: 'avg_per_active_day' }, { key: 'peakDay', label: 'peak_day' },
    { key: 'cost', label: 'estimated_cost' }, { key: 'share', label: 'share' },
  ];
}

function exportCsv(scope) {
  const today = new Date().toISOString().slice(0, 10);
  if (SNAPSHOT) {
    const rows = window.__TOKENFLOW_RECORDS__ || [];
    downloadCsv(`tokenflow-usage-${today}.csv`, [
      { key: 'ts', label: 'timestamp' }, { key: 'p', label: 'provider' }, { key: 'm', label: 'model' },
      { key: 'c', label: 'client' }, { key: 'i', label: 'interface' }, { key: 'in', label: 'input_tokens' },
      { key: 'ou', label: 'output_tokens' }, { key: 'cr', label: 'cache_read_tokens' }, { key: 'cw', label: 'cache_write_tokens' },
      { key: 'tt', label: 'total_tokens' }, { key: 's', label: 'session_id' }, { key: 'pj', label: 'project' },
      { key: 'co', label: 'estimated_cost' },
    ], rows);
    return;
  }
  const q = new URLSearchParams({ scope });
  if (scope === 'view') {
    q.set('from', S.filters.from || '');
    q.set('to', S.filters.to || '');
    for (const k of ['provider', 'model', 'client', 'interface', 'project']) {
      if (S.filters[k] && S.filters[k].length) q.set(k, S.filters[k].join(','));
    }
  }
  window.location.href = '/api/export.csv?' + q.toString();
}

function downloadCsv(name, cols, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let out = cols.map((c) => cell(c.label ?? c.key)).join(',') + '\n';
  for (const r of rows) {
    out += cols.map((c) => {
      const raw = c.raw ? c.raw(r) : r[c.key];
      return cell(raw instanceof Node ? '' : raw);
    }).join(',') + '\n';
  }
  const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ================================================================== pricing ==

function pricingModal() {
  const body = el('div');
  body.appendChild(el('p', { class: 'hint', text: `Rates are USD per 1,000,000 tokens. Built-in table ${S.bundle.meta.pricingTableVersion}; anything you enter here overrides it. Left blank means unpriced — the dashboard shows "no price" rather than inventing a rate. Cache write columns: the first is the short-TTL (5-minute) rate, and the long-TTL (1-hour) subset falls back to each vendor's published multiple.` }));
  body.appendChild(el('p', { class: 'hint', text: 'Service-tier multipliers (OpenAI Fast mode 4x, Anthropic Batch 0.5x) are applied automatically per request from the recorded tier — do not bake them into these rates.' }));
  const models = S.view.dimensions.models;
  const existing = S.bundle.pricing?.models || {};
  const inputs = new Map();
  const rows = models.map((m) => {
    const cur = existing[m.key] || {};
    const mk = (k, ph) => {
      const i = el('input', { type: 'number', step: '0.0001', min: '0', placeholder: ph, value: cur[k] ?? '' });
      i.style.width = '92px';
      return i;
    };
    const inp = mk('in', 'input');
    const out = mk('out', 'output');
    const cr = mk('cacheRead', 'cache r');
    const cw = mk('cacheWrite', 'cache w');
    inputs.set(m.key, { in: inp, out, cacheRead: cr, cacheWrite: cw });
    return { model: m.key, tokens: m.total, priced: m.cost !== null, inp, out, cr, cw };
  });
  body.appendChild(table([
    { key: 'model', label: 'Model', text: true },
    { key: 'tokens', label: 'Tokens', value: (r) => compact(r.tokens) },
    { key: 'priced', label: 'Status', value: (r) => el('span', { class: 'badge ' + (r.priced ? 'meas' : 'na'), text: r.priced ? 'priced' : 'no price' }) },
    { key: 'in', label: 'Input $/1M', value: (r) => r.inp },
    { key: 'out', label: 'Output $/1M', value: (r) => r.out },
    { key: 'cr', label: 'Cache read', value: (r) => r.cr },
    { key: 'cw', label: 'Cache write', value: (r) => r.cw },
  ], rows));

  const foot = [
    btn('Save & refresh totals', async () => {
      const models2 = {};
      for (const [key, fields] of inputs) {
        const o = {};
        for (const [k, i] of Object.entries(fields)) if (i.value !== '') o[k] = Number(i.value);
        if (Object.keys(o).length) models2[key] = o;
      }
      if (SNAPSHOT) {
        S.bundle.pricing = { models: models2 };
        recompute(); closeModal(); render();
        return;
      }
      await fetch('/api/pricing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: models2 }) });
      closeModal();
      await doRefresh();
    }, 'primary'),
  ];
  openModal(`Pricing — table ${S.bundle.meta.pricingTableVersion}`, body, foot);
}

// ==================================================================== modal ==

function openModal(title, body, foot) {
  const d = /** @type {HTMLDialogElement} */ (document.getElementById('modal'));
  document.getElementById('modal-title').textContent = title;
  const b = document.getElementById('modal-body');
  b.textContent = '';
  b.appendChild(body);
  const f = document.getElementById('modal-foot');
  f.textContent = '';
  for (const x of [].concat(foot || [])) f.appendChild(x);
  f.appendChild(btn('Close', () => closeModal(), 'ghost'));
  document.getElementById('modal-close').onclick = () => closeModal();
  d.showModal();
}
function closeModal() {
  /** @type {HTMLDialogElement} */ (document.getElementById('modal')).close();
}

// ===================================================================== util ==

async function fetchJson(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text()}`);
  return r.json();
}

function loadPrefs() {
  // Server-side preferences are the source of truth; localStorage is only an
  // offline fallback and may legitimately be unavailable, so never let it throw.
  try {
    const raw = localStorage.getItem('tokenflow-prefs');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let saveTimer = null;
function savePrefs() {
  const prefs = {
    theme: document.documentElement.dataset.mode,
    skin: document.documentElement.dataset.skin,
    mode: document.documentElement.dataset.mode,
    tab: S.tab,
    granularity: S.granularity,
    rangeId: S.rangeId,
    filters: S.filters,
  };
  try {
    localStorage.setItem('tokenflow-prefs', JSON.stringify(prefs));
  } catch { /* private mode / file:// — preferences simply don't persist */ }
  if (SNAPSHOT) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prefs) }).catch(() => {});
  }, 800);
}

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'r' && (ev.metaKey || ev.ctrlKey) === false && ev.target === document.body && !SNAPSHOT) doRefresh();
  if (ev.key === 'Escape') tooltip.hide();
});

// ============================================================== live view ==

const SEV = {
  high: { label: 'high', cls: 'sev-high' },
  warn: { label: 'watch', cls: 'sev-warn' },
  info: { label: 'info', cls: 'sev-info' },
};

function liveWatcherCard() {
  const body = el('div');
  const w = S.live?.watcher;
  if (w) {
    const age = S.live.freshness?.ageMs;
    body.appendChild(el('div', { class: 'chips', style: 'padding:10px 14px' }, [
      el('span', { class: 'badge ok', text: `● watcher running · pid ${w.pid}` }),
      el('span', { class: 'muted', text: `every ${w.intervalSeconds ?? '?'}s · ${int(w.cycles)} cycles` + (age != null ? ` · snapshot ${relativeTime(S.live.generatedAt)}` : '') }),
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
  return card('Real-time engine', 'The watcher refreshes incrementally and rewrites data/status.json after every cycle.', body);
}

function limitRow(s) {
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

function capacityCard() {
  const cap = S.view.capacity || { states: [], invalid: [], summary: {} };
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
    const actions = btn('⧉ Copy YAML', () => {
      navigator.clipboard.writeText(yaml).then(() => { actions.textContent = '✓ Copied'; setTimeout(() => { actions.textContent = '⧉ Copy YAML'; }, 1500); }).catch(() => {});
    }, 'ghost sm');
    return card('Capacity & budgets', 'Burn rate, exhaustion ETA and reset countdowns for your declared limits.', body, actions);
  }

  const sum = cap.summary || {};
  if (sum.counts && (sum.counts.exceeded || sum.counts.warn)) {
    body.appendChild(el('div', { class: 'chips', style: 'padding:2px 0 8px' }, [
      sum.counts.exceeded ? el('span', { class: 'badge demo', text: `${sum.counts.exceeded} exceeded` }) : null,
      sum.counts.warn ? el('span', { class: 'badge warn', text: `${sum.counts.warn} approaching` }) : null,
      sum.firstToHit ? el('span', { class: 'muted', text: `first projected hit: ${sum.firstToHit.label} in ${countdown(sum.firstToHit.etaHours * 3600000)}` }) : null,
    ].filter(Boolean)));
  }
  for (const s of cap.states) body.appendChild(limitRow(s));
  if (cap.invalid?.length) {
    body.appendChild(el('p', { class: 'hint', text: `${cap.invalid.length} invalid limit definition(s) in config were ignored — check \`tokenflow capacity\`.` }));
  }
  const manage = SNAPSHOT
    ? null
    : btn('⚙ Manage limits', openLimitEditor, 'ghost sm');
  return card('Capacity & budgets', 'Evaluated against all primary usage regardless of dashboard filters — quota windows are facts about your accounts, not filter states.', body, manage);
}

function openLimitEditor() {
  const cur = (S.bundle.limits || []).map((l) => ({ ...l }));
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
      r.appendChild(btn('Remove', () => { cur.splice(cur.indexOf(l), 1); renderRows(); }, 'ghost sm'));
      rows.appendChild(r);
    }
    if (!cur.length) rows.appendChild(el('p', { class: 'hint', text: 'No limits yet — add one below.' }));
  };
  renderRows();
  body.appendChild(rows);

  const f = {};
  const field = (key, placeholder, type = 'text') => {
    const input = el('input', { placeholder, type, 'aria-label': key });
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
  foot.appendChild(btn('Cancel', () => document.getElementById('modal-close').click(), 'ghost sm'));
  foot.appendChild(btn('Save limits', async () => {
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
      S.bundle.limits = out.limits;
      recompute();
      render();
      document.getElementById('modal-close').click();
    } catch (e) {
      errBox.textContent = `Save failed: ${e.message}`;
    }
  }, 'sm'));
  body.appendChild(foot);

  openModal('Manage capacity limits', body);
}

function forecastCard() {
  const v = S.view;
  const f = v.forecast;
  const body = el('div');

  if (!f || f.tomorrow === null) {
    body.appendChild(el('p', { class: 'hint', text: f?.reason || 'Not enough history yet.' }));
    return card('Forecast', 'A conservative linear trend over recent days — never a promise.', body);
  }

  const kpis = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:10px 14px 2px' });
  const kpiTile = (label, val, sub) => {
    const d = el('div', { style: 'background:var(--surface-2);border-radius:8px;padding:10px' });
    d.appendChild(el('div', { class: 'hint', text: label }));
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

  return card('Forecast', 'Measured history first; projections always labelled and kept apart.', body);
}

function anomaliesCard() {
  const v = S.view;
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
  return card('Anomalies & changes', 'Robust median/MAD detection — every alert shows observed vs expected so you can check it.', body);
}

function viewLive() {
  ensureLiveLoop();
  const root = el('div', { class: 'grid' });
  if (!SNAPSHOT) root.appendChild(liveWatcherCard());
  root.appendChild(capacityCard());
  root.appendChild(forecastCard());
  root.appendChild(anomaliesCard());
  return root;
}

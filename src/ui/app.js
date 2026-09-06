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
import { renderReceiptMarkdown } from '../analytics/receipt.js';
import {
  el, svg, timeSeries, columns, hbars, donut, compositionBar, calendarHeatmap,
  matrix, scatter, sparkline, legend, table, miniBar, tooltip, observeWidth,
  ColorScale, SERIES_VARS, OTHER_COLOR, scaleLegend,
} from './charts.js';
import * as charts from './charts.js';
import { VIEWS } from './views/index.js';
import { mountPalette } from './palette.js';
import { maybeShowFirstRun } from './first-run.js';
import { icon, ICON_NAMES } from './components/icons.js';
import { attachTooltip } from './components/tooltip.js';
import { mountFilterBar } from './filters.js';

const SNAPSHOT = typeof window !== 'undefined' && !!window.__TOKENFLOW_BUNDLE__;

/**
 * The build this page was LOADED from, stamped into the HTML by the server.
 *
 * It is as old as the JavaScript running beside it, which is the point: a tab
 * left open across an upgrade keeps this value while the API starts reporting
 * the new one. Comparing the two is the only way the page can tell that its own
 * code is stale, because every module was fetched once, at load, and `no-store`
 * only helps a reload that never happened. A snapshot has no server to be out
 * of step with, so the check does not apply there.
 */
const LOADED_BUILD = typeof document !== 'undefined'
  ? (document.querySelector('meta[name="tokenflow-build"]')?.getAttribute('content') || null)
  : null;

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

/**
 * The tabs app.js renders itself, as `[id, label, order]`.
 *
 * Orders are spaced by 10 so a view registered in ./views/index.js can slot
 * anywhere without renumbering anything. 30 is deliberately absent: the Live
 * tab is a registered view and claims it from the registry.
 */
const TABS = [
  ['overview', 'Overview', 10],
  ['receipts', 'Receipts', 20],
  ['providers', 'Providers', 40],
  ['models', 'Models', 50],
  ['interfaces', 'Interfaces', 60],
  ['time', 'Time patterns', 70],
  ['peaks', 'Peaks', 80],
  ['efficiency', 'Efficiency', 90],
  ['cost', 'Cost', 100],
  ['productivity', 'Productivity', 110],
  ['compare', 'Compare', 120],
  ['explorer', 'Data explorer', 130],
  ['health', 'Data health', 140],
];

const BUILTIN_TAB_IDS = new Set(TABS.map(([id]) => id));

/**
 * Topic groups for the tab strip's overflow menu. Presentation only: the order
 * of the strip still comes from TABS and the registry. An id missing here lands
 * under "More views", so a newly registered view needs no edit to appear.
 */
/** @type {[string, string[]][]} */
const TAB_GROUPS = [
  ['Spend', ['overview', 'receipts', 'tickets', 'cost', 'branches', 'compare']],
  ['Sessions', ['anatomy', 'live', 'productivity', 'rhythm']],
  ['Models', ['providers', 'models', 'interfaces', 'efficiency', 'cache']],
  ['Time', ['time', 'peaks', 'whatif']],
  ['Data', ['explorer', 'annotations', 'health']],
];

/**
 * Tab id -> icon name in ./components/icons.js, verified one-for-one against
 * every built-in tab and every id named in TAB_GROUPS: overview, receipts,
 * tickets, cost, branches, compare, anatomy, live, productivity, rhythm,
 * providers, models, interfaces, efficiency, cache, time, peaks, whatif,
 * explorer, annotations and health each have a same-named glyph.
 *
 * Kept as an explicit table rather than using a tab id directly as an icon
 * name: the icon set and the tab list are maintained by different people, and
 * a rename on either side must fail here in one obvious place, not as a
 * blank icon discovered weeks later.
 * @type {Record<string,string>}
 */
const TAB_ICONS = {
  overview: 'overview', receipts: 'receipts', tickets: 'tickets', cost: 'cost',
  branches: 'branches', compare: 'compare', anatomy: 'anatomy', live: 'live',
  productivity: 'productivity', rhythm: 'rhythm', providers: 'providers',
  models: 'models', interfaces: 'interfaces', efficiency: 'efficiency',
  cache: 'cache', time: 'time', peaks: 'peaks', whatif: 'whatif',
  explorer: 'explorer', annotations: 'annotations', health: 'health',
};
/** Drawn for a tab id TAB_ICONS does not name, or names an icon that no longer
 * exists: a view a plugin registers at runtime must never render blank. */
const TAB_ICON_FALLBACK = 'more-horizontal';

/**
 * The icon name to draw for a tab id, guarding both ends: an id missing from
 * TAB_ICONS, and a mapped name the icon set no longer carries.
 * @param {string} id
 * @returns {string} one of ICON_NAMES
 */
function tabIcon(id) {
  const name = TAB_ICONS[id];
  return name && ICON_NAMES.includes(name) ? name : TAB_ICON_FALLBACK;
}

// Declared here, above boot(): the snapshot boots synchronously at module end,
// and a binding below that call would still be in its temporal dead zone.
const SIDEBAR_DEFAULT_W = 248;
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 420;
const SIDEBAR_RAIL_W = 56;
/** Sidebar chrome state. `w` and `collapsed` persist with the other prefs; `drawerOpen` is per load. */
const sideState = { w: SIDEBAR_DEFAULT_W, collapsed: false, drawerOpen: false };
/**
 * Which `collapsed` value #side-toggle's icon and the nav items' tooltips
 * were last built for, so applySidebarState (called on every pointermove
 * while dragging the resizer) only rebuilds them on the one call where
 * collapsed actually flipped, not dozens of times a drag.
 * @type {boolean|null}
 */
let sideCollapsedRendered = null;
/** detach() for #side-toggle's current tooltip, so a rebuild removes the old one first. */
let toggleTooltipDetach = null;
/**
 * detach() functions for every tooltip syncNavTooltips() attached to a nav
 * item. renderSidebar rebuilds #tabs from scratch on every tab switch, and
 * attachTooltip adds a capture-phase `window` scroll listener per call that
 * only its own detach() removes. Without this, switching tabs a thousand
 * times would leave a thousand dead listeners closed over discarded nodes.
 * Declared here, above boot() at the bottom of this file, for the same
 * temporal-dead-zone reason SIDEBAR_DEFAULT_W and `palette` are: boot() calls
 * initSidebar() -> applySidebarState() -> syncNavTooltips() synchronously,
 * before the rest of the module's top-level bindings would otherwise run.
 * @type {(() => void)[]}
 */
let sideTooltipDetachers = [];

/**
 * Registered views that are safe to mount: a unique id that does not collide
 * with a built-in tab, and the three required exports.
 *
 * A malformed entry is dropped with a console message rather than allowed to
 * break every other tab. Several people add views to the same registry, and one
 * bad module must not take the dashboard down with it.
 *
 * @returns {object[]}
 */
function registeredViews() {
  const seen = new Set();
  const out = [];
  for (const v of VIEWS) {
    const where = v && v.id ? `view "${v.id}"` : 'a view module';
    if (!v || typeof v.id !== 'string' || !v.id) { console.error(`registry: ${where} has no id — skipped`); continue; }
    if (typeof v.view !== 'function' || typeof v.label !== 'string' || typeof v.order !== 'number') {
      console.error(`registry: ${where} needs label, order and view() — skipped`);
      continue;
    }
    if (BUILTIN_TAB_IDS.has(v.id) || seen.has(v.id)) { console.error(`registry: ${where} duplicates an existing tab id — skipped`); continue; }
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/**
 * Built-in tabs and registered views merged into one ordered tab list.
 * @returns {{id:string,label:string,order:number,module:object|null}[]}
 */
function allTabs() {
  const builtin = TABS.map(([id, label, order]) => ({ id, label, order, module: null }));
  const registered = registeredViews().map((v) => ({ id: v.id, label: v.label, order: v.order, module: v }));
  return [...builtin, ...registered].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The registered module owning a tab id, or null for a built-in tab. */
function viewModule(id) {
  return allTabs().find((t) => t.id === id)?.module || null;
}

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

// =========================================================== view registry ==

/**
 * One `<link>` per registered view's stylesheet, injected once.
 *
 * Development only. A saved snapshot has no server to fetch src/ from, so the
 * exporter inlines the same files instead — see src/export/html-snapshot.js.
 */
let viewStylesInjected = false;
function injectViewStyles() {
  if (SNAPSHOT || viewStylesInjected) return;
  viewStylesInjected = true;
  const already = new Set();
  document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => already.add(l.getAttribute('href')));
  for (const v of registeredViews()) {
    if (!v.css) continue;
    const href = '/src/ui/' + String(v.css).replace(/^\.?\//, '');
    if (already.has(href)) continue;
    already.add(href);
    document.head.appendChild(el('link', { rel: 'stylesheet', href }));
  }
}

/**
 * The stylesheets for palette.js and first-run.js: not registered views (they
 * are app.js features, not tabs), so injectViewStyles() never sees them. They
 * still live under src/ui/styles/, which means html-snapshot.js's collectCss
 * inlines them into an offline snapshot for free — this function only has to
 * cover the dev server, where nothing else links them.
 *
 * A static `<link>` in index.html would do the same job in dev, but the
 * snapshot's `<link>` removal is a single, non-global replace (see
 * html-snapshot.js): a second `<link>` there would survive into the saved
 * file and fail to load from file://. Injecting by script, the same way
 * injectViewStyles() does, avoids that entirely.
 */
const OWN_STYLES = ['./styles/palette.css', './styles/first-run.css', './styles/sidebar.css', './styles/components.css', './styles/filters.css'];
let ownStylesInjected = false;
function injectOwnStyles() {
  if (SNAPSHOT || ownStylesInjected) return;
  ownStylesInjected = true;
  for (const css of OWN_STYLES) {
    const href = '/src/ui/' + css.replace(/^\.?\//, '');
    document.head.appendChild(el('link', { rel: 'stylesheet', href }));
  }
}

/**
 * Set once boot() mounts it; the chip's click handler is the only other
 * caller. Declared here — before `boot().catch(...)` is invoked below — and
 * NOT after boot()'s own definition: in a snapshot, boot() never hits a real
 * `await` (the bundle is already on `window`, so the SNAPSHOT branch of the
 * ternary never evaluates the `await` branch), so it runs start to finish
 * synchronously in one go. A `let` declared later in the file would still be
 * in its temporal dead zone at that point, exactly like `viewStylesInjected`
 * had to be declared before boot() for the same reason.
 */
let palette = null;

/**
 * The filter bar, mounted once on the first render and patched by every render
 * after it. Declared here for the same temporal-dead-zone reason as `palette`
 * above: in a snapshot, boot() runs start to finish synchronously.
 *
 * It is mounted lazily rather than in boot() because it reads `S.view.facets`
 * to build a value list, and the first recompute() has to have happened.
 * @type {import('./filters.js').FilterBarApi|null}
 */
let filterBar = null;

/**
 * Intervals a view asked for, in two lifetimes: one registered from `onEnter`
 * lives until the view is left, one registered from `view()` only until the
 * next render — because that render runs `view()` again and it would otherwise
 * stack a duplicate every time a filter changed.
 */
const viewTimers = { enter: [], render: [] };
/** @type {'enter'|'render'} */
let timerPhase = 'render';
let enteredTab = null;

function clearViewTimers(phase) {
  for (const t of viewTimers[phase]) clearInterval(t);
  viewTimers[phase] = [];
}

/**
 * The object every registered view is given. `bundle`, `view` and `filters` are
 * getters over live state, so a ctx held in a closure never reads a stale one.
 *
 * @returns {import('./views/index.js').ViewContext}
 */
function viewContext() {
  return {
    S,
    get bundle() { return S.bundle; },
    get view() { return S.view; },
    get filters() { return S.filters; },
    snapshot: SNAPSHOT,
    el,
    card,
    chartCard,
    btn,
    kpi,
    deltaChip,
    sectionTitle,
    emptyCard,
    openModal,
    closeModal,
    drillTo,
    fmt: {
      compact, int, usd, pct, signedPct, shortDate, longDate,
      hourLabel, hourWindow, relativeTime, humanDuration, countdown, DOW,
    },
    charts,
    // A snapshot is a file: there is no API to call, and a view must get a
    // plain "no data" rather than an exception it has to catch.
    fetchJson: (path, opt) => (SNAPSHOT ? Promise.resolve(null) : fetchJson(path, opt)),
    schedule: (fn, ms) => {
      const t = setInterval(fn, ms);
      viewTimers[timerPhase].push(t);
      return t;
    },
    rerender: (opt = {}) => {
      if (opt.recompute !== false) recompute();
      render();
    },
  };
}

/**
 * The object mountPalette(ctx) is given, once, at boot.
 *
 * Unlike viewContext(), nothing here needs to be a getter: the palette only
 * reads `getTabs()` (and nothing else state-shaped) at the moment it opens,
 * never while it is closed, so a stale closure is not a risk.
 *
 * @returns {import('./palette.js').PaletteContext}
 */
function paletteContext() {
  return {
    el,
    getTabs: () => allTabs().map((t) => ({ id: t.id, label: t.label })),
    goToTab,
    ranges: QUICK_RANGES.filter((r) => r.id !== 'custom'),
    applyRange: (id) => applyRange(id),
    skins: SKINS,
    setSkin: (id) => { applyTheme(id, document.documentElement.dataset.mode); savePrefs(); renderShell(); render(); },
    modes: [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }],
    setMode: (id) => { applyTheme(document.documentElement.dataset.skin, id); savePrefs(); renderShell(); render(); },
    canRefresh: () => !SNAPSHOT,
    refresh: () => doRefresh(),
    exportCsv: () => exportMenu(),
    exportHtmlInfo: () => htmlExportInfoModal(),
    clearFilters,
    copyDeepLink,
    activeTabButton: () => /** @type {HTMLElement|null} */ (document.querySelector('#tabs .side-item[aria-current="page"]')),
  };
}

/**
 * Fire onLeave/onEnter when the active tab changes, and drop the timers the
 * departing view owned. Called from render(), so it catches every route into a
 * tab: the tab bar, a deep link, and the KPI tiles that jump between views.
 */
function enterTab(ctx) {
  if (enteredTab === S.tab) return;
  const prev = enteredTab === null ? null : viewModule(enteredTab);
  if (prev && typeof prev.onLeave === 'function') {
    try { prev.onLeave(ctx); } catch (err) { console.error(err); }
  }
  clearViewTimers('enter');
  clearViewTimers('render');
  enteredTab = S.tab;
  const next = viewModule(S.tab);
  if (next && typeof next.onEnter === 'function') {
    timerPhase = 'enter';
    try { next.onEnter(ctx); } catch (err) { console.error(err); }
    timerPhase = 'render';
  }
}

// ============================================================ bootstrapping ==

boot().catch((err) => {
  document.getElementById('view').appendChild(
    el('div', { class: 'banner' }, [el('span', { text: 'Could not start: ' + err.message })]),
  );
  console.error(err);
});

async function boot() {
  // Before the bundle fetch, so each view's stylesheet loads in parallel with
  // the data and is applied by the time anything paints.
  injectViewStyles();
  injectOwnStyles();
  const prefs = loadPrefs();
  initSidebar(prefs);
  S.bundle = SNAPSHOT ? window.__TOKENFLOW_BUNDLE__ : await fetchJson('/api/bundle');
  // Every daily chart overlays annotations from this module-level list, not
  // from S.bundle directly, so a marker must not wait for someone to visit
  // the Annotations tab before it appears anywhere else.
  charts.setAnnotations(S.bundle.annotations || []);
  // Config supplies the default look; a choice made in the browser wins.
  applyTheme(
    prefs.skin || S.bundle.meta?.skin || SKINS[0].id,
    prefs.mode || (prefs.theme === 'light' ? 'light' : null) || S.bundle.meta?.mode || 'dark',
  );
  if (prefs.filters) S.filters = { ...S.filters, ...prefs.filters };
  S.rangeId = prefs.rangeId || S.bundle.meta.defaultRange || 'all';
  if (prefs.granularity) S.granularity = prefs.granularity;
  if (prefs.tab) S.tab = prefs.tab;
  // Deep links: #tab=receipts&skin=terminal&mode=light. A link wins over a
  // remembered preference for this load only; nothing is persisted from it.
  const link = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (link.get('tab') && allTabs().some((t) => t.id === link.get('tab'))) S.tab = link.get('tab');
  if (link.get('skin') || link.get('mode')) {
    applyTheme(
      SKINS.some((s) => s.id === link.get('skin')) ? link.get('skin') : document.documentElement.dataset.skin,
      ['dark', 'light'].includes(link.get('mode')) ? link.get('mode') : document.documentElement.dataset.mode,
    );
  }
  if (S.bundle.meta?.includeOverlayDefault) S.filters.includeOverlay = true;
  applyRange(S.rangeId, { silent: true });
  recompute();
  // Mounted once: the chip and the Cmd+K/Ctrl+K shortcut both open the same
  // instance for the rest of this page's life.
  palette = mountPalette(paletteContext());
  const chip = document.getElementById('palette-chip');
  if (chip) chip.addEventListener('click', () => palette.open());
  renderShell();
  render();
  // Handed over from a saved snapshot's "Refresh & open live" button. The
  // refresh runs here, same-origin, with this page's own token.
  if (!SNAPSHOT && new URLSearchParams(location.search).get('refresh') === '1') {
    history.replaceState(null, '', location.pathname);
    doRefresh();
  }
  ensureLiveLoop();
  // Never in a snapshot: a saved file has no /api/providers to ask, and
  // nothing new to report since it was written.
  if (!SNAPSHOT) {
    maybeShowFirstRun({
      el,
      appVersion: S.bundle.meta.appVersion,
      sources: S.bundle.meta.sources,
      fetchProviders: () => fetch('/api/providers').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    });
  }
}

// ============================================================ live polling ==

let liveTimer = null;

/**
 * Poll the live snapshot once a minute while the dashboard is open. This is
 * what makes the header pill and the Live tab's watcher strip current without
 * any user action. In a static snapshot there is no server: the loop never
 * starts, and the Live tab renders purely from the bundle.
 *
 * boot() starts it whichever tab is open, so the pill works everywhere and the
 * Live view (now src/ui/views/live.js) does not have to ask for it.
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
 * The dataset's today, which is not the machine's.
 *
 * `meta.today` is `localToday(tz)` in the dataset's configured timezone. A
 * store whose newest record is older than that still ends at its own coverage,
 * so the later of the two is the day every relative range counts back from.
 * Every consumer has to use this one: a preset resolved against UTC now, or
 * against a browser in another zone, is off by a day.
 */
function datasetToday() {
  const cov = S.bundle.meta.coverage;
  return S.bundle.meta.today && S.bundle.meta.today > cov.to ? S.bundle.meta.today : cov.to;
}

/**
 * @param {string} id
 * @param {{silent?:boolean}} [o]
 */
function applyRange(id, { silent } = {}) {
  S.rangeId = id;
  if (id !== 'custom') {
    const cov = S.bundle.meta.coverage;
    const r = resolveRange(id, cov, datasetToday());
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

/**
 * Switch the active tab. The tab bar's own buttons and the command palette's
 * "Go to tab" commands both funnel through here, so a deep link built from
 * one behaves exactly like a deep link built from the other.
 * @param {string} id
 */
function goToTab(id) {
  if (S.tab !== id) S.viewEntered = false; // a view change earns the one entry stagger
  S.tab = id; savePrefs(); renderShell(); render();
  // Keep the URL shareable without adding history entries for every click.
  try { history.replaceState(null, '', `#${currentDeepLinkHash()}`); } catch { /* file:// or a sandboxed frame may refuse; the tab still switched */ }
}

/**
 * The sidebar navigation: every tab, grouped by TAB_GROUPS, with anything the
 * groups do not name under "More views" so a newly registered view always has
 * a place. Also sets the page title in the header to the active view's label.
 */
function renderSidebar() {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  // The old anchors are about to be discarded; syncNavTooltips() at the end
  // of this function detaches their tooltips (and everything else's stale
  // state) before attaching fresh ones, so there is exactly one place that
  // clears sideTooltipDetachers, not two copies of the same loop.
  nav.textContent = '';
  const tabs = allTabs();
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const placed = new Set();
  const group = (/** @type {string} */ title, /** @type {{id:string,label:string}[]} */ items) => {
    if (!items.length) return;
    nav.appendChild(el('div', { class: 'side-group', text: title }));
    for (const t of items) {
      const active = S.tab === t.id;
      const a = el('a', {
        class: 'side-item', href: `#tab=${t.id}`, 'aria-label': t.label, 'data-tab': t.id,
        'aria-current': active ? 'page' : null,
      }, [
        icon(tabIcon(t.id), { size: 16 }),
        el('span', { class: 'side-label', text: t.label }),
      ]);
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        goToTab(t.id);
        if (sideState.drawerOpen) setDrawer(false);
      });
      nav.appendChild(a);
      placed.add(t.id);
    }
  };
  for (const [title, ids] of TAB_GROUPS) group(title, ids.filter((id) => byId.has(id)).map((id) => byId.get(id)));
  group('More views', tabs.filter((t) => !placed.has(t.id)));
  const active = nav.querySelector('.side-item[aria-current="page"]');
  if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  const title = document.getElementById('page-title');
  if (title) title.textContent = byId.get(S.tab)?.label || 'Tokenflow';
  const foot = document.getElementById('side-foot');
  if (foot) foot.textContent = S.bundle?.meta?.appVersion ? `v${S.bundle.meta.appVersion} · local-first` : '';
  syncNavTooltips();
}

/**
 * A nav item's own visible label already says its name in the expanded
 * sidebar, so a hover tooltip repeating it there is noise, not help. The
 * screenshot that caught this showed "Receipts" floating over "Tickets" a
 * row down. The rail is the opposite: .side-label is display:none, and the
 * icon is all there is, which is exactly where the task asked for a tooltip.
 * So tooltips exist on nav items only while collapsed, added and removed from
 * the same persistent anchor nodes as sideState.collapsed flips, rather than
 * attached unconditionally forever.
 *
 * This is the one place sideTooltipDetachers gets cleared, so it is called
 * after every renderSidebar() (the nav was just rebuilt from scratch, and the
 * old anchors' tooltips need detaching too) and, from applySidebarState(),
 * only on the one call where collapsed actually changed.
 */
function syncNavTooltips() {
  for (const detach of sideTooltipDetachers) detach();
  sideTooltipDetachers = [];
  if (!sideState.collapsed) return;
  document.querySelectorAll('#tabs .side-item').forEach((/** @type {HTMLElement} */ a) => {
    const label = a.getAttribute('aria-label');
    if (label) sideTooltipDetachers.push(attachTooltip(a, label));
  });
}

function clampSidebarWidth(/** @type {number} */ w) {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(w)));
}

/** Push sideState into the DOM: the width variable, the collapsed and drawer classes, and the controls' ARIA state. */
function applySidebarState() {
  const app = document.getElementById('app');
  if (!app) return;
  app.style.setProperty('--sidebar-w', `${sideState.collapsed ? SIDEBAR_RAIL_W : sideState.w}px`);
  app.classList.toggle('collapsed', sideState.collapsed);
  app.classList.toggle('drawer-open', sideState.drawerOpen);
  const toggle = document.getElementById('side-toggle');
  if (toggle) {
    const label = sideState.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.setAttribute('aria-expanded', String(!sideState.collapsed));
    toggle.setAttribute('aria-label', label);
    if (sideCollapsedRendered !== sideState.collapsed) {
      sideCollapsedRendered = sideState.collapsed;
      toggle.textContent = '';
      toggle.appendChild(icon(sideState.collapsed ? 'chevron-right' : 'chevron-left', { size: 16 }));
      if (toggleTooltipDetach) toggleTooltipDetach();
      toggleTooltipDetach = attachTooltip(toggle, label);
      syncNavTooltips();
    }
  }
  const rz = document.getElementById('side-resizer');
  if (rz) rz.setAttribute('aria-valuenow', String(sideState.w));
  const scrim = document.getElementById('side-scrim');
  if (scrim) scrim.hidden = !sideState.drawerOpen;
  const opener = document.getElementById('side-open');
  if (opener) opener.setAttribute('aria-expanded', String(sideState.drawerOpen));
}

/** Narrow screens: the sidebar is an off-canvas drawer. Focus moves in on open and back to the trigger on close. */
function setDrawer(/** @type {boolean} */ open) {
  sideState.drawerOpen = open;
  applySidebarState();
  const target = /** @type {HTMLElement|null} */ (document.getElementById(open ? 'palette-chip' : 'side-open'));
  if (target) target.focus();
}

/**
 * Wire the sidebar chrome once: collapse toggle, drawer trigger and scrim,
 * Escape, and the resize handle (pointer capture for 1:1 tracking, arrow keys
 * and Home/End for keyboard users, double-click to reset). Width and collapsed
 * state come from the same prefs blob as skin and tab.
 * @param {any} prefs
 */
function initSidebar(prefs) {
  const saved = prefs && prefs.sidebar;
  if (saved && typeof saved === 'object') {
    if (Number.isFinite(saved.w)) sideState.w = clampSidebarWidth(saved.w);
    sideState.collapsed = saved.collapsed === true;
  }
  applySidebarState();
  const toggle = document.getElementById('side-toggle');
  if (toggle) toggle.addEventListener('click', () => { sideState.collapsed = !sideState.collapsed; applySidebarState(); savePrefs(); });
  // Both controls are icon-only in every state (the hamburger always, the
  // search chip once its shortcut hint is hidden in the rail, see
  // sidebar.css), and neither one's text ever changes, so one attachTooltip
  // call at setup is enough: unlike the toggle, there is nothing to rebuild.
  const search = document.getElementById('palette-chip');
  if (search) {
    search.prepend(icon('search', { size: 16 }));
    attachTooltip(search, 'Search or jump to (⌘K)');
  }
  const opener = document.getElementById('side-open');
  if (opener) {
    opener.appendChild(icon('panel-left', { size: 16 }));
    attachTooltip(opener, 'Open navigation');
    opener.addEventListener('click', () => setDrawer(true));
  }
  const scrim = document.getElementById('side-scrim');
  if (scrim) scrim.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && sideState.drawerOpen) { ev.preventDefault(); setDrawer(false); }
  });
  const rz = document.getElementById('side-resizer');
  if (!rz) return;
  let startX = 0;
  let startW = 0;
  rz.addEventListener('pointerdown', (ev) => {
    if (sideState.collapsed) return;
    startX = ev.clientX;
    startW = sideState.w;
    rz.setPointerCapture(ev.pointerId);
    document.body.classList.add('resizing');
    ev.preventDefault();
  });
  rz.addEventListener('pointermove', (ev) => {
    if (!rz.hasPointerCapture(ev.pointerId)) return;
    sideState.w = clampSidebarWidth(startW + (ev.clientX - startX));
    applySidebarState();
  });
  const end = (/** @type {PointerEvent} */ ev) => {
    if (!rz.hasPointerCapture(ev.pointerId)) return;
    rz.releasePointerCapture(ev.pointerId);
    document.body.classList.remove('resizing');
    savePrefs();
  };
  rz.addEventListener('pointerup', end);
  rz.addEventListener('pointercancel', end);
  rz.addEventListener('dblclick', () => { sideState.w = SIDEBAR_DEFAULT_W; applySidebarState(); savePrefs(); });
  rz.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 48 : 16;
    let w = null;
    if (ev.key === 'ArrowLeft') w = sideState.w - step;
    else if (ev.key === 'ArrowRight') w = sideState.w + step;
    else if (ev.key === 'Home') w = SIDEBAR_MIN_W;
    else if (ev.key === 'End') w = SIDEBAR_MAX_W;
    if (w === null) return;
    ev.preventDefault();
    sideState.w = clampSidebarWidth(w);
    applySidebarState();
    savePrefs();
  });
}

/** The `tab=…&skin=…&mode=…` hash boot() parses back. Shared by goToTab's address-bar update and copyDeepLink, so the two never disagree on shape. */
function currentDeepLinkHash() {
  return new URLSearchParams({
    tab: S.tab,
    skin: document.documentElement.dataset.skin,
    mode: document.documentElement.dataset.mode,
  }).toString();
}

function renderShell() {
  const acts = document.getElementById('header-actions');
  acts.textContent = '';
  if (!SNAPSHOT) {
    acts.appendChild(btn('↻ Refresh data', () => doRefresh(), 'primary', 'refresh-btn'));
  }
  acts.appendChild(btn('Export CSV ▾', (ev) => exportMenu(ev), 'ghost'));
  acts.appendChild(btn('Pricing', () => pricingModal(), 'ghost'));
  acts.appendChild(themePicker());

  renderSidebar();

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
  syncFilterBar();
  const ctx = viewContext();
  enterTab(ctx);
  const host = document.getElementById('view');
  host.textContent = '';
  // Cards stagger in only when the VIEW changes. A filter change re-renders the
  // same view and must feel instant, so it does not re-run the entrance.
  host.classList.toggle('view-enter', S.viewEntered === false);
  S.viewEntered = true;
  const mod = viewModule(S.tab);
  if (mod) {
    clearViewTimers('render');
    // One broken registered view must cost its own tab, not the whole page.
    try {
      host.appendChild(mod.view(ctx));
    } catch (err) {
      console.error(err);
      host.appendChild(el('div', { class: 'banner' }, [
        el('span', { text: `The ${mod.label} tab could not render: ${err.message}` }),
      ]));
    }
    return;
  }
  const fn = {
    overview: viewOverview,
    receipts: viewReceipts,
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
  const stale = staleBuildBar();
  if (stale) box.prepend(stale);
}

/**
 * The bar shown when this page's code is older than the server's.
 *
 * Everything under /src is served `no-store`, so a reload always lands on the
 * current build. A tab that is never reloaded is the gap: the menu bar app's
 * Dashboard button focuses an existing tab rather than reloading it, so a page
 * can keep running last week's modules against today's API for as long as the
 * tab is open. The failure that produces is silent and confusing, because the
 * page looks current and only some parts misbehave.
 *
 * Returns null when there is nothing to say: in a snapshot (no server to
 * differ from), when the server did not stamp a build, and, deliberately, when
 * either side reports the placeholder "dev" so that working from a checkout
 * never nags.
 *
 * @returns {HTMLElement|null}
 */
function staleBuildBar() {
  if (SNAPSHOT) return null;
  const running = S.bundle?.meta?.appVersion || null;
  if (!LOADED_BUILD || !running) return null;
  if (LOADED_BUILD === 'dev' || running === 'dev') return null;
  if (LOADED_BUILD === running) return null;

  const bar = el('div', { class: 'banner warn' }, [
    el('span', { class: 'badge', text: 'UPDATE' }),
    el('span', { text: `This page is running TokenFlow ${LOADED_BUILD}, but ${running} is installed. Reload to pick up the new version.` }),
  ]);
  const reload = el('button', { class: 'btn sm', text: 'Reload' });
  reload.addEventListener('click', () => window.location.reload());
  bar.appendChild(reload);
  return bar;
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

/**
 * The filter bar, mounted on the first render and patched by every one after.
 *
 * Mounted here rather than in boot() because a value list is built from
 * `S.view.facets`, which only exists once recompute() has run. Patched rather
 * than rebuilt because a multi-select value list stays open across its own
 * change: a bar rebuilt on every render would tear the panel out from under
 * the user mid-selection. src/ui/filters.js owns the DOM; this function owns
 * the state, and every command below still ends in recompute() then render().
 */
function syncFilterBar() {
  if (filterBar) { filterBar.update(); return; }
  filterBar = mountFilterBar({
    host: document.getElementById('filters'),
    getFilters: () => S.filters,
    getFacets: () => S.view.facets,
    getDrillDate: () => S.drillDate,
    getToday: () => datasetToday(),
    // `custom` has no computable dates, so the picker has nothing to offer for
    // it; the custom fields on the right of the same panel are that row.
    presets: QUICK_RANGES.filter((r) => r.id !== 'custom'),
    onRange: (v) => {
      S.filters.hourFrom = v.hourFrom;
      S.filters.hourTo = v.hourTo;
      // A preset goes through applyRange, which is the only thing that knows
      // about the configured `defaultFrom` floor and about resolving a range
      // against the dataset's coverage. Re-deriving the dates here would drop
      // the floor and quietly widen "all data".
      if (v.presetId) { applyRange(v.presetId); return; }
      S.filters.from = v.from;
      S.filters.to = v.to;
      S.rangeId = 'custom';
      recompute();
      render();
    },
    setDimension: (key, values) => {
      // An empty list is stored as null, the shape EMPTY_FILTERS and
      // clearFilters both use, so a filter that was emptied does not persist
      // into preferences as a stray [].
      S.filters[key] = values && values.length ? values : null;
      recompute();
      render();
    },
    setScope: (patch) => {
      Object.assign(S.filters, patch);
      recompute();
      render();
    },
    clearWeekdays: () => { S.filters.dows = null; recompute(); render(); },
    clearDrillDate: () => { S.drillDate = null; recompute(); render(); },
    clearAll: clearFilters,
  });
}

/**
 * Reset every filter and the date range to "all". The overlay/activity scope
 * toggles are preserved: they widen or narrow what counts as data, not a
 * filter on it, which is why the old "Clear N filter(s)" button never counted
 * them either.
 *
 * Shared by the bar's own "Clear all" and the command palette's "Clear
 * filters", so the two cannot drift apart.
 */
function clearFilters() {
  S.filters = { ...EMPTY_FILTERS, includeOverlay: S.filters.includeOverlay, includeActivity: S.filters.includeActivity };
  S.drillDate = null;
  applyRange('all');
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
  const story = storyStrip();
  if (story) root.appendChild(story);
  root.appendChild(kpiRow());

  const gran = el('div', { class: 'chips' });
  // Spelled out rather than derived. Appending "ly" to the capitalised key is
  // right for week and month and gives "Dayly" for day, which shipped.
  const GRAIN_LABELS = /** @type {[('day'|'week'|'month'), string][]} */ ([['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]);
  for (const [g, label] of GRAIN_LABELS) {
    const c = el('button', { class: 'chip', text: label, 'aria-pressed': String(S.granularity === g) });
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

/**
 * The three sentences that matter for this slice, before any chart. Each
 * insight already carries its own condition and weight (insights.js); this
 * only picks the top three and sets the numbers in a heavier face so the eye
 * lands on them first. Nothing here is computed.
 */
function storyStrip() {
  const ins = (S.view.insights || []).filter((i) => i.kind !== 'empty' && i.kind !== 'quality');
  if (ins.length < 2) return null;
  const top = [...ins].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 3);
  const strip = el('div', { class: 'story' });
  for (const i of top) {
    const p = el('p', { class: 'story-text' });
    // Numbers, money, ratios and percentages get the figure face; words stay words.
    // A figure is a number with its unit: "4.37M", "97.9%", "2.3×", "30 days", "$12.40", "r = 0.44".
    const re = /((?:\$|[+\-−]|r = )?\d+(?:[.,]\d+)*(?:\s?(?:[KMB](?![a-z])|×|x(?![a-z])|%|days?|hours?|min(?![a-z])))?)/g;
    let last = 0;
    for (const m of i.text.matchAll(re)) {
      if (m.index > last) p.appendChild(document.createTextNode(i.text.slice(last, m.index)));
      p.appendChild(el('strong', { text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < i.text.length) p.appendChild(document.createTextNode(i.text.slice(last)));
    strip.appendChild(el('div', { class: 'story-line ' + (i.kind || '') }, [
      el('span', { class: 'story-ico', text: i.icon || '•', 'aria-hidden': 'true' }),
      p,
    ]));
  }
  return strip;
}

// ================================================================= receipts ==

/**
 * Spend attributed to the unit of work: per repository, per branch. The
 * receipts arrive in the bundle (computed once per refresh on the server, or
 * baked into a snapshot), so this view works offline and never scans records
 * in the browser. It covers the whole store: a receipt is bounded by its
 * branch, not by the date filter, and the view says so.
 */
function viewReceipts() {
  const R = S.bundle.receipts;
  const root = el('div', { class: 'grid' });
  if (!R || !R.repos || !R.repos.length || !(R.totals.cost > 0)) {
    root.appendChild(card('Receipts', 'Spend attributed to a branch, per repository.', emptyCard(
      'No branch-attributed spend yet',
      'Receipts need sessions that recorded a git branch and a priced model. Claude Code and OpenCode sessions do; sessions on a detached HEAD are reported as unattributed.',
    )));
    return root;
  }
  const all = R.repos.flatMap((r) => r.branches.filter((b) => b.cost !== null).map((b) => ({ ...b, repo: r.repo })));
  const costs = all.map((b) => b.cost).sort((a, b) => a - b);
  const median = costs.length ? costs[Math.floor(costs.length / 2)] : null;
  const top = all.length ? all.reduce((a, b) => (b.cost > a.cost ? b : a)) : null;
  const unattributed = R.repos.reduce((a, r) => a + (r.unattributed.cost ?? 0), 0);

  const box = el('div', { class: 'cards' });
  const heroCard = kpi('Attributed to a branch', pct(R.totals.attributedShare, 0), `${usd(R.totals.attributedCost)} of ${usd(R.totals.cost)} estimated`, { hero: true, title: 'Share of estimated spend whose turns ran on a named branch. The rest ran on a detached HEAD or with no branch recorded.' });
  heroCard.classList.add('wide');
  box.appendChild(heroCard);
  box.appendChild(kpi('Branches', int(R.totals.branches), `${int(R.repos.length)} repositor${R.repos.length === 1 ? 'y' : 'ies'}`));
  box.appendChild(kpi('Median branch', median !== null ? usd(median) : '—', 'half of all branches cost less'));
  if (top) box.appendChild(kpi('Most expensive branch', usd(top.cost), `${top.key} · ${top.repo}`, { title: `${top.sessions} sessions · ${top.turns} turns`, onClick: () => receiptDetail(R.repos.find((r) => r.repo === top.repo), top) }));
  box.appendChild(kpi('Unattributed', usd(unattributed), 'detached HEAD or no branch', { title: 'Reported, never guessed: these turns cannot be tied to a unit of work.' }));
  root.appendChild(box);

  root.appendChild(el('div', { class: 'banner info' }, [el('span', {
    text: `Receipts cover the whole store (${int(R.totals.records)} turns, computed ${relativeTime(R.computedAt)}). The date and provider filters above do not apply here: a receipt is bounded by its branch, not by a window. Pull-request joins run from the CLI: tokenflow receipt --repo <path> --gh.`,
  })]));

  for (const repo of R.repos.slice(0, 12)) {
    const maxCost = Math.max(...repo.branches.map((b) => b.cost ?? 0), 0);
    const rows = repo.branches.slice(0, 15);
    const columns = [
      { key: 'key', label: 'Branch', text: true, value: (b) => el('span', { class: 'branch-cell' }, [
        miniBar(maxCost ? (b.cost ?? 0) / maxCost : 0, 'var(--seq-5)'),
        el('span', { class: 'branch-name', text: b.key }),
        b.longLived ? el('span', { class: 'badge', text: 'long-lived', title: 'A branch that lives forever: this is a receipt for a period of work on it, not for one change.' }) : null,
      ]) },
      { key: 'cost', label: 'Spend', value: (b) => (b.cost === null ? null : usd(b.cost)), title: 'Estimated from the price table; unpriced turns excluded' },
      { key: 'contextShare', label: 'Context', value: (b) => (b.contextShare === null ? null : pct(b.contextShare, 0)), title: 'Share of spend that paid to re-send earlier context (cache reads + writes)' },
      { key: 'sessions', label: 'Sessions' },
      { key: 'turns', label: 'Turns' },
      { key: 'subagentShare', label: 'Subagent', value: (b) => (b.subagentTurns ? pct(b.subagentShare, 0) : '0%') },
      { key: 'vsMedian', label: '× median', value: (b) => (b.vsMedian === null ? null : `${b.vsMedian >= 10 ? Math.round(b.vsMedian) : b.vsMedian.toFixed(1)}×`), title: 'This branch against the median priced branch in the same repository' },
    ];
    const tbl = table(columns, rows, { onRowClick: (b) => receiptDetail(repo, b), emptyText: 'No attributed branches in this repository.' });
    const hint = [
      `${usd(repo.cost)} · ${int(repo.branches.length)} branch${repo.branches.length === 1 ? '' : 'es'}`,
      repo.medianBranchCost !== null ? `median ${usd(repo.medianBranchCost)}` : null,
      repo.unattributed.turns ? `unattributed ${usd(repo.unattributed.cost)} across ${int(repo.unattributed.sessions)} session${repo.unattributed.sessions === 1 ? '' : 's'}` : null,
      repo.branches.length > rows.length ? `showing the top ${rows.length}` : null,
    ].filter(Boolean).join(' · ');
    root.appendChild(card(repo.repo, hint, tbl));
  }
  if (R.repos.length > 12) root.appendChild(el('p', { class: 'muted', text: `${R.repos.length - 12} smaller repositories not shown. The CLI lists every one: tokenflow receipt.` }));
  return root;
}

/** One receipt, as a card with a copy-as-PR-comment action. */
function receiptDetail(repo, b) {
  const body = el('div', { class: 'receipt' });
  const head = el('div', { class: 'receipt-head' });
  head.appendChild(el('div', { class: 'receipt-kicker', text: repo ? repo.repo : '' }));
  head.appendChild(el('div', { class: 'receipt-branch' }, [
    document.createTextNode(b.key),
    b.longLived ? el('span', { class: 'badge', style: 'margin-left:8px;vertical-align:middle', text: 'long-lived branch · a period of work, not one change' }) : null,
  ]));
  body.appendChild(head);

  body.appendChild(el('div', { class: 'receipt-total' }, [
    el('span', { class: 'receipt-amount', text: b.cost === null ? '—' : usd(b.cost) }),
    el('span', { class: 'receipt-amount-sub', text: b.cost === null ? 'no priced turns' : 'estimated spend on this branch' }),
  ]));

  if (b.contextShare !== null) {
    const bar = el('div', { class: 'split-bar', role: 'img', 'aria-label': `${pct(b.contextShare, 0)} re-sent context, ${pct(1 - b.contextShare, 0)} fresh work` });
    const ctx = el('i', { class: 'seg ctx', title: 'Context: cache reads and writes — the cost of re-sending the conversation so far' });
    ctx.style.width = `${Math.round(b.contextShare * 1000) / 10}%`;
    const work = el('i', { class: 'seg work', title: 'Work: fresh input and generated output' });
    bar.appendChild(ctx);
    bar.appendChild(work);
    body.appendChild(bar);
    body.appendChild(el('div', { class: 'split-legend' }, [
      el('span', {}, [el('i', { class: 'sw ctx' }), document.createTextNode(` ${pct(b.contextShare, 0)} re-sent context`)]),
      el('span', {}, [el('i', { class: 'sw work' }), document.createTextNode(` ${pct(1 - b.contextShare, 0)} fresh work`)]),
    ]));
  }

  const dl = el('dl', { class: 'kv receipt-kv' });
  const row = (k, v) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); };
  row('Sessions · turns', `${int(b.sessions)} · ${int(b.turns)}${b.subagentTurns ? ` (${pct(b.subagentShare, 0)} subagent)` : ''}`);
  if (b.models.length) row('Models', b.models.slice(0, 3).map((m) => `${m.model} ${pct(m.share, 0)}`).join(', ') + (b.models.length > 3 ? ', …' : ''));
  if (b.vsMedian !== null) row('vs repository median', `${b.vsMedian >= 10 ? Math.round(b.vsMedian) : b.vsMedian.toFixed(1)}×`);
  if (b.maxPrompt !== null) row('Largest prompt', `${compact(b.maxPrompt)} tokens`);
  if (b.first && b.last) row('Window', `${shortDate(b.first.slice(0, 10))} → ${shortDate(b.last.slice(0, 10))}`);
  if (b.unpricedTurns) row('Unpriced turns', `${int(b.unpricedTurns)} (not in the total)`);
  body.appendChild(dl);
  body.appendChild(el('p', { class: 'receipt-foot', text: `Estimated locally from the session logs on this machine with price table ${S.bundle.meta.pricingTableVersion}. No prompt or code content was read. Bounded by branch, not by a pull request — join PRs from the CLI with tokenflow receipt --gh.` }));

  const copy = btn('Copy as PR comment', async () => {
    const md = renderReceiptMarkdown(b, { repo: repo ? repo.repo : undefined, pricingVersion: S.bundle.meta.pricingTableVersion });
    try {
      await navigator.clipboard.writeText(md);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy as PR comment'; }, 1400);
    } catch {
      // The clipboard API needs a secure context or a user gesture the browser accepted; fall back to showing the text.
      openModal('Receipt (markdown)', el('pre', { class: 'mono', text: md }));
    }
  }, 'primary');
  openModal('AI cost receipt', body, [copy]);
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
          width: w, height: 300, fmtX: compact, fmtY: compact,
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
  const i = el('input', { class: 'tf-input', type: 'date', value: value || '' });
  i.addEventListener('change', () => onChange(i.value || null));
  return el('label', { class: 'fld' }, [el('span', { text: label }), i]);
}

// ================================================================= explorer ==

function viewExplorer() {
  const root = el('div', { class: 'grid' });
  root.appendChild(sectionTitle('Raw data explorer'));
  const ex = S.explorer;

  const bar = el('div', { class: 'filters', style: 'padding-top:0' });
  const search = el('input', { class: 'tf-input', type: 'text', placeholder: 'Search model, project, session, branch…', value: ex.search });
  // An explicit width, because .tf-input is `width: 100%` and this input sits
  // in a flex row next to the page controls, where filling the row would push
  // them off it. 280px is what the old min-width rendered as.
  search.style.width = '280px';
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
    charts.setAnnotations(S.bundle.annotations || []);
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

/**
 * "Export HTML snapshot" (command palette). Writing a self-contained offline
 * file is a filesystem operation, and every route this server exposes is
 * read-only or config-writing — there is no `/api/export.html` to call from
 * here. This states the one CLI command that does it, the same way
 * freshnessBar() states `npm start` when no live dashboard answers.
 */
function htmlExportInfoModal() {
  const body = el('div');
  body.appendChild(el('p', { class: 'hint', text: 'This writes one self-contained HTML file: the analytics, the charts and the data bundle, all inlined. It opens later from a file:// URL with no server and no network.' }));
  const row = el('div', { style: 'display:flex;gap:8px;align-items:center' });
  row.appendChild(el('code', { text: 'tokenflow export --html' }));
  const copy = btn('Copy', async () => {
    try { await navigator.clipboard.writeText('tokenflow export --html'); copy.textContent = 'Copied'; } catch { copy.textContent = 'tokenflow export --html'; }
  }, 'ghost sm');
  row.appendChild(copy);
  body.appendChild(row);
  openModal('Export HTML snapshot', body);
}

/** "Copy deep link" (command palette): the current tab, skin and mode, via the same hash shape goToTab() writes to the address bar. */
async function copyDeepLink() {
  // Built from location.href, not location.origin + location.pathname:
  // Chromium (and others) return the literal string "null" for `origin` on a
  // file:// page, which would silently produce a "null/…" link for anyone
  // copying a deep link out of a saved snapshot.
  const u = new URL(location.href);
  u.search = ''; // drop a stale ?refresh=1 from a snapshot's "Refresh & open live" handoff
  u.hash = currentDeepLinkHash();
  const url = u.href;
  let ok = true;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // No Clipboard permission, or an insecure context (file://): the banner
    // still shows the link so it can be copied by hand.
    ok = false;
  }
  const box = document.getElementById('banners');
  const status = el('div', { class: 'banner info' }, [el('span', {
    text: ok ? `Copied: ${url}` : `Could not copy automatically. Deep link: ${url}`,
  })]);
  box.prepend(status);
  setTimeout(() => status.remove(), 9000);
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
      const i = el('input', { class: 'tf-input', type: 'number', step: '0.0001', min: '0', placeholder: ph, value: cur[k] ?? '' });
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
    sidebar: { w: sideState.w, collapsed: sideState.collapsed },
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

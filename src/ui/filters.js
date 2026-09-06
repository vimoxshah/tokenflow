/**
 * The filter bar: two buttons and N chips, and nothing else at rest.
 *
 * What it replaces: 18 always-visible controls sitting between the reader and
 * the data on every one of the 21 views. Seven quick-range chips, two native
 * date inputs, two hour selects, seven native dropdowns, two scope toggles and
 * an "All data" breadcrumb, on every page, ahead of the numbers.
 *
 * The shape comes from the research pass across Linear, Grafana, PostHog,
 * Metabase and Datadog:
 *
 *   - Grafana's time picker is ONE button whose label is the current range,
 *     opening one panel that holds both fast presets and precise custom entry.
 *     That is `createDateRange`, unchanged.
 *   - Linear's filter menu is a trigger that opens a list of dimensions and
 *     then a list of values. That is `createMenu` handing off to
 *     `createListbox`.
 *   - Metabase's documented removal gesture, a small x on the applied filter,
 *     is the chip's x.
 *   - Datadog's always-open facet rail is the one pattern deliberately not
 *     copied. A permanent wall of controls is the defect being fixed.
 *
 * Nothing here owns state. `S.filters`, `S.rangeId` and `S.drillDate` stay in
 * app.js: this module is given readers for them and hands commands back, and
 * every command still ends in recompute() then render(), with render() calling
 * `update()` on the bar.
 *
 * Mounted ONCE, then patched. That is not an optimisation, it is a
 * correctness requirement: a multi-select value list stays open across its own
 * onChange, so a bar that rebuilt itself on every render would destroy the
 * panel the user is still picking values in. update() moves existing chip
 * nodes with appendChild (which relocates rather than clones, so listeners and
 * the popover's anchor survive) and only creates or destroys a chip when the
 * set of active filters actually changes.
 */
import { DIMENSIONS } from '../core/schema.js';
import { compact, longDate, DOW } from '../core/units.js';
import { icon, createPopover, createListbox, createMenu, createDateRange } from './components/index.js';
// Not from components/index.js, which publishes the six constructors only.
// `selectionLabel` is the exact function the listbox trigger uses to write its
// own text; computing the chip's accessible name from a second, similar
// function is how a label starts describing a filter that is not applied.
import { selectionLabel } from './components/listbox.js';

/**
 * Every dimension that can carry a filter, in the order chips appear.
 *
 * Straight from `src/core/schema.js`, whose comment already called this "the
 * dimensions the cube and the filter bar share". One list, so a new cube
 * dimension cannot appear in the data and be missing from the bar.
 */
export const CHIP_DIMENSIONS = DIMENSIONS;

/**
 * The dimensions the "+ Filter" menu offers, which is the seven the old wall
 * of dropdowns offered.
 *
 * `model_family` and `repository` are absent on purpose: they are drill-in
 * dimensions, set by clicking a share chart or a table row, not things a
 * person goes looking for in a menu. They still render as full, editable chips
 * when a drill sets them, which the old breadcrumb line never did.
 */
export const MENU_DIMENSIONS = DIMENSIONS.filter((d) => d.key !== 'model_family' && d.key !== 'repository');

/** @type {Record<string,{key:string,label:string,cube:string}>} */
const DIM_BY_KEY = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

/** The label shown for a facet value that is the empty string. */
const NO_VALUE_LABEL = '(none)';

/**
 * @typedef {{value:string, label:string, hint?:string}} ValueItem
 * @typedef {{kind:'dimension'|'weekday'|'day', key:string, label:string, values:string[], text:string|null}} ChipSpec
 */

/**
 * One dimension's facet list, as listbox items.
 *
 * The total travels in `hint`, which is what keeps the old dropdown's most
 * useful column: it tells the reader which values are worth picking. It is
 * also searchable, because `filterItems` matches the hint as well as the
 * label, which costs nothing here and helps for a model whose identifier is
 * the thing a person types.
 *
 * @param {Record<string,{value:string,total?:number}[]>|null|undefined} facets `S.view.facets`
 * @param {string} key a dimension key
 * @returns {ValueItem[]}
 */
export function facetItems(facets, key) {
  const list = facets && Array.isArray(facets[key]) ? facets[key] : [];
  return list.map((o) => {
    const value = String(o.value ?? '');
    /** @type {ValueItem} */
    const item = { value, label: value || NO_VALUE_LABEL };
    if (Number.isFinite(o.total)) item.hint = compact(o.total);
    return item;
  });
}

/**
 * A chip's full text: the dimension name, then what is selected.
 *
 * Zero values reads as the bare dimension name, which is the state of a chip
 * opened from the menu before anything is ticked. One value names it. Several
 * name the first and count the rest, which is `selectionLabel`'s format and
 * therefore exactly what the trigger will render.
 *
 * @param {string} dimLabel
 * @param {ValueItem[]} items
 * @param {string[]|null} value
 * @returns {string}
 */
export function chipText(dimLabel, items, value) {
  const selected = selectionLabel(items, Array.isArray(value) ? value : [], '');
  return selected ? `${dimLabel}: ${selected}` : dimLabel;
}

/**
 * The weekday chip's text. `dows` are 0=Mon..6=Sun, the cube's own encoding.
 *
 * @param {number[]|null} dows
 * @returns {string}
 */
export function weekdayText(dows) {
  const list = Array.isArray(dows) ? dows : [];
  if (list.length === 0) return 'Weekday';
  if (list.length === 1) return `Weekday: ${DOW[list[0]] ?? list[0]}`;
  return `Weekday: ${DOW[list[0]] ?? list[0]} +${list.length - 1}`;
}

/**
 * The chips a given filter state produces, in a fixed order.
 *
 * The date range and the hour bounds are deliberately absent: they live on the
 * date button, whose label already states them, and saying it twice is the
 * clutter this bar exists to remove.
 *
 * `text` is null for a dimension chip because the listbox trigger writes its
 * own text from the live facet list; a precomputed string here would be a
 * second source for the same sentence. Static chips have no trigger, so they
 * carry theirs.
 *
 * @param {Record<string,any>} filters `S.filters`
 * @param {string|null} [drillDate] `S.drillDate`
 * @returns {ChipSpec[]}
 */
export function activeChips(filters, drillDate = null) {
  const f = filters || {};
  /** @type {ChipSpec[]} */
  const out = [];
  for (const d of CHIP_DIMENSIONS) {
    const v = f[d.key];
    if (Array.isArray(v) && v.length) {
      out.push({ kind: 'dimension', key: d.key, label: d.label, values: v.map(String), text: null });
    }
  }
  if (Array.isArray(f.dows) && f.dows.length) {
    out.push({
      kind: 'weekday', key: 'dows', label: 'Weekday', values: f.dows.map(String), text: weekdayText(f.dows),
    });
  }
  if (drillDate) {
    out.push({
      kind: 'day', key: 'day', label: 'Day', values: [drillDate], text: `Day: ${longDate(drillDate)}`,
    });
  }
  return out;
}

/**
 * How many filters are on, which is what decides whether "Clear all" exists
 * and what its accessible name says.
 *
 * One filter, one unit: a dimension with four values selected still counts
 * once, because clearing it is one gesture.
 *
 * @param {Record<string,any>} filters
 * @param {string|null} [drillDate]
 * @returns {number}
 */
export function activeFilterCount(filters, drillDate = null) {
  const f = filters || {};
  let n = activeChips(f, drillDate).length;
  // The hour window has no chip, so add it here. `Number.isInteger` is the
  // same test `formatHoursLabel` uses to decide whether the date button shows
  // an hours suffix, which is what keeps the count and the button agreeing.
  if (Number.isInteger(f.hourFrom) || Number.isInteger(f.hourTo)) n++;
  return n;
}

/**
 * Whether the scope differs from the base the analytics layer assumes:
 * gateway overlay excluded (it double-counts tokens) and activity-only
 * records included (they add no tokens, only activity).
 *
 * @param {Record<string,any>} filters
 * @returns {number} 0, 1 or 2
 */
export function scopeChangeCount(filters) {
  const f = filters || {};
  return (f.includeOverlay ? 1 : 0) + (f.includeActivity === false ? 1 : 0);
}

/** The two scope toggles, in the order they are shown. */
const SCOPE_ROWS = [
  {
    key: 'includeOverlay',
    label: 'Include gateway overlay',
    note: 'Proxy/gateway logs describe traffic already counted by the client adapter. Including them double-counts tokens, but exposes measured cost.',
  },
  {
    key: 'includeActivity',
    label: 'Include activity-only',
    note: 'Records from sources that report no token counts (Cline sessions, IDE edits, commits). They never add tokens, only activity.',
  },
];

/**
 * @typedef {object} FilterBarApi
 * @property {()=>void} update re-read state and patch the bar
 * @property {()=>void} destroy
 */

/**
 * Mount the bar into `host`, once.
 *
 * The readers are getters rather than values because the bar outlives every
 * render: it must read `S` at the moment it paints, never a snapshot taken at
 * boot.
 *
 * @param {{host:HTMLElement,
 *          getFilters:()=>Record<string,any>,
 *          getFacets:()=>Record<string,any>,
 *          getDrillDate:()=>string|null,
 *          getToday:()=>string,
 *          presets:{id:string,label:string}[],
 *          onRange:(v:{from:string|null,to:string|null,hourFrom:number|null,hourTo:number|null,presetId:string|null})=>void,
 *          setDimension:(key:string, values:string[]|null)=>void,
 *          setScope:(patch:Record<string,boolean>)=>void,
 *          clearWeekdays:()=>void,
 *          clearDrillDate:()=>void,
 *          clearAll:()=>void}} args
 * @returns {FilterBarApi}
 */
export function mountFilterBar({
  host,
  getFilters,
  getFacets,
  getDrillDate,
  getToday,
  presets,
  onRange,
  setDimension,
  setScope,
  clearWeekdays,
  clearDrillDate,
  clearAll,
}) {
  const bar = document.createElement('div');
  bar.className = 'tf-filterbar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filters');

  const lead = document.createElement('div');
  lead.className = 'tf-filterbar-lead';
  const end = document.createElement('div');
  end.className = 'tf-filterbar-end';
  bar.append(lead, end);

  // ---- the date range button, leftmost, label first
  /** @type {import('./components/daterange.js').DateRangeApi|null} */
  let dateApi = null;
  let dateToday = null;
  const dateSlot = document.createElement('span');
  dateSlot.className = 'tf-filterbar-date';
  lead.appendChild(dateSlot);

  function buildDate() {
    const f = getFilters();
    dateToday = getToday();
    dateApi = createDateRange({
      from: f.from, to: f.to, hourFrom: f.hourFrom, hourTo: f.hourTo,
      presets,
      // Never the primitive's default, which is UTC today off the machine
      // clock. The dashboard's today is the dataset's own, in the configured
      // timezone, and a preset resolved against the wrong one is off by a day.
      today: dateToday,
      onChange: (v) => onRange(v),
    });
    dateSlot.appendChild(dateApi.el);
  }
  buildDate();

  // ---- "+ Filter": pick a dimension, then pick its values
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tf-trigger tf-filter-add';
  addBtn.append(icon('plus', { size: 14, className: 'tf-trigger-icon' }));
  const addText = document.createElement('span');
  addText.className = 'tf-trigger-text';
  addText.textContent = 'Filter';
  addBtn.appendChild(addText);
  lead.appendChild(addBtn);

  // No search field on this list on purpose. Seven labelled rows are all
  // visible at once, which is under the threshold `createListbox` uses to
  // decide a search box is worth its space; a search box over seven visible
  // words is the same clutter one level down.
  const addMenu = createMenu({
    trigger: addBtn,
    placement: 'bottom-start',
    label: 'Add a filter',
    className: 'tf-filter-menu',
    items: MENU_DIMENSIONS.map((d) => ({
      label: d.label,
      onSelect: () => openDimension(d.key),
    })),
  });

  // ---- the chips
  const chipsHost = document.createElement('div');
  chipsHost.className = 'tf-chips';
  lead.appendChild(chipsHost);

  /**
   * @typedef {object} ChipRecord
   * @property {ChipSpec} spec
   * @property {HTMLElement} wrap
   * @property {HTMLElement} body the chip's own trigger, or a static span
   * @property {HTMLElement} keyEl
   * @property {HTMLButtonElement} xBtn
   * @property {import('./components/listbox.js').ListboxApi|null} api
   * @property {MutationObserver|null} watcher
   * @property {boolean} dead
   * @property {string} [itemsKey] signature of the facet list last handed over
   * @property {string} [valueKey] signature of the selection last handed over
   */
  /** @type {Map<string,ChipRecord>} */
  const records = new Map();

  /** @param {ChipRecord} rec */
  const isOpen = (rec) => !!rec.api && rec.body.getAttribute('aria-expanded') === 'true';

  // ---- "Clear all", present only when there is something to clear
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'tf-btn tf-filter-clear';
  clearBtn.textContent = 'Clear all';
  clearBtn.addEventListener('click', () => {
    clearAll();
    // The button removes itself, so the keyboard needs somewhere to carry on
    // from. The trigger that starts the whole flow is the honest landing spot.
    addBtn.focus();
  });
  lead.appendChild(clearBtn);

  // ---- scope, quiet, at the right end. Not a filter in the same sense: it
  // widens or narrows what counts as data at all, so it must not compete with
  // the chips for attention.
  const scopeBtn = document.createElement('button');
  scopeBtn.type = 'button';
  scopeBtn.className = 'tf-trigger tf-scope-trigger';
  const scopeText = document.createElement('span');
  scopeText.className = 'tf-trigger-text';
  scopeText.textContent = 'Scope';
  const scopeCount = document.createElement('span');
  scopeCount.className = 'tf-scope-count';
  scopeBtn.append(scopeText, scopeCount, icon('chevron-down', { size: 14, className: 'tf-trigger-caret' }));
  scopeBtn.setAttribute('aria-haspopup', 'dialog');
  scopeBtn.setAttribute('aria-expanded', 'false');
  end.appendChild(scopeBtn);

  const scopePop = createPopover({
    trigger: scopeBtn,
    placement: 'bottom-end',
    className: 'tf-scope-popover',
    render: renderScope,
  });
  scopeBtn.addEventListener('click', () => scopePop.toggle());
  // Attached once, to the panel, NOT inside render(): render runs on every
  // open and would stack one listener per open. Escape is createPopover's job;
  // this is the Tab that would otherwise walk out of the document and leave
  // the panel open behind it, the same rule listbox, menu and daterange follow.
  scopePop.el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') scopePop.close('escape');
  });

  /** @param {HTMLElement} body */
  function renderScope(body) {
    const f = getFilters();
    const panel = document.createElement('div');
    panel.className = 'tf-scope';
    // A dialog, because that is what the trigger's aria-haspopup promises and
    // what createDateRange's panel already declares. Two switches is a small
    // dialog, but a trigger that announces one thing and opens another is the
    // defect this whole bar exists to remove.
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Scope');
    for (const row of SCOPE_ROWS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tf-scope-row';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', f[row.key] ? 'true' : 'false');
      const mark = document.createElement('span');
      mark.className = 'tf-scope-mark';
      if (f[row.key]) mark.appendChild(icon('check', { size: 14 }));
      const copy = document.createElement('span');
      copy.className = 'tf-scope-copy';
      const title = document.createElement('span');
      title.className = 'tf-scope-title';
      title.textContent = row.label;
      const note = document.createElement('span');
      note.className = 'tf-scope-note';
      note.textContent = row.note;
      copy.append(title, note);
      btn.append(mark, copy);
      btn.addEventListener('click', () => {
        // Read the switch's own state, not a value captured when the panel
        // opened: the panel stays open across the render this triggers, so a
        // second click has to see the result of the first.
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', next ? 'true' : 'false');
        mark.replaceChildren();
        if (next) mark.appendChild(icon('check', { size: 14 }));
        setScope({ [row.key]: next });
      });
      panel.appendChild(btn);
    }
    body.appendChild(panel);
  }

  // ============================================================== the chips ==

  /**
   * @param {ChipSpec} spec
   * @returns {ChipRecord}
   */
  function createRecord(spec) {
    const wrap = document.createElement('span');
    wrap.className = `tf-chip tf-chip-${spec.kind}`;
    wrap.dataset.filter = spec.key;

    const keyEl = document.createElement('span');
    keyEl.className = 'tf-chip-key';

    /** @type {HTMLElement} */
    let body;
    /** @type {import('./components/listbox.js').ListboxApi|null} */
    let api = null;

    if (spec.kind === 'dimension') {
      api = createListbox({
        // Also the panel's accessible name and its search field's, so it is
        // the dimension name rather than something chip-shaped. When nothing
        // is ticked the trigger falls back to it, which is why `keyEl` hides
        // itself in that state instead of reading "Provider Provider".
        label: spec.label,
        items: facetItems(getFacets(), spec.key),
        value: spec.values.slice(),
        multiple: true,
        className: 'tf-chip-body',
        emptyLabel: 'No matching values',
        onChange: (v) => setDimension(spec.key, /** @type {string[]} */ (v)),
      });
      body = api.el;
      body.insertBefore(keyEl, body.firstChild);
      // The listbox owns `.tf-trigger-text` and rewrites it on every change;
      // it never replaces its children, so a prepended prefix survives.
      api.el.setAttribute('aria-haspopup', 'listbox');
    } else {
      body = document.createElement('span');
      body.className = 'tf-chip-body tf-chip-fixed';
      body.appendChild(keyEl);
    }

    const xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.className = 'tf-chip-x';
    xBtn.appendChild(icon('x', { size: 12 }));
    xBtn.addEventListener('click', () => {
      const held = document.activeElement === xBtn;
      if (spec.kind === 'dimension') setDimension(spec.key, null);
      else if (spec.kind === 'weekday') clearWeekdays();
      else clearDrillDate();
      // This chip is gone by now, so a keyboard user would be standing on a
      // removed node. Hand focus to the control that adds the next filter.
      if (held) addBtn.focus();
    });

    wrap.append(body, xBtn);
    /** @type {ChipRecord} */
    const rec = {
      spec, wrap, body, keyEl, xBtn, api, watcher: null, dead: false, itemsKey: null, valueKey: null,
    };

    if (api) {
      // Two jobs, one signal. `aria-expanded` on the trigger is the popover's
      // own published state, so watching it is the only way the pill and the
      // panel can never disagree about whether the chip is being edited.
      //
      // The second job is the reason it has to be an observer rather than an
      // onClose hook: a chip opened from the "+ Filter" menu has no values
      // yet, so nothing in `S.filters` keeps it alive. It survives while its
      // panel is open, and is reaped the moment that panel closes with
      // nothing ticked, which is also the Escape-out-of-a-new-filter path.
      const watcher = new MutationObserver(() => {
        if (rec.dead) return;
        const open = rec.body.getAttribute('aria-expanded') === 'true';
        rec.wrap.classList.toggle('is-open', open);
        if (open) return;
        const vals = getFilters()[spec.key];
        if (Array.isArray(vals) && vals.length) return;
        destroyRecord(spec.key, { returnFocus: true });
      });
      watcher.observe(body, { attributes: true, attributeFilter: ['aria-expanded'] });
      rec.watcher = watcher;
    }

    records.set(spec.key, rec);
    return rec;
  }

  /**
   * @param {string} key
   * @param {{returnFocus?:boolean}} [opt]
   */
  function destroyRecord(key, { returnFocus = false } = {}) {
    const rec = records.get(key);
    if (!rec) return;
    rec.dead = true;
    records.delete(key);
    if (rec.watcher) rec.watcher.disconnect();
    // Read before the teardown: destroying the trigger moves focus, so asking
    // afterwards would always say no.
    const held = !!(document.activeElement && rec.wrap.contains(document.activeElement));
    if (returnFocus && held) addBtn.focus();
    if (rec.api) rec.api.destroy();
    rec.wrap.remove();
  }

  /**
   * @param {ChipRecord} rec
   * @param {ChipSpec} spec
   */
  function syncRecord(rec, spec) {
    rec.spec = spec;
    if (rec.api) {
      const items = facetItems(getFacets(), spec.key);
      // Both setters re-render the option rows when the panel is open, and
      // update() runs on every render, so handing over an identical list would
      // rebuild every row of an open list three times per tick. The facets are
      // computed from the whole cube and almost never change, so the guard
      // costs one string compare and saves the rebuild.
      const itemsKey = items.map((i) => i.value + '\u0000' + (i.hint || '')).join('\u0001');
      if (itemsKey !== rec.itemsKey) {
        rec.itemsKey = itemsKey;
        rec.api.setItems(items);
      }
      const valueKey = spec.values.join('\u0001');
      if (valueKey !== rec.valueKey) {
        rec.valueKey = valueKey;
        rec.api.setValue(spec.values.slice());
      }
      rec.keyEl.textContent = `${spec.label}:`;
      rec.keyEl.hidden = spec.values.length === 0;
      rec.xBtn.setAttribute('aria-label', `Remove filter ${chipText(spec.label, items, spec.values)}`);
      return;
    }
    const text = spec.text || spec.label;
    rec.keyEl.textContent = text;
    rec.keyEl.hidden = false;
    rec.xBtn.setAttribute('aria-label', `Remove filter ${text}`);
  }

  /**
   * Open a dimension's value list, from the menu or from a chip.
   *
   * A dimension with no values yet gets a chip first: the panel is anchored to
   * a trigger, so the trigger has to exist and be laid out before it opens.
   *
   * @param {string} key
   */
  function openDimension(key) {
    const dim = DIM_BY_KEY[key];
    if (!dim) return;
    let rec = records.get(key);
    if (!rec) {
      const values = getFilters()[key];
      const spec = /** @type {ChipSpec} */ ({
        kind: 'dimension',
        key,
        label: dim.label,
        values: Array.isArray(values) ? values.map(String) : [],
        text: null,
      });
      rec = createRecord(spec);
      syncRecord(rec, spec);
      chipsHost.appendChild(rec.wrap);
    }
    if (rec.api) rec.api.open();
  }

  // ================================================================ update ==

  function update() {
    const filters = getFilters();
    const drillDate = getDrillDate();

    // The dataset's today can move under us on a refresh, and the date
    // primitive takes it once at construction. Rebuild rather than resolve a
    // preset against yesterday.
    if (getToday() !== dateToday) {
      if (dateApi) dateApi.destroy();
      buildDate();
    } else if (dateApi) {
      dateApi.setRange({
        from: filters.from, to: filters.to, hourFrom: filters.hourFrom, hourTo: filters.hourTo,
      });
    }

    const specs = activeChips(filters, drillDate);
    const byKey = new Map(specs.map((s) => [s.key, s]));

    // Drop what is no longer filtered, unless its panel is open: a chip whose
    // last value was just unticked is mid-edit, not finished.
    for (const key of [...records.keys()]) {
      const rec = records.get(key);
      if (byKey.has(key) || (rec && isOpen(rec))) continue;
      destroyRecord(key);
    }

    // Paint in a fixed order. appendChild on a node that is already a child
    // MOVES it, so an open panel keeps its anchor and every listener.
    for (const dim of CHIP_DIMENSIONS) {
      const spec = byKey.get(dim.key) || pendingSpec(dim);
      if (!spec) continue;
      const rec = records.get(dim.key) || createRecord(spec);
      syncRecord(rec, spec);
      chipsHost.appendChild(rec.wrap);
    }
    for (const spec of specs) {
      if (spec.kind === 'dimension') continue;
      const rec = records.get(spec.key) || createRecord(spec);
      syncRecord(rec, spec);
      chipsHost.appendChild(rec.wrap);
    }

    const n = activeFilterCount(filters, drillDate);
    clearBtn.hidden = n === 0;
    clearBtn.setAttribute('aria-label', `Clear all filters (${n} active)`);

    const changed = scopeChangeCount(filters);
    scopeCount.textContent = changed ? String(changed) : '';
    scopeCount.hidden = changed === 0;
    scopeBtn.classList.toggle('is-modified', changed > 0);
    scopeBtn.setAttribute('aria-label', `Scope: ${SCOPE_ROWS
      .map((r) => `${r.label.replace(/^Include /, '')} ${filters[r.key] ? 'included' : 'excluded'}`)
      .join(', ')}`);
  }

  /**
   * The spec for a chip that exists only because its panel is open. Returns
   * null for every dimension that is neither filtered nor being edited.
   *
   * @param {{key:string,label:string}} dim
   * @returns {ChipSpec|null}
   */
  function pendingSpec(dim) {
    const rec = records.get(dim.key);
    if (!rec || !isOpen(rec)) return null;
    return { kind: 'dimension', key: dim.key, label: dim.label, values: [], text: null };
  }

  host.appendChild(bar);
  update();

  return {
    update,
    destroy() {
      for (const key of [...records.keys()]) destroyRecord(key);
      addMenu.destroy();
      scopePop.destroy();
      if (dateApi) dateApi.destroy();
      bar.remove();
    },
  };
}

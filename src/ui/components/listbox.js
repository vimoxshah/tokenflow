/**
 * The select replacement: a trigger button that opens a real listbox.
 *
 * A native `<select>` cannot show a hint column, a check indicator, an icon or
 * a search field, and it cannot be styled by the token system at all, which is
 * why every dropdown in this dashboard looked like a different product. The
 * anatomy here is Radix Select's: `role="listbox"` on the list, `role="option"`
 * with `aria-selected` on each row, `aria-expanded` on the trigger, and a
 * `check` icon as the selected indicator.
 *
 * `filterItems` and `typeaheadMatch` are pure and exported for the tests. The
 * rest needs a browser.
 */
import { icon } from './icons.js';
import { createPopover } from './popover.js';

/** At or above this many items the panel grows a search field. */
const SEARCH_THRESHOLD = 8;

let uid = 0;

/**
 * @typedef {{value:string, label:string, hint?:string, icon?:string}} ListboxItem
 */

/**
 * The items whose label or hint contains `query`, case-insensitively.
 *
 * The hint is searched as well as the label because a hint here carries the
 * identifier a person actually types: the label reads "Sonnet 4.5" and the
 * hint reads "claude-sonnet-4-5". Matching only the label would make the
 * search box refuse the exact string the user copied from a receipt.
 *
 * @param {ListboxItem[]} items
 * @param {string} [query]
 * @returns {ListboxItem[]}
 */
export function filterItems(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list.slice();
  return list.filter((it) => {
    const label = String(it?.label ?? '').toLowerCase();
    const hint = String(it?.hint ?? '').toLowerCase();
    return label.includes(q) || (!!hint && hint.includes(q));
  });
}

/**
 * Typeahead, to the WAI-ARIA listbox pattern.
 *
 * Typing "se" moves to the first item starting with "se", searching forward
 * from the active row and wrapping. Typing the SAME character repeatedly is
 * the documented exception: "aaa" does not look for an item starting with
 * "aaa", it steps through the items starting with "a", one per press, which is
 * how a native select behaves and how a user expects to cycle same-initial
 * options.
 *
 * @param {ListboxItem[]} items
 * @param {string} buffer the characters typed so far
 * @param {number} [fromIndex] the active option index, or -1
 * @returns {number} an index into `items`, or -1 when nothing matches
 */
export function typeaheadMatch(items, buffer, fromIndex = -1) {
  const list = Array.isArray(items) ? items : [];
  const raw = String(buffer ?? '').toLowerCase();
  if (!raw || list.length === 0) return -1;

  const repeated = raw.length > 1 && raw.split('').every((c) => c === raw[0]);
  const term = repeated ? raw[0] : raw;
  const start = fromIndex >= 0 && fromIndex < list.length ? fromIndex : 0;

  // A single-character term always advances past the current row, so pressing
  // "a" twice moves on instead of re-selecting what is already active. A
  // multi-character term keeps the current row eligible, so "s" then "e"
  // refines within "Sessions" rather than jumping off it.
  const skipCurrent = term.length === 1 && fromIndex >= 0;
  for (let step = skipCurrent ? 1 : 0; step < list.length + (skipCurrent ? 1 : 0); step++) {
    const i = (start + step) % list.length;
    if (String(list[i]?.label ?? '').toLowerCase().startsWith(term)) return i;
  }
  return -1;
}

/**
 * The trigger's text for a selection: the label when one thing is chosen, and
 * "<first> +N" when several are, because a trigger that lists every selected
 * model stops being a button and becomes a paragraph.
 *
 * @param {ListboxItem[]} items
 * @param {string|string[]|null} value
 * @param {string} label the placeholder shown when nothing is selected
 * @returns {string}
 */
export function selectionLabel(items, value, label) {
  const list = Array.isArray(items) ? items : [];
  const labelOf = (v) => list.find((it) => it.value === v)?.label ?? v;
  if (Array.isArray(value)) {
    if (value.length === 0) return label;
    if (value.length === 1) return String(labelOf(value[0]));
    return `${labelOf(value[0])} +${value.length - 1}`;
  }
  if (value === null || value === undefined || value === '') return label;
  return String(labelOf(value));
}

/**
 * @typedef {object} ListboxApi
 * @property {HTMLButtonElement} el the trigger, ready to append
 * @property {(items:ListboxItem[])=>void} setItems
 * @property {(value:string|string[]|null)=>void} setValue
 * @property {()=>string|string[]|null} getValue
 * @property {()=>void} open
 * @property {()=>void} close
 * @property {()=>void} destroy
 */

/**
 * Build a listbox.
 *
 * @param {{label:string, items?:ListboxItem[], value?:string|string[]|null,
 *          multiple?:boolean, searchThreshold?:number, emptyLabel?:string,
 *          onChange?:(value:string|string[]|null)=>void, className?:string}} args
 * @returns {ListboxApi}
 */
export function createListbox({
  label,
  items = [],
  value = null,
  multiple = false,
  searchThreshold = SEARCH_THRESHOLD,
  emptyLabel = 'No matches',
  onChange,
  className,
}) {
  const id = ++uid;
  let all = Array.isArray(items) ? items.slice() : [];
  let current = multiple ? (Array.isArray(value) ? value.slice() : []) : (value ?? null);
  let query = '';
  let activeIndex = -1;
  let visible = all.slice();
  let typeBuffer = '';
  let typeTimer = null;

  /** @type {HTMLElement|null} */
  let listEl = null;
  /** @type {HTMLInputElement|null} */
  let searchEl = null;

  const el = document.createElement('button');
  el.type = 'button';
  el.className = `tf-trigger tf-listbox-trigger${className ? ` ${className}` : ''}`;
  el.setAttribute('aria-haspopup', 'listbox');
  el.setAttribute('aria-expanded', 'false');

  const text = document.createElement('span');
  text.className = 'tf-trigger-text';
  const caret = icon('chevron-down', { className: 'tf-trigger-caret' });
  el.append(text, caret);

  const pop = createPopover({
    trigger: el,
    placement: 'bottom-start',
    className: 'tf-listbox-popover',
    matchTriggerWidth: true,
    render: renderPanel,
    onClose: () => { query = ''; activeIndex = -1; listEl = null; searchEl = null; },
  });

  // Once, on the panel itself, NOT on the popover body inside render(). The
  // body element is created once and only refilled per open, so attaching
  // there would add a second listener on the second open and ArrowDown would
  // start moving two rows at a time. Keydown bubbles up from the search input
  // and the list, so one listener here covers both.
  pop.el.addEventListener('keydown', onPanelKeyDown);

  function isSelected(v) {
    return Array.isArray(current) ? current.includes(v) : current === v;
  }

  function syncTrigger() {
    text.textContent = selectionLabel(all, current, label);
    el.classList.toggle('is-empty', selectionLabel(all, current, label) === label);
  }

  function optionId(index) {
    return `tf-listbox-${id}-opt-${index}`;
  }

  function setActive(index, { scroll = true } = {}) {
    if (!listEl) return;
    activeIndex = index;
    const rows = listEl.querySelectorAll('[role="option"]');
    rows.forEach((row, i) => {
      const on = i === index;
      row.classList.toggle('is-active', on);
      if (on && scroll && typeof (/** @type {any} */ (row).scrollIntoView) === 'function') {
        /** @type {any} */ (row).scrollIntoView({ block: 'nearest' });
      }
    });
    const owner = searchEl || listEl;
    if (index >= 0) owner.setAttribute('aria-activedescendant', optionId(index));
    else owner.removeAttribute('aria-activedescendant');
  }

  function commit(v) {
    if (Array.isArray(current)) {
      current = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    } else {
      current = v;
    }
    syncTrigger();
    if (onChange) onChange(getValue());
  }

  function choose(index) {
    const item = visible[index];
    if (!item) return;
    commit(item.value);
    if (multiple) {
      // A multi-select stays open: picking three models should be three
      // clicks, not three round trips through the trigger.
      renderRows();
      setActive(index, { scroll: false });
    } else {
      pop.close('select');
    }
  }

  function moveActive(delta) {
    if (visible.length === 0) return;
    const next = activeIndex < 0
      ? (delta > 0 ? 0 : visible.length - 1)
      : (activeIndex + delta + visible.length) % visible.length;
    setActive(next);
  }

  function onPanelKeyDown(ev) {
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); moveActive(1); return;
      case 'ArrowUp': ev.preventDefault(); moveActive(-1); return;
      case 'Home': ev.preventDefault(); if (visible.length) setActive(0); return;
      case 'End': ev.preventDefault(); if (visible.length) setActive(visible.length - 1); return;
      case 'Enter': ev.preventDefault(); if (activeIndex >= 0) choose(activeIndex); return;
      case ' ':
        // Space is a character while a search field has focus, and a
        // selection everywhere else.
        if (searchEl) return;
        ev.preventDefault();
        if (activeIndex >= 0) choose(activeIndex);
        return;
      case 'Tab':
        pop.close('escape');
        return;
      default: break;
    }
    if (searchEl) return;
    if (ev.key.length !== 1 || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    ev.preventDefault();
    typeBuffer += ev.key;
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(() => { typeBuffer = ''; }, 500);
    const hit = typeaheadMatch(visible, typeBuffer, activeIndex);
    if (hit >= 0) setActive(hit);
  }

  function renderRows() {
    if (!listEl) return;
    visible = filterItems(all, query);
    listEl.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tf-empty';
      empty.textContent = emptyLabel;
      listEl.appendChild(empty);
      setActive(-1);
      return;
    }
    visible.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'tf-option';
      row.id = optionId(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', isSelected(item.value) ? 'true' : 'false');

      const mark = document.createElement('span');
      mark.className = 'tf-option-mark';
      if (isSelected(item.value)) mark.appendChild(icon('check', { size: 14 }));
      row.appendChild(mark);

      if (item.icon) {
        const g = document.createElement('span');
        g.className = 'tf-option-icon';
        g.appendChild(icon(item.icon, { size: 14 }));
        row.appendChild(g);
      }

      const lab = document.createElement('span');
      lab.className = 'tf-option-label';
      lab.textContent = item.label;
      row.appendChild(lab);

      if (item.hint) {
        const h = document.createElement('span');
        h.className = 'tf-option-hint';
        h.textContent = item.hint;
        row.appendChild(h);
      }

      // Hover moves the active row so the mouse and the arrow keys share one
      // notion of "where I am", which is what stops Enter selecting a row the
      // pointer is nowhere near.
      row.addEventListener('pointerenter', () => setActive(i, { scroll: false }));
      row.addEventListener('click', (ev) => { ev.preventDefault(); choose(i); });
      listEl.appendChild(row);
    });
    // There is always an active option once there are rows. Falling back to -1
    // when nothing is selected (most filters, on first open) left the list
    // holding focus with no `.is-active` ground, no ring, and no
    // aria-activedescendant: nothing on screen and nothing to announce. The
    // WAI-ARIA listbox pattern says the first option, so it is the first
    // option. The selected row still wins when there is one.
    const selectedAt = visible.findIndex((it) => isSelected(it.value));
    const fallback = selectedAt >= 0 ? selectedAt : 0;
    setActive(activeIndex >= 0 && activeIndex < visible.length ? activeIndex : fallback);
  }

  function renderPanel(bodyEl) {
    if (all.length >= searchThreshold) {
      const wrap = document.createElement('div');
      wrap.className = 'tf-search';
      wrap.appendChild(icon('search', { size: 14, className: 'tf-search-icon' }));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tf-search-input';
      input.placeholder = 'Search';
      input.setAttribute('aria-label', `Search ${label}`);
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-autocomplete', 'list');
      input.autocomplete = 'off';
      input.value = query;
      input.addEventListener('input', () => {
        query = input.value;
        activeIndex = -1;
        renderRows();
      });
      wrap.appendChild(input);
      bodyEl.appendChild(wrap);
      searchEl = input;
    }

    const list = document.createElement('div');
    list.className = 'tf-listbox';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    if (multiple) list.setAttribute('aria-multiselectable', 'true');
    if (!searchEl) list.tabIndex = -1;
    bodyEl.appendChild(list);
    listEl = list;
    if (searchEl) searchEl.setAttribute('aria-controls', list.id || (list.id = `tf-listbox-${id}-list`));

    renderRows();
    // Focus after the panel is laid out, so the first arrow key already has a
    // measured list to scroll inside.
    requestAnimationFrame(() => {
      if (searchEl) searchEl.focus();
      else if (listEl) /** @type {HTMLElement} */ (listEl).focus();
    });
  }

  function getValue() {
    return Array.isArray(current) ? current.slice() : current;
  }

  el.addEventListener('click', () => pop.toggle());
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      pop.open();
    }
  });
  syncTrigger();

  return {
    el,
    // Replacing the options never touches the value. A selected model that
    // drops out of the list (a narrowed date range, a provider filter) is
    // still what the dashboard is filtering on, and the trigger keeps showing
    // it, so the user can see what to clear. Silently dropping it here would
    // change the filter without firing onChange, which the filter bar could
    // not observe. Use setValue to change the value.
    setItems(next) {
      all = Array.isArray(next) ? next.slice() : [];
      syncTrigger();
      if (pop.isOpen()) renderRows();
    },
    setValue(next) {
      current = multiple ? (Array.isArray(next) ? next.slice() : []) : (next ?? null);
      syncTrigger();
      if (pop.isOpen()) renderRows();
    },
    getValue,
    open: () => pop.open(),
    close: () => pop.close('api'),
    destroy() {
      if (typeTimer) clearTimeout(typeTimer);
      pop.destroy();
      el.remove();
    },
  };
}

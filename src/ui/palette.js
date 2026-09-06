/**
 * Command palette: Cmd+K / Ctrl+K, or the "⌘K" chip at the end of the tab bar.
 *
 * Split in two on purpose. `rankCommands`, `matchRanges`, `groupByCategory`
 * and `paletteSections` are pure — no DOM, no `window`, no `localStorage` —
 * so test/palette.test.js can cover the matching, highlighting and grouping
 * rules with plain node:test. `mountPalette` is the browser half: it builds a
 * native `<dialog>` (free modality, top-layer stacking, and — per the HTML
 * living standard — focus returns to whatever had it when the dialog opened,
 * the moment `close()` runs) and wires up typing, the arrow keys, Enter and
 * Esc.
 *
 * Everything the palette needs to act — the tab list, the quick ranges, the
 * skins, exporting, refreshing — arrives through the `ctx` app.js builds in
 * `mountPalette(ctx)`. palette.js never imports app.js or charts.js, so it
 * stays importable from a plain node:test run with no DOM at all. It does
 * import the icon set (icons.js is DOM-only at the point `icon()` is called,
 * never at module load), which is why the pure exports above stay reachable
 * from node:test: nothing at this module's top level touches `document`.
 */

import { icon, ICON_NAMES } from './components/icons.js';

const RECENT_KEY = 'tokenflow-palette-recent';
const RECENT_MAX = 8;

/**
 * Rank `commands` against `query`, dropping anything that does not match.
 *
 * Four match tiers against the label, best first:
 *   0. the label equals the query exactly
 *   1. the label starts with the query
 *   2. a word inside the label starts with the query ("word-prefix")
 *   3. the query is a subsequence of the label (each character of the query
 *      appears in the label, in order, not necessarily adjacent)
 * A command's optional `keywords` string is an alias, not label prose: it
 * matches only when the query appears as a plain, contiguous SUBSTRING
 * somewhere in it — never a subsequence. Subsequence matching a keyword blob
 * lets the query's characters land in different keywords entirely (`"rec"`
 * finding r in "appearance", e at its end, c starting "colour"), which reads
 * as a broken search: nothing on screen explains the hit, because there is
 * nothing to highlight in a keyword the label never shows. A keyword hit
 * never outranks any label hit, of any tier. Ties (same tier, same position)
 * keep the order `commands` arrived in, so the caller controls what counts as
 * "first" among equals.
 *
 * An empty (or whitespace-only) query skips matching entirely: it returns the
 * commands whose id appears in `recent`, most-recently-used first, then every
 * other command in its original order. An id in `recent` that names no
 * current command is ignored — the caller is not responsible for pruning a
 * stale recent list (a "Refresh data" run before a snapshot load, say).
 *
 * @param {{id:string,label:string,keywords?:string}[]} commands
 * @param {string} [query]
 * @param {string[]} [recent] command ids, most recent first
 * @returns {object[]} the subset of `commands` that match, in rank order
 */
export function rankCommands(commands, query, recent = []) {
  const list = Array.isArray(commands) ? commands : [];
  const q = String(query ?? '').trim().toLowerCase();

  if (!q) {
    const recencyOf = new Map();
    (Array.isArray(recent) ? recent : []).forEach((id, i) => { if (!recencyOf.has(id)) recencyOf.set(id, i); });
    const known = list.filter((c) => recencyOf.has(c.id));
    known.sort((a, b) => recencyOf.get(a.id) - recencyOf.get(b.id));
    const rest = list.filter((c) => !recencyOf.has(c.id));
    return [...known, ...rest];
  }

  const scored = [];
  list.forEach((c, index) => {
    const score = matchScore(c, q);
    if (score !== null) scored.push({ c, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.c);
}

/** Lowest (best) tier score for one command against a lowercased query, or null for no match. */
function matchScore(command, q) {
  const label = String(command.label || '').toLowerCase();
  const keywords = String(command.keywords || '').toLowerCase();
  let best = null;

  if (label) {
    let tier = null;
    if (label === q) tier = 0;
    else if (label.startsWith(q)) tier = 1000;
    else {
      const wp = wordPrefixIndex(label, q);
      if (wp !== -1) tier = 2000 + wp;
      else {
        const sub = subsequenceIndex(label, q);
        if (sub !== -1) tier = 3000 + sub;
      }
    }
    if (tier !== null) best = tier;
  }

  // A keyword is an alias, not prose: a plain substring is enough to count as
  // a hit, and — unlike the label — there is no position worth ranking by,
  // since nothing about a keyword is ever shown or highlighted on screen.
  // Fixed at 4000 regardless of where the substring falls, so it always
  // outranks the worst label tier (3000 + up to label.length) and never
  // outranks the best.
  if (keywords && keywords.indexOf(q) !== -1) {
    const total = 4000;
    if (best === null || total < best) best = total;
  }

  return best;
}

/**
 * Index (in `text`) of the first word that starts with `q`, or -1.
 *
 * A scan, not a split: `text.split(/[^a-z0-9]+/i)` collapses a multi-char
 * separator ("Skin: Aurora" splits on ": ") into a single delimiter, so
 * accumulating `w.length + 1` per word undercounts the offset by however many
 * separator characters ran together and points at the separator instead of
 * the word. Walking `text` and testing "is this the start of a word" at each
 * index sidesteps that: it never has to guess a separator's width.
 */
function wordPrefixIndex(text, q) {
  for (let i = 0; i < text.length; i++) {
    const atWordStart = i === 0 || /[^a-z0-9]/i.test(text[i - 1]);
    if (atWordStart && text.startsWith(q, i)) return i;
  }
  return -1;
}

/** Index of the first character of `text`'s earliest in-order match of every character in `q`, or -1. */
function subsequenceIndex(text, q) {
  let from = 0;
  let first = -1;
  for (let i = 0; i < q.length; i++) {
    const at = text.indexOf(q[i], from);
    if (at === -1) return -1;
    if (first === -1) first = at;
    from = at + 1;
  }
  return first;
}

/**
 * The `[start, end)` ranges within `label` responsible for it matching
 * `query`, for highlighting matched characters as the user types.
 *
 * Mirrors matchScore's own tiers, checked in the same order, but only ever
 * looks at the label: a command that matched on `keywords` alone has nothing
 * in its visible text to underline, so that case returns an empty array
 * rather than a guess.
 *
 * @param {string} label
 * @param {string} [query]
 * @returns {[number, number][]}
 */
export function matchRanges(label, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const text = String(label || '');
  const lower = text.toLowerCase();
  if (!q || !lower) return [];
  if (lower === q) return [[0, text.length]];
  if (lower.startsWith(q)) return [[0, q.length]];
  const wp = wordPrefixIndex(lower, q);
  if (wp !== -1) return [[wp, wp + q.length]];
  /** @type {[number, number][]} */
  const ranges = [];
  let from = 0;
  for (let i = 0; i < q.length; i++) {
    const at = lower.indexOf(q[i], from);
    if (at === -1) return []; // no subsequence in the label itself — a keyword-only match
    ranges.push([at, at + 1]);
    from = at + 1;
  }
  return ranges;
}

/**
 * Group already-ordered `items` under their `group` label, one section per
 * distinct label, in the order each label first appears. An item with no
 * `group` lands under "Other" rather than being dropped.
 *
 * @param {(Record<string, any> & {group?: string})[]} items any command-shaped object; only `group` is read
 * @returns {{heading:string, items:object[]}[]}
 */
export function groupByCategory(items) {
  const order = [];
  const byHeading = new Map();
  items.forEach((c) => {
    const heading = c.group || 'Other';
    if (!byHeading.has(heading)) { byHeading.set(heading, []); order.push(heading); }
    byHeading.get(heading).push(c);
  });
  return order.map((heading) => ({ heading, items: byHeading.get(heading) }));
}

/**
 * `commands` ranked against `query`, then split into headed sections for
 * display.
 *
 * An empty query gets a leading "Recent" section — the caller's own MRU list,
 * already in recency order because rankCommands put recent commands first —
 * followed by every other command grouped under its own category, in the
 * order each category first appears among what's left. A non-empty query
 * never gets a "Recent" section (relevance, not recency, decided the order)
 * and groups the full ranked list the same way, so a category can reorder
 * relative to the others when a better hit lands in it.
 *
 * Pure — same guarantees as rankCommands: no DOM, no storage.
 *
 * @param {{id:string,label:string,group?:string,keywords?:string}[]} commands
 * @param {string} [query]
 * @param {string[]} [recent]
 * @returns {{heading:string, items:object[]}[]}
 */
export function paletteSections(commands, query, recent = []) {
  const items = rankCommands(commands, query, recent);
  const q = String(query ?? '').trim();
  if (q) return groupByCategory(items);

  const recentIds = new Set(Array.isArray(recent) ? recent : []);
  const recentItems = items.filter((c) => recentIds.has(c.id));
  const restItems = items.filter((c) => !recentIds.has(c.id));
  const sections = [];
  if (recentItems.length) sections.push({ heading: 'Recent', items: recentItems });
  sections.push(...groupByCategory(restItems));
  return sections;
}

/** The persisted "recently run" command ids, most recent first. Never throws. */
function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    // Private mode, or a saved snapshot opened from file:// — recent commands
    // simply do not persist between visits.
    return [];
  }
}

function saveRecent(ids) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
  } catch { /* private mode / file:// — see loadRecent() */ }
}

/** Whether `target` is a field a real keystroke could be editing (input, textarea, contenteditable). */
function isEditable(target) {
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!target.isContentEditable;
}

/** Every icon name `icon()` knows about, for the "does this command have a real icon" guard below. */
const ICON_SET = new Set(ICON_NAMES);

/**
 * `icon(name)`, or a neutral fallback glyph if `name` names no known icon.
 *
 * Tab commands ask for `icon(t.id)` directly — every built-in tab id doubles
 * as an icon name, but a *future* registered view is under no such
 * obligation, and a typo'd or simply new id must not throw `icon()`'s own
 * "unknown icon name" error and take the whole palette down with it.
 */
function safeIcon(name, opts) {
  return icon(ICON_SET.has(name) ? name : 'chevron-right', opts);
}

/**
 * `text` split into plain-text and `<mark>` pieces at `ranges` (ascending,
 * non-overlapping `[start, end)` pairs from `matchRanges`), for rendering
 * matched-character highlighting. Returns plain `[text]` when there is
 * nothing to highlight.
 */
function labelNodes(el, text, ranges) {
  if (!ranges.length) return [text];
  const nodes = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(el('mark', { class: 'palette-match' }, [text.slice(start, end)]));
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * @typedef {object} PaletteContext
 * @property {(tag:string, attrs?:object, kids?:any)=>HTMLElement} el
 * @property {()=>{id:string,label:string}[]} getTabs the merged tab list, read at open time.
 * @property {(id:string)=>void} goToTab
 * @property {{id:string,label:string}[]} ranges the quick ranges (no "custom").
 * @property {(id:string)=>void} applyRange
 * @property {{id:string,name:string}[]} skins
 * @property {(id:string)=>void} setSkin
 * @property {{id:string,label:string}[]} modes
 * @property {(id:string)=>void} setMode
 * @property {()=>boolean} canRefresh false in a snapshot: there is nothing to refresh.
 * @property {()=>void} refresh
 * @property {()=>void} exportCsv
 * @property {()=>void} exportHtmlInfo
 * @property {()=>void} clearFilters
 * @property {()=>void} copyDeepLink
 * @property {()=>(HTMLElement|null)} [activeTabButton] a focus fallback if the original target is gone.
 */

/**
 * Mount the command palette once. Returns `{ open, close, isOpen }` so app.js
 * can drive it from the "⌘K" chip as well as the keyboard shortcut.
 *
 * @param {PaletteContext} ctx
 */
export function mountPalette(ctx) {
  const { el } = ctx;
  let recent = loadRecent();
  let allCommands = [];
  let items = [];
  let activeIndex = 0;
  let lastFocused = null;

  const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
  dialog.className = 'palette-dialog';
  dialog.setAttribute('aria-label', 'Command palette');
  dialog.setAttribute('role', 'dialog');

  const input = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text', class: 'palette-input', placeholder: 'Type a command…',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
  }));
  const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const empty = el('div', { class: 'palette-empty', text: 'No matching commands' });
  const footer = el('div', { class: 'palette-footer' }, [
    el('span', { class: 'palette-hint' }, [
      kbdIcon('arrow-up'), kbdIcon('arrow-down'),
      el('span', { class: 'palette-hint-label', text: 'Navigate' }),
    ]),
    el('span', { class: 'palette-hint' }, [
      kbdIcon('corner-down-left'),
      el('span', { class: 'palette-hint-label', text: 'Select' }),
    ]),
    el('span', { class: 'palette-hint' }, [
      kbdText('Esc'),
      el('span', { class: 'palette-hint-label', text: 'Close' }),
    ]),
  ]);

  function kbdIcon(name) {
    return el('kbd', { class: 'palette-kbd' }, [icon(name, { size: 12 })]);
  }
  function kbdText(text) {
    return el('kbd', { class: 'palette-kbd', text });
  }

  dialog.appendChild(input);
  dialog.appendChild(list);
  dialog.appendChild(empty);
  dialog.appendChild(footer);
  document.body.appendChild(dialog);

  /**
   * Every command the palette can run right now, one row anatomy for all of
   * them: an icon, a label, and (only while active) an Enter hint. `group`
   * decides which heading a command sits under on an empty query and when
   * several commands share a rank tier.
   */
  function buildCommands() {
    const cmds = [];
    for (const t of ctx.getTabs()) {
      cmds.push({ id: `tab:${t.id}`, label: t.label, group: 'Views', icon: t.id, keywords: 'tab view', run: () => ctx.goToTab(t.id) });
    }
    for (const r of ctx.ranges) {
      cmds.push({ id: `range:${r.id}`, label: r.label, group: 'Quick range', icon: 'calendar', keywords: 'range date filter', run: () => ctx.applyRange(r.id) });
    }
    for (const s of ctx.skins) {
      cmds.push({ id: `skin:${s.id}`, label: `Skin: ${s.name}`, group: 'Appearance', icon: 'panel-left', keywords: 'theme skin appearance colour color', run: () => ctx.setSkin(s.id) });
    }
    for (const m of ctx.modes) {
      cmds.push({ id: `mode:${m.id}`, label: `Mode: ${m.label}`, group: 'Appearance', icon: m.id === 'dark' ? 'moon' : 'sun', keywords: 'theme mode appearance', run: () => ctx.setMode(m.id) });
    }
    cmds.push({ id: 'export-csv', label: 'Export CSV', group: 'Export', icon: 'download', keywords: 'csv download export', run: () => ctx.exportCsv() });
    cmds.push({ id: 'export-html', label: 'Export HTML snapshot', group: 'Export', icon: 'external-link', keywords: 'html snapshot offline export', run: () => ctx.exportHtmlInfo() });
    if (ctx.canRefresh()) {
      cmds.push({ id: 'refresh', label: 'Refresh data', group: 'Actions', icon: 'refresh', keywords: 'refresh reload rescan', run: () => ctx.refresh() });
    }
    cmds.push({ id: 'clear-filters', label: 'Clear filters', group: 'Actions', icon: 'filter', keywords: 'reset clear filters', run: () => ctx.clearFilters() });
    cmds.push({ id: 'copy-link', label: 'Copy deep link', group: 'Actions', icon: 'external-link', keywords: 'link share url copy', run: () => ctx.copyDeepLink() });
    return cmds;
  }

  /** DOM rows in the same flat order as `items`, so setActive() never has to rebuild the list to move the highlight. */
  let rowEls = [];

  /**
   * Rebuild the list from the current query. Only this touches
   * `list.textContent`, so the arrow keys and a hover never reset scroll
   * position. Renders `paletteSections()`'s groups as a heading followed by
   * its rows; `items` stays the flat, sectioned order so index arithmetic
   * elsewhere (activeIndex, runIndex) never has to know about sections.
   */
  function rebuild() {
    const query = input.value;
    const sections = paletteSections(allCommands, query, recent);
    items = sections.flatMap((s) => s.items);
    list.textContent = '';
    rowEls = [];
    const hasItems = items.length > 0;
    empty.style.display = hasItems ? 'none' : '';
    if (!hasItems) {
      const q = query.trim();
      empty.textContent = q ? `No matches for "${q}"` : 'No commands available';
    }
    activeIndex = hasItems ? Math.min(activeIndex, items.length - 1) : 0;

    let rowIndex = 0;
    sections.forEach((section, si) => {
      const headingId = `palette-grp-${si}`;
      const group = el('div', { class: 'palette-group', role: 'group', 'aria-labelledby': headingId });
      group.appendChild(el('div', { class: 'palette-heading', id: headingId, text: section.heading }));
      section.items.forEach((c) => {
        const i = rowIndex++;
        const row = el('div', {
          class: 'palette-row', role: 'option', id: `palette-opt-${i}`, 'aria-selected': 'false',
        }, [
          el('span', { class: 'palette-row-icon', 'aria-hidden': 'true' }, [safeIcon(c.icon)]),
          el('span', { class: 'palette-row-label' }, labelNodes(el, c.label, matchRanges(c.label, query))),
          el('kbd', { class: 'palette-kbd palette-row-hint', 'aria-hidden': 'true' }, [icon('corner-down-left', { size: 12 })]),
        ]);
        row.addEventListener('mousemove', () => setActive(i));
        row.addEventListener('mousedown', (ev) => { ev.preventDefault(); runIndex(i); });
        group.appendChild(row);
        rowEls.push(row);
      });
      list.appendChild(group);
    });
    setActive(activeIndex);
  }

  /**
   * Move the highlight to row `i`, clamped to the list's bounds. Only toggles
   * classes/attributes on the rows rebuild() already built, and scrolls the
   * new row into view — no transition either way, so the highlight jumps
   * under the arrow keys instead of trailing them.
   */
  function setActive(i) {
    if (!items.length) { input.removeAttribute('aria-activedescendant'); return; }
    activeIndex = Math.max(0, Math.min(i, items.length - 1));
    rowEls.forEach((row, ri) => {
      const on = ri === activeIndex;
      row.classList.toggle('active', on);
      row.setAttribute('aria-selected', String(on));
    });
    input.setAttribute('aria-activedescendant', `palette-opt-${activeIndex}`);
    rowEls[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function remember(id) {
    recent = [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
    saveRecent(recent);
  }

  /**
   * Refocus `target` if it is still in the document and is not `<body>` itself
   * (the palette was opened with nothing focused), else the active navigation
   * item, so focus never lands nowhere after a jump.
   */
  function restoreFocus(target) {
    const usable = target && target !== document.body && document.body.contains(target);
    const t = usable ? target : (ctx.activeTabButton && ctx.activeTabButton());
    if (t && typeof t.focus === 'function') t.focus();
  }

  function runIndex(i) {
    const c = items[i];
    if (!c) return;
    remember(c.id);
    const before = lastFocused;
    closePalette();
    // A command's own action (switching tabs, applying a range) re-renders
    // the page and can detach whatever `before` pointed at, so the fallback
    // in restoreFocus runs AFTER the action, not before it.
    try { c.run(); } finally { restoreFocus(before); }
  }

  function openPalette() {
    if (dialog.open) { input.focus(); return; }
    lastFocused = document.activeElement;
    allCommands = buildCommands();
    input.value = '';
    activeIndex = 0;
    rebuild();
    dialog.showModal();
    input.focus();
  }

  function closePalette() {
    if (!dialog.open) return;
    dialog.close();
  }

  input.addEventListener('input', () => { activeIndex = 0; rebuild(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(activeIndex + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(activeIndex - 1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); runIndex(activeIndex); }
    else if (ev.key === 'Escape') { ev.preventDefault(); const before = lastFocused; closePalette(); restoreFocus(before); }
  });
  // Clicking the backdrop lands a click on the dialog element itself (the
  // backdrop is not part of the interactive tree), never on `input` or `list`.
  dialog.addEventListener('mousedown', (ev) => { if (ev.target === dialog) { const before = lastFocused; closePalette(); restoreFocus(before); } });

  window.addEventListener('keydown', (ev) => {
    const k = ev.key ? ev.key.toLowerCase() : '';
    if (k !== 'k' || (!ev.metaKey && !ev.ctrlKey) || ev.altKey || ev.repeat) return;
    if (dialog.open) {
      ev.preventDefault();
      const before = lastFocused; closePalette(); restoreFocus(before);
      return;
    }
    // Ctrl+K is a real editing shortcut (macOS "kill to end of line") in any
    // other text field on the page — the explorer search, a filter input.
    // Meta+K carries no such meaning anywhere, so it always opens the
    // palette; a bare Ctrl+K only opens it when focus is not already in a
    // field that wants it. The palette's own input can never be `ev.target`
    // here: it is inert while the dialog is closed.
    if (ev.ctrlKey && !ev.metaKey && isEditable(ev.target)) return;
    // A native <dialog> occupies the browser's top layer; opening a second
    // one on top of an already-open one (the shared export/pricing modal)
    // would render underneath it and look broken, so leave it alone.
    if (document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    openPalette();
  });

  return { open: openPalette, close: closePalette, isOpen: () => dialog.open };
}

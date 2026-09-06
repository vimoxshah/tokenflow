/**
 * Command palette: Cmd+K / Ctrl+K, or the "⌘K" chip at the end of the tab bar.
 *
 * Split in two on purpose. `rankCommands` is pure — no DOM, no `window`, no
 * `localStorage` — so test/palette.test.js can cover the matching rules with
 * plain node:test. `mountPalette` is the browser half: it builds a native
 * `<dialog>` (free modality, top-layer stacking, and — per the HTML living
 * standard — focus returns to whatever had it when the dialog opened, the
 * moment `close()` runs) and wires up typing, the arrow keys, Enter and Esc.
 *
 * Everything the palette needs to act — the tab list, the quick ranges, the
 * skins, exporting, refreshing — arrives through the `ctx` app.js builds in
 * `mountPalette(ctx)`. palette.js never imports app.js or charts.js, so it
 * stays importable from a plain node:test run with no DOM at all.
 */

const RECENT_KEY = 'tokenflow-palette-recent';
const RECENT_MAX = 8;

/**
 * Rank `commands` against `query`, dropping anything that does not match.
 *
 * Four match tiers, best first:
 *   0. the label equals the query exactly
 *   1. the label starts with the query
 *   2. a word inside the label starts with the query ("word-prefix")
 *   3. the query is a subsequence of the label (each character of the query
 *      appears in the label, in order, not necessarily adjacent)
 * A command's optional `keywords` string is searched the same way, but a
 * keyword hit never outranks any label hit. Ties (same tier, same position)
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
  const texts = [String(command.label || '').toLowerCase(), String(command.keywords || '').toLowerCase()];
  let best = null;
  texts.forEach((text, hi) => {
    if (!text) return;
    const tierBase = hi * 4000; // any label match outranks every keyword-only match
    let tier = null;
    if (text === q) tier = 0;
    else if (text.startsWith(q)) tier = 1000;
    else {
      const wp = wordPrefixIndex(text, q);
      if (wp !== -1) tier = 2000 + wp;
      else {
        const sub = subsequenceIndex(text, q);
        if (sub !== -1) tier = 3000 + sub;
      }
    }
    if (tier !== null) {
      const total = tierBase + tier;
      if (best === null || total < best) best = total;
    }
  });
  return best;
}

/** Index (in `text`) of the first word that starts with `q`, or -1. */
function wordPrefixIndex(text, q) {
  const words = text.split(/[^a-z0-9]+/i);
  let at = 0;
  for (const w of words) {
    if (w && w.startsWith(q)) return at;
    at += w.length + 1;
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

  dialog.appendChild(input);
  dialog.appendChild(list);
  dialog.appendChild(empty);
  document.body.appendChild(dialog);

  function buildCommands() {
    const cmds = [];
    for (const t of ctx.getTabs()) {
      cmds.push({ id: `tab:${t.id}`, label: t.label, group: 'Go to tab', keywords: 'tab view', run: () => ctx.goToTab(t.id) });
    }
    for (const r of ctx.ranges) {
      cmds.push({ id: `range:${r.id}`, label: r.label, group: 'Quick range', keywords: 'range date filter', run: () => ctx.applyRange(r.id) });
    }
    for (const s of ctx.skins) {
      cmds.push({ id: `skin:${s.id}`, label: `Skin: ${s.name}`, group: 'Appearance', keywords: 'theme skin appearance colour color', run: () => ctx.setSkin(s.id) });
    }
    for (const m of ctx.modes) {
      cmds.push({ id: `mode:${m.id}`, label: `Mode: ${m.label}`, group: 'Appearance', keywords: 'theme mode appearance', run: () => ctx.setMode(m.id) });
    }
    cmds.push({ id: 'export-csv', label: 'Export CSV', group: 'Export', keywords: 'csv download export', run: () => ctx.exportCsv() });
    cmds.push({ id: 'export-html', label: 'Export HTML snapshot', group: 'Export', keywords: 'html snapshot offline export', run: () => ctx.exportHtmlInfo() });
    if (ctx.canRefresh()) {
      cmds.push({ id: 'refresh', label: 'Refresh data', group: 'Actions', keywords: 'refresh reload rescan', run: () => ctx.refresh() });
    }
    cmds.push({ id: 'clear-filters', label: 'Clear filters', group: 'Actions', keywords: 'reset clear filters', run: () => ctx.clearFilters() });
    cmds.push({ id: 'copy-link', label: 'Copy deep link', group: 'Actions', keywords: 'link share url copy', run: () => ctx.copyDeepLink() });
    return cmds;
  }

  /** DOM rows in the same order as `items`, so setActive() never has to rebuild the list to move the highlight. */
  let rowEls = [];

  /** Rebuild the list from the current query. Only this touches `list.textContent`, so the arrow keys and a hover never reset scroll position. */
  function rebuild() {
    items = rankCommands(allCommands, input.value, recent);
    list.textContent = '';
    rowEls = [];
    empty.style.display = items.length ? 'none' : '';
    activeIndex = items.length ? Math.min(activeIndex, items.length - 1) : 0;
    items.forEach((c, i) => {
      const row = el('div', {
        class: 'palette-row', role: 'option', id: `palette-opt-${i}`, 'aria-selected': 'false',
      }, [
        el('span', { class: 'palette-row-label', text: c.label }),
        c.group ? el('span', { class: 'palette-row-group', text: c.group }) : null,
      ]);
      row.addEventListener('mousemove', () => setActive(i));
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); runIndex(i); });
      list.appendChild(row);
      rowEls.push(row);
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

  /** Refocus `target` if it is still in the document, else the active tab button, so focus never lands on `<body>`. */
  function restoreFocus(target) {
    const t = target && document.body.contains(target) ? target : (ctx.activeTabButton && ctx.activeTabButton());
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

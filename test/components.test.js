/**
 * The pure half of the component layer (src/ui/components/).
 *
 * There is no DOM in this runner and no test dependency is allowed, so the
 * logic that decides an outcome is factored out of the render code and covered
 * here: where a panel lands, what a search filters, what a keystroke matches,
 * and what a preset id means as a pair of dates. Anything that needs a real
 * layout (open and close, focus return, light dismiss, tooltip timing) is
 * verified by rendering, and is listed in the handover.
 *
 * The icon test is the one that pays for itself: 45 hand-written path strings
 * is exactly where a typo hides for a year.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { icon, ICON_NAMES, ICON_PATHS } from '../src/ui/components/icons.js';
import { computePlacement } from '../src/ui/components/popover.js';
import { filterItems, typeaheadMatch, selectionLabel } from '../src/ui/components/listbox.js';
import { hasAccessibleName } from '../src/ui/components/tooltip.js';
import { presetRange, matchPreset, formatRangeLabel, formatHoursLabel } from '../src/ui/components/daterange.js';

// ============================================================ importability ==

test('every component module imports with no DOM present', () => {
  // The imports at the top of this file are the assertion: a module that
  // touched `document` or `window` at the top level would have thrown before
  // any test ran. This names the invariant so a future top-level `document`
  // lookup fails with a message that explains itself.
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof computePlacement, 'function');
});

// ===================================================================== icons ==

const REQUIRED_ICONS = [
  'overview', 'receipts', 'tickets', 'cost', 'branches', 'compare', 'anatomy', 'live',
  'productivity', 'rhythm', 'providers', 'models', 'interfaces', 'efficiency', 'cache',
  'time', 'peaks', 'whatif', 'explorer', 'annotations', 'health', 'search', 'calendar',
  'filter', 'plus', 'x', 'check', 'chevron-down', 'chevron-up', 'chevron-right',
  'chevron-left', 'refresh', 'download', 'moon', 'sun', 'panel-left', 'keyboard',
  'corner-down-left', 'arrow-up', 'arrow-down', 'more-horizontal', 'external-link',
  'alert-triangle', 'info', 'clock',
];

test('icons: all 45 required names are present', () => {
  assert.equal(REQUIRED_ICONS.length, 45);
  const missing = REQUIRED_ICONS.filter((n) => !ICON_NAMES.includes(n));
  assert.deepEqual(missing, [], 'every consuming stream depends on each of these');
  assert.equal(ICON_NAMES.length, 45, 'no unnamed extras drifting in');
});

test('icons: ICON_NAMES is frozen, so a caller cannot mutate the set', () => {
  assert.ok(Object.isFrozen(ICON_NAMES));
  assert.throws(() => { /** @type {any} */ (ICON_NAMES).push('nope'); }, TypeError);
});

test('icons: every path is well-formed SVG path data inside the 24x24 box', () => {
  for (const name of ICON_NAMES) {
    const paths = ICON_PATHS[name];
    assert.ok(Array.isArray(paths) && paths.length > 0, `${name} has at least one path`);
    for (const d of paths) {
      assert.equal(typeof d, 'string', `${name}: path is a string`);
      assert.ok(d.length > 1, `${name}: path is not empty`);
      assert.ok(/^[MmLlHhVvCcSsQqTtAaZz]/.test(d), `${name}: path starts with a command, got ${d.slice(0, 8)}`);
      assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/, `${name}: only path commands and numbers, got ${d}`);
      // Two decimal points in one token is the classic typo ("1..5"), and it
      // renders as nothing at all rather than as an error.
      for (const tok of d.split(/[^0-9.]+/)) {
        assert.ok((tok.match(/\./g) || []).length <= 1, `${name}: malformed number "${tok}" in ${d}`);
      }
    }
  }
});

test('icons: near-identical glyphs share one path list rather than wobbling apart', () => {
  assert.deepEqual(ICON_PATHS.time, ICON_PATHS.clock, 'time and clock are the same glyph');
});

test('icons: an unknown name throws and names the bad value', () => {
  // icon() must validate before it touches the DOM. If the name check ran
  // after createElementNS this would fail with "document is not defined" and
  // hide the real mistake behind an environment error.
  assert.throws(() => icon('chevron-dwon'), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /chevron-dwon/, 'the bad value is in the message');
    assert.match(err.message, /unknown icon name/i);
    return true;
  });
  assert.throws(() => icon(undefined), /unknown icon name/);
  assert.throws(() => icon('toString'), /unknown icon name/, 'inherited Object keys are not icons');
});

// ================================================================= placement ==

const VIEWPORT = { width: 1000, height: 800 };
const PANEL = { width: 200, height: 300 };

test('placement: a panel that fits sits under the trigger, start-aligned', () => {
  const at = computePlacement({
    trigger: { x: 100, y: 100, width: 120, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
  });
  assert.deepEqual({ x: at.x, y: at.y }, { x: 100, y: 136 });
  assert.equal(at.placement, 'bottom-start');
  assert.equal(at.origin, 'top left');
});

test('placement: end alignment pins the panel to the trigger right edge', () => {
  const at = computePlacement({
    trigger: { x: 400, y: 100, width: 120, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
    placement: 'bottom-end',
  });
  assert.equal(at.x, 400 + 120 - 200);
  assert.equal(at.origin, 'top right');
});

test('placement: it flips above when there is no room below and more room above', () => {
  const at = computePlacement({
    trigger: { x: 100, y: 600, width: 120, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
  });
  assert.equal(at.placement, 'top-start');
  assert.equal(at.y, 600 - 300 - 6);
  assert.equal(at.origin, 'bottom left', 'the panel grows out of the edge it now sits on');
});

test('placement: it flips below when a top-placed panel has no room above', () => {
  const at = computePlacement({
    trigger: { x: 100, y: 40, width: 120, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
    placement: 'top-start',
  });
  assert.equal(at.placement, 'bottom-start');
  assert.equal(at.y, 40 + 30 + 6);
});

test('placement: when neither side fits, it takes the roomier one and does not hop', () => {
  // A 700px panel in a 500px viewport fits nowhere. The rule is still "flip
  // only if the other side is genuinely roomier", which is what stops a tall
  // list from swapping sides on every open in a short window.
  const tall = { width: 200, height: 700 };
  const viewport = { width: 1000, height: 500 };

  // Trigger at y=200: 262px below, 192px above. Below wins, so it stays put.
  const stays = computePlacement({ trigger: { x: 100, y: 200, width: 120, height: 30 }, panel: tall, viewport });
  assert.equal(stays.placement, 'bottom-start');

  // Trigger at y=300: 162px below, 292px above. Above wins, so it flips.
  const flips = computePlacement({ trigger: { x: 100, y: 300, width: 120, height: 30 }, panel: tall, viewport });
  assert.equal(flips.placement, 'top-start');

  // Either way the panel is pinned inside the viewport, never off the top.
  assert.equal(stays.y, 8);
  assert.equal(flips.y, 8);
});

test('placement: it shifts right when the trigger is against the left edge', () => {
  const at = computePlacement({
    trigger: { x: 2, y: 100, width: 40, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
    placement: 'bottom-end',
  });
  // Un-shifted this would be 2 + 40 - 200 = -158, which is off screen.
  assert.equal(at.x, 8, 'clamped to the viewport margin');
});

test('placement: it shifts left when the trigger is against the right edge', () => {
  const at = computePlacement({
    trigger: { x: 950, y: 100, width: 40, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
  });
  assert.equal(at.x, 1000 - 200 - 8, 'clamped to the far margin');
});

test('placement: flip and shift compose on one open', () => {
  const at = computePlacement({
    trigger: { x: 960, y: 700, width: 40, height: 30 },
    panel: PANEL,
    viewport: VIEWPORT,
  });
  assert.equal(at.placement, 'top-start', 'flipped');
  assert.equal(at.x, 792, 'and shifted');
  assert.equal(at.y, 700 - 300 - 6);
});

test('placement: a panel bigger than the viewport pins to the margin, never off screen', () => {
  const at = computePlacement({
    trigger: { x: 100, y: 100, width: 120, height: 30 },
    panel: { width: 2000, height: 2000 },
    viewport: VIEWPORT,
  });
  assert.equal(at.x, 8);
  assert.equal(at.y, 8);
});

// =================================================================== listbox ==

const ITEMS = [
  { value: 'sonnet', label: 'Sonnet 4.5', hint: 'claude-sonnet-4-5' },
  { value: 'opus', label: 'Opus 4.1', hint: 'claude-opus-4-1' },
  { value: 'haiku', label: 'Haiku 3.5', hint: 'claude-haiku-3-5' },
  { value: 'gpt', label: 'GPT-5', hint: 'gpt-5' },
  { value: 'sonar', label: 'Sonar', hint: 'sonar-pro' },
];

test('filter: an empty or whitespace query returns everything, as a copy', () => {
  assert.equal(filterItems(ITEMS, '').length, ITEMS.length);
  assert.equal(filterItems(ITEMS, '   ').length, ITEMS.length);
  assert.equal(filterItems(ITEMS, undefined).length, ITEMS.length);
  assert.notEqual(filterItems(ITEMS, ''), ITEMS, 'the caller cannot mutate the source list');
});

test('filter: substring match on the label, case-insensitive and not anchored', () => {
  assert.deepEqual(filterItems(ITEMS, 'son').map((i) => i.value), ['sonnet', 'sonar']);
  assert.deepEqual(filterItems(ITEMS, 'SON').map((i) => i.value), ['sonnet', 'sonar']);
  assert.deepEqual(filterItems(ITEMS, 'aiku').map((i) => i.value), ['haiku'], 'matches mid-label');
});

test('filter: the hint matches too, so a model id pasted from a receipt finds its row', () => {
  assert.deepEqual(filterItems(ITEMS, 'claude-opus').map((i) => i.value), ['opus']);
  assert.deepEqual(filterItems(ITEMS, 'sonar-pro').map((i) => i.value), ['sonar']);
});

test('filter: no match returns an empty list, never the whole list', () => {
  assert.deepEqual(filterItems(ITEMS, 'zzzz'), []);
  assert.deepEqual(filterItems(null, 'a'), []);
});

test('typeahead: a multi-character buffer finds the first label with that prefix', () => {
  assert.equal(typeaheadMatch(ITEMS, 'op'), 1);
  assert.equal(typeaheadMatch(ITEMS, 'gp'), 3);
  assert.equal(typeaheadMatch(ITEMS, 'HA'), 2, 'case-insensitive');
});

test('typeahead: it is a prefix match, not a substring one', () => {
  assert.equal(typeaheadMatch(ITEMS, 'aiku'), -1, '"Haiku" contains it but does not start with it');
});

test('typeahead: a repeated character cycles through the same-initial rows', () => {
  // "s" from nowhere lands on Sonnet; pressing "s" again must move on to
  // Sonar rather than re-selecting the row already under the cursor.
  assert.equal(typeaheadMatch(ITEMS, 's', -1), 0);
  assert.equal(typeaheadMatch(ITEMS, 'ss', 0), 4);
  assert.equal(typeaheadMatch(ITEMS, 'sss', 4), 0, 'and wraps back round');
});

test('typeahead: a multi-character buffer refines the current row instead of skipping it', () => {
  // Typing "s" then "o" must stay on Sonnet, not jump to Sonar.
  assert.equal(typeaheadMatch(ITEMS, 'so', 0), 0);
});

test('typeahead: no match and empty input both return -1', () => {
  assert.equal(typeaheadMatch(ITEMS, 'zq'), -1);
  assert.equal(typeaheadMatch(ITEMS, ''), -1);
  assert.equal(typeaheadMatch([], 'a'), -1);
});

test('selection label: the placeholder shows only when nothing is chosen', () => {
  assert.equal(selectionLabel(ITEMS, null, 'All models'), 'All models');
  assert.equal(selectionLabel(ITEMS, [], 'All models'), 'All models');
  assert.equal(selectionLabel(ITEMS, 'opus', 'All models'), 'Opus 4.1');
});

test('selection label: several selected collapse to "<first> +N", never a paragraph', () => {
  assert.equal(selectionLabel(ITEMS, ['sonnet'], 'All models'), 'Sonnet 4.5');
  assert.equal(selectionLabel(ITEMS, ['sonnet', 'opus'], 'All models'), 'Sonnet 4.5 +1');
  assert.equal(selectionLabel(ITEMS, ['sonnet', 'opus', 'gpt'], 'All models'), 'Sonnet 4.5 +2');
});

test('selection label: a value with no matching item falls back to the raw value', () => {
  // A stale filter deep-link must show what it is filtering on, not a blank.
  assert.equal(selectionLabel(ITEMS, 'retired-model', 'All models'), 'retired-model');
});

// =================================================================== tooltip ==

test('tooltip: an element with its own name gets a decorative tooltip, not a second name', () => {
  const fake = (attrs, text = '') => /** @type {any} */ ({
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    textContent: text,
  });
  assert.equal(hasAccessibleName(fake({ 'aria-label': 'Refresh' })), true);
  assert.equal(hasAccessibleName(fake({ 'aria-labelledby': 'x' })), true);
  assert.equal(hasAccessibleName(fake({ title: 'Refresh' })), true);
  assert.equal(hasAccessibleName(fake({}, 'Refresh')), true, 'visible text counts');
  assert.equal(hasAccessibleName(fake({}, '   ')), false, 'whitespace is not a name');
  assert.equal(hasAccessibleName(fake({ 'aria-label': '  ' })), false);
  assert.equal(hasAccessibleName(fake({}, '')), false, 'an icon-only button needs the tooltip as its name');
  assert.equal(hasAccessibleName(null), false);
});

// ================================================================ date range ==

// A "today" that crosses a month boundary, so last7 and lastMonth have to do
// real calendar arithmetic instead of subtracting within one month.
const TODAY = '2026-03-03';

test('presetRange: every required preset id, against a fixed today', () => {
  assert.deepEqual(presetRange('today', TODAY), { from: '2026-03-03', to: '2026-03-03' });
  assert.deepEqual(presetRange('yesterday', TODAY), { from: '2026-03-02', to: '2026-03-02' });
  assert.deepEqual(presetRange('last7', TODAY), { from: '2026-02-25', to: '2026-03-03' });
  assert.deepEqual(presetRange('last30', TODAY), { from: '2026-02-02', to: '2026-03-03' });
  assert.deepEqual(presetRange('last90', TODAY), { from: '2025-12-04', to: '2026-03-03' });
  assert.deepEqual(presetRange('month', TODAY), { from: '2026-03-01', to: '2026-03-03' });
  assert.deepEqual(presetRange('lastMonth', TODAY), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(presetRange('all', TODAY), { from: null, to: null });
});

test('presetRange: "last7" is 7 days inclusive of today, matching the shipped quick range', () => {
  const r = presetRange('last7', TODAY);
  const days = (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86400000 + 1;
  assert.equal(days, 7);
  assert.equal((Date.parse('2026-03-03T00:00:00Z') - Date.parse(`${presetRange('last30', TODAY).from}T00:00:00Z`)) / 86400000 + 1, 30);
  assert.equal((Date.parse('2026-03-03T00:00:00Z') - Date.parse(`${presetRange('last90', TODAY).from}T00:00:00Z`)) / 86400000 + 1, 90);
});

test('presetRange: the shipped QUICK_RANGES ids resolve identically to the new names', () => {
  // The filter bar swaps the old chips for this control. If these two columns
  // ever diverged, every saved range would shift by a day on upgrade.
  for (const [oldId, newId] of [['7d', 'last7'], ['30d', 'last30'], ['90d', 'last90'], ['mtd', 'month'], ['lastmonth', 'lastMonth']]) {
    assert.deepEqual(presetRange(oldId, TODAY), presetRange(newId, TODAY), `${oldId} === ${newId}`);
  }
});

test('presetRange: leap February, year boundaries and a 31-day previous month', () => {
  assert.deepEqual(presetRange('lastMonth', '2024-03-15'), { from: '2024-02-01', to: '2024-02-29' }, 'leap year');
  assert.deepEqual(presetRange('lastMonth', '2026-01-10'), { from: '2025-12-01', to: '2025-12-31' }, 'crosses into last year');
  assert.deepEqual(presetRange('lastMonth', '2026-05-02'), { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(presetRange('yesterday', '2026-01-01'), { from: '2025-12-31', to: '2025-12-31' });
  assert.deepEqual(presetRange('month', '2026-01-01'), { from: '2026-01-01', to: '2026-01-01' });
});

test('presetRange: an unknown id returns null rather than guessing a range', () => {
  assert.equal(presetRange('custom', TODAY), null, '"custom" ships in QUICK_RANGES and has no dates');
  assert.equal(presetRange('last-fortnight', TODAY), null);
  assert.equal(presetRange('', TODAY), null);
});

test('presetRange: UTC only, so the answer does not move with the machine timezone', () => {
  // Parsed as local time, '2026-03-03' is Mar 2 anywhere west of Greenwich and
  // 'today' would silently return the wrong day for most of the Americas.
  assert.deepEqual(presetRange('today', '2026-01-01'), { from: '2026-01-01', to: '2026-01-01' });
  assert.deepEqual(presetRange('today', '2026-12-31'), { from: '2026-12-31', to: '2026-12-31' });
});

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All data' },
  { id: 'custom', label: 'Custom' },
];

test('matchPreset: a range that equals a preset is marked as that preset', () => {
  assert.equal(matchPreset({ from: '2026-02-25', to: '2026-03-03' }, PRESETS, TODAY), 'last7');
  assert.equal(matchPreset({ from: null, to: null }, PRESETS, TODAY), 'all');
  assert.equal(matchPreset({ from: '2026-03-03', to: '2026-03-03' }, PRESETS, TODAY), 'today');
});

test('matchPreset: a genuinely custom range matches nothing, and "custom" is never returned', () => {
  assert.equal(matchPreset({ from: '2026-02-26', to: '2026-03-03' }, PRESETS, TODAY), null);
  assert.equal(matchPreset({ from: '2020-01-01', to: '2020-01-02' }, PRESETS, TODAY), null);
  assert.equal(matchPreset({}, PRESETS, TODAY), 'all', 'an unset range is the unbounded one');
  assert.equal(matchPreset({ from: '2026-03-03', to: '2026-03-03' }, [], TODAY), null);
});

test('range label: the same year is written once', () => {
  assert.equal(formatRangeLabel('2026-07-08', '2026-09-05'), 'Jul 8 to Sep 5, 2026');
  assert.equal(formatRangeLabel('2026-01-01', '2026-12-31'), 'Jan 1 to Dec 31, 2026');
});

test('range label: one day, a year boundary, and no bounds at all', () => {
  assert.equal(formatRangeLabel('2026-09-05', '2026-09-05'), 'Sep 5, 2026');
  assert.equal(formatRangeLabel('2025-12-28', '2026-01-04'), 'Dec 28, 2025 to Jan 4, 2026');
  assert.equal(formatRangeLabel(null, null), 'All time');
});

test('range label: one open bound says so, because it is still a filter', () => {
  // Apply accepts a From with no To. The analytics layer reads the missing
  // bound as the dataset edge, so the dashboard really is filtered, and a
  // button reading "All time" over a filtered dashboard is the exact lie this
  // control exists to remove.
  assert.equal(formatRangeLabel('2026-01-01', null), 'From Jan 1, 2026');
  assert.equal(formatRangeLabel(null, '2026-09-05'), 'Until Sep 5, 2026');
  assert.equal(formatRangeLabel('2025-12-31', null), 'From Dec 31, 2025');
  assert.notEqual(formatRangeLabel('2026-01-01', null), 'All time');
});

test('matchPreset: a half-open range is not the "all" preset', () => {
  // "all" is both bounds open. One bound open is a custom filter, and marking
  // the All data row aria-current would tell the user the opposite.
  assert.equal(matchPreset({ from: '2026-01-01', to: null }, PRESETS, TODAY), null);
  assert.equal(matchPreset({ from: null, to: '2026-01-01' }, PRESETS, TODAY), null);
});

test('hours label: only shown when an hour bound is actually set', () => {
  assert.equal(formatHoursLabel(null, null), '');
  assert.equal(formatHoursLabel(9, 17), '09:00 to 17:00');
  assert.equal(formatHoursLabel(0, 23), '00:00 to 23:00', 'hour 0 is a real bound, not an absent one');
  assert.equal(formatHoursLabel(9, null), 'from 09:00');
  assert.equal(formatHoursLabel(null, 17), 'to 17:00');
});

// ======================================================== the CSS invariants ==

const CSS = fs.readFileSync(new URL('../src/ui/styles/components.css', import.meta.url), 'utf8');

test('css: not one literal colour, so every skin and both modes restyle it for free', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = stripped.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/g) || [];
  assert.deepEqual(literals, [], 'use a role variable from design/tokens.yaml instead');
});

test('css: every interactive component class is in the one focus-visible ring rule', () => {
  const at = CSS.indexOf('outline: 2px solid var(--accent)');
  assert.ok(at > 0, 'the ring rule exists');
  const open = CSS.lastIndexOf('{', at);
  const selectors = CSS.slice(CSS.lastIndexOf('}', open) + 1, open);
  const decls = CSS.slice(open, CSS.indexOf('}', open));
  assert.ok(decls.includes('outline: 2px solid var(--accent)'), 'the ring is the accent role');
  assert.ok(decls.includes('outline-offset: 2px'));
  // A control that can take focus and is missing here has no ring at all.
  for (const sel of ['.tf-trigger', '.tf-btn', '.tf-option', '.tf-menu-item', '.tf-preset', '.tf-input', '.tf-search-input']) {
    assert.ok(selectors.includes(`${sel}:focus-visible`), `${sel} draws the ring`);
  }
});

test('css: nothing kills an outline without a replacement indicator', () => {
  // Only these two may null an outline, and only because they are containers
  // that take focus programmatically, never controls. Anything else appearing
  // here is a control that has silently lost its ring, which is exactly how a
  // listbox came to hold focus with nothing visible on screen.
  const ALLOWED = ['.tf-popover:focus', '.tf-listbox:focus'];
  for (const m of CSS.matchAll(/([^{}]+)\{[^{}]*outline:\s*none[^{}]*\}/g)) {
    // The capture runs back to the previous `}`, so it picks up any comment
    // sitting above the rule. Strip that before reading the selector list.
    const selectorList = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/:focus-visible/.test(selectorList), `outline: none on a :focus-visible selector: ${selectorList}`);
    for (const s of selectorList.split(',').map((x) => x.trim()).filter(Boolean)) {
      assert.ok(ALLOWED.includes(s), `${s} may not remove its focus ring`);
    }
  }
  // The replacement the listbox relies on: the active row must be a real,
  // distinct ground, and it must be a role variable rather than a tint.
  assert.ok(/\.tf-option\.is-active,[\s\S]{0,120}background: var\(--surface-3\)/.test(CSS),
    'the active option has a visible ground standing in for the ring');
  assert.ok(/\.tf-option:hover[\s\S]{0,120}background: var\(--surface-2\)/.test(CSS),
    'and it is distinguishable from mere hover');
});

test('css: reduced motion neutralises the transform on every animated selector', () => {
  const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at > 0, 'the block exists');
  const block = CSS.slice(at);
  // Per rule, not per block: a bare `block.includes(sel)` plus one loose
  // `transform: none` anywhere would pass while the selector it names still
  // animated.
  const rules = new Map();
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = m[2];
    for (const s of m[1].split(',')) {
      const sel = s.trim().replace(/^[\s\S]*\*\//, '').trim();
      if (sel.startsWith('.tf-')) rules.set(sel, decls);
    }
  }
  for (const sel of ['.tf-popover', '.tf-popover.is-open', '.tf-tooltip', '.tf-tooltip.is-open', '.tf-trigger:active', '.tf-btn:active']) {
    const decls = rules.get(sel);
    assert.ok(decls, `${sel} is named in the reduced-motion block`);
    assert.match(decls, /transform: none/, `${sel} still moves under reduced motion`);
  }
  // Nothing in the block may reintroduce travel.
  assert.ok(!/transform:\s*(scale|translate|rotate)/.test(block), 'no transform survives reduced motion');
});

/** The declaration block of the first rule whose selector list starts with `sel`. */
function ruleFor(sel) {
  const at = CSS.indexOf(`\n${sel},`) >= 0 ? CSS.indexOf(`\n${sel},`) : CSS.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} has a rule`);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open, CSS.indexOf('}', open));
}

test('css: numbers use tabular figures wherever they can appear', () => {
  for (const sel of ['.tf-trigger', '.tf-option', '.tf-option-hint', '.tf-input', '.tf-trigger-hours']) {
    assert.ok(ruleFor(sel).includes('font-variant-numeric: tabular-nums'), `${sel} sets tabular figures`);
  }
});

test('css: rows are 32px tall with the specified hover, active and selected roles', () => {
  const at = CSS.indexOf('.tf-option,\n.tf-menu-item,\n.tf-preset {');
  assert.ok(at > 0);
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(rule.includes('min-height: 32px'));
  assert.ok(/\.tf-option:hover[\s\S]{0,120}background: var\(--surface-2\)/.test(CSS), 'hover on surface-2');
  assert.ok(/is-active[\s\S]{0,160}background: var\(--surface-3\)/.test(CSS), 'the active row on surface-3');
  assert.ok(/\.tf-option-mark \{[\s\S]*?color: var\(--accent\)/.test(CSS), 'the selected indicator in accent');
});

test('css: the panel is an opaque surface, so a popover over a popover stays readable', () => {
  const at = CSS.indexOf('.tf-popover {');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(rule.includes('background: var(--surface-1)'));
  assert.ok(rule.includes('border: 1px solid var(--border)'));
  assert.ok(rule.includes('box-shadow: var(--shadow)'));
  assert.ok(rule.includes('border-radius: var(--radius)'));
});

test('css: a closing panel stops taking clicks before it finishes fading', () => {
  // close() drops the dismiss listeners at once, but the element is only
  // hidden 120ms later and opacity 0 is still hit-testable. Without this rule
  // a second click inside that window reaches a row handler and silently
  // changes the selection the user just made.
  assert.match(CSS, /\.tf-popover:not\(\.is-open\)\s*\{[^}]*pointer-events: none/);
});

test('css: every duration and easing comes from the motion tokens', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const times = stripped.match(/(?<![\w-])\d+m?s\b/g) || [];
  assert.deepEqual(times, [], 'use --dur-press, --dur-fast, --dur-base or --dur-slow');
  const eases = stripped.match(/cubic-bezier\(/g) || [];
  assert.deepEqual(eases, [], 'use --ease-out, --ease-in-out or --ease-drawer');
});

// ================================================= the house text conventions ==

test('house style: no em dash or en dash in any component source', () => {
  const files = [
    'icons.js', 'popover.js', 'listbox.js', 'menu.js', 'tooltip.js', 'daterange.js', 'index.js',
  ].map((f) => new URL(`../src/ui/components/${f}`, import.meta.url));
  files.push(new URL('../src/ui/styles/components.css', import.meta.url));
  files.push(new URL('./components.test.js', import.meta.url));
  // The dashes are written as escapes on purpose: a literal glyph here would
  // be a hit in this very file and the test would fail on itself.
  const DASHES = /[\u2013\u2014]/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = src.match(DASHES) || [];
    assert.deepEqual(hits, [], `${f.pathname.split('/').pop()}: use a plain sentence or a comma`);
  }
});

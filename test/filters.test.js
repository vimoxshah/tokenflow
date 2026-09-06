/**
 * The filter bar (src/ui/filters.js).
 *
 * The bar replaced 18 always-visible controls with two buttons and N chips, so
 * the thing worth testing is the mapping: which chips a filter state produces,
 * what each one says, how many filters that counts as, and which facet list a
 * dimension resolves to. All of that is pure and exported, so node:test covers
 * it with no DOM and no test dependency.
 *
 * What needs a real browser, and is verified by rendering instead: the popover
 * anchoring, the keyboard walk through a value list, the MutationObserver that
 * reaps a chip whose panel closed with nothing ticked, and whether any of it
 * looks right.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DIMENSIONS } from '../src/core/schema.js';
import {
  CHIP_DIMENSIONS, MENU_DIMENSIONS, facetItems, chipText, weekdayText,
  activeChips, activeFilterCount, scopeChangeCount,
} from '../src/ui/filters.js';

const EMPTY = {
  from: null, to: null, hourFrom: null, hourTo: null, dows: null,
  provider: null, model: null, model_family: null, client: null,
  interface: null, gateway: null, project: null, repository: null, service_tier: null,
  includeOverlay: false, includeActivity: true,
};

// ============================================================ importability ==

test('the module imports with no DOM present', () => {
  // The import at the top of this file is the assertion: a module that touched
  // `document` at the top level would have thrown before any test ran. The
  // bar's DOM half only runs inside mountFilterBar().
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof activeChips, 'function');
});

// ================================================================ the lists ==

test('chips cover every cube dimension, and the menu offers the seven the old wall did', () => {
  assert.deepEqual(CHIP_DIMENSIONS, DIMENSIONS, 'one list, shared with the cube');
  assert.deepEqual(
    MENU_DIMENSIONS.map((d) => d.label),
    ['Provider', 'Model', 'Client', 'Interface', 'Gateway', 'Project', 'Service tier'],
  );
  // The two that are absent are reachable by drilling from a chart, never from
  // the menu, and both still render as editable chips.
  assert.deepEqual(
    CHIP_DIMENSIONS.filter((d) => !MENU_DIMENSIONS.includes(d)).map((d) => d.key),
    ['model_family', 'repository'],
  );
});

// =================================================== dimension -> value list ==

test('facetItems: a dimension id resolves to its facet list, totals kept as hints', () => {
  const facets = {
    provider: [{ value: 'anthropic', total: 1_200_000 }, { value: 'openai', total: 4300 }],
    gateway: [],
  };
  assert.deepEqual(facetItems(facets, 'provider'), [
    { value: 'anthropic', label: 'anthropic', hint: '1.2M' },
    { value: 'openai', label: 'openai', hint: '4.3K' },
  ]);
  assert.deepEqual(facetItems(facets, 'gateway'), []);
  // A dimension the view did not facet is an empty list, never a crash: the
  // bar renders before a plugin view has had a chance to add anything.
  assert.deepEqual(facetItems(facets, 'service_tier'), []);
  assert.deepEqual(facetItems(null, 'provider'), []);
  assert.deepEqual(facetItems(undefined, 'provider'), []);
});

test('facetItems: an empty value is still selectable, and says so', () => {
  const items = facetItems({ project: [{ value: '', total: 12 }] }, 'project');
  assert.equal(items[0].value, '', 'the filter value stays exactly what the cube holds');
  assert.equal(items[0].label, '(none)', 'a blank row would be unreadable and unclickable');
});

test('facetItems: a facet with no total gets no hint rather than a dash', () => {
  const items = facetItems({ model: [{ value: 'sonnet' }] }, 'model');
  assert.deepEqual(items, [{ value: 'sonnet', label: 'sonnet' }]);
  assert.ok(!('hint' in items[0]));
});

// =============================================================== chip text ==

test('chipText: nothing, one thing, several things', () => {
  const items = [
    { value: 'anthropic', label: 'anthropic' },
    { value: 'openai', label: 'openai' },
    { value: 'google', label: 'google' },
  ];
  assert.equal(chipText('Provider', items, []), 'Provider', 'an empty chip is the dimension alone');
  assert.equal(chipText('Provider', items, null), 'Provider');
  assert.equal(chipText('Provider', items, ['anthropic']), 'Provider: anthropic');
  assert.equal(chipText('Provider', items, ['anthropic', 'openai']), 'Provider: anthropic +1');
  assert.equal(chipText('Provider', items, ['anthropic', 'openai', 'google']), 'Provider: anthropic +2');
});

test('chipText: a selected value missing from the facet list still reads as itself', () => {
  // A narrowed date range can drop a value out of the facets while the filter
  // is still applied. The chip has to keep naming it, or the user cannot see
  // what to clear.
  assert.equal(chipText('Model', [], ['claude-sonnet-4-5']), 'Model: claude-sonnet-4-5');
});

test('chipText: the label is what the listbox trigger renders, not a second opinion', () => {
  // The chip is a listbox trigger with a "Provider:" prefix in front of it, so
  // the text has to come from the same function the trigger uses. This asserts
  // the composition, which is the part that could silently drift.
  const items = [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }];
  assert.equal(chipText('Client', items, ['x', 'y']), 'Client: x +1');
});

test('weekdayText: 0=Mon, and several read like a selection', () => {
  assert.equal(weekdayText(null), 'Weekday');
  assert.equal(weekdayText([]), 'Weekday');
  assert.equal(weekdayText([0]), 'Weekday: Mon');
  assert.equal(weekdayText([6]), 'Weekday: Sun');
  assert.equal(weekdayText([1, 3]), 'Weekday: Tue +1');
});

// =================================================== which chips are on air ==

test('activeChips: no filters, no chips. An empty bar already means all data', () => {
  assert.deepEqual(activeChips(EMPTY), []);
  assert.deepEqual(activeChips({}), []);
  assert.deepEqual(activeChips(null), []);
});

test('activeChips: an empty array is not a filter', () => {
  assert.deepEqual(activeChips({ ...EMPTY, provider: [] }), []);
});

test('activeChips: one chip per filtered dimension, in cube order', () => {
  const chips = activeChips({
    ...EMPTY,
    service_tier: ['batch'],
    provider: ['anthropic'],
    model: ['sonnet', 'opus'],
  });
  assert.deepEqual(chips.map((c) => c.key), ['provider', 'model', 'service_tier']);
  assert.deepEqual(chips.map((c) => c.kind), ['dimension', 'dimension', 'dimension']);
  assert.deepEqual(chips[1].values, ['sonnet', 'opus']);
  assert.equal(chips[0].text, null, 'a dimension chip gets its text from its own trigger');
});

test('activeChips: a drill-only dimension gets a chip too', () => {
  // model_family and repository can only be set by clicking a chart. The old
  // breadcrumb line never showed them, so a click could leave a filter on with
  // nothing on screen able to remove it.
  const chips = activeChips({ ...EMPTY, model_family: ['claude'], repository: ['tokenflow'] });
  assert.deepEqual(chips.map((c) => c.key), ['model_family', 'repository']);
});

test('activeChips: the hour window and the weekday set', () => {
  // The hours live on the date button, whose label already states them, so
  // they get no chip. The weekday set has nowhere else to appear.
  assert.deepEqual(activeChips({ ...EMPTY, hourFrom: 9, hourTo: 17 }), []);
  const chips = activeChips({ ...EMPTY, dows: [1] });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].kind, 'weekday');
  assert.equal(chips[0].text, 'Weekday: Tue');
});

test('activeChips: a drilled day is the last chip and names the date', () => {
  const chips = activeChips({ ...EMPTY, provider: ['anthropic'], dows: [0] }, '2026-09-03');
  assert.deepEqual(chips.map((c) => c.kind), ['dimension', 'weekday', 'day']);
  assert.equal(chips[2].text, 'Day: Sep 3, 2026');
  assert.deepEqual(chips[2].values, ['2026-09-03']);
});

// ============================================================== the counter ==

test('activeFilterCount: nothing on is nothing to clear', () => {
  assert.equal(activeFilterCount(EMPTY), 0);
  assert.equal(activeFilterCount(EMPTY, null), 0);
  // Scope is not a filter. It widens or narrows what counts as data at all,
  // which is why "Clear all" leaves it alone, exactly as the old button did.
  assert.equal(activeFilterCount({ ...EMPTY, includeOverlay: true, includeActivity: false }), 0);
});

test('activeFilterCount: one filter per gesture it takes to clear', () => {
  assert.equal(activeFilterCount({ ...EMPTY, provider: ['anthropic'] }), 1);
  assert.equal(activeFilterCount({ ...EMPTY, provider: ['a', 'b', 'c', 'd'] }), 1, 'four values, one chip, one gesture');
  assert.equal(activeFilterCount({ ...EMPTY, provider: ['a'], model: ['b'] }), 2);
  assert.equal(activeFilterCount({ ...EMPTY, provider: [] }), 0);
});

test('activeFilterCount: the hour window counts, and hour 0 is a real bound', () => {
  assert.equal(activeFilterCount({ ...EMPTY, hourFrom: 9 }), 1);
  assert.equal(activeFilterCount({ ...EMPTY, hourTo: 17 }), 1);
  assert.equal(activeFilterCount({ ...EMPTY, hourFrom: 0 }), 1, 'midnight is a bound, not an absence');
  assert.equal(activeFilterCount({ ...EMPTY, hourFrom: 9, hourTo: 17 }), 1, 'one window, one gesture');
});

test('activeFilterCount: the weekday set counts, so the chip and the button agree', () => {
  // The old counter ignored `dows` entirely: the hour-by-weekday heatmap could
  // set it, no crumb showed it, and no "Clear filters" button appeared. Now it
  // renders a chip, so it has to count as one.
  assert.equal(activeFilterCount({ ...EMPTY, dows: [2] }), 1);
  assert.equal(activeFilterCount({ ...EMPTY, dows: [] }), 0);
});

test('activeFilterCount: a drilled day counts', () => {
  assert.equal(activeFilterCount(EMPTY, '2026-09-03'), 1);
  assert.equal(activeFilterCount({ ...EMPTY, provider: ['a'], hourFrom: 9, dows: [1] }, '2026-09-03'), 4);
});

test('activeFilterCount: the count equals the chips plus the hour window', () => {
  // The invariant the bar leans on: every counted filter is either a chip or
  // the hours on the date button, so "Clear all" can never appear over a bar
  // that shows nothing.
  /** @type {[Record<string,any>, string|null][]} */
  const cases = [
    [EMPTY, null],
    [{ ...EMPTY, provider: ['a'] }, null],
    [{ ...EMPTY, dows: [1], repository: ['r'] }, '2026-01-01'],
    [{ ...EMPTY, hourFrom: 3 }, null],
  ];
  for (const [f, day] of cases) {
    const hours = Number.isInteger(f.hourFrom) || Number.isInteger(f.hourTo) ? 1 : 0;
    assert.equal(activeFilterCount(f, day), activeChips(f, day).length + hours);
  }
});

test('scopeChangeCount: how far the scope is from the base the analytics assume', () => {
  assert.equal(scopeChangeCount(EMPTY), 0);
  assert.equal(scopeChangeCount({ ...EMPTY, includeOverlay: true }), 1);
  assert.equal(scopeChangeCount({ ...EMPTY, includeActivity: false }), 1);
  assert.equal(scopeChangeCount({ ...EMPTY, includeOverlay: true, includeActivity: false }), 2);
  assert.equal(scopeChangeCount({}), 0, 'an absent flag is the base, not a change');
});

// ======================================================== the CSS invariants ==

const CSS = fs.readFileSync(new URL('../src/ui/styles/filters.css', import.meta.url), 'utf8');

test('css: not one literal colour, so every skin and both modes restyle the bar for free', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = stripped.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/g) || [];
  assert.deepEqual(literals, [], 'use a role variable from design/tokens.yaml instead');
});

test('css: no raw duration or easing curve', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(stripped.match(/(?<![\w-])\d+m?s\b/g) || [], [], 'use --dur-press, --dur-fast, --dur-base or --dur-slow');
  assert.deepEqual(stripped.match(/cubic-bezier\(/g) || [], [], 'use --ease-out, --ease-in-out or --ease-drawer');
});

test('css: every control the bar adds draws the one focus ring', () => {
  const at = CSS.indexOf('outline: 2px solid var(--accent)');
  assert.ok(at > 0, 'the ring rule exists');
  const open = CSS.lastIndexOf('{', at);
  const selectors = CSS.slice(CSS.lastIndexOf('}', open) + 1, open);
  const decls = CSS.slice(open, CSS.indexOf('}', open));
  assert.ok(decls.includes('outline-offset'), 'the ring is offset from the control');
  // Every class in this file that can take focus. The chip body and the two
  // buttons are `.tf-trigger`/`.tf-btn` and are already covered by
  // components.css; these are the ones only this file introduces.
  for (const sel of ['.tf-chip-x', '.tf-scope-row']) {
    assert.ok(selectors.includes(`${sel}:focus-visible`), `${sel} draws the ring`);
  }
});

test('css: nothing kills an outline', () => {
  for (const m of CSS.matchAll(/([^{}]+)\{[^{}]*outline:\s*none[^{}]*\}/g)) {
    assert.fail(`outline: none with no replacement indicator: ${m[1].trim()}`);
  }
});

test('css: reduced motion neutralises the transform on every animated selector', () => {
  const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at > 0, 'the block exists');
  const block = CSS.slice(at);
  // Per rule, not per block: one loose `transform: none` anywhere would pass
  // while the selector it names still animated.
  const rules = new Map();
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const s of m[1].split(',')) {
      const sel = s.trim().replace(/^[\s\S]*\*\//, '').trim();
      if (sel) rules.set(sel, (rules.get(sel) || '') + m[2]);
    }
  }
  const stripped = CSS.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*transform:[^{}]*)\}/g)) {
    if (!/transform:\s*(scale|translate|rotate)/.test(m[2])) continue;
    for (const s of m[1].split(',')) {
      const sel = s.trim();
      if (!sel || sel.startsWith('@')) continue;
      const decls = rules.get(sel) || '';
      assert.ok(/transform:\s*none/.test(decls), `${sel} still travels under prefers-reduced-motion`);
    }
  }
});

test('css: [hidden] wins inside the bar, or "Clear all" never leaves', () => {
  // `.tf-btn` and `.tf-trigger` set `display: inline-flex`, and an author
  // display rule beats the UA's `[hidden] { display: none }` however low its
  // specificity. Without this rule the Clear all button and the scope badge
  // would be permanently visible, which is the whole defect in miniature.
  assert.match(CSS, /\.tf-filterbar \[hidden\][\s\S]{0,60}display: none/);
});

// ================================================= the stylesheet is loaded ==

const APP = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

test('the stylesheet is registered, because the dev server links nothing on its own', () => {
  // The offline snapshot inlines everything under src/ui/styles/ by itself.
  // The dev server does not: an unregistered file means an unstyled bar in dev
  // and a styled one in the export, which is the worst possible split.
  const line = APP.split('\n').find((l) => l.includes('const OWN_STYLES'));
  assert.ok(line, 'OWN_STYLES exists in app.js');
  assert.ok(line.includes('./styles/filters.css'), 'filters.css is in OWN_STYLES');
});

test('the old filter wall is gone, not merely unused', () => {
  // A dead parallel implementation of the thing that was just replaced is how
  // the next person rebuilds the wall by accident.
  for (const dead of ['function dateField(', 'function hourField(', 'function toggleChip(', 'function multi(', 'function renderFilters(', 'function renderCrumbs(']) {
    assert.ok(!APP.includes(dead), `app.js still defines ${dead.slice(9)}`);
  }
  const SHEET = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.ok(!/\.ms-(btn|pop|list|row|foot)\b/.test(SHEET), 'styles.css still styles the old multiselect');
  assert.ok(!/\.crumbs\b/.test(SHEET), 'styles.css still styles the breadcrumb line');
  const HTML = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.ok(!HTML.includes('id="crumbs"'), 'index.html still has the breadcrumb host');
  assert.ok(HTML.includes('id="filters"'), 'index.html still has the filter bar host');
});

// ================================================ the house text conventions ==

test('house style: no em dash or en dash in the filter bar source', () => {
  // Written as escapes on purpose: a literal glyph here would be a hit in this
  // very file and the test would fail on itself.
  const DASHES = /[\u2013\u2014]/g;
  for (const f of ['../src/ui/filters.js', '../src/ui/styles/filters.css', './filters.test.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.deepEqual(src.match(DASHES) || [], [], `${f}: use a plain sentence or a comma`);
  }
});

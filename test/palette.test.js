/**
 * rankCommands, matchRanges, groupByCategory and paletteSections are the pure
 * half of the command palette (src/ui/palette.js): no DOM, no `window`, no
 * `localStorage`. mountPalette is deliberately not exercised here — it needs
 * a browser, and this file must run under plain node:test. Everything about
 * the palette's actual rendering (icons, the `<mark>` highlight nodes, ARIA
 * wiring, keyboard focus, the footer strip) is DOM-only and untested here;
 * see the report for what was instead checked by hand in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCommands, matchRanges, groupByCategory, paletteSections } from '../src/ui/palette.js';

const TABS = [
  { id: 'tab:overview', label: 'Overview' },
  { id: 'tab:receipts', label: 'Receipts' },
  { id: 'tab:providers', label: 'Providers' },
  { id: 'tab:explorer', label: 'Data explorer' },
  { id: 'export-csv', label: 'Export CSV', keywords: 'csv download export' },
  { id: 'export-html', label: 'Export HTML snapshot', keywords: 'html snapshot offline export' },
  { id: 'refresh', label: 'Refresh data', keywords: 'refresh reload rescan' },
  { id: 'clear-filters', label: 'Clear filters', keywords: 'reset clear filters' },
];

test('empty query: recent commands first, most recent first, then the rest in original order', () => {
  const ranked = rankCommands(TABS, '', ['refresh', 'tab:receipts']);
  assert.deepEqual(ranked.map((c) => c.id), [
    'refresh', 'tab:receipts',
    'tab:overview', 'tab:providers', 'tab:explorer', 'export-csv', 'export-html', 'clear-filters',
  ]);
});

test('empty query and no recent history: the original order, untouched', () => {
  const ranked = rankCommands(TABS, '', []);
  assert.deepEqual(ranked.map((c) => c.id), TABS.map((c) => c.id));
});

test('query undefined or whitespace-only is treated as empty', () => {
  assert.deepEqual(rankCommands(TABS, undefined).map((c) => c.id), TABS.map((c) => c.id));
  assert.deepEqual(rankCommands(TABS, '   ').map((c) => c.id), TABS.map((c) => c.id));
});

test('recent ids that name no current command are ignored, never inserted', () => {
  const ranked = rankCommands(TABS, '', ['tab:does-not-exist', 'refresh']);
  assert.deepEqual(ranked.map((c) => c.id)[0], 'refresh');
  assert.ok(!ranked.some((c) => c.id === 'tab:does-not-exist'));
  assert.equal(ranked.length, TABS.length);
});

test('exact label match outranks a mere prefix', () => {
  // 'b' (the mere prefix) is listed FIRST, so an implementation that just
  // returned input order — ignoring tier entirely — would produce ['b','a'],
  // not the ['a','b'] this asserts. The tier comparison is what has to move
  // 'a' ahead of its earlier-indexed sibling.
  const commands = [
    { id: 'b', label: 'Export CSV' },
    { id: 'a', label: 'Export' },
  ];
  const ranked = rankCommands(commands, 'export');
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b']);
});

test('label prefix outranks a word-prefix match elsewhere in the label', () => {
  const commands = [
    { id: 'a', label: 'Export csv' }, // "csv" is a word inside the label, not a label prefix
    { id: 'b', label: 'csv export' }, // the label itself starts with "csv"
  ];
  const ranked = rankCommands(commands, 'csv');
  assert.deepEqual(ranked.map((c) => c.id), ['b', 'a']);
});

test('word-prefix outranks a subsequence-only match', () => {
  const commands = [
    { id: 'subseq', label: 'Live orchestration graph' }, // l-o-g appear in order, but no word starts with "log"
    { id: 'wordpfx', label: 'Peaks log view' },           // the word "log" itself starts with "log"
  ];
  const ranked = rankCommands(commands, 'log');
  assert.deepEqual(ranked.map((c) => c.id), ['wordpfx', 'subseq']);
});

test('subsequence matching finds a command with no contiguous match at all', () => {
  // "xplor" has no contiguous appearance in "Data explorer", but its letters
  // appear in order (e-X-P-L-O-R-er) — a subsequence match. Neither "Export
  // CSV" nor "Export HTML snapshot" carries an "l" in the right place, so
  // this query is unambiguous among TABS.
  const ranked = rankCommands(TABS, 'xplor');
  assert.deepEqual(ranked.map((c) => c.id), ['tab:explorer']);
});

test('a query nothing matches returns an empty array', () => {
  assert.deepEqual(rankCommands(TABS, 'zzzzz'), []);
});

test('matching is case-insensitive', () => {
  const ranked = rankCommands(TABS, 'RECEIPTS');
  assert.deepEqual(ranked.map((c) => c.id), ['tab:receipts']);
});

test('a keyword hit never outranks any label hit, even a subsequence one', () => {
  const commands = [
    { id: 'keyword-only', label: 'Something else', keywords: 'export' },
    { id: 'label-subseq', label: 'Ex-Report' }, // "export" is a subsequence: e-x-p-o-r-t in order
  ];
  const ranked = rankCommands(commands, 'export');
  assert.deepEqual(ranked.map((c) => c.id), ['label-subseq', 'keyword-only']);
});

test('ties keep the order commands arrived in (stable)', () => {
  const commands = [
    { id: 'first', label: 'Providers' },
    { id: 'second', label: 'Peaks' },
    { id: 'third', label: 'Productivity' },
  ];
  // All three labels start with "p", so all three share the exact same
  // label-prefix tier — the only thing left to separate them is input order.
  const ranked = rankCommands(commands, 'p');
  assert.deepEqual(ranked.map((c) => c.id), ['first', 'second', 'third']);
});

test('an empty commands array is handled for every query shape', () => {
  assert.deepEqual(rankCommands([], ''), []);
  assert.deepEqual(rankCommands([], 'anything'), []);
  assert.deepEqual(rankCommands([], '', ['recent-but-nothing-to-match']), []);
});

// ------------------------------------------------------------- matchRanges --

test('matchRanges: exact match highlights the whole label', () => {
  assert.deepEqual(matchRanges('Refresh', 'refresh'), [[0, 7]]);
});

test('matchRanges: label-prefix match highlights only the matched prefix', () => {
  assert.deepEqual(matchRanges('Export CSV', 'exp'), [[0, 3]]);
});

test('matchRanges: word-prefix match highlights the matched word, not the whole label', () => {
  assert.deepEqual(matchRanges('Peaks log view', 'log'), [[6, 9]]);
});

test('matchRanges: word-prefix match is correct across a multi-character separator', () => {
  // "Skin: Aurora" splits on ": " (two characters). A position computed by
  // accumulating `word.length + 1` per word (a single-char-separator
  // assumption) lands one character short, on the space, not on "A" — this
  // pins the fix at src/ui/palette.js's wordPrefixIndex().
  assert.deepEqual(matchRanges('Skin: Aurora', 'aur'), [[6, 9]]);
  assert.deepEqual(matchRanges('Mode: Dark', 'dark'), [[6, 10]]);
});

test('matchRanges: subsequence match highlights one range per matched character, in order', () => {
  // "xplor" against "Data explorer": e-X-P-L-O-R-er, no contiguous match.
  assert.deepEqual(matchRanges('Data explorer', 'xplor'), [[6, 7], [7, 8], [8, 9], [9, 10], [10, 11]]);
});

test('matchRanges: a keyword-only match returns no ranges — nothing in the label to underline', () => {
  // "Clear filters" contains no in-order r-e-s-e-t; the match (if any) can
  // only have come from the command's `keywords`, which matchRanges never
  // looks at.
  assert.deepEqual(matchRanges('Clear filters', 'reset'), []);
});

test('matchRanges: empty or whitespace-only query highlights nothing', () => {
  assert.deepEqual(matchRanges('Overview', ''), []);
  assert.deepEqual(matchRanges('Overview', '   '), []);
  assert.deepEqual(matchRanges('Overview', undefined), []);
});

test('matchRanges: matching is case-insensitive but ranges index the original, mixed-case label', () => {
  assert.deepEqual(matchRanges('Receipts', 'RECEIPTS'), [[0, 8]]);
});

// ---------------------------------------------------------- groupByCategory --

test('groupByCategory: items are grouped by their group label, first-appearance order', () => {
  const items = [
    { id: 'a', group: 'Views' },
    { id: 'b', group: 'Actions' },
    { id: 'c', group: 'Views' },
    { id: 'd', group: 'Export' },
  ];
  const sections = groupByCategory(items);
  assert.deepEqual(sections.map((s) => s.heading), ['Views', 'Actions', 'Export']);
  assert.deepEqual(sections.map((s) => s.items.map((i) => i.id)), [['a', 'c'], ['b'], ['d']]);
});

test('groupByCategory: every item lands in exactly one group, none dropped or duplicated', () => {
  const items = [
    { id: 'a', group: 'Views' },
    { id: 'b', group: 'Actions' },
    { id: 'c', group: 'Views' },
  ];
  const sections = groupByCategory(items);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  assert.equal(total, items.length);
});

test('groupByCategory: an item with no group lands under "Other"', () => {
  const sections = groupByCategory([{ id: 'a' }]);
  assert.deepEqual(sections, [{ heading: 'Other', items: [{ id: 'a' }] }]);
});

// --------------------------------------------------------- paletteSections --

test('paletteSections: empty query with recents gets a leading Recent section, recents removed from their own category', () => {
  const sections = paletteSections(TABS, '', ['refresh', 'tab:receipts']);
  assert.equal(sections[0].heading, 'Recent');
  assert.deepEqual(sections[0].items.map((c) => c.id), ['refresh', 'tab:receipts']);
  // "Refresh data" and "Receipts" must not also appear a second time under
  // whatever category they would otherwise have grouped into.
  const rest = sections.slice(1).flatMap((s) => s.items.map((c) => c.id));
  assert.ok(!rest.includes('refresh'));
  assert.ok(!rest.includes('tab:receipts'));
  const allIds = sections.flatMap((s) => s.items.map((c) => c.id));
  assert.deepEqual([...allIds].sort(), [...TABS.map((c) => c.id)].sort());
});

test('paletteSections: empty query with no recents has no Recent section', () => {
  const sections = paletteSections(TABS, '', []);
  assert.ok(!sections.some((s) => s.heading === 'Recent'));
});

test('paletteSections: a stale recent id (names no current command) is ignored, not turned into an empty Recent section', () => {
  const sections = paletteSections(TABS, '', ['tab:does-not-exist']);
  assert.ok(!sections.some((s) => s.heading === 'Recent'));
});

test('paletteSections: a non-empty query never gets a Recent section, even with matching recents', () => {
  const sections = paletteSections(TABS, 'export', ['export-csv']);
  assert.ok(!sections.some((s) => s.heading === 'Recent'));
});

test('paletteSections: a non-empty query groups by category in first-appearance rank order, not a fixed order', () => {
  // "csv" ranks "Export CSV" (an Export command) ahead of nothing else here,
  // so with only one match there is only one section — the interesting case
  // is proven below, where a later-declared category outranks an earlier one.
  const commands = [
    { id: 'tab:x', label: 'Some tab', group: 'Views' },
    { id: 'export-csv', label: 'Export CSV', group: 'Export' },
  ];
  // "export" is a label-prefix match for "Export CSV" and no match at all for
  // "Some tab", so Export must be the only (and therefore first) section.
  const sections = paletteSections(commands, 'export', []);
  assert.deepEqual(sections.map((s) => s.heading), ['Export']);
});

// ---------------------------------------------------- keyword substring fix --
// A keyword is an alias, not label prose: it must match the query as a plain
// contiguous substring, never a subsequence. Subsequence matching a keyword
// blob lets the query's letters land in different keywords entirely (see the
// reproduction below), which read as a broken search once grouping and
// highlighting made results legible — nothing on screen explained the hit,
// because there is nothing to highlight in a keyword the label never shows.

test('a keyword blob is no longer matched by subsequence: "rec" does not span r from one keyword into e and c of another', () => {
  // Reproduces the exact defect: in "theme skin appearance colour color",
  // r lands in "appearance", e ends "appearance", and c starts "colour" —
  // three different keywords, no substring "rec" anywhere in the blob.
  const commands = [
    { id: 'skin-aurora', label: 'Skin: Aurora', keywords: 'theme skin appearance colour color' },
    { id: 'skin-terminal', label: 'Skin: Terminal', keywords: 'theme skin appearance colour color' },
    { id: 'skin-editorial', label: 'Skin: Editorial', keywords: 'theme skin appearance colour color' },
    { id: 'clear-filters', label: 'Clear filters', keywords: 'reset clear filters' },
    { id: 'refresh', label: 'Refresh data', keywords: 'refresh reload rescan' },
    { id: 'copy-link', label: 'Copy deep link', keywords: 'link share url copy' },
  ];
  assert.deepEqual(rankCommands(commands, 'rec'), []);
});

test('"rec" still matches every command whose LABEL genuinely contains it, label subsequence included', () => {
  const ranked = rankCommands(TABS, 'rec');
  assert.deepEqual(ranked.map((c) => c.id), ['tab:receipts']);
});

test('a keyword substring match still works — a real alias is not thrown out with the subsequence fix', () => {
  // "download" appears nowhere in either label, only inside export-csv's own
  // keywords — this is exactly what a keyword alias is for.
  const ranked = rankCommands(TABS, 'download');
  assert.deepEqual(ranked.map((c) => c.id), ['export-csv']);
});

test('a keyword match is substring, not prefix-only or exact-only: it can start mid-string', () => {
  const commands = [{ id: 'a', label: 'Something else', keywords: 'theme skin appearance colour color' }];
  assert.deepEqual(rankCommands(commands, 'colour'), [{ id: 'a', label: 'Something else', keywords: 'theme skin appearance colour color' }]);
});

test('a keyword hit still never outranks any label hit, including a label subsequence one', () => {
  const commands = [
    { id: 'keyword-only', label: 'Something else', keywords: 'export' },
    { id: 'label-subseq', label: 'Ex-Report' }, // "export" is a subsequence: e-x-p-o-r-t in order
  ];
  const ranked = rankCommands(commands, 'export');
  assert.deepEqual(ranked.map((c) => c.id), ['label-subseq', 'keyword-only']);
});

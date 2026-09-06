/**
 * rankCommands is the pure half of the command palette (src/ui/palette.js):
 * no DOM, no `window`, no `localStorage`. mountPalette is deliberately not
 * exercised here — it needs a browser, and this file must run under plain
 * node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCommands } from '../src/ui/palette.js';

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

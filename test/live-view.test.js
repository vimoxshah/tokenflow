/**
 * The pure shaping behind the Live tab's "right now" sections.
 *
 * Each assertion stands in for a way the tab could lie about the moment it is
 * describing: a gauge that sits at zero when nothing was measured, a source
 * that changes colour because a quiet hour dropped it down the ranking, a
 * missing value rendered as 0 or as an em dash, a cap that reads as declared
 * when it is only the drawing default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_CAP,
  asOfLabel,
  capRows,
  contextGauge,
  costLabel,
  countLabel,
  gaugeRatio,
  guardChip,
  orderSparkSources,
  sessionPlace,
  turnsLabel,
} from '../src/analytics/live-view.js';

const NO_CAPS = {
  warnCostUsd: null,
  maxCostUsd: null,
  warnContextTokens: null,
  maxContextTokens: null,
  warnMarginalUsd: null,
};

// ------------------------------------------------------------ cap resolution

test('cap resolution: a declared maxContextTokens wins, and says so', () => {
  const declared = contextGauge({ contextTokens: 60000, policy: { ...NO_CAPS, maxContextTokens: 120000 } });
  assert.equal(declared.cap, 120000);
  assert.equal(declared.declared, true);
  assert.equal(declared.capLabel, 'of 120K');
  assert.equal(declared.ratio, 0.5);
});

test('cap resolution: no cap falls back to the 200K drawing scale, flagged undeclared', () => {
  const g = contextGauge({ contextTokens: 100000, policy: NO_CAPS });
  assert.equal(g.cap, DEFAULT_CONTEXT_CAP);
  assert.equal(g.cap, 200000);
  assert.equal(g.declared, false, 'the default scale must never claim to be a declared cap');
  assert.equal(g.capLabel, 'of 200K');
  assert.equal(g.text, '100K of 200K');
});

test('cap resolution: a zero, negative or non-numeric cap is not a cap', () => {
  for (const bad of [0, -5, null, undefined, '150000', NaN, Infinity]) {
    const g = contextGauge({ contextTokens: 1000, policy: { ...NO_CAPS, maxContextTokens: bad } });
    assert.equal(g.cap, DEFAULT_CONTEXT_CAP, `maxContextTokens ${String(bad)} must not become a cap`);
    assert.equal(g.declared, false);
  }
});

test('cap resolution: a missing policy object is survivable', () => {
  for (const p of [null, undefined, {}]) {
    const g = contextGauge({ contextTokens: 20000, policy: p });
    assert.equal(g.cap, DEFAULT_CONTEXT_CAP);
    assert.equal(g.declared, false);
  }
});

// ------------------------------------------------------------- gauge ratio --

test('gauge ratio: clamps to 0..1 rather than overflowing its track', () => {
  assert.equal(gaugeRatio(0, 200000), 0);
  assert.equal(gaugeRatio(50000, 200000), 0.25);
  assert.equal(gaugeRatio(200000, 200000), 1);
  assert.equal(gaugeRatio(400000, 200000), 1, 'past the cap the fill stops at full');
  assert.equal(gaugeRatio(-10, 200000), 0);
});

test('gauge ratio: an unmeasured context is null, never 0', () => {
  for (const v of [null, undefined, NaN, Infinity, '1000']) {
    // The cast is the point: a caller with a loose type must still get null.
    assert.equal(gaugeRatio(/** @type {any} */ (v), 200000), null, `${String(v)} tokens must not read as an empty gauge`);
  }
  assert.equal(gaugeRatio(1000, 0), null, 'a zero cap has no fraction to report');
  assert.equal(gaugeRatio(1000, null), null);
});

test('gauge: an unmeasured context says n/a on both the value and the percent', () => {
  const g = contextGauge({ contextTokens: null, policy: NO_CAPS });
  assert.equal(g.ratio, null);
  assert.equal(g.value, 'n/a');
  assert.equal(g.text, 'n/a');
  assert.equal(g.pctText, 'n/a');
  assert.ok(!g.text.includes('0'), 'a missing measurement must not render as zero');
});

test('gauge: a real demo-store session reads the way the card shows it', () => {
  const g = contextGauge({ contextTokens: 163757, policy: NO_CAPS });
  assert.equal(g.text, '164K of 200K');
  assert.equal(g.pctText, '82%');
  assert.ok(g.ratio > 0.81 && g.ratio < 0.83);
});

// ------------------------------------------------------------- asOf labels --

test('asOf label: relative to the stamp, never to the wall clock', () => {
  const now = Date.parse('2026-09-05T17:10:00.000Z');
  assert.equal(asOfLabel('2026-09-05T17:06:02.917Z', now), '3 min ago');
  assert.equal(asOfLabel('2026-09-05T17:09:59.000Z', now), 'just now');
  assert.equal(asOfLabel('2026-09-05T15:00:00.000Z', now), '2 hours ago');
});

test('asOf label: a missing stamp is n/a, not "never" and not the current time', () => {
  const now = Date.parse('2026-09-05T17:10:00.000Z');
  assert.equal(asOfLabel(null, now), 'n/a');
  assert.equal(asOfLabel(undefined, now), 'n/a');
  assert.equal(asOfLabel('', now), 'n/a');
  assert.equal(asOfLabel('not a date', now), 'n/a');
});

// --------------------------------------------------------------- cost/turns --

test('cost label: an unpriced session is n/a, and a partly priced one shows its coverage', () => {
  assert.deepEqual(costLabel({ costUsd: null, coverage: null }), {
    text: 'n/a', coverageText: null, priced: false,
  });
  assert.deepEqual(costLabel({ costUsd: 101.93542724999999, coverage: 1 }), {
    text: '$101.94', coverageText: null, priced: true,
  });
  assert.deepEqual(costLabel({ costUsd: 4.2, coverage: 0.6 }), {
    text: '$4.20', coverageText: 'priced 60% of turns', priced: true,
  });
});

test('cost label: full coverage stays silent, so only the gap is called out', () => {
  assert.equal(costLabel({ costUsd: 1, coverage: 1 }).coverageText, null);
  assert.equal(costLabel({ costUsd: 1, coverage: 0.999 }).coverageText, 'priced 100% of turns');
});

test('count label: a counted noun agrees with its count, and 1 is never "1 sessions"', () => {
  assert.equal(countLabel(1, 'session'), '1 session');
  assert.equal(countLabel(0, 'session'), '0 sessions');
  assert.equal(countLabel(179, 'turn'), '179 turns');
  assert.equal(countLabel(12345, 'turn'), '12,345 turns');
  assert.equal(countLabel(null, 'turn'), 'n/a');
  assert.equal(countLabel(undefined, 'session'), 'n/a');
  assert.equal(countLabel(NaN, 'session'), 'n/a');
});

test('turns label: subagents appear only when there are some', () => {
  assert.equal(turnsLabel({ turns: 11, subagentTurns: 0 }), '11 turns');
  assert.equal(turnsLabel({ turns: 1, subagentTurns: 0 }), '1 turn');
  assert.equal(turnsLabel({ turns: 260, subagentTurns: 4 }), '260 turns, 4 by subagents');
  assert.equal(turnsLabel({ turns: null, subagentTurns: null }), 'n/a');
  assert.equal(turnsLabel({}), 'n/a');
});

test('session place: project first, repository as the fallback, n/a when neither', () => {
  assert.deepEqual(sessionPlace({ project: 'web-app', repository: 'web-app', branch: 'feat/x' }), {
    where: 'web-app', branch: 'feat/x',
  });
  assert.deepEqual(sessionPlace({ project: null, repository: 'infra', branch: null }), {
    where: 'infra', branch: 'n/a',
  });
  assert.deepEqual(sessionPlace({}), { where: 'n/a', branch: 'n/a' });
});

// ------------------------------------------------------------------ guard ---

test('guard chip: an unknown level degrades to ok rather than to a status colour', () => {
  assert.equal(guardChip({ level: 'block' }).level, 'block');
  assert.equal(guardChip({ level: 'warn' }).level, 'warn');
  assert.equal(guardChip({ level: 'ok' }).level, 'ok');
  assert.equal(guardChip({ level: 'exploded' }).level, 'ok');
  assert.equal(guardChip(null).level, 'ok');
  assert.equal(guardChip({ level: 'block' }).text, 'guard block');
});

test('guard chip: the first reason becomes the tooltip, and no reason means no tooltip', () => {
  assert.equal(guardChip({ level: 'warn', reasons: ['spend passed $25', 'context is large'] }).title, 'spend passed $25');
  assert.equal(guardChip({ level: 'ok', reasons: [] }).title, null, 'an empty title would render an empty tooltip');
  assert.equal(guardChip({ level: 'ok' }).title, null);
});

test('cap rows: nothing declared means no rows, so the card can say "No caps set"', () => {
  assert.deepEqual(capRows(NO_CAPS), []);
  assert.deepEqual(capRows({}), []);
  assert.deepEqual(capRows(null), []);
});

test('cap rows: declared caps come back in policy order, money as money and tokens compact', () => {
  const rows = capRows({
    warnCostUsd: 25,
    maxCostUsd: 50,
    warnContextTokens: null,
    maxContextTokens: 180000,
    warnMarginalUsd: 0.75,
  });
  assert.deepEqual(rows.map((r) => r.key), ['warnCostUsd', 'maxCostUsd', 'maxContextTokens', 'warnMarginalUsd']);
  assert.deepEqual(rows.map((r) => r.text), ['$25.00', '$50.00', '180K', '$0.75']);
  assert.equal(rows[1].label, 'Block at session spend');
});

// ------------------------------------------------------------- sparklines ---

const HOURS = 24;
const flat = (n) => new Array(HOURS).fill(n);

test('sparklines: one series per source, colour by alphabetical position', () => {
  const { series, folded } = orderSparkSources({
    bySource: { opencode: flat(5), codex: flat(1), 'claude-code': flat(9) },
  });
  assert.deepEqual(folded, []);
  assert.deepEqual(series.map((s) => s.id), ['claude-code', 'codex', 'opencode'], 'presentation order is alphabetical');
  assert.deepEqual(series.map((s) => s.colorIndex), [0, 1, 2]);
});

test('sparklines: a new source ahead of the others shifts every rank together, never steals one', () => {
  const before = orderSparkSources({ bySource: { hermes: flat(3), opencode: flat(5) } });
  const after = orderSparkSources({ bySource: { 'claude-code': flat(1), hermes: flat(3), opencode: flat(5) } });
  const idx = (r, id) => r.series.find((s) => s.id === id).colorIndex;
  assert.equal(idx(before, 'hermes'), 0);
  assert.equal(idx(before, 'opencode'), 1);
  // Alphabetical position shifted for both, and that is the whole point: the
  // rule is "colour by alphabetical position", so both move together and no
  // series inherits a colour that was another source's a moment ago.
  assert.equal(idx(after, 'claude-code'), 0);
  assert.equal(idx(after, 'hermes'), 1);
  assert.equal(idx(after, 'opencode'), 2);
});

test('sparklines: colour survives a volume change that reorders the ranking', () => {
  const quiet = orderSparkSources({ bySource: { alpha: flat(1), beta: flat(9) } });
  const busy = orderSparkSources({ bySource: { alpha: flat(9), beta: flat(1) } });
  const idx = (r, id) => r.series.find((s) => s.id === id).colorIndex;
  assert.equal(idx(quiet, 'alpha'), idx(busy, 'alpha'), 'ranking must not repaint a series');
  assert.equal(idx(quiet, 'beta'), idx(busy, 'beta'));
});

test('sparklines: past the cap the quiet sources fold into one summed "other"', () => {
  const bySource = {
    a: flat(10), b: flat(9), c: flat(8), d: flat(7), e: flat(6), f: flat(5), g: flat(4),
  };
  const { series, folded } = orderSparkSources({ bySource, max: 5 });
  assert.equal(series.length, 6, 'five sources plus one "other"');
  assert.deepEqual(folded, ['f', 'g'], 'the two smallest fold');
  const other = series[series.length - 1];
  assert.equal(other.id, 'other', '"other" is always last');
  assert.equal(other.colorIndex, null, '"other" takes the muted colour, not a series slot');
  assert.deepEqual(other.values, flat(9), 'folded buckets are summed hour by hour, not averaged');
  assert.equal(other.total, 9 * HOURS);
  assert.deepEqual(other.folded, ['f', 'g']);
});

test('sparklines: selection is by volume even though presentation is alphabetical', () => {
  const bySource = { zulu: flat(100), alpha: flat(1), bravo: flat(2) };
  const { series, folded } = orderSparkSources({ bySource, max: 1 });
  assert.deepEqual(series.map((s) => s.id), ['zulu', 'other']);
  assert.deepEqual(folded, ['alpha', 'bravo']);
  assert.equal(series[0].colorIndex, 2, 'zulu keeps its alphabetical slot even as the only kept series');
  assert.deepEqual(series[1].values, flat(3));
});

test('sparklines: an exact tie on volume breaks alphabetically, not by insertion order', () => {
  const { series } = orderSparkSources({ bySource: { zebra: flat(1), apple: flat(1) }, max: 1 });
  assert.deepEqual(series.map((s) => s.id), ['apple', 'other']);
});

test('sparklines: a ninth source keeps its own rank, so the view can tell it from "other"', () => {
  const bySource = {};
  'abcdefghi'.split('').forEach((k, i) => { bySource[k] = flat(i + 1); });
  const { series } = orderSparkSources({ bySource, max: 5 });
  const ninth = series.find((x) => x.id === 'i');
  assert.equal(ninth.colorIndex, 8, 'the rank runs past the eight series slots and the view wraps it');
  assert.notEqual(ninth.colorIndex, null, 'only the folded series may take the muted colour');
  assert.equal(series[series.length - 1].colorIndex, null, 'and "other" still does');
});

test('sparklines: no sources means no series and nothing folded', () => {
  for (const bySource of [{}, null, undefined]) {
    const r = orderSparkSources({ bySource });
    assert.deepEqual(r.series, []);
    assert.deepEqual(r.folded, []);
  }
  assert.deepEqual(orderSparkSources().series, []);
});

test('sparklines: a non-array bucket set is skipped instead of crashing the tab', () => {
  const { series } = orderSparkSources({ bySource: { good: flat(2), broken: 'nope', missing: null } });
  assert.deepEqual(series.map((s) => s.id), ['good']);
});

test('sparklines: the values handed to the chart are a copy, so a redraw cannot mutate the status', () => {
  const bySource = { only: flat(3) };
  const { series } = orderSparkSources({ bySource });
  series[0].values[0] = 999;
  assert.equal(bySource.only[0], 3, 'the fetched status must stay exactly what the file said');
});

test('sparklines: the demo store shape survives the round trip', () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 225740, 2121552, 4603519, 8737232, 6344337];
  const { series, folded } = orderSparkSources({ bySource: { mock: values } });
  assert.deepEqual(folded, []);
  assert.equal(series.length, 1);
  assert.equal(series[0].id, 'mock');
  assert.equal(series[0].colorIndex, 0);
  assert.deepEqual(series[0].values, values);
  assert.equal(series[0].total, 22032380);
});

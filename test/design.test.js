/**
 * The design system is code: one token source compiles into three surfaces
 * and passes its gates. These tests make a hand edit to a generated block, a
 * palette that fails contrast, or a UI motion over 300ms a failing build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadTokens, compile, materialize, runGates, contrast, deltaE, luminance, hexToRgb, THRESHOLDS, START, END,
} from '../scripts/design-build.js';

const t = loadTokens();

test('colour math: contrast and ΔE behave', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.equal(deltaE('#ff0000', '#ff0000'), 0);
  assert.ok(deltaE('#ff0000', '#00ff00') > 100);
  assert.equal(hexToRgb('#zzz'), null);
  assert.ok(luminance('#ffffff') > 0.99);
});

test('gates: the shipped tokens pass every hard gate', () => {
  const g = runGates(t);
  assert.deepEqual(g.failures, []);
  // The documented relief slots on light chart surfaces surface as warnings, never silently.
  assert.ok(g.warnings.some((w) => /relief/.test(w)), 'light-mode relief slots are reported');
});

test('gates: catch a muted ink that fails, a UI motion over the ceiling, and a hue at the diverging midpoint', () => {
  const bad = structuredClone(t);
  bad.skins.aurora.dark['text-muted'] = '#2a3140';
  bad.motion.ui.slow = '450ms';
  bad.diverging.dark[2] = '#3987e5';
  const g = runGates(bad);
  assert.ok(g.failures.some((f) => /aurora\/dark: text-muted/.test(f)));
  assert.ok(g.failures.some((f) => /motion\/ui\/slow/.test(f)));
  assert.ok(g.failures.some((f) => /diverging\/dark: midpoint/.test(f)));
});

test('gates: adjacent series that collapse together are refused', () => {
  const bad = structuredClone(t);
  bad.series.dark[1] = bad.series.dark[0];
  const g = runGates(bad);
  assert.ok(g.failures.some((f) => /series\/dark: slots 1–2/.test(f)));
});

test('structure: two axes, eight series per mode, every skin carries both modes and a density block', () => {
  assert.equal(t.series.dark.length, 8);
  assert.equal(t.series.light.length, 8);
  assert.equal(Object.values(t.skins).filter((s) => s.default).length, 1, 'exactly one default skin');
  for (const [id, s] of Object.entries(t.skins)) {
    assert.ok(s.dark && s.light, `${id} has both modes`);
    assert.ok(s.density && s.density['pad-card'], `${id} declares density`);
    assert.ok(['sans', 'mono', 'serif'].includes(s.display), `${id} display face is a known role`);
  }
  for (const v of Object.values(t.type)) assert.ok(v.size > 0 && typeof v.tracking === 'string');
  assert.ok(parseInt(t.motion.ui.slow, 10) <= 300);
});

test('outputs: generated blocks are current in every target (run `npm run design` after editing tokens.yaml)', () => {
  const { gates, outputs } = compile(t);
  assert.deepEqual(gates.failures, []);
  const files = materialize(outputs);
  for (const [name, { file, next }] of Object.entries(files)) {
    assert.ok(fs.existsSync(file), `${name}: ${file} exists`);
    assert.equal(fs.readFileSync(file, 'utf8'), next, `${name}: ${file} is out of date`);
  }
});

test('outputs: the dashboard block carries every role the hand-authored CSS relies on', () => {
  const css = compile(t).outputs.dashboard;
  for (const v of ['--plane', '--surface-1', '--text-muted', '--accent-solid', '--series-8', '--seq-7', '--div-3', '--good', '--critical', '--dur-press', '--ease-out', '--fs-hero', '--tr-hero', '--radius-pill', '--pad-card']) {
    assert.ok(css.includes(v + ':'), `${v} is emitted`);
  }
  assert.ok(css.startsWith(START) && css.endsWith(END));
  assert.ok(!/\t/.test(css), 'no tabs');
  assert.ok(!/[ \t]+\n/.test(css), 'no trailing whitespace');
  assert.ok(/:root\[data-skin='terminal'\]/.test(css));
  assert.ok(/:root, :root\[data-skin='aurora'\]/.test(css), 'the default skin is also the bare :root');
});

test('outputs: the site block self-hosts its faces and commits to one world', () => {
  const css = compile(t).outputs.site;
  assert.ok(/@font-face \{ font-family: 'Space Grotesk'/.test(css));
  assert.ok(/url\('fonts\/ibm-plex-sans-500\.woff2'\)/.test(css));
  for (const m of css.matchAll(/url\('fonts\/([^']+)'\)/g)) {
    assert.ok(fs.existsSync(new URL(`../site/fonts/${m[1]}`, import.meta.url)), `${m[1]} is shipped under site/fonts/`);
  }
  assert.ok(!/fonts\.googleapis/.test(css), 'no third-party font requests');
  assert.ok(/color-scheme: dark;/.test(css));
  assert.ok(!/data-mode='light'/.test(css), 'single world: no second mode faked');
});

test('outputs: the Swift file resolves every role by appearance and never guesses a colour', () => {
  const swift = compile(t).outputs.swift;
  assert.ok(/static let accent = Dyn\(dark: "#8f9dff", light: "#3d4dd6"\)/.test(swift));
  assert.ok(/static let seriesDark: \[String\] = \["#3987e5"/.test(swift));
  assert.ok(/convenience init\(dkHex: String\)/.test(swift));
  assert.ok(/static let durPress: Double = 0\.120/.test(swift));
  assert.ok(swift.endsWith('\n'));
});

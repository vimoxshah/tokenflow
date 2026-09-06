#!/usr/bin/env node
/**
 * The design-token compiler.
 *
 *   node scripts/design-build.js            compile design/tokens.yaml and write
 *   node scripts/design-build.js --check    compile in memory, diff, run gates; exit 1 on drift or failure
 *
 * One source, three outputs:
 *   src/ui/styles.css                 a generated block between markers (the dashboard + offline snapshot)
 *   site/styles.css                   a generated block between markers (the landing page)
 *   menubar/TokenFlow/DesignTokens.swift  a whole generated file (the menu bar)
 *
 * The blocks live INSIDE the existing stylesheets rather than in new files
 * because the offline snapshot (src/export/html-snapshot.js) inlines exactly
 * one stylesheet; a second file would silently break every exported page.
 *
 * Gates run on every compile and fail closed. They measure what a token file
 * can measure — contrast, perceptual distance, monotonic ramps — and print
 * what they cannot (rationing, hierarchy) as doctrine for review.
 *
 * Zero dependencies: the YAML is read with the project's own parser.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseYaml } from '../src/core/yaml.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const TOKENS_FILE = path.join(ROOT, 'design', 'tokens.yaml');
export const TARGETS = {
  dashboard: path.join(ROOT, 'src', 'ui', 'styles.css'),
  site: path.join(ROOT, 'site', 'styles.css'),
  swift: path.join(ROOT, 'menubar', 'TokenFlow', 'DesignTokens.swift'),
};
export const START = '/* @generated design-tokens:start';
export const END = '/* @generated design-tokens:end */';

// ------------------------------------------------------------- colour math ---

export function hexToRgb(hex) {
  const h = String(hex).trim().replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
export function lab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.0;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
/** CIE76 ΔE — the perceptual distance the design-kit ramp gate uses. */
export function deltaE(a, b) {
  const A = lab(a);
  const B = lab(b);
  if (!A || !B) return null;
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// ------------------------------------------------------------------ gates ---

export const THRESHOLDS = {
  inkPrimary: 7.0,      // text-primary on plane (AAA for body)
  inkSecondary: 4.5,    // text-secondary on plane
  inkMuted: 4.5,        // text-muted on surface-1 (labels are 11.5px; no discount)
  accentInk: 4.5,       // button text on accent-solid
  seriesOnSurface: 3.0, // a mark must separate from the chart surface
  adjacentSeries: 20,   // CIE76 ΔE between neighbouring series (design-kit gate)
  firstThreeAllPairs: 20,
  statusVsSeries: 12,   // hard floor; below 20 is reported as a warning
  divergingEnds: 40,
  divergingMidChroma: 14, // |a|,|b| of the midpoint must stay near neutral
};

/**
 * @param {object} t parsed tokens
 * @returns {{failures:string[], warnings:string[], report:string[]}}
 */
export function runGates(t) {
  const failures = [];
  const warnings = [];
  const report = [];
  const fail = (m) => failures.push(m);
  const warn = (m) => warnings.push(m);
  const fmt = (n) => (n === null ? 'n/a' : n.toFixed(2));

  for (const [skinId, skin] of Object.entries(t.skins)) {
    for (const mode of ['dark', 'light']) {
      const c = skin[mode];
      if (!c) { fail(`${skinId}: missing ${mode} block`); continue; }
      for (const role of ['plane', 'surface-1', 'surface-2', 'surface-3', 'text-primary', 'text-secondary', 'text-muted', 'grid', 'axis', 'border', 'border-strong', 'hairline', 'accent', 'accent-solid', 'accent-ink', 'shadow', 'glow', 'hero-glow']) {
        if (c[role] === undefined) fail(`${skinId}/${mode}: missing role ${role}`);
      }
      const where = `${skinId}/${mode}`;
      const ip = contrast(c['text-primary'], c.plane);
      const is = contrast(c['text-secondary'], c.plane);
      const im = contrast(c['text-muted'], c['surface-1']);
      const ai = contrast(c['accent-ink'], c['accent-solid']);
      report.push(`${where}: ink primary ${fmt(ip)} · secondary ${fmt(is)} · muted ${fmt(im)} · accent-ink ${fmt(ai)}`);
      if (ip < THRESHOLDS.inkPrimary) fail(`${where}: text-primary on plane ${fmt(ip)} < ${THRESHOLDS.inkPrimary}`);
      if (is < THRESHOLDS.inkSecondary) fail(`${where}: text-secondary on plane ${fmt(is)} < ${THRESHOLDS.inkSecondary}`);
      if (im < THRESHOLDS.inkMuted) fail(`${where}: text-muted on surface-1 ${fmt(im)} < ${THRESHOLDS.inkMuted}`);
      if (ai < THRESHOLDS.accentInk) fail(`${where}: accent-ink on accent-solid ${fmt(ai)} < ${THRESHOLDS.accentInk}`);
      // Lightness carries hierarchy. A card LIFTS off the plane toward the light
      // in both modes; wells nested inside a card (surface-2, surface-3) step
      // AWAY from the card — lighter still in dark mode, greyer in light mode.
      const [Lp, L1, L2, L3] = [c.plane, c['surface-1'], c['surface-2'], c['surface-3']].map(luminance);
      if (!(L1 > Lp)) fail(`${where}: surface-1 (${fmt(L1)}) does not lift off the plane (${fmt(Lp)})`);
      const nests = mode === 'dark' ? (L2 > L1 && L3 > L2) : (L2 < L1 && L3 < L2);
      if (!nests) fail(`${where}: surface-2/3 do not nest away from surface-1 in one direction (${[L1, L2, L3].map(fmt).join(' → ')})`);

      // Series on this skin's chart surface.
      const series = t.series[mode];
      const relief = new Set((t.series.relief && t.series.relief[mode]) || []);
      series.forEach((hex, i) => {
        const cr = contrast(hex, c['surface-1']);
        if (cr < THRESHOLDS.seriesOnSurface) {
          const msg = `${where}: series-${i + 1} ${hex} on surface-1 is ${fmt(cr)} < ${THRESHOLDS.seriesOnSurface}`;
          if (relief.has(i + 1)) warn(`${msg} (documented relief: table twin + direct labels)`); else fail(msg);
        }
      });
    }
  }

  for (const mode of ['dark', 'light']) {
    const s = t.series[mode];
    if (!s || s.length !== 8) fail(`series/${mode}: expected 8 steps, got ${s ? s.length : 0}`);
    for (let i = 1; i < s.length; i++) {
      const d = deltaE(s[i - 1], s[i]);
      if (d < THRESHOLDS.adjacentSeries) fail(`series/${mode}: slots ${i}–${i + 1} ΔE ${fmt(d)} < ${THRESHOLDS.adjacentSeries}`);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const d = deltaE(s[i], s[j]);
      if (d < THRESHOLDS.firstThreeAllPairs) fail(`series/${mode}: slots ${i + 1}/${j + 1} (all-pairs set) ΔE ${fmt(d)} < ${THRESHOLDS.firstThreeAllPairs}`);
    }
    const worstAdj = Math.min(...s.slice(1).map((h, i) => deltaE(s[i], h)));
    report.push(`series/${mode}: worst adjacent ΔE ${fmt(worstAdj)}`);

    const seq = t.sequential[mode];
    const Ls = seq.map(luminance);
    const mono = Ls.every((v, i) => i === 0 || v > Ls[i - 1]) || Ls.every((v, i) => i === 0 || v < Ls[i - 1]);
    if (!mono) fail(`sequential/${mode}: luminance is not monotonic`);

    const div = t.diverging[mode];
    if (!div || div.length !== 5) fail(`diverging/${mode}: expected 5 steps`);
    else {
      const ends = deltaE(div[0], div[4]);
      if (ends < THRESHOLDS.divergingEnds) fail(`diverging/${mode}: ends ΔE ${fmt(ends)} < ${THRESHOLDS.divergingEnds}`);
      const mid = lab(div[2]);
      if (Math.abs(mid[1]) > THRESHOLDS.divergingMidChroma || Math.abs(mid[2]) > THRESHOLDS.divergingMidChroma) {
        fail(`diverging/${mode}: midpoint ${div[2]} is not neutral (a ${fmt(mid[1])}, b ${fmt(mid[2])})`);
      }
    }

    const statusRelief = new Set((t.status.relief && t.status.relief[mode]) || []);
    for (const [name, hex] of Object.entries(t.status)) {
      if (typeof hex !== 'string') continue; // the relief block, not a colour
      s.forEach((sh, i) => {
        const d = deltaE(hex, sh);
        if (d < THRESHOLDS.statusVsSeries) {
          const msg = `status/${name} vs series-${i + 1} (${mode}) ΔE ${fmt(d)} < ${THRESHOLDS.statusVsSeries}`;
          if (statusRelief.has(name)) warn(`${msg} (documented relief: status is never a mark and always carries an icon or a word)`); else fail(msg);
        } else if (d < 20) warn(`status/${name} vs series-${i + 1} (${mode}) ΔE ${fmt(d)} — close; status ships with icon + word`);
      });
    }
  }

  for (const [tier, m] of Object.entries(t.motion)) {
    for (const [k, v] of Object.entries(m)) {
      if (/^(press|fast|base|slow|stagger)$/.test(k) && !/^\d+ms$/.test(String(v))) fail(`motion/${tier}/${k}: "${v}" is not a millisecond value`);
    }
    if (tier === 'ui' && parseInt(m.slow, 10) > 300) fail(`motion/ui/slow ${m.slow} exceeds the 300ms ceiling for UI motion`);
  }
  return { failures, warnings, report };
}

// ------------------------------------------------------------- rendering ---

const ms = (v) => String(v);
const px = (v) => `${v}px`;

function rootBlock(t, { includeNarrative = true } = {}) {
  const L = [];
  L.push(`  --sans: ${t.fonts.sans};`);
  L.push(`  --mono: ${t.fonts.mono};`);
  L.push(`  --serif: ${t.fonts.serif};`);
  L.push(`  --display: var(--sans);`);
  L.push(`  --figure: var(--sans);`);
  L.push('');
  L.push('  /* type scale — size-specific tracking and leading */');
  for (const [k, v] of Object.entries(t.type)) {
    L.push(`  --fs-${k}: ${px(v.size)}; --tr-${k}: ${v.tracking}; --lh-${k}: ${v.leading};`);
  }
  L.push('');
  L.push(`  /* space */`);
  L.push('  ' + t.space.map((n) => `--sp-${n}: ${px(n)};`).join(' '));
  L.push('');
  L.push('  /* radius */');
  L.push(`  --radius-xs: ${px(t.radius.xs)}; --radius-sm: ${px(t.radius.sm)}; --radius: ${px(t.radius.md)}; --radius-lg: ${px(t.radius.lg)}; --radius-pill: ${px(t.radius.pill)};`);
  L.push('');
  L.push('  /* motion · ui tier — nothing over 300ms, no animation on keyboard actions */');
  const u = t.motion.ui;
  L.push(`  --dur-press: ${ms(u.press)}; --dur-fast: ${ms(u.fast)}; --dur-base: ${ms(u.base)}; --dur-slow: ${ms(u.slow)};`);
  L.push(`  --ease-out: ${u['ease-out']};`);
  L.push(`  --ease-in-out: ${u['ease-in-out']};`);
  L.push(`  --ease-drawer: ${u['ease-drawer']};`);
  L.push(`  --stagger: ${ms(u.stagger)}; --stagger-max: ${u['stagger-max']};`);
  if (includeNarrative) {
    const n = t.motion.narrative;
    L.push('  /* motion · narrative tier — reveals on reading surfaces */');
    L.push(`  --nar-fast: ${ms(n.fast)}; --nar-base: ${ms(n.base)}; --nar-slow: ${ms(n.slow)};`);
    L.push(`  --nar-ease: ${n.ease};`);
    L.push(`  --nar-ease-out: ${n['ease-out']};`);
    L.push(`  --nar-stagger: ${ms(n.stagger)}; --nar-stagger-max: ${n['stagger-max']};`);
  }
  L.push('');
  L.push('  /* status — reserved for state, never a series, never a mark, never themed */');
  L.push(`  --good: ${t.status.good};`);
  L.push(`  --warning: ${t.status.warning};`);
  L.push(`  --serious: ${t.status.serious};`);
  L.push(`  --critical: ${t.status.critical};`);
  return L.join('\n');
}

function modeBlock(t, mode) {
  const L = [];
  L.push(`  color-scheme: ${mode};`);
  t.series[mode].forEach((h, i) => L.push(`  --series-${i + 1}: ${h};`));
  t.sequential[mode].forEach((h, i) => L.push(`  --seq-${i + 1}: ${h};`));
  t.diverging[mode].forEach((h, i) => L.push(`  --div-${i + 1}: ${h};`));
  return L.join('\n');
}

function skinRoles(c) {
  const order = ['plane', 'surface-1', 'surface-2', 'surface-3', 'text-primary', 'text-secondary', 'text-muted', 'grid', 'axis', 'border', 'border-strong', 'hairline', 'accent', 'accent-solid', 'accent-ink', 'shadow', 'glow', 'hero-glow'];
  return order.map((r) => `  --${r}: ${c[r]};`).join('\n');
}

function densityBlock(skin) {
  const d = skin.density;
  const L = [];
  L.push(`  --radius: ${px(d.radius)}; --radius-sm: ${px(d['radius-sm'])};`);
  L.push(`  --pad-card: ${d['pad-card']}; --gap-grid: ${d['gap-grid']}; --fig-scale: ${d['fig-scale']}; --sec-space: ${d['sec-space']}; --tracking-h: ${d['tracking-h']};`);
  L.push(`  --display: var(--${skin.display}); --figure: var(--${skin.figure});`);
  return L.join('\n');
}

const header = (what) => `${START} — ${what}. Source: design/tokens.yaml · rebuild: npm run design. Hand edits here are overwritten and fail test/design.test.js. */`;

/** The dashboard's token layer: base roles, both modes, every skin × mode. */
export function renderDashboardCss(t) {
  const L = [];
  L.push(header('TokenFlow design tokens for the dashboard and the offline snapshot'));
  L.push(':root {');
  L.push(rootBlock(t));
  L.push('}');
  L.push('');
  L.push('/* series / sequential / diverging steps belong to the MODE, never the skin */');
  L.push(`:root, :root[data-mode='dark'] {\n${modeBlock(t, 'dark')}\n}`);
  L.push(`:root[data-mode='light'] {\n${modeBlock(t, 'light')}\n}`);
  L.push('');
  for (const [id, skin] of Object.entries(t.skins)) {
    L.push(`/* skin: ${id} — ${skin.note} */`);
    const sel = skin.default ? `:root, :root[data-skin='${id}']` : `:root[data-skin='${id}']`;
    L.push(`${sel} {\n${skinRoles(skin.dark)}\n${densityBlock(skin)}\n}`);
    L.push(`:root[data-skin='${id}'][data-mode='light'] {\n${skinRoles(skin.light)}\n}`);
    L.push('');
  }
  L.push(END);
  return L.join('\n');
}

/** The landing page's token layer: one world, one mode, self-hosted faces. */
export function renderSiteCss(t) {
  const l = t.landing;
  const skin = t.skins[l.world];
  const c = skin[l.mode];
  const L = [];
  L.push(header('TokenFlow design tokens for the landing page (single world)'));
  for (const [role, f] of Object.entries(l.fonts)) {
    for (const w of f.weights) {
      L.push(`@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url('fonts/${f.file}-${w}.woff2') format('woff2'); }`);
    }
    void role;
  }
  L.push('');
  L.push(':root {');
  L.push(rootBlock(t));
  L.push('');
  L.push(`  --l-display: '${l.fonts.display.family}', var(--${l.fonts.display.fallback}); --l-body: '${l.fonts.body.family}', var(--${l.fonts.body.fallback}); --l-mono: '${l.fonts.mono.family}', var(--${l.fonts.mono.fallback});`);
  L.push(`  --l-tracking-display: ${l.fonts.display.tracking};`);
  L.push('');
  L.push(modeBlock(t, l.mode));
  L.push('');
  L.push(skinRoles(c));
  L.push(densityBlock(skin));
  L.push('}');
  L.push(END);
  return L.join('\n');
}

/** The menu bar's constants: the default skin in both modes, resolved by appearance. */
export function renderSwift(t) {
  const skinId = Object.entries(t.skins).find(([, s]) => s.default)?.[0] || Object.keys(t.skins)[0];
  const skin = t.skins[skinId];
  const dyn = (role) => `Dyn(dark: "${skin.dark[role]}", light: "${skin.light[role]}")`;
  const arr = (xs) => `[${xs.map((h) => `"${h}"`).join(', ')}]`;
  const L = [];
  L.push('// @generated by scripts/design-build.js from design/tokens.yaml — do not edit.');
  L.push(`// Skin: ${skinId} (${skin.note}). The menu bar follows the system appearance,`);
  L.push('// so every role is a dark/light pair resolved at draw time.');
  L.push('import SwiftUI');
  L.push('import AppKit');
  L.push('');
  L.push('enum DesignTokens {');
  L.push(`    static let version = ${t.version}`);
  L.push('');
  L.push('    struct Dyn {');
  L.push('        let dark: String');
  L.push('        let light: String');
  L.push('        /// Follows the current appearance, including live switching.');
  L.push('        var color: Color {');
  L.push('            Color(nsColor: NSColor(name: nil) { appearance in');
  L.push('                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua');
  L.push('                    ? NSColor(dkHex: self.dark) : NSColor(dkHex: self.light)');
  L.push('            })');
  L.push('        }');
  L.push('        func resolved(_ scheme: ColorScheme) -> Color {');
  L.push('            Color(nsColor: NSColor(dkHex: scheme == .dark ? dark : light))');
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    // surfaces and ink');
  for (const role of ['plane', 'surface-1', 'surface-2', 'surface-3', 'text-primary', 'text-secondary', 'text-muted', 'grid', 'axis', 'accent', 'accent-solid', 'accent-ink']) {
    const name = role.replace(/-(\w)/g, (_, ch) => ch.toUpperCase());
    L.push(`    static let ${name} = ${dyn(role)}`);
  }
  L.push('');
  L.push('    // status — reserved for state, never a series, never a mark');
  for (const [k, v] of Object.entries(t.status)) if (typeof v === 'string') L.push(`    static let ${k} = Color(nsColor: NSColor(dkHex: "${v}"))`);
  L.push('');
  L.push('    // categorical series, fixed order, assigned by entity');
  L.push(`    static let seriesDark: [String] = ${arr(t.series.dark)}`);
  L.push(`    static let seriesLight: [String] = ${arr(t.series.light)}`);
  L.push('    static func series(_ index: Int, _ scheme: ColorScheme) -> Color {');
  L.push('        let steps = scheme == .dark ? seriesDark : seriesLight');
  L.push('        return Color(nsColor: NSColor(dkHex: steps[index % steps.count]))');
  L.push('    }');
  L.push('    /// Appearance-following series step, for views that do not read a ColorScheme.');
  L.push('    static func series(_ index: Int) -> Color {');
  L.push('        Dyn(dark: seriesDark[index % seriesDark.count], light: seriesLight[index % seriesLight.count]).color');
  L.push('    }');
  L.push('');
  L.push('    /// Raw status hexes for AppKit call sites (the status item title) that need an NSColor.');
  L.push('    enum StatusHex {');
  for (const [k, v] of Object.entries(t.status)) if (typeof v === 'string') L.push(`        static let ${k} = "${v}"`);
  L.push('    }');
  L.push(`    static let sequentialDark: [String] = ${arr(t.sequential.dark)}`);
  L.push(`    static let sequentialLight: [String] = ${arr(t.sequential.light)}`);
  L.push('');
  L.push('    // shape and space');
  L.push(`    static let radius: CGFloat = ${skin.density.radius}`);
  L.push(`    static let radiusSm: CGFloat = ${skin.density['radius-sm']}`);
  L.push(`    static let space: [CGFloat] = [${t.space.join(', ')}]`);
  L.push('');
  L.push('    // motion · ui tier (seconds)');
  const sec = (v) => (parseInt(v, 10) / 1000).toFixed(3);
  L.push(`    static let durPress: Double = ${sec(t.motion.ui.press)}`);
  L.push(`    static let durFast: Double = ${sec(t.motion.ui.fast)}`);
  L.push(`    static let durBase: Double = ${sec(t.motion.ui.base)}`);
  L.push(`    static let durSlow: Double = ${sec(t.motion.ui.slow)}`);
  L.push('');
  L.push('    // type scale (points)');
  for (const [k, v] of Object.entries(t.type)) L.push(`    static let fs${k[0].toUpperCase()}${k.slice(1)}: CGFloat = ${v.size}`);
  L.push('}');
  L.push('');
  L.push('extension NSColor {');
  L.push('    /// "#rrggbb" → NSColor in sRGB. A malformed token is a build error upstream, so this never guesses.');
  L.push('    convenience init(dkHex: String) {');
  L.push('        var s = dkHex.trimmingCharacters(in: .whitespaces)');
  L.push('        if s.hasPrefix("#") { s.removeFirst() }');
  L.push('        let v = UInt32(s, radix: 16) ?? 0');
  L.push('        self.init(srgbRed: CGFloat((v >> 16) & 0xff) / 255,');
  L.push('                  green: CGFloat((v >> 8) & 0xff) / 255,');
  L.push('                  blue: CGFloat(v & 0xff) / 255,');
  L.push('                  alpha: 1)');
  L.push('    }');
  L.push('}');
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------- assembly ---

export function loadTokens(file = TOKENS_FILE) {
  return parseYaml(fs.readFileSync(file, 'utf8'));
}

/** Replace the generated block in a stylesheet; the rest of the file is hand-authored and untouched. */
export function splice(existing, block, label) {
  const a = existing.indexOf(START);
  const b = existing.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`${label}: markers not found. Add a line "${START} */" and a line "${END}" where the tokens should live.`);
  }
  return existing.slice(0, a) + block + existing.slice(b + END.length);
}

export function compile(t = loadTokens()) {
  const gates = runGates(t);
  const outputs = {
    dashboard: renderDashboardCss(t),
    site: renderSiteCss(t),
    swift: renderSwift(t),
  };
  return { tokens: t, gates, outputs };
}

/** What each target file would contain after compile. */
export function materialize(outputs, targets = TARGETS) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    dashboard: { file: targets.dashboard, next: splice(read(targets.dashboard), outputs.dashboard, 'src/ui/styles.css') },
    site: { file: targets.site, next: splice(read(targets.site), outputs.site, 'site/styles.css') },
    swift: { file: targets.swift, next: outputs.swift },
  };
}

function main(argv) {
  const check = argv.includes('--check');
  const { gates, outputs } = compile();
  for (const r of gates.report) console.log(`  · ${r}`);
  for (const w of gates.warnings) console.log(`  ! ${w}`);
  if (gates.failures.length) {
    console.error(`\n${gates.failures.length} gate failure(s):`);
    for (const f of gates.failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  const files = materialize(outputs);
  let stale = 0;
  for (const { file, next } of Object.values(files)) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur === next) continue;
    stale++;
    if (check) console.error(`  ✗ ${path.relative(ROOT, file)} is out of date with design/tokens.yaml`);
    else { fs.writeFileSync(file, next); console.log(`  ✓ wrote ${path.relative(ROOT, file)}`); }
  }
  if (check) {
    if (stale) { console.error('\nrun `npm run design` and commit the result'); process.exit(1); }
    console.log(`\n✓ design tokens: gates pass, ${Object.keys(files).length} targets current`);
  } else if (!stale) {
    console.log(`\n✓ design tokens: gates pass, nothing to write`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

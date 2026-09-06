/**
 * A branch receipt as a self-contained SVG card — shaped for a Slack drop or
 * a PR-comment attachment, the way the landing page's receipt figure looks.
 *
 * Every colour comes from design/tokens.yaml, read through the project's own
 * YAML parser at render time: nothing here hardcodes a hex value. No external
 * fonts (the system stack from tokens.yaml, with its own fallbacks) and no
 * scripts, so the file opens anywhere and prints anywhere.
 *
 * PNG is an optional second step: a local headless Chromium/Chrome takes a
 * screenshot of the SVG. Nothing is ever downloaded — when no local browser
 * is found, the SVG already on disk is the deliverable and the caller is told
 * so in one line.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseYaml } from '../core/yaml.js';
import { usd, pct } from '../core/units.js';

const TOKENS_PATH = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../../design/tokens.yaml');

let tokensCache = null;

/** design/tokens.yaml, parsed once and cached — the single colour source every card reads. */
export function loadDesignTokens() {
  if (!tokensCache) tokensCache = parseYaml(fs.readFileSync(TOKENS_PATH, 'utf8'));
  return tokensCache;
}

/**
 * Resolve the surface / ink / accent / series roles a card needs, for one skin
 * and mode. Falls back to aurora/dark so a bad or missing skin name never
 * throws mid-render.
 * @param {object} tokens parsed design/tokens.yaml
 * @param {string} [skin] aurora | terminal | editorial
 * @param {string} [mode] dark | light
 */
export function resolveTheme(tokens, skin = 'aurora', mode = 'dark') {
  const skins = tokens.skins || {};
  const s = skins[skin] || skins.aurora || Object.values(skins)[0] || {};
  const palette = s[mode] || s.dark || {};
  const series = (tokens.series && tokens.series[mode]) || (tokens.series && tokens.series.dark) || [];
  return {
    surface1: palette['surface-1'],
    surface2: palette['surface-2'],
    surface3: palette['surface-3'],
    textPrimary: palette['text-primary'],
    textSecondary: palette['text-secondary'],
    textMuted: palette['text-muted'],
    accent: palette.accent,
    accentSolid: palette['accent-solid'],
    accentInk: palette['accent-ink'],
    border: palette.border,
    borderStrong: palette['border-strong'],
    // The split bar is the one place a card draws "series" data (context vs
    // work dollars) rather than chrome — the first two categorical steps for
    // this mode, exactly what the landing page's --series-1 / --series-2 are.
    context: series[0] || palette.accent,
    work: series[1] || palette.accent,
    sans: (tokens.fonts && tokens.fonts.sans) || 'system-ui, -apple-system, sans-serif',
    mono: (tokens.fonts && tokens.fonts.mono) || 'ui-monospace, monospace',
  };
}

/** Escape text for use inside SVG element content or a double-quoted attribute. */
export function escapeXml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `v === null|undefined ? 'n/a' : fmt(v)` — the one place "no em dash" is enforced for cards. */
export function orNA(v, fmt) {
  return v === null || v === undefined ? 'n/a' : fmt(v);
}

const times = (v) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`;

/**
 * Render one branch receipt (from `buildReceipts()` / `buildReceiptsForStore`)
 * as a self-contained SVG card.
 * @param {object} b one branch receipt
 * @param {{repo?:string, skin?:string, mode?:string, width?:number, tokens?:object}} [opt]
 */
export function renderReceiptCardSvg(b, opt = {}) {
  const tokens = opt.tokens || loadDesignTokens();
  const theme = resolveTheme(tokens, opt.skin, opt.mode);
  const W0 = 640;
  const H0 = 460;
  const width = opt.width || W0;
  const height = Math.round(width * (H0 / W0));

  const title = b.pr ? `${escapeXml(b.key)} · PR #${b.pr.number}` : escapeXml(b.key);
  const repoLine = opt.repo ? escapeXml(opt.repo) : '';
  const cost = orNA(b.cost, (v) => usd(v));
  const ctxShare = b.contextShare;
  const barX = 16;
  const barW = W0 - barX * 2;
  const ctxPct = ctxShare === null || ctxShare === undefined ? 0.5 : ctxShare;
  const ctxW = Math.max(0, Math.round(barW * ctxPct));
  const workW = Math.max(0, barW - ctxW);

  const modelsLine = b.models && b.models.length
    ? b.models.slice(0, 3).map((m) => `${m.model} ${orNA(m.share, (v) => pct(v, 0, 'n/a'))}`).join(', ')
    : 'n/a';

  const rows = [
    ['Sessions', String(b.sessions ?? 0)],
    ['Turns', String(b.turns ?? 0)],
    ['Subagent share', orNA(b.subagentShare, (v) => pct(v, 0, 'n/a'))],
    ['Models', modelsLine],
    ['Cost per 100 lines', orNA(b.costPer100Lines, (v) => usd(v))],
    ['vs median branch', orNA(b.vsMedian, times)],
  ];

  const caveat = b.pr && b.pr.mergedAt ? 'estimated spend, up to the merge' : 'estimated spend';

  const titleY = repoLine ? 90 : 74;
  const heroY = repoLine ? 150 : 134;
  const barY = heroY + 40;
  const legendY = barY + 26;

  const L = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W0} ${H0}" font-family="${escapeXml(theme.sans)}">`);
  L.push(`<rect x="0.5" y="0.5" width="${W0 - 1}" height="${H0 - 1}" rx="16" fill="${theme.surface1}" stroke="${theme.borderStrong}"/>`);
  L.push(`<rect x="16" y="40" width="40" height="4" rx="2" fill="${theme.accent}"/>`);
  L.push(`<text x="16" y="30" font-size="11.5" letter-spacing="0.08em" fill="${theme.textMuted}">AI COST RECEIPT</text>`);
  if (repoLine) L.push(`<text x="16" y="66" font-size="12.5" fill="${theme.textMuted}">${repoLine}</text>`);
  L.push(`<text x="16" y="${titleY}" font-size="15" fill="${theme.textPrimary}">${title}</text>`);
  L.push(`<text x="16" y="${heroY}" font-size="42" font-family="${escapeXml(theme.mono)}" fill="${theme.textPrimary}">${escapeXml(cost)}</text>`);
  L.push(`<text x="16" y="${heroY + 20}" font-size="12.5" fill="${theme.textMuted}">${escapeXml(caveat)}</text>`);

  L.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" fill="${theme.surface3}"/>`);
  if (ctxW > 0) L.push(`<rect x="${barX}" y="${barY}" width="${ctxW}" height="10" rx="5" fill="${theme.context}"/>`);
  if (workW > 0) L.push(`<rect x="${barX + ctxW}" y="${barY}" width="${workW}" height="10" rx="5" fill="${theme.work}"/>`);
  L.push(`<circle cx="20" cy="${legendY - 4}" r="4" fill="${theme.context}"/>`);
  L.push(`<text x="30" y="${legendY}" font-size="12.5" fill="${theme.textSecondary}">${escapeXml(orNA(ctxShare, (v) => pct(v, 0, 'n/a')))} re-sent context</text>`);
  L.push(`<circle cx="220" cy="${legendY - 4}" r="4" fill="${theme.work}"/>`);
  L.push(`<text x="230" y="${legendY}" font-size="12.5" fill="${theme.textSecondary}">${escapeXml(orNA(ctxShare, (v) => pct(1 - v, 0, 'n/a')))} fresh work</text>`);

  let y = legendY + 34;
  const rowH = 24;
  for (const [label, value] of rows) {
    L.push(`<text x="16" y="${y}" font-size="13" fill="${theme.textMuted}">${escapeXml(label)}</text>`);
    L.push(`<text x="${W0 - 16}" y="${y}" text-anchor="end" font-family="${escapeXml(theme.mono)}" font-size="13" fill="${theme.textPrimary}">${escapeXml(value)}</text>`);
    y += rowH;
  }
  L.push(`<line x1="16" y1="${y + 6}" x2="${W0 - 16}" y2="${y + 6}" stroke="${theme.border}"/>`);
  L.push(`<text x="16" y="${y + 26}" font-size="11.5" fill="${theme.textMuted}">No prompt or code content was read. Estimated locally from the session logs on this machine.</text>`);
  L.push('</svg>');
  return L.join('');
}

const DEFAULT_CHROMIUM_CANDIDATES = [
  '/opt/homebrew/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chromium',
  'google-chrome',
];

/**
 * Locate a local Chromium/Chrome binary. Absolute candidates are checked
 * directly; bare names are resolved against PATH. Never downloads anything.
 * @param {{candidates?:string[], PATH?:string}} [opt]
 * @returns {string|null}
 */
export function findChromiumBinary(opt = {}) {
  const candidates = opt.candidates || DEFAULT_CHROMIUM_CANDIDATES;
  const dirs = String(opt.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    for (const d of dirs) {
      const full = path.join(d, c);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Rasterize an SVG file to PNG via a local, headless Chromium/Chrome. Never
 * fetches anything: when no local browser is found, the SVG already on disk
 * is the deliverable and the message says so.
 * @param {string} svgFile
 * @param {string} pngFile
 * @param {{width?:number, height?:number, candidates?:string[], PATH?:string}} [opt]
 * @returns {{ok:boolean, message?:string}}
 */
export function renderSvgToPng(svgFile, pngFile, opt = {}) {
  const bin = findChromiumBinary(opt);
  if (!bin) {
    return { ok: false, message: `PNG needs a local Chromium or Chrome install; wrote the SVG instead: ${svgFile}` };
  }
  const width = opt.width || 640;
  const height = opt.height || 460;
  execFileSync(bin, [
    '--headless=new',
    `--screenshot=${path.resolve(pngFile)}`,
    `--window-size=${width},${height}`,
    `file://${path.resolve(svgFile)}`,
  ], { stdio: 'ignore' });
  return { ok: true };
}

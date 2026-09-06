/**
 * The icon set: 24x24 stroke geometry, drawn at any size, coloured by
 * `currentColor` so a role variable on the parent is the only colour input.
 *
 * The path data is vendored in the Lucide style and shipped as a static asset,
 * exactly like a font file. Nothing is fetched, nothing is installed, and the
 * dashboard still opens from file:// with zero dependencies.
 *
 *   Lucide is licensed under the ISC License.
 *   Copyright (c) 2020, Lucide Contributors
 *   Copyright (c) 2013-2022, Cole Bemis (Feather icons, the original source)
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 *   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 *   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 *   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Every glyph is a list of `d` strings and nothing else: one primitive keeps
 * the renderer four lines long, keeps `innerHTML` out of the file entirely,
 * and makes a malformed path a testable string rather than a silent blank box.
 * Circles are two half arcs, which is what an SVG circle compiles down to.
 *
 * An icon never carries meaning on its own here. It always travels with a text
 * label or with an `aria-label` on the control that owns it, so every SVG is
 * `aria-hidden` and unfocusable: a screen reader must never read the same
 * thing twice.
 */

/** A full circle as two half arcs, so every glyph can stay a list of paths. */
function circle(cx, cy, r) {
  return `M${cx + r} ${cy}a${r} ${r} 0 1 0-${r * 2} 0a${r} ${r} 0 1 0 ${r * 2} 0`;
}

/** A rounded rectangle, corner radius `r`. */
function rect(x, y, w, h, r = 2) {
  return `M${x + r} ${y}h${w - r * 2}a${r} ${r} 0 0 1 ${r} ${r}v${h - r * 2}a${r} ${r} 0 0 1-${r} ${r}h-${w - r * 2}a${r} ${r} 0 0 1-${r}-${r}v-${h - r * 2}a${r} ${r} 0 0 1 ${r}-${r}z`;
}

/** A dot: a round line cap with no length, the way Lucide draws `h.01`. */
function dot(x, y) {
  return `M${x} ${y}h.01`;
}

const CLOCK = [circle(12, 12, 10), 'M12 6v6l4 2'];
const CHART_UP = ['M16 7h6v6', 'm22 7-8.5 8.5-5-5L2 17'];

/**
 * name -> the ordered list of `d` strings that draw it.
 *
 * Where two ideas share a glyph they share the array as well: `time` is a
 * clock because a second, slightly different clock would only wobble.
 */
const PATHS = {
  // ---- navigation: one entry per dashboard view
  overview: [rect(3, 3, 7, 9, 1), rect(14, 3, 7, 5, 1), rect(14, 12, 7, 9, 1), rect(3, 16, 7, 5, 1)],
  receipts: ['M6 2h12v20l-3-2-3 2-3-2-3 2z', 'M9 7h6', 'M9 11h6'],
  tickets: ['M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z', 'M13 5v2', 'M13 11v2', 'M13 17v2'],
  cost: ['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  branches: ['M6 3v12', circle(18, 6, 3), circle(6, 18, 3), 'M18 9a9 9 0 0 1-9 9'],
  compare: ['M8 3 4 7l4 4', 'M4 7h16', 'M16 21l4-4-4-4', 'M20 17H4'],
  anatomy: ['M12 2 2 7l10 5 10-5z', 'm2 17 10 5 10-5', 'm2 12 10 5 10-5'],
  live: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  productivity: CHART_UP,
  rhythm: ['M4 9v6', 'M8 5v14', 'M12 8v8', 'M16 4v16', 'M20 10v4'],
  providers: [rect(2, 4, 20, 7, 2), rect(2, 13, 20, 7, 2), dot(6, 7.5), dot(6, 16.5)],
  models: ['m21 8-9-5-9 5v8l9 5 9-5z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
  interfaces: ['m4 17 6-6-6-6', 'M12 19h8'],
  efficiency: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  cache: ['M21 5a9 3 0 1 0-18 0a9 3 0 1 0 18 0', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  time: CLOCK,
  peaks: ['m8 3 4 8 5-5 5 15H2z'],
  whatif: ['M16 3h5v5', 'M8 3H3v5', 'M12 22v-8.3a4 4 0 0 0-1.2-2.9L3 3', 'm15 9 6-6'],
  explorer: [rect(3, 3, 18, 18, 2), 'M12 3v18', 'M3 9h18', 'M3 15h18'],
  annotations: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  health: ['M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],

  // ---- controls
  search: [circle(11, 11, 8), 'm21 21-4.3-4.3'],
  calendar: ['M8 2v4', 'M16 2v4', rect(3, 4, 18, 18, 2), 'M3 10h18'],
  filter: ['M22 3H2l8 9.5V19l4 2v-8.5z'],
  plus: ['M5 12h14', 'M12 5v14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  refresh: ['M3 12a9 9 0 0 1 15.7-6L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.7 6L3 16', 'M8 16H3v5'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  sun: [circle(12, 12, 4), 'M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm6.3 17.7-1.4 1.4', 'm19.1 4.9-1.4 1.4'],
  'panel-left': [rect(3, 3, 18, 18, 2), 'M9 3v18'],
  keyboard: [rect(2, 5, 20, 14, 2), dot(6, 10), dot(10, 10), dot(14, 10), dot(18, 10), 'M7 15h10'],
  'corner-down-left': ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'more-horizontal': [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  'alert-triangle': ['M10.3 4 2.3 18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z', 'M12 9v4', dot(12, 17)],
  info: [circle(12, 12, 10), 'M12 16v-4', dot(12, 8)],
  clock: CLOCK,
};

/** Every name `icon()` will draw, frozen so a caller cannot mutate the set. */
export const ICON_NAMES = Object.freeze(Object.keys(PATHS).sort());

/** The raw geometry, exported for the test that guards it against typos. */
export const ICON_PATHS = Object.freeze(PATHS);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build one icon.
 *
 * The name is validated before any DOM call, so a typo fails loudly with the
 * bad value in the message instead of rendering an empty 16px hole that nobody
 * notices for six months.
 *
 * @param {string} name one of `ICON_NAMES`
 * @param {{size?:number, strokeWidth?:number, className?:string}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, opts = {}) {
  const paths = Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
  if (!paths) {
    throw new Error(`icon(): unknown icon name ${JSON.stringify(name)}. Known names: ${ICON_NAMES.join(', ')}`);
  }
  const size = Number.isFinite(opts.size) ? opts.size : 16;
  const strokeWidth = Number.isFinite(opts.strokeWidth) ? opts.strokeWidth : 1.75;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `tf-icon${opts.className ? ` ${opts.className}` : ''}`);
  svg.dataset.icon = name;
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

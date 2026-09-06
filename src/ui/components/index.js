/**
 * The single public import path for the component layer.
 *
 *   import { icon, createListbox, attachTooltip } from './components/index.js';
 *
 * Written as an import followed by an export list rather than the shorter
 * `export { x } from './x.js'`. The offline snapshot bundler
 * (src/export/bundler.js) rewrites `import` statements and strips standalone
 * `export { ... };` lines, but it does not understand the combined re-export
 * form: it would drop the `export` keyword and leave `{ icon } from './icons.js';`
 * in the bundle, which is a syntax error, and it would never follow the edge
 * to icons.js at all. The public surface is identical either way.
 *
 * Styling lives in src/ui/styles/components.css. The offline snapshot picks
 * that file up on its own (html-snapshot.js reads the whole styles/ directory),
 * but the dev server does not: it needs the path added to `OWN_STYLES` in
 * src/ui/app.js, next to palette.css and first-run.css.
 */
import { icon, ICON_NAMES } from './icons.js';
import { createPopover } from './popover.js';
import { createListbox } from './listbox.js';
import { createMenu } from './menu.js';
import { attachTooltip } from './tooltip.js';
import { createDateRange } from './daterange.js';

export { icon, ICON_NAMES };
export { createPopover };
export { createListbox };
export { createMenu };
export { attachTooltip };
export { createDateRange };

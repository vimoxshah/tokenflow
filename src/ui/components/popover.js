/**
 * The popover primitive: one floating panel, anchored to a trigger, that never
 * leaves the viewport. Listbox, menu and the date range are all built on it.
 *
 * Split in two on purpose, the same way palette.js is. `computePlacement` is
 * pure arithmetic over plain rectangles, so test/components.test.js can cover
 * flipping and shifting under plain node:test. `createPopover` is the browser
 * half and is never imported by a test.
 *
 * Top layer, two ways. Where the browser has the native `popover` attribute we
 * use it, which buys real top-layer stacking (a popover over a popover is
 * never clipped by an ancestor's `overflow`) and light dismiss for free. Where
 * it does not, the panel is appended to `<body>` and we run our own outside
 * click handler. Both paths position with `position: fixed` and client
 * coordinates from `getBoundingClientRect`, so there is exactly one placement
 * code path to reason about. CSS anchor positioning would delete this file,
 * but it is not broadly available yet.
 */

/**
 * @typedef {{x:number, y:number, width:number, height:number}} Box
 * @typedef {'bottom-start'|'bottom-end'|'top-start'|'top-end'} Placement
 */

/** The gap between the trigger edge and the panel, in px. */
const GAP = 6;
/** How close the panel may come to the viewport edge, in px. */
const MARGIN = 8;

/**
 * Where the panel goes, given a trigger, a panel size and a viewport.
 *
 * Two corrections, in the order a user would expect them:
 *   1. flip, on the cross axis only. A panel that does not fit below moves
 *      above, but only when there is genuinely more room above, so a short
 *      viewport does not make it hop back and forth.
 *   2. shift, on both axes. After flipping, the panel is clamped into the
 *      viewport, which is what stops an end-aligned panel on a trigger at the
 *      left edge from hanging off the screen.
 *
 * The returned `placement` is the placement after flipping, not the one asked
 * for, and `origin` is the matching `transform-origin`: the panel must grow
 * out of the trigger edge it actually sits on.
 *
 * @param {{trigger:Box, panel:{width:number,height:number}, viewport:{width:number,height:number},
 *          placement?:Placement, gap?:number, margin?:number}} args
 * @returns {{x:number, y:number, placement:Placement, origin:string}}
 */
export function computePlacement({ trigger, panel, viewport, placement = 'bottom-start', gap = GAP, margin = MARGIN }) {
  const [askedSide, align] = String(placement).split('-');
  let side = askedSide === 'top' ? 'top' : 'bottom';

  const roomBelow = viewport.height - (trigger.y + trigger.height) - margin;
  const roomAbove = trigger.y - margin;
  const needed = panel.height + gap;
  if (side === 'bottom' && needed > roomBelow && roomAbove > roomBelow) side = 'top';
  else if (side === 'top' && needed > roomAbove && roomBelow > roomAbove) side = 'bottom';

  let y = side === 'bottom' ? trigger.y + trigger.height + gap : trigger.y - panel.height - gap;
  let x = align === 'end' ? trigger.x + trigger.width - panel.width : trigger.x;

  // Shift. The lower clamp is applied last so that a panel larger than the
  // viewport pins to the top-left margin rather than to a negative offset.
  x = Math.max(margin, Math.min(x, viewport.width - panel.width - margin));
  y = Math.max(margin, Math.min(y, viewport.height - panel.height - margin));

  return {
    x,
    y,
    placement: /** @type {Placement} */ (`${side}-${align === 'end' ? 'end' : 'start'}`),
    origin: `${side === 'bottom' ? 'top' : 'bottom'} ${align === 'end' ? 'right' : 'left'}`,
  };
}

/**
 * The one popover that is currently open. Opening a second closes the first,
 * because two anchored panels on screen at once is never what was meant.
 */
let openPopover = null;

/** Feature detection, run once, guarded so this module imports cleanly in node. */
const NATIVE = typeof HTMLElement !== 'undefined'
  && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');

let uid = 0;

/**
 * The close reasons that hand focus back to the trigger: the keyboard closed
 * the panel, so the keyboard must land somewhere it can carry on from. A
 * pointer dismissal ('outside'), a replacement, or a teardown must not, or the
 * page would yank focus off whatever the user just clicked.
 */
const RETURNS_FOCUS = new Set(['escape', 'select']);

/**
 * @typedef {object} PopoverApi
 * @property {(opts?:{focus?:boolean})=>void} open
 * @property {(reason?:string)=>void} close
 * @property {()=>void} toggle
 * @property {()=>boolean} isOpen
 * @property {()=>void} destroy
 * @property {HTMLElement} el the panel element
 */

/**
 * Anchor a floating panel to `trigger`.
 *
 * `render(body, api)` runs on EVERY open, not once at creation, so a panel can
 * never show a stale list. The body is emptied first.
 *
 * `close(reason)` takes a reason because focus should return to the trigger
 * when the keyboard closed the panel ('escape', 'select') and must NOT when a
 * pointer did ('outside'): stealing focus back from whatever the user just
 * clicked is worse than losing it.
 *
 * @param {{trigger:HTMLElement, render:(body:HTMLElement, api:PopoverApi)=>void,
 *          placement?:Placement, onOpen?:()=>void, onClose?:()=>void,
 *          className?:string, matchTriggerWidth?:boolean}} args
 * @returns {PopoverApi}
 */
export function createPopover({ trigger, render, placement = 'bottom-start', onOpen, onClose, className, matchTriggerWidth = false }) {
  const el = document.createElement('div');
  el.className = `tf-popover${className ? ` ${className}` : ''}`;
  el.id = `tf-popover-${++uid}`;
  el.setAttribute('role', 'presentation');
  el.tabIndex = -1;
  if (NATIVE) el.setAttribute('popover', 'manual');
  else el.hidden = true;

  const body = document.createElement('div');
  body.className = 'tf-popover-body';
  el.appendChild(body);

  let open = false;
  let closing = null;

  /** @type {PopoverApi} */
  const api = {
    open: doOpen, close: doClose, toggle, isOpen: () => open, destroy, el,
  };

  function position() {
    if (!open) return;
    const t = trigger.getBoundingClientRect();
    const at = computePlacement({
      trigger: { x: t.left, y: t.top, width: t.width, height: t.height },
      // offsetWidth/offsetHeight, not getBoundingClientRect: the panel is
      // still at scale(.96) on the first open (the `is-open` class lands a
      // frame later) and a client rect includes that transform. Measuring 4%
      // small is enough to get the flip decision wrong and to let a tall panel
      // sit past the viewport margin.
      panel: { width: el.offsetWidth, height: el.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement,
    });
    el.style.left = `${Math.round(at.x)}px`;
    el.style.top = `${Math.round(at.y)}px`;
    el.style.transformOrigin = at.origin;
    el.dataset.placement = at.placement;
  }

  function onDocPointerDown(ev) {
    const target = /** @type {Node} */ (ev.target);
    if (el.contains(target) || trigger.contains(target)) return;
    doClose('outside');
  }

  function onKeyDown(ev) {
    if (ev.key !== 'Escape' || !open) return;
    ev.stopPropagation();
    ev.preventDefault();
    doClose('escape');
  }

  function onViewportChange() {
    position();
  }

  /**
   * The browser can close a native popover on its own (Escape, or a light
   * dismiss we never see). Without this the panel would be gone while
   * `isOpen()` still said true.
   */
  function onToggleEvent(ev) {
    if (/** @type {any} */ (ev).newState === 'closed' && open) doClose('native');
  }

  function doOpen({ focus = false } = {}) {
    if (open) return;
    if (openPopover && openPopover !== api) openPopover.close('replaced');
    open = true;
    openPopover = api;

    if (closing) { clearTimeout(closing); closing = null; }
    body.replaceChildren();
    el.classList.remove('is-open');
    if (!el.isConnected) document.body.appendChild(el);
    if (NATIVE) {
      if (!el.matches(':popover-open')) /** @type {any} */ (el).showPopover();
    } else {
      el.hidden = false;
    }
    if (matchTriggerWidth) el.style.minWidth = `${Math.round(trigger.getBoundingClientRect().width)}px`;
    render(body, api);
    position();

    // The open state class lands on the next frame so the enter transition has
    // a "from" to interpolate out of, in both the native and fallback paths.
    requestAnimationFrame(() => { if (open) el.classList.add('is-open'); });

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange, { passive: true });
    // Scroll does not bubble, so the listener has to capture.
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    el.addEventListener('toggle', onToggleEvent);
    trigger.setAttribute('aria-expanded', 'true');
    if (focus) el.focus();
    if (onOpen) onOpen();
  }

  function doClose(reason = 'api') {
    if (!open) return;
    // Read before any teardown: hidePopover() and an emptied body both move
    // focus, so asking afterwards would always say no.
    const heldFocus = !!(document.activeElement && el.contains(document.activeElement));
    open = false;
    if (openPopover === api) openPopover = null;
    el.classList.remove('is-open');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, { capture: true });
    el.removeEventListener('toggle', onToggleEvent);
    trigger.setAttribute('aria-expanded', 'false');

    // The exit runs on a timer rather than `transitionend`, which never fires
    // when the whole animation is suppressed by prefers-reduced-motion.
    const finish = () => {
      closing = null;
      if (open) return;
      if (NATIVE) {
        if (el.matches(':popover-open')) /** @type {any} */ (el).hidePopover();
      } else {
        el.hidden = true;
      }
      body.replaceChildren();
    };
    if (reason === 'native') finish();
    else closing = setTimeout(finish, 120);

    // Escape and select always hand focus back. Every other reason hands it
    // back only if the panel still had it, which is what separates a
    // programmatic or replaced close (focus is inside, so it must be rescued
    // or it falls to <body> and Tab restarts at the top of the document) from
    // an outside click (focus has already moved to what the user clicked, and
    // taking it away would be theft).
    if (typeof trigger.focus === 'function' && (RETURNS_FOCUS.has(reason) || heldFocus)) trigger.focus();
    if (onClose) onClose();
  }

  function toggle() {
    if (open) doClose('api');
    else doOpen();
  }

  function destroy() {
    doClose('destroy');
    // The trigger belongs to the caller and outlives this popover, so give it
    // back clean. A dead button still advertising aria-expanded tells a screen
    // reader there is a panel to open that nothing can open.
    trigger.removeAttribute('aria-expanded');
    if (closing) { clearTimeout(closing); closing = null; }
    el.remove();
  }

  return api;
}

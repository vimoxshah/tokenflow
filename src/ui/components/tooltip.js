/**
 * Tooltips, with the one rule that decides whether a toolbar feels fast.
 *
 * A first tooltip waits 400ms, because a tooltip that fires on every pointer
 * crossing is noise. But once ANY tooltip is on screen the user has declared
 * they are reading labels, so the next one appears instantly and without an
 * animation. Hover along a row of icon buttons and the text changes under the
 * cursor with no lag at all. Pause for a moment and the group goes cold again,
 * so the next hover is deliberate and waits its 400ms. This is the behaviour
 * every good desktop toolbar has and almost no web app bothers with.
 *
 * One shared element, moved between targets, rather than one per call site.
 * That is what makes the group rule a single module-level boolean instead of
 * coordination between N independent timers.
 */
import { computePlacement } from './popover.js';

/** How long a cold tooltip waits before showing, in ms. */
const DELAY = 400;
/** How long the group stays warm after the last tooltip hides, in ms. */
const WARM = 300;

/** @type {HTMLElement|null} */
let tip = null;
let visible = false;
let warm = false;
let showTimer = null;
let warmTimer = null;
/** @type {HTMLElement|null} */
let owner = null;
/** element -> its live detach(), so a re-attach can undo the previous one. */
const attached = new WeakMap();

function tipEl() {
  if (tip && tip.isConnected) return tip;
  tip = document.createElement('div');
  tip.className = 'tf-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'tf-tooltip';
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

/**
 * Whether `el` already tells assistive tech what it is.
 *
 * If it does, the tooltip is decorative and must be hidden from the
 * accessibility tree, or a screen reader reads the same words twice. If it
 * does not, the tooltip text becomes the accessible name, which is the only
 * thing that makes an icon-only button usable at all.
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function hasAccessibleName(el) {
  if (!el) return false;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return true;
  const by = el.getAttribute('aria-labelledby');
  if (by && by.trim()) return true;
  const title = el.getAttribute('title');
  if (title && title.trim()) return true;
  return !!(el.textContent && el.textContent.trim());
}

function place(target, placement) {
  const el = tipEl();
  const t = target.getBoundingClientRect();
  const at = computePlacement({
    trigger: { x: t.left, y: t.top, width: t.width, height: t.height },
    // The layout box, not a client rect: the bubble is still at scale(.96)
    // when this runs, and a client rect would include that transform.
    panel: { width: el.offsetWidth, height: el.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    placement,
    gap: 6,
    margin: 6,
  });
  el.style.left = `${Math.round(at.x)}px`;
  el.style.top = `${Math.round(at.y)}px`;
  el.style.transformOrigin = at.origin;
  el.dataset.placement = at.placement;
}

function hide() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  unbindEscape();
  if (!visible) return;
  visible = false;
  owner = null;
  const el = tipEl();
  el.classList.remove('is-open');
  el.hidden = true;
  // Stay warm briefly, so moving along a toolbar keeps the zero delay but
  // wandering away and coming back does not.
  warm = true;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => { warm = false; }, WARM);
}

/**
 * Keep the bubble honest about its owner still being on the page.
 *
 * A tooltip hides on pointer, blur, Escape and scroll, and a node that has
 * been removed from the DOM can no longer fire any of them. Re-render a
 * toolbar mid-hover, or remove the button while the 400ms timer is still
 * running, and the bubble is pinned to a rectangle that no longer exists with
 * nothing left that could ever take it down. One property read per frame, and
 * only while something is actually visible.
 */
function watchOwner() {
  if (!visible) return;
  if (owner && !owner.isConnected) { hide(); return; }
  requestAnimationFrame(watchOwner);
}

/**
 * Escape, from wherever focus happens to be.
 *
 * A tooltip is usually opened by HOVER, so its element almost never holds
 * focus, and a keydown bound to that element sees nothing: the key goes to
 * whatever is focused, which is normally `<body>`. One capture-phase listener
 * on the document is the only placement that actually works, and it lives only
 * while a bubble is on screen or a show timer is pending.
 *
 * @param {KeyboardEvent} ev
 */
function onDocEscape(ev) {
  if (ev.key === 'Escape') hide();
}

/** Bind and unbind the document Escape listener with the bubble's lifetime. */
let escapeBound = false;
function bindEscape() {
  if (escapeBound) return;
  document.addEventListener('keydown', onDocEscape, true);
  escapeBound = true;
}
function unbindEscape() {
  if (!escapeBound) return;
  document.removeEventListener('keydown', onDocEscape, true);
  escapeBound = false;
}

function show(target, text, placement) {
  if (!target.isConnected) return;
  bindEscape();
  const el = tipEl();
  el.textContent = text;
  // The words are already on the control (as its own text or its aria-label),
  // so the visual tooltip is a duplicate and stays out of the a11y tree.
  el.setAttribute('aria-hidden', target.hasAttribute('data-tooltip-decorative') ? 'true' : 'false');
  el.hidden = false;
  el.classList.toggle('is-instant', warm);
  visible = true;
  owner = target;
  place(target, placement);
  requestAnimationFrame(() => { if (visible && owner === target) el.classList.add('is-open'); });
  requestAnimationFrame(watchOwner);
}

/**
 * Attach a tooltip to an element.
 *
 * @param {HTMLElement} el
 * @param {string} text
 * @param {{placement?:'bottom-start'|'bottom-end'|'top-start'|'top-end', delay?:number}} [opts]
 * @returns {()=>void} detach
 */
export function attachTooltip(el, text, opts = {}) {
  const placement = opts.placement || 'bottom-start';
  const delay = Number.isFinite(opts.delay) ? opts.delay : DELAY;

  // Re-attaching is what a re-render does, so it has to be idempotent. Without
  // this, a second attach on the same element stacks another six listeners and
  // another capture-phase scroll listener on window, and the stale aria-label
  // from the first attach would win forever.
  const prior = attached.get(el);
  if (prior) prior();

  const named = hasAccessibleName(el);
  if (named) {
    // Decorative: the control already says what it is.
    el.setAttribute('data-tooltip-decorative', 'true');
  } else {
    el.setAttribute('aria-label', text);
  }

  const openNow = () => {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (visible && owner === el) return;
    // Bound here as well as in show(), so Escape also cancels a tooltip that is
    // still counting down rather than only one already on screen.
    bindEscape();
    if (visible || warm) show(el, text, placement);
    else showTimer = setTimeout(() => { showTimer = null; show(el, text, placement); }, delay);
  };
  const closeNow = () => { if (owner === el || showTimer) hide(); };

  el.addEventListener('pointerenter', openNow);
  el.addEventListener('pointerleave', closeNow);
  el.addEventListener('pointerdown', closeNow);
  el.addEventListener('focus', openNow);
  el.addEventListener('blur', closeNow);
  // Scroll does not bubble, so this captures; a tooltip anchored to a rect
  // that just moved is worse than no tooltip.
  window.addEventListener('scroll', closeNow, { capture: true, passive: true });

  function detach() {
    closeNow();
    el.removeEventListener('pointerenter', openNow);
    el.removeEventListener('pointerleave', closeNow);
    el.removeEventListener('pointerdown', closeNow);
    el.removeEventListener('focus', openNow);
    el.removeEventListener('blur', closeNow);
    window.removeEventListener('scroll', closeNow, { capture: true });
    el.removeAttribute('data-tooltip-decorative');
    // Take back only a label this attachment put there. Removing one the
    // caller wrote would strip the control's real name; leaving one we wrote
    // means a screen reader keeps reading the old text after the tooltip is
    // gone.
    if (!named) el.removeAttribute('aria-label');
    if (attached.get(el) === detach) attached.delete(el);
  }

  attached.set(el, detach);
  return detach;
}

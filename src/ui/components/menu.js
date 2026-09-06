/**
 * The action menu: a list of things to do, not a list of things to pick.
 *
 * That distinction is the whole reason this is a separate file from
 * listbox.js. A menu item runs and the panel closes; it has no selected state,
 * no multi-select and no search. The ARIA roles differ for the same reason
 * (`menu` and `menuitem`, not `listbox` and `option`), and a screen reader
 * announces them differently, so sharing one component would have been a lie
 * to assistive tech in order to save fifty lines.
 *
 * Used for the CSV export split, the skin picker, and the row overflow menus.
 */
import { icon } from './icons.js';
import { createPopover } from './popover.js';

/**
 * @typedef {{label:string, icon?:string, kbd?:string, disabled?:boolean, onSelect?:()=>void}} MenuAction
 * @typedef {{separator:true}} MenuSeparator
 * @typedef {MenuAction|MenuSeparator} MenuItem
 */

let uid = 0;

/**
 * Build an action menu on a trigger.
 *
 * @param {{trigger:HTMLElement, items:MenuItem[],
 *          placement?:'bottom-start'|'bottom-end'|'top-start'|'top-end',
 *          label?:string, className?:string}} args
 * @returns {{open:()=>void, close:()=>void, destroy:()=>void}}
 */
export function createMenu({ trigger, items, placement = 'bottom-end', label = 'Actions', className }) {
  const id = ++uid;
  let rows = [];
  let active = -1;

  const pop = createPopover({
    trigger,
    placement,
    className: `tf-menu-popover${className ? ` ${className}` : ''}`,
    render: renderPanel,
    onClose: () => { rows = []; active = -1; },
  });

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  function setActive(next) {
    active = next;
    rows.forEach((row, i) => {
      row.classList.toggle('is-active', i === next);
      row.tabIndex = i === next ? 0 : -1;
    });
    if (next >= 0 && rows[next]) rows[next].focus();
  }

  function move(delta) {
    if (rows.length === 0) return;
    const next = active < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : (active + delta + rows.length) % rows.length;
    setActive(next);
  }

  function run(index) {
    const action = rows[index]?.__action;
    // Close first: an action that swaps the whole view out from under the
    // panel would otherwise leave a floating menu attached to a dead trigger.
    pop.close('select');
    if (typeof action === 'function') action();
  }

  function onKeyDown(ev) {
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); move(1); break;
      case 'ArrowUp': ev.preventDefault(); move(-1); break;
      case 'Home': ev.preventDefault(); setActive(0); break;
      case 'End': ev.preventDefault(); setActive(rows.length - 1); break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (active >= 0) run(active);
        break;
      case 'Tab':
        pop.close('escape');
        break;
      default: break;
    }
  }

  function renderPanel(bodyEl) {
    rows = [];
    const menu = document.createElement('div');
    menu.className = 'tf-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    menu.addEventListener('keydown', onKeyDown);

    (Array.isArray(items) ? items : []).forEach((item, i) => {
      if (item && /** @type {MenuSeparator} */ (item).separator) {
        const sep = document.createElement('div');
        sep.className = 'tf-menu-separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        return;
      }
      const action = /** @type {MenuAction} */ (item);
      const row = document.createElement('div');
      row.className = 'tf-menu-item';
      row.id = `tf-menu-${id}-item-${i}`;
      row.setAttribute('role', 'menuitem');
      row.tabIndex = -1;
      if (action.disabled) {
        row.setAttribute('aria-disabled', 'true');
        row.classList.add('is-disabled');
      }

      const g = document.createElement('span');
      g.className = 'tf-menu-icon';
      if (action.icon) g.appendChild(icon(action.icon, { size: 14 }));
      row.appendChild(g);

      const lab = document.createElement('span');
      lab.className = 'tf-menu-label';
      lab.textContent = action.label;
      row.appendChild(lab);

      if (action.kbd) {
        const k = document.createElement('kbd');
        k.className = 'tf-kbd';
        k.textContent = action.kbd;
        row.appendChild(k);
      }

      if (!action.disabled) {
        const at = rows.length;
        /** @type {any} */ (row).__action = action.onSelect;
        row.addEventListener('pointerenter', () => {
          active = at;
          rows.forEach((r, j) => r.classList.toggle('is-active', j === at));
        });
        row.addEventListener('click', (ev) => { ev.preventDefault(); run(at); });
        rows.push(row);
      }
      menu.appendChild(row);
    });

    bodyEl.appendChild(menu);
    requestAnimationFrame(() => { if (rows.length) setActive(0); });
  }

  // The menu owns its trigger's click, unlike createPopover, whose caller gets
  // a `toggle` to wire up itself. A menu with no exposed toggle and no wired
  // trigger could only ever be opened from code, which is not a menu.
  const onTriggerClick = () => pop.toggle();
  const onTriggerKeyDown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); pop.open(); }
  };
  trigger.addEventListener('click', onTriggerClick);
  trigger.addEventListener('keydown', onTriggerKeyDown);

  return {
    open: () => pop.open(),
    close: () => pop.close('api'),
    destroy() {
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKeyDown);
      // The trigger is the caller's and outlives the menu. pop.destroy()
      // clears aria-expanded; aria-haspopup was set here, so it is cleared
      // here.
      trigger.removeAttribute('aria-haspopup');
      pop.destroy();
    },
  };
}

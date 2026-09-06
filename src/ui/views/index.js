/**
 * The dashboard view registry.
 *
 * A registered view is a whole tab that lives outside app.js: one module in
 * this directory, one stylesheet under src/ui/styles/, and nothing else. app.js
 * merges this list with its built-in tabs and dispatches to it, so adding a tab
 * never means editing app.js — which is what lets several tabs be written at
 * the same time without a merge conflict in one 2600-line file.
 *
 * A view module must NOT import app.js. It receives everything it may use as a
 * ViewContext argument. That keeps the module graph acyclic, which the offline
 * snapshot bundler (src/export/bundler.js) requires.
 *
 * The full contract, including how a view degrades offline, is in
 * docs/ui-views.md.
 */
import * as live from './live.js';
import * as cache from './cache.js';
import * as annotations from './annotations.js';
import * as branches from './branches.js';
import * as anatomy from './anatomy.js';
import * as whatif from './whatif.js';
import * as rhythm from './rhythm.js';
import * as tickets from './tickets.js';

/**
 * Everything a view is allowed to use from the host application.
 *
 * app.js rebuilds this object for every render, and `bundle`, `view`, `filters`
 * and `live` are getters over the live state, so a ctx captured in a closure
 * (a timer, an event handler) never reads a stale value.
 *
 * @typedef {object} ViewContext
 * @property {object} S dashboard state. Read freely; write only fields you own.
 * @property {object} bundle the aggregate bundle this page was loaded with.
 * @property {object} view the computed analytics view for the current filters.
 * @property {object} filters the active filter object (same object as `S.filters`).
 * @property {boolean} snapshot true when running from an offline HTML snapshot.
 * @property {(tag:string, attrs?:object, kids?:any)=>any} el build a DOM element.
 * @property {(title:string, hint:string, body:any, actions?:any)=>any} card
 * @property {(id:string, title:string, hint:string, renderChart:(w:number)=>any, tableSpec?:object, extraActions?:any)=>any} chartCard chart with its mandatory table twin.
 * @property {(label:string, onClick:(ev:any)=>void, cls?:string, id?:string)=>any} btn
 * @property {(label:string, value:string, sub?:any, opt?:object)=>any} kpi
 * @property {(change:number|null, opt?:{goodUp?:boolean})=>any} deltaChip
 * @property {(t:string)=>any} sectionTitle
 * @property {(text:string, detail?:string)=>any} emptyCard
 * @property {(title:string, body:any, foot?:any)=>void} openModal
 * @property {()=>void} closeModal
 * @property {(key:string, value:string)=>void} drillTo filter to one value and re-render.
 * @property {object} fmt the number and date formatters from core/units.js.
 * @property {object} charts namespace import of src/ui/charts.js.
 * @property {(path:string, opt?:object)=>Promise<any>} fetchJson resolves to null in a snapshot.
 * @property {(fn:()=>void, ms:number)=>any} schedule an interval app.js clears for you.
 * @property {(opt?:{recompute?:boolean})=>void} rerender recompute and repaint.
 */

/**
 * One tab. `id`, `label`, `order` and `view` are required; the rest optional.
 *
 * `order` places the tab: the built-in tabs hold 10, 20, 40 … 140, so a view
 * can slot anywhere by picking a number between them. `css` is a path relative
 * to src/ui/ and must point at a single file under src/ui/styles/.
 *
 * @typedef {object} ViewModule
 * @property {string} id unique, and never one of app.js's built-in tab ids.
 * @property {string} label the tab caption.
 * @property {number} order position among all tabs.
 * @property {string} [css] e.g. './styles/live.css'.
 * @property {(ctx: ViewContext) => any} view returns the element for the tab body.
 * @property {(ctx: ViewContext) => void} [onEnter] the tab became active.
 * @property {(ctx: ViewContext) => void} [onLeave] the tab stopped being active.
 */

/**
 * Every registered view, in registration order. app.js sorts by `order`.
 * @type {ViewModule[]}
 */
export const VIEWS = [
  live,
  cache,
  annotations,
  branches,
  anatomy,
  whatif,
  rhythm,
  tickets,
];

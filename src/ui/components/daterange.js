/**
 * One button where a row of chips, two native date inputs and two hour inputs
 * used to be. That row ate the top of every page and still could not say what
 * the current range was in one glance; the button says "Jul 8 to Sep 5, 2026"
 * and opens the rest on demand.
 *
 * The date maths is pure, UTC-only and exported. UTC matters: `new Date('2026-09-06')`
 * is parsed as midnight UTC and then read back in local time, so `.getDate()`
 * returns the 5th anywhere west of Greenwich. Every function here goes through
 * `Date.UTC` and `getUTC*`, which is the same discipline src/analytics uses.
 *
 * The apply model is deliberate. A preset applies immediately, because the
 * click IS the decision. The custom fields do not, because a half-typed
 * "2026-0" would otherwise recompute the whole dashboard on every keystroke.
 * `onChange` fires exactly once, on apply.
 */
import { icon } from './icons.js';
import { createPopover } from './popover.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Preset ids to their canonical spelling.
 *
 * The dashboard already ships quick ranges under the ids `7d`, `30d`, `90d`,
 * `mtd` and `lastmonth` (src/analytics/index.js). This component's contract
 * names them `last7`, `last30`, `last90`, `month` and `lastMonth`. Both are
 * accepted and resolve to identical dates, so a caller can hand over the
 * existing `QUICK_RANGES` list unchanged and the range cannot silently shift
 * by a day during the swap.
 */
const ALIASES = {
  '7d': 'last7',
  '30d': 'last30',
  '90d': 'last90',
  mtd: 'month',
  lastmonth: 'lastMonth',
};

/** @param {string} iso @returns {Date} */
function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** @param {Date} d @returns {string} */
function toISO(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** @param {string} iso @param {number} n @returns {string} */
function shift(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

/**
 * The dates a preset id means, relative to `today`.
 *
 * `all` resolves to `{from: null, to: null}`: "all data" is not a pair of
 * dates, it is the absence of a bound, and the analytics layer already reads a
 * null bound as the dataset's own coverage. Returning today's date for it
 * would quietly clamp the range to whatever day the page was opened.
 *
 * An id that names no preset returns null rather than falling back to a range.
 * `custom` is the case that matters: it is a real entry in the shipped quick
 * range list and it has no computable dates, so a caller iterating its own
 * presets can skip it instead of being handed a wrong answer.
 *
 * @param {string} id
 * @param {string} today a 'YYYY-MM-DD' date
 * @returns {{from:string|null, to:string|null}|null}
 */
export function presetRange(id, today) {
  const key = Object.prototype.hasOwnProperty.call(ALIASES, id) ? ALIASES[id] : id;
  const to = String(today);
  switch (key) {
    case 'today': return { from: to, to };
    case 'yesterday': return { from: shift(to, -1), to: shift(to, -1) };
    case 'last7': return { from: shift(to, -6), to };
    case 'last30': return { from: shift(to, -29), to };
    case 'last90': return { from: shift(to, -89), to };
    case 'month': return { from: `${to.slice(0, 7)}-01`, to };
    case 'lastMonth': {
      const end = shift(`${to.slice(0, 7)}-01`, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case 'all': return { from: null, to: null };
    default: return null;
  }
}

/**
 * The id of the preset whose dates equal the given range, or null when the
 * range is genuinely custom. This is what marks a row `aria-current`.
 *
 * An absent bound counts as null, so an unset range matches the `all` preset
 * rather than matching nothing.
 *
 * @param {{from?:string|null, to?:string|null}} range
 * @param {{id:string, label:string}[]} presets
 * @param {string} today
 * @returns {string|null}
 */
export function matchPreset(range, presets, today) {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  for (const p of Array.isArray(presets) ? presets : []) {
    const r = presetRange(p.id, today);
    if (r && r.from === from && r.to === to) return p.id;
  }
  return null;
}

/**
 * The trigger's text. Same year collapses to one year label ("Jul 8 to Sep 5,
 * 2026"); a range that crosses New Year spells both out, because "Dec 28 to
 * Jan 4, 2026" would be a lie about the start.
 *
 * One open bound is a real filter, not an absent one: "everything since the
 * migration" is a From with no To, and the analytics layer honours it by
 * reading the missing bound as the dataset's own edge. It therefore has to say
 * "From Jan 1, 2026", never "All time". This control exists so the button says
 * what the range is in one glance, and "All time" over a filtered dashboard is
 * the exact failure it was built to remove.
 *
 * @param {string|null} from
 * @param {string|null} to
 * @returns {string}
 */
export function formatRangeLabel(from, to) {
  if (!from && !to) return 'All time';
  const day = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const full = (iso) => { const d = parseISO(iso); return `${day(d)}, ${d.getUTCFullYear()}`; };
  if (from && !to) return `From ${full(from)}`;
  if (!from && to) return `Until ${full(to)}`;
  const a = parseISO(from);
  const b = parseISO(to);
  if (from === to) return `${day(a)}, ${a.getUTCFullYear()}`;
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${day(a)} to ${day(b)}, ${b.getUTCFullYear()}`;
  return `${day(a)}, ${a.getUTCFullYear()} to ${day(b)}, ${b.getUTCFullYear()}`;
}

/**
 * The hours suffix, or an empty string when both bounds are open. Kept off the
 * main label so the button still reads as dates first.
 *
 * @param {number|null} hourFrom
 * @param {number|null} hourTo
 * @returns {string}
 */
export function formatHoursLabel(hourFrom, hourTo) {
  const a = Number.isInteger(hourFrom) ? hourFrom : null;
  const b = Number.isInteger(hourTo) ? hourTo : null;
  if (a === null && b === null) return '';
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  if (a !== null && b !== null) return `${hh(a)} to ${hh(b)}`;
  if (a !== null) return `from ${hh(a)}`;
  return `to ${hh(b)}`;
}

/** Today, in UTC, as 'YYYY-MM-DD'. */
function todayISO() {
  return toISO(new Date());
}

/**
 * @typedef {object} DateRangeApi
 * @property {HTMLButtonElement} el the trigger, ready to append
 * @property {(next:{from?:string|null, to?:string|null, hourFrom?:number|null, hourTo?:number|null})=>void} setRange
 * @property {()=>void} destroy
 */

/**
 * Build the date range control.
 *
 * @param {{from?:string|null, to?:string|null, hourFrom?:number|null, hourTo?:number|null,
 *          presets?:{id:string,label:string}[], today?:string,
 *          onChange?:(v:{from:string|null,to:string|null,hourFrom:number|null,hourTo:number|null,presetId:string|null})=>void,
 *          className?:string}} args
 * @returns {DateRangeApi}
 */
export function createDateRange({
  from = null,
  to = null,
  hourFrom = null,
  hourTo = null,
  presets = [],
  today,
  onChange,
  className,
}) {
  const state = { from, to, hourFrom, hourTo };
  const now = () => today || todayISO();

  const el = document.createElement('button');
  el.type = 'button';
  el.className = `tf-trigger tf-daterange-trigger${className ? ` ${className}` : ''}`;
  el.setAttribute('aria-haspopup', 'dialog');
  el.setAttribute('aria-expanded', 'false');
  el.appendChild(icon('calendar', { className: 'tf-trigger-icon' }));

  const text = document.createElement('span');
  text.className = 'tf-trigger-text';
  const hours = document.createElement('span');
  hours.className = 'tf-trigger-hours';
  el.append(text, hours, icon('chevron-down', { className: 'tf-trigger-caret' }));

  function syncTrigger() {
    text.textContent = formatRangeLabel(state.from, state.to);
    const h = formatHoursLabel(state.hourFrom, state.hourTo);
    hours.textContent = h;
    hours.hidden = !h;
    el.setAttribute('aria-label', `Date range: ${text.textContent}${h ? `, hours ${h}` : ''}`);
  }

  function emit(presetId) {
    if (onChange) {
      onChange({
        from: state.from, to: state.to, hourFrom: state.hourFrom, hourTo: state.hourTo, presetId,
      });
    }
  }

  /** Read an hour field: empty means "any", and anything outside 0..23 is refused. */
  function readHour(input) {
    const raw = input.value.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 23) return null;
    return n;
  }

  const pop = createPopover({
    trigger: el,
    placement: 'bottom-start',
    className: 'tf-daterange-popover',
    render: renderPanel,
  });

  function renderPanel(bodyEl, api) {
    const panel = document.createElement('div');
    panel.className = 'tf-daterange';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose a date range');

    // ---- left: presets, one click each
    const left = document.createElement('div');
    left.className = 'tf-daterange-presets';
    const currentId = matchPreset(state, presets, now());
    for (const p of presets) {
      const r = presetRange(p.id, now());
      if (!r) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tf-preset';
      row.textContent = p.label;
      if (p.id === currentId) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        state.from = r.from;
        state.to = r.to;
        syncTrigger();
        api.close('select');
        emit(p.id);
      });
      left.appendChild(row);
    }

    // ---- right: the custom fields, applied on demand
    const right = document.createElement('div');
    right.className = 'tf-daterange-custom';

    const fields = document.createElement('div');
    fields.className = 'tf-field-grid';
    const mkField = (labelText, type, value, extra = {}) => {
      const wrap = document.createElement('label');
      wrap.className = 'tf-field';
      const lab = document.createElement('span');
      lab.className = 'tf-field-label';
      lab.textContent = labelText;
      const input = document.createElement('input');
      input.type = type;
      input.className = 'tf-input';
      input.value = value;
      for (const [k, v] of Object.entries(extra)) input.setAttribute(k, String(v));
      wrap.append(lab, input);
      fields.appendChild(wrap);
      return input;
    };

    const fromInput = mkField('From', 'date', state.from || '');
    const toInput = mkField('To', 'date', state.to || '');
    const hourFromInput = mkField('Hours from', 'number', state.hourFrom === null ? '' : String(state.hourFrom), { min: 0, max: 23, step: 1, placeholder: 'Any', inputmode: 'numeric' });
    const hourToInput = mkField('Hours to', 'number', state.hourTo === null ? '' : String(state.hourTo), { min: 0, max: 23, step: 1, placeholder: 'Any', inputmode: 'numeric' });

    const foot = document.createElement('div');
    foot.className = 'tf-daterange-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tf-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => api.close('escape'));
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'tf-btn tf-btn-primary';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
      const nextFrom = fromInput.value || null;
      const nextTo = toInput.value || null;
      // A backwards range is a typo, not an intent. Swap rather than refuse,
      // so the user is never stuck staring at a disabled button.
      state.from = nextFrom && nextTo && nextFrom > nextTo ? nextTo : nextFrom;
      state.to = nextFrom && nextTo && nextFrom > nextTo ? nextFrom : nextTo;
      state.hourFrom = readHour(hourFromInput);
      state.hourTo = readHour(hourToInput);
      syncTrigger();
      api.close('select');
      emit(matchPreset(state, presets, now()));
    });
    foot.append(cancel, apply);

    right.append(fields, foot);
    panel.append(left, right);
    bodyEl.appendChild(panel);

    requestAnimationFrame(() => fromInput.focus());
  }

  // Attached once to the panel, not inside render(), so it cannot accumulate.
  // The panel is a role="dialog" appended at the end of <body> with no DOM
  // relationship to its invoker, so Tab past the Apply button walks straight
  // out of the document and leaves the panel open behind it. Escape is already
  // handled by createPopover. This matches listbox and menu.
  pop.el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') pop.close('escape');
  });

  el.addEventListener('click', () => pop.toggle());
  syncTrigger();

  return {
    el,
    setRange(next = {}) {
      if ('from' in next) state.from = next.from ?? null;
      if ('to' in next) state.to = next.to ?? null;
      if ('hourFrom' in next) state.hourFrom = next.hourFrom ?? null;
      if ('hourTo' in next) state.hourTo = next.hourTo ?? null;
      syncTrigger();
    },
    destroy() {
      pop.destroy();
      el.remove();
    },
  };
}

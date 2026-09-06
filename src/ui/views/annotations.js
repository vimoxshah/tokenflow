/**
 * The Annotations tab: mark a calendar day ("switched to Opus 5", "started
 * using subagents") and see it drawn on every daily chart in the dashboard.
 *
 * The list itself lives in annotations.json on this machine (src/core/
 * annotations.js). This view only fetches it, edits it through the API, and
 * calls charts.js's `setAnnotations` so every other tab's chart picks up the
 * current list — see the comment on that function for why a module-level
 * setter is the right shape here rather than a prop app.js would have to
 * thread through.
 */
import { el, setAnnotations } from '../charts.js';

/** @typedef {import('./index.js').ViewContext} ViewContext */

export const id = 'annotations';
export const label = 'Annotations';
export const order = 135;
export const css = './styles/annotations.css';

/** @type {{id:string,date:string,text:string}[]} */
let items = [];

/**
 * @param {ViewContext} ctx
 */
export async function onEnter(ctx) {
  await load(ctx);
}

async function load(ctx) {
  if (ctx.snapshot) {
    items = ctx.bundle.annotations || [];
  } else {
    const res = await ctx.fetchJson('/api/annotations').catch(() => null);
    items = res?.items || [];
  }
  setAnnotations(items);
  ctx.rerender({ recompute: false });
}

/**
 * @param {ViewContext} ctx
 * @returns {HTMLElement}
 */
export function view(ctx) {
  // view() runs on every render, including renders triggered from other tabs
  // before this one's onEnter has ever fired; keep charts.js current either way.
  setAnnotations(items);
  const root = el('div', { class: 'grid' });
  root.appendChild(ctx.sectionTitle('Annotations'));
  root.appendChild(listCard(ctx));
  if (!ctx.snapshot) root.appendChild(formCard(ctx));
  root.appendChild(el('p', {
    class: 'hint',
    text: 'Annotations are drawn on every daily chart. They stay in annotations.json on this machine.',
  }));
  return root;
}

function listCard(ctx) {
  const body = el('div');
  const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!sorted.length) {
    body.appendChild(el('p', { class: 'hint', text: 'No annotations yet.' }));
  } else {
    for (const a of sorted) {
      const row = el('div', { class: 'annotations-row' });
      row.appendChild(el('span', { class: 'annotations-date mono', text: a.date }));
      row.appendChild(el('span', { class: 'annotations-text', text: a.text }));
      if (!ctx.snapshot) {
        row.appendChild(ctx.btn('Remove', () => removeItem(ctx, a.id), 'ghost sm'));
      }
      body.appendChild(row);
    }
  }
  return ctx.card('Marked days', 'Every entry appears as a dashed hairline on every daily chart.', body);
}

function formCard(ctx) {
  const body = el('div', { class: 'annotations-form' });
  const today = ctx.bundle?.meta?.today || '';
  const dateInput = el('input', { class: 'tf-input', type: 'date', value: today, 'aria-label': 'Date' });
  const textInput = el('input', { class: 'tf-input', type: 'text', placeholder: 'e.g. switched to Opus 5', maxlength: '140', 'aria-label': 'Note' });
  const err = el('p', { class: 'hint annotations-error' });

  const addBtn = ctx.btn('Add', async () => {
    err.textContent = '';
    try {
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'add', date: dateInput.value, text: textInput.value }),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) { err.textContent = out.error || 'could not add annotation'; return; }
      textInput.value = '';
      await load(ctx);
    } catch (e) {
      err.textContent = `save failed: ${e.message}`;
    }
  }, 'sm');

  body.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Date' }), dateInput]));
  body.appendChild(el('label', { class: 'fld annotations-note-fld' }, [el('span', { text: 'Note' }), textInput]));
  body.appendChild(addBtn);
  body.appendChild(err);
  return ctx.card('Add annotation', 'Dates are calendar days in the dashboard’s timezone.', body);
}

async function removeItem(ctx, itemId) {
  try {
    const res = await fetch('/api/annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'remove', id: itemId }),
    });
    if (!res.ok) return;
    await load(ctx);
  } catch { /* best effort; the list stays as-is until the next reload */ }
}

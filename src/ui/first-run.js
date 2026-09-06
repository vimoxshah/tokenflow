/**
 * The first-run screen: a one-time modal explaining what TokenFlow read off
 * this machine, the moment a fresh install (or a fresh version) opens the
 * live dashboard.
 *
 * Never shown in a snapshot — app.js only calls `maybeShowFirstRun` when
 * `!SNAPSHOT`, since a saved file has nothing new to report and no
 * `/api/providers` to ask. `/api/providers` itself is optional here too: a
 * failed or slow fetch must never hold up the dialog, so the source rows
 * (built from `bundle.meta.sources`, already in hand) render immediately and
 * the "detected but no data yet" section is appended only if the fetch
 * succeeds.
 *
 * Like palette.js, this module imports nothing from app.js or charts.js —
 * only the leaf formatter module core/units.js, which has no DOM dependency
 * of its own.
 */
import { int, shortDate } from '../core/units.js';

const SEEN_KEY = 'tokenflow-first-run-seen-version';
const OPT_OUT_KEY = 'tokenflow-first-run-opt-out';

/**
 * Whether the screen should show for `appVersion`.
 *
 * "Open the dashboard" marks only THIS version seen — an upgrade to a new
 * appVersion shows it again, since a new version may read new sources.
 * "Do not show again" is a separate, permanent flag that survives upgrades.
 *
 * @param {string} appVersion
 * @returns {boolean}
 */
function shouldShow(appVersion) {
  try {
    if (localStorage.getItem(OPT_OUT_KEY) === '1') return false;
    return localStorage.getItem(SEEN_KEY) !== appVersion;
  } catch {
    // Private mode / file:// — the flag cannot be read. Showing the screen
    // once more costs less than silently hiding it forever by assuming "yes,
    // seen" on a store that cannot say either way.
    return true;
  }
}

function markSeen(appVersion) {
  try { localStorage.setItem(SEEN_KEY, appVersion); } catch { /* private mode / file:// — it may show again next time, which is safe */ }
}

function markOptOut() {
  try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch { /* private mode / file:// — it may show again next time, which is safe */ }
}

/** One plain sentence for a source already in `bundle.meta.sources`. */
function sourceSentence(s) {
  const records = s.records || 0;
  const files = s.files || 0;
  const cov = s.coverage;
  const range = cov && cov.from ? `covering ${shortDate(cov.from)} to ${shortDate(cov.to)}` : 'with no dated coverage yet';
  // The demo generator (and any other source with no backing files on disk)
  // reports records with files:0 — "from 0 files" would read as broken, so
  // the clause is dropped rather than stating a record count with no file.
  const fromFiles = files > 0 ? ` from ${int(files)} file${files === 1 ? '' : 's'}` : '';
  return `${s.id}: ${int(records)} record${records === 1 ? '' : 's'}${fromFiles}, ${range}.`;
}

/** One plain sentence for an adapter /api/providers detected that contributed nothing to `sources`. */
function providerSentence(p) {
  const label = p.name || p.id;
  if (p.available === false) return `${label}: not found on this machine.${p.detail ? ` ${p.detail}` : ''}`;
  if (p.enabled === false) return `${label}: found, but turned off in the current config.`;
  return `${label}: found, but nothing has been read from it yet.`;
}

/**
 * @typedef {object} FirstRunContext
 * @property {(tag:string, attrs?:object, kids?:any)=>HTMLElement} el
 * @property {string} appVersion
 * @property {{id:string,records:number,files:number,coverage:{from:string|null,to:string|null}|null}[]} sources bundle.meta.sources
 * @property {()=>Promise<{providers:object[]}|null>} fetchProviders resolves to null (never rejects) on any failure.
 */

/**
 * Show the first-run modal if it has not been seen for `ctx.appVersion` and
 * the user has not opted out permanently. Call only when `!SNAPSHOT` — this
 * module does not check that itself, so it stays usable from a test with a
 * plain object ctx.
 *
 * @param {FirstRunContext} ctx
 */
export function maybeShowFirstRun(ctx) {
  if (!shouldShow(ctx.appVersion)) return;
  const { el } = ctx;

  const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
  dialog.className = 'first-run-dialog';
  dialog.setAttribute('aria-label', 'What TokenFlow found on this machine');

  dialog.appendChild(el('div', { class: 'd-head' }, [el('h2', { text: 'What TokenFlow found on this machine' })]));

  const body = el('div', { class: 'd-body first-run-body' });
  const list = el('div', { class: 'first-run-list' });
  const sources = ctx.sources || [];
  if (sources.length) {
    for (const s of sources) list.appendChild(el('p', { class: 'first-run-row', text: sourceSentence(s) }));
  } else {
    list.appendChild(el('p', { class: 'first-run-row muted', text: 'No source has read a record yet.' }));
  }
  body.appendChild(list);
  const missingHost = el('div', { class: 'first-run-missing' });
  body.appendChild(missingHost);
  body.appendChild(el('p', { class: 'first-run-closing', text: 'Everything here was read from logs already on this machine. Nothing was sent anywhere.' }));
  dialog.appendChild(body);

  const foot = el('div', { class: 'd-foot' });
  const dismissBtn = el('button', { class: 'btn ghost', text: 'Do not show again' });
  const openBtn = el('button', { class: 'btn primary', text: 'Open the dashboard' });
  foot.appendChild(dismissBtn);
  foot.appendChild(openBtn);
  dialog.appendChild(foot);

  const done = (opt) => {
    if (opt) markOptOut(); else markSeen(ctx.appVersion);
    dialog.close();
  };
  openBtn.addEventListener('click', () => done(false));
  dismissBtn.addEventListener('click', () => done(true));
  // Escape and any other native dismissal count as "seen", not a permanent
  // opt-out — same as clicking "Open the dashboard".
  dialog.addEventListener('cancel', () => markSeen(ctx.appVersion));
  dialog.addEventListener('close', () => dialog.remove());

  document.body.appendChild(dialog);
  dialog.showModal();
  openBtn.focus();

  const sourceIds = new Set(sources.map((s) => s.id));
  ctx.fetchProviders().then((res) => {
    if (!dialog.isConnected || !res || !Array.isArray(res.providers)) return;
    const missing = res.providers.filter((p) => !sourceIds.has(p.id));
    if (!missing.length) return;
    missingHost.appendChild(el('div', { class: 'sec-title', text: 'Detected, but nothing read yet' }));
    for (const p of missing) missingHost.appendChild(el('p', { class: 'first-run-row', text: providerSentence(p) }));
  }).catch(() => { /* never blocks: the dialog already shows what bundle.meta.sources knows */ });
}

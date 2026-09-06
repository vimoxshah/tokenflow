/**
 * Day annotations: a small, user-declared list of dated notes ("switched to
 * Opus 5", "started using subagents") that every daily chart in the dashboard
 * draws as a marker.
 *
 * One flat file, `<paths().root>/annotations.json`, sitting next to
 * config.yaml rather than under data/ — data/ holds ingested and derived
 * state that a refresh rebuilds from source records, while annotations are
 * hand-authored and must survive a `tokenflow refresh --full` or a store
 * rebuild exactly the way config.yaml does. test/demo-isolation.test.js does
 * not assert the store's file set (it only checks that nothing lands under
 * the default home, and that the sandboxed store has a config.yaml), so
 * nothing there constrains this choice either way.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './config.js';
import { readJson, writeJson } from './store.js';

export const ANNOTATIONS_SCHEMA = 1;

/** Sanitized text longer than this is truncated, never rejected. */
const MAX_TEXT_LENGTH = 140;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function annotationsFile() {
  return path.join(paths().root, 'annotations.json');
}

/** True when `date` is a real calendar day in YYYY-MM-DD form (rejects e.g. 2024-02-30). */
function isValidDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Strip ASCII control characters (including DEL) before trimming, so a
 * control character sitting outside the visible text does not leave stray
 * whitespace behind once it's gone. Never HTML-escaped: every render path
 * (the annotations list, the chart label's title) sets textContent, not
 * innerHTML, so raw text is safe to store as-is.
 */
function sanitizeText(text) {
  return String(text ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Read the annotations file. A missing or corrupt file yields an empty list
 * rather than throwing — annotations are optional, and a bad file must never
 * take the dashboard down.
 * @returns {{schema:number, items:{id:string,date:string,text:string}[]}}
 */
export function readAnnotations() {
  const raw = readJson(annotationsFile(), null);
  if (!raw || !Array.isArray(raw.items)) return { schema: ANNOTATIONS_SCHEMA, items: [] };
  return { schema: ANNOTATIONS_SCHEMA, items: raw.items };
}

function saveAnnotations(items) {
  writeJson(annotationsFile(), { schema: ANNOTATIONS_SCHEMA, items });
}

/**
 * Add one annotation. Throws a plain `Error` with a short, user-safe message
 * on invalid input; the caller decides how to surface it (the route answers
 * 400 with it).
 * @param {{date?:string, text?:string}} input
 * @returns {{id:string,date:string,text:string}} the stored item
 */
export function addAnnotation({ date, text } = {}) {
  if (!isValidDate(date)) throw new Error(`invalid date "${date}" — expected YYYY-MM-DD`);
  const clean = sanitizeText(text).slice(0, MAX_TEXT_LENGTH);
  if (!clean) throw new Error('text is required');
  const item = { id: randomUUID(), date, text: clean };
  const { items } = readAnnotations();
  items.push(item);
  saveAnnotations(items);
  return item;
}

/**
 * Remove one annotation by id. Idempotent: removing an id that is already
 * gone is not an error, it just reports nothing was removed.
 * @param {string} id
 * @returns {boolean} whether an item was actually removed
 */
export function removeAnnotation(id) {
  if (!id || typeof id !== 'string') throw new Error('id is required');
  const { items } = readAnnotations();
  const next = items.filter((it) => it.id !== id);
  const removed = next.length !== items.length;
  if (removed) saveAnnotations(next);
  return removed;
}

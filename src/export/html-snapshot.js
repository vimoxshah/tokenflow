/**
 * Self-contained HTML snapshot.
 *
 * One file: inlined CSS, an inlined bundle of the same analytics + chart code
 * the live dashboard uses, and the data bundle embedded as JSON. It opens from
 * a file:// URL with no server, no network and no build step, which makes it
 * the thing you can archive, attach, or hand to someone else.
 *
 * The ↻ Refresh button is hidden in a snapshot (there is nothing to re-read),
 * and a bounded sample of request-level records is embedded so the Data
 * Explorer and CSV export still work offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bundle } from './bundler.js';
import { buildBundle, rootDir } from '../core/bundle.js';
import { Store } from '../core/store.js';
import { loadConfig } from '../core/config.js';

function candidatePorts() {
  let configured = null;
  try { configured = loadConfig().ui?.port || null; } catch { configured = null; }
  return [...new Set([configured, 7799, 7800, 8799].filter(Boolean))];
}

export function buildSnapshot({ maxRecords = 20000, title = 'Tokenflow' } = {}) {
  const ROOT = rootDir();
  const css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = bundle(path.join(ROOT, 'src', 'ui', 'app.js'), { root: ROOT });
  // A snapshot that does not parse is worse than a failed export, so check the
  // bundle compiles before writing it. `new vm.Script` parses without running.
  try {
    new vm.Script(js, { filename: 'tokenflow-snapshot-bundle.js' });
  } catch (err) {
    throw new Error(`snapshot bundle failed to compile: ${err.message}`);
  }
  const data = buildBundle();

  // Newest records first, capped — an archive should stay a file, not a dump.
  const store = new Store();
  const recs = [];
  store.scanRecords((o) => {
    recs.push(o);
    if (recs.length > maxRecords * 3) {
      recs.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      recs.length = maxRecords;
    }
  });
  recs.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const records = recs.slice(0, maxRecords);

  // NOTE: every replacement below passes a FUNCTION, never a string. A string
  // replacement expands `$&`, `$1` and especially `$'` (the text after the
  // match) — and the code being inlined contains `'$' + n.toFixed(2)`, which
  // would silently splice the rest of the document into the middle of a string
  // literal and produce an unparseable snapshot.
  const dataScript = [
    '<script>',
    `window.__TOKENFLOW_BUNDLE__ = ${safeJson(data)};`,
    `window.__TOKENFLOW_RECORDS__ = ${safeJson(records)};`,
    `window.__TOKENFLOW_SNAPSHOT_AT__ = ${JSON.stringify(new Date().toISOString())};`,
    // Where to look for a live dashboard when this file is opened later: the
    // configured port first, then the usual fallbacks the server tries.
    `window.__TOKENFLOW_PORTS__ = ${JSON.stringify(candidatePorts())};`,
    '</scr' + 'ipt>',
    '<script>',
    js,
    '</scr' + 'ipt>',
  ].join('\n');

  const body = html
    .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`)
    .replace(/<script type="module" src="[^"]*"><\/script>/, () => dataScript)
    .replace('<title>Tokenflow</title>', () => `<title>${escapeHtml(title)}</title>`)
    .replace('loading…', () => 'static snapshot');

  return {
    html: body,
    stats: {
      bytes: Buffer.byteLength(body),
      records: records.length,
      recordsTruncated: recs.length > records.length || records.length === maxRecords,
      cubeRows: data.cube.rows.length,
      sessions: data.sessions.length,
    },
  };
}

/** JSON safe to embed inside a <script> tag. */
function safeJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

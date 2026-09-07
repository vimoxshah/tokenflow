/**
 * The screenshots are build artifacts, and for a whole release they were wrong.
 *
 * The README hero and the landing page's only image showed the previous
 * interface: a filter wall, a two-row tab bar and a typo, all of which had been
 * replaced. Nothing failed, because nothing checked. These tests cannot see
 * whether an image is CURRENT (only a person looking at it can), but they can
 * hold the three things that made it possible to go unnoticed: an image
 * referenced but missing, an image shipped but referenced nowhere, and an image
 * linked without any way to regenerate it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { MEDIA, MEDIA_NOT_SHOT_HERE } from '../scripts/shoot-media.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = path.join(ROOT, 'docs', 'media');
const SURFACES = ['README.md', path.join('site', 'index.html')];

/** Every `docs/media/...` path referenced by a reader-facing surface. */
function referenced() {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const rel of SURFACES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [, file] of text.matchAll(/docs\/media\/([A-Za-z0-9._-]+\.(?:png|svg|jpg|webp))/g)) {
      if (!out.has(file)) out.set(file, []);
      const where = out.get(file);
      if (where && !where.includes(rel)) where.push(rel);
    }
  }
  return out;
}

test('media: every image the README or the site references exists on disk', () => {
  const missing = [];
  for (const [file, where] of referenced()) {
    if (!fs.existsSync(path.join(MEDIA_DIR, file))) missing.push(`${file} (used by ${where.join(', ')})`);
  }
  assert.deepEqual(missing, [], `referenced but not present in docs/media:\n${missing.join('\n')}`);
});

test('media: nothing in docs/media is unused', () => {
  // Four unreferenced screenshots of the old interface sat here for a release.
  // Dead images are not harmless: they are found, linked and believed later.
  const used = new Set(referenced().keys());
  const orphans = fs.readdirSync(MEDIA_DIR)
    .filter((f) => /\.(png|svg|jpg|webp)$/.test(f))
    .filter((f) => !used.has(f));
  assert.deepEqual(orphans, [], `present in docs/media but referenced nowhere:\n${orphans.join('\n')}`);
});

test('media: every referenced image can be regenerated, or says why it cannot', () => {
  const shootable = new Set(MEDIA.map((m) => m.file));
  const exempt = new Set(MEDIA_NOT_SHOT_HERE);
  const unexplained = [...referenced().keys()].filter((f) => !shootable.has(f) && !exempt.has(f));
  assert.deepEqual(
    unexplained,
    [],
    'these are used but neither in MEDIA (so `npm run media` cannot rebuild them) nor in\n'
    + `MEDIA_NOT_SHOT_HERE (so nothing records why):\n${unexplained.join('\n')}`,
  );
});

test('media: the shot list has no duplicate targets', () => {
  const seen = new Set();
  const dupes = [];
  for (const m of MEDIA) {
    if (seen.has(m.file)) dupes.push(m.file);
    seen.add(m.file);
  }
  assert.deepEqual(dupes, [], `two entries would write the same file:\n${dupes.join('\n')}`);
});

test('media: importing the shot script starts no browser and no server', () => {
  // The import at the top of this file is the assertion: a module that spawned
  // anything on import would leave this test run hanging or fail in CI, where
  // there is no Chromium. `main()` is guarded on being the entry point.
  assert.ok(Array.isArray(MEDIA) && MEDIA.length > 0);
  assert.ok(Array.isArray(MEDIA_NOT_SHOT_HERE));
});

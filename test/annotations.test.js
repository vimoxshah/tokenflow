import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotationMarkers } from '../src/ui/charts.js';

/**
 * Day annotations: storage/validation (src/core/annotations.js), the bundle
 * field it feeds (src/core/bundle.js), and the pure marker-position helper
 * charts.js uses to draw them on a daily time-series chart.
 *
 * Each filesystem test gets its own TOKENFLOW_HOME so nothing here can touch
 * a real installation; modules that read it are re-imported with a cache-bust
 * so config paths are re-resolved per test rather than reused from an earlier
 * home.
 */
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-annotations-'));
  const prev = process.env.TOKENFLOW_HOME;
  process.env.TOKENFLOW_HOME = dir;
  const bust = `?t=${Date.now()}${Math.random()}`;
  const mods = {
    annotations: await import(`../src/core/annotations.js${bust}`),
    bundle: await import(`../src/core/bundle.js${bust}`),
  };
  try {
    return await fn(dir, mods);
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME;
    else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function leftoverTmpFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

// --------------------------------------------------------------- read/write --

test('readAnnotations: a missing file yields an empty schema-1 list, not a throw', async () => {
  await withHome(async (dir, m) => {
    const out = m.annotations.readAnnotations();
    assert.deepEqual(out, { schema: 1, items: [] });
    assert.equal(fs.existsSync(path.join(dir, 'annotations.json')), false);
  });
});

test('addAnnotation: stores a valid entry and readAnnotations sees it afterwards', async () => {
  await withHome(async (dir, m) => {
    const item = m.annotations.addAnnotation({ date: '2026-03-14', text: 'switched to Opus 5' });
    assert.match(item.id, /^[0-9a-f-]{36}$/);
    assert.equal(item.date, '2026-03-14');
    assert.equal(item.text, 'switched to Opus 5');

    const out = m.annotations.readAnnotations();
    assert.equal(out.schema, 1);
    assert.deepEqual(out.items, [item]);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
    assert.deepEqual(onDisk, { schema: 1, items: [item] });
  });
});

test('addAnnotation: appends, it does not replace, the existing list', async () => {
  await withHome(async (dir, m) => {
    m.annotations.addAnnotation({ date: '2026-01-01', text: 'first' });
    m.annotations.addAnnotation({ date: '2026-01-02', text: 'second' });
    const out = m.annotations.readAnnotations();
    assert.equal(out.items.length, 2);
    assert.deepEqual(out.items.map((it) => it.text), ['first', 'second']);
  });
});

// ---------------------------------------------------------------- validation --

test('addAnnotation: rejects a malformed or non-existent calendar date', async () => {
  await withHome(async (dir, m) => {
    for (const bad of ['2026-13-01', '2026-02-30', '03-14-2026', '2026/03/14', '', undefined, null, 'not-a-date']) {
      assert.throws(() => m.annotations.addAnnotation({ date: bad, text: 'x' }), /invalid date/);
    }
  });
});

test('addAnnotation: rejects text that is empty once sanitized', async () => {
  await withHome(async (dir, m) => {
    for (const bad of ['', '   ', '\x00\x01\x02', undefined]) {
      assert.throws(() => m.annotations.addAnnotation({ date: '2026-03-14', text: bad }), /text is required/);
    }
  });
});

test('addAnnotation: trims, strips control characters, and caps at 140 characters', async () => {
  await withHome(async (dir, m) => {
    const item = m.annotations.addAnnotation({ date: '2026-03-14', text: '  \x07hello\x07  ' });
    assert.equal(item.text, 'hello', 'control chars gone and no residual whitespace from them');

    const long = 'a'.repeat(200);
    const capped = m.annotations.addAnnotation({ date: '2026-03-15', text: long });
    assert.equal(capped.text.length, 140);
    assert.equal(capped.text, 'a'.repeat(140));
  });
});

// -------------------------------------------------------------------- remove --

test('removeAnnotation: removes an existing id and is idempotent for one that is gone', async () => {
  await withHome(async (dir, m) => {
    const a = m.annotations.addAnnotation({ date: '2026-03-14', text: 'keep' });
    const b = m.annotations.addAnnotation({ date: '2026-03-15', text: 'drop' });

    assert.equal(m.annotations.removeAnnotation(b.id), true);
    assert.deepEqual(m.annotations.readAnnotations().items.map((it) => it.id), [a.id]);

    assert.equal(m.annotations.removeAnnotation(b.id), false, 'removing it again is a no-op, not an error');
  });
});

test('removeAnnotation: rejects a missing or invalid id', async () => {
  await withHome(async (dir, m) => {
    assert.throws(() => m.annotations.removeAnnotation(undefined), /id is required/);
    assert.throws(() => m.annotations.removeAnnotation(''), /id is required/);
  });
});

// --------------------------------------------------------------------- atomic --

test('add and remove leave no temp file behind', async () => {
  await withHome(async (dir, m) => {
    const a = m.annotations.addAnnotation({ date: '2026-03-14', text: 'one' });
    assert.deepEqual(leftoverTmpFiles(dir), []);
    m.annotations.addAnnotation({ date: '2026-03-15', text: 'two' });
    assert.deepEqual(leftoverTmpFiles(dir), []);
    m.annotations.removeAnnotation(a.id);
    assert.deepEqual(leftoverTmpFiles(dir), []);
  });
});

// --------------------------------------------------------------------- bundle --

test('buildBundle: carries annotations, empty when the file does not exist', async () => {
  await withHome(async (dir, m) => {
    const b = m.bundle.buildBundle({ receipts: false });
    assert.deepEqual(b.annotations, []);
  });
});

test('buildBundle: reflects the annotations file once entries exist', async () => {
  await withHome(async (dir, m) => {
    m.annotations.addAnnotation({ date: '2026-03-14', text: 'switched to Opus 5' });
    const b = m.bundle.buildBundle({ receipts: false });
    assert.equal(b.annotations.length, 1);
    assert.equal(b.annotations[0].text, 'switched to Opus 5');
  });
});

// --------------------------------------------------------- marker positions --

test('annotationMarkers: an in-range date maps to its bucket index on a daily axis', () => {
  const data = [{ key: '2026-03-10' }, { key: '2026-03-11' }, { key: '2026-03-12' }, { key: '2026-03-13' }];
  const anns = [{ id: 'a', date: '2026-03-12', text: 'note' }];
  const marks = annotationMarkers(data, anns);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].index, 2);
  assert.equal(marks[0].annotation.text, 'note');
});

test('annotationMarkers: dates outside the bucket range are dropped', () => {
  const data = [{ key: '2026-03-10' }, { key: '2026-03-11' }, { key: '2026-03-12' }];
  const anns = [
    { id: 'before', date: '2026-03-01', text: 'too early' },
    { id: 'after', date: '2026-04-01', text: 'too late' },
    { id: 'in', date: '2026-03-11', text: 'in range' },
  ];
  const marks = annotationMarkers(data, anns);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].annotation.id, 'in');
});

test('annotationMarkers: a non-daily axis (weekly buckets) yields no markers', () => {
  // Bucket keys are still date-shaped (the Monday each week starts), but
  // spaced 7 days apart — not the calendar-day axis this feature draws on.
  const data = [{ key: '2026-03-02' }, { key: '2026-03-09' }, { key: '2026-03-16' }];
  const anns = [{ id: 'a', date: '2026-03-09', text: 'note' }];
  assert.deepEqual(annotationMarkers(data, anns), []);
});

test('annotationMarkers: a gap in the daily series still lands the marker inside the range', () => {
  // Non-contiguous daily series (e.g. active-days-only): no bucket for the
  // 12th exactly, so the marker falls on the next bucket at or after it.
  const data = [{ key: '2026-03-10' }, { key: '2026-03-11' }, { key: '2026-03-14' }];
  const anns = [{ id: 'a', date: '2026-03-12', text: 'note' }];
  const marks = annotationMarkers(data, anns);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].index, 2, 'falls on the 14th, the next bucket at or after the 12th');
});

test('annotationMarkers: no data or no annotations yields no markers', () => {
  assert.deepEqual(annotationMarkers([], [{ id: 'a', date: '2026-03-12', text: 'x' }]), []);
  assert.deepEqual(annotationMarkers([{ key: '2026-03-10' }], []), []);
  assert.deepEqual(annotationMarkers([{ key: '2026-03-10' }], null), []);
});

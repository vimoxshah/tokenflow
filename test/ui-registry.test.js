/**
 * The two extension points, and the three ways they can quietly stop working.
 *
 * A registered view and a registered route are only useful if nobody has to
 * edit app.js or server.js to add one. Each assertion here stands in for a
 * failure mode that is invisible until someone else's tab is already broken:
 *
 *  - a module in the registry that does not satisfy the contract, or takes an
 *    id another tab already owns;
 *  - a per-view stylesheet that lives on the dev server but never reaches the
 *    saved snapshot, so the tab loses its styles the moment the file is saved;
 *  - a bundler that cannot follow `../charts.js` out of src/ui/views/, which
 *    would break the snapshot for every view but not the dev page;
 *  - a route registry the server ignores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_CSS_DIR = path.join(ROOT, 'src', 'ui', 'styles');

// A throwaway store, set before anything that resolves it is imported. The
// snapshot and the server both read TOKENFLOW_HOME at call time; neither may
// touch a real one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-registry-home-'));
process.env.TOKENFLOW_HOME = HOME;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

/** The built-in tabs, read out of app.js so this test cannot drift from it. */
function builtinTabs() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const block = src.match(/\nconst TABS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'app.js must declare a TABS array');
  const tabs = [...block[1].matchAll(/\['([^']+)',\s*'([^']+)',\s*(\d+)\]/g)]
    .map((m) => ({ id: m[1], label: m[2], order: Number(m[3]) }));
  assert.ok(tabs.length > 0, 'TABS must parse as [id, label, order] triples');
  return tabs;
}

test('view registry: every module satisfies the contract and owns a unique id', async () => {
  const { VIEWS } = await import('../src/ui/views/index.js');
  assert.ok(Array.isArray(VIEWS), 'VIEWS must be an array');
  assert.ok(VIEWS.length > 0, 'VIEWS must not be empty');

  const builtinIds = new Set(builtinTabs().map((t) => t.id));
  const seen = new Set();

  for (const v of VIEWS) {
    const where = `view "${v && v.id}"`;
    assert.equal(typeof v.id, 'string', `${where}: id must be a string`);
    assert.ok(v.id.length, `${where}: id must not be empty`);
    assert.equal(typeof v.label, 'string', `${where}: label must be a string`);
    assert.ok(v.label.length, `${where}: label must not be empty`);
    assert.equal(typeof v.order, 'number', `${where}: order must be a number`);
    assert.ok(Number.isFinite(v.order), `${where}: order must be finite`);
    assert.equal(typeof v.view, 'function', `${where}: view() is required`);

    for (const hook of ['onEnter', 'onLeave']) {
      if (v[hook] !== undefined) {
        assert.equal(typeof v[hook], 'function', `${where}: ${hook} must be a function if present`);
      }
    }

    assert.ok(!seen.has(v.id), `${where}: duplicate view id`);
    assert.ok(!builtinIds.has(v.id), `${where}: id collides with a built-in tab`);
    seen.add(v.id);

    if (v.css !== undefined) {
      assert.equal(typeof v.css, 'string', `${where}: css must be a path string`);
      const abs = path.join(ROOT, 'src', 'ui', v.css.replace(/^\.?\//, ''));
      assert.equal(path.dirname(abs), VIEW_CSS_DIR, `${where}: css must live in src/ui/styles/`);
      assert.ok(fs.existsSync(abs), `${where}: css file ${v.css} does not exist`);
    }
  }
});

test('view registry: Live comes from the registry, not from app.js', async () => {
  const { VIEWS } = await import('../src/ui/views/index.js');
  const live = VIEWS.find((v) => v.id === 'live');
  assert.ok(live, 'the Live tab must be a registered view');
  assert.equal(live.order, 30, 'Live keeps the slot it had in the built-in sequence');
  assert.equal(live.label, 'Live');

  const builtin = builtinTabs();
  assert.ok(!builtin.some((t) => t.id === 'live'), 'app.js must not still declare a live tab');
  // The gap Live slots into must stay open, or it lands somewhere else.
  assert.ok(builtin.some((t) => t.order === 20), 'Receipts keeps order 20');
  assert.ok(builtin.some((t) => t.order === 40), 'Providers keeps order 40');
});

test('snapshot: carries the content of every per-view stylesheet', async () => {
  const { buildSnapshot } = await import('../src/export/html-snapshot.js');
  const { html } = buildSnapshot({ maxRecords: 1 });

  const base = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  assert.ok(html.includes(base), 'the base stylesheet must be inlined');

  const files = fs.readdirSync(VIEW_CSS_DIR).filter((f) => f.endsWith('.css')).sort();
  assert.ok(files.length > 0, 'there must be at least one per-view stylesheet to carry');

  let previous = html.indexOf(base);
  for (const f of files) {
    const css = fs.readFileSync(path.join(VIEW_CSS_DIR, f), 'utf8');
    const at = html.indexOf(css);
    assert.notEqual(at, -1, `src/ui/styles/${f} is missing from the snapshot`);
    // Views must be able to override the base, and each other, in name order.
    assert.ok(at > previous, `src/ui/styles/${f} must be inlined after what precedes it`);
    previous = at;
  }

  // No <link> may survive: a saved file has nothing to fetch it from.
  assert.ok(!/<link rel="stylesheet"/.test(html), 'a snapshot must not link a stylesheet');
});

test('bundler: follows a relative import out of a nested directory', async () => {
  const { bundle } = await import('../src/export/bundler.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bundler-'));
  try {
    fs.mkdirSync(path.join(dir, 'ui', 'views'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'helper.js'), [
      'export const TAG = "helper";',
      'export function greet(n) { return "hi " + n; }',
      '',
    ].join('\n'));
    // The shape this exists for: src/ui/views/<view>.js importing ../charts.js.
    fs.writeFileSync(path.join(dir, 'ui', 'views', 'one.js'), [
      "import { greet, TAG } from '../helper.js';",
      "export const id = 'one';",
      'export function view() { return greet(TAG); }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'ui', 'views', 'index.js'), [
      "import * as one from './one.js';",
      'export const VIEWS = [one];',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'ui', 'app.js'), [
      "import { VIEWS } from './views/index.js';",
      'globalThis.__out = VIEWS.map((v) => v.id + ":" + v.view()).join(",");',
      '',
    ].join('\n'));

    const js = bundle(path.join(dir, 'ui', 'app.js'), { root: dir });
    assert.match(js, /__registry\["ui\/views\/one\.js"\]/, 'the nested module must be registered under its path from the root');
    assert.match(js, /__req\("ui\/helper\.js"\)/, 'the ../ import must be rewritten to the resolved id');

    // Parsing is not enough: the wiring has to actually run.
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename: 'nested-bundle-test.js' });
    assert.equal(sandbox.__out, 'one:hi helper');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bundler: the real app pulls the view registry and its nested imports in', async () => {
  const { bundle } = await import('../src/export/bundler.js');
  const js = bundle(path.join(ROOT, 'src', 'ui', 'app.js'), { root: ROOT });
  assert.match(js, /__registry\["src\/ui\/views\/index\.js"\]/);
  assert.match(js, /__registry\["src\/ui\/views\/live\.js"\]/);
  // live.js reaches back up to ../charts.js; that is the case the snapshot
  // needs and the dev server never exercises.
  const start = js.indexOf('__registry["src/ui/views/live.js"]');
  const end = js.indexOf('__registry[', start + 12);
  assert.match(js.slice(start, end), /__req\("src\/ui\/charts\.js"\)/);
  new vm.Script(js, { filename: 'app-bundle-test.js' }); // must parse
});

test('routes: a registered route is served, and disappears when unregistered', async () => {
  const { ROUTES } = await import('../src/server/routes/index.js');
  const { startServer } = await import('../src/server/server.js');

  const route = {
    method: 'GET',
    path: '/api/registry-probe',
    handler: (req, res, url, ctx) => ctx.json({
      ok: true,
      q: url.searchParams.get('q'),
      port: ctx.port,
      hasConfig: !!ctx.config,
      hasPaths: typeof ctx.paths?.state === 'string',
      root: ctx.root,
    }),
  };
  ROUTES.push(route);

  let s = null;
  try {
    s = await startServer({ port: 0, token: false });
    const boundPort = Number(new URL(s.url).port);
    assert.ok(boundPort > 0, 'port 0 must resolve to a real port');

    const res = await fetch(`${s.url}/api/registry-probe?q=hi`);
    assert.equal(res.status, 200, 'the registered route must be served');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.q, 'hi', 'the handler gets the parsed URL');
    assert.equal(body.port, boundPort, 'ctx.port must be the port actually bound');
    assert.equal(body.hasConfig, true, 'ctx.config must resolve');
    assert.equal(body.hasPaths, true, 'ctx.paths must resolve');
    assert.equal(body.root, ROOT, 'ctx.root must be the repository root');

    // A method that was not registered falls through to the inline chain.
    const wrongMethod = await fetch(`${s.url}/api/registry-probe`, { method: 'POST' });
    assert.equal(wrongMethod.status, 404, 'only the registered method matches');

    // The inline chain still owns everything it owned before.
    const ping = await fetch(`${s.url}/api/ping`);
    assert.equal(ping.status, 200, 'built-in routes must be untouched');

    ROUTES.splice(ROUTES.indexOf(route), 1);
    const gone = await fetch(`${s.url}/api/registry-probe?q=hi`);
    assert.equal(gone.status, 404, 'an unregistered route must stop being served');
  } finally {
    const i = ROUTES.indexOf(route);
    if (i >= 0) ROUTES.splice(i, 1);
    if (s) await s.close();
  }
});

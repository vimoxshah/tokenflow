#!/usr/bin/env node
/**
 * Regenerate every screenshot the README and the landing page use.
 *
 * Why this exists: the images went stale silently. For a whole release the
 * README hero and the site's only screenshot showed the previous interface,
 * complete with a filter wall and a two-row tab bar that no longer existed and
 * a typo that had been fixed. Nothing failed, because nothing checked. A
 * screenshot is a build artifact; it should be rebuildable with one command.
 *
 *   npm run media            rebuild every image in MEDIA
 *   npm run media -- filters rebuild only the ones whose name matches "filters"
 *
 * It drives a real headless browser over the DevTools protocol, with no
 * dependencies: Node ships a WebSocket client, and Chromium is a tool on the
 * machine rather than something this project installs. The data is always a
 * freshly generated synthetic store in a temp directory, never your own, which
 * is why every image carries its own DEMO DATA banner. That banner stays: the
 * product's whole claim is honest numbers, and cropping it out of the marketing
 * would be the one lie in the set.
 *
 * `MEDIA` is the single source of truth. test/media.test.js reads it and fails
 * if the README or the site references an image that is not listed here, so a
 * new screenshot cannot be linked without being shootable.
 *
 * This is NOT idempotent, and do not treat a diff as a signal. The mock
 * provider's corpus is seeded and stable, but its window ends on the day it
 * runs, so the dates and therefore every pixel move whenever you run it. Run it
 * when the interface has changed, look at what comes out, and commit it because
 * you decided to, not because the bytes differ.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = path.join(ROOT, 'docs', 'media');

/** Logical width and height in CSS pixels; every shot is taken at 2x. */
const W = 1440;
const H = 1000;
const SCALE = 2;

/**
 * Every screenshot the README or the landing page embeds.
 *
 * `action` names an interaction to perform before the shot. Without one the
 * page is captured at rest.
 *
 * @type {{file:string, tab:string, skin:'aurora'|'terminal'|'editorial', mode:'dark'|'light', action?:'filters'|'palette', note:string}[]}
 */
export const MEDIA = [
  { file: 'overview-aurora-dark.png', tab: 'overview', skin: 'aurora', mode: 'dark', note: 'README hero' },
  { file: 'receipts-aurora-dark.png', tab: 'receipts', skin: 'aurora', mode: 'dark', note: 'landing page, receipts section' },
  { file: 'tickets-editorial-light.png', tab: 'tickets', skin: 'editorial', mode: 'light', note: 'README, cost per ticket' },
  { file: 'filters-aurora-dark.png', tab: 'overview', skin: 'aurora', mode: 'dark', action: 'filters', note: 'README and landing page, the filter bar carrying a chip' },
  { file: 'palette-aurora-dark.png', tab: 'overview', skin: 'aurora', mode: 'dark', action: 'palette', note: 'README, the command palette' },
];

/**
 * Images that are used but cannot be produced here, so a reader of this file
 * is not left assuming the set is complete.
 *
 * The menu bar popover only renders from a real user session, so its two images
 * come from the Swift target's own off-screen preview path rather than a
 * browser. `architecture-hero.svg` is drawn by hand.
 *
 * @type {string[]}
 */
export const MEDIA_NOT_SHOT_HERE = [
  'menubar-light.png',
  'menubar-dark.png',
  'architecture-hero.svg',
];

/** Where Chromium might be. Override with `CHROME=/path/to/binary`. */
const CHROME_CANDIDATES = [
  process.env.CHROME,
  process.env.CHROMIUM,
  '/opt/homebrew/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * The first Chromium-like binary that exists.
 *
 * @returns {string}
 */
function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error(
    'no Chromium found. Install one (brew install --cask chromium) or set CHROME=/path/to/binary.\n'
    + `Looked in:\n  ${CHROME_CANDIDATES.filter(Boolean).join('\n  ')}`,
  );
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * One CDP session against a fresh headless browser.
 *
 * @param {string} chrome path to the browser binary
 * @param {number} port devtools port
 * @returns {Promise<{send:(m:string,p?:object)=>Promise<any>, ev:(expr:string)=>Promise<any>, clickAt:(x:number,y:number)=>Promise<void>, keys:(key:string,code:string,mods?:number)=>Promise<void>, rectOf:(expr:string)=>Promise<{x:number,y:number}|null>, shoot:(file:string)=>Promise<void>, close:()=>void}>}
 */
async function session(chrome, port) {
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  /** @param {string} p */
  const getJson = (p) => new Promise((resolve, reject) => {
    // Imported lazily so the module stays importable by the test without it.
    import('node:http').then(({ default: http }) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      }).on('error', reject);
    }, reject);
  });

  /** @type {any} */
  let targets = null;
  for (let i = 0; i < 80 && !targets; i++) {
    try { targets = await getJson('/json'); } catch { await sleep(120); }
  }
  if (!targets) { proc.kill(); throw new Error('chromium did not start'); }
  const page = targets.find((/** @type {any} */ t) => t.type === 'page');
  if (!page) { proc.kill(); throw new Error('no page target; attaching to the wrong one makes every DOM query return 0'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  /** @type {Map<number,(m:any)=>void>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ e) => {
    const m = JSON.parse(e.data);
    const fn = m.id ? pending.get(m.id) : null;
    if (fn) { fn(m); pending.delete(m.id); }
  };
  const send = (/** @type {string} */ method, /** @type {object} */ params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const ev = async (/** @type {string} */ expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  const clickAt = async (/** @type {number} */ x, /** @type {number} */ y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(600);
  };
  const keys = async (/** @type {string} */ key, /** @type {string} */ code, /** @type {number} */ mods = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key, code, modifiers: mods });
    }
    await sleep(500);
  };
  const rectOf = async (/** @type {string} */ expr) => {
    const raw = await ev(`(() => { const n = ${expr}; if (!n) return null; const b = n.getBoundingClientRect();`
      + ' return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }); })()');
    return raw ? JSON.parse(raw) : null;
  };
  const shoot = async (/** @type {string} */ file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });

  return { send, ev, clickAt, keys, rectOf, shoot, close: () => { ws.close(); proc.kill(); } };
}

/** Dismiss the first-run explainer, which otherwise covers every shot. */
const DISMISS = '(() => { const d = document.querySelector("dialog[open]");'
  + ' if (d) { const b = [...d.querySelectorAll("button")].find((x) => x.textContent.includes("Open the dashboard")); if (b) b.click(); }'
  + ' return 1; })()';

/**
 * Apply a real filter through the real menu, so the shot cannot show a state
 * the UI could not actually reach.
 *
 * @param {any} s a session
 */
async function driveFilters(s) {
  const add = await s.rectOf("[...document.querySelectorAll('.tf-filterbar button')].find((b) => /Filter/.test(b.textContent))");
  if (!add) throw new Error('the "+ Filter" button is gone; the filter bar markup changed');
  await s.clickAt(add.x, add.y);

  const dim = await s.rectOf("[...document.querySelectorAll('[role=\"menuitem\"]')].find((n) => /Model/.test(n.textContent))");
  if (!dim) throw new Error('no Model row in the dimension menu');
  await s.clickAt(dim.x, dim.y);

  for (const i of [0, 1]) {
    const opt = await s.rectOf(`document.querySelectorAll('[role="option"]')[${i}]`);
    if (opt) await s.clickAt(opt.x, opt.y);
  }
  await s.keys('Escape', 'Escape');

  const chips = Number(await s.ev("document.querySelectorAll('.tf-chip').length"));
  if (!chips) throw new Error('ticking two values produced no chip');
}

/**
 * Open the command palette the way a user does.
 *
 * @param {any} s a session
 */
async function drivePalette(s) {
  await s.keys('k', 'KeyK', 4); // 4 = Meta
  const open = await s.ev("!!document.querySelector('.palette-dialog[open]')");
  if (!open) throw new Error('the palette did not open');
  const rows = Number(await s.ev("document.querySelectorAll('.palette-row').length"));
  if (!rows) throw new Error('the palette opened with no commands');
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const wanted = only.length ? MEDIA.filter((m) => only.some((o) => m.file.includes(o))) : MEDIA;
  if (!wanted.length) {
    console.error(`nothing matches ${only.join(' ')}. Known: ${MEDIA.map((m) => m.file).join(', ')}`);
    process.exit(1);
  }

  const chrome = findChrome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenflow-media-'));
  const port = 7910 + Math.floor(Math.random() * 40);

  console.log(`generating synthetic data in ${home}`);
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'tokenflow.js'), 'demo', '--no-serve', '--days', '60'], {
    env: { ...process.env, TOKENFLOW_HOME: home }, stdio: 'inherit',
  });

  const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'tokenflow.js'), 'dashboard', '--port', String(port), '--no-open'], {
    env: { ...process.env, TOKENFLOW_HOME: home }, stdio: 'ignore',
  });

  let failed = 0;
  try {
    // Wait for the API rather than a fixed sleep.
    const { default: http } = await import('node:http');
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/api/bundle' }, (r) => { r.resume(); resolve(true); })
          .on('error', () => resolve(false));
      });
      if (!up) await sleep(300);
    }
    if (!up) throw new Error(`the dashboard never answered on ${port}`);

    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    for (const [i, m] of wanted.entries()) {
      const s = await session(chrome, 9600 + i);
      try {
        await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/#tab=${m.tab}&skin=${m.skin}&mode=${m.mode}` });
        await sleep(3000);
        await s.ev(DISMISS);
        await sleep(800);
        if (m.action === 'filters') await driveFilters(s);
        if (m.action === 'palette') await drivePalette(s);
        const out = path.join(MEDIA_DIR, m.file);
        await s.shoot(out);
        const kb = Math.round(fs.statSync(out).size / 1024);
        console.log(`  ✓ ${m.file}  ${kb}KB  (${m.note})`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${m.file}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        s.close();
      }
    }
  } finally {
    server.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }

  if (failed) {
    console.error(`\n${failed} shot(s) failed. The images that did write are current; the rest are unchanged.`);
    process.exit(1);
  }
  console.log(`\n${wanted.length} image(s) written to docs/media. Look at them before committing:`
    + ' a screenshot that renders is not the same as a screenshot that is right.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

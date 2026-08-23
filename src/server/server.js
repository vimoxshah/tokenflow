/**
 * The local dashboard server.
 *
 * Binds to 127.0.0.1 by default and serves the UI plus a small JSON API. No
 * outbound network calls are ever made; the "server" exists only so the
 * browser can read local files and trigger a refresh.
 *
 * ES modules are served straight from src/, so the browser imports the very
 * same analytics code the CLI runs. There is no build step and no bundler in
 * the development path.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildBundle, queryRecords, rootDir } from '../core/bundle.js';
import { refresh } from '../core/ingest.js';
import { loadProviders, listProviders } from '../core/registry.js';
import { loadConfig, saveConfig, paths, savePrefs, loadPrefs, DEFAULT_CONFIG, merge } from '../core/config.js';
import { currentStatus } from '../core/live-status.js';
import { PROVIDER_REGIONS, resolveMyLocation } from '../core/geo.js';
import { normalizeLimits } from '../analytics/capacity.js';
import { streamRecordsCsv, exportFilename } from '../export/csv.js';
import { writeJson, readJson } from '../core/store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

export async function startServer({ port = 7799, host = '127.0.0.1', open = false, token = null } = {}) {
  const ROOT = rootDir();
  const UI = path.join(ROOT, 'src', 'ui');
  await loadProviders();
  const authToken = token === false ? null : token || randomBytes(12).toString('base64url');

  let refreshing = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      // Loopback-only + a token on state-changing calls: a page on another
      // origin in the same browser must not be able to poke this API.
      if (req.method !== 'GET' && authToken) {
        const given = url.searchParams.get('token') || req.headers['x-tokenflow-token'];
        const sameSite = !req.headers.origin || req.headers.origin === `http://${host}:${port}` || req.headers.origin === `http://localhost:${port}`;
        if (!sameSite && given !== authToken) return send(res, 403, 'text/plain', 'forbidden');
      }

      if (p === '/' || p === '/index.html') {
        return sendFile(res, path.join(UI, 'index.html'));
      }
      if (p.startsWith('/src/')) {
        const target = path.normalize(path.join(ROOT, p));
        if (!target.startsWith(path.join(ROOT, 'src'))) return send(res, 403, 'text/plain', 'forbidden');
        return sendFile(res, target);
      }

      if (p === '/api/bundle') {
        return json(res, buildBundle());
      }
      if (p === '/api/health') {
        const b = buildBundle();
        return json(res, { health: b.health, meta: b.meta });
      }
      /**
       * A deliberately tiny, read-only, CORS-open liveness probe.
       *
       * It exists so a saved HTML snapshot opened from file:// can tell whether
       * a live dashboard is running on this machine and offer to hand over to
       * it. It answers only "yes, and this is how fresh I am" — no usage data,
       * no config, no paths — and it is GET-only, so no cross-origin page can
       * use it to change anything. The snapshot never POSTs across origins:
       * it navigates to the live UI with ?refresh=1 and lets that same-origin
       * page do the refresh with its own token.
       */
      if (p === '/api/ping') {
        const st = readJson(paths().state, {});
        res.setHeader('access-control-allow-origin', '*');
        return json(res, {
          ok: true,
          app: 'tokenflow',
          port,
          records: st.counters?.records ?? null,
          lastRefresh: st.lastRefresh || null,
        });
      }
      if (p === '/api/providers') {
        const cfg = loadConfig();
        const ctx = { config: cfg, home: process.env.HOME };
        const out = [];
        for (const pr of listProviders()) {
          let det = { available: false, detail: 'detect() failed' };
          try { det = await pr.detect(ctx); } catch (e) { det = { available: false, detail: e.message }; }
          out.push({ ...pr.getMetadata(), ...det, enabled: !cfg.providers.length || cfg.providers.includes(pr.id) });
        }
        return json(res, { providers: out, configured: cfg.providers });
      }
      if (p === '/api/records') {
        return json(res, queryRecords(Object.fromEntries(url.searchParams)));
      }
      /**
       * The live snapshot: the watcher's last write when it is fresh, else a
       * fresh computation. Same shape the menu bar and `tokenflow usage`
       * consume, so the dashboard's Live tab cannot disagree with either.
       */
      if (p === '/api/live') {
        const { status, fromWatch } = currentStatus({ maxAgeMs: 30000 });
        return json(res, { ...status, fromWatch });
      }
      /**
       * Map geography, for the Global activity section. Two layers:
       *  - providerRegions: static vendor datacenter regions per measured
       *    provider (offline public knowledge — never per-request claims)
       *  - myLocation: ONLY when `map.showMyLocation: true` is set in config
       *    (one cached IP lookup of this machine; the IP itself is never
       *    stored). Disabled ⇒ null, and nothing is sent anywhere.
       */
      if (p === '/api/geo') {
        const cfg = loadConfig();
        return json(res, {
          providerRegions: PROVIDER_REGIONS,
          myLocation: await resolveMyLocation({ config: cfg }),
          note: 'regions are vendor-published possibilities, not per-request facts',
        });
      }
      /**
       * Limited config editing from the dashboard: only the limits list and
       * watch preferences may change, both validated before saving. Everything
       * else (providers, sources, identity) stays CLI-managed on purpose.
       */
      if (p === '/api/config' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const cfg = loadConfig();
        const out = { updated: [] };
        if (body.limits !== undefined) {
          const { limits, invalid } = normalizeLimits(body.limits);
          if (invalid.length) return json(res, { ok: false, invalid }, 400);
          cfg.limits = limits;
          out.updated.push('limits');
          out.limits = limits;
        }
        if (body.watch !== undefined) {
          const w = body.watch || {};
          cfg.watch = {
            intervalSeconds: w.intervalSeconds !== undefined
              ? Math.max(10, Number(w.intervalSeconds) || 120)
              : (cfg.watch?.intervalSeconds ?? 120),
            notifications: w.notifications !== undefined
              ? !!w.notifications
              : !!cfg.watch?.notifications,
            staleAfterSeconds: w.staleAfterSeconds !== undefined
              ? Math.max(60, Number(w.staleAfterSeconds) || 600)
              : (cfg.watch?.staleAfterSeconds ?? 600),
          };
          out.updated.push('watch');
          out.watch = cfg.watch;
        }
        saveConfig(cfg);
        return json(res, { ok: true, ...out });
      }
      if (p === '/api/export.csv') {
        const q = Object.fromEntries(url.searchParams);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${exportFilename()}"`,
          'cache-control': 'no-store',
        });
        const filter = q.scope === 'all' ? {} : q;
        streamRecordsCsv((chunk) => res.write(chunk), filter);
        return res.end();
      }
      if (p === '/api/refresh' && req.method === 'POST') {
        if (refreshing) return send(res, 409, 'text/plain', 'a refresh is already running');
        refreshing = true;
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        try {
          const budget = Number(url.searchParams.get('budgetMs')) || 0;
          await refresh({
            registry: listProviders(),
            deadlineMs: budget || undefined,
            onProgress: (ev) => {
              try { res.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ }
            },
          });
        } catch (err) {
          res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
        } finally {
          refreshing = false;
          res.end();
        }
        return undefined;
      }
      if (p === '/api/pricing') {
        if (req.method === 'GET') return json(res, readJson(paths().pricing, {}));
        const body = await readBody(req);
        const parsed = JSON.parse(body || '{}');
        writeJson(paths().pricing, { updatedAt: new Date().toISOString(), ...parsed });
        return json(res, { ok: true });
      }
      if (p === '/api/prefs') {
        if (req.method === 'GET') return json(res, loadPrefs());
        const body = await readBody(req);
        savePrefs(JSON.parse(body || '{}'));
        return json(res, { ok: true });
      }
      if (p === '/api/config') {
        return json(res, { config: loadConfig(), paths: paths() });
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      console.error(err);
      return send(res, 500, 'application/json', JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  // address() is `string` for a pipe/socket and AddressInfo for TCP.
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
  const addr = `http://${host}:${boundPort}`;
  return { server, url: addr, token: authToken, close: () => new Promise((r) => server.close(r)) };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function json(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'text/plain', 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 4 << 20) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

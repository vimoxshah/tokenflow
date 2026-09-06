/**
 * Multi-machine aggregation — optional, OFF by default, file-based (or a
 * server the user names).
 *
 * Philosophy: instead of a cloud SaaS endpoint, TokenFlow syncs through a
 * folder the user already trusts (iCloud Drive, Dropbox, Syncthing mount,
 * a git repo — anything that syncs files between their machines). The data
 * that leaves this machine is exactly what the user can open and read:
 * one JSONL file of daily rollups per machine. No raw prompts, no content,
 * per-day granularity only.
 *
 *   sync:
 *     enabled: false            # ← default; nothing leaves the machine
 *     dir: ~/Sync/TokenFlow     # shared folder both machines can see
 *     machineName: MacBook Pro  # friendly label shown in aggregated views
 *     developerName: Vimox      # OPTIONAL — only when the team explicitly
 *                               # opts into per-developer visibility (P4-B)
 *     receipts: true            # ← default; set false to skip the ledger file
 *     to: https://…             # OPTIONAL — POST both files to a server
 *                               # instead of writing them into `dir`
 *     token: …                  # bearer token for `to` (or env
 *                               # TOKENFLOW_SYNC_TOKEN)
 *
 * What is transmitted, in the daily rollup (per day, per provider/model):
 *   date, tokens in/out/cache, requests, estimated cost, machineId
 *   + developerName ONLY if you set it yourself (team mode, opt-in)
 *
 * A SECOND file, `<machineId>.receipts.json`, carries the team's cost-per-
 * branch-and-PR ledger (see src/analytics/receipt.js), whole-state and
 * last-write-wins, written on every push unless `sync.receipts: false`. Per
 * branch it transmits only:
 *   repo (basename only — never a path or URL), branch, costUsd, turns,
 *   sessions, subagentTurns, contextShare, first/last (ISO timestamps),
 *   longLived (bool), and pr — null, or {number, mergedAt} for a PR this
 *   branch shipped in. (`pr` comes from buildReceiptsForStore(), which has
 *   no PR source wired in yet — it is null on every real push today; the
 *   shape exists so a future cached PR list needs no format change.)
 * It NEVER transmits: file paths, commit hashes, PR titles, diffs or line
 * counts, prompts, or any model/code text — nothing beyond the aggregate
 * numbers above.
 *
 * Conflict resolution: each machine writes ONLY its own files
 * (<machineId>.jsonl append-only last-write-wins per line;
 * <machineId>.receipts.json whole-state last-write-wins). Reads merge all
 * sibling files. Offline is the natural state: files just sync whenever the
 * folder does.
 *
 * `sync.to` (+ `sync.token` / env TOKENFLOW_SYNC_TOKEN) sends the exact same
 * two files' contents to a server the user names instead of writing them
 * into the shared folder — see push() below. Nothing else about the data
 * changes; only the destination does.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadConfig, paths } from './config.js';
import { Store, readJson } from './store.js';
import { buildReceiptsForStore } from './bundle.js';

/** Stable, anonymous machine id: random UUID persisted locally on first use. */
export function machineId(cfgHome = null) {
  const base = cfgHome || process.env.TOKENFLOW_HOME || path.join(os.homedir(), '.tokenflow');
  const file = path.join(base, 'machine-id');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const id = 'm-' + crypto.randomUUID().slice(0, 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id);
  return id;
}

export function isEnabled(cfg) {
  return !!(cfg?.sync?.enabled && cfg.sync.dir);
}

export function syncDir(cfg) {
  const d = cfg?.sync?.dir;
  if (!d) throw new Error('sync.dir not configured');
  return d.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * Read the local daily cube rollup written by the dashboard/watch pipeline
 * and fold it into one JSONL line per date. Provider/model detail stays
 * LOCAL; the synced line is deliberately coarse so the shared folder (or
 * server) leaks minimum information.
 * @param {object} cfg loaded config
 * @param {string} id this machine's id
 * @param {string} cubeFile path to data/cube.json, already known to exist
 * @returns {string[]} one JSON-encoded line per date, oldest first
 */
function computeDailyLines(cfg, id, cubeFile) {
  const cube = JSON.parse(fs.readFileSync(cubeFile, 'utf8'));
  const dims = cube.dims;
  const di = dims.indexOf('d');           // date
  const off = dims.length;
  const mIn = off + cube.measures.indexOf('in');
  const mOut = off + cube.measures.indexOf('out');
  const mReq = off + cube.measures.indexOf('req');
  const mCost = off + cube.measures.indexOf('cost');

  const byDay = new Map();
  for (const r of cube.rows) {
    const day = r[di];
    let acc = byDay.get(day);
    if (!acc) { acc = { date: day, input: 0, output: 0, requests: 0, estCost: 0 }; byDay.set(day, acc); }
    acc.input += r[mIn] || 0;
    acc.output += r[mOut] || 0;
    acc.requests += r[mReq] || 0;
    acc.estCost += r[mCost] || 0;
  }

  const name = sanitizeName(cfg.sync.machineName || os.hostname().split('.')[0]);
  // Developer identity is included ONLY when the user explicitly set
  // sync.developerName in their own config. Absent field = anonymous machine.
  const dev = cfg.sync.developerName ? sanitizeName(cfg.sync.developerName) : null;
  return [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => JSON.stringify({
      machineId: id, machineName: name,
      ...(dev ? { developer: dev } : {}),
      date: d.date,
      inputTokens: d.input, outputTokens: d.output,
      requests: d.requests, estCostUsd: Math.round(d.estCost * 10000) / 10000,
      exportedAt: new Date().toISOString(),
    }));
}

/** `sync.receipts: false` is the only way to skip the ledger file; absent = on. */
function receiptsAllowed(cfg) {
  return cfg?.sync?.receipts !== false;
}

/**
 * The whole-state receipts ledger for this machine: cost per (repo, branch),
 * joined to a PR when one is known. Sourced entirely from
 * buildReceiptsForStore() — this module never re-derives cost or reads a
 * session transcript itself.
 * @param {object} cfg loaded config
 * @param {string} id this machine's id
 * @returns {object} the JSON-serializable payload, allowlisted fields only
 */
function buildReceiptsPayload(cfg, id) {
  const pricing = readJson(paths().pricing, {});
  const store = new Store();
  const built = buildReceiptsForStore(store, pricing);
  const receipts = [];
  for (const R of built.repos) {
    const repo = path.basename(R.repo || 'unknown');
    for (const b of R.branches) {
      receipts.push({
        repo,
        branch: b.key,
        costUsd: b.cost,
        turns: b.turns,
        sessions: b.sessions,
        subagentTurns: b.subagentTurns,
        contextShare: b.contextShare,
        first: b.first,
        last: b.last,
        longLived: b.longLived,
        pr: b.pr ? { number: b.pr.number, mergedAt: b.pr.mergedAt ?? null } : null,
      });
    }
  }
  // Unlike the jsonl rollup (which always carries a hostname fallback), the
  // machine label here is opt-in only — this file joins branch/PR identity,
  // so it stays anonymous unless the user chose a label themselves.
  const name = cfg?.sync?.machineName ? sanitizeName(cfg.sync.machineName) : null;
  return {
    schema: 1,
    machineId: id,
    ...(name ? { machineName: name } : {}),
    generatedAt: new Date().toISOString(),
    receipts,
  };
}

/**
 * Export this machine's daily rollups (and, unless disabled, its receipts
 * ledger) to the shared folder, or POST both to a server when `to`/
 * `sync.to` is set.
 *
 * Stays synchronous for the folder path (existing callers rely on getting
 * `{file, days}` back immediately, not a Promise). The moment a destination
 * server is configured, a network call is unavoidable, so that branch alone
 * returns a Promise — `await push(...)` works either way.
 * @param {{config?: object, to?: string|null, token?: string|null}} opt
 * @returns {{file:string|null, days:number}|Promise<{file:null, days:number, pushedTo:string}>}
 */
export function push(opt = {}) {
  const cfg = opt.config || loadConfig();
  const id = machineId();
  const to = opt.to || cfg?.sync?.to || null;
  const token = opt.token || cfg?.sync?.token || process.env.TOKENFLOW_SYNC_TOKEN || null;

  if (to) return pushToServer({ cfg, id, to, token });

  if (!isEnabled(cfg)) throw new Error('sync is disabled (sync.enabled: false)');
  const dir = ensureDir(cfg);

  const cubeFile = `${paths().data}/cube.json`;
  if (!fs.existsSync(cubeFile)) return { file: null, days: 0 };

  const lines = computeDailyLines(cfg, id, cubeFile);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));

  if (receiptsAllowed(cfg)) {
    const receiptsFile = path.join(dir, `${id}.receipts.json`);
    fs.writeFileSync(receiptsFile, JSON.stringify(buildReceiptsPayload(cfg, id), null, 2));
  }

  return { file, days: lines.length };
}

/**
 * The remote-destination branch of push(): same two files' contents, POSTed
 * instead of written to a folder.
 * @param {{cfg:object, id:string, to:string, token:string|null}} args
 * @returns {Promise<{file:null, days:number, pushedTo:string}>}
 */
async function pushToServer({ cfg, id, to, token }) {
  if (cfg?.sync?.enabled !== true) throw new Error('sync is disabled (sync.enabled: false)');
  if (!/^https?:\/\//i.test(to)) throw new Error(`sync.to must be an http(s) URL, got: ${to}`);

  const cubeFile = `${paths().data}/cube.json`;
  const lines = fs.existsSync(cubeFile) ? computeDailyLines(cfg, id, cubeFile) : [];
  const files = { [`${id}.jsonl`]: lines.join('\n') + (lines.length ? '\n' : '') };
  if (receiptsAllowed(cfg)) {
    files[`${id}.receipts.json`] = JSON.stringify(buildReceiptsPayload(cfg, id), null, 2);
  }

  const url = `${to.replace(/\/+$/, '')}/api/rollup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ machineId: id, files }),
  });
  if (!res.ok) {
    // Drain the body so the connection can be reused, but never surface it —
    // a server's error page is not ours to print.
    try { await res.text(); } catch { /* ignore */ }
    throw new Error(`sync push to ${to} failed: ${res.status} ${res.statusText}`);
  }
  return { file: null, days: lines.length, pushedTo: to };
}

/**
 * Merge every sibling machine's file into combined daily totals.
 * @returns {{machines: string[], days: Array}}
 */
export function pull(opt = {}) {
  const cfg = opt.config || loadConfig();
  if (!isEnabled(cfg)) throw new Error('sync is disabled (sync.enabled: false)');
  const dir = ensureDir(cfg);

  const machines = [];
  const byDate = new Map();

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.replace(/\.jsonl$/, '');
    machines.push(id);
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }   // tolerate partial syncs
      let bucket = byDate.get(rec.date);
      if (!bucket) { bucket = { date: rec.date, machines: new Set(), input: 0, output: 0, requests: 0, estCost: 0 }; byDate.set(rec.date, bucket); }
      bucket.input += rec.inputTokens || 0;
      bucket.output += rec.outputTokens || 0;
      bucket.requests += rec.requests || 0;
      bucket.estCost += rec.estCostUsd || 0;
      bucket.machines.add(rec.machineName || id);
    }
  }

  const days = [...byDate.values()]
    .map((b) => ({ ...b, machineCount: b.machines.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { machines, days };
}

function ensureDir(cfg) {
  const d = syncDir(cfg);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sanitizeName(n) {
  return String(n).replace(/[^\w .-]/g, '').slice(0, 40) || 'machine';
}

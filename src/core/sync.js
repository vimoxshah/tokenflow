/**
 * Multi-machine aggregation — optional, OFF by default, file-based.
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
 *
 * What is transmitted (per day, per provider/model):
 *   date, tokens in/out/cache, requests, estimated cost, machineId
 * What is NEVER transmitted: prompts, code, file paths beyond the machine
 * label you chose, credentials.
 *
 * Conflict resolution: each machine writes ONLY its own file
 * (<machineId>.jsonl) — append-only, last-write-wins per line. Reads merge
 * all sibling files by summing per-date buckets. Offline is the natural
 * state: files just sync whenever the folder does.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadConfig, paths } from './config.js';

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
 * Export this machine's daily rollups to the shared folder.
 * @param {{config?: object}} opt
 * @returns {{file:string, days:number}}
 */
export function push(opt = {}) {
  const cfg = opt.config || loadConfig();
  if (!isEnabled(cfg)) throw new Error('sync is disabled (sync.enabled: false)');
  const dir = ensureDir(cfg);

  // Read the local daily cube rollup written by the dashboard/watch pipeline.
  const cubeFile = `${paths().data}/cube.json`;
  if (!fs.existsSync(cubeFile)) return { file: null, days: 0 };

  const cube = JSON.parse(fs.readFileSync(cubeFile, 'utf8'));
  const dims = cube.dims;
  const di = dims.indexOf('d');           // date
  const pi = dims.indexOf('p');           // provider
  const off = dims.length;
  const mIn = off + cube.measures.indexOf('in');
  const mOut = off + cube.measures.indexOf('out');
  const mReq = off + cube.measures.indexOf('req');
  const mCost = off + cube.measures.indexOf('cost');

  // Aggregate rows → one record per (date): totals across providers/models.
  // Provider/model detail stays LOCAL; the synced file is deliberately coarse
  // so the shared folder leaks minimum information.
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

  const id = machineId();
  const name = sanitizeName(cfg.sync.machineName || os.hostname().split('.')[0]);
  const lines = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => JSON.stringify({
      machineId: id, machineName: name, date: d.date,
      inputTokens: d.input, outputTokens: d.output,
      requests: d.requests, estCostUsd: Math.round(d.estCost * 10000) / 10000,
      exportedAt: new Date().toISOString(),
    }));

  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return { file, days: lines.length };
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

/**
 * Read-only SQLite access via Node's built-in `node:sqlite` (Node >= 22.5).
 * Zero dependencies, and never writes to the user's database.
 *
 * Live databases are often mid-transaction with a hot -wal file. Opening the
 * original can fail or read a stale page, so we snapshot the db plus its
 * sidecars into the cache dir and read the copy. Slower by a few milliseconds;
 * correct, and it cannot corrupt someone's editor state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let _sqlite = null;
function sqlite() {
  if (_sqlite) return _sqlite;
  // Silence just the one experimental warning, without muting the channel.
  const orig = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const s = typeof w === 'string' ? w : w?.message || '';
    if (/SQLite is an experimental feature/i.test(s)) return;
    return orig.call(process, w, ...rest);
  };
  try {
    _sqlite = require_('node:sqlite');
  } catch (err) {
    const e = new Error('node:sqlite is unavailable — Node 22.5 or newer is required for SQLite sources');
    e.cause = err;
    throw e;
  } finally {
    process.emitWarning = orig;
  }
  return _sqlite;
}

export function sqliteAvailable() {
  try {
    return !!sqlite().DatabaseSync;
  } catch {
    return false;
  }
}

export function openReadOnly(file, { snapshot = true } = {}) {
  const { DatabaseSync } = sqlite();
  let target = file;
  let tmpDir = null;
  if (snapshot) {
    // Deliberately the OS temp dir, not the config dir: the config dir may sit
    // on a network share or sandboxed mount that refuses unlink, and a snapshot
    // we cannot delete is worse than a slightly less tidy temp path.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenflow-sqlite-'));
    target = path.join(tmpDir, path.basename(file));
    fs.copyFileSync(file, target);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, target + ext);
    }
  }
  const db = new DatabaseSync(target);
  const origClose = db.close.bind(db);
  db.close = () => {
    try {
      origClose();
    } finally {
      // Never let cleanup failure sink an otherwise successful ingest.
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir left behind */ }
      }
    }
  };
  return db;
}

/** List the tables in a database — used by the generic SQLite importer. */
export function tables(file) {
  const db = openReadOnly(file);
  try {
    return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  } finally {
    db.close();
  }
}

/** Column names of a table, for interactive field mapping. */
export function columns(file, table) {
  const db = openReadOnly(file);
  try {
    const row = db.prepare(`SELECT * FROM "${String(table).replace(/"/g, '""')}" LIMIT 1`).get();
    return row ? Object.keys(row) : [];
  } finally {
    db.close();
  }
}

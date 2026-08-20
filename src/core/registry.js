/**
 * Provider registry + SDK.
 *
 * A provider is a plain object satisfying the contract in
 * docs/creating-provider.md. `createProvider` validates it up front so a
 * broken adapter fails at load with a readable message instead of halfway
 * through a 1.5 GB ingest.
 *
 * Discovery order (later wins on id collision, so a user can shadow a built-in):
 *   1. built-ins in src/providers/<id>/index.js
 *   2. user adapters in $TOKENFLOW_HOME/providers/*.js
 *   3. anything registered programmatically via registerProvider()
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { validateProvider } from './validate.js';
import { homeDir } from './config.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.join(HERE, '..', 'providers');

const registry = new Map();

/**
 * Wrap a provider definition with defaults + validation.
 * @template {{id:string, name:string, ingestFile?:Function}} T
 * @param {T} def
 * @returns {T}
 */
export function createProvider(def) {
  const v = validateProvider(def);
  if (!v.ok) {
    throw new Error(`Invalid provider "${def?.id ?? '(no id)'}":\n  - ${v.errors.join('\n  - ')}`);
  }
  const p = {
    description: '',
    measurement: 'primary',
    /** File extensions / prefilter substrings the engine uses to skip work. */
    prefilter: null,
    /** Human notes surfaced in `tokenflow providers`. */
    requires: [],
    getMetadata() {
      return {
        id: p.id, name: p.name, description: p.description,
        measurement: p.measurement, requires: p.requires,
        kind: typeof p.ingestFile === 'function' ? 'file' : 'fetch',
      };
    },
    ...def,
  };
  return Object.freeze(p);
}

export function registerProvider(p) {
  registry.set(p.id, p);
  return p;
}

export function getProvider(id) {
  return registry.get(id);
}

export function listProviders() {
  return [...registry.values()];
}

export function clearRegistry() {
  registry.clear();
}

/** Load built-in adapters, then any user adapters. Idempotent. */
export async function loadProviders({ includeUser = true, dir = BUILTIN_DIR } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'index.js');
    if (!fs.existsSync(f)) continue;
    const mod = await import(url.pathToFileURL(f).href);
    const p = mod.default ?? mod.provider;
    if (p) registerProvider(p);
  }
  if (includeUser) {
    const udir = path.join(homeDir(), 'providers');
    let ufiles = [];
    try {
      ufiles = fs.readdirSync(udir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    } catch {
      ufiles = [];
    }
    for (const f of ufiles) {
      try {
        const mod = await import(url.pathToFileURL(path.join(udir, f)).href);
        const p = mod.default ?? mod.provider;
        if (p) registerProvider(p);
      } catch (err) {
        console.error(`! could not load user provider ${f}: ${err.message}`);
      }
    }
  }
  return listProviders();
}

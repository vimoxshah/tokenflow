/**
 * `tokenflow pricing diff <file.json|-> [--apply] [--yes]`
 *
 * Compares a candidate price table to the current EFFECTIVE book — the
 * existing overrides file (`paths().pricing`) layered on the built-in table,
 * exactly what `buildPriceBook` resolves for every other command — and prints
 * what would change: models the candidate adds, rates it changes (with the
 * percent change per field), and the current overrides it says nothing about
 * (which `--apply` never touches, because apply merges, it does not replace).
 *
 * The candidate is the same shape the overrides file already uses today
 * (`{ models: { "<model>": { in, out, cacheRead?, cacheWrite?, cacheRefresh?,
 * match? } } }`, see src/core/pricing.js#buildPriceBook), plus two optional
 * top-level fields for provenance: `sources: [string]` and `version: string`.
 * Neither is written to the overrides file on apply — the overrides file's
 * shape stays exactly what `tokenflow pricing --set` already produces
 * (`models` + `updatedAt`), so nothing downstream has to learn a new field.
 *
 * `--apply` always prints the diff first. It then requires either `--yes`,
 * or an interactive terminal that confirms a `y` — a non-interactive run
 * (piped stdin, a script, CI) without `--yes` is refused rather than guessed
 * at.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { paths } from '../core/config.js';
import { readJson, writeJson } from '../core/store.js';
import { buildPriceBook, PRICING_SOURCES } from '../core/pricing.js';
import { usd, signedPct } from '../core/units.js';

const RATE_FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite'];
const RATE_LABELS = { in: 'input', out: 'output', cacheRead: 'cache read', cacheWrite: 'cache write' };

function num(v) {
  return v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
}

/** A model entry in the overrides-file shape, normalized to plain rate fields. */
function rateSpecOf(entry) {
  if (!entry || typeof entry !== 'object') return {};
  return {
    in: num(entry.in ?? entry.input),
    out: num(entry.out ?? entry.output),
    cacheRead: num(entry.cacheRead ?? entry.cache_read),
    cacheWrite: num(entry.cacheWrite ?? entry.cache_write),
    cacheRefresh: num(entry.cacheRefresh ?? entry.cache_refresh),
    match: entry.match,
  };
}

/** Only the fields a diff cares about, out of a full `book.lookup()` entry. */
function pickRates(entry) {
  return { in: entry.in, out: entry.out, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
}

/**
 * Compare a candidate price table to the current effective book.
 *
 * Both the current side and the candidate side are resolved through
 * `buildPriceBook` (the same cache-rate fallback, the same "no rate" rule),
 * so a candidate that only states `in`/`out` is compared like-for-like
 * against a current entry that does the same — neither side is favoured by
 * a difference in how missing cache rates are filled in.
 *
 * @param {{models?: Record<string, object>}} current the current overrides file contents
 * @param {{models: Record<string, object>, sources?: string[], version?: string}} candidate
 * @returns {{
 *   added: {model:string, to:object}[],
 *   removed: {model:string, rates:object}[],
 *   changed: {model:string, from:object, to:object, deltas:object, currentSrc:string|null, currentOrigin:string|null}[],
 *   unchanged: string[],
 *   invalid: {model:string, reason:string}[],
 *   candidateVersion: string|null,
 *   candidateSources: string[],
 * }}
 */
export function diffPriceTables(current, candidate) {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.models !== 'object' || candidate.models === null) {
    throw new Error('candidate must be an object with a "models" map, e.g. { "models": { "<model>": { "in": 1, "out": 2 } } }');
  }
  const currentModels = (current && current.models) || {};
  const candidateModels = candidate.models;

  // A candidate entry without a usable in/out rate would otherwise fall
  // through buildPriceBook's lookup (it skips entries missing in/out) and
  // silently read back as "unchanged" against the builtin table — the worst
  // failure mode for a tool whose whole job is telling a human what changed.
  const invalid = [];
  const validCandidateModels = {};
  for (const [key, spec] of Object.entries(candidateModels)) {
    const r = rateSpecOf(spec);
    if (!Number.isFinite(r.in) || !Number.isFinite(r.out)) {
      invalid.push({ model: key, reason: 'missing or non-numeric "in"/"out" rate' });
      continue;
    }
    validCandidateModels[key] = spec;
  }

  const currentBook = buildPriceBook({ models: currentModels });
  const candidateBook = buildPriceBook({ models: validCandidateModels });

  const added = [];
  const changed = [];
  const unchanged = [];
  for (const key of Object.keys(validCandidateModels)) {
    const to = candidateBook.lookup(key, undefined);
    if (!to) {
      // A finite in/out passed validation above, but an explicit `match`
      // override that does not match its own key means the lookup never
      // finds this entry at all — the same "no usable rate" outcome as a
      // missing in/out, just reached a different way.
      invalid.push({ model: key, reason: '"match" pattern does not match its own model key' });
      continue;
    }
    const from = currentBook.lookup(key, undefined);
    if (!from) { added.push({ model: key, to: pickRates(to) }); continue; }
    const deltas = {};
    let any = false;
    for (const f of RATE_FIELDS) {
      const a = from[f] ?? null;
      const b = to[f] ?? null;
      if (a === b) continue;
      any = true;
      deltas[f] = { from: a, to: b, pct: (a === null || a === undefined || a === 0) ? null : (b - a) / a };
    }
    if (any) changed.push({ model: key, from: pickRates(from), to: pickRates(to), deltas, currentSrc: from.src ?? null, currentOrigin: from.origin ?? null });
    else unchanged.push(key);
  }

  const removed = Object.keys(currentModels)
    .filter((k) => !(k in candidateModels))
    .map((k) => ({ model: k, rates: rateSpecOf(currentModels[k]) }));

  return {
    added,
    removed,
    changed,
    unchanged,
    invalid,
    candidateVersion: candidate.version ?? null,
    candidateSources: Array.isArray(candidate.sources) ? candidate.sources : [],
  };
}

function fmtRate(n) {
  return n === null || n === undefined ? 'n/a' : usd(n);
}

function rateLine(r) {
  const bits = [`in ${fmtRate(r.in)}`, `out ${fmtRate(r.out)}`];
  if (r.cacheRead !== null && r.cacheRead !== undefined) bits.push(`cacheRead ${fmtRate(r.cacheRead)}`);
  if (r.cacheWrite !== null && r.cacheWrite !== undefined) bits.push(`cacheWrite ${fmtRate(r.cacheWrite)}`);
  return bits.join(', ');
}

/** Render a diff the way a person reviews it before deciding to `--apply`. */
function renderDiff(diff) {
  const lines = [];
  lines.push(`${diff.candidateVersion ? `candidate table version: ${diff.candidateVersion}` : 'candidate table (no version stated)'}`);
  if (diff.invalid.length) {
    lines.push('');
    lines.push(`${diff.invalid.length} invalid candidate entr${diff.invalid.length === 1 ? 'y' : 'ies'} — skipped, and --apply is refused while these exist:`);
    for (const i of diff.invalid) lines.push(`  ✗ ${i.model}: ${i.reason}`);
  }
  if (diff.added.length) {
    lines.push('');
    lines.push(`${diff.added.length} added:`);
    for (const a of diff.added) lines.push(`  + ${a.model}: ${rateLine(a.to)}`);
  }
  if (diff.changed.length) {
    lines.push('');
    lines.push(`${diff.changed.length} changed:`);
    for (const c of diff.changed) {
      const parts = RATE_FIELDS.filter((f) => c.deltas[f]).map((f) => {
        const d = c.deltas[f];
        return `${RATE_LABELS[f]} ${fmtRate(d.from)} -> ${fmtRate(d.to)} (${d.pct === null ? 'n/a' : signedPct(d.pct)})`;
      });
      const was = c.currentSrc ? `  [current: ${c.currentOrigin === 'user' ? 'your override' : c.currentSrc}]` : '';
      lines.push(`  ~ ${c.model}: ${parts.join(', ')}${was}`);
    }
  }
  if (diff.removed.length) {
    lines.push('');
    lines.push(`${diff.removed.length} in your current overrides but not mentioned by this candidate — untouched by --apply (a merge, not a replace):`);
    for (const r of diff.removed) lines.push(`  · ${r.model}: ${rateLine(r.rates)}`);
  }
  if (!diff.added.length && !diff.changed.length && !diff.removed.length && !diff.invalid.length) {
    lines.push('');
    lines.push('no differences from the current effective price book.');
  }
  lines.push('');
  lines.push(`candidate sources: ${diff.candidateSources.length ? diff.candidateSources.join('; ') : '(none stated)'}`);
  lines.push('current built-in sources:');
  for (const [key, src] of Object.entries(PRICING_SOURCES)) {
    lines.push(`  ${key}: ${src.confidence} — ${src.url} (fetched ${src.fetched})`);
  }
  return lines.join('\n');
}

/**
 * Merge a candidate's models into the overrides file — never a replace.
 * Any model the candidate does not mention keeps its existing override
 * exactly as it was; a model the candidate does mention is fully replaced by
 * the candidate's rate object for that model. Only `models` and `updatedAt`
 * are written — a candidate's `sources`/`version` are for the diff review,
 * not for the overrides file's own schema.
 *
 * @param {{candidate: {models: Record<string, object>}, overridesPath: string}} opt
 * @returns {{path:string, applied:string[], modelCount:number}}
 */
export function applyCandidate({ candidate, overridesPath }) {
  if (!candidate || typeof candidate.models !== 'object' || candidate.models === null) {
    throw new Error('candidate must have a "models" map to apply');
  }
  const existing = readJson(overridesPath, { models: {} });
  const mergedModels = { ...(existing.models || {}), ...candidate.models };
  const merged = { ...existing, models: mergedModels, updatedAt: new Date().toISOString() };
  writeJson(overridesPath, merged);
  return { path: overridesPath, applied: Object.keys(candidate.models), modelCount: Object.keys(mergedModels).length };
}

function readCandidateInput(file, stdinReader) {
  const raw = file === '-'
    ? (stdinReader ? stdinReader() : fs.readFileSync(0, 'utf8'))
    : fs.readFileSync(path.resolve(file), 'utf8');
  return JSON.parse(raw);
}

/** Default confirm: a real y/N prompt on the controlling terminal. */
function defaultConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

/**
 * CLI entry for `tokenflow pricing diff`. Returns what to print and the exit
 * code; the caller decides the stream (matches src/commands/guard.js's `run`
 * convention).
 *
 * @param {{
 *   file?: string,
 *   apply?: boolean,
 *   yes?: boolean,
 *   overridesPath?: string,
 *   isTTY?: boolean,
 *   confirm?: (question:string) => Promise<boolean>,
 *   stdinReader?: () => string,
 *   write?: (s: string) => void,
 * }} flags
 *   `overridesPath`, `isTTY`, `confirm`, `stdinReader` and `write` are
 *   injectable seams for tests; a real CLI invocation only ever sets `file`,
 *   `apply` and `yes`. `write` is only used on the interactive-confirm path,
 *   where the diff must reach the terminal before the confirm prompt does
 *   (defaults to `process.stdout.write`).
 * @returns {Promise<{stdout: string|null, stderr: string|null, exitCode: number}>}
 */
export async function run(flags = {}) {
  const file = flags.file;
  if (!file) {
    return { stdout: null, stderr: 'usage: tokenflow pricing diff <file.json|-> [--apply] [--yes]', exitCode: 1 };
  }

  let candidate;
  try {
    candidate = readCandidateInput(file, flags.stdinReader);
  } catch (err) {
    return { stdout: null, stderr: `could not read candidate pricing table: ${err.message}`, exitCode: 1 };
  }

  const overridesPath = flags.overridesPath || paths().pricing;
  const current = readJson(overridesPath, { models: {} });

  let diff;
  try {
    diff = diffPriceTables(current, candidate);
  } catch (err) {
    return { stdout: null, stderr: err.message, exitCode: 1 };
  }
  const text = renderDiff(diff);

  if (!flags.apply) return { stdout: text, stderr: null, exitCode: 0 };

  if (diff.invalid.length) {
    return { stdout: text, stderr: `refusing to apply: ${diff.invalid.length} invalid candidate entr${diff.invalid.length === 1 ? 'y' : 'ies'}.`, exitCode: 1 };
  }
  const hasChanges = diff.added.length > 0 || diff.changed.length > 0;
  if (!hasChanges) {
    return { stdout: `${text}\n\nnothing to apply — the candidate matches the current effective table.`, stderr: null, exitCode: 0 };
  }

  if (!flags.yes) {
    const isTTY = flags.isTTY !== undefined ? flags.isTTY : !!(process.stdin && process.stdin.isTTY);
    if (!isTTY) {
      return { stdout: text, stderr: 'refusing to apply non-interactively — re-run with --yes to confirm.', exitCode: 1 };
    }
    // On a real terminal the confirm prompt (readline, or an injected mock)
    // writes straight to stdout the moment it is called — so the diff must
    // already be on screen before that happens, not bundled into a return
    // value the caller would only print afterwards.
    (flags.write || ((s) => process.stdout.write(s)))(`${text}\n\n`);
    const confirmFn = flags.confirm || defaultConfirm;
    const ok = await confirmFn(`Apply ${diff.added.length} added / ${diff.changed.length} changed model rate(s) to ${overridesPath}? [y/N] `);
    if (!ok) return { stdout: 'apply cancelled.', stderr: null, exitCode: 0 };
    const res = applyCandidate({ candidate, overridesPath });
    return { stdout: `✓ applied ${res.applied.length} model rate(s) to ${res.path}`, stderr: null, exitCode: 0 };
  }

  const res = applyCandidate({ candidate, overridesPath });
  return { stdout: `${text}\n\n✓ applied ${res.applied.length} model rate(s) to ${res.path}`, stderr: null, exitCode: 0 };
}

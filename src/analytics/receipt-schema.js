/**
 * Receipt schema v0 — a branch receipt shaped to travel with the code (as a
 * git note) rather than live on a server. Three things live here:
 *
 *   toReceiptV0()            maps one buildReceipts() branch entry (the shape
 *                             src/analytics/receipt.js produces) into the
 *                             portable schema described by
 *                             schemas/receipt.v0.json.
 *   validateReceiptV0()      a small hand-written validator for that schema.
 *                             No dependencies; kept in lockstep with the
 *                             `required` list in schemas/receipt.v0.json —
 *                             test/receipt-schema.test.js checks the two
 *                             don't drift apart.
 *   renderReceiptV0Markdown() the same PR-comment table shape as
 *                             renderReceiptMarkdown() in receipt.js, plus an
 *                             `<!-- tokenflow-receipt -->` marker on the first
 *                             line so a CI comment can be found and updated.
 *
 * Every dollar figure here is an estimate from local token counts against a
 * local price table — never measured billing, never a network round trip.
 * See docs/receipt-schema.md.
 */
import { usd, compact, pct, shortDate } from '../core/units.js';

/** The one receipt schema version this module speaks. */
export const RECEIPT_SCHEMA_VERSION = 0;

/** Fields schemas/receipt.v0.json marks `required`. Kept in sync by hand. */
const REQUIRED_FIELDS = [
  'schemaVersion', 'generatedAt', 'toolVersion', 'repo', 'branch', 'headSha',
  'window', 'costUsd', 'contextShare', 'turns', 'sessions', 'subagentTurns',
  'models', 'coverage', 'largestPromptTokens', 'changedLines', 'pr',
  'longLived', 'costPer100Lines', 'notes',
];

/**
 * Honesty caveats for one branch receipt, as plain sentences (no markdown).
 * Mirrors the notes renderReceiptMarkdown() prints beside the table, minus
 * the fields (like vsMedian and the raw prWindow) the v0 schema does not keep.
 * @param {object} b one branch receipt from buildReceipts()
 * @returns {string[]}
 */
function buildNotes(b) {
  const notes = [];
  const w = b.prWindow;
  if (w && w.beforeOpened.turns > 0 && w.beforeOpened.days !== null && w.beforeOpened.days > 14) {
    const preShare = b.cost ? (w.beforeOpened.cost ?? 0) / b.cost : null;
    const pct100 = preShare !== null ? `${Math.round(preShare * 100)}%` : 'some';
    notes.push(`${pct100} of the total predates the pull request by up to ${Math.round(w.beforeOpened.days)} days; on a long-lived branch that is earlier work, not this PR's.`);
  }
  if (b.longLived) notes.push(`"${b.key}" is a long-lived branch: this is a receipt for a period of work on it, not for one change.`);
  if (w && w.priorPrs.count > 0) notes.push(`${w.priorPrs.count} earlier merged pull request(s) on this branch hold additional spend not counted here.`);
  if (b.unpricedTurns > 0) notes.push(`${b.unpricedTurns} turn(s) used a model with no configured price and are excluded from costUsd.`);
  notes.push('Estimated locally by TokenFlow from the session logs already on this machine, against a local price table — never measured billing, and no prompt or code content was read.');
  return notes;
}

/**
 * Map one buildReceipts()/createReceiptBuilder() branch entry into the
 * portable receipt.v0 shape (schemas/receipt.v0.json).
 * @param {object} b one branch receipt (an entry of `result.repos[i].branches`)
 * @param {{repo:string, headSha:string, toolVersion:string, generatedAt?:string}} meta
 * @returns {object} a receipt.v0 object
 */
export function toReceiptV0(b, meta) {
  const hasWindow = (b.first !== null && b.first !== undefined) || (b.last !== null && b.last !== undefined);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    toolVersion: meta.toolVersion,
    repo: meta.repo,
    branch: b.key,
    headSha: meta.headSha,
    window: hasWindow ? { first: b.first ?? null, last: b.last ?? null } : null,
    costUsd: b.cost ?? null,
    contextShare: b.contextShare ?? null,
    turns: b.turns,
    sessions: b.sessions,
    subagentTurns: b.subagentTurns,
    models: (b.models || []).map((m) => ({ model: m.model, costUsd: m.cost ?? null, share: m.share ?? null })),
    coverage: b.coverage ?? null,
    largestPromptTokens: b.maxPrompt ?? null,
    changedLines: b.changedLines ?? null,
    pr: b.pr ? { number: b.pr.number, mergedAt: b.pr.mergedAt ?? null } : null,
    longLived: !!b.longLived,
    costPer100Lines: b.costPer100Lines ?? null,
    notes: buildNotes(b),
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNullableNum = (v) => v === null || isNum(v);
const isShare = (v) => v === null || (isNum(v) && v >= 0 && v <= 1);
const isInt = (v) => Number.isInteger(v);
const isNullableNonNegInt = (v) => v === null || (isInt(v) && v >= 0);
const isStr = (v) => typeof v === 'string';

/**
 * Hand-written validator for the receipt.v0 shape — no dependencies, mirrors
 * schemas/receipt.v0.json field-for-field.
 * @param {*} obj
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateReceiptV0(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['receipt must be an object'] };
  }
  for (const key of REQUIRED_FIELDS) {
    if (!(key in obj)) errors.push(`missing required field "${key}"`);
  }

  if ('schemaVersion' in obj && obj.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RECEIPT_SCHEMA_VERSION}`);
  if ('generatedAt' in obj && !isStr(obj.generatedAt)) errors.push('generatedAt must be a string');
  if ('toolVersion' in obj && !isStr(obj.toolVersion)) errors.push('toolVersion must be a string');
  if ('repo' in obj && !(isStr(obj.repo) && obj.repo.length > 0)) errors.push('repo must be a non-empty string');
  if ('branch' in obj && !(isStr(obj.branch) && obj.branch.length > 0)) errors.push('branch must be a non-empty string');
  if ('headSha' in obj && !(isStr(obj.headSha) && /^[0-9a-f]{7,40}$/.test(obj.headSha))) errors.push('headSha must be a 7-40 char lowercase hex sha');

  if ('window' in obj) {
    const w = obj.window;
    if (w !== null) {
      if (typeof w !== 'object' || Array.isArray(w)) errors.push('window must be an object or null');
      else {
        if (!('first' in w) || !('last' in w)) errors.push('window must have "first" and "last"');
        if ('first' in w && w.first !== null && !isStr(w.first)) errors.push('window.first must be a string or null');
        if ('last' in w && w.last !== null && !isStr(w.last)) errors.push('window.last must be a string or null');
      }
    }
  }

  if ('costUsd' in obj && !isNullableNum(obj.costUsd)) errors.push('costUsd must be a number or null');
  if ('contextShare' in obj && !isShare(obj.contextShare)) errors.push('contextShare must be null or a number between 0 and 1');
  if ('turns' in obj && !isInt(obj.turns)) errors.push('turns must be an integer');
  if ('sessions' in obj && !isInt(obj.sessions)) errors.push('sessions must be an integer');
  if ('subagentTurns' in obj && !isInt(obj.subagentTurns)) errors.push('subagentTurns must be an integer');

  if ('models' in obj) {
    if (!Array.isArray(obj.models)) errors.push('models must be an array');
    else obj.models.forEach((m, i) => {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) { errors.push(`models[${i}] must be an object`); return; }
      if (!isStr(m.model)) errors.push(`models[${i}].model must be a string`);
      if (!isNullableNum(m.costUsd)) errors.push(`models[${i}].costUsd must be a number or null`);
      if (!isShare(m.share)) errors.push(`models[${i}].share must be null or a number between 0 and 1`);
    });
  }

  if ('coverage' in obj && !isShare(obj.coverage)) errors.push('coverage must be null or a number between 0 and 1');
  if ('largestPromptTokens' in obj && !isNullableNonNegInt(obj.largestPromptTokens)) errors.push('largestPromptTokens must be null or a non-negative integer');
  if ('changedLines' in obj && !isNullableNonNegInt(obj.changedLines)) errors.push('changedLines must be null or a non-negative integer');

  if ('pr' in obj) {
    const pr = obj.pr;
    if (pr !== null) {
      if (typeof pr !== 'object' || Array.isArray(pr)) errors.push('pr must be an object or null');
      else {
        if (!isInt(pr.number)) errors.push('pr.number must be an integer');
        if (!(pr.mergedAt === null || isStr(pr.mergedAt))) errors.push('pr.mergedAt must be a string or null');
      }
    }
  }

  if ('longLived' in obj && typeof obj.longLived !== 'boolean') errors.push('longLived must be a boolean');
  if ('costPer100Lines' in obj && !isNullableNum(obj.costPer100Lines)) errors.push('costPer100Lines must be a number or null');

  if ('notes' in obj) {
    if (!Array.isArray(obj.notes)) errors.push('notes must be an array');
    else obj.notes.forEach((n, i) => { if (!isStr(n)) errors.push(`notes[${i}] must be a string`); });
  }

  return { ok: errors.length === 0, errors };
}

const money = (v) => (v === null || v === undefined ? '—' : usd(v));
const share = (v) => (v === null || v === undefined ? '—' : pct(v, 0));

/**
 * A receipt.v0 object rendered for a PR comment — the same table shape as
 * renderReceiptMarkdown() in src/analytics/receipt.js, plus a leading
 * `<!-- tokenflow-receipt -->` marker so CI can find and update its own
 * comment instead of piling up a new one per push.
 * @param {object} receipt a receipt.v0 object (see toReceiptV0())
 * @returns {string}
 */
export function renderReceiptV0Markdown(receipt) {
  const L = [];
  L.push('<!-- tokenflow-receipt -->');
  const title = receipt.pr ? `\`${receipt.branch}\` · PR #${receipt.pr.number}` : `\`${receipt.branch}\``;
  L.push(`### 🧾 AI cost receipt — ${title}`);
  if (receipt.repo) L.push(`_${receipt.repo}_`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  const costLine = receipt.costUsd === null
    ? '— (no priced turns)'
    : `**${money(receipt.costUsd)}**${receipt.contextShare !== null ? ` · ${share(receipt.contextShare)} re-sent context, ${share(1 - receipt.contextShare)} fresh work` : ''}`;
  L.push(`| Estimated spend | ${costLine} |`);
  const subagentShare = receipt.turns > 0 ? receipt.subagentTurns / receipt.turns : null;
  L.push(`| Sessions · turns | ${receipt.sessions} · ${receipt.turns}${subagentShare !== null && receipt.subagentTurns > 0 ? ` (${share(subagentShare)} subagent)` : ''} |`);
  if (receipt.models.length) {
    L.push(`| Models | ${receipt.models.slice(0, 3).map((m) => `${m.model} ${share(m.share)}`).join(', ')}${receipt.models.length > 3 ? ', …' : ''} |`);
  }
  if (receipt.pr && receipt.changedLines !== null) {
    L.push(`| Changed lines | ${receipt.changedLines}${receipt.costPer100Lines !== null ? ` → ${money(receipt.costPer100Lines)} per 100 lines` : ''} |`);
  }
  if (receipt.largestPromptTokens !== null) L.push(`| Largest prompt | ${compact(receipt.largestPromptTokens)} tokens |`);
  if (receipt.window && receipt.window.first && receipt.window.last) {
    const merged = receipt.pr && receipt.pr.mergedAt ? ` (merged ${shortDate(receipt.pr.mergedAt.slice(0, 10))})` : receipt.pr ? ' (PR open)' : '';
    L.push(`| Window | ${shortDate(receipt.window.first.slice(0, 10))} → ${shortDate(receipt.window.last.slice(0, 10))}${merged} |`);
  }
  L.push('');
  L.push(`<sub>${receipt.notes.join(' ')}</sub>`);
  return L.join('\n');
}

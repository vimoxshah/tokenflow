/**
 * A FOCUS-shaped export — maps TokenFlow's own local, zero-network cost
 * estimates onto the column names of the FinOps FOCUS (FinOps Open Cost and
 * Usage Specification), so an estimate produced entirely on this machine can
 * be dropped straight into a FinOps tool that already ingests FOCUS-shaped
 * CSVs, next to the real cloud bill.
 *
 * TWO PATHS, TWO GRAINS:
 *   focusRowsFromReceipts()  one row per branch receipt (schemas/receipt.v0.json
 *                            or receipt.v1.json). Resource grain is the branch
 *                            (`<repo>#<branch>`) — see `tokenflow export --focus`.
 *   focusRowsFromDaily()     one row per machine-day from the team sync ledger
 *                            (the shape src/core/sync.js writes to
 *                            `<machineId>.jsonl`). Resource grain is the
 *                            machine, because that ledger carries no
 *                            repo/branch detail — see `tokenflow team --focus`.
 *
 * THE HONESTY RULE THIS EXPORT MUST NOT BREAK: every dollar and every
 * quantity here is a LOCAL ESTIMATE at list price, computed from token counts
 * against a local price table — never a measured invoice, never a network
 * round trip. FOCUS's four cost columns (BilledCost, EffectiveCost, ListCost,
 * ContractedCost) are usually distinct on a real bill; here they are
 * deliberately identical, because splitting one estimate into four numbers
 * would imply a precision this data doesn't have. See docs/focus-export.md
 * for the full column mapping and this same note.
 *
 * COLUMN-SET CAVEAT: built without live access to the FOCUS specification
 * (see docs/focus-export.md for what was and wasn't verified). The column
 * names below are the well-published FOCUS 1.x set; treat this as a
 * FOCUS-shaped export for FinOps tooling, not a certified FOCUS conformance
 * report.
 *
 * Missing values follow this project's own null contract
 * (docs/exports-and-budgets.md): an empty cell, never a 0 or an invented
 * value — even where FOCUS marks a column mandatory. A row is never skipped
 * for missing data; every receipt/day gets exactly one row.
 */
import { csvLine } from './csv.js';

/**
 * FOCUS 1.x column names this export writes, alphabetical, one row per
 * receipt or per machine-day.
 */
export const FOCUS_COLUMNS = [
  'AvailabilityZone', 'BilledCost', 'BillingAccountId', 'BillingAccountName',
  'BillingAccountType', 'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart',
  'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency',
  'ChargePeriodEnd', 'ChargePeriodStart', 'CommitmentDiscountCategory',
  'CommitmentDiscountId', 'CommitmentDiscountName', 'CommitmentDiscountStatus',
  'CommitmentDiscountType', 'ConsumedQuantity', 'ConsumedUnit', 'ContractedCost',
  'ContractedUnitPrice', 'EffectiveCost', 'InvoiceIssuerName', 'ListCost',
  'ListUnitPrice', 'PricingCategory', 'PricingQuantity', 'PricingUnit',
  'ProviderName', 'PublisherName', 'RegionId', 'RegionName', 'ResourceId',
  'ResourceName', 'ResourceType', 'ServiceCategory', 'ServiceName', 'SkuId',
  'SkuPriceId', 'SubAccountId', 'SubAccountName', 'Tags',
];

/** Written to ChargeDescription on every row — the estimate marker a reader sees even without opening Tags. */
export const ESTIMATE_NOTE = 'Estimated coding agent token spend at list price; not an invoice.';

/**
 * A small, best-effort model-family -> vendor table. Receipts carry a model
 * family string (e.g. "Claude Opus 5"), never a raw provider id, so this is a
 * heuristic, not a lookup against a known list — an unrecognized family falls
 * back to the family string itself rather than a blank ProviderName.
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export function vendorFromModel(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const m = model.toLowerCase();
  if (/claude/.test(m)) return 'Anthropic';
  if (/gpt|codex|\bo[134]\b/.test(m)) return 'OpenAI';
  if (/gemini/.test(m)) return 'Google';
  if (/mistral/.test(m)) return 'Mistral AI';
  if (/llama/.test(m)) return 'Meta';
  if (/deepseek/.test(m)) return 'DeepSeek';
  return model;
}

/** One row with every FOCUS column present (as null) so every export writes the full column set. */
function blankRow() {
  const row = {};
  for (const c of FOCUS_COLUMNS) row[c] = null;
  return row;
}

/** Null-safe sum of two optional token counts; null when both are missing. */
function sumTokens(a, b) {
  const hasA = typeof a === 'number' && Number.isFinite(a);
  const hasB = typeof b === 'number' && Number.isFinite(b);
  if (!hasA && !hasB) return null;
  return (hasA ? a : 0) + (hasB ? b : 0);
}

/**
 * Map branch receipts (schemas/receipt.v0.json or receipt.v1.json) to
 * FOCUS-shaped rows — one row per receipt, resource grain is the branch.
 *
 * DOCUMENTED DEVIATION: `ConsumedQuantity`/`ConsumedUnit` report `turns`/
 * `'turns'`, not a token total. The receipt schema this stream owns
 * (schemas/receipt.v1.json) carries no total-token field — only
 * `largestPromptTokens`, which is a max, not a total, and would misrepresent
 * volume if used here. See docs/focus-export.md. `focusRowsFromDaily()`
 * below reports real token totals, because that ledger has them.
 *
 * @param {object[]} receipts receipt.v0 or receipt.v1 objects (see
 *   src/analytics/receipt-schema.js's toReceiptV0())
 * @param {object} [opt] reserved for future column overrides; unused today
 *   because a receipt already carries everything this mapping needs
 * @returns {object[]} FOCUS-shaped rows, keyed by FOCUS column name
 */
export function focusRowsFromReceipts(receipts, opt = {}) {
  return (receipts || []).map((r) => {
    const row = blankRow();
    const topModel = Array.isArray(r.models) && r.models.length ? r.models[0].model : null;
    const tags = {
      repo: r.repo,
      branch: r.branch,
      headSha: r.headSha,
      toolVersion: r.toolVersion,
      costBasis: 'estimated',
      ...(r.ticket ? { ticket: r.ticket.key } : {}),
    };
    row.BilledCost = r.costUsd;
    row.EffectiveCost = r.costUsd;
    row.ListCost = r.costUsd;
    row.ContractedCost = r.costUsd;
    row.BillingCurrency = 'USD';
    row.ChargeCategory = 'Usage';
    row.PricingCategory = 'Standard';
    row.ChargeDescription = ESTIMATE_NOTE;
    row.ChargePeriodStart = r.window ? r.window.first : null;
    row.ChargePeriodEnd = r.window ? r.window.last : null;
    row.ConsumedQuantity = typeof r.turns === 'number' ? r.turns : null;
    row.ConsumedUnit = 'turns';
    row.ProviderName = vendorFromModel(topModel);
    row.ServiceName = 'Coding agent tokens';
    row.ServiceCategory = 'AI and Machine Learning';
    row.ResourceId = r.repo && r.branch ? `${r.repo}#${r.branch}` : null;
    row.ResourceName = r.branch ?? null;
    row.ResourceType = 'branch';
    row.Tags = JSON.stringify(tags);
    return row;
  });
}

/**
 * Map team-synced daily rollup rows — the shape written to
 * `<machineId>.jsonl` by src/core/sync.js's push() — to FOCUS-shaped rows.
 * One row per machine-day; resource grain is the machine, because this
 * ledger never carries repo/branch (see the module doc comment above for why
 * `focusRowsFromReceipts()` and this one use different grains).
 *
 * PROPOSED CONTRACT for `tokenflow team --focus` (not yet wired — see the
 * report for this stream): call this with the raw `*.jsonl` lines read back
 * from the sync folder (one object per line, already JSON.parsed), not with
 * `aggregate()`'s `trendDays` (team.js caps that at the last 28 days for
 * rendering, so it is not export-grade).
 *
 * @param {{date:string, inputTokens?:number, outputTokens?:number,
 *   requests?:number, estCostUsd?:number, machineId?:string,
 *   machineName?:string, developer?:string}[]} rows daily sync lines
 * @param {object} [opt] reserved for future column overrides; unused today
 * @returns {object[]} FOCUS-shaped rows, keyed by FOCUS column name
 */
export function focusRowsFromDaily(rows, opt = {}) {
  return (rows || []).map((r) => {
    const row = blankRow();
    const machine = r.machineName || r.machineId || null;
    const tokens = sumTokens(r.inputTokens, r.outputTokens);
    const dayStart = r.date ? `${r.date}T00:00:00.000Z` : null;
    const dayEnd = r.date ? nextDayIso(r.date) : null;
    const tags = {
      machineId: r.machineId ?? null,
      machineName: r.machineName ?? null,
      date: r.date ?? null,
      costBasis: 'estimated',
      ...(r.developer ? { developer: r.developer } : {}),
    };
    row.BilledCost = typeof r.estCostUsd === 'number' ? r.estCostUsd : null;
    row.EffectiveCost = row.BilledCost;
    row.ListCost = row.BilledCost;
    row.ContractedCost = row.BilledCost;
    row.BillingCurrency = 'USD';
    row.ChargeCategory = 'Usage';
    row.PricingCategory = 'Standard';
    row.ChargeDescription = ESTIMATE_NOTE;
    row.ChargePeriodStart = dayStart;
    row.ChargePeriodEnd = dayEnd;
    row.ConsumedQuantity = tokens;
    row.ConsumedUnit = 'tokens';
    // No per-model/provider detail survives into the daily sync ledger (by
    // design — see src/core/sync.js's own privacy contract), so ProviderName
    // is honestly null here rather than a guess.
    row.ProviderName = null;
    row.ServiceName = 'Coding agent tokens';
    row.ServiceCategory = 'AI and Machine Learning';
    row.ResourceId = machine ? `machine:${machine}` : null;
    row.ResourceName = machine;
    row.ResourceType = 'machine';
    row.Tags = JSON.stringify(tags);
    return row;
  });
}

/** "2026-08-20" -> "2026-08-21T00:00:00.000Z" (UTC, calendar-safe). */
function nextDayIso(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * FOCUS-shaped rows as CSV, header first, in FOCUS_COLUMNS order. Reuses this
 * project's own CSV primitives (src/export/csv.js) so the same escaping and
 * null-as-empty-cell rules apply here as everywhere else TokenFlow exports.
 * @param {object[]} rows rows produced by focusRowsFromReceipts()/focusRowsFromDaily()
 * @returns {string}
 */
export function toCsv(rows) {
  let out = csvLine(FOCUS_COLUMNS);
  for (const r of rows || []) out += csvLine(FOCUS_COLUMNS.map((c) => (r[c] === undefined ? null : r[c])));
  return out;
}

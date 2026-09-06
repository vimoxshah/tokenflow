# FOCUS-shaped export

A second export shape alongside the receipt CSV in
[exports-and-budgets.md](exports-and-budgets.md): one row per branch receipt (or, for a
team, one row per machine-day), with column names taken from the FinOps FOCUS
specification (FinOps Open Cost and Usage Specification), the column set several FinOps
tools already ingest. Dropping this file next to a real cloud bill export lets a FinOps
tool line up "what coding agents cost, estimated" against "what the cloud actually
billed" without a custom importer.

`src/export/focus.js` provides:

- `focusRowsFromReceipts(receipts, opt)`: one row per branch receipt (a
  `schemas/receipt.v0.json` or `receipt.v1.json` object; see
  [receipt-schema.md](receipt-schema.md)).
- `focusRowsFromDaily(rows, opt)`: one row per machine-day from the team sync ledger
  (the `<machineId>.jsonl` line shape `src/core/sync.js`'s `push()` writes).
- `toCsv(rows)`: either row set as CSV, header first, reusing this project's own CSV
  escaping (`src/export/csv.js`) so a comma or quote inside a value (Tags, always) is
  quoted correctly rather than corrupting the column count.

## Honesty note: read this before wiring the CLI

**Every number in this export is a local estimate at list price, never a measured
invoice, never a network round trip.** FOCUS's four cost columns, `BilledCost`,
`EffectiveCost`, `ListCost`, and `ContractedCost`, are usually different numbers on a
real bill (a negotiated rate, a commitment discount, taxes). Here they are
**deliberately set to the same value** (the receipt's `costUsd`, or the daily row's
`estCostUsd`), because reporting four different-looking numbers from one estimate would
claim a precision this data doesn't have. Every row also carries the estimate marker
twice, so it survives even if a downstream tool only shows one column:

- `ChargeDescription`: `"Estimated coding agent token spend at list price; not an invoice."`
- `Tags`: a JSON object with `"costBasis": "estimated"`.

This project's own null contract still applies (see
[exports-and-budgets.md](exports-and-budgets.md)): a missing value is an **empty cell,
never `0`, and never invented**, even for a column FOCUS marks mandatory. A row is
never skipped because a value is missing; every receipt (or machine-day) gets exactly
one row, with whatever cells are unknown left blank.

## Column-set verification: what was and wasn't checked

This mapping was built per the task's instruction to verify the column set with
`ctx7` (`npx ctx7@latest library "FOCUS FinOps Open Cost and Usage Specification"` then
`docs <id> "..."`). That lookup did not index the FOCUS specification itself; it
resolved to the general FinOps Foundation framework repository
(`/finopsfoundation/framework`), whose docs describe FinOps practice, not FOCUS's column
list. A follow-up attempt to fetch the column list directly from
`github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec` also returned a 404 (the
repository layout has likely changed). **The column names below are therefore the
well-published FOCUS 1.x set from general knowledge, not verified against a live copy of
the spec during this build.** Treat this as a FOCUS-shaped export for FinOps tooling,
not a certified FOCUS conformance report, and re-verify the column list against
`https://focus.finops.org` (or the current spec repository) before relying on exact
FOCUS compliance.

## Mapping table

One row per receipt (`focusRowsFromReceipts`) or per machine-day (`focusRowsFromDaily`).
Columns not listed as populated are written empty (`null`, an empty CSV cell). There is
no honest local value for them: region, SKU, commitment discounts, sub-account, invoice
issuer, and similar billing-system concepts don't exist for a locally estimated token
cost.

| FOCUS column | Receipts (`focusRowsFromReceipts`) | Daily/team (`focusRowsFromDaily`) |
|---|---|---|
| `BilledCost` / `EffectiveCost` / `ListCost` / `ContractedCost` | `receipt.costUsd` (same value in all four; see honesty note) | `estCostUsd` (same value in all four) |
| `BillingCurrency` | `"USD"` | `"USD"` |
| `ChargeCategory` | `"Usage"` | `"Usage"` |
| `PricingCategory` | `"Standard"` | `"Standard"` |
| `ChargeDescription` | the estimate marker (see honesty note) | the estimate marker |
| `ChargePeriodStart` / `ChargePeriodEnd` | `receipt.window.first` / `.last` (empty when `window` is `null`) | the day, `00:00:00Z` through next day `00:00:00Z` (UTC, calendar day) |
| `ConsumedQuantity` / `ConsumedUnit` | `receipt.turns` / `"turns"`, see deviation below | `inputTokens + outputTokens` / `"tokens"` (null when both are missing) |
| `ProviderName` | derived from the receipt's top model family (`models[0].model`) through a small vendor heuristic (Claude maps to Anthropic, GPT/Codex/o-series maps to OpenAI, Gemini maps to Google, and so on); an unrecognized family falls back to the family string itself, never blank | `null`, the daily sync ledger carries no per-model detail by design (see `src/core/sync.js`'s privacy contract) |
| `ServiceName` | `"Coding agent tokens"` | `"Coding agent tokens"` |
| `ServiceCategory` | `"AI and Machine Learning"` | `"AI and Machine Learning"` |
| `ResourceId` | `` `<repo>#<branch>` `` | `` `machine:<machineName or machineId>` `` |
| `ResourceName` | the branch name | the machine name (or id, if no name was set) |
| `ResourceType` | `"branch"` | `"machine"` |
| `Tags` | JSON object: `repo`, `branch`, `headSha`, `toolVersion`, `costBasis: "estimated"`, and `ticket` (the ticket's `key`) when the receipt has one | JSON object: `machineId`, `machineName`, `date`, `costBasis: "estimated"`, and `developer` when the synced row carries one |
| everything else (`AvailabilityZone`, `BillingAccountId/Name/Type`, `BillingPeriodStart/End`, `ChargeClass`, `ChargeFrequency`, the five `CommitmentDiscount*` columns, `ContractedUnitPrice`, `InvoiceIssuerName`, `ListUnitPrice`, `PricingQuantity`, `PricingUnit`, `PublisherName`, `RegionId`, `RegionName`, `SkuId`, `SkuPriceId`, `SubAccountId`, `SubAccountName`) | empty | empty |

### Deviation: `ConsumedQuantity` on the receipts path is turns, not tokens

The receipt schema this stream owns (`schemas/receipt.v1.json`) has no total-token
field, only `largestPromptTokens`, which is the single **largest** prompt seen on the
branch, not a sum, and would misrepresent volume if reused here. `ConsumedQuantity` on
the receipts path is therefore `receipt.turns` with `ConsumedUnit: "turns"`, so a reader
of the unit label is never misled into thinking it's a token count. The daily/team path
does carry real token totals (the sync ledger sums `inputTokens`/`outputTokens` per day),
so `focusRowsFromDaily` reports actual tokens. Adding a token-total field to a future
receipt schema version would let `focusRowsFromReceipts` report real tokens too; this is
flagged for whichever stream next revises the receipt schema.

## Running the export

Proposed CLI contract (the flags this stream's mapping was built against; wiring them
into `bin/` is a separate stream's task):

```bash
tokenflow export --focus                 # writes tokenflow-focus-<date>.csv to the cwd
tokenflow export --focus --out <dir>      # writes it into <dir> instead
tokenflow team --focus                    # the team rollup, FOCUS-shaped
```

`tokenflow export --focus` is expected to build its rows from this machine's branch
receipts (the same source `tokenflow receipt --csv` reads; see
[exports-and-budgets.md](exports-and-budgets.md)) via `focusRowsFromReceipts()`, then
`toCsv()`, then write `tokenflow-focus-YYYY-MM-DD.csv` (see `exportFilename()` in
`src/export/csv.js` for the existing naming convention this should match, with
`tokenflow-focus` as the prefix) to the current directory, or to `--out <dir>` when
given.

`tokenflow team --focus` is expected to call `focusRowsFromDaily()` with the raw
`*.jsonl` lines read back from the sync folder (one JSON object per line), **not**
`aggregate()`'s `trendDays`, which `src/core/team.js` truncates to the last 28 days for
rendering and is not export-grade. This shape (`{date, inputTokens, outputTokens,
requests, estCostUsd, machineId, machineName?, developer?}` per line) is a proposed
contract from this stream, not yet wired into `src/core/team.js` or `bin/`; confirm it
before wiring.

## Who ingests this

Any FinOps platform or spreadsheet workflow that already reads FOCUS-shaped CSVs for
cloud billing data (the FOCUS column names are shared across most major cloud and SaaS
billing exports). Loading `tokenflow-focus-*.csv` alongside a cloud bill export lets a
FinOps team see "estimated coding agent spend" as one more cost source in the same view,
explicitly marked as an estimate, never mixed silently into invoiced totals.

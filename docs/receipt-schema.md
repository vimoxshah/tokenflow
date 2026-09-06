# Receipt schema v0 and v1

A branch receipt that travels with the code — no server. `tokenflow hooks install`
attaches one to the local commit sha on every `git push`, as a git note under
`refs/notes/tokenflow`. The [GitHub Action](../action/README.md) reads that note back
on a pull request and posts (or updates) it as a comment.

The machine-readable shape is `schemas/receipt.v0.json` (JSON Schema, draft 2020-12), or
`schemas/receipt.v1.json`, which adds two optional fields on top (see
[Schema v1](#schema-v1) below). `src/analytics/receipt-schema.js` provides:

- `toReceiptV0(branchReceipt, meta)`: maps one `buildReceipts()` branch entry into
  the v0 shape.
- `validateReceiptV0(obj)` and `validateReceiptV1(obj)`: small hand-written validators
  (no dependencies), each returns `{ ok, errors[] }`.
- `validateReceipt(receipt)`: validates against whichever schema `receipt.schemaVersion`
  names (`0` or `1` today); a v0 note keeps validating forever, see
  [Schema v1](#schema-v1).
- `renderReceiptV0Markdown(receipt)`: the PR-comment table, with a leading
  `<!-- tokenflow-receipt -->` marker so CI can find and update its own comment. Renders
  a v1 receipt's `ticket`/`verdict` rows too, when present.

## The estimated-vs-measured caveat

**Every dollar figure in this receipt is an estimate**, computed locally from token
counts against a local price table (`~/.tokenflow/pricing.json` plus TokenFlow's
built-in table) — never measured billing pulled from a vendor, and never a network
call. Two things follow from that:

- A model with no configured price contributes turns (counted in `turns`,
  `subagentTurns`, `sessions`) but not dollars — `costUsd` reflects only the priced
  turns, and `coverage` says what share of turns that was. A branch with **zero**
  priced turns reports `costUsd: null`, never `0`.
- `contextShare` splits `costUsd` into what paid to re-send prior context (cache
  reads + writes) versus fresh input/output. A high share is not waste — it is the
  price of a long session — but it is where the lever is if you want a cheaper one.

`notes` carries these caveats (and others — a long-lived branch, work that predates
a matched pull request, earlier merged PRs on the same branch) as plain sentences,
so a reader of the JSON alone — not just the markdown table — sees them.

## Fields

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `schemaVersion` | integer (`0`) | no | Which version of this document the receipt follows. |
| `generatedAt` | string (date-time) | no | When this receipt was computed, in UTC ISO-8601. |
| `toolVersion` | string | no | The TokenFlow package version that computed it. |
| `repo` | string | no | The repository's name — the basename of its **main checkout**, resolved through git worktrees (never a full path, never a worktree leaf's own directory name). |
| `branch` | string | no | The branch this receipt attributes spend to. |
| `headSha` | string | no | The commit sha this receipt is attached to (7-40 lowercase hex characters). |
| `window` | object or `null` | yes | `{ first, last }` — the first and last timestamp of a priced turn on this branch. `null` when there were none. |
| `window.first` / `window.last` | string (date-time) or `null` | yes | Endpoints of the window. |
| `costUsd` | number | yes | Estimated spend attributed to this branch, in US dollars. `null` — never `0` — when nothing on this branch was priced. |
| `contextShare` | number (0–1) | yes | Share of `costUsd` that re-sent prior context rather than doing fresh work. |
| `turns` | integer | no | Turns (LLM requests) attributed to this branch, priced or not. |
| `sessions` | integer | no | Distinct sessions that touched this branch. |
| `subagentTurns` | integer | no | Of `turns`, how many ran as a subagent. |
| `models` | array | no | `{ model, costUsd, share }` per model family, most expensive first. |
| `coverage` | number (0–1) | yes | Share of `turns` priced (i.e. counted in `costUsd`). |
| `largestPromptTokens` | integer | yes | The largest single prompt (input + cache read + cache write) seen on this branch. |
| `changedLines` | integer | yes | Additions + deletions of the matched pull request. `null` with no matched PR. |
| `pr` | object or `null` | yes | `{ number, mergedAt }` of the pull request this receipt's headline is scoped to. |
| `longLived` | boolean | no | True for branch names like `main` / `staging` / `develop` — this receipt covers a period of work, not one change. |
| `costPer100Lines` | number | yes | `costUsd` scaled to 100 changed lines. `null` with no matched PR, no changed lines, or no priced turns. |
| `notes` | array of strings | no | Honesty caveats — see above. |

## Design notes

- `repo` is the repository's **name only** — never a filesystem path — because the
  receipt is meant to be read on a different machine (a CI runner, a teammate's
  laptop) than the one that produced it.
- A receipt with no local sessions for a branch is not produced at all
  (`buildBranchReceipt()` in `src/core/receipt-note.js` returns `null`); there is
  nothing to attach as a note.
- `pr` and `changedLines` are `null` for every receipt written by the pre-push hook,
  because attaching a note happens at push time, before any PR exists to look up —
  they are populated only when a receipt is built through `tokenflow receipt --gh`
  (or an equivalent supplied `--prs` list) and re-serialized through `toReceiptV0()`.

## Schema v1

`schemas/receipt.v1.json` is v0 plus two optional fields. **Nothing v0 required stops
being required**: `receipt.v1.json`'s `required` list is identical to v0's, so a v1
receipt is a v0 receipt with `schemaVersion: 1` and, optionally, these two fields set:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `ticket` | object or `null` | yes | `{ system, key, url }`, the tracked-work item (Jira, Linear, a GitHub issue, or `"other"`) this branch's work is filed against. `system` is one of `"jira"`, `"linear"`, `"github"`, `"other"`; `key` is the ticket's own identifier (e.g. `ENG-123`); `url` links to it, or `null` when there is none to link. Populated by the cost-per-ticket stream; this document is that stream's contract for the shape it writes. |
| `verdict` | object or `null` | yes | `{ maxCostUsd, maxCostPer100Lines, overBudget }`, the result of checking this receipt against a declared budget. `maxCostUsd`/`maxCostPer100Lines` are the caps that were checked (either may be `null` when that cap wasn't declared); `overBudget` is `true` when the receipt crossed at least one declared cap. `null` when no budget comparison was run. |

`src/analytics/receipt-schema.js` exports, alongside the v0 functions:

- `validateReceiptV1(obj)`: the same field-for-field checks as `validateReceiptV0`,
  plus `ticket`/`verdict` when present. Returns `{ ok, errors[] }`, same as v0.
- `validateReceipt(receipt)`: dispatches on `receipt.schemaVersion`: `0` goes to
  `validateReceiptV0`, `1` goes to `validateReceiptV1`, anything else fails with an
  "unsupported schemaVersion" error rather than silently accepting it.
- `renderReceiptV0Markdown(receipt)` renders a v1 receipt too, unchanged for v0 input.
  When `ticket` is set it adds a Ticket row (linked when `url` is set, plain text
  otherwise); when `verdict` is set it adds a Budget row saying over budget or within
  budget, with the cap(s) checked. Neither row appears for a receipt that doesn't carry
  the field (every v0 receipt, and a v1 receipt that left it `null`).

### Compatibility rule

**A v0 receipt stays valid forever.** `validateReceiptV0` is unchanged by v1's
existence: nothing about the v0 shape, its required fields, or its error messages
moved. A git note written today under `schemaVersion: 0` will still pass
`validateReceiptV0` (and `validateReceipt`) after this repository has moved on to
writing v1 notes by default. The two schemas are siblings, not a migration: nothing
reads a v0 note and rewrites it as v1, and nothing requires that it ever happen.

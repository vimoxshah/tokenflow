# Receipt schema v0

A branch receipt that travels with the code — no server. `tokenflow hooks install`
attaches one to the local commit sha on every `git push`, as a git note under
`refs/notes/tokenflow`. The [GitHub Action](../action/README.md) reads that note back
on a pull request and posts (or updates) it as a comment.

The machine-readable shape is `schemas/receipt.v0.json` (JSON Schema, draft 2020-12).
`src/analytics/receipt-schema.js` provides:

- `toReceiptV0(branchReceipt, meta)` — maps one `buildReceipts()` branch entry into
  this shape.
- `validateReceiptV0(obj)` — a small hand-written validator (no dependencies),
  returns `{ ok, errors[] }`.
- `renderReceiptV0Markdown(receipt)` — the PR-comment table, with a leading
  `<!-- tokenflow-receipt -->` marker so CI can find and update its own comment.

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

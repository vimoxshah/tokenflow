# TokenFlow receipt comment (GitHub Action)

Reads the TokenFlow receipt attached to a pull request's head commit — written there by
`tokenflow hooks install`'s pre-push hook, as a git note under `refs/notes/tokenflow` — and
posts or updates it as one PR comment. No server: the receipt already lives in your git
history, this action just surfaces it.

Requires `git notes --ref=tokenflow show <sha>` to find something. If nobody who pushed to
the PR had the pre-push hook installed (`tokenflow hooks install`), there is no note and the
action logs one line and exits 0 — it never fails a workflow over a missing receipt.

Optionally, it also judges the receipt against a budget you declare (`max-usd`,
`max-usd-per-100-lines`, or a committed policy file) and fails the job when a cap is
exceeded: that failure is what a branch protection rule or a ruleset can require, turning
this action into a merge gate. See [docs/receipts-on-github.md](../docs/receipts-on-github.md)
for the install steps and the required-check setup.

## Usage

```yaml
name: TokenFlow receipt

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # to post/update the comment

jobs:
  receipt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # notes live outside the default shallow fetch
      - uses: vimoxshah/tokenflow@v1.3.3
        # or, dogfooding this repo's own checkout: uses: ./
        with:
          token: ${{ secrets.GITHUB_TOKEN }}   # default; only pass to override
          notes-ref: tokenflow                  # default
          comment-marker: '<!-- tokenflow-receipt -->'   # default
          max-usd: '50'                          # optional: fail the job over this cap
          max-usd-per-100-lines: '5'             # optional: fail the job over this cap
          fail-on-over-budget: 'true'            # default
          policy-file: '.tokenflow/policy.yaml'  # default
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | `${{ github.token }}` | Used to list/create/update the PR comment via the GitHub REST API. |
| `notes-ref` | `tokenflow` | The git notes ref to fetch and read (`refs/notes/<notes-ref>`). |
| `comment-marker` | `<!-- tokenflow-receipt -->` | Identifies the action's own comment so a later push updates it in place instead of piling up a new one. |
| `max-usd` | *(empty)* | Cap on `receipt.costUsd`, in US dollars. Empty reads the cap from `policy-file` instead. |
| `max-usd-per-100-lines` | *(empty)* | Cap on `receipt.costPer100Lines`, in US dollars. Empty reads the cap from `policy-file` instead. Only ever evaluated on a receipt with a matched pull request (`tokenflow receipt --gh`); a hook-written receipt has no `costPer100Lines` to compare and this cap is reported "not evaluated" instead of guessed. |
| `fail-on-over-budget` | `true` | When a declared cap is exceeded, print `::error::` and fail the job (`exitCode = 1`) instead of only reporting it in the comment. |
| `policy-file` | `.tokenflow/policy.yaml` | Path, relative to the checkout, to a policy file declaring `receipt.maxCostUsd` / `receipt.maxCostPer100Lines`. Read only for whichever of `max-usd` / `max-usd-per-100-lines` is left empty. A missing or malformed file means no cap from this source, never a crash. |

## Outputs

| Output | Meaning |
|---|---|
| `cost-usd` | The receipt's `costUsd` used for the budget check, or empty when the receipt has no priced turns. |
| `over-budget` | `"true"` when any declared cap was exceeded, else `"false"`. |
| `verdict` | The budget verdict as one line of text: also the first line the comment adds above the receipt table, and what `$GITHUB_STEP_SUMMARY` carries when that env var is set. |

## Budget verdict

With no cap declared (neither input set, no policy file, or the policy file only sets keys
this action does not read), the comment and `$GITHUB_STEP_SUMMARY` are unchanged from today:
no verdict line is added, and `verdict` reports "No budget cap declared". With at least one
cap declared, a line is added above the receipt table: `**Over budget**`, `**Within budget**`,
or `**Budget cap not evaluated**` when the declared cap has nothing on this receipt to compare
against (rather than guessing a pass). A cap is exceeded only when the measured value is
strictly greater than it; equal to the cap is within budget.

## Notes on permissions

- A pull request from a **fork** runs with a read-only `GITHUB_TOKEN` by default (GitHub's
  security model for forked-repo workflows). This action's comment step will then fail —
  that failure is not swallowed; the job will show it. If you need receipts on fork PRs,
  route through `pull_request_target` with the usual caution for that trigger, or accept
  that fork PRs won't get a comment.
- `fetch-depth: 0` (or at least fetching `refs/notes/*`) is required — a shallow checkout
  does not bring notes along by default, and `git fetch origin +refs/notes/tokenflow:refs/notes/tokenflow`
  (which this action runs itself) still needs the ref to exist on the remote, which only
  happens once someone has pushed with the hook installed.

## What this action does not do

- It never reads prompt or code content — only the numbers already computed into the
  receipt (`docs/receipt-schema.md`).
- It makes no network call besides the GitHub REST API (to read/post/patch the PR comment)
  and the `git fetch` of the notes ref from the checkout's own `origin` remote.

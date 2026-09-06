# TokenFlow receipt comment (GitHub Action)

Reads the TokenFlow receipt attached to a pull request's head commit — written there by
`tokenflow hooks install`'s pre-push hook, as a git note under `refs/notes/tokenflow` — and
posts or updates it as one PR comment. No server: the receipt already lives in your git
history, this action just surfaces it.

Requires `git notes --ref=tokenflow show <sha>` to find something. If nobody who pushed to
the PR had the pre-push hook installed (`tokenflow hooks install`), there is no note and the
action logs one line and exits 0 — it never fails a workflow over a missing receipt.

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
      - uses: vimoxshah/tokenflow/action@main
        # or, dogfooding this repo's own checkout: uses: ./action
        with:
          token: ${{ secrets.GITHUB_TOKEN }}   # default; only pass to override
          notes-ref: tokenflow                  # default
          comment-marker: '<!-- tokenflow-receipt -->'   # default
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | `${{ github.token }}` | Used to list/create/update the PR comment via the GitHub REST API. |
| `notes-ref` | `tokenflow` | The git notes ref to fetch and read (`refs/notes/<notes-ref>`). |
| `comment-marker` | `<!-- tokenflow-receipt -->` | Identifies the action's own comment so a later push updates it in place instead of piling up a new one. |

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

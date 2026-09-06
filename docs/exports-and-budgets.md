# Exports that travel, and budgets per repo and per team

Two additions on top of `receipt` and the monthly `budget`: receipts and a
weekly summary you can drop into Slack or a PR, and a budget you can scope to
one repository or to your whole team.

## Receipt cards: SVG, PNG, and CSV

`tokenflow receipt --branch <name>` already prints a PR-comment receipt. Add
`--svg` to also write it as a card:

```bash
tokenflow receipt --branch feat/x --svg receipt.svg
tokenflow receipt --branch feat/x --svg receipt.svg --png receipt.png
tokenflow receipt --branch feat/x --png receipt.png   # writes receipt.png.svg too
```

The card is a plain SVG file. It opens in a browser, and it drops straight
into Slack or a PR comment as an image. Every colour on it comes from
`design/tokens.yaml`, read at render time, so it always matches the skin and
mode set in `config.yaml` (`ui.skin`, `ui.mode`). Nothing is downloaded and
nothing is drawn with a colour that is not one of the project's own tokens.

`--png` needs a local Chromium or Chrome install (checked at
`/opt/homebrew/bin/chromium`, `/Applications/Google Chrome.app`, or on your
`PATH`). When none is found, the command says so in one line and the SVG is
still there.

Add `--csv` to get one row per branch instead, across every repository the
`receipt` command would otherwise print as a table:

```bash
tokenflow receipt --csv > receipts.csv
tokenflow receipt --repo api --csv > api-receipts.csv
```

Columns: `repo, branch, costUsd, contextShare, sessions, turns, subagentTurns,
first, last, longLived, prNumber, mergedAt, changedLines, costPer100Lines`. A
missing value is an empty cell, never `0`, the same rule the rest of
TokenFlow's exports follow.

## `tokenflow week`: your AI week as a card

```bash
tokenflow week                         text summary
tokenflow week --svg week.svg          a shareable card
tokenflow week --svg week.svg --png week.png
tokenflow week --json                  everything, machine readable
```

Spend this calendar week (Monday through today) against last week (the full
prior Monday through Sunday), the context share, turns, sessions, the three
branches that cost the most, the single most expensive session, and one
sentence of insight. Every number in that sentence is a number: no "a lot" or
"much higher" without a figure next to it.

## Budgets per repository and per team

The existing monthly budget (`tokenflow budget --set 200`) still works exactly
as before. Alongside it, declare as many scoped budgets as you like:

```yaml
budgets:
  - id: api-monthly
    scope: repo            # total | repo | team
    repo: api                # required when scope is repo
    monthlyUsd: 150
    warnAt: 0.8             # optional, default 0.8 (a fraction, like limits[].warnAt)
  - id: team-monthly
    scope: team
    monthlyUsd: 1000
```

- `total`: every priced turn in the store this month.
- `repo`: turns this month attributed to that repository, resolved the same
  way `tokenflow receipt` resolves it. A worktree checkout folds into its main
  repository, so a repo's spend is never split across every worktree it ever
  had.
- `team`: this machine's shared sync folder (`sync.dir`), if `sync.enabled` is
  set. Nothing is invented: with sync off, or with a sync folder that has no
  data yet, the row says so plainly (`no team data`) rather than reporting a
  number nobody synced.

Each row reports `spentUsd`, `monthlyUsd`, `share`, and a state: `ok`, `warn`
(at or above `warnAt`), or `over` (at or above the cap).

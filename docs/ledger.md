# The Ledger — team cost per branch and per merged PR

The Ledger joins everyone's local branch-cost receipts (`src/analytics/receipt.js`)
across every machine that syncs, so a team lead can see "what did this branch
cost" and "what did merged PRs typically cost" without anyone reading anyone
else's session transcripts. It rides the same file sync as the rest of
`tokenflow sync` / `tokenflow team` — see [`configuration.md`](configuration.md)
for the `sync:` block and [`team-server.md`](team-server.md) if you push to a
self-hosted server instead of a shared folder.

Two files travel per machine, both written by `sync.push()`
(`src/core/sync.js`):

| file | shape | conflict rule |
| --- | --- | --- |
| `<machineId>.jsonl` | one line per day, coarse tokens/requests/cost | append-only, last-write-wins per line |
| `<machineId>.receipts.json` | one entry per (repo, branch) this machine has session history for | whole-state, last-write-wins |

The second file is the Ledger's input. It is written on every push unless you
set `sync.receipts: false`.

## What leaves the machine

Per branch, exactly these fields — nothing else:

| Field | Meaning |
| --- | --- |
| `repo` | The repository's name — **basename only**, never a path. |
| `branch` | The branch name. |
| `costUsd` | Estimated spend on this branch (`null` if nothing was priced — never `0`). |
| `turns` | LLM requests attributed to this branch. |
| `sessions` | Distinct sessions that touched it. |
| `subagentTurns` | Of `turns`, how many ran as a subagent. |
| `contextShare` | Share of `costUsd` that re-sent prior context vs. fresh work. |
| `first` / `last` | ISO timestamps bounding the branch's activity. |
| `longLived` | True for `main` / `staging` / `develop`-style names — this is a receipt for a period of work, not one change. |
| `pr` | `null`, or `{ number, mergedAt }` for the PR this branch shipped in. |

The whole file also carries `schema` (currently `1`), `machineId`,
`generatedAt`, and — **only if you set `sync.machineName` yourself** —
`machineName`. Unlike the daily jsonl (which always falls back to the
hostname), the ledger stays anonymous by default: it joins branch and PR
identity, which is more identifying than a coarse daily total, so machine
labelling here is opt-in on top of opt-in.

Never included, at any level: file paths, commit hashes, PR titles, diffs or
line counts, prompts, or any model/code text. The data comes entirely from
`buildReceiptsForStore()` (`src/core/bundle.js`) — this module does not
re-derive cost or open a session transcript itself.

**Known gap:** `buildReceiptsForStore()` has no PR source wired in yet (PR
matching today only happens through `tokenflow receipt --gh`, a separate CLI
path). That means `pr` is `null` on every real push right now. The field
exists so a future cached PR list needs no format change — `perMergedPr` and
the `mergedPrCount` in `byMonth` will be empty until that lands.

## Sending it to a server instead of a folder

```yaml
sync:
  enabled: true
  to: https://team-box.example.com     # or your self-hosted `tokenflow team serve`
  token: <shared-secret>               # or set TOKENFLOW_SYNC_TOKEN in the env
```

With `sync.to` set, `push()` POSTs the exact same two files' text to
`<to>/api/rollup` as `{ machineId, files: { "<machineId>.jsonl": "…", "<machineId>.receipts.json": "…" } }`
with an `Authorization: Bearer <token>` header, instead of writing them into
`sync.dir`. A non-2xx response is reported as an error with the status line
only (`sync push to <to> failed: 401 Unauthorized`) — the response body is
never printed, since a server's error page is not this tool's to surface.
See [`team-server.md`](team-server.md) for the receiving end's contract
(path, auth model, file-name allowlist, size cap).

`push()` stays synchronous when writing to a folder (matches every existing
caller). The moment a destination server is configured it necessarily makes
a network call, so that branch returns a Promise — `await push(...)` works
either way.

## The join: `team.aggregate(dir)`

`tokenflow team` (`src/core/team.js`) reads every sibling `*.receipts.json`
alongside the `*.jsonl` files it already merges for per-developer rows, and
adds a `receipts` section to its result:

- **`receipts.totals`** — `{ cost, branches, repos }` across every merged
  (repo, branch).
- **`receipts.byRepo`** — `[{ repo, cost, branches, sessions }]`, sorted by
  cost descending.
- **`receipts.byMonth`** — `[{ month, cost, mergedPrCount }]`, bucketed by the
  month of each branch's `last` activity, sorted ascending. `mergedPrCount`
  counts branches in that month whose `pr.mergedAt` is known.
- **`receipts.perMergedPr`** — `{ median, p90, sampleSize }` cost across
  branches with a known `pr.mergedAt`. `p90` follows the same convention as
  `sessionStats()`'s `p90SessionCost` in `receipt.js`: sort branch costs
  descending, take the value 10% of the way down (10% of branches cost more
  than this).
- **`receipts.concentration`** — `{ top10Share, top5 }`: the share of total
  receipt cost held by the most expensive 10% of branches (at least one
  branch), and the five most expensive branches as `{ repo, branch, cost }`.
- **`receipts.longLivedShare`** — `{ cost, share }`: how much of total
  receipt cost sits on `longLived` branches — work that a PR never bounded,
  labelled that way because it is a different kind of spend to reason about
  than a feature branch that shipped and closed.

Merging across machines, per (repo, branch): **sum** `costUsd`/`turns`/
`sessions`; take the **earliest** `first` and **latest** `last`; keep
whichever machine's view of the PR **knows a `mergedAt`** (a machine that
hasn't re-synced since the merge only sees an open PR, or none — the merged
view wins once any machine has it). `longLived` is true if any machine
reports it true (the branch-name pattern is deterministic, so this only
matters for split-second sync races).

Receipts are **not** filtered by the `from`/`to` window `aggregate()` accepts
for the daily rollup: a receipt is a lifetime-of-the-branch ledger entry, not
a per-day bucket, so there is no single day to test it against. If a team
needs a windowed view of the Ledger later, that is a follow-on, not this
join.

`renderText(aggregate(dir))` prints a "Receipts (branch × PR cost ledger)"
section using all of the above; with no `*.receipts.json` files synced yet it
prints one line saying so, rather than an empty table.

## Example

```
Receipts (branch × PR cost ledger)
  Total receipt cost   $43.00 across 3 branch(es) in 2 repo(s)

  By repo
    demo-repo               $23.00    2 branch(es)     4 session(s)
    other-repo               $20.00    1 branch(es)     3 session(s)

  Cost per merged PR   median $19.00 · p90 $20.00   (n=2)
  Concentration        top 10% of branches hold 46.5% of receipt cost
    other-repo/feature-y  $20.00
    demo-repo/feature-x  $18.00
    demo-repo/main  $5.00
  Long-lived branches  11.6% of receipt cost ($5.00) sits on long-lived branches — work not bounded by a PR

  By month
    2026-07       $20.00   1 merged PR(s)
    2026-08       $23.00   1 merged PR(s)
```

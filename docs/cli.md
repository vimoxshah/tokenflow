# CLI reference

```
tokenflow <command> [flags]
```

Every command is safe to run repeatedly, writes only inside `$TOKENFLOW_HOME` (default
`~/.tokenflow`), and makes no network requests.

Global flags: `--json`, `--quiet`, `--debug`, `--help`, `--version`.

---

## Getting started

### `setup`
Runs every adapter's `detect()`, writes `config.yaml` with what was found, and sets the timezone
and identity. Reads no usage data. Safe to re-run — it refreshes the detected provider list
without discarding your source paths or pricing.

### `up` (alias: `open`)
The "I just want to look at it" command, and what `npm start` and the double-clickable
`Refresh & Open Dashboard.command` both run.

```
refresh (budgeted, looped until the engine reports done)
  → rebuild tokenflow-dashboard.html beside it
  → serve + open the live dashboard
```

| Flag | Effect |
|---|---|
| `--budget <seconds>` | per-pass ingest budget (default 60) |
| `--passes <n>` | maximum ingest passes before giving up (default 20) |
| `--no-refresh` | skip the ingest, just rebuild + serve |
| `--no-snapshot` | skip rebuilding the offline HTML file |
| `--snapshot <file>` | write the offline file somewhere else |
| `--port`, `--host`, `--no-open` | passed through to `dashboard` |

**Keeping it fresh unattended.** `tokenflow up --no-serve` does the refresh and rebuilds the
offline file without starting a server, which is the thing to schedule. macOS (`launchd`), saved
as `~/Library/LaunchAgents/com.local.tokenflow.plist` and loaded with
`launchctl load ~/Library/LaunchAgents/com.local.tokenflow.plist`:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.tokenflow</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/tokenflow/bin/tokenflow.js</string>
    <string>up</string><string>--no-serve</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/tokenflow</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
```

Linux (systemd user timer) or plain cron works the same way:

```cron
0 9 * * * cd /path/to/tokenflow && node bin/tokenflow.js up --no-serve >/dev/null 2>&1
```

Windows, with Task Scheduler:

```bat
schtasks /create /tn "Tokenflow daily" /sc daily /st 09:00 ^
  /tr "cmd /c cd /d C:\path\to\tokenflow && node bin\tokenflow.js up --no-serve"
```

### `refresh`
Ingests new usage. Incremental by default: unchanged files are skipped without being read.

| Flag | Effect |
|---|---|
| `--provider <id[,id]>` | only these adapters |
| `--full` | re-ingest from scratch. With `--provider`, scoped: that adapter's old records are superseded, compacted away, and the aggregates rebuilt — other adapters are untouched. Without `--provider`, everything is reset. Refuses to run if a source that contributed stored records is not reachable right now (see below). |
| `--force` | with `--full`, proceed even though an unreachable source's records will be dropped and cannot be rebuilt |
| `--budget <seconds>` | stop cleanly on a file boundary and report `done: false`; run again to continue |
| `--strict` | validate every record as it is written (slower; use when developing an adapter) |
| `--quiet` | no progress line |
| `--json` | machine-readable report |

```bash
tokenflow refresh
tokenflow refresh --provider anthropic --full
tokenflow refresh --budget 30           # then run it again
```

**Why `--full` can refuse.** A full re-ingest drops the stored records for the sources in
scope and rebuilds them from the source logs. That is only safe if those logs are reachable.
Run the same command on another machine, inside a sandbox, or after the log directory has
moved, and the adapter simply detects as unavailable — an unguarded reset would delete a
corpus it cannot rebuild. So detection runs *before* anything destructive, and the command
exits non-zero with the record count at risk and the reason each source is unreachable.
Fix the path and retry, run an incremental `refresh`, restore from an export, or pass
`--force` if you really do mean discard.

### `dashboard` (aliases: `serve`, `ui`)
Starts the local server and opens a browser.

| Flag | Default |
|---|---|
| `--port <n>` | `7799` |
| `--host <addr>` | `127.0.0.1` — loopback only |
| `--no-open` | don't launch a browser |

### `demo`
Generates deterministic synthetic data and opens the dashboard. `--days <n>`, `--seed <n>`,
`--no-dashboard`. Everything it produces is labelled as demo data in the UI.

---

## Everyday

### `status`
Totals, coverage, composition, peak, cost, data health and the top insights — the same numbers
the dashboard shows, from the same analytics code. `--json` for scripting.

| Flag | Effect |
|---|---|
| `--bar` | print only the one-line menu-bar summary (see `menubar`) |
| `--mode <m>` | with `--bar`: `auto` (default) / `tokens` / `cost` / `limit` |
| `--prefix <s>` | with `--bar`: leading label (default `TF`) |

---

### `digest`
A shareable summary of a usage window, rendered from the same cube as everything else: headline
tokens/cost/requests, by source, by provider, top models, pace vs your 14-day average, nearest
capacity limit and any high-severity alerts. Markdown by default; paste it into Slack, an issue,
or a stand-up note.

```bash
tokenflow digest                       # last 7 days, markdown to stdout
tokenflow digest --format text         # plain text
tokenflow digest --from 2026-08-01 --to 2026-08-07
tokenflow digest --out week.md        # write instead of print
```

---

### `receipt`
What a branch or pull request cost. Spend is attributed per turn to the branch checked out when
the turn ran, so a long session that moves across branches is split across them. Repositories are
identified by walking up from each recorded working directory to `.git` and following a worktree's
`gitdir:` pointer back to the main checkout — every `.worktrees/<x>` counts as the repo it belongs
to. With `--gh`, merged pull requests are fetched through the GitHub CLI and joined by head branch;
each matched receipt then carries `+/−` lines and cost per 100 changed lines.

Each receipt also splits the estimate into **context** dollars (cache reads + writes: the cost of
re-sending the conversation so far) and **work** dollars (fresh input + output). Context is the
cheap path per token — a high share is not waste, it is where the lever is.

```bash
tokenflow receipt                              # every repo, top branches by spend
tokenflow receipt --repo ~/code/api --gh       # one repo, joined to its merged PRs
tokenflow receipt --repo api --branch feat/x   # one branch as a PR-comment receipt
tokenflow receipt --repo ~/code/api --gh --pr 478 --md
tokenflow receipt --prs prs.json               # PR list you exported yourself:
   # gh pr list --state merged --json number,headRefName,additions,deletions,title,mergedAt
tokenflow receipt --sessions                   # where the money goes across sessions
tokenflow receipt --sessions --cap 25,100,500  # dollars above each candidate per-session cap
tokenflow receipt --from 2026-06-01 --top 30 --automated '^release/'   # flag automated PRs
tokenflow receipt --json                       # everything, machine-readable
tokenflow receipt --csv > receipts.csv          # one row per branch, every repository
tokenflow receipt --branch feat/x --svg r.svg --png r.png   # a shareable receipt card
```

A merged PR owns the turns on its branch **up to the merge**, including work done before the PR
was opened (that work is how the PR came to exist). Turns *after* the merge are follow-up on a
checkout that kept the old branch name; they appear beside the receipt as "After the merge, same
branch" and are never counted inside it. A branch with several merged PRs attributes each turn to
the PR it shipped in. Long-lived branches (`main`, `staging`, …) are flagged: a receipt there is
for a period of work, not one change. A branch name that is deleted and reused inherits the
earlier branch's pre-merge turns under this rule; give reused names a suffix if that matters.

Sessions on a detached `HEAD` or with no branch recorded are reported as *unattributed*, never
guessed. Unpriced turns are counted and excluded from the total, never shown as `$0`.
`--sessions` labels its cap table as an upper bound: the dollars above a cap are what a guard could
have held back at most, not a saving.

`--csv` writes one row per branch (`repo, branch, costUsd, contextShare, sessions, turns,
subagentTurns, first, last, longLived, prNumber, mergedAt, changedLines, costPer100Lines`) across
every repository the plain-text table would show; combine with `--repo` to scope it to one. `--svg`
writes a shareable card built from a single branch or PR receipt (`--branch` or `--pr`); add `--png`
to also render a PNG through a local Chromium/Chrome (the SVG is still written if none is found).
Every colour on the card comes from `design/tokens.yaml`, so it matches the configured skin and
mode. See [exports-and-budgets.md](exports-and-budgets.md).

### `week`
"Your AI week": spend this calendar week (Monday through today) against last week, context share,
turns, sessions, the three costliest branches, and the single most expensive session, computed
from the same store as everything else.

```bash
tokenflow week                          # text summary
tokenflow week --svg week.svg           # a shareable card
tokenflow week --svg week.svg --png week.png   # card + a local screenshot
tokenflow week --json                   # everything, machine-readable
```

See [exports-and-budgets.md](exports-and-budgets.md).

### `budget`
Monthly spend cap with projected-overrun alerts, deduplicated so a state only alerts once.

```bash
tokenflow budget --set 200     # $200/month, warn at 80% projected
tokenflow budget               # current state: safe / approaching / over
```

A `budgets:` list in `config.yaml` adds caps scoped to one repository or to the whole team,
alongside the single monthly cap above; `tokenflow budget` prints both when any are configured. See
[configuration.md](configuration.md) for the `budgets:` shape and
[exports-and-budgets.md](exports-and-budgets.md) for how each scope's spend is computed.

---

### `guard`
A circuit breaker for the session you are in, run as a Claude Code hook. It reads the live
transcript with the same adapter and price table as everything else, then reports the running
spend, the size of the prompt now being re-sent, and the median cost of the last ten turns — and
warns or blocks against thresholds **you** declared. With none declared it is informational and
never blocks.

```bash
tokenflow guard --install                        # print the settings.json hooks block (not written)
tokenflow guard --set warnCostUsd=25,maxCostUsd=200,warnContextTokens=200000
tokenflow guard --set maxCostUsd=                # clear one threshold
tokenflow guard --session ~/.claude/projects/<slug>/<id>.jsonl   # judge one transcript
```

Hook contract: stdin carries `{session_id, transcript_path, hook_event_name, …}`. A warning is
returned as JSON — `hookSpecificOutput.additionalContext` reaches the model,
`systemMessage` reaches you. A declared cap that is reached exits `2`, which blocks a
`PreToolUse` tool call or rejects a `UserPromptSubmit` prompt with the reason on stderr; `Stop`
and `SessionStart` are never blocked. The read is incremental: each session's byte offset and open
streaming groups are kept under `~/.tokenflow/guard/`, so a large transcript is read once.

Keys: `warnCostUsd`, `maxCostUsd`, `warnContextTokens`, `maxContextTokens`, `warnMarginalUsd`.

A repository can declare its own caps in `.tokenflow/policy.yaml`, committed with the code; a
declared key there wins over the personal config, key by key.

```bash
tokenflow guard --policy                  # effective policy for the current directory
tokenflow guard --policy --cwd <dir>      # for some other directory / repository
```

Codex CLI has no blocking hook, so its integration only warns, through an OS notification:

```bash
tokenflow guard --install --codex            # print the notify = [...] line for config.toml
tokenflow guard --install --codex --apply    # append it, only if safe to do so
```

See [guard-codex.md](guard-codex.md) for the policy file shape and the Codex `notify` contract.

---

### `hooks`
Installs a `pre-push` git hook that attaches a receipt to the pushed commit as a git note under
`refs/notes/tokenflow`, so the receipt travels with the code instead of living only on this
machine. The [GitHub Action](../action/README.md) reads that note on a pull request and posts or
updates one comment.

```bash
tokenflow hooks install      # write .git/hooks/pre-push
tokenflow hooks uninstall    # remove it, restoring anything it replaced
tokenflow hooks status       # installed? chained? where?
```

The hook never blocks a push: every failure is reported on stderr with exit `0`. A hook it
replaces is kept as `pre-push.tokenflow-chained` and always runs first, keeping its own exit
code, so a pre-existing gate still gates. See [receipt-schema.md](receipt-schema.md).

---

### `providers`
What is detected, connected, or disabled, with the reason for each. `--json`.

### `provider add|remove|list <id>`
Enable or disable an adapter in `config.yaml`.

### `export`
| Flag | Effect |
|---|---|
| `--csv [file]` | request-level CSV; default name `tokenflow-usage-YYYY-MM-DD.csv` |
| `--all` | every record, ignoring filters |
| `--from` / `--to` / `--provider` / `--model` / `--client` / `--interface` / `--project` | filter the export |
| `--html [file]` | one self-contained offline dashboard file |
| `--maxRecords <n>` | records embedded in the HTML snapshot (default 20,000) |
| `--out <dir>` | output directory when no filename is given |

```bash
tokenflow export --csv --from 2026-03-14 --provider anthropic
tokenflow export --csv --all
tokenflow export --html ~/Desktop/tokenflow.html
```

Missing values are written as empty cells, never as `0`.

---

## Team & sync

### `sync`
Optional, off by default: exchange daily rollups (and, unless disabled, a branch/PR receipt
ledger) between machines through a folder you already sync, or by pushing to a server you run.

```bash
tokenflow sync                          # push this machine's files, then show the merged view
tokenflow sync --pull                   # merged view only, no push
tokenflow sync --off                    # disable sync entirely
tokenflow sync --to <url> --token <t>   # push both files to a team server instead of a folder
```

`--to` (or `sync.to` in `config.yaml`) sends the exact same two files to
`tokenflow team serve` (or any server that speaks its `/api/rollup` contract) instead of writing
them into `sync.dir`; there is no merged view to pull from a server, so this only pushes. The
token can come from `--token`, `sync.token`, or the `TOKENFLOW_SYNC_TOKEN` environment variable.
`sync.receipts: false` skips the ledger file. See [ledger.md](ledger.md) and
[team-server.md](team-server.md).

### `team`
Per-developer usage, joined from every machine's synced rollups, plus the branch/PR cost ledger
once any machine has pushed one.

```bash
tokenflow team                    # aggregated view from the shared sync folder
tokenflow team --json             # machine-readable
tokenflow team serve              # self-hosted server: same aggregate, over HTTP
```

`team serve` runs one process on a machine the team owns (LAN or Docker) so every machine can push
with `sync --to` instead of writing into a shared folder.

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | bind address; non-loopback requires a token |
| `--port` | `7790` | bind port |
| `--dir` | `<TOKENFLOW_HOME>/team` | where uploaded rollups are stored |
| `--token` | — (falls back to `TOKENFLOW_TEAM_TOKEN`) | shared bearer token |

See [team-server.md](team-server.md) for the auth model and routes.

---

## Live

These four read the watcher's snapshot (`data/status.json`) when it is fresh
and compute on the spot otherwise — so they are fast to run repeatedly and
always agree with the dashboard.

### `usage`
Today / yesterday / week-to-date / month-to-date: tokens by bucket, requests,
sessions, estimated cost, plus today's top providers and models. `--json`
returns the full slices.

### `cost`
Estimated vs measured spend for the same windows, today's spend by provider,
and the month-end projection with its confidence. `--json`.

### `capacity`
Every configured limit (see [live-mode.md](live-mode.md#capacity--budgets) and
[configuration.md](configuration.md)): bar, % of cap, burn rate, projected
exhaustion ETA, reset countdown, sorted most-urgent first. With no limits
configured it prints the exact YAML to paste instead of pretending to know
vendor quotas. `--json` includes validation errors for bad definitions.

### `forecast`
Tomorrow (with likely range), next 7 days, month-end projection, confidence,
sample size — followed by active anomaly alerts with their arithmetic.
`--json` returns `{ forecast, anomalies }`.

### `watch`
The background refresher. One cycle = incremental refresh → rebuild
`data/status.json` → (opt-in) notify transitions.

```bash
tokenflow watch                 # every watch.intervalSeconds (default 120)
tokenflow watch --interval 30   # this run only
tokenflow watch --once          # single cycle, exit (cron-friendly)
tokenflow watch --notify        # OS notifications for threshold crossings
tokenflow watch --status        # running? pid? how fresh is the data?
tokenflow watch --stop          # stop a running watcher
```

Single-instance per data home; failures back off exponentially (15-minute
ceiling) and land in `lastError`. See [live-mode.md](live-mode.md).

### `menubar`
Menu bar surfaces. On macOS the primary is **TokenFlow's own native app**:

```bash
tokenflow menubar --app               # build TokenFlow.app (swiftc), install
                                      # to ~/Applications and launch it
tokenflow menubar --app --login-item  # also add it to Login Items
```

The app shows an adaptive status item (limit % with state color > today's
cost > today's tokens). Its dropdown carries today/week/month usage, a
per-provider breakdown, capacity meters with reset countdowns and ETAs, the
forecast with confidence, high-severity anomaly alerts, freshness/watcher
badges, and Refresh-now / Open-Dashboard / Start-Stop-watcher actions.

Cross-platform text protocol for other bars:

```bash
tokenflow menubar --render            # print xbar/SwiftBar-format text
tokenflow menubar --swiftbar          # install into ~/Library/Plugins
tokenflow menubar --xbar              # install into xbar's plugin dir
tokenflow menubar --out <dir>         # any compatible bar's plugin dir
tokenflow menubar --mode <m>          # auto | tokens | cost | limit
```

Requires `swiftc` for `--app` (`xcode-select --install` provides it).

---

## Configure

### `pricing`
With no flags: every model in the store, its token volume, estimated cost, effective $/1M, and
which source its rate came from.

```bash
tokenflow pricing
tokenflow pricing --sources                               # provenance + tier multipliers
tokenflow pricing --set "claude-opus-5=5,25,0.5,6.25"     # input,output[,cacheRead[,cacheWrite]]
tokenflow pricing --unset claude-opus-5
```

Rates are USD per 1,000,000 tokens. Run `tokenflow refresh --full` afterwards to re-cost history.
Anything left unpriced shows as "no price", never as `$0`.

`--sources` prints, for every group of built-in rates, the URL it was taken from, the date it was
fetched, and whether the source is official or third-party — plus the service-tier multipliers
that get applied per request, and the one premium tier that is deliberately *not* applied
(long-context).

### `pricing diff`
Compares a candidate price table to the current effective one (the overrides file layered on the
built-in table, same as every other command resolves it) and prints what would change: models
added, rates changed with the percent change per field, and current overrides the candidate says
nothing about.

```bash
tokenflow pricing diff table.json              # print the diff only
tokenflow pricing diff table.json --apply      # print, then confirm interactively (y/N)
tokenflow pricing diff table.json --apply --yes   # print and apply, no prompt (scripts, CI)
```

`--apply` merges the candidate's models into the overrides file; it never replaces it, and a
model the candidate does not mention keeps its existing override untouched. Refused when the
candidate has an invalid entry, or (without `--yes`) when stdin is not an interactive terminal.

### `import <file>`
Generic import for CSV / TSV / JSON / JSONL / SQLite. With no `--field` flags it prints the
columns it found, infers a mapping, and previews five normalized rows.

| Flag | Effect |
|---|---|
| `--name <n>` | mapping name (default: the filename) |
| `--format csv\|tsv\|json\|jsonl\|sqlite` | override detection |
| `--table <t>` / `--query <sql>` | SQLite source |
| `--field <schemaField>=<column>` | repeatable |
| `--default <field>=<value>` | repeatable, e.g. `--default client=openrouter` |
| `--timestamp-format iso\|epoch_ms\|epoch_s` | |
| `--dry-run` | preview only, save nothing |

```bash
tokenflow import ~/Downloads/usage.csv --dry-run
tokenflow import ~/Downloads/usage.csv --field timestamp=created_at --field input_tokens=prompt_tokens
```

### `restore <file.csv>`
Rebuilds the store from a full export (`tokenflow export --csv --all`) and re-prices every
*estimated* cost with the current price table. Measured costs — a gateway's own billing
numbers — are preserved verbatim and never re-estimated.

| Flag | Effect |
|---|---|
| `--yes` | required when the store already holds records; a restore replaces the dataset |
| `--no-reprice` | keep the costs exactly as exported |

```bash
tokenflow export --csv --all             # on the machine that has the logs
tokenflow restore tokenflow-usage-2026-08-20.csv --yes
```

Three reasons to reach for it:

- **portability** — move a dataset between machines, or into a team roll-up, without
  shipping the vendors' raw session logs. The CSV holds counts and identifiers; prompts,
  conversations and source code never leave the machine that produced them.
- **recovery** — rebuild after the source logs have been rotated, pruned, or moved.
- **re-pricing** — apply a price-table update to all of history without re-reading
  gigabytes of logs.

What restore cannot recover: per-record `metadata` (working directory, streaming audit
trail, price provenance) is not part of the CSV contract. Restored records carry
`metadata.restored_from` instead.

A restored slice is provisional. The next `refresh` that actually reaches a source's logs
marks the restored records for that source stale, compacts them away and rebuilds the
aggregates — so a restore and a real re-read can never be double counted.

### `config show|path|export|import`
```bash
tokenflow config show                    # effective config as YAML
tokenflow config path                    # the data home
tokenflow config export backup.json      # config + pricing + mappings (no usage data)
tokenflow config import backup.json      # restore on another machine
```

---

## Maintain

### `doctor`
Runtime, `node:sqlite` availability, timezone, every path, store size, cube rows, sessions,
pending compaction, and every adapter's detection status. Start here when something is off.

After the Store section, an **Audit** block runs seven data-quality checks over the last three
months of records: git worktrees fragmenting a repository's spend, a recorded cwd outside any
repository, Codex records with no git branch, unpriced models, a stale built-in price table,
session-level sources present in per-turn views, and records explicitly marked
`metadata.repoResolved === false`. Each line names the check, its severity (`ok` / `info` / `warn`
/ `fail`), and a one-line fix when it is not clean.

### `validate`
Re-validates every stored record against the schema and reports the failure modes by frequency.
Exits non-zero if anything is invalid.

### `compact`
Rewrites the record shards without superseded generations and rebuilds the aggregates. Normally
automatic after a scoped `--full` or after a restored slice is superseded; run it manually if
`doctor` reports pending stale generations.

| Flag | Effect |
|---|---|
| `--recount` | rebuild and re-derive the record counts even when there is nothing to compact |

Record counts in `state.json` accumulate as records are ingested. After a restore, a scoped
re-ingest, or a compaction they are re-derived from the records that actually survived — so the
stored count is the store's real size, not a lifetime total. `--recount` forces that derivation
on demand.

### `reset --yes`
Deletes ingested data. Config, pricing and mappings are kept.

---

## npm script wrappers

```bash
npm run setup       npm run refresh     npm run status
npm run dashboard   npm run demo
npm test            npm run lint        npm run typecheck   npm run validate
```

## Environment

| Variable | Effect |
|---|---|
| `TOKENFLOW_HOME` | data + config directory (default `~/.tokenflow`) |
| `TOKENFLOW_DEMO=1` | enable the mock provider |
| `CLAUDE_CONFIG_DIR` | extra Claude Code home(s) for the anthropic adapter |
| `CODEX_HOME` | extra Codex home for the openai adapter |
| `NO_COLOR` | plain output |

## Exit codes

`0` success · `1` a command failed, or `validate` found invalid records.

## Scripting

`--json` on `refresh`, `status` and `providers` emits machine-readable output:

```bash
tokenflow refresh --json | jq '.newRecords, .done'
tokenflow status --json  | jq '.health.grade, .meta.coverage'
tokenflow providers --json | jq '.[] | select(.available) | .id'
```

A nightly refresh needs nothing more than:

```cron
17 3 * * *  cd ~/tokenflow && node bin/tokenflow.js refresh --quiet
```

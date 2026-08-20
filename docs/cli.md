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

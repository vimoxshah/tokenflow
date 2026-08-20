# Troubleshooting

Start here:

```bash
tokenflow doctor      # runtime, paths, store, every adapter's detection status
npm run validate     # incl. whether the aggregates still agree with the stored records
```

---

## "No usage sources found"

That is a normal answer, not a failure. Check where your tool actually keeps its logs, then point
at it:

```yaml
# ~/.tokenflow/config.yaml
sources:
  anthropic:
    paths: ["/custom/claude/home", "~/.claude-work"]
  openai:
    paths: ["/custom/codex/home"]
```

An adapter is only "available" if the specific directory or file it names exists. `tokenflow
providers` prints the exact reason for each one.

No supported tool at all? Either `tokenflow import <file>` an export, or `tokenflow demo` to explore.

## "node:sqlite is unavailable"

You are on Node < 22.5. Upgrade Node; the SQLite-backed adapters (`cursor`, and `generic` with
`--format sqlite`) will start working. Everything else is unaffected.

## Refresh is slow

The first ingest reads everything once; after that it should be seconds. If it stays slow:

- `tokenflow doctor` → is `files tracked` growing every run? A source whose files are rewritten
  rather than appended can't be resumed, and will be re-read each time.
- Network drives and FUSE mounts are the usual culprit. The store handles mounts that refuse
  `rename`/`unlink`, but read throughput is what it is.
- Cap the work and resume: `tokenflow refresh --budget 30`, repeatedly.

## Refresh hit the time budget

Expected, by design. Progress was saved. Run it again — it continues at the byte offset where it
stopped:

```bash
until node bin/tokenflow.js refresh --budget 30 --quiet | grep -q 'budget reached'; do :; done
```

## The numbers look too high

This is the failure mode worth being suspicious about, and there are three real causes.

**Streaming logs re-report usage.** Both shipped adapters handle it, but a custom adapter probably
doesn't. Symptom: one day, or one session, dwarfs everything else by 10–100x. Check
`metadata.token_count_events` / `metadata.usage_segments` in the Data Explorer — a record built
from hundreds of events is a reconstruction, and if your adapter summed them it inflated them.
See [creating-provider.md](creating-provider.md#5-watch-for-re-reported-usage).

**Overlay double counting.** If "Include gateway overlay" is on, proxy records are being added to
client records for the same traffic. Turn it off (it is off by default) — overlay exists for the
measured *cost*, not for tokens.

**Cache read counted as input.** If your adapter passed a vendor's inclusive `input_tokens`
straight through, every cached prompt token is counted twice. `input + cache_read` should be the
prompt side, with no overlap.

Sanity check any suspicious day against the raw source:

```bash
tokenflow export --csv --from 2026-08-15 --to 2026-08-15
```

…then compare with whatever independent record you have (a gateway log, a billing page). Two
sources agreeing is worth more than one source being plausible.

## The numbers look too low

- **Active days** counts days with *measured tokens*. Days where only a no-token source (Cline,
  Cursor, git) was active are reported separately as "activity-only" — that is why the count can
  be lower than you expect.
- Check the **date filter**. `ui.defaultFrom` sets a floor for the default view; the data is still
  there. Click "Since …" or set an explicit range.
- Check **Data health → Sources**: each adapter's real coverage window is listed. A source that
  only started logging in July does not cover March.
- Many tools prune their own logs (Claude Code defaults to ~30 days). Nothing can recover data the
  source already deleted.

## Cost shows nothing / "no price"

By design: no rate in the table, no number. See what is missing and fix it:

```bash
tokenflow pricing
tokenflow pricing --set "your-model=15,75,1.5,18.75"
tokenflow refresh --full
```

Newly released models are the usual case — the built-in table only carries rates that were
published when it was built (its version is shown in the dashboard footer).

## Cost coverage is under 100%

Expected when some models are priced and others aren't. The Cost page states the covered share and
lists the unpriced models by volume. The **estimated** total covers only priced requests; the
**measured** figure, if present, covers only gateway-routed traffic. They are shown separately
because they measure different things.

## "Data health: Good" instead of "Excellent"

The grade is driven by the share of token fields the *sources* didn't report. A dataset containing
Cline or Cursor records will never be "Excellent" — those sources report no tokens at all. Check
**Data health → Field availability** for the per-field breakdown.

## Interface shows "Unknown"

The source record had no surface field. Interface is deliberately never inferred from the model.
If you know what a client is, say so:

```yaml
interfaceOverrides:
  my-custom-client: "API"
```

## The dashboard is empty but `status` shows data

Almost always the date filter. Click **Since …**, or clear filters via the breadcrumb. The
breadcrumb above the tabs always lists every active filter.

## "a refresh is already running"

One refresh at a time, so two writers can't interleave into the store. Wait for it, or restart the
server.

## Aggregates disagree with the records

```bash
npm run validate     # reports drift between the cube and the stored facts
tokenflow compact     # rewrites shards without superseded records and rebuilds
```

This can happen if a process was killed mid-refresh. `compact` is always safe to run.

## Port already in use

```bash
tokenflow dashboard --port 8080
```

## `refresh --full` says it is "refusing a full re-ingest"

The command was about to drop stored records belonging to a source whose logs it cannot read
right now, so it stopped and told you how many and why. This is the guard working, not a
failure. Usual causes:

- you are running from a different machine, container or sandbox than the one that ingested
- a source path in `config.yaml` moved (`~/.claude`, `~/.codex`, a Cursor DB)
- the log directory was pruned or archived

```bash
tokenflow doctor                       # which paths resolve, which adapters detect
tokenflow refresh                      # incremental is always safe
tokenflow restore export.csv --yes     # rebuild from a full export instead
tokenflow refresh --full --force       # only if you really mean "discard those records"
```

## I moved to a new machine / the logs are gone

Export on the machine that has the logs, restore on the one that does not. The CSV carries
counts and identifiers only — prompts, conversations and code stay put.

```bash
# old machine
tokenflow export --csv --all
# new machine
tokenflow restore tokenflow-usage-2026-08-20.csv --yes
```

Estimated costs are recomputed with the current price table on restore (`--no-reprice` to
keep them as exported); measured costs are preserved. Per-record `metadata` is not part of a
CSV export and is not restored. If the real logs later become reachable again, just
`refresh` — the restored slice is superseded automatically rather than double counted.

## I want to start over

```bash
tokenflow reset --yes     # deletes ingested data, keeps config, pricing and mappings
tokenflow refresh
```

Or delete the whole thing: `rm -rf ~/.tokenflow`. Nothing lives anywhere else.

## Something is genuinely broken

```bash
node bin/tokenflow.js doctor
node bin/tokenflow.js refresh --strict --debug --provider <suspect>
npm test
```

`--strict` validates every record as it is written and prints the first failures with the adapter
that produced them, which is usually enough to localise the problem to one adapter and one field.

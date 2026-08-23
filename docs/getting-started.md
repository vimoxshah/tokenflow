# Getting started

## Requirements

- **Node 22.5 or newer.** 22.5 is where `node:sqlite` and the built-in test runner landed; both
  are used. Check with `node -v`.
- Nothing else. This project has **zero runtime dependencies** — `npm install` does nothing and
  is not required.

## Install

**macOS, from a DMG:** download `TokenFlow-<version>.dmg` from the
[latest release](https://github.com/vimoxshah/tokenflow/releases/latest), open it, drag
**TokenFlow.app** to Applications, launch from Launchpad. The app builds and launches everything
it needs — refresh, watcher, dashboard. It is unsigned: right-click → Open the first time.

The DMG is produced by [`scripts/build-dmg.sh`](../scripts/build-dmg.sh) and attached to releases
automatically by [`.github/workflows/release.yml`](../.github/workflows/release.yml). Releases
also carry `tokenflow-dashboard-demo.html` — a fully offline demo dashboard you can open in any
browser without installing anything.

**From source (all platforms):**

```bash
git clone <this repo> tokenflow
cd tokenflow
node bin/tokenflow.js --help
```

To get a global `tokenflow` command:

```bash
npm link          # or: npm i -g .
tokenflow --help
```

Everything below works either way; `npm run <script>` wrappers exist for `setup`, `refresh`,
`status`, `dashboard`, and `demo`.

## 1. Look around first (optional)

```bash
npm run demo
```

Generates deterministic synthetic data and opens the dashboard. Every demo record is flagged, and
the dashboard shows a red **DEMO DATA** banner for as long as any of it is in scope, so it can
never be mistaken for your own usage. To clear it later:

```bash
tokenflow provider remove mock
tokenflow refresh --full
```

## 2. Detect your tools

```bash
tokenflow setup
```

```
Tokenflow — setup
config home: /Users/you/.tokenflow

  ✓ Anthropic (Claude Code / Agent SDK)      ~/.claude, ~/.claude-work
  ✓ OpenAI (Codex CLI / IDE / Desktop)       /Users/you/.codex
  ✓ Cline CLI                                22 session directories · no token fields reported
  ✓ Cursor (AI code activity)                activity source — AI-authored edits + commits
  ○ Headroom gateway (overlay)               No ~/.headroom/savings_events.jsonl found
  ○ Git activity (correlation)               no repositories found — set sources.git.scanRoots

✓ wrote /Users/you/.tokenflow/config.yaml
```

`setup` only writes config. It reads no usage data yet.

**Nothing detected?** That is a normal answer, not a failure. Either the tools store their logs
somewhere non-standard (point at it: `sources.<id>.paths`), or you want
[`tokenflow import`](cli.md#import) for an export file, or `tokenflow demo` to explore.

## 3. Ingest

```bash
tokenflow refresh
```

```
  ✓ anthropic    44,820 new records · 5,110 files read, 0 unchanged of 5,110 found · 1.4 GB
  ✓ openai        4,460 new records · 625 files read, 0 unchanged of 625 found · 3.8 GB
  ✓ cline            22 new records · 22 files read, 0 unchanged of 22 found · 92.2 KB
  ✓ cursor       12,480 new records
  ○ git          no repositories found — set sources.git.repos or sources.git.scanRoots

  61,782 new records · 5.2 GB read · 0 files skipped as unchanged · 29s
```

Run it again and it costs almost nothing — unchanged files are skipped without being read:

```
  0 new records · 0 B read · 5,757 files skipped as unchanged · 2s
```

If a first ingest is too big for the time you have, cap it and resume:

```bash
tokenflow refresh --budget 30    # stop cleanly after ~30s
tokenflow refresh --budget 30    # continue exactly where it stopped
```

## 4. Open the dashboard

```bash
tokenflow dashboard
```

The server binds to `127.0.0.1` only. The browser downloads one pre-aggregated bundle and then
does every filter and aggregation locally, so filtering is instant and offline.

Click **↻ Refresh data** any time — it re-ingests, streams progress, and keeps your filters.

### The one-command version

```bash
npm start            # = tokenflow up
```

On macOS you can double-click **`Refresh & Open Dashboard.command`** in the project folder
instead (it is a bash script, so on Windows stay with `npm start`). Either way it refreshes, rebuilds the offline `tokenflow-dashboard.html` beside it, and
opens the live dashboard. That is the thing to use when you come back after a few days.

The offline file, opened on its own, states how old its data is and looks for a live dashboard on
loopback; if it finds one it offers to hand over and refresh there. To keep the file current
without thinking about it, schedule `tokenflow up --no-serve` (see
[cli.md § up](cli.md#up-alias-open) for a ready-made launchd plist and cron line).

## 5. Pick a look (optional)

Three skins, each with a dark and a light mode. Switch from the header (**◑ Aurora**), or set the
default:

```yaml
# ~/.tokenflow/config.yaml
ui:
  skin: aurora    # aurora | terminal | editorial
  mode: dark      # dark | light
  port: 7799
```

Series colours belong to the mode, not the skin, and were validated for colour-blind separation
against every skin's chart surface — so changing the look never changes what a colour means.

Every field is documented in **[configuration.md](configuration.md)** — that is the page to open
when you want to change something and are not sure what it affects.

## 6. Set the default window (optional)

If your store contains older records you don't normally want in scope:

```yaml
# ~/.tokenflow/config.yaml
ui:
  defaultRange: all       # all | 7d | 30d | 90d | mtd
  defaultFrom: "2026-03-14"
```

`defaultFrom` is a floor for the default view, not a filter on the data — everything stays in the
store and in `--all` exports.

## 7. Turn on cost (optional)

Cost is blank until a model has a price. See what is missing:

```bash
tokenflow pricing
```

```
  MODEL                              TOKENS     STATUS
  claude-opus-5                      6.35B      no price
  gpt-5.6-luna                       1.71B      no price
  claude-3-5-sonnet-20241022         88.1M      priced  $264.30 est.
```

Add rates in USD per million tokens — `input,output[,cacheRead[,cacheWrite]]`:

```bash
tokenflow pricing --set "claude-opus-5=15,75,1.5,18.75"
tokenflow refresh --full          # re-cost the history
```

Or use the **Pricing** dialog in the dashboard, which lists your models by volume and saves +
re-costs in one step. Anything you leave blank stays unpriced — the dashboard shows "no price"
rather than a plausible-looking `$0`.

## 8. Correlate with your actual work (optional)

```yaml
sources:
  git:
    scanRoots: ["~/code", "~/work"]
    autoFromUsage: true    # also use the working directories seen in usage records
```

```bash
tokenflow provider add git && tokenflow refresh
```

The Productivity page will then correlate daily AI usage with commits, files changed and line
churn — over the overlapping days only, with `n` reported, and labelled as a correlation. With
fewer than 10 overlapping days it tells you that instead of showing a number.

## 9. Export

```bash
tokenflow export --csv                # the current filter
tokenflow export --csv --all          # everything
tokenflow export --html               # one self-contained offline dashboard file
```

## Where everything lives

```
~/.tokenflow/
  config.yaml        providers, source paths, preferences
  pricing.json       your rate overrides
  mappings/          saved generic-import field mappings
  providers/         your own adapters (*.js), loaded automatically
  data/
    records/         YYYY-MM.jsonl — request-level facts
    cube.json        the pre-aggregated table the dashboard loads
    sessions.json    one row per session
    activity.json    daily work-activity rollup
    state.json       per-file ingest offsets (this is what makes refresh incremental)
  cache/
```

Move it with `TOKENFLOW_HOME=/some/path tokenflow ...`, back it up with
`tokenflow config export`, and restore with `tokenflow config import`.

## Verify the install

```bash
npm run validate
```

Checks the runtime, the config, every adapter's `detect()`, and — importantly — that the
aggregates still agree with the stored records. If they have drifted, it tells you to run
`tokenflow compact`.

## Next

- Numbers look wrong? → [troubleshooting.md](troubleshooting.md)
- Want another source? → [providers.md](providers.md), [creating-provider.md](creating-provider.md)
- Want an agent to set this up on a new machine? → [skill.md](skill.md)
- Changing a setting? → [configuration.md](configuration.md)

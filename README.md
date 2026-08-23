<h1 align="center">TokenFlow</h1>

<p align="center">
  <strong>See where your AI tokens actually go.</strong><br>
  Local-first analytics for tokens spent across Claude Code, Codex, OpenCode, Cline,
  Cursor, Hermes — or anything you can point it at.
</p>

![CI](https://github.com/vimoxshah/tokenflow/actions/workflows/ci.yml/badge.svg)
![node >= 22.5](https://img.shields.io/badge/node-%3E%3D22.5-informational)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

![Overview — Aurora dark](docs/media/overview-aurora-dark.png)

Zero runtime dependencies. Nothing leaves your machine. No API keys, no accounts, no telemetry.

### Install

**macOS app** — download `TokenFlow-*.dmg` from the
[**latest release**](https://github.com/vimoxshah/tokenflow/releases/latest) (each release also
carries `tokenflow-dashboard-demo.html`, an offline demo dashboard that opens in any browser).
Open the DMG, drag **TokenFlow.app** to Applications, launch from Launchpad.

> The build is unsigned (no Apple Developer account), so macOS blocks the first launch. This is
> expected and one-time only:
> 1. Open **System Settings → Privacy & Security** → scroll to **Security**.
> 2. Click **Open Anyway** next to the "TokenFlow was blocked" message.
> 3. Confirm **Open**.
>
> Alternatively right-click the app → **Open** → **Open**.

Then click the menu bar item → **Run setup**, which detects your installed tools and writes
`~/.tokenflow/config.yaml`. The watcher refreshes every two minutes after that.

**From source** (macOS, Linux, Windows — needs Node 22.5+, nothing else):

```bash
git clone https://github.com/vimoxshah/tokenflow.git && cd tokenflow
npm run setup        # detect Claude Code, Codex, OpenCode, Cursor, Cline…
npm start            # ingest what's new, then open the dashboard
```

No `npm run install` needed — zero dependencies. If nothing is detected, `node bin/tokenflow.js
providers` tells you what it looked for and where.

Just want a look first? `npm run demo` generates clearly-labelled synthetic data and opens the
dashboard.

---

## What it does

| Question | Where |
|---|---|
| How much AI did I use, and how has that changed? | Overview — KPIs, daily series, trend |
| Input vs output vs cache? | Token composition — four buckets that sum to the total |
| Which provider and model do I rely on? | Provider & model share, growth, per-model efficiency |
| When do I use AI most? | Time patterns — hour/weekday profiles, heatmap, calendar |
| What does it cost? | Cost — estimated from a versioned price table with stated coverage |
| Does usage track shipped work? | Productivity — correlations with git activity, labelled as correlations |
| What changed between two periods? | Compare — any two windows, metric by metric |
| Can I trust these numbers? | Data health — per-field availability, per-adapter coverage |

<details>
<summary>All pages</summary>

Overview · Token composition · Providers & models · Interfaces · Time patterns · Peaks ·
Efficiency · Cost · Productivity · Compare · Data explorer (searchable/sortable/exportable) ·
Data health

</details>

*Every screenshot uses `npm run demo` data, which the UI labels as synthetic.*

## Supported sources

| Adapter | Source | Reports |
|---|---|---|
| `anthropic` | `~/.claude*/projects/**/*.jsonl` | per-request input, output, cache read/write, thinking |
| `openai` | `~/.codex/sessions/**/*.jsonl` | per-turn fresh/cached input, cache write, output, reasoning |
| `opencode` | opencode.db (XDG data dir) | per-request fresh input, cache read/write, output |
| `hermes` | `~/.hermes/state.db` | per-session-per-model tokens, measured cost when recorded |
| `cline` | `~/.cline/data/sessions/**` | sessions + model only — this source has no token counts |
| `cursor` | cursor ai-code-tracking db | AI-authored edits per commit |
| `headroom` | `~/.headroom/savings_events.jsonl` | measured cost + compression delta from a local gateway (overlay) |
| `git` | any repository | commits, churn — independent work signal |
| `generic` | CSV / TSV / JSON / JSONL / SQLite | anything via a saved field mapping |
| `mock` | — | deterministic demo data, always labelled |

New adapters drop into `src/providers/<id>/index.js` or `$TOKENFLOW_HOME/providers/*.js`; new
providers and models appear in every chart automatically. See [docs/providers.md](docs/providers.md).

## Correctness guarantees

The parts most token dashboards get wrong:

- **Cache tokens are not input tokens.** Fresh input, `cache_read`, `cache_write` and output are
  mutually exclusive and sum to the total; long-TTL refreshes and reasoning are subsets, never
  added again.
- **Vendors disagree on `input_tokens`.** Anthropic excludes cache; OpenAI includes cached input.
  The OpenAI adapter subtracts so nothing counts twice.
- **Streaming logs re-report usage.** Summing them inflates totals badly (on our test corpus, ~45x
  for Codex). Adapters take the maximum of each monotonic run instead.
- **Missing ≠ zero.** Unknown token fields are `null`, never coerced to `0`; sums skip nulls and
  report coverage.
- **Overlay measurements don't inflate totals.** Gateway/proxy records describe traffic another
  adapter already counted; they're excluded by default and used only for measured-cost cross-checks.
- **No invented prices.** Unpriced models show `null` cost and are listed for configuration — never
  silently `$0`.

## Refresh model

Transcripts are append-only, so the store tracks each file's `{size, mtime, offset}`: unchanged
files are skipped entirely, grown files resume at their byte offset, rewrites are superseded and
compacted. On a real 1.5 GB / 5,110-file corpus: ~15 s first ingest, ~2 s no-op refresh.
`refresh --budget 30` stops cleanly on a file boundary and resumes later — big ingests fit inside
CI steps or browser requests.

## CLI

```bash
node bin/tokenflow.js setup          # detect tools, write ~/.tokenflow/config.yaml
node bin/tokenflow.js refresh        # incremental ingest (--full re-reads everything)
node bin/tokenflow.js status         # current numbers, same modules the dashboard calls
node bin/tokenflow.js providers      # what was detected, where
node bin/tokenflow.js dashboard      # live UI at http://127.0.0.1:7799 (loopback only)
node bin/tokenflow.js watch          # auto-refresh every N seconds (default 120)
node bin/tokenflow.js import f.csv   # CSV/JSONL/SQLite via saved field mapping
node bin/tokenflow.js export --csv   # --all for everything; --html for offline snapshot
node bin/tokenflow.js up             # refresh → rebuild offline HTML → serve + open

npm link                             # optional: global `tokenflow` command
```

Every command is documented in [docs/cli.md](docs/cli.md); every config field in
[docs/configuration.md](docs/configuration.md).

## Menu bar app (macOS)

```bash
node bin/tokenflow.js menubar --app   # builds & launches the native app
```

A small native Swift app compiled on your machine (no Electron): status item shows spend today or
limit pressure (`▲ 82%`, `✗ 105%`), with a dropdown covering today/week/month, per-provider rows,
capacity meters with reset countdowns, forecast, and anomaly alerts. Declare caps yourself:

```yaml
limits:
  - id: anthropic-monthly
    provider: anthropic
    scope: month
    metric: tokens            # or cost / requests / input / output
    cap: 120000000
```

Quotas exist because you declared them — none are invented. Details:
[docs/live-mode.md](docs/live-mode.md). SwiftBar users: `menubar --swiftbar --out <dir>`.

## Themes & export

Three skins (Aurora default, Terminal, Editorial) × dark/light, persisted via `ui.skin` /
`ui.mode`. Series colours belong to the mode, not the skin, validated for colour-blind separation —
switching themes never changes what a colour means.

`export --html` produces one self-contained offline file (CSS + analytics + data inline) that opens
from `file://` with no server. A full CSV export doubles as a portable dataset:
`tokenflow restore <file>.csv --yes` rebuilds a store on another machine without the raw vendor logs.

## Contributing

```bash
npm test               # 102 tests: normalization, adapters, analytics, store, formatting
npm run lint           # project invariants (incl. "no || 0 on a token field")
npm run typecheck      # tsc over JSDoc types — must be zero errors
npm run validate       # self-check: runtime, adapters, store↔cube agreement
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it states the five invariants that keep this honest
(missing is not zero; measured and estimated never mix; a streamed usage block is a snapshot;
tokens are not productivity; nothing leaves the machine).

Easiest contribution: an adapter (`src/providers/<id>/index.js`) plus a fixture under
`test/fixtures/`, stating in its header comment what each vendor field means.

## Documentation

- [getting-started.md](docs/getting-started.md) — install to first dashboard
- [live-mode.md](docs/live-mode.md) — watcher, menu bar, capacity, forecasts
- [configuration.md](docs/configuration.md) — every config field
- [providers.md](docs/providers.md) — every adapter, what it reads
- [data-model.md](docs/data-model.md) — schema and token accounting rules
- [creating-provider.md](docs/creating-provider.md) — the adapter contract
- [cli.md](docs/cli.md) — every command and flag
- [architecture.md](docs/architecture.md) — layers and plugin points
- [troubleshooting.md](docs/troubleshooting.md) — when the numbers look wrong

## Privacy & security

Local data → local normalization → local analytics → local dashboard. The server binds to
`127.0.0.1`. No prompt text, code, or file content is ever stored — adapters read token counts and
discard the rest. No telemetry, no network client anywhere in the codebase (verify:
`grep -rn "fetch\|https\?://" src/`). Everything lives in `~/.tokenflow/`.
[SECURITY.md](SECURITY.md) covers the threat model and private vulnerability reporting.

## License

MIT — see [LICENSE](LICENSE).

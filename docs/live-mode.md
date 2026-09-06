# Live mode — the watcher, the native menu bar app, capacity and alerts

Everything in this document runs **locally**. The watcher reads your logs, the
menu bar app reads one JSON file, notifications come from your operating
system. No network client exists anywhere in the codebase.

```
tokenflow watch  ──every N s──▶  incremental refresh
        │
        ▼
data/status.json   ◀── read by ──▶  TokenFlow.app (native macOS menu bar)
        │                            tokenflow usage / cost / capacity / forecast
        │                            tokenflow status --bar
        ▼                            dashboard header pill + Live tab
OS notifications (opt-in): limit crossings, same-day high-severity anomalies
```

## The watcher

```bash
tokenflow watch              # start; Ctrl+C stops it
tokenflow watch --interval 30
tokenflow watch --once       # one cycle and exit — what cron wants
tokenflow watch --status     # running? how fresh is the data?
tokenflow watch --stop       # stop a running watcher
tokenflow watch --notify     # enable OS notifications for this run
```

Properties that matter:

- **Single instance.** A pidfile guards the store. A crashed run leaves a dead
  pid behind; the next start detects it and takes over.
- **Failure isolation with backoff.** A failing refresh doubles the interval,
  up to a 15-minute ceiling, and records `lastError` in the status file
  instead of crashing or spamming.
- **Sleep/wake is free.** Each tick reschedules from wall-clock reality, so a
  laptop that slept for three hours wakes to exactly one refresh, never a
  catch-up burst.
- **Honest freshness.** Every surface recomputes "stale?" at *read* time from
  `lastRefresh`, against `watch.staleAfterSeconds` (default 600). Old data
  says so; nothing silently pretends to be real-time.

Defaults live in `config.yaml`:

```yaml
watch:
  intervalSeconds: 120
  notifications: false     # or pass --notify per run
  staleAfterSeconds: 600
```

`tokenflow up` remains the pull-based path (`refresh → snapshot → open`); the
watcher is the push-based one. They share the same incremental engine and can
interleave safely — a manual refresh during a watched cycle simply coalesces.

## Capacity & budgets

TokenFlow **never invents vendor quota data** — there is no network client, so
no screen claims to know what Anthropic or OpenAI think your balance is.
Instead you declare caps, and the engine evaluates them against measured
consumption:

```yaml
limits:
  - id: anthropic-monthly
    provider: anthropic      # optional filters: provider | model | project
    scope: month             # day | week | month  (your local calendar)
    metric: tokens           # tokens | input | output | requests | cost
    cap: 120000000           # tokens — or dollars when metric is cost
    warnAt: 0.8              # optional: when "approaching" starts
```

For each limit the Live tab and `tokenflow capacity` derive:

| Field | Meaning |
|---|---|
| used / remaining | consumption inside the current window |
| % / bar | fraction of cap consumed |
| burn/hour | today's pace so far (local wall clock) |
| burn/day | trailing 7 calendar days, trimmed to dataset coverage |
| ETA | projected exhaustion at the faster of the two paces |
| resets in | deterministic countdown to local midnight / Monday / 1st |

Limits evaluate against the whole primary dataset regardless of dashboard
filters — quota windows are facts about your accounts, not filter states.
Invalid definitions are reported (`tokenflow capacity --json` → `invalid`),
never silently dropped. Edit them in the dashboard's **Live → Manage limits**
or by hand in `config.yaml`.

## Forecasting

`tokenflow forecast` fits a conservative linear trend over the last 14 days
(minimum 5), reports tomorrow's likely range, next-7-days and month-end totals
with cost, and states its confidence (high / medium / low) plus sample size.
Month-to-date is always shown separately from the projection. Thin or volatile
history degrades confidence honestly instead of producing confident nonsense.

## Anomalies

Detection uses robust statistics (median / MAD, Iglewicz–Hoaglin modified
z-score ≥ 3.5):

- token, cost and request-volume spikes (and weekday collapses)
- possible ingestion gaps — a zero weekday between two active days
- models/providers appearing for the first time this week

Every alert carries its own arithmetic — observed value, trailing median,
ratio, z-score — so you can check it rather than trust it. Notifications fire
only for **same-day high-severity** anomalies; history replaying as alerts on
a first run would be noise, so it doesn't happen.

## Live status: sessions, receipts, guard, sparklines

Alongside the totals above, `data/status.json` carries four sections built from a second,
record-level scan of the store — the cube the rest of this file describes is pre-aggregated and
carries no session id, branch, or per-turn guard verdict. All four anchor on `lastRefresh` (the
store's last completed refresh), never the real clock, so a reader is only ever as current as the
last refresh cycle said.

| Section | What it carries |
|---|---|
| `liveSessions` | Up to 8 sessions with activity in the last 10 minutes of `lastRefresh`: source, model, project/repository/branch, turns, subagent turns, running cost, context tokens and share, and that session's own guard verdict. |
| `receiptsToday` | The 3 highest-cost (repo, branch) pairs with spend dated `lastRefresh`'s day, plus the total across all of them. |
| `guard` | The declared thresholds (from `~/.tokenflow/config.yaml`, overridden per repository by `.tokenflow/policy.yaml`) and the last guard verdict, with its `source`: `cache` when a session's own guard cache holds one, `derived` when it is inferred from the worst `liveSessions` entry instead (today the cache stores no verdict, so this is `derived` on every run). |
| `sparklines` | 24 hourly token/cost buckets per source, covering the 24 hours up to `lastRefresh`. |

### The Live tab

The dashboard's **Live** tab (a registered view, `src/ui/views/live.js`) renders these same four
sections, polling `/api/live` every 30 seconds while the tab is open. Nothing on it animates
toward a number it was not given: every value is the last thing `data/status.json` said, and it
changes only when that file changes. In an offline snapshot the tab shows the numbers captured at
export time and hides the controls (like "Manage limits") that need a live server.

## Menu bar — TokenFlow.app (native, macOS)

TokenFlow ships its own menu bar application: a ~370 KB native binary compiled
on your machine from [`menubar/TokenFlow/main.swift`](../menubar/TokenFlow/main.swift)
with `swiftc` (Xcode Command Line Tools). No Electron, no third-party bar, no
network. It reads `data/status.json` every 5 seconds and rebuilds its dropdown
every time it opens.

```bash
tokenflow menubar --app             # build → ~/Applications/TokenFlow.app → launch
tokenflow menubar --app --login-item
                                    # …and start it on every login
```

**Status item (adaptive, most-urgent signal wins):**

| Situation | Menu bar shows |
|---|---|
| a limit exceeded | `✗ 105%` in red |
| a limit approaching | `▲ 82%` in orange |
| healthy limit | `● 42%` in green |
| no limits, priced usage | `$4.83` |
| unpriced day | today's tokens |

**The dropdown contains everything — no browser hop required:**

- header: live/watcher badge + data freshness ("live · data updated just now")
- Today / Week / Month rows — tokens, requests, estimated cost
- **Live, as of `<time>`** — up to 3 sessions active in the last 10 minutes, each with a
  context gauge, its own guard-coloured dot, and running cost
- **Today's receipts** — the day's top 3 (repo, branch) pairs by spend, and the total
- **Guard** — the declared caps, the last verdict, and two buttons: **Raise cost cap** and
  **Clear caps**, both of which write through `tokenflow guard --set` (never by editing
  `config.yaml` directly) and then run one refresh cycle so the popover reflects the change
- Today by provider — inline share bars (▰▱), tokens and cost per provider
- Today by source — the app that wrote the log (claude-code, opencode,
  hermes, git…). Provider attribution names the model's vendor, so Hermes
  traffic appears under each model's vendor there; this section shows it as
  "hermes"
- **Last 24 hours by source** — a small sparkline per source, tokens and cost, drawn only
  when its data is present so an older status file shows exactly what it always showed
- Top models today — token and cost leaders per model
- Capacity — a real meter per declared limit with %, exhaustion ETA and reset
  countdown; "first projected hit" callout when one will cross before reset
- Forecast — tomorrow / 7-day projections, month-end spend, confidence
- Alerts — high-severity anomalies with their arithmetic
- Actions — `Refresh now` (⌘R, runs a watch cycle), `Open Dashboard`,
  `Start/Stop watcher`, `Quit`
- **Density** — Comfortable or Compact, a persisted preference that tightens row spacing
  and type size for a laptop screen
- **Shortcut** — a global keyboard shortcut that toggles the popover from any app,
  persisted and re-registered immediately on change
- Appearance button (◐) — cycles system → light → dark; persisted across
  launches in `defaults` under `appearanceOverride`

Dark/light follows the appearance override (◐ button, persisted) or the system
appearance when set to follow; all figures use monospaced digits.

**Transient guard alert.** When a live session's guard level rises to warn or block since the
last load, a small card slides in from the status item to announce it — never on the first load,
and never on a recovery back down, so it only ever interrupts for something new. One card at a
time; clicking it opens the popover on the section that explains why.

## Menu bar — other platforms (SwiftBar/xbar text protocol)

For Linux bars or if you prefer SwiftBar on macOS:

```bash
tokenflow menubar --swiftbar          # install for SwiftBar (~/Library/Plugins)
tokenflow menubar --xbar              # xbar's plugin directory instead
tokenflow menubar --out <dir>         # any compatible bar
tokenflow menubar --render            # print the text protocol (debug)
tokenflow menubar --mode cost         # auto | tokens | cost | limit
```

The generated script shells to `tokenflow menubar --render` every couple of
minutes (filename convention). The title adapts automatically — the most
urgent signal wins:

| Situation | Title shows |
|---|---|
| a limit approaching | `TF ⚠ anthropic-monthly 82% · 4h 12m` |
| a limit exceeded | `TF ✗ anthropic-monthly 105% · resets 3d` |
| no limits, priced usage | `TF $4.83` |
| unpriced day, week has data | `TF 7d 5.04B` |

Any bar speaking the same text protocol (Argos, Waybar custom modules) works
via `--out`.

The SwiftBar dropdown carries the same breakdowns as the native popover:
today/week/month totals, **by source** (claude-code, hermes, opencode… —
provider rows name each model's vendor, so this is where Hermes appears under
its own name), **top models**, limits, forecast and alerts. Appearance is the
one thing a text-protocol plugin cannot control: SwiftBar renders plain text,
so its light/dark look follows SwiftBar's own settings — use the native app's
◐ button for an in-app toggle.

## Data flow guarantees

- `data/status.json` is written atomically (tmp + rename). A reader never sees
  a half-file; a corrupt file degrades to "recompute fresh".
- Estimated and measured cost stay separate everywhere, including the bar line
  and the dropdown.
- A one-shot cycle (`--once`) never leaves the file claiming a watcher is
  running; liveness is verified against the pid, not assumed.

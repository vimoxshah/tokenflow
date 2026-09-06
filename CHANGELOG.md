# Changelog

All notable changes to TokenFlow are recorded here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0 — 2026-09-06

Spend attributed to the unit of work, a guard that acts while a session is
still running, and a design system that every surface compiles from. Nothing
here reads prompt or code content.

### Added

- **Command palette.** ⌘K or Ctrl+K, or the "⌘K" chip at the end of the tab
  bar: every tab, the quick ranges, each skin and mode, export, refresh and
  clear filters, matched by subsequence or word prefix, with the last eight
  commands first. It opens and closes with no animation because it is used
  dozens of times a day. Works from the offline snapshot too. Inside a text
  field, Ctrl+K keeps its editing meaning and ⌘K still opens the palette.
- **First-run screen.** The first time the live dashboard opens, and again
  after an upgrade, one screen says what was found on this machine: what each
  source contributed, which detected adapters have read nothing yet, and why.
  Never shown from a saved snapshot.
- **Tab bar that wraps.** Twenty tabs wrap to two rows at 1280 and 1024 pixels
  with the active tab always visible.
- **A `--hairline` token.** The subtlest divider now has its own colour role in
  `design/tokens.yaml` for every skin and mode, so views stop guessing.
- **A design system with a compiler.** `design/tokens.yaml` is the single
  source for colour roles, the two axes (mode × skin), a type scale with
  size-specific tracking, a 4-pt space scale, radii, two motion tiers and the
  authored chart ramps. `npm run design` compiles it into a generated block in
  the dashboard stylesheet, a generated block in the landing stylesheet and
  `menubar/TokenFlow/DesignTokens.swift`, and refuses to write when a gate
  fails: ink contrast, series-on-surface contrast, adjacent-series perceptual
  distance, sequential monotonicity, status-vs-series distinctness, the 300ms
  ceiling on UI motion. `test/design.test.js` fails the build when a generated
  block is hand-edited or stale. Doctrine in `docs/design-system.md`.
- **Receipts view** in the dashboard: spend per repository and branch, with
  context share, sessions, turns, subagent share and rank against the repo's
  median. Click a branch for the receipt and copy it as a PR comment. Receipts
  ship inside the data bundle, computed once per refresh and streamed rather
  than materialized, so the offline snapshot has them too. The scan costs
  about two seconds on a 160K-turn store, so the watcher's status snapshot
  and the one-line CLI summaries opt out of it.
- **Story strip** on the Overview: the three insights that matter for the
  current slice, as sentences, with their numbers set in the figure face.
- **Deep links**: `#tab=receipts&skin=terminal&mode=light` opens the dashboard
  on that view and look. The tab is reflected in the URL as you switch.
- **Motion and type polish through the tokens**: feedback on press for every
  pressable, popovers that scale from their trigger, tooltips that respond in
  a frame, cards that stagger in only when the view changes, a translucent
  header material, hover states gated to pointer devices, and reduced-motion
  and reduced-transparency that degrade to a complete state. Muted ink was
  nudged in every skin to clear 4.5:1 on cards.
- **Menu bar on the same tokens.** Accent, status colours and the categorical
  palette now come from the generated Swift file; the saturated gradients on
  the brand mark and the milestone banner became solid accent surfaces, per the
  system's own rule that a gradient sits only behind a single number.
- **Landing page rewritten around the finding, not the features**: a real
  receipt in the hero, the three numbers from nine weeks of logs, the
  marginal-cost curve, the receipt rules with the correction that produced
  them, the guard, and the cap table with its upper-bound caveat. Built on the
  same tokens, with self-hosted fonts and no third-party requests; the GSAP
  and three.js dependencies are gone.

- **`tokenflow receipt`** — what a branch or pull request cost. Each turn is
  attributed to the branch checked out when it ran, so one long session that
  moved across branches is split across them. Repositories are identified by
  walking up from the recorded working directory to `.git` and following a
  worktree's `gitdir:` pointer home, so `.worktrees/<x>` no longer counts as
  its own project. `--gh` joins merged pull requests by head branch and prices
  each at `$ per 100 changed lines`; `--md` renders a PR-comment receipt. A PR
  owns the turns on its branch up to the merge; turns after the merge are
  follow-up on a checkout that kept the branch name and are shown beside the
  receipt, never inside it. Long-lived branches are flagged as such. The
  estimate is split into *context* dollars (cache reads + writes: re-sending
  the conversation so far) and *work* dollars (fresh input + output).
  `--sessions` reports how concentrated spend is across sessions, the median
  cost of a turn by how deep into a session it is, and the dollars above each
  candidate per-session cap — labelled an upper bound, not a saving.
- **`tokenflow guard`** — a Claude Code hook that reads the live transcript,
  prices it, and reports running spend, current prompt size and the median cost
  of the last ten turns, then warns or blocks against thresholds you declared
  with `guard --set`. Nothing declared means informational only, never a
  block. Reads are incremental per session. `--install` prints the hooks block
  and does not write your settings.
- **`tokenflow team serve`.** A self-hosted team server for the folder-sync
  rollups: one process on a machine your team owns, fed by the same
  per-machine files (`<id>.jsonl`, `<id>.receipts.json`) the folder sync
  already writes. A single shared bearer token gates writes and reads once
  configured; a non-loopback host always requires one. `GET /health` always
  answers; `GET /api/team` and `GET /` return the same aggregate `tokenflow
  team` prints. See `docs/team-server.md` and `Dockerfile.team`.
- **The Ledger: cost per branch and per merged PR, across the team.**
  `sync.push()` now also writes `<machineId>.receipts.json`, a whole-state,
  opt-in-anonymous ledger of branch receipts (unless `sync.receipts: false`).
  `tokenflow team` joins every synced ledger into `receipts.totals`,
  `byRepo`, `byMonth`, `perMergedPr`, `concentration` and `longLivedShare`.
  `sync.to` (plus `sync.token` or `TOKENFLOW_SYNC_TOKEN`) pushes both files to
  a server instead of a shared folder; `tokenflow sync --to <url> --token
  <t>` runs it from the CLI. See `docs/ledger.md`.
- **Receipts travel with the code.** `tokenflow hooks install` writes a
  `pre-push` hook that attaches a receipt to the pushed commit as a git note
  under `refs/notes/tokenflow`. The hook never blocks: every failure is
  reported on stderr with exit 0, and a hook it replaces is kept and chained,
  running first and keeping its own exit code. Receipt schema v0
  (`schemas/receipt.v0.json`, `src/analytics/receipt-schema.js`) makes the
  note machine readable. A zero-dependency GitHub Action (`action/`) reads
  the note on a pull request and posts or updates one PR comment. See
  `docs/receipt-schema.md`.
- **Per-repository guard policy and a Codex guard.** `.tokenflow/policy.yaml`
  declares guard thresholds that travel with a repository and win over the
  personal config, key by key; `tokenflow guard --policy [--cwd <dir>]`
  shows the effective policy and each value's source. Codex CLI has no
  blocking hook, so `tokenflow guard --install --codex [--apply]` wires up
  its `notify` setting instead: it reads only `thread-id` and `cwd` from
  Codex's payload and sends one OS notification on warn or block, never a
  block itself. See `docs/guard-codex.md`.
- **Exports that travel, and budgets per repo and per team.** `tokenflow
  receipt` gains `--svg`, `--png` and `--csv`: a shareable receipt card, or
  one CSV row per branch across every repository. `tokenflow week` builds
  "your AI week" as text, JSON, or the same kind of card (`--svg`, `--png`).
  A `budgets:` list in `config.yaml` adds caps scoped to one repository or to
  the whole team, alongside the existing monthly budget; `tokenflow budget`
  prints both. See `docs/exports-and-budgets.md`.
- **`tokenflow doctor` data-quality audit and `tokenflow pricing diff`.**
  Doctor now runs seven checks over the last three months of records:
  worktree-split spend, cwd outside any repository, Codex records with no
  git branch, unpriced models, a stale price table, session-level sources in
  per-turn views, and `metadata.repoResolved === false`. `tokenflow pricing
  diff <table.json> [--apply] [--yes]` compares a candidate price table to
  the current effective one and merges it in only on explicit confirmation.
- **Live status carries sessions, receipts, guard state and sparklines.**
  `data/status.json` now includes `liveSessions` (up to 8 sessions active
  within 10 minutes of the last refresh), `receiptsToday` (the top 3
  branches by spend today), `guard` (declared thresholds plus the last
  verdict, sourced `cache` or `derived`) and `sparklines` (24 hourly buckets
  per source). The xbar/SwiftBar text shows a "Live now" line and a "Guard:"
  line from the same data.
- **The native menu bar shows the same live state.** A "Live, as of" section
  lists running sessions with a context gauge and the guard's colour dot;
  "Today's receipts" lists the day's top branches; "Guard" shows the
  declared caps, the last verdict, and Raise-cap / Clear-caps buttons that
  write through `tokenflow guard --set`, never by editing config.yaml
  directly; a "Last 24 hours by source" sparkline section closes it out. A
  transient card slides in from the status item only when a live session's
  guard level rises, never on a recovery, and only one shows at a time.
  Density (compact/comfortable) and the popover's global keyboard shortcut
  are now preferences.
- **Demo data is schema-complete.** The synthetic dataset now has a hot
  repository and branch, five repositories, and volume that stays within
  10% across weekdays, so every new view has something realistic to render
  offline.
- **`otel`, an OpenTelemetry (GenAI) adapter.** Reads a standards-based
  OTLP JSON export (`resourceSpans`/`resourceLogs`, `gen_ai.usage.*`
  attributes) from any tool's file exporter, and Gemini CLI's own file
  telemetry (`~/.gemini/telemetry.log` by default, or `sources.otel.paths`),
  deduplicating Gemini's paired usage events. See `docs/providers-otel.md`.
- **Seven new dashboard views, each a registered module, not an app.js
  edit.** Session anatomy: a session's turn-by-turn cost waterfall, growing
  context and subagent fan-out, backed by `GET /api/session`. Live v2: the
  four "right now" sections above, as its own tab. Cache health: hit rate,
  write split and churn events with their dollar cost. What-if: reprice the
  same tokens at another model's rates, labelled as a price-only comparison.
  Compare branches: any two branch receipts on a symmetric log scale.
  Rhythm: deep-work sessions, project switching, and the hour marginal cost
  peaks. Annotations: mark a day and see it on every daily chart, stored in
  `annotations.json`. All seven route through the view registry
  (`src/ui/views/index.js`) and the route registry
  (`src/server/routes/index.js`) documented in `docs/ui-views.md`.

### Fixed

- **Git worktrees no longer split one repository's spend.** A session in
  `<repo>/.worktrees/<x>` used to file under `x`; ingestion now resolves
  `project` and `repository` through the main checkout at ingest time
  (`src/core/repo.js`, `metadata.repoResolved`), and `tokenflow doctor`
  flags any repository still fragmented across worktree names. Repair
  existing history with `tokenflow refresh --full`.
- **Codex sessions now carry a branch and a repository name.** CLI builds
  0.149 and later report a `git` block on `session_meta` (`branch`,
  `repository_url`); the openai adapter sets `git_branch` and `repository`
  from it, falling back to the cwd basename exactly as before when the block
  is absent.

## 1.1.2 — 2026-09-03

Makes the downloadable app usable on a machine that is not the one that built
it. 1.1.1 was correct as source and as an npm package; its DMG was not.

### Fixed

- **The released app pointed at the machine that built it.** Every build
  embedded the absolute path of its own node binary and CLI, which is right for
  a developer driving their checkout and wrong for a release: the 1.1.1 DMG
  shipped `TokenFlowCLIPath = /Users/runner/work/tokenflow/...`, a path that
  exists on no user's machine. Only path-discovery fallbacks kept the app
  working at all. A distributable build now embeds no path
  (`TOKENFLOW_PORTABLE=1`), the DMG script refuses to package one that does,
  and the release workflow re-checks it after mounting the finished image.
- **A cask-only install had nothing to run.** The cask installs the app; the
  CLI came from npm. Anyone who only ran `brew install --cask tokenflow` got a
  menu bar that could read an existing status file and do nothing else — no
  refresh, no watcher, no dashboard. The app now carries its own CLI (see
  below).
- **Node discovery named one specific version.** The first candidate was
  `~/.nvm/versions/node/v24.13.1/bin/node` — whichever version the developer
  happened to have. One `nvm install` away from being wrong for everybody.
  nvm installs are now discovered and the highest one at or above the engine
  floor wins.

### Added

- **The app bundles its own CLI**, at
  `Contents/Resources/cli/package/bin/tokenflow.js`. It is packed with
  `npm pack` and then pruned to the files the CLI actually executes, so the
  bundle is always a subset of the published package and never carries a file
  npm does not ship. The bundled copy takes priority over any CLI found on the
  system, because the app and the CLI share a contract — the status file's
  shape, the watcher lock format, `/api/ping` — and the copy shipped beside the
  binary is the only one guaranteed to match it. A local build still embeds the
  developer's clone, which wins, so an installed app keeps driving the checkout
  being edited.
- **A missing dependency now says so.** With no CLI or no Node the menu bar
  reported nothing and every button failed silently. It names the problem and
  the command that fixes it, at launch rather than on the first click.

### Changed

- The cask states the Node requirement in `caveats` instead of declaring
  `depends_on formula: "node"`, which would install a second Node beside an
  nvm- or asdf-managed one and fight the version manager.

## 1.1.1 — 2026-09-03

A reliability release. Five defects had combined to leave the app paused, the
dashboard unreachable, the stop button inert, one day's token total inflated by
37 billion — and the alert that would have caught it ranked out of sight.

### Fixed

- **The watcher refused to start after a reboot.** The lock file held a bare
  PID, and PID numbers restart and get reused at every boot, so a lock that
  outlived a restart kept naming a live process — just not ours. One left at
  pid 810 was inherited by `mobilerepaird`; `kill(810, 0)` went on succeeding
  and every `tokenflow watch` refused to start, from the launch agent and the
  menu bar's play button alike. The data went stale behind a phantom. The lock
  now records the boot its PID was issued by, so a pidfile from an earlier boot
  is stale by construction. A watcher that fails to start now reports why
  instead of failing silently.
- **The Dashboard button opened a closed port.** It opened
  `http://127.0.0.1:<port>` whether or not anything was serving. It now starts
  the server when none is running, shows progress while the data bundle builds,
  and reports a failure. `tokenflow dashboard` also binds the port from
  `config.yaml` rather than a hardcoded default, and a second invocation opens
  the window instead of failing on a busy port.
- **The stop button never stopped anything.** A `KeepAlive: true` launch agent
  restarts the job after *any* exit, including the clean one a deliberate stop
  produces — measured at about two seconds. The supported agent uses
  `KeepAlive: { SuccessfulExit: false }`: a crash comes back, a stop stays
  stopped.
- **The Hermes adapter invented usage that never happened.**
  `session_model_usage` is keyed on six columns and the adapter's bookkeeping
  key used four, omitting `billing_base_url` and `billing_mode`. Two real rows
  differing only in billing mode shared one entry, each computed its delta
  against the other's totals, and every refresh cycle re-emitted the difference
  under a fresh id. Five colliding sessions turned one day into 39.9B tokens —
  a figure that grew with the number of refresh cycles rather than with usage.
  The key is now the table's whole primary key, and the tail is a high-water
  mark, so a total that comes back lower can never manufacture usage.
- **The alert that caught it was buried.** That corruption was detected the day
  it began: 240× the 60-day median, a modified z-score of 170.9, severity high.
  Severity saturates at "high" around z=6 and the list then sorted by date, so
  the outlier ranked third behind two request spikes of z=6.5 and z=11.2 from
  later in the week — and the menu bar shows the top two. Anomalies of a
  different order now outrank recency; ordinary alerts still read newest-first.

### Added

- `tokenflow watch --install-agent` — keeps the watcher running across reboots,
  supervised by launchd. `--uninstall-agent` removes it. Installing replaces any
  other agent that runs a watcher, because two of them fight over the same lock
  for ever. `tokenflow watch --status` now reports the agent's state and warns
  about conflicts.
- `tokenflow reset --source <id> --yes` — forget one source and re-read it from
  scratch on the next refresh, leaving every other source untouched. This is the
  repair path for a store holding data from an adapter that has since been
  fixed.

### Changed

- `tokenflow setup` now installs the watcher agent on macOS, so live data works
  without hand-rolling a LaunchAgent. `--no-agent` opts out, and the install is
  announced rather than silent. On other platforms it prints the systemd/cron
  equivalent instead.
- A dead watcher no longer leaves its identity in the status file, so a paused
  TokenFlow cannot report itself as live.

### Repairing an affected store

A store that ingested the inflated Hermes records keeps them until it is told
to re-read the source:

```sh
tokenflow reset --source hermes --yes
tokenflow refresh
```

The Hermes database still holds the truth, so nothing is lost. On the corpus
this was found on, the re-read reconciled exactly — 1,568 source rows to 1,568
records, every token field matching — and the affected day fell from 39.9B to
2.35B, with usage returning to the days it actually happened on.

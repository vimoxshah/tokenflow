# Changelog

All notable changes to TokenFlow are recorded here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.3.2 — 2026-09-06

The three interface defects 1.3.1 listed as known and left open.

### Fixed

- **Home and End jump the command palette to the first and last command.** They previously did
  nothing at all, while every other list in the app answers them. In a filter box in front of a
  list they move the list, not the text caret.
- **Escape dismisses a tooltip from wherever focus is.** The handler was bound to the element the
  tooltip belongs to, and a tooltip is almost always opened by hovering, so that element rarely
  has focus and never saw the key. One listener on the document, alive only while a tooltip is on
  screen or counting down, is the only placement that works.
- **The date button and the header no longer state different end dates.** "All data" resolved to
  the dataset's today rather than to its last day with records, so on a store whose newest record
  is older than today the button claimed a date no record reached, while the coverage line beside
  it read the real one. The range now ends at the last day the store has, which is what "all
  data" says and what the function's own documentation already promised. The rows matched are
  unchanged, because there was never anything after that date to match. Relative ranges still
  count back from today, which is the whole point of passing it.

## 1.3.1 — 2026-09-06

Interface fixes found by driving the dashboard with real mouse and keyboard input, which is
what 1.3.0 was never checked with. Every gate passed for 1.3.0 and every view was
screenshotted, and none of that could see any of the following.

### Fixed

- **A closed command palette stayed on the page.** Its stylesheet set `display: flex` without
  qualifying it to the open state, which overrides the browser's own rule for hiding a closed
  dialog. The palette therefore stayed laid out, painted and clickable while closed: on a tall
  page it sat below the footer, so it read as a stray box at the bottom of the dashboard, and
  on a short page it floated over the content with no backdrop. Typing into it produced "No
  commands available", because a palette that was never opened has no commands to show. Worse,
  clicking a row in that closed panel still ran the command and changed the page. Nothing ever
  threw, so no test and no screenshot caught it. A test now fails if any stylesheet sets
  `display` on a dialog selector that is not qualified to `[open]`.
- **Dismissing a popover by clicking away no longer jumps the page to the top.** The dismissal
  runs on pointer-down, before the browser has moved focus, so the panel still appeared to hold
  focus and the code handed it back to the trigger. Because focusing an element scrolls it into
  view, closing a filter panel while scrolled down threw the reader back to the top of the page.
  An outside click now never takes focus back, which was always the stated intention.
- **Keyboard focus no longer ends up inside a closed palette**, where Tab walked deeper into a
  dialog that was not on screen.
- **"All data" is marked as the current range in the date picker.** The app resolves it into
  real coverage dates before the picker sees it, so the picker could not recognise its own
  default and left every row unmarked.
- **The granularity chip said "Dayly".** The label was built by adding "ly" to the key, which is
  right for week and month.

### Added

- **A stale tab now says so.** The dashboard is a long-lived page served by a local process, so
  a tab left open across an upgrade keeps running the old JavaScript against the new API, and
  nothing on screen admits it. The server stamps the running version into the page, and the page
  says "This page is running TokenFlow X, but Y is installed" with a reload button when the two
  disagree. A saved snapshot has no server to differ from, so it never asks.

## 1.3.0 — 2026-09-06

Receipts that leave the laptop and land where the decision is made: on the pull request, on a
ticket, in the FinOps tool, and in the agent's own hands. Nothing here reads prompt or code
content, and nothing here is hosted by us.

### Added

- **Receipts on GitHub: comment, budget, merge gate.** A GitHub Action reads the receipt a push
  already attached as a git note, posts or edits ONE pull request comment (found by a
  `<!-- tokenflow-receipt -->` marker, so it never stacks), and judges it against a cap declared as
  a workflow input or in the repository's committed `.tokenflow/policy.yaml`. Over budget fails the
  job, and a failed job is a status check a branch protection rule can require before a merge. A
  push with no receipt logs one line and exits 0: a missing receipt is never itself a blocker. A cap
  is crossed only when the value is strictly greater, and a cap with no matching measurement reports
  "not evaluated" rather than a false pass. Zero npm dependencies, and every side effect is
  injectable, so the tests never touch the network. See docs/receipts-on-github.md.
- **A self-hosted GitHub App.** `tokenflow team serve` can now receive YOUR OWN GitHub App and
  answer every pull request with the same receipt comment plus a "TokenFlow spend" check run:
  neutral until a receipt lands, red when the repository's own cap is crossed, green otherwise. We
  host nothing and store nothing. The receipt is read from your repository over the API, rendered,
  posted back, and dropped. Webhook deliveries are authenticated by GitHub's signature over the raw
  body, in constant time; installation tokens are minted per delivery and never cached. Overlapping
  deliveries for one pull request are serialized, and a late-arriving note always wins, so a green
  check is never overwritten by a stale neutral one. Flags `--github-app-id`, `--github-key-file`,
  `--github-webhook-secret`, `--github-api-url` (GitHub Enterprise works by pointing it at
  `/api/v3`) and `--github-notes-ref`, each with a `TOKENFLOW_GH_*` environment variable.
  `POST /github/webhook` answers 404 until all three required values are set. See docs/github-app.md.
- **Cost per ticket.** A **Tickets** tab and `tokenflow tickets`: every branch receipt that names
  the same Jira, Linear or GitHub key, grouped across every repository and branch. The key is read
  from the branch name, or from a merged pull request's title when the branch name has none.
  Matching is a convention, not a guarantee, so a branch that names no key stays in an
  `(unattributed)` row rather than being guessed into a ticket, and the built-in shape requires two
  letters and two digits, which is what keeps `UTF-8` from reading as a ticket. Configure it with a
  `tickets:` block (`system`, `baseUrl`, `pattern`); `baseUrl` is the only thing that turns a key
  into a link, and building that link is string work that never contacts your tracker.
  `--csv`, `--json`, `--top`. See docs/tickets.md.
- **FOCUS-shaped export.** `tokenflow export --focus` writes one row per branch receipt and
  `tokenflow team --focus` writes one row per machine-day, both to
  `tokenflow-focus-YYYY-MM-DD.csv` under the FinOps FOCUS column names, so an estimate produced
  entirely on this machine can sit beside a real cloud bill in a tool that already ingests FOCUS.
  The four FOCUS cost columns deliberately carry the same number, because splitting one estimate
  into four would claim a precision this data does not have, and every row says so twice: in
  `ChargeDescription` and in `Tags.costBasis`. The null contract survives the export: a missing
  value is an empty cell, never a `0`. See docs/focus-export.md.
- **An MCP server, so the agent can read its own bill.** `tokenflow mcp` speaks the Model Context
  Protocol over stdio and offers four read-only tools: `tokenflow_receipt` (what this branch has
  cost), `tokenflow_policy` (the caps in force here, and which layer each came from),
  `tokenflow_usage` (totals for the last N days and the top models) and `tokenflow_budget` (the
  monthly cap and where this month stands). Every other surface reports to a human after the fact;
  this one hands the numbers to the participant actually spending the money, in time to change what
  it does next. Local stdio: no socket, no network call, nothing written to the store. stdout
  carries JSON-RPC and nothing else. See docs/mcp.md.
- **Org policy: a ceiling above the personal and repo caps.** A team can publish a `policy.yaml` on
  its own team server; `tokenflow policy pull` caches it locally and `tokenflow refresh` keeps that
  cache warm (at most one fetch an hour). The org layer applies as a CEILING: for each guard key it
  can only lower the effective cap, never raise one, and a key it does not declare leaves the
  personal or repository value alone. The guard hook never fetches, only reads the cache, so a
  session is never blocked waiting on a server, however stale that cache is. A failed pull keeps the
  cache it had, rather than replacing a good policy with nothing. `tokenflow policy show` prints
  every key with its source, now `[personal]`, `[repo]`, `[org]` or `[default]`.
  See docs/policy.md.
- **A self-hosting kit for the team server.** `Dockerfile.team`, a compose file, and a deployment
  guide, so the process that receives your rollups and your GitHub App is something a customer
  stands up in an afternoon on hardware they own. `tokenflow team check` verifies one from a laptop:
  reachable, token accepted, org policy present, and what to fix when not. See docs/team-server.md.
- **Receipt schema v1.** The portable receipt (`schemas/receipt.v1.json`) gains two optional fields:
  `ticket`, the tracked-work item the branch names, and `verdict`, the result of checking the
  receipt against the `receipt:` caps its repository committed. Every field v0 required is still
  required and unmoved, so **a v0 receipt stays valid forever**: `validateReceipt()` dispatches on
  `schemaVersion`, and both the Action and the self-hosted App accept either version. The pre-push
  hook and `tokenflow receipt --branch <b> --json` now emit v1. See docs/receipt-schema.md.

### Changed

- **A sidebar instead of a tab bar.** The dashboard is now an app shell: a
  left sidebar holds every view, grouped by topic (Spend, Sessions, Models,
  Time, Data, and "More views" for anything a registered module adds), and the
  content takes the rest of the width. The sidebar collapses to a rail of
  icons with the full name as a tooltip, resizes by dragging its
  edge (or with the arrow keys on the handle; double-click resets), and
  remembers both settings with the other preferences. Below 900 pixels it is a
  drawer opened from the header. The search row at the top of the sidebar
  replaces the "⌘K" chip and opens the same command palette. The header now
  shows the active view's name. This replaces the two-row tab wrap from 1.2.0,
  which broke down as soon as a real dataset showed every tab.
- **One filter bar instead of a wall of controls.** Every view used to open with eighteen controls
  above the data: eight range chips, two date fields, two hour fields, seven dropdowns and two
  scope toggles, all visible whether or not you used them. At rest the bar is now a date button
  that reads the range it applied, a `+ Filter` button, and nothing else. Picking a dimension
  opens its values with a search box and each value's total; what you pick becomes a chip you can
  edit or remove, and the chips are the whole truth, so the "All data" line is gone. Scope sits
  quietly at the right end, and "Clear all" appears only when there is something to clear. A
  weekday or single day picked by clicking a chart now shows up as a chip too, which means a
  filter can no longer be applied with nothing on screen able to see or clear it.
- **A component layer, so controls stop looking like browser defaults.** The design tokens were
  always there; what was missing was anything built on them, so every control fell through to the
  browser's own styling. There is now a popover, a listbox with search and full keyboard
  operation, an action menu, a tooltip, a date range picker and a 45 icon set, all vanilla and all
  drawing every colour, size and easing from the same tokens. One focus ring is applied once,
  globally, on `:focus-visible`. See the Components section of docs/design-system.md.
- **The command palette reads like a palette.** Commands are grouped under headings, every row has
  an icon, the characters that matched your query are highlighted, and the active row shows the
  Enter key. Opening it with nothing typed lists what you ran recently instead of an empty box.
  Searching also got stricter: a query used to match a command's hidden keywords letter by letter
  across word boundaries, so "rec" returned all three skins. Keywords now match as whole text.
- **Charts say what they mean.** Hovering a line chart draws a crosshair and names every series at
  that point; bars, cells and slices have their own tooltips and answer the keyboard as well as the
  pointer. Stacked segments and neighbouring bars are separated by a small gap so two categories
  never read as one shape, charts with two to four lines label them at the end of the line, and a
  chart with no data says so instead of drawing empty axes.
- **A blocked session is told how to actually unblock itself.** When the guard blocks on a cap that
  came from the org ceiling, the message no longer suggests `tokenflow guard --set`, which writes
  your own config and cannot lift a ceiling. It names the org policy and points at docs/policy.md
  instead. A personal or repo cap keeps the old advice, because there the command does work.
- **`tokenflow receipt --branch <b> --json` prints the portable Receipt v1 document.** It used to
  print the internal builder entry. A script that read the old shape needs one update; the numbers
  are the same, the field names follow schemas/receipt.v1.json. See docs/receipt-schema.md.
- **The dashboard's Tickets tab honours your `tickets:` config.** The whole-store receipt pass now
  threads that block through, and caches on it, so editing the config and reopening the dashboard
  never serves receipts built under the old pattern.

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

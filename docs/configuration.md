# Configuration reference

Everything Tokenflow knows about your setup lives in one file:

```
~/.tokenflow/config.yaml
```

`tokenflow setup` writes it for you by detecting what is on the machine, so most people never
edit it. This page is the complete reference for when you do. `tokenflow config show` prints the
*effective* config (defaults merged with your file), and `tokenflow config path` prints the data
home.

Nothing here is transmitted anywhere unless you explicitly point it somewhere you own. The two
exceptions are opt-in: `sync.token` (a bearer token for your own team server, never a vendor
credential) and `delivery:` (your own webhook/Telegram/email). If a field looks like it wants a
vendor API key or account, you are reading the wrong project.

---

## The whole file, annotated

```yaml
version: 1

# Timezone used to bucket a timestamp into a day and an hour. Set it explicitly
# if you travel, or if you want the numbers to match a colleague's. null = this
# machine's current zone at ingest time.
timezone: Asia/Kolkata          # null | any IANA zone

# Stamped onto every record. Useful later if several people's exports are ever
# merged; ignored entirely if you are the only user.
identity:
  user: null                    # null = the OS username
  machine: null                 # null = the hostname
  team: null

# Which adapters are enabled. Empty means "every adapter that detects".
# Manage with: tokenflow provider add|remove <id>
providers:
  - anthropic
  - openai
  - opencode
  - hermes
  - cline
  - cursor
  - headroom
  - git

# Per-adapter options. Anything omitted falls back to that adapter's default
# locations, so this section is usually short.
sources:
  anthropic:
    # Claude Code / Agent SDK. Several homes are normal: one per client, or a
    # separate profile per company.
    paths: ["~/.claude", "~/.claude-work"]
  openai:
    paths: ["~/.codex"]         # Codex CLI / IDE / Desktop
  opencode:
    db: "~/.local/share/opencode/opencode.db"   # $XDG_DATA_HOME-aware
  hermes:
    db: "~/.hermes/state.db"    # $HERMES_HOME honoured
  cline:
    path: "~/.cline/data/sessions"
  cursor:
    db: "~/.cursor/ai-tracking/ai-code-tracking.db"
  headroom:
    path: "~/.headroom"         # gateway overlay: measured cost, tokens excluded
  git:
    # Correlate usage with shipped work. Both are optional.
    scanRoots: ["~/code", "~/work"]   # directories to scan for repositories
    repos: []                          # or list them explicitly
    autoFromUsage: true                # also use working dirs seen in usage records
  otel:
    # OpenTelemetry GenAI file exports. Defaults look for ~/.gemini/telemetry.log
    # and ~/.tokenflow/otel/*.{jsonl,ndjson,json,log}; add paths of your own.
    paths: ["~/code/my-project/.gemini/telemetry.log"]

store:
  keepRaw: true                 # keep request-level records (Data Explorer + full export)
  rawRetentionDays: null        # null = keep forever; a number prunes older shards

analytics:
  # A gateway/proxy log describes traffic a client adapter already counted.
  # Including it double-counts tokens; excluding it still surfaces its measured
  # cost. Leave false unless you know you want the other behaviour.
  includeOverlaySources: false
  # Only used for sources that do not carry a session id of their own.
  minSessionGapMinutes: 30

# Your own model classification rules, evaluated before the built-ins. Use this
# when a gateway renames models, or for an in-house model the built-ins can't know.
modelMappings:
  - match: "^acme-"             # regex against the model name
    provider: acme
    label: Acme
    family: Acme v2

# Force an interface for a client the adapter can't classify from its own signals.
# Values: CLI | Desktop | IDE | Web | API | Unknown
interfaceOverrides:
  my-wrapper-script: CLI

ui:
  skin: aurora                  # aurora | terminal | editorial
  mode: dark                    # dark | light
  port: 7799                    # the dashboard binds 127.0.0.1 on this port
  defaultRange: all             # all | 7d | 30d | 90d | mtd
  defaultFrom: null             # e.g. "2026-03-14" — a floor for the default view only

# How a branch name (or a merged PR's title) is turned into a ticket key, and
# whether that key becomes a link. All three fields are optional.
tickets:
  system: null                   # jira | linear | github | other | null (detect structurally)
  baseUrl: null                  # e.g. https://acme.atlassian.net - no baseUrl means no link
  pattern: null                  # your own regex; when set it alone decides a match

# Optional, off by default. See the `sync` and `budgets` sections below.
sync:
  enabled: false
  dir: ~/Sync/TokenFlow          # a shared folder both machines can see
  machineName: MacBook Pro
  developerName: null            # opt-in only; omit to stay anonymous in team views
  receipts: true                 # set false to skip the branch/PR ledger file
  to: null                       # POST to a server instead of writing into `dir`
  token: null                    # bearer token for `to` (or env TOKENFLOW_SYNC_TOKEN)

budgets:
  - id: api-monthly
    scope: repo                  # total | repo | team
    repo: api                    # required when scope is repo
    monthlyUsd: 150
    warnAt: 0.8                  # optional, default 0.8
```

---

## The fields that actually change behaviour

### `timezone`

A day boundary is a decision, not a fact. Tokens are bucketed into `date` and `hour` **at ingest
time** using this zone, and the value is stored on the record — so changing it later requires
`tokenflow refresh --full` to take effect on history. Set it if you want stable days across
travel.

### `providers`

An empty list means "auto": every adapter that detects gets used. Naming them explicitly is
faster (no detection work for tools you don't have) and predictable. `tokenflow providers` shows
what is detected, what is enabled, and *why* something is not available.

### `sources.<id>.paths`

Adapters look in conventional locations. Point them elsewhere when your tool is installed
somewhere unusual, or when you keep several profiles:

```yaml
sources:
  anthropic:
    paths: ["~/.claude", "~/.claude-clientA", "/Volumes/work/.claude"]
```

A path that does not exist is skipped silently — listing a machine's worth of possibilities is
fine and costs nothing.

### `analytics.includeOverlaySources`

Set this to `true` only if you *want* gateway traffic counted twice — for example when the
gateway is your only record of a tool that writes no logs of its own. The default (`false`) keeps
tokens honest and still reports the gateway's measured cost separately.

### `store.rawRetentionDays`

Aggregates (the cube, sessions, activity) are tiny and kept forever. The request-level shards are
what grow. Set a number of days if you want them pruned; the aggregates already computed are not
affected, so your history stays in the charts even after the raw rows are gone. `keepRaw: false`
skips writing them entirely — the Data Explorer and the full CSV export then have nothing to
show, so prefer a retention window over turning it off.

### `ui.skin` / `ui.mode`

The default look. A choice made in the dashboard header is remembered in the browser and wins
over this. Series colours belong to the **mode**, not the skin, and were validated for
colour-blind separation against every skin's chart surface — which is why changing the look can
never change what a colour means.

### `limits` — declared capacity caps

TokenFlow never invents vendor quota data. A limit exists because you wrote it here, and the
engine evaluates it against measured consumption (Live tab, `tokenflow capacity`, menu bar):

```yaml
limits:
  - id: anthropic-monthly     # required, unique
    provider: anthropic       # optional cube filters — provider | model | project
    scope: month              # day | week | month  (your local calendar)
    metric: tokens            # tokens | input | output | requests | cost
    cap: 120000000            # tokens, or dollars when metric is cost
    warnAt: 0.8               # optional warn threshold (default 0.8)
```

From each limit the engine derives: consumption in the window, % used, remaining,
today's hourly pace, a trailing-7-day daily pace, projected exhaustion ETA and
the exact reset instant in your timezone. Invalid definitions are reported via
`tokenflow capacity --json` (`invalid`) and by the dashboard — never silently
ignored. See [live-mode.md](live-mode.md) for semantics.

### `guard` — thresholds for the in-session circuit breaker

Read by `tokenflow guard` when it runs as a Claude Code hook. Absent or all-null means the hook
reports and never blocks. Values are declared, never inferred.

```yaml
guard:
  warnCostUsd: 25            # session spend at which the hook warns (context + systemMessage)
  maxCostUsd: 200            # session spend at which PreToolUse / UserPromptSubmit are blocked
  warnContextTokens: 200000  # prompt size (fresh + cache read + cache write) at which to warn
  maxContextTokens: null     # prompt size at which to block
  warnMarginalUsd: null      # median cost of the last ten turns at which to warn
```

`tokenflow guard --set warnCostUsd=25,maxCostUsd=200` writes these; an empty value clears one.

A repository can declare its own caps in `.tokenflow/policy.yaml`, committed with the code, so
the cap travels with everyone who clones it:

```yaml
# <repo root>/.tokenflow/policy.yaml
guard:
  warnCostUsd: 10
  maxCostUsd: 50
note: "This repo's sessions run long — reasoning-heavy refactors, not chat."
```

A key declared there wins over `~/.tokenflow/config.yaml`, key by key; a key declared nowhere is
`null` (informational only). `tokenflow guard --policy [--cwd <dir>]` shows the effective value
for each key and which file it came from. `note` is optional and shown beside a triggered
warning/block and beside `guard --policy`'s output. See [guard-codex.md](guard-codex.md).

### Org policy: a cap your team declares, applied as a ceiling

A third layer sits above the personal config and the repository file: a `policy.yaml` your team
publishes on the team server named by `sync.to`. `tokenflow policy pull` fetches it and caches it
at `<TOKENFLOW_HOME>/policy/org.yaml`; `tokenflow refresh` refreshes that cache when it has gone
stale, at most once an hour.

The org layer is a **ceiling**: for each guard key it can only lower the effective cap, never raise
one, and a key it does not declare leaves the personal or repository value untouched. There is
nothing to configure locally beyond `sync.to` (and `sync.token` when the server requires one). The
guard hook never fetches, only reads that cache, so a session is never blocked waiting on a
server, however stale the cache is.

```bash
tokenflow policy show     # the effective value for every key, and which layer it came from
tokenflow policy pull     # refresh the cache now
```

See [policy.md](policy.md).

### `tickets`: how a branch name names a ticket

Read by `tokenflow tickets`, by the dashboard's Tickets tab, and by every receipt (the `ticket`
field of a receipt.v1 note). All three fields are optional; with none set, a ticket key is still
detected structurally and simply carries no link.

```yaml
tickets:
  system: jira                      # jira | linear | github | other | null
  baseUrl: https://acme.atlassian.net
  pattern: null                     # e.g. "(PROJ-[0-9]+)" - your own regex wins when set
```

- **`system`** decides which built-in shape is looked for and how a URL is built:
  `jira` gives `<baseUrl>/browse/<KEY>`, `linear` gives `<baseUrl>/issue/<KEY>`, `github` gives
  `<baseUrl>/issues/<n>`. With `system: null` both shapes are tried: a GitHub-style reference
  (`#123`, `gh-123`, `issue-123`, `issues/123`) is unambiguous and is reported as `github`, and a
  letters-dash-digits key is reported as `other`, because without a declared system there is no way
  to tell Jira from Linear.
- **`baseUrl`** is the only thing that turns a key into a link. Without it every ticket's `url` is
  `null`. Building a URL is string work: nothing here ever calls your tracker.
- **`pattern`** is your own regular expression, matched case-insensitively. When it is set it alone
  decides a match: the first capture group is the key, or the whole match when it has no group. An
  invalid pattern is treated as no match rather than thrown, so a typo cannot break every receipt.

Matching is a convention, not a guarantee, and the built-in shape needs at least two letters and
two digits (`ENG-42`), which is what keeps `UTF-8` from reading as a ticket. See
[tickets.md](tickets.md).

### `sources.otel.paths` — OpenTelemetry (GenAI) file exports

```yaml
sources:
  otel:
    paths: ["~/code/my-project/.gemini/telemetry.log", "~/.tokenflow/otel"]
```

Reads a standards-based OTLP JSON export from any tool's file/collector exporter, and Gemini
CLI's own file telemetry. With no `paths` configured, the adapter still looks in its defaults:
`~/.gemini/telemetry.log` and `~/.tokenflow/otel/*.{jsonl,ndjson,json,log}`. See
[providers-otel.md](providers-otel.md).

### `sync` — optional multi-machine aggregation

Off by default. Exchanges daily rollups (and, unless disabled, a branch/PR receipt ledger)
between machines through a folder you already sync, or by pushing to a server you run:

```yaml
sync:
  enabled: true
  dir: ~/Sync/TokenFlow        # a shared folder both machines can see
  machineName: MacBook Pro     # label shown in aggregated views
  developerName: null          # OPTIONAL, opt-in only — per-developer team views
  receipts: true               # set false to skip the branch/PR ledger file
  to: null                     # POST to a server instead of writing into `dir`
  token: null                  # bearer token for `to` (or env TOKENFLOW_SYNC_TOKEN)
```

`to` and `dir` are alternatives, not both required: set `to` (a `tokenflow team serve` URL, or
any server speaking its contract) to push there instead of `dir`. What is shared is always the
same coarse shape — date, tokens, requests, estimated cost, plus the branch/PR ledger unless
`receipts: false` — never prompts, code, file paths, or credentials. See
[ledger.md](ledger.md) and [team-server.md](team-server.md).

### `budgets` — caps scoped to a repository or a team

Alongside the single monthly `budget` above, declare as many scoped budgets as you like:

```yaml
budgets:
  - id: api-monthly
    scope: repo            # total | repo | team
    repo: api                # required when scope is repo; matched the same way
                              # `tokenflow receipt` resolves a repository (worktrees
                              # folded into their main checkout)
    monthlyUsd: 150
    warnAt: 0.8             # optional, default 0.8 (a fraction, like limits[].warnAt)
  - id: team-monthly
    scope: team
    monthlyUsd: 1000
```

`total` sums every priced turn in the store this month; `repo` sums turns attributed to that
repository; `team` reads this machine's shared sync folder, if enabled, and says so plainly
(`no team data`) rather than reporting a number nobody synced. `tokenflow budget` prints every
scoped row alongside the monthly cap. See [exports-and-budgets.md](exports-and-budgets.md).

### `watch` — the background refresher

```yaml
watch:
  intervalSeconds: 120      # between incremental refresh passes
  notifications: false      # OS notifications on limit crossings / new anomalies
  staleAfterSeconds: 600    # when live surfaces should call the data stale
```

The watcher only runs while you started it (`tokenflow watch`); nothing is
installed or auto-started. `notifications: true` is what `--notify` overrides
per run.

### `ui.menubarMode`

Default display mode for `tokenflow status --bar` and the menu-bar plugin:
`auto` (most urgent signal), `tokens`, `cost`, or `limit`.

### `map.showMyLocation`

Off by default — and it is the only geography feature that touches the network.
When set to `true`, the dashboard's Global activity map resolves THIS machine's
public IP once via an HTTPS lookup (ipapi.co), caches the derived place
(city/region/country/coordinates) in `$TOKENFLOW_HOME/data/geo-cache.json`,
and re-resolves at most monthly. The IP itself is never stored, never logged,
never displayed. Leave it unset (or `false`) and TokenFlow performs no lookup
at all: the map then shows only vendor-published provider regions. There is
no per-request IP capture anywhere in the product.

---

## Pricing is separate

Rates live in `~/.tokenflow/pricing.json`, not in `config.yaml`, because they are data rather
than configuration — and because the built-in table ships with provenance:

```bash
tokenflow pricing                 # what is priced, from which source
tokenflow pricing --sources       # every rate's origin, fetch date and confidence
tokenflow pricing --set "my-model=3,15,0.3,3.75"   # input,output[,cacheRead[,cacheWrite]] per 1M
```

Your overrides always beat the built-in table. Anything with no rate stays visibly unpriced —
never a plausible-looking `$0`.

---

## Environment variables

| Variable | Effect |
|---|---|
| `TOKENFLOW_HOME` | move the whole data home (config, pricing, data, cache) |
| `TOKENFLOW_DEMO=1` | enable the synthetic demo adapter |
| `AI_USAGE_HOME` | legacy alias for `TOKENFLOW_HOME`, still honoured |
| `TOKENFLOW_SYNC_TOKEN` | bearer token for `sync.to`, instead of `sync.token` |
| `TOKENFLOW_TEAM_TOKEN` | shared bearer token for `tokenflow team serve` |

Running several isolated datasets is just several homes:

```bash
TOKENFLOW_HOME=~/.tokenflow-work tokenflow refresh
TOKENFLOW_HOME=~/.tokenflow-work tokenflow dashboard --port 7801
```

If `~/.tokenflow` does not exist but `~/.ai-usage-dashboard` does, the older directory is used —
an install from before the rename keeps its ingested history instead of silently starting over.

---

## Moving a setup to another machine

```bash
# old machine
tokenflow config export backup.json     # config + pricing + mappings, no usage data
tokenflow export --csv --all            # the usage data, if you want it too

# new machine
tokenflow config import backup.json
tokenflow restore tokenflow-usage-2026-08-20.csv --yes
```

The CSV carries counts and identifiers only — prompts, conversations and source code never leave
the machine that produced them. See [cli.md § restore](cli.md#restore-filecsv).

---

## Where everything lives

```
~/.tokenflow/
  config.yaml        this file
  pricing.json       your rate overrides
  preferences.json   dashboard state (filters, tab, theme)
  mappings/          saved generic-import field mappings
  providers/         your own adapters (*.js) — loaded automatically
  data/
    records/         YYYY-MM.jsonl, request-level facts
    cube.json        the pre-aggregated table the dashboard loads
    sessions.json    one row per session
    activity.json    daily work-activity rollup
    state.json       per-file ingest offsets — this is what makes refresh incremental
  cache/
```

Delete the directory and Tokenflow knows nothing. Nothing lives anywhere else.

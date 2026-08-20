# Configuration reference

Everything Tokenflow knows about your setup lives in one file:

```
~/.tokenflow/config.yaml
```

`tokenflow setup` writes it for you by detecting what is on the machine, so most people never
edit it. This page is the complete reference for when you do. `tokenflow config show` prints the
*effective* config (defaults merged with your file), and `tokenflow config path` prints the data
home.

Nothing here is ever transmitted anywhere. There are no keys, tokens, or accounts to configure —
if a field looks like it wants a credential, you are reading the wrong project.

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

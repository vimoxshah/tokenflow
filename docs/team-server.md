# Team server (self-hosted)

We host nothing. `tokenflow team serve` runs one process on a machine your
team owns, a spare box on the LAN, a VM, or a container, and lets every
teammate's `tokenflow sync` push its daily rollup there instead of writing
into a shared folder (iCloud/Dropbox/Syncthing). It is a second transport
for the exact same data the folder-sync `tokenflow team` view already reads:
the aggregation logic (`src/core/team.js`) and the plain-text renderer are
unchanged.

Nothing here reads prompt or code content. Each machine sends the same
coarse daily rollup the folder sync already produces: tokens, requests,
estimated cost, and (only if that developer opted in locally) their chosen
name, plus a per-branch cost ledger (see [`ledger.md`](ledger.md)) unless
that machine set `sync.receipts: false`. Request bodies are never logged.
This page is the operations guide: what to install, how to give it a
network path your laptops can reach, and how to keep it running. For what
the server actually stores and merges, see [`ledger.md`](ledger.md); for the
guard policy it can distribute, see [`policy.md`](policy.md); for the
optional GitHub App receiver, see [`github-app.md`](github-app.md).

## What it is, and what it is not

A single HTTP process with one shared secret, not a multi-tenant service.
It is meant for one team, on a network that team controls. It stores
exactly what a laptop's `tokenflow sync` already computes locally (daily
token/cost rollups and a branch/PR cost ledger), written to plain files on
disk, nothing more.

## Prerequisites

- **Node 22.5 or later** if you install directly, or **Docker** if you
  don't want Node on the host at all. Pick one; deploy/ has a path for
  each.
- **A machine on your team's private network.** LAN, VPN, or a Docker
  network with no public port mapping. The token protects the data, but put
  this behind a network boundary too; see "Network and TLS" below.
- **A DNS name pointing at that machine**, only if you want TLS (a reverse
  proxy in front, or the optional GitHub App webhook).

## Install

Three ways to run it; `deploy/README.md` is a ten-line pointer to the
same choice.

### npm global

```bash
npm install -g @vimoxshah/tokenflow
export TOKENFLOW_TEAM_TOKEN=$(openssl rand -hex 32)
echo "$TOKENFLOW_TEAM_TOKEN"          # save this; every laptop's sync.token must match it
tokenflow team serve --host 0.0.0.0
```

Good for a quick trial. For anything that should survive a reboot, use one
of the two paths below instead.

### Docker

```bash
cp deploy/team.env.example deploy/team.env    # then edit deploy/team.env
docker compose -f deploy/docker-compose.yml up -d
```

`Dockerfile.team` builds a tiny `node:22-alpine` image with no `npm install`
step (zero runtime dependencies, the whole app is already plain ESM).
`deploy/docker-compose.yml` builds it from the repo, binds the server to
`127.0.0.1` on the host only, stores uploads in a named volume, and runs a
healthcheck against `GET /health`. Add the TLS-terminating proxy only if
you plan to expose the GitHub App webhook publicly:

```bash
docker compose -f deploy/docker-compose.yml --profile tls up -d
```

### systemd

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tokenflow
sudo mkdir -p /etc/tokenflow
sudo cp deploy/team.env.example /etc/tokenflow/team.env   # then edit it
sudo chmod 600 /etc/tokenflow/team.env                    # it carries the shared token
sudo cp deploy/tokenflow-team.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tokenflow-team
```

`deploy/tokenflow-team.service` runs `tokenflow team serve` as a dedicated,
unprivileged user, with `NoNewPrivileges`, `ProtectSystem=strict`, and
`ReadWritePaths` scoped to its data directory only, and restarts it on
failure.

## Run it directly

```
tokenflow team serve
```

Defaults: binds `127.0.0.1:7790`, stores uploads under
`<TOKENFLOW_HOME>/team` (created if missing).

```
tokenflow team serve --host 0.0.0.0 --port 7790 --token <shared-secret>
```

A **non-loopback** `--host` always requires a token; the server refuses to
start without one, so an operator cannot accidentally expose an open write
endpoint to the network. The token can also come from the
`TOKENFLOW_TEAM_TOKEN` environment variable instead of `--token` (handy for
Docker/systemd, where flags end up in `ps` output). A **loopback** bind with
no token skips that check, since only the machine's own owner can reach it,
but if you then put a reverse proxy in front of that loopback port (see
"Network and TLS"), the proxy exposes it to everyone the proxy reaches. Set
`TOKENFLOW_TEAM_TOKEN` any time a proxy sits in front, loopback bind or not.

| flag | default | meaning |
| --- | --- | --- |
| `--host` | `127.0.0.1` | bind address |
| `--port` | `7790` | bind port |
| `--dir` | `<TOKENFLOW_HOME>/team` | where uploaded rollups are stored |
| `--token` | (falls back to `TOKENFLOW_TEAM_TOKEN`) | shared bearer token |
| `--github-app-id` | (falls back to `TOKENFLOW_GH_APP_ID`) | GitHub App id |
| `--github-key-file` | (falls back to `TOKENFLOW_GH_PRIVATE_KEY_FILE`) | path to the App's private key |
| `--github-webhook-secret` | (falls back to `TOKENFLOW_GH_WEBHOOK_SECRET`) | the App's webhook secret |
| `--github-api-url` | (falls back to `TOKENFLOW_GH_API_URL`, default `https://api.github.com`) | GitHub Enterprise Server only |
| `--github-notes-ref` | `tokenflow` | notes ref the App reads receipts from (flag only, no env var) |

The GitHub App flags are optional and only take effect together: an app id,
a private key, and a webhook secret must all be present or the receiver
stays disabled. See [`github-app.md`](github-app.md).

## Generating and distributing the shared token

One secret, two names: `TOKENFLOW_TEAM_TOKEN` on the server,
`sync.token` (or `TOKENFLOW_SYNC_TOKEN`) on each laptop. Generate it once:

```bash
openssl rand -hex 32
```

Set it on the server (an env file, or `--token`), then give every laptop the
same value and the server's URL:

```yaml
# ~/.tokenflow/config.yaml, on each laptop
sync:
  enabled: true
  to: https://team.example.com        # or http://team-box.local:7790 on a LAN
  token: <the-same-shared-secret>      # or set TOKENFLOW_SYNC_TOKEN instead
```

From here, `tokenflow sync` on each laptop pushes to `<to>/api/rollup`
instead of writing into a shared folder; see [`configuration.md`](configuration.md)
and [`ledger.md`](ledger.md) for the `sync:` block and what travels in each
push. Run `tokenflow team check` from a laptop any time you want to confirm
it can reach the server with that token before waiting on the first real
push; see "Health checks and monitoring" below.

## Network and TLS

Private by default: put this server on a network only your team can reach
(LAN, VPN, or a Docker network with no public port mapping) regardless of
whether a token is set. The token protects the data; it does not protect
the network path to it.

The **one exception** is the GitHub App webhook receiver
(`POST /github/webhook`, see [`github-app.md`](github-app.md)): it cannot
carry the shared bearer token, because GitHub has no way to be told to send
one. Its own auth is the App's webhook secret, checked as an HMAC over the
raw request body. If your team runs that receiver, publish only that one
path to the internet and keep every other route (`/api/rollup`,
`/api/team`, `/api/policy`, `/`) on the private network. `deploy/Caddyfile`
and `deploy/nginx.conf` both document this as "variant (b)", matched by URL
path.

For TLS: `deploy/Caddyfile` requests a certificate automatically for a name
that resolves publicly and answers inbound 80/443 from the internet. A
LAN-only name cannot get one that way; use `tls internal` (Caddy's own
local CA, documented inline in that file) or a DNS-01 challenge module
instead. `deploy/nginx.conf` is the equivalent for a team that already runs
nginx and manages its own certificates (for example with certbot); it also
sets `client_max_body_size`, since the rollup upload cap is 8 MB and
nginx's own default is 1 MB.

## The org policy file

Drop a `policy.yaml` in the server's data directory (next to the uploaded
rollups) to declare a guard cap the whole org must respect. Laptops pull it
with `tokenflow policy pull`, which fetches `GET /api/policy` and caches the
result at `<TOKENFLOW_HOME>/policy/org.yaml`; the guard hook itself only
ever reads that cache; it never makes a network call on its own. `GET
/api/policy` serves the file verbatim as `text/yaml` with an ETag, and
answers a 404 JSON error when the org has declared none, gated by the same
bearer token or `tf_token` cookie as every other read. See
[`policy.md`](policy.md) for the file's shape and the ceiling rule (an org
value can only lower an effective cap, never raise one).

## Backups

The data directory is the whole state: uploaded rollups, the receipts
ledger, and `policy.yaml` if you set one. Nothing else needs saving.

- **Docker**: back up the named volume. `docker compose` prefixes it with the
  compose project name (the `deploy` directory, unless you set `-p`
  yourself); run `docker volume ls` to confirm the exact name, then
  `docker run --rm -v deploy_tokenflow-team-data:/data -v $PWD:/backup
  alpine tar czf /backup/tokenflow-team-backup.tgz -C /data .`, or use your
  platform's own volume snapshot tooling.
- **systemd**: `rsync` or snapshot `/var/lib/tokenflow` (or whatever
  `TOKENFLOW_HOME` you set).

A restore is just putting the files back and restarting the process; there
is no database to migrate.

## Upgrades

`npm update -g @vimoxshah/tokenflow` for an npm install, or `docker compose
-f deploy/docker-compose.yml up -d --build` for Docker (there is no
published image to pull, so this rebuilds from the repo you have checked
out and restarts), or update the package and `systemctl restart
tokenflow-team` for systemd. The on-disk format does not change between
versions within the documented contract: each upload is either a
one-line-per-day rollup file or a whole-state receipts snapshot, and the
server always writes a file atomically (temp file, then rename), never
edits one in place. An upgrade never needs a data migration step.

## Health checks and monitoring

`GET /health` always answers, so a liveness check never needs the token:

```json
{ "ok": true, "machines": 3, "updatedAt": "2026-09-05T10:00:00.000Z" }
```

With no token configured at all, every caller gets the full shape above.
Once a token IS configured, an unauthenticated request gets only the
minimal `{ "ok": true }`, and the full shape (machine count and freshest
upload time) is reserved for a request that carries the right bearer or
`tf_token` cookie. `docker-compose.yml`'s healthcheck and the systemd
unit's `Restart=on-failure` both key off this route, and neither needs the
token: `{ "ok": true }` alone is enough to prove the process is alive.
`GET /github/health` is separate, never gated, and never carries a secret:
`{ "ok": true, "appConfigured": true|false }`, so you can confirm the App is
wired up before GitHub ever sends a delivery.

From a laptop, `tokenflow team check [--url <u>] [--token <t>]` (reading
`sync.to`/`sync.token` from config when the flags are omitted) is a small
diagnostic that reports whether the server is reachable, whether the token
is accepted, and whether an org policy is present, with a plain-language fix
for whichever of those fails.

## Troubleshooting

- **401 on a push, or `tokenflow team check` says the token was rejected.**
  The laptop's `sync.token` (or `TOKENFLOW_SYNC_TOKEN`) does not match the
  server's `TOKENFLOW_TEAM_TOKEN`. Compare them directly; a copy-paste often
  carries trailing whitespace or a missing character.
- **Clock skew.** The shared bearer token itself has no time component, so
  clock drift between a laptop and the server does not cause a 401 there.
  If you run the GitHub App receiver, its JWT to the GitHub API is
  time-bound (issued 60 seconds in the past specifically to absorb drift,
  and short-lived after that); a host whose clock is off by minutes, not
  seconds, is the only place skew matters here. See
  [`github-app.md`](github-app.md).
- **A laptop cannot reach the server at all.** Check the URL and port
  (`sync.to`), that the process is actually running (`GET /health` from the
  server's own machine first), and that the network path between them is
  open (LAN routing, VPN connected, or the Docker network the laptop
  expects). `tokenflow team check` reports this as "not reachable" with the
  same checklist.
- **Disk growth.** There is no pruning on either side today: each machine's
  rollup file holds one line per day it has ever synced (recomputed from
  its local `cube.json`, which `configuration.md` documents as kept
  forever), and its receipts file holds one entry per (repo, branch) with
  session history, both rewritten in full on every push. The bound is
  predictable rather than unbounded: roughly 200 bytes per machine per day
  for the rollup file, so 50 machines over 5 years is well under 20 MB;
  the receipts file scales with branches touched, not with time. Watch it
  the way you would any other small, slowly growing log directory.

## Security

- **Token rotation.** Generate a new token, set it on the server, and
  redistribute it to every laptop's `sync.token`/`TOKENFLOW_SYNC_TOKEN`.
  There is a window while some laptops still carry the old value; those
  pushes fail with a 401 until they're updated, rather than silently
  accepting the stale token, so a rotation is visible instead of partial and
  invisible.
- **What a leaked token exposes.** Read access to every rollup and receipt
  the team has ever pushed (repo names, branch names, machine labels, and
  costs; never prompts, code, file paths, or diffs), and write access to
  `POST /api/rollup` (which can only write files matching a machine's own
  id, not arbitrary paths). Rotate it immediately if you suspect it has
  leaked; see above.
- **Why this is not for the public internet.** One shared secret for
  everyone, no per-person accounts, no rate limiting beyond the 8 MB body
  cap on `/api/rollup`, and no audit log beyond your own reverse-proxy
  access log. That is an intentional tradeoff for a small trusted team on a
  private network, not a public multi-tenant service. The one path that IS
  meant to be public, `/github/webhook`, is authenticated a different way
  entirely (the App's HMAC-signed webhook secret) for exactly this reason.

## Auth model

There is exactly one shared secret; no per-person accounts, the same token
for every machine that pushes and every teammate who reads.

- **Writes**, `POST /api/rollup`, require `Authorization: Bearer <token>`
  **whenever a token is configured.**
- **Reads**, `GET /api/team`, `GET /api/policy`, and `GET /` require the
  token too, once configured: the aggregate carries repo names, branch
  names, machine names and costs, and a LAN peer should not see any of that
  without the secret. Two ways to authenticate a read:
  - `Authorization: Bearer <token>`, same as writes, or
  - a `tf_token` cookie. Visit `/?token=<token>` once from a browser you
    trust; the server mints the cookie (`HttpOnly`, `SameSite=Strict`,
    `Path=/`) and immediately redirects to `/` with the query string
    stripped, so the token never lingers in the address bar or browser
    history. Every subsequent `GET /` from that browser is authenticated
    automatically.
  - Without either, `GET /api/team` and `GET /api/policy` return a 401 JSON
    error and `GET /` returns a minimal "a token is required" page with
    **no aggregate content**, not even a hint of machine names or numbers.
- **`GET /health`** always answers (so a liveness check never needs the
  token), but the payload depends on auth: `{ "ok": true }` only when
  unauthenticated, the full `{ "ok": true, "machines": <n>, "updatedAt":
  "<iso|null>" }` once authenticated. `GET /github/health` is separate and
  never gated; see "Health checks and monitoring" above.
- **`POST /github/webhook` is the one route the shared token cannot
  protect**, because GitHub cannot be told to send one. Its own auth is the
  App's webhook secret, checked as an HMAC over the raw body: 404 while the
  App is unconfigured, 401 on a missing or wrong signature, 202 once a
  delivery is accepted for processing. See [`github-app.md`](github-app.md).
- **No token configured** (the loopback default): every route stays open,
  unchanged from a server with no auth story at all. There is no
  per-viewer identity to check on a machine only its owner can reach.
- Put this server on a private network regardless (see "Network and TLS");
  the token protects the data, not the network path to it.

## Routes

- `POST /api/rollup`, body `{ "machineId": "<id>", "files": { "<name>": "<text>" } }`.
  - `machineId` must match `^[A-Za-z0-9_-]{8,64}$` (the same id
    `tokenflow sync` already generates per machine).
  - Every key in `files` must equal exactly `<machineId>.jsonl` or
    `<machineId>.receipts.json`, nothing else is accepted, and nothing is
    ever written outside the server's storage directory.
  - The whole request body is capped at 8 MB.
  - `.jsonl` content is validated line by line (each non-blank line must
    parse as JSON); `.receipts.json` content must parse as JSON as a whole.
  - Files are written atomically (temp file, then rename) so a reader never
    sees a partial upload.
  - Response: `{ "ok": true, "files": ["<name>", ...] }`. Invalid requests
    get a short JSON error and a 400/401/413.
- `GET /api/team`, `aggregate(dir)` as JSON (same shape `tokenflow team
  --json` prints). 401 JSON error when a token is configured and the request
  isn't authenticated (see "Auth model").
- `GET /api/policy`, the org's `policy.yaml` verbatim as `text/yaml` with an
  ETag; 404 JSON error when the org has declared none. See "The org policy
  file" above.
- `GET /health`, counted directly from the uploaded `.jsonl` files (not the
  aggregate), so it reflects what the server has actually received. See
  "Health checks and monitoring" above.
- `GET /github/health`, `{ "ok": true, "appConfigured": true|false }`,
  never gated, never secret-bearing.
- `POST /github/webhook`, the self-hosted GitHub App receiver. See
  [`github-app.md`](github-app.md).
- `GET /`, a self-contained HTML page (no external requests, no scripts):
  the dashboard's generated design tokens inlined so colours/fonts match the
  rest of TokenFlow, a heading, machine count and freshness, and the same
  plain-text view `tokenflow team` prints. A "top repositories" table
  appears once the aggregate exposes `receipts.byRepo` (see
  [`ledger.md`](ledger.md) for that shape); the page degrades to the
  plain-text view alone when that section isn't present, no error either
  way. When a token is configured and the request isn't authenticated, this
  route instead returns a minimal "token required" page with no aggregate
  content, unless the request is `/?token=<token>` (see "Auth model").

## Example: pushing from a machine

```bash
curl -X POST http://team-box.local:7790/api/rollup \
  -H "authorization: Bearer $TOKENFLOW_TEAM_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "machineId": "m-a1b2c3d4",
    "files": {
      "m-a1b2c3d4.jsonl": "{\"machineId\":\"m-a1b2c3d4\",\"date\":\"2026-09-05\",\"inputTokens\":1000,\"outputTokens\":200,\"requests\":5,\"estCostUsd\":1.23}\n",
      "m-a1b2c3d4.receipts.json": "{}"
    }
  }'
```

## Safety notes

- The server never serves files from its storage directory directly, only
  through `aggregate()`/`renderText()`, and never logs request bodies.
- Only `POST /api/rollup` is rate-capped (by body size, not frequency),
  nothing else limits request rate. Keep the server on a network only your
  team can reach.
- `Cache-Control: no-store` is set on every response.
- The `tf_token` cookie has no `Secure` attribute, since this server is
  typically plain HTTP on a LAN/Docker network rather than behind TLS; if
  you do put it behind HTTPS, note that a plain-HTTP fallback path on the
  same host would still see the cookie (`SameSite=Strict` limits cross-site
  use, not cross-scheme use on the same site).

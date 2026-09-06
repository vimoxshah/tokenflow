# Team server (self-hosted)

`tokenflow team serve` runs one process on a machine your team owns — a spare
box on the LAN, or a container — and lets every teammate's `tokenflow sync`
push its daily rollup there instead of writing into a shared folder
(iCloud/Dropbox/Syncthing). It is a second transport for the exact same data
the folder-sync `tokenflow team` view already reads: the aggregation logic
(`src/core/team.js`) and the plain-text renderer are unchanged.

Nothing here reads prompt or code content. Each machine sends the same
coarse daily rollup the folder sync already produces — tokens, requests,
estimated cost, and (only if that developer opted in locally) their chosen
name. Request bodies are never logged.

## Run it

```
tokenflow team serve
```

Defaults: binds `127.0.0.1:7790`, stores uploads under
`<TOKENFLOW_HOME>/team` (created if missing).

```
tokenflow team serve --host 0.0.0.0 --port 7790 --token <shared-secret>
```

A **non-loopback** `--host` always requires a token — the server refuses to
start without one, so an operator cannot accidentally expose an open write
endpoint to the network. The token can also come from the
`TOKENFLOW_TEAM_TOKEN` environment variable instead of `--token` (handy for
Docker/systemd where flags end up in `ps` output).

| flag | default | meaning |
| --- | --- | --- |
| `--host` | `127.0.0.1` | bind address |
| `--port` | `7790` | bind port |
| `--dir` | `<TOKENFLOW_HOME>/team` | where uploaded rollups are stored |
| `--token` | — (falls back to `TOKENFLOW_TEAM_TOKEN`) | shared bearer token |

## Auth model

There is exactly one shared secret — no per-person accounts, the same token
for every machine that pushes and every teammate who reads.

- **Writes** — `POST /api/rollup` requires `Authorization: Bearer <token>`
  **whenever a token is configured.**
- **Reads** — `GET /api/team` and `GET /` require the token too, once
  configured: the aggregate carries repo names, branch names, machine names
  and costs, and a LAN peer should not see any of that without the secret.
  Two ways to authenticate a read:
  - `Authorization: Bearer <token>`, same as writes, or
  - a `tf_token` cookie. Visit `/?token=<token>` once from a browser you
    trust; the server mints the cookie (`HttpOnly`, `SameSite=Strict`,
    `Path=/`) and immediately redirects to `/` with the query string
    stripped, so the token never lingers in the address bar or browser
    history. Every subsequent `GET /` from that browser is authenticated
    automatically.
  - Without either, `GET /api/team` returns a 401 JSON error and `GET /`
    returns a minimal "a token is required" page with **no aggregate
    content** — not even a hint of machine names or numbers.
- **`GET /health`** always answers (so a liveness check never needs the
  token), but the payload depends on auth: `{ "ok": true }` only when
  unauthenticated, the full `{ "ok": true, "machines": <n>, "updatedAt":
  "<iso|null>" }` once authenticated.
- **No token configured** (the loopback default) — every route stays open,
  unchanged from a server with no auth story at all. There is no per-viewer
  identity to check on a machine only its owner can reach.
- Put this server on a private network (LAN, VPN, or a Docker network with
  no public port mapping) regardless — the token protects the data, not the
  network path to it.

## Routes

- `POST /api/rollup` — body `{ "machineId": "<id>", "files": { "<name>": "<text>" } }`.
  - `machineId` must match `^[A-Za-z0-9_-]{8,64}$` (the same id
    `tokenflow sync` already generates per machine).
  - Every key in `files` must equal exactly `<machineId>.jsonl` or
    `<machineId>.receipts.json` — nothing else is accepted, and nothing is
    ever written outside the server's storage directory.
  - The whole request body is capped at 8 MB.
  - `.jsonl` content is validated line by line (each non-blank line must
    parse as JSON); `.receipts.json` content must parse as JSON as a whole.
  - Files are written atomically (temp file + rename) so a reader never sees
    a partial upload.
  - Response: `{ "ok": true, "files": ["<name>", ...] }`. Invalid requests
    get a short JSON error and a 400/401/413.
- `GET /api/team` — `aggregate(dir)` as JSON (same shape `tokenflow team
  --json` prints). 401 JSON error when a token is configured and the request
  isn't authenticated (see "Auth model").
- `GET /health` — counted directly from the uploaded `.jsonl` files (not the
  aggregate), so it reflects what the server has actually received.
  Unauthenticated response is `{ "ok": true }`; authenticated (or no token
  configured) response is `{ "ok": true, "machines": <n>, "updatedAt":
  "<iso|null>" }`.
- `GET /` — a self-contained HTML page (no external requests, no scripts):
  the dashboard's generated design tokens inlined so colours/fonts match the
  rest of TokenFlow, a heading, machine count and freshness, and the same
  plain-text view `tokenflow team` prints. A "top repositories" table is
  added once the aggregate exposes `receipts.byRepo`; today `aggregate()`
  only reads the `.jsonl` files, so the page shows the `<pre>` view alone
  until the receipts pipeline lands (see "Open questions" below) — the page
  degrades to that automatically, no error either way. When a token is
  configured and the request isn't authenticated, this route instead
  returns a minimal "token required" page with no aggregate content, unless
  the request is `/?token=<token>` (see "Auth model").

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

- The server never serves files from its storage directory directly — only
  through `aggregate()`/`renderText()`, and never logs request bodies.
- Only `POST /api/rollup` is rate-capped (by body size, not frequency) —
  nothing else limits request rate. Keep the server on a network only your
  team can reach.
- `Cache-Control: no-store` is set on every response.
- The `tf_token` cookie has no `Secure` attribute, since this server is
  typically plain HTTP on a LAN/Docker network rather than behind TLS; if you
  do put it behind HTTPS, note that a plain-HTTP fallback path on the same
  host would still see the cookie (`SameSite=Strict` limits cross-site use,
  not cross-scheme use on the same site).

## Docker

`Dockerfile.team` builds a tiny `node:22-alpine` image with no `npm install`
step (zero runtime dependencies — the whole app is already plain ESM). Set
`TOKENFLOW_TEAM_TOKEN` and mount a volume for the storage directory:

```bash
docker build -f Dockerfile.team -t tokenflow-team .
docker run -d \
  -e TOKENFLOW_TEAM_TOKEN=<shared-secret> \
  -p 7790:7790 \
  -v tokenflow-team-data:/data \
  tokenflow-team
```

Inside the container the server binds `0.0.0.0` (so Docker's port mapping can
reach it), which is why `TOKENFLOW_TEAM_TOKEN` is mandatory there.

## Open questions

- The exact shape of `receipts.byRepo` on the `aggregate()` result is owned
  by the in-progress receipts pipeline (see `src/core/team.js`,
  `src/core/sync.js` module headers). This page reads `repo`/`name`,
  `tokens`, and `estCostUsd`/`cost` off each entry defensively and skips the
  table entirely if the shape isn't there yet; once that pipeline lands, the
  table may need its column list revisited against the real field names.
- `--port` with a non-numeric value is passed straight to `server.listen()`,
  which fails with Node's own error rather than a friendly CLI hint.
- A client that declares a huge `Content-Length` but never times out its
  upload is read to completion (bounded memory, unbounded time) before the
  413 is returned — see the comment on `readBodyLimited` in
  `src/commands/team-serve.js` for why closing the connection early instead
  resets it. There is deliberately no request-rate limiting; per the task's
  own scope this is body-size-only.

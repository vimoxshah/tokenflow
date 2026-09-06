# Self-hosted GitHub App

`tokenflow team serve` can receive GitHub webhooks and answer them with a
receipt comment and a check run. **We host nothing.** You run the team server
on a machine you own, you register your own GitHub App, and you point that App
at your own URL. No TokenFlow-operated service sits in the path, and no
receipt is stored on the server: it is read from your repository, rendered,
posted back to the same repository, and dropped.

This is the same job the [GitHub Action](../action/README.md) does, with a
different trade. The Action runs inside your CI and needs a workflow file in
every repository. The App runs once for the whole organization and needs no
workflow file at all, at the cost of a server you keep running and a URL
GitHub can reach.

## What the receiver does

On `pull_request` (`opened`, `synchronize`, `reopened`) and on a `push` to
`refs/notes/tokenflow`:

1. Resolves `refs/notes/<ref>` to its commit, that commit's tree, and the blob
   whose path is the pull request's head sha. Git fans a notes tree out as it
   grows, so the blob may live at `ab/cdef...` or deeper; the receiver joins
   the path components back together, so every fanout depth resolves.
2. Decodes that blob, parses it as JSON and validates it against the receipt
   schema (`schemas/receipt.v0.json`, and v1 once your build writes v1 notes).
3. Posts one pull request comment, or edits the one already there. The comment
   is found by the `<!-- tokenflow-receipt -->` marker and rendered by the same
   renderer the Action uses, so the two never post over each other and the
   comment reads identically whichever path produced it.
4. Publishes one check run named **TokenFlow spend** on the head commit, and
   edits that same check run on later deliveries rather than stacking a second
   one.

| Situation | Check run conclusion |
| --- | --- |
| No receipt note on the head sha yet | `neutral` |
| Receipt found, no cap declared or within every declared cap | `success` |
| Receipt found and over a cap in `.tokenflow/policy.yaml` | `failure` |

A pull request opened before its note is pushed gets a `neutral` check
immediately, and the same check turns green (or red) as soon as the notes push
arrives. That second delivery is why the receiver listens to `push` at all: the
note is written by the pre-push hook and travels as a separate ref, so it often
lands after the pull request event.

`neutral` never blocks a merge. Require the check in a branch protection rule
or a ruleset only if you want a missing receipt to hold a pull request.

### The cap

The cap lives in the repository, committed with the code:

```yaml
# <repo root>/.tokenflow/policy.yaml
receipt:
  maxCostUsd: 25
  maxCostPer100Lines: 4
```

These are the same two keys `src/core/policy.js` validates and the Action
reads, so one committed file drives the pre-push hook, the Action and this
receiver. A cap only fires on a number the receipt actually carries: a receipt
with no priced turns, or with no changed-line cost, reports the cap as "not
evaluated" instead of guessing. A missing, unreadable or malformed
`policy.yaml` means no cap, never a failed check.

Note that `guard:` in the same file is a different thing: those are per-session
live thresholds for the hook on a developer's machine, and they are never read
as a receipt cap.

## Register the GitHub App

In your organization: **Settings > Developer settings > GitHub Apps > New
GitHub App**.

1. **Homepage URL**: anything; it is not used.
2. **Webhook**: tick **Active**, and set the **Webhook URL** to your server's
   `POST /github/webhook`, for example
   `https://tokenflow.internal.example.com/github/webhook`.
3. **Webhook secret**: generate a long random string and keep it. The server
   needs the identical value.

   ```bash
   openssl rand -hex 32
   ```

4. **Repository permissions**:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Pull requests | Read and write | post and edit the receipt comment |
   | Checks | Read and write | create and update the `TokenFlow spend` check run |
   | Contents | Read-only | read `refs/notes/<ref>` and `.tokenflow/policy.yaml` |
   | Metadata | Read-only | mandatory, and required to subscribe to any repository event |

   Nothing else. In particular the App never needs Actions, Secrets, Packages
   or any organization permission.

5. **Subscribe to events**: **Pull request** and **Push**. Both, not one.
6. Create the App, then **Generate a private key**. GitHub downloads a
   `.pem` file once and cannot show it again. Put it somewhere only the server
   user can read:

   ```bash
   install -m 600 ~/Downloads/your-app.<date>.private-key.pem /etc/tokenflow/github-app.pem
   ```

7. Note the **App ID** at the top of the App's settings page.
8. **Install App**, and choose the organization and the repositories.

## Run the server with the App on

```bash
tokenflow team serve \
  --host 0.0.0.0 --port 7790 \
  --token "$TOKENFLOW_TEAM_TOKEN" \
  --github-app-id 424242 \
  --github-key-file /etc/tokenflow/github-app.pem \
  --github-webhook-secret "$TOKENFLOW_GH_WEBHOOK_SECRET"
```

| Flag | Environment fallback | Default |
| --- | --- | --- |
| `--github-app-id` | `TOKENFLOW_GH_APP_ID` | none |
| `--github-key-file` | `TOKENFLOW_GH_PRIVATE_KEY_FILE` | none |
| `--github-webhook-secret` | `TOKENFLOW_GH_WEBHOOK_SECRET` | none |
| `--github-api-url` | `TOKENFLOW_GH_API_URL` | `https://api.github.com` |
| `--github-notes-ref` | none | `tokenflow` |

Prefer the environment variables under systemd or Docker: a flag value ends up
in `ps` output, an environment variable does not.

Every one of these values is trimmed before use. A webhook secret pasted into
a systemd unit or a Docker env file usually picks up a trailing newline, and a
secret that differs from GitHub's by one invisible byte fails every signature
check with nothing in the log to explain it. Leading and trailing whitespace is
therefore never part of the secret. Whitespace *inside* it is, so do not put
any there.

The App is on only when the **app id, the private key and the webhook secret
are all three present**. With any of them missing, `POST /github/webhook`
answers `404` rather than half working, and the rest of the team server is
unaffected. A `--github-key-file` that is named but cannot be read fails at
startup, where you will see it, rather than on the first delivery.

Two routes come with it:

- `POST /github/webhook`. Verified by HMAC SHA-256 over the raw request body
  against `X-Hub-Signature-256`, compared in constant time. **This is the one
  route the shared team token does not protect**, because GitHub cannot be told
  to send a bearer header. Its auth is the webhook secret and nothing else.
  A body over 1 MB is rejected with `413`, a content type that is not
  `application/json` with `415`, a body that is not JSON with `400`, and a bad
  or missing signature with `401`. A good delivery is answered `202`
  immediately and processed afterwards, because GitHub gives a receiver ten
  seconds and reading a notes tree can take longer.
- `GET /github/health` returns `{"ok":true,"appConfigured":true|false}`. It
  carries no secret and is never gated, so a reverse proxy or a load balancer
  can probe it.

Unrelated to the App but served by the same process, `GET /api/policy` hands
out the org's `<dir>/policy.yaml` as `text/yaml` for `tokenflow policy pull`,
behind the same token as every other read. It sends an `ETag`, and a request
carrying a matching `If-None-Match` gets a `304` with no body, so an unchanged
policy costs a round trip and no download.

Deliveries are deduplicated by `X-GitHub-Delivery` in memory (the last 1000),
so a GitHub retry or a manual redelivery does not post a second comment. The
memory is not persisted: a restart may re-edit a comment that is upserted
anyway.

## Exposing only the webhook

[docs/team-server.md](team-server.md) says to keep the team server on a private
network. That advice still stands, and it is not in conflict with this page:
**expose the single path `/github/webhook` and nothing else.** The dashboard,
`/api/team`, `/api/rollup` and `/api/policy` stay on the private network. Only
GitHub needs to reach the webhook, and the webhook is the only route whose auth
does not depend on the team token.

An nginx front end that publishes exactly one path:

```nginx
server {
  listen 443 ssl;
  server_name tokenflow.internal.example.com;

  # ssl_certificate / ssl_certificate_key ...

  location = /github/webhook {
    proxy_pass http://10.0.0.20:7790/github/webhook;
    proxy_set_header Host $host;
    client_max_body_size 1m;
  }

  location = /github/health {
    proxy_pass http://10.0.0.20:7790/github/health;
  }

  location / {
    return 404;
  }
}
```

Note the exact-match `location =`: a prefix match would publish
`/github/webhook/../api/team` to anyone who asks.

Narrow it further with GitHub's own source addresses. `GET https://api.github.com/meta`
returns a `hooks` array of CIDR ranges that webhook deliveries come from, and
those ranges change, so read them at deploy time rather than pasting them in:

```bash
curl -s https://api.github.com/meta | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const c of JSON.parse(s).hooks)console.log(`allow ${c};`)})' \
  > /etc/nginx/github-hooks.conf
```

Include that file in the `location = /github/webhook` block, followed by
`deny all;`, and re-run it on a schedule. Treat the allow list as defence in
depth, not as authentication: the signature check is what actually proves a
delivery came from your App.

Terminate TLS at the proxy. GitHub will deliver over plain HTTP, but the
webhook secret is only as private as the transport carrying its signature.

## GitHub Enterprise Server

Point `--github-api-url` at your instance's REST API root and everything else
is identical:

```bash
tokenflow team serve \
  --github-api-url https://github.example.com/api/v3 \
  --github-app-id 7 \
  --github-key-file /etc/tokenflow/github-app.pem \
  --github-webhook-secret "$TOKENFLOW_GH_WEBHOOK_SECRET"
```

Register the App under your instance's own organization settings. Everything
the receiver calls (the App JWT, installation access tokens, the Git Data API,
the Contents API, issue comments, check runs, list pull requests) exists on
GitHub Enterprise Server.

## A different notes ref

`--github-notes-ref` changes which ref the receiver reads, and it defaults to
`tokenflow`. Leave it alone unless something other than TokenFlow's own hook is
attaching the notes: `tokenflow hooks install` writes and pushes
`refs/notes/tokenflow` and has no flag to change that today
(`NOTES_REF` in `src/core/receipt-note.js`). The option exists for a repository
whose notes were attached by hand or by another tool:

```bash
git notes --ref=receipts add -F receipt.json <sha>
git push origin refs/notes/receipts
tokenflow team serve --github-notes-ref receipts
```

The receiver matches the `push` event on `refs/notes/<ref>` exactly, so a
mismatch shows up as a delivery that is accepted and then ignored, with
`outcome=ignored (ref=...)` in the log.

## Limits worth knowing before you rely on it

**A pull request from a fork usually has no receipt.** The receipt travels as a
git note, and the pre-push hook pushes `refs/notes/tokenflow` to the remote it
is pushing to. A contributor working on a fork pushes the branch and the notes
ref to **their fork**, not to your repository, so the note never reaches the
base repository the pull request targets. The App reads the base repository, so
it finds nothing and publishes a `neutral` check.

There is no way around this from the server: the App's installation token has
no access to a fork it is not installed on, and asking a contributor to install
an App on their personal fork is not reasonable. Live with `neutral` on fork
pull requests, or, if you require the check, exempt them in the ruleset. Same
repository, different branch (the usual shape inside a company) is unaffected.

**Long conversations and large repositories are paged, up to a point.** The
search for the existing receipt comment walks every page of the conversation
until it finds the marker, and a notes push walks every page of open pull
requests, both following GitHub's `Link: rel="next"` header. The walk stops at
20 pages of 100. Past roughly 2000 comments on one pull request the existing
comment is not found and a new one is posted; past roughly 2000 open pull
requests, the ones beyond that are not visited on a notes push. Neither limit
is reachable in normal use, and the comment search costs a single request in
the normal case because it stops on the page the marker is on.

**Two deliveries about the same pull request are serialized.** The pre-push
hook pushes the branch and then the notes ref, so a `pull_request` event that
finds no receipt is routinely still being processed when the notes `push`
arrives. The receiver processes one pull request at a time and re-reads the
notes ref immediately before it would publish a `neutral` check, so a late
receipt always wins and a green check is never overwritten by a stale neutral
one. This is per process: two team servers behind a load balancer, both
receiving the same App's deliveries, can still race. Run one.

## Troubleshooting

Start at the App's **Advanced > Recent Deliveries** page. Every delivery shows
the request GitHub sent and the response your server gave, and each one has a
**Redeliver** button.

| What you see | What it means |
| --- | --- |
| `404` on the delivery | The App is not configured on the server. Check `GET /github/health`; if `appConfigured` is `false`, one of the app id, key file or webhook secret is missing. |
| `401` on the delivery | The webhook secret on the server is not the one in the App settings. Re-set both to the same value and redeliver. |
| `415` on the delivery | The App's webhook content type is `application/x-www-form-urlencoded`. Set it to `application/json`. |
| `413` on the delivery | The body was over 1 MB. No `pull_request` or notes `push` payload is close to that; suspect a misrouted webhook. |
| Timeout, no response | GitHub cannot reach the URL. Check DNS, the firewall and the proxy from outside your network. |
| `202`, but no comment appears | The server log line for that delivery says why. `outcome=neutral (no-note)` means the receipt has not been pushed yet; `outcome=ignored (...)` names the event or action that was skipped. |
| The check stays `neutral` forever | The notes ref was never pushed. Run `tokenflow hooks install` on the machines that push, then `git push origin refs/notes/tokenflow` once for history already pushed. |
| `neutral` only on pull requests from forks | Expected. The contributor's notes went to their fork, not to your repository. See "Limits worth knowing" above. |
| `outcome=error (POST ... failed: 403)` | The installation is missing a permission. Re-check the four in the table above; GitHub does not grant a permission added after installation until an org owner accepts it. |
| `outcome=error (... failed: 404)` on a repository call | The App is not installed on that repository. |

The server logs exactly one line per pull request:

```
[tokenflow github] event=pull_request repo=acme/widgets pr=7 outcome=success
```

That line, and the check run's own summary, are the whole log surface.
**Request bodies are never logged**, on this route or any other.

## What leaves your machine, and what does not

The receiver reads a git note and a policy file that are already in your
repository and calls the GitHub REST API to read them, to post or edit one
comment, and to create or update one check run. It makes no other network call.
It reads no prompt content and no code content: a receipt is token counts,
model names, session and turn counts, and a dollar estimate produced locally
against a local price table. It is never measured billing.

Nothing from a delivery is written to disk. The team server stores rollups
uploaded by your own machines (see [docs/team-server.md](team-server.md)) and
nothing from GitHub.

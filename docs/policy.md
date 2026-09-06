# Policy: personal, repo, and org

A guard threshold can be declared at three levels, and each level can only
tighten the one below it:

1. **Personal** (`~/.tokenflow/config.yaml`'s `guard:` block, set with
   `tokenflow guard --set`). One machine, one person.
2. **Repo** (`<repo root>/.tokenflow/policy.yaml`'s `guard:` block). Checked
   in, reviewed in a PR, the same for everyone who clones the repo. Wins over
   the personal value, key by key.
3. **Org** (a cap the team declares on a team server, cached locally at
   `<TOKENFLOW_HOME>/policy/org.yaml`). Applied as a CEILING on top of
   whichever of the two layers above declared a value.

**The ceiling rule: the org can only lower an effective cap, never raise
one.** For each of the five guard keys, the effective value is the smaller
of "whatever personal/repo already produced" and "whatever the org
declared" (when the org declared anything for that key). A key the org does
not mention is untouched.

## Worked example

Say a repository's `.tokenflow/policy.yaml` declares:

```yaml
guard:
  maxCostUsd: 80
  warnCostUsd: 20
```

and the org's cached policy declares:

```yaml
guard:
  maxCostUsd: 30
  warnCostUsd: 999
```

The effective policy for that repo is:

| key | value | source | why |
| --- | --- | --- | --- |
| `maxCostUsd` | 30 | org | 30 is lower than the repo's 80, so it wins |
| `warnCostUsd` | 20 | repo | the org's 999 is higher, so it has no effect |

`tokenflow guard --policy` (or `tokenflow policy show`) prints exactly this,
with each key's source tagged `[personal]`, `[repo]`, `[org]`, or
`[default]` (declared nowhere).

## `policy.yaml`'s shape

The same file format is used for a repo's `.tokenflow/policy.yaml` and for
the org's cached copy. Both `guard:` and `receipt:` blocks are optional, and
an invalid value inside either one is reported and dropped rather than
applied, so a typo never takes the file's other, valid keys down with it:

```yaml
guard:
  warnCostUsd: 10          # session spend at which the hook warns
  maxCostUsd: 50           # session spend at which the hook blocks
  warnContextTokens: 150000
  maxContextTokens: null
  warnMarginalUsd: null
receipt:
  maxCostUsd: 25            # a per-PR/per-branch receipt cap, checked by the Action/App streams
  maxCostPer100Lines: 2.5   # a per-100-changed-lines receipt cap, same streams
note: "This repo's sessions run long, reasoning-heavy refactors, not chat."
```

`receipt.maxCostUsd` and `receipt.maxCostPer100Lines` are a contract with
the GitHub Action and App streams (see `receipts-on-github.md`): those two
names are read directly off the parsed policy file and are never renamed.
They are NOT merged into the guard's effective policy: there is no personal
"receipt" layer to ceiling against, and the in-session guard only ever
reads the five `guard:` keys.

## The org cache: location, TTL, and what "pull" does

The guard never fetches anything itself. It only reads whatever is already
on disk at:

```
<TOKENFLOW_HOME>/policy/org.yaml         # the org's policy.yaml, verbatim
<TOKENFLOW_HOME>/policy/org.meta.json    # {fetchedAt, source, etag?}
```

`tokenflow policy pull` is the one command that talks to the network. It
fetches `GET <sync.to>/api/policy` (authenticated the same way every other
read from a team server is, with `Authorization: Bearer <sync.token>`, see
`team-server.md`), and:

- writes the new content atomically (temp file plus rename) when it differs
  from the cache, and stamps `org.meta.json` with the fetch time and the
  server URL,
- leaves the existing cache completely untouched on any failure: a network
  error, a non-2xx status, or a body that will not parse as YAML,
- clears `org.yaml` on a 404 (the org removed its policy), while still
  stamping `org.meta.json` so the TTL keeps gating re-fetches instead of
  hitting the server on every single call.

By default a pull only actually reaches the network once per hour (the TTL);
`tokenflow policy pull --force` bypasses that and fetches regardless of age.
A background refresh helper, `refreshOrgPolicyIfStale()` (in
`src/commands/policy.js`), wraps the same call so `tokenflow watch` or
`tokenflow refresh` can keep the cache current on their own schedule without
either command needing to know anything about TTLs or team servers. As of
this writing it is not yet wired into either command; the intended call
sites are `runCycle()` in `src/core/watch.js` and `cmdRefresh()` in
`bin/tokenflow.js`.

```bash
tokenflow policy pull                 # fetch now if the cache is older than an hour
tokenflow policy pull --force         # fetch regardless of the cache's age
tokenflow policy show                 # the effective policy for the current directory
tokenflow policy show --cwd <dir>     # for some other directory or repository
tokenflow policy show --json          # the same result, as JSON
```

`policy pull` exits `1` only when the fetch failed AND there is no cache to
fall back on. If a cache already exists, a failed pull reports the error and
exits `0`: the org's last-known caps still apply, they just did not get a
chance to refresh this time.

## What the guard does when the server is unreachable

Nothing different, by design. `evaluateSession` (the Claude Code hook path)
and `evaluateCodexNotify` (the Codex path) call `effectivePolicy()`, which
reads `org.yaml`/`org.meta.json` off disk and nothing else: there is no
fetch anywhere on the hook's call path, so a down team server, a laptop on a
plane, or a `sync.to` that was never configured all look identical to the
guard. It uses whatever cache is there (possibly nothing, in which case the
org layer contributes no ceiling at all) and evaluates normally. When an
org-declared cap is the one that actually fires, the verdict names it: the
`guard --policy` view and a triggered warning/block both say a cap came
"from the org policy" and name the server URL it was cached from, the same
way a repo-declared cap already says it came from `.tokenflow/policy.yaml`.

## Config keys involved

- `guard:` in `~/.tokenflow/config.yaml`, the personal layer (see
  `configuration.md`'s `guard` section).
- `sync.to` and `sync.token` (or the `TOKENFLOW_SYNC_TOKEN` environment
  variable) in `~/.tokenflow/config.yaml`, the team server and the bearer
  token `policy pull` authenticates with. The same two keys `tokenflow sync`
  already uses to push rollups (see `team-server.md`); nothing new is
  introduced for the policy layer to reuse them.

Nothing here ever sends a repository name, a branch name, prompt content, or
code to the team server. A `policy pull` request carries only the bearer
token; the response is the org's own `policy.yaml` text, the same file the
team already committed to run its own server.

# The guard for Codex CLI, and caps that travel with a repository

`tokenflow guard` started as a Claude Code hook. This page covers the two
things layered on top of it: a per-repository policy file, and a Codex CLI
integration that **warns but never blocks**.

## Codex cannot be blocked — read this first

Claude Code gives a hook a chance to reject a tool call or a prompt before it
runs (`PreToolUse` / `UserPromptSubmit`, exit code `2`). Codex CLI has no
equivalent. Its only extension point after a turn is `notify` in
`~/.codex/config.toml`: one external program, run once per completed turn,
with no way to stop anything that already happened.

So the Codex integration **only warns**, through an OS notification (the same
`src/core/notify.js` used everywhere else in TokenFlow — `osascript` on
macOS, `notify-send` on Linux, a toast on Windows). It cannot cap a runaway
Codex session the way the Claude Code hook can cap a runaway Claude Code
session. If you want an enforceable cap, Claude Code's `PreToolUse` /
`UserPromptSubmit` hook is still the only one that can actually stop a turn.

## What Codex sends, and what TokenFlow reads

Codex's `notify` program receives one JSON argument after every turn
(`agent-turn-complete` is currently the only event). Per Codex's own docs,
common fields are:

```json
{
  "type": "agent-turn-complete",
  "thread-id": "0199...",
  "turn-id": "turn-...",
  "cwd": "/Users/you/project",
  "input-messages": ["..."],
  "last-assistant-message": "..."
}
```

`tokenflow guard --codex-notify` reads **only** `thread-id` and `cwd`. It
never reads, logs, or stores `input-messages` or `last-assistant-message` —
those carry the actual conversation, and TokenFlow's rule is counts and
metadata only, never prompt or code content.

From `thread-id` it locates the matching rollout transcript —
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<thread-id>.jsonl` (or
`archived_sessions`) — and ingests it with the same openai adapter and the
same incremental, offset-based cache `tokenflow refresh` and the Claude Code
guard already use (`$TOKENFLOW_HOME/guard/codex-<thread-id>.json`), so a long
session's transcript is re-read only for the bytes appended since the last
turn. From `cwd` it resolves the effective guard policy (below) and judges
the session exactly the way the Claude Code hook does — same thresholds, same
`evaluateGuard`.

On `warn` or `block` it sends **one** OS notification with the same text
`tokenflow guard --session <file>` would print. A `block`-level verdict is
still only a notification: the title says so explicitly ("warning only —
Codex has no blocking hook"). `src/core/notify.js` truncates a notification
body to 240 characters, so a long verdict (several reasons, a suggestion) may
arrive clipped — the full text is always available by running
`tokenflow guard --session <the rollout file>` yourself.

## Wiring it up

```bash
tokenflow guard --install --codex            # print the exact notify = [...] line
tokenflow guard --install --codex --apply    # append it to ~/.codex/config.toml, if safe to do so
```

`--apply` only writes when **both** are true: `~/.codex/config.toml`'s parent
directory exists (otherwise Codex does not look installed on this machine,
and nothing is created), and the file declares no `notify` key yet. Codex
allows exactly one `notify` program — if one is already configured (for
example a computer-use client, or your own script), `--apply` refuses and
prints the same instructions `--install --codex` alone would, so you can
merge it by hand instead of silently losing whatever was there. Restart
Codex CLI for a config change to take effect.

## Per-repository caps: `.tokenflow/policy.yaml`

A threshold set with `tokenflow guard --set` lives in
`~/.tokenflow/config.yaml` — one machine, one person. A repository can
instead declare its own caps in a file that travels with it:

```yaml
# <repo root>/.tokenflow/policy.yaml
guard:
  warnCostUsd: 10
  maxCostUsd: 50
  warnContextTokens: 150000
note: "This repo's sessions run long — reasoning-heavy refactors, not chat."
```

Any of the five guard keys may be declared (see `docs/configuration.md`'s
`guard` section for what each one means); an invalid value (not a number, or
not positive) is reported and ignored rather than applied — a typo in a
checked-in file must not take the hook down for everyone who clones the repo.
`note` is optional and shown alongside a warning/block that the policy
triggered, and beside `guard --policy`'s output; it may sit at the top level
or beside the `guard:` block.

**A repository's declared key wins over the personal config, key by key.** A
key the repository does not declare falls back to `~/.tokenflow/config.yaml`,
and a key declared nowhere is `null` — informational only, same as today.
Above both sits an optional **org policy**: a cap your team publishes on its
own team server, cached locally, applied only as a ceiling (it can lower an
effective cap, never raise one). See [policy.md](policy.md).

```bash
tokenflow guard --policy                  # effective policy for the current directory
tokenflow guard --policy --cwd <dir>      # for some other directory / repository
tokenflow policy show                     # the same view, under its own command
```

prints each of the five keys, its value, and where it came from -
`[personal]`, `[repo]`, `[org]`, or `[default]` - plus the repository root
that was found (a plain `.git` directory is enough; a git worktree resolves to
its main checkout, same as everywhere else in TokenFlow) and any errors in
`policy.yaml`. `[personal]` is `~/.tokenflow/config.yaml`; older builds of
this command labelled that same source `[config]`.

When a warning or block fires because of a repo-declared key, one extra line
is appended to the verdict naming which key(s) came from
`.tokenflow/policy.yaml` (and the `note`, if one is set) — for both the
Claude Code hook and the Codex path, since both call the same policy
computation. A key that came from the org layer gets its own line saying so,
and a block on an org cap tells you to talk to whoever maintains the team
server rather than to run `guard --set`, which writes your own config and
cannot lift a ceiling.

The org layer is read from its local cache only. This hook never fetches, no
matter how stale that cache is; `tokenflow policy pull` and `tokenflow
refresh` are what keep it current. See [policy.md](policy.md).

## Everything this adds, at a glance

| Command | What it does |
| --- | --- |
| `tokenflow guard --policy [--cwd <dir>]` | Show the effective guard policy and each value's source |
| `tokenflow policy show [--cwd <dir>]` | The same view, plus where the cached org policy came from |
| `tokenflow policy pull [--force]` | Refresh the cached org policy from your team server |
| `tokenflow guard --install --codex [--apply]` | Wire up (or print) Codex's `notify` line |
| `tokenflow guard --codex-notify <json>` | What Codex's `notify` actually runs, once per turn |

Nothing here reads prompt or code content, or writes outside `$TOKENFLOW_HOME`
and (only with `--apply`, and only when safe) `~/.codex/config.toml`. Only one
row makes a network call: `policy pull`, to the team server you named in
`sync.to`. Both guard paths read the cached policy and never fetch.

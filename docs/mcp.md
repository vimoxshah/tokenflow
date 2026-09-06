# The MCP server: letting the agent read its own bill

Every other surface in TokenFlow reports to a human after the fact: a dashboard,
a receipt on a pull request, a number in the menu bar. The one participant who
has never been able to see any of it is the agent doing the spending.

`tokenflow mcp` closes that loop. It is a Model Context Protocol server over
stdio, so a coding agent can ask, in the middle of its own session:

- what has this branch cost so far?
- what cap did this repository declare?
- how much have I used in the last week, and on which models?
- where does the monthly budget stand?

An agent that can read those answers can plan around them. It can batch its
edits instead of re-reading a file it already read, choose a smaller model for
a mechanical change, or say out loud that the work it is about to start will
cross the cap the repository set. A number the agent cannot see cannot change
its behaviour.

**The server is read-only and local.** Nothing it exposes writes to the store,
sends a notification, or makes a network request. Its only filesystem effect is
creating the (empty) data directories under `$TOKENFLOW_HOME`, which every read
command already does. Nothing leaves your machine.

## The tools

| Tool | Arguments | Answers |
|---|---|---|
| `tokenflow_receipt` | `repo?`, `branch?` | what one branch has cost: dollars, the context/work split, turns, sessions, dates |
| `tokenflow_policy` | `cwd?` | the guard caps in force here, and which layer each came from |
| `tokenflow_usage` | `days?` (1 to 90, default 7) | tokens by bucket, cost, requests, sessions, top models |
| `tokenflow_budget` | none | the monthly cap, spend so far, and the projected month end |

Every call returns one text content block holding compact JSON, so an agent can
parse the answer rather than read prose out of a table.

`repo` takes a path to a checkout or a bare repository name, the same as
`tokenflow receipt --repo`. With a path, the branch defaults to the one checked
out there, read from `.git/HEAD` without running git. When a branch has no
recorded sessions the result is `{"found": false, ...}` with the branches that
do have receipts, never an invented zero.

`tokenflow_policy` reports a `source` beside every cap: `org` (a team cap, which
can only lower a limit), `repo` (a `.tokenflow/policy.yaml` checked into the
repository), `personal` or `config` (this machine's own setting), and `default`
(nothing declared, so the cap is `null` and nothing will be blocked). See
[guard-codex.md](guard-codex.md) for how those layers are declared.

Two honesty rules carry through from the rest of TokenFlow. Estimated cost (this
machine's price table) and measured cost (what a gateway billed) are reported
separately and never added together. A missing number is `null`, never `0`, so
an agent cannot read "not known" as "free".

A tool that fails returns `isError: true` with a message rather than a JSON-RPC
error, which is what the protocol asks for: a model can only correct a mistake
it is allowed to see. Only "no such tool" is a protocol error.

## Registering the server

The server speaks MCP over stdio and takes no arguments beyond the subcommand.
All three commands below assume `tokenflow` is on your `PATH`; if you run it
from a checkout, use `node /path/to/bin/tokenflow.js` as the command and put
`mcp` in the arguments.

### Claude Code

```bash
claude mcp add tokenflow -- tokenflow mcp
```

Everything after `--` is the command Claude Code runs. Verified against the
Claude Code documentation (`claude mcp add [options] <name> -- <command>
[args...]`).

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.tokenflow]
command = "tokenflow"
args = ["mcp"]
```

Verified against the Codex configuration reference: `mcp_servers` is a map of
server name to config, and `command` and `args` are passed to the stdio
launcher verbatim, with no shell, no tilde expansion and no variable
substitution. Give an absolute path if `tokenflow` is not on the `PATH` Codex
inherits.

### Cursor

In `.cursor/mcp.json` at the root of the project:

```json
{
  "mcpServers": {
    "tokenflow": {
      "command": "tokenflow",
      "args": ["mcp"]
    }
  }
}
```

The block itself is verified against the Cursor MCP documentation: the key is
`mcpServers`, and a local server is `command` plus `args`. The file *path* is
not: the documentation fetched showed the shape without naming where the file
lives, so check your Cursor version if a project-level `.cursor/mcp.json` is
not picked up.

### Anything else

Any MCP client that can launch a stdio server will work. The launch is
`tokenflow mcp`, with no flags.

## Checking it by hand

The server reads newline-delimited JSON-RPC on stdin and writes it on stdout,
so you can talk to it with a pipe:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tokenflow_usage","arguments":{"days":7}}}' \
  | tokenflow mcp
```

You should see three JSON lines back, one per request, and nothing else:
stdout carries the protocol and only the protocol. Diagnostics go to stderr.

## Protocol notes

- Transport: stdio, newline-delimited JSON-RPC 2.0, one message per line.
- Latest protocol version this server names: `2026-07-28`. It also speaks
  `2025-11-25` and `2025-06-18`. On `initialize` it answers with the client's
  version when that version is one of those three, and otherwise with its own
  latest.
- Answering with our own latest is the lifecycle rule up to `2025-11-25`. The
  `2026-07-28` lifecycle asks a server to refuse an unsupported version
  instead, with error `-32022` and `data: {supported, requested}`. This server
  does not do that, on purpose: it is read-only and harmless to talk to, and
  refusing the handshake would lock out every client written against the older
  rule for no gain. It is a compatibility choice, not an oversight.
- Every result carries `resultType: "complete"` once the negotiated version is
  `2026-07-28`, because from that version the field sits on the base `Result`
  type and the schema says a server implementing it MUST include it. That means
  `initialize`, `ping`, `tools/list` and `tools/call` alike. On an earlier
  negotiated version the field is left off, which is what those schemas expect:
  a client is told to read an absent `resultType` as `"complete"`. Errors are
  not results and never carry it.
- Capabilities: `tools` only. There are no resources, no prompts, no sampling
  and no subscriptions, because none of them would tell an agent anything the
  four tools do not.
- Responses are written in the order the requests arrived. The specification
  permits any order, but nothing here waits on I/O, so keeping the stream in
  order costs nothing and makes it far easier to read a transcript.
- The server exits 0 when stdin ends or the output pipe breaks. A client
  hanging up is a normal end of session, not a failure.

The framing lives in `src/core/jsonrpc.js` and the tools in
`src/commands/mcp.js`, both dependency-free like the rest of TokenFlow. There is
no MCP SDK in this project.

## What is deliberately not here

- **No writes.** No tool sets a budget, edits a policy, or triggers a refresh.
  An agent that could raise its own cap is not a cap.
- **No prompt or code content.** The tools report counts, dollars and metadata,
  the same fields the rest of TokenFlow records.
- **No scoped budgets yet.** `tokenflow_budget` reports the single monthly cap.
  Per-repository and per-team budgets (`budgets:` in `config.yaml`) are visible
  through `tokenflow budget` on the command line.

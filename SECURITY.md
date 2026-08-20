# Security & privacy

## The privacy model, stated plainly

This tool reads local files that AI coding tools already write, extracts **counts, identifiers
and timestamps**, and stores them in a local directory. It does not read, store or transmit
prompts, completions, conversations, or source code.

- **No network calls** in ingest, analytics, or the UI. Not for pricing (the price table is a
  committed file), not for telemetry (there is none), not for updates.
- The dashboard server binds to **127.0.0.1** and requires a token for any state-changing
  request. The one CORS-open endpoint, `GET /api/ping`, returns a liveness flag, the port, a
  record count and a timestamp — nothing else.
- All data lives under `~/.tokenflow` (or `$TOKENFLOW_HOME`). Deleting that directory
  deletes everything the tool knows.
- A CSV or HTML export contains your usage counts and identifiers such as session ids, project
  paths and repository names. Treat an export as you would treat a build log — it is not
  prompt content, but it does describe your work. `tokenflow export --csv` is the one operation
  that can move data off the machine, and only because you chose where to put the file.

Verify any of this yourself: `grep -rn "fetch\|https\?://" src/` — the only matches in the
ingest and analytics path are in this documentation and in the browser's calls to its own
loopback server.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Instead:

1. Open a GitHub security advisory (Security → Report a vulnerability), or
2. Contact a maintainer privately.

Include what an attacker could do, and a minimal reproduction. We will acknowledge, investigate,
and credit you in the fix unless you prefer otherwise.

## Threat model, briefly

In scope: anything that could cause the tool to exfiltrate data, execute untrusted content from
a log file, escape the data directory when writing, or let another origin in the same browser
read or mutate your data through the local server.

Out of scope: an attacker who already has read access to your home directory (they can read the
AI tools' logs directly, which are the input to this tool).

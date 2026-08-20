# Agent skill

`skills/tokenflow/` is a self-contained skill that teaches an AI coding agent to install,
configure, extend and debug this project on an unfamiliar machine. The point is that you should be
able to say:

> "Install and configure the Tokenflow for my environment."

…and get a working dashboard without explaining anything about the internals.

## What the agent can do with it

- probe the machine for supported AI tools and report what it found
- write a correct `config.yaml`, including non-standard source paths
- run a resumable ingest that fits inside short-lived shells
- validate the result and explain the data-health numbers
- add a new provider adapter for an unsupported tool
- build a generic import mapping from an arbitrary CSV/JSON/SQLite export
- configure pricing, and explain why cost is blank until it is
- diagnose inflated or missing numbers using the documented failure modes
- explain any number on the dashboard, including what it deliberately does not claim

## Layout

```
skills/tokenflow/
  SKILL.md                    the instructions the agent reads
  providers/
    detection-matrix.md       where each tool stores usage, per OS
    adapter-template.js       a commented starting point
  schemas/
    normalized-record.json    JSON Schema for the unified record
    config.schema.json        JSON Schema for config.yaml
  examples/
    config.yaml               a fully worked configuration
    generic-mapping.json      a saved import mapping
    session-transcript.md     the awkward real-world shapes, annotated
```

## Using it

**Claude Code / Cowork:** copy the folder into `.claude/skills/` (project) or `~/.claude/skills/`
(global) and ask for it by name. **Any other agent:** point it at `SKILL.md` — it is plain
Markdown with no tool-specific assumptions.

```
> Install and configure the Tokenflow for my environment.
> Add an adapter for <tool>; its logs are at <path> and look like <sample>.
> My Aug 15 total looks 40x too high. Diagnose it.
> Explain what "cache hit rate 94.8%" on my dashboard actually measures.
```

## Design notes

The skill front-loads the **invariants**, not the API surface, because those are what an agent
gets wrong: missing is not zero, cache is not input, a gateway is not a vendor, interface is never
inferred from the model, streaming logs re-report usage, and tokens are not productivity. Each one
is stated with the concrete failure it prevents — including the measured 45x inflation that
motivated the Codex reconstruction — because an agent that knows *why* a rule exists applies it to
cases the rule didn't enumerate.

It also tells the agent to verify rather than assert: run `npm run validate`, cross-check a
suspicious day against an independent source, and write the "re-reading the same bytes emits
nothing new" test for any new adapter.

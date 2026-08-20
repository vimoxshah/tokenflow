# Detection matrix

Where each tool keeps local usage data, and what can be recovered from it. Probe rather than
assume — several of these move between versions, and users relocate them.

## Claude Code / Claude Agent SDK → adapter `anthropic`

| OS | Location |
|---|---|
| macOS / Linux | `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl` |
| alt homes | `$CLAUDE_CONFIG_DIR` (may be `:`-separated), `~/.config/claude`, any `~/.claude-*` containing `projects/` |
| Windows | `%USERPROFILE%\.claude\projects\...` |

Multiple homes are common (one per account: `~/.claude-work`, `~/.claude-personal`). The adapter
auto-discovers any `~/.claude*` with a `projects/` directory; add anything else to
`sources.anthropic.paths`.

**Recoverable:** input, output, cache read, cache write, 1h-ephemeral cache refresh, thinking
tokens, model, session id, request id, `cwd` → project, git branch, `entrypoint` → interface,
CLI version, service tier, sidechain (subagent) flag.

**Not recoverable:** cost.

**Retention:** Claude Code prunes transcripts (commonly ~30 days by default). Data already deleted
cannot be recovered from anywhere.

```bash
ls -d ~/.claude ~/.claude-* ~/.config/claude 2>/dev/null
find ~/.claude*/projects -name '*.jsonl' 2>/dev/null | wc -l
grep -m1 '"usage"' "$(find ~/.claude*/projects -name '*.jsonl' | head -1)" | head -c 600
```

## Codex CLI / IDE / Desktop → adapter `openai`

| OS | Location |
|---|---|
| macOS / Linux | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, plus `~/.codex/archived_sessions/` |
| alt home | `$CODEX_HOME` |

**Recoverable:** fresh input (after subtracting cached), cached input, cache write (newer builds
only), output, reasoning, session/thread/turn ids, `cwd` → project, `source`/`originator` →
interface, `model_provider` → gateway, reasoning effort, service tier, context window,
time-to-first-token, subagent role.

**Not recoverable:** cost.

**Two traps** — see invariants 3 and 4 in `SKILL.md`. `input_tokens` **includes**
`cached_input_tokens`, and `token_count` events re-report a turn's usage as it grows while
`total_token_usage` is a running sum of those re-reports (unusable as a cumulative counter).

```bash
find ~/.codex/sessions -name '*.jsonl' | wc -l
f=$(find ~/.codex/sessions -name '*.jsonl' | tail -1)
grep -c '"token_count"' "$f"; grep -c '"task_started"' "$f"   # ratio >> 1 means re-reporting
```

## Cline CLI → adapter `cline`

`~/.cline/data/sessions/<id>/<id>.json` (+ `<id>.messages.json`).

**Recoverable:** session id, `provider`, `model` (so the vendor is derived — `deepseek/...` →
DeepSeek), start/end, status, exit code, `cwd`, git metadata, team, message counts.

**NOT recoverable: any token count.** All token fields must be `null` and the record
`measurement: activity`.

```bash
ls ~/.cline/data/sessions | wc -l
cat ~/.cline/data/sessions/*/*[!s].json | head -40
```

## Cursor → adapter `cursor`

`~/.cursor/ai-tracking/ai-code-tracking.db` (SQLite; needs `node:sqlite`, i.e. Node ≥ 22.5).

Tables that matter: `ai_code_hashes` (AI-authored code events: model, file, extension,
conversation, `source` ∈ composer/tab/human) and `scored_commits` (per-commit AI vs human line
attribution).

**Recoverable:** AI edit activity, per-commit attribution, model names as Cursor labels them
(`claude-4.5-sonnet`, `composer-1`, and the placeholder `default`/`NULL` → unknown).

**Not recoverable:** token counts — Cursor does not store them locally.

Read from a temp snapshot (with `-wal`/`-shm`) so a live editor is never disturbed.

```bash
ls -la ~/.cursor/ai-tracking/
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare(\"select name from sqlite_master where type='table'\").all())" ~/.cursor/ai-tracking/ai-code-tracking.db
```

## Local gateways / proxies → adapter `headroom` (or a new overlay adapter)

`~/.headroom/savings_events.jsonl`, plus `proxy_savings.json` and a SQLite store.

**Recoverable:** measured `cost_usd` per request, post-compression prompt tokens actually sent,
the compression delta, model, client.

**Not recoverable:** output tokens, cache split.

Always `measurement: overlay` — the proxy is a second view of traffic a client adapter already
recorded. Its unique value is the *measured* cost.

Any router of this shape (LiteLLM, OpenRouter's local proxy, a custom one) fits the same pattern:
one overlay adapter, measured cost, excluded from token totals.

## Git → adapter `git`

Any repository. Needs `git` on `PATH`.

**Recoverable:** commits, files changed, insertions, deletions, author, branch, message.

Repos come from `sources.git.repos`, `sources.git.scanRoots` (depth 3), or `autoFromUsage: true`
(the working directories already seen in ingested usage records — zero config when you code where
you prompt).

## Other tools worth probing

| Tool | Look at | Typically has token counts? |
|---|---|---|
| GitHub Copilot CLI | `~/.copilot/logs/` | no |
| Continue | `~/.continue/dev_data/*.jsonl` | sometimes (`tokensGenerated.jsonl`) |
| opencode / crush / goose | `~/.opencode`, `~/.crush`, `~/.config/goose` | varies by version |
| Aider | `.aider.chat.history.md`, `.aider.llm.history` | partial, text-formatted |
| Zed | `~/.local/share/zed/` | no |
| Ollama | `~/.ollama/logs/server.log` | prompt/eval counts in the log |
| OpenAI / Anthropic consoles | CSV export | yes → use `tokenflow import` |
| LiteLLM | its own DB/logs | yes → an overlay adapter |

For anything with an export, prefer `tokenflow import` over an adapter — a saved mapping is less
code to maintain. Write an adapter when the tool writes a log continuously.

## Quick machine sweep

```bash
for d in .claude .claude-* .codex .cline .cursor .headroom .continue .copilot .opencode .crush .aider .ollama; do
  [ -e "$HOME/$d" ] && printf '%-22s %s\n' "$d" "$(du -sh "$HOME/$d" 2>/dev/null | cut -f1)"
done
```

Size is a useful signal: a directory in the hundreds of MB is almost certainly full of
transcripts worth ingesting.

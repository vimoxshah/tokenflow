# Real log shapes, annotated

The awkward parts of real transcripts, with the trap each one sets. Reading this before writing an
adapter is worth more than reading the schema.

---

## 1. Claude Code — one message written three times

```jsonc
// line 1
{"type":"assistant","requestId":"req_011Ce…","timestamp":"2026-08-18T10:14:45.100Z",
 "sessionId":"ec553ff4…","cwd":"/Users/you/projects/billing","gitBranch":"main",
 "entrypoint":"cli","version":"2.1.234","isSidechain":false,
 "message":{"id":"msg_011Ce…","model":"claude-haiku-4-5-20251001",
   "usage":{"input_tokens":10,"output_tokens":4,
            "cache_creation_input_tokens":38477,"cache_read_input_tokens":21339,
            "cache_creation":{"ephemeral_1h_input_tokens":38477,"ephemeral_5m_input_tokens":0},
            "output_tokens_details":{"thinking_tokens":2}}}}
// line 2 — SAME requestId + message.id, output has grown
{… "usage":{"input_tokens":10,"output_tokens":131,"cache_creation_input_tokens":38477,
            "cache_read_input_tokens":21339, …}}
// line 3 — SAME again, final
{… "usage":{"input_tokens":10,"output_tokens":254,"cache_creation_input_tokens":38477,
            "cache_read_input_tokens":21339,"output_tokens_details":{"thinking_tokens":123}}}
```

**Trap:** summing gives `output = 389`. **Correct:** `output = 254` — the maximum. Prompt-side
counts are constant across the snapshots, which is the tell.

Measured on a real corpus: **2,493 of 5,060** usage rows were re-reports. All duplicates were
within a single file, so a per-file group buffer is enough — no global index required.

**Mapping:**
```
input_tokens                          -> input_tokens        (already fresh-only)
cache_read_input_tokens               -> cache_read_tokens
cache_creation_input_tokens           -> cache_write_tokens
cache_creation.ephemeral_1h_…         -> cache_refresh_tokens  (SUBSET of cache_write)
output_tokens_details.thinking_tokens -> reasoning_tokens      (SUBSET of output)
entrypoint                            -> interface signal
cwd                                   -> project
```

---

## 2. Claude Code — a synthetic entry that is not an API call

```jsonc
{"type":"assistant","requestId":null,"uuid":"6e605aee…","sessionId":"eb4cf63e…",
 "message":{"id":"c0dfe116…",
   "usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,
            "cache_read_input_tokens":0}}}
```

**Trap:** it looks like a request. It isn't — no `requestId` and every count is zero. Counting it
adds fake zero-token requests and drags "tokens per request" down. **Rule:** skip when
`requestId` is null AND every usage field is zero. On the sampled corpus this was ~60% of lines
containing `"usage"`.

---

## 3. Codex — `input_tokens` includes cached tokens

```jsonc
{"timestamp":"2026-08-14T15:32:14.124Z","type":"event_msg","payload":{"type":"token_count",
 "info":{"total_token_usage":{"input_tokens":25243,"cached_input_tokens":4864,
                              "cache_write_input_tokens":0,"output_tokens":140,
                              "reasoning_output_tokens":82,"total_tokens":25383},
         "last_token_usage":{"input_tokens":25243,"cached_input_tokens":4864,
                             "output_tokens":140,"reasoning_output_tokens":82,
                             "total_tokens":25383}}}}
```

**Trap:** copying `input_tokens` straight through counts 4,864 tokens twice — once as fresh input,
once as cache read. **Correct:** `fresh = 25243 − 4864 = 20379`.

Note also `cache_write_input_tokens` is **absent** on older sessions. Absent → `null`, not `0`:
"the CLI didn't report it" and "no cache was written" are different facts.

---

## 4. Codex — the expensive one: re-reported turn usage

One turn (`turn_id: 375dc371`), 1,508 `token_count` events, `last_token_usage.input_tokens`:

```
27531, 29361, 29533, 29900, … 170071, 170257      ← the SAME context, growing
```

and `total_token_usage` climbing to **199,900,281** for that single turn.

```
sum of all last_token_usage           = 201,152,484   ← what a naive adapter reports
max of the monotonic run              =     244,880   ← the turn's actual context
```

Whole-file view: 49,739 `token_count` events for **266** `task_started` turns, and 89,000 events
sharing two wall-clock seconds — this file is a bulk replay, not 49,739 API calls.

**Correct reconstruction:** per turn, split the `last_token_usage` series into monotonically
non-decreasing **runs** (a drop = a context compaction or a new call — this file had 318
`context_compacted` events) and sum each run's maximum.

```
turn with a compaction:  30000, 5000, 9000  ->  30000 + 9000 = 39000   (2 segments)
simple turn:             20000, 24000, 30000 ->  30000                 (1 segment)
single-event turn:       100                 ->  100                   (identity)
```

Effect on one real day: **82.8 B → 1.8 B**, a 45x correction. Validated against an independent
gateway billing log (~2.1 B input lifetime for the same model), which agreed with the corrected
figure and not the naive one.

Every emitted record carries `metadata.token_count_events` and `metadata.usage_segments` so the
reconstruction is auditable.

---

## 5. Codex — a gateway is not a vendor

```jsonc
{"type":"session_meta","payload":{
  "session_id":"019fb754…","id":"01a00510…","cwd":"/Users/you/projects/app",
  "originator":"codex_work_desktop","cli_version":"0.147.0-alpha.6.6",
  "source":{"subagent":{"thread_spawn":{"depth":1,"agent_role":"luna_worker"}}},
  "thread_source":"subagent","model_provider":"headroom"}}
```

```
model_provider: "headroom"  -> gateway: "headroom"     (a local proxy)
model: "gpt-5.6-luna"       -> provider: "openai"      (the vendor, from the MODEL)
originator: codex_work_desktop -> interface: Desktop App
thread_source: "subagent"   -> category: "subagent"
```

**Trap:** recording `provider: "headroom"` invents a vendor that doesn't exist and hides all the
OpenAI usage. Note `source` is sometimes a string (`"cli"`, `"vscode"`, `"exec"`) and sometimes a
nested object — flatten it before using it as an interface signal.

---

## 6. Cline — a source with no token counts at all

```jsonc
{"version":1,"session_id":"1785561978480_iuptv","source":"cli",
 "started_at":"2026-08-01T05:27:23.189Z","ended_at":"2026-08-01T05:27:53.359Z",
 "status":"completed","provider":"cline","model":"deepseek/deepseek-v4-flash",
 "cwd":"/Users/you/projects/pipeline","metadata":{"git":{"branch":"main"}}}
```

**Two traps.** `provider: "cline"` names the **client**, not the vendor — the vendor comes from
`deepseek/deepseek-v4-flash`. And there is **no usage block anywhere**: every token field must be
`null` with `measurement: "activity"`. Emitting zeros would add 22 free sessions to the totals and
pull every average down.

---

## 7. Cursor — activity, not tokens

```sql
CREATE TABLE ai_code_hashes (hash TEXT PRIMARY KEY, source TEXT, fileExtension TEXT,
  fileName TEXT, requestId TEXT, conversationId TEXT, timestamp INTEGER,
  createdAt INTEGER, model TEXT);
CREATE TABLE scored_commits (commitHash TEXT, branchName TEXT, scoredAt INTEGER,
  linesAdded INT, composerLinesAdded INT, humanLinesAdded INT, v2AiPercentage TEXT, …);
```

No token columns exist. This is the **work-output** signal for correlation — the thing token counts
are so often wrongly assumed to prove. `model: "default"` and `NULL` are Cursor's own placeholders
and must be recorded as unknown, not guessed. Most `scored_commits` columns are nullable and often
null: `null` ≠ 0.

---

## 8. A gateway savings log — measured cost, partial tokens

```jsonc
{"v":1,"ts":"2026-08-13T10:05:06.449119+00:00","before":92783,"after":83161,
 "saved":9622,"cost_usd":0.028866,"model":"gpt-5.6-sol","client":"codex","source":"proxy"}
```

```
after     -> input_tokens        (post-compression: what was actually sent)
cost_usd  -> measured_cost       (cost_basis: "measured" — a real bill, not an estimate)
output, cache split              -> null: the savings log has neither
measurement                      -> "overlay": the Codex adapter already counted this traffic
```

**Trap:** treating this as primary usage double counts every routed request. Its unique value is
that `cost_usd` is *measured*, which is what makes the Cost page's estimate checkable.

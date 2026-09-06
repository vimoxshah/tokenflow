# Roadmap — TokenFlow after the pivot

Written 2026-09-05. This is the ambitious version. Everything here keeps the one
promise the product is built on: **your data stays on machines you own.** A folder
you already sync and a server you run on your own network are in. A hosted
service that holds anyone's usage is out, for now, and the line is drawn in
section 9.

The spine is three products on one engine. Every other item exists to show,
capture, or distribute one of them.

| | Receipts | Guard | Ledger |
|---|---|---|---|
| Question it answers | What did this branch / PR cost? | Is the session I am in getting expensive? | What does our team's AI spend buy, per merged PR? |
| Who reads it | the whole team, in the PR | the developer, mid-session | the engineering manager, the FinOps lead |
| State today | CLI `tokenflow receipt`, merge-bounded, worktree-aware | CLI `tokenflow guard`, Claude Code hook, incremental | `tokenflow team` over a shared folder or `tokenflow team serve`; receipts joined per branch, the PR join still needs a cached PR list |

---

## 1. Design system — one source, three surfaces (now)

Done first because every item below renders through it.

- `design/tokens.yaml` is the single source: roles not values, two axes (mode ×
  skin), type scale with size-specific tracking, a 4-pt space scale, radii, two
  motion tiers, status colors, authored chart ramps.
- `scripts/design-build.js` compiles it into the dashboard CSS, the landing CSS
  and the menu bar's Swift constants, and refuses to emit anything that fails
  the gates: ink contrast, series-on-surface contrast, adjacent-series
  perceptual distance, sequential monotonicity, status-vs-series distinctness.
- A test regenerates and diffs, so a hand edit to a generated block fails CI.
- Doctrine lives in `docs/design-system.md`.

## 2. Dashboard — from "a dashboard" to "it told me something" (now → next)

**Now**

- **Story strip.** The Overview opens with the three sentences that matter this
  week, each with its number, generated from `insights.js` — not a grid of
  KPIs you have to interpret.
- **Receipts view.** Per repository, per branch: spend, context share, sessions,
  turns, subagent share, vs-median. Click a branch for the PR-comment receipt
  and a copy button. Works in the offline snapshot because receipts ship in
  the bundle.
- **Polish pass** through the tokens: press feedback on every pressable,
  popovers that scale from their trigger, tooltips that are instant once one is
  open, a short stagger only when a view changes, translucent header, hover
  states gated to pointer devices, reduced-motion that degrades to a complete
  state.

**Next**

- **Session anatomy.** Pick a session and see its turn-by-turn cost waterfall,
  its context growing turn over turn, its subagent fan-out as a tree, and the
  moment its per-turn cost stepped up. This is the flame graph for agent
  spend; nothing else draws it.
- **Live sessions.** Transcripts modified in the last few minutes, each with a
  running cost ticker, a context gauge and the guard's verdict. The dashboard
  becomes something you leave open.
- **Cache health.** Cache-write churn (a system prompt change invalidating the
  cache), 5-minute vs 1-hour write split, hit-rate over time, and the dollar
  cost of each churn event.
- **Model what-if.** Re-price the same tokens at another model's rates and show
  the difference, labelled as a what-if about price, never a claim about
  quality.
- **Compare v2.** Any two windows or any two branches side by side, with the
  diverging ramp doing the work.
- **Rhythm and focus.** Deep-work sessions, project switching per day, the
  hour your marginal cost per turn is highest.
- **Command palette (⌘K)** for every filter, tab and export; no animation on
  keyboard actions.
- **First-run screen.** "Here is what we found on this machine, here is what we
  did not, here is why." Sets expectations before the first chart.
- **Annotations.** Mark a day ("switched to Opus 5", "started using
  subagents") and see it on every time series.

## 3. Menu bar — the glanceable surface (now → next)

**Now**

- Consume the generated Swift tokens; retire the hardcoded gradients (the
  streak banner's saturated fill breaks the system's own rule that a gradient
  sits only behind a single number).

**Next**

- **Live session ticker.** The session running right now: spend, context size,
  guard state. Updates every refresh cycle.
- **Today's receipts.** The three branches that cost most today.
- **Guard state.** Thresholds, last verdict, one click to raise or clear a cap.
- **Transient alert.** When a session crosses a declared cap, a small
  notification-style card slides in from the status item and leaves the same
  way it came. Spatially consistent, interruptible, never modal.
- **Density modes.** Compact for a laptop screen, comfortable for a display.
- **Keyboard shortcut** to open the popover; no open/close animation on it.
- **Sparklines** for the last 24 hours of spend, by source.

## 4. Capture — read more, still read nothing sensitive (next)

New adapters, each ~80 lines plus a fixture, each reading counts and metadata
and discarding content:

- Gemini CLI, GitHub Copilot CLI, Aider, Antigravity, Zed, Windsurf, JetBrains
  AI Assistant, Continue, Ollama (measured local tokens), LM Studio,
  LiteLLM/OpenRouter local logs.
- **Codex branch capture** so Codex work can be attributed to a PR (today its
  records carry no branch).
- Fix the two attribution defects in the adapters: git worktrees counted as
  separate repositories, and `project` set to the working directory's basename.

Hooks and integrations that run on the developer's machine:

- **Receipt on push.** A `pre-push` hook writes the branch receipt to
  `.tokenflow/receipts/<branch>.json` and adds an `AI-Cost:` commit trailer.
- **GitHub Action `tokenflow/receipt-comment`.** Reads that file on
  `pull_request` and posts the markdown block. No server involved.
- **Codex guard.** The same circuit breaker for Codex sessions.
- **Per-repo policy file** `.tokenflow/policy.yaml`, committed with the code,
  so a team's caps travel with the repository.
- **Receipt schema v0**, published, so FinOps tools can ingest receipts.

## 5. Ledger — the buyer's view (next → later)

- Join receipts into the team rollup: cost per merged PR by team, repo and
  month; the concentration curve for the team; orphan (after-merge) spend.
- **Self-hosted team server.** One process on a machine the team owns (LAN,
  Docker), fed by the same per-machine rollups the folder sync uses today.
  Per-developer names remain opt-in per person. Still no cloud.
- **Exports that travel.** A receipt as a PNG card for Slack or a PR; a weekly
  "your AI week" card; CSV of receipts.
- **Budgets per repo and per team**, using the existing budget engine.

## 6. Landing page and story (now)

- Rewrite around the finding, not the features: the cost of every PR, the
  turn-50 step in marginal cost, the guard that acts on it, and the honesty
  caveats that come with each number.
- Self-hosted fonts, no third-party requests, no decorative 3D background.
- The live demo shows a Receipts view with synthetic branches.

## 7. Platform reach (later)

- **Windows and Linux tray apps.** Same status file, same tokens; native per
  platform rather than a web wrapper, to keep the zero-dependency promise.
- **Browser extension** that reads token counts from chat UIs' own responses,
  locally, and writes them into the store. Counts only.
- **Signed macOS build** once there is an Apple Developer account behind the
  project; the Gatekeeper dance is the first thing every new user hits.

## 8. Data quality and trust (continuous)

- Price table refresh flow that shows the diff and its sources before applying.
- Coverage shown on every receipt and every total, as now.
- Hermes and other session-level sources labelled as such in per-turn views.
- A `tokenflow doctor` check for every defect found in the 2026-09 audit.

## 9. The line we do not cross yet

| In | Out, for now |
|---|---|
| Folder sync you already run (iCloud, Dropbox, Syncthing, a git repo) | Any hosted service that stores usage |
| A server you run on your own network | Telemetry of any kind |
| Receipts you choose to push to your own repository | Prompt or code content in any store |
| Exports you choose to share | Default-on names in team views |

---

## Sequencing

| Window | Ships |
|---|---|
| **Now** (this release) | Design system + compiler + gates (shipped) · dashboard polish (shipped) · story strip (shipped) · Receipts view (shipped) · menu bar on tokens (shipped) · landing v2 (shipped) |
| **Next** (weeks 2-6) | Session anatomy (shipped) · live sessions (shipped) · receipt-on-push hook + GitHub Action (shipped) · Codex branch capture (shipped) · attribution defect fixes (shipped) · cache health (shipped) · guard state in menu bar (shipped) |
| **Later** (quarter) | Ledger join + self-hosted team server (shipped) · model what-if (shipped) · new adapters in batches (otel shipped; the rest still need a sample, see docs/providers-otel.md) · Windows/Linux trays (not started) · signed build (not started) |

**Status 2026-09-06:** everything in the Now and Next rows above has shipped, along with the
Ledger, the self-hosted team server, model what-if, and the otel adapter from Later. The six
views named in section 2's Next list (Session anatomy, Cache health, Model what-if, Compare v2,
Rhythm and focus, Annotations) all landed as registered modules, plus Compare branches as a
seventh. Remaining open items: Windows/Linux trays, the browser extension, a signed macOS build,
and adapters for Aider/Ollama/LM Studio/Zed/Windsurf/JetBrains/Continue/Copilot CLI/Antigravity
(each needs a sample before it can be verified).

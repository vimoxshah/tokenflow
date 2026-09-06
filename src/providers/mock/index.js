/**
 * Mock provider — deterministic demo data so a new contributor can run
 * `npm run demo` and see a realistic dashboard without connecting anything.
 *
 * Every record it produces carries `metadata.demo = true` and
 * `machine: "demo-machine"`, and the dashboard shows a persistent DEMO DATA
 * banner whenever any demo record is in scope. It only activates when asked
 * for explicitly (TOKENFLOW_DEMO=1 or `providers: [mock]`), so it can never
 * contaminate a real dataset by accident.
 *
 * ## Shape of the synthetic corpus
 *
 * Real Claude Code usage is bimodal: most sessions are a handful of quick
 * turns, a few run for hours and hold most of the spend. This generator
 * mirrors that on purpose, in four deterministic phases, all drawing from two
 * independent seeded rng streams (see `fetchUsage` for why there are two) so
 * a given seed always reproduces the same corpus:
 *
 *   A. one short "seed" session per (repository, branch) pair, so every
 *      branch exists in the receipts even on an unlucky draw elsewhere;
 *   B. a handful of long, cache-heavy sessions concentrated on ONE branch of
 *      ONE repository (`HOT_REPO`/`HOT_BRANCH`), so that branch's receipt
 *      dwarfs its repo's median — the "one branch is way more expensive
 *      than the rest" pattern a real receipt should be able to show;
 *   C. a calendar backfill across `days` days with weekday/weekend/trend
 *      texture (mostly short sessions, occasionally a long one), for volume
 *      and time-of-day/day-of-week coverage;
 *   D. a few "live" sessions whose last turn lands within minutes of
 *      generation time, one of them expensive enough to trip a guard
 *      warning at a $25 session cap, so the Live view and menu bar have
 *      something current to show.
 *
 * Structural requirements (branch coverage, the outlier branch, "about a
 * quarter of long sessions carry subagent turns", the guard-tripping live
 * session, the one unpriced model) are guaranteed BY CONSTRUCTION rather
 * than left to chance — a probability close to a target still drifts across
 * different calendar dates (weekends/trend consume a different number of rng
 * draws each day), which would make a downstream test flaky. Only the day
 * to day *volume* and calendar texture are left to the rng.
 */
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT, INTERFACE } from '../../core/schema.js';

/** mulberry32 — small, fast, seeded, identical across platforms. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Model catalogue. `cacheHeavy` models (Claude via Claude Code) are the ones
 * that carry the growing-context / churn / subagent story; the rest are
 * short, low-cache interactive calls, as in real mixed-tool usage.
 * `gpt-6-mini-preview` is deliberately absent from `BUILTIN_PRICES`
 * (src/core/pricing.js), so at least one model in the demo has no configured
 * price and the coverage labels have something real to report.
 */
const MODELS = [
  { model: 'claude-opus-4-1-20250805', client: 'claude-code', iface: INTERFACE.CLI, weight: 34, out: 0.06, cacheHeavy: true },
  { model: 'claude-sonnet-4-20250514', client: 'claude-code', iface: INTERFACE.CLI, weight: 26, out: 0.08, cacheHeavy: true },
  { model: 'claude-3-5-haiku-20241022', client: 'claude-desktop', iface: INTERFACE.DESKTOP, weight: 8, out: 0.12, cacheHeavy: false },
  { model: 'gpt-4o', client: 'codex', iface: INTERFACE.IDE, weight: 14, out: 0.10, cacheHeavy: false },
  { model: 'o3', client: 'codex', iface: INTERFACE.CLI, weight: 9, out: 0.18, cacheHeavy: false, reasoning: 0.55 },
  { model: 'deepseek-chat', client: 'cline', iface: INTERFACE.CLI, weight: 6, out: 0.14, cacheHeavy: false },
  { model: 'gemini-2.0-flash', client: 'api-script', iface: INTERFACE.API, weight: 3, out: 0.20, cacheHeavy: false },
  { model: 'gpt-6-mini-preview', client: 'codex', iface: INTERFACE.IDE, weight: 5, out: 0.15, cacheHeavy: false },
];
const CACHE_HEAVY_MODELS = MODELS.filter((m) => m.cacheHeavy);
const UNPRICED_MODEL = 'gpt-6-mini-preview';

/** 5 synthetic repositories: within the 4-6 the demo is asked to cover. */
const REPOS = ['billing-service', 'web-app', 'infra-terraform', 'data-pipeline', 'docs'];
/** Every repo gets `main` plus these PR-like feature branches. */
const FEATURE_BRANCHES = ['feat/receipts-view', 'fix/guard-cache', 'chore/tokens'];
/** The repo/branch that carries a deliberately outsized share of the spend. */
const HOT_REPO = 'billing-service';
const HOT_BRANCH = 'feat/receipts-view';
const HOT_EXTRA_BRANCHES = ['feat/cache-warmup', 'chore/pricing-refresh'];

/** @returns {string[]} the branches that exist on `repo`. */
function branchesFor(repo) {
  return repo === HOT_REPO
    ? ['main', ...FEATURE_BRANCHES, ...HOT_EXTRA_BRANCHES]
    : ['main', ...FEATURE_BRANCHES];
}

/** A working-directory path that is deliberately NOT a git repo, so the
 *  CLI's cwd->repo resolver falls back to the `repository` field. */
function cwdOf(repo) {
  return `/Users/demo/src/${repo}`;
}

/** Weighted pick from a `{weight}`-bearing list. */
function pickWeighted(list, r) {
  const total = list.reduce((a, m) => a + m.weight, 0);
  let v = r() * total;
  for (const m of list) {
    v -= m.weight;
    if (v <= 0) return m;
  }
  return list[list.length - 1];
}

/**
 * Generate the turns of one synthetic session.
 *
 * Context grows turn over turn for cache-heavy models: a real cache write on
 * the first turn (the initial system-prompt cache), then again every
 * `churnInterval` (60-120) turns — a "churn" event, as when the system
 * prompt changes mid-session — a large write following a large read. Some
 * sessions carry `cache_refresh_tokens` as a subset of the write (the
 * long-TTL cache); others never do, matching real deployments where only
 * some conversations opt into a long-TTL cache.
 *
 * Timestamps are anchored either at the session's first turn (`anchor.mode
 * === 'start'`, used for backfilled history) or at its LAST turn (`anchor.mode
 * === 'end'`, used for the "still running" live sessions) — anchoring at the
 * end is what lets a caller pin "last turn N seconds ago" exactly, regardless
 * of how the random per-turn gaps sum up.
 *
 * @param {object} opt
 * @param {() => number} opt.r seeded rng — callers pass the `rGen` stream, so
 *   a session's internal size never perturbs the caller's structural draws
 * @param {string} opt.sid session id
 * @param {string} opt.repo repository (== project)
 * @param {string|null} opt.branch git branch; 'HEAD' or null are valid (unattributed)
 * @param {object} opt.spec one entry from MODELS
 * @param {number} opt.turns requested turn count (may be truncated, see `cutoffMs`)
 * @param {{mode:'start'|'end', ms:number}} opt.anchor where turn 0 (start) or the
 *   last turn (end) lands
 * @param {number} [opt.cutoffMs] for `anchor.mode==='start'` only: never emit a
 *   turn whose timestamp would land at or after this instant — keeps a
 *   backfilled session from spilling into the live window.
 * @param {{start:number, count:number}|null} [opt.subagentBlock] contiguous
 *   turn range to mark `category: 'subagent'`
 * @param {boolean} [opt.refreshEnabled] whether this session's cache writes
 *   carry a `cache_refresh_tokens` subset
 * @param {number} [opt.scale] multiplier on cache read/write growth, for the
 *   deliberately oversized branch/live sessions
 * @returns {object[]} partial usage records, one per turn
 */
function genSession({
  r, sid, repo, branch, spec, turns, anchor, cutoffMs = Infinity,
  subagentBlock = null, refreshEnabled = false, scale = 1,
}) {
  const heavy = !!spec.cacheHeavy;
  const churnInterval = 60 + Math.floor(r() * 61); // 60..120 turns

  // Pass 1: per-turn gaps (20-90s), as offsets relative to the session's
  // first turn — computed before we know the anchor so an "end" anchor can
  // shift the whole session to make its LAST turn land exactly where asked.
  let deltas = [0];
  for (let i = 1; i < turns; i++) deltas.push(deltas[i - 1] + Math.round((20 + r() * 70) * 1000));

  let tsOf;
  if (anchor.mode === 'end') {
    const total = deltas[deltas.length - 1];
    tsOf = (i) => anchor.ms - (total - deltas[i]);
  } else {
    tsOf = (i) => anchor.ms + deltas[i];
    let cut = deltas.length;
    for (let i = 0; i < deltas.length; i++) {
      if (tsOf(i) >= cutoffMs) { cut = i; break; }
    }
    if (cut < deltas.length) { deltas = deltas.slice(0, cut); turns = cut; }
  }
  if (turns <= 0) return [];

  const recs = [];
  const cwd = cwdOf(repo);
  let cacheRead = heavy ? Math.round((3000 + r() * 3000) * scale) : Math.round(150 + r() * 250);

  for (let i = 0; i < turns; i++) {
    const isChurn = heavy && i > 0 && i % churnInterval === 0;
    let cacheWrite = 0;
    if (i === 0) {
      cacheWrite = heavy ? Math.round((4000 + r() * 5000) * scale) : 0;
    } else if (isChurn) {
      // A system-prompt change: a large write, and the read this same turn
      // already reflects the freshly-cached prefix.
      cacheWrite = Math.round((15000 + r() * 20000) * scale);
      cacheRead += Math.round(cacheWrite * (0.4 + r() * 0.3));
    }
    if (heavy && i > 0) cacheRead += Math.round((120 + r() * 260) * scale);

    const cacheRefresh = refreshEnabled && cacheWrite > 0 ? Math.round(cacheWrite * (0.3 + r() * 0.3)) : 0;
    const input = heavy ? Math.round(80 + r() * 220) : Math.round(150 + r() * 350);
    const output = Math.round((input + cacheRead) * spec.out * (0.4 + r() * 0.6));
    const reasoning = spec.reasoning ? Math.round(output * spec.reasoning) : null;
    const inSub = !!subagentBlock && i >= subagentBlock.start && i < subagentBlock.start + subagentBlock.count;

    recs.push({
      id: `mock-${sid}-${i}`,
      timestamp: new Date(tsOf(i)).toISOString(),
      model: spec.model,
      client: spec.client,
      application: spec.client,
      interface: spec.iface,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cache_refresh_tokens: cacheRefresh,
      reasoning_tokens: reasoning,
      session_id: sid,
      conversation_id: sid,
      request_id: `req-${sid}-${i}`,
      project: repo,
      repository: repo,
      git_branch: branch,
      category: inSub ? 'subagent' : 'main',
      machine: 'demo-machine',
      user: 'demo',
      duration_ms: Math.round(600 + output / 30 + r() * 2000),
      metadata: { demo: true, cwd },
    });
  }
  return recs;
}

export default createProvider({
  id: 'mock',
  name: 'Demo data (synthetic)',
  description: 'Deterministic synthetic usage for development and screenshots. Always labelled as demo.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['TOKENFLOW_DEMO=1, or add "mock" to providers in config.yaml'],

  async detect(ctx) {
    const on = process.env.TOKENFLOW_DEMO === '1' || (ctx?.config?.providers || []).includes('mock');
    return on
      ? { available: true, detail: 'SYNTHETIC DEMO DATA — not real usage' }
      : { available: false, detail: 'set TOKENFLOW_DEMO=1 to generate demo data' };
  },

  async fetchUsage(ctx, emit) {
    const days = Math.max(2, Number(ctx?.config?.sources?.mock?.days ?? 160));
    const seed = Number(ctx?.config?.sources?.mock?.seed ?? 20260814);
    // Test-only override so structural assertions can be checked against a
    // pinned calendar; the CLI never sets this, so real usage always gets
    // `new Date()`.
    const nowOverride = ctx?.config?.sources?.mock?.now;
    const nowMs = nowOverride ? new Date(nowOverride).getTime() : Date.now();
    const end = new Date(nowMs);
    end.setUTCHours(0, 0, 0, 0);
    const endMs = end.getTime();
    const cutoffMs = nowMs - 15 * 60000; // backfilled sessions never spill into the live window
    // Two independent streams from the same seed. `r` decides STRUCTURE (which
    // days get a session, how many turns, which repo/branch/model) and always
    // consumes the same small, fixed number of draws per decision. `rGen` is
    // the only thing genSession ever touches, for the per-turn token/timing
    // math — which legitimately takes anywhere from 5 to 600 turns' worth of
    // draws. Sharing one stream between the two would mean a single big
    // session shifts every structural decision after it, so which days end up
    // active would depend on the position that session happened to land at —
    // and since day-level structure depends on the REAL weekday/weekend
    // pattern (via `now`), the whole corpus size would swing wildly depending
    // on what day `tokenflow demo` happens to run.
    const r = rng(seed);
    const rGen = rng((seed ^ 0x9e3779b9) >>> 0);

    let records = 0;
    let longSeq = 0;
    const emitAll = (recs) => { for (const p of recs) { emit(p); records++; } };
    const dayStartMs = (offsetDays) => endMs - offsetDays * 86400000;
    const clampOffset = (want) => Math.min(Math.max(1, days - 1), Math.max(1, want));

    // Roughly 1 in 4 long sessions carries subagent turns, deterministically
    // (the 1st, 5th, 9th, ... long session across the whole run), with a
    // contiguous block whose share is drawn inside [0.35, 0.65] — comfortably
    // inside the [0.3, 0.7] band a downstream check asks for.
    const nextSubagentBlock = (turns) => {
      const idx = longSeq++;
      if (idx % 4 !== 0) return null;
      const share = 0.35 + r() * 0.3;
      const count = Math.max(1, Math.min(turns - 1, Math.round(turns * share)));
      const start = Math.max(1, Math.min(turns - count, Math.floor(turns * (0.1 + r() * 0.2))));
      return { start, count };
    };

    // ---- Phase A: one seed session per (repository, branch) ---------------
    // Guarantees every branch of every repo shows up in the receipts, no
    // matter how the rest of the draw goes.
    let unpricedForced = false;
    for (const repo of REPOS) {
      for (const branch of branchesFor(repo)) {
        const offset = clampOffset(2 + Math.floor(r() * Math.max(1, days - 3)));
        const hour = 9 + Math.floor(r() * 10);
        const startMs = dayStartMs(offset) + hour * 3600000 + Math.floor(r() * 3600000);
        const turns = 5 + Math.floor(35 * r() * r()); // skewed toward the low end, 5-40
        let spec;
        if (!unpricedForced && repo === REPOS[3] && branch === 'chore/tokens') {
          spec = MODELS.find((m) => m.model === UNPRICED_MODEL);
          unpricedForced = true;
        } else {
          spec = pickWeighted(MODELS, r);
        }
        const sid = `demo-seed-${repo}-${branch.replace(/\//g, '-')}`;
        emitAll(genSession({
          r: rGen, sid, repo, branch, spec, turns,
          anchor: { mode: 'start', ms: startMs }, cutoffMs,
          refreshEnabled: r() < 0.5,
        }));
      }
    }

    // ---- Phase B: long, cache-heavy sessions concentrated on one branch ---
    // These, plus the guard-trip live session in Phase D, are what make
    // HOT_BRANCH's receipt dwarf its repo's median branch.
    for (let i = 0; i < 3; i++) {
      const offset = clampOffset(5 + Math.floor(r() * Math.max(1, days - 6)));
      const hour = 9 + Math.floor(r() * 10);
      const startMs = dayStartMs(offset) + hour * 3600000 + Math.floor(r() * 3600000);
      const turns = 200 + Math.floor(400 * r() * r()); // skewed toward the low end, 200-600
      const spec = pickWeighted(CACHE_HEAVY_MODELS, r);
      const subagentBlock = nextSubagentBlock(turns);
      emitAll(genSession({
        r: rGen, sid: `demo-hot-${i}`, repo: HOT_REPO, branch: HOT_BRANCH, spec, turns,
        anchor: { mode: 'start', ms: startMs }, cutoffMs,
        subagentBlock, refreshEnabled: true, scale: 1.2,
      }));
    }

    // ---- Phase C: calendar backfill for volume + weekday/hour texture -----
    // "Roughly 1 in 14 backfilled sessions is long" is structural (every
    // 14th, by a counter), not `r() < 0.07`: a Bernoulli draw over the ~110
    // sessions a run creates has a standard deviation of a few long sessions
    // either way, and each one is worth ~15-20x a short session's records —
    // exactly the kind of small probability swing that would make the total
    // record count drift outside its target band depending on which days a
    // long session happened to land on.
    let backfillSeq = 0;
    for (let dayIdx = days - 1; dayIdx >= 1; dayIdx--) {
      const d = new Date(endMs - dayIdx * 86400000);
      const dow = (d.getUTCDay() + 6) % 7;
      const weekend = dow >= 5;
      // A gentle upward trend plus weekday seasonality plus noise, same
      // shape as the original generator so the calendar still reads right.
      const trend = 0.55 + 0.9 * ((days - dayIdx) / days);
      const dayFactor = (weekend ? 0.3 : 1) * trend * (0.6 + r() * 0.8);
      // Every day draws exactly the same three rolls regardless of which
      // branch they take: an early `continue` would make idle days consume
      // fewer rng draws than active ones, and since weekday/weekend/idle
      // outcomes depend on the REAL calendar date `now` resolves to, that
      // would desync the whole rest of the run's rng position differently
      // on every different day the demo happens to run — a few genuinely
      // idle days is still the goal, it just can't change how many draws
      // the day consumes.
      const idleRoll = r();
      const idle = idleRoll < (weekend ? 0.4 : 0.06);
      let sessionsToday = 0;
      if (!idle) {
        sessionsToday = r() < 0.74 * dayFactor ? 1 : 0;
        if (r() < 0.135 * dayFactor) sessionsToday += 1;
      } else {
        r(); r(); // keep the per-day draw count identical to the active path
      }

      for (let s = 0; s < sessionsToday; s++) {
        // Bimodal working hours: a morning block and an evening block.
        const evening = r() < 0.38;
        const hour = evening ? 19 + Math.floor(r() * 4) : 9 + Math.floor(r() * 5);
        const startMs = dayStartMs(dayIdx) + hour * 3600000 + Math.floor(r() * 3600000);
        const isLong = backfillSeq++ % 14 === 13; // ~1 in 14, deterministically
        const turns = isLong
          ? 200 + Math.floor(400 * r() * r())
          : 5 + Math.floor(35 * r() * r());
        const repo = REPOS[Math.floor(r() * REPOS.length)];
        const list = branchesFor(repo);
        let branch;
        if (isLong) {
          branch = repo === HOT_REPO ? HOT_BRANCH : (r() < 0.6 ? 'main' : list[1 + Math.floor(r() * (list.length - 1))]);
        } else {
          branch = list[Math.floor(r() * list.length)];
        }
        const spec = isLong ? pickWeighted(CACHE_HEAVY_MODELS, r) : pickWeighted(MODELS, r);
        const subagentBlock = isLong ? nextSubagentBlock(turns) : null;
        const sid = `demo-bf-${d.toISOString().slice(0, 10)}-${s}`;
        emitAll(genSession({
          r: rGen, sid, repo, branch, spec, turns,
          anchor: { mode: 'start', ms: startMs }, cutoffMs,
          subagentBlock, refreshEnabled: r() < 0.5,
        }));
      }
    }

    // ---- Special branch identities ----------------------------------------
    // Exactly one detached-HEAD session and one with no branch at all — both
    // land in "(unattributed)" in the receipts, as real detached checkouts do.
    {
      const offset = clampOffset(Math.min(days - 1, 6));
      const startMs = dayStartMs(offset) + 10 * 3600000;
      const spec = pickWeighted(MODELS, r);
      emitAll(genSession({
        r: rGen, sid: 'demo-head-session', repo: 'web-app', branch: 'HEAD', spec,
        turns: 5 + Math.floor(10 * r()), anchor: { mode: 'start', ms: startMs }, cutoffMs,
      }));
    }
    {
      const offset = clampOffset(Math.min(days - 1, 4));
      const startMs = dayStartMs(offset) + 14 * 3600000;
      const spec = pickWeighted(MODELS, r);
      emitAll(genSession({
        r: rGen, sid: 'demo-nobranch-session', repo: 'infra-terraform', branch: null, spec,
        turns: 5 + Math.floor(10 * r()), anchor: { mode: 'start', ms: startMs }, cutoffMs,
      }));
    }

    // ---- Phase D: live sessions, still running -----------------------------
    // Anchored at their LAST turn so it lands within minutes of "now",
    // regardless of how many turns came before it.
    {
      const turns = 8 + Math.floor(6 * r());
      const lastMs = nowMs - Math.round((30 + r() * 300) * 1000); // within ~5.5 min
      emitAll(genSession({
        r: rGen, sid: 'demo-live-short', repo: REPOS[1], branch: 'feat/receipts-view',
        spec: pickWeighted(MODELS, r), turns, anchor: { mode: 'end', ms: lastMs },
      }));
    }
    {
      const turns = 25 + Math.floor(10 * r());
      const lastMs = nowMs - Math.round((30 + r() * 300) * 1000);
      emitAll(genSession({
        r: rGen, sid: 'demo-live-medium', repo: REPOS[2], branch: 'chore/tokens',
        spec: pickWeighted(CACHE_HEAVY_MODELS, r), turns, anchor: { mode: 'end', ms: lastMs },
        refreshEnabled: true,
      }));
    }
    {
      // The guard-trip session: enough turns of a cache-heavy model, growing
      // context, to comfortably clear a $25/session guard cap.
      const turns = 260;
      const lastMs = nowMs - Math.round((30 + r() * 270) * 1000); // within ~5 min
      const spec = MODELS.find((m) => m.model === 'claude-opus-4-1-20250805');
      const subagentBlock = nextSubagentBlock(turns);
      emitAll(genSession({
        r: rGen, sid: 'demo-live-guard', repo: HOT_REPO, branch: HOT_BRANCH, spec, turns,
        anchor: { mode: 'end', ms: lastMs }, subagentBlock, refreshEnabled: true, scale: 1.6,
      }));
    }

    return { records, notes: ['synthetic demo data — clearly labelled in the UI'] };
  },
});

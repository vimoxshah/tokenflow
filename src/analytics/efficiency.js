/**
 * Efficiency + cost.
 *
 * "Efficiency" here means observable ratios, nothing more. A high
 * output/input ratio is not automatically good and a low one is not
 * automatically bad — the UI presents these as measurements with an
 * explanation, not as a score.
 */

export function calculateEfficiency(totals, { sessions = 0, activeDays = 0, requests = null } = {}) {
  const req = requests ?? totals.req;
  const t = totals.total;
  return {
    outputPerInput: totals.in ? totals.out / totals.in : null,
    outputPerPromptToken: (totals.in + totals.cr + totals.cw) ? totals.out / (totals.in + totals.cr + totals.cw) : null,
    cacheRatio: t ? (totals.cr + totals.cw) / t : null,
    cacheHitRate: totals.in + totals.cr ? totals.cr / (totals.in + totals.cr) : null,
    // How many prompt tokens were re-sent fresh for every one served from
    // cache. Above 1 means the cache is mostly missing.
    freshPerCachedPrompt: totals.cr ? totals.in / totals.cr : null,
    tokensPerSession: sessions ? t / sessions : null,
    outputPerSession: sessions ? totals.out / sessions : null,
    requestsPerSession: sessions ? req / sessions : null,
    tokensPerActiveDay: activeDays ? t / activeDays : null,
    tokensPerRequest: req ? t / req : null,
    outputPerRequest: req ? totals.out / req : null,
    reasoningShareOfOutput: totals.out ? totals.rs / totals.out : null,
    refreshShareOfCacheWrite: totals.cw ? totals.cf / totals.cw : null,
  };
}

/**
 * Cost analysis with explicit coverage reporting.
 *
 * `coverage` is the fraction of requests in the slice whose model had a price.
 * Presenting a total cost without it would imply a completeness that isn't
 * there, so the UI always shows them together and lists the unpriced models
 * by volume so the gap is actionable rather than mysterious.
 */
export function calculateCost(totals, { sessions = 0, activeDays = 0, unpriced = [], tiers = [], premiumTiers = [], overlayMeasured = null, overlayRequests = 0 } = {}) {
  const covered = totals.costReq || 0;
  const coverage = totals.req ? covered / totals.req : null;
  const est = covered > 0 ? totals.cost : null;
  // Measured cost comes from two places: a primary record that carried a
  // billed amount, and an overlay source whose tokens are excluded from the
  // totals but whose money is real. They are added together and kept strictly
  // apart from the estimate — one is evidence, the other is arithmetic.
  const measuredIn = totals.costMeasured > 0 ? totals.costMeasured : 0;
  const measuredOverlay = overlayMeasured > 0 ? overlayMeasured : 0;
  const measured = measuredIn + measuredOverlay > 0 ? measuredIn + measuredOverlay : null;
  const premium = tiers.filter((t) => premiumTiers.includes(t.key));
  const premiumTokens = premium.reduce((a, t) => a + t.total, 0);
  return {
    tiers,
    premiumTierShare: totals.total ? premiumTokens / totals.total : null,
    premiumTierTokens: premiumTokens,
    premiumTierNames: premium.map((t) => t.key),
    // Long-context premiums are a known, stated gap rather than a silent one.
    underEstimateNote: 'Long-context premium tiers are not applied (they need a per-request prompt size plus a per-model threshold), so a long-context-heavy workload is under-estimated.',
    estimated: est,
    measured,
    measuredInSlice: measuredIn || null,
    measuredOverlay: measuredOverlay || null,
    measuredNote: measuredOverlay
      ? `Includes $${measuredOverlay.toFixed(2)} billed through a gateway across ${overlayRequests.toLocaleString()} request(s). Those tokens are excluded from the totals above so the client adapter's count is not doubled — the cost is not.`
      : null,
    basisNote: est === null && measured === null
      ? 'No pricing configured for any model in this slice.'
      : coverage !== null && coverage < 0.999
        ? `Estimate covers ${(coverage * 100).toFixed(1)}% of requests; the rest have no configured price.`
        : 'Estimate covers every request in this slice.',
    coverage,
    coveredRequests: covered,
    totalRequests: totals.req,
    perDay: est !== null && activeDays ? est / activeDays : null,
    perSession: est !== null && sessions ? est / sessions : null,
    perMillionTokens: est !== null && totals.total ? est / (totals.total / 1e6) : null,
    perMillionOutput: est !== null && totals.out ? est / (totals.out / 1e6) : null,
    unpriced,
  };
}

/**
 * Models with no configured price, ranked by the tokens they'd account for.
 * This is the list the "Configure pricing" call-to-action shows.
 */
export function unpricedModels(rows, ix, priceLookup) {
  const by = new Map();
  for (const r of rows) {
    if (r[ix.m.costReq] > 0) continue;
    const model = r[ix.d.m];
    const e = by.get(model) || { model, provider: r[ix.d.p], total: 0, requests: 0 };
    e.total += r[ix.m.in] + r[ix.m.out] + r[ix.m.cr] + r[ix.m.cw];
    e.requests += r[ix.m.req];
    by.set(model, e);
  }
  const out = [...by.values()].filter((e) => e.requests > 0 && (!priceLookup || !priceLookup(e.model, e.provider)));
  out.sort((a, b) => b.total - a.total);
  return out;
}

/** Session shape distribution — the "long vs short session" analysis. */
export function calculateSessionProfile(sessions) {
  if (!sessions.length) {
    return { count: 0, buckets: [], medianTokens: null, medianDurationMs: null, p90Tokens: null, longSessions: 0, shortSessions: 0, highOutput: 0 };
  }
  const tokens = sessions.map((s) => s.total || 0).sort((a, b) => a - b);
  const durs = sessions.map((s) => s.durationMs || 0).filter((x) => x > 0).sort((a, b) => a - b);
  const p = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
  const medianTokens = p(tokens, 0.5);
  const p90 = p(tokens, 0.9);
  // Buckets are relative to this dataset's own distribution.
  const edges = [p(tokens, 0.25), medianTokens, p(tokens, 0.75), p90];
  const labels = ['Smallest 25%', '25–50%', '50–75%', '75–90%', 'Top 10%'];
  const counts = new Array(5).fill(0);
  const totals = new Array(5).fill(0);
  for (const s of sessions) {
    const t = s.total || 0;
    let i = 0;
    while (i < edges.length && t > edges[i]) i++;
    counts[i]++;
    totals[i] += t;
  }
  const grand = tokens.reduce((a, b) => a + b, 0);
  return {
    count: sessions.length,
    medianTokens,
    p90Tokens: p90,
    medianDurationMs: durs.length ? durs[Math.floor(durs.length / 2)] : null,
    buckets: labels.map((label, i) => ({
      label, sessions: counts[i], tokens: totals[i], share: grand ? totals[i] / grand : null,
      upperEdge: i < edges.length ? edges[i] : null,
    })),
    longSessions: sessions.filter((s) => (s.durationMs || 0) > 30 * 60000).length,
    shortSessions: sessions.filter((s) => (s.durationMs || 0) > 0 && s.durationMs < 2 * 60000).length,
    highOutput: sessions.filter((s) => medianTokens && (s.out || 0) > 2 * (medianTokens * 0.15)).length,
  };
}

/**
 * P4 Team dashboard — Option B (per-developer rows), built on file sync.
 *
 * PRIVACY CONTRACT (explicit opt-in, per person):
 *   A record carries a `developer` name ONLY if that person set
 *   sync.developerName in their own config. Machines without it stay
 *   anonymous ("machine-a1b2") and are EXCLUDED from per-developer rows —
 *   they only contribute to team totals if includeAnonymous is set.
 *   Nobody can be de-anonymized by another member; the name is chosen
 *   (or withheld) by each developer locally.
 *
 * Aggregation reads the SAME shared sync folder as multi-machine mode:
 * one JSONL per machine of {date, tokens, requests, estCostUsd,
 * machineId, machineName, developer?}. No server, no new backend.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir resolved sync directory
 * @param {{from?: string|null, to?: string|null, includeAnonymous?: boolean}} opt
 * @returns {object|null} team rollup or null when nothing readable
 */
export function aggregate(dir, opt = {}) {
  if (!fs.existsSync(dir)) return null;

  const from = opt.from || null;
  const to = opt.to || null;
  const includeAnonymous = !!opt.includeAnonymous;

  // Per-developer and per-machine accumulators.
  const devs = new Map();      // developer → totals + daily map
  const machines = new Map();  // machineName/id → totals (for the roster)
  const anon = { tokens: 0, requests: 0, cost: 0 };  // records w/o developer
  let days = new Map();        // date → {tokens, requests, cost} for trend

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }   // tolerate partial syncs
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;

      const tokens = (r.inputTokens || 0) + (r.outputTokens || 0);
      const req = r.requests || 0;
      const cost = r.estCostUsd || 0;
      const mKey = r.machineName || r.machineId || f.replace(/\.jsonl$/, '');
      const dev = typeof r.developer === 'string' && r.developer.trim()
        ? r.developer.trim() : null;

      let m = machines.get(mKey);
      if (!m) { m = { machine: mKey, developer: dev, tokens: 0, requests: 0, cost: 0, days: new Set() }; machines.set(mKey, m); }
      m.tokens += tokens; m.requests += req; m.cost += cost; m.days.add(r.date);

      if (dev) {
        let d = devs.get(dev);
        if (!d) { d = { developer: dev, tokens: 0, requests: 0, cost: 0, days: new Map(), machines: new Set() }; devs.set(dev, d); }
        d.tokens += tokens; d.requests += req; d.cost += cost;
        d.machines.add(mKey);
        const dayTot = d.days.get(r.date) || { tokens: 0 };
        dayTot.tokens += tokens; d.days.set(r.date, dayTot);
      } else {
        anon.tokens += tokens; anon.requests += req; anon.cost += cost;
      }

      const t = days.get(r.date) || { tokens: 0, requests: 0, cost: 0 };
      t.tokens += tokens; t.requests += req; t.cost += cost;
      days.set(r.date, t);
    }
  }

  if (!machines.size) return null;

  const developers = [...devs.values()]
    .map((d) => ({
      developer: d.developer,
      requests: d.requests,
      tokens: d.tokens,
      estCostUsd: Math.round(d.cost * 100) / 100,
      activeDays: d.days.size,
      avgTokensPerDay: d.days.size ? Math.round(d.tokens / d.days.size) : null,
      machines: [...d.machines],
    }))
    .sort((a, b) => b.estCostUsd - a.estCostUsd || b.tokens - a.tokens);

  const maxCost = developers[0]?.estCostUsd || 0;
  const totalTokens = [...days.values()].reduce((s, d) => s + d.tokens, 0);
  const totalRequests = [...days.values()].reduce((s, d) => s + d.requests, 0);
  const totalCost = [...days.values()].reduce((s, d) => s + d.cost, 0);

  return {
    window: { from, to },
    totals: {
      requests: totalRequests,
      tokens: totalTokens,
      estCostUsd: Math.round(totalCost * 100) / 100,
      activeMachines: machines.size,
      namedDevelopers: developers.length,
      anonymousTokens: anon.tokens,
    },
    // Per-developer share bars are rendered from these percentages.
    shares: developers.map((d) => ({
      ...d,
      pctOfCost: totalCost > 0 ? Math.round((d.estCostUsd / totalCost) * 1000) / 10 : null,
      bar: maxCost > 0 ? Math.max(1, Math.round((d.estCostUsd / maxCost) * 24)) : 1,
    })),
    roster: [...machines.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((m) => ({ ...m, estCostUsd: Math.round(m.cost * 100) / 100 })),
    anonymous: includeAnonymous || !developers.length ? { ...anon } : undefined,
    trendDays: [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-28)
      .map(([date, v]) => ({ date, ...v })),
  };
}

/** Plain-text rendering for the CLI. */
export function renderText(t) {
  if (!t) return 'No team data found in the sync folder.';
  const L = [];
  const win = t.window.from || t.window.to
    ? `${t.window.from || '…'} → ${t.window.to || '…'}`
    : 'all time';
  L.push(`Team AI usage — ${win}`);
  L.push('');
  L.push(`  Total requests     ${t.totals.requests.toLocaleString('en-US')}`);
  L.push(`  Total tokens       ${fmt(t.totals.tokens)}`);
  L.push(`  Estimated cost     $${t.totals.estCostUsd.toFixed(2)}   (estimated from local price table)`);
  L.push(`  Active machines    ${t.totals.activeMachines}   named developers: ${t.totals.namedDevelopers}`);
  L.push('');
  L.push('Per developer');
  if (!t.shares.length) {
    L.push('  (no records carry a developer name — nobody has set sync.developerName)');
  }
  for (const d of t.shares) {
    const bar = '█'.repeat(d.bar);
    const pct = d.pctOfCost != null ? ` ${d.pctOfCost}%` : '';
    L.push(`  ${d.developer.padEnd(14).slice(0, 14)} ${bar.padEnd(25)} ${fmt(d.tokens).padStart(8)} tok  $${d.estCostUsd.toFixed(2).padStart(9)}${pct}`);
  }
  if (t.anonymous && (t.anonymous.tokens > 0)) {
    L.push(`  ${'(anonymous)'.padEnd(14)} ${fmt(t.anonymous.tokens).padStart(8)} tok  excluded from per-dev rows`);
  }
  if (!t.shares.length && !(t.anonymous && t.anonymous.tokens > 0)) L.push('  (empty window)');
  L.push('');
  L.push('Roster (per machine)');
  for (const m of t.roster) {
    L.push(`  ${String(m.machine).padEnd(16).slice(0, 16)} ${String(m.developer || '—').padEnd(12).slice(0, 12)} ${fmt(m.tokens).padStart(8)} tok  $${m.estCostUsd.toFixed(2).padStart(9)}  ${m.days.size}d`);
  }
  L.push('');
  L.push('Names appear here only for developers who chose to publish theirs (sync.developerName).');
  return L.join('\n');
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

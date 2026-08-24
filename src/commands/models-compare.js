/**
 * `tokenflow models-compare` — "which model is actually costing me what?"
 *
 * Uses ONLY the user's own measured data from the same cube as every other
 * surface. Metrics are factual arithmetic over the window; the only judgement
 * offered is cost-efficiency per request/token, clearly derived, never a
 * claim about model quality. No useful-output signal exists in local logs,
 * so "cost per useful output" is explicitly reported as unavailable rather
 * than fabricated.
 */
import { buildBundle } from '../core/bundle.js';
import { filterCube, indexCube, finalize, sumRows } from '../analytics/aggregate.js';
import { compact, usd } from '../core/units.js';

/**
 * @param {{from?:string, to?:string}} opt
 */
export function compare({ from, to } = {}) {
  const b = buildBundle();
  const ix = indexCube(b.cube);
  const toD = to || b.meta.today;
  const fromD = from || addDays(toD, -29);

  const rows = filterCube(ix, { from: fromD, to: toD, includeOverlay: false })
    .filter((r) => r[ix.d.m] !== 'unknown');
  if (!rows.length) return null;

  const byModel = new Map();
  for (const r of rows) {
    const k = r[ix.d.m];
    let m = byModel.get(k);
    if (!m) {
      m = { key: k, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, pricedReq: 0 };
      byModel.set(k, m);
    }
    m.requests += r[ix.m.req];
    m.input += r[ix.m.in];
    m.output += r[ix.m.out];
    m.cacheRead += r[ix.m.cr];
    m.cacheWrite += r[ix.m.cw];
    m.cost += r[ix.m.cost] || 0;
    if (r[ix.m.costReq] > 0) m.pricedReq += r[ix.m.costReq];
  }

  return {
    from: fromD, to: toD,
    models: [...byModel.values()]
      .filter((m) => m.requests > 0)
      .sort((a, b) => b.cost - a.cost)
      .map((m) => {
        const tokens = m.input + m.output + m.cacheRead + m.cacheWrite;
        return {
          ...m,
          tokens,
          cacheHitPct: (m.cacheRead + m.cacheWrite) > 0
            ? Math.round((m.cacheRead / (m.cacheRead + m.input + m.cacheWrite)) * 1000) / 10
            : null,
          avgCostPerRequest: m.pricedReq > 0 ? m.cost / m.pricedReq : null,
          avgTokensPerRequest: m.requests > 0 ? Math.round(tokens / m.requests) : null,
        };
      }),
  };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Render the comparison as aligned plain text. */
export function renderText(cmp) {
  if (!cmp) return 'No model usage in this window.';
  const L = [];
  L.push(`Model comparison — ${cmp.from} → ${cmp.to}`);
  L.push('');
  L.push('Model                          Requests   Tokens      Cost        $/req     tok/req   cache-hit');
  L.push('-'.repeat(100));
  for (const m of cmp.models.slice(0, 15)) {
    const perReq = m.avgCostPerRequest != null ? usd(m.avgCostPerRequest) : 'n/a';
    const cache = m.cacheHitPct != null ? `${m.cacheHitPct}%` : 'n/a';
    L.push(
      m.key.padEnd(30).slice(0, 30)
      + String(m.requests.toLocaleString('en-US')).padStart(9)
      + compact(m.tokens).padStart(10)
      + (m.cost > 0 ? usd(m.cost).padStart(12) : 'n/a'.padStart(12))
      + perReq.padStart(11)
      + String(m.avgTokensPerRequest ?? 'n/a').padStart(10)
      + cache.padStart(10),
    );
  }
  L.push('');
  L.push('Costs are estimates from the versioned price table where rates exist; "n/a" means unpriced — never $0.');
  L.push('"cost per useful output" is not computable from local logs and is deliberately not shown.');
  return L.join('\n');
}

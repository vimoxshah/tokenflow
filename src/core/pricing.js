/**
 * Cost estimation.
 *
 * ## Hard rules
 *
 * 1. **Never invent a price.** A model with no entry and no user override
 *    produces `estimated_cost: null` and is listed in the "pricing not
 *    configured" report, ranked by token volume. A `$0` is only ever a real
 *    measured zero.
 * 2. **Every rate has a source.** Each entry names the `PRICING_SOURCES` key it
 *    came from, so `tokenflow pricing --sources` can show where a number came
 *    from and when it was fetched. Third-party sources are marked as such.
 * 3. **Estimated is labelled estimated.** A cost that a source actually billed
 *    (a gateway's own `cost_usd`) is `measured` and kept in its own column.
 *
 * ## Service tiers matter more than people expect
 *
 * OpenAI's Fast mode (renamed from "priority" on 2026-07-30) bills at **4x**
 * the standard rate. Anthropic's Batch API bills at 0.5x. Both adapters record
 * `metadata.service_tier`, so the estimate applies the right multiplier per
 * request instead of quietly assuming everything was standard-rate.
 *
 * ## Known limitation: long-context tiers
 *
 * Several vendors charge a premium above a context threshold (Anthropic above
 * 200K, OpenAI's "long context" rows). Applying that needs a per-request prompt
 * size AND a per-model threshold and premium, which are not uniformly
 * published. This table uses the short-context rate, so a long-context-heavy
 * workload is UNDER-estimated. The UI says so rather than pretending
 * otherwise.
 *
 * Rates are USD per 1,000,000 tokens.
 */

export const PRICING_TABLE_VERSION = '2026-08-20';

/** Where each group of rates came from. Surfaced by `tokenflow pricing --sources`. */
export const PRICING_SOURCES = {
  anthropic: {
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetched: '2026-08-20',
    confidence: 'official',
  },
  openai: {
    url: 'https://developers.openai.com/api/docs/pricing',
    fetched: '2026-08-20',
    confidence: 'official',
  },
  'openai-thirdparty': {
    url: 'https://openrouter.ai/openai/gpt-5.5',
    fetched: '2026-08-20',
    confidence: 'third-party',
    note: 'gpt-5.5 is no longer on OpenAI\'s own pricing page; this mirrors its baseline rate.',
  },
  deepseek: {
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    fetched: '2026-08-20',
    confidence: 'official',
    note: 'DeepSeek charges peak (01:00-04:00 and 06:00-10:00 UTC) at 2x off-peak. These are OFF-PEAK rates, so a peak-heavy workload is under-estimated.',
  },
  zai: {
    url: 'https://docs.z.ai/guides/overview/pricing',
    fetched: '2026-08-20',
    confidence: 'official',
  },
  google: {
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    fetched: '2026-08-20',
    confidence: 'official',
    note: 'Flash/Pro rates vary above a 200K prompt; the short-context rate is used.',
  },
  legacy: {
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetched: '2026-08-20',
    confidence: 'official-historical',
    note: 'Retired models, kept so historical records still cost out.',
  },
};

/**
 * Published list prices. First regex match wins, so specific patterns come
 * before general ones.
 *
 * `cacheWrite` is the short-TTL (5-minute) write rate; `cacheRefresh` is the
 * long-TTL (1-hour) rate applied to the `cache_refresh_tokens` subset.
 *
 * @type {{match:string,in:number,out:number,cacheRead?:number,cacheWrite?:number,cacheRefresh?:number,src:string}[]}
 */
export const BUILTIN_PRICES = [
  // ---- Anthropic — platform.claude.com, fetched 2026-08-20 ----------------
  { match: 'claude-(fable|mythos)-5', in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5, cacheRefresh: 20, src: 'anthropic' },
  { match: 'claude-opus-4-(1|0)|claude-4-1-opus|claude-4-opus', in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheRefresh: 30, src: 'legacy' },
  { match: 'claude-opus-(5|4-8|4-7|4-6|4-5)', in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheRefresh: 10, src: 'anthropic' },
  { match: 'claude-sonnet-5', in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheRefresh: 4, src: 'anthropic' },
  { match: 'claude-sonnet-4-(6|5)|claude-sonnet-4($|-2)', in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheRefresh: 6, src: 'anthropic' },
  { match: 'claude-haiku-4-5|claude-4-5-haiku', in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheRefresh: 2, src: 'anthropic' },
  { match: 'claude-(3-5-haiku|haiku-3-5)', in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1, cacheRefresh: 1.6, src: 'legacy' },
  // Older generations, so records predating the current line-up still cost out.
  { match: 'claude-3-opus', in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheRefresh: 30, src: 'legacy' },
  { match: 'claude-3-haiku', in: 0.25, out: 1.25, cacheRead: 0.03, cacheWrite: 0.3, cacheRefresh: 0.5, src: 'legacy' },
  { match: 'claude-3-(5|7)-sonnet', in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheRefresh: 6, src: 'legacy' },

  // ---- OpenAI — developers.openai.com, fetched 2026-08-20 -----------------
  // Cache writes are not billed separately; cached input is the read rate.
  { match: '^gpt-5\\.6-sol', in: 2.5, out: 15, cacheRead: 0.25, cacheWrite: 0, cacheRefresh: 0, src: 'openai' },
  { match: '^gpt-5\\.6-terra', in: 1, out: 6, cacheRead: 0.1, cacheWrite: 0, cacheRefresh: 0, src: 'openai' },
  { match: '^gpt-5\\.6-luna', in: 0.1, out: 0.6, cacheRead: 0.01, cacheWrite: 0, cacheRefresh: 0, src: 'openai' },
  { match: '^gpt-5\\.3-codex|^gpt-5-codex', in: 1.75, out: 14, cacheRead: 0.175, cacheWrite: 0, cacheRefresh: 0, src: 'openai' },
  { match: '^chat-latest', in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0, cacheRefresh: 0, src: 'openai' },
  { match: '^gpt-5\\.5', in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0, cacheRefresh: 0, src: 'openai-thirdparty' },
  // Older OpenAI generations.
  { match: '^gpt-4o-mini', in: 0.15, out: 0.6, cacheRead: 0.075, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-4o', in: 2.5, out: 10, cacheRead: 1.25, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-4\\.1-nano', in: 0.1, out: 0.4, cacheRead: 0.025, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-4\\.1-mini', in: 0.4, out: 1.6, cacheRead: 0.1, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-4\\.1', in: 2, out: 8, cacheRead: 0.5, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-5-nano', in: 0.05, out: 0.4, cacheRead: 0.005, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-5-mini', in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^gpt-5($|[^.\\d])', in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^o4-mini', in: 1.1, out: 4.4, cacheRead: 0.275, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^o3-mini', in: 1.1, out: 4.4, cacheRead: 0.55, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: '^o3', in: 2, out: 8, cacheRead: 0.5, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },

  // ---- DeepSeek — api-docs.deepseek.com, fetched 2026-08-20 (OFF-PEAK) ----
  { match: 'deepseek-v4-flash', in: 0.22, out: 0.66, cacheRead: 0.007, cacheWrite: 0, cacheRefresh: 0, src: 'deepseek' },
  { match: 'deepseek-v4-pro|deepseek-v4($|[^-])', in: 0.66, out: 1.98, cacheRead: 0.022, cacheWrite: 0, cacheRefresh: 0, src: 'deepseek' },
  { match: 'deepseek-(chat|v3)', in: 0.27, out: 1.1, cacheRead: 0.07, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: 'deepseek-(reasoner|r1)', in: 0.55, out: 2.19, cacheRead: 0.14, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },

  // ---- Z.ai / GLM — docs.z.ai, fetched 2026-08-20 -------------------------
  { match: '^glm-5\\.(3|2|1)', in: 1.4, out: 4.4, cacheRead: 0.26, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-5-turbo', in: 1.2, out: 4, cacheRead: 0.24, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-5($|[^.\\d-])', in: 1, out: 3.2, cacheRead: 0.2, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.7-flashx', in: 0.07, out: 0.4, cacheRead: 0.01, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.(7|6|5)-flash', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.5-airx', in: 1.1, out: 4.5, cacheRead: 0.22, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.5-air', in: 0.2, out: 1.1, cacheRead: 0.03, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.5-x', in: 2.2, out: 8.9, cacheRead: 0.45, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },
  { match: '^glm-4\\.(7|6|5)', in: 0.6, out: 2.2, cacheRead: 0.11, cacheWrite: 0, cacheRefresh: 0, src: 'zai' },

  // ---- Google — ai.google.dev, fetched 2026-08-20 (short context) ---------
  { match: 'gemini-3\\.(7|6)-flash', in: 0.75, out: 3.75, cacheRead: 0.075, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-3\\.5-flash-lite', in: 0.3, out: 2.5, cacheRead: 0.03, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-3\\.5-flash', in: 1.5, out: 9, cacheRead: 0.15, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-3\\.1-flash-lite', in: 0.25, out: 1.5, cacheRead: 0.025, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-2\\.5-pro', in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-2\\.5-flash-lite', in: 0.1, out: 0.4, cacheRead: 0.01, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-2\\.5-flash', in: 0.3, out: 2.5, cacheRead: 0.03, cacheWrite: 0, cacheRefresh: 0, src: 'google' },
  { match: 'gemini-2\\.0-flash-lite', in: 0.075, out: 0.3, cacheRead: 0.01875, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: 'gemini-2\\.0-flash', in: 0.1, out: 0.4, cacheRead: 0.025, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: 'gemini-1\\.5-flash', in: 0.075, out: 0.3, cacheRead: 0.01875, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
  { match: 'gemini-1\\.5-pro', in: 1.25, out: 5, cacheRead: 0.3125, cacheWrite: 0, cacheRefresh: 0, src: 'legacy' },
];

/**
 * Service-tier multipliers, applied to every rate for a request.
 *
 * OpenAI: Fast mode (renamed from "priority" on 2026-07-30) is 4x standard;
 *         Batch and Flex are billed at standard rates.
 * Anthropic: the Batch API is 0.5x.
 *
 * An unrecognised tier is treated as 1x — the standard rate — rather than
 * guessed at.
 */
export const TIER_MULTIPLIERS = {
  openai: { priority: 4, fast: 4, standard: 1, default: 1, auto: 1, batch: 1, flex: 1, scale: 1 },
  anthropic: { batch: 0.5, standard: 1, default: 1, auto: 1, priority: 1 },
  _default: { batch: 0.5, standard: 1, default: 1, auto: 1 },
};

/**
 * @param {string|null} tier value of `metadata.service_tier`
 * @param {string} provider
 * @returns {{mult:number, known:boolean, tier:string|null}}
 */
export function tierMultiplier(tier, provider) {
  if (!tier) return { mult: 1, known: false, tier: null };
  const t = String(tier).toLowerCase();
  const table = TIER_MULTIPLIERS[provider] || TIER_MULTIPLIERS._default;
  if (Object.prototype.hasOwnProperty.call(table, t)) return { mult: table[t], known: true, tier: t };
  return { mult: 1, known: false, tier: t };
}

/**
 * Family fallback multipliers, used ONLY to derive a cache rate when an entry
 * has an input/output price but no explicit cache rate. Never used to invent an
 * input or output price. An absent multiplier is unknown, which is null.
 */
const CACHE_MULTIPLIERS = {
  anthropic: { read: 0.1, write: 1.25, refresh: 2.0 },
  openai: { read: 0.1, write: 0, refresh: 0 },
  deepseek: { read: 0.26, write: 0, refresh: 0 },
  google: { read: 0.25, write: 0, refresh: 0 },
  zai: { read: 0.2, write: 0, refresh: 0 },
  _default: { read: null, write: null, refresh: null },
};

function mult(v, base) {
  if (v === null || v === undefined) return null;
  return base * v;
}

export function buildPriceBook(userPricing = {}) {
  const user = Object.entries(userPricing.models || {}).map(([match, v]) => ({
    match: v.match || `^${escapeRe(match)}$`,
    key: match,
    in: num(v.in ?? v.input),
    out: num(v.out ?? v.output),
    cacheRead: num(v.cacheRead ?? v.cache_read),
    cacheWrite: num(v.cacheWrite ?? v.cache_write),
    cacheRefresh: num(v.cacheRefresh ?? v.cache_refresh),
    src: 'user',
    origin: 'user',
  }));
  const builtin = BUILTIN_PRICES.map((p) => ({ ...p, origin: 'builtin' }));
  const all = [...user, ...builtin].map((p) => ({ ...p, re: new RegExp(p.match, 'i') }));
  return {
    version: PRICING_TABLE_VERSION,
    sources: PRICING_SOURCES,
    entries: all,
    lookup(model, provider) {
      if (!model) return null;
      for (const e of all) {
        if (!e.re.test(model)) continue;
        if (e.in === null || e.out === null || e.in === undefined || e.out === undefined) continue;
        const m = CACHE_MULTIPLIERS[provider] || CACHE_MULTIPLIERS._default;
        return {
          in: e.in,
          out: e.out,
          cacheRead: e.cacheRead ?? mult(m.read, e.in),
          cacheWrite: e.cacheWrite ?? mult(m.write, e.in),
          cacheRefresh: e.cacheRefresh ?? mult(m.refresh, e.in),
          origin: e.origin,
          src: e.src,
          match: e.match,
        };
      }
      return null;
    },
  };
}

/**
 * @param {object} tok token fields
 * @param {string} model
 * @param {string} provider
 * @param {ReturnType<typeof buildPriceBook>} book
 * @param {{tier?:string|null}} [opt]
 * @returns {{cost:number|null, basis:'estimated'|null, partial:boolean, tier:string|null, tierMult:number, src:string|null}}
 */
export function estimateCost(tok, model, provider, book, opt = {}) {
  const p = book.lookup(model, provider);
  if (!p) return { cost: null, basis: null, partial: false, tier: null, tierMult: 1, src: null };

  const { mult: tm, tier } = tierMultiplier(opt.tier ?? null, provider);
  let cost = 0;
  let partial = false;
  const add = (tokens, rate) => {
    if (tokens === null || tokens === undefined) return;
    if (rate === null || rate === undefined || !Number.isFinite(rate)) {
      if (tokens > 0) partial = true;
      return;
    }
    cost += (tokens / 1e6) * rate * tm;
  };
  add(tok.input_tokens, p.in);
  add(tok.output_tokens, p.out);
  add(tok.cache_read_tokens, p.cacheRead);
  // Cache writes split into the long-TTL (refresh) subset and the rest, because
  // the two are billed at different rates.
  const refresh = tok.cache_refresh_tokens ?? null;
  const write = tok.cache_write_tokens ?? null;
  if (refresh !== null && write !== null && p.cacheRefresh !== null) {
    add(Math.max(0, write - refresh), p.cacheWrite);
    add(refresh, p.cacheRefresh);
  } else {
    add(write, p.cacheWrite);
  }
  if (!Number.isFinite(cost)) return { cost: null, basis: null, partial: true, tier, tierMult: tm, src: p.src };
  return { cost, basis: 'estimated', partial, tier, tierMult: tm, src: p.src ?? null };
}

function num(v) {
  return v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

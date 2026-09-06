/**
 * What-if repricing: take the tokens a model already used and price them
 * again at another model's published rates.
 *
 * This says nothing about quality, latency or output length. It only prices.
 * It answers "what would this same traffic have cost at model B's rates
 * instead of model A's", nothing more.
 *
 * ## Method
 *
 * Both the "current" and "what-if" figures are recomputed here from the raw
 * token counts times `book.lookup(...)`, never read off the row's own
 * `cost` field. That is deliberate: the per-model aggregate the Cost view
 * shows (`view.dimensions.models[*].cost`) already applied each request's
 * service-tier multiplier (Anthropic Batch, OpenAI Fast/priority, ...), but
 * an aggregated model row only carries token totals, not a per-tier
 * breakdown, so there is nothing left here to multiply. Recomputing "current"
 * through the exact same code path as "what-if" is what makes an identity
 * mapping (source === target) provably yield a zero delta, and it is also
 * why a heavily-tiered slice will show a "current" here that sits a little
 * off the Cost tab's tier-aware number for the same model. That is a known,
 * reported simplification, not a bug.
 *
 * ## Missing rates
 *
 * `book.lookup(model, provider)` returns `null` when the model has no price
 * at all: both "current" and "what-if" are `null` (n/a) for that model, and
 * it is excluded from every overall total (current, what-if AND delta).
 * Folding an unknown number into a sum by pretending it is zero would just
 * be a wrong number wearing a confident face. When the model *does* have a
 * price but one token kind on it does not (a partial user override, for
 * example), that one kind reports `null` and the model's total is flagged
 * `partial`; the kinds that ARE known still sum into the total.
 */

/** Token kinds priced individually. Reasoning tokens are a subset of output
 * tokens (see core/schema.js) and the shipped price table has no separate
 * reasoning rate, so there is no fifth kind to compute today. A future rate
 * that names one would show up as `rate.reasoning`, which nothing here reads
 * yet, by design: inventing a reasoning charge the table does not publish
 * would be exactly the kind of invented price this module exists to avoid. */
const KIND_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/**
 * Price one model's cache-write tokens, splitting the long-TTL (refresh)
 * subset from the short-TTL rest exactly as `core/pricing.js`'s
 * `estimateCost` does, but folded into the single "cache write" kind the
 * spec lists (no separate "cache refresh" row).
 * @param {{cacheWrite:number, cacheRefresh:number}} tok
 * @param {{cacheWrite:number|null|undefined, cacheRefresh:number|null|undefined}} rate
 * @returns {{value:number|null, partial:boolean}}
 */
function priceCacheWrite(tok, rate) {
  const refresh = tok.cacheRefresh || 0;
  const write = tok.cacheWrite || 0;
  const shortWrite = Math.max(0, write - refresh);
  const haveRefreshRate = rate.cacheRefresh !== null && rate.cacheRefresh !== undefined;
  const haveWriteRate = rate.cacheWrite !== null && rate.cacheWrite !== undefined;
  if (haveRefreshRate && haveWriteRate) {
    return { value: (shortWrite / 1e6) * rate.cacheWrite + (refresh / 1e6) * rate.cacheRefresh, partial: false };
  }
  if (haveWriteRate) {
    // No distinct refresh rate published: bill the whole write total,
    // refresh subset included, at the plain write rate. This is the same
    // fallback core/pricing.js's estimateCost takes.
    return { value: (write / 1e6) * rate.cacheWrite, partial: false };
  }
  return { value: write > 0 ? null : 0, partial: write > 0 };
}

/**
 * Price one model's token counts against one resolved rate entry.
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number, cacheRefresh:number}} tok
 * @param {{in:number, out:number, cacheRead:number|null, cacheWrite:number|null, cacheRefresh:number|null}|null} rate
 * @returns {{byKind:Record<string, number|null>, total:number|null, partial:boolean}}
 */
function priceTokens(tok, rate) {
  if (!rate) {
    const na = Object.fromEntries(KIND_KEYS.map((k) => [k, null]));
    return { byKind: na, total: null, partial: false };
  }
  /** @type {Record<string, number|null>} */
  const byKind = {};
  let total = 0;
  let partial = false;
  const simple = (key, tokens, r) => {
    const t = tokens || 0;
    if (r === null || r === undefined || !Number.isFinite(r)) {
      byKind[key] = t > 0 ? null : 0;
      if (t > 0) partial = true;
      return;
    }
    const cost = (t / 1e6) * r;
    byKind[key] = cost;
    total += cost;
  };
  simple('input', tok.input, rate.in);
  simple('output', tok.output, rate.out);
  simple('cacheRead', tok.cacheRead, rate.cacheRead);
  const cw = priceCacheWrite(tok, rate);
  byKind.cacheWrite = cw.value;
  if (cw.value !== null) total += cw.value;
  if (cw.partial) partial = true;
  return { byKind, total, partial };
}

/**
 * Reprice a set of per-model aggregate rows at another model's rates.
 *
 * @param {{
 *   rows: {key:string, provider:string, total:number, requests:number,
 *          input:number, output:number, cacheRead:number, cacheWrite:number,
 *          cacheRefresh:number}[],
 *   book: {lookup:(model:string, provider:string)=>({in:number,out:number,
 *          cacheRead:number|null,cacheWrite:number|null,cacheRefresh:number|null}|null)},
 *   mapping?: Record<string,string>,
 * }} args `rows` is the per-model aggregate the Cost view already computes
 *   (`view.dimensions.models`, or any subset of it for the current filters).
 *   `mapping` is `{ fromModel: toModel }`; a model absent from `mapping`
 *   reprices against itself (identity, zero delta).
 * @returns {{
 *   models: {model:string, provider:string, target:string, tokens:number,
 *     requests:number, current:number|null, currentByKind:Record<string,number|null>,
 *     whatif:number|null, whatifByKind:Record<string,number|null>,
 *     delta:number|null, partial:boolean}[],
 *   overall: {current:number|null, whatif:number|null, delta:number|null,
 *     excluded:number, partial:boolean},
 * }}
 */
export function reprice({ rows, book, mapping = {} }) {
  const models = (rows || []).map((row) => {
    const target = mapping[row.key] ?? row.key;
    const tok = {
      input: row.input, output: row.output,
      cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, cacheRefresh: row.cacheRefresh,
    };
    const fromRate = book.lookup(row.key, row.provider);
    const toRate = book.lookup(target, row.provider);
    const cur = priceTokens(tok, fromRate);
    const wi = priceTokens(tok, toRate);
    const delta = cur.total !== null && wi.total !== null ? wi.total - cur.total : null;
    return {
      model: row.key,
      provider: row.provider,
      target,
      tokens: row.total,
      requests: row.requests,
      current: cur.total,
      currentByKind: cur.byKind,
      whatif: wi.total,
      whatifByKind: wi.byKind,
      delta,
      // A gap on either side of the mapping is still a gap: either number
      // being incomplete makes the pairing incomplete.
      partial: cur.partial || wi.partial,
    };
  });

  // A model missing on either side cannot honestly contribute to an overall
  // current/what-if/delta trio: the three must stay `delta === whatif -
  // current`, which only holds over the same set of rows on all three.
  const comparable = models.filter((m) => m.current !== null && m.whatif !== null);
  const sum = (get) => comparable.reduce((a, m) => a + get(m), 0);
  const overall = {
    current: comparable.length ? sum((m) => m.current) : null,
    whatif: comparable.length ? sum((m) => m.whatif) : null,
    delta: comparable.length ? sum((m) => m.delta) : null,
    excluded: models.length - comparable.length,
    partial: models.length > comparable.length || models.some((m) => m.partial),
  };
  return { models, overall };
}

// ---------------------------------------------------------- target list ----

const SRC_PROVIDER = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-thirdparty': 'OpenAI',
  deepseek: 'DeepSeek',
  zai: 'Z.ai',
  google: 'Google',
};

/** Prefix fallback for entries whose `src` does not name a provider directly
 * (`legacy`, `user`): only changes which optgroup a name is filed under, not
 * any rate, since every shipped rate is looked up by model name alone. */
function inferProvider(name) {
  if (/^claude/i.test(name)) return 'Anthropic';
  if (/^(gpt|o3|o4|chat)/i.test(name)) return 'OpenAI';
  if (/^deepseek/i.test(name)) return 'DeepSeek';
  if (/^gemini/i.test(name)) return 'Google';
  if (/^glm/i.test(name)) return 'Z.ai';
  return 'Other';
}

/**
 * The first top-level alternative of a regex source string: the substring
 * up to the first `|` that sits outside any `(...)` group.
 * @param {string} pattern
 * @returns {string}
 */
function firstTopLevelAlt(pattern) {
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) return pattern.slice(0, i);
  }
  return pattern;
}

/**
 * Turn one `BUILTIN_PRICES`-style `match` regex into one representative,
 * literal model name: take the first top-level alternative, drop the
 * anchors, and resolve every `(...)` group to its own first alternative. An
 * alternative that is bare `$` (an end-of-string anchor standing in for
 * "nothing more") resolves to the empty string, not the literal text "$".
 * @param {string} pattern
 * @returns {string}
 */
export function deriveModelName(pattern) {
  let s = firstTopLevelAlt(pattern);
  s = s.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\(([^()]*)\)/g, (_, inner) => {
    const alt = firstTopLevelAlt(inner);
    return alt === '$' ? '' : alt;
  });
  s = s.replace(/\\(.)/g, '$1');
  return s;
}

/**
 * Every target a "reprice at" select may offer: one representative name per
 * price-table entry (builtin and user overrides), unioned with every priced
 * model actually seen in the dataset. That way migrating *to* a model you
 * have never used is possible, and a model an imperfect regex-derivation
 * missed is not silently dropped just because it showed up in real usage.
 * Every name is round-tripped through `book.lookup` before being offered, so
 * a derivation slip never produces an option that reprices to n/a.
 * @param {{book:object, seenModels?:({value:string}|string)[]}} args
 * @returns {{name:string, provider:string}[]} sorted by provider, then name.
 */
export function targetModelOptions({ book, seenModels = [] }) {
  const byName = new Map();
  for (const e of book.entries || []) {
    const name = e.origin === 'user' ? e.key : deriveModelName(e.match);
    if (!name || byName.has(name)) continue;
    if (!book.lookup(name, 'unknown')) continue;
    byName.set(name, SRC_PROVIDER[e.src] || inferProvider(name));
  }
  for (const s of seenModels) {
    const name = typeof s === 'string' ? s : s.value;
    if (!name || byName.has(name)) continue;
    if (!book.lookup(name, 'unknown')) continue;
    byName.set(name, inferProvider(name));
  }
  return [...byName.entries()]
    .map(([name, provider]) => ({ name, provider }))
    .sort((a, b) => (a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider)));
}

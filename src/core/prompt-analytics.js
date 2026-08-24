/**
 * Prompt-level analytics — strictly opt-in, privacy-preserving by design.
 *
 * DEFAULT STATE: OFF. No adapter captures prompts unless
 *   promptAnalytics:
 *     enabled: true
 *     storeRaw: false          # raw content stays OFF unless separately opted in
 * is present in config.yaml.
 *
 * What is captured when enabled (per request):
 *   - sha256(prompt)[:16]  — a one-way hash; cannot be reversed to the prompt
 *   - category             — heuristic keyword classifier (code-review,
 *                            debug, test, docs, architecture, other)
 *   - model, tokens, cost  — already collected by every adapter
 *
 * What is NEVER captured: raw prompt text (unless storeRaw: true), file
 * contents, environment variables, credentials.
 *
 * Repeated-prompt detection falls out of the hash: identical normalized
 * prompts share a hash across days/models.
 */
import crypto from 'node:crypto';

export const CATEGORIES = [
  ['code-review', /\b(review|pr|pull.request|diff|audit)\b/i],
  ['debugging', /\b(debug|error|bug|fix|stack.?trace|exception|failing)\b/i],
  ['testing', /\b(test|spec|coverage|jest|vitest|pytest)\b/i],
  ['documentation', /\b(doc|readme|comment|javadoc|explain this code)/i],
  ['architecture', /\b(architect|design|refactor|structure|pattern|migrate)\b/i],
];
/** Type note for tsc: entries are [label, RegExp]. */
const CATEGORY_RULES = CATEGORIES;

export function normalizePrompt(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w ]/g, '')
    .trim()
    .slice(0, 2000);
}

/** One-way hash. Short prefix only — collisions acceptable for analytics. */
export function hashPrompt(text) {
  return crypto.createHash('sha256').update(normalizePrompt(text)).digest('hex').slice(0, 16);
}

export function categorize(text) {
  const n = normalizePrompt(text);
  for (const [cat, re] of CATEGORY_RULES) if (re instanceof RegExp && re.test(n)) return cat;
  return 'uncategorized';
}

/**
 * The record adapters may emit when prompt analytics is enabled.
 * Returns null fields when input has no prompt text (e.g. cache-only rows).
 */
/**
 * @param {{promptText?: string, model?: string|null, tokens?: number|null, cost?: number|null, timestamp?: string|null}} args
 */
export function makePromptRecord({ promptText, model, tokens, cost, timestamp } = {}) {
  if (!promptText) return null;
  return {
    promptHash: hashPrompt(promptText),
    category: categorize(promptText),
    model: model || null,
    tokens: tokens ?? null,
    estCostUsd: cost ?? null,
    timestamp: timestamp || new Date().toISOString(),
    // Raw text is captured ONLY when the user separately opts in.
    ...(this?.storeRaw ? { raw: String(promptText).slice(0, 4000) } : {}),
  };
}

/**
 * Aggregate prompt records → the views the gauntlet asks for.
 * @param {Array<{promptHash,category,model,tokens,estCostUsd}>} records
 */
export function aggregate(records) {
  const byCat = new Map();
  const byHash = new Map();
  let totalTokens = 0;
  let cacheCapable = 0;

  for (const r of records) {
    const c = byCat.get(r.category) || { requests: 0, tokens: 0, cost: 0 };
    c.requests += 1;
    c.tokens += r.tokens || 0;
    c.cost += r.estCostUsd || 0;
    byCat.set(r.category, c);

    const h = byHash.get(r.promptHash) || { count: 0, categories: new Set(), models: new Set(), cost: 0 };
    h.count += 1;
    h.categories.add(r.category);
    h.models.add(r.model);
    h.cost += r.estCostUsd || 0;
    byHash.set(r.promptHash, h);

    totalTokens += r.tokens || 0;
    cacheCapable += 1;
  }

  const categories = [...byCat.entries()]
    .map(([category, v]) => ({
      category,
      requests: v.requests,
      tokens: v.tokens,
      estCostUsd: Math.round(v.cost * 100) / 100,
      avgCostPerRequest: v.requests ? Math.round((v.cost / v.requests) * 10000) / 10000 : null,
    }))
    .sort((a, b) => b.estCostUsd - a.estCostUsd);

  const repeats = [...byHash.entries()]
    .filter(([, h]) => h.count > 1)
    .map(([hash, h]) => ({ hash, count: h.count, models: [...h.models] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalPrompts: records.length,
    uniquePrompts: byHash.size,
    repeatRatePct: records.length ? Math.round(((records.length - byHash.size) / records.length) * 1000) / 10 : 0,
    avgTokensPerPrompt: records.length ? Math.round(totalTokens / records.length) : null,
    categories,
    repeats,
  };
}

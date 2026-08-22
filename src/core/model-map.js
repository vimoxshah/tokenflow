/**
 * Provider + model-family classification.
 *
 * Rules are DATA, not code paths: the list below is the built-in ruleset and
 * a user's `~/.tokenflow/config.yaml` can prepend their own rules
 * (`modelMappings:`) without touching the dashboard. A model that matches
 * nothing becomes provider `unknown` with its raw string preserved — it is
 * never bucketed into a plausible-looking vendor.
 */

/** @typedef {{match: string, provider: string, label: string, family?: string, familyFrom?: string[]}} ModelRule */

/** @type {ModelRule[]} */
export const BUILTIN_MODEL_RULES = [
  {
    match: '(^|/)claude|^anthropic\\.|claude-instant',
    provider: 'anthropic',
    label: 'Anthropic',
    familyFrom: ['opus', 'sonnet', 'haiku'],
  },
  {
    match: '(^|/)(gpt|chatgpt|o[1345](-|$)|codex|text-davinci|davinci)',
    provider: 'openai',
    label: 'OpenAI',
  },
  { match: 'deepseek', provider: 'deepseek', label: 'DeepSeek' },
  { match: '(^|/)(glm|charglm|cogview)|z-?ai', provider: 'zai', label: 'Z.ai / GLM' },
  { match: '(^|/)(gemini|gemma|palm|bison)', provider: 'google', label: 'Google' },
  { match: '(^|/)(qwen|qwq)', provider: 'alibaba', label: 'Alibaba / Qwen' },
  { match: 'kimi|moonshot', provider: 'moonshot', label: 'Moonshot / Kimi' },
  { match: '(^|/)grok', provider: 'xai', label: 'xAI / Grok' },
  { match: '(^|/)(llama|codellama)', provider: 'meta', label: 'Meta / Llama' },
  { match: '(^|/)(mistral|mixtral|codestral|magistral)', provider: 'mistral', label: 'Mistral' },
  { match: '(^|/)(command-?r?|cohere)', provider: 'cohere', label: 'Cohere' },
  { match: '(^|/)(nova)|^amazon\\.', provider: 'amazon', label: 'Amazon / Nova' },
  { match: '(^|/)(phi-|orca)', provider: 'microsoft', label: 'Microsoft' },
  { match: '(^|/)composer-', provider: 'cursor', label: 'Cursor' },
  // Gateways publish free/preview models under their own namespace; the slug
  // prefix is the publisher's own attribution, same evidence as any vendor
  // prefix above.
  { match: '(^|/)minimax|(^|/)abab', provider: 'minimax', label: 'MiniMax' },
  { match: 'upstage|(^|/)solar', provider: 'upstage', label: 'Upstage' },
  { match: 'tencent|hunyuan|(^|/)hy\\d', provider: 'tencent', label: 'Tencent / Hunyuan' },
  { match: '^nvidia|(^|/)nemotron', provider: 'nvidia', label: 'NVIDIA' },
  { match: 'xiaomi|(^|/)(mi-?)?mimo', provider: 'xiaomi', label: 'Xiaomi / MiMo' },
  // OpenRouter's own house/stealth series ("openrouter/owl-alpha"). This must
  // stay AFTER the vendor rules: "openrouter/deepseek/v3" is DeepSeek, and
  // only slugs no vendor rule can identify fall back to the namespace owner.
  { match: '(^|/)openrouter/', provider: 'openrouter', label: 'OpenRouter' },
  // OpenCode's own gateway catalog (served through the opencode adapter):
  // the "x" preview family and the muse-spark community series. These slugs
  // are published by OpenCode itself, so attribution follows the publisher.
  { match: '(^|/)x-preview(-|$)', provider: 'opencode', label: 'OpenCode' },
  { match: '(^|/)muse-spark', provider: 'opencode', label: 'OpenCode' },
];

const compiled = new WeakMap();

function compile(rules) {
  let c = compiled.get(rules);
  if (!c) {
    c = rules.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));
    compiled.set(rules, c);
  }
  return c;
}

/**
 * @param {string|null} raw model string as reported by the source
 * @param {{rules?: ModelRule[], providerHint?: string|null}} [opt]
 *   providerHint is used ONLY when the model string matches nothing — a hint
 *   never overrides evidence from the model name itself.
 * @returns {{provider:string, provider_label:string, model:string, model_family:string}}
 */
export function classifyModel(raw, opt = {}) {
  const rules = compile(opt.rules ?? BUILTIN_MODEL_RULES);
  const model = raw && String(raw).trim() ? String(raw).trim() : 'unknown';
  if (model === 'unknown') {
    return {
      provider: opt.providerHint || 'unknown',
      provider_label: opt.providerHint ? titleize(opt.providerHint) : 'Unknown',
      model,
      model_family: 'Unknown',
    };
  }

  for (const r of rules) {
    if (!r.re.test(model)) continue;
    return {
      provider: r.provider,
      provider_label: r.label,
      model,
      model_family: r.family ?? familyOf(model, r),
    };
  }
  return {
    provider: opt.providerHint || 'unknown',
    provider_label: opt.providerHint ? titleize(opt.providerHint) : 'Unknown',
    model,
    model_family: opt.providerHint ? `${titleize(opt.providerHint)} (unmapped)` : 'Unmapped',
  };
}

/**
 * Family label: the human-meaningful tier, with build dates and vendor
 * prefixes stripped, so `claude-opus-4-5-20260101` and `claude-opus-5` land in
 * comparable buckets without us pretending to know a version taxonomy.
 */
function familyOf(model, rule) {
  const m = model.toLowerCase();
  if (rule.familyFrom) {
    for (const tier of rule.familyFrom) {
      if (m.includes(tier)) {
        const ver = m.match(new RegExp(`${tier}[-_]?(\\d+(?:[.-]\\d+)?)`)) || m.match(new RegExp(`(\\d+(?:[.-]\\d+)?)[-_]?${tier}`));
        const v = ver ? ' ' + ver[1].replace('-', '.') : '';
        return titleize(rule.provider === 'anthropic' ? 'Claude ' + tier : tier) + v;
      }
    }
  }
  // Strip a vendor prefix ("openrouter/x/y" -> "y"), then a trailing date stamp.
  let base = m.split('/').pop();
  base = base.replace(/[-_](\d{8}|\d{4}-\d{2}-\d{2}|latest|preview|exp)$/g, '');
  // Collapse a trailing variant suffix (gpt-5.6-sol -> gpt-5.6) but keep it as
  // a distinct family when it is the only distinguishing token.
  const generation = base.match(/^([a-z]+[-_]?\d+(?:\.\d+)?)/);
  if (generation) {
    const suffix = base.slice(generation[1].length).replace(/^[-_]/, '');
    const g = titleize(generation[1]);
    return suffix ? `${g} (${suffix})` : g;
  }
  return titleize(base);
}

function titleize(s) {
  return String(s)
    .replace(/[-_]/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bAi\b/g, 'AI')
    .trim();
}

export { titleize };

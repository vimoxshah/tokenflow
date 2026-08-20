/**
 * The provider SDK — the minimum surface a community adapter needs.
 *
 *   import { createProvider, registerProvider, normalizeUsage, validateUsage }
 *     from 'tokenflow/sdk';
 *
 * See docs/creating-provider.md for the full contract.
 */
export { createProvider, registerProvider, getProvider, listProviders } from './core/registry.js';
export { validateUsage, validateProvider } from './core/validate.js';
export {
  createRecord, computeTotal, dateParts, hashId,
  MEASUREMENT, INTERFACE, INTERFACE_ORDER, interfaceClass,
  BILLABLE_TOKEN_FIELDS, BREAKDOWN_TOKEN_FIELDS, TOKEN_FIELDS,
} from './core/schema.js';
export { classifyModel, BUILTIN_MODEL_RULES } from './core/model-map.js';
export { classifyInterface } from './core/interface-map.js';
export { readLines, readJsonLines } from './core/jsonl.js';
export { walk, enrich } from './core/ingest.js';
export { openReadOnly, tables, columns, sqliteAvailable } from './core/sqlite.js';
export { registerAnalytics, listAnalytics } from './analytics/index.js';
import { enrich } from './core/ingest.js';

/**
 * Normalize a partial record without running a full ingest — handy in adapter
 * unit tests and in `--dry-run` importers.
 * @param {object} partial
 * @param {{provider:{id:string,name:string,measurement?:string}, tz?:string|null, priceBook?:object,
 *   rules?:object[], config?:object, user?:string|null, machine?:string|null,
 *   seq?:number, fileRef?:object|null}} opt
 */
export function normalizeUsage(partial, opt) {
  return enrich(partial, {
    ctx: {
      tz: opt.tz ?? null,
      priceBook: opt.priceBook ?? { lookup: () => null },
      rules: opt.rules,
      config: opt.config ?? {},
      user: opt.user ?? null,
      machine: opt.machine ?? null,
    },
    provider: opt.provider,
    seq: opt.seq ?? 0,
    fileRef: opt.fileRef ?? null,
  });
}

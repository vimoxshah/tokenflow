/**
 * Library entry point. Everything the CLI and dashboard use is exported here,
 * so the platform can be embedded in another tool without shelling out.
 */
export * from './core/schema.js';
export * from './core/validate.js';
export * from './core/registry.js';
export * from './core/config.js';
export * from './core/pricing.js';
export * from './core/model-map.js';
export * from './core/interface-map.js';
export { refresh, enrich, walk } from './core/ingest.js';
export { Store, encodeRecord, decodeRecord } from './core/store.js';
export { buildBundle, queryRecords } from './core/bundle.js';
export * from './analytics/index.js';
export * from './export/csv.js';
export { buildSnapshot } from './export/html-snapshot.js';
export { startServer } from './server/server.js';

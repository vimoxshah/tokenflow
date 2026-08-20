/**
 * Globals the offline snapshot injects.
 *
 * `src/export/html-snapshot.js` inlines the whole dataset into the exported HTML
 * as `window.__TOKENFLOW_*__` assignments, so a `file://` page has its data
 * without a server. In the live dashboard none of these exist and the UI falls
 * back to `/api/*` — which is why every one of them is optional.
 *
 * Types only. This file is never bundled or shipped; it exists so `checkJs` can
 * see what the snapshot writes.
 */

interface Window {
  /** Pre-aggregated cube + sessions + meta, as built by src/core/bundle.js. */
  __TOKENFLOW_BUNDLE__?: any;
  /** Request-level records, capped by the export's --max-records. */
  __TOKENFLOW_RECORDS__?: any[];
  /** ISO timestamp of when the snapshot was written. */
  __TOKENFLOW_SNAPSHOT_AT__?: string;
  /** Loopback ports the snapshot should probe for a live dashboard. */
  __TOKENFLOW_PORTS__?: number[];
}

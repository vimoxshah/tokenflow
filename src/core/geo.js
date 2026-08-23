/**
 * Provider region map — the geography TokenFlow can honestly claim.
 *
 * Two layers, both explicit about what they are:
 *
 * 1. Vendor regions (offline, always on). A request to Anthropic lands in
 *    Anthropic's published datacenter regions; that much is public knowledge
 *    and can be attached to measured per-provider usage. What is NOT known is
 *    which specific region any individual request hit — providers don't log
 *    it locally — so regions are listed per provider as possibilities, never
 *    asserted per request, and no fake percentages are generated.
 *
 * 2. "You are here" (opt-in only). One IP geolocation lookup of THIS machine's
 *    public IP, gated behind `map.showMyLocation: true` in config.yaml,
 *    resolved once and cached in $TOKENFLOW_HOME/data/geo-cache.json with the
 *    lookup date. The raw IP is never stored — only city/region/country and
 *    coordinates returned by the lookup. Off by default because the project
 *    promises "no network client"; enabling it adds exactly one outbound call.
 */
import fs from 'node:fs';
import https from 'node:https';
import { paths, ensureDirs } from './config.js';

/** Publicly documented primary regions per provider (approximate, honest). */
export const PROVIDER_REGIONS = {
  anthropic: { label: 'Anthropic', regions: ['us-west (Oregon)', 'us-east (Virginia)'] },
  openai: { label: 'OpenAI', regions: ['us-east', 'eu-west (Azure)'] },
  opencode: { label: 'OpenCode gateway', regions: ['multi-vendor routing — region varies by model'] },
  openrouter: { label: 'OpenRouter', regions: ['us-east', 'eu-central'] },
  nous: { label: 'Nous Research', regions: ['us (deepinfra-backed)'] },
  deepseek: { label: 'DeepSeek', regions: ['cn-south'] },
  moonshot: { label: 'Moonshot AI', regions: ['cn-north'] },
  upstage: { label: 'Upstage', regions: ['kr-seoul'] },
  nvidia: { label: 'NVIDIA NIM', regions: ['us-east', 'us-west'] },
  stepfun: { label: 'StepFun', regions: ['cn-east'] },
};

const GEO_CACHE = 'geo-cache.json';
const GEO_TTL_MS = 30 * 24 * 3600 * 1000; // re-resolve monthly at most

/**
 * Opt-in "you are here". Returns { lat, lon, city, country, source, date }
 * or null when disabled or unreachable. Never throws; never stores the IP.
 * @param {{config?:object}} opt
 */
export async function resolveMyLocation(opt = {}) {
  const config = opt.config;
  if (!config?.map?.showMyLocation) return null;

  ensureDirs();
  const file = `${paths().data}/${GEO_CACHE}`;
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached && Date.now() - new Date(cached.date).getTime() < GEO_TTL_MS) {
      return { ...cached, cached: true };
    }
  } catch { /* no cache yet */ }

  const geo = await fetchGeo();
  if (!geo) return null;
  const record = { ...geo, date: new Date().toISOString() };
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch { /* cache write is best-effort */ }
  return record;
}

function fetchGeo() {
  // ipapi.co free tier: one HTTPS GET, returns city/region/country/lat/lon.
  // The public IP travels to the geo service by necessity of the lookup; it is
  // then discarded — only the derived place fields are persisted.
  return new Promise((resolve) => {
    const req = https.get(
      { host: 'ipapi.co', path: '/json/', timeout: 5000, headers: { 'user-agent': 'tokenflow-local' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        res.on('end', () => {
          try {
            const o = JSON.parse(body);
            if (typeof o.latitude === 'number' && typeof o.longitude === 'number') {
              resolve({
                lat: o.latitude,
                lon: o.longitude,
                city: o.city || null,
                region: o.region || null,
                country: o.country_name || null,
                source: 'ipapi.co',
              });
            } else resolve(null);
          } catch { resolve(null); }
        });
      });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

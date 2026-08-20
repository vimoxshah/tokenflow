/**
 * Mock provider — deterministic demo data so a new contributor can run
 * `npm run demo` and see a realistic dashboard without connecting anything.
 *
 * Every record it produces carries `metadata.demo = true` and
 * `machine: "demo-machine"`, and the dashboard shows a persistent DEMO DATA
 * banner whenever any demo record is in scope. It only activates when asked
 * for explicitly (TOKENFLOW_DEMO=1 or `providers: [mock]`), so it can never
 * contaminate a real dataset by accident.
 */
import { createProvider } from '../../core/registry.js';
import { MEASUREMENT, INTERFACE } from '../../core/schema.js';

/** mulberry32 — small, fast, seeded, identical across platforms. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  { model: 'claude-opus-4-1-20250805', client: 'claude-code', iface: INTERFACE.CLI, weight: 34, out: 0.06, cacheHeavy: true },
  { model: 'claude-sonnet-4-20250514', client: 'claude-code', iface: INTERFACE.CLI, weight: 26, out: 0.08, cacheHeavy: true },
  { model: 'claude-3-5-haiku-20241022', client: 'claude-desktop', iface: INTERFACE.DESKTOP, weight: 8, out: 0.12, cacheHeavy: false },
  { model: 'gpt-4o', client: 'codex', iface: INTERFACE.IDE, weight: 14, out: 0.10, cacheHeavy: false },
  { model: 'o3', client: 'codex', iface: INTERFACE.CLI, weight: 9, out: 0.18, cacheHeavy: false, reasoning: 0.55 },
  { model: 'deepseek-chat', client: 'cline', iface: INTERFACE.CLI, weight: 6, out: 0.14, cacheHeavy: false },
  { model: 'gemini-2.0-flash', client: 'api-script', iface: INTERFACE.API, weight: 3, out: 0.20, cacheHeavy: false },
];
const PROJECTS = ['billing-service', 'web-app', 'infra-terraform', 'data-pipeline', 'docs'];

export default createProvider({
  id: 'mock',
  name: 'Demo data (synthetic)',
  description: 'Deterministic synthetic usage for development and screenshots. Always labelled as demo.',
  measurement: MEASUREMENT.PRIMARY,
  requires: ['TOKENFLOW_DEMO=1, or add "mock" to providers in config.yaml'],

  async detect(ctx) {
    const on = process.env.TOKENFLOW_DEMO === '1' || (ctx?.config?.providers || []).includes('mock');
    return on
      ? { available: true, detail: 'SYNTHETIC DEMO DATA — not real usage' }
      : { available: false, detail: 'set TOKENFLOW_DEMO=1 to generate demo data' };
  },

  async fetchUsage(ctx, emit) {
    const days = Number(ctx?.config?.sources?.mock?.days ?? 160);
    const seed = Number(ctx?.config?.sources?.mock?.seed ?? 20260814);
    const r = rng(seed);
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    let records = 0;

    const total = MODELS.reduce((a, m) => a + m.weight, 0);
    for (let dayIdx = days - 1; dayIdx >= 0; dayIdx--) {
      const d = new Date(end.getTime() - dayIdx * 86400000);
      const dow = (d.getUTCDay() + 6) % 7;
      const weekend = dow >= 5;
      // A gentle upward trend plus weekday seasonality plus noise.
      const trend = 0.55 + 0.9 * ((days - dayIdx) / days);
      const dayFactor = (weekend ? 0.28 : 1) * trend * (0.65 + r() * 0.7);
      if (r() < (weekend ? 0.45 : 0.06)) continue; // a few genuinely idle days
      const requests = Math.round(40 * dayFactor);
      const sessions = Math.max(1, Math.round(requests / (6 + r() * 6)));

      for (let s = 0; s < sessions; s++) {
        // Bimodal working hours: a morning block and an evening block.
        const evening = r() < 0.38;
        const baseHour = evening ? 19 + Math.floor(r() * 4) : 9 + Math.floor(r() * 5);
        const sid = `demo-${d.toISOString().slice(0, 10)}-${s}`;
        const project = PROJECTS[Math.floor(r() * PROJECTS.length)];
        let pickV = r() * total;
        let spec = MODELS[0];
        for (const m of MODELS) { pickV -= m.weight; if (pickV <= 0) { spec = m; break; } }

        const perSession = Math.max(1, Math.round(requests / sessions));
        for (let i = 0; i < perSession; i++) {
          const hour = Math.min(23, baseHour + Math.floor(r() * 2));
          const ts = new Date(d.getTime() + hour * 3600000 + Math.floor(r() * 3600000));
          const scale = 1 + r() * 9;
          const cacheRead = spec.cacheHeavy ? Math.round(9000 * scale * (1 + r())) : Math.round(400 * scale);
          const cacheWrite = spec.cacheHeavy ? Math.round(2400 * scale * r()) : 0;
          const input = Math.round(180 * scale * (0.4 + r()));
          const output = Math.round((input + cacheRead) * spec.out * (0.5 + r()));
          emit({
            id: `mock-${sid}-${i}`,
            timestamp: ts.toISOString(),
            model: spec.model,
            client: spec.client,
            application: spec.client,
            interface: spec.iface,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            cache_refresh_tokens: spec.cacheHeavy ? Math.round(cacheWrite * 0.35) : 0,
            reasoning_tokens: spec.reasoning ? Math.round(output * spec.reasoning) : null,
            session_id: sid,
            project,
            repository: project,
            git_branch: r() < 0.5 ? 'main' : `feat/${project}-${Math.floor(r() * 90)}`,
            category: 'main',
            machine: 'demo-machine',
            user: 'demo',
            metadata: { demo: true },
          });
          records++;
        }
      }
    }
    return { records, notes: ['synthetic demo data — clearly labelled in the UI'] };
  },
});

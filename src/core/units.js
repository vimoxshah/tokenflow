/**
 * Number / date formatting shared by the CLI, the API and the browser bundle.
 * Kept dependency-free and side-effect-free so it can be inlined into the
 * static HTML snapshot verbatim.
 */

const UNITS = [
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'B' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'K' },
];

/**
 * Compact token formatting. Handles billions/trillions without losing
 * readability and never renders a raw 12-digit integer.
 * 1_742_000_000 -> "1.74B"
 * @param {number|null|undefined} n
 * @param {{digits?:number, na?:string}} [opt]
 */
export function compact(n, opt = {}) {
  const na = opt.na ?? '—';
  if (n === null || n === undefined || Number.isNaN(n)) return na;
  const neg = n < 0;
  const a = Math.abs(n);
  if (a < 1000) {
    const s = Number.isInteger(a) ? String(a) : a.toFixed(opt.digits ?? 1);
    return (neg ? '-' : '') + s;
  }
  for (const u of UNITS) {
    if (a >= u.v) {
      const q = a / u.v;
      // 3 significant figures reads best across K/M/B/T
      const d = opt.digits !== undefined ? opt.digits : q >= 100 ? 0 : q >= 10 ? 1 : 2;
      // Trim trailing zeros so 2.50T reads as 2.5T and 1.00B as 1B.
      const q2 = q.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return (neg ? '-' : '') + q2 + u.s;
    }
  }
  return String(n);
}

/** Thousands-separated integer, for table cells and tooltips. */
export function int(n, na = '—') {
  if (n === null || n === undefined || Number.isNaN(n)) return na;
  return Math.round(n).toLocaleString('en-US');
}

/** @param {number|null|undefined} n */
export function usd(n, na = '—') {
  if (n === null || n === undefined || Number.isNaN(n)) return na;
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  if (a < 0.01) return '$' + n.toFixed(4);
  if (a < 1000) return '$' + n.toFixed(2);
  if (a < 1e6) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + (n / 1e6).toFixed(2) + 'M';
}

/** @param {number|null|undefined} f fraction 0..1 */
export function pct(f, digits = 1, na = '—') {
  if (f === null || f === undefined || Number.isNaN(f) || !Number.isFinite(f)) return na;
  return (f * 100).toFixed(digits) + '%';
}

/** Signed percentage change, for comparison mode and trend chips. */
export function delta(cur, prev, digits = 0) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (prev === 0) return cur === 0 ? 0 : null; // undefined growth from zero base
  return (cur - prev) / prev;
}

export function signedPct(f, digits = 0) {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—';
  const s = f > 0 ? '+' : '';
  return s + (f * 100).toFixed(digits) + '%';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "2026-08-12" -> "Aug 12" */
export function shortDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2026-08-12" -> "Aug 12, 2026" */
export function longDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Hour label for axis ticks: 0 -> "00", 14 -> "14". */
export function hourLabel(h) {
  return String(h).padStart(2, '0');
}

/** "10:00 – 13:00" from an inclusive hour window. */
export function hourWindow(a, b) {
  return `${hourLabel(a)}:00 – ${hourLabel((b + 1) % 24)}:00`;
}

export function humanDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const diff = now - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return longDate(iso.slice(0, 10));
}

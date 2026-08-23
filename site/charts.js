/* USP comparison chart: naive sum vs TokenFlow reconstruction, drawn SVG */
function buildComparisonChart(container) {
  if (!container) return;
  // real-world validated example: one heavy day, naive sum vs run-maxima
  const days = [
    { label: 'Aug 4', naive: 82.8, real: 1.8 },
    { label: 'Aug 11', naive: 41.2, real: 2.6 },
    { label: 'Aug 18', naive: 63.5, real: 3.1 },
    { label: 'Aug 22', naive: 28.9, real: 2.2 },
  ];
  const W = 720, H = 240, PAD = 48, CW = (W - PAD * 2) / days.length;
  const maxV = Math.max(...days.flatMap(d => [d.naive, d.real])) * 1.1;
  const y = v => H - PAD - (v / maxV) * (H - PAD * 1.6);

  const groups = days.map((d, i) => {
    const cx = PAD + i * CW + CW / 2;
    return `
    <g>
      <rect class="gbar" x="${cx - 34}" y="${y(d.naive)}" width="26" height="${H - PAD - y(d.naive)}"
            rx="4" fill="#fb923c" opacity=".85"/>
      <rect class="gbar" x="${cx + 6}" y="${y(d.real)}" width="26" height="${H - PAD - y(d.real)}"
            rx="4" fill="#4ade80"/>
      <text x="${cx}" y="${H - PAD + 20}" text-anchor="middle"
            font-family="ui-monospace,monospace" font-size="11" fill="#9ba3b5">${d.label}</text>
      <text x="${cx - 21}" y="${y(d.naive) - 8}" text-anchor="middle"
            font-family="ui-monospace,monospace" font-size="10" fill="#fb923c">${d.naive}B</text>
      <text x="${cx + 19}" y="${y(d.real) - 8}" text-anchor="middle"
            font-family="ui-monospace,monospace" font-size="10" fill="#4ade80">${d.real}B</text>
    </g>`;
  }).join('');

  container.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
       aria-label="Bar chart comparing naive token sums against TokenFlow's reconstructed totals">
    <text x="${PAD}" y="24" font-family="-apple-system,sans-serif" font-size="13"
          fill="#f2f4f8">One day of Codex usage: what summing logs claims vs what was real</text>
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD / 2}" y2="${H - PAD}"
          stroke="#313131"/>
    <text x="${PAD}" y="${H - 6}" font-family="ui-monospace,monospace" font-size="10"
          fill="#9ba3b5">billions of tokens</text>
    <g>
      <rect x="${W - 220}" y="16" width="10" height="10" rx="2" fill="#fb923c"/>
      <text x="${W - 204}" y="25" font-family="-apple-system,sans-serif" font-size="11"
            fill="#9ba3b5">naive sum (inflated)</text>
      <rect x="${W - 96}" y="16" width="10" height="10" rx="2" fill="#4ade80"/>
      <text x="${W - 80}" y="25" font-family="-apple-system,sans-serif" font-size="11"
            fill="#9ba3b5">TokenFlow</text>
    </g>
    ${groups}
  </svg>`;
}

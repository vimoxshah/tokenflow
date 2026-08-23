/* Animated SVG hero: mini dashboard. Layout rules to prevent overlap:
   - header zone (title + value) occupies y 0..44, nothing else drawn there
   - plot zone y 56..150: bars grow from baseline y=148, max height 84
   - sparkline confined to y<=52 so it can never touch bar tops
   - legend row y 176..200, clear of both zones */
(function () {
  const el = document.getElementById('hero-visual');
  if (!el) return;

  // bar heights scaled to fit 84px max within the plot zone
  const bars = [
    [0, 30], [1, 20], [2, 40], [3, 27], [4, 52],
    [5, 36], [6, 65], [7, 47], [8, 76], [9, 58],
  ];
  const BASE = 148;
  const barSvg = bars.map(([i, h], k) =>
    `<rect class="bar-pop" x="${16 + i * 29}" y="${BASE - h}" width="17" height="${h}"
       rx="3" fill="${i === 8 ? '#8f9dff' : '#313131'}"
       style="animation-delay:${.9 + k * .06}s" opacity=".9"/>`).join('');

  el.innerHTML = `
  <svg viewBox="0 0 320 210" width="100%" role="img"
       aria-label="Stylised TokenFlow dashboard: daily token usage bars with a rising trend line">
    <!-- header zone -->
    <text x="24" y="26" font-family="-apple-system,sans-serif" font-size="11"
          fill="#9ba3b5">tokens per day</text>
    <text x="296" y="26" text-anchor="end" font-family="ui-monospace,monospace" font-size="13"
          font-weight="700" fill="#f2f4f8">4.83B</text>

    <!-- trend line stays in its own band above the bars -->
    <path class="hero-line" d="M20 50 C 60 46, 90 38, 130 41 S 200 28, 240 22 S 285 16, 300 12"
          stroke="#8f9dff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="300" cy="12" r="4" fill="#8f9dff">
      <animate attributeName="r" values="3;5;3" dur="2.4s" repeatCount="indefinite"/>
    </circle>

    <!-- plot zone -->
    ${barSvg}
    <line x1="16" y1="${BASE + 6}" x2="304" y2="${BASE + 6}" stroke="#313131"/>

    <!-- legend zone -->
    <g font-family="ui-monospace,monospace" font-size="10" fill="#9ba3b5">
      <rect x="24" y="180" width="10" height="10" rx="2" fill="#8f9dff"/><text x="40" y="189">peak day</text>
      <rect x="124" y="180" width="10" height="10" rx="2" fill="#4ade80"/><text x="140" y="189">cache hit rate 91%</text>
      <rect x="256" y="180" width="10" height="10" rx="2" fill="#fb923c"/><text x="272" y="189">limit pace</text>
    </g>
  </svg>`;
})();

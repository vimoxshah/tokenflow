/* Animated SVG hero: mini dashboard with drawn sparklines and popping bars */
(function () {
  const el = document.getElementById('hero-visual');
  if (!el) return;

  const bars = [
    [0, 34], [1, 22], [2, 44], [3, 30], [4, 58],
    [5, 40], [6, 72], [7, 52], [8, 84], [9, 64],
  ];
  const barSvg = bars.map(([i, h], k) =>
    `<rect class="bar-pop" x="${16 + i * 26}" y="${118 - h}" width="16" height="${h}"
       rx="3" fill="${i === 8 ? '#8f9dff' : '#313131'}"
       style="animation-delay:${.9 + k * .06}s" opacity=".9"/>`).join('');

  el.innerHTML = `
  <svg viewBox="0 0 320 220" width="100%" role="img"
       aria-label="Stylised TokenFlow dashboard: daily token usage bars with two rising trend lines">
    <rect x="1" y="1" width="318" height="218" rx="16" fill="#1F1F1F" stroke="#313131"/>
    <text x="24" y="36" font-family="-apple-system,sans-serif" font-size="12"
          fill="#9ba3b5">tokens per day</text>
    <text x="296" y="36" text-anchor="end" font-family="ui-monospace,monospace" font-size="14"
          font-weight="700" fill="#f2f4f8">4.83B</text>
    ${barSvg}
    <path class="hero-line" d="M20 96 C 60 88, 90 70, 130 74 S 200 46, 240 38 S 285 30, 300 24"
          stroke="#8f9dff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path class="hero-line late" d="M20 150 C 70 146, 110 128, 150 126 S 230 104, 300 92"
          stroke="#4ade80" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="600"/>
    <circle cx="300" cy="24" r="4" fill="#8f9dff">
      <animate attributeName="r" values="3;5;3" dur="2.4s" repeatCount="indefinite"/>
    </circle>
    <g font-family="ui-monospace,monospace" font-size="10" fill="#9ba3b5">
      <rect x="20" y="188" width="10" height="10" rx="2" fill="#8f9dff"/><text x="36" y="197">estimated</text>
      <rect x="110" y="188" width="10" height="10" rx="2" fill="#4ade80"/><text x="126" y="197">cache hit</text>
      <rect x="205" y="188" width="10" height="10" rx="2" fill="#fb923c"/><text x="221" y="197">limit pace</text>
    </g>
  </svg>`;
})();

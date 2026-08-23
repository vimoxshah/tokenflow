/* Animated SVG hero: mini dashboard.
   Layout contract — four horizontal bands, no element crosses a band edge:
     band 1  header    y 0..44    title left, value below it
     band 2  trend     y 56..96   the line only
     band 3  bars      y 100..170 baseline at 168, max height 62
     band 4  legend    y 186..204 three short labels, measured to fit 320w */
(function () {
  const el = document.getElementById('hero-visual');
  if (!el) return;

  const BASE = 168;
  const bars = [
    [0, 24], [1, 16], [2, 32], [3, 22], [4, 42],
    [5, 29], [6, 52], [7, 38], [8, 60], [9, 46],
  ];
  const barSvg = bars.map(([i, h], k) =>
    `<rect class="bar-pop" x="${16 + i * 29}" y="${BASE - h}" width="17" height="${h}"
       rx="3" fill="${i === 8 ? '#8f9dff' : '#2a3040'}"
       style="animation-delay:${.9 + k * .06}s"/>`).join('');

  // trend sits fully inside band 2 (y 58..94), never enters band 3 (top of
  // tallest bar is y=108) and never enters band 1 (bottom is y=44)
  el.innerHTML = `
  <svg viewBox="0 0 320 210" width="100%" role="img"
       aria-label="Stylised TokenFlow dashboard: daily token usage bars with a rising trend line">
    <!-- band 1: header -->
    <text x="20" y="20" font-family="-apple-system,sans-serif" font-size="11"
          fill="#9ba3b5">tokens per day</text>
    <text x="20" y="40" font-family="ui-monospace,monospace" font-size="15"
          font-weight="700" fill="#f2f4f8">4.83B</text>

    <!-- band 2: trend -->
    <path class="hero-line" d="M20 92 C 55 88, 85 78, 120 82 S 190 66, 235 62 S 285 56, 300 54"
          stroke="#8f9dff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="300" cy="54" r="4" fill="#8f9dff">
      <animate attributeName="r" values="3;5;3" dur="2.4s" repeatCount="indefinite"/>
    </circle>

    <!-- band 3: bars -->
    ${barSvg}
    <line x1="16" y1="${BASE + 4}" x2="304" y2="${BASE + 4}" stroke="#232a38"/>

    <!-- band 4: legend (labels sized so none clips at 320px width) -->
    <g font-family="-apple-system,sans-serif" font-size="10" fill="#9ba3b5">
      <rect x="20" y="188" width="9" height="9" rx="2" fill="#8f9dff"/>
      <text x="34" y="196">peak day</text>
      <rect x="112" y="188" width="9" height="9" rx="2" fill="#4ade80"/>
      <text x="126" y="196">cache hit</text>
      <rect x="204" y="188" width="9" height="9" rx="2" fill="#fb923c"/>
      <text x="218" y="196">limit pace</text>
    </g>
  </svg>`;
})();

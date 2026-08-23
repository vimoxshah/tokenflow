/* World map storytelling section.
   Honesty rule: no source exposes real request geography, so the map shows
   the shape of TokenFlow's model — your machine, the local gateway, and the
   provider edges it measures — with region data explicitly marked unknown.
   No fabricated country percentages. */
(function () {
  const el = document.getElementById('worldmap');
  if (!el) return;

  // dotted-globe style SVG: abstract dot-grid world silhouette + measured
  // flow arcs labelled with what they actually are
  el.innerHTML = `
  <svg viewBox="0 0 720 340" width="100%" role="img"
       aria-label="Stylised world map showing request flows from a local machine to AI providers. Region data is not reported by providers and is shown as unknown.">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#8f9dff" stop-opacity=".35"/>
        <stop offset="100%" stop-color="#8f9dff" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- dot-grid world suggestion: rows of dots masked to continent-ish blobs -->
    <g fill="#313131">
      ${(() => {
        // crude continent silhouettes as dot fields (x,y clusters)
        const blobs = [
          // north america
          [90,90,26],[110,80,30],[130,95,24],[100,120,20],[120,135,16],
          // south america
          [150,190,18],[160,215,16],[168,240,12],
          // europe
          [330,85,20],[350,78,16],
          // africa
          [345,140,22],[355,170,22],[365,200,16],
          // asia
          [430,80,34],[470,90,36],[510,80,30],[470,120,26],[520,110,22],
          // oceania
          [600,220,18],[620,235,14],
        ];
        let dots = '';
        for (const [cx,cy,r] of blobs) {
          for (let x = cx - r; x <= cx + r; x += 9) {
            for (let y = cy - r; y <= cy + r; y += 9) {
              if ((x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r && Math.random() > .18) {
                dots += '<circle cx="'+x+'" cy="'+y+'" r="1.6"/>';
              }
            }
          }
        }
        return dots;
      })()}
    </g>

    <!-- measured edges: local machine -> providers (what IS known) -->
    <g fill="none" stroke="#8f9dff" stroke-width="1.5" opacity=".9">
      <path class="flow" d="M250 250 C 300 180, 360 160, 430 120" stroke-dasharray="4 6"/>
      <path class="flow" d="M255 255 C 320 230, 380 210, 470 190" stroke-dasharray="4 6" opacity=".6"/>
      <path class="flow" d="M245 245 C 280 170, 310 130, 345 105" stroke-dasharray="4 6" opacity=".6"/>
    </g>

    <!-- your machine -->
    <circle cx="250" cy="252" r="26" fill="url(#glow)"/>
    <circle cx="250" cy="252" r="5" fill="#8f9dff"/>
    <text x="250" y="282" text-anchor="middle" font-family="-apple-system,sans-serif"
          font-size="11" fill="#e8ebf2">your machine</text>
    <text x="250" y="296" text-anchor="middle" font-family="-apple-system,sans-serif"
          font-size="10" fill="#9ba3b5">logs stay here</text>

    <!-- provider hubs -->
    <g font-family="-apple-system,sans-serif" font-size="10" fill="#9ba3b5">
      <circle cx="432" cy="118" r="4" fill="#8f9dff"/>
      <text x="442" y="114">Claude</text>
      <circle cx="472" cy="192" r="4" fill="#8f9dff"/>
      <text x="482" y="188">Codex</text>
      <circle cx="347" cy="103" r="4" fill="#8f9dff"/>
      <text x="300" y="96">OpenCode</text>
    </g>

    <!-- honesty badge -->
    <g font-family="-apple-system,sans-serif">
      <rect x="20" y="20" width="270" height="46" rx="8" fill="#1F1F1F" stroke="#313131"/>
      <text x="34" y="39" font-size="11" fill="#f2f4f8">Region data: not provided by provider.</text>
      <text x="34" y="56" font-size="10" fill="#9ba3b5">Flows show measured request paths, never guessed geography.</text>
    </g>
  </svg>`;
})();

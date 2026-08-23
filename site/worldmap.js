/* World map storytelling section.
   Honesty rule, upgraded: local logs carry no request IPs, so the map never
   claims per-request geography. It shows two honest layers:
     1. vendor-published datacenter regions per measured provider (offline
        knowledge — possibilities, not per-request facts);
     2. "you are here" ONLY when the dashboard's /api/geo reports it, which
        itself requires the user's explicit `map.showMyLocation: true` config.
   When the live API is unreachable (e.g. this static landing page), the map
   renders the static layer alone and says so. */
(function () {
  const el = document.getElementById('worldmap');
  if (!el) return;

  // Static fallback regions (same data as src/core/geo.js PROVIDER_REGIONS).
  const REGIONS = [
    { name: 'Anthropic', x: 195, y: 118, sub: 'us-west · us-east' },
    { name: 'OpenAI', x: 225, y: 100, sub: 'us-east · eu-west' },
    { name: 'OpenRouter', x: 322, y: 88, sub: 'eu-central' },
    { name: 'Nous', x: 208, y: 132, sub: 'us (deepinfra)' },
    { name: 'Upstage', x: 545, y: 128, sub: 'kr-seoul' },
    { name: 'DeepSeek', x: 520, y: 150, sub: 'cn-south' },
  ];

  function dotGrid() {
    const blobs = [
      [90,90,26],[110,80,30],[130,95,24],[100,120,20],[120,135,16],
      [150,190,18],[160,215,16],[168,240,12],
      [330,85,20],[350,78,16],
      [345,140,22],[355,170,22],[365,200,16],
      [430,80,34],[470,90,36],[510,80,30],[470,120,26],[520,110,22],
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
  }

  function hubSVG(regions, me, live) {
    const flows = regions.map((r, i) => {
      if (!me) {
        const mx = 250, my = 252;
        return `<path class="flow" d="M${mx} ${my} C ${(mx+r.x)/2} ${my-60}, ${(mx+r.x)/2} ${r.y+40}, ${r.x-4} ${r.y}" stroke-dasharray="4 6" opacity="${i % 2 ? .55 : .9}"/>`;
      }
      return `<path class="flow" d="M${me.x} ${me.y} C ${(me.x+r.x)/2} ${Math.min(me.y,r.y)-50}, ${(me.x+r.x)/2} ${r.y+40}, ${r.x-4} ${r.y}" stroke-dasharray="4 6" opacity="${i % 2 ? .55 : .9}"/>`;
    }).join('\n      ');

    const hubs = regions.map((r) => `
      <circle cx="${r.x}" cy="${r.y}" r="4" fill="#8f9dff"/>
      <text x="${r.x + 10}" y="${r.y - 2}" fill="#c7cede">${r.name}</text>
      <text x="${r.x + 10}" y="${r.y + 11}" font-size="8" fill="#9ba3b5">${r.sub}</text>`).join('');

    const meMark = me ? `
      <circle cx="${me.x}" cy="${me.y}" r="18" fill="url(#glow)"/>
      <circle cx="${me.x}" cy="${me.y}" r="5" fill="#5eead4"/>
      <text x="${me.x}" y="${me.y + 30}" text-anchor="middle" font-size="10" fill="#5eead4">you · ${me.city || me.region || ''}</text>` : '';

    const origin = me
      ? `<text x="${me.x + 12}" y="${me.y - 12}" font-size="9" fill="#9ba3b5">flows start at your location (opt-in)</text>`
      : `<circle cx="250" cy="252" r="22" fill="url(#glow)"/>
         <circle cx="250" cy="252" r="5" fill="#8f9dff"/>
         <text x="250" y="282" text-anchor="middle" font-size="11" fill="#e8ebf2">your machine</text>`;

    const badge = me
      ? `<text x="34" y="39" font-size="11" fill="#f2f4f8">Your location shown by your choice (map.showMyLocation).</text>
         <text x="34" y="56" font-size="10" fill="#9ba3b5">Provider regions are vendor-published possibilities — no request-level IP is stored.</text>`
      : `<text x="34" y="39" font-size="11" fill="#f2f4f8">Region data: vendor-published only.${live ? '' : ' (static page)'}</text>
         <text x="34" y="56" font-size="10" fill="#9ba3b5">No IP capture. Enable map.showMyLocation in config to place yourself.</text>`;

    return `
  <svg viewBox="0 0 720 340" width="100%" role="img"
       aria-label="World map: measured providers mapped to their published datacenter regions; optional user location only when explicitly enabled.">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#5eead4" stop-opacity=".35"/>
        <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <g fill="#313131">${dotGrid()}</g>
    <g fill="none" stroke="#8f9dff" stroke-width="1.5" opacity=".9">
      ${flows}
    </g>
    ${hubs}
    ${origin}
    ${meMark}
    <g font-family="-apple-system,sans-serif">
      <rect x="20" y="20" width="420" height="46" rx="8" fill="#1F1F1F" stroke="#313131"/>
      ${badge}
    </g>
  </svg>`;
  }

  // Try the live dashboard first (same machine); fall back to static.
  fetch('http://127.0.0.1:7799/api/geo', { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((geo) => {
      let me = null;
      if (geo && geo.myLocation && typeof geo.myLocation.lat === 'number') {
        const L = geo.myLocation;
        me = {
          x: Math.max(40, Math.min(680, 360 + (L.lon ?? 0) * 2.6)),
          y: Math.max(40, Math.min(320, 170 - (L.lat ?? 0) * 2.6)),
          city: L.city, region: L.region,
        };
      }
      el.innerHTML = hubSVG(REGIONS, me, !!geo);
    })
    .catch(() => { el.innerHTML = hubSVG(REGIONS, null, false); });
})();

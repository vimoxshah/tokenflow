/* download button -> newest release DMG; scroll reveals; tagline word activation */
(function () {
  // resolve the Download CTA to the latest release's .dmg asset
  const btn = document.getElementById('download-btn');
  fetch('https://api.github.com/repos/vimoxshah/tokenflow/releases/latest')
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(rel => {
      const dmg = (rel.assets || []).find(a => a.name.endsWith('.dmg'));
      if (dmg && btn) btn.href = dmg.browser_download_url;
    })
    .catch(() => {}); // keep the releases-page fallback

  // scroll-triggered reveal for sections and cards
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach(n => io.observe(n));

  // tagline: words activate one at a time as they cross a trigger line
  const tag = document.querySelector('.tagline');
  if (tag && 'IntersectionObserver' in window) {
    const words = tag.textContent.trim().split(/\s+/);
    tag.innerHTML = words.map(w =>
      `<span class="w${w === 'honestly.' ? ' accent' : ''}">${w}</span>`).join(' ');
    const spans = tag.querySelectorAll('.w');
    const wio = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('on'); }
    }, { rootMargin: '-35% 0px -35% 0px', threshold: 0 });
    spans.forEach(s => wio.observe(s));
  }
})();

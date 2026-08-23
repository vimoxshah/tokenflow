/* GSAP choreography with a fail-safe guarantee:
   every animated-from-invisible element MUST end visible even if GSAP,
   ScrollTrigger, or any animation errors. Sections must never be blank. */
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function revealAll() {
    document.querySelectorAll('.reveal').forEach(n => { n.style.opacity = '1'; n.style.transform = 'none'; });
  }

  if (!window.gsap || !window.ScrollTrigger || reduceMotion) { revealAll(); return; }
  try {
    gsap.registerPlugin(ScrollTrigger);
  } catch (e) { revealAll(); return; }

  // Safety net: whatever happens below, after 3s force everything on-screen.
  setTimeout(revealAll, 3000);

  // hero entrance choreography
  gsap.from('nav', { y: -64, opacity: 0, duration: .8, ease: 'power3.out' });
  gsap.from('.eyebrow', { opacity: 0, y: 16, duration: .6, delay: .1, ease: 'power2.out' });
  gsap.from('h1', { opacity: 0, y: 28, duration: .9, delay: .2, ease: 'power3.out' });
  gsap.from('.sub', { opacity: 0, y: 20, duration: .7, delay: .38, ease: 'power2.out' });
  gsap.from('.cta .btn', { opacity: 0, y: 16, stagger: .08, duration: .6, delay: .5, ease: 'power2.out' });
  gsap.from('.proof-line', { opacity: 0, duration: .8, delay: .68 });

  const heroSvg = document.querySelectorAll('#hero-visual rect.bar-pop, #hero-visual path.hero-line');
  if (heroSvg.length) {
    gsap.set(heroSvg, { clearProps: 'all' }); // hand bars/lines over to GSAP
    gsap.from('#hero-visual rect.bar-pop',
      { scaleY: 0, transformOrigin: 'bottom', stagger: .05, duration: .7, delay: .5, ease: 'back.out(1.4)' });
    gsap.from('#hero-visual path.hero-line',
      { strokeDasharray: 600, strokeDashoffset: 600, duration: 1.6, delay: .9, ease: 'power2.inOut', stagger: .3 });
    gsap.to('#hero-visual', { y: -12, duration: 3, repeat: -1, yoyo: true, ease: 'sine.inOut', delay: 1.6 });
  }

  // section reveals — wrapped so one failure can't skip the safety net
  try {
    document.querySelectorAll('.reveal').forEach(el => {
      gsap.from(el, { opacity: 0, y: 32, duration: .8, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 85%' } });
    });
  } catch (e) { revealAll(); }

  // tagline words activate one at a time on scroll
  const tag = document.querySelector('.tagline');
  if (tag) {
    const accentWords = new Set(['honestly.']);
    tag.innerHTML = tag.textContent.trim().split(/\s+/).map(w =>
      `<span class="w${accentWords.has(w) ? ' accent' : ''}">${w}</span>`).join(' ');
    gsap.to(tag.querySelectorAll('.w'), { color: (i, t) =>
        t.classList.contains('accent') ? '#8f9dff' : '#f2f4f8',
      stagger: .09, ease: 'none',
      scrollTrigger: { trigger: '#tagline', start: 'top 70%', end: 'top 25%', scrub: true } });
  }

  // comparison chart draws as it enters
  const strip = document.getElementById('chart-strip');
  if (strip && window.buildComparisonChart) {
    buildComparisonChart(strip);
    gsap.from('#chart-strip svg path.drawn', {
      strokeDashoffset: (i, t) => t.getTotalLength(),
      strokeDasharray: (i, t) => t.getTotalLength(),
      duration: 1.8, ease: 'power2.inOut',
      scrollTrigger: { trigger: strip, start: 'top 80%' }
    });
    gsap.from('#chart-strip svg rect.gbar', {
      scaleY: 0, transformOrigin: 'bottom', stagger: .04, duration: .6, ease: 'power2.out',
      scrollTrigger: { trigger: strip, start: 'top 80%' }
    });
  }

  // world map: flows draw themselves, dots fade up in one wave
  const map = document.getElementById('worldmap');
  if (map) {
    const flows = map.querySelectorAll('path.flow');
    flows.forEach(p => { const L = p.getTotalLength(); p.style.strokeDasharray = `4 6`; p.style.strokeDashoffset = L; });
    gsap.to(flows, {
      strokeDashoffset: 0, duration: 1.6, stagger: .3, ease: 'power2.inOut',
      scrollTrigger: { trigger: map, start: 'top 75%' }
    });
    gsap.from(map.querySelectorAll('circle[r="1.6"]'), {
      opacity: 0, duration: .8, stagger: { amount: .9, from: 'random' },
      scrollTrigger: { trigger: map, start: 'top 78%' }
    });
  }

  // feature cards cascade
  const grid = document.getElementById('feature-grid');
  if (grid) gsap.from(grid.querySelectorAll('.card'), {
    opacity: 0, y: 28, stagger: .07, duration: .7, ease: 'power2.out',
    scrollTrigger: { trigger: grid, start: 'top 82%' }
  });
})();

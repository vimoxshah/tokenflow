/* The landing page's only script. Zero dependencies, three jobs:
   1. reveal sections as they enter the viewport (narrative motion tier, 85ms
      stagger, at most seven items) — and reveal everything at once when the
      reader prefers reduced motion or the observer is unavailable;
   2. draw the marginal-cost chart once, when it is seen;
   3. copy install commands to the clipboard with visible confirmation.
   Nothing is fetched, measured or reported. */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

  // ---- reveals -------------------------------------------------------------
  const targets = Array.from(document.querySelectorAll('[data-reveal]'));
  function show(node) { node.classList.add('in'); }
  if (reduce || !('IntersectionObserver' in window)) {
    targets.forEach(show);
  } else {
    root.classList.add('js-reveal');
    // Siblings inside one group stagger; the group index caps at seven so a
    // long list never ends in a broken tail.
    document.querySelectorAll('[data-reveal-group]').forEach((g) => {
      Array.from(g.children).forEach((child, i) => { child.style.setProperty('--i', String(Math.min(i, 6))); });
    });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    targets.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92) show(n); else io.observe(n);
    });
    // Whatever happens, nothing stays hidden for long.
    setTimeout(() => { targets.forEach(show); io.disconnect(); }, 2500);
  }

  // ---- the marginal-cost chart --------------------------------------------
  const chart = document.getElementById('marginal-chart');
  if (chart) {
    const bars = chart.querySelectorAll('.mc-bar');
    const draw = () => chart.classList.add('drawn');
    if (reduce || !('IntersectionObserver' in window)) draw();
    else {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { draw(); io.disconnect(); }
      }, { threshold: 0.4 });
      io.observe(chart);
    }
    bars.forEach((b, i) => b.style.setProperty('--i', String(i)));
  }

  // ---- copy buttons --------------------------------------------------------
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy');
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        btn.classList.add('done');
      } catch (e) {
        // No clipboard permission: select the text so a manual copy is one keystroke away.
        const code = btn.parentElement && btn.parentElement.querySelector('code');
        if (code && window.getSelection) {
          const range = document.createRange(); range.selectNodeContents(code);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        }
        btn.textContent = 'Select + ⌘C';
      }
      setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1600);
    });
  });
})();

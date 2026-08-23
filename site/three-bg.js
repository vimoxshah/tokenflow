/* three.js background: slow parallax particle field of token "points", GPU-cheap */
(function () {
  const canvas = document.getElementById('bg-3d');
  if (!canvas || !window.THREE) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 14;

  // a field of points resembling tokens flowing through pipes
  const N = 900;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - .5) * 40;
    pos[i * 3 + 1] = (Math.random() - .5) * 24;
    pos[i * 3 + 2] = (Math.random() - .5) * 20 - 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x8f9dff, size: 0.06, transparent: true, opacity: .55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  scene.add(new THREE.Points(geo, mat));

  let mx = 0, my = 0;
  window.addEventListener('pointermove', e => {
    mx = (e.clientX / window.innerWidth - .5) * 2;
    my = (e.clientY / window.innerHeight - .5) * 2;
  }, { passive: true });

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // honour reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    renderer.render(scene, camera);
    return;
  }

  let t = 0;
  (function tick() {
    t += 0.0022;
    camera.position.x = mx * 1.2;
    camera.position.y = -my * 0.8;
    camera.lookAt(0, 0, 0);
    geo.attributes.position.needsUpdate = true;
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 2] += 0.008;                    // drift toward viewer
      if (pos[i * 3 + 2] > 8) pos[i * 3 + 2] = -12; // recycle
    }
    mat.opacity = .35 + Math.sin(t * 8) * .15;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  })();
})();

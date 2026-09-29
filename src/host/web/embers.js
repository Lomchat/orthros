// Rising embers behind the home screen: a few dozen square sparks (pixel art, like the hound) drifting up from the
// hound's feet and the bottom of the window. One canvas, one requestAnimationFrame loop; stop() ends it for good —
// nothing here may compete with the emulator for the frame budget once a game starts.
const COLORS = ['#ffd9a0', '#ffb56b', '#f8901f', '#f8901f', '#e0242a', '#b75d14'];

/**
 * @param {HTMLCanvasElement} canvas  fixed, full-window canvas
 * @param {() => ({ x: number, y: number, w: number } | null)} [origin]  where sparks are born besides the window's
 *   bottom edge (viewport coordinates: the hound's feet), or null when it is out of view
 * @returns {{ stop(): void }}
 */
export function startEmbers(canvas, origin = () => null) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) return { stop() {} };
  const ctx = canvas.getContext('2d');
  const sparks = [];
  let w = 0, h = 0, dpr = 1, raf = 0, last = 0, t = 0, stopped = false;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.max(24, Math.min(70, Math.round(w * h / 26000)));
    while (sparks.length < want) sparks.push(spawn({}, true));
    sparks.length = want;
  }
  /** (Re)birth of a spark; `anywhere`: at a random height (the first fill), else at its source. */
  function spawn(s, anywhere = false) {
    const o = Math.random() < 0.6 ? origin() : null;
    s.x = o ? o.x + rnd(0, o.w) : rnd(0, w);
    s.y = anywhere ? rnd(0, h) : (o ? o.y : h) + rnd(0, 24);
    s.vx = rnd(-7, 7); s.vy = -rnd(16, 52);
    s.size = Math.random() < 0.12 ? 4 : Math.random() < 0.5 ? 3 : 2;
    s.age = anywhere ? rnd(0, 6) : 0; s.ttl = rnd(4.5, 10);
    s.phase = rnd(0, 6.28); s.color = COLORS[(Math.random() * COLORS.length) | 0];
    return s;
  }
  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now; t += dt;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const s of sparks) {
      s.age += dt;
      if (s.age > s.ttl || s.y < -8) { spawn(s); continue; }
      s.x += (s.vx + Math.sin(t * 0.9 + s.phase) * 9) * dt; s.y += s.vy * dt;
      const life = s.age / s.ttl, fade = Math.sin(Math.PI * life) ** 0.8;
      ctx.globalAlpha = Math.max(0, fade * (0.55 + 0.45 * Math.sin(t * 6 + s.phase)) * 0.9);
      ctx.fillStyle = s.color;
      const q = 2; // (snapped to a 2 px grid: the stepped movement of pixel art)
      ctx.fillRect(Math.round(s.x / q) * q, Math.round(s.y / q) * q, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  const ro = new ResizeObserver(resize); ro.observe(canvas);
  resize();
  raf = requestAnimationFrame(frame);
  return { stop() { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); ctx.clearRect(0, 0, canvas.width, canvas.height); } };
}

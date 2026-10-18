// Put into the OpenMW engine's pages by the Orthros server (src/host/server.js): what the Orthros page around the
// engine shows in its header — the frame rate (a frame: an animation frame in which the engine drew) and whether the
// game has the mouse. Told to the page by messages of its origin; nothing changes in the engine.
(() => {
  if (window.parent === window) return;
  const tell = (m) => window.parent.postMessage(m, location.origin);
  let draws = 0, seen = 0, frames = [];
  for (const type of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!type) continue;
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = type.prototype[method]; if (!original) continue;
      type.prototype[method] = function (...args) { draws++; return original.apply(this, args); };
    }
  }
  const tick = (t) => { if (draws !== seen) { seen = draws; frames.push(t); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const now = performance.now(); frames = frames.filter((t) => t > now - 1000);
    const recent = frames.filter((t) => t > now - 500), gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
    tell({ type: 'orthros-frames', fps: recent.length * 2, max: gaps.at(-1) ?? 0, p99: gaps[Math.floor(gaps.length * 0.99)] ?? 0, total: draws > 0 });
  }, 500);
  const lock = () => tell({ type: 'orthros-pointer', locked: !!document.pointerLockElement });
  document.addEventListener('pointerlockchange', lock);
  // (the page asks: the game gets the mouse — a click on its canvas does the same)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'orthros-capture') return;
    const canvas = document.querySelector('canvas'); canvas?.focus(); canvas?.requestPointerLock?.()?.catch?.(() => {});
  });
  lock();
})();

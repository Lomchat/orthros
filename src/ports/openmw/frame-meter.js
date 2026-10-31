// Put into the OpenMW engine's pages by the Orthros server (src/host/server.js): what the Orthros page around the
// engine shows in its header — the frame rate (a frame: an animation frame in which the engine drew) and whether the
// game has the mouse — and on its loading screen (the engine's download). Told to the page by messages of its origin;
// nothing changes in the engine. The frames' last measure is the engine page's too (window.orthrosFrames: its view
// distance's growth holds while frames are long, view-grow.js).
(() => {
  const framed = window.parent !== window;
  const tell = (m) => { if (framed) window.parent.postMessage(m, location.origin); };
  let draws = 0, seen = 0, frames = [], glc = null;
  // (an engine drawing on its own thread, OPENMW_ORTHROS_DRAWTHREAD: no WebGL call on this page — its frames are the
  // pictures it hands to the page, window.__omwDrawThreadFrames; no GPU time then, gl() stays null)
  const drawn = () => draws + (window.__omwDrawThreadFrames ?? 0);
  for (const type of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!type) continue;
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = type.prototype[method]; if (!original) continue;
      type.prototype[method] = function (...args) { draws++; glc = this; return original.apply(this, args); };
    }
  }
  const tick = (t) => { const d = drawn(); if (d !== seen) { seen = d; frames.push(t); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  // the engine's frame timed whole (its pump, Module._omw_pump_frame): `done(ms, suspendedMs)` once it ended — a frame
  // that suspends while it waits for the game's files (the Orthros build's JSPI, orthros-r20.patch) returns a promise
  // and ends when it settles, its time then the whole of it, `suspendedMs` the part the engine stood suspended
  // (Module.orthrosSuspendedMs) —; `f` timed returned (the bench hooks below, tools/openmw/perf.mjs)
  window.orthrosFrameTimer = (f, done) => function (...a) {
    const M = window.Module, t0 = performance.now(), s0 = M?.orthrosSuspendedMs ?? 0;
    const end = () => { try { done(performance.now() - t0, (M?.orthrosSuspendedMs ?? 0) - s0); } catch { /* the meter's */ } };
    let r;
    try { r = f.apply(this, a); } catch (e) { end(); throw e; }
    if (r && typeof r.then === 'function') r.then(end, end); else end();
    return r;
  };
  setInterval(() => {
    const now = performance.now(); frames = frames.filter((t) => t > now - 1000);
    const recent = frames.filter((t) => t > now - 500), gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
    const m = { type: 'orthros-frames', fps: recent.length * 2, max: gaps.at(-1) ?? 0, p99: gaps[Math.floor(gaps.length * 0.99)] ?? 0, total: drawn() > 0 };
    window.orthrosFrames = m; tell(m);
  }, 500);
  // the bench suite around this page (src/host/web/bench-suite.js, ?benchrun=): what its frame measurement and scripted
  // input use (page-meter.js hooks) — the engine's work a frame (its pump, Module._omw_pump_frame, timed), its debug
  // teleport, its data reads waited for (streamfs.js)
  if (/[?&]benchrun=/.test(location.search)) {
    let workMs = 0;
    const wrap = setInterval(() => {
      const M = window.Module, f = M?._omw_pump_frame; if (!f || f.orthrosTimed) return;
      const timed = window.orthrosFrameTimer(f, (ms) => { workMs += ms; });
      timed.orthrosTimed = true; M._omw_pump_frame = timed; clearInterval(wrap);
    }, 100);
    window.orthrosBenchHooks = {
      workMs: () => (window.Module?._omw_pump_frame?.orthrosTimed ? workMs : undefined),
      teleport: (x, y, z) => window.Module?._omw_debug_teleport?.(x, y, z),
      data: () => { const s = window.__streamfsStats; return s ? { waits: s.misses ?? 0, waitMs: s.stallMs ?? 0, bytes: s.fetchedBytes ?? 0 } : null; },
    };
  }
  // the passive session record (src/host/web/perf-page.js, docs/real-machine-bench.md "Passive session records"): the
  // engine's frames (browser frames with draws), its GPU time on its context, the game data's waits (streamfs.js),
  // the phase (loading, the menus, the world: view-grow.js), the quality tier (tier.js) and the browser's storage — the
  // Orthros page's (play.js asks persistence as the game starts), else this page's own, asked here
  Promise.all([import('/src/host/web/perf-page.js'), import('/src/ports/openmw/view-grow.js'), import('/src/host/web/storage-persist.js')]).then(([perf, view, sp]) => {
    const id = decodeURIComponent(location.pathname.split('/')[3] ?? '');
    let storage = null; try { storage = framed ? window.parent.orthrosStorage ?? null : null; } catch { /* another origin */ }
    if (!storage) { storage = sp.pageStorage(); storage.ask(); }
    window.orthrosPerf = perf.portPerf({ runtime: 'openmw', game: id, session: Math.random().toString(36).slice(2, 14), version: null, bench: new URLSearchParams(location.search).get('benchrun'),
      tier: () => window.orthrosTierChoice?.tier ?? null, phase: () => (!drawn() ? 'loading' : view.inWorld(window) ? 'world' : 'menu'),
      data: () => perf.portDataSummary(window.StreamFS?.data?.() ?? null),
      gl: () => glc, draws: drawn, storage });
  }).catch((e) => console.warn('[orthros perf]', e));
  // the engine's loading status (Module.setStatus, src/host/openmw.js): its package download, "Downloading data...
  // (x/y)" many times a second (a few told), then "Running..."
  if (!framed) return;
  let told = 0;
  window.orthrosStatus = (text) => {
    if (!text) return;
    const now = performance.now(), got = /\((\d+)\/(\d+)\)/.exec(text);
    if (got && +got[1] < +got[2] && now - told < 250) return;   // (the last one always: the download's end)
    told = now; tell({ type: 'orthros-status', text: String(text) });
  };
  const lock = () => tell({ type: 'orthros-pointer', locked: !!document.pointerLockElement });
  document.addEventListener('pointerlockchange', lock);
  // (the page asks: the game gets the mouse — a click on its canvas does the same)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'orthros-capture') return;
    const canvas = document.querySelector('canvas'); canvas?.focus(); canvas?.requestPointerLock?.()?.catch?.(() => {});
  });
  lock();
})();

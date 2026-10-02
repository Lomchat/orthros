// The emulator worker's side of the render worker (docs/render-worker.md, D063): `host.gfx` objects that give each
// Direct3D device a Recorder (d3d-recorder.js) instead of the WebGL backend, and replay its commands either on this
// same thread (?glworker=inline: the fidelity check of the recording, one thread) or in a render worker
// (?glworker=1: src/gfx/render-worker.js, its own OffscreenCanvas and WebGL2 context, frames posted to the page).
// Both answer what the worker reads of `host.gfx` (programCache, device stats, prewarm/afterSlice/beforeSlice).
import { createWebGLBackend } from './d3d8-webgl.js';
import { Replayer, compareDevice } from './d3d-mirror.js';
import { RenderLink, Recorder } from './d3d-recorder.js';
import { CTL, CTL_WORDS, ACK_SLOTS } from './cmd-ring.js';

/** command ring size in words (16 MiB) */
export const RING_WORDS = 1 << 22;

/**
 * ?glworker=inline (and =check): the backend on this thread, fed through the ring — what a render worker would do,
 * replayed at presents, readbacks and fences. `check`: replayed after every draw and the mirror compared with the
 * device field by field (mismatches logged).
 */
export function createInlineGfx(canvas, log, dump, { check = false, beforePresent = null } = {}) {
  const inner = createWebGLBackend(canvas, log, dump);
  if (!inner) return null;
  const words = new Int32Array(1 << 20), ack = new Int32Array(ACK_SLOTS).fill(-1);
  const replayer = new Replayer(words, {
    mem: null, ack, createBackend: (m) => inner.createDevice(m), beforePresent,
    onCanvas: (w, h) => { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } },
  });
  const link = new RenderLink({ words, replayer, ack, log });
  let checks = 0, mismatches = 0;
  const gfx = {
    mode: check ? 'check' : 'inline', gl: inner.gl, programCache: inner.programCache, link,
    get device() { return inner.device; },
    prewarm() { inner.prewarm(); },
    afterSlice() { inner.afterSlice(); },
    beforeSlice(ms) { inner.beforeSlice(ms); },
    gpuFramesBehind() { return inner.gpuFramesBehind(); },
    createDevice(dev) {
      replayer.mem ??= dev.proc.mem;
      const rec = new Recorder(link, dev);
      if (check) {
        const work = rec.workDone.bind(rec);
        rec.workDone = () => {
          work(); link.publish(true);
          const m = replayer.devices.get(rec.id); if (!m) return;
          checks++;
          const diff = compareDevice(dev, m, 8);
          if (diff.length && ++mismatches <= 20) log(`render check: mirror differs from the device at draw ${checks}: ${diff.join('; ')}`);
          if (checks % 20000 === 0) log(`render check: ${checks} draws compared, ${mismatches} with differences`);
        };
      }
      return rec;
    },
    /** the display's size: the canvas frames are presented on (ordered with the recorded presents) */
    canvasResized(w, h) { link.canvas(w, h); },
    stats() { return { ...link.stats, replayMs: link.replayMs ?? 0, checks, mismatches }; },
  };
  return gfx;
}

/**
 * ?glworker=1: a render worker replays the commands with its own canvas and WebGL2 context. `start(memory)` once the
 * guest memory exists (shared: the render worker reads resource contents from it), awaited before the guest runs
 * (true: ready). If the render worker does not
 * come up within 10 s, dies, or stops making progress while the emulator waits for it, `onFail(reason)` is called:
 * the worker then gives every device the in-thread backend (the emulator's device was the reference all along).
 */
export function createRemoteGfx({ log, onFail, workerUrl }) {
  const ringSab = new SharedArrayBuffer(RING_WORDS * 4), ctlSab = new SharedArrayBuffer(CTL_WORDS * 4), ackSab = new SharedArrayBuffer(ACK_SLOTS * 4);
  const words = new Int32Array(ringSab), ctl = new Int32Array(ctlSab), ack = new Int32Array(ackSab).fill(-1);
  const remoteStats = new Map();
  const programCache = { queue: { length: 0 }, ready: new Map(), learned: [], used: [], started: 0, hits: 0, pending: 0, devices: new Set(), remote: true };
  let worker = null, readyTimer = null, failed = false, deviceProxy = null, settle = null;
  const gfx = {
    mode: 'worker', gl: null, programCache, ready: false, replay: { ms: 0, frames: 0 },
    link: null,
    get device() { return deviceProxy; },
    prewarm() {},
    afterSlice() { if (!failed) gfx.link.publish(true); },
    beforeSlice() {},
    createDevice(dev) {
      const rec = new Recorder(gfx.link, dev);
      deviceProxy = { get stats() { return gfx.link.statsFor(rec.id); }, get frame() { return gfx.link.frames; }, set captureAt(v) { worker?.postMessage({ type: 'capture', at: v }); }, set captureDraws(v) { worker?.postMessage({ type: 'capture', draws: v }); }, set countFrames(v) { worker?.postMessage({ type: 'capture', count: v }); } };
      return rec;
    },
    canvasResized(w, h) { gfx.link.canvas(w, h); },
    /** messages for the render worker (debug globals, captures, context loss tests) */
    post(m) { worker?.postMessage(m); },
    stats() { return { ...gfx.link.stats, replayMs: gfx.replay.ms }; },
    start(memory, opts, pagePort) {
      worker = new Worker(workerUrl, { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { gfx.ready = true; clearTimeout(readyTimer); log(`render worker: ready (${m.renderer})`); settle?.(); }
        else if (m.type === 'failed') { fail(`render worker could not start: ${m.reason}`); settle?.(); }
        else if (m.type === 'stats') { for (const [id, s] of m.devices) remoteStats.set(id, s); Object.assign(programCache, m.programCache, { queue: { length: m.programCache.queueLength ?? 0 } }); gfx.replay = m.replay; }
        else if (m.type === 'log') log(m.msg);
        else if (m.type === 'compare') gfx.onCompare?.(m);
      };
      worker.onerror = (e) => { fail(`render worker error: ${e.message ?? e}`); settle?.(); };
      readyTimer = setTimeout(() => { if (!gfx.ready) fail('render worker not ready after 10 s'); settle?.(); }, 10000); // (a loaded machine included)
      worker.postMessage({ type: 'init', memory, ring: ringSab, ctl: ctlSab, ack: ackSab, port: pagePort, opts }, [pagePort]);
      // (the emulator waits for it before running the guest: a nested worker's scripts load through its parent's
      // thread, which must not be blocked meanwhile — waiting for a render worker that cannot load would never end)
      return new Promise((r) => { settle = () => { settle = null; r(gfx.ready && !failed); }; if (gfx.ready || failed) settle(); });
    },
  };
  const fail = (reason) => { if (failed) return; failed = true; gfx.link.fail(reason); };
  gfx.link = new RenderLink({ words, ctl, ack, log, onFail: (reason) => { failed = true; try { worker?.terminate(); } catch { /* gone */ } onFail?.(reason, [...gfx.link.recorders]); } });
  gfx.link.remoteStats = remoteStats;
  void CTL;
  return gfx;
}

/** Compare two frames' pixels: null when identical, else a description of the differences. */
export function compareFrames(a, b) {
  if (!a || !b) return 'missing frame';
  if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} / ${b.w}x${b.h}`;
  let n = 0, max = 0, first = -1;
  for (let i = 0; i < a.px.length; i += 4) {
    const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]), Math.abs(a.px[i + 3] - b.px[i + 3]));
    if (d) { n++; if (d > max) max = d; if (first < 0) first = i; }
  }
  if (!n) return null;
  const x = (first / 4) % a.w, y = a.h - 1 - Math.floor(first / 4 / a.w);
  return `${n} of ${a.w * a.h} pixels differ (largest channel difference ${max}; first at ${x},${y}: ${Array.from(a.px.subarray(first, first + 4))} / ${Array.from(b.px.subarray(first, first + 4))})`;
}

/**
 * ?glworker=compare (inline replay) / compare-worker (render worker): the in-thread backend renders and presents as
 * usual (the reference) while every device's work is also recorded and replayed into a second WebGL context; every
 * `every` frames both back buffers are read just before the present and compared — the same scene, pixel for pixel.
 */
export function createCompareGfx(canvas, log, dump, { every = 60, remote = null } = {}) {
  const ref = createWebGLBackend(canvas, log, dump);
  if (!ref) return null;
  let compared = 0, differing = 0;
  const report = (frame, refPx, other) => {
    const d = compareFrames(refPx, other);
    compared++; if (d) differing++;
    if (d || compared <= 3 || compared % 20 === 0) log(`render compare: frame ${frame}: ${d ?? 'identical'} (${compared} frames compared, ${differing} differing)`);
  };
  const pending = new Map();
  let side;
  if (remote) { side = remote; remote.onCompare = (m) => { const r = pending.get(m.frame); pending.delete(m.frame); if (r) report(m.frame, r, m.snap); }; }
  else {
    const replayCanvas = new OffscreenCanvas(canvas.width, canvas.height);
    side = createInlineGfx(replayCanvas, (m) => log(`[replay] ${m}`), null, { beforePresent: (m, frame) => { if (frame % every === 0 && m.gfx) { const r = pending.get(frame); pending.delete(frame); if (r) report(frame, r, m.gfx.readBackBuffer()); } } });
  }
  const tee = (refDev, rec) => new Proxy({}, {
    get(t, k) {
      if (k === 'present') return (...a) => { const frame = side.link.frames + 1; if (frame % every === 0) pending.set(frame, refDev.readBackBuffer()); rec.present(...a); return refDev.present(...a); };
      if (k === 'copyRects') return (...a) => refDev.copyRects(...a);
      if (k === 'stats' || k === 'frame') return refDev[k];
      const fr = typeof refDev[k] === 'function', fc = typeof rec[k] === 'function';
      if (fr && fc) return (...a) => { rec[k](...a); return refDev[k](...a); };
      if (fc) return (...a) => rec[k](...a);
      if (fr) return (...a) => refDev[k](...a);
      return refDev[k];
    },
    set(t, k, v) { refDev[k] = v; return true; },
  });
  return {
    mode: remote ? 'compare-worker' : 'compare', gl: ref.gl, programCache: ref.programCache, link: side.link,
    get device() { return ref.device; },
    prewarm() { ref.prewarm(); }, afterSlice() { ref.afterSlice(); side.afterSlice(); }, beforeSlice(ms) { ref.beforeSlice(ms); },
    createDevice(dev) { const refDev = ref.createDevice(dev); const rec = side.createDevice(dev); return tee(refDev, rec); },
    canvasResized(w, h) { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } side.canvasResized(w, h); },
    post: remote ? (m) => remote.post(m) : undefined,
    start: remote ? (...a) => remote.start(...a) : undefined,
    stats() { return { ...side.stats(), compared, differing }; },
  };
}

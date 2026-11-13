// GpuProbe's idle-free views (docs/real-machine-bench.md): a draw-run query on alternate frames of a window, and a fence
// latency per sampled frame, with a scripted GL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProbe } from '../src/gfx/gpu-probe.js';

test('window: even frames time present to present, odd ones the draw run, fences give the backlog', () => {
  let t = 0, active = null, nsNext = 0;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2, ready: false,
    getExtension: () => ({}), createQuery: () => ({}), deleteQuery() {}, deleteSync() {},
    beginQuery(_, q) { assert.equal(active, null, 'one TIME_ELAPSED at a time'); active = q; },
    endQuery() { assert.ok(active); active.ns = nsNext; active = null; },
    getQueryParameter: (q, p) => (p === 1 ? true : q.ns), getParameter: () => false,
    fenceSync: () => ({ done: false }), getSyncParameter: () => (t >= 100 ? 0x9119 : 0x9118),
  };
  const p = new GpuProbe(gl, { now: () => t, wrapGl: false });
  t = 4000; // the first window opens at the next present
  for (let f = 0; f < 20; f++) {
    p.endRun(); nsNext = 5e6; // present starts; a query ending now measured 5 ms
    t += 10; if (t > 100 && t < 4000) t = 4000 + f;
    p.frame();
    if (p.hot) p.draw(); // the next frame's first draw
  }
  p.endRun(); p.frame();
  const g = p.stats.gpu;
  assert.ok(g.frames >= 8 && g.runFrames >= 8, `frame ${g.frames} run ${g.runFrames}`);
  assert.equal(g.runMs / g.runFrames, 5);
  assert.ok(g.fenceN > 0, 'fences resolved');
});

test('a run-timed frame that draws nothing never nests a query into the next frame', () => {
  let active = null;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => ({}), createQuery: () => ({}), deleteQuery() {}, deleteSync() {},
    beginQuery(_, q) { assert.equal(active, null, 'one TIME_ELAPSED at a time'); active = q; },
    endQuery() { assert.ok(active, 'an active query ended'); active.ns = 1e6; active = null; },
    getQueryParameter: (q, p) => (p === 1 ? true : q.ns), getParameter: () => false,
    fenceSync: () => ({}), getSyncParameter: () => 0x9119,
  };
  let t = 0;
  const p = new GpuProbe(gl, { now: () => t, wrapGl: false });
  t = 4000; // (the first window opens at the next present)
  // frames with no draw at all (a loading screen): the run armed by an odd frame must not outlive it — the next
  // frame's present-to-present query is active, a draw then would begin a second one
  for (let f = 0; f < 4; f++) { p.endRun(); t += 10; p.frame(); }
  p.draw();
});

test('the render loop reads a frame\'s fence when it wakes, not at the next frame (a real GPU done in a few ms)', async () => {
  // (regression: the owner's RTX 4050 read fence 44.75 ms for a 3.75 ms draw run — fences were only polled at the next
  // frame's draws and present; the emulator paces 30 fps, so nothing else woke the probe in between)
  const { replayLoop } = await import('../src/gfx/render-loop.js');
  const { CTL_WORDS } = await import('../src/gfx/cmd-ring.js');
  let signalAt = Infinity;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2, getExtension: () => ({}), createQuery: () => ({}), deleteQuery() {}, deleteSync() {},
    beginQuery() {}, endQuery() {}, getQueryParameter: () => false, getParameter: () => false,
    fenceSync: () => ({}), getSyncParameter: () => (performance.now() >= signalAt ? 0x9119 : 0x9118),
  };
  const p = new GpuProbe(gl, { wrapGl: false });
  p.nextWindow = 0; p.frame(); // (a window opens: the next present sets a fence)
  p.frame(); assert.equal(p.fences.length, 1);
  signalAt = performance.now() + 3; // (the GPU finishes 3 ms after the present)
  const ctl = new Int32Array(new SharedArrayBuffer(CTL_WORDS * 4));
  const replayer = { reader: { consumed: 0 }, tail: () => 0, staticFrames: null };
  const backend = { device: {}, prewarm() {}, afterSlice() {}, beforeSlice() {}, wake: () => p.wake() };
  const t0 = performance.now();
  await replayLoop(ctl, replayer, backend, { ms: 0, waitMs: 0 }, () => p.stats.gpu.fenceN > 0 || performance.now() - t0 > 500);
  const g = p.stats.gpu;
  assert.equal(g.fenceN, 1, 'the fence was read while the loop slept');
  // (~8 ms alone; 18.7 ms seen inside a parallel make test — real timers on a loaded machine: the bound tells a wake-up
  // read, a few ms late at worst, from the old next-frame read, never within 500 ms)
  assert.ok(g.fenceMs < 100, `fence ${g.fenceMs.toFixed(1)} ms for a GPU done in 3 ms`);
});

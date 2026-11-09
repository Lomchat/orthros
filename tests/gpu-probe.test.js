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
  const p = new GpuProbe(gl, { now: () => 4000, wrapGl: false });
  // frames with no draw at all (a loading screen): the armed run must not survive into a present-to-present frame
  for (let f = 0; f < 6; f++) { p.endRun(); p.frame(); if (f % 2) p.draw(); }
  for (let f = 0; f < 6; f++) { p.endRun(); p.frame(); p.draw(); }
});

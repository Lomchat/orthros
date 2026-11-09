// Adaptive internal render resolution (src/gfx/render-scale.js): the Direct3D rectangles land on the same part of the
// picture in a scaled target's GL storage, a readback of a scaled target returns its Direct3D size, and the controller
// does not oscillate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glRect, glEdgeX, glEdgeY, ScaleController, scaleMode } from '../src/gfx/render-scale.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';

test('viewport / scissor / clear rectangles: unscaled as before, scaled edges rounded and still adjacent', () => {
  // unscaled: the formula the backend always used (GL rows up for a back buffer, D3D rows for a texture target)
  assert.deepEqual(glRect(100, 50, 300, 250, 600, false, 1, 1), [100, 350, 200, 200]);
  assert.deepEqual(glRect(100, 50, 300, 250, 600, true, 1, 1), [100, 50, 200, 200]);
  // half scale: the full viewport covers the whole storage, a sub-rectangle the same part of it
  assert.deepEqual(glRect(0, 0, 800, 600, 600, false, 0.5, 0.5), [0, 0, 400, 300]);
  assert.deepEqual(glRect(100, 50, 300, 250, 600, false, 0.5, 0.5), [50, 175, 100, 100]);
  // two rectangles side by side at an odd scale: the second starts where the first ends
  const k = 683 / 1024, a = glRect(0, 0, 333, 768, 768, false, k, k), b = glRect(333, 0, 1024, 768, 768, false, k, k);
  assert.equal(a[0] + a[2], b[0]); assert.equal(b[0] + b[2], 683);
  // StretchRect edges: the flip of each surface, then its scale
  const back = { flip: false, dh: 600, kx: 0.5, ky: 0.5 }, tex = { flip: true, dh: 600, kx: 1, ky: 1 };
  assert.deepEqual([glEdgeX(back, 800), glEdgeY(back, 0), glEdgeY(back, 600)], [400, 300, 0]);
  assert.deepEqual([glEdgeX(tex, 800), glEdgeY(tex, 0), glEdgeY(tex, 600)], [800, 0, 600]);
});

test('a readback of a scaled back buffer returns the Direct3D size (blitted up from the smaller storage)', () => {
  const G = fakeGl(800, 600), prev = globalThis.ORTHROS_RENDER_SCALE;
  globalThis.ORTHROS_RENDER_SCALE = 0.5; // (fixed: on any GPU)
  try {
    const u8 = new Uint8Array(800 * 600 * 4);
    const bb = { id: 7, width: 800, height: 600, fmt: 22, usage: 1, pitch: 3200, mem: 0, ensureMem() { return 0; } };
    const dev = { proc: { mem: { u8 } }, pp: { width: 800, height: 600 }, backBuffers: [bb], renderTarget: null, viewport: { x: 0, y: 0, w: 800, h: 600, minZ: 0, maxZ: 1 } };
    const d = new WebGLDevice(G.gl, dev, { software: false });
    assert.equal(d.rscale, 0.5);
    d.readbackSurface(bb);
    const call = (name) => G.calls.filter((c) => c[0] === name);
    assert.ok(call('renderbufferStorage').some((c) => c[3] === 400 && c[4] === 300), 'the back buffer stored at 400x300');
    assert.ok(call('blitFramebuffer').some((c) => c.slice(1, 9).join() === '0,0,400,300,0,0,800,600'), 'blitted up to 800x600');
    const rp = call('readPixels'); assert.equal(rp.length, 1); assert.deepEqual(rp[0].slice(1, 5), [0, 0, 800, 600]);
  } finally { globalThis.ORTHROS_RENDER_SCALE = prev; }
});

test('controller: steps down when render-bound, not back up while the next step would be over budget', () => {
  assert.equal(scaleMode(undefined, false).mode, 'off'); assert.equal(scaleMode('auto', true).mode, 'auto'); assert.equal(scaleMode(0.6, false).s, 0.6);
  const c = new ScaleController(), B = 1000 / 30;
  let s = 1, t = 0;
  // 66 ms frames, render 64 ms at scale 1 (pixel-bound: render time ~ pixels)
  const render = (sc) => 8 + 56 * sc * sc;
  for (; t < 30000; t += 66) { c.add(t, s, Math.max(B, render(s)), render(s)); const n = c.decide(t, s, B); if (n !== s) { c.changed(t); s = n; } }
  assert.ok(s < 1 && s >= 0.5, `stepped down to ${s}`);
  assert.ok(render(s) <= B, 'until the render fits the budget');
  // stays there: the next step up would not fit
  const before = s;
  for (; t < 60000; t += 33) { c.add(t, s, B, render(s)); const n = c.decide(t, s, B); if (n !== s) { c.changed(t); s = n; } }
  assert.equal(s, before);
});

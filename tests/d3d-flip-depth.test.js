// A flipping swap chain (D3DSWAPEFFECT_FLIP, two back buffers: Age of the Ring's "swap 2 x2") rotates its color
// buffers at each Present; the depth-stencil surface is not part of the chain (Direct3D 9: its contents stay unless
// D3DPRESENTFLAG_DISCARD_DEPTHSTENCIL). The backend gave each back buffer's framebuffer a depth-stencil of its own and
// rotated them with the colors: the frame after a present tested against the depth and stencil of the frame before
// the previous one — a picture that depends on depth or stencil left by the previous frame alternated between two
// histories, one per framebuffer. Also checked: the frame's command signature the flicker probe compares (d3d8-webgl.js
// sigMix) is the same for the same work whichever back buffer it went into — else every sample would look like the
// game alternating its commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';

const X8R8G8B8 = 22, FLIP = 2, D24S8 = 75, CLEAR_TARGET = 1, CLEAR_ZBUFFER = 2, CLEAR_STENCIL = 4;

for (const recorded of [false, true]) {
  test(`the back buffers of a flipping chain rotate, the depth-stencil does not${recorded ? ' (render worker)' : ''}`, () => {
    const { gl, calls } = fakeGl(320, 240), sigs = [];
    const probe = { flicker: { present: (fbo, w, h, dev, sig) => { sigs.push(sig); return false; } }, endRun() {}, frame() {} }; // (every frame signed: sigOn)
    const backend = (dev) => { const b = new WebGLDevice(gl, dev, {}); b.probe = probe; b.sigOn = true; return b; };
    let gfx = { createDevice: backend }, link = null;
    if (recorded) {
      const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: backend });
      link = new RenderLink({ words, replayer, ack });
      gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
    }
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16);
    // (width, height, format, back buffers 2, no multisampling, FLIP, hwnd, fullscreen, automatic D24S8 depth-stencil)
    [320, 240, X8R8G8B8, 2, 0, 0, FLIP, 0, 0, 1, D24S8, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    // frame 1 clears depth and stencil, frames 2 and 3 only the color: they keep testing against frame 1's depth
    calls.length = 0;
    for (const flags of [CLEAR_TARGET | CLEAR_ZBUFFER | CLEAR_STENCIL, CLEAR_TARGET, CLEAR_TARGET]) {
      call('BeginScene'); call('Clear', 0, 0, flags, 0xff000000, 0x3e800000, 0); call('EndScene');
      assert.equal(call('Present', 0, 0, 0, 0), 0);
    }
    link?.publish(true);
    // (the GL calls as a working context would see them: the framebuffer bound and the depth attached to each)
    const FB = gl.FRAMEBUFFER, DS = gl.DEPTH_STENCIL_ATTACHMENT, depthOf = new Map(), frames = [];
    let bound = null;
    for (const [k, ...a] of calls) {
      if (k === 'bindFramebuffer' && (a[0] === FB || a[0] === gl.DRAW_FRAMEBUFFER)) bound = a[1];
      else if (k === 'framebufferRenderbuffer' && a[1] === DS) depthOf.set(bound, a[3]);
      else if (k === 'clear') frames.push({ fbo: bound, depth: depthOf.get(bound) });
    }
    frames.splice(0, frames.length - 3); // (the render worker's backend, made as the work is replayed, clears the canvas first)
    assert.equal(frames.length, 3, 'one clear per frame');
    assert.notEqual(frames[1].fbo, frames[0].fbo, 'the second frame draws into the other back buffer');
    assert.equal(frames[2].fbo, frames[0].fbo, 'the third into the first again');
    assert.ok(frames[0].depth, 'a depth-stencil attached');
    assert.equal(frames[1].depth, frames[0].depth, 'the depth-stencil written in frame 1 is the one frame 2 tests against');
    assert.equal(frames[2].depth, frames[0].depth);
    assert.equal(sigs.length, 3);
    assert.equal(sigs[2], sigs[1], 'the same work, the same signature, in either back buffer');
    assert.notEqual(sigs[1], sigs[0], 'another clear, another signature');
  });
}

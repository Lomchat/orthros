// Floating-point render targets (Direct3D 9 R32F, R16F...): a game that keeps depth in an R32F texture for its shadow
// map (SAGE: Age of the Ring, Rise of the Witch-king) must get one — offered by CheckDeviceFormat and stored as floats.
// Before, R32F was not offered: the shadow maps were never created, and an 8-bit storage would have shown as shadow acne
// crawling with the camera. A channel the format lacks reads 1, as in Direct3D: it is cleared to 1 and never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';

const R32F = 114, RT = 1, TEXTURE = 3, X8R8G8B8 = 22;

/** a Direct3D 9 device on a fake GL with EXT_color_buffer_float; recorded: through the render worker's command ring */
function setup(recorded) {
  const { gl, calls } = fakeGl(320, 240, { extensions: ['EXT_color_buffer_float', 'OES_texture_float_linear'] });
  let gfx = { createDevice: (dev) => new WebGLDevice(gl, dev, {}) }, link = null;
  if (recorded) {
    const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
    const replayer = new Replayer(words, { mem: null, ack, createBackend: (m) => new WebGLDevice(gl, m, {}) });
    link = new RenderLink({ words, replayer, ack });
    gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
  }
  const E = d3dEnv(gfx);
  const { mem, ctx, com } = E;
  const pp = E.alloc(64), out = E.alloc(64), verts = E.alloc(256);
  [320, 240, X8R8G8B8, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
  assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  for (let i = 0; i < 18; i++) mem.writeF32(verts + 4 * i, i % 3 === 2 ? 0.5 : (i * 7) % 5);
  return { gl, calls, mem, ctx, com, d3d, d3dPtr, call, out, verts, flush: () => link?.publish(true) };
}

for (const recorded of [false, true]) {
  test(`an R32F render-target texture is offered, stored as floats and drawn with its red channel only${recorded ? ' (render worker)' : ''}`, () => {
    const { gl, calls, mem, ctx, com, d3d, d3dPtr, call, out, verts, flush } = setup(recorded);
    assert.equal(d3d.CheckDeviceFormat(ctx([d3dPtr, 0, 1, X8R8G8B8, RT, TEXTURE, R32F])), 0, 'R32F render-target textures offered');
    assert.equal(call('CreateTexture', 64, 64, 1, RT, R32F, 0, out, 0), 0);
    const tex = mem.read32(out);
    assert.equal(com.implAt(tex).GetSurfaceLevel(ctx([tex, 0, out])), 0);
    assert.equal(call('SetRenderTarget', 0, mem.read32(out)), 0);
    calls.length = 0;
    call('Clear', 0, 0, 1, 0xff808080, 0x3f800000, 0);
    call('SetFVF', 0x102);
    call('DrawPrimitiveUP', 4, 1, verts, 20);
    flush();
    // (the render worker replays the device's creation too: what follows the target's own initialization)
    const alloc = calls.findIndex((c) => c[0] === 'texImage2D' && c[4] === 64), init = calls.findIndex((c) => c[0] === 'clearBufferfv');
    assert.ok(alloc >= 0, 'the target level allocated');
    assert.equal(calls[alloc][3], gl.RGBA32F, '32-bit float storage');
    assert.ok(init > alloc, 'its missing channels initialized (to 1)');
    const after = calls.slice(init + 1), masks = after.filter((c) => c[0] === 'colorMask').map((c) => c.slice(1, 5).join());
    assert.deepEqual(new Set(masks), new Set(['true,false,false,false']), 'clears and draws write red only');
    assert.ok(after.some((c) => c[0] === 'clear') && after.some((c) => c[0] === 'drawArrays'), 'cleared and drawn');
  });
}

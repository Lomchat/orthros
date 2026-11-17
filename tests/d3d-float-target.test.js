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
import { filterChain } from '../src/win32/d3dx9-texwork.js';
import { toRgba, fromRgba } from '../src/win32/d3dx9-image.js';

const R16F = 111, R32F = 114, A16B16G16R16F = 113, RT = 1, TEXTURE = 3, X8R8G8B8 = 22, NOTAVAILABLE = 0x8876086a;

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
  return { gl, calls, mem, ctx, com, d3d, d3dPtr, call, out, verts, alloc: E.alloc, flush: () => link?.publish(true) };
}

for (const recorded of [false, true]) {
  test(`an R32F render-target texture is offered, stored as floats and drawn with its red channel only${recorded ? ' (render worker)' : ''}`, () => {
    const { gl, calls, mem, ctx, com, d3d, d3dPtr, call, out, verts, flush } = setup(recorded);
    assert.equal(d3d.CheckDeviceFormat(ctx([d3dPtr, 0, 1, X8R8G8B8, RT, TEXTURE, R32F])), 0, 'R32F render-target textures offered');
    // (what the QUERY bits ask is answered as Orthros renders it: 32-bit floats neither filtered nor blended on every
    // GPU, no vertex texture fetch at all — a game picks its path from these answers)
    const q = (usage, fmt) => d3d.CheckDeviceFormat(ctx([d3dPtr, 0, 1, X8R8G8B8, usage, TEXTURE, fmt]));
    assert.equal(q(RT | 0x80000, R32F), NOTAVAILABLE, 'no blending into R32F');
    assert.equal(q(0x20000, R32F), NOTAVAILABLE, 'no filtering of R32F');
    assert.equal(q(0x100000, R32F), NOTAVAILABLE, 'no vertex texture');
    assert.equal(q(0x20000, R16F), 0, 'R16F filtered');
    assert.equal(q(RT | 0x80000, A16B16G16R16F), 0, 'A16B16G16R16F blended');
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

for (const recorded of [false, true]) {
  test(`float targets: texels uploaded before a level is drawn to stay; StretchRect blits between float and fixed-point targets both ways${recorded ? ' (render worker)' : ''}`, () => {
    const { gl, calls, mem, ctx, com, call, out, alloc, flush } = setup(recorded);
    const level = (fmt, pool, usage) => { assert.equal(call('CreateTexture', 16, 16, 1, usage, fmt, pool, out, 0), 0); const t = mem.read32(out); com.implAt(t).GetSurfaceLevel(ctx([t, 0, out])); return mem.read32(out); };
    const sys = level(R32F, 2, 0), rt = level(R32F, 0, RT), fixed = level(X8R8G8B8, 0, RT), lr = alloc(16);
    // (the R32F target filled from system memory — UpdateSurface — before it becomes a render target)
    assert.equal(com.implAt(sys).LockRect(ctx([sys, lr, 0, 0])), 0);
    for (let i = 0; i < 256; i++) mem.writeF32(mem.read32(lr + 4) + 4 * i, 0.75);
    com.implAt(sys).UnlockRect(ctx([sys]));
    assert.equal(call('UpdateSurface', sys, 0, rt, 0), 0);
    calls.length = 0;
    for (const s of [rt, fixed]) { call('SetRenderTarget', 0, s); call('Clear', 0, 0, 4, 0, 0, 0); } // (stencil only: the colors stay)
    assert.equal(call('StretchRect', fixed, 0, rt, 0, 2), 0, 'fixed-point to float');
    assert.equal(call('StretchRect', rt, 0, fixed, 0, 2), 0, 'float to fixed-point');
    flush();
    const upload = calls.findIndex((c) => c[0] === 'texImage2D' && c[4] === 16 && c[3] === gl.RGBA32F && String(c[9]).startsWith('data'));
    assert.ok(upload >= 0, 'the texels uploaded');
    // (every clear of a float target's missing channels masks its own channel: red is never cleared)
    let mask = null; const ones = [];
    calls.slice(upload).forEach((c, i) => { if (c[0] === 'colorMask') mask = c.slice(1, 5).join(); if (c[0] === 'clearBufferfv') ones.push([upload + i, mask]); });
    assert.ok(ones.every(([, m]) => m === 'false,true,true,true'), `missing channels only (${ones.map(([, m]) => m)})`);
    const blits = calls.map((c, i) => [c, i]).filter(([c]) => c[0] === 'blitFramebuffer' && c[3] === 16);
    assert.equal(blits.length, 2, 'both copies made on the GPU');
    assert.ok(ones.some(([i]) => i > blits[0][1] && i < blits[1][1]), 'the float target\'s missing channels set to 1 again after the blit into it');
  });
}

test('ColorFill of a float surface: the color converted (each channel / 255), not its bits', () => {
  const { mem, ctx, com, call, out } = setup(false);
  assert.equal(call('CreateOffscreenPlainSurface', 4, 4, R32F, 2, out, 0), 0);
  const s = mem.read32(out);
  assert.equal(call('ColorFill', s, 0, 0xff336699), 0);
  assert.ok(Math.abs(mem.readF32(com.implAt(s).mem + 4 * 5) - 0x33 / 255) < 1e-6);
});

test('D3DX on float formats: 8-bit pixels read and written as floats, mips filtered in floats (values over 1 kept)', () => {
  const u8 = new Uint8Array(64), dv = new DataView(u8.buffer), m = { bytes: (a, n) => u8.subarray(a, a + n) };
  [2, 4, 6, 8].forEach((v, i) => dv.setFloat32(16 + 4 * i, v, true));
  const lv = [{ mem: 16, bytes: 16, fmt: R32F, width: 2, height: 2, pitch: 8 }, { mem: 32, bytes: 4, fmt: R32F, width: 1, height: 1, pitch: 4 }];
  let got = null; filterChain(m, lv, 0, false, () => null, (l, data) => { got = new DataView(data.buffer, data.byteOffset).getFloat32(0, true); });
  assert.equal(got, 5, 'the mean of 2, 4, 6, 8');
  assert.deepEqual([...toRgba(R32F, u8.subarray(16, 32), 2, 2).subarray(0, 4)], [255, 255, 255, 255], 'clamped into 8 bits, missing channels 1');
  dv.setFloat32(0, 0.2, true);
  assert.deepEqual([...toRgba(R32F, u8.subarray(0, 4), 1, 1)], [51, 255, 255, 255]);
  const enc = fromRgba(R16F, new Uint8Array([51, 0, 0, 255]), 1, 1);
  assert.equal(new DataView(enc.buffer).getUint16(0, true), 0x3266, 'R16F of 51 / 255');
});

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
import { constReads9 } from '../src/gfx/d3d9-shaders.js';

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

// The display report's values record (d3d8-webgl.js valDraw): the owner's RotWK pause menu showed its darkening layer
// (TEXTUREFACTOR x vertex alpha) fainter for one frame in three under one command signature — the signature leaves
// values out, so a report could not tell the game's values from GL's work. Each signed frame now also gets a hash of
// the color values its draws read and the draws whose TEXTUREFACTOR changed since the previous frame.
for (const recorded of [false, true]) {
  test(`a signed frame's values: a TEXTUREFACTOR change shows under the same command signature${recorded ? ' (render worker)' : ''}`, () => {
    const { gl } = fakeGl(320, 240), frames = [];
    const probe = { flicker: { present: (fbo, w, h, dev, sig) => { frames.push({ sig, val: dev.valFrame }); return false; } }, endRun() {}, frame() {} };
    const backend = (dev) => { const b = new WebGLDevice(gl, dev, {}); b.probe = probe; b.sigOn = true; return b; };
    let gfx = { createDevice: backend }, link = null;
    if (recorded) {
      const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: backend });
      link = new RenderLink({ words, replayer, ack });
      gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
    }
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16), tri = alloc(60);
    [320, 240, X8R8G8B8, 1, 0, 0, 1, 0, 0, 1, D24S8, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    [[10, 10], [100, 10], [10, 100]].forEach(([x, y], i) => { const a = tri + 20 * i; mem.writeF32(a, x); mem.writeF32(a + 4, y); mem.writeF32(a + 8, 0.5); mem.writeF32(a + 12, 1); mem.write32(a + 16, 0xff000000); });
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    call('SetFVF', 0x44); // (XYZRHW | DIFFUSE)
    for (const tf of [0xcc000000, 0xcc000000, 0x28000000, 0xcc000000]) {
      call('BeginScene'); call('SetRenderState', 60, tf); call('DrawPrimitiveUP', 4, 1, tri, 20); call('EndScene');
      assert.equal(call('Present', 0, 0, 0, 0), 0);
    }
    link?.publish(true);
    const last = frames.slice(-4);
    assert.equal(last.length, 4);
    assert.equal(new Set(last.map((f) => f.sig)).size, 1, 'one command signature: TEXTUREFACTOR is a value, not a command');
    const v = last.map((f) => f.val.vsig);
    assert.equal(v[1], v[0]); assert.equal(v[3], v[0]); assert.notEqual(v[2], v[0], 'the frame with the other TEXTUREFACTOR has its own values signature');
    assert.deepEqual(last[1].val.tf, []);
    assert.deepEqual(last[2].val.tf, [[0, 0xcc000000, 0x28000000]], 'its draw named, with the value of the frame before');
    assert.deepEqual(last[3].val.tf, [[0, 0x28000000, 0xcc000000]]);
  });
}

// The values of a D3DX effect's material reach the draw in shader constants, which that record left out: Age of the
// Ring's materials took turns while a building was under construction (parameter blocks applied for one another) under
// values signatures that never moved. Each signed frame now also carries a hash of the float constants its draws'
// shaders read (constReads9) and how many draws read other constants than in the frame before.
// vs_2_0: dcl_position v0; mov oPos, v0; mov oD0, c6
const VS_C6 = [0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x02000001, 0xc00f0000, 0x90e40000, 0x02000001, 0xd00f0000, 0xa0e40006, 0x0000ffff];
for (const recorded of [false, true]) {
  test(`a signed frame's shader constants: a change of a register the draw's shader reads shows, another register's does not${recorded ? ' (render worker)' : ''}`, () => {
    const { gl } = fakeGl(320, 240), frames = [];
    const probe = { flicker: { present: (fbo, w, h, dev, sig) => { frames.push({ sig, val: dev.valFrame }); return false; } }, endRun() {}, frame() {} };
    const backend = (dev) => { const b = new WebGLDevice(gl, dev, {}); b.probe = probe; b.sigOn = true; return b; };
    let gfx = { createDevice: backend }, link = null;
    if (recorded) {
      const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: backend });
      link = new RenderLink({ words, replayer, ack });
      gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
    }
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16), tri = alloc(36), code = alloc(4 * VS_C6.length), reg = alloc(16);
    [320, 240, X8R8G8B8, 1, 0, 0, 1, 0, 0, 1, D24S8, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    [[0, 0], [1, 0], [0, 1]].forEach(([x, y], i) => { mem.writeF32(tri + 12 * i, x); mem.writeF32(tri + 12 * i + 4, y); mem.writeF32(tri + 12 * i + 8, 0.5); });
    VS_C6.forEach((v, i) => mem.write32(code + 4 * i, v));
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    const setC = (r, x) => { [x, 0, 0, 1].forEach((v, i) => mem.writeF32(reg + 4 * i, v)); assert.equal(call('SetVertexShaderConstantF', r, reg, 1), 0); };
    call('SetFVF', 0x002); // (XYZ)
    assert.equal(call('CreateVertexShader', code, out), 0); call('SetVertexShader', mem.read32(out));
    // (c6: the register the shader reads — an opacity; c7: one it does not)
    for (const [c6, c7] of [[0.8, 1], [0.8, 2], [0.3, 2], [0.8, 2]]) {
      call('BeginScene'); setC(6, c6); setC(7, c7); call('DrawPrimitiveUP', 4, 1, tri, 12); call('EndScene');
      assert.equal(call('Present', 0, 0, 0, 0), 0);
    }
    link?.publish(true);
    const last = frames.slice(-4), v = last.map((f) => f.val);
    assert.equal(last.length, 4);
    assert.equal(new Set(last.map((f) => f.sig)).size, 1, 'one command signature');
    assert.equal(new Set(v.map((x) => x.vsig)).size, 1, 'and one values signature: no TEXTUREFACTOR, material or fog moved');
    assert.equal(v[1].csig, v[0].csig, 'a register the shader does not read');
    assert.deepEqual([v[1].cn, v[1].cd], [0, []]);
    assert.notEqual(v[2].csig, v[0].csig, 'the register it reads');
    assert.deepEqual([v[2].cn, v[2].cd], [1, [0]], 'its draw named');
    assert.equal(v[3].csig, v[0].csig);
  });
}

test('the constant registers a shader reads: direct reads, a matrix instruction\'s rows, an indexed read up to the end of its table\'s constant, its own definitions left out', () => {
  // vs_2_0 with a constant table naming Bones at c10..c15 (D3DX's CTAB comment): def c7; mova a0.x, c5.x;
  // mov r0, c[a0.x + 10]; m4x3 r1.xyz, r0, c20; mov oD0, c6; mov oD1, c7
  const ctab = [0x42415443, 28, 0, 0xfffe0200, 1, 28, 0, 0, 64, 2 | (10 << 16), 6, 48, 0, 0, 0, 0, 0, 0x73656e42, 0];
  const body = [0x05000051, 0xa00f0007, 0x3f800000, 0, 0, 0, 0x0200002e, 0xb0010000, 0xa0000005, 0x03000001, 0x800f0000, 0xa0e4200a, 0xb0000000,
    0x03000015, 0x80070001, 0x80e40000, 0xa0e40014, 0x02000001, 0xd00f0000, 0xa0e40006, 0x02000001, 0xd00f0001, 0xa0e40007, 0x0000ffff];
  const withTable = Uint32Array.from([0xfffe0200, 0xfffe | (ctab.length << 16), ...ctab, ...body]);
  assert.deepEqual(Array.from(constReads9(withTable)), [5, 6, 10, 11, 12, 13, 14, 15, 20, 21, 22]);
  const bare = Array.from(constReads9(Uint32Array.from([0xfffe0200, ...body])));
  assert.deepEqual(bare.slice(0, 3), [5, 6, 10]); assert.equal(bare.length, 2 + (256 - 10), 'no table: the indexed read reaches the last register');
});


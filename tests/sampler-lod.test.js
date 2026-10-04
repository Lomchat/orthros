// D3DSAMP_MAXMIPLEVEL and IDirect3DBaseTexture9::SetLOD: the index of the most detailed mip level sampled (0: the
// largest; the smaller levels stay in use) — GL's TEXTURE_MIN_LOD on the sampler object, not a cap on the smallest
// levels. SetLOD only acts on managed textures, and a change of it alone gives the next draw the right sampler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';

/** recorded: the device records into a command ring replayed into a mirror (the render worker's path). */
function setup(recorded = false) {
  const { gl, calls } = fakeGl(320, 240);
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
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  const texture = (pool) => { assert.equal(call('CreateTexture', 16, 16, 4, 0, 21, pool, out, 0), 0); const p = mem.read32(out); return { ptr: p, impl: com.implAt(p) }; };
  for (let i = 0; i < 18; i++) mem.writeF32(verts + 4 * i, i % 3 === 2 ? 0.5 : (i * 7) % 5);
  call('SetFVF', 0x102); // (XYZ | TEX1)
  // the MIN_LOD set on the sampler bound to unit 0 at the draw
  const draw = () => {
    call('DrawPrimitiveUP', 4, 1, verts, 20);
    link?.publish(true);
    const minLod = new Map();
    for (const c of calls) if (c[0] === 'samplerParameterf' && c[2] === gl.TEXTURE_MIN_LOD) minLod.set(c[1], c[3]);
    let bound = null;
    for (const c of calls) if (c[0] === 'bindSampler' && c[1] === 0) bound = c[2];
    return minLod.get(bound) ?? 0;
  };
  return { call, texture, draw, ctx };
}

test('MAXMIPLEVEL is the most detailed level sampled (GL minimum LOD), with mipmapped filtering only', () => {
  const { call, texture, draw } = setup();
  const t = texture(1);
  call('SetTexture', 0, t.ptr);
  call('SetSamplerState', 0, 6, 2); call('SetSamplerState', 0, 7, 2); // (MINFILTER, MIPFILTER linear)
  assert.equal(draw(), 0);
  call('SetSamplerState', 0, 9, 1); // MAXMIPLEVEL 1: levels 1..3
  assert.equal(draw(), 1);
  call('SetSamplerState', 0, 9, 9); // past the last level: the last one
  assert.equal(draw(), 3);
  call('SetSamplerState', 0, 7, 0); // no mipmapping: no LOD clamp
  assert.equal(draw(), 0);
});

test('SetLOD acts on managed textures only, returns the previous value, and the next draw samples from it', () => {
  const { call, texture, draw, ctx } = setup();
  const t = texture(1);
  call('SetTexture', 0, t.ptr);
  call('SetSamplerState', 0, 6, 2); call('SetSamplerState', 0, 7, 2);
  assert.equal(draw(), 0);
  assert.equal(t.impl.SetLOD(ctx([t.ptr, 2])), 0);
  assert.equal(t.impl.GetLOD(ctx([t.ptr])), 2);
  assert.equal(draw(), 2, 'the sampler of the previous draw is not reused');
  call('SetSamplerState', 0, 9, 1);
  assert.equal(draw(), 2, 'the larger of MAXMIPLEVEL and the LOD');
  call('SetSamplerState', 0, 9, 3);
  assert.equal(draw(), 3);
  assert.equal(t.impl.SetLOD(ctx([t.ptr, 7])), 2);
  assert.equal(t.impl.GetLOD(ctx([t.ptr])), 3, 'clamped to the last level');
  const d = texture(0);
  assert.equal(d.impl.SetLOD(ctx([d.ptr, 2])), 0);
  assert.equal(d.impl.GetLOD(ctx([d.ptr])), 0, 'not a managed texture: no effect');
  call('SetSamplerState', 0, 9, 0);
  call('SetTexture', 0, d.ptr);
  assert.equal(draw(), 0);
});

test('SetLOD reaches the render worker\'s mirror: the replayed draws sample from the same level', () => {
  const { call, texture, draw, ctx } = setup(true);
  const early = texture(1), t = texture(1);
  assert.equal(early.impl.SetLOD(ctx([early.ptr, 1])), 0); // (before the texture was ever recorded)
  call('SetSamplerState', 0, 6, 2); call('SetSamplerState', 0, 7, 2);
  call('SetTexture', 0, early.ptr);
  assert.equal(draw(), 1, 'the LOD set before the texture was recorded travels with it');
  call('SetTexture', 0, t.ptr);
  assert.equal(draw(), 0);
  t.impl.SetLOD(ctx([t.ptr, 2]));
  assert.equal(draw(), 2, 'a later SetLOD reaches the mirror');
  t.impl.SetLOD(ctx([t.ptr, 0]));
  assert.equal(draw(), 0);
});

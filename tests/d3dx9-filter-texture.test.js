// D3DXFilterTexture and D3DXLoadSurfaceFromMemory end to end on Direct3D 9 textures (the device's surfaces in guest
// memory): the levels written equal the base implementation's computation (tests/fixtures/d3dx9-image-base.js: the
// source level decoded — or its RGBA kept by the load — then resized 2:1 and re-encoded level after level), for DXT and
// 16 / 32-bit formats, a chain starting below level 0, a source level without memory (skipped, as before), and the
// point filter (level by level).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { registerD3DX9 } from '../src/win32/d3dx9.js';
import * as base from './fixtures/d3dx9-image-base.js';
import { FMT } from '../src/win32/d3d8.js';

function env() {
  const E = d3dEnv(null), { mem, ctx, com } = E;
  const X = {}; registerD3DX9({ define(dll, d) { Object.assign(X, d); } }, E.vm);
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => X[name][1](ctx(args));
  const texture = (w, h, fmt) => { assert.equal(dev.CreateTexture(ctx([devPtr, w, h, 0, 0, fmt, 1, out, 0])), 0); const p = mem.read32(out); return { p, t: com.implAt(p) }; };
  const surface = (tex, l) => { assert.equal(tex.t.GetSurfaceLevel(ctx([tex.p, l, out])), 0); return mem.read32(out); };
  return { E, mem, ctx, com, call, texture, surface };
}
const rgbaImage = (w, h, seed) => { let s = seed; const px = new Uint8Array(w * h * 4); for (let i = 0; i < px.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; px[i] = (i & 3) === 3 ? (s >>> 31 ? 255 : (s >>> 24) & 127) : ((i >> 5) + (s >>> 28)) & 255; } return px; };
/** the base's levels below `from` (RGBA of level `l0`) for texture t */
const expected = (t, l0, from, point = false) => { const out = []; let px = from; for (let i = l0 + 1; i < t.levels.length; i++) { const p = t.levels[i - 1], s = t.levels[i]; px = base.resizeRgba(px, p.width, p.height, s.width, s.height, point); out.push(base.fromRgba(s.fmt, px, s.width, s.height)); } return out; };
const levelBytes = (mem, s) => Array.from(mem.bytes(s.mem, s.bytes));

for (const fmt of [FMT.DXT1, FMT.DXT5, FMT.A1R5G5B5, FMT.R5G6B5, FMT.A8R8G8B8, FMT.L8]) {
  test(`D3DXLoadSurfaceFromMemory then D3DXFilterTexture, format ${fmt}: the base's levels`, () => {
    const { E, mem, call, texture, surface } = env();
    for (const [w, h, point] of [[64, 64, false], [32, 8, false], [16, 16, true]]) {
      const tex = texture(w, h, fmt), src = E.alloc(w * h * 4), rect = E.alloc(16);
      const bgra = base.fromRgba(FMT.A8R8G8B8, rgbaImage(w, h, w + fmt), w, h); mem.writeBytes(src, bgra);
      [0, 0, w, h].forEach((v, i) => mem.write32(rect + 4 * i, v));
      assert.equal(call('D3DXLoadSurfaceFromMemory', surface(tex, 0), 0, 0, src, FMT.A8R8G8B8, w * 4, 0, rect, 1, 0), 0);
      const l0 = tex.t.levels[0];
      // (level 0's RGBA: kept by the load for DXT, else decoded from the level as the filter does)
      const from = base.isDxt(fmt) ? base.toRgba(FMT.A8R8G8B8, bgra, w, h) : base.toRgba(fmt, mem.bytes(l0.mem, l0.bytes).slice(), w, h);
      assert.equal(call('D3DXFilterTexture', tex.p, 0, 0xffffffff, point ? 2 : 5), 0);
      expected(tex.t, 0, from, point).forEach((want, i) => assert.deepEqual(levelBytes(mem, tex.t.levels[i + 1]), Array.from(want), `${w}x${h} level ${i + 1}`));
    }
  });
}

test('D3DXFilterTexture from level 1, and over a source level without memory (left alone, the chain starting below it)', () => {
  const { E, mem, call, texture, surface } = env();
  const tex = texture(32, 32, FMT.A1R5G5B5), t = tex.t;
  // level 1 written by a lock, level 0 never touched (no memory): filtering from 0 skips 1, which has no source
  const l1 = t.levels[1], lr = E.alloc(8);
  assert.equal(t.levels[1].lock({ proc: E.proc, retAddr: 0 }, lr, 0, 0), 0);
  const px = base.fromRgba(FMT.A1R5G5B5, rgbaImage(16, 16, 9), 16, 16); mem.writeBytes(mem.read32(lr + 4), px); t.levels[1].unlock();
  assert.equal(t.levels[0].mem, 0);
  assert.equal(call('D3DXFilterTexture', tex.p, 0, 0, 5), 0);
  assert.equal(t.levels[0].mem, 0, 'level 0 untouched');
  assert.deepEqual(levelBytes(mem, l1), Array.from(px), 'level 1 kept (its source had no data)');
  const from = base.toRgba(FMT.A1R5G5B5, px, 16, 16);
  expected(t, 1, from).forEach((want, i) => assert.deepEqual(levelBytes(mem, t.levels[i + 2]), Array.from(want), `level ${i + 2}`));
  // filtering from level 2 rewrites the levels below it from level 2's data
  const l2 = levelBytes(mem, t.levels[2]);
  assert.equal(call('D3DXFilterTexture', tex.p, 0, 2, 5), 0);
  assert.deepEqual(levelBytes(mem, t.levels[2]), l2);
  void surface;
});

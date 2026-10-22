// Volume textures' levels as objects (IDirect3DVolume8 / 9): GetVolumeLevel returns the level (the same object each
// time, alive while its texture lives), its description, LockBox with a box offsetting the pointer, the backend told of
// new contents (dirty: uploaded again at the next use), and the D3DX volume loads into a level (RotWK 2.01 creates a
// volume texture, takes level 0, loads a file into it with D3DXLoadVolumeFromFileInMemory, then D3DXFilterTexture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { registerD3DX9 } from '../src/win32/d3dx9.js';
import { FMT } from '../src/win32/d3d8.js';

function env(api9 = true) {
  const gfxCalls = [];
  const gfx = { volumeUpdated: (t, i) => gfxCalls.push(['updated', i]), volumeMem: (t, i) => gfxCalls.push(['mem', i]) };
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  const X = {}; registerD3DX9({ define(dll, d) { Object.assign(X, d); } }, E.vm);
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = api9 ? E.defs.Direct3DCreate9[1](ctx([32])) : E.defs.Direct3DCreate8[1](ctx([220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  dev.gfx = gfx;
  const stack = E.alloc(256);
  const sctx = (args) => { args.forEach((v, i) => mem.write32(stack + 4 + 4 * i, v >>> 0)); return { sp: stack, proc: E.proc, thread: { id: 1 }, retAddr: 0, arg(i) { return mem.read32(this.sp + 4 + 4 * i) >>> 0; }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } }; };
  const call = (name, ...args) => X[name][1](sctx(args));
  const volumeTexture = (w, h, d, levels, fmt) => {
    const args = api9 ? [devPtr, w, h, d, levels, 0, fmt, 1, out, 0] : [devPtr, w, h, d, levels, 0, fmt, 1, out];
    assert.equal(dev.CreateVolumeTexture(ctx(args)), 0);
    const p = mem.read32(out); return { p, t: com.implAt(p) };
  };
  const level = (tex, l) => { const o = E.alloc(4); const r = tex.t.GetVolumeLevel(ctx([tex.p, l, o])); return { r, p: mem.read32(o) }; };
  return { E, mem, ctx, com, call, volumeTexture, level, gfxCalls, devPtr };
}

for (const api9 of [true, false]) {
  test(`Direct3D ${api9 ? 9 : 8}: GetVolumeLevel gives the level as an object, its description, GetContainer`, () => {
    const { E, mem, ctx, com, volumeTexture, level } = env(api9);
    const tex = volumeTexture(8, 4, 2, 0, FMT.A8R8G8B8);
    assert.equal(tex.t.levels.length, 4); // (8x4x2, 4x2x1, 2x1x1, 1x1x1)
    const a = level(tex, 1), b = level(tex, 1);
    assert.equal(a.r, 0); assert.ok(a.p);
    assert.equal(b.p, a.p, 'the same object for the same level');
    assert.equal(com.objectAt(a.p).refs, 2);
    assert.equal(level(tex, 9).r, 0x8876086c); // (D3DERR_INVALIDCALL)
    const v = com.implAt(a.p), desc = E.alloc(32);
    assert.equal(v.GetDesc(ctx([a.p, desc])), 0);
    const words = Array.from({ length: 8 }, (_, i) => mem.read32(desc + 4 * i));
    if (api9) assert.deepEqual(words.slice(0, 7), [FMT.A8R8G8B8, 2, 0, 1, 4, 2, 1]);
    else assert.deepEqual(words, [FMT.A8R8G8B8, 2, 0, 1, 4 * 2 * 4 * 1, 4, 2, 1]);
    // (the texture's GetLevelDesc writes the same description)
    const desc2 = E.alloc(32); assert.equal(tex.t.GetLevelDesc(ctx([tex.p, 1, desc2])), 0);
    assert.deepEqual(Array.from({ length: 8 }, (_, i) => mem.read32(desc2 + 4 * i)).slice(0, api9 ? 7 : 8), words.slice(0, api9 ? 7 : 8));
    const o = E.alloc(4), iid = E.alloc(16);
    assert.equal(v.GetContainer(ctx([a.p, iid, o])), 0);
    assert.equal(mem.read32(o), tex.p);
  });
}

test('LockBox with a box: the pointer at its corner, pitches of the level; the backend told of new contents', () => {
  const { E, mem, ctx, com, volumeTexture, level, gfxCalls } = env(true);
  const tex = volumeTexture(8, 4, 4, 1, FMT.A8R8G8B8), v = com.implAt(level(tex, 0).p);
  const lb = E.alloc(12), box = E.alloc(24);
  [2, 1, 6, 3, 3, 4].forEach((x, i) => mem.write32(box + 4 * i, x)); // (left 2, top 1, right 6, bottom 3, front 3, back 4)
  assert.equal(v.LockBox(ctx([0, lb, box, 0])), 0);
  const pitch = mem.read32(lb), slice = mem.read32(lb + 4), bits = mem.read32(lb + 8);
  assert.deepEqual([pitch, slice], [32, 128]);
  assert.equal(bits, v.mem + 3 * 128 + 1 * 32 + 2 * 4);
  assert.equal(v.LockBox(ctx([0, lb, 0, 0])), 0x8876086c, 'locked twice');
  mem.write32(bits, 0x11223344);
  v.dirty = false;
  assert.equal(v.UnlockBox(ctx([0])), 0);
  assert.equal(v.dirty, true);
  assert.deepEqual(gfxCalls.filter((x) => x[0] === 'updated'), [['updated', 0]]);
  assert.equal(v.UnlockBox(ctx([0])), 0x8876086c, 'not locked');
  // (the texture's LockBox locks the same level, at its box too)
  assert.equal(tex.t.LockBox(ctx([tex.p, 0, lb, box, 0])), 0);
  assert.equal(mem.read32(mem.read32(lb + 8)), 0x11223344);
  assert.equal(tex.t.UnlockBox(ctx([tex.p, 0])), 0);
  // (DXT: rows and columns of 4x4 blocks)
  const dxt = volumeTexture(16, 16, 2, 1, FMT.DXT1), dv = dxt.t.levels[0];
  [4, 8, 16, 16, 1, 2].forEach((x, i) => mem.write32(box + 4 * i, x));
  assert.equal(dxt.t.LockBox(ctx([dxt.p, 0, lb, box, 0])), 0);
  assert.equal(mem.read32(lb + 8), dv.mem + dv.slice + 2 * dv.pitch + 1 * 8);
});

test('D3DXLoadVolumeFromMemory into a level, then D3DXFilterTexture: 2 x 2 x 2 box means level after level', () => {
  const { E, mem, com, call, volumeTexture, level } = env(true);
  const tex = volumeTexture(4, 4, 4, 0, FMT.A8R8G8B8), vp = level(tex, 0).p, v = com.implAt(vp);
  const src = E.alloc(4 * 4 * 4 * 4), box = E.alloc(24);
  const texel = (x, y, z) => ((x * 16 + y * 4 + z * 64) & 0xff) | (((x + y + z) * 8) << 8) | (z * 60 << 16) | 0xff000000;
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) mem.write32(src + ((z * 4 + y) * 4 + x) * 4, texel(x, y, z) >>> 0);
  [0, 0, 4, 4, 0, 4].forEach((x, i) => mem.write32(box + 4 * i, x));
  assert.equal(call('D3DXLoadVolumeFromMemory', vp, 0, 0, src, FMT.A8R8G8B8, 16, 64, 0, box, 1, 0), 0);
  assert.deepEqual(Array.from(mem.bytes(v.mem, v.bytes)), Array.from(mem.bytes(src, 256)));
  assert.equal(call('D3DXFilterTexture', tex.p, 0, 0xffffffff, 5), 0);
  const l1 = tex.t.levels[1], l2 = tex.t.levels[2];
  assert.ok(l1.mem && l2.mem);
  // level 1 texel (1, 0, 1): the mean of source texels x 2-3, y 0-1, z 2-3, each channel rounded
  const mean = (sh, xs, ys, zs) => { let s = 0, n = 0; for (const z of zs) for (const y of ys) for (const x of xs) { s += (texel(x, y, z) >>> sh) & 0xff; n++; } return Math.floor((s + (n >> 1)) / n); };
  const got = mem.read32(l1.mem + 1 * l1.slice + 0 * l1.pitch + 1 * 4) >>> 0;
  for (const sh of [0, 8, 16, 24]) assert.equal((got >>> sh) & 0xff, mean(sh, [2, 3], [0, 1], [2, 3]), `channel at bit ${sh}`);
  // level 2 (1 x 1 x 1): the mean of level 1's eight texels
  const l1t = (x, y, z) => mem.read32(l1.mem + z * l1.slice + y * l1.pitch + x * 4) >>> 0;
  const top = mem.read32(l2.mem) >>> 0;
  for (const sh of [0, 8, 16]) { let s = 0; for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) s += (l1t(x, y, z) >>> sh) & 0xff; assert.equal((top >>> sh) & 0xff, Math.floor((s + 4) / 8)); }
});

test('D3DXLoadVolumeFromFileInMemory into a level: a DDS volume file, its first level converted to the level\'s format', () => {
  const { E, mem, com, call, volumeTexture, level } = env(true);
  const tex = volumeTexture(4, 2, 2, 1, FMT.A8R8G8B8), vp = level(tex, 0).p, v = com.implAt(vp);
  // a DDS volume (DDSD_DEPTH, DDSCAPS2_VOLUME), 32-bit BGRA, 4 x 2 x 2
  const w = 4, h = 2, d = 2, file = new Uint8Array(128 + w * h * d * 4), dv = new DataView(file.buffer);
  file.set([0x44, 0x44, 0x53, 0x20]); dv.setUint32(4, 124, true); dv.setUint32(8, 0x1007 | 0x800000, true); dv.setUint32(12, h, true); dv.setUint32(16, w, true); dv.setUint32(24, d, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true); dv.setUint32(92, 0xff0000, true); dv.setUint32(96, 0xff00, true); dv.setUint32(100, 0xff, true); dv.setUint32(104, 0xff000000, true);
  dv.setUint32(108, 0x1000, true); dv.setUint32(112, 0x200000, true);
  for (let i = 0; i < w * h * d; i++) dv.setUint32(128 + 4 * i, (0x80000000 | i * 0x010203) >>> 0, true);
  const p = E.alloc(file.length); mem.writeBytes(p, file);
  const info = E.alloc(32);
  assert.equal(call('D3DXLoadVolumeFromFileInMemory', vp, 0, 0, p, file.length, 0, 1, 0, info), 0);
  assert.deepEqual([mem.read32(info), mem.read32(info + 4), mem.read32(info + 8)], [4, 2, 2]);
  assert.deepEqual(Array.from(mem.bytes(v.mem, v.bytes)), Array.from(file.subarray(128)));
  assert.equal(v.dirty, true);
  assert.equal(call('D3DXLoadVolumeFromFileInMemory', 0x1234, 0, 0, p, file.length, 0, 1, 0, 0), 0x8876086c, 'not a volume');
});

test('UpdateTexture between volume textures copies their levels', () => {
  const { ctx, mem, volumeTexture, devPtr, com } = env(true);
  const a = volumeTexture(4, 4, 2, 1, FMT.A8R8G8B8), b = volumeTexture(4, 4, 2, 1, FMT.A8R8G8B8);
  const la = a.t.levels[0]; la.ensureMem(a.t.dev.proc); mem.write32(la.mem + 8, 0xabcdef01);
  assert.equal(com.implAt(devPtr).UpdateTexture(ctx([devPtr, a.p, b.p])), 0);
  assert.equal(mem.read32(b.t.levels[0].mem + 8) >>> 0, 0xabcdef01);
  assert.equal(b.t.levels[0].dirty, true);
});

test('a destination box: a 2D image into one slice of a volume, the other slices kept (D3DXLoadVolumeFromFileInMemory / FromMemory)', () => {
  const { E, mem, com, call, volumeTexture, level } = env(true);
  const tex = volumeTexture(4, 4, 4, 1, FMT.A8R8G8B8), vp = level(tex, 0).p, v = com.implAt(vp);
  mem.fill(v.ensureMem(E.proc), v.bytes, 0x5a);
  // a 2D DDS, 32-bit BGRA 4 x 4
  const file = new Uint8Array(128 + 64), dv = new DataView(file.buffer);
  file.set([0x44, 0x44, 0x53, 0x20]); dv.setUint32(4, 124, true); dv.setUint32(8, 0x1007, true); dv.setUint32(12, 4, true); dv.setUint32(16, 4, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true); dv.setUint32(92, 0xff0000, true); dv.setUint32(96, 0xff00, true); dv.setUint32(100, 0xff, true); dv.setUint32(104, 0xff000000, true); dv.setUint32(108, 0x1000, true);
  for (let i = 0; i < 16; i++) dv.setUint32(128 + 4 * i, (0xff000000 | i * 0x030507) >>> 0, true);
  const p = E.alloc(file.length); mem.writeBytes(p, file);
  const box = E.alloc(24); [0, 0, 4, 4, 2, 3].forEach((x, i) => mem.write32(box + 4 * i, x)); // (slice 2)
  assert.equal(call('D3DXLoadVolumeFromFileInMemory', vp, 0, box, p, file.length, 0, 1, 0, 0), 0);
  const slice = (z) => Array.from(mem.bytes(v.mem + z * v.slice, v.slice));
  assert.deepEqual(slice(2), Array.from(file.subarray(128)));
  for (const z of [0, 1, 3]) assert.ok(slice(z).every((x) => x === 0x5a), `slice ${z} kept`);
  // the same from memory into slice 0, a 2 x 2 x 1 box at (1, 1): resized from the 4 x 4 source by 2 x 2 means
  const sbox = E.alloc(24); [0, 0, 4, 4, 0, 1].forEach((x, i) => mem.write32(sbox + 4 * i, x));
  [1, 1, 3, 3, 0, 1].forEach((x, i) => mem.write32(box + 4 * i, x));
  assert.equal(call('D3DXLoadVolumeFromMemory', vp, 0, box, p + 128, FMT.A8R8G8B8, 16, 64, 0, sbox, 1, 0), 0);
  const at = (x, y, z) => mem.read32(v.mem + z * v.slice + y * v.pitch + 4 * x) >>> 0;
  assert.equal(at(0, 0, 0), 0x5a5a5a5a); assert.equal(at(3, 3, 0), 0x5a5a5a5a);
  const src = (x, y) => dv.getUint32(128 + 4 * (y * 4 + x), true);
  const mean = (sh, x0, y0) => { let t = 0; for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) t += (src(x, y) >>> sh) & 0xff; return Math.floor((t + 2) / 4); };
  for (const sh of [0, 8, 16]) assert.equal((at(2, 1, 0) >>> sh) & 0xff, mean(sh, 2, 0), `channel ${sh}`);
});

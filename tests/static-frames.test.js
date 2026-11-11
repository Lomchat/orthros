// Static frames (src/gfx/static-frames.js): a frame equal to the two before it is shown again without rendering, and
// only then — never a frame whose commands or written texture bytes differ, nor one whose image depends on what its
// target held before it — and the device mirror ends exactly as when every frame is rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, RingWriter, VERSION_FIELDS } from '../src/gfx/cmd-ring.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';

function run(words, produced, reuse, mem) {
  const calls = [], reused = [];
  globalThis.ORTHROS_STATIC_REUSE = 1; // (off by default)
  const r = new Replayer(words, { mem, ack: null, onReuse: reuse ? (m, f) => reused.push(f) : null, createBackend: () => ({
    rscale: 1, clear: () => calls.push('clear'), drawPrimitive: () => calls.push('draw'), present: () => calls.push('present'), beginScene() {}, constTouched() {}, bufferUpdated() {},
    drawPrimitiveUP() { calls.push('up'); },
  }) });
  r.run(produced);
  return { r, calls, reused, m: r.devices.get(1) };
}

test('static frames: equal frames after two are reused, any difference renders, the mirror stays exact', () => {
  const words = new Int32Array(1 << 16), w = new RingWriter(words, () => { throw new Error('full'); });
  w.put(OP.DEVICE, 1, 1, 64, 48, 1); w.put(OP.TABLES, 8, 16); w.put(OP.STREAMS, 2); w.put(OP.TEXTURES, 8); w.put(OP.CONSTS, 16, 16, 0, 0, 0, 0);
  w.put(OP.SURF, 5, 21, 64, 48, 1, 0, 0, 0); w.put(OP.BACKBUFFERS, Int32Array.of(5));
  let ver = 1, frame = 0;
  const plain = (color, { clear = true, ztest = false, draw = () => w.put(OP.DRAW, 4, 0, 2) } = {}) => {
    w.put(OP.VERSION, 0, ver++); // (a counter that moves every frame: set aside by the comparison)
    w.put(OP.TSETS, Int32Array.of(0, 7, ztest ? 1 : 0, 0, 60, color));
    if (clear) w.put(OP.CLEAR, 0, 1, 0xff000000, 1, 0, null);
    w.put(OP.BUF_DATA, 9, 0, 0, Uint8Array.of(color & 255, 2, 3, 4)); // (bytes in the ring: compared too)
    draw(); w.put(OP.PRESENT, ++frame);
  };
  w.put(OP.BUF, 9, 1, 64, 0x200, 0, 0, -1, 1);
  for (let i = 0; i < 5; i++) plain(1); // frames 1-5 (1 with the setup: not plain): 4 and 5 reused
  for (let i = 0; i < 4; i++) plain(2); // 6 held then released at its first difference, 7 rendered too (two equal frames first), 8 and 9 reused
  for (let i = 0; i < 4; i++) plain(3, { clear: false }); // drawn over the previous image: never reused
  for (let i = 0; i < 4; i++) plain(4, { ztest: true }); // a depth test against a depth buffer not cleared: never reused
  w.put(OP.SURF_DIRTY, 77, 1, null); for (let i = 0; i < 4; i++) plain(4); // (a resource written: that frame not plain)
  // a texture the guest writes every frame (a loading screen's): reused while its bytes stay the same
  const u8 = new Uint8Array(4096), mem = { u8 };
  w.put(OP.TEX, 30, 1, 21, 4, 4, 1, 0, 1, 0, 1, Int32Array.of(31, 4, 4, 1, 1024));
  const written = (draw) => { w.put(OP.SURF_DIRTY, 31, 100 + frame, null); w.put(OP.TEXTURE, 0, 30); plain(5, { draw }); };
  for (let i = 0; i < 5; i++) written(); // 22 (the texture created) to 26: 25 and 26 reused
  const A = run(words, w.produced, true, mem), B = run(words, w.produced, false, mem);
  // new bytes: 27 held then released, 28 rendered (two equal frames first), 29 reused
  u8[1029] = 7; for (let i = 0; i < 3; i++) written();
  A.r.run(w.produced); B.r.run(w.produced);
  // vertices in the ring (DRAW_UP): 30 and 31 rendered (new commands), 32 reused, 33 written with new bytes: rendered
  const quad = new Float32Array([10, 10, 0, 1, 0, 0, 20, 10, 0, 1, 1, 0, 10, 20, 0, 1, 0, 1, 20, 10, 0, 1, 1, 0, 20, 20, 0, 1, 1, 1, 10, 20, 0, 1, 0, 1]);
  const ui = () => { w.put(OP.FVF, 0x104); w.put(OP.DRAW_UP, 4, 2, 24, new Uint8Array(quad.buffer)); };
  for (let i = 0; i < 3; i++) written(ui);
  A.r.run(w.produced); B.r.run(w.produced);
  u8[1030] = 9; written(ui);
  A.r.run(w.produced); B.r.run(w.produced);
  assert.deepEqual(A.reused, [4, 5, 8, 9, 21, 25, 26, 29, 32]);
  assert.equal(A.calls.filter((c) => c === 'present').length, frame - A.reused.length, 'the other frames rendered');
  assert.deepEqual(A.calls.slice(-2), ['up', 'present'], 'frame 33 rendered');
  assert.equal(B.calls.filter((c) => c === 'present').length, frame);
  for (const f of [...VERSION_FIELDS, 'textures', 'streams', 'fvf']) assert.deepEqual(A.m[f], B.m[f], f);
  assert.deepEqual([...A.m.rs], [...B.m.rs], 'render states');
  assert.deepEqual(A.r.res.get(9).shadow, B.r.res.get(9).shadow, 'buffer bytes');
  globalThis.ORTHROS_STATIC_REUSE = undefined;
});

// The render worker's replay reads the commands of every draw straight from the ring words (Replayer.applyFast); the
// general path decodes them by the command table. Random commands of those kinds — every encoding the table allows
// (uint32, int32, float64 and missing numbers, empty and absent word lists) — applied both ways must leave equal mirrors
// and drive their backends with the same calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, RingWriter, CONST_FIELDS, VERSION_FIELDS } from '../src/gfx/cmd-ring.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';

function replayer(words, fast, calls) {
  const r = new Replayer(words, { mem: null, ack: null, createBackend: () => ({
    drawPrimitive: (...a) => calls.push(['dp', ...a]), drawIndexedPrimitive: (...a) => calls.push(['dip', ...a]), constTouched: (...a) => calls.push(['ct', ...a]),
  }) });
  if (!fast) r.applyFast = () => false;
  return r;
}

test('replay: the per-draw commands read from the ring words equal the decoded general path', () => {
  let s = 7; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s % n; };
  const num = () => { const k = rnd(6); return k < 3 ? rnd(100000) : k === 3 ? -1 - rnd(1000) : k === 4 ? rnd(1000) / 7 : undefined; };
  for (const api9 of [1, 0]) {
    const words = new Int32Array(1 << 16), w = new RingWriter(words, () => { throw new Error('full'); });
    w.put(OP.DEVICE, 1, api9, 640, 480, 1); w.put(OP.TABLES, 8, api9 ? 16 : 0); w.put(OP.STREAMS, 4); w.put(OP.TEXTURES, 8); w.put(OP.CONSTS, 1024, 128, api9 ? 64 : 0, api9 ? 64 : 0, api9 ? 16 : 0, api9 ? 16 : 0);
    for (let i = 0; i < 3000; i++) {
      switch (rnd(9)) {
        case 0: { const n = rnd(5), t = []; for (let k = 0; k < n; k++) t.push(rnd(api9 ? 25 : 9), rnd(200), rnd(0xffffffff) | 0); w.put(OP.TSETS, Int32Array.from(t)); break; }
        case 1: w.put(OP.VERSION, rnd(VERSION_FIELDS.length), num()); break;
        case 2: w.put(OP.TEXTURE, rnd(8), rnd(50)); break;
        case 3: w.put(OP.STREAM, rnd(4), rnd(50), num(), num()); break;
        case 4: w.put(OP.INDICES, rnd(50), num()); break;
        case 5: { const k = rnd(api9 ? 6 : 2), len = [1024, 128, 64, 64, 16, 16][k], n = rnd(9), lo = rnd(len - n + 1); w.put(OP.CONST, k, lo, Int32Array.from({ length: n }, () => rnd(0xffffffff) | 0)); break; }
        case 6: { const slot = [2, 3, 256, 257, 16][rnd(5)], m = rnd(6); w.put(OP.XFORM, slot, num(), m === 0 ? null : Int32Array.from({ length: m === 1 ? 4 : 16 }, () => rnd(0xffffffff) | 0)); break; }
        case 7: w.put(OP.DRAW, rnd(6), rnd(100), rnd(100)); break;
        default: w.put(OP.DRAW_INDEXED, rnd(6), rnd(100), rnd(100), rnd(100), rnd(100), num()); break;
      }
      if (rnd(500) === 0) w.put(OP.XFORMS);
    }
    const callsA = [], callsB = [], A = replayer(words, true, callsA), B = replayer(words, false, callsB);
    A.run(w.produced); B.run(w.produced);
    const a = A.devices.get(1), b = B.devices.get(1);
    assert.deepEqual(callsA, callsB, 'the same backend calls');
    for (const f of [...VERSION_FIELDS, 'textures', 'streams', 'indices']) assert.deepEqual(a[f], b[f], f);
    for (const f of CONST_FIELDS) assert.deepEqual(a[f] && Array.from(a[f]), b[f] && Array.from(b[f]), f);
    const tbl = (m) => [m.rs, ...m.tss, ...(m.samplers ?? [])].map((t) => [...t]);
    assert.deepEqual(tbl(a), tbl(b), 'state tables');
    assert.deepEqual([...a.transformSlotVersion], [...b.transformSlotVersion], 'transform versions');
    assert.deepEqual([...a.transforms].map(([k, v]) => [k, Array.from(new Int32Array(v.buffer, v.byteOffset, 16))]), [...b.transforms].map(([k, v]) => [k, Array.from(new Int32Array(v.buffer, v.byteOffset, 16))]), 'transform words');
  }
});

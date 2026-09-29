// The JPEG decoder's factored IDCT (even/odd halves, zero rows skipped, flat and row-0-only blocks, rows 4-7 zero)
// against the plain separable IDCT: the same transform, so the samples agree except where a sum falls within rounding
// noise of .5 (the reference keeps its rows in float32, the factored one in double): never more than 1 apart, and rarely.
// A flat block (DC only) is exactly DC*q/8 + 128 rounded half up, as an integer IDCT gives it: the reference's float32
// cosines put these frequent exact ties (DC*q = 4 mod 8) a hair below .5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idctFast, idctReference } from '../src/gfx/codecs/jpeg.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** Every block shape the fast IDCT distinguishes: which rows have terms, DC-only rows, dense rows. */
function block(r, n) {
  const c = new Int16Array(64);
  const kind = n % 8;
  const rows = kind === 0 ? 0 : kind === 1 ? 1 : kind === 2 ? 0x0f : kind === 3 ? 0xf0 : kind === 4 ? 1 << (1 + Math.floor(r() * 7)) : Math.floor(r() * 256);
  const amp = kind === 7 ? 1200 : 60;
  c[0] = Math.floor((r() - 0.5) * 400);
  for (let y = 0; y < 8; y++) {
    if (!(rows >> y & 1)) continue;
    const dcOnly = r() < 0.3, dense = kind >= 5;
    for (let u = 0; u < 8; u++) {
      if (dcOnly && u) break;
      if (dense || u === 0 || r() < 0.4) c[y * 8 + u] = Math.floor((r() - 0.5) * amp) || 1;
    }
  }
  return c;
}

test('factored IDCT = reference IDCT within 1, on every block shape', () => {
  const r = rng(3);
  let differ = 0, total = 0;
  for (let n = 0; n < 40000; n++) {
    if (n % 8 < 2) continue; // (flat blocks and row-0-only blocks: the ties; next test)
    const qt = Uint16Array.from({ length: 64 }, () => 1 + Math.floor(r() * (n % 3 === 0 ? 4 : 60)));
    const c = block(r, n);
    const coef = new Int16Array(64 * 2), co = (n & 1) * 64; // (a block at an offset in a larger array)
    coef.set(c, co);
    const a = new Uint8ClampedArray(64 * 3).fill(7), b = new Uint8ClampedArray(64 * 3).fill(7);
    idctReference(c, qt, a, 5, 16);
    idctFast(coef, co, qt, b, 5, 16);
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      assert.ok(d <= 1, `block ${n}: sample ${i}: ${b[i]} vs ${a[i]}`);
      if (d) differ++;
      total++;
    }
  }
  assert.ok(differ / total < 1e-3, `${differ} of ${total} samples differ`);
});

test('factored IDCT: flat blocks are DC*q/8 + 128 rounded half up, clamped', () => {
  for (const q of [1, 2, 3, 5, 8, 16, 99, 255, 1000]) {
    for (let dc = -2048; dc <= 2047; dc += 1 + (q > 8 ? 7 : 0)) {
      const c = new Int16Array(64); c[0] = dc;
      const qt = new Uint16Array(64).fill(q);
      const b = new Uint8Array(64);
      idctFast(c, 0, qt, b, 0, 8);
      const v = Math.floor((dc * q + 4) / 8) + 128, want = v < 0 ? 0 : v > 255 ? 255 : v;
      assert.ok(b.every((x) => x === want), `dc=${dc} q=${q}: ${b[0]} vs ${want}`);
    }
  }
});

test('factored IDCT: extreme coefficients clamp like the reference', () => {
  const qt = new Uint16Array(64).fill(65535);
  for (const v of [32767, -32768, 1, -1]) {
    for (const k of [0, 1, 9, 63]) {
      const c = new Int16Array(64); c[k] = v; c[0] = v;
      const a = new Uint8ClampedArray(64), b = new Uint8ClampedArray(64);
      idctReference(c, qt, a, 0, 8);
      idctFast(c, 0, qt, b, 0, 8);
      assert.deepEqual(b, a, `v=${v} k=${k}`);
    }
  }
});

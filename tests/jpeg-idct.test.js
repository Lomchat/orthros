// The JPEG decoder's pruned IDCT (zero rows skipped, flat blocks) gives exactly the plain separable IDCT's pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idctFast, idctReference } from '../src/gfx/codecs/jpeg.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('pruned IDCT = reference IDCT on sparse, flat and dense blocks', () => {
  const r = rng(3);
  const qt = Uint16Array.from({ length: 64 }, () => 1 + Math.floor(r() * 40));
  for (let n = 0; n < 3000; n++) {
    const coef = new Int16Array(64 * 2), co = (n & 1) * 64; // (a block at an offset in a larger array)
    const kind = n % 3, nnz = kind === 0 ? 0 : kind === 1 ? 1 + Math.floor(r() * 6) : 64;
    coef[co] = Math.floor((r() - 0.5) * 400);
    for (let i = 0; i < nnz; i++) { const k = kind === 1 ? Math.floor(r() * 24) : i; coef[co + k] = Math.floor((r() - 0.5) * 60); }
    const a = new Uint8ClampedArray(64 * 3), b = new Uint8ClampedArray(64 * 3);
    idctReference(coef.subarray(co, co + 64), qt, a, 5, 16);
    idctFast(coef, co, qt, b, 5, 16);
    assert.deepEqual(b, a, `block ${n}`);
  }
});

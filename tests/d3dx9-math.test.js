// D3DX math functions against their documented formulas (vectors / matrices in guest memory, float32).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { defineD3DXMath } from '../src/win32/d3dx9-math.js';

const mem = new GuestMemory({ sizeBytes: 1 << 20 });
const X = {}; defineD3DXMath(X, mem);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = (v) => { f32[0] = v; return u32[0]; };
const call = (name, args) => X[name][1]({ arg: (i) => args[i] >>> 0, argF32: (i) => { u32[0] = args[i]; return f32[0]; }, retDouble: () => {} });
const put = (a, v) => v.forEach((x, i) => mem.writeF32(a + 4 * i, x));
const get = (a, n) => Array.from({ length: n }, (_, i) => mem.readF32(a + 4 * i));
const close = (a, b, eps = 1e-4) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= eps * Math.max(1, Math.abs(b[i])), `${x} vs ${b[i]} at ${i}`));

test('Catmull-Rom and Hermite splines, output aliasing an input', () => {
  const P = [[0, 0, 0], [1, 2, 3], [4, 1, -2], [5, 5, 5]], s = 0.3;
  P.forEach((p, i) => put(0x100 + 16 * i, p));
  const cr = (i) => 0.5 * (2 * P[1][i] + (P[2][i] - P[0][i]) * s + (2 * P[0][i] - 5 * P[1][i] + 4 * P[2][i] - P[3][i]) * s * s + (3 * P[1][i] - P[0][i] - 3 * P[2][i] + P[3][i]) * s ** 3);
  call('D3DXVec3CatmullRom', [0x200, 0x100, 0x110, 0x120, 0x130, bits(s)]);
  close(get(0x200, 3), [0, 1, 2].map(cr));
  call('D3DXVec3CatmullRom', [0x110, 0x100, 0x110, 0x120, 0x130, bits(s)]); // (out = p1)
  close(get(0x110, 3), [0, 1, 2].map(cr));
  P.forEach((p, i) => put(0x100 + 16 * i, p));
  const h = (i) => { const s2 = s * s, s3 = s2 * s; return (2 * s3 - 3 * s2 + 1) * P[0][i] + (s3 - 2 * s2 + s) * P[1][i] + (-2 * s3 + 3 * s2) * P[2][i] + (s3 - s2) * P[3][i]; };
  call('D3DXVec3Hermite', [0x100, 0x100, 0x110, 0x120, 0x130, bits(s)]); // (out = p1)
  close(get(0x100, 3), [0, 1, 2].map(h));
});

test('matrix inverse: M * inverse(M) = I, determinant, singular matrix', () => {
  const M = [2, 0, 1, 0, 1, 3, 0, 0, 0, 1, 4, 0, 5, -2, 1, 1];
  put(0x300, M);
  assert.equal(call('D3DXMatrixInverse', [0x340, 0x380, 0x300]), 0x340);
  const inv = get(0x340, 16), prod = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += M[i * 4 + k] * inv[k * 4 + j]; prod.push(s); }
  close(prod, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  close(get(0x380, 1), [2 * (3 * 4 - 0) - 0 + 1 * (1 * 1 - 0)]); // det of the upper 3x3 (the last column is (0,0,0,1))
  put(0x300, [1, 2, 3, 4, 2, 4, 6, 8, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(call('D3DXMatrixInverse', [0x340, 0, 0x300]), 0, 'singular: NULL');
  put(0x300, M);
  call('D3DXMatrixInverse', [0x300, 0, 0x300]); // (in place)
  close(get(0x300, 16), inv);
});

// D3DX image conversions (d3dx9-image.js): the table-driven 8/16-bit decoders and the word-wide / tabulated encoders
// give the same bytes as the per-texel versions they replaced (tests/fixtures/image-ref.js) for every texel value,
// aligned or not; rows read in place with a pitch match a packed copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRgba, toRgbaRows, fromRgba } from '../src/win32/d3dx9-image.js';
import { FMT, surfacePitch } from '../src/win32/d3d8.js';
import { toRgbaRef, fromRgbaRef } from './fixtures/image-ref.js';

const DECODED = [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A8B8G8R8, 33, FMT.R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8, FMT.L8, FMT.P8, FMT.A8L8, FMT.A4L4, 81, FMT.G16R16];
const ENCODED = [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A8B8G8R8, 33, FMT.R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8, FMT.L8, FMT.A8L8, FMT.A4L4];
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }

test('toRgba: every texel value of every 8/16/24/32-bit format decodes as before, at any alignment', () => {
  const r = rng(5);
  for (const fmt of DECODED) {
    const w = 256, h = 257, bytes = surfacePitch(fmt, w) * h; // (16-bit formats: rows 0..255 hold every value once)
    const buf = new Uint8Array(bytes + 1);
    for (let i = 0; i < bytes; i++) buf[i + 1] = surfacePitch(fmt, 1) === 2 && i < 2 * 65536 ? (i & 1 ? (i >> 9) & 255 : (i >> 1) & 255) : r();
    for (const off of [0, 1]) {
      const data = off ? buf.subarray(1) : Uint8Array.from(buf.subarray(1)); // (off 1: an odd address in its buffer)
      assert.deepEqual(toRgba(fmt, data, w, h), toRgbaRef(fmt, data, w, h), `format ${fmt}, offset ${off}`);
    }
  }
});

test('toRgbaRows: a rectangle read in place (any pitch and alignment) equals the packed copy decoded', () => {
  const r = rng(9), mem = new Uint8Array(4096);
  for (let i = 0; i < mem.length; i++) mem[i] = r();
  for (const fmt of DECODED) for (const [addr, pitch] of [[0, 64], [3, 70], [2, 66], [8, 100]]) {
    const bpp = surfacePitch(fmt, 1), w = 9, h = 5;
    const packed = new Uint8Array(w * h * bpp);
    for (let y = 0; y < h; y++) packed.set(mem.subarray(addr + y * pitch, addr + y * pitch + w * bpp), y * w * bpp);
    assert.deepEqual(toRgbaRows(fmt, mem.subarray(addr, addr + (h - 1) * pitch + w * bpp), w, h, pitch), toRgbaRef(fmt, packed, w, h), `format ${fmt} at ${addr} pitch ${pitch}`);
  }
});

test('fromRgba: the same bytes as the per-texel encoder for every channel value, aligned or not', () => {
  const r = rng(3), w = 64, h = 67, n = w * h * 4, buf = new Uint8Array(n + 1);
  for (let i = 0; i < n; i++) buf[i + 1] = i < 1024 ? (i >> 2) & 255 : r(); // (every value in every channel, then noise)
  for (const fmt of ENCODED) for (const off of [0, 1]) {
    const rgba = off ? buf.subarray(1) : Uint8Array.from(buf.subarray(1));
    assert.deepEqual(fromRgba(fmt, rgba, w, h), fromRgbaRef(fmt, rgba, w, h), `format ${fmt}, offset ${off}`);
  }
  for (const [w2, h2] of [[1, 1], [3, 5], [2, 1]]) for (const fmt of ENCODED) { const px = buf.subarray(0, w2 * h2 * 4); assert.deepEqual(fromRgba(fmt, px, w2, h2), fromRgbaRef(fmt, px, w2, h2), `${fmt} ${w2}x${h2}`); }
});

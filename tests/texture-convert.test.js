// Texture uploads (gfx/d3d8-webgl.js surfaceToRgba): the 8- and 16-bit formats converted through a table of every
// texel value, and the conversion into a reused output buffer, give the same bytes as the per-texel conversion they
// replaced (tests/fixtures/surface-rgba-ref.js) for every texel value, at any alignment and pitch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surfaceToRgba } from '../src/gfx/d3d8-webgl.js';
import { FMT, surfacePitch } from '../src/win32/d3d8.js';
import { surfaceToRgbaRef } from './fixtures/surface-rgba-ref.js';

const FORMATS = [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A8B8G8R8, 33, FMT.R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8, FMT.L8, FMT.P8, FMT.A8L8,
  FMT.A4L4, 81, FMT.V8U8, FMT.Q8W8V8U8, FMT.V16U16, FMT.G16R16, FMT.A2B10G10R10, FMT.A2R10G10B10, FMT.DXT1, FMT.DXT5];
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }
/** a guest-memory-like object over one buffer (u8 / u32 views, bytes(addr, n)) */
function memOf(bytes) { return { u8: bytes, u32: new Uint32Array(bytes.buffer), bytes: (a, n) => bytes.subarray(a, a + n) }; }

test('surfaceToRgba: every texel value of every format, aligned or not, with a pitch, into a fresh or reused buffer', () => {
  const r = rng(7), size = 1 << 20, bytes = new Uint8Array(size), mem = memOf(bytes);
  for (let i = 0; i < size; i++) bytes[i] = r();
  // 16-bit values 0..65535 in a row of 256 x 256 texels, at an even and an odd address
  for (const base of [0x1000, 0x40001]) for (let v = 0; v < 65536; v++) { bytes[base + 2 * v] = v & 255; bytes[base + 2 * v + 1] = v >> 8; }
  const reused = new Uint8Array(1 << 19).fill(0xcd);
  for (const fmt of FORMATS) {
    const bpp = surfacePitch(fmt, 1);
    const cases = [[0x1000, 256, 256, surfacePitch(fmt, 256)], [0x40001, 256, 256, surfacePitch(fmt, 256)], [0x80003, 37, 11, surfacePitch(fmt, 37) + 6], [0x90000, 1, 1, 64], [0xa0002, 64, 3, surfacePitch(fmt, 64) + 2]];
    for (const [addr, w, h, pitch] of cases) {
      if ((fmt === FMT.DXT1 || fmt === FMT.DXT5) && (w % 4 || h % 4)) continue;
      const want = surfaceToRgbaRef(mem, fmt, addr, w, h, pitch);
      assert.deepEqual(surfaceToRgba(mem, fmt, addr, w, h, pitch), want, `format ${fmt} (${bpp} B) at 0x${addr.toString(16)} ${w}x${h} pitch ${pitch}`);
      const got = surfaceToRgba(mem, fmt, addr, w, h, pitch, reused);
      assert.equal(got.length, w * h * 4);
      assert.deepEqual(got, want, `format ${fmt} into the reused buffer`);
    }
  }
});

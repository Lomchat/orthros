// D3DX pixel conversions (d3dx9-image.js): the table-driven / whole-texel loops against the per-texel conversions they
// replaced (kept below as the reference): the same bytes for every format both ways, aligned or not, odd sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromRgba, toRgba } from '../src/win32/d3dx9-image.js';
import { FMT, surfacePitch, surfaceBytes } from '../src/win32/d3d8.js';

// ---- reference (the previous implementation)
const TEXEL = {
  [FMT.A8R8G8B8]: [4, (u8, s, out, o) => { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = u8[s + 3]; }],
  [FMT.X8R8G8B8]: [4, (u8, s, out, o) => { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; }],
  [FMT.A8B8G8R8]: [4, (u8, s, out, o) => { out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = u8[s + 3]; }],
  33: [4, (u8, s, out, o) => { out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = 255; }],
  [FMT.R8G8B8]: [3, (u8, s, out, o) => { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; }],
  [FMT.R5G6B5]: [2, (u8, s, out, o) => { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; }],
  [FMT.X1R5G5B5]: [2, (u8, s, out, o) => { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; }],
  [FMT.A1R5G5B5]: [2, (u8, s, out, o) => { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = v & 0x8000 ? 255 : 0; }],
  [FMT.A4R4G4B4]: [2, (u8, s, out, o) => { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = (v >> 12) * 17; }],
  [FMT.X4R4G4B4]: [2, (u8, s, out, o) => { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = 255; }],
  [FMT.A8]: [1, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[s]; }],
  [FMT.L8]: [1, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; }],
  [FMT.P8]: [1, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; }],
  [FMT.A8L8]: [2, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = u8[s + 1]; }],
  [FMT.A4L4]: [1, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = (u8[s] & 15) * 17; out[o + 3] = (u8[s] >> 4) * 17; }],
  81: [2, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = u8[s + 1]; out[o + 3] = 255; }],
};
const TEXEL_DEFAULT = [4, (u8, s, out, o) => { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = u8[s + 3]; }];
function toRgbaRef(fmt, u8, w, h) {
  const pitch = surfacePitch(fmt, w), out = new Uint8Array(w * h * 4), [bpp, texel] = TEXEL[fmt] ?? TEXEL_DEFAULT;
  for (let y = 0; y < h; y++) for (let x = 0, s = y * pitch, o = y * w * 4; x < w; x++, s += bpp, o += 4) texel(u8, s, out, o);
  return out;
}
function fromRgbaRef(fmt, rgba, w, h) {
  const pitch = surfacePitch(fmt, w), out = new Uint8Array(surfaceBytes(fmt, w, h));
  const q = (v, bits) => Math.round(v * ((1 << bits) - 1) / 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    let s;
    switch (fmt) {
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: s = y * pitch + 4 * x; out[s] = b; out[s + 1] = g; out[s + 2] = r; out[s + 3] = fmt === FMT.X8R8G8B8 ? 255 : a; break;
      case FMT.A8B8G8R8: case 33: s = y * pitch + 4 * x; out[s] = r; out[s + 1] = g; out[s + 2] = b; out[s + 3] = fmt === 33 ? 255 : a; break;
      case FMT.R8G8B8: s = y * pitch + 3 * x; out[s] = b; out[s + 1] = g; out[s + 2] = r; break;
      case FMT.R5G6B5: { s = y * pitch + 2 * x; const v = (q(r, 5) << 11) | (q(g, 6) << 5) | q(b, 5); out[s] = v & 255; out[s + 1] = v >> 8; break; }
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: { s = y * pitch + 2 * x; const v = ((fmt === FMT.X1R5G5B5 || a >= 128) ? 0x8000 : 0) | (q(r, 5) << 10) | (q(g, 5) << 5) | q(b, 5); out[s] = v & 255; out[s + 1] = v >> 8; break; }
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: { s = y * pitch + 2 * x; const v = ((fmt === FMT.X4R4G4B4 ? 15 : q(a, 4)) << 12) | (q(r, 4) << 8) | (q(g, 4) << 4) | q(b, 4); out[s] = v & 255; out[s + 1] = v >> 8; break; }
      case FMT.A8: out[y * pitch + x] = a; break;
      case FMT.L8: out[y * pitch + x] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b); break;
      case FMT.A8L8: s = y * pitch + 2 * x; out[s] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b); out[s + 1] = a; break;
      case FMT.A4L4: out[y * pitch + x] = (q(a, 4) << 4) | q(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), 4); break;
      default: return null;
    }
  }
  return out;
}

const FORMATS = [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A8B8G8R8, 33, FMT.R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8, FMT.L8, FMT.P8, FMT.A8L8, FMT.A4L4, 81, FMT.V8U8, FMT.G16R16];
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }

test('fromRgba: the per-texel conversion\'s bytes for every format, aligned and unaligned sources', () => {
  const r = rng(17);
  for (const [w, h] of [[1, 1], [3, 5], [16, 16], [37, 9]]) {
    const buf = new Uint8Array(w * h * 4 + 1); for (let i = 0; i < buf.length; i++) buf[i] = r();
    for (const src of [buf.subarray(0, w * h * 4), buf.subarray(1)]) for (const fmt of FORMATS) assert.deepEqual(fromRgba(fmt, src, w, h), fromRgbaRef(fmt, src, w, h), `fmt ${fmt} ${w}x${h} offset ${src.byteOffset}`);
  }
  // every 8-bit value through each channel of the quantized formats
  const ramp = new Uint8Array(256 * 4); for (let v = 0; v < 256; v++) ramp.fill(v, 4 * v, 4 * v + 4);
  for (const fmt of FORMATS) assert.deepEqual(fromRgba(fmt, ramp, 16, 16), fromRgbaRef(fmt, ramp, 16, 16), `ramp fmt ${fmt}`);
  // a source cut short (aligned and not): the missing channels read as 0, as the per-texel conversion does
  const long = new Uint8Array(6 * 5 * 4 + 1); for (let i = 0; i < long.length; i++) long[i] = r();
  for (const cut of [1, 3, 6]) for (const src of [long.subarray(0, 6 * 5 * 4 - cut), long.subarray(1, 1 + 6 * 5 * 4 - cut)])
    for (const fmt of FORMATS) assert.deepEqual(fromRgba(fmt, src, 6, 5), fromRgbaRef(fmt, src, 6, 5), `short by ${cut} fmt ${fmt} offset ${src.byteOffset}`);
});

test('toRgba: the per-texel conversion\'s texels for every format and every value of the 1- and 2-byte formats', () => {
  const r = rng(29);
  for (const fmt of FORMATS) {
    const bpp = surfacePitch(fmt, 1);
    if (bpp <= 2) { // (all 256 / 65536 values)
      const n = bpp === 1 ? 256 : 65536, raw = new Uint8Array(n * bpp);
      for (let v = 0; v < n; v++) { raw[bpp * v] = v & 255; if (bpp === 2) raw[bpp * v + 1] = v >> 8; }
      assert.deepEqual(toRgba(fmt, raw, 256, n / 256), toRgbaRef(fmt, raw, 256, n / 256), `all values fmt ${fmt}`);
    }
    for (const [w, h] of [[1, 1], [3, 5], [37, 9]]) {
      const buf = new Uint8Array(surfaceBytes(fmt, w, h) + 1); for (let i = 0; i < buf.length; i++) buf[i] = r();
      for (const src of [buf.subarray(0, buf.length - 1), buf.subarray(1)]) assert.deepEqual(toRgba(fmt, src, w, h), toRgbaRef(fmt, src, w, h), `fmt ${fmt} ${w}x${h} offset ${src.byteOffset}`);
      if (bpp > 2) continue;
      const short = buf.subarray(0, (buf.length - 1) >> 1); // (data cut short, 1- and 2-byte formats: the missing bytes read as 0, as before)
      assert.deepEqual(toRgba(fmt, short, w, h), toRgbaRef(fmt, short, w, h), `short fmt ${fmt} ${w}x${h}`);
    }
  }
});

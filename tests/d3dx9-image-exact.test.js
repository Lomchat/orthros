// D3DX image work against the implementation it replaced (tests/fixtures/d3dx9-image-base.js, verbatim): the
// WebAssembly kernels (d3dx9-image-wasm.js: DXT encoder, 32-bit swizzle, 2:1 mip filter), the JavaScript one it falls back to, the helper pool on shared WebAssembly
// memory, mip chains (box / point filters, odd sizes) and the header-only image information give the same bytes and
// fields for random images of every size, format and alpha pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import * as cur from '../src/win32/d3dx9-image.js';
import * as base from './fixtures/d3dx9-image-base.js';
import { FMT } from '../src/win32/d3d8.js';
import { imageWasmSupported } from '../src/win32/d3dx9-image-wasm.js';
import { DxtPool } from '../src/win32/dxt-pool.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }
const DXT = [FMT.DXT1, FMT.DXT2, FMT.DXT3, FMT.DXT4, FMT.DXT5];
/** an RGBA8 image of one of several kinds: noise, smooth gradients with grain, flat areas, binary / ramp / sparse alpha, few colors */
function image(r, w, h, kind) {
  const px = new Uint8Array(w * h * 4), c = [r(), r(), r(), r()];
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0, g = r() & 15;
    const o = 4 * i;
    switch (kind % 7) {
      case 0: px[o] = r(); px[o + 1] = r(); px[o + 2] = r(); px[o + 3] = r(); break;
      case 1: px[o] = (x * 7 + g) & 255; px[o + 1] = (y * 5 + g) & 255; px[o + 2] = ((x + y) * 3) & 255; px[o + 3] = 255; break;
      case 2: px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3]; break; // (uniform blocks: equal endpoints)
      case 3: px[o] = (x * 9) & 255; px[o + 1] = (y * 9) & 255; px[o + 2] = g * 16; px[o + 3] = r() < 90 ? (r() & 127) : 128 + (r() & 127); break; // (DXT1: transparent texels)
      case 4: px[o] = r() & 0xf8; px[o + 1] = r() & 0xfc; px[o + 2] = r() & 0xf8; px[o + 3] = r() < 128 ? 0 : 255; break; // (565-exact colors)
      case 5: px[o] = r() < 128 ? 0 : 255; px[o + 1] = r() < 128 ? 0 : 255; px[o + 2] = r() < 40 ? 7 : 248; px[o + 3] = (x * 255 / Math.max(1, w - 1)) | 0; break; // (few colors, alpha ramp)
      default: px[o] = c[0] + (g >> 3); px[o + 1] = c[1] ^ (g & 1); px[o + 2] = c[2]; px[o + 3] = c[3] ^ (g & 3); break; // (nearly uniform)
    }
  }
  return px;
}
const SIZES = [[1, 1], [2, 2], [3, 1], [4, 4], [5, 3], [7, 9], [8, 8], [12, 4], [13, 7], [16, 16], [17, 33], [31, 30], [64, 32], [66, 70], [128, 4], [255, 9]];

test('DXT1-5: the encoder gives the base encoder\'s blocks (WebAssembly and JavaScript), every size and alpha pattern', () => {
  const r = rng(1);
  for (const [w, h] of SIZES) for (let kind = 0; kind < 7; kind++) {
    const px = image(r, w, h, kind);
    for (const fmt of DXT) {
      const want = base.fromRgba(fmt, px, w, h);
      assert.deepEqual(cur.fromRgba(fmt, px, w, h), want, `${w}x${h} kind ${kind} fmt ${fmt.toString(16)}`);
      const bh = Math.max(1, (h + 3) >> 2);
      assert.deepEqual(cur.encodeDxtRowsJs(fmt, px, w, h, 0, bh, new Uint8Array(want.length)), want, `JavaScript ${w}x${h} kind ${kind}`);
    }
  }
});

test('DXT: block rows encoded separately (the pool\'s parts) land at their place, as the base encoder writes them', () => {
  const r = rng(2);
  for (const [w, h] of [[64, 64], [37, 50], [256, 12]]) for (const fmt of [FMT.DXT1, FMT.DXT3, FMT.DXT5]) {
    const px = image(r, w, h, 3), bh = Math.max(1, (h + 3) >> 2), n = cur.dxtBytes(fmt, w, h);
    for (const [a, b] of [[0, 1], [1, bh - 1], [bh - 1, bh], [2, 3]]) {
      if (b <= a) continue;
      assert.deepEqual(cur.encodeDxtRows(fmt, px, w, h, a, b, new Uint8Array(n).fill(0xa5)), base.encodeDxtRows(fmt, px, w, h, a, b, new Uint8Array(n).fill(0xa5)), `${w}x${h} rows ${a}..${b}`);
    }
  }
});

test('DXT: random blocks in volume, both encoders against the base', () => {
  const r = rng(3), w = 64, h = 64;
  for (let n = 0; n < 60; n++) {
    const px = image(r, w, h, n), fmt = DXT[n % DXT.length], bh = 16, want = base.fromRgba(fmt, px, w, h);
    assert.deepEqual(cur.encodeDxtRows(fmt, px, w, h, 0, bh, new Uint8Array(want.length)), want, `image ${n}`);
  }
});

test('the WebAssembly encoder is there (Node and Chrome have WebAssembly SIMD), and switching it off changes nothing', () => {
  assert.ok(imageWasmSupported());
  const r = rng(4), px = image(r, 40, 24, 3);
  const on = cur.fromRgba(FMT.DXT1, px, 40, 24);
  globalThis.ORTHROS_DXT_WASM = 0;
  try { assert.deepEqual(cur.fromRgba(FMT.DXT1, px, 40, 24), on); } finally { delete globalThis.ORTHROS_DXT_WASM; }
});

test('mip chains (D3DXFilterTexture, D3DX\'s mip filter): resize and re-encode level after level as the base does', () => {
  const r = rng(5);
  const formats = [FMT.DXT1, FMT.DXT5, FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A1R5G5B5, FMT.R5G6B5, FMT.A4R4G4B4, FMT.L8, FMT.A8L8];
  for (const [w0, h0] of [[64, 64], [64, 16], [30, 70], [1, 8], [9, 9]]) for (const point of [false, true]) {
    const px = image(r, w0, h0, (w0 + h0) % 7);
    for (const fmt of formats) {
      let a = cur.toRgba(fmt, cur.fromRgba(fmt, px, w0, h0), w0, h0), b = base.toRgba(fmt, base.fromRgba(fmt, px, w0, h0), w0, h0);
      assert.deepEqual(a, b, `level 0 ${w0}x${h0} fmt ${fmt}`);
      for (let w = w0, h = h0; w > 1 || h > 1;) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
        a = cur.resizeRgba(a, w, h, nw, nh, point); b = base.resizeRgba(b, w, h, nw, nh, point);
        assert.deepEqual(a, b, `resize ${w}x${h} -> ${nw}x${nh} point ${point}`);
        assert.deepEqual(cur.fromRgba(fmt, a, nw, nh), base.fromRgba(fmt, b, nw, nh), `encode ${nw}x${nh} fmt ${fmt}`);
        w = nw; h = nh;
      }
    }
  }
  // other sizes (D3DXLoadSurface* into a rectangle of another size)
  const px = image(r, 50, 30, 1);
  for (const [dw, dh] of [[17, 9], [100, 61], [50, 1], [3, 30]]) for (const point of [false, true]) assert.deepEqual(cur.resizeRgba(px, 50, 30, dw, dh, point), base.resizeRgba(px, 50, 30, dw, dh, point), `${dw}x${dh}`);
});

test('DXT decoding: random blocks (both color modes, both DXT5 alpha modes, every index) decode to the base\'s bytes', () => {
  const r = rng(13);
  for (const fmt of DXT) for (const [w, h] of [[64, 64], [32, 33], [37, 50], [256, 4], [5, 300], [1024, 1], [2, 600]]) {
    const n = cur.dxtBytes(fmt, w, h), blocks = Uint8Array.from({ length: n + 3 }, () => r());
    if (fmt !== FMT.DXT1) for (let o = 0; o < n; o += 32) { blocks[o] = blocks[o + 1]; } // (some a0 = a1)
    for (const off of [0, 3]) { const b = blocks.subarray(off, off + n); assert.deepEqual(cur.toRgba(fmt, b, w, h), base.toRgba(fmt, b, w, h), `fmt ${fmt} ${w}x${h} at ${off}`); }
  }
  // the colors of a decoded image re-encoded and decoded again (smooth data: few random blocks)
  const px = image(r, 128, 96, 1);
  for (const fmt of DXT) { const enc = base.fromRgba(fmt, px, 128, 96); assert.deepEqual(cur.toRgba(fmt, enc, 128, 96), base.toRgba(fmt, enc, 128, 96)); }
  // blocks missing (a truncated file): the JavaScript decoder's zeros, as before
  const short = Uint8Array.from({ length: 100 }, () => r());
  assert.deepEqual(cur.toRgba(FMT.DXT5, short, 64, 64), base.toRgba(FMT.DXT5, short, 64, 64));
});

test('32-bit and 16-bit conversions: every texel value, odd widths (the kernels\' tails), pitches and alignments as the base', () => {
  const r = rng(11);
  // 16-bit formats: every value (65536 texels) laid out in rows of several widths and pitches; and 8-bit samples
  const all16 = new Uint8Array(2 * 65536 + 64); for (let v = 0; v < 65536; v++) { all16[2 * v] = v & 255; all16[2 * v + 1] = v >> 8; }
  for (let i = 2 * 65536; i < all16.length; i++) all16[i] = r();
  for (const fmt of [FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8L8, 81]) {
    for (const [w, pitch, off] of [[256, 512, 0], [251, 512, 0], [37, 80, 1], [1027, 2054, 2], [7, 14, 0]]) {
      const h = Math.min(400, Math.floor((all16.length - off - 2 * w) / pitch) + 1), src = all16.subarray(off, off + (h - 1) * pitch + 2 * w);
      assert.deepEqual(cur.toRgbaRows(fmt, src, w, h, pitch), base.toRgbaRows(fmt, src, w, h, pitch), `decode ${fmt} ${w}x${h} pitch ${pitch} at ${off}`);
    }
  }
  // 32-bit formats: random texels, pitches with gaps, odd addresses
  const buf = Uint8Array.from({ length: 300 * 1024 }, () => r());
  for (const fmt of [FMT.A8R8G8B8, FMT.X8R8G8B8]) for (const [w, pitch, off] of [[256, 1024, 0], [61, 260, 3], [1030, 4120, 1], [33, 132, 0]]) {
    const h = Math.min(60, Math.floor((buf.length - off - 4 * w) / pitch) + 1), src = buf.subarray(off, off + (h - 1) * pitch + 4 * w);
    assert.deepEqual(cur.toRgbaRows(fmt, src, w, h, pitch), base.toRgbaRows(fmt, src, w, h, pitch), `decode ${fmt} ${w}x${h} pitch ${pitch} at ${off}`);
  }
  // encodes: every channel value, texel counts that are not a multiple of 8, unaligned views
  for (const fmt of [FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8R8G8B8, FMT.X8R8G8B8]) for (const [w, h, off] of [[64, 67, 0], [131, 9, 1], [1025, 1, 2], [3, 345, 0]]) {
    const px = buf.subarray(off, off + w * h * 4); for (let i = 0; i < 1024; i++) px[i] = i >> 2;
    assert.deepEqual(cur.fromRgba(fmt, px, w, h), base.fromRgba(fmt, px, w, h), `encode ${fmt} ${w}x${h} at ${off}`);
  }
  // 2:1 filter: odd output widths, unaligned sources
  for (const [dw, dh, off] of [[33, 17, 0], [64, 1, 1], [1, 64, 0], [129, 40, 2]]) {
    const src = buf.subarray(off, off + dw * dh * 16);
    assert.deepEqual(cur.resizeRgba(src, 2 * dw, 2 * dh, dw, dh), base.resizeRgba(src, 2 * dw, 2 * dh, dw, dh), `halve to ${dw}x${dh} at ${off}`);
  }
});

test('mipChain (D3DXFilterTexture\'s levels at once): the base\'s resize + encode level after level, every kernel format and size', () => {
  const r = rng(12);
  const chainSizes = (w, h) => { const s = []; while (w > 1 || h > 1) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); s.push([w, h]); } return s; };
  const formats = [FMT.DXT1, FMT.DXT3, FMT.DXT5, FMT.A1R5G5B5, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8R8G8B8, FMT.X8R8G8B8];
  for (const [w, h] of [[256, 256], [128, 32], [64, 1], [1, 16], [12, 20], [6, 6], [2, 1]]) for (const fmt of formats) {
    const px = image(r, w, h, (w * 3 + h + fmt) % 7);
    const sizes = chainSizes(w, h);
    // (and a chain that starts with an equal size, and one with a general resize step: the handler's levels need not halve)
    for (const sz of [sizes, ...(w >= 4 ? [[[w, h], ...sizes], [[w - 1, Math.max(1, h - 3)], ...sizes.slice(1)]] : [])]) {
      const got = cur.mipChain(fmt, px, w, h, sz);
      assert.ok(got, `${fmt} ${w}x${h}: the kernels take it`);
      let from = px, fw = w, fh = h;
      sz.forEach(([lw, lh], i) => {
        from = base.resizeRgba(from, fw, fh, lw, lh); fw = lw; fh = lh;
        assert.deepEqual(got[i], base.fromRgba(fmt, from, lw, lh), `fmt ${fmt} ${w}x${h} level ${i} (${lw}x${lh})`);
      });
    }
  }
  assert.equal(cur.mipChain(FMT.L8, image(r, 8, 8, 1), 8, 8, [[4, 4]]), null, 'no kernel for L8: level by level');
  // the source level given as its own data (unpacked by the kernels): as decoding it with toRgba first
  for (const fmt of [FMT.A1R5G5B5, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4, FMT.A8R8G8B8, FMT.X8R8G8B8]) for (const [w, h] of [[64, 64], [24, 6], [1, 4]]) {
    const raw = base.fromRgba(fmt, image(r, w, h, w + fmt), w, h), sizes = chainSizes(w, h);
    const want = []; let from = base.toRgba(fmt, raw, w, h), fw = w, fh = h;
    for (const [lw, lh] of sizes) { from = base.resizeRgba(from, fw, fh, lw, lh); fw = lw; fh = lh; want.push(base.fromRgba(fmt, from, lw, lh)); }
    const got = cur.mipChain(fmt, raw, w, h, sizes, fmt);
    assert.equal(got.length, want.length);
    got.forEach((g, i) => assert.deepEqual(g, want[i], `raw ${fmt} ${w}x${h} level ${i}`));
  }
  // DXT sources (decoded by the kernels), into DXT and other formats, to smaller, equal and larger sizes (D3DX's level
  // conversions: one target level, any size)
  for (const srcFmt of [FMT.DXT1, FMT.DXT3, FMT.DXT5]) for (const [w, h] of [[64, 64], [20, 12], [1, 1], [4, 2]]) {
    const raw = base.fromRgba(srcFmt, image(r, w, h, w + srcFmt), w, h);
    for (const fmt of [srcFmt, FMT.DXT1, FMT.A8R8G8B8, FMT.A4R4G4B4]) for (const sz of [chainSizes(w, h), [[w, h]], [[w * 2, h + 3]], [[Math.max(1, w >> 1), Math.max(1, h >> 1)]]]) {
      if (!sz.length) continue;
      let from = base.toRgba(srcFmt, raw, w, h), fw = w, fh = h;
      const got = cur.mipChain(fmt, raw, w, h, sz, srcFmt);
      sz.forEach(([lw, lh], i) => { from = base.resizeRgba(from, fw, fh, lw, lh); fw = lw; fh = lh; assert.deepEqual(got[i], base.fromRgba(fmt, from, lw, lh), `DXT source ${srcFmt} ${w}x${h} -> ${fmt} level ${i} ${lw}x${lh}`); });
    }
  }
  assert.equal(cur.mipChain(FMT.DXT1, new Uint8Array(4), 4, 4, [[2, 2]], FMT.DXT1), null, 'blocks missing: the caller decodes');
});

// ---- image information (D3DXGetImageInfoFromFile*): the header-only TGA / BMP paths against the full parse
const fields = (im) => (im ? { width: im.width, height: im.height, depth: im.depth, mips: im.mips, fmt: im.fmt, infoFmt: im.infoFmt, fileFormat: im.fileFormat, kind: im.kind } : null);
/** the base's information as D3DX reported it: an exception while parsing counts as invalid data */
const baseInfo = (b) => { try { return fields(base.parseImageInfo(b)); } catch { return null; } };
function tga(r, { type, bpp, cm = 0, cmBits = 24, cmLen = 4, w = 5, h = 3, desc = 0, idLen = 0, cut = 0 }) {
  const Bpp = Math.ceil(bpp / 8), eb = Math.ceil(cmBits / 8), body = type >= 9 ? 40 : w * h * Bpp;
  const b = new Uint8Array(Math.max(0, 18 + idLen + (cm ? cmLen * eb : 0) + body - cut));
  const hd = [idLen, cm, type, 0, 0, cmLen & 255, cmLen >> 8, cmBits, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, bpp, desc];
  for (let i = 0; i < Math.min(18, b.length); i++) b[i] = hd[i];
  for (let i = 18; i < b.length; i++) b[i] = r();
  return b;
}
test('image information: TGA headers read as the full parse reports them (types, depths, color maps, truncation)', () => {
  const r = rng(6);
  let n = 0;
  for (const type of [0, 1, 2, 3, 4, 9, 10, 11]) for (const bpp of [8, 15, 16, 24, 32, 7]) for (const cm of [0, 1, 2]) for (const cmBits of [0, 15, 24, 32]) for (const cut of [0, 1, 30]) for (const desc of [0, 0x28, 0x11]) {
    const b = tga(r, { type, bpp, cm, cmBits, cut, desc, w: 1 + (r() % 9), h: 1 + (r() % 9), idLen: r() % 3 });
    assert.deepEqual(fields(cur.parseImageInfo(b)), baseInfo(b), `TGA type ${type} bpp ${bpp} cm ${cm}/${cmBits} cut ${cut} desc ${desc}`);
    n++;
  }
  for (const b of [new Uint8Array(0), new Uint8Array(17), tga(r, { type: 2, bpp: 32, w: 0 }), tga(r, { type: 2, bpp: 24, h: 0 })]) assert.deepEqual(fields(cur.parseImageInfo(b)), baseInfo(b));
  assert.ok(n > 1000);
});
function bmp(r, { w = 6, h = 4, bpp = 24, comp = 0, clrUsed = 0, cut = 0 }) {
  const stride = ((w * bpp + 31) >> 5) * 4, pal = bpp <= 8 ? 4 * (clrUsed || 1 << bpp) : 0, off = 54 + pal, size = off + stride * Math.abs(h);
  const b = new Uint8Array(Math.max(55, size - cut)), dv = new DataView(b.buffer);
  for (let i = 54; i < b.length; i++) b[i] = r();
  b[0] = 0x42; b[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, off, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, bpp, true); dv.setUint32(30, comp, true); dv.setUint32(46, clrUsed, true);
  return b;
}
test('image information: BMP headers read as the full parse reports them', () => {
  const r = rng(7);
  for (const bpp of [1, 4, 8, 16, 24, 32, 2]) for (const comp of [0, 1, 3]) for (const h of [4, -4, 0, 1]) for (const w of [6, 0, -2, 1]) for (const cut of [0, 20]) {
    const b = bmp(r, { w, h, bpp, comp, cut, clrUsed: bpp === 8 ? 16 : 0 });
    assert.deepEqual(fields(cur.parseImageInfo(b)), baseInfo(b), `BMP ${w}x${h} bpp ${bpp} comp ${comp} cut ${cut}`);
  }
});
test('image information: DDS, JPEG, PNG and unknown data as before, read in place from shared memory', () => {
  const r = rng(8);
  const dds = new Uint8Array(128 + 64 * 64), dv = new DataView(dds.buffer);
  dds.set([0x44, 0x44, 0x53, 0x20]); dv.setUint32(8, 0x2000f, true); dv.setUint32(12, 32, true); dv.setUint32(16, 32, true); dv.setUint32(28, 3, true); dv.setUint32(80, 4, true); dv.setUint32(84, 0x31545844, true);
  const garbage = Uint8Array.from({ length: 300 }, () => r());
  const png = new Uint8Array(40); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 64, 8, 6]);
  const jpg = new Uint8Array(30); jpg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 48, 0, 96, 3]);
  for (const b of [dds, garbage, png, jpg, tga(r, { type: 10, bpp: 32 }), bmp(r, {})]) {
    const sab = new Uint8Array(new SharedArrayBuffer(b.length + 8)); sab.set(b, 8);
    assert.deepEqual(fields(cur.parseImageInfo(sab.subarray(8), true)), baseInfo(b));
  }
});

test('helper pool on shared WebAssembly memory: the base encoder\'s blocks, encoder switched per job', async () => {
  const url = new URL('../src/win32/dxt-pool.js', import.meta.url).href;
  const threads = [];
  const spawn = () => { const w = new Worker(`import('${url}').then(({ helperLoop }) => require('node:worker_threads').parentPort.once('message', helperLoop));`, { eval: true }); threads.push(w); return w; };
  const pool = new DxtPool(2, spawn);
  try {
    const r = rng(9);
    for (const off of [false, true]) {
      if (off) globalThis.ORTHROS_DXT_WASM = 0;
      for (const fmt of [FMT.DXT1, FMT.DXT3, FMT.DXT5]) for (const [w, h] of [[256, 136], [130, 250]]) {
        const px = image(r, w, h, w + fmt);
        assert.deepEqual(pool.encode(fmt, px, w, h), base.fromRgba(fmt, px, w, h), `fmt ${fmt} ${w}x${h} ${off ? 'JavaScript' : 'WebAssembly'}`);
      }
    }
  } finally { delete globalThis.ORTHROS_DXT_WASM; for (const t of threads) await t.terminate(); }
});

// The DXT encoder (d3dx9-image.js: no allocation per block, nearest palette entry found by projection on the endpoint
// axis) against the straightforward version it replaced (kept below as the reference, a distance to each palette
// entry): the same endpoints, the same choices but for exact ties, never a larger error; DXT1 with and without
// transparent texels, DXT3, DXT5; and the 2:1 box filter of mip levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDxt, resizeRgba } from '../src/win32/d3dx9-image.js';
import { FMT } from '../src/win32/d3d8.js';
import { decodeDxt } from '../src/gfx/d3d8-webgl.js';

// ---- reference (the previous implementation)
const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
function colorBlockRef(px, out, o, transparent) {
  let minL = Infinity, maxL = -Infinity, lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) { if (transparent && px[4 * i + 3] < 128) continue; const l = px[4 * i] * 2 + px[4 * i + 1] * 4 + px[4 * i + 2]; if (l < minL) { minL = l; lo = i; } if (l > maxL) { maxL = l; hi = i; } }
  let c0 = to565(px[4 * hi], px[4 * hi + 1], px[4 * hi + 2]), c1 = to565(px[4 * lo], px[4 * lo + 1], px[4 * lo + 2]);
  const anyTransparent = transparent && [...Array(16).keys()].some((i) => px[4 * i + 3] < 128);
  if (anyTransparent) { if (c0 > c1) [c0, c1] = [c1, c0]; } else { if (c0 < c1) [c0, c1] = [c1, c0]; if (c0 === c1) { if (c1 > 0) c1--; else c0++; } }
  const a = from565(c0), b = from565(c1);
  const pal = anyTransparent ? [a, b, a.map((x, k) => (x + b[k]) / 2), null] : [a, b, a.map((x, k) => (2 * x + b[k]) / 3), a.map((x, k) => (x + 2 * b[k]) / 3)];
  let idx = 0;
  for (let i = 15; i >= 0; i--) { let best = 0, bd = Infinity; if (anyTransparent && px[4 * i + 3] < 128) best = 3; else for (let k = 0; k < 4; k++) { if (!pal[k]) continue; const d = (pal[k][0] - px[4 * i]) ** 2 + (pal[k][1] - px[4 * i + 1]) ** 2 + (pal[k][2] - px[4 * i + 2]) ** 2; if (d < bd) { bd = d; best = k; } } idx = (idx << 2) | best; }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8; out[o + 4] = idx & 255; out[o + 5] = (idx >>> 8) & 255; out[o + 6] = (idx >>> 16) & 255; out[o + 7] = (idx >>> 24) & 255;
}
function encodeRef(fmt, rgba, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), unit = fmt === FMT.DXT1 ? 8 : 16, out = new Uint8Array(bw * bh * unit), px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const sx = Math.min(w - 1, bx * 4 + x), sy = Math.min(h - 1, by * 4 + y), s = (sy * w + sx) * 4, d = (y * 4 + x) * 4; px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3]; }
    const o = (by * bw + bx) * unit;
    if (fmt === FMT.DXT1) { colorBlockRef(px, out, o, true); continue; }
    if (fmt === FMT.DXT3) { for (let i = 0; i < 16; i += 2) out[o + (i >> 1)] = (px[4 * i + 3] >> 4) | ((px[4 * i + 7] >> 4) << 4); }
    else {
      let a0 = 0, a1 = 255; for (let i = 0; i < 16; i++) { a0 = Math.max(a0, px[4 * i + 3]); a1 = Math.min(a1, px[4 * i + 3]); }
      if (a0 === a1) { if (a1 > 0) a1--; else a0++; }
      const levels = [a0, a1]; for (let k = 1; k < 7; k++) levels.push(((7 - k) * a0 + k * a1) / 7);
      let bits = 0n; for (let i = 15; i >= 0; i--) { let best = 0, bd = Infinity; for (let k = 0; k < 8; k++) { const d = Math.abs(levels[k] - px[4 * i + 3]); if (d < bd) { bd = d; best = k; } } bits = (bits << 3n) | BigInt(best); }
      out[o] = a0; out[o + 1] = a1; for (let k = 0; k < 6; k++) out[o + 2 + k] = Number((bits >> BigInt(8 * k)) & 255n);
    }
    colorBlockRef(px, out, o + 8, false);
  }
  return out;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
function image(r, w, h, kind) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    if (kind === 0) for (let c = 0; c < 4; c++) px[4 * i + c] = (r() * 256) | 0; // noise
    else { px[4 * i] = (x * 9 + y * 3) & 255; px[4 * i + 1] = (x * y) & 255; px[4 * i + 2] = 200 - y; px[4 * i + 3] = kind === 2 ? ((x + y) % 5 === 0 ? 0 : 255) : (x * 16) & 255; } // gradients, holes
  }
  return px;
}

const err = (fmt, blocks, px, w, h) => { const d = decodeDxt(fmt, blocks, w, h); let e = 0; for (let i = 0; i < px.length; i++) if ((i & 3) !== 3 || fmt !== FMT.DXT1) e += (d[i] - px[i]) ** 2; return e; };
test('DXT1 / DXT3 / DXT5: the reference encoder\'s blocks but for ties, never a larger error', () => {
  const r = rng(11);
  let same = 0, total = 0;
  for (const [w, h] of [[16, 16], [13, 7], [4, 4], [1, 1], [64, 32]]) for (const kind of [0, 1, 2]) {
    const px = image(r, w, h, kind);
    for (const fmt of [FMT.DXT1, FMT.DXT3, FMT.DXT5]) {
      const a = encodeDxt(fmt, px, w, h), b = encodeRef(fmt, px, w, h), unit = fmt === FMT.DXT1 ? 8 : 16;
      for (let o = 0; o < a.length; o += unit, total++) { let eq = true; for (let k = 0; k < unit; k++) if (a[o + k] !== b[o + k]) eq = false; if (eq) same++; }
      assert.ok(err(fmt, a, px, w, h) <= err(fmt, b, px, w, h) + 1e-9, `${w}x${h} kind ${kind} fmt ${fmt}: larger error`);
    }
  }
  assert.ok(same / total > 0.95, `identical blocks ${same} / ${total}`);
});

test('2:1 box filter of a mip level = the general box filter', () => {
  const r = rng(5), px = image(r, 32, 16, 0);
  const general = (src, sw, sh, dw, dh) => { const out = new Uint8Array(dw * dh * 4); for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let s = [0, 0, 0, 0]; for (let yy = 2 * y; yy < 2 * y + 2; yy++) for (let xx = 2 * x; xx < 2 * x + 2; xx++) for (let c = 0; c < 4; c++) s[c] += src[(yy * sw + xx) * 4 + c]; for (let c = 0; c < 4; c++) out[(y * dw + x) * 4 + c] = s[c] / 4 + 0.5 | 0; } return out; };
  assert.deepEqual(resizeRgba(px, 32, 16, 16, 8), general(px, 32, 16, 16, 8));
});

// Mip levels: the 2:1 box filter on 32-bit words (two 16-bit lanes per word) gives each channel (sum + 2) >> 2, the
// general formula's rounding — aligned images through the word path, an unaligned view through the byte loop.
test('2:1 mip filter: every channel the rounded average of its 2 x 2 texels, aligned or not', () => {
  const w = 64, h = 32, buf = new Uint8Array(w * h * 4 + 1);
  let s = 99; for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) >>> 0; buf[i] = s >>> 24; }
  buf.fill(255, 0, 64); // (saturated texels: the lane sums at their largest)
  for (const src of [buf.subarray(0, w * h * 4), buf.subarray(1)]) {
    const got = resizeRgba(src, w, h, w / 2, h / 2);
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) for (let c = 0; c < 4; c++) {
      const i = (2 * y * w + 2 * x) * 4 + c;
      assert.equal(got[(y * (w / 2) + x) * 4 + c], (src[i] + src[i + 4] + src[i + w * 4] + src[i + w * 4 + 4] + 2) >> 2);
    }
  }
});

// DXT5 alpha: the nearest of the 8 levels is searched only around the texel's position on the a0 -> a1 scale; every
// alpha between every pair of endpoints must pick what the reference's scan of all 8 levels picks (ties included).
test('DXT5 alpha blocks: the reference choice for every alpha of every endpoint pair', () => {
  const px = new Uint8Array(64);
  for (let hi = 0; hi < 256; hi++) for (let lo = 0; lo <= hi; lo++) {
    for (let start = lo; start <= hi; start += 14) {
      for (let i = 0; i < 16; i++) { px[4 * i] = (i * 37 + hi) & 255; px[4 * i + 1] = (i * 11) & 255; px[4 * i + 2] = 0; px[4 * i + 3] = i === 0 ? hi : i === 1 ? lo : Math.min(hi, start + i - 2); }
      const a = encodeDxt(FMT.DXT5, px, 4, 4), b = encodeRef(FMT.DXT5, px, 4, 4);
      for (let k = 0; k < 8; k++) if (a[k] !== b[k]) assert.fail(`endpoints ${hi}/${lo} from ${start}: alpha byte ${k} ${a[k]} != ${b[k]}`);
      if (lo === hi) break;
    }
  }
});

// A block of 16 equal texels has its color index computed once: the same block as when every texel is examined.
test('uniform blocks: the index of every texel the same as the reference', () => {
  const px = new Uint8Array(64);
  const r = rng(3);
  for (let n = 0; n < 2000; n++) {
    const c = [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0, n % 3 === 0 ? 0 : n % 3 === 1 ? 255 : (r() * 256) | 0];
    for (let i = 0; i < 64; i++) px[i] = c[i & 3];
    for (const fmt of [FMT.DXT1, FMT.DXT5]) assert.deepEqual(encodeDxt(fmt, px, 4, 4), encodeRef(fmt, px, 4, 4), `texel ${c} fmt ${fmt}`);
  }
});

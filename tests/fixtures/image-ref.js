// The image conversions of src/win32/d3dx9-image.js before their table-driven / word-wide rewrite, kept as the
// reference the tests compare the current ones with (same bytes out for every input).
import { FMT, surfacePitch, surfaceBytes } from '../../src/win32/d3d8.js';
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;
export function toRgbaRef(fmt, data, w, h) { return surfaceToRgbaLocal(fmt, data, w, h, surfacePitch(fmt, w)); }
/** per-format texel conversions to RGBA8 (source bytes at s, out at o), for one row loop per format */
const TO_RGBA = {
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
  81: [2, (u8, s, out, o) => { out[o] = out[o + 1] = out[o + 2] = u8[s + 1]; out[o + 3] = 255; }], // L16
};
const TO_RGBA_DEFAULT = [4, (u8, s, out, o) => { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = u8[s + 3]; }];

function surfaceToRgbaLocal(fmt, u8, w, h, pitch) {
  const out = new Uint8Array(w * h * 4);
  if ((fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8) && ((u8.byteOffset | pitch) & 3) === 0) { // (whole texels: B,G,R,A -> R,G,B,A on 32-bit lanes)
    const src = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2), dst = new Uint32Array(out.buffer), alpha = fmt === FMT.X8R8G8B8 ? 0xff000000 : 0;
    for (let y = 0; y < h; y++) for (let x = 0, si = (y * pitch) >> 2, o = y * w; x < w; x++, si++, o++) { const v = src[si]; dst[o] = ((v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff) | alpha) >>> 0; }
    return out;
  }
  const [bpp, texel] = TO_RGBA[fmt] ?? TO_RGBA_DEFAULT; // (one loop per format: the conversion is chosen once, not per texel)
  for (let y = 0; y < h; y++) for (let x = 0, s = y * pitch, o = y * w * 4; x < w; x++, s += bpp, o += 4) texel(u8, s, out, o);
  return out;
}

/** RGBA8 to raw pixels of `fmt` (uncompressed formats; null when not encodable here). */
export function fromRgbaRef(fmt, rgba, w, h) {
  if (isDxt(fmt)) return encodeDxtRef(fmt, rgba, w, h);
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

// ---------------------------------------------------------------- block compression (DXT1/3/5 encoder)
const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
/** texel indexes of an alpha block, its palette: scratch */
const IDX = new Uint8Array(16), APAL = new Float64Array(8);
/**
 * One color block (8 bytes) for 16 RGBA texels; `transparent`: DXT1 3-color mode for texels with alpha < 128. Endpoints:
 * the texels of lowest and highest luminance; each texel takes the nearest palette entry (the first of equals).
 * Written without an object per block: mip levels of block-compressed textures are re-encoded while maps load.
 */
function colorBlock(px, out, o, transparent) {
  let minL = Infinity, maxL = -Infinity, lo = 0, hi = 0, anyTransparent = false;
  for (let i = 0; i < 16; i++) {
    if (transparent && px[4 * i + 3] < 128) { anyTransparent = true; continue; }
    const l = px[4 * i] * 2 + px[4 * i + 1] * 4 + px[4 * i + 2];
    if (l < minL) { minL = l; lo = i; } if (l > maxL) { maxL = l; hi = i; }
  }
  let c0 = to565(px[4 * hi], px[4 * hi + 1], px[4 * hi + 2]), c1 = to565(px[4 * lo], px[4 * lo + 1], px[4 * lo + 2]);
  if (anyTransparent) { if (c0 > c1) { const t = c0; c0 = c1; c1 = t; } } // (c0 <= c1: 3 colors + transparent)
  else { if (c0 < c1) { const t = c0; c0 = c1; c1 = t; } if (c0 === c1) { if (c1 > 0) c1--; else c0++; } }
  const ar = ((c0 >> 11) & 31) * 255 / 31, ag = ((c0 >> 5) & 63) * 255 / 63, ab = (c0 & 31) * 255 / 31;
  const br = ((c1 >> 11) & 31) * 255 / 31, bg = ((c1 >> 5) & 63) * 255 / 63, bb = (c1 & 31) * 255 / 31;
  // the palette (c0, c1 and 1 or 2 points between them) lies on the segment c1 -> c0: the nearest entry is the one
  // nearest the texel's projection on that axis (s = 1 at c0, 0 at c1); equal distances pick the lower index
  // (the projection t = n / dd is compared with the thresholds scaled by dd once per block: no division per texel)
  const dr = ar - br, dg = ag - bg, db = ab - bb, dd = dr * dr + dg * dg + db * db;
  const hi0 = anyTransparent ? dd * 0.75 : dd * (5 / 6), mid = anyTransparent ? dd * 0.25 : dd * 0.5, low = dd * (1 / 6);
  let idx = 0;
  for (let i = 15; i >= 0; i--) {
    let best = 0;
    if (anyTransparent && px[4 * i + 3] < 128) best = 3;
    else if (dd > 0) {
      const n = (px[4 * i] - br) * dr + (px[4 * i + 1] - bg) * dg + (px[4 * i + 2] - bb) * db;
      best = anyTransparent ? (n >= hi0 ? 0 : n > mid ? 2 : 1) : (n >= hi0 ? 0 : n >= mid ? 2 : n > low ? 3 : 1);
    }
    idx = (idx << 2) | best;
  }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255; out[o + 5] = (idx >>> 8) & 255; out[o + 6] = (idx >>> 16) & 255; out[o + 7] = (idx >>> 24) & 255;
}
/** One DXT4/5 interpolated alpha block (8 bytes): endpoints the highest and lowest alpha, 8-level mode. */
function alphaBlock(px, out, o) {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { const a = px[4 * i + 3]; if (a > a0) a0 = a; if (a < a1) a1 = a; }
  if (a0 === a1) { if (a1 > 0) a1--; else a0++; }
  // the 8-level palette once per block (entry k + 1 = ((7 - k) a0 + k a1) / 7), then the nearest entry per texel
  APAL[0] = a0; APAL[1] = a1; for (let k = 1; k < 7; k++) APAL[k + 1] = ((7 - k) * a0 + k * a1) / 7;
  for (let i = 0; i < 16; i++) {
    const a = px[4 * i + 3];
    let best = 0, bd = Math.abs(a0 - a);
    for (let k = 1; k < 8; k++) { const d = Math.abs(APAL[k] - a); if (d < bd) { bd = d; best = k; } }
    IDX[i] = best;
  }
  let lo = 0, hi = 0; // (3 bits per texel, texel 0 lowest: two 24-bit halves)
  for (let i = 7; i >= 0; i--) { lo = lo * 8 + IDX[i]; hi = hi * 8 + IDX[i + 8]; }
  out[o] = a0; out[o + 1] = a1;
  out[o + 2] = lo & 255; out[o + 3] = (lo >> 8) & 255; out[o + 4] = (lo >> 16) & 255;
  out[o + 5] = hi & 255; out[o + 6] = (hi >> 8) & 255; out[o + 7] = (hi >> 16) & 255;
}
/** RGBA8 (w x h) to DXT1/DXT3/DXT5 blocks */
export function encodeDxtRef(fmt, rgba, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), unit = fmt === FMT.DXT1 ? 8 : 16, out = new Uint8Array(bw * bh * unit);
  const px = new Uint8Array(64), px32 = new Uint32Array(px.buffer);
  // (blocks inside the image: their 16 texels copied as 32-bit words; edge blocks repeat the last row / column)
  const src32 = (rgba.byteOffset & 3) === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, (w * h) | 0) : null;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (src32 && bx * 4 + 3 < w && by * 4 + 3 < h) {
      for (let y = 0, s = by * 4 * w + bx * 4; y < 16; y += 4, s += w) { px32[y] = src32[s]; px32[y + 1] = src32[s + 1]; px32[y + 2] = src32[s + 2]; px32[y + 3] = src32[s + 3]; }
    } else for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const sx = Math.min(w - 1, bx * 4 + x), sy = Math.min(h - 1, by * 4 + y), s = (sy * w + sx) * 4, d = (y * 4 + x) * 4; px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3]; }
    const o = (by * bw + bx) * unit;
    if (fmt === FMT.DXT1) { colorBlock(px, out, o, true); continue; }
    if (fmt === FMT.DXT2 || fmt === FMT.DXT3) { for (let i = 0; i < 16; i += 2) out[o + (i >> 1)] = (px[4 * i + 3] >> 4) | ((px[4 * i + 7] >> 4) << 4); }
    else alphaBlock(px, out, o); // DXT4/5: interpolated alpha
    colorBlock(px, out, o + 8, false);
  }
  return out;
}

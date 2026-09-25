// Image files for D3DX (D3DXCreateTextureFromFileInMemory & co): DDS, TGA, BMP, JPEG and PNG parsed into Direct3D
// pixel data, plus the conversions and box filtering D3DX applies when the texture it creates differs from the file
// (another format, size or mip chain). The formats are the public ones (Microsoft DDS, Truevision TGA, Windows BMP).
import { FMT, surfaceBytes, surfacePitch } from './d3d8.js';
import { decodeJpeg, isJpeg } from '../gfx/codecs/jpeg.js';
import { decodePng, isPng } from '../gfx/codecs/png.js';
import { decodeDxt } from '../gfx/d3d8-webgl.js';

/** D3DXIMAGE_FILEFORMAT */
export const IFF = { BMP: 0, JPG: 1, TGA: 2, PNG: 3, DDS: 4, PPM: 5, DIB: 6, HDR: 7, PFM: 8 };
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;
const fourcc = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

/**
 * @typedef {{ width: number, height: number, depth: number, mips: number, fmt: number, fileFormat: number,
 *   kind: 'tex'|'cube'|'volume', images: Uint8Array[][] }} ImageFile  images[face][level]: raw data in `fmt` layout
 */

/** Parse an image file; null when the data is not a supported image. */
export function parseImage(bytes) {
  if (bytes.length >= 128 && bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x20) return parseDds(bytes);
  if (bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d) return parseBmp(bytes);
  if (isJpeg(bytes)) { const im = decodeJpeg(bytes); return rgbaFile(im.width, im.height, im.data, IFF.JPG, false); }
  if (isPng(bytes)) { const im = decodePng(bytes); return rgbaFile(im.width, im.height, im.data, IFF.PNG, true); }
  return parseTga(bytes); // (no signature: the header's plausibility decides)
}

/** An RGBA8 image as a one-level A8R8G8B8 / X8R8G8B8 file */
function rgbaFile(w, h, rgba, fileFormat, alpha, infoFmt) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[4 * i] = rgba[4 * i + 2]; out[4 * i + 1] = rgba[4 * i + 1]; out[4 * i + 2] = rgba[4 * i]; out[4 * i + 3] = alpha ? rgba[4 * i + 3] : 255; }
  return { width: w, height: h, depth: 1, mips: 1, fmt: alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, infoFmt: infoFmt ?? (alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8), fileFormat, kind: 'tex', images: [[out]] };
}

function parseDds(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u = (o) => dv.getUint32(o, true);
  const flags = u(8), height = u(12), width = u(16), depth = (flags & 0x800000) ? Math.max(1, u(24)) : 1;
  const mips = (flags & 0x20000) ? Math.max(1, u(28)) : 1;
  const pf = 76, pfFlags = u(pf + 4), four = u(pf + 8), bits = u(pf + 12), rm = u(pf + 16), gm = u(pf + 20), bm = u(pf + 24), am = u(pf + 28);
  const caps2 = u(112);
  let fmt = 0;
  if (pfFlags & 0x4) { // FOURCC
    const map = { [fourcc('DXT1')]: FMT.DXT1, [fourcc('DXT2')]: FMT.DXT2, [fourcc('DXT3')]: FMT.DXT3, [fourcc('DXT4')]: FMT.DXT4, [fourcc('DXT5')]: FMT.DXT5 };
    fmt = map[four] ?? (four < 256 ? four : 0); // (a D3DFORMAT number in the fourCC field: float formats and the like)
  } else if (pfFlags & 0x40) { // RGB
    const a = (pfFlags & 0x1) ? am : 0;
    if (bits === 32) fmt = rm === 0xff0000 ? (a ? FMT.A8R8G8B8 : FMT.X8R8G8B8) : rm === 0xff ? (a ? FMT.A8B8G8R8 : 33) : rm === 0x3ff00000 ? FMT.A2B10G10R10 : rm === 0xffff ? FMT.G16R16 : FMT.A8R8G8B8;
    else if (bits === 24) fmt = FMT.R8G8B8;
    else if (bits === 16) fmt = rm === 0xf800 ? FMT.R5G6B5 : rm === 0x7c00 ? (a ? FMT.A1R5G5B5 : FMT.X1R5G5B5) : rm === 0xf00 ? (a ? FMT.A4R4G4B4 : FMT.X4R4G4B4) : rm === 0xe0 ? FMT.A8R3G3B2 : FMT.R5G6B5;
    else if (bits === 8) fmt = FMT.R3G3B2;
  } else if (pfFlags & 0x20000) fmt = bits === 16 ? ((pfFlags & 0x1) ? FMT.A8L8 : 81) : (pfFlags & 0x1) && am === 0xf0 ? FMT.A4L4 : FMT.L8; // LUMINANCE
  else if (pfFlags & 0x2) fmt = FMT.A8; // ALPHA only
  else if (pfFlags & 0x80000) fmt = bits === 32 ? FMT.Q8W8V8U8 : FMT.V8U8; // BUMPDUDV
  if (!fmt) return null;
  const cube = (caps2 & 0x200) !== 0, volume = (caps2 & 0x200000) !== 0;
  const faces = cube ? 6 : 1;
  const images = [];
  let off = 128;
  for (let f = 0; f < faces; f++) {
    const lv = [];
    for (let i = 0, w = width, h = height, d = depth; i < mips; i++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1), d = Math.max(1, d >> 1)) {
      const n = surfaceBytes(fmt, w, h) * d;
      if (off + n > b.length) break;
      lv.push(b.subarray(off, off + n));
      off += n;
    }
    images.push(lv);
  }
  const got = Math.min(...images.map((l) => l.length));
  if (!got) return null;
  return { width, height, depth, mips: got, fmt, infoFmt: fmt, fileFormat: IFF.DDS, kind: cube ? 'cube' : volume ? 'volume' : 'tex', images: images.map((l) => l.slice(0, got)) };
}

function parseTga(b) {
  if (b.length < 18) return null;
  const idLen = b[0], cmType = b[1], type = b[2], cmFirst = b[3] | (b[4] << 8), cmLen = b[5] | (b[6] << 8), cmBits = b[7];
  const w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8), bpp = b[16], desc = b[17];
  if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h || ![8, 15, 16, 24, 32].includes(bpp) || cmType > 1) return null;
  let p = 18 + idLen;
  let pal = null;
  if (cmType === 1) { const eb = Math.ceil(cmBits / 8); pal = b.subarray(p, p + cmLen * eb); p += cmLen * eb; }
  const Bpp = Math.ceil(bpp / 8), n = w * h;
  let px = new Uint8Array(n * Bpp);
  if (type >= 9) { // RLE
    let o = 0;
    while (o < px.length && p < b.length) {
      const hdr = b[p++], cnt = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { const v = b.subarray(p, p + Bpp); p += Bpp; for (let k = 0; k < cnt && o < px.length; k++) { px.set(v, o); o += Bpp; } }
      else { const m = Math.min(cnt * Bpp, px.length - o); px.set(b.subarray(p, p + m), o); p += cnt * Bpp; o += m; }
    }
  } else { if (p + px.length > b.length) return null; px = b.subarray(p, p + px.length); }
  const alphaBits = desc & 15, topDown = (desc & 0x20) !== 0, rightLeft = (desc & 0x10) !== 0;
  const out = new Uint8Array(n * 4); // B,G,R,A
  const cm = (i) => { const eb = Math.ceil(cmBits / 8), k = (i - cmFirst) * eb; return eb >= 3 ? [pal[k], pal[k + 1], pal[k + 2], eb === 4 ? pal[k + 3] : 255] : [0, 0, 0, 255]; };
  for (let y = 0; y < h; y++) {
    const sy = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const sx = rightLeft ? w - 1 - x : x, s = (sy * w + sx) * Bpp, o = (y * w + x) * 4;
      let B, G, R, A = 255;
      if (type === 3 || type === 11) { B = G = R = px[s]; if (Bpp === 2) A = px[s + 1]; }
      else if (type === 1 || type === 9) { [B, G, R, A] = cm(Bpp === 2 ? px[s] | (px[s + 1] << 8) : px[s]); }
      else if (Bpp === 2) { const v = px[s] | (px[s + 1] << 8); R = ((v >> 10) & 31) * 255 / 31 | 0; G = ((v >> 5) & 31) * 255 / 31 | 0; B = (v & 31) * 255 / 31 | 0; A = alphaBits ? (v & 0x8000 ? 255 : 0) : 255; }
      else { B = px[s]; G = px[s + 1]; R = px[s + 2]; if (Bpp === 4) A = px[s + 3]; }
      out[o] = B; out[o + 1] = G; out[o + 2] = R; out[o + 3] = A;
    }
  }
  const alpha = bpp === 32 || (bpp === 16 && alphaBits > 0) || (Bpp === 2 && (type === 3 || type === 11));
  return { width: w, height: h, depth: 1, mips: 1, fmt: alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, infoFmt: bpp === 24 ? FMT.R8G8B8 : bpp === 16 ? FMT.A1R5G5B5 : bpp === 8 ? (type === 3 || type === 11 ? FMT.L8 : FMT.P8) : alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, fileFormat: IFF.TGA, kind: 'tex', images: [[out]] };
}

function parseBmp(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dataOff = dv.getUint32(10, true), hs = dv.getUint32(14, true);
  const w = dv.getInt32(18, true), hRaw = dv.getInt32(22, true), bpp = dv.getUint16(28, true), comp = dv.getUint32(30, true);
  if (w <= 0 || !hRaw || ![1, 4, 8, 16, 24, 32].includes(bpp) || (comp !== 0 && comp !== 3)) return null;
  const h = Math.abs(hRaw), topDown = hRaw < 0, stride = ((w * bpp + 31) >> 5) * 4;
  const clrUsed = dv.getUint32(46, true), palOff = 14 + hs, pal = b.subarray(palOff, palOff + 4 * (clrUsed || (bpp <= 8 ? 1 << bpp : 0)));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = dataOff + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (bpp <= 8) { const bit = x * bpp, v = (b[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1); out[o] = pal[4 * v]; out[o + 1] = pal[4 * v + 1]; out[o + 2] = pal[4 * v + 2]; out[o + 3] = 255; }
      else if (bpp === 16) { const v = b[row + 2 * x] | (b[row + 2 * x + 1] << 8); out[o] = (v & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 3] = 255; }
      else { const s = row + x * (bpp >> 3); out[o] = b[s]; out[o + 1] = b[s + 1]; out[o + 2] = b[s + 2]; out[o + 3] = bpp === 32 ? b[s + 3] : 255; }
    }
  }
  return { width: w, height: h, depth: 1, mips: 1, fmt: FMT.X8R8G8B8, infoFmt: bpp === 24 ? FMT.R8G8B8 : bpp === 32 ? FMT.X8R8G8B8 : bpp === 16 ? FMT.X1R5G5B5 : FMT.P8, fileFormat: IFF.BMP, kind: 'tex', images: [[out]] };
}

// ---------------------------------------------------------------- conversions (through RGBA8)

/** Raw pixels of `fmt` (w x h) to RGBA8. */
export function toRgba(fmt, data, w, h) {
  if (isDxt(fmt)) return decodeDxt(fmt, data, w, h);
  return surfaceToRgbaLocal(fmt, data, w, h, surfacePitch(fmt, w));
}

function surfaceToRgbaLocal(fmt, u8, w, h, pitch) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let s;
    switch (fmt) {
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: s = y * pitch + 4 * x; out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = fmt === FMT.X8R8G8B8 ? 255 : u8[s + 3]; break;
      case FMT.A8B8G8R8: case 33: s = y * pitch + 4 * x; out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = fmt === 33 ? 255 : u8[s + 3]; break;
      case FMT.R8G8B8: s = y * pitch + 3 * x; out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; break;
      case FMT.R5G6B5: { s = y * pitch + 2 * x; const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; break; }
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: { s = y * pitch + 2 * x; const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = fmt === FMT.A1R5G5B5 ? (v & 0x8000 ? 255 : 0) : 255; break; }
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: { s = y * pitch + 2 * x; const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = fmt === FMT.A4R4G4B4 ? (v >> 12) * 17 : 255; break; }
      case FMT.A8: s = y * pitch + x; out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[s]; break;
      case FMT.L8: case FMT.P8: s = y * pitch + x; out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; break;
      case FMT.A8L8: s = y * pitch + 2 * x; out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = u8[s + 1]; break;
      case FMT.A4L4: s = y * pitch + x; out[o] = out[o + 1] = out[o + 2] = (u8[s] & 15) * 17; out[o + 3] = (u8[s] >> 4) * 17; break;
      case 81: s = y * pitch + 2 * x; out[o] = out[o + 1] = out[o + 2] = u8[s + 1]; out[o + 3] = 255; break;
      default: s = y * pitch + 4 * x; out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = u8[s + 3];
    }
  }
  return out;
}

/** RGBA8 to raw pixels of `fmt` (uncompressed formats; null when not encodable here). */
export function fromRgba(fmt, rgba, w, h) {
  if (isDxt(fmt)) return encodeDxt(fmt, rgba, w, h);
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

/** Box-filtered (or point-sampled, `point`) resize of an RGBA8 image. */
export function resizeRgba(src, sw, sh, dw, dh, point = false) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh), y1 = point ? y0 + 1 : Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw), x1 = point ? x0 + 1 : Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * sw + xx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++; }
      const o = (y * dw + x) * 4; out[o] = r / n + 0.5 | 0; out[o + 1] = g / n + 0.5 | 0; out[o + 2] = b / n + 0.5 | 0; out[o + 3] = a / n + 0.5 | 0;
    }
  }
  return out;
}

/** A D3DX color key (ARGB) applied to an RGBA8 image: matching texels become transparent black. */
export function applyColorKey(rgba, key) {
  if (!key) return rgba;
  const kr = (key >>> 16) & 255, kg = (key >>> 8) & 255, kb = key & 255, ka = key >>> 24;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === kr && rgba[i + 1] === kg && rgba[i + 2] === kb && rgba[i + 3] === ka) rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
  return rgba;
}
export { isDxt };

// ---------------------------------------------------------------- block compression (DXT1/3/5 encoder)
const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
/** one color block (8 bytes) for 16 RGBA texels; `transparent`: DXT1 3-color mode for texels with alpha < 128 */
function colorBlock(px, out, o, transparent) {
  let minL = Infinity, maxL = -Infinity, lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) { if (transparent && px[4 * i + 3] < 128) continue; const l = px[4 * i] * 2 + px[4 * i + 1] * 4 + px[4 * i + 2]; if (l < minL) { minL = l; lo = i; } if (l > maxL) { maxL = l; hi = i; } }
  let c0 = to565(px[4 * hi], px[4 * hi + 1], px[4 * hi + 2]), c1 = to565(px[4 * lo], px[4 * lo + 1], px[4 * lo + 2]);
  const anyTransparent = transparent && [...Array(16).keys()].some((i) => px[4 * i + 3] < 128);
  if (anyTransparent) { if (c0 > c1) [c0, c1] = [c1, c0]; } // (c0 <= c1: 3 colors + transparent)
  else { if (c0 < c1) [c0, c1] = [c1, c0]; if (c0 === c1) { if (c1 > 0) c1--; else c0++; } }
  const a = from565(c0), b = from565(c1);
  const pal = anyTransparent ? [a, b, a.map((x, k) => (x + b[k]) / 2), null] : [a, b, a.map((x, k) => (2 * x + b[k]) / 3), a.map((x, k) => (x + 2 * b[k]) / 3)];
  let idx = 0;
  for (let i = 15; i >= 0; i--) {
    let best = 0, bd = Infinity;
    if (anyTransparent && px[4 * i + 3] < 128) best = 3;
    else for (let k = 0; k < 4; k++) { if (!pal[k]) continue; const d = (pal[k][0] - px[4 * i]) ** 2 + (pal[k][1] - px[4 * i + 1]) ** 2 + (pal[k][2] - px[4 * i + 2]) ** 2; if (d < bd) { bd = d; best = k; } }
    idx = (idx << 2) | best;
  }
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255; out[o + 5] = (idx >>> 8) & 255; out[o + 6] = (idx >>> 16) & 255; out[o + 7] = (idx >>> 24) & 255;
}
/** RGBA8 (w x h) to DXT1/DXT3/DXT5 blocks */
export function encodeDxt(fmt, rgba, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), unit = fmt === FMT.DXT1 ? 8 : 16, out = new Uint8Array(bw * bh * unit);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const sx = Math.min(w - 1, bx * 4 + x), sy = Math.min(h - 1, by * 4 + y), s = (sy * w + sx) * 4, d = (y * 4 + x) * 4; px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3]; }
    const o = (by * bw + bx) * unit;
    if (fmt === FMT.DXT1) { colorBlock(px, out, o, true); continue; }
    if (fmt === FMT.DXT2 || fmt === FMT.DXT3) { for (let i = 0; i < 16; i += 2) out[o + (i >> 1)] = (px[4 * i + 3] >> 4) | ((px[4 * i + 7] >> 4) << 4); }
    else { // DXT4/5: interpolated alpha
      let a0 = 0, a1 = 255; for (let i = 0; i < 16; i++) { a0 = Math.max(a0, px[4 * i + 3]); a1 = Math.min(a1, px[4 * i + 3]); }
      if (a0 === a1) { if (a1 > 0) a1--; else a0++; }
      const levels = [a0, a1]; for (let k = 1; k < 7; k++) levels.push(((7 - k) * a0 + k * a1) / 7);
      let bits = 0n; for (let i = 15; i >= 0; i--) { let best = 0, bd = Infinity; for (let k = 0; k < 8; k++) { const d = Math.abs(levels[k] - px[4 * i + 3]); if (d < bd) { bd = d; best = k; } } bits = (bits << 3n) | BigInt(best); }
      out[o] = a0; out[o + 1] = a1; for (let k = 0; k < 6; k++) out[o + 2 + k] = Number((bits >> BigInt(8 * k)) & 255n);
    }
    colorBlock(px, out, o + 8, false);
  }
  return out;
}

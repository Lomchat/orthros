// Image files for D3DX (D3DXCreateTextureFromFileInMemory & co): DDS, TGA, BMP, JPEG and PNG parsed into Direct3D
// pixel data, plus the conversions and box filtering D3DX applies when the texture it creates differs from the file
// (another format, size or mip chain). The formats are the public ones (Microsoft DDS, Truevision TGA, Windows BMP).
import { FMT, surfaceBytes, surfacePitch } from './d3d8.js';
import { decodeJpeg, isJpeg, jpegSize } from '../gfx/codecs/jpeg.js';
import { decodePng, isPng } from '../gfx/codecs/png.js';
import { decodeDxt } from '../gfx/d3d8-webgl.js';
import { imageWasmSupported, instantiateImage, KIND as WASM_KIND, SCRATCH_BYTES as WASM_SCRATCH_BYTES, FMT16 } from './d3dx9-image-wasm.js';

/** D3DXIMAGE_FILEFORMAT */
export const IFF = { BMP: 0, JPG: 1, TGA: 2, PNG: 3, DDS: 4, PPM: 5, DIB: 6, HDR: 7, PFM: 8 };
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;
const fourcc = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

/**
 * @typedef {{ width: number, height: number, depth: number, mips: number, fmt: number, fileFormat: number,
 *   kind: 'tex'|'cube'|'volume', images: Uint8Array[][] }} ImageFile  images[face][level]: raw data in `fmt` layout
 */

/** A DDS file (parseImage parses it as such; its levels are views of `bytes`, nothing else of it is kept) */
export const isDdsFile = (bytes) => bytes.length >= 128 && bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x20;
/** Parse an image file; null when the data is not a supported image. */
export function parseImage(bytes) {
  if (isDdsFile(bytes)) return parseDds(bytes);
  if (bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d) return parseBmp(bytes);
  if (isJpeg(bytes)) { const im = decodeJpeg(bytes); return rgbaFile(im.width, im.height, im.data, IFF.JPG, false); }
  if (isPng(bytes)) { const im = decodePng(bytes); return rgbaFile(im.width, im.height, im.data, IFF.PNG, true); }
  return parseTga(bytes); // (no signature: the header's plausibility decides)
}

/**
 * What parseImage would describe (size, format, kind: D3DXIMAGE_INFO), without decoding pixels: JPEG and PNG headers
 * give it (D3DXGetImageInfoFromFile*, usually called before creating the texture from the same file, decoded it in
 * full), and so do TGA and BMP headers (the same fields and the same rejections as their parsers; DDS is parsed in
 * place). Headers this cannot read go through parseImage. `shared`: `bytes` is a view of memory other code may
 * write (guest memory, read in place) — the decoders get a copy.
 */
export function parseImageInfo(bytes, shared = false) {
  const info = (width, height, alpha, fileFormat) => ({ width, height, depth: 1, mips: 1, fmt: alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, infoFmt: alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, fileFormat, kind: 'tex', images: null });
  if (isJpeg(bytes)) { const s = jpegSize(bytes); if (s && s.width && s.height) return info(s.width, s.height, false, IFF.JPG); }
  else if (isPng(bytes) && bytes.length >= 33 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) { // (IHDR first)
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0, h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    if (w && h) return info(w, h, true, IFF.PNG);
  }
  else if (isPng(bytes)) { /* (no IHDR first: decoded) */ }
  else if (isDdsFile(bytes)) return parseDds(bytes);
  else if (bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d) { const r = bmpInfo(bytes); if (r !== undefined) return r; }
  else { const r = tgaInfo(bytes); if (r !== undefined) return r; }
  return parseImage(shared ? bytes.slice() : bytes);
}
/** Largest image (texels) whose information is read from its header: past it, the full parse (its allocation may fail). */
const INFO_MAX_TEXELS = 1 << 26;
/** parseTga's result without the pixels (undefined: decide by parsing; null: parseTga returns null or throws) */
function tgaInfo(b) {
  if (b.length < 18) return null;
  const idLen = b[0], cmType = b[1], type = b[2], cmLen = b[5] | (b[6] << 8), cmBits = b[7];
  const w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8), bpp = b[16], desc = b[17];
  if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h || ![8, 15, 16, 24, 32].includes(bpp) || cmType > 1) return null;
  if (w * h > INFO_MAX_TEXELS) return undefined;
  const p = 18 + idLen + (cmType === 1 ? cmLen * Math.ceil(cmBits / 8) : 0), Bpp = Math.ceil(bpp / 8);
  if (type < 9 && p + w * h * Bpp > b.length) return null;
  if ((type === 1 || type === 9) && cmType !== 1 && Math.ceil(cmBits / 8) >= 3) return null; // (a color-mapped image without its map: parseTga throws)
  const alphaBits = desc & 15, alpha = bpp === 32 || (bpp === 16 && alphaBits > 0) || (Bpp === 2 && (type === 3 || type === 11));
  return { width: w, height: h, depth: 1, mips: 1, fmt: alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, infoFmt: bpp === 24 ? FMT.R8G8B8 : bpp === 16 ? FMT.A1R5G5B5 : bpp === 8 ? (type === 3 || type === 11 ? FMT.L8 : FMT.P8) : alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, fileFormat: IFF.TGA, kind: 'tex', images: null };
}
/** parseBmp's result without the pixels (undefined: decide by parsing; null: parseBmp returns null) */
function bmpInfo(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = dv.getInt32(18, true), hRaw = dv.getInt32(22, true), bpp = dv.getUint16(28, true), comp = dv.getUint32(30, true);
  if (w <= 0 || !hRaw || ![1, 4, 8, 16, 24, 32].includes(bpp) || (comp !== 0 && comp !== 3)) return null;
  const h = Math.abs(hRaw);
  if (w * h > INFO_MAX_TEXELS) return undefined;
  return { width: w, height: h, depth: 1, mips: 1, fmt: FMT.X8R8G8B8, infoFmt: bpp === 24 ? FMT.R8G8B8 : bpp === 32 ? FMT.X8R8G8B8 : bpp === 16 ? FMT.X1R5G5B5 : FMT.P8, fileFormat: IFF.BMP, kind: 'tex', images: null };
}

/** R,G,B,A texels to B,G,R,A (alpha 255 without `alpha`) */
function rgbaToBgra(rgba, w, h, alpha) {
  const out = new Uint8Array(w * h * 4);
  if ((rgba.byteOffset & 3) === 0) { // (whole pixels as little-endian words: R,G,B,A -> B,G,R,A)
    const s32 = new Int32Array(rgba.buffer, rgba.byteOffset, w * h), d32 = new Int32Array(out.buffer), a = alpha ? 0 : 0xff000000;
    for (let i = 0; i < w * h; i++) { const v = s32[i]; d32[i] = (v & 0xff00ff00) | ((v >>> 16) & 0xff) | ((v & 0xff) << 16) | a; }
  } else for (let i = 0; i < w * h; i++) { out[4 * i] = rgba[4 * i + 2]; out[4 * i + 1] = rgba[4 * i + 1]; out[4 * i + 2] = rgba[4 * i]; out[4 * i + 3] = alpha ? rgba[4 * i + 3] : 255; }
  return out;
}
/** An RGBA8 image as a one-level A8R8G8B8 / X8R8G8B8 file */
function rgbaFile(w, h, rgba, fileFormat, alpha, infoFmt) {
  const out = wasmSwizzle(rgba, w * 4, w, h, alpha ? 0 : 0xff000000) ?? rgbaToBgra(rgba, w, h, alpha);
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
  if (isDxt(fmt)) return wasmDecodeDxt(fmt, data, w, h) ?? decodeDxt(fmt, data, w, h);
  return surfaceToRgbaLocal(fmt, data, w, h, surfacePitch(fmt, w));
}

/** Raw pixels of an uncompressed `fmt` (w x h, rows `pitch` bytes apart) to RGBA8. */
export function toRgbaRows(fmt, data, w, h, pitch) { return surfaceToRgbaLocal(fmt, data, w, h, pitch); }

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
  if (fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8) { const r = wasmSwizzle(u8, pitch, w, h, fmt === FMT.X8R8G8B8 ? 0xff000000 : 0); if (r) return r; }
  const out = new Uint8Array(w * h * 4);
  if ((fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8) && ((u8.byteOffset | pitch) & 3) === 0) { // (whole texels: B,G,R,A -> R,G,B,A on 32-bit lanes)
    const src = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2), dst = new Uint32Array(out.buffer), alpha = fmt === FMT.X8R8G8B8 ? 0xff000000 : 0;
    for (let y = 0; y < h; y++) for (let x = 0, si = (y * pitch) >> 2, o = y * w; x < w; x++, si++, o++) { const v = src[si]; dst[o] = ((v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff) | alpha) >>> 0; }
    return out;
  }
  const [bpp, texel] = TO_RGBA[fmt] ?? TO_RGBA_DEFAULT; // (one loop per format: the conversion is chosen once, not per texel)
  // 8- and 16-bit formats: the RGBA8 of every possible texel value in a table (built once per format from the same
  // per-texel conversion), one lookup per texel
  if (bpp <= 2 && TO_RGBA[fmt]) {
    const r = bpp === 2 ? wasmUnpack16(fmt, u8, pitch, w, h) : null; if (r) return r;
    const lut = texelTable(fmt, bpp, texel), dst = new Uint32Array(out.buffer);
    if (bpp === 1) { for (let y = 0; y < h; y++) for (let x = 0, s = y * pitch, o = y * w; x < w; x++) dst[o + x] = lut[u8[s + x]]; }
    else if (((u8.byteOffset | pitch) & 1) === 0) { const src = new Uint16Array(u8.buffer, u8.byteOffset, u8.length >> 1); for (let y = 0; y < h; y++) for (let x = 0, s = (y * pitch) >> 1, o = y * w; x < w; x++) dst[o + x] = lut[src[s + x]]; }
    else for (let y = 0; y < h; y++) for (let x = 0, s = y * pitch, o = y * w; x < w; x++, s += 2) dst[o + x] = lut[u8[s] | (u8[s + 1] << 8)];
    return out;
  }
  for (let y = 0; y < h; y++) for (let x = 0, s = y * pitch, o = y * w * 4; x < w; x++, s += bpp, o += 4) texel(u8, s, out, o);
  return out;
}
const TEXEL_TABLES = new Map();
/** RGBA8 (as a little-endian word) of each value of an 8- or 16-bit texel format, from its per-texel conversion. */
function texelTable(fmt, bpp, texel) {
  let t = TEXEL_TABLES.get(fmt);
  if (!t) {
    t = new Uint32Array(bpp === 1 ? 256 : 65536);
    const v8 = new Uint8Array(2), o8 = new Uint8Array(4), o32 = new Uint32Array(o8.buffer);
    for (let v = 0; v < t.length; v++) { v8[0] = v & 255; v8[1] = v >> 8; texel(v8, 0, o8, 0); t[v] = o32[0]; }
    TEXEL_TABLES.set(fmt, t);
  }
  return t;
}
/** q(v, bits) = round(v * (2^bits - 1) / 255) for v in 0..255, per bit count (fromRgba's quantization, tabulated) */
const QUANT = [4, 5, 6].reduce((m, bits) => { m[bits] = Uint8Array.from({ length: 256 }, (_, v) => Math.round(v * ((1 << bits) - 1) / 255)); return m; }, []);

/** RGBA8 to raw pixels of `fmt` (uncompressed formats; null when not encodable here). */
export function fromRgba(fmt, rgba, w, h) {
  if (isDxt(fmt)) return encodeDxt(fmt, rgba, w, h);
  if (fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8) { const r = wasmSwizzle(rgba, w * 4, w, h, fmt === FMT.X8R8G8B8 ? 0xff000000 : 0); if (r) return r; }
  const pitch = surfacePitch(fmt, w), out = new Uint8Array(surfaceBytes(fmt, w, h));
  // the common formats a texel at a time on whole words (the same values as the general loop below)
  if ((rgba.byteOffset & 3) === 0 && (fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8)) {
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h), dst = new Uint32Array(out.buffer), alpha = fmt === FMT.X8R8G8B8 ? 0xff000000 : 0; // (pitch = 4 w)
    for (let i = 0; i < w * h; i++) { const p = src[i]; dst[i] = ((p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff) | alpha) >>> 0; }
    return out;
  }
  if (fmt === FMT.R5G6B5 || fmt === FMT.X1R5G5B5 || fmt === FMT.A1R5G5B5 || fmt === FMT.A4R4G4B4 || fmt === FMT.X4R4G4B4) {
    const r = wasmPack16(fmt, rgba, w, h); if (r) return r;
    const dst = new Uint16Array(out.buffer), q4 = QUANT[4], q5 = QUANT[5], q6 = QUANT[6]; // (pitch = 2 w)
    const n = w * h;
    if (fmt === FMT.R5G6B5) for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = (q5[rgba[j]] << 11) | (q6[rgba[j + 1]] << 5) | q5[rgba[j + 2]];
    else if (fmt === FMT.X1R5G5B5) for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = 0x8000 | (q5[rgba[j]] << 10) | (q5[rgba[j + 1]] << 5) | q5[rgba[j + 2]];
    else if (fmt === FMT.A1R5G5B5) for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = (rgba[j + 3] >= 128 ? 0x8000 : 0) | (q5[rgba[j]] << 10) | (q5[rgba[j + 1]] << 5) | q5[rgba[j + 2]];
    else if (fmt === FMT.X4R4G4B4) for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = 0xf000 | (q4[rgba[j]] << 8) | (q4[rgba[j + 1]] << 4) | q4[rgba[j + 2]];
    else for (let i = 0, j = 0; i < n; i++, j += 4) dst[i] = (q4[rgba[j + 3]] << 12) | (q4[rgba[j]] << 8) | (q4[rgba[j + 1]] << 4) | q4[rgba[j + 2]];
    return out;
  }
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
  if (!point && dw * 2 === sw && dh * 2 === sh) { // (a mip level: each texel the average of 2 x 2, as the general loop computes it)
    const r = wasmHalve(src, dw, dh); if (r) return r;
    const out = new Uint8Array(dw * dh * 4), row = sw * 4;
    if ((src.byteOffset & 3) === 0) { // (whole texels: the channels summed in two 16-bit lanes per word, (sum + 2) >> 2 each)
      const s32 = new Uint32Array(src.buffer, src.byteOffset, sw * sh), o32 = new Uint32Array(out.buffer), M = 0x00ff00ff;
      for (let y = 0; y < dh; y++) for (let x = 0, i = 2 * y * sw, o = y * dw; x < dw; x++, i += 2, o++) {
        const p0 = s32[i], p1 = s32[i + 1], p2 = s32[i + sw], p3 = s32[i + sw + 1];
        const lo = (((p0 & M) + (p1 & M) + (p2 & M) + (p3 & M) + 0x00020002) >>> 2) & M;
        const hi = ((((p0 >>> 8) & M) + ((p1 >>> 8) & M) + ((p2 >>> 8) & M) + ((p3 >>> 8) & M) + 0x00020002) >>> 2) & M;
        o32[o] = (lo | (hi << 8)) >>> 0;
      }
      return out;
    }
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const i = (2 * y * sw + 2 * x) * 4, o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (src[i + c] + src[i + 4 + c] + src[i + row + c] + src[i + row + 4 + c]) / 4 + 0.5 | 0;
    }
    return out;
  }
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
/** RGBA8 (w x h) to DXT1/DXT3/DXT5 blocks (through the parallel encoder when one is installed, see setDxtEncoder) */
export function encodeDxt(fmt, rgba, w, h) {
  if (dxtEncoder) { const r = dxtEncoder(fmt, rgba, w, h); if (r) return r; }
  const bh = Math.max(1, (h + 3) >> 2);
  return encodeDxtRows(fmt, rgba, w, h, 0, bh, new Uint8Array(dxtBytes(fmt, w, h)));
}
/** Size of the DXT blocks of a w x h image. */
export const dxtBytes = (fmt, w, h) => Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * (fmt === FMT.DXT1 ? 8 : 16);
let dxtEncoder = null;
/** Install an encoder that may split the work (returns null to decline: the encoder here runs). */
export function setDxtEncoder(f) { dxtEncoder = f; }
/** The block kind of d3dx9-image-wasm.js encodeRows for a DXT format. */
export const dxtKind = (fmt) => (fmt === FMT.DXT1 ? WASM_KIND.DXT1 : fmt === FMT.DXT2 || fmt === FMT.DXT3 ? WASM_KIND.DXT3 : WASM_KIND.DXT5);

// ---------------------------------------------------------------- WebAssembly kernels (d3dx9-image-wasm.js)
/**
 * The WebAssembly kernels on this thread, with a private memory — [scratch, input, output] for one call at a time —
 * grown to the largest image met; null without WebAssembly SIMD, or switched off for a measurement
 * (?dbg=ORTHROS_DXT_WASM=0: the JavaScript code everywhere, the same bytes).
 */
let wasmLocal;
function localWasm() {
  if (globalThis.ORTHROS_DXT_WASM === 0) return null;
  if (wasmLocal === undefined) {
    wasmLocal = null;
    try { if (imageWasmSupported()) { const memory = new WebAssembly.Memory({ initial: 1 }); wasmLocal = { memory, exports: instantiateImage(memory) }; } } catch { wasmLocal = null; }
  }
  return wasmLocal;
}
/** Images below this many texels stay in JavaScript (a call and two copies cost more than the work) */
const WASM_MIN_TEXELS = 1024;
/** The local memory with room for `inBytes` at IN and `outBytes` after it: [u8 view of the memory, output offset] */
function wasmRoom(wl, inBytes, outBytes) {
  const out = WASM_IN + ((inBytes + 15) & ~15), need = out + outBytes, have = wl.memory.buffer.byteLength;
  if (need > have) wl.memory.grow(Math.ceil((need - have) / 65536));
  return [new Uint8Array(wl.memory.buffer), out];
}
const WASM_IN = WASM_SCRATCH_BYTES;
/**
 * w x h 32-bit texels (rows `pitch` bytes apart) with bytes 0 and 2 of each exchanged and `alphaOr` ORed into the word:
 * A8R8G8B8 / X8R8G8B8 <-> RGBA8, as a new packed image; null when the JavaScript code is to do it (small image, no
 * WebAssembly, a source shorter than its rows or rows overlapping).
 */
function wasmSwizzle(u8, pitch, w, h, alphaOr) {
  const n = w * h, inBytes = (h - 1) * pitch + w * 4;
  if (n < WASM_MIN_TEXELS || pitch < w * 4 || u8.length < inBytes) return null;
  const wl = localWasm(); if (!wl) return null;
  const [m, out] = wasmRoom(wl, inBytes, n * 4);
  m.set(u8.subarray(0, inBytes), WASM_IN);
  wl.exports.swizzle(WASM_IN, pitch, out, w, h, alphaOr | 0);
  return m.slice(out, out + n * 4);
}
/** w x h texels of a 16-bit format of FMT16 (rows `pitch` bytes apart) as RGBA8, or null (as wasmSwizzle) */
function wasmUnpack16(fmt, u8, pitch, w, h) {
  const n = w * h, inBytes = (h - 1) * pitch + w * 2;
  if (!FMT16[fmt] || n < WASM_MIN_TEXELS || pitch < w * 2 || u8.length < inBytes) return null;
  const wl = localWasm(); if (!wl) return null;
  const [m, out] = wasmRoom(wl, inBytes, n * 4);
  m.set(u8.subarray(0, inBytes), WASM_IN);
  wl.exports[`unpack${fmt}`](WASM_IN, pitch, out, w, h);
  return m.slice(out, out + n * 4);
}
/** w x h RGBA8 texels in a 16-bit format of FMT16 (packed rows), or null (as wasmSwizzle) */
function wasmPack16(fmt, rgba, w, h) {
  const n = w * h;
  if (!FMT16[fmt] || n < WASM_MIN_TEXELS || rgba.length < n * 4) return null;
  const wl = localWasm(); if (!wl) return null;
  const [m, out] = wasmRoom(wl, n * 4, n * 2);
  m.set(rgba.subarray(0, n * 4), WASM_IN);
  wl.exports[`pack${fmt}`](WASM_IN, out, n);
  return m.slice(out, out + n * 2);
}
/** DXT1-5 blocks of a w x h image decoded to RGBA8 (decodeDxt's bytes), or null (as wasmSwizzle; blocks missing) */
function wasmDecodeDxt(fmt, data, w, h) {
  const n = w * h, inBytes = dxtBytes(fmt, w, h);
  if (n < WASM_MIN_TEXELS || data.length < inBytes) return null;
  const wl = localWasm(); if (!wl) return null;
  const [m, out] = wasmRoom(wl, inBytes, n * 4);
  m.set(data.subarray(0, inBytes), WASM_IN);
  wl.exports.decodeDxt(dxtKind(fmt), WASM_IN, w, h, out, 0);
  return m.slice(out, out + n * 4);
}
/** The 2:1 box filter of a 2 dw x 2 dh RGBA8 image (resizeRgba's mip levels), or null (as wasmSwizzle) */
function wasmHalve(src, dw, dh) {
  const inBytes = dw * dh * 16;
  if (dw * dh * 4 < WASM_MIN_TEXELS || src.length < inBytes) return null;
  const wl = localWasm(); if (!wl) return null;
  const [m, out] = wasmRoom(wl, inBytes, dw * dh * 4);
  m.set(src.subarray(0, inBytes), WASM_IN);
  wl.exports.halve(WASM_IN, out, dw, dh);
  return m.slice(out, out + dw * dh * 4);
}
/**
 * A mip chain as D3DXFilterTexture builds it (box filter): from the w x h RGBA8 image `from`, each level of `sizes`
 * ([w, h] pairs, in order) resized from the previous level's RGBA and encoded in `fmt` — the bytes of resizeRgba and
 * fromRgba level after level. The images stay in the kernels' memory (one copy in, the encoded levels copied out
 * together); large DXT levels still go to the parallel encoder. `srcFmt`: `from` is the source level's own data in
 * that format (DXT1-5, a 16-bit format of FMT16, A8R8G8B8 or X8R8G8B8: decoded there, as toRgba would) rather than RGBA8.
 * Null when the kernels cannot do it (no WebAssembly, a format without a kernel): the caller goes level by level.
 */
export const mipChainReady = (fmt) => (isDxt(fmt) || !!FMT16[fmt] || fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8) && !!localWasm();
export function mipChain(fmt, from, w, h, sizes, srcFmt = null) {
  const dxt = isDxt(fmt), k16 = !!FMT16[fmt], k32 = fmt === FMT.A8R8G8B8 || fmt === FMT.X8R8G8B8;
  const srcDxt = srcFmt !== null && isDxt(srcFmt);
  const srcBytes = srcFmt === null ? w * h * 4 : srcDxt ? dxtBytes(srcFmt, w, h) : FMT16[srcFmt] ? w * h * 2 : srcFmt === FMT.A8R8G8B8 || srcFmt === FMT.X8R8G8B8 ? w * h * 4 : 0;
  if (!(dxt || k16 || k32) || !srcBytes || !sizes.length || from.length < srcBytes) return null;
  const wl = localWasm(); if (!wl) return null;
  const encBytes = sizes.map(([lw, lh]) => surfaceBytes(fmt, lw, lh));
  const region = (Math.max(srcBytes, w * h * 4, ...sizes.map(([lw, lh]) => lw * lh * 4)) + 15) & ~15; // (levels may be larger than the source)
  const total = encBytes.reduce((a, b) => a + b, 0);
  let [m] = wasmRoom(wl, 2 * region, total);
  const A = WASM_IN, B = WASM_IN + region, OUT = WASM_IN + 2 * region;
  if (srcFmt === null) m.set(from.subarray(0, w * h * 4), A);
  else { // (the source level's data decoded / unpacked into A, through B)
    m.set(from.subarray(0, srcBytes), B);
    if (srcDxt) wl.exports.decodeDxt(dxtKind(srcFmt), B, w, h, A, 0);
    else if (FMT16[srcFmt]) wl.exports[`unpack${srcFmt}`](B, w * 2, A, w, h);
    else wl.exports.swizzle(B, w * 4, A, w, h, srcFmt === FMT.X8R8G8B8 ? 0xff000000 | 0 : 0);
  }
  let cur = A, nxt = B, cw = w, ch = h, o = OUT;
  for (let i = 0; i < sizes.length; i++) {
    const [lw, lh] = sizes[i];
    if (lw * 2 === cw && lh * 2 === ch) wl.exports.halve(cur, nxt, lw, lh);
    else if (lw === cw && lh === ch) m.copyWithin(nxt, cur, cur + lw * lh * 4);
    else m.set(resizeRgba(m.slice(cur, cur + cw * ch * 4), cw, ch, lw, lh), nxt); // (the general filter, in JavaScript)
    const n = lw * lh;
    if (dxt) {
      const r = n >= WASM_MIN_TEXELS && dxtEncoder ? dxtEncoder(fmt, m.subarray(nxt, nxt + n * 4), lw, lh) : null;
      if (r) m.set(r, o); else wl.exports.encodeRows(dxtKind(fmt), lw, lh, 0, Math.max(1, (lh + 3) >> 2), nxt, o, 0);
    } else if (k16) wl.exports[`pack${fmt}`](nxt, o, n);
    else wl.exports.swizzle(nxt, lw * 4, o, lw, lh, fmt === FMT.X8R8G8B8 ? 0xff000000 | 0 : 0);
    o += encBytes[i]; cw = lw; ch = lh; const t = cur; cur = nxt; nxt = t;
  }
  const all = m.slice(OUT, OUT + total), out = [];
  for (let i = 0, p = 0; i < sizes.length; p += encBytes[i++]) out.push(all.subarray(p, p + encBytes[i]));
  return out;
}
/** Block rows [by0, by1) of the DXT encoding of an RGBA8 image, written at their place in `out` (the whole image's blocks). */
export function encodeDxtRows(fmt, rgba, w, h, by0, by1, out) {
  const inBytes = w * h * 4, wl = by1 > by0 && rgba.length >= inBytes ? localWasm() : null;
  if (!wl) return encodeDxtRowsJs(fmt, rgba, w, h, by0, by1, out);
  const outBytes = dxtBytes(fmt, w, h), [m, dst] = wasmRoom(wl, inBytes, outBytes);
  m.set(rgba.subarray(0, inBytes), WASM_IN);
  wl.exports.encodeRows(dxtKind(fmt), w, h, by0, by1, WASM_IN, dst, 0);
  const rowBytes = outBytes / Math.max(1, (h + 3) >> 2), a = by0 * rowBytes, b = Math.min(outBytes, by1 * rowBytes);
  out.set(m.subarray(dst + a, dst + b), a);
  return out;
}
/** encodeDxtRows in JavaScript (the reference of the WebAssembly encoder; the encoder where WebAssembly SIMD is missing) */
export function encodeDxtRowsJs(fmt, rgba, w, h, by0, by1, out) {
  const bw = Math.max(1, (w + 3) >> 2), unit = fmt === FMT.DXT1 ? 8 : 16;
  const px = new Uint8Array(64), px32 = new Uint32Array(px.buffer);
  // (blocks inside the image: their 16 texels copied as 32-bit words; edge blocks repeat the last row / column)
  const src32 = (rgba.byteOffset & 3) === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, (w * h) | 0) : null;
  for (let by = by0; by < by1; by++) for (let bx = 0; bx < bw; bx++) {
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

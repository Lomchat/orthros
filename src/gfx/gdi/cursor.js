// Windows cursor and icon images: .cur/.ico files (ICONDIR with DIB or PNG images), animated .ani
// cursors (RIFF 'ACON': anih header, optional rate/seq chunks, a LIST 'fram' of icon files) and the
// RT_GROUP_CURSOR/RT_CURSOR resource layout. Images become straight RGBA with the hotspot, ready for
// the host (a CSS cursor in the browser). Written from the public file format descriptions.
import { decodePng } from '../codecs/png.js';

/**
 * @typedef {{ w: number, h: number, hotX: number, hotY: number, rgba: Uint8Array }} CursorFrame
 * @typedef {{ frames: CursorFrame[], steps: Array<{ frame: number, ms: number }> }} CursorImage
 */

/**
 * Parse a cursor/icon file (.cur, .ico or .ani).
 * @param {Uint8Array} bytes
 * @returns {CursorImage|null}
 */
export function parseCursorFile(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'ACON') return parseAni(bytes, dv);
  const f = parseIconDir(bytes, dv, 0);
  return f ? { frames: [f], steps: [{ frame: 0, ms: 0 }] } : null;
}

const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** ICONDIR (type 1 icon, 2 cursor): the largest, deepest image; cursors carry their hotspot in the entry. */
function parseIconDir(bytes, dv, base) {
  if (base + 6 > bytes.length) return null;
  const type = dv.getUint16(base + 2, true), count = dv.getUint16(base + 4, true);
  if ((type !== 1 && type !== 2) || !count) return null;
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = base + 6 + 16 * i;
    if (e + 16 > bytes.length) break;
    const w = bytes[e] || 256, h = bytes[e + 1] || 256;
    const hotX = type === 2 ? dv.getUint16(e + 4, true) : w >> 1, hotY = type === 2 ? dv.getUint16(e + 6, true) : h >> 1;
    const size = dv.getUint32(e + 8, true), off = dv.getUint32(e + 12, true);
    // prefer 32x32 (the standard cursor size), then the largest
    const score = (w === 32 ? 1e6 : 0) + w * h;
    if (!best || score > best.score) best = { w, h, hotX, hotY, size, off: base + off, score };
  }
  if (!best || best.off + 8 > bytes.length) return null;
  const img = decodeIconImage(bytes.subarray(best.off, best.off + best.size));
  if (!img) return null;
  return { w: img.w, h: img.h, hotX: Math.min(best.hotX, img.w - 1), hotY: Math.min(best.hotY, img.h - 1), rgba: img.rgba };
}

/**
 * One icon/cursor image: PNG, or a DIB whose height covers the XOR color bitmap and the 1 bpp AND mask.
 * @returns {{ w: number, h: number, rgba: Uint8Array }|null}
 */
export function decodeIconImage(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    try { const p = decodePng(data); return { w: p.width, h: p.height, rgba: p.data }; } catch { return null; }
  }
  if (data.length < 40) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hdr = dv.getUint32(0, true), w = dv.getInt32(4, true), h2 = dv.getInt32(8, true), bpp = dv.getUint16(14, true);
  const h = Math.abs(h2) >> 1;
  if (w <= 0 || h <= 0 || w > 256 || h > 256) return null;
  let colors = dv.getUint32(32, true); if (!colors && bpp <= 8) colors = 1 << bpp;
  const pal = hdr + (bpp <= 8 ? colors * 4 : 0);
  const xorStride = ((w * bpp + 31) >> 5) << 2, andStride = ((w + 31) >> 5) << 2;
  const xor = pal, and = xor + xorStride * h;
  const rgba = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = xor + (h - 1 - y) * xorStride, mrow = and + (h - 1 - y) * andStride; // bottom-up
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      if (bpp === 32) { const p = row + 4 * x; b = data[p]; g = data[p + 1]; r = data[p + 2]; a = data[p + 3]; if (a) anyAlpha = true; }
      else if (bpp === 24) { const p = row + 3 * x; b = data[p]; g = data[p + 1]; r = data[p + 2]; }
      else if (bpp === 16) { const v = data[row + 2 * x] | (data[row + 2 * x + 1] << 8); r = ((v >> 10) & 31) * 255 / 31 | 0; g = ((v >> 5) & 31) * 255 / 31 | 0; b = (v & 31) * 255 / 31 | 0; }
      else {
        const bit = x * bpp, byte = data[row + (bit >> 3)];
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const q = hdr + 4 * idx; b = data[q]; g = data[q + 1]; r = data[q + 2];
      }
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      // AND bit set: transparent where the color is black; a set color would invert the screen, shown opaque
      if (bpp !== 32 && mrow + (x >> 3) < data.length && (data[mrow + (x >> 3)] >> (7 - (x & 7))) & 1) rgba[o + 3] = r | g | b ? 255 : 0;
    }
  }
  if (bpp === 32 && !anyAlpha) { // 32 bpp without alpha: the AND mask decides, recomputed now that we know
    for (let y = 0; y < h; y++) { const mrow = and + (h - 1 - y) * andStride; for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; const m = (data[mrow + (x >> 3)] >> (7 - (x & 7))) & 1; rgba[o + 3] = m ? (rgba[o] | rgba[o + 1] | rgba[o + 2] ? 255 : 0) : 255; } }
  }
  return { w, h, rgba };
}

/** RIFF ACON: frames from LIST 'fram' / 'icon' chunks, timing from 'anih' (jiffies of 1/60 s), 'rate' and 'seq '. */
function parseAni(bytes, dv) {
  let frames = [], rate = null, seq = null, nSteps = 0, jif = 10;
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      const id = tag(bytes, p), size = dv.getUint32(p + 4, true), body = p + 8;
      if (id === 'anih' && size >= 36) { nSteps = dv.getUint32(body + 8, true); jif = dv.getUint32(body + 28, true) || 10; }
      else if (id === 'rate') { rate = []; for (let i = 0; i + 4 <= size; i += 4) rate.push(dv.getUint32(body + i, true)); }
      else if (id === 'seq ') { seq = []; for (let i = 0; i + 4 <= size; i += 4) seq.push(dv.getUint32(body + i, true)); }
      else if (id === 'LIST') walk(body + 4, Math.min(end, body + size));
      else if (id === 'icon') { const f = parseIconDir(bytes, dv, body); if (f) frames.push(f); }
      p = body + size + (size & 1);
    }
  };
  walk(12, bytes.length);
  if (!frames.length) return null;
  const n = nSteps || (seq ? seq.length : frames.length);
  const steps = [];
  for (let i = 0; i < n; i++) { const frame = seq ? seq[i] ?? 0 : i % frames.length; steps.push({ frame: Math.min(frame, frames.length - 1), ms: Math.round(((rate ? rate[i] ?? jif : jif) * 1000) / 60) }); }
  return { frames, steps };
}

/**
 * A cursor resource: RT_CURSOR data is a 2-byte hotspot (x, y) followed by the DIB/PNG image.
 * @returns {CursorImage|null}
 */
export function cursorFromResource(data) {
  if (data.length < 8) return null;
  const hotX = data[0] | (data[1] << 8), hotY = data[2] | (data[3] << 8);
  const img = decodeIconImage(data.subarray(4));
  return img ? { frames: [{ w: img.w, h: img.h, hotX, hotY, rgba: img.rgba }], steps: [{ frame: 0, ms: 0 }] } : null;
}

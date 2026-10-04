// The video codecs Windows ships with (the "Video for Windows" set its DirectShow AVI decompressor uses): uncompressed
// DIBs, Microsoft RLE (BI_RLE8 / BI_RLE4), Microsoft Video 1 (CRAM) and Cinepak (cvid). Each decoder draws into a
// persistent top-down frame of 32-bit pixels (little-endian ABGR words: R, G, B, A bytes), as delta frames update the
// previous picture.

/** BITMAPINFOHEADER fields + palette (0x00RRGGBB entries) of a video stream's format */
export function readBitmapInfo(b, at, len) {
  const dv = new DataView(b.buffer, b.byteOffset + at, len);
  const size = dv.getUint32(0, true), width = dv.getInt32(4, true), height = dv.getInt32(8, true), bits = dv.getUint16(14, true), compression = dv.getUint32(16, true);
  let colors = len >= 36 ? dv.getUint32(32, true) : 0;
  if (!colors && bits <= 8) colors = 1 << bits;
  const palette = new Uint32Array(256);
  for (let i = 0; i < Math.min(colors, 256) && size + 4 * i + 4 <= len; i++) { const o = size + 4 * i; palette[i] = (dv.getUint8(o + 2) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o); }
  return { width, height: Math.abs(height), bottomUp: height > 0, bits, compression, palette };
}
const fourcc = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
const BI_RGB = 0, BI_RLE8 = 1, BI_RLE4 = 2, BI_BITFIELDS = 3;
const rgb = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const pal = (c) => rgb((c >> 16) & 255, (c >> 8) & 255, c & 255);
const c555 = (v) => rgb(((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0);

/**
 * A decoder for a stream's compression (fourcc or BI_* value) — { decode(bytes, keyframe), frame: Uint32Array top-down,
 * width, height, setPalette(entries) } — or null when it is not one of these.
 */
export function vfwDecoder(info, handler = 0) {
  const c = info.compression, w = info.width, h = info.height;
  const frame = new Uint32Array(w * h).fill(0xff000000);
  const P = new Uint32Array(256); for (let i = 0; i < 256; i++) P[i] = pal(info.palette[i]);
  const base = { frame, width: w, height: h, setPalette(first, entries) { for (let i = 0; i < entries.length && first + i < 256; i++) P[first + i] = pal(entries[i]); } };
  const row = (y) => (info.bottomUp ? h - 1 - y : y) * w; // (the frame row of a stored row)
  if (c === BI_RGB || c === BI_BITFIELDS) {
    const bits = info.bits, stride = ((w * bits + 31) >> 5) << 2;
    if (![8, 16, 24, 32].includes(bits) && !(bits === 4 || bits === 1)) return null;
    return { ...base, decode(b) {
      for (let y = 0; y < h; y++) {
        const o = y * stride, r = row(y);
        if (o + stride > b.length) break;
        for (let x = 0; x < w; x++) {
          let v;
          if (bits === 24) v = rgb(b[o + 3 * x + 2], b[o + 3 * x + 1], b[o + 3 * x]);
          else if (bits === 32) v = rgb(b[o + 4 * x + 2], b[o + 4 * x + 1], b[o + 4 * x]);
          else if (bits === 16) v = c555(b[o + 2 * x] | (b[o + 2 * x + 1] << 8)); // (BI_RGB 16-bit: 5-5-5)
          else if (bits === 8) v = P[b[o + x]];
          else if (bits === 4) v = P[(b[o + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15];
          else v = P[(b[o + (x >> 3)] >> (7 - (x & 7))) & 1];
          frame[r + x] = v;
        }
      }
    } };
  }
  if (c === BI_RLE8 || c === BI_RLE4) {
    const four = c === BI_RLE4;
    const put = (x, y, v) => { if (x < w && y < h) frame[row(y) + x] = P[v]; };
    return { ...base, decode(b) {
      let x = 0, y = 0, i = 0;
      while (i + 1 < b.length && y < h) {
        const n = b[i++], v = b[i++];
        if (n) { for (let k = 0; k < n; k++) put(x++, y, four ? (k & 1 ? v & 15 : v >> 4) : v); continue; }
        if (v === 0) { x = 0; y++; } // end of line
        else if (v === 1) break; // end of bitmap
        else if (v === 2) { x += b[i++]; y += b[i++]; } // delta
        else { // absolute run of v pixels, padded to a word
          const bytes = four ? (v + 1) >> 1 : v;
          for (let k = 0; k < v; k++) put(x++, y, four ? (k & 1 ? b[i + (k >> 1)] & 15 : b[i + (k >> 1)] >> 4) : b[i + k]);
          i += bytes + (bytes & 1);
        }
      }
    } };
  }
  const cc = c === 0 ? handler : c;
  if (cc === fourcc('CRAM') || cc === fourcc('cram') || cc === fourcc('MSVC') || cc === fourcc('msvc') || cc === fourcc('WHAM') || cc === fourcc('wham')) return msvideo1(base, info, row);
  if (cc === fourcc('cvid') || cc === fourcc('CVID')) return cinepak(base, info);
  return null;
}

/**
 * Microsoft Video 1, 16-bit form: 4x4 blocks from the bottom-left, 1, 2 or 8 colors (5-5-5) each. (The 8-bit form, with
 * palette indexes, is not decoded: vfwDecoder answers null.)
 */
function msvideo1(base, info, row) {
  if (info.bits !== 16) return null;
  const { frame, width: w, height: h } = base;
  const bw = w >> 2, bh = h >> 2;
  const px = (bx, by, k, v) => { frame[row(by * 4 + (k >> 2)) + bx * 4 + (k & 3)] = v; }; // (k: pixel k of the block, from its first stored row)
  return { ...base, decode(b) {
    let i = 0, skip = 0;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        if (skip > 0) { skip--; continue; }
        if (i + 2 > b.length) return;
        const a = b[i++], f = b[i++];
        if (a === 0 && f === 0) return; // (end of the picture: the rest unchanged)
        if ((f & 0xfc) === 0x84) { skip = ((f - 0x84) << 8) + a - 1; continue; } // (blocks unchanged)
        if (f < 0x80) { // 16 flag bits, one per pixel: 2 colors, or 8 (a pair per 2x2 quadrant) when the first has its top bit
          const flags = (f << 8) | a, ca = b[i] | (b[i + 1] << 8);
          if (ca & 0x8000) {
            const cols = []; for (let k = 0; k < 8; k++) cols.push(c555(b[i + 2 * k] | (b[i + 2 * k + 1] << 8)));
            i += 16;
            for (let k = 0; k < 16; k++) { const q = ((k >> 3) << 1) | ((k & 3) >> 1); px(bx, by, k, cols[2 * q + (((flags >> k) & 1) ^ 1)]); }
          } else {
            const cb = b[i + 2] | (b[i + 3] << 8); i += 4;
            const colors = [c555(cb), c555(ca)];
            for (let k = 0; k < 16; k++) px(bx, by, k, colors[(flags >> k) & 1]);
          }
        } else { const v = c555((f << 8) | a); for (let k = 0; k < 16; k++) px(bx, by, k, v); } // (one color)
      }
    }
  } };
}

/** Cinepak: strips of 4x4 blocks, each from one (V1, doubled) or four (V4) entries of the strip's 2x2 codebooks */
function cinepak(base) {
  const { frame, width: W, height: H } = base;
  const books = []; // per strip: { v1: Uint32Array(256 * 4), v4: Uint32Array(256 * 4) } — 2x2 pixels per entry
  const book = () => ({ v1: new Uint32Array(1024).fill(0xff000000), v4: new Uint32Array(1024).fill(0xff000000) });
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const yuv = (y, u, v) => rgb(clamp(y + 2 * v), clamp(y - (u >> 1) - v), clamp(y + 2 * u));
  const be16 = (b, i) => (b[i] << 8) | b[i + 1], be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  function loadBook(dst, b, i, end, partial, gray) {
    const n = gray ? 4 : 6;
    let k = 0;
    while (i < end && k < 256) {
      let mask = 0xffffffff;
      if (partial) { if (i + 4 > end) break; mask = be32(b, i); i += 4; }
      for (let bit = 31; bit >= 0 && k < 256; bit--, k++) {
        if (!(mask >>> bit & 1)) continue;
        if (i + n > end) return;
        const u = gray ? 0 : (b[i + 4] << 24) >> 24, v = gray ? 0 : (b[i + 5] << 24) >> 24;
        for (let p = 0; p < 4; p++) dst[4 * k + p] = yuv(b[i + p], u, v);
        i += n;
      }
    }
  }
  return { ...base, decode(b) {
    if (b.length < 10) return;
    const flags = b[0], strips = be16(b, 8);
    let i = 10, y0 = 0;
    for (let s = 0; s < strips && i + 12 <= b.length; s++) {
      const size = be16(b, i + 2), top = be16(b, i + 4), left = be16(b, i + 6), bottom = be16(b, i + 8), right = be16(b, i + 10);
      const end = Math.min(b.length, i + size);
      const sy0 = top ? top : y0, sy1 = top ? bottom : y0 + bottom; // (a zero top: the strip follows the previous one, `bottom` its height)
      if (!books[s]) books[s] = book();
      if (s > 0 && !(flags & 1)) { books[s].v1.set(books[s - 1].v1); books[s].v4.set(books[s - 1].v4); } // (codebooks inherited)
      const bk = books[s];
      let j = i + 12;
      while (j + 4 <= end) {
        const id = be16(b, j), csize = be16(b, j + 2), cend = Math.min(end, j + csize);
        if (csize < 4) break;
        const d = j + 4;
        switch (id) {
          case 0x2000: case 0x2100: case 0x2400: case 0x2500: loadBook(bk.v4, b, d, cend, (id & 0x100) !== 0, (id & 0x400) !== 0); break;
          case 0x2200: case 0x2300: case 0x2600: case 0x2700: loadBook(bk.v1, b, d, cend, (id & 0x100) !== 0, (id & 0x400) !== 0); break;
          case 0x3000: case 0x3100: case 0x3200: blocks(bk, b, d, cend, id, left, sy0, right, sy1); break;
        }
        j += csize;
      }
      y0 = sy1; i += size;
    }
  } };
  function blocks(bk, b, i, end, id, x0, y0, x1, y1) {
    let mask = 0, bit = 0; // (flag words read as needed, most significant bit first)
    const flag = () => { if (!bit) { if (i + 4 > end) return -1; mask = be32(b, i); i += 4; bit = 32; } bit--; return mask >>> bit & 1; };
    const right = Math.min(x1 || W, W);
    for (let y = y0; y < Math.min(y1, H); y += 4) {
      for (let x = x0; x < right; x += 4) {
        let mode; // 0 skip, 1 V1, 4 V4
        if (id === 0x3200) mode = 1;
        else if (id === 0x3000) { const f = flag(); if (f < 0) return; mode = f ? 4 : 1; }
        else { const f = flag(); if (f < 0) return; if (!f) mode = 0; else { const g = flag(); if (g < 0) return; mode = g ? 4 : 1; } }
        if (mode === 0) continue;
        if (mode === 1) {
          if (i >= end) return;
          const e = 4 * b[i++];
          for (let q = 0; q < 4; q++) { const v = bk.v1[e + q], qx = x + (q & 1) * 2, qy = y + (q >> 1) * 2; fill(qx, qy, v, v, v, v); }
        } else {
          if (i + 4 > end) return;
          for (let q = 0; q < 4; q++) { const e = 4 * b[i++], qx = x + (q & 1) * 2, qy = y + (q >> 1) * 2; fill(qx, qy, bk.v4[e], bk.v4[e + 1], bk.v4[e + 2], bk.v4[e + 3]); }
        }
      }
    }
  }
  function fill(x, y, a, c, d, e) {
    if (y < H) { const o = y * W + x; if (x < W) frame[o] = a; if (x + 1 < W) frame[o + 1] = c; }
    if (y + 1 < H) { const o = (y + 1) * W + x; if (x < W) frame[o] = d; if (x + 1 < W) frame[o + 1] = e; }
  }
}

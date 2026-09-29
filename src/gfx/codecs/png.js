// PNG decoder: color types 0/2/3/4/6, bit depths 1-16, Adam7 interlace, tRNS transparency.
// Output: { width, height, data: Uint8Array RGBA }.
import { inflate } from './inflate.js';

export function isPng(b) { return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47; }

export function decodePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 8, ctype = 6, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos); const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); depth = bytes[pos + 16]; ctype = bytes[pos + 17]; interlace = bytes[pos + 20]; }
    else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') trns = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  let total = 0; for (const d of idat) total += d.length;
  const comp = new Uint8Array(total); let o = 0; for (const d of idat) { comp.set(d, o); o += d.length; }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel (for filtering), >=1
  const rawSize = passRows(width, height, interlace, channels, depth);
  let raw = inflate(comp, { sizeHint: rawSize * 1.05 + 64 });
  if (raw.length < rawSize) { const r = new Uint8Array(rawSize); r.set(raw); raw = r; } // (truncated data: zero bytes)
  const out = new Uint8Array(width * height * 4);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const lut8 = ctype === 3 && depth === 8 ? paletteLut(palette, trns) : palette;
  let rp = 0;
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((width - sx) / dx), ph = Math.ceil((height - sy) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil(pw * channels * depth / 8);
    for (let y = 0; y < ph; y++) {
      const filter = raw[rp++];
      // (rows are unfiltered in place: the previous row of the pass is the rowBytes + 1 bytes before, none for the first)
      unfilter(raw, rp, y ? rp - rowBytes - 1 : -1, rowBytes, bpp, filter);
      const row = raw.subarray(rp, rp + rowBytes); rp += rowBytes;
      if (depth === 8) { unpack8(row, pw, out, ((sy + y * dy) * width + sx) * 4, dx * 4, ctype, lut8, trns); continue; }
      // unpack samples
      for (let x = 0; x < pw; x++) {
        const px = sx + x * dx, py = sy + y * dy;
        const oi = (py * width + px) * 4;
        const samp = (k) => { // k-th sample of the pixel
          const idx = x * channels + k;
          if (depth === 8) return row[idx];
          if (depth === 16) return row[idx * 2];
          const bitPos = idx * depth; const byte = row[bitPos >> 3]; const shift = 8 - depth - (bitPos & 7);
          const v = (byte >> shift) & ((1 << depth) - 1);
          return ctype === 3 ? v : (v * 255) / ((1 << depth) - 1);
        };
        switch (ctype) {
          case 0: { const g = samp(0); out[oi] = out[oi + 1] = out[oi + 2] = g; out[oi + 3] = trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === (depth === 16 ? (row[x * 2] << 8) | row[x * 2 + 1] : Math.round(g * ((1 << depth) - 1) / 255)) ? 0 : 255; break; }
          case 2: { out[oi] = samp(0); out[oi + 1] = samp(1); out[oi + 2] = samp(2); out[oi + 3] = 255; if (trns && trns.length >= 6 && out[oi] === trns[1] && out[oi + 1] === trns[3] && out[oi + 2] === trns[5]) out[oi + 3] = 0; break; }
          case 3: { const i = samp(0); out[oi] = palette ? palette[i * 3] : 0; out[oi + 1] = palette ? palette[i * 3 + 1] : 0; out[oi + 2] = palette ? palette[i * 3 + 2] : 0; out[oi + 3] = trns && i < trns.length ? trns[i] : 255; break; }
          case 4: { const g = samp(0); out[oi] = out[oi + 1] = out[oi + 2] = g; out[oi + 3] = samp(1); break; }
          case 6: { out[oi] = samp(0); out[oi + 1] = samp(1); out[oi + 2] = samp(2); out[oi + 3] = samp(3); break; }
        }
      }
    }
  }
  return { width, height, data: out };
}

/** Bytes of filtered image data (filter byte + row) of every pass. */
function passRows(width, height, interlace, channels, depth) {
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let n = 0;
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((width - sx) / dx), ph = Math.ceil((height - sy) / dy);
    if (pw > 0 && ph > 0) n += ph * (Math.ceil(pw * channels * depth / 8) + 1);
  }
  return n;
}

/**
 * The Paeth predictor of a (left), u (up), c (up-left): whichever is closest to a + u - c, ties to a then u. Without
 * branches (the choice is data-dependent: a mispredicted branch per byte otherwise).
 */
function paeth(a, u, c) {
  let pa = u - c, pb = a - c, pc = pa + pb, m; // (p - a, p - b, p - c for p = a + u - c)
  m = pa >> 31; pa = (pa ^ m) - m; m = pb >> 31; pb = (pb ^ m) - m; m = pc >> 31; pc = (pc ^ m) - m;
  const notA = ((pb - pa) | (pc - pa)) >> 31, cOverU = (pc - pb) >> 31; // (-1: pa > pb or pa > pc; pb > pc)
  const uc = u ^ ((u ^ c) & cOverU);
  return a ^ ((a ^ uc) & notA);
}

/**
 * Undo a row's filter in place: the row at b[r..r+len), the previous (already unfiltered) row at b[p..p+len), p < 0 for
 * the first row of a pass (all zero). One loop per filter type; bytes before the row's first pixel have a = c = 0.
 * (Row lengths are whole pixels when bpp > 1.)
 * An unknown filter type leaves the row as it is.
 */
function unfilter(b, r, p, len, bpp, filter) {
  switch (filter) {
    case 1: for (let i = bpp; i < len; i++) b[r + i] += b[r + i - bpp]; break;
    case 2: if (p >= 0) for (let i = 0; i < len; i++) b[r + i] += b[p + i]; break;
    case 3:
      if (p < 0) { for (let i = bpp; i < len; i++) b[r + i] += b[r + i - bpp] >> 1; break; }
      for (let i = 0; i < bpp && i < len; i++) b[r + i] += b[p + i] >> 1;
      for (let i = bpp; i < len; i++) b[r + i] += (b[r + i - bpp] + b[p + i]) >> 1;
      break;
    case 4:
      if (p < 0) { for (let i = bpp; i < len; i++) b[r + i] += b[r + i - bpp]; break; } // (Paeth(a, 0, 0) = a)
      for (let i = 0; i < bpp && i < len; i++) b[r + i] += b[p + i]; // (Paeth(0, b, 0) = b)
      if (bpp === 4) { // (RGBA: the four channels' chains interleaved, each carrying its a and c in registers)
        let a0 = b[r], a1 = b[r + 1], a2 = b[r + 2], a3 = b[r + 3], c0 = b[p], c1 = b[p + 1], c2 = b[p + 2], c3 = b[p + 3];
        for (let i = 4; i + 3 < len; i += 4) {
          const u0 = b[p + i], u1 = b[p + i + 1], u2 = b[p + i + 2], u3 = b[p + i + 3];
          a0 = (b[r + i] + paeth(a0, u0, c0)) & 255; a1 = (b[r + i + 1] + paeth(a1, u1, c1)) & 255;
          a2 = (b[r + i + 2] + paeth(a2, u2, c2)) & 255; a3 = (b[r + i + 3] + paeth(a3, u3, c3)) & 255;
          b[r + i] = a0; b[r + i + 1] = a1; b[r + i + 2] = a2; b[r + i + 3] = a3; c0 = u0; c1 = u1; c2 = u2; c3 = u3;
        }
        break;
      }
      if (bpp === 3) { // (RGB)
        let a0 = b[r], a1 = b[r + 1], a2 = b[r + 2], c0 = b[p], c1 = b[p + 1], c2 = b[p + 2];
        for (let i = 3; i + 2 < len; i += 3) {
          const u0 = b[p + i], u1 = b[p + i + 1], u2 = b[p + i + 2];
          a0 = (b[r + i] + paeth(a0, u0, c0)) & 255; a1 = (b[r + i + 1] + paeth(a1, u1, c1)) & 255; a2 = (b[r + i + 2] + paeth(a2, u2, c2)) & 255;
          b[r + i] = a0; b[r + i + 1] = a1; b[r + i + 2] = a2; c0 = u0; c1 = u1; c2 = u2;
        }
        break;
      }
      for (let ch = 0; ch < bpp && ch < len; ch++) { // (one sample channel at a time: a and c carried in registers)
        let a = b[r + ch], c = b[p + ch];
        for (let i = ch + bpp; i < len; i += bpp) { const u = b[p + i]; a = (b[r + i] + paeth(a, u, c)) & 255; b[r + i] = a; c = u; }
      }
      break;
  }
}

/** The palette as RGBA entries for 256 indices: past the palette black, past tRNS opaque (as the generic path reads). */
function paletteLut(palette, trns) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    if (palette) { lut[4 * i] = palette[i * 3] ?? 0; lut[4 * i + 1] = palette[i * 3 + 1] ?? 0; lut[4 * i + 2] = palette[i * 3 + 2] ?? 0; }
    lut[4 * i + 3] = trns && i < trns.length ? trns[i] : 255;
  }
  return lut;
}

/**
 * 8-bit samples of one unfiltered row to RGBA at out[o], o += step per pixel (4, or 4 * the Adam7 column step), with
 * the generic path's transparency rules (gray / RGB key colour from tRNS, palette alpha). For palette images `palette`
 * is paletteLut's table.
 */
function unpack8(row, pw, out, o, step, ctype, palette, trns) {
  switch (ctype) {
    case 0: {
      const key = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
      for (let x = 0; x < pw; x++, o += step) { const g = row[x]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = g === key ? 0 : 255; }
      break;
    }
    case 2: {
      const keyed = trns && trns.length >= 6, kr = keyed ? trns[1] : -1, kg = keyed ? trns[3] : -1, kb = keyed ? trns[5] : -1;
      for (let x = 0, i = 0; x < pw; x++, i += 3, o += step) {
        const r = row[i], g = row[i + 1], bl = row[i + 2];
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = r === kr && g === kg && bl === kb ? 0 : 255;
      }
      break;
    }
    case 3: { const lut = palette; // (paletteLut's table)
      for (let x = 0; x < pw; x++, o += step) { const k = row[x] * 4; out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = lut[k + 3]; }
      break;
    }
    case 4:
      for (let x = 0, i = 0; x < pw; x++, i += 2, o += step) { const g = row[i]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = row[i + 1]; }
      break;
    case 6:
      if (step === 4) { out.set(row.subarray(0, pw * 4), o); break; }
      for (let x = 0, i = 0; x < pw; x++, i += 4, o += step) { out[o] = row[i]; out[o + 1] = row[i + 1]; out[o + 2] = row[i + 2]; out[o + 3] = row[i + 3]; }
      break;
  }
}

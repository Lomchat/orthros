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
  const raw = inflate(comp, { sizeHint: height * (Math.ceil(width * channels * depth / 8) + 1) * 1.05 + 64 });
  const out = new Uint8Array(width * height * 4);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let rp = 0;
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((width - sx) / dx), ph = Math.ceil((height - sy) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil(pw * channels * depth / 8);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      const filter = raw[rp++];
      const row = raw.slice(rp, rp + rowBytes); rp += rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = row[i];
        switch (filter) { case 1: v += a; break; case 2: v += b; break; case 3: v += (a + b) >> 1; break; case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; } }
        row[i] = v & 0xff;
      }
      prev = row;
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

// JPEG decoder (baseline and progressive DCT, Huffman coding, 8-bit samples, YCbCr/grayscale/
// CMYK, arbitrary chroma subsampling, restart intervals). Output: { width, height, data: Uint8Array RGBA }.

class BitReader {
  constructor(bytes, pos) { this.b = bytes; this.pos = pos; this.acc = 0; this.n = 0; this.marker = 0; }
  fill() {
    while (this.n <= 24) {
      let v = 0;
      if (this.marker || this.pos >= this.b.length) { v = 0; }
      else {
        v = this.b[this.pos++];
        if (v === 0xff) {
          const nx = this.b[this.pos];
          if (nx === 0) this.pos++;
          else if (nx >= 0xd0 && nx <= 0xd7) { /* RST: handled by restart logic, treat as end of data for now */ this.marker = nx; this.pos--; v = 0; }
          else { this.marker = nx; this.pos--; v = 0; }
        }
      }
      this.acc = (this.acc << 8) | v; this.n += 8;
    }
  }
  bit() { if (this.n === 0) this.fill(); this.n--; return (this.acc >>> this.n) & 1; }
  bits(k) { if (k === 0) return 0; if (this.n < k) this.fill(); this.n -= k; return (this.acc >>> this.n) & ((1 << k) - 1); }
  receiveExtend(s) { if (s === 0) return 0; const v = this.bits(s); return v < 1 << (s - 1) ? v - (1 << s) + 1 : v; }
  /** align to a byte boundary and skip to after the next RST marker */
  restart() {
    this.acc = 0; this.n = 0; this.marker = 0;
    // find RSTn
    while (this.pos + 1 < this.b.length) { if (this.b[this.pos] === 0xff && this.b[this.pos + 1] >= 0xd0 && this.b[this.pos + 1] <= 0xd7) { this.pos += 2; return; } this.pos++; }
  }
  decodeHuff(t) {
    // t: { maxcode[17], valptr[17], mincode[17], vals, lookup (9-bit) }
    if (this.n < 16) this.fill();
    const peek = (this.acc >>> (this.n - 9)) & 0x1ff;
    const lk = t.lookup[peek];
    if (lk) { this.n -= lk >> 8; return lk & 0xff; }
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | this.bit();
      if (code <= t.maxcode[l]) return t.vals[t.valptr[l] + code - t.mincode[l]];
    }
    return 0;
  }
}

function buildHuff(counts, vals) {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k; mincode[l] = code;
    code += counts[l - 1]; k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  // 9-bit lookup: (length << 8) | value
  const lookup = new Uint16Array(512);
  code = 0; k = 0;
  for (let l = 1; l <= 9; l++) {
    for (let i = 0; i < counts[l - 1]; i++) {
      const v = vals[k++];
      const shift = 9 - l;
      for (let j = 0; j < 1 << shift; j++) lookup[(code << shift) | j] = (l << 8) | v;
      code++;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, vals, lookup };
}

const ZIGZAG = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);

// Float IDCT (separable), accurate and simple.
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const tmp = new Float32Array(64), rowU = new Int32Array(8), rowV = new Float64Array(8);
/**
 * The same transform as idctReference, skipping what is zero (most blocks carry a handful of low frequencies): a block
 * with only its DC term is flat; rows without coefficients contribute nothing to the column pass, which runs only over
 * the rows up to the last one that has some. `coef` holds the block at `co`.
 */
function idct(coef, co, qt, out, outOff, stride) {
  let last = -1, acAny = false;
  for (let y = 0; y < 8; y++) {
    let any = false;
    for (let u = 0; u < 8; u++) if (coef[co + y * 8 + u]) { any = true; if (y || u) acAny = true; }
    if (any) last = y;
  }
  if (!acAny) { // (flat: DC * q / 8 + 128 everywhere, as both passes give)
    const t = Math.fround(coef[co] * qt[0] * COS[0] / 2), v0 = Math.round(t * COS[0] / 2 + 128), v = v0 < 0 ? 0 : v0 > 255 ? 255 : v0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[outOff + y * stride + x] = v;
    return;
  }
  for (let y = 0; y <= last; y++) {
    const r = co + y * 8;
    let n = 0; // (the row's nonzero terms, dequantized, in increasing u: the same sums as the reference)
    for (let u = 0; u < 8; u++) { const c = coef[r + u]; if (c) { rowU[n] = u; rowV[n] = c * qt[y * 8 + u]; n++; } }
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rowV[i] * COS[x * 8 + rowU[i]];
      tmp[y * 8 + x] = s / 2;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v <= last; v++) s += tmp[v * 8 + x] * COS[y * 8 + v];
      const val = Math.round(s / 2 + 128);
      out[outOff + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}
/** The plain separable float IDCT (reference for tests). */
export function idctReference(coef, qt, out, outOff, stride) {
  // rows: coef is in natural order (dequantize here)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) { const c = coef[y * 8 + u]; if (c) s += c * qt[y * 8 + u] * COS[x * 8 + u]; }
      tmp[y * 8 + x] = s / 2;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * COS[y * 8 + v];
      const val = Math.round(s / 2 + 128);
      out[outOff + y * stride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}

export function decodeJpeg(bytes) {
  let pos = 0;
  const u16 = () => { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  pos = 2;
  const qts = [];
  const dcTabs = [], acTabs = [];
  let frame = null, restartInterval = 0, adobe = false, progressive = false;
  let eobrun = 0;
  const scans = [];
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const m = bytes[pos + 1]; pos += 2;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { if (m === 0xff) pos--; continue; }
    if (m === 0xd9) break;
    const len = u16(); const end = pos + len - 2;
    switch (m) {
      case 0xdb: // DQT
        while (pos < end) { const pq = bytes[pos] >> 4, tq = bytes[pos] & 15; pos++; const t = new Uint16Array(64); for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = pq ? u16() : bytes[pos++]; } qts[tq] = t; }
        break;
      case 0xc4: // DHT
        while (pos < end) { const tc = bytes[pos] >> 4, th = bytes[pos] & 15; pos++; const counts = bytes.subarray(pos, pos + 16); pos += 16; let n = 0; for (let i = 0; i < 16; i++) n += counts[i]; const vals = bytes.subarray(pos, pos + n); pos += n; (tc ? acTabs : dcTabs)[th] = buildHuff(counts, vals); }
        break;
      case 0xc0: case 0xc1: case 0xc2: { // SOF
        progressive = m === 0xc2;
        pos++; // precision
        const height = u16(), width = u16(); const nc = bytes[pos++];
        const comps = [];
        for (let i = 0; i < nc; i++) { comps.push({ id: bytes[pos], h: bytes[pos + 1] >> 4, v: bytes[pos + 1] & 15, tq: bytes[pos + 2] }); pos += 3; }
        const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
        const mcux = Math.ceil(width / (8 * hmax)), mcuy = Math.ceil(height / (8 * vmax));
        for (const c of comps) {
          c.bw = mcux * c.h; c.bh = mcuy * c.v; // blocks per line/column (padded to MCU)
          c.coef = new Int16Array(c.bw * c.bh * 64);
          c.pred = 0;
        }
        frame = { width, height, comps, hmax, vmax, mcux, mcuy };
        break;
      }
      case 0xdd: restartInterval = u16(); break;
      case 0xee: if (bytes[pos] === 0x41 && bytes[pos + 1] === 0x64) adobe = true; break; // Adobe
      case 0xda: { // SOS
        const ns = bytes[pos++];
        const sc = [];
        for (let i = 0; i < ns; i++) { const id = bytes[pos], t = bytes[pos + 1]; pos += 2; const c = frame.comps.find((x) => x.id === id); c.td = t >> 4; c.ta = t & 15; sc.push(c); }
        const ss = bytes[pos], se = bytes[pos + 1], ah = bytes[pos + 2] >> 4, al = bytes[pos + 2] & 15; pos += 3;
        pos = decodeScan(bytes, pos, frame, sc, { ss, se, ah, al, progressive, restartInterval, dcTabs, acTabs });
        scans.push(1);
        continue; // decodeScan leaves pos at the next marker
      }
      default: break;
    }
    pos = end;
  }
  if (!frame) throw new Error('JPEG: no frame');
  return outputImage(frame, qts, adobe);
}

function decodeScan(bytes, pos, frame, sc, o) {
  const r = new BitReader(bytes, pos);
  const { ss, se, ah, al, progressive } = o;
  for (const c of sc) c.pred = 0;
  let eobrun = 0;
  const single = sc.length === 1;
  // number of MCUs (non-interleaved scans iterate over the component's blocks)
  let mcuTotal, perLine;
  if (single) { const c = sc[0]; const bw = Math.ceil(Math.ceil(frame.width * c.h / frame.hmax) / 8), bh = Math.ceil(Math.ceil(frame.height * c.v / frame.vmax) / 8); perLine = bw; mcuTotal = bw * bh; c.sbw = bw; c.sbh = bh; }
  else { perLine = frame.mcux; mcuTotal = frame.mcux * frame.mcuy; }
  const decodeBlock = (c, brow, bcol) => {
    const off = (brow * c.bw + bcol) * 64;
    const coef = c.coef;
    if (!progressive) {
      const t = r.decodeHuff(o.dcTabs[c.td]);
      const diff = t === 0 ? 0 : r.receiveExtend(t);
      c.pred += diff;
      coef[off] = c.pred;
      let k = 1;
      const ac = o.acTabs[c.ta];
      while (k < 64) {
        const rs = r.decodeHuff(ac); const s = rs & 15, rr = rs >> 4;
        if (s === 0) { if (rr < 15) break; k += 16; continue; }
        k += rr; if (k > 63) break;
        coef[off + ZIGZAG[k]] = r.receiveExtend(s); k++;
      }
      return;
    }
    if (ss === 0) { // DC scan
      if (ah === 0) { const t = r.decodeHuff(o.dcTabs[c.td]); const diff = t === 0 ? 0 : r.receiveExtend(t); c.pred += diff; coef[off] = c.pred << al; }
      else if (r.bit()) coef[off] |= 1 << al;
      return;
    }
    // AC scans
    if (ah === 0) { // first
      if (eobrun > 0) { eobrun--; return; }
      let k = ss;
      const ac = o.acTabs[c.ta];
      while (k <= se) {
        const rs = r.decodeHuff(ac); const s = rs & 15, rr = rs >> 4;
        if (s === 0) { if (rr < 15) { eobrun = (1 << rr) - 1; if (rr) eobrun += r.bits(rr); break; } k += 16; continue; }
        k += rr; if (k > 63) break;
        coef[off + ZIGZAG[k]] = r.receiveExtend(s) * (1 << al); k++;
      }
      return;
    }
    // AC refinement
    let k = ss;
    const p1 = 1 << al, m1 = -1 << al;
    const ac = o.acTabs[c.ta];
    if (eobrun <= 0) {
      while (k <= se) {
        const rs = r.decodeHuff(ac); let rr = rs >> 4; const s = rs & 15;
        let val = 0;
        if (s === 0) { if (rr < 15) { eobrun = (1 << rr); if (rr) eobrun += r.bits(rr); break; } }
        else val = r.bit() ? p1 : m1;
        while (k <= se) {
          const z = off + ZIGZAG[k];
          if (coef[z] !== 0) { if (r.bit()) { if ((coef[z] & p1) === 0) coef[z] += coef[z] >= 0 ? p1 : m1; } }
          else { if (rr === 0) { if (val) coef[z] = val; k++; break; } rr--; }
          k++;
        }
      }
    }
    if (eobrun > 0) {
      while (k <= se) { const z = off + ZIGZAG[k]; if (coef[z] !== 0) { if (r.bit()) { if ((coef[z] & p1) === 0) coef[z] += coef[z] >= 0 ? p1 : m1; } } k++; }
      eobrun--;
    }
  };
  let mcu = 0;
  while (mcu < mcuTotal) {
    if (o.restartInterval && mcu > 0 && mcu % o.restartInterval === 0) { r.restart(); for (const c of sc) c.pred = 0; eobrun = 0; }
    if (single) { const c = sc[0]; const brow = (mcu / perLine) | 0, bcol = mcu % perLine; decodeBlock(c, brow, bcol); }
    else {
      const my = (mcu / perLine) | 0, mx = mcu % perLine;
      for (const c of sc) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, my * c.v + v, mx * c.h + h);
    }
    mcu++;
    // a marker seen by the reader's look-ahead does not end the scan: the buffered bits still belong
    // to the last blocks (the reader feeds zero bits past the marker, like a truncated scan)
  }
  // position after scan data: find next marker
  let p = r.pos;
  while (p + 1 < bytes.length && !(bytes[p] === 0xff && bytes[p + 1] !== 0 && !(bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7))) p++;
  return p;
}

// libjpeg-compatible YCbCr->RGB fixed-point tables (rounded, 16 fractional bits)
const FIX = (x) => (x * 65536 + 0.5) | 0;
const CR_R = new Int32Array(256), CB_B = new Int32Array(256), CR_G = new Int32Array(256), CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i - 128;
  CR_R[i] = (FIX(1.40200) * x + 32768) >> 16; CB_B[i] = (FIX(1.77200) * x + 32768) >> 16;
  CR_G[i] = -FIX(0.71414) * x; CB_G[i] = -FIX(0.34414) * x + 32768;
}

/** Triangle-filter ("fancy") chroma upsampling by 2 horizontally and/or vertically, edge-replicating. */
function upsample(plane, pw, ph, dw, dh, fx, fy) {
  const ow = dw * fx, oh = dh * fy;
  const out = new Uint8ClampedArray(ow * oh);
  if (fx === 2 && fy === 2) {
    for (let oy = 0; oy < oh; oy++) {
      const iy = oy >> 1, far = Math.min(dh - 1, Math.max(0, (oy & 1) ? iy + 1 : iy - 1));
      const r0 = iy * pw, r1 = far * pw, o = oy * ow;
      const colsum = (x) => plane[r0 + x] * 3 + plane[r1 + x];
      let last = colsum(0), cur = last, next;
      for (let x = 0; x < dw; x++) {
        next = x + 1 < dw ? colsum(x + 1) : cur;
        out[o + 2 * x] = (cur * 3 + (x ? last : cur) + 8) >> 4;
        out[o + 2 * x + 1] = (cur * 3 + next + 7) >> 4;
        last = cur; cur = next;
      }
    }
  } else if (fx === 2 && fy === 1) {
    for (let y = 0; y < dh; y++) {
      const r = y * pw, o = y * ow;
      for (let x = 0; x < dw; x++) {
        const v = plane[r + x];
        out[o + 2 * x] = x ? (v * 3 + plane[r + x - 1] + 1) >> 2 : v;
        out[o + 2 * x + 1] = x + 1 < dw ? (v * 3 + plane[r + x + 1] + 2) >> 2 : v;
      }
    }
  } else if (fx === 1 && fy === 2) {
    for (let oy = 0; oy < oh; oy++) {
      const iy = oy >> 1, far = Math.min(dh - 1, Math.max(0, (oy & 1) ? iy + 1 : iy - 1)), bias = (oy & 1) ? 2 : 1;
      const r0 = iy * pw, r1 = far * pw, o = oy * ow;
      for (let x = 0; x < dw; x++) out[o + x] = (plane[r0 + x] * 3 + plane[r1 + x] + bias) >> 2;
    }
  } else { // other ratios: sample replication
    for (let oy = 0; oy < oh; oy++) { const r = ((oy / fy) | 0) * pw, o = oy * ow; for (let ox = 0; ox < ow; ox++) out[o + ox] = plane[r + ((ox / fx) | 0)]; }
  }
  return { plane: out, pw: ow, ph: oh };
}

function outputImage(frame, qts, adobe) {
  const { width, height, comps, hmax, vmax } = frame;
  // IDCT each component into a plane, then bring every plane to full resolution
  const planes = comps.map((c) => {
    const pw = c.bw * 8, ph = c.bh * 8;
    let plane = new Uint8ClampedArray(pw * ph);
    const qt = qts[c.tq];
    for (let by = 0; by < c.bh; by++) for (let bx = 0; bx < c.bw; bx++) idct(c.coef, (by * c.bw + bx) * 64, qt, plane, by * 8 * pw + bx * 8, pw);
    const fx = hmax / c.h, fy = vmax / c.v;
    if (fx !== 1 || fy !== 1) {
      const dw = Math.ceil(width * c.h / hmax), dh = Math.ceil(height * c.v / vmax); // downsampled component size
      return upsample(plane, pw, ph, dw, dh, fx, fy);
    }
    return { plane, pw, ph };
  });
  const out = new Uint8Array(width * height * 4);
  const p0 = planes[0], p1 = planes[1], p2 = planes[2], p3 = planes[3];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (comps.length === 1) { const g = p0.plane[y * p0.pw + x]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; continue; }
      if (comps.length === 3) {
        const Y = p0.plane[y * p0.pw + x], cb = p1.plane[y * p1.pw + x], cr = p2.plane[y * p2.pw + x];
        out[o] = clamp(Y + CR_R[cr]); out[o + 1] = clamp(Y + ((CB_G[cb] + CR_G[cr]) >> 16)); out[o + 2] = clamp(Y + CB_B[cb]); out[o + 3] = 255;
        continue;
      }
      // CMYK (Adobe inverted)
      const cc = p0.plane[y * p0.pw + x], mm = p1.plane[y * p1.pw + x], yy = p2.plane[y * p2.pw + x], kk = p3.plane[y * p3.pw + x];
      if (adobe) { out[o] = (cc * kk) / 255; out[o + 1] = (mm * kk) / 255; out[o + 2] = (yy * kk) / 255; }
      else { out[o] = 255 - Math.min(255, cc + kk); out[o + 1] = 255 - Math.min(255, mm + kk); out[o + 2] = 255 - Math.min(255, yy + kk); }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/** Quick sniff. */
export function isJpeg(bytes) { return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; }

export const idctFast = idct; // (tests)

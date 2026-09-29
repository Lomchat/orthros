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
  // 9-bit lookup of a whole coefficient: a code of length l whose symbol's l + size bits fit in the 9 bits, with the
  // size bits following it decoded as well: (value << 16) | (run << 4) | (l + size), 0 elsewhere. For AC codes of a
  // non-zero size (a value is never 0: the entry is non-zero); for DC codes, size 0 included (the entry is l).
  const fastAc = new Int32Array(512), fastDc = new Int32Array(512);
  code = 0; k = 0;
  for (let l = 1; l <= 9; l++) {
    for (let i = 0; i < counts[l - 1]; i++) {
      const rs = vals[k++], s = rs & 15, run = rs >> 4, shift = 9 - l;
      if (l + s <= 9) {
        for (let j = 0; j < 1 << shift; j++) {
          const extra = s ? (j >> (shift - s)) & ((1 << s) - 1) : 0, v = s && extra < 1 << (s - 1) ? extra - (1 << s) + 1 : extra;
          const idx = (code << shift) | j;
          if (s) fastAc[idx] = (v << 16) | (run << 4) | (l + s);
          if (rs < 16) fastDc[idx] = (v << 16) | (l + s); // (a DC symbol is a size alone)
        }
      }
      code++;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, vals, lookup, fastAc, fastDc };
}

/**
 * One block of a baseline (sequential) scan: DC difference and AC run/values into coef[off..] (zig-zag to natural
 * order), the component's DC predictor updated. The same decode as the generic path, most coefficients taken in one
 * lookup (fastDc / fastAc) instead of a Huffman lookup plus a read of the size bits.
 */
function decodeBlockBaseline(r, c, coef, off, dc, ac) {
  if (r.n < 16) r.fill();
  let e = dc.fastDc[(r.acc >>> (r.n - 9)) & 0x1ff], diff;
  if (e) { r.n -= e & 15; diff = e >> 16; }
  else { const t = r.decodeHuff(dc); diff = t === 0 ? 0 : r.receiveExtend(t); }
  c.pred += diff;
  coef[off] = c.pred;
  const fast = ac.fastAc;
  let k = 1;
  while (k < 64) {
    if (r.n < 16) r.fill();
    e = fast[(r.acc >>> (r.n - 9)) & 0x1ff];
    if (e) {
      r.n -= e & 15; k += (e >> 4) & 15;
      if (k > 63) break;
      coef[off + ZIGZAG[k]] = e >> 16; k++;
      continue;
    }
    const rs = r.decodeHuff(ac); const s = rs & 15, rr = rs >> 4;
    if (s === 0) { if (rr < 15) break; k += 16; continue; }
    // (a run past the block's end, corrupt data: its size bits are read all the same, as the fast lookup above and
    // libjpeg do, so that the next block starts at the same bit whichever path decoded this one)
    k += rr; const v = r.receiveExtend(s); if (k > 63) break;
    coef[off + ZIGZAG[k]] = v; k++;
  }
}

const ZIGZAG = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);

// Float IDCT (separable), accurate and simple: the reference (idctReference) the decoder's factored IDCT is tested against.
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const tmp = new Float32Array(64);

// Factored IDCT: the same separable transform as idctReference (each 1-D pass out[x] = 1/2 sum_u C(u) F(u)
// cos((2x+1)u pi/16)), computed with its symmetries instead of the 8x8 cosine matrix: out[x] and out[7-x] share the
// terms of every u, with the sign of the odd ones flipped, so a pass is an even half E0..E3 (F0/F4 through 1/sqrt2,
// F2/F6 through a rotation by pi/8: 4 products) and an odd half O0..O3 (the 4x4 matrix of cos(k pi/16) on F1,F3,F5,F7),
// out[x] = E(x) + O(x), out[7-x] = E(x) - O(x). 24 products per pass instead of 64, in double precision throughout
// (the reference keeps its intermediate rows in float32): the pixels equal the reference's except where a sum lands
// within rounding noise of a .5 (off by one there; tests bound it). The 1/2 of both passes is folded into the
// dequantization table (dequantTable), the level shift into the final rounding.
const R2 = Math.SQRT1_2, K1 = Math.cos(Math.PI / 16), K2 = Math.cos(2 * Math.PI / 16), K3 = Math.cos(3 * Math.PI / 16);
const K5 = Math.cos(5 * Math.PI / 16), K6 = Math.cos(6 * Math.PI / 16), K7 = Math.cos(7 * Math.PI / 16);
const ws = new Float64Array(64);
/** A quantization table as the IDCT's multipliers: q/4 (the two passes' 1/2), natural order. */
function dequantTable(qt) { const d = new Float64Array(64); for (let i = 0; i < 64; i++) d[i] = qt[i] / 4; return d; }
/** One 8-bit sample from a column-pass output (level shift, round half up, clamp; |0 only on the in-range value). */
const px = (s) => { const v = s + 128.5; return v <= 0 ? 0 : v >= 255 ? 255 : v | 0; };
/**
 * IDCT of the block at `co` in `coef` (natural order, not dequantized) with the multipliers `dq` (dequantTable),
 * 8x8 samples to out[outOff + y*stride + x]. Rows without AC terms (most of them) take a shortcut, and a block whose
 * only term is DC is filled flat.
 */
function idct(coef, co, dq, out, outOff, stride) {
  let rowsAny = 0; // (bit y: row y of the row-pass output is non-zero)
  for (let y = 0, r = co; y < 8; y++, r += 8) {
    const w = y * 8;
    const f1 = coef[r + 1], f2 = coef[r + 2], f3 = coef[r + 3], f4 = coef[r + 4], f5 = coef[r + 5], f6 = coef[r + 6], f7 = coef[r + 7];
    if ((f1 | f2 | f3 | f4 | f5 | f6 | f7) === 0) {
      const f0 = coef[r];
      if (f0 === 0) { if (rowsAny) ws[w] = ws[w + 1] = ws[w + 2] = ws[w + 3] = ws[w + 4] = ws[w + 5] = ws[w + 6] = ws[w + 7] = 0; continue; }
      const v = f0 * dq[w] * R2;
      if (rowsAny === 0 && y) ws.fill(0, 0, w); // (rows above were skipped without clearing)
      ws[w] = ws[w + 1] = ws[w + 2] = ws[w + 3] = ws[w + 4] = ws[w + 5] = ws[w + 6] = ws[w + 7] = v;
      rowsAny |= 1 << y;
      continue;
    }
    if (rowsAny === 0 && y) ws.fill(0, 0, w); // (rows above were skipped without clearing)
    rowsAny |= 1 << y;
    const v0 = coef[r] * dq[w], v4 = f4 * dq[w + 4], v2 = f2 * dq[w + 2], v6 = f6 * dq[w + 6];
    const v1 = f1 * dq[w + 1], v3 = f3 * dq[w + 3], v5 = f5 * dq[w + 5], v7 = f7 * dq[w + 7];
    const p = (v0 + v4) * R2, q = (v0 - v4) * R2, rr = v2 * K2 + v6 * K6, ss = v2 * K6 - v6 * K2;
    const e0 = p + rr, e3 = p - rr, e1 = q + ss, e2 = q - ss;
    const o0 = v1 * K1 + v3 * K3 + v5 * K5 + v7 * K7, o1 = v1 * K3 - v3 * K7 - v5 * K1 - v7 * K5;
    const o2 = v1 * K5 - v3 * K1 + v5 * K7 + v7 * K3, o3 = v1 * K7 - v3 * K5 + v5 * K3 - v7 * K1;
    ws[w] = e0 + o0; ws[w + 7] = e0 - o0; ws[w + 1] = e1 + o1; ws[w + 6] = e1 - o1;
    ws[w + 2] = e2 + o2; ws[w + 5] = e2 - o2; ws[w + 3] = e3 + o3; ws[w + 4] = e3 - o3;
  }
  if (rowsAny === 0) { const v = px(0); for (let y = 0, o = outOff; y < 8; y++, o += stride) out.fill(v, o, o + 8); return; }
  if (rowsAny === 1) { // (only row 0: every column is constant)
    if ((coef[co + 1] | coef[co + 2] | coef[co + 3] | coef[co + 4] | coef[co + 5] | coef[co + 6] | coef[co + 7]) === 0) {
      // flat (DC only): DC*q/8 exactly (R2*R2 is not exactly 1/2 in double: the frequent ties would round down)
      const v = px(coef[co] * dq[0] * 0.5);
      for (let y = 0, o = outOff; y < 8; y++, o += stride) out.fill(v, o, o + 8);
      return;
    }
    for (let x = 0; x < 8; x++) { const v = px(ws[x] * R2); for (let y = 0, o = outOff + x; y < 8; y++, o += stride) out[o] = v; }
    return;
  }
  if (rowsAny < 16) { // (rows 4-7 zero: half the column products)
    for (let x = 0; x < 8; x++) {
      const v0 = ws[x], v1 = ws[8 + x], v2 = ws[16 + x], v3 = ws[24 + x];
      const p = v0 * R2, rr = v2 * K2, ss = v2 * K6;
      const e0 = p + rr, e3 = p - rr, e1 = p + ss, e2 = p - ss;
      const o0 = v1 * K1 + v3 * K3, o1 = v1 * K3 - v3 * K7, o2 = v1 * K5 - v3 * K1, o3 = v1 * K7 - v3 * K5;
      const o = outOff + x;
      out[o] = px(e0 + o0); out[o + 7 * stride] = px(e0 - o0); out[o + stride] = px(e1 + o1); out[o + 6 * stride] = px(e1 - o1);
      out[o + 2 * stride] = px(e2 + o2); out[o + 5 * stride] = px(e2 - o2); out[o + 3 * stride] = px(e3 + o3); out[o + 4 * stride] = px(e3 - o3);
    }
    return;
  }
  for (let x = 0; x < 8; x++) {
    const v0 = ws[x], v1 = ws[8 + x], v2 = ws[16 + x], v3 = ws[24 + x], v4 = ws[32 + x], v5 = ws[40 + x], v6 = ws[48 + x], v7 = ws[56 + x];
    const p = (v0 + v4) * R2, q = (v0 - v4) * R2, rr = v2 * K2 + v6 * K6, ss = v2 * K6 - v6 * K2;
    const e0 = p + rr, e3 = p - rr, e1 = q + ss, e2 = q - ss;
    const o0 = v1 * K1 + v3 * K3 + v5 * K5 + v7 * K7, o1 = v1 * K3 - v3 * K7 - v5 * K1 - v7 * K5;
    const o2 = v1 * K5 - v3 * K1 + v5 * K7 + v7 * K3, o3 = v1 * K7 - v3 * K5 + v5 * K3 - v7 * K1;
    const o = outOff + x;
    out[o] = px(e0 + o0); out[o + 7 * stride] = px(e0 - o0); out[o + stride] = px(e1 + o1); out[o + 6 * stride] = px(e1 - o1);
    out[o + 2 * stride] = px(e2 + o2); out[o + 5 * stride] = px(e2 - o2); out[o + 3 * stride] = px(e3 + o3); out[o + 4 * stride] = px(e3 - o3);
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
    if (!progressive) { decodeBlockBaseline(r, c, coef, off, o.dcTabs[c.td], o.acTabs[c.ta]); return; }
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

// libjpeg-compatible YCbCr->RGB fixed point (constants rounded, 16 fractional bits)
const FIX = (x) => (x * 65536 + 0.5) | 0;
/**
 * One row of YCbCr samples to RGBA words (libjpeg's fixed-point conversion). A function of its own, called per row, so
 * that the engine optimizes it as a whole function rather than as an on-stack replacement of the caller's loop.
 */
function yccRow(out32, o, width, Y, yo, Cb, bo, Cr, ro) {
  const clamp = CLAMP; // (a local: a module binding is reloaded per use)
  for (let x = 0; x < width; x++) {
    // (the CR_R / CB_B / CB_G + CR_G table entries, computed: a multiply is cheaper than three more loads)
    const l = Y[yo + x] + CLAMP_OFF, cb = Cb[bo + x] - 128, cr = Cr[ro + x] - 128;
    out32[o + x] = 0xff000000 | clamp[l + ((FIX_B * cb + 32768) >> 16)] << 16 | clamp[l + ((32768 - FIX_GB * cb - FIX_GR * cr) >> 16)] << 8 | clamp[l + ((FIX_R * cr + 32768) >> 16)];
  }
}
const FIX_R = FIX(1.40200), FIX_B = FIX(1.77200), FIX_GB = FIX(0.34414), FIX_GR = FIX(0.71414);
/** Clamp to 0..255 by table: CLAMP[v + CLAMP_OFF] for v in -CLAMP_OFF..767 - CLAMP_OFF (Y plus any chroma term). */
const CLAMP_OFF = 256, CLAMP = new Uint8Array(768);
for (let i = 0; i < 768; i++) CLAMP[i] = Math.max(0, Math.min(255, i - CLAMP_OFF));

/**
 * One output row of the 2x2 triangle filter: the near input row r0 weighted 3, the far one r1 weighted 1, then the
 * same 3:1 horizontally between neighbouring column sums (edge columns replicated).
 */
function upsampleRow22(plane, r0, r1, dw, out, o) {
  let cur = plane[r0] * 3 + plane[r1], last = cur;
  for (let x = 0; x < dw; x++) {
    const next = x + 1 < dw ? plane[r0 + x + 1] * 3 + plane[r1 + x + 1] : cur;
    out[o + 2 * x] = (cur * 3 + last + 8) >> 4;
    out[o + 2 * x + 1] = (cur * 3 + next + 7) >> 4;
    last = cur; cur = next;
  }
}

/** Triangle-filter ("fancy") chroma upsampling by 2 horizontally and/or vertically, edge-replicating. */
function upsample(plane, pw, ph, dw, dh, fx, fy) {
  const ow = dw * fx, oh = dh * fy;
  const out = new Uint8Array(ow * oh); // (every filtered value is within 0..255: no clamping store needed)
  if (fx === 2 && fy === 2) {
    for (let oy = 0; oy < oh; oy++) {
      const iy = oy >> 1, far = Math.min(dh - 1, Math.max(0, (oy & 1) ? iy + 1 : iy - 1));
      upsampleRow22(plane, iy * pw, far * pw, dw, out, oy * ow);
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
    const plane = new Uint8Array(pw * ph);
    const dq = dequantTable(qts[c.tq]);
    for (let by = 0; by < c.bh; by++) for (let bx = 0; bx < c.bw; bx++) idct(c.coef, (by * c.bw + bx) * 64, dq, plane, by * 8 * pw + bx * 8, pw);
    const fx = hmax / c.h, fy = vmax / c.v;
    if (fx !== 1 || fy !== 1) {
      const dw = Math.ceil(width * c.h / hmax), dh = Math.ceil(height * c.v / vmax); // downsampled component size
      return upsample(plane, pw, ph, dw, dh, fx, fy);
    }
    return { plane, pw, ph };
  });
  const out = new Uint8Array(width * height * 4);
  const p0 = planes[0], p1 = planes[1], p2 = planes[2], p3 = planes[3];
  if (comps.length === 1 || comps.length === 3) { // (whole pixels as little-endian words: R, G, B, A=255)
    const out32 = new Int32Array(out.buffer), Y = p0.plane, yw = p0.pw;
    if (comps.length === 1) {
      for (let y = 0, o = 0; y < height; y++) for (let i = y * yw, e = i + width; i < e; i++) { const g = Y[i]; out32[o++] = 0xff000000 | g << 16 | g << 8 | g; }
    } else {
      const Cb = p1.plane, Cr = p2.plane, bw = p1.pw, rw = p2.pw;
      for (let y = 0; y < height; y++) yccRow(out32, y * width, width, Y, y * yw, Cb, y * bw, Cr, y * rw);
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // CMYK (Adobe inverted)
      const cc = p0.plane[y * p0.pw + x], mm = p1.plane[y * p1.pw + x], yy = p2.plane[y * p2.pw + x], kk = p3.plane[y * p3.pw + x];
      if (adobe) { out[o] = (cc * kk) / 255; out[o + 1] = (mm * kk) / 255; out[o + 2] = (yy * kk) / 255; }
      else { out[o] = 255 - Math.min(255, cc + kk); out[o + 1] = 255 - Math.min(255, mm + kk); out[o + 2] = 255 - Math.min(255, yy + kk); }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * The frame size from the headers alone (no entropy decoding): { width, height } of the first SOF0/1/2 frame (the ones
 * decodeJpeg reads), null when another kind of frame or none comes first.
 */
export function jpegSize(bytes) {
  let pos = 2;
  while (pos + 3 < bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const m = bytes[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (pos + 9 > bytes.length) return null;
      return { width: (bytes[pos + 7] << 8) | bytes[pos + 8], height: (bytes[pos + 5] << 8) | bytes[pos + 6] };
    }
    if ((m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)) return null; // (other SOFs: not decoded)
    pos += 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3]);
  }
  return null;
}

/** Quick sniff. */
export function isJpeg(bytes) { return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; }

/** The decoder's IDCT with idctReference's arguments (tests). */
export const idctFast = (coef, co, qt, out, outOff, stride) => idct(coef, co, dequantTable(qt), out, outOff, stride);

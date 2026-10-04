// MPEG-1 video decoder (ISO/IEC 11172-2), written from the standard: sequence / GOP / picture / slice / macroblock
// layers, I, P, B and D pictures, half-pel motion compensation, intra and non-intra quantizer matrices, the 8x8 inverse
// DCT in double precision (IEEE 1180 accuracy). Windows decodes these streams with the MPEG-1 decoder of its media
// framework (quartz.dll); src/win32/quartz.js plays them through this one.
//
// Use: push elementary-stream bytes with push(), end() at the end of the stream, then decode() returns the next picture
// in display order ({ y, cb, cr, width, height, stride, cstride, type }, planes valid until the next decode) or null
// when more data is needed (or the stream is over: `done`).
import { BitReader, Vlc } from './bits.js';

export const PICTURE_RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
export const ZIGZAG = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
export const DEFAULT_INTRA_MATRIX = new Uint8Array([
  8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40,
  22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83]);

const PIC_I = 1, PIC_P = 2, PIC_B = 3, PIC_D = 4;
const MB_QUANT = 0x10, MB_FWD = 0x08, MB_BWD = 0x04, MB_PATTERN = 0x02, MB_INTRA = 0x01;
const STUFFING = -2, ESCAPE = -3;

// ---- variable-length codes (ISO/IEC 11172-2 annex B)
export const MB_ADDR_CODES = [['1', 1], ['011', 2], ['010', 3], ['0011', 4], ['0010', 5], ['00011', 6], ['00010', 7], ['0000111', 8], ['0000110', 9],
  ['00001011', 10], ['00001010', 11], ['00001001', 12], ['00001000', 13], ['00000111', 14], ['00000110', 15], ['0000010111', 16], ['0000010110', 17],
  ['0000010101', 18], ['0000010100', 19], ['0000010011', 20], ['0000010010', 21], ['00000100011', 22], ['00000100010', 23], ['00000100001', 24],
  ['00000100000', 25], ['00000011111', 26], ['00000011110', 27], ['00000011101', 28], ['00000011100', 29], ['00000011011', 30], ['00000011010', 31],
  ['00000011001', 32], ['00000011000', 33], ['00000001111', STUFFING], ['00000001000', ESCAPE]];
export const MB_TYPE_CODES = {
  [PIC_I]: [['1', MB_INTRA], ['01', MB_QUANT | MB_INTRA]],
  [PIC_P]: [['1', MB_FWD | MB_PATTERN], ['01', MB_PATTERN], ['001', MB_FWD], ['00011', MB_INTRA], ['00010', MB_QUANT | MB_FWD | MB_PATTERN],
    ['00001', MB_QUANT | MB_PATTERN], ['000001', MB_QUANT | MB_INTRA]],
  [PIC_B]: [['10', MB_FWD | MB_BWD], ['11', MB_FWD | MB_BWD | MB_PATTERN], ['010', MB_BWD], ['011', MB_BWD | MB_PATTERN], ['0010', MB_FWD],
    ['0011', MB_FWD | MB_PATTERN], ['00011', MB_INTRA], ['00010', MB_QUANT | MB_FWD | MB_BWD | MB_PATTERN], ['000011', MB_QUANT | MB_FWD | MB_PATTERN],
    ['000010', MB_QUANT | MB_BWD | MB_PATTERN], ['000001', MB_QUANT | MB_INTRA]],
  [PIC_D]: [['1', MB_INTRA]],
};
export const CBP_CODES = [['111', 60], ['1101', 4], ['1100', 8], ['1011', 16], ['1010', 32], ['10011', 12], ['10010', 48], ['10001', 20], ['10000', 40],
  ['01111', 28], ['01110', 44], ['01101', 52], ['01100', 56], ['01011', 1], ['01010', 61], ['01001', 2], ['01000', 62], ['001111', 24], ['001110', 36],
  ['001101', 3], ['001100', 63], ['0010111', 5], ['0010110', 9], ['0010101', 17], ['0010100', 33], ['0010011', 6], ['0010010', 10], ['0010001', 18],
  ['0010000', 34], ['00011111', 7], ['00011110', 11], ['00011101', 19], ['00011100', 35], ['00011011', 13], ['00011010', 49], ['00011001', 21],
  ['00011000', 41], ['00010111', 14], ['00010110', 50], ['00010101', 22], ['00010100', 42], ['00010011', 15], ['00010010', 51], ['00010001', 23],
  ['00010000', 43], ['00001111', 25], ['00001110', 37], ['00001101', 26], ['00001100', 38], ['00001011', 29], ['00001010', 45], ['00001001', 53],
  ['00001000', 57], ['00000111', 30], ['00000110', 46], ['00000101', 54], ['00000100', 58], ['000000111', 31], ['000000110', 47], ['000000101', 55],
  ['000000100', 59], ['000000011', 27], ['000000010', 39], ['000000001', 0]];
/** motion_code magnitudes (the sign bit follows every non-zero code) */
export const MOTION_CODES = [['1', 0], ['01', 1], ['001', 2], ['0001', 3], ['000011', 4], ['0000101', 5], ['0000100', 6], ['0000011', 7], ['000001011', 8],
  ['000001010', 9], ['000001001', 10], ['0000010001', 11], ['0000010000', 12], ['0000001111', 13], ['0000001110', 14], ['0000001101', 15], ['0000001100', 16]];
export const DC_LUMA_CODES = [['100', 0], ['00', 1], ['01', 2], ['101', 3], ['110', 4], ['1110', 5], ['11110', 6], ['111110', 7], ['1111110', 8]];
export const DC_CHROMA_CODES = [['00', 0], ['01', 1], ['10', 2], ['110', 3], ['1110', 4], ['11110', 5], ['111110', 6], ['1111110', 7], ['11111110', 8]];
/** dct_coeff_next: [code without the sign bit, run, level]; '10' is end of block, '000001' the escape */
export const DCT_CODES = [['11', 0, 1], ['011', 1, 1], ['0100', 0, 2], ['0101', 2, 1], ['00101', 0, 3], ['00111', 3, 1], ['00110', 4, 1], ['000110', 1, 2],
  ['000111', 5, 1], ['000101', 6, 1], ['000100', 7, 1], ['0000110', 0, 4], ['0000100', 2, 2], ['0000111', 8, 1], ['0000101', 9, 1], ['00100110', 0, 5],
  ['00100001', 0, 6], ['00100101', 1, 3], ['00100100', 3, 2], ['00100111', 10, 1], ['00100011', 11, 1], ['00100010', 12, 1], ['00100000', 13, 1],
  ['0000001010', 0, 7], ['0000001100', 1, 4], ['0000001011', 2, 3], ['0000001111', 4, 2], ['0000001001', 5, 2], ['0000001110', 14, 1], ['0000001101', 15, 1],
  ['0000001000', 16, 1], ['000000011101', 0, 8], ['000000011000', 0, 9], ['000000010011', 0, 10], ['000000010000', 0, 11], ['000000011011', 1, 5],
  ['000000010100', 2, 4], ['000000011100', 3, 3], ['000000010010', 4, 3], ['000000011110', 6, 2], ['000000010101', 7, 2], ['000000010001', 8, 2],
  ['000000011111', 17, 1], ['000000011010', 18, 1], ['000000011001', 19, 1], ['000000010111', 20, 1], ['000000010110', 21, 1], ['0000000011010', 0, 12],
  ['0000000011001', 0, 13], ['0000000011000', 0, 14], ['0000000010111', 0, 15], ['0000000010110', 1, 6], ['0000000010101', 1, 7], ['0000000010100', 2, 5],
  ['0000000010011', 3, 4], ['0000000010010', 5, 3], ['0000000010001', 9, 2], ['0000000010000', 10, 2], ['0000000011111', 22, 1], ['0000000011110', 23, 1],
  ['0000000011101', 24, 1], ['0000000011100', 25, 1], ['0000000011011', 26, 1], ['00000000011111', 0, 16], ['00000000011110', 0, 17], ['00000000011101', 0, 18],
  ['00000000011100', 0, 19], ['00000000011011', 0, 20], ['00000000011010', 0, 21], ['00000000011001', 0, 22], ['00000000011000', 0, 23],
  ['00000000010111', 0, 24], ['00000000010110', 0, 25], ['00000000010101', 0, 26], ['00000000010100', 0, 27], ['00000000010011', 0, 28],
  ['00000000010010', 0, 29], ['00000000010001', 0, 30], ['00000000010000', 0, 31], ['000000000011000', 0, 32], ['000000000010111', 0, 33],
  ['000000000010110', 0, 34], ['000000000010101', 0, 35], ['000000000010100', 0, 36], ['000000000010011', 0, 37], ['000000000010010', 0, 38],
  ['000000000010001', 0, 39], ['000000000010000', 0, 40], ['000000000011111', 1, 8], ['000000000011110', 1, 9], ['000000000011101', 1, 10],
  ['000000000011100', 1, 11], ['000000000011011', 1, 12], ['000000000011010', 1, 13], ['000000000011001', 1, 14], ['0000000000010011', 1, 15],
  ['0000000000010010', 1, 16], ['0000000000010001', 1, 17], ['0000000000010000', 1, 18], ['0000000000010100', 6, 3], ['0000000000011010', 11, 2],
  ['0000000000011001', 12, 2], ['0000000000011000', 13, 2], ['0000000000010111', 14, 2], ['0000000000010110', 15, 2], ['0000000000010101', 16, 2],
  ['0000000000011111', 27, 1], ['0000000000011110', 28, 1], ['0000000000011101', 29, 1], ['0000000000011100', 30, 1], ['0000000000011011', 31, 1]];
const DCT_EOB = 0x10000, DCT_ESC = 0x20000;

let tables = null;
function vlcTables() {
  if (tables) return tables;
  const dct = new Vlc([['10', DCT_EOB], ['000001', DCT_ESC], ...DCT_CODES.map(([s, run, level]) => [s, (run << 8) | level])]);
  tables = {
    addr: new Vlc(MB_ADDR_CODES), cbp: new Vlc(CBP_CODES), motion: new Vlc(MOTION_CODES), dcLuma: new Vlc(DC_LUMA_CODES), dcChroma: new Vlc(DC_CHROMA_CODES), dct,
    type: { [PIC_I]: new Vlc(MB_TYPE_CODES[PIC_I]), [PIC_P]: new Vlc(MB_TYPE_CODES[PIC_P]), [PIC_B]: new Vlc(MB_TYPE_CODES[PIC_B]), [PIC_D]: new Vlc(MB_TYPE_CODES[PIC_D]) },
  };
  return tables;
}

// ---- inverse DCT: separable, in double precision; C[k][n] = c(k)/2 * cos((2n+1)k pi/16)
const IDCT = new Float64Array(64);
for (let k = 0; k < 8; k++) for (let n = 0; n < 8; n++) IDCT[k * 8 + n] = (k === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * n + 1) * k * Math.PI / 16);
const tmp = new Float64Array(64);
/** The definition, term by term (tests: the reference of idct8x8). */
export function idct8x8Reference(blk) {
  const out = new Float64Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) s += blk[v * 8 + u] * IDCT[u * 8 + x] * IDCT[v * 8 + y];
    out[y * 8 + x] = s;
  }
  for (let i = 0; i < 64; i++) blk[i] = Math.round(out[i]);
}
// 1-D 8-point inverse DCT by even / odd halves: x[n] = e[n] + o[n], x[7-n] = e[n] - o[n]; constants with the 1/2 scale
const C1 = Math.cos(Math.PI / 16) / 2, C2 = Math.cos(2 * Math.PI / 16) / 2, C3 = Math.cos(3 * Math.PI / 16) / 2, C4 = Math.cos(4 * Math.PI / 16) / 2;
const C5 = Math.cos(5 * Math.PI / 16) / 2, C6 = Math.cos(6 * Math.PI / 16) / 2, C7 = Math.cos(7 * Math.PI / 16) / 2;
function idct1d(s, o, st, d, od, dt) {
  const x0 = s[o], x1 = s[o + st], x2 = s[o + 2 * st], x3 = s[o + 3 * st], x4 = s[o + 4 * st], x5 = s[o + 5 * st], x6 = s[o + 6 * st], x7 = s[o + 7 * st];
  const a0 = (x0 + x4) * C4, a1 = (x0 - x4) * C4, b0 = x2 * C2 + x6 * C6, b1 = x2 * C6 - x6 * C2;
  const e0 = a0 + b0, e3 = a0 - b0, e1 = a1 + b1, e2 = a1 - b1;
  const o0 = x1 * C1 + x3 * C3 + x5 * C5 + x7 * C7;
  const o1 = x1 * C3 - x3 * C7 - x5 * C1 - x7 * C5;
  const o2 = x1 * C5 - x3 * C1 + x5 * C7 + x7 * C3;
  const o3 = x1 * C7 - x3 * C5 + x5 * C3 - x7 * C1;
  d[od] = e0 + o0; d[od + 7 * dt] = e0 - o0; d[od + dt] = e1 + o1; d[od + 6 * dt] = e1 - o1;
  d[od + 2 * dt] = e2 + o2; d[od + 5 * dt] = e2 - o2; d[od + 3 * dt] = e3 + o3; d[od + 4 * dt] = e3 - o3;
}
/**
 * In place: coefficients (natural order) -> spatial values rounded to the nearest integer (double precision: within
 * the IEEE 1180 accuracy bounds). Rows of zeros skip their pass; a block with only its DC term is a constant.
 */
export function idct8x8(blk) {
  let rows = 0;
  for (let v = 0; v < 8; v++) {
    const o = v * 8;
    if (blk[o] | blk[o + 1] | blk[o + 2] | blk[o + 3] | blk[o + 4] | blk[o + 5] | blk[o + 6] | blk[o + 7]) rows |= 1 << v;
  }
  if (rows === 0) return;
  if (rows === 1 && !(blk[1] | blk[2] | blk[3] | blk[4] | blk[5] | blk[6] | blk[7])) { blk.fill(Math.round(blk[0] / 8)); return; }
  for (let v = 0; v < 8; v++) { // along x, per row of vertical frequency v
    if (rows & (1 << v)) idct1d(blk, v * 8, 1, tmp, v * 8, 1);
    else for (let x = 0; x < 8; x++) tmp[v * 8 + x] = 0;
  }
  for (let x = 0; x < 8; x++) idct1d(tmp, x, 8, tmp, x, 8); // along y (in place per column: inputs read first)
  for (let i = 0; i < 64; i++) blk[i] = Math.round(tmp[i]);
}

class Frame {
  constructor(mbw, mbh) {
    this.stride = mbw * 16; this.cstride = mbw * 8;
    this.y = new Uint8Array(this.stride * mbh * 16);
    this.cb = new Uint8Array(this.cstride * mbh * 8); this.cr = new Uint8Array(this.cstride * mbh * 8);
    this.type = 0; this.temporalRef = 0;
  }
}

export class Mpeg1VideoDecoder {
  constructor() {
    this.buf = new Uint8Array(1 << 16); this.len = 0; this.pos = 0; this.eos = false; this.done = false;
    this.seq = null; // { width, height, rate, aspect, bitRate }
    this.intraMatrix = DEFAULT_INTRA_MATRIX.slice(); this.nonIntraMatrix = new Uint8Array(64).fill(16);
    this.ref0 = null; this.ref1 = null; this.bframe = null; this.spare = null;
    this.pending = null; // the newest reference picture, shown when the next one is decoded (display order)
    this.pictures = 0; this.errors = 0;
    this.blk = new Int32Array(64);
    this.skipB = false; // a caller behind schedule: B pictures (no other picture depends on them) are dropped undecoded
  }
  /** append elementary-stream bytes */
  push(bytes) {
    if (this.pos > 0 && this.pos >= this.len >> 1) { this.buf.copyWithin(0, this.pos, this.len); this.len -= this.pos; this.pos = 0; }
    if (this.len + bytes.length + 4 > this.buf.length) { let n = this.buf.length; while (n < this.len + bytes.length + 4) n *= 2; const b = new Uint8Array(n); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
    this.buf.set(bytes, this.len); this.len += bytes.length;
    this.buf.fill(0, this.len, this.len + 4); // (zero padding: the bit reader reads a word past the end)
  }
  /** no more bytes: the last picture can be decoded and the last reference shown */
  end() { this.eos = true; }
  /** index of the next start code at or after byte i (or -1) */
  findStart(i) {
    const b = this.buf, end = this.len;
    for (; i + 3 < end; i++) {
      if (b[i + 2] > 1) { i += 2; continue; }
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
    }
    return -1;
  }
  /** Decode until a picture is ready for display: the picture, or null (more data needed, or the end: `done`). */
  decode() {
    for (;;) {
      const s = this.findStart(this.pos);
      if (s < 0) {
        if (this.eos) return this.flush();
        if (this.len > 3) this.pos = this.len - 3; // (a start code may straddle the boundary)
        return null;
      }
      const code = this.buf[s + 3];
      if (code === 0xb3) { // sequence header: up to 12 + 128 bytes
        if (this.len - s < 140 && !this.eos) { this.pos = s; return null; }
        this.sequenceHeader(s + 4); this.pos = s + 4; continue;
      }
      if (code === 0x00) { // picture: all of it (up to the next picture, GOP, sequence header or end)
        let e = s + 4;
        for (;;) {
          e = this.findStart(e);
          if (e < 0) break;
          const c = this.buf[e + 3];
          if (c === 0x00 || c === 0xb3 || c === 0xb7 || c === 0xb8) break;
          e += 4;
        }
        if (e < 0) { if (!this.eos) { this.pos = s; return null; } e = this.len; }
        this.pos = e;
        if (!this.seq) continue; // (no sequence header yet: nothing to decode with)
        const out = this.picture(s + 4, e);
        if (out) return out;
        continue;
      }
      if (code === 0xb7) { this.pos = s + 4; const out = this.flushRef(); if (out) return out; continue; } // sequence end
      this.pos = s + 4; // GOP, user data, extensions, slices outside of a picture: skipped
    }
  }
  /** Parse the first sequence header in the bytes pushed so far (no picture decoded): true when found. */
  readSequenceHeader() {
    for (let s = this.findStart(0); s >= 0; s = this.findStart(s + 4)) if (this.buf[s + 3] === 0xb3) { this.sequenceHeader(s + 4); return !!this.seq; }
    return false;
  }
  flush() { const out = this.flushRef(); if (!out) this.done = true; return out; }
  flushRef() { const p = this.pending; this.pending = null; return p ? this.output(p) : null; }

  sequenceHeader(at) {
    const br = new BitReader(this.buf, at, this.len);
    const width = br.read(12), height = br.read(12), aspect = br.read(4), rateCode = br.read(4), bitRate = br.read(18);
    br.skip(1); br.skip(10); br.skip(1); // marker, vbv_buffer_size, constrained_parameters_flag
    if (br.read(1)) { for (let i = 0; i < 64; i++) this.intraMatrix[ZIGZAG[i]] = br.read(8); } else this.intraMatrix.set(DEFAULT_INTRA_MATRIX);
    if (br.read(1)) { for (let i = 0; i < 64; i++) this.nonIntraMatrix[ZIGZAG[i]] = br.read(8); } else this.nonIntraMatrix.fill(16);
    if (!width || !height) return;
    if (!this.seq || this.seq.width !== width || this.seq.height !== height) {
      this.mbw = (width + 15) >> 4; this.mbh = (height + 15) >> 4;
      this.ref0 = this.ref1 = this.pending = null;
      this.frames = [new Frame(this.mbw, this.mbh), new Frame(this.mbw, this.mbh), new Frame(this.mbw, this.mbh)];
      this.bframe = new Frame(this.mbw, this.mbh);
    }
    this.seq = { width, height, aspect, rate: PICTURE_RATES[rateCode] || 25, bitRate: bitRate * 400 };
  }

  output(f) { return { y: f.y, cb: f.cb, cr: f.cr, width: this.seq.width, height: this.seq.height, stride: f.stride, cstride: f.cstride, type: f.type }; }

  picture(start, end) {
    const br = new BitReader(this.buf, start, end);
    const temporalRef = br.read(10), type = br.read(3); br.skip(16);
    let fullFwd = 0, fwdCode = 0, fullBwd = 0, bwdCode = 0;
    if (type === PIC_P || type === PIC_B) { fullFwd = br.read(1); fwdCode = br.read(3); }
    if (type === PIC_B) { fullBwd = br.read(1); bwdCode = br.read(3); }
    if (type < PIC_I || type > PIC_D) { this.errors++; return null; }
    if (type === PIC_B && (!this.ref0 || !this.ref1)) return null; // (a B picture before two references: an open GOP's start, not shown)
    if (type === PIC_P && !this.ref1) return null;
    if (type === PIC_B && this.skipB) return { skipped: true, type }; // (counted: the display order's timing stays right)
    this.pictures++;
    let cur;
    if (type === PIC_B) cur = this.bframe;
    else cur = this.frames.find((f) => f !== this.ref1 && f !== this.ref0) ?? this.frames.find((f) => f !== this.ref1);
    cur.type = type; cur.temporalRef = temporalRef;
    this.pic = { type, fullFwd, fwdCode, fullBwd, bwdCode, cur, fwd: type === PIC_B ? this.ref0 : this.ref1, bwd: type === PIC_B ? this.ref1 : null };
    // slices
    br.pos = start * 8;
    for (;;) {
      const code = br.nextStartCode();
      if (code < 0) break;
      if (code >= 0x01 && code <= 0xaf) { try { this.slice(br, code); } catch (e) { this.errors++; } }
    }
    if (type === PIC_B) return this.output(cur);
    // a reference picture: the previous one is shown now (B pictures between them come after it in display order)
    this.ref0 = this.ref1; this.ref1 = cur;
    const prev = this.pending; this.pending = cur;
    return prev ? this.output(prev) : null;
  }

  slice(br, vpos) {
    const T = vlcTables(), pic = this.pic, mbw = this.mbw, mbh = this.mbh;
    let quant = br.read(5);
    while (br.read(1)) br.skip(8); // extra_information_slice
    let addr = (vpos - 1) * mbw - 1;
    const dc = [1024, 1024, 1024];
    let fx = 0, fy = 0, bx = 0, by = 0; // motion vector predictors (forward, backward)
    let lastFwd = false, lastBwd = false; // the previous macroblock's prediction (skipped B macroblocks repeat it)
    let mfx = 0, mfy = 0, mbx = 0, mby = 0; // the vectors in use (half-pel units)
    let first = true;
    const total = mbw * mbh;
    while (br.left > 0) {
      let inc = 0;
      for (;;) {
        const v = T.addr.read(br);
        if (v === STUFFING) continue;
        if (v === ESCAPE) { inc += 33; continue; }
        if (v < 0) throw new Error('bad macroblock address increment');
        inc += v; break;
      }
      if (!first && inc > 1) { // skipped macroblocks
        dc[0] = dc[1] = dc[2] = 1024;
        if (pic.type === PIC_P) { fx = fy = 0; mfx = mfy = 0; }
        for (let a = addr + 1; a < addr + inc && a < total; a++) {
          if (pic.type === PIC_P) this.predict(a, true, 0, 0, false, 0, 0);
          else this.predict(a, lastFwd, mfx, mfy, lastBwd, mbx, mby);
        }
      }
      first = false;
      addr += inc;
      if (addr >= total) throw new Error('macroblock address out of the picture');
      const type = T.type[pic.type].read(br);
      if (type < 0) throw new Error('bad macroblock type');
      if (type & MB_QUANT) quant = br.read(5);
      if (type & MB_INTRA) {
        fx = fy = bx = by = 0; lastFwd = lastBwd = false;
        for (let i = 0; i < 6; i++) this.block(br, addr, i, true, quant, dc);
      } else {
        dc[0] = dc[1] = dc[2] = 1024;
        if (type & MB_FWD) {
          fx = this.motion(br, pic.fwdCode, fx); fy = this.motion(br, pic.fwdCode, fy);
          mfx = pic.fullFwd ? fx << 1 : fx; mfy = pic.fullFwd ? fy << 1 : fy;
        } else if (pic.type === PIC_P) { fx = fy = 0; mfx = mfy = 0; }
        if (type & MB_BWD) {
          bx = this.motion(br, pic.bwdCode, bx); by = this.motion(br, pic.bwdCode, by);
          mbx = pic.fullBwd ? bx << 1 : bx; mby = pic.fullBwd ? by << 1 : by;
        }
        const useFwd = pic.type === PIC_P || (type & MB_FWD) !== 0, useBwd = (type & MB_BWD) !== 0;
        this.predict(addr, useFwd, mfx, mfy, useBwd, mbx, mby);
        lastFwd = useFwd; lastBwd = useBwd;
        const cbp = type & MB_PATTERN ? T.cbp.read(br) : 0;
        if (cbp < 0) throw new Error('bad coded block pattern');
        for (let i = 0; i < 6; i++) if (cbp & (32 >> i)) this.block(br, addr, i, false, quant, dc);
      }
      if (pic.type === PIC_D) br.skip(1);
      if (br.peek(23) === 0) break; // (a start code, or the zero padding after the stream: the end of the slice)
    }
  }

  motion(br, fcode, pred) {
    const code = vlcTables().motion.read(br);
    if (code < 0) throw new Error('bad motion code');
    let d = code;
    if (code !== 0) {
      const neg = br.read(1);
      const rsize = fcode - 1;
      if (rsize > 0) d = ((code - 1) << rsize) + br.read(rsize) + 1;
      if (neg) d = -d;
    }
    const f = 1 << (fcode - 1);
    let v = pred + d;
    if (v > (f << 4) - 1) v -= f << 5; else if (v < -(f << 4)) v += f << 5;
    return v;
  }

  /** the prediction of macroblock `addr` (forward, backward or their average) written into the current picture */
  predict(addr, useFwd, fx, fy, useBwd, bx, by) {
    const pic = this.pic, cur = pic.cur, mbw = this.mbw;
    const mx = addr % mbw, my = (addr / mbw) | 0;
    const f = useFwd ? pic.fwd : null, b = useBwd ? pic.bwd : null;
    if (!f && !b) return;
    const yo = my * 16 * cur.stride + mx * 16, co = my * 8 * cur.cstride + mx * 8;
    const H = this.mbh * 16;
    copyBlock(cur.y, yo, cur.stride, f, b, 'y', mx * 16, my * 16, 16, fx, fy, bx, by, cur.stride, H);
    // chroma vectors: half the luma ones, truncated toward zero
    const cfx = (fx / 2) | 0, cfy = (fy / 2) | 0, cbx = (bx / 2) | 0, cby = (by / 2) | 0;
    copyBlock(cur.cb, co, cur.cstride, f, b, 'cb', mx * 8, my * 8, 8, cfx, cfy, cbx, cby, cur.cstride, H >> 1);
    copyBlock(cur.cr, co, cur.cstride, f, b, 'cr', mx * 8, my * 8, 8, cfx, cfy, cbx, cby, cur.cstride, H >> 1);
  }

  block(br, addr, i, intra, quant, dc) {
    const T = vlcTables(), blk = this.blk;
    blk.fill(0);
    let n;
    if (intra) {
      const size = (i < 4 ? T.dcLuma : T.dcChroma).read(br);
      if (size < 0) throw new Error('bad dc size');
      let diff = 0;
      if (size) { diff = br.read(size); if (!(diff & (1 << (size - 1)))) diff = diff - (1 << size) + 1; }
      const p = i < 4 ? 0 : i - 3;
      dc[p] += diff * 8; // (the predictors kept in units of the reconstructed DC: dc * 8)
      blk[0] = dc[p];
      n = 0;
    } else n = -1;
    const matrix = intra ? this.intraMatrix : this.nonIntraMatrix;
    let firstCoef = !intra;
    for (;;) {
      let run, level;
      if (firstCoef && br.peek(1) === 1) { br.skip(1); run = 0; level = br.read(1) ? -1 : 1; }
      else {
        const v = T.dct.read(br);
        if (v === DCT_EOB) break;
        if (v === DCT_ESC) {
          run = br.read(6); level = br.read(8);
          if (level === 0) level = br.read(8); else if (level === 128) level = br.read(8) - 256; else if (level > 128) level -= 256;
        } else if (v < 0) throw new Error('bad dct coefficient');
        else { run = v >> 8; level = v & 0xff; if (br.read(1)) level = -level; }
      }
      firstCoef = false;
      n += run + 1;
      if (n > 63) throw new Error('dct coefficient index past 63');
      const pos = ZIGZAG[n];
      let c = intra ? ((level * 2 * quant * matrix[pos]) / 16) | 0 : (((level * 2 + Math.sign(level)) * quant * matrix[pos]) / 16) | 0;
      if ((c & 1) === 0 && c !== 0) c -= Math.sign(c);
      blk[pos] = c > 2047 ? 2047 : c < -2048 ? -2048 : c;
    }
    idct8x8(blk);
    const cur = this.pic.cur, mbw = this.mbw, mx = addr % mbw, my = (addr / mbw) | 0;
    let plane, stride, o;
    if (i < 4) { plane = cur.y; stride = cur.stride; o = (my * 16 + (i >> 1) * 8) * stride + mx * 16 + (i & 1) * 8; }
    else { plane = i === 4 ? cur.cb : cur.cr; stride = cur.cstride; o = my * 8 * stride + mx * 8; }
    for (let y = 0; y < 8; y++, o += stride) {
      for (let x = 0; x < 8; x++) {
        let v = blk[y * 8 + x];
        if (v > 255) v = 255; else if (v < -256) v = -256;
        if (!intra) v += plane[o + x];
        plane[o + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

/** a block's reference samples gathered with the picture edges extended (a vector pointing out of the picture) */
const edge = new Uint8Array(17 * 17), predB = new Uint8Array(256);
/**
 * out[oo + r * ostride + c] = the size x size block of `ref` at (x + vx/2, y + vy/2), vx / vy in half pels (averages of
 * 2 or 4 samples, rounded up, for the half positions).
 */
function fetch(out, oo, ostride, ref, stride, H, x, y, size, vx, vy) {
  const ix = x + (vx >> 1), iy = y + (vy >> 1), hx = vx & 1, hy = vy & 1;
  let src = ref, ss = stride, so = iy * stride + ix;
  if (ix < 0 || iy < 0 || ix + size + hx > stride || iy + size + hy > H) {
    for (let r = 0; r <= size; r++) {
      const yy = iy + r < 0 ? 0 : iy + r >= H ? H - 1 : iy + r;
      for (let c = 0; c <= size; c++) { const xx = ix + c < 0 ? 0 : ix + c >= stride ? stride - 1 : ix + c; edge[r * 17 + c] = ref[yy * stride + xx]; }
    }
    src = edge; ss = 17; so = 0;
  }
  if (hx && hy) {
    for (let r = 0; r < size; r++, so += ss, oo += ostride) for (let c = 0; c < size; c++) out[oo + c] = (src[so + c] + src[so + c + 1] + src[so + ss + c] + src[so + ss + c + 1] + 2) >> 2;
  } else if (hx) {
    for (let r = 0; r < size; r++, so += ss, oo += ostride) for (let c = 0; c < size; c++) out[oo + c] = (src[so + c] + src[so + c + 1] + 1) >> 1;
  } else if (hy) {
    for (let r = 0; r < size; r++, so += ss, oo += ostride) for (let c = 0; c < size; c++) out[oo + c] = (src[so + c] + src[so + ss + c] + 1) >> 1;
  } else {
    for (let r = 0; r < size; r++, so += ss, oo += ostride) for (let c = 0; c < size; c++) out[oo + c] = src[so + c];
  }
}
function copyBlock(dst, o, dstride, f, b, plane, x, y, size, fx, fy, bx, by, stride, H) {
  if (f && b) {
    fetch(dst, o, dstride, f[plane], stride, H, x, y, size, fx, fy);
    fetch(predB, 0, 16, b[plane], stride, H, x, y, size, bx, by);
    for (let r = 0, k = 0; r < size; r++, o += dstride, k += 16) for (let c = 0; c < size; c++) dst[o + c] = (dst[o + c] + predB[k + c] + 1) >> 1;
  } else if (f) fetch(dst, o, dstride, f[plane], stride, H, x, y, size, fx, fy);
  else fetch(dst, o, dstride, b[plane], stride, H, x, y, size, bx, by);
}

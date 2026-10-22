// Lossless PCM transport codec (docs/slow-network.md "Audio units"): a range of a game file whose bytes are, wholly or
// in part, uncompressed PCM sound (8-bit unsigned or 16-bit signed little-endian, mono or stereo), coded by linear
// prediction and Rice codes of the residuals — what brotli cannot see in sampled sound (it finds repeated strings, a
// waveform has almost none: sounds at 0.88-0.95 of their bytes) —, byte-exact. The server makes such units in the
// background beside its brotli ones (src/host/br-cache.js, src/host/pcm-units.js) and sends one to a request that says
// it decodes them; the shared reader decodes it (HttpBackend.decodeUnit, src/vfs/http-backend.js) before any byte
// reaches the game. Written from scratch for Orthros.
//
// Container (little-endian): 'OPC1', u32 decoded length, u32 CRC-32 of the decoded bytes, u16 segment count, then per
// segment u8 kind (0 bytes as they are, 1 PCM), u8 bits (8 | 16), u8 channels (1 | 2), u8 log2 of its frame (PCM; 0),
// u32 decoded length; then
// each segment's payload: the bytes themselves, or u32 coded length + the coded samples. A PCM segment's length is a
// whole number of sample frames.
//
// Coded samples (bits read most significant first): frames of the segment's sample frames (the last one shorter); a stereo
// frame starts with 2 bits — 0 left/right, 1 left/side, 2 side/right, 3 mid/side (side = left − right, mid = (left +
// right) >> 1) —; then one subframe per channel, its samples `w` bits wide (the segment's bits, one more for the side):
// 6 bits of type — 0-4 fixed polynomial predictor of that order, 5 verbatim, 6 constant, 8 + n − 1 linear predictor of
// order n (1-32) —; constant: one w-bit value; verbatim: every sample in w bits; a predictor: its first `order` samples
// in w bits, for a linear one 4 bits (coefficients' precision − 1), 5 bits (shift) and its coefficients (signed, that
// precision), then the residuals: 4 bits of partition order p (2^p partitions, the first one `order` samples shorter),
// per partition 5 bits of Rice parameter k — or 31: 5 bits of width then each residual in that width — and its
// residuals zigzagged (0, −1, 1, −2 … → 0, 1, 2, 3 …), each as q = u >> k zeros, a one, and u's k low bits.
// A prediction is floor(Σ cᵢ·xₙ₋ᵢ / 2^shift), the sum exact (below 2^53: doubles).

import { crc32 } from '../core/crc32.js';

export const PCM_MAGIC = 0x3143504f; // 'OPC1'
/** sample frames per frame (by default: a segment says its own, as the log2 of it, 64-65536) */
export const FRAME = 2048;
const MAX_LPC = 12;
const T_VERBATIM = 5, T_CONSTANT = 6, T_LPC = 8;

// ------------------------------------------------------------------------------------------------ bits
class BitWriter {
  constructor(n = 1 << 16) { this.buf = new Uint8Array(n); this.len = 0; this.acc = 0; this.nacc = 0; }
  grow(n) { if (this.len + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n + 1024)); b.set(this.buf.subarray(0, this.len)); this.buf = b; } }
  /** the n low bits of v (n ≤ 24) */
  put(v, n) {
    if (n === 0) return;
    this.acc = (this.acc << n) | (v & ((1 << n) - 1)); this.nacc += n;
    if (this.nacc >= 8) {
      this.grow(4);
      while (this.nacc >= 8) { this.nacc -= 8; this.buf[this.len++] = (this.acc >>> this.nacc) & 0xff; }
      this.acc &= (1 << this.nacc) - 1;
    }
  }
  /** n bits of v, n ≤ 32 */
  putLong(v, n) { if (n > 24) { this.put(Math.floor(v / 0x10000) & 0xffff, n - 16); this.put(v & 0xffff, 16); } else this.put(v, n); }
  zeros(q) { while (q >= 24) { this.put(0, 24); q -= 24; } this.put(0, q); }
  /** the bytes, the last one padded with zero bits */
  end() { if (this.nacc) { this.grow(1); this.buf[this.len++] = (this.acc << (8 - this.nacc)) & 0xff; this.acc = 0; this.nacc = 0; } return this.buf.subarray(0, this.len); }
}

class BitReader {
  /** b: padded with 8 zero bytes past `end` */
  constructor(b, end) { this.b = b; this.pos = 0; this.end = end * 8; }
  /** the 32 bits from pos */
  peek() {
    const b = this.b, i = this.pos >>> 3, s = this.pos & 7;
    const hi = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    return s ? ((hi << s) | (b[i + 4] >>> (8 - s))) >>> 0 : hi >>> 0;
  }
  /** n bits unsigned (1 ≤ n ≤ 32) */
  bits(n) { const v = this.peek() >>> (32 - n); this.pos += n; if (this.pos > this.end) throw new Error('pcm: coded samples cut short'); return n === 32 ? v >>> 0 : v; }
  /** n bits two's complement (1 ≤ n ≤ 32) */
  signed(n) { const v = this.peek(); this.pos += n; if (this.pos > this.end) throw new Error('pcm: coded samples cut short'); return (v | 0) >> (32 - n); }
}

const zig = (r) => (r >= 0 ? 2 * r : -2 * r - 1);

// ------------------------------------------------------------------------------------------------ prediction
/** residuals of fixed predictor `order` over x[order, n) into r (r[i] for sample i) */
function fixedResidual(x, n, order, r) {
  switch (order) {
    case 0: for (let i = 0; i < n; i++) r[i] = x[i]; break;
    case 1: for (let i = 1; i < n; i++) r[i] = x[i] - x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) r[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) r[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
    case 4: for (let i = 4; i < n; i++) r[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
  }
}
function fixedRestore(x, n, order, r) {
  switch (order) {
    case 0: for (let i = 0; i < n; i++) x[i] = r[i]; break;
    case 1: for (let i = 1; i < n; i++) x[i] = r[i] + x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) x[i] = r[i] + 2 * x[i - 1] - x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) x[i] = r[i] + 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break;
    case 4: for (let i = 4; i < n; i++) x[i] = r[i] + 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]; break;
  }
}
function lpcResidual(x, n, c, order, shift, r) {
  const k = 2 ** -shift;
  for (let i = order; i < n; i++) {
    let s = 0;
    for (let j = 0; j < order; j++) s += c[j] * x[i - 1 - j];
    r[i] = x[i] - Math.floor(s * k);
  }
}
function lpcRestore(x, n, c, order, shift, r) {
  const k = 2 ** -shift;
  if (order === 12) { // (the encoder's usual order: unrolled)
    const c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3], c4 = c[4], c5 = c[5], c6 = c[6], c7 = c[7], c8 = c[8], c9 = c[9], c10 = c[10], c11 = c[11];
    for (let i = 12; i < n; i++) {
      const s = c0 * x[i - 1] + c1 * x[i - 2] + c2 * x[i - 3] + c3 * x[i - 4] + c4 * x[i - 5] + c5 * x[i - 6] + c6 * x[i - 7] + c7 * x[i - 8] + c8 * x[i - 9] + c9 * x[i - 10] + c10 * x[i - 11] + c11 * x[i - 12];
      x[i] = r[i] + Math.floor(s * k);
    }
    return;
  }
  for (let i = order; i < n; i++) {
    let s = 0;
    for (let j = 0; j < order; j++) s += c[j] * x[i - 1 - j];
    x[i] = r[i] + Math.floor(s * k);
  }
}

/** linear prediction coefficients of orders 1..maxOrder (Levinson-Durbin over a Welch-windowed autocorrelation): lpc[o-1] */
function lpcCoefs(x, n, maxOrder) {
  const w = new Float64Array(n), h = (n - 1) / 2;
  for (let i = 0; i < n; i++) { const t = (i - h) / (h + 1); w[i] = x[i] * (1 - t * t); }
  const R = new Float64Array(maxOrder + 1);
  for (let l = 0; l <= maxOrder; l++) { let s = 0; for (let i = l; i < n; i++) s += w[i] * w[i - l]; R[l] = s; }
  if (!(R[0] > 0)) return null;
  R[0] *= 1 + 1e-9; // (a little white noise: a stable recursion on pure tones)
  const out = [], a = new Float64Array(maxOrder + 1), tmp = new Float64Array(maxOrder + 1);
  let err = R[0];
  for (let o = 1; o <= maxOrder; o++) {
    let acc = R[o];
    for (let j = 1; j < o; j++) acc -= a[j] * R[o - j];
    const k = acc / err;
    tmp.set(a);
    a[o] = k;
    for (let j = 1; j < o; j++) a[j] = tmp[j] - k * tmp[o - j];
    err *= 1 - k * k;
    out.push(Array.from(a.subarray(1, o + 1)));
    if (!(err > 0)) break;
  }
  return out;
}
/** coefficients quantized to `precision` bits: { c: Int32 array, shift } or null */
function quantize(a, precision) {
  let max = 0; for (const v of a) max = Math.max(max, Math.abs(v));
  if (!(max > 0)) return null;
  const lim = 2 ** (precision - 1) - 1;
  let shift = precision - 1 - Math.ceil(Math.log2(max + 1e-12));
  shift = Math.max(0, Math.min(31, shift));
  while (shift > 0 && Math.round(max * 2 ** shift) > lim) shift--;
  const c = new Int32Array(a.length);
  let e = 0;
  for (let i = 0; i < a.length; i++) { // (the rounding error carried: FLAC's way)
    const v = a[i] * 2 ** shift + e, q = Math.max(-lim - 1, Math.min(lim, Math.round(v)));
    e = v - q; c[i] = q;
  }
  return { c, shift };
}

// ------------------------------------------------------------------------------------------------ residual coding
const PARTITION_MAX = 6;
/** bits of the best Rice coding of r[from, to) and its parameter (31: escape) */
function riceBest(r, from, to) {
  const n = to - from; if (n <= 0) return { bits: 5, k: 0 };
  let sum = 0, maxU = 0;
  for (let i = from; i < to; i++) { const u = zig(r[i]); sum += u; if (u > maxU) maxU = u; }
  const mean = sum / n;
  let k0 = mean > 1 ? Math.floor(Math.log2(mean)) : 0, best = null;
  for (let k = Math.max(0, k0 - 1); k <= Math.min(30, k0 + 1); k++) {
    let bits = 5 + n * (k + 1);
    const d = 2 ** k;
    for (let i = from; i < to; i++) bits += Math.floor(zig(r[i]) / d);
    if (!best || bits < best.bits) best = { bits, k };
  }
  const width = maxU ? 32 - Math.clz32(maxU) + 1 : 1; // (two's complement of the residual: one bit more than |r|)
  const esc = 10 + n * Math.min(32, width);
  return esc < best.bits ? { bits: esc, k: 31, width: Math.min(32, width) } : best;
}
/** the best partitioning of residuals r[order, n): { bits, p, parts: [{ k, width }] } */
function residualPlan(r, n, order) {
  let best = null;
  for (let p = 0; p <= PARTITION_MAX; p++) {
    if (n % (1 << p) || (n >> p) <= order) break;
    const size = n >> p, parts = [];
    let bits = 4;
    for (let i = 0; i < 1 << p; i++) {
      const from = i === 0 ? order : i * size, b = riceBest(r, from, (i + 1) * size);
      bits += b.bits; parts.push(b);
    }
    if (!best || bits < best.bits) best = { bits, p, parts };
  }
  return best;
}
function writeResidual(bw, r, n, order, plan) {
  bw.put(plan.p, 4);
  const size = n >> plan.p;
  for (let i = 0; i < 1 << plan.p; i++) {
    const { k, width } = plan.parts[i], from = i === 0 ? order : i * size, to = (i + 1) * size;
    bw.put(k, 5);
    if (k === 31) { bw.put(width - 1, 5); for (let j = from; j < to; j++) bw.putLong(r[j] >>> 0, width); continue; }
    const d = 2 ** k;
    for (let j = from; j < to; j++) {
      const u = zig(r[j]), q = Math.floor(u / d);
      bw.zeros(q); bw.put(1, 1);
      if (k) bw.putLong(u - q * d, k);
    }
  }
}
function readResidual(br, r, n, order) {
  const p = br.bits(4), size = n >> p;
  if (n % (1 << p) || size < order) throw new Error('pcm: bad partition');
  for (let i = 0; i < 1 << p; i++) {
    const from = i === 0 ? order : i * size, to = (i + 1) * size, k = br.bits(5);
    if (k === 31) { const w = br.bits(5) + 1; for (let j = from; j < to; j++) r[j] = br.signed(w); continue; }
    // (the hot loop: the reader's state in locals, its 32-bit window read inline)
    const b = br.b, end = br.end, ks = 32 - k;
    let pos = br.pos;
    for (let j = from; j < to; j++) {
      let q = 0, w;
      for (;;) {
        const i = pos >>> 3, s = pos & 7;
        w = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
        if (s) w = (w << s) | (b[i + 4] >>> (8 - s));
        if (w !== 0) break;
        q += 32; pos += 32;
        if (pos > end) throw new Error('pcm: coded samples cut short');
      }
      const z = Math.clz32(w); q += z; pos += z + 1;
      // (u below 2^31 in a valid stream: the encoder escapes larger residuals; a corrupt one fails the CRC)
      let u = q;
      if (k) {
        const i = pos >>> 3, s = pos & 7;
        let v = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
        if (s) v = (v << s) | (b[i + 4] >>> (8 - s));
        u = (q << k) | (v >>> ks); pos += k;
      }
      r[j] = (u >>> 1) ^ -(u & 1);
    }
    if (pos > end) throw new Error('pcm: coded samples cut short');
    br.pos = pos;
  }
}

// ------------------------------------------------------------------------------------------------ subframes
/** the cheapest coding of x[0, n) at width w: { bits, write(bw) } */
function planSubframe(x, n, w, r) {
  let constant = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { bits: 6 + w, write: (bw) => { bw.put(T_CONSTANT, 6); bw.putLong(x[0] >>> 0, w); } };
  let best = { bits: 6 + n * w, write: (bw) => { bw.put(T_VERBATIM, 6); for (let i = 0; i < n; i++) bw.putLong(x[i] >>> 0, w); } };
  // fixed predictors: the one with the smallest residual magnitude, then coded exactly
  let fo = 0, fs = Infinity;
  for (let o = 0; o <= 4 && o < n; o++) {
    fixedResidual(x, n, o, r);
    let s = 0; for (let i = o; i < n; i++) s += Math.abs(r[i]);
    s /= Math.max(1, n - o);
    if (s < fs) { fs = s; fo = o; }
  }
  {
    const o = fo;
    fixedResidual(x, n, o, r);
    const plan = residualPlan(r, n, o);
    if (plan) {
      const bits = 6 + o * w + plan.bits;
      if (bits < best.bits) { const rr = r.slice(0, n); best = { bits, write: (bw) => { bw.put(o, 6); for (let i = 0; i < o; i++) bw.putLong(x[i] >>> 0, w); writeResidual(bw, rr, n, o, plan); } }; }
    }
  }
  // linear predictors
  if (n > 32) {
    const sets = lpcCoefs(x, n, Math.min(MAX_LPC, n >> 3));
    const precision = w <= 9 ? 12 : 14;
    if (sets) for (const o of [2, 4, 8, 12]) {
      if (o > sets.length) break;
      const q = quantize(sets[o - 1], precision); if (!q) continue;
      lpcResidual(x, n, q.c, o, q.shift, r);
      let ok = true; for (let i = o; i < n; i++) if (Math.abs(r[i]) >= 2 ** 30) { ok = false; break; }
      if (!ok) continue;
      const plan = residualPlan(r, n, o); if (!plan) continue;
      const bits = 6 + o * w + 9 + o * precision + plan.bits;
      if (bits < best.bits) {
        const rr = r.slice(0, n), { c, shift } = q;
        best = { bits, write: (bw) => { bw.put(T_LPC + o - 1, 6); for (let i = 0; i < o; i++) bw.putLong(x[i] >>> 0, w); bw.put(precision - 1, 4); bw.put(shift, 5); for (let i = 0; i < o; i++) bw.putLong(c[i] >>> 0, precision); writeResidual(bw, rr, n, o, plan); } };
      }
    }
  }
  return best;
}
function readSubframe(br, x, n, w, r) {
  const t = br.bits(6);
  if (t === T_CONSTANT) { const v = br.signed(w); for (let i = 0; i < n; i++) x[i] = v; return; }
  if (t === T_VERBATIM) { for (let i = 0; i < n; i++) x[i] = br.signed(w); return; }
  if (t <= 4) {
    if (t > n) throw new Error('pcm: bad order');
    for (let i = 0; i < t; i++) x[i] = br.signed(w);
    readResidual(br, r, n, t); fixedRestore(x, n, t, r); return;
  }
  if (t < T_LPC) throw new Error('pcm: bad subframe');
  const o = t - T_LPC + 1; if (o > n) throw new Error('pcm: bad order');
  for (let i = 0; i < o; i++) x[i] = br.signed(w);
  const precision = br.bits(4) + 1, shift = br.bits(5), c = new Float64Array(o);
  for (let i = 0; i < o; i++) c[i] = br.signed(precision);
  readResidual(br, r, n, o); lpcRestore(x, n, c, o, shift, r);
}

// ------------------------------------------------------------------------------------------------ segments
/** the samples of PCM bytes b[at, at + len): one Float64Array per channel (8-bit unsigned centred on 0) */
function samplesOf(b, at, len, bits, ch) {
  const bps = bits >> 3, frames = Math.floor(len / (bps * ch)), out = [];
  for (let c = 0; c < ch; c++) out.push(new Float64Array(frames));
  for (let f = 0, p = at; f < frames; f++) for (let c = 0; c < ch; c++, p += bps) out[c][f] = bits === 8 ? b[p] - 128 : (b[p] | (b[p + 1] << 8)) << 16 >> 16;
  return out;
}

/** PCM bytes coded (see the header) */
function encodeSamples(b, at, len, bits, ch, FRAME) {
  const chans = samplesOf(b, at, len, bits, ch), frames = chans[0].length, bw = new BitWriter(len + 64);
  const r = new Float64Array(FRAME), xs = [new Float64Array(FRAME), new Float64Array(FRAME), new Float64Array(FRAME), new Float64Array(FRAME)];
  for (let f0 = 0; f0 < frames; f0 += FRAME) {
    const n = Math.min(FRAME, frames - f0);
    if (ch === 1) { xs[0].set(chans[0].subarray(f0, f0 + n)); planSubframe(xs[0], n, bits, r).write(bw); continue; }
    const L = chans[0].subarray(f0, f0 + n), R = chans[1].subarray(f0, f0 + n);
    const [l, rr, s, m] = xs;
    for (let i = 0; i < n; i++) { l[i] = L[i]; rr[i] = R[i]; s[i] = L[i] - R[i]; m[i] = Math.floor((L[i] + R[i]) / 2); }
    const pl = planSubframe(l, n, bits, r), pr = planSubframe(rr, n, bits, r), ps = planSubframe(s, n, bits + 1, r), pm = planSubframe(m, n, bits, r);
    const modes = [[pl, pr], [pl, ps], [ps, pr], [pm, ps]];
    let bi = 0; for (let i = 1; i < 4; i++) if (modes[i][0].bits + modes[i][1].bits < modes[bi][0].bits + modes[bi][1].bits) bi = i;
    bw.put(bi, 2); modes[bi][0].write(bw); modes[bi][1].write(bw);
  }
  return bw.end();
}
function decodeSamples(coded, out, at, len, bits, ch, FRAME) {
  const pad = new Uint8Array(coded.length + 8); pad.set(coded);
  const br = new BitReader(pad, coded.length), bps = bits >> 3, frames = len / (bps * ch);
  const r = new Float64Array(FRAME), a = new Float64Array(FRAME), b2 = new Float64Array(FRAME);
  for (let f0 = 0; f0 < frames; f0 += FRAME) {
    const n = Math.min(FRAME, frames - f0);
    let L = a, R = b2;
    if (ch === 1) readSubframe(br, a, n, bits, r);
    else {
      const mode = br.bits(2);
      readSubframe(br, a, n, mode === 2 ? bits + 1 : bits, r);
      readSubframe(br, b2, n, mode === 0 ? bits : mode === 2 ? bits : bits + 1, r);
      if (mode === 1) for (let i = 0; i < n; i++) b2[i] = a[i] - b2[i]; // left, side → left, right
      else if (mode === 2) for (let i = 0; i < n; i++) a[i] = a[i] + b2[i]; // side, right → left, right
      else if (mode === 3) for (let i = 0; i < n; i++) { const s = b2[i], mm = a[i] * 2 + (s & 1); a[i] = (mm + s) / 2; b2[i] = (mm - s) / 2; }
      L = a; R = b2;
    }
    let p = at + f0 * bps * ch;
    if (ch === 1 && bits === 16) for (let i = 0; i < n; i++, p += 2) { const v = L[i]; out[p] = v; out[p + 1] = v >> 8; }
    else if (ch === 1) for (let i = 0; i < n; i++) out[p++] = L[i] + 128;
    else if (bits === 16) for (let i = 0; i < n; i++, p += 4) { const v = L[i], w = R[i]; out[p] = v; out[p + 1] = v >> 8; out[p + 2] = w; out[p + 3] = w >> 8; }
    else for (let i = 0; i < n; i++, p += 2) { out[p] = L[i] + 128; out[p + 1] = R[i] + 128; }
  }
}

/**
 * Bytes b coded: `regions` [{ at, len, bits: 8 | 16, ch: 1 | 2 }] the PCM parts (sorted, not overlapping, inside b);
 * the rest goes as it is. Returns the container.
 */
export function encodePcm(b, regions, { frame: fl = FRAME } = {}) {
  const segs = [], payloads = [];
  let pos = 0;
  const raw = (to) => { if (to > pos) { segs.push([0, 0, 0, to - pos, 0]); payloads.push(b.subarray(pos, to)); pos = to; } };
  for (const g of regions) {
    const frame = (g.bits >> 3) * g.ch, at = Math.max(g.at, pos), len = Math.floor((Math.min(b.length, g.at + g.len) - at) / frame) * frame;
    if (len < frame * 64 || (at - g.at) % frame) continue; // (too short to gain anything, or cut inside a frame)
    raw(at);
    const coded = encodeSamples(b, at, len, g.bits, g.ch, fl);
    if (coded.length + 4 >= len) { raw(at + len); continue; } // (not predictable: as it is)
    segs.push([1, g.bits, g.ch, len, 31 - Math.clz32(fl)]);
    const p = new Uint8Array(4 + coded.length); new DataView(p.buffer).setUint32(0, coded.length, true); p.set(coded, 4);
    payloads.push(p); pos = at + len;
  }
  raw(b.length);
  const head = 14 + segs.length * 8, total = head + payloads.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, PCM_MAGIC, true); dv.setUint32(4, b.length, true); dv.setUint32(8, crc32(b), true); dv.setUint16(12, segs.length, true);
  segs.forEach(([kind, bits, ch, len, lf], i) => { out[14 + i * 8] = kind; out[15 + i * 8] = bits; out[16 + i * 8] = ch; out[17 + i * 8] = lf; dv.setUint32(18 + i * 8, len, true); });
  let o = head; for (const p of payloads) { out.set(p, o); o += p.length; }
  return out;
}

/** how many of the container's decoded bytes are coded samples (0: none — not worth sending as such) */
export function pcmCodedBytes(c) {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength), n = dv.getUint16(12, true);
  let s = 0; for (let i = 0; i < n; i++) if (c[14 + i * 8] === 1) s += dv.getUint32(18 + i * 8, true);
  return s;
}

/** the bytes of a container (throws on anything not one, or not whole, or whose bytes do not match their CRC) */
export function decodePcm(c) {
  if (c.length < 14) throw new Error('pcm: not a container');
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  if (dv.getUint32(0, true) !== PCM_MAGIC) throw new Error('pcm: not a container');
  const size = dv.getUint32(4, true), crc = dv.getUint32(8, true), n = dv.getUint16(12, true);
  let o = 14 + n * 8, at = 0;
  if (o > c.length) throw new Error('pcm: cut short');
  const out = new Uint8Array(size);
  for (let i = 0; i < n; i++) {
    const kind = c[14 + i * 8], bits = c[15 + i * 8], ch = c[16 + i * 8], lf = c[17 + i * 8], len = dv.getUint32(18 + i * 8, true);
    if (at + len > size) throw new Error('pcm: segments past the end');
    if (kind === 0) { if (o + len > c.length) throw new Error('pcm: cut short'); out.set(c.subarray(o, o + len), at); o += len; }
    else if (kind === 1) {
      if ((bits !== 8 && bits !== 16) || (ch !== 1 && ch !== 2) || len % ((bits >> 3) * ch) || lf < 6 || lf > 16) throw new Error('pcm: bad segment');
      if (o + 4 > c.length) throw new Error('pcm: cut short');
      const cl = dv.getUint32(o, true); o += 4;
      if (o + cl > c.length) throw new Error('pcm: cut short');
      decodeSamples(c.subarray(o, o + cl), out, at, len, bits, ch, 1 << lf); o += cl;
    } else throw new Error('pcm: bad segment');
    at += len;
  }
  if (at !== size || o !== c.length) throw new Error('pcm: bad length');
  if (crc32(out) !== crc) throw new Error('pcm: CRC mismatch');
  return out;
}

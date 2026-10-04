// MPEG-1 / MPEG-2 (low sampling frequencies) audio decoder, layers I and II (ISO/IEC 11172-3, 13818-3), written from
// the standard: frame headers, bit allocation, scale factors (with their selection information), grouped and ungrouped
// samples, requantization, joint stereo (intensity) and the polyphase synthesis filterbank. Layer III is not decoded
// here (decode() reports it unsupported). Output: 32-bit float samples, one array per channel.
import { BitReader } from './bits.js';
import { mpegAudioHeader } from './mpeg-ps.js';
import { SYNTH_WINDOW_HALF } from './mpeg-audio-window.js';

// ---- layer II bit allocation tables (11172-3 annex B.2, 13818-3 annex B.1): per subband, the bits of the allocation
// index and the quantization of each index (number of steps; 0 = none)
const Q_A = [0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535];
const Q_B = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535];
const Q_C = [0, 3, 5, 7, 9, 15, 31, 65535];
const Q_D = [0, 3, 5, 65535];
const Q_E = [0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767];
const Q_F = [0, 3, 5, 9, 15, 31, 63, 127];
// MPEG-2 low sampling frequencies (13818-3 table B.1)
const Q_L1 = [0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383];
const Q_L2 = [0, 3, 5, 9, 15, 31, 63, 127];
const Q_L3 = [0, 3, 5, 9];
const rep = (n, nbal, q) => Array.from({ length: n }, () => ({ nbal, q }));
export const ALLOC_TABLES = {
  a: [...rep(3, 4, Q_A), ...rep(8, 4, Q_B), ...rep(12, 3, Q_C), ...rep(4, 2, Q_D)], // 27 subbands
  b: [...rep(3, 4, Q_A), ...rep(8, 4, Q_B), ...rep(12, 3, Q_C), ...rep(7, 2, Q_D)], // 30
  c: [...rep(2, 4, Q_E), ...rep(6, 3, Q_F)], // 8
  d: [...rep(2, 4, Q_E), ...rep(10, 3, Q_F)], // 12
  lsf: [...rep(4, 4, Q_L1), ...rep(7, 3, Q_L2), ...rep(19, 2, Q_L3)], // 30
};
/** the layer II allocation table of a frame (by sampling frequency and bit rate per channel) */
export function allocTable(h) {
  if (h.version !== 1) return ALLOC_TABLES.lsf;
  const perChannel = h.bitrate / 1000 / (h.mode === 3 ? 1 : 2);
  if (perChannel <= 48) return h.rate === 32000 ? ALLOC_TABLES.d : ALLOC_TABLES.c;
  if (perChannel <= 80) return ALLOC_TABLES.a;
  return h.rate === 48000 ? ALLOC_TABLES.a : ALLOC_TABLES.b;
}
/** steps -> [bits per sample (or per group of 3), grouped] */
const QUANT = new Map([[3, [5, true]], [5, [7, true]], [9, [10, true]]]);
for (let b = 3; b <= 16; b++) QUANT.set((1 << b) - 1, [b, false]);
/** scale factors: 2 * 2^(-i/3) */
export const SCALE = Float64Array.from({ length: 64 }, (_, i) => (i < 63 ? 2 * Math.pow(2, -i / 3) : 0));

// ---- polyphase synthesis: N[i][k] = cos((16 + i)(2k + 1) pi / 64); the 512-sample window D from its first half
const NMAT = new Float64Array(64 * 32);
for (let i = 0; i < 64; i++) for (let k = 0; k < 32; k++) NMAT[i * 32 + k] = Math.cos((16 + i) * (2 * k + 1) * Math.PI / 64);
/** D[0..511] (11172-3 table B.3): D[512 - i] = -D[i], except D[512 - i] = D[i] for i a multiple of 64 */
export const SYNTH_WINDOW = (() => {
  const d = new Float64Array(512);
  for (let i = 0; i <= 256; i++) d[i] = SYNTH_WINDOW_HALF[i] / 65536;
  for (let i = 257; i < 512; i++) d[i] = (i % 64 === 0 ? 1 : -1) * d[512 - i];
  return d;
})();

/** Synthesis state of one channel: the V vector history (1024) as a ring. */
export class Synth {
  constructor() { this.v = new Float64Array(1024); this.off = 0; }
  /** 32 subband samples -> 32 PCM samples written to out[o..o+31] */
  run(s, out, o, D = SYNTH_WINDOW) {
    this.off = (this.off - 64) & 1023;
    const v = this.v, off = this.off;
    for (let i = 0; i < 64; i++) {
      let acc = 0; const r = i * 32;
      for (let k = 0; k < 32; k++) acc += NMAT[r + k] * s[k];
      v[(off + i) & 1023] = acc;
    }
    // U[i*64 + j] = V[i*128 + j], U[i*64 + 32 + j] = V[i*128 + 96 + j]; out[j] = sum_i U[j + 32 i] * D[j + 32 i]
    for (let j = 0; j < 32; j++) {
      let acc = 0;
      for (let i = 0; i < 16; i++) {
        const vi = (i >> 1) * 128 + (i & 1 ? 96 : 0) + j;
        acc += v[(off + vi) & 1023] * D[j + 32 * i];
      }
      out[o + j] = acc;
    }
  }
  /** the 16 window inputs U[j + 32 i] of output sample j after the last run (tools/mpa-window-fit.mjs) */
  inputs(j, out) { for (let i = 0; i < 16; i++) out[i] = this.v[(this.off + (i >> 1) * 128 + (i & 1 ? 96 : 0) + j) & 1023]; }
}

export class MpegAudioDecoder {
  constructor() {
    this.synth = [new Synth(), new Synth()];
    this.sb = [new Float64Array(32), new Float64Array(32)];
    this.pcm = new Float64Array(32);
    this.header = null; this.errors = 0; this.unsupported = null;
  }
  /**
   * Decode one frame (bytes from its header; at least header.bytes long): { channels, rate, samples: Float32Array[] }
   * or null (not a layer I / II frame, or corrupt).
   */
  decodeFrame(b, at = 0) {
    const h = mpegAudioHeader(b, at);
    if (!h || !h.bytes) return null;
    if (h.layer === 3) { this.unsupported = 'layer III'; return null; }
    this.header = h;
    const br = new BitReader(b, at, at + h.bytes);
    br.skip(32);
    if (h.crc) br.skip(16);
    const nch = h.channels, out = [new Float32Array(h.samples), nch > 1 ? new Float32Array(h.samples) : null].slice(0, nch);
    try { if (h.layer === 1) this.layer1(br, h, out); else this.layer2(br, h, out); } catch { this.errors++; return null; }
    return { channels: nch, rate: h.rate, samples: out };
  }

  layer1(br, h, out) {
    const nch = h.channels, bound = h.mode === 1 ? (h.modeExt + 1) * 4 : 32;
    const alloc = [new Uint8Array(32), new Uint8Array(32)], scf = [new Float64Array(32), new Float64Array(32)];
    for (let sb = 0; sb < 32; sb++) for (let ch = 0; ch < nch; ch++) {
      if (sb >= bound && ch === 1) { alloc[1][sb] = alloc[0][sb]; continue; }
      const a = br.read(4); if (a === 15) throw new Error('bad allocation'); alloc[ch][sb] = a;
    }
    for (let sb = 0; sb < 32; sb++) for (let ch = 0; ch < nch; ch++) if (alloc[ch][sb]) scf[ch][sb] = SCALE[br.read(6)];
    const codes = new Int32Array(32);
    for (let s = 0; s < 12; s++) {
      for (let sb = 0; sb < 32; sb++) for (let ch = 0; ch < nch; ch++) {
        const a = alloc[ch][sb];
        if (!a) { this.sb[ch][sb] = 0; continue; }
        const nb = a + 1, steps = (1 << nb) - 1;
        if (!(sb >= bound && ch === 1)) codes[sb] = br.read(nb);
        this.sb[ch][sb] = (2 * codes[sb] - (steps - 1)) / steps * scf[ch][sb];
      }
      for (let ch = 0; ch < nch; ch++) this.emit(ch, out[ch], s * 32);
    }
  }

  layer2(br, h, out) {
    const nch = h.channels, table = allocTable(h), sblimit = table.length;
    const bound = h.mode === 1 ? Math.min((h.modeExt + 1) * 4, sblimit) : sblimit;
    const alloc = [new Int32Array(32), new Int32Array(32)];
    for (let sb = 0; sb < sblimit; sb++) {
      const nbal = table[sb].nbal;
      if (sb < bound) for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = table[sb].q[br.read(nbal)];
      else { const q = table[sb].q[br.read(nbal)]; alloc[0][sb] = q; alloc[1][sb] = q; }
    }
    const scfsi = [new Uint8Array(32), new Uint8Array(32)];
    for (let sb = 0; sb < sblimit; sb++) for (let ch = 0; ch < nch; ch++) if (alloc[ch][sb]) scfsi[ch][sb] = br.read(2);
    const scf = [new Float64Array(96), new Float64Array(96)]; // [part * 32 + sb]
    for (let sb = 0; sb < sblimit; sb++) for (let ch = 0; ch < nch; ch++) {
      if (!alloc[ch][sb]) continue;
      let a, b, c;
      switch (scfsi[ch][sb]) {
        case 0: a = br.read(6); b = br.read(6); c = br.read(6); break;
        case 1: a = b = br.read(6); c = br.read(6); break;
        case 2: a = b = c = br.read(6); break;
        default: a = br.read(6); b = c = br.read(6); break;
      }
      scf[ch][sb] = SCALE[a]; scf[ch][32 + sb] = SCALE[b]; scf[ch][64 + sb] = SCALE[c];
    }
    const samp = [new Float64Array(96), new Float64Array(96)]; // [3 samples][32 subbands] of the granule, per channel
    const codes = new Int32Array(3);
    for (let gr = 0; gr < 12; gr++) {
      const part = (gr >> 2) * 32;
      for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
          const steps = alloc[ch][sb];
          if (!steps) { samp[ch][sb] = samp[ch][32 + sb] = samp[ch][64 + sb] = 0; continue; }
          if (!(sb >= bound && ch === 1)) {
            const [bits, grouped] = QUANT.get(steps);
            if (grouped) { let c = br.read(bits); for (let k = 0; k < 3; k++) { codes[k] = c % steps; c = (c / steps) | 0; } }
            else for (let k = 0; k < 3; k++) codes[k] = br.read(bits);
          }
          const f = scf[ch][part + sb];
          for (let k = 0; k < 3; k++) samp[ch][k * 32 + sb] = (2 * codes[k] - (steps - 1)) / steps * f;
        }
      }
      for (let ch = 0; ch < nch; ch++) {
        for (let sb = sblimit; sb < 32; sb++) samp[ch][sb] = samp[ch][32 + sb] = samp[ch][64 + sb] = 0;
        for (let k = 0; k < 3; k++) { this.sb[ch].set(samp[ch].subarray(k * 32, k * 32 + 32)); this.emit(ch, out[ch], (gr * 3 + k) * 32); }
      }
    }
  }

  emit(ch, out, o) {
    this.synth[ch].run(this.sb[ch], this.pcm, 0);
    for (let j = 0; j < 32; j++) out[o + j] = this.pcm[j];
  }
}

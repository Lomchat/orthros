// RIFF WAVE files for the DirectShow path (a game playing music or speech with IGraphBuilder::RenderFile): PCM
// (8 / 16 / 24 / 32-bit integers, 32 / 64-bit floats, WAVE_FORMAT_EXTENSIBLE), IMA ADPCM and Microsoft ADPCM — the formats
// Windows decodes with its built-in codecs. Same playing interface as MpegSource (audio only).
import { MediaError } from './mpeg-source.js';

const TAG_PCM = 1, TAG_MSADPCM = 2, TAG_FLOAT = 3, TAG_IMAADPCM = 0x11, TAG_EXTENSIBLE = 0xfffe;
const CHUNK = 256 * 1024;

export const IMA_STEPS = new Int32Array([7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
  29794, 32767]);
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_COEFS = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];

/** A RIFF WAVE file's first bytes? */
export const isWave = (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;

const u16 = (b, i) => b[i] | (b[i + 1] << 8), s16 = (b, i) => (u16(b, i) << 16) >> 16, u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** IMA ADPCM block (one per channel interleaved by 4 bytes) -> float samples per channel; `n` samples per channel */
export function decodeImaBlock(b, at, len, ch, n, out) {
  const pred = [], idx = [];
  for (let c = 0; c < ch; c++) { pred[c] = s16(b, at + 4 * c); idx[c] = Math.min(88, b[at + 4 * c + 2]); out[c][0] = pred[c] / 32768; }
  let p = at + 4 * ch, s = 1;
  while (s < n && p < at + len) {
    for (let c = 0; c < ch; c++) { // 8 samples per channel from 4 bytes
      for (let k = 0; k < 8; k++) {
        const nib = (b[p + 4 * c + (k >> 1)] >> ((k & 1) * 4)) & 15, step = IMA_STEPS[idx[c]];
        let d = step >> 3; if (nib & 1) d += step >> 2; if (nib & 2) d += step >> 1; if (nib & 4) d += step;
        let v = pred[c] + (nib & 8 ? -d : d); v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        pred[c] = v; idx[c] = Math.max(0, Math.min(88, idx[c] + IMA_INDEX[nib & 7]));
        if (s + k < n) out[c][s + k] = v / 32768;
      }
    }
    p += 4 * ch; s += 8;
  }
  return Math.min(n, s);
}
/** Microsoft ADPCM block -> float samples per channel */
export function decodeMsBlock(b, at, len, ch, n, out, coefs = MS_COEFS) {
  const pi = [], delta = [], s1 = [], s2 = [];
  let p = at;
  for (let c = 0; c < ch; c++) pi[c] = Math.min(b[p++], coefs.length - 1);
  for (let c = 0; c < ch; c++) { delta[c] = s16(b, p); p += 2; }
  for (let c = 0; c < ch; c++) { s1[c] = s16(b, p); p += 2; }
  for (let c = 0; c < ch; c++) { s2[c] = s16(b, p); p += 2; }
  for (let c = 0; c < ch; c++) { out[c][0] = s2[c] / 32768; if (n > 1) out[c][1] = s1[c] / 32768; }
  let s = 2, c = 0, hi = true;
  while (s < n && p < at + len) {
    const nib = hi ? b[p] >> 4 : b[p] & 15; if (!hi) p++; hi = !hi;
    const signed = nib & 8 ? nib - 16 : nib, [k1, k2] = coefs[pi[c]];
    let v = ((s1[c] * k1 + s2[c] * k2) >> 8) + signed * delta[c];
    v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    s2[c] = s1[c]; s1[c] = v;
    delta[c] = Math.max(16, (MS_ADAPT[nib] * delta[c]) >> 8);
    out[c][s] = v / 32768;
    if (++c === ch) { c = 0; s++; }
  }
  return Math.min(n, s);
}

/**
 * The format and the data chunk of a WAVE file: { fmt: { tag, channels, rate, align, bits, extra }, dataStart, dataSize }
 * (the header may be longer than the first bytes read: more are read then). Throws MediaError.
 */
export function parseWave(file, head) {
  const size = file.size();
  let b = head, i = 12, fmt = null, dataStart, dataSize;
  for (;;) {
    if (i + 8 > b.length) { if (b.length >= size) break; b = file.read(0, Math.min(size, i + 65536)); continue; }
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]), n = u32(b, i + 4);
    if (id === 'fmt ') {
      if (i + 8 + n > b.length) { if (b.length >= size) break; b = file.read(0, Math.min(size, i + 8 + n)); continue; }
      fmt = { tag: u16(b, i + 8), channels: u16(b, i + 10), rate: u32(b, i + 12), align: u16(b, i + 20), bits: u16(b, i + 22), extra: b.slice(i + 24, i + 8 + n) };
      if (fmt.tag === TAG_EXTENSIBLE && n >= 40) fmt.tag = u16(b, i + 32); // (the sub-format GUID's first word)
    } else if (id === 'data') { dataStart = i + 8; dataSize = Math.min(n, size - i - 8); break; }
    i += 8 + n + (n & 1);
  }
  if (!fmt || dataStart === undefined) throw new MediaError('corrupt', 'WAVE file without fmt / data');
  if (!fmt.channels || !fmt.rate || !fmt.align) throw new MediaError('corrupt', 'WAVE format');
  return { fmt, dataStart, dataSize };
}
/** WAVE format tags of MPEG audio (layers I / II, layer III): the data chunk is an MPEG audio stream */
export const isMpegWaveTag = (tag) => tag === 0x50 || tag === 0x55;
/** a part of a file seen as a file (offsets from `start`) */
export function subFile(file, start, size) {
  return { size: () => size, read: (o, n) => file.read(start + o, Math.max(0, Math.min(n, size - o))), prepare: file.prepare ? (o, n) => file.prepare(start + o, Math.max(0, Math.min(n, size - o))) : undefined, close: () => file.close?.() };
}

/** Samples of a WAVE format (WAVEFORMATEX fields: tag, channels, rate, align, bits, extra), by whole blocks. */
export class WaveDecoder {
  constructor(fmt) {
    const pcm = fmt.tag === TAG_PCM && [8, 16, 24, 32].includes(fmt.bits), flt = fmt.tag === TAG_FLOAT && (fmt.bits === 32 || fmt.bits === 64);
    if (!pcm && !flt && fmt.tag !== TAG_IMAADPCM && fmt.tag !== TAG_MSADPCM) throw new MediaError('unsupported', `WAVE format tag 0x${fmt.tag.toString(16)}`);
    if (!fmt.channels || !fmt.align) throw new MediaError('corrupt', 'WAVE format');
    this.fmt = fmt;
    if (fmt.tag === TAG_IMAADPCM) this.blockSamples = (fmt.align - 4 * fmt.channels) * 8 / (4 * fmt.channels) + 1;
    else if (fmt.tag === TAG_MSADPCM) {
      this.blockSamples = fmt.extra.length >= 4 ? u16(fmt.extra, 2) : (fmt.align - 7 * fmt.channels) * 2 / fmt.channels + 2;
      const nc = fmt.extra.length >= 6 ? u16(fmt.extra, 4) : 0;
      this.coefs = nc ? Array.from({ length: nc }, (_, k) => [s16(fmt.extra, 6 + 4 * k), s16(fmt.extra, 8 + 4 * k)]) : MS_COEFS;
    } else this.blockSamples = 1;
  }
  /** n blocks -> float samples per channel */
  decode(b, n) {
    const f = this.fmt, ch = f.channels, count = n * this.blockSamples;
    const out = Array.from({ length: ch }, () => new Float32Array(count));
    if (f.tag === TAG_IMAADPCM || f.tag === TAG_MSADPCM) {
      const view = Array.from({ length: ch });
      for (let k = 0; k < n; k++) {
        for (let c = 0; c < ch; c++) view[c] = out[c].subarray(k * this.blockSamples);
        if (f.tag === TAG_IMAADPCM) decodeImaBlock(b, k * f.align, f.align, ch, this.blockSamples, view);
        else decodeMsBlock(b, k * f.align, f.align, ch, this.blockSamples, view, this.coefs);
      }
      return out;
    }
    const bps = f.align / ch, dv = new DataView(b.buffer, b.byteOffset, b.length);
    for (let s = 0; s < n; s++) for (let c = 0; c < ch; c++) {
      const o = s * f.align + c * bps;
      let v;
      if (f.tag === TAG_FLOAT) v = bps === 8 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bps === 1) v = (b[o] - 128) / 128;
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) v = ((b[o] | b[o + 1] << 8 | b[o + 2] << 16) << 8 >> 8) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      out[c][s] = v;
    }
    return out;
  }
}

export class WavSource {
  constructor(file, head, opts = {}) {
    this.file = file; this.log = opts.log ?? (() => {});
    this.size = file.size();
    this.kind = 'wav'; this.video = null; this.audio = true; this.width = 0; this.height = 0; this.fps = 0;
    this.audioStart = 0; this.videoStart = 0; this.audioLayer = 0;
    const { fmt, dataStart, dataSize } = parseWave(file, head);
    this.dataStart = dataStart; this.dataSize = dataSize;
    this.dec = new WaveDecoder(fmt);
    this.fmt = fmt; this.blockSamples = this.dec.blockSamples;
    this.audioRate = fmt.rate; this.audioChannels = fmt.channels;
    const blocks = Math.floor(this.dataSize / fmt.align);
    this.duration = blocks * this.blockSamples / fmt.rate;
    this.reset();
  }
  reset() {
    this.readPos = 0; // bytes of the data chunk decoded
    this.audioPos = 0; this.audioDone = false; this.videoDone = true; this.frameIndex = 0; this.picture = null; this.eof = false;
    this.loading = null; this.loadError = null; this.failed = false;
    this.stats = { decoded: 0, skipped: 0, overtaken: 0, late: 0, decodeMs: 0 };
  }
  load() { return false; } // (read as decoded: audioUntil)
  pictureAt() { return null; }
  get videoEnd() { return 0; }
  get audioEnd() { return this.audioDone ? this.audioPos / this.audioRate : Infinity; }
  ended(t) { return this.audioDone && t >= this.audioEnd || this.failed; }
  frameTime() { return Infinity; }
  /** decode up to stream time t: out(samplesPerChannel[], startTime) per piece (waits for data on the network: later) */
  audioUntil(t, out) {
    const f = this.fmt, align = f.align;
    while (!this.audioDone && this.audioPos / f.rate < t) {
      const left = this.dataSize - this.readPos;
      if (left < align) { this.audioDone = true; return; }
      const len = Math.min(left - left % align, CHUNK - CHUNK % align);
      const off = this.dataStart + this.readPos;
      if (this.loading) return;
      const p = this.file.prepare?.(off, len);
      if (p) { this.loading = p; p.then(() => { this.loading = null; }, (e) => { this.loading = null; this.loadError = e; this.audioDone = true; }); return; }
      const b = this.file.read(off, len);
      if (b.length < align) { this.audioDone = true; return; }
      const n = Math.floor(b.length / align);
      const samples = this.decode(b, n);
      out(samples, this.audioPos / f.rate);
      this.audioPos += samples[0].length; this.readPos += n * align;
    }
  }
  decode(b, n) { return this.dec.decode(b, n); }
  close() { this.file.close?.(); }
}

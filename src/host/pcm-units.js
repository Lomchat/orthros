// Which bytes of a game file are PCM sound, for the PCM transport units (src/vfs/pcm-codec.js, made by
// src/host/br-cache-worker.js beside the brotli ones; docs/slow-network.md "Audio units"). By format only, every game
// the same, no file name looked at:
// - RIFF WAVE sounds anywhere in a file — a .wav, or one stored as it is inside an archive (EA's .big, a .pak, …) —:
//   the data chunk of each whose format chunk says integer PCM (tag 1, or WAVE_FORMAT_EXTENSIBLE with the PCM
//   subtype), 8 or 16 bits, mono or stereo (`scanWaves`, once per file version: the generator keeps the answer beside
//   the file's units);
// - a range of a file with no such sound (a raw sample bank without headers): tried as 16-bit mono, 16-bit stereo and
//   8-bit mono (`trialLayouts`) — a coding that is lossless whatever the bytes are, kept only when it beats the range's
//   brotli unit (the proof that the bytes are sampled sound is the coding's size).
import fs from 'node:fs';

const SCAN_CHUNK = 4 << 20;
/** the share of a unit that must be sound for its audio form to be tried (less cannot save the 5 % asked of it) */
export const PCM_SHARE_MIN = 0.15;
const PCM_GUID_TAIL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);

/**
 * The PCM sample regions of the RIFF WAVE sound whose header starts at `h` (its first bytes, at file offset `at`), in a
 * file of `size` bytes: { start, end, bits, ch, next } (next: where the sound ends), or null (not one, or not PCM).
 */
export function parseWave(h, at, size) {
  if (h.length < 12 || h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') return null;
  const riffEnd = Math.min(size, at + 8 + h.readUInt32LE(4));
  let o = 12, fmt = null;
  while (o + 8 <= h.length && at + o + 8 <= riffEnd) {
    const id = h.toString('latin1', o, o + 4), n = h.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 8 + 16 <= h.length) {
      let tag = h.readUInt16LE(o + 8);
      const ch = h.readUInt16LE(o + 10), align = h.readUInt16LE(o + 20), bits = h.readUInt16LE(o + 22);
      if (tag === 0xfffe && n >= 40 && o + 8 + 40 <= h.length && h.subarray(o + 8 + 26, o + 8 + 40).equals(PCM_GUID_TAIL)) tag = h.readUInt16LE(o + 8 + 24);
      fmt = tag === 1 && (bits === 8 || bits === 16) && (ch === 1 || ch === 2) && align === (bits >> 3) * ch ? { bits, ch } : false;
    } else if (id === 'data') {
      if (!fmt) return null;
      const start = at + o + 8, frame = (fmt.bits >> 3) * fmt.ch;
      const end = start + Math.floor((Math.min(riffEnd, start + n) - start) / frame) * frame;
      return end > start ? { start, end, bits: fmt.bits, ch: fmt.ch, next: Math.max(end, riffEnd) } : null;
    }
    o += 8 + n + (n & 1);
  }
  return null;
}

/** Every PCM region of the RIFF WAVE sounds in file `file` ([{ start, end, bits, ch }], in file order): reads it whole. */
export function scanWaves(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, buf = Buffer.alloc(SCAN_CHUNK + 3), head = Buffer.alloc(4096), out = [];
    let at = 0, keep = 0; // (keep: the last 3 bytes of the previous chunk, a 'RIFF' across the boundary)
    while (at < size) {
      const n = fs.readSync(fd, buf, keep, Math.min(SCAN_CHUNK, size - at), at);
      if (n <= 0) break;
      const base = at - keep, len = keep + n;
      const view = buf.subarray(0, len);
      let i = 0, skipTo = -1;
      for (;;) {
        i = view.indexOf('RIFF', i, 'latin1');
        if (i < 0) break;
        const off = base + i;
        if (off >= skipTo) {
          const hn = fs.readSync(fd, head, 0, 4096, off), w = parseWave(head.subarray(0, hn), off, size);
          if (w) { out.push({ start: w.start, end: w.end, bits: w.bits, ch: w.ch }); skipTo = w.next; }
        }
        i++;
      }
      at += n;
      if (skipTo > at) { // (inside a sound: on after it)
        at = skipTo; keep = 0; continue;
      }
      keep = Math.min(3, len); buf.copy(buf, 0, len - keep, len);
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** the regions of `waves` inside [start, end), relative to start, each starting on a sample frame: [{ at, len, bits, ch }] */
export function regionsIn(waves, start, end) {
  const out = [];
  for (const w of waves) {
    if (w.end <= start || w.start >= end) continue;
    const frame = (w.bits >> 3) * w.ch;
    let a = Math.max(w.start, start); a += (frame - ((a - w.start) % frame)) % frame;
    const b = Math.min(w.end, end);
    if (b - a >= frame) out.push({ at: a - start, len: Math.floor((b - a) / frame) * frame, bits: w.bits, ch: w.ch });
  }
  return out;
}

/** the layouts a range without sound headers is tried as (see the header) */
export const trialLayouts = (len) => [{ bits: 16, ch: 1 }, { bits: 16, ch: 2 }, { bits: 8, ch: 1 }].map((l) => ({ at: 0, len, ...l }));

/**
 * A quick estimate of the coded bytes of b as `layout` (order-2 prediction, Rice cost from each 1024 samples' mean),
 * to try only the layouts that may pay: bytes.
 */
export function estimateCoded(b, layout) {
  const { bits, ch } = layout, bps = bits >> 3, frame = bps * ch, frames = Math.floor(b.length / frame);
  let total = 0;
  for (let c = 0; c < ch; c++) {
    let x1 = 0, x2 = 0, sum = 0, cnt = 0;
    for (let f = 0; f < frames; f++) {
      const p = f * frame + c * bps, x = bits === 8 ? b[p] - 128 : ((b[p] | (b[p + 1] << 8)) << 16) >> 16;
      if (f >= 2) { const r = x - 2 * x1 + x2; sum += r < 0 ? -2 * r - 1 : 2 * r; cnt++; }
      x2 = x1; x1 = x;
      if (cnt === 1024 || f === frames - 1) { if (cnt) { const m = sum / cnt; total += cnt * ((m > 1 ? Math.log2(m) : 0) + 1.6); } sum = 0; cnt = 0; }
    }
  }
  return Math.ceil(total / 8);
}

/**
 * The layout a range without sound headers is coded as (bytes `b`; `wire`: its brotli unit's wire bytes), or null:
 * the most promising of trialLayouts by estimateCoded, when it may beat brotli — the estimate runs 5-18 % above the
 * coding's size on sampled sound (Vice City's sfx.RAW blocks), so it is asked to be under wire / 0.85.
 */
export function trialRegion(b, wire) {
  const best = trialLayouts(b.length).map((l) => [l, estimateCoded(b, l)]).sort((x, y) => x[1] - y[1])[0];
  return best[1] * TRIAL_ESTIMATE_SLACK < wire ? best[0] : null;
}
const TRIAL_ESTIMATE_SLACK = 0.85;

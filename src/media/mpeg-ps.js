// MPEG program / system stream demultiplexer (ISO/IEC 11172-1, and the MPEG-2 program stream pack header of
// 13818-1): packs, system headers and PES packets, incrementally (bytes are pushed as they arrive). Payloads of the
// first video stream (0xE0-0xEF) and the first audio stream (0xC0-0xDF) are handed to callbacks with their
// presentation time stamps (90 kHz units, or null).

/** What a media file holds, from its first bytes: 'mpeg-ps' | 'mpeg-video' | 'mpeg-audio' | null. */
export function probeMpeg(head) {
  const b = head;
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1) {
    if (b[3] === 0xba) return 'mpeg-ps';
    if (b[3] === 0xb3) return 'mpeg-video';
  }
  // an MPEG audio elementary stream: an ID3v2 tag, or two consecutive frame headers
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mpeg-audio';
  if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    const n = mpegAudioFrameBytes(b, 0);
    if (n > 0 && (b.length < n + 2 || (b[n] === 0xff && (b[n + 1] & 0xe0) === 0xe0))) return 'mpeg-audio';
  }
  return null;
}

const BITRATES = { // kbit/s by [version 1 / 2][layer 1..3][index]
  1: [null, [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
  2: [null, [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** The MPEG audio frame header at b[i]: its fields, or null. */
export function mpegAudioHeader(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layerBits = (b[i + 1] >> 1) & 3, prot = b[i + 1] & 1;
  const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layerBits === 0 || bri === 15 || sri === 3) return null;
  const layer = 4 - layerBits, rate = RATES[ver][sri], bitrate = BITRATES[ver === 3 ? 1 : 2][layer][bri] * 1000;
  const mode = b[i + 3] >> 6, modeExt = (b[i + 3] >> 4) & 3;
  let bytes = 0;
  if (bitrate) bytes = layer === 1 ? ((12 * bitrate / rate | 0) + pad) * 4 : layer === 3 && ver !== 3 ? (72 * bitrate / rate | 0) + pad : (144 * bitrate / rate | 0) + pad;
  return { version: ver === 3 ? 1 : ver === 2 ? 2 : 2.5, layer, crc: !prot, bitrate, rate, pad, mode, modeExt, channels: mode === 3 ? 1 : 2, bytes, samples: layer === 1 ? 384 : layer === 3 && ver !== 3 ? 576 : 1152 };
}
/** bytes of the MPEG audio frame at b[i] (0: not a frame header, or free format) */
export function mpegAudioFrameBytes(b, i) { return mpegAudioHeader(b, i)?.bytes ?? 0; }

/** 33-bit time stamp of 5 bytes ('xxxx' marker bits ignored) */
function timeStamp(b, i) { return ((b[i] >> 1) & 7) * 1073741824 + (b[i + 1] << 22 | (b[i + 2] >> 1) << 15 | b[i + 3] << 7 | b[i + 4] >> 1); }

export class MpegPsDemuxer {
  /** @param {{ video?: (bytes: Uint8Array, pts: number|null) => void, audio?: (bytes: Uint8Array, pts: number|null) => void }} sinks */
  constructor(sinks) {
    this.sinks = sinks;
    this.buf = new Uint8Array(1 << 16); this.len = 0; this.pos = 0;
    this.videoId = -1; this.audioId = -1; this.ended = false;
    this.firstScr = null; this.lastPts = null; this.mpeg2 = false;
  }
  push(bytes) {
    if (this.pos > 0) { this.buf.copyWithin(0, this.pos, this.len); this.len -= this.pos; this.pos = 0; }
    if (this.len + bytes.length > this.buf.length) { let n = this.buf.length; while (n < this.len + bytes.length) n *= 2; const nb = new Uint8Array(n); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; }
    this.buf.set(bytes, this.len); this.len += bytes.length;
    this.parse();
  }
  parse() {
    const b = this.buf;
    while (!this.ended) {
      let i = this.pos;
      // resynchronize on the next start code (garbage between packets is skipped)
      while (i + 3 < this.len && !(b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1)) i++;
      this.pos = i;
      if (i + 4 > this.len) return;
      const id = b[i + 3];
      if (id === 0xb9) { this.pos = i + 4; this.ended = true; return; } // end of the program stream
      if (id === 0xba) { // pack header
        if (i + 12 > this.len) return;
        if ((b[i + 4] & 0xc0) === 0x40) { // MPEG-2: 10 bytes + stuffing
          if (i + 14 > this.len) return;
          this.mpeg2 = true;
          const n = 14 + (b[i + 13] & 7);
          if (i + n > this.len) return;
          this.pos = i + n;
        } else {
          if (this.firstScr === null) this.firstScr = timeStamp(b, i + 4);
          this.pos = i + 12;
        }
        continue;
      }
      if (id < 0xb9) { this.pos = i + 3; continue; } // (a stray start code)
      // system header, PES packets, padding: a 16-bit length
      if (i + 6 > this.len) return;
      const n = (b[i + 4] << 8) | b[i + 5];
      if (i + 6 + n > this.len) return;
      this.packet(id, i + 6, i + 6 + n);
      this.pos = i + 6 + n;
    }
  }
  packet(id, start, end) {
    const isVideo = id >= 0xe0 && id <= 0xef, isAudio = id >= 0xc0 && id <= 0xdf;
    if (!isVideo && !isAudio) return;
    if (isVideo) { if (this.videoId < 0) this.videoId = id; else if (id !== this.videoId) return; }
    if (isAudio) { if (this.audioId < 0) this.audioId = id; else if (id !== this.audioId) return; }
    const b = this.buf;
    let i = start, pts = null;
    if ((b[i] & 0xc0) === 0x80) { // MPEG-2 PES header
      const flags = b[i + 1], hlen = b[i + 2];
      if (flags & 0x80) pts = timeStamp(b, i + 3);
      i += 3 + hlen;
    } else {
      while (i < end && b[i] === 0xff) i++; // stuffing
      if ((b[i] & 0xc0) === 0x40) i += 2; // STD buffer
      if ((b[i] & 0xf0) === 0x20) { pts = timeStamp(b, i); i += 5; }
      else if ((b[i] & 0xf0) === 0x30) { pts = timeStamp(b, i); i += 10; }
      else if (b[i] === 0x0f) i++;
    }
    if (i >= end) return;
    if (pts !== null) this.lastPts = Math.max(this.lastPts ?? 0, pts);
    const payload = b.slice(i, end);
    (isVideo ? this.sinks.video : this.sinks.audio)?.(payload, pts);
  }
}

/** The largest presentation time stamp (90 kHz) in a chunk of a program stream (its last bytes: the duration), or null. */
export function lastPtsIn(bytes) {
  let best = null;
  const d = new MpegPsDemuxer({ video: (_, p) => { if (p !== null) best = Math.max(best ?? 0, p); }, audio: (_, p) => { if (p !== null) best = Math.max(best ?? 0, p); } });
  // (the chunk starts anywhere: begin at its first pack header)
  let i = 0; while (i + 4 < bytes.length && !(bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && bytes[i + 3] === 0xba)) i++;
  d.push(bytes.subarray(i));
  return best;
}
/** The first presentation time stamp (90 kHz) of a program stream's first bytes, or null. */
export function firstPtsIn(bytes) {
  let best = null;
  const d = new MpegPsDemuxer({ video: (_, p) => { if (p !== null && best === null) best = p; }, audio: (_, p) => { if (p !== null && best === null) best = p; } });
  d.push(bytes);
  return best;
}

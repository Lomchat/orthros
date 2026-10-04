// AVI files for the DirectShow path (RIFF 'AVI '): the first video and audio streams, read progressively; video through
// the Video for Windows codecs Windows ships with (vfw-codecs.js), sound as in WAVE files (PCM / ADPCM, wav-source.js)
// or MPEG audio (layers I / II here, layer III through the browser). Same playing interface as MpegSource; pictures as
// RGBA ({ rgba, width, height }).
import { MediaError, AsyncAudio } from './mpeg-source.js';
import { WaveDecoder } from './wav-source.js';
import { readBitmapInfo, vfwDecoder } from './vfw-codecs.js';
import { MpegAudioDecoder } from './mpeg-audio.js';
import { mpegAudioHeader } from './mpeg-ps.js';

const CHUNK = 256 * 1024;
const id4 = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u16 = (b, i) => b[i] | (b[i + 1] << 8), u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** an AVI file's first bytes? */
export const isAvi = (b) => b.length >= 12 && id4(b, 0) === 'RIFF' && id4(b, 8) === 'AVI ';

export class AviSource {
  constructor(file, head, opts = {}) {
    this.file = file; this.log = opts.log ?? (() => {});
    this.size = file.size();
    this.kind = 'avi'; this.videoStart = 0; this.audioStart = 0; this.audioLayer = 0;
    // the header list (hdrl) and where the movi list starts (the header may extend past the first bytes read)
    let b = head;
    const need = (n) => { if (n > b.length && b.length < this.size) b = file.read(0, Math.min(this.size, Math.max(n, 2 * b.length))); return n <= b.length; };
    let i = 12, streams = [], movi = -1, usPerFrame = 0, frames = 0;
    while (movi < 0 && need(i + 12)) {
      const id = id4(b, i), n = u32(b, i + 4);
      if (id === 'LIST') {
        const type = id4(b, i + 8);
        if (type === 'movi') { movi = i + 12; this.moviEnd = Math.min(this.size, i + 8 + n); break; }
        if (type === 'hdrl') {
          if (!need(i + 8 + n)) throw new MediaError('corrupt', 'AVI header');
          for (let j = i + 12; j + 8 <= i + 8 + n;) {
            const cid = id4(b, j), cn = u32(b, j + 4);
            if (cid === 'avih') { usPerFrame = u32(b, j + 8); frames = u32(b, j + 24); }
            else if (cid === 'LIST' && id4(b, j + 8) === 'strl') streams.push(this.streamList(b, j + 12, j + 8 + cn));
            j += 8 + cn + (cn & 1);
          }
        }
        i += 8 + n + (n & 1);
        continue;
      }
      i += 8 + n + (n & 1);
    }
    if (movi < 0) throw new MediaError('corrupt', 'AVI without movi list');
    this.moviStart = movi;
    // the streams played: the first video and audio ones that can be decoded
    const vids = streams.findIndex((s) => s.type === 'vids'), auds = streams.findIndex((s) => s.type === 'auds');
    this.vIndex = -1; this.aIndex = -1; this.video = null; this.audio = null;
    if (vids >= 0) {
      const s = streams[vids];
      if (s.bih && vfwDecoder(s.bih, s.handler)) { this.vIndex = vids; this.vs = s; this.video = true; this.width = s.bih.width; this.height = s.bih.height; this.fps = s.rate / (s.scale || 1); this.videoStart = s.start * (s.scale || 1) / (s.rate || 1); }
      else this.videoUnsupported = `AVI video ${s.handlerName || ''} (compression ${s.bih ? s.bih.compression.toString(16) : '?'})`;
    }
    if (auds >= 0) {
      const s = streams[auds];
      this.aIndex = auds; this.as = s; this.audioRate = s.wfx.rate; this.audioChannels = s.wfx.channels;
      this.audioMpeg = s.wfx.tag === 0x50 || s.wfx.tag === 0x55;
      this.audioAsync = s.wfx.tag === 0x55 && AsyncAudio.available();
      try { if (!this.audioMpeg) new WaveDecoder(s.wfx); this.audio = !this.audioMpeg || s.wfx.tag === 0x50 || this.audioAsync; } catch { this.audio = false; }
      if (!this.audio) { this.audioUnsupported = `AVI audio format 0x${s.wfx.tag.toString(16)}`; this.audioLayer = s.wfx.tag === 0x55 ? 3 : 0; }
    }
    if (this.videoUnsupported) this.log(`${this.videoUnsupported}: no decoder, the file plays without pictures`);
    if (this.audioUnsupported) this.log(`${this.audioUnsupported}: no decoder, the file plays without sound`);
    if (!this.video && !this.audio) throw new MediaError('unsupported', this.videoUnsupported ?? this.audioUnsupported ?? 'AVI without streams');
    this.duration = this.video ? (this.vs.length || frames) / this.fps : usPerFrame * frames / 1e6;
    if (!this.duration && this.audio) this.duration = (this.as.length * (this.as.scale || 1) / (this.as.rate || 1)) || 0;
    this.reset();
  }
  /** a strl list: { type, handler, scale, rate, start, length, sampleSize, bih | wfx } */
  streamList(b, i, end) {
    const s = {};
    for (let j = i; j + 8 <= end;) {
      const cid = id4(b, j), n = u32(b, j + 4), d = j + 8;
      if (cid === 'strh') { s.type = id4(b, d); s.handlerName = id4(b, d + 4); s.handler = u32(b, d + 4); s.scale = u32(b, d + 20); s.rate = u32(b, d + 24); s.start = u32(b, d + 28); s.length = u32(b, d + 32); s.sampleSize = u32(b, d + 44); }
      else if (cid === 'strf') {
        if (s.type === 'vids' && n >= 40) s.bih = readBitmapInfo(b, d, n);
        else if (s.type === 'auds' && n >= 14) s.wfx = { tag: u16(b, d), channels: u16(b, d + 2), rate: u32(b, d + 4), align: u16(b, d + 12), bits: n >= 16 ? u16(b, d + 14) : 0, extra: b.slice(d + 16, d + n) };
      }
      j += 8 + n + (n & 1);
    }
    return s;
  }
  reset() {
    this.vdec = this.video ? vfwDecoder(this.vs.bih, this.vs.handler) : null;
    this.adec?.close?.();
    this.adec = !this.audio ? null : this.audioMpeg ? (this.audioAsync ? new AsyncAudio('mp3', this.audioRate, this.audioChannels, this.log) : new MpegAudioDecoder()) : new WaveDecoder(this.as.wfx);
    this.buf = new Uint8Array(0); this.bufAt = this.moviStart; this.parsePos = this.moviStart; // (file bytes from bufAt, parsed up to parsePos)
    this.loadPos = this.moviStart; this.loading = null; this.loadError = null; this.eof = false;
    this.vq = []; this.aq = []; // queued video chunks (frame data) and audio chunks
    this.frameIndex = 0; this.picture = null; this.videoDone = !this.video; this.audioDone = !this.audio;
    this.audioPos = 0; this.submitPos = 0; this.mpegBuf = new Uint8Array(0);
    this.stats = { decoded: 0, skipped: 0, overtaken: 0, late: 0, decodeMs: 0 };
  }
  get bytesPerSecond() { return this.duration ? this.size / this.duration : 1 << 20; }
  /** read and parse ahead to stream time t + 2 s (see MpegSource.load) */
  load(t, maxChunks = 4) {
    const want = Math.min(this.moviEnd, Math.ceil((t + 2) * this.bytesPerSecond) + CHUNK);
    let n = 0;
    while (!this.eof && this.loadPos < want && n < maxChunks && !this.loading) {
      const len = Math.min(CHUNK, this.moviEnd - this.loadPos);
      const p = this.file.prepare?.(this.loadPos, len);
      if (p) { this.loading = p; p.then(() => { this.loading = null; }, (e) => { this.loading = null; this.loadError = e; }); break; }
      const bytes = this.file.read(this.loadPos, len);
      if (!bytes.length) { this.eof = true; break; }
      this.append(bytes); this.loadPos += bytes.length; n++;
      if (this.loadPos >= this.moviEnd) this.eof = true;
    }
    this.parse();
    return false;
  }
  append(bytes) {
    const keep = this.buf.subarray(this.parsePos - this.bufAt);
    const nb = new Uint8Array(keep.length + bytes.length); nb.set(keep); nb.set(bytes, keep.length);
    this.buf = nb; this.bufAt = this.parsePos;
  }
  /** the complete chunks of the movi list read so far, queued by stream */
  parse() {
    const b = this.buf;
    for (;;) {
      const i = this.parsePos - this.bufAt;
      if (i + 8 > b.length) break;
      const id = id4(b, i), n = u32(b, i + 4);
      if (id === 'LIST') { this.parsePos += 12; continue; } // ('rec ' groups: their chunks follow)
      if (id === 'idx1' || this.parsePos + 8 > this.moviEnd) { this.parsePos = this.moviEnd; this.eof = true; break; }
      if (i + 8 + n > b.length) break;
      const stream = (b[i] - 48) * 10 + (b[i + 1] - 48), kind = id.slice(2);
      const data = b.subarray(i + 8, i + 8 + n);
      if (stream === this.vIndex && (kind === 'dc' || kind === 'db')) this.vq.push(data);
      else if (stream === this.vIndex && kind === 'pc') this.vq.push({ palette: data.slice() });
      else if (stream === this.aIndex && kind === 'wb') this.aq.push(data);
      this.parsePos += 8 + n + (n & 1);
    }
    if (this.eof && this.parsePos >= this.loadPos - 8) this.parsedAll = true;
  }
  frameTime(i) { return this.videoStart + i / this.fps; }
  /** the picture due at stream time t (every frame decoded in order: they depend on each other) */
  pictureAt(t) {
    if (!this.vdec) return null;
    const st = this.stats, t0 = performance.now();
    let shown = null;
    while (!this.videoDone && this.frameTime(this.frameIndex) <= t) {
      const c = this.vq[0];
      if (!c) { if (this.eof) this.videoDone = true; break; }
      this.vq.shift();
      if (c.palette) { const p = c.palette, first = p[0], count = p[1] || 256, entries = []; for (let k = 0; k < count && 4 + 4 * k + 3 < p.length; k++) entries.push((p[4 + 4 * k] << 16) | (p[5 + 4 * k] << 8) | p[6 + 4 * k]); this.vdec.setPalette(first, entries); continue; }
      if (c.length) { try { this.vdec.decode(c); } catch { this.errors = (this.errors ?? 0) + 1; } }
      this.frameIndex++; st.decoded++;
      if (shown) st.overtaken++;
      shown = { rgba: new Uint8ClampedArray(this.vdec.frame.buffer), width: this.width, height: this.height };
      st.late = Math.max(st.late, t - this.frameTime(this.frameIndex - 1));
    }
    st.decodeMs += performance.now() - t0;
    if (shown) this.picture = shown;
    return shown;
  }
  get videoEnd() { return !this.vdec ? 0 : this.videoDone ? this.frameTime(this.frameIndex) : Infinity; }
  get audioEnd() { return !this.adec ? 0 : this.audioDone ? this.audioPos / this.audioRate : Infinity; }
  ended(t) { return this.videoDone && this.audioDone && t >= this.videoEnd && t >= this.audioEnd || !!this.failed; }
  audioUntil(t, out) {
    const a = this.adec; if (!a) return;
    if (!this.audioMpeg) {
      while (!this.audioDone && this.audioPos / this.audioRate < t) {
        const c = this.aq.shift();
        if (!c) { if (this.eof && this.parsedAll) this.audioDone = true; return; }
        const n = Math.floor(c.length / this.as.wfx.align); if (!n) continue;
        const smp = a.decode(c, n);
        out(smp, this.audioPos / this.audioRate); this.audioPos += smp[0].length;
      }
      return;
    }
    // MPEG audio: chunks joined into a stream and cut into frames
    for (;;) {
      if (this.audioAsync ? a.flushing || this.submitPos / this.audioRate >= t + 1 : this.audioDone || this.audioPos / this.audioRate >= t) break;
      const f = this.nextMpegFrame();
      if (!f) { if (this.eof && this.parsedAll) { if (this.audioAsync) a.flush(); else this.audioDone = true; } break; }
      const [b, at, h] = f;
      if (this.audioAsync) { a.submit(b.slice(at, at + h.bytes), this.submitPos / this.audioRate); this.submitPos += h.samples; continue; }
      const d = a.decodeFrame(b, at); if (!d) continue;
      out(d.samples, this.audioPos / this.audioRate); this.audioPos += d.samples[0].length;
    }
    if (this.audioAsync) { for (const d of a.take()) { this.audioPos += d.samples[0].length; out(d.samples, d.start); } if (a.failed || a.flushed && !a.ready.length) this.audioDone = true; }
  }
  nextMpegFrame() {
    for (;;) {
      let b = this.mpegBuf, i = 0;
      while (i + 4 <= b.length) {
        const h = mpegAudioHeader(b, i);
        if (h && h.bytes) { if (i + h.bytes > b.length) break; this.mpegBuf = b.subarray(i + h.bytes); return [b, i, h]; }
        i++;
      }
      this.mpegBuf = b.subarray(i);
      const c = this.aq.shift(); if (!c) return null;
      const nb = new Uint8Array(this.mpegBuf.length + c.length); nb.set(this.mpegBuf); nb.set(c, this.mpegBuf.length); this.mpegBuf = nb;
    }
  }
  close() { this.adec?.close?.(); this.file.close?.(); }
}

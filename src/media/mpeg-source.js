// An MPEG media file being played: MPEG-1 system / program streams, MPEG-1 video elementary streams and MPEG audio
// elementary streams (layers I and II), read progressively from a file of the virtual file system, demultiplexed and
// decoded on demand as the playback clock advances. The playback code (src/win32/quartz.js) asks for the picture to
// show at a stream time and for the audio up to a stream time.
import { probeMpeg, MpegPsDemuxer, mpegAudioHeader, lastPtsIn } from './mpeg-ps.js';
import { Mpeg1VideoDecoder } from './mpeg1-video.js';
import { MpegAudioDecoder } from './mpeg-audio.js';

const CHUNK = 256 * 1024;
const HEAD = 256 * 1024, TAIL = 128 * 1024;

/** An error opening a media file: `code` is 'not-found' | 'unsupported' | 'corrupt'. */
export class MediaError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/** Accumulates MPEG audio elementary-stream bytes and cuts whole frames. */
class AudioFrames {
  constructor() { this.buf = new Uint8Array(1 << 15); this.len = 0; this.pos = 0; }
  push(bytes) {
    if (this.pos > 0) { this.buf.copyWithin(0, this.pos, this.len); this.len -= this.pos; this.pos = 0; }
    if (this.len + bytes.length > this.buf.length) { let n = this.buf.length; while (n < this.len + bytes.length) n *= 2; const b = new Uint8Array(n); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
    this.buf.set(bytes, this.len); this.len += bytes.length;
  }
  /** the next whole frame as [buffer, offset, header] (null: more bytes needed); garbage between frames is skipped */
  next() {
    const b = this.buf;
    while (this.pos + 4 <= this.len) {
      if (b[this.pos] === 0x49 && b[this.pos + 1] === 0x44 && b[this.pos + 2] === 0x33 && this.pos + 10 <= this.len) { // ID3v2 tag
        const n = 10 + ((b[this.pos + 6] & 0x7f) << 21 | (b[this.pos + 7] & 0x7f) << 14 | (b[this.pos + 8] & 0x7f) << 7 | (b[this.pos + 9] & 0x7f));
        if (this.pos + n > this.len) return null;
        this.pos += n; continue;
      }
      const h = mpegAudioHeader(b, this.pos);
      if (!h || !h.bytes) { this.pos++; continue; }
      if (this.pos + h.bytes > this.len) return null;
      const at = this.pos; this.pos += h.bytes;
      return [b, at, h];
    }
    return null;
  }
}

export class MpegSource {
  /**
   * @param {{ size: () => number, read: (off: number, len: number) => Uint8Array, prepare?: (off: number, len: number) => Promise<any>|null, close?: () => void }} file
   * @param {{ log?: (msg: string) => void }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file; this.log = opts.log ?? (() => {});
    this.size = file.size();
    const head = file.read(0, Math.min(this.size, HEAD));
    this.kind = probeMpeg(head);
    if (!this.kind) throw new MediaError('unsupported', 'not an MPEG stream');
    this.head = head;
    this.video = null; this.audio = null; this.width = 0; this.height = 0; this.fps = 0; this.aspect = 1;
    this.audioRate = 0; this.audioChannels = 0; this.videoStart = 0; this.audioStart = 0; this.duration = 0;
    this.probe(head);
    this.reset();
  }

  /** stream properties from the first bytes (and the last ones: the duration of a program stream) */
  probe(head) {
    let vPts = null, aPts = null;
    const vdec = new Mpeg1VideoDecoder(), afr = new AudioFrames();
    const take = (k) => k === 'video' ? (b, pts) => { vdec.push(b); if (vPts === null && pts !== null) vPts = pts; } : (b, pts) => { afr.push(b); if (aPts === null && pts !== null) aPts = pts; };
    if (this.kind === 'mpeg-ps') { const d = new MpegPsDemuxer({ video: take('video'), audio: take('audio') }); d.push(head); }
    else if (this.kind === 'mpeg-video') vdec.push(head);
    else afr.push(head);
    vdec.readSequenceHeader();
    if (vdec.seq) { this.video = true; this.width = vdec.seq.width; this.height = vdec.seq.height; this.fps = vdec.seq.rate; this.bitRate = vdec.seq.bitRate; }
    const af = afr.next();
    if (af) { const h = af[2]; this.audio = h.layer !== 3 ? true : false; this.audioLayer = h.layer; this.audioRate = h.rate; this.audioChannels = h.channels; this.audioBitRate = h.bitrate; }
    if (af && h3(af)) this.log(`MPEG audio layer III: not decoded, the stream plays without sound`);
    if (!this.video && !this.audio) throw new MediaError('unsupported', af ? 'MPEG audio layer III' : 'no MPEG-1 video or MPEG audio stream');
    // times: the first time stamps of the streams, relative to the earliest
    if (this.kind === 'mpeg-ps') {
      const base = Math.min(vPts ?? Infinity, aPts ?? Infinity);
      if (base !== Infinity) { this.videoStart = vPts !== null ? (vPts - base) / 90000 : 0; this.audioStart = aPts !== null ? (aPts - base) / 90000 : 0; }
      const tail = this.size > HEAD ? this.file.read(Math.max(0, this.size - TAIL), Math.min(TAIL, this.size)) : head;
      const last = lastPtsIn(tail);
      if (last !== null && base !== Infinity && last > base) this.duration = (last - base) / 90000 + (this.video ? 1 / this.fps : 0);
    }
    if (!this.duration) {
      const rate = this.kind === 'mpeg-audio' ? this.audioBitRate : this.bitRate + (this.audioBitRate || 0);
      // (a video elementary stream's bit rate field is often the 'variable' marker: no estimate from it)
      if (rate && (this.kind !== 'mpeg-video' || this.bitRate !== 0x3ffff * 400)) this.duration = this.size * 8 / rate;
    }
  }

  /** back to the start of the stream (decoders and demultiplexer reset) */
  reset() {
    this.vdec = this.video ? new Mpeg1VideoDecoder() : null;
    this.adec = this.audio ? new MpegAudioDecoder() : null;
    this.afr = new AudioFrames();
    this.demux = this.kind === 'mpeg-ps' ? new MpegPsDemuxer({ video: (b) => this.vdec?.push(b), audio: (b) => this.afr.push(b) }) : null;
    this.loadPos = 0; this.loading = null; this.loadError = null;
    this.frameIndex = 0; // next picture in display order
    // decoded / skipped (B pictures dropped undecoded) / overtaken (decoded, a later one shown at once) pictures, the
    // largest lateness of a picture (s), decoding time (ms)
    this.stats = { decoded: 0, skipped: 0, overtaken: 0, late: 0, decodeMs: 0 };
    this.picture = null; // the last picture shown: { y, cb, cr, ... } (valid until the next decode)
    this.videoDone = !this.video;
    this.audioPos = 0; // samples decoded (per channel)
    this.audioDone = !this.audio;
    this.feed(this.head);
    this.loadPos = this.head.length;
    if (this.loadPos >= this.size) this.endOfData();
  }
  feed(bytes) {
    if (this.demux) this.demux.push(bytes);
    else if (this.kind === 'mpeg-video') this.vdec.push(bytes);
    else this.afr.push(bytes);
  }
  endOfData() { this.vdec?.end(); this.eof = true; }
  get bytesPerSecond() { return this.duration ? this.size / this.duration : 1 << 20; }

  /**
   * Read ahead so that data up to stream time `t` + 2 s is demultiplexed. Without a network wait pending, reads at most
   * `maxChunks` chunks synchronously (data already local); a range still on the network is fetched asynchronously
   * (file.prepare) and taken at a later call. Returns true while data is missing for time `t` itself.
   */
  load(t, maxChunks = 4) {
    const want = Math.min(this.size, Math.ceil((t + 2) * this.bytesPerSecond) + CHUNK);
    let n = 0;
    while (!this.eof && this.loadPos < want && n < maxChunks && !this.loading) {
      const len = Math.min(CHUNK, this.size - this.loadPos);
      const p = this.file.prepare?.(this.loadPos, len);
      if (p) { this.loading = p; p.then(() => { this.loading = null; }, (e) => { this.loading = null; this.loadError = e; }); break; }
      const bytes = this.file.read(this.loadPos, len);
      if (!bytes.length) { this.endOfData(); break; }
      this.feed(bytes); this.loadPos += bytes.length; n++;
      if (this.loadPos >= this.size) this.endOfData();
    }
    return !this.eof && this.loadPos < Math.min(this.size, Math.ceil(t * this.bytesPerSecond));
  }

  /** time of picture i (display order) */
  frameTime(i) { return this.videoStart + i / this.fps; }
  /**
   * The picture to show at stream time t: decodes forward to the last picture due at t. Returns the new picture, or
   * null when the one shown before is still current (or no picture is available yet). Pictures skipped over (the
   * caller late) are B pictures dropped undecoded when possible.
   */
  pictureAt(t) {
    if (!this.vdec) return null;
    let shown = null;
    const st = this.stats, t0 = performance.now();
    while (!this.videoDone && this.frameTime(this.frameIndex) <= t) {
      // (another picture already due after this one: a B picture can be skipped)
      this.vdec.skipB = this.frameTime(this.frameIndex + 1) <= t;
      const p = this.vdec.decode();
      if (!p) { if (this.vdec.done) this.videoDone = true; break; }
      this.frameIndex++;
      if (p.skipped) st.skipped++; else { st.decoded++; if (shown) st.overtaken++; shown = p; }
      st.late = Math.max(st.late, t - this.frameTime(this.frameIndex - 1));
    }
    st.decodeMs += performance.now() - t0;
    this.vdec.skipB = false;
    if (shown) this.picture = shown;
    return shown;
  }
  /** stream time at which the video ends (its last picture's display ends), once known */
  get videoEnd() { return !this.vdec ? 0 : this.videoDone ? this.frameTime(this.frameIndex) : Infinity; }
  get audioEnd() { return !this.adec ? 0 : this.audioDone ? this.audioStart + this.audioPos / this.audioRate : Infinity; }
  /** all streams over at stream time t */
  ended(t) { return this.videoDone && this.audioDone && t >= this.videoEnd && t >= this.audioEnd || !!this.failed; }

  /**
   * Decode audio up to stream time t: calls out(samplesPerChannel[], startTime) for each decoded frame. Stops when
   * data is missing.
   */
  audioUntil(t, out) {
    if (!this.adec) return;
    while (!this.audioDone && this.audioStart + this.audioPos / this.audioRate < t) {
      const f = this.afr.next();
      if (!f) { if (this.eof) this.audioDone = true; return; }
      const [b, at] = f;
      const d = this.adec.decodeFrame(b, at);
      if (!d) continue;
      const start = this.audioStart + this.audioPos / this.audioRate;
      this.audioPos += d.samples[0].length;
      out(d.samples, start);
    }
  }
  close() { this.file.close?.(); }
}
const h3 = (af) => af[2].layer === 3;

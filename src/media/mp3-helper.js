// The MP3 decoding helper (a worker; docs/miles-mp3.md): decodes the MP3 frames the emulator's thread sends
// (src/media/mp3-host.js) and writes 16-bit interleaved PCM into each session's shared ring, where the emulator's thread
// copies it from without a message (Atomics on the ring's header). In the browser: the WebCodecs AudioDecoder ('mp3').
// In Node (tools only, no WebCodecs there): an ffmpeg process per session when ffmpeg is installed — a measurement
// stand-in, not shipped to players.
//
// A session's output is placed by sample position: each frame is sent with its first sample's index (its timestamp), so
// a decoder that drops or delays samples (priming) leaves zeros, never a shift, and the session's length is exactly the
// samples its frames hold (the 'end' message's total; the rest padded with zeros, any excess dropped).
import { RING_HDR, H_W, H_R, H_STATE, H_SEQ, ST_DONE, ST_FAILED } from './mp3-ring.js';

const isNode = typeof globalThis.process?.versions?.node === 'string' && typeof globalThis.WorkerGlobalScope === 'undefined';
const port = isNode ? (await import('node:worker_threads')).parentPort : globalThis;
const spawnFfmpeg = isNode ? (await import('node:child_process')).spawn : null;
const sessions = new Map();

class Session {
  constructor(m) {
    this.id = m.id; this.rate = m.rate; this.ch = m.ch;
    this.i32 = new Int32Array(m.sab, 0, RING_HDR / 4); this.u8 = new Uint8Array(m.sab, RING_HDR); this.cap = this.u8.length;
    this.next = 0; // samples (per channel) written
    this.total = -1; // samples the session holds ('end')
    this.closed = false; this.chain = Promise.resolve();
    this.backlog = []; // (outputs waiting for room in the ring: never expected, the emulator bounds what it sends)
    if (m.codec === 'pcm-test') this.test = true; // (tests/mp3-host.test.js: frames of 16-bit PCM, "decoded" asynchronously as they are)
    else if (typeof globalThis.AudioDecoder === 'function') this.openWebCodecs();
    else if (spawnFfmpeg) this.openFfmpeg();
    else this.fail('no MP3 decoder in this worker');
  }
  openWebCodecs() {
    this.dec = new globalThis.AudioDecoder({
      output: (d) => {
        try {
          if (this.closed) return;
          const n = d.numberOfFrames, nch = d.numberOfChannels, planes = [];
          for (let c = 0; c < this.ch; c++) { const a = new Float32Array(n); d.copyTo(a, { planeIndex: Math.min(c, nch - 1), format: 'f32-planar' }); planes.push(a); }
          this.place(Math.round(d.timestamp * this.rate / 1e6), planes, n);
        } finally { d.close(); }
      },
      error: (e) => this.fail(`AudioDecoder: ${e.message ?? e}`),
    });
    try { this.dec.configure({ codec: 'mp3', sampleRate: this.rate, numberOfChannels: this.ch }); } catch (e) { this.fail(`AudioDecoder: ${e.message ?? e}`); }
  }
  openFfmpeg() {
    const p = this.proc = spawnFfmpeg('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-fflags', 'nobuffer', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ac', String(this.ch), '-ar', String(this.rate), 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let carry = null;
    p.stdout.on('data', (b) => {
      if (this.closed) return;
      let buf = carry ? Buffer.concat([carry, b]) : b;
      const fb = 2 * this.ch, n = Math.floor(buf.length / fb);
      carry = buf.length > n * fb ? buf.subarray(n * fb) : null;
      if (n) this.placeS16(this.next, new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * fb)), n);
    });
    p.stdout.on('end', () => { this.ffEnded = true; this.ffDone?.(); });
    p.on('error', (e) => this.fail(`ffmpeg: ${e.message}`));
    p.stdin.on('error', () => {});
  }
  fail(msg) {
    if (Atomics.load(this.i32, H_STATE) === ST_FAILED) return;
    port.postMessage({ t: 'log', msg: `mp3 session ${this.id}: ${msg}` });
    Atomics.store(this.i32, H_STATE, ST_FAILED); Atomics.add(this.i32, H_SEQ, 1); Atomics.notify(this.i32, H_SEQ);
  }
  data(m) {
    if (Atomics.load(this.i32, H_STATE) === ST_FAILED) return;
    if (this.test) {
      for (const [start, off, len] of m.frames) { const pcm = new Int16Array(m.bytes.slice(off, off + len).buffer); this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, 1))).then(() => this.placeS16(start, pcm, pcm.length / this.ch)); }
    } else if (this.dec) {
      for (const [start, off, len] of m.frames) {
        try { this.dec.decode(new globalThis.EncodedAudioChunk({ type: 'key', timestamp: Math.round(start * 1e6 / this.rate), data: m.bytes.subarray(off, off + len) })); } catch (e) { this.fail(`decode: ${e.message ?? e}`); return; }
      }
    } else if (this.proc) this.proc.stdin.write(m.bytes);
  }
  async end(total) {
    this.total = total;
    try {
      if (this.test) await this.chain;
      else if (this.dec) await this.dec.flush();
      else if (this.proc) { await new Promise((res) => { this.ffDone = res; this.proc.stdin.end(); if (this.ffEnded) res(); }); }
    } catch (e) { this.fail(`flush: ${e.message ?? e}`); return; }
    if (this.closed || Atomics.load(this.i32, H_STATE) === ST_FAILED) return;
    while (this.backlog.length) { await new Promise((r) => setTimeout(r, 2)); this.drain(); }
    if (this.next < total) this.zeros(total - this.next);
    Atomics.store(this.i32, H_STATE, ST_DONE); Atomics.add(this.i32, H_SEQ, 1); Atomics.notify(this.i32, H_SEQ);
  }
  /** decoded float planes at sample `s0` */
  place(s0, planes, n) {
    const ch = this.ch, out = new Int16Array(n * ch);
    for (let c = 0; c < ch; c++) { const p = planes[c]; for (let i = 0, j = c; i < n; i++, j += ch) { const v = Math.round(p[i] * 32768); out[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } }
    this.placeS16(s0, out, n);
  }
  placeS16(s0, pcm, n) {
    let from = 0;
    if (s0 > this.next + 2 * this.rate) s0 = this.next; // (a time stamp far ahead: not trusted)
    if (s0 > this.next) this.zeros(s0 - this.next);
    else if (s0 < this.next) from = this.next - s0; // (overlap: already written)
    if (this.total >= 0) n = Math.min(n, from + Math.max(0, this.total - this.next));
    if (from >= n) return;
    this.write(new Uint8Array(pcm.buffer, pcm.byteOffset + from * 2 * this.ch, (n - from) * 2 * this.ch));
    this.next += n - from;
  }
  zeros(k) { if (this.total >= 0) k = Math.min(k, this.total - this.next); if (k <= 0) return; this.write(new Uint8Array(k * 2 * this.ch)); this.next += k; }
  write(b) {
    if (this.backlog.length || !this.room(b.length)) { this.backlog.push(b.slice()); this.pollBacklog(); return; }
    this.copyIn(b);
  }
  room(n) { const w = Atomics.load(this.i32, H_W), r = Atomics.load(this.i32, H_R); return this.cap - (w - r) >= n; }
  copyIn(b) {
    let w = Atomics.load(this.i32, H_W), at = w % this.cap, k = Math.min(b.length, this.cap - at);
    this.u8.set(b.subarray(0, k), at); if (k < b.length) this.u8.set(b.subarray(k), 0);
    Atomics.store(this.i32, H_W, (w + b.length) | 0); Atomics.add(this.i32, H_SEQ, 1); Atomics.notify(this.i32, H_SEQ);
  }
  drain() { while (this.backlog.length && this.room(this.backlog[0].length)) this.copyIn(this.backlog.shift()); }
  pollBacklog() { if (this.polling) return; this.polling = true; const tick = () => { this.drain(); if (this.backlog.length && !this.closed) setTimeout(tick, 2); else this.polling = false; }; setTimeout(tick, 2); }
  close() {
    this.closed = true; this.backlog = [];
    try { if (this.dec && this.dec.state !== 'closed') this.dec.close(); } catch { /* closed */ }
    try { this.proc?.kill(); } catch { /* gone */ }
  }
}

const onMessage = (m) => {
  if (m.t === 'open') { sessions.set(m.id, new Session(m)); return; }
  const s = sessions.get(m.id);
  if (!s) return;
  if (m.t === 'data') s.data(m);
  else if (m.t === 'end') s.end(m.total);
  else if (m.t === 'close') { s.close(); sessions.delete(m.id); }
};
if (isNode) port.on('message', onMessage); else port.onmessage = (e) => onMessage(e.data);

// MP3 decoding off the emulator's thread (docs/miles-mp3.md): sessions of MP3 frames sent to a helper worker
// (mp3-helper.js), their PCM read back from a shared ring without a message. The emulator's thread only copies; it waits
// (Atomics.wait on the ring) only when the PCM it needs is not decoded yet — at a session's start, the decoding being
// kept ahead of the reader otherwise (the caller sends frames ahead).
import { RING_HDR, H_W, H_R, H_STATE, H_SEQ, ST_RUN, ST_DONE, ST_FAILED } from './mp3-ring.js';

/** ring capacity (PCM bytes): 1.1 s of 44.1 kHz stereo; a session never has more sent and unread (the caller's bound) */
export const RING_BYTES = 192 * 1024;

export class Mp3Session {
  constructor(host, id, rate, ch, codec) {
    this.host = host; this.id = id; this.rate = rate; this.ch = ch;
    const sab = new SharedArrayBuffer(RING_HDR + RING_BYTES);
    this.i32 = new Int32Array(sab, 0, RING_HDR / 4); this.u8 = new Uint8Array(sab, RING_HDR); this.cap = RING_BYTES;
    this.read = 0; // bytes read
    host.post({ t: 'open', id, sab, rate, ch, codec });
  }
  /** PCM bytes ready */
  available() { return (Atomics.load(this.i32, H_W) - this.read) | 0; }
  state() { return Atomics.load(this.i32, H_STATE); }
  /** frames: [first sample, offset in bytes, length] each; bytes: their MP3 data (transferred) */
  send(bytes, frames) { this.host.post({ t: 'data', id: this.id, bytes, frames }, [bytes.buffer]); }
  end(total) { this.host.post({ t: 'end', id: this.id, total }); }
  /** copy up to n ready bytes into dst (a Uint8Array view of guest memory); returns the count */
  take(dst, n) {
    n = Math.min(n, this.available());
    if (n <= 0) return 0;
    const at = this.read % this.cap, k = Math.min(n, this.cap - at);
    dst.set(this.u8.subarray(at, at + k), 0);
    if (k < n) dst.set(this.u8.subarray(0, n - k), k);
    this.read = (this.read + n) | 0;
    Atomics.store(this.i32, H_R, this.read);
    return n;
  }
  /** skip up to n ready bytes */
  skip(n) { n = Math.min(n, this.available()); if (n > 0) { this.read = (this.read + n) | 0; Atomics.store(this.i32, H_R, this.read); } return Math.max(0, n); }
  /** wait until the ring changes (more PCM, done, failed) or `ms` pass; false on timeout */
  wait(ms) {
    const seq = Atomics.load(this.i32, H_SEQ);
    if (this.available() > 0 || this.state() !== ST_RUN) return true;
    const t0 = performance.now();
    const r = Atomics.wait(this.i32, H_SEQ, seq, ms);
    this.host.stats.waits++; this.host.stats.waitMs += performance.now() - t0;
    return r !== 'timed-out';
  }
  close() { this.host.post({ t: 'close', id: this.id }); }
}

export class Mp3Host {
  /**
   * @param {() => { postMessage: Function, terminate?: Function, on?: Function, onmessage?: any }} spawn a worker running mp3-helper.js
   * @param {(m: string) => void} [log]
   */
  constructor(spawn, log = () => {}) {
    this.spawn = spawn; this.log = log; this.worker = null; this.nextId = 1;
    this.stats = { sessions: 0, frames: 0, waits: 0, waitMs: 0, failures: 0 };
  }
  post(m, transfer) {
    if (!this.worker) {
      this.worker = this.spawn();
      const onMsg = (d) => { if (d?.t === 'log') { this.stats.failures++; this.log(d.msg); } };
      if (this.worker.on) this.worker.on('message', onMsg); else this.worker.onmessage = (e) => onMsg(e.data);
    }
    this.worker.postMessage(m, transfer);
  }
  /** a session (codec: 'mp3', or 'pcm-test': frames of 16-bit PCM passed through, for the tests) */
  open(rate, ch, codec = 'mp3') { this.stats.sessions++; return new Mp3Session(this, this.nextId++, rate, ch, codec); }
  terminate() { this.worker?.terminate?.(); this.worker = null; }
}
export { ST_RUN, ST_DONE, ST_FAILED };

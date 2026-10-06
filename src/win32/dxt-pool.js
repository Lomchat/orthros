// Parallel DXT encoding: the block rows of a large image are split between helper workers and the calling thread,
// which waits for the helpers (Atomics.wait: the emulator runs in a worker) before returning — D3DX calls stay
// synchronous for the guest. Every block is encoded by the same code as the sequential encoder (encodeDxtRows): the
// bytes are identical. Images travel through shared memory (a cross-origin isolated page): one shared
// WebAssembly.Memory — [scratch per thread, image, blocks] — on which every thread runs the WebAssembly encoder
// (dxt-wasm.js) in place, or the JavaScript one where WebAssembly SIMD is missing (or ?dbg=ORTHROS_DXT_WASM=0, decided
// per job); the helpers sleep in Atomics.wait on a job counter (no message per job: a wake-up costs microseconds, not an
// event-loop round trip).
import { encodeDxtRowsJs, dxtBytes, dxtKind } from './d3dx9-image.js';
import { dxtWasmSupported, instantiateDxt, SCRATCH_BYTES } from './dxt-wasm.js';
import { acct, C as ACCT } from '../core/frame-acct.js';

/** Images with fewer blocks than this are encoded by the caller alone (the hand-off costs more than it saves). */
export const MIN_PARALLEL_BLOCKS = 1024;
/** Largest image handed to the helpers (texels): the shared buffers are allocated once at this size. */
export const MAX_PARALLEL_TEXELS = 2048 * 2048;
/** Most helpers a pool takes (their scratch areas lie before the image). */
const MAX_HELPERS = 15;
// shared memory layout: scratch of the caller (0) and of each helper (1 + index), the image, the blocks (DXT3/5: 1 byte per texel)
const IN = (MAX_HELPERS + 1) * SCRATCH_BYTES, OUT = IN + MAX_PARALLEL_TEXELS * 4, BYTES = OUT + MAX_PARALLEL_TEXELS;
// control words: parts finished by the helpers, job number, format, width, height, parts, encoder (1 WebAssembly, 0 JavaScript)
const DONE = 0, SEQ = 1, FMT_ = 2, W = 3, H = 4, PARTS = 5, WASM = 6;
const cut = (k, bh, parts) => Math.round((k * bh) / parts);
const useWasm = () => globalThis.ORTHROS_DXT_WASM !== 0 && dxtWasmSupported();

export class DxtPool {
  /**
   * @param {number} helpers number of helper workers
   * @param {() => { postMessage: (m: any) => void, terminate?: () => void }} spawn creates one helper (a Worker running dxt-helper.js)
   * @param {(m: string) => void} [log]
   * @param {{ firstMs?: number, ms?: number }} [timeouts] how long a job may wait for the helpers (the first one: loading them)
   */
  constructor(helpers, spawn, log = () => {}, timeouts = {}) {
    this.log = log; this.timeouts = { firstMs: timeouts.firstMs ?? 10000, ms: timeouts.ms ?? 2000 };
    this.ctl = new Int32Array(new SharedArrayBuffer(64));
    // (a shared WebAssembly memory when WebAssembly SIMD is there: the encoder runs on it; else a plain shared buffer)
    this.memory = dxtWasmSupported() ? new WebAssembly.Memory({ initial: Math.ceil(BYTES / 65536), maximum: Math.ceil(BYTES / 65536), shared: true }) : null;
    this.buffer = this.memory ? this.memory.buffer : new SharedArrayBuffer(BYTES);
    this.wasm = null; // (this thread's encoder instance on the shared memory, made at the first job)
    this.workers = [];
    for (let i = 0; i < Math.min(helpers, MAX_HELPERS); i++) { const w = spawn(); w.postMessage({ ctl: this.ctl.buffer, memory: this.memory, buffer: this.buffer, index: i }); this.workers.push(w); }
    this.firstJob = true; this.broken = false;
    this.stats = { jobs: 0, waitMs: 0 };
  }
  /** Encode (fmt, rgba, w, h) as encodeDxt does, or return null (the caller encodes) for small or huge images or a broken pool. */
  encode(fmt, rgba, w, h) {
    const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
    if (this.broken || !this.workers.length || bw * bh < MIN_PARALLEL_BLOCKS || bh < 2 || w * h > MAX_PARALLEL_TEXELS) return null;
    const inBytes = w * h * 4, outBytes = dxtBytes(fmt, w, h), ctl = this.ctl;
    if (outBytes > BYTES - OUT) return null; // (sizes not multiple of 4 near the limit: edge blocks exceed 1 byte per texel)
    new Uint8Array(this.buffer, IN, inBytes).set(rgba.subarray(0, inBytes));
    const out = new Uint8Array(this.buffer, OUT, outBytes);
    // parts: helpers take the first ones, this thread the last one (block rows split evenly)
    const parts = Math.min(this.workers.length + 1, bh), helpers = parts - 1; // (helpers past the parts answer without work)
    const wasm = this.memory && useWasm();
    ctl[FMT_] = fmt; ctl[W] = w; ctl[H] = h; ctl[PARTS] = parts; ctl[WASM] = wasm ? 1 : 0;
    Atomics.store(ctl, DONE, 0);
    Atomics.add(ctl, SEQ, 1); Atomics.notify(ctl, SEQ);
    if (wasm) (this.wasm ??= instantiateDxt(this.memory)).encodeRows(dxtKind(fmt), w, h, cut(helpers, bh, parts), bh, IN, OUT, 0);
    else encodeDxtRowsJs(fmt, new Uint8Array(this.buffer, IN, inBytes), w, h, cut(helpers, bh, parts), bh, out);
    const t0 = performance.now(), limit = this.firstJob ? this.timeouts.firstMs : this.timeouts.ms; // (the first job waits for the helpers to load)
    const ap = acct.enter(ACCT.tex); // (frame accounting: waiting for the helpers)
    try { return this.collect(ctl, out, t0, limit); } finally { acct.leave(ap); }
  }
  collect(ctl, out, t0, limit) {
    for (;;) {
      const done = Atomics.load(ctl, DONE);
      if (done >= this.workers.length) break; // (every helper answers every job, with a part or not: none lags behind)
      if (performance.now() - t0 > limit) {
        // helpers not answering: never use them (nor these buffers, which they may still write) again
        this.broken = true;
        this.log(`dxt pool: helpers did not answer within ${limit} ms, encoding on this thread from now on`);
        for (const wk of this.workers) wk.terminate?.();
        return null;
      }
      Atomics.wait(ctl, DONE, done, 50);
    }
    this.firstJob = false;
    this.stats.jobs++; this.stats.waitMs += performance.now() - t0;
    return out.slice();
  }
}

/**
 * The helper side (first message: the shared memory and this helper's index): sleeps until the job number changes,
 * encodes its part of the job when it has one, counts it done. Never returns (the worker is terminated with its page).
 */
export function helperLoop(m) {
  const ctl = new Int32Array(m.ctl), index = m.index;
  let wasm = null;
  try { if (m.memory) wasm = instantiateDxt(m.memory); } catch { wasm = null; } // (then the JavaScript encoder: the same bytes)
  let seen = 0; // (jobs are numbered from 1: a helper starting late still takes the job waiting for it)
  for (;;) {
    Atomics.wait(ctl, SEQ, seen);
    const seq = Atomics.load(ctl, SEQ);
    if (seq === seen) continue;
    seen = seq;
    const parts = ctl[PARTS];
    const fmt = ctl[FMT_], w = ctl[W], h = ctl[H], bh = Math.max(1, (h + 3) >> 2);
    if (index < parts - 1) {
      const by0 = cut(index, bh, parts), by1 = cut(index + 1, bh, parts);
      if (ctl[WASM] && wasm) wasm.encodeRows(dxtKind(fmt), w, h, by0, by1, IN, OUT, (1 + index) * SCRATCH_BYTES);
      else encodeDxtRowsJs(fmt, new Uint8Array(m.buffer, IN, w * h * 4), w, h, by0, by1, new Uint8Array(m.buffer, OUT, dxtBytes(fmt, w, h)));
    }
    Atomics.add(ctl, DONE, 1); Atomics.notify(ctl, DONE);
  }
}

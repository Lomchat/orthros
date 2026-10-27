// Measurements of the GPU side of the frames for telemetry (docs/real-machine-bench.md), cheap enough to stay on in
// every session:
// - GPU time per frame: EXT_disjoint_timer_query_webgl2, a TIME_ELAPSED query from one present to the next (the GPU
//   execution time of the commands of a frame, the final blit included), over windows of WINDOW_FRAMES consecutive
//   frames every PERIOD_MS. Results are read at later presents, when available; a disjoint operation (GPU reset,
//   frequency change, another context) discards the results in flight. Without the extension the measurement is
//   reported as unavailable — never estimated.
// - WebGL calls per frame (bench runs only: ORTHROS_GL_COUNT, set by the page's ?bench mode — swapping the
//   prototype's methods makes V8 drop the code optimized against them, a cost ordinary sessions need not pay): every
//   GL_PERIOD_MS, the calls made through the context object over GL_FRAMES frames are counted (the context prototype's methods wrapped by counting closures for that window only, then restored; the
//   draw calls among them apart).
// Both keep cumulative counters in `stats` (the device statistics that reach the emulator worker and the page);
// readers take differences.
import { HIST_N, histBucket } from '../core/frame-acct.js';

/**
 * The page's debug flags (?dbg=, the worker's globals) that only measure the host's GL side — no guest-visible effect, no
 * state of the machine: left out of a snapshot's key (snapshot-key.js), a ?bench page (which adds ORTHROS_GL_COUNT) and a
 * player's page share their snapshots. ORTHROS_GL_COUNT: the GL call counter here; ORTHROS_GL_PROBES=0: this probe off
 * (d3d8-webgl.js); ORTHROS_GL_TIME: every GL call timed for some frames (d3d8-webgl.js glProbeStep). A flag that changes
 * what the guest sees or when (timers, scheduling, the JIT, the APIs' paths) is not one of them.
 */
export const HOST_ONLY_DBG = Object.freeze(['ORTHROS_GL_COUNT', 'ORTHROS_GL_PROBES', 'ORTHROS_GL_TIME']);

const TIME_ELAPSED_EXT = 0x88bf, GPU_DISJOINT_EXT = 0x8fbb;
export const WINDOW_FRAMES = 120, PERIOD_MS = 10000, GL_FRAMES = 30, GL_PERIOD_MS = 20000;
/** queries in flight at most (a GPU that far behind: frames left untimed rather than more queries) */
const IN_FLIGHT = 16;
/** presents after which a query still unavailable is given up (counted lost): a result that never comes must not stop the others */
const STALE_FRAMES = 240;
const DRAW_FNS = new Set(['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']);

export class GpuProbe {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ now?: () => number, wrapGl?: boolean }} [opts] `wrapGl`: count GL calls (false when `gl` is not a real
   * context: a test double)
   */
  constructor(gl, opts = {}) {
    this.gl = gl; this.now = opts.now ?? (() => performance.now());
    this.ext = null;
    try { this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch { this.ext = null; }
    const real = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.wrapGl = opts.wrapGl ?? (real && !!globalThis.ORTHROS_GL_COUNT);
    // gpu: cumulative; `state`: 'on' | 'unavailable' (no extension) | 'off' (switched off) ; hist: frames by GPU ms (frame-acct.js buckets)
    this.stats = {
      gpu: { state: this.ext ? 'on' : 'unavailable', frames: 0, ms: 0, max: 0, over16: 0, over33: 0, disjoint: 0, lost: 0, hist: new Array(HIST_N).fill(0) },
      glCalls: { state: this.wrapGl ? 'on' : real ? 'off' : 'unavailable', frames: 0, calls: 0, draws: 0 },
    };
    this.cur = null; this.pending = []; this.left = 0; this.nextWindow = this.now() + 3000; // (the first window soon after the start)
    this.glLeft = 0; this.glNext = this.now() + 5000; this.glWrapped = null; this.glCount = 0; this.glDraws = 0;
  }
  /** Something else wraps or replaces GL methods (frame capture, GL timing, null mode): the call counter stays away. */
  set busy(v) { this.isBusy = v; if (v) this.stopGlCount(false); }
  /** The context was lost and restored: the queries in flight are gone (counted lost), wrapped methods kept. */
  reset() { this.stats.gpu.lost += this.pending.length + (this.cur ? 1 : 0); this.pending.length = 0; this.cur = null; this.left = 0; }
  /** A frame was presented (after its commands were flushed). */
  frame() {
    const now = this.now();
    if (this.ext) this.gpuFrame(now);
    if (this.wrapGl) this.glFrame(now);
  }
  gpuFrame(now) {
    const gl = this.gl, g = this.stats.gpu;
    this.presents = (this.presents ?? 0) + 1;
    if (this.cur) { gl.endQuery(TIME_ELAPSED_EXT); this.cur.endAt = this.presents; this.pending.push(this.cur); this.cur = null; }
    this.poll();
    if (!this.left && now >= this.nextWindow) { this.left = WINDOW_FRAMES; this.nextWindow = now + PERIOD_MS; }
    if (this.left > 0) {
      this.left--;
      if (this.pending.length < IN_FLIGHT) { const q = gl.createQuery(); if (q) { gl.beginQuery(TIME_ELAPSED_EXT, q); this.cur = q; } }
      else g.lost++;
    }
  }
  /** Results of the queries that completed, in order; all of them dropped after a disjoint operation. */
  poll() {
    const gl = this.gl, g = this.stats.gpu;
    if (!this.pending.length) return;
    let disjoint = false;
    try { disjoint = !!gl.getParameter(GPU_DISJOINT_EXT); } catch { disjoint = false; }
    if (disjoint) { g.disjoint += this.pending.length; for (const q of this.pending) gl.deleteQuery(q); this.pending.length = 0; return; }
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (this.presents - (q.endAt ?? this.presents) < STALE_FRAMES) break;
        gl.deleteQuery(q); this.pending.shift(); g.lost++; continue;
      }
      const ns = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)); gl.deleteQuery(q); this.pending.shift();
      const ms = ns / 1e6;
      if (!(ms >= 0) || ms > 60000) { g.lost++; continue; }
      g.frames++; g.ms += ms; if (ms > g.max) g.max = ms; if (ms > 16.7) g.over16++; if (ms > 33.4) g.over33++;
      g.hist[histBucket(ms)]++;
    }
  }
  glFrame(now) {
    if (this.glWrapped) {
      if (--this.glLeft <= 0) this.stopGlCount(true);
      return;
    }
    if (this.isBusy || now < this.glNext) return;
    this.glNext = now + GL_PERIOD_MS;
    this.startGlCount();
  }
  startGlCount() {
    const proto = Object.getPrototypeOf(this.gl);
    if (!proto || proto === Object.prototype) return;
    glCounting(proto).set(this.gl, this);
    this.glWrapped = proto; this.glLeft = GL_FRAMES; this.glCount = 0; this.glDraws = 0;
  }
  /** Unwrap; `keep`: the window completed (its counts added), else dropped. */
  stopGlCount(keep) {
    if (!this.glWrapped) return;
    glUncount(this.glWrapped, this.gl);
    this.glWrapped = null;
    if (keep) { const c = this.stats.glCalls; c.frames += GL_FRAMES; c.calls += this.glCount; c.draws += this.glDraws; }
  }
}

// The counting wrappers live on the context's prototype, installed while a window is open and then put back: own
// properties added to (then deleted from) the context object would leave it in V8's dictionary mode for the rest of the
// session — every later GL call measured ~30 ns slower in Chromium (63 -> 95 ns for bindBuffer / enable) — while a
// prototype restored to its own methods is fast again. A wrapper counts for the probe of its receiver only (several
// contexts share the prototype: the mirror mode, other pages' contexts in the realm).
/** @type {Map<object, { orig: Map<string, Function>, probes: Map<object, GpuProbe> }>} */
const counting = new Map();
/** The receivers counted on `proto` (the wrappers installed with the first one). */
function glCounting(proto) {
  let c = counting.get(proto);
  if (c) return c.probes;
  c = { orig: new Map(), probes: new Map() }; counting.set(proto, c);
  const probes = c.probes;
  for (const k of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (typeof d?.value !== 'function' || k === 'constructor' || !d.writable) continue;
    const f = d.value;
    c.orig.set(k, f);
    proto[k] = DRAW_FNS.has(k)
      ? function () { const p = probes.get(this); if (p) { p.glCount++; p.glDraws++; } return f.apply(this, arguments); }
      : function () { const p = probes.get(this); if (p) p.glCount++; return f.apply(this, arguments); };
  }
  return probes;
}
/** `gl` no longer counted; the prototype's own methods back once no receiver is. */
function glUncount(proto, gl) {
  const c = counting.get(proto);
  if (!c) return;
  c.probes.delete(gl);
  if (c.probes.size) return;
  for (const [k, f] of c.orig) proto[k] = f;
  counting.delete(proto);
}

// Frame summaries over a window of the worker's stats messages (~0.5 s each): the periodic `summary` telemetry records
// and the per-phase measurements of the bench mode (docs/real-machine-bench.md). Built from what the stats already
// carry — the frame accounting of each interval (frame-acct.js FrameStats.takeInterval: slow-frame counts, frame-time
// histogram, mean time by category) and cumulative counters (draws, GPU time, GL calls, render worker waits) — so the
// page does no work per frame. No dependency on the DOM (unit tests).
import { HIST_N, histAddSparse, histQuantile, histSparse, histBucket } from '../core/frame-acct.js';

/** a counter's growth, a counter that restarted (a new device) counting from zero */
const grow = (a, b) => (b === undefined || b === null ? 0 : a === undefined || a === null || b < a ? b : b - a);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
/** a quantile of a histogram, rounded to 0.1 ms (the upper bound of a bucket, or the window's maximum) */
const hq = (h, q, max) => { const v = histQuantile(h, q, max); return v === null ? null : r1(v); };

/** The cumulative counters of a stats message the window takes differences of. */
function counters(m) {
  const d = m?.d3d, g = m?.gl, gpu = d?.gpu, gc = d?.glCalls;
  return {
    d3dFrames: d?.frames, draws: d?.draws,
    gpuState: gpu?.state ?? null, gpuFrames: gpu?.frames, gpuMs: gpu?.ms, gpuOver33: gpu?.over33, gpuDisjoint: gpu?.disjoint, gpuLost: gpu?.lost, gpuHist: gpu?.hist ? Array.from(gpu.hist) : null, gpuMax: gpu?.max,
    glState: gc?.state ?? null, glFrames: gc?.frames, glCalls: gc?.calls, glDraws: gc?.draws,
    rwWaitMs: g?.gpuWaitMs, rwFenceMs: g?.fenceMs, rwFrameMs: g?.frameMs, rwReplayMs: g?.replayMs, rwReadbackMs: g?.readbackMs,
  };
}

export class PerfWindow {
  constructor() { this.base = null; this.last = null; this.reset(); }
  reset() {
    this.seconds = 0; this.frames = 0; this.s33 = 0; this.s40 = 0; this.s50 = 0; this.s100 = 0; this.max = 0;
    this.hist = new Array(HIST_N).fill(0); this.work = 0; this.cats = {}; this.slowCats = {}; this.worst = null;
    this.busy = 0; this.mips = 0; this.visible = 0; this.fullscreen = 0; this.samples = 0; this.status = null; this.t0 = null; this.t1 = null;
    this.base = this.last;
  }
  /**
   * One stats message. `extra`: what the page knows of that moment ({ t: Date.now(), visible, fullscreen, status }).
   * @param {any} m
   */
  add(m, extra = {}) {
    const dt = m.dt ?? 0.5, a = m.acct;
    this.samples++; this.seconds += dt; this.t0 ??= extra.t ?? null; this.t1 = extra.t ?? null;
    if (extra.visible !== false) this.visible += dt; if (extra.fullscreen) this.fullscreen += dt; this.status = extra.status ?? this.status;
    if (m.render) this.renderMode = m.render; // (the rendering actually used: 'worker', 'thread', 'inline', ..., 'none')
    this.busy += (m.busy ?? 0) * dt; this.mips += (m.mips ?? 0) * dt;
    if (a) {
      const n = a.frames ?? 0;
      this.frames += n; this.s33 += a.s33 ?? 0; this.s40 += a.s40 ?? 0; this.s50 += a.s50 ?? 0; this.s100 += a.s100 ?? 0;
      if ((a.max ?? 0) > this.max) this.max = a.max;
      histAddSparse(this.hist, a.h);
      // (an interval without a histogram — an older worker — counts its frames at the interval's mean duration)
      if (!a.h && n) this.hist[histBucket(dt * 1000 / n)] += n;
      this.work += (a.w ?? 0) * n;
      for (const [k, v] of Object.entries(a.c ?? {})) this.cats[k] = (this.cats[k] ?? 0) + v * n;
      for (const [k, v] of Object.entries(a.sc ?? {})) this.slowCats[k] = (this.slowCats[k] ?? 0) + v;
      if (a.wf && (!this.worst || a.wf[0] > this.worst[0])) this.worst = a.wf;
    }
    const c = counters(m);
    this.base ??= c; this.last = c;
  }
  /**
   * The window as a compact record, then a new window begins (its counters from this one's end). null when the
   * window holds no sample.
   */
  take() {
    if (!this.samples) return null;
    const b = this.base ?? {}, l = this.last ?? {}, n = this.frames, sec = this.seconds, min = sec / 60;
    const per = (x) => (min > 0 ? Math.round(x / min * 10) / 10 : 0);
    const out = {
      seconds: r1(sec), frames: n, fps: sec > 0 ? r1(n / sec) : 0,
      s33: this.s33, s40: this.s40, s50: this.s50, s100: this.s100, per33: per(this.s33), per50: per(this.s50), per100: per(this.s100),
      dt: n ? { p50: hq(this.hist, 0.5, this.max), p90: hq(this.hist, 0.9, this.max), p99: hq(this.hist, 0.99, this.max), max: Math.round(this.max) } : null,
      work: n ? r1(this.work / n) : null,
      cats: n ? Object.fromEntries(Object.entries(this.cats).map(([k, v]) => [k, r2(v / n)]).filter(([, v]) => v >= 0.05).sort((x, y) => y[1] - x[1])) : null,
      slowCats: Object.keys(this.slowCats).length ? Object.fromEntries(Object.entries(this.slowCats).map(([k, v]) => [k, Math.round(v)]).sort((x, y) => y[1] - x[1])) : null,
      worst: this.worst, h: histSparse(this.hist),
      busy: sec > 0 ? Math.round(this.busy / sec) : null, mips: sec > 0 ? Math.round(this.mips / sec) : null,
      visible: sec > 0 ? r2(this.visible / sec) : null, fullscreen: sec > 0 ? r2(this.fullscreen / sec) : null, status: this.status, renderMode: this.renderMode ?? null,
    };
    // Direct3D draw calls per presented Direct3D frame
    const d3dFrames = grow(b.d3dFrames, l.d3dFrames), draws = grow(b.draws, l.draws);
    out.d3dFrames = d3dFrames; out.drawsPerFrame = d3dFrames > 0 ? r1(draws / d3dFrames) : null;
    // GPU time per frame (EXT_disjoint_timer_query_webgl2 windows: gpu-probe.js), or why there is none
    if (l.gpuState === 'on') {
      const f = grow(b.gpuFrames, l.gpuFrames), ms = grow(b.gpuMs, l.gpuMs);
      const h = l.gpuHist ? l.gpuHist.map((v, i) => grow(b.gpuHist?.[i], v)) : null;
      const max = (l.gpuMax ?? 0) > (b.gpuMax ?? 0) ? l.gpuMax : null; // (the cumulative maximum grew in this window: it is this window's)
      out.gpu = f > 0 ? { state: 'on', frames: f, mean: r2(ms / f), p50: h ? hq(h, 0.5, max ?? Infinity) : null, p90: h ? hq(h, 0.9, max ?? Infinity) : null, p99: h ? hq(h, 0.99, max ?? Infinity) : null, max: max !== null ? r1(max) : null, over33: grow(b.gpuOver33, l.gpuOver33), disjoint: grow(b.gpuDisjoint, l.gpuDisjoint), lost: grow(b.gpuLost, l.gpuLost), h: h ? histSparse(h) : null }
        : { state: 'on', frames: 0, disjoint: grow(b.gpuDisjoint, l.gpuDisjoint), lost: grow(b.gpuLost, l.gpuLost) };
    } else out.gpu = { state: l.gpuState ?? 'none' }; // ('unavailable': no timer query extension; 'none': no Direct3D device)
    // WebGL calls per frame (sampled windows)
    if (l.glState === 'on') { const f = grow(b.glFrames, l.glFrames); out.glCalls = f > 0 ? { frames: f, perFrame: r1(grow(b.glCalls, l.glCalls) / f), drawsPerFrame: r1(grow(b.glDraws, l.glDraws) / f) } : { frames: 0 }; }
    else out.glCalls = { state: l.glState ?? 'none' };
    // render worker: the emulator's waits for it and its replay time, ms per frame
    if (l.rwWaitMs !== undefined && n > 0) out.render = { waitMs: r2(grow(b.rwWaitMs, l.rwWaitMs) / n), fenceMs: r2(grow(b.rwFenceMs, l.rwFenceMs) / n), frameMs: r2(grow(b.rwFrameMs, l.rwFrameMs) / n), replayMs: r2(grow(b.rwReplayMs, l.rwReplayMs) / n), readbackMs: r2(grow(b.rwReadbackMs, l.rwReadbackMs) / n) };
    this.reset();
    return out;
  }
}

/**
 * Periodic summaries for telemetry: one record every `everyMs` of samples (~20 s), at most `cap` per session.
 * `add` returns the record when one is due.
 */
export class SummaryClock {
  constructor(everyMs = 20000, cap = 720) { this.everyMs = everyMs; this.cap = cap; this.sent = 0; this.window = new PerfWindow(); this.acc = 0; }
  add(m, extra = {}) {
    this.window.add(m, extra);
    this.acc += (m.dt ?? 0.5) * 1000;
    if (this.acc < this.everyMs) return null;
    this.acc = 0;
    const s = this.window.take();
    if (!s || this.sent >= this.cap) return null;
    this.sent++;
    return s;
  }
}

/** The compact form of a worker phase report (frame-acct.js FrameStats.phase) kept in bench records. */
export function compactPhase(ph) {
  if (!ph) return null;
  return {
    label: ph.label, frames: ph.frames ?? 0, seconds: ph.seconds ?? 0, fps: ph.fps ?? 0,
    slow33: ph.slow33 ?? 0, slow40: ph.slow40 ?? 0, slow50: ph.slow50 ?? 0, slow100: ph.slow100 ?? 0, per33: ph.per33 ?? 0, per40: ph.per40 ?? 0, per50: ph.per50 ?? 0, per100: ph.per100 ?? 0,
    slowPaced: ph.slowPaced ?? null,
    dt: ph.dt ?? null, work: ph.work ?? null, mean: ph.mean ?? null, slowMean: ph.slowMean ?? null, excessShares: ph.excessShares ?? null, hitches: ph.hitches ?? null,
    worst: (ph.worst ?? []).slice(0, 3),
  };
}

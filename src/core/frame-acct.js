// Per-frame time accounting (always on): where the emulator worker's time goes between two presented frames.
//
// One stopwatch for the whole worker thread: at every moment the time is charged to exactly one category (`cur`);
// enter(cat) closes the running segment and opens one of `cat`, returning the category to restore with leave(prev).
// Sections nest (a texture upload inside an API call inside a callback from guest code), so each category's time is
// exclusive and the categories of a frame add up to its duration.
//
// performance.now() costs ~250 ns in a cross-origin isolated Chrome worker, so the very frequent sections are not
// timed one by one: JS API calls and interpreter fallbacks are timed on a random sample (1 in ~16, `sampled*`) and
// the others counted; a frame's untimed calls are estimated from its timed ones (ratio estimator) and that time is
// moved from the enclosing category (guest code) when the frame closes. A draw is timed (`draw`) inside a timed API
// call — the untimed calls' draw time is estimated with their API time — and every draw is timed from a draw of 0.5 ms
// or more (a GPU process behind: one draw a frame may wait for the whole previous frame) until 1024 draws in a row are
// short again. An API whose timed call took 0.5 ms or more of its own (draws excluded) is timed on every call
// (`always`) until 1024 of its calls in a row are short again: rare heavy calls are not left to sampling.
//
// Pacing (`wait`, `sleep`) is the game's own frame pacing — guest threads waiting for their timers — not work: a
// frame's work is its duration minus those.

/** Category names, in their index order (telemetry and reports use these names). */
export const CATS = ['guest', 'api', 'draw', 'interp', 'jit', 'ahead', 'install', 'prog', 'tex', 'readback', 'io', 'net', 'present', 'render', 'audio', 'host', 'wait', 'sleep', 'ioWait', 'late'];
/** Category indices by name. */
export const C = Object.freeze(Object.fromEntries(CATS.map((k, i) => [k, i])));
/** What each category holds (reports, docs). */
export const CAT_INFO = {
  guest: 'guest code in translated code, the dispatcher and thread switches',
  api: 'Win32 / Direct3D / D3DX handlers in JavaScript (exclusive of the categories below)',
  draw: "Direct3D draws, clears and StretchRect submitted to WebGL (state, constants, vertex data, the GL call — or recorded for the render worker); blocks when the GPU process is behind",
  interp: 'instructions run by the interpreter (fallbacks of translated code)',
  jit: 'translation of new code on the game thread (first tier, consolidation)',
  ahead: 'learned code regions translated on the game thread while it waits',
  install: 'installing regions translated by the background worker',
  prog: 'GL program builds and resolves (at draws, and ahead)',
  tex: 'texture conversions and uploads, waits for the DXT helpers',
  readback: 'GL readbacks on the game thread',
  io: 'game file reads served from memory or the block store',
  net: 'synchronous game file reads over the network',
  present: 'frame present and hand-off to the page',
  render: 'waits for the render worker (?glworker=1)',
  audio: 'audio mixing / cursor publication on the game thread',
  host: "the worker's own bookkeeping between slices (stats, learning uploads)",
  wait: 'guest threads waiting inside a nested call (pacing)',
  sleep: 'every guest thread waits: the worker sleeps until the next wake-up (pacing)',
  ioWait: 'the worker idle while a parked file read is on the network',
  late: 'the worker resumed later than planned (timer clamping, garbage collection, other tasks)',
};
export const N_CATS = CATS.length;
/** Pacing categories: excluded from a frame's work. */
export const PACING = [C.wait, C.sleep];
/** Frames longer than these (ms) are counted as slow (33.4: a frame of a steady 30 fps is 33.3 ms). */
export const SLOW_MS = 33.4, VERY_SLOW_MS = 50;
/** Sampled sections: mean interval between two timed calls. */
const SAMPLE_EVERY = 16;
/** A timed API call this long (ms, its own time) makes its API timed on every call; ALWAYS_CALLS short ones in a row, sampled again. */
const HEAVY_MS = 0.5, SHORT_MS = 0.05, ALWAYS_CALLS = 1024;

export class FrameAccount {
  /** @param {() => number} [now] clock in ms (performance.now by default) */
  constructor(now = () => performance.now()) {
    this.now = now;
    // time per category since the start (ms; cumulative, so that a section spanning a frame boundary — a timed Present —
    // still measures its own time) and its value at the last frame boundary
    this.acc = new Float64Array(N_CATS); this.base = new Float64Array(N_CATS);
    this.out = new Float64Array(N_CATS); // the last closed frame (estimates applied)
    this.cur = C.host; this.at = now();
    this.rng = 0x2545f491; this.apiLeft = 1; this.interpLeft = 1;
    this.always = new Uint16Array(256); // per API index: timed on every call while non-zero (short calls left before sampling again)
    // per frame: sampled (randomly timed) API calls, their exclusive time, and the calls not timed; same for the interpreter
    this.apiSampledN = 0; this.apiSampledMs = 0; this.drawSampledMs = 0; this.apiUntimedN = 0;
    this.interpSampledN = 0; this.interpSampledMs = 0; this.interpUntimedN = 0;
    // whole-run means per sampled call (frames without a sample use these)
    this.apiMean = 0.002; this.drawMean = 0; this.interpMean = 0.0005; this.apiTotN = 0; this.apiTotMs = 0; this.drawTotMs = 0; this.interpTotN = 0; this.interpTotMs = 0;
    this.heavyApis = 0; // APIs switched to timing on every call
    this.drawAll = 0; this.drawAllFrame = false; this.drawAllSwitches = 0; // every draw timed while non-zero (short draws left)
    this.reads = 0; // clock reads by the accounting itself (its cost: ~0.25 µs each in a Chrome worker)
    // per API index: time and count of its timed calls (with the call counts, an estimate of each API's time)
    this.idxMs = new Float64Array(256); this.idxN = new Float64Array(256); this.idxCalls = new Float64Array(256);
  }
  /** Close the running segment and charge the time from now on to `cat`; returns the category to give leave(). */
  enter(cat) { this.reads++; const t = this.now(); this.acc[this.cur] += t - this.at; this.at = t; const p = this.cur; this.cur = cat; return p; }
  /** Close the running segment and go back to `prev` (enter's result). */
  leave(prev) { this.reads++; const t = this.now(); this.acc[this.cur] += t - this.at; this.at = t; this.cur = prev; }
  /** Move `ms` the current frame already charged to `from` to another category (e.g. a gap's late part). */
  move(from, to, ms) { if (ms <= 0) return; const have = this.acc[from] - this.base[from]; if (ms > have) ms = have; if (ms <= 0) return; this.acc[from] -= ms; this.acc[to] += ms; }
  nextInterval() { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x >>> 0; return 1 + (this.rng % (2 * SAMPLE_EVERY - 1)); }

  /**
   * An API call (thunk index `idx`) is about to run: true when it is timed — then enter(C.api) / apiEnd bracket it.
   * An untimed call is counted (its time stays in the enclosing category until the frame's estimate moves it).
   * Draws are timed (enter(C.draw)) only while `cur` is C.api: inside a timed call.
   */
  apiTimed(idx) {
    if (idx < this.idxCalls.length) this.idxCalls[idx]++; else this.growCalls(idx);
    if (idx < this.always.length && this.always[idx]) return true;
    if (--this.apiLeft > 0) { if (this.cur !== C.api) this.apiUntimedN++; return false; }
    this.apiLeft = this.nextInterval();
    return true;
  }
  /**
   * End a timed API call: `p` enter(C.api)'s result, `a0` / `d0` acc[api] / acc[draw] just after it, `outer` false
   * for a call made while another timed one runs (its time is part of that one's).
   */
  apiEnd(p, idx, a0, d0, outer) {
    this.leave(p);
    if (!outer) return;
    const ms = this.acc[C.api] - a0, draw = this.acc[C.draw] - d0;
    if (idx >= this.idxMs.length) { const m = new Float64Array(Math.max(idx + 1, this.idxMs.length * 2)), n = new Float64Array(m.length); m.set(this.idxMs); n.set(this.idxN); this.idxMs = m; this.idxN = n; }
    this.idxMs[idx] += ms + draw; this.idxN[idx]++;
    if (idx >= this.always.length) { const a = new Uint16Array(Math.max(idx + 1, this.always.length * 2)); a.set(this.always); this.always = a; }
    const al = this.always[idx];
    if (ms >= HEAVY_MS) { if (!al) this.heavyApis++; this.always[idx] = ALWAYS_CALLS; }
    else if (al && ms < SHORT_MS) this.always[idx] = al - 1;
    if (al) return; // (timed because heavy: measured, not a sample)
    this.apiSampledN++; this.apiSampledMs += ms; this.drawSampledMs += draw;
  }
  /** Is the draw about to be submitted timed (then enter(C.draw) / drawEnd bracket it)? */
  drawTimed() { return this.cur === C.api || this.drawAll > 0; }
  /** End a timed draw (`p` enter's result, `d0` acc[draw] just after it). */
  drawEnd(p, d0) {
    this.leave(p);
    const ms = this.acc[C.draw] - d0;
    if (ms >= HEAVY_MS) { if (!this.drawAll) this.drawAllSwitches++; this.drawAll = ALWAYS_CALLS; this.drawAllFrame = true; }
    else if (this.drawAll > 0 && ms < SHORT_MS) this.drawAll--;
  }
  growCalls(idx) { const a = new Float64Array(Math.max(idx + 1, this.idxCalls.length * 2)); a.set(this.idxCalls); this.idxCalls = a; a[idx]++; }
  /** An interpreter fallback: true when this one is timed (then enter(C.interp) / interpEnd(prev, acc[interp]) bracket it). */
  interpTimed() {
    if (--this.interpLeft > 0) { if (this.cur !== C.interp) this.interpUntimedN++; return false; }
    this.interpLeft = this.nextInterval();
    return true;
  }
  interpEnd(p, a0) { this.leave(p); this.interpSampledN++; this.interpSampledMs += this.acc[C.interp] - a0; }

  /**
   * Frame boundary: the categories since the previous one (ms, the untimed calls' estimated time moved from guest
   * code to `api` / `interp`), in a buffer reused by the next call. Starts the next frame.
   */
  frame() {
    this.reads++; this.lastReads = this.reads; this.reads = 0; // (the reads of the frame closed now)
    const t = this.now(); this.acc[this.cur] += t - this.at; this.at = t;
    const a = this.acc, b = this.base, o = this.out;
    if (this.apiSampledN) { this.apiTotN += this.apiSampledN; this.apiTotMs += this.apiSampledMs; this.drawTotMs += this.drawSampledMs; this.apiMean = this.apiTotMs / this.apiTotN; this.drawMean = this.drawTotMs / this.apiTotN; }
    if (this.interpSampledN) { this.interpTotN += this.interpSampledN; this.interpTotMs += this.interpSampledMs; this.interpMean = this.interpTotMs / this.interpTotN; }
    const local = this.apiSampledN >= 8;
    const apiEst = this.apiUntimedN * (local ? this.apiSampledMs / this.apiSampledN : this.apiMean);
    // (every draw timed during this frame: none to estimate)
    const drawEst = this.drawAllFrame ? 0 : this.apiUntimedN * (local ? this.drawSampledMs / this.apiSampledN : this.drawMean);
    this.drawAllFrame = this.drawAll > 0;
    const interpEst = this.interpUntimedN * (this.interpSampledN >= 8 ? this.interpSampledMs / this.interpSampledN : this.interpMean);
    for (let i = 0; i < N_CATS; i++) { o[i] = a[i] - b[i]; b[i] = a[i]; }
    // (the untimed calls ran inside guest code's time: moved from it, never more than it holds)
    let move = apiEst + drawEst + interpEst, k = 1;
    if (move > o[C.guest]) { k = o[C.guest] / move; move = o[C.guest]; }
    o[C.api] += apiEst * k; o[C.draw] += drawEst * k; o[C.interp] += interpEst * k;
    o[C.guest] -= move;
    this.apiSampledN = 0; this.apiSampledMs = 0; this.drawSampledMs = 0; this.apiUntimedN = 0;
    this.interpSampledN = 0; this.interpSampledMs = 0; this.interpUntimedN = 0;
    return o;
  }
}

/** The process-wide stopwatch (one emulator per worker / process). */
export const acct = new FrameAccount();

/** Work of a frame: its categories minus the pacing ones. */
export function workOf(cats) { let w = 0; for (let i = 0; i < N_CATS; i++) w += cats[i]; for (const i of PACING) w -= cats[i]; return w; }

/** `cats` as { name: ms } with the categories of at least `min` ms, largest first, at most `top` of them. */
export function catsObject(cats, min = 0.5, top = N_CATS, scale = 1) {
  const idx = []; for (let i = 0; i < N_CATS; i++) if (cats[i] * scale >= min) idx.push(i);
  idx.sort((x, y) => cats[y] - cats[x]);
  const o = {}; for (const i of idx.slice(0, top)) o[CATS[i]] = Math.round(cats[i] * scale * 10) / 10;
  return o;
}
const fmtCats = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

/**
 * Frame statistics over the accounted frames: per interval (the worker's ~0.5 s stats, telemetry) and per phase
 * (harness marks: frames > 33 / > 50 ms per minute, worst frames, cause breakdown). A phase keeps every frame's
 * duration and categories (up to `ring` frames, the latest ones).
 */
export class FrameStats {
  constructor(ring = 36000) {
    this.ring = ring; this.rec = new Float32Array(ring * (N_CATS + 1)); this.n = 0; this.phaseStart = null; this.label = 'start';
    this.iv = this.newInterval();
  }
  newInterval() { return { reads: 0, frames: 0, slow33: 0, slow50: 0, max: 0, dt: 0, work: 0, cats: new Float64Array(N_CATS), slowCats: new Float64Array(N_CATS), slowN: 0, worst: null }; }
  /** One frame: its duration `dt` (ms) and categories (FrameAccount.frame()); `at`: when it was presented. */
  add(dt, cats, at = 0, reads = 0) {
    const iv = this.iv, w = workOf(cats);
    iv.reads += reads; this.phaseReads = (this.phaseReads ?? 0) + reads;
    if (this.phaseStart === null) this.phaseStart = at - dt;
    iv.frames++; iv.dt += dt; iv.work += w; if (dt > iv.max) iv.max = dt;
    for (let i = 0; i < N_CATS; i++) iv.cats[i] += cats[i];
    if (dt > SLOW_MS) {
      iv.slow33++; iv.slowN++; if (dt > VERY_SLOW_MS) iv.slow50++;
      for (let i = 0; i < N_CATS; i++) iv.slowCats[i] += cats[i];
      if (!iv.worst || dt > iv.worst.dt) iv.worst = { dt, work: w, cats: Float64Array.from(cats) };
    }
    const o = (this.n % this.ring) * (N_CATS + 1);
    this.rec[o] = dt; for (let i = 0; i < N_CATS; i++) this.rec[o + 1 + i] = cats[i];
    this.n++;
  }
  /**
   * The interval since the last call (then reset), compact for telemetry: frames, slow counts, mean work and
   * categories per frame (`c`), the slow frames' categories summed (`sc`) and the worst slow frame (`wf`).
   */
  takeInterval() {
    const iv = this.iv; this.iv = this.newInterval();
    if (!iv.frames) return null;
    const r = { frames: iv.frames, s33: iv.slow33, s50: iv.slow50, max: Math.round(iv.max), w: Math.round(iv.work / iv.frames * 10) / 10, c: catsObject(iv.cats, 0.3, N_CATS, 1 / iv.frames) };
    if (iv.slowN) { r.sc = catsObject(iv.slowCats, 1); r.wf = [Math.round(iv.worst.dt), Math.round(iv.worst.work), catsObject(iv.worst.cats, 1, 5)]; }
    return r;
  }
  /**
   * The phase since the previous mark (then a new one named `label` begins): an object and a text report. Causes of
   * slow frames: their mean categories, and their excess over the phase's median frame per category (shares of the
   * total excess; `dominant`: slow frames counted by their largest excess).
   */
  phase(label, at = 0) {
    const n = Math.min(this.n, this.ring), K = N_CATS + 1, rec = this.rec, start = this.phaseStart;
    const prev = this.label, reads = this.phaseReads ?? 0; this.label = label; this.n = 0; this.phaseStart = at; this.phaseReads = 0;
    if (!n) return { label: prev, frames: 0, text: `phase ${prev}: no frames` };
    const dts = new Float64Array(n), works = new Float64Array(n);
    let total = 0, s33 = 0, s40 = 0, s50 = 0;
    for (let f = 0; f < n; f++) {
      const o = f * K; dts[f] = rec[o]; total += rec[o];
      let w = 0; for (let i = 0; i < N_CATS; i++) w += rec[o + 1 + i]; for (const i of PACING) w -= rec[o + 1 + i]; works[f] = w;
      if (rec[o] > SLOW_MS) { s33++; if (rec[o] > 40) s40++; if (rec[o] > VERY_SLOW_MS) s50++; }
    }
    const seconds = Math.max(total, start !== null && at > start ? at - start : 0) / 1000, minutes = seconds / 60;
    const q = (arr, x) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(x * s.length))]; };
    // per-category median over the phase (the typical frame), mean over all frames and over the slow ones
    const med = new Float64Array(N_CATS), mean = new Float64Array(N_CATS), slowMean = new Float64Array(N_CATS), excess = new Float64Array(N_CATS), dominant = new Float64Array(N_CATS);
    const col = new Float64Array(n);
    for (let i = 0; i < N_CATS; i++) {
      let sum = 0; for (let f = 0; f < n; f++) { col[f] = rec[f * K + 1 + i]; sum += col[f]; }
      mean[i] = sum / n; med[i] = q(col, 0.5);
    }
    const worst = [];
    for (let f = 0; f < n; f++) {
      const o = f * K; if (rec[o] <= SLOW_MS) continue;
      let best = -1, bestV = 0;
      for (let i = 0; i < N_CATS; i++) { const v = rec[o + 1 + i]; slowMean[i] += v; const e = v - med[i]; if (e > 0 && !PACING.includes(i)) { excess[i] += e; if (e > bestV) { bestV = e; best = i; } } }
      if (best >= 0) dominant[best]++;
      worst.push(f);
    }
    if (s33) for (let i = 0; i < N_CATS; i++) slowMean[i] /= s33;
    worst.sort((a, b) => rec[b * K] - rec[a * K]);
    const exTotal = excess.reduce((a, b) => a + b, 0);
    const shares = {}; for (let i = 0; i < N_CATS; i++) if (exTotal > 0 && excess[i] / exTotal >= 0.01) shares[CATS[i]] = Math.round(100 * excess[i] / exTotal);
    const dom = {}; for (let i = 0; i < N_CATS; i++) if (dominant[i]) dom[CATS[i]] = dominant[i];
    const worstFrames = worst.slice(0, 6).map((f) => { const c = rec.subarray(f * K + 1, f * K + K); return { dt: Math.round(rec[f * K]), work: Math.round(works[f]), cats: catsObject(c, 1, 5) }; });
    const r = {
      label: prev, frames: n, seconds: Math.round(seconds * 10) / 10, fps: Math.round(n / Math.max(1e-3, seconds) * 10) / 10,
      slow33: s33, slow40: s40, slow50: s50, per33: Math.round(s33 / Math.max(1e-6, minutes)), per40: Math.round(s40 / Math.max(1e-6, minutes)), per50: Math.round(s50 / Math.max(1e-6, minutes)),
      clockReads: Math.round(reads / n),
      dt: { p50: Math.round(q(dts, 0.5) * 10) / 10, p90: Math.round(q(dts, 0.9) * 10) / 10, p99: Math.round(q(dts, 0.99) * 10) / 10, max: Math.round(q(dts, 1)) },
      work: { p50: Math.round(q(works, 0.5) * 10) / 10, p90: Math.round(q(works, 0.9) * 10) / 10, p99: Math.round(q(works, 0.99) * 10) / 10 },
      mean: catsObject(mean, 0.1), slowMean: catsObject(slowMean, 0.1), excessShares: shares, dominant: dom, worst: worstFrames,
    };
    r.text = `phase ${prev}: ${n} frames in ${r.seconds} s (${r.fps} fps); >33 ms ${s33} (${r.per33}/min), >40 ms ${s40} (${r.per40}/min), >50 ms ${s50} (${r.per50}/min); frame ms p50 ${r.dt.p50} p90 ${r.dt.p90} p99 ${r.dt.p99} max ${r.dt.max}; work ms p50 ${r.work.p50} p90 ${r.work.p90} p99 ${r.work.p99}; accounting ${r.clockReads} clock reads per frame\n` +
      `  mean frame (ms): ${fmtCats(r.mean)}\n` +
      (s33 ? `  slow frames, mean (ms): ${fmtCats(r.slowMean)}\n  slow frames, excess over the median frame (% of the excess): ${fmtCats(shares)}; largest excess per slow frame: ${fmtCats(dom)}\n` +
        `  worst: ${worstFrames.map((w) => `${w.dt} ms (work ${w.work}: ${fmtCats(w.cats)})`).join('; ')}` : '  no slow frames');
    return r;
  }
}

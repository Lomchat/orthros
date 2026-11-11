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
// The game file reads (`io`, up to 2 M per load, ~1.5 us each) are sampled the same way when they run from guest code
// (an untimed ReadFile): 1 call in ~16 timed, the others counted and estimated at the frame's close; a read inside a timed
// API call is timed exactly, and reads of 0.5 ms or more switch to timing every read (as `always`). ORTHROS_ACCT_SAMPLE=0
// (dbg:) times every read: the exact reference.
//
// Pacing (`wait`, `sleep`) is the game's own frame pacing — guest threads waiting for their timers — not work: a
// frame's work is its duration minus those.

/** Category names, in their index order (telemetry and reports use these names). */
export const CATS = ['guest', 'api', 'draw', 'interp', 'jit', 'ahead', 'install', 'prog', 'tex', 'readback', 'io', 'net', 'present', 'render', 'audio', 'host', 'wait', 'sleep', 'ioWait', 'late', 'task'];
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
  ioWait: 'guest threads waiting for a file read on the network (the worker idle, or a nested wait for a read)',
  late: 'the worker resumed later than planned (timer clamping, garbage collection, untracked tasks), or a host wait woke after its deadline (a coarse host timer)',
  task: "the worker's own event-loop tasks between two pumps (a fetch's block installs, messages from the page and the helpers): measured, no longer part of late / ioWait / sleep",
};
export const N_CATS = CATS.length;
/** Pacing categories: excluded from a frame's work. */
export const PACING = [C.wait, C.sleep];
/** Frames longer than these (ms) are counted as slow (33.4: a frame of a steady 30 fps is 33.3 ms). */
export const SLOW_MS = 33.4, VERY_SLOW_MS = 50;
/** a hitch: a frame of this length or more (phase reports count them by their largest category) */
export const HITCH_MS = 150;
/**
 * Frame-time histogram (telemetry summaries, bench phases, GPU time): bucket indices for a duration in ms — 1 ms wide
 * below 100 ms, 5 ms to 300, 25 ms to 1000, 250 ms to 5000, then one open bucket. Incrementing one is the only
 * per-frame work; percentiles are read from the counts (resolution: the bucket's width).
 */
export const HIST_N = 185;
/** @param {number} ms */
export function histBucket(ms) {
  if (!(ms > 0)) return 0;
  if (ms < 100) return Math.floor(ms);
  if (ms < 300) return 100 + Math.floor((ms - 100) / 5);
  if (ms < 1000) return 140 + Math.floor((ms - 300) / 25);
  if (ms < 5000) return 168 + Math.floor((ms - 1000) / 250);
  return 184;
}
/** The upper bound of bucket `b` (ms; Infinity for the open one). */
export function histUpper(b) { return b < 100 ? b + 1 : b < 140 ? 100 + (b - 99) * 5 : b < 168 ? 300 + (b - 139) * 25 : b < 184 ? 1000 + (b - 167) * 250 : Infinity; }
/**
 * The `q` quantile of the durations counted in `hist` (dense counts), as FrameStats.phase reads it from sorted
 * durations (the element at floor(q * n)): the upper bound of its bucket, never above `max` (the largest duration,
 * when known). null without frames.
 */
export function histQuantile(hist, q, max = Infinity) {
  let n = 0; for (let i = 0; i < hist.length; i++) n += hist[i];
  if (!n) return null;
  const k = Math.min(n - 1, Math.floor(q * n));
  let c = 0;
  for (let i = 0; i < hist.length; i++) { c += hist[i]; if (c > k) return Math.min(histUpper(i), max); }
  return max;
}
/** Dense counts as a flat list of [bucket, count] pairs (the non-empty buckets). */
export function histSparse(hist) { const out = []; for (let i = 0; i < hist.length; i++) if (hist[i]) out.push(i, hist[i]); return out; }
/** Add a sparse list (histSparse) into dense counts. */
export function histAddSparse(dense, sparse) { for (let i = 0; i + 1 < (sparse?.length ?? 0); i += 2) if (sparse[i] >= 0 && sparse[i] < dense.length) dense[sparse[i]] += sparse[i + 1]; return dense; }

/**
 * Sampled sections: mean interval between two timed calls (SAMPLE_EVERY at least; a section called thousands of times a
 * frame — ReadFile in a load: 8 000 — is sampled less often, SAMPLE_TARGET timed calls a frame are enough: see `every`).
 */
const SAMPLE_EVERY = 16, SAMPLE_TARGET = 128, SAMPLE_MAX_EVERY = 256;
/** the mean interval for a section called `n` times in the last frame */
const every = (n) => Math.max(SAMPLE_EVERY, Math.min(SAMPLE_MAX_EVERY, Math.round(n / SAMPLE_TARGET)));
/** A timed API call this long (ms, its own time) makes its API timed on every call; ALWAYS_CALLS short ones in a row, sampled again. */
const HEAVY_MS = 0.5, SHORT_MS = 0.05, ALWAYS_CALLS = 1024;
/**
 * An API timed on every call (above) is timed exactly for this many calls per frame; the rest of the frame's calls of
 * that API are sampled (1 in ~16) and estimated from that API's own samples (a stratum of its own, not the mean of all
 * APIs). Bounds the clock reads of a very frequent API with the odd heavy call (ReadFile: 1.5 M calls in a load, a
 * big read now and then kept it timed on every call, 2 clock reads each). ORTHROS_ACCT_SAMPLE=0: no cap.
 */
const ALWAYS_FRAME_CAP = 48, CAP_DECAY = 0.98;

export class FrameAccount {
  /** @param {() => number} [now] clock in ms (performance.now by default) */
  constructor(now = () => performance.now()) {
    this.now = now;
    // time per category since the start (ms; cumulative, so that a section spanning a frame boundary — a timed Present —
    // still measures its own time) and its value at the last frame boundary
    this.acc = new Float64Array(N_CATS); this.base = new Float64Array(N_CATS);
    this.out = new Float64Array(N_CATS); // the last closed frame (estimates applied)
    this.cur = C.host; this.at = now(); this.on = true;
    this.gap = { cat: -1, planned: 0, at: 0, acc0: 0, task0: 0, early: false }; // (gapBegin / gapEnd)
    this.rng = 0x2545f491; this.apiLeft = 1; this.interpLeft = 1;
    this.alwaysFrame = new Uint32Array(256); this.capLeft = new Uint16Array(256); this.capN = new Float64Array(256); this.capMs = new Float64Array(256); this.capDrawMs = new Float64Array(256); this.capUntimed = new Float64Array(256); this.capSumN = new Float64Array(256); this.capSumMs = new Float64Array(256); this.capSumDraw = new Float64Array(256); this.capList = [];
    this.always = new Uint16Array(256); // per API index: timed on every call while non-zero (short calls left before sampling again)
    // per frame: sampled (randomly timed) API calls, their exclusive time, and the calls not timed; same for the interpreter
    this.apiSampledN = 0; this.apiSampledMs = 0; this.drawSampledMs = 0; this.apiUntimedN = 0;
    this.interpSampledN = 0; this.interpSampledMs = 0; this.interpUntimedN = 0;
    // whole-run means per sampled call (frames without a sample use these)
    this.apiMean = 0.002; this.drawMean = 0; this.interpMean = 0.0005; this.apiTotN = 0; this.apiTotMs = 0; this.drawTotMs = 0; this.interpTotN = 0; this.interpTotMs = 0;
    this.nestApi = 0; this.nestDraw = 0; // own api / draw time of every timed outer call so far (apiEnd: a call's nested ones taken out)
    this.heavyApis = 0; // APIs switched to timing on every call
    this.drawAll = 0; this.drawAllFrame = false; this.drawAllSwitches = 0; // every draw timed while non-zero (short draws left)
    this.sampleOn = true; this.apiEvery = SAMPLE_EVERY; this.interpEvery = SAMPLE_EVERY; this.ioEvery = SAMPLE_EVERY; this.ioLeft = 1; this.ioAll = 0; this.ioSampledN = 0; this.ioSampledMs = 0; this.ioUntimedN = 0; this.ioMean = 0.001; this.ioTotN = 0; this.ioTotMs = 0;
    this.reads = 0; // clock reads by the accounting itself (its cost: ~0.25 µs each in a Chrome worker)
    // per API index: time and count of its timed calls (with the call counts, an estimate of each API's time)
    this.idxMs = new Float64Array(256); this.idxN = new Float64Array(256); this.idxCalls = new Float64Array(256);
  }
  /**
   * Measurement switch (harness dbg:ORTHROS_ACCT_OFF=1): `now` null stops reading the clock (every section then lasts
   * 0 ms) — the accounting's cost compared within one session; a function restores it.
   */
  setClock(now) { if (now) { this.now = now; this.at = now(); this.on = true; } else { this.at = this.now(); this.now = () => this.at; this.on = false; } }
  /** The time of the last section boundary (enter / leave), or the clock when the accounting's clock is off (callers timing their own stats with it). */
  stamp() { return this.on ? this.at : performance.now(); }
  /** Close the running segment and charge the time from now on to `cat`; returns the category to give leave(). */
  enter(cat) { this.reads++; const t = this.now(); this.acc[this.cur] += t - this.at; this.at = t; const p = this.cur; this.cur = cat; return p; }
  /** Close the running segment and go back to `prev` (enter's result). */
  leave(prev) { this.reads++; const t = this.now(); this.acc[this.cur] += t - this.at; this.at = t; this.cur = prev; }
  /** Move `ms` the current frame already charged to `from` to another category (e.g. a gap's late part). */
  move(from, to, ms) { if (ms <= 0) return; const have = this.acc[from] - this.base[from]; if (ms > have) ms = have; if (ms <= 0) return; this.acc[from] -= ms; this.acc[to] += ms; }
  nextInterval(every = SAMPLE_EVERY) { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x >>> 0; return 1 + (this.rng % (2 * every - 1)); }

  /**
   * An API call (thunk index `idx`) is about to run: true when it is timed — then enter(C.api) / apiEnd bracket it.
   * An untimed call is counted (its time stays in the enclosing category until the frame's estimate moves it).
   * Draws are timed (enter(C.draw)) only while `cur` is C.api: inside a timed call.
   */
  apiTimed(idx) {
    if (idx < this.idxCalls.length) this.idxCalls[idx]++; else this.growCalls(idx);
    if (idx < this.always.length && this.always[idx]) {
      if (!this.sampleOn || ++this.alwaysFrame[idx] <= ALWAYS_FRAME_CAP) return true;
      // (over the frame's cap: sampled, with the API's own estimate)
      if (this.alwaysFrame[idx] === ALWAYS_FRAME_CAP + 1) this.capList.push(idx);
      if (this.capLeft[idx] > 1) { this.capLeft[idx]--; if (this.cur !== C.api) this.capUntimed[idx]++; return false; }
      this.capLeft[idx] = this.nextInterval(this.apiEvery);
      return true;
    }
    if (--this.apiLeft > 0) { if (this.cur !== C.api) this.apiUntimedN++; return false; }
    this.apiLeft = this.nextInterval(this.apiEvery);
    return true;
  }
  /**
   * End a timed API call: `p` enter(C.api)'s result, `a0` / `d0` acc[api] / acc[draw] just after it, `outer` false
   * for a call made while another timed one runs (its time is part of that one's). `n0` / `m0`: nestApi / nestDraw
   * just after it — the timed calls made from guest code it ran (a callback, a nested wait running other threads)
   * measured their own time: it is not this call's.
   */
  apiEnd(p, idx, a0, d0, outer, n0 = this.nestApi, m0 = this.nestDraw) {
    this.leave(p);
    if (!outer) return;
    const ms = this.acc[C.api] - a0 - (this.nestApi - n0), draw = this.acc[C.draw] - d0 - (this.nestDraw - m0);
    this.nestApi += ms; this.nestDraw += draw;
    if (idx >= this.idxMs.length) { const m = new Float64Array(Math.max(idx + 1, this.idxMs.length * 2)), n = new Float64Array(m.length); m.set(this.idxMs); n.set(this.idxN); this.idxMs = m; this.idxN = n; }
    this.idxMs[idx] += ms + draw; this.idxN[idx]++;
    if (idx >= this.always.length) { const a = new Uint16Array(Math.max(idx + 1, this.always.length * 2)); a.set(this.always); this.always = a; for (const k of ['alwaysFrame', 'capLeft']) { const u = new this[k].constructor(a.length); u.set(this[k]); this[k] = u; } for (const k of ['capN', 'capMs', 'capDrawMs', 'capUntimed', 'capSumN', 'capSumMs', 'capSumDraw']) { const f = new Float64Array(a.length); f.set(this[k]); this[k] = f; } }
    const al = this.always[idx];
    if (ms >= HEAVY_MS) { if (!al) this.heavyApis++; this.always[idx] = ALWAYS_CALLS; }
    else if (al && ms < SHORT_MS) this.always[idx] = al - 1;
    if (al) { // (timed because heavy: measured, not a sample — except over the frame's cap, a sample of the API's own)
      if (this.sampleOn && this.alwaysFrame[idx] > ALWAYS_FRAME_CAP) { this.capN[idx]++; this.capMs[idx] += ms; this.capDrawMs[idx] += draw; }
      return;
    }
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
  /**
   * A game file read is about to run: 0 when it is not timed (counted: its time stays in the enclosing category until the
   * frame's estimate moves it), 1 when it is timed (enter(C.io) / ioEnd(prev, acc[io], 1)), 2 when it is a timed sample.
   * Only a read made from guest code is sampled; one inside a timed API call or any other section is timed exactly.
   */
  ioTimed() {
    if (!this.sampleOn || this.cur !== C.guest || this.ioAll > 0) return 1;
    if (--this.ioLeft > 0) { this.ioUntimedN++; return 0; }
    this.ioLeft = this.nextInterval(this.ioEvery);
    return 2;
  }
  ioEnd(p, a0, kind) {
    this.leave(p);
    const ms = this.acc[C.io] - a0;
    if (kind === 2) { this.ioSampledN++; this.ioSampledMs += ms; }
    if (ms >= HEAVY_MS) this.ioAll = ALWAYS_CALLS; else if (this.ioAll > 0 && ms < SHORT_MS) this.ioAll--;
  }
  /**
   * An event-loop task of the worker starts (a fetch's block install, a message): while the worker is in a gap between two
   * pumps (late / ioWait / sleep) its time is charged to `task`; elsewhere (nested in guest code) nothing changes.
   * Returns what taskEnd takes, or -1.
   */
  taskStart() { const c = this.cur; return c === C.late || c === C.ioWait || c === C.sleep ? this.enter(C.task) : -1; }
  taskEnd(p) { if (p >= 0) this.leave(p); }
  /**
   * The worker waits between two pumps: charge the gap to `cat` (sleep / ioWait / late). `planned` ms of it are the
   * planned wait (Infinity: open-ended, a wait for a file read); the time beyond it, event-loop tasks excepted, becomes
   * `late` at gapEnd, unless `early` (a pacing loop's earlier wait: waking late does not lengthen the frame).
   */
  gapBegin(cat, planned, early) {
    this.enter(cat);
    const g = this.gap; g.cat = cat; g.planned = planned; g.at = this.at; g.acc0 = this.acc[cat]; g.task0 = this.acc[C.task]; g.early = early;
  }
  /** The next pump starts: the time is the host's again, lateness moved out of the gap's category. */
  gapEnd() {
    this.enter(C.host);
    const g = this.gap;
    if (g.cat < 0) return;
    const over = this.at - g.at - g.planned - (this.acc[C.task] - g.task0);
    if (over > 0 && g.cat !== C.late && !g.early) this.move(g.cat, C.late, Math.min(over, this.acc[g.cat] - g.acc0));
    g.cat = -1;
  }
  /** An interpreter fallback: true when this one is timed (then enter(C.interp) / interpEnd(prev, acc[interp]) bracket it). */
  interpTimed() {
    if (--this.interpLeft > 0) { if (this.cur !== C.interp) this.interpUntimedN++; return false; }
    this.interpLeft = this.nextInterval(this.interpEvery);
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
    this.sampleOn = !(globalThis.ORTHROS_ACCT_SAMPLE === 0 || globalThis.ORTHROS_ACCT_SAMPLE === '0' || globalThis.ORTHROS_ACCT_SAMPLE === false);
    // (the next frame's sampling intervals follow this frame's call counts; with the switch off, the fixed one)
    if (this.sampleOn) { this.apiEvery = every(this.apiUntimedN + this.apiSampledN); this.interpEvery = every(this.interpUntimedN + this.interpSampledN); this.ioEvery = every(this.ioUntimedN + this.ioSampledN); }
    else { this.apiEvery = this.interpEvery = this.ioEvery = SAMPLE_EVERY; }
    if (this.apiSampledN) { this.apiTotN += this.apiSampledN; this.apiTotMs += this.apiSampledMs; this.drawTotMs += this.drawSampledMs; this.apiMean = this.apiTotMs / this.apiTotN; this.drawMean = this.drawTotMs / this.apiTotN; }
    if (this.interpSampledN) { this.interpTotN += this.interpSampledN; this.interpTotMs += this.interpSampledMs; this.interpMean = this.interpTotMs / this.interpTotN; }
    if (this.ioSampledN) { this.ioTotN += this.ioSampledN; this.ioTotMs += this.ioSampledMs; this.ioMean = this.ioTotMs / this.ioTotN; }
    const ioEst = this.ioUntimedN * (this.ioSampledN >= 8 ? this.ioSampledMs / this.ioSampledN : this.ioMean);
    // (the capped APIs' own estimates: their calls over the frame's cap that were not timed)
    let capApi = 0, capDraw = 0;
    for (const i of this.capList) {
      // (the API's mean over its last ~50 capped frames: one sample of a rare heavy call in a frame's ~120 would be scaled
      // by ~2000 calls, and the frame's estimate clipped by the guest time it can be taken from)
      const sn = this.capSumN[i] = this.capSumN[i] * CAP_DECAY + this.capN[i], sm = this.capSumMs[i] = this.capSumMs[i] * CAP_DECAY + this.capMs[i], sd = this.capSumDraw[i] = this.capSumDraw[i] * CAP_DECAY + this.capDrawMs[i];
      const n = this.capUntimed[i];
      if (n && sn) { capApi += n * sm / sn; capDraw += n * sd / sn; }
      this.capN[i] = 0; this.capMs[i] = 0; this.capDrawMs[i] = 0; this.capUntimed[i] = 0; this.capLeft[i] = 0;
    }
    this.capList.length = 0; this.alwaysFrame.fill(0);
    const local = this.apiSampledN >= 8;
    const apiEst = capApi + this.apiUntimedN * (local ? this.apiSampledMs / this.apiSampledN : this.apiMean);
    // (every draw timed during this frame: none to estimate)
    const drawEst = capDraw + (this.drawAllFrame ? 0 : this.apiUntimedN * (local ? this.drawSampledMs / this.apiSampledN : this.drawMean));
    this.drawAllFrame = this.drawAll > 0;
    const interpEst = this.interpUntimedN * (this.interpSampledN >= 8 ? this.interpSampledMs / this.interpSampledN : this.interpMean);
    for (let i = 0; i < N_CATS; i++) { o[i] = a[i] - b[i]; b[i] = a[i]; }
    // (the untimed calls ran inside guest code's time: moved from it, never more than it holds)
    let move = apiEst + drawEst + interpEst + ioEst, k = 1;
    if (move > o[C.guest]) { k = o[C.guest] / move; move = o[C.guest]; }
    o[C.api] += apiEst * k; o[C.draw] += drawEst * k; o[C.interp] += interpEst * k; o[C.io] += ioEst * k;
    o[C.guest] -= move;
    this.apiSampledN = 0; this.apiSampledMs = 0; this.drawSampledMs = 0; this.apiUntimedN = 0;
    this.interpSampledN = 0; this.interpSampledMs = 0; this.interpUntimedN = 0;
    this.ioSampledN = 0; this.ioSampledMs = 0; this.ioUntimedN = 0;
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
  newInterval() { return { reads: 0, frames: 0, slow33: 0, slow40: 0, slow50: 0, slow100: 0, hist: new Uint16Array(HIST_N), max: 0, dt: 0, work: 0, cats: new Float64Array(N_CATS), slowCats: new Float64Array(N_CATS), slowN: 0, worst: null }; }
  /** One frame: its duration `dt` (ms) and categories (FrameAccount.frame()); `at`: when it was presented. */
  add(dt, cats, at = 0, reads = 0) {
    const iv = this.iv, w = workOf(cats);
    iv.reads += reads; this.phaseReads = (this.phaseReads ?? 0) + reads;
    if (this.phaseStart === null) this.phaseStart = at - dt;
    iv.frames++; iv.dt += dt; iv.work += w; if (dt > iv.max) iv.max = dt; iv.hist[histBucket(dt)]++;
    for (let i = 0; i < N_CATS; i++) iv.cats[i] += cats[i];
    if (dt > SLOW_MS) {
      iv.slow33++; iv.slowN++; if (dt > 40) iv.slow40++; if (dt > VERY_SLOW_MS) iv.slow50++; if (dt > 100) iv.slow100++;
      for (let i = 0; i < N_CATS; i++) iv.slowCats[i] += cats[i];
      if (!iv.worst || dt > iv.worst.dt) iv.worst = { dt, work: w, cats: Float64Array.from(cats) };
    }
    const o = (this.n % this.ring) * (N_CATS + 1);
    this.rec[o] = dt; for (let i = 0; i < N_CATS; i++) this.rec[o + 1 + i] = cats[i];
    this.n++;
  }
  /**
   * The interval since the last call (then reset), compact for telemetry: frames, slow counts, mean work and
   * categories per frame (`c`), the slow frames' categories summed (`sc`) and the worst slow frame (`wf`); frames
   * > 40 / > 100 ms (`s40`, `s100`) and the frame-time histogram (`h`, histSparse) for the page's summaries.
   */
  takeInterval() {
    const iv = this.iv; this.iv = this.newInterval();
    if (!iv.frames) return null;
    const r = { frames: iv.frames, s33: iv.slow33, s40: iv.slow40, s50: iv.slow50, s100: iv.slow100, h: histSparse(iv.hist), max: Math.round(iv.max), w: Math.round(iv.work / iv.frames * 10) / 10, c: catsObject(iv.cats, 0.3, N_CATS, 1 / iv.frames) };
    if (iv.slowN) { r.sc = catsObject(iv.slowCats, 1); r.wf = [Math.round(iv.worst.dt), Math.round(iv.worst.work), catsObject(iv.worst.cats, 1, 5)]; }
    return r;
  }
  /**
   * The phase since the previous mark (then a new one named `label` begins): an object and a text report. Causes of
   * slow frames: their mean categories, and their excess over the phase's median frame per category (shares of the
   * total excess; `dominant`: slow frames counted by their largest excess).
   */
  phase(label, at = 0) {
    // (a phase longer than the ring: its rates are those of the frames kept, over their own time)
    const all = this.n, n = Math.min(all, this.ring), K = N_CATS + 1, rec = this.rec, start = all > this.ring ? null : this.phaseStart;
    const prev = this.label, reads = this.phaseReads ?? 0; this.label = label; this.n = 0; this.phaseStart = at; this.phaseReads = 0;
    if (!n) return { label: prev, frames: 0, text: `phase ${prev}: no frames` };
    const dts = new Float64Array(n), works = new Float64Array(n);
    let total = 0, s33 = 0, s40 = 0, s50 = 0, s100 = 0, paced = 0;
    for (let f = 0; f < n; f++) {
      const o = f * K; dts[f] = rec[o]; total += rec[o];
      let w = 0; for (let i = 0; i < N_CATS; i++) w += rec[o + 1 + i]; for (const i of PACING) w -= rec[o + 1 + i]; works[f] = w;
      // (paced: a slow frame whose work fits in SLOW_MS — its length is waiting: the game's own frame limiter waking a
      // little late, e.g. a 30 fps game's 33.3 ms frames by 1-2 ms of Sleep granularity, as on Windows)
      if (rec[o] > SLOW_MS) { s33++; if (rec[o] > 40) s40++; if (rec[o] > VERY_SLOW_MS) s50++; if (rec[o] > 100) s100++; if (w <= SLOW_MS) paced++; }
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
    const worst = [], hitches = {};
    for (let f = 0; f < n; f++) {
      const o = f * K; if (rec[o] <= SLOW_MS) continue;
      // (hitches: frames of HITCH_MS and more, counted by their largest category)
      if (rec[o] >= HITCH_MS) { let top = 0; for (let i = 1; i < N_CATS; i++) if (rec[o + 1 + i] > rec[o + 1 + top]) top = i; hitches[CATS[top]] = (hitches[CATS[top]] ?? 0) + 1; }
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
      slow100: s100, per100: Math.round(s100 / Math.max(1e-6, minutes) * 10) / 10,
      slowPaced: paced,
      clockReads: Math.round(reads / all),
      dt: { p50: Math.round(q(dts, 0.5) * 10) / 10, p90: Math.round(q(dts, 0.9) * 10) / 10, p99: Math.round(q(dts, 0.99) * 10) / 10, max: Math.round(q(dts, 1)) },
      work: { p50: Math.round(q(works, 0.5) * 10) / 10, p90: Math.round(q(works, 0.9) * 10) / 10, p99: Math.round(q(works, 0.99) * 10) / 10 },
      mean: catsObject(mean, 0.1), slowMean: catsObject(slowMean, 0.1), excessShares: shares, dominant: dom, worst: worstFrames, hitches,
    };
    r.text = `phase ${prev}: ${n} frames in ${r.seconds} s (${r.fps} fps); >33 ms ${s33} (${r.per33}/min${s33 ? `, ${paced} of them paced: work under ${SLOW_MS} ms` : ''}), >40 ms ${s40} (${r.per40}/min), >50 ms ${s50} (${r.per50}/min), >100 ms ${s100} (${r.per100}/min); frame ms p50 ${r.dt.p50} p90 ${r.dt.p90} p99 ${r.dt.p99} max ${r.dt.max}; work ms p50 ${r.work.p50} p90 ${r.work.p90} p99 ${r.work.p99}; accounting ${r.clockReads} clock reads per frame\n` +
      `  mean frame (ms): ${fmtCats(r.mean)}\n` +
      (s33 ? `  slow frames, mean (ms): ${fmtCats(r.slowMean)}\n  slow frames, excess over the median frame (% of the excess): ${fmtCats(shares)}; largest excess per slow frame: ${fmtCats(dom)}\n` +
        `  worst: ${worstFrames.map((w) => `${w.dt} ms (work ${w.work}: ${fmtCats(w.cats)})`).join('; ')}` +
        (Object.keys(hitches).length ? `\n  frames of ${HITCH_MS} ms and more by their largest category: ${fmtCats(hitches)}` : '') : '  no slow frames');
    return r;
  }
}

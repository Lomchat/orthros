// Adaptive internal render resolution of the Direct3D 8/9 backend (docs/render-worker.md section 9).
//
// On a machine without a GPU (the WebGL renderer is a software rasterizer: SwiftShader, llvmpipe, Microsoft Basic
// Render...) the browser's GPU process rasterizes on the CPU and the frame's pixel work dominates. The backend then
// draws the back buffers — and the render targets of their size (a game's screen-sized post-processing targets) — into
// GL storage `s` times smaller in each direction, and upscales the back buffer to the canvas at present. Everything the
// game sees keeps the Direct3D sizes: surface descriptions, viewports, scissor and clear rectangles, StretchRect
// rectangles and readbacks (read back at full size, upsampled); only the picture's sharpness changes.
//
// This module holds the coordinate mapping (pure functions, tested) and the controller: per presented frame its
// render time — the backend's busy time between two presents: the render worker's replay, the GL calls blocked while
// the GPU process is behind included (it is behind whenever the rasterizer is the bottleneck) — against the frame
// budget. The scale steps down when the frames are render-bound for ~1.5 s, up when the next step's predicted render
// time stays comfortably under the budget for ~4 s; a step down that did not lower the render time is undone. (A fence
// after the present was tried as a measure of the GPU work left: Chrome updates a sync object's status between tasks of
// the worker's event loop, which a busy render worker reaches late — seconds measured, useless.)
//
// ORTHROS_RENDER_SCALE (worker debug global, switchable within a session): 'auto' (default: on a software GPU only),
// 'off', or a number in (0, 1] (that fixed scale, on any GPU — testing). ORTHROS_RENDER_BUDGET: the frame budget in ms
// (default 1000/30).

/** the scales the controller moves through, largest first (never below the last) */
export const SCALE_STEPS = Object.freeze([1, 0.85, 0.75, 0.6, 0.5]);
/** a fixed scale's lower bound */
const FIXED_MIN = 0.25;
/** frames render-bound this long before a step down; under budget this long before a step up (ms) */
const DOWN_MS = 1500, UP_MS = 4000;
/** after a change, the frames of this long are not judged (their GL work straddles the change) */
const SETTLE_MS = 500;
/** a step down that brought no gain is undone and the next one waits this long (ms) */
const NO_GAIN_HOLD_MS = 30000, MAX_HOLD_MS = 600000;
/** a step down is judged over the frames of this long after it (ms) */
const GAIN_MS = 3000;

/** GL size of a Direct3D size `w` at scale `k` */
export const scaledSize = (w, k) => (k === 1 ? w : Math.max(1, Math.round(w * k)));

/**
 * The GL window rectangle [x, y, w, h] of a Direct3D rectangle (l, t, r, b) on a target of Direct3D height `dh`: rows
 * flipped (GL rows go up) unless `flip` (texture targets are drawn y-flipped, their rows in Direct3D order), each edge
 * scaled by kx / ky and rounded — adjacent rectangles stay adjacent.
 */
export function glRect(l, t, r, b, dh, flip, kx, ky, out = [0, 0, 0, 0]) {
  const y0 = flip ? t : dh - b, y1 = flip ? b : dh - t;
  const X0 = kx === 1 ? l : Math.round(l * kx), X1 = kx === 1 ? r : Math.round(r * kx);
  const Y0 = ky === 1 ? y0 : Math.round(y0 * ky), Y1 = ky === 1 ? y1 : Math.round(y1 * ky);
  out[0] = X0; out[1] = Y0; out[2] = X1 - X0; out[3] = Y1 - Y0;
  return out;
}
/** a Direct3D column `x` of target `f` (bindTarget's record) in its GL storage */
export const glEdgeX = (f, x) => (f.kx === 1 ? x : Math.round(x * f.kx));
/** a Direct3D row edge `y` of target `f` in its GL storage (GL rows up unless the target is y-flipped) */
export const glEdgeY = (f, y) => { const v = f.flip ? y : f.dh - y; return f.ky === 1 ? v : Math.round(v * f.ky); };

/**
 * GL size of mip level `level` of a texture whose level 0 is (w0, h0) Direct3D texels, stored at scale `k`: level 0 scaled,
 * the others halved from it as GL requires of a complete texture.
 */
export function scaledLevel(w0, h0, k, level) {
  const w = scaledSize(w0, k), h = scaledSize(h0, k);
  return [Math.max(1, w >> level), Math.max(1, h >> level)];
}

/** Nearest-texel resample of RGBA8 pixels (a scaled texture level uploaded from guest memory: a rare path). */
export function resampleRgba(src, w, h, dw, dh) {
  const out = new Uint8Array(dw * dh * 4), s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), d32 = new Uint32Array(out.buffer);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / dh)) * w;
    for (let x = 0; x < dw; x++) d32[y * dw + x] = s32[sy + Math.min(w - 1, Math.floor((x + 0.5) * w / dw))];
  }
  return out;
}

/** The mode a value of ORTHROS_RENDER_SCALE asks for: { mode: 'auto' | 'off' | 'fixed', s } (software: no GPU). */
export function scaleMode(v, software) {
  if (v === 'off' || v === 0 || v === '0' || v === false) return { mode: 'off', s: 1 };
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' && v !== 'auto' ? Number(v) : NaN;
  if (n > 0 && n <= 1) return { mode: 'fixed', s: Math.max(FIXED_MIN, n) };
  return software ? { mode: 'auto', s: null } : { mode: 'off', s: 1 };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * The decision part (no GL): frames measured (`add`) and the scale to use next (`decide`). Hysteresis: down only when the
 * frames are over budget *and* their render time is most of the frame (the render is what holds them), up only when the
 * next step's predicted render time — the measured one times the pixel ratio, an overestimate as part of it does not
 * scale with pixels — stays under 75 % of the budget: after a step up the frames are under budget, so they do not step
 * down again.
 */
export class ScaleController {
  constructor() { this.samples = []; this.changedAt = -Infinity; this.downFrom = null; this.noDownUntil = -Infinity; this.hold = 0; this.kept = 0; this.undone = 0; }
  /** the frame presented at `t` (scale `s`): `interval` since the previous present, `render` its render time (ms) */
  add(t, s, interval, render) {
    this.samples.push({ t, s, i: interval, r: render });
    while (this.samples.length > 256 || (this.samples.length && this.samples[0].t < t - 2 * UP_MS)) this.samples.shift();
  }
  /** the scale changed at `now`: the frames measured before it no longer count */
  changed(now) { this.changedAt = now; this.samples.length = 0; }
  /** the scale for the next frames (`s` the current one, `budget` the frame budget in ms) */
  decide(now, s, budget) {
    const since = now - this.changedAt;
    const window = (ms) => this.samples.filter((x) => x.s === s && x.t >= now - ms && x.t >= this.changedAt + SETTLE_MS);
    const k = SCALE_STEPS.indexOf(s);
    // the verdict on the last step down: neither the render time nor the frame interval lower by 8 % (the frames bound
    // by work that does not scale with pixels — vertices, uploads, the replay, the emulator itself): undone, and the
    // next step down waits, twice longer at each such verdict (30 s, 1 min, ... 10 min: no oscillation)
    if (this.downFrom) {
      if (since < GAIN_MS + SETTLE_MS) return s;
      const w = window(GAIN_MS);
      if (w.length < 3) return s;
      const from = this.downFrom, r = median(w.map((x) => x.r)), i = median(w.map((x) => x.i));
      this.downFrom = null;
      if (r > 0.92 * from.r && i > 0.92 * from.i) { this.hold = Math.min(MAX_HOLD_MS, this.hold ? 2 * this.hold : NO_GAIN_HOLD_MS); this.noDownUntil = now + this.hold; this.undone++; return from.s; }
      this.kept++;
    }
    if (since >= DOWN_MS + SETTLE_MS && k >= 0 && k < SCALE_STEPS.length - 1 && now >= this.noDownUntil) {
      const w = window(DOWN_MS);
      if (w.length >= 3) {
        const r = median(w.map((x) => x.r)), i = median(w.map((x) => x.i));
        if (r > budget && i > budget * 1.05 && r >= 0.75 * i) { this.downFrom = { s, r, i }; return SCALE_STEPS[k + 1]; }
      }
    }
    if (since >= UP_MS + SETTLE_MS && k > 0) {
      const w = window(UP_MS);
      if (w.length >= 6) {
        const up = SCALE_STEPS[k - 1], r = median(w.map((x) => x.r)) * (up / s) ** 2;
        if (r < 0.75 * budget) return up;
      }
    }
    if (k < 0) return SCALE_STEPS.find((x) => x <= s) ?? SCALE_STEPS[SCALE_STEPS.length - 1]; // (from a fixed scale back to auto)
    return s;
  }
}

/**
 * The controller of one device, called at each present after the frame's flush. `busy()`: the backend's cumulative busy
 * time (ms). `stats`: the device statistics' `rscale` record (cumulative: readers take differences).
 */
export class RenderScale {
  /** @param {{ software: boolean, busy: () => number, now?: () => number }} o */
  constructor(o) {
    this.software = !!o.software; this.busy = o.busy; this.now = o.now ?? (() => performance.now());
    this.ctl = new ScaleController(); this.lastT = null; this.lastBusy = 0; this.modeKey = undefined; this.mode = null;
    this.stats = { mode: 'off', s: 1, changes: 0, min: 1, frames: 0, renderMs: 0, intervalMs: 0, software: this.software };
  }
  /** the mode now (the debug global read at every present: switchable within a session) */
  currentMode() {
    const v = globalThis.ORTHROS_RENDER_SCALE;
    if (v !== this.modeKey || !this.mode) { this.modeKey = v; this.mode = scaleMode(v, this.software); this.stats.mode = this.mode.mode; this.reset(); }
    return this.mode;
  }
  /** the scale the targets are created with (a fixed scale from the start) */
  initial() { const m = this.currentMode(); return m.mode === 'fixed' ? m.s : 1; }
  /** measurement state dropped (mode change, context loss) */
  reset() { this.lastT = null; this.ctl = new ScaleController(); this.ctl.changed(this.now()); }
  /** A frame was presented and flushed at scale `s`: measured; the scale for the next frame returned. */
  present(s) {
    const m = this.currentMode(), now = this.now();
    // (measured in every mode on a software GPU, or with a forced scale: the statistics compare phases of either mode)
    if (m.mode === 'off' && !this.software) return 1;
    const busy = this.busy?.() ?? 0, st = this.stats;
    if (this.lastT !== null) {
      const interval = now - this.lastT, b = Math.max(0, Math.min(interval, busy - this.lastBusy));
      st.frames++; st.renderMs += b; st.intervalMs += interval;
      this.ctl.add(now, s, interval, b);
    }
    this.lastT = now; this.lastBusy = busy;
    if (m.mode !== 'auto') return m.s;
    const budget = Number(globalThis.ORTHROS_RENDER_BUDGET) > 0 ? Number(globalThis.ORTHROS_RENDER_BUDGET) : 1000 / 30;
    const c = this.ctl, k0 = c.kept, u0 = c.undone;
    const next = c.decide(now, s, budget);
    st.kept = (st.kept ?? 0) + c.kept - k0; st.undone = (st.undone ?? 0) + c.undone - u0; // (steps down kept / undone for no gain)
    if (next !== s) this.ctl.changed(now);
    return next;
  }
}

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
// render time — the backend's busy time between two presents (the render worker's replay, blocked GL calls included)
// plus the latency of a fence placed after the present (the GPU work left when the frame was handed over) — against the
// frame budget. The scale steps down when the frames are render-bound for ~1.5 s and up when the next step's predicted
// render time stays comfortably under the budget for ~4 s.
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
/** at most this many fences in flight (more frames are not measured) */
const FENCES = 8;
/** fences polled in draws at most every POLL_MS */
const POLL_MS = 1;
const SYNC_GPU_COMMANDS_COMPLETE = 0x9117, SYNC_STATUS = 0x9114, SIGNALED = 0x9119;

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
  constructor() { this.samples = []; this.changedAt = -Infinity; }
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
    if (since >= DOWN_MS + SETTLE_MS && k >= 0 && k < SCALE_STEPS.length - 1) {
      const w = window(DOWN_MS);
      if (w.length >= 3) {
        const r = median(w.map((x) => x.r)), i = median(w.map((x) => x.i));
        if (r > budget && i > budget * 1.05 && r >= 0.75 * i) return SCALE_STEPS[k + 1];
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
 * The controller of one device: called at each present after the frame's flush (`present`) and in draws (`poll`, when
 * `hot`). `busy()`: the backend's cumulative busy time (ms). `stats`: the device statistics' `rscale` record.
 */
export class RenderScale {
  /** @param {WebGL2RenderingContext} gl @param {{ software: boolean, busy: () => number, now?: () => number }} o */
  constructor(gl, o) {
    this.gl = gl; this.software = !!o.software; this.busy = o.busy; this.now = o.now ?? (() => performance.now());
    this.ctl = new ScaleController(); this.fences = []; this.lastT = null; this.lastBusy = 0; this.lastPoll = 0; this.hot = false; this.modeKey = undefined; this.mode = null;
    this.stats = { mode: 'off', s: 1, changes: 0, min: 1, frames: 0, renderMs: 0, intervalMs: 0, busyMs: 0, fenceMs: 0, software: this.software };
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
  reset() { for (const f of this.fences) try { this.gl.deleteSync(f.sync); } catch { /* context lost */ } this.fences.length = 0; this.lastT = null; this.hot = false; this.ctl.changed(this.now()); }
  /** A frame was presented and flushed at scale `s`: measured; the scale for the next frame returned. */
  present(s) {
    const m = this.currentMode(), now = this.now();
    if (m.mode !== 'auto') return m.s;
    const busy = this.busy?.() ?? 0;
    if (this.lastT !== null) {
      const interval = now - this.lastT, b = Math.max(0, Math.min(interval, busy - this.lastBusy));
      if (this.fences.length < FENCES && typeof this.gl.fenceSync === 'function') { const sync = this.gl.fenceSync(SYNC_GPU_COMMANDS_COMPLETE, 0); if (sync) this.fences.push({ sync, t: now, s, interval, busy: b }); }
    }
    this.lastT = now; this.lastBusy = busy;
    this.poll(now);
    const budget = Number(globalThis.ORTHROS_RENDER_BUDGET) > 0 ? Number(globalThis.ORTHROS_RENDER_BUDGET) : 1000 / 30;
    const next = this.ctl.decide(now, s, budget);
    if (next !== s) this.ctl.changed(now);
    return next;
  }
  /** The fences signaled since: their frames' render times (busy + latency after the present) to the controller. */
  poll(now = this.now()) {
    const gl = this.gl, st = this.stats; this.lastPoll = now;
    while (this.fences.length) {
      const f = this.fences[0];
      if (gl.getSyncParameter(f.sync, SYNC_STATUS) !== SIGNALED) break;
      gl.deleteSync(f.sync); this.fences.shift();
      const lat = now - f.t, r = f.busy + lat;
      st.frames++; st.renderMs += r; st.intervalMs += f.interval; st.busyMs += f.busy; st.fenceMs += lat;
      this.ctl.add(f.t, f.s, f.interval, r);
    }
    this.hot = this.fences.length > 0;
  }
  /** in draws (when `hot`): fences polled at most every POLL_MS */
  draw() { const now = this.now(); if (now - this.lastPoll >= POLL_MS) this.poll(now); }
}

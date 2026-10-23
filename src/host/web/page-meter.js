// The frames of a page whose engine draws with WebGL on the page's own thread — the browser ports' pages (re3, GoldSrc,
// OpenMW) — measured from outside it, as the Win32 worker measures its own (docs/real-machine-bench.md, "The bench
// suite"): installed by the bench suite (bench-suite.js) into the port's window of its frame, same origin, at any time
// after the page started (the engine's calls look the WebGL methods and requestAnimationFrame up at each call):
// - a frame is a browser frame in which the engine drew (its draw calls counted on the context prototypes), its time
//   the gap between the animation frames that saw two such frames; the engine's work in it, from the frame's first
//   callback to the last request for the next one made in it (the engine asks at the end of its iteration, an
//   asynchronous main loop too), or the port's own count of its engine's work (hooks.workMs);
// - each frame goes to the frame accounting every runtime uses (core/frame-acct.js FrameStats: `guest` its work,
//   `ioWait` the port's reads waited for in it, `wait` the rest), so its phase reports and intervals are the Win32
//   worker's, read by the same summaries (perf-summary.js PerfWindow, compactPhase);
// - GPU time per frame with the Win32 runtime's probe (gfx/gpu-probe.js: EXT_disjoint_timer_query_webgl2 windows) on
//   the engine's context, and that context's renderer string;
// - every 0.5 s a stats message shaped as the Win32 worker's (fps, dt, acct, d3d: { frames, draws, gpu }) for the
//   scenario player's waits and the bench's windows, with the port's data (hooks.data: its reads waited for).
// The port's page may give hooks (window.orthrosBenchHooks): command(text) (its console), teleport(x, y, z),
// data() → { waits, waitMs, bytes }, workMs() (its engine's work so far, ms); without them, those its portSession
// offers (the re3 and GoldSrc pages': command, files — the game data's reads, src/vfs/data-client.js stats).
// `discard`: the rasterizer discarded (RASTERIZER_DISCARD kept on: every call made, no pixel drawn — this server's
// software GPU measured without its drawing; the harness's --gl-discard).
import { FrameStats, C, N_CATS } from '../../core/frame-acct.js';
import { GpuProbe } from '../../gfx/gpu-probe.js';

const DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
const RASTERIZER_DISCARD = 0x8C89;
export const STATS_MS = 500;

export class PageMeter {
  /**
   * @param {Window} win the port's window
   * @param {{ discard?: boolean, now?: () => number, onStats?: (m: any) => void }} [o]
   */
  constructor(win, o = {}) {
    this.win = win; this.discard = !!o.discard; this.now = o.now ?? (() => win.performance.now()); this.onStats = o.onStats ?? null;
    this.draws = 0; this.drawsAt = 0; this.frames = 0; this.framesDraws = 0; this.browserFrames = 0;
    this.fs = new FrameStats(); this.gl = null; this.gpu = null; this.renderer = null; this.seq = 0;
    this.tickT = null; this.tickAt = null; this.lastAsk = 0; this.lastShown = null; this.work = 0;
    this.lastWorkMs = null; this.lastIo = null; this.statsAt = null; this.statsFrames = 0;
  }
  get hooks() { return benchHooks(this.win); }
  /** The wrappers in the port's window (once a window: a page reloaded in the frame is another window). */
  install() {
    const W = this.win, P = this;
    if (W.__orthrosPageMeter) return W.__orthrosPageMeter === this;
    W.__orthrosPageMeter = this;
    for (const type of [W.WebGL2RenderingContext, W.WebGLRenderingContext]) {
      if (!type) continue;
      const proto = type.prototype;
      for (const k of DRAWS) {
        const f = proto[k]; if (typeof f !== 'function') continue;
        proto[k] = function () { P.draws++; if (P.gl !== this) P.context(this); return f.apply(this, arguments); };
      }
      if (this.discard && type === W.WebGL2RenderingContext) {
        const disable = proto.disable;
        proto.disable = function (cap) { if (cap === RASTERIZER_DISCARD) return undefined; return disable.call(this, cap); };
      }
    }
    const raf = W.requestAnimationFrame.bind(W);
    W.requestAnimationFrame = (cb) => { if (P.tickAt !== null) P.lastAsk = P.now(); return raf((t) => { P.tick(t); return cb(t); }); };
    // (a frame without the engine's own callback is seen all the same: an engine pumped by messages)
    const loop = (t) => { if (this.stopped) return; P.tick(t); raf(loop); };
    raf(loop);
    this.statsAt = this.now();
    this.timer = W.setInterval(() => this.emit(), STATS_MS);
    return true;
  }
  stop() { this.stopped = true; try { this.win.clearInterval(this.timer); } catch { /* gone */ } this.gpu?.stopGlCount?.(false); }
  /** The engine's context, seen at its first draw: its renderer, its GPU timer, the rasterizer discarded. */
  context(gl) {
    if (this.gl) { this.otherContexts = (this.otherContexts ?? 0) + 1; if (this.gl.isContextLost?.() === false) return; }
    this.gl = gl;
    try { const info = gl.getExtension('WEBGL_debug_renderer_info'); this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); } catch { this.renderer = null; }
    this.webgl2 = typeof gl.createQuery === 'function' && typeof gl.beginQuery === 'function';
    // (WebGL 1: no TIME_ELAPSED queries of the kind the probe makes — reported unavailable)
    this.gpu = this.webgl2 ? new GpuProbe(gl, { wrapGl: false, now: this.now }) : null;
    if (this.discard && this.webgl2) gl.enable(RASTERIZER_DISCARD);
  }
  /** An animation frame (the first callback in it: once per browser frame). */
  tick(t) {
    if (t === this.tickT) return;
    const now = this.now(), h = this.hooks;
    // (the browser frame that ended: the engine's work in it)
    if (this.tickAt !== null) this.work += this.lastAsk > this.tickAt ? this.lastAsk - this.tickAt : 0;
    this.tickT = t; this.tickAt = now; this.lastAsk = 0; this.browserFrames++;
    if (this.draws === this.drawsAt) return;
    // the engine drew since the last frame: a frame shown now
    this.drawsAt = this.draws; this.frames++; this.framesDraws = this.draws;
    let work = this.work; this.work = 0;
    const wm = safe(() => h?.workMs?.()); if (typeof wm === 'number') { if (this.lastWorkMs !== null) work = wm - this.lastWorkMs; this.lastWorkMs = wm; }
    const io = safe(() => h?.data?.()?.waitMs); let ioMs = 0; if (typeof io === 'number') { if (this.lastIo !== null) ioMs = Math.max(0, io - this.lastIo); this.lastIo = io; }
    if (this.lastShown !== null) {
      const dt = t - this.lastShown, cats = new Float64Array(N_CATS);
      const w = Math.max(0, Math.min(work, dt)), wio = Math.min(ioMs, w);
      cats[C.guest] = w - wio; cats[C.ioWait] = wio; cats[C.wait] = Math.max(0, dt - w);
      this.fs.add(dt, cats, t);
    }
    this.lastShown = t;
    try { this.gpu?.frame(); } catch { this.gpu = null; } // (a lost context: no more timing)
  }
  /** The stats message now (the Win32 worker's shape: what the scenario player and PerfWindow read). */
  emit() {
    const now = this.now(), dt = Math.max(1e-3, (now - this.statsAt) / 1000), frames = this.frames - this.statsFrames;
    this.statsAt = now; this.statsFrames = this.frames;
    const g = this.gpu?.stats.gpu, data = safe(() => this.hooks?.data?.()) ?? null;
    const m = {
      seq: ++this.seq, dt, fps: frames / dt, acct: this.fs.takeInterval(),
      d3d: { frames: this.frames, draws: this.framesDraws, gpu: g ? { ...g, hist: Array.from(g.hist) } : { state: this.gl ? 'unavailable' : 'none' } },
      ...(data ? { data } : {}), browserFrames: this.browserFrames,
    };
    this.last = m;
    this.onStats?.(m);
    return m;
  }
  /** A phase boundary (BenchRun's mark): the phase report since the previous one (frame-acct.js FrameStats.phase). */
  phase(label) { return this.fs.phase(label, this.now()); }
}

function safe(f) { try { return f(); } catch { return undefined; } }

const fromSession = new WeakMap();
/** A port page's bench hooks: its own (window.orthrosBenchHooks), else its portSession's command and data reads. */
export function benchHooks(win) {
  try {
    if (!win) return null;
    if (win.orthrosBenchHooks) return win.orthrosBenchHooks;
    const s = win.portSession; if (!s) return null;
    let h = fromSession.get(s);
    if (!h) {
      h = {
        command: (text) => s.command?.(text),
        data: () => { const st = s.files?.stats; return st ? { waits: st.waits ?? 0, waitMs: st.waitMs ?? 0, bytes: st.fetchedBytes ?? 0 } : null; },
      };
      fromSession.set(s, h);
    }
    return h;
  } catch { return null; }
}

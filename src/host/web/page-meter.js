// The frames of a page whose engine draws with WebGL on the page's own thread — the browser ports' pages (re3, GoldSrc,
// OpenMW) — measured from outside it, as the Win32 worker measures its own (docs/real-machine-bench.md, "The bench
// suite"): installed by the bench suite (bench-suite.js) into the port's window of its frame, same origin, at any time
// after the page started (the engine's calls look the WebGL methods and requestAnimationFrame up at each call):
// - a frame is a browser frame in which the engine drew (its draw calls counted on the context prototypes), its time,
//   its work and its data waits measured as the passive session records measure them (perf-page.js
//   watchEngineFrames: one measurement of a port's frames), or the port's own count of its engine's work
//   (hooks.workMs);
// - each frame goes to the frame accounting every runtime uses (core/frame-acct.js FrameStats: `guest` its work,
//   `ioWait` the port's reads waited for in it, `wait` the rest), so its phase reports and intervals are the Win32
//   worker's, read by the same summaries (perf-summary.js PerfWindow, compactPhase);
// - GPU time per frame with the Win32 runtime's probe (gfx/gpu-probe.js: EXT_disjoint_timer_query_webgl2 windows, WebGL
//   1's extension through perf-page.js timerContext) on the engine's context, and that context's renderer string;
// - every 0.5 s a stats message shaped as the Win32 worker's (fps, dt, acct, d3d: { frames, draws, gpu }) for the
//   scenario player's waits and the bench's windows, with the port's data (hooks.data: its reads waited for).
// The port's page may give hooks (window.orthrosBenchHooks): command(text) (its console), teleport(x, y, z),
// data() → { waits, waitMs, bytes }, workMs() (its engine's work so far, ms); without them, those its portSession
// offers (the re3 and GoldSrc pages': command, files — the game data's reads, src/vfs/data-client.js stats).
// `discard`: the rasterizer discarded (RASTERIZER_DISCARD kept on: every call made, no pixel drawn — this server's
// software GPU measured without its drawing; the harness's --gl-discard).
import { FrameStats, C, N_CATS } from '../../core/frame-acct.js';
import { GpuProbe } from '../../gfx/gpu-probe.js';
import { watchEngineFrames, timerContext } from './perf-page.js';

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
    this.draws = 0; this.frames = 0; this.framesDraws = 0;
    this.fs = new FrameStats(); this.gl = null; this.gpu = null; this.renderer = null; this.seq = 0;
    this.lastWorkMs = null; this.statsAt = null; this.statsFrames = 0;
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
    // (the frames shown, their work and data waits: the passive records' measurement, perf-page.js)
    watchEngineFrames(W, {
      draws: () => this.draws, now: this.now, stopped: () => this.stopped,
      data: () => { const d = safe(() => this.hooks?.data?.()); return d ? { ms: d.waitMs ?? 0 } : null; },
      onShown: () => { this.frames++; this.framesDraws = this.draws; try { this.gpu?.frame(); } catch { this.gpu = null; } }, // (a lost context: no more timing)
      onFrame: (dt, work, dataMs, t) => this.frame(dt, work, dataMs, t),
    });
    this.statsAt = this.now();
    this.timer = W.setInterval(() => this.emit(), STATS_MS);
    return true;
  }
  stop() { this.stopped = true; try { this.win.clearInterval(this.timer); } catch { /* gone */ } }
  /** The engine's context, seen at its first draw: its renderer, its GPU timer, the rasterizer discarded. */
  context(gl) {
    if (this.gl) { this.otherContexts = (this.otherContexts ?? 0) + 1; if (this.gl.isContextLost?.() === false) return; }
    this.gl = gl;
    try { const info = gl.getExtension('WEBGL_debug_renderer_info'); this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); } catch { this.renderer = null; }
    const W2 = this.win.WebGL2RenderingContext;
    // (its timer queries, WebGL 1's extension adapted — perf-page.js timerContext; none: reported unavailable)
    try { this.gpu = new GpuProbe(timerContext(gl), { wrapGl: false, now: this.now }); } catch { this.gpu = null; }
    if (this.discard && W2 && gl instanceof W2) gl.enable(RASTERIZER_DISCARD);
  }
  /**
   * A frame shown (after the first): to the frame accounting — `guest` the engine's work (the port's own count when it
   * has one, hooks.workMs), `ioWait` the data waits within it, `wait` the rest.
   */
  frame(dt, work, dataMs, t) {
    let w = work ?? 0;
    const wm = safe(() => this.hooks?.workMs?.()); if (typeof wm === 'number') { if (this.lastWorkMs !== null) w = wm - this.lastWorkMs; this.lastWorkMs = wm; }
    const cats = new Float64Array(N_CATS), ww = Math.max(0, Math.min(w, dt)), wio = Math.min(dataMs, ww);
    cats[C.guest] = ww - wio; cats[C.ioWait] = wio; cats[C.wait] = Math.max(0, dt - ww);
    this.fs.add(dt, cats, t); // (t: the browser frame that ends it)
  }
  /** The stats message now (the Win32 worker's shape: what the scenario player and PerfWindow read). */
  emit() {
    const now = this.now(), dt = Math.max(1e-3, (now - this.statsAt) / 1000), frames = this.frames - this.statsFrames;
    this.statsAt = now; this.statsFrames = this.frames;
    const g = this.gpu?.stats.gpu, data = safe(() => this.hooks?.data?.()) ?? null;
    const m = {
      seq: ++this.seq, dt, fps: frames / dt, acct: this.fs.takeInterval(),
      d3d: { frames: this.frames, draws: this.framesDraws, gpu: g ? { ...g, hist: Array.from(g.hist) } : { state: this.gl ? 'unavailable' : 'none' } },
      ...(data ? { data } : {}),
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

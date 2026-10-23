// The page's side of the passive session records (src/host/perf-record.js, docs/real-machine-bench.md "Passive
// session records"), one for every runtime: the Windows games' page feeds it the worker's stats intervals (frame
// accounting), a browser port's page (GoldSrc, re3, the OpenMW engine's page) its frames shown — the engine's work a
// frame measured from the browser's animation frames, its GPU time by the timer query probe (gpu-probe.js, sampled
// windows), its game data waits from the shared game data's counters (data-client.js). It keeps the clock (visible and
// hidden time, the phase), runs the host timing probe once (timing-probe.js), and sends a record every 2 minutes of
// play and one at the end (sendBeacon, else a keepalive fetch).
import { PerfRecorder, SLOW_A } from '../perf-record.js';
import { GpuProbe } from '../../gfx/gpu-probe.js';
import { runTimingProbe } from './timing-probe.js';
import { gpuClass, gpuInfo } from './gpu-class.js';

export { SLOW_A };
/** the clock's period (ms); the timing probe once after this much visible time */
export const CLOCK_MS = 1000, PROBE_AFTER_MS = 60000;

/** Send a telemetry body (an object or its JSON) to the server: sendBeacon, else a keepalive fetch. */
export function beacon(body, url = '/api/telemetry') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try { if (globalThis.navigator?.sendBeacon?.(url, new Blob([text], { type: 'application/json' }))) return true; } catch { /* refused */ }
  try { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: true }).catch(() => {}); } catch { /* no fetch */ }
  return false;
}

/**
 * A WebGL context's timer queries as GpuProbe expects them (WebGL2's API): the context itself on WebGL2, an adapter
 * of EXT_disjoint_timer_query on WebGL1 (the same enums), a context without the extension otherwise (GpuProbe then
 * reports 'unavailable').
 */
export function timerContext(gl) {
  if (!gl) return gl;
  const has = (n) => { try { return gl.getExtension(n); } catch { return null; } };
  if ((typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) || has('EXT_disjoint_timer_query_webgl2')) return gl;
  const ext = has('EXT_disjoint_timer_query');
  if (!ext) return { getExtension: () => null };
  return {
    getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? ext : null),
    createQuery: () => ext.createQueryEXT(), deleteQuery: (q) => ext.deleteQueryEXT(q),
    beginQuery: (t, q) => ext.beginQueryEXT(t, q), endQuery: (t) => ext.endQueryEXT(t),
    getQueryParameter: (q, p) => ext.getQueryObjectEXT(q, p), getParameter: (p) => gl.getParameter(p),
    QUERY_RESULT: ext.QUERY_RESULT_EXT, QUERY_RESULT_AVAILABLE: ext.QUERY_RESULT_AVAILABLE_EXT,
  };
}

/** The machine as the ports' telemetry already tells it, with the WebGL renderer (of `gl` when given) and its kind. */
export function portEnv(gl = null) {
  const nav = globalThis.navigator ?? {}, { renderer, vendor } = gpuInfo(gl);
  return { gpu: renderer, gpuVendor: vendor, gpuClass: gpuClass(renderer), cores: nav.hardwareConcurrency ?? null, memGB: nav.deviceMemory ?? null, ua: nav.userAgent ?? null,
    screen: globalThis.screen ? `${screen.width}x${screen.height}@${globalThis.devicePixelRatio ?? 1}` : null };
}

export class PerfSession {
  /**
   * @param {{ runtime: string, game: string|null, session: string, version?: string|null, build?: string|null,
   *   tier?: () => string|null, bench?: string|null, env?: () => object, phase?: () => string|null,
   *   data?: () => ({ waits: number, ms: number }|null), gpu?: () => object|null, send?: (rec: object) => void,
   *   win?: any, now?: () => number, probe?: boolean, recordMs?: number }} o
   */
  constructor(o) {
    this.o = o; this.win = o.win ?? globalThis; this.now = o.now ?? (() => performance.now());
    this.rec = new PerfRecorder({ recordMs: o.recordMs, header: { session: o.session, game: o.game ?? null, runtime: o.runtime, version: o.version ?? null, build: o.build ?? null, tier: null, ...(o.bench ? { bench: o.bench } : {}) } });
    this.sendFn = o.send ?? beacon; this.envCache = null; this.ended = false; this.probeAsked = o.probe === false;
    this.gpuProbe = null; this.dataCum = null; this.gpuStats = null;
    const doc = this.win.document;
    this.onVis = () => { this.tick(); if (this.meter) { this.meter.prevT = null; this.meter.lastShownT = null; } };
    this.onHide = () => this.end();
    doc?.addEventListener?.('visibilitychange', this.onVis);
    // (capture: before the page's own pagehide listeners — a large telemetry flush there could use up the keepalive quota)
    this.win.addEventListener?.('pagehide', this.onHide, { capture: true });
    this.timer = setInterval(() => this.tick(), CLOCK_MS);
    this.tick();
  }
  visible() { return this.win.document?.visibilityState !== 'hidden'; }
  gpu() { return this.o.gpu ? this.o.gpu() : this.gpuProbe ? this.gpuProbe.stats.gpu : this.gpuStats; }
  data() { return this.o.data ? this.o.data() : this.dataCum; }
  tick() {
    if (this.ended) return;
    const now = this.now(), vis = this.visible();
    this.rec.counters({ gpu: this.gpu() ?? null, data: this.data() ?? null });
    this.rec.clock(now, vis, this.o.phase?.() ?? null);
    if (!this.probeAsked && vis && this.rec.tot.vis >= PROBE_AFTER_MS) {
      this.probeAsked = true;
      runTimingProbe().then((p) => { if (p) this.rec.setProbe(p); }, () => {});
    }
    const r = this.rec.take(now); if (r) this.send(r);
  }
  send(r) {
    if (!this.envCache) { try { this.envCache = this.o.env ? this.o.env() : portEnv(this.meter?.gl ?? null); } catch { this.envCache = null; } if (this.envCache && !this.envCache.gpuClass) this.envCache = { ...this.envCache, gpuClass: gpuClass(this.envCache.gpu) }; }
    r.tier = this.o.tier?.() ?? null;
    if (this.envCache) { const e = this.envCache; r.env = { gpu: e.gpu ?? null, gpuVendor: e.gpuVendor ?? null, gpuClass: e.gpuClass ?? null, cores: e.cores ?? null, memGB: e.memGB ?? null, ua: e.ua ?? null, screen: e.screen ?? null }; }
    try { this.sendFn(r); } catch { /* lost */ }
  }
  /** The session's end (the game exited, the page goes): the last record, then nothing more. */
  end() {
    if (this.ended) return;
    const now = this.now();
    this.rec.counters({ gpu: this.gpu() ?? null, data: this.data() ?? null });
    const r = this.rec.take(now, true); this.ended = true;
    clearInterval(this.timer);
    this.win.document?.removeEventListener?.('visibilitychange', this.onVis); this.win.removeEventListener?.('pagehide', this.onHide, { capture: true });
    if (r) this.send(r);
  }

  // ---------------------------------------------------------------- the Windows games: the worker's stats intervals
  /** One stats message of the emulator's worker (~0.5 s): its frame accounting, GPU timer and file waits. */
  interval(m) {
    if (this.ended || !m) return;
    if (m.d3d?.gpu) this.gpuStats = m.d3d.gpu;
    if (m.netMs !== undefined) { const d = (this.dataCum ??= { waits: 0, ms: 0 }); d.waits += m.netReq ?? 0; d.ms += m.netMs ?? 0; }
    const a = m.acct; if (!a) return;
    // (the frames' own time: the sum of their categories — work and waits —, else the interval's)
    const c = a.c ? Object.values(a.c).reduce((x, y) => x + y, 0) : 0, dtMs = c > 0 ? c * a.frames : (m.dt ?? 0.5) * 1000;
    this.rec.interval(a, dtMs);
  }

  // ---------------------------------------------------------------- the ports: the frames shown
  /**
   * Measure the frames of an engine that runs in this page: `gl()` its WebGL context once it has one (GPU time, the
   * renderer), `draws()` a counter of its draw calls (a browser frame with draws was shown), else the page calls the
   * returned `shown()` for each frame the engine displayed. The engine's work a frame: from the browser frame's start
   * to the engine's request for the next one made in it (its iteration's end, with an asynchronous main loop as well).
   */
  watchFrames({ gl = null, draws = null } = {}) {
    const win = this.win, raf0 = win.requestAnimationFrame.bind(win);
    const m = this.meter = { prevT: null, lastShownT: null, flag: false, drawsSeen: draws ? draws() : 0, work: 0, known: false, frameT: null, ask: [null, 0], askPrev: [null, 0], dataAt: null, gl: null };
    // (the asks: the last two frames' last requests, by the frame they were made in)
    win.requestAnimationFrame = function (cb) {
      const at = performance.now();
      if (m.ask[0] !== m.frameT) m.askPrev = m.ask;
      m.ask = [m.frameT, at];
      return raf0((t) => { m.frameT = t; cb(t); });
    };
    const tick = (t) => {
      if (this.ended) return;
      if (m.frameT !== t) m.frameT = t; // (this frame's asks are this frame's)
      if (m.prevT !== null) {
        const a = m.ask[0] === m.prevT ? m.ask : m.askPrev[0] === m.prevT ? m.askPrev : null;
        if (a) { m.work += Math.max(0, a[1] - m.prevT); m.known = true; }
        const d = draws ? draws() : null, shown = m.flag || (d !== null && d !== m.drawsSeen);
        m.flag = false; if (d !== null) m.drawsSeen = d;
        if (shown) {
          if (!this.gpuProbe && gl) { const ctx = gl(); if (ctx) { m.gl = ctx; try { this.gpuProbe = new GpuProbe(timerContext(ctx), { wrapGl: false }); } catch { this.gpuProbe = null; } } }
          try { this.gpuProbe?.frame(); } catch { /* lost context */ }
          const dw = this.data(), dms = dw ? dw.ms : 0, dd = m.dataAt === null ? 0 : Math.max(0, dms - m.dataAt); m.dataAt = dms;
          if (m.lastShownT !== null && this.visible()) this.rec.frame(m.prevT - m.lastShownT, m.known ? m.work : null, dd);
          m.lastShownT = m.prevT; m.work = 0; m.known = false;
        }
      }
      m.prevT = t; raf0(tick);
    };
    raf0(tick);
    return { shown: () => { m.flag = true; } };
  }
}

/** The WebGL context an engine made on `canvas` (asked once it drew: never creates one), or null. */
export function canvasGl(canvas) {
  try { return canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? null; } catch { return null; }
}

/**
 * A port's session record, started when the server keeps telemetry (/api/config): `o` as PerfSession's, with
 * watchFrames' `gl` and `draws`. Returns at once a handle — `shown()` (a frame the engine displayed, for an engine
 * whose page knows them), `end()` — that forwards to the session once it exists.
 */
export function portPerf(o) {
  const h = { session: null, frames: null, ended: false, shown() { h.frames?.shown(); }, end() { h.ended = true; h.session?.end(); } };
  fetch('/api/config').then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((c) => {
    if (!c?.telemetry || h.ended) return;
    h.session = new PerfSession({ ...o, build: c.version ?? null });
    h.frames = h.session.watchFrames({ gl: o.gl, draws: o.draws });
  });
  return h;
}

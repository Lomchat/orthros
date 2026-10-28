// The page's side of the passive session records (src/host/perf-record.js, docs/real-machine-bench.md "Passive
// session records"), one for every runtime: the Windows games' page feeds it the worker's stats intervals (frame
// accounting), a browser port's page (GoldSrc, re3, the OpenMW engine's page) its frames shown — the engine's work a
// frame measured from the browser's animation frames, its GPU time by the timer query probe (gpu-probe.js, sampled
// windows), its game data waits from the shared game data's counters (data-client.js) and what they were for
// (portDataSummary). It keeps the clock (visible and hidden time, the phase), runs the host timing probe once
// (timing-probe.js), and sends a record every 2 minutes of play and one at the end (sendBeacon, else a keepalive fetch).
import { PerfRecorder, SLOW_A } from '../perf-record.js';
import { GpuProbe } from '../../gfx/gpu-probe.js';
import { runTimingProbe } from './timing-probe.js';
import { gpuClass, gpuInfo } from './gpu-class.js';
import { pageStorage, withStorage } from './storage-persist.js';

export { SLOW_A };
/** the clock's period (ms); the timing probe once after this much visible time */
export const CLOCK_MS = 1000, PROBE_AFTER_MS = 60000;
/** the storage's state (storage-persist.js) read again this often (ms) for the records' env */
export const STORAGE_READ_MS = 30000;

/** Send a telemetry body (an object or its JSON) to the server: sendBeacon, else a keepalive fetch. */
export function beacon(body, url = '/api/telemetry') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try { if (globalThis.navigator?.sendBeacon?.(url, new Blob([text], { type: 'application/json' }))) return true; } catch { /* refused */ }
  try { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: true }).catch(() => {}); } catch { /* no fetch */ }
  return false;
}

/**
 * A browser port's session events (/api/telemetry: its start, errors, crash, audio, end — a few a session; the GoldSrc
 * and re3 pages): `port` its runtime, `state()` the page's state, `storage` its pageStorage (the env's storage),
 * `bench` a bench suite's run (bench-suite.js). report(event, data) sends one (20 at most a session); end(data) the
 * session's end, once. `session`: the id the passive record shares (portPerf). `send`: beacon (tests: their own).
 * @param {{ port: string, state: () => string, storage: { state: any }, bench?: string|null, max?: number, send?: (body: object) => void }} o
 */
export function portEvents({ port, state, storage, bench = null, max = 20, send = beacon }) {
  const t = { session: crypto.randomUUID().replaceAll('-', '').slice(0, 16), started: performance.now(), sent: 0, ended: false,
    report(event, data = {}) {
      if (t.sent >= max) return; t.sent++;
      send({ session: t.session, game: decodeURIComponent(globalThis.location?.pathname.split('/').filter(Boolean)[2] ?? ''), port, event, ...(bench ? { bench } : {}),
        seconds: Math.round((performance.now() - t.started) / 1000), state: state(), ...data, env: eventEnv(storage.state) });
    },
    end(data = {}) { if (t.ended) return; t.ended = true; t.report('end', data); } };
  return t;
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

/**
 * The env of a browser port's event records (start, error, end — /api/telemetry, the GoldSrc and re3 pages): the
 * browser and machine, and the storage's state (`storage`: the page's pageStorage().state, storage-persist.js).
 */
export function eventEnv(storage = null) {
  const nav = globalThis.navigator ?? {};
  return withStorage({ ua: nav.userAgent ?? null, cores: nav.hardwareConcurrency ?? null, memGB: nav.deviceMemory ?? null, dpr: globalThis.devicePixelRatio ?? 1,
    screen: globalThis.screen ? `${screen.width}x${screen.height}` : null }, storage);
}

export class PerfSession {
  /**
   * @param {{ runtime: string, game: string|null, session: string, version?: string|null, build?: string|null,
   *   tier?: () => string|null, bench?: string|null, env?: () => object, phase?: () => string|null,
   *   data?: () => ({ waits: number, ms: number, sum?: object }|null), gpu?: () => object|null, send?: (rec: object) => void,
   *   win?: any, now?: () => number, probe?: boolean, recordMs?: number, storage?: ReturnType<typeof pageStorage> }} o
   *   storage: the page's (storage-persist.js: its env's `storage`, read again after each record), else one of its own
   */
  constructor(o) {
    this.o = o; this.win = o.win ?? globalThis; this.now = o.now ?? (() => performance.now());
    this.rec = new PerfRecorder({ recordMs: o.recordMs, header: { session: o.session, game: o.game ?? null, runtime: o.runtime, version: o.version ?? null, build: o.build ?? null, tier: null, ...(o.bench ? { bench: o.bench } : {}) } });
    this.sendFn = o.send ?? beacon; this.envCache = null; this.ended = false; this.probeAsked = o.probe === false;
    this.gpuProbe = null; this.dataCum = null; this.gpuStats = null;
    this.storage = o.storage ?? pageStorage(this.win.navigator); // (read by tick: at once, then every STORAGE_READ_MS)
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
    else if (!(now - (this.storageRead ?? -Infinity) < STORAGE_READ_MS)) { this.storageRead = now; this.storage.read(); } // (the usage grows as the game data comes: the end's record too)
  }
  send(r) {
    if (!this.envCache) { try { this.envCache = this.o.env ? this.o.env() : portEnv(this.meter?.gl ?? null); } catch { this.envCache = null; } if (this.envCache && !this.envCache.gpuClass) this.envCache = { ...this.envCache, gpuClass: gpuClass(this.envCache.gpu) }; }
    r.tier = this.o.tier?.() ?? null;
    if (this.envCache) { const e = this.envCache; r.env = withStorage({ gpu: e.gpu ?? null, gpuVendor: e.gpuVendor ?? null, gpuClass: e.gpuClass ?? null, cores: e.cores ?? null, memGB: e.memGB ?? null, ua: e.ua ?? null, screen: e.screen ?? null }, this.storage.state); }
    try { this.sendFn(r); } catch { /* lost */ }
    this.storage.read(); // (the next record's: the usage grows as the game data comes)
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
    const w = watchEngineFrames(this.win, {
      draws, gl, data: () => this.data(), active: () => this.visible(), stopped: () => this.ended, now: () => performance.now(),
      onGl: (ctx) => { try { this.gpuProbe = new GpuProbe(timerContext(ctx), { wrapGl: false }); } catch { this.gpuProbe = null; } },
      onShown: () => { try { this.gpuProbe?.frame(); } catch { /* lost context */ } },
      onFrame: (dt, work, dataMs) => this.rec.frame(dt, work, dataMs),
    });
    this.meter = w.meter;
    return { shown: w.shown };
  }
}

/**
 * The frames an engine shows in the page `win` — one measurement for the passive records (PerfSession.watchFrames, in
 * the port's own page) and the bench suite (page-meter.js, from the page around it): a frame shown is a browser frame
 * with draws (`draws()`, a counter of the engine's draw calls) or one the page marks (the returned `shown()`); its time
 * the gap between the animation frames that saw two of them; the engine's work in it from the browser frame's start to
 * the engine's request for the next one made in it (its iteration's end, with an asynchronous main loop as well; null
 * when it made none); the game data's waits in it from `data()` ({ ms } cumulative). `gl()`: the engine's context, asked
 * at shown frames until it has one (onGl). onShown() at each frame shown, onFrame(dtMs, workMs | null, dataMs, t) for
 * each one after the first while `active()`; `stopped()` ends it. `now`: the clock of the page's requests (its
 * performance.now).
 */
export function watchEngineFrames(win, o) {
  const raf0 = win.requestAnimationFrame.bind(win), now = o.now ?? (() => (win.performance ?? performance).now());
  const m = { prevT: null, lastShownT: null, flag: false, drawsSeen: o.draws ? o.draws() : 0, work: 0, known: false, frameT: null, ask: [null, 0], askPrev: [null, 0], dataAt: null, gl: null };
  // (the asks: the last two frames' last requests, by the frame they were made in)
  win.requestAnimationFrame = function (cb) {
    const at = now();
    if (m.ask[0] !== m.frameT) m.askPrev = m.ask;
    m.ask = [m.frameT, at];
    return raf0((t) => { m.frameT = t; cb(t); });
  };
  const tick = (t) => {
    if (o.stopped?.()) return;
    if (m.frameT !== t) m.frameT = t; // (this frame's asks are this frame's)
    if (m.prevT !== null) {
      const a = m.ask[0] === m.prevT ? m.ask : m.askPrev[0] === m.prevT ? m.askPrev : null;
      if (a) { m.work += Math.max(0, a[1] - m.prevT); m.known = true; }
      const d = o.draws ? o.draws() : null, shown = m.flag || (d !== null && d !== m.drawsSeen);
      m.flag = false; if (d !== null) m.drawsSeen = d;
      if (shown) {
        if (!m.gl && o.gl) { const ctx = o.gl(); if (ctx) { m.gl = ctx; o.onGl?.(ctx); } }
        o.onShown?.(m.prevT);
        const dw = o.data?.(), dms = dw ? dw.ms : 0, dd = m.dataAt === null ? 0 : Math.max(0, dms - m.dataAt); m.dataAt = dms;
        if (m.lastShownT !== null && (o.active?.() ?? true)) o.onFrame(m.prevT - m.lastShownT, m.known ? m.work : null, dd, m.prevT);
        m.lastShownT = m.prevT; m.work = 0; m.known = false;
      }
    }
    m.prevT = t; raf0(tick);
  };
  raf0(tick);
  return { meter: m, shown: () => { m.flag = true; } };
}

/**
 * A port's game data for its passive record (PerfSession's `data`, the same for every port): its waits, cumulative
 * ({ waits, ms }: each minute's), and `sum` what they were for so far (the record's totals, perf-record.js
 * compactDataSum) — the files waited for (the shared game data's fileWaits), the engine's own stops for its files when
 * it counts them (`engine.orthrosBlocked`: { count, ms, max, files: ms by path } — reVC; `root` its game folder in the
 * engine's file system, left out of the paths), its announced reads' waits, the background's bytes by producer (the
 * link's bgBy; a getter: the frames' meter reads only `ms`, each frame). gameData: the page's GameData
 * (data-client.js), null before (then null).
 * @param {any} gameData @param {any} [engine] @param {{ root?: string }} [o]
 */
export function portDataSummary(gameData, engine = null, { root = '' } = {}) {
  if (!gameData) return null;
  const s = gameData.stats ?? {}, rel = (p) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
  return { waits: s.misses ?? 0, ms: s.stallMs ?? 0,
    get sum() {
      const B = engine?.orthrosBlocked;
      const blocked = B ? { count: B.count ?? 0, ms: B.ms ?? 0, max: B.max ?? 0, files: Object.fromEntries(Object.entries(B.files ?? {}).map(([k, v]) => [rel(k), v])) } : null;
      return { files: s.fileWaits ?? null, blocked, wantWaits: s.wantWaits ?? 0, wantWaitMs: s.wantWaitMs ?? 0, wantTimeouts: s.wantTimeouts ?? 0, bgBy: gameData.net?.bgBy ?? null };
    } };
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

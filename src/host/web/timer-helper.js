// Host timer helper (docs/thread-scheduling.md "Host timer resolution"): on Windows a timed wait (Atomics.wait, setTimeout)
// ends at a system timer tick — 15.625 ms by default, ~1 ms while some code of the browser process holds a 1 ms
// resolution — and Chrome raises that resolution only in some cases (a short setTimeout/setInterval chain running, not on
// battery...). A game's frame limiter on a coarse host then oversleeps its last wait (core/host-wait.js spins to hide it,
// at ~8 ms of a core per frame). This module measures the granularity once (a probe worker's Atomics.wait(1): the p50
// overshoot), and only when it is coarse (> COARSE_MS) tries small helpers that may hold the 1 ms resolution — a
// setInterval(1) or a setTimeout(0) chain on the page, the same in a tiny worker (each ~1 % of a core; a MessageChannel
// ping-pong would hold a whole core: measured 107 %, not offered) — measuring the
// granularity under each, and keeps the best one (when it gains) only while a pacing loop runs and the tab is visible.
// A fine host (Linux, Windows with a 1 ms resolution already) stays at "fine": nothing is ever started.
// The decision logic is plain (a fake clock in the tests); the browser variants are at the end of the file.
//
// Debug switches (page globals; ?dbg= and the harness's dbg: steps, forwarded by the worker): ORTHROS_HOST_TIMER_HELPER_OFF=1
// never runs a helper (and stops the one running); ORTHROS_HOST_TIMER_HELPER_FORCE=<variant> runs that variant while a pacing
// loop runs, without measuring (CPU cost A/B on a fine host).

/** a probe p50 (ms) above this is a coarse host timer: helpers are tried */
export const COARSE_MS = 4;
/** a variant is kept when it brings the p50 under this share of the baseline, and by at least MIN_GAIN_MS */
export const GAIN_RATIO = 0.6, MIN_GAIN_MS = 1;
/** a helper is stopped this long (ms) after the last sign of a pacing loop */
export const PACE_IDLE_MS = 5000;
/** the chosen helper's effect is measured again this often (ms) while it runs (Chrome drops the resolution on battery) */
export const RECHECK_MS = 30000;

/**
 * The variant to keep: among `tried` ({ name: p50 | null }, in order of cost, cheapest first) the first whose p50 is within
 * 1 ms (or 1.5 times) of the best one, when that best one gains over `baseline` enough; else null.
 */
export function pickVariant(baseline, tried) {
  let bp = Infinity;
  for (const v of Object.values(tried)) if (typeof v === 'number' && v < bp) bp = v;
  if (!(bp <= baseline * GAIN_RATIO && baseline - bp >= MIN_GAIN_MS)) return null;
  for (const [k, v] of Object.entries(tried)) if (typeof v === 'number' && v <= Math.max(bp + 1, bp * 1.5)) return k;
  return null;
}

export const helperOff = (g = globalThis) => { const v = g.ORTHROS_HOST_TIMER_HELPER_OFF; return v !== undefined && v !== '' && Number(v) !== 0; };
export const helperForced = (g = globalThis) => { const v = g.ORTHROS_HOST_TIMER_HELPER_FORCE; return typeof v === 'string' && v ? v : ''; };

export class TimerHelper {
  /**
   * @param {{ probe: (n?: number) => Promise<number|null>, variants: { name: string, start: () => (() => void) }[],
   *   visible?: () => boolean, now?: () => number, sleep?: (ms: number) => Promise<void>, g?: object }} o
   *   probe: the p50 overshoot (ms) of a 1 ms wait now (null: it could not be measured)
   */
  constructor(o) {
    this.o = o; this.g = o.g ?? globalThis; this.now = o.now ?? (() => performance.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rec = { status: 'idle', baseline: null, tried: {}, chosen: null, after: null, runMs: 0, starts: 0 };
    this.stop = null; this.runningName = null; this.startedAt = 0; this.paceAt = -Infinity; this.calibrating = false; this.checkedAt = 0;
  }
  /** The worker's stats show a pacing loop (host waits going on) now. */
  pacing(on = true) { if (on) this.paceAt = this.now(); return this.apply(); }
  active() { return !helperOff(this.g) && (this.o.visible?.() ?? true) && this.now() - this.paceAt <= PACE_IDLE_MS; }
  /** The variant that should be running now, or null. */
  wants() { return this.active() ? helperForced(this.g) || (this.rec.status === 'chosen' ? this.rec.chosen : null) : null; }
  /** Start or stop the helper as the state asks (page visible, pacing loop running, switches); first measurement when needed. */
  apply() {
    const name = this.wants();
    if (name && !this.stop && !this.calibrating) { const v = this.o.variants.find((x) => x.name === name); if (v) { this.stop = v.start(); this.runningName = name; this.startedAt = this.now(); this.rec.starts++; } }
    else if (!name && this.stop) this.halt();
    if (this.rec.status === 'idle' && !this.calibrating && this.active() && !helperForced(this.g)) this.calibrate();
    if (this.stop && this.rec.status === 'chosen' && this.now() - this.checkedAt > RECHECK_MS) this.recheck();
    return this.runningName;
  }
  halt() { try { this.stop?.(); } catch { /* gone */ } this.rec.runMs += this.now() - this.startedAt; this.stop = null; this.runningName = null; }
  /** Measure the granularity; when coarse, try the variants and keep the best. Resolves to the record. */
  async calibrate() {
    if (this.calibrating) return this.rec;
    this.calibrating = true; this.rec.status = 'measuring';
    try {
      const base = await this.o.probe(24);
      if (base === null || base === undefined) { this.rec.status = 'unmeasured'; return this.rec; }
      this.rec.baseline = base;
      if (base <= COARSE_MS) { this.rec.status = 'fine'; return this.rec; }
      for (const v of this.o.variants) {
        let stop = null;
        try { stop = v.start(); await this.sleep(150); this.rec.tried[v.name] = await this.o.probe(24); } catch { this.rec.tried[v.name] = null; } finally { try { stop?.(); } catch { /* gone */ } }
      }
      const best = pickVariant(base, this.rec.tried);
      this.rec.chosen = best; this.rec.after = best ? this.rec.tried[best] : null;
      this.rec.status = best ? 'chosen' : 'coarse-none';
    } finally { this.calibrating = false; this.checkedAt = this.now(); }
    this.apply();
    return this.rec;
  }
  /** While the chosen helper runs: measure again; a helper that no longer helps (battery) is dropped. */
  async recheck() {
    this.checkedAt = this.now();
    const p = await this.o.probe(24);
    if (p === null || p === undefined) return;
    this.rec.after = p;
    if (this.stop && p > COARSE_MS) { this.halt(); this.rec.status = 'ineffective'; }
  }
  /** The record for the perf record and the probe's results (compact). */
  report() { const r = this.rec; return { status: r.status, baseline: r.baseline, tried: { ...r.tried }, chosen: r.chosen, after: r.after, running: this.runningName, runMs: Math.round(r.runMs + (this.stop ? this.now() - this.startedAt : 0)), starts: r.starts, forced: helperForced(this.g) || undefined, off: helperOff(this.g) || undefined }; }
}

// ---------------------------------------------------------------- the browser's variants
const noop = () => {};
/** The helper variants of a page, cheapest first (measured in Chromium on Linux: tools/timer-helper-bench.mjs). */
export function browserVariants(win = globalThis) {
  return [
    { name: 'page-interval', start: () => { const id = win.setInterval(noop, 1); return () => win.clearInterval(id); } },
    { name: 'page-timeout', start: () => { let on = true; const f = () => { if (on) win.setTimeout(f, 0); }; win.setTimeout(f, 0); return () => { on = false; }; } },
    { name: 'worker-interval', start: () => { const w = new Worker(import.meta.url, { type: 'module', name: 'orthros-timer-helper' }); return () => w.terminate(); } },
  ];
}
// (this module as the helper worker: a 1 ms interval, nothing else)
if (typeof WorkerGlobalScope !== 'undefined' && globalThis.name === 'orthros-timer-helper') setInterval(noop, 1);

/**
 * The probe: a persistent worker (timing-probe.js, mode 'wait') measuring Atomics.wait(1)'s p50 overshoot on request.
 * @returns {{ probe: (n?: number) => Promise<number|null>, close: () => void } | null}
 */
export function createWaitProbe(probeUrl, q = 0) {
  if (typeof Worker === 'undefined' || typeof SharedArrayBuffer === 'undefined') return null;
  let w; try { w = new Worker(probeUrl, { type: 'module', name: 'orthros-timing-probe' }); } catch { return null; }
  let pending = null;
  w.onmessage = (e) => { if (e.data?.wait !== undefined) { const p = pending; pending = null; p?.(e.data.wait); } };
  w.onerror = () => { const p = pending; pending = null; p?.(null); };
  return { probe: (n = 24) => new Promise((resolve) => { pending = resolve; w.postMessage({ mode: 'wait', n, q }); setTimeout(() => { if (pending === resolve) { pending = null; resolve(null); } }, 5000); }), close: () => w.terminate() };
}

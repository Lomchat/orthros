// The emulator thread's own waits on the host (docs/thread-scheduling.md, "Host wake-up overshoot"): every timed wait
// of a guest thread — Sleep, a timed WaitFor*, the Sleep(0) throttle's 1 ms park — ends with the emulator's worker
// blocked in Atomics.wait (Node: RealClock.sleep) or, for longer ones in the browser, a setTimeout. How late those wake
// up is the browser's business: on Linux Chrome ~0.05-0.1 ms, on Windows up to a system timer tick (15.625 ms by
// default; ~1-2 ms while some code of the process holds a 1 ms timer resolution — Chrome drops it on battery). A game
// pacing itself with Sleep(0)/Sleep(1) + timeGetTime then overshoots its frame deadline by that much at its last wait.
//
// HostWaiter makes those wake-ups precise where it matters, without spinning when the host is precise anyway:
// - it measures the overshoot of its own host waits (`est`: the second largest of the last 16 overshoots — a single
//   stall, a garbage collection, does not raise it; a coarse timer does at once), a separate estimate for timers;
// - a wait for a deadline further than that estimate asks the host for the time left minus the estimate (free: the
//   host wakes earlier, the rest is waited again);
// - what is left once a host wait would overshoot (left <= est) is spun on performance.now() only near the end of a
//   guest pacing loop (`paceEnd`: a frame limiter's predicted end, set by kernel32's Sleep — see pacePredict) and only
//   within SPIN_MAX_MS of the deadline; elsewhere it is a plain host wait, its overshoot accepted (a background thread's
//   Sleep(1) is not worth a core). An overshoot up to TOLERATE_MS is always accepted: no spin at all on a precise host.
// The guest still wakes at or after its deadline (its clock is performance.now()): timing stays faithful, only the
// host's lateness is taken out of the frame limiter's last wait.
//
// Pacing loops (pacePredict): a game's frame limiter polls the clock — Sleep(0) + timeGetTime (BFME), Sleep(1) +
// timeGetTime — until its next frame time, then works. Only its last wait's overshoot lengthens the frame; every earlier
// one only shortens the polling. kernel32 notes when each loop ends (the thread's polling streak broken by real work);
// the next end is predicted from the loops' period (the second shortest of the last 8 end-to-end intervals: an end is
// never earlier than the limiter's period after the previous one, a late one only lengthens one interval). Waits that
// would wake after `paceEnd - est` are the last ones: they are spun (on a coarse host the limiter's last ~est ms spin,
// as the game's loop spins on Windows; outside them the worker sleeps as before).
//
// Debug switches (globals; ?dbg= in the page, `dbg:` scenario steps, --dbg in the tools), read at each wait:
// - ORTHROS_HOST_TIMER_Q=<ms>: inject a coarse host timer — every host wait (Atomics.wait, the worker's setTimeout)
//   asked for t ms is rounded up to whole milliseconds and ends at the first multiple of <ms> (performance.now() time
//   base) at or after it, as Windows' timer interrupt ends them (15.625: the default tick; 1: a 1 ms resolution);
// - ORTHROS_ADAPTIVE_SLEEP=0: plain host waits (the behaviour before 2026-10-22), for A/B.

/** a deadline this close (ms) is reached by spinning on performance.now() when a host wait would overshoot it */
export const SPIN_MAX_MS = 2;
/** an overshoot this small (ms) is accepted: no spin for it */
export const TOLERATE_MS = 0.25;
/** a pacing loop's predicted end is trusted this long after it (ms): later, the prediction failed (a longer frame) */
export const PACE_SLACK_MS = 4;
/** pacing loops' ends kept (pacePredict) */
export const PACE_RING = 9;
const RING = 16;
/** overshoot histogram bucket upper bounds (ms; the last bucket is open) */
export const OVER_BOUNDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

/** The injected timer quantum (ORTHROS_HOST_TIMER_Q, ms), 0 when off. */
export function injectedQuantum() { const q = Number(globalThis.ORTHROS_HOST_TIMER_Q); return q > 0 ? q : 0; }
/** The adaptive waits are on (ORTHROS_ADAPTIVE_SLEEP not 0). */
export function adaptiveOn() { const v = globalThis.ORTHROS_ADAPTIVE_SLEEP; return v === undefined || v === '' || Number(v) !== 0; }
/**
 * How long a host wait asked for `ms` at `t0` lasts with the injected quantum `q` (ms; `ms` itself without one): whole
 * milliseconds (Chrome rounds a wait's timeout up), then the first multiple of `q` at or after that end.
 */
export function quantised(t0, ms, q = injectedQuantum()) {
  if (!(q > 0) || !(ms > 0)) return ms;
  const end = Math.ceil((t0 + Math.ceil(ms - 1e-9)) / q - 1e-9) * q;
  return Math.max(ms, end - t0);
}

/** A moving estimate of a wake-up source's overshoot: the second largest of the last RING samples. */
export class OvershootEstimate {
  constructor() { this.ring = new Float64Array(RING); this.n = 0; this.value = 0; }
  /** a measured overshoot (ms) */
  add(over) {
    this.ring[this.n++ % RING] = Math.max(0, over);
    let a = 0, b = 0; const k = Math.min(this.n, RING);
    for (let i = 0; i < k; i++) { const v = this.ring[i]; if (v > a) { b = a; a = v; } else if (v > b) b = v; }
    this.value = k >= 2 ? b : a;
  }
}

/** Per-source wait statistics (telemetry: the bench phases, the summaries). */
function newStats() { return { waits: 0, overMs: 0, overMax: 0, hist: new Array(OVER_BOUNDS.length + 1).fill(0), spins: 0, spinMs: 0, early: 0, plain: 0, lateMs: 0, q: 0, modes: 0 }; }

export class HostWaiter {
  /**
   * @param {() => number} [now] the host clock (ms)
   * @param {(arr: Int32Array, idx: number, value: number, ms: number) => string} [rawWait] the host wait (Atomics.wait)
   */
  constructor(now = () => performance.now(), rawWait = (arr, idx, value, ms) => Atomics.wait(arr, idx, value, ms)) {
    this.now = now; this.rawWait = rawWait;
    this.est = new OvershootEstimate(); // (Atomics.wait)
    this.timerEst = new OvershootEstimate(); // (the worker's setTimeout, measured at the pump)
    this.stats = newStats(); this.timer = newStats();
    this.tot = { waits: 0, overMs: 0, lateMs: 0, spins: 0, spinMs: 0, timers: 0, timerOverMs: 0 }; // (cumulative: the stats messages, summaries take differences)
    this.paceEnd = 0; // (host time: the predicted end of the guest's current pacing loop, 0 none — kernel32 sets it)
    this.lastLate = 0; // (the last wait's lateness that can lengthen a frame, ms: the frame accounting's `late`)
    this.ownSab = null;
  }
  /** One host wait of `ms` (the injected quantum applied): Atomics.wait's result. */
  hostWait(arr, idx, value, ms) {
    if (!(ms > 0)) return 'timed-out';
    return this.rawWait(arr, idx, value, quantised(this.now(), ms));
  }
  /** The guest's pacing loop is predicted to end at host time `t` (0: no prediction). */
  pace(t) { this.paceEnd = t > 0 ? t : 0; }
  /** A wait ending at `deadline` is one of a pacing loop's last ones (its overshoot would lengthen the frame). */
  lastPacingWait(deadline) { const e = this.paceEnd; return e > 0 && deadline > e - this.est.value - 0.5 && deadline <= e + PACE_SLACK_MS; }
  /**
   * A wait ending at `deadline` is one of a pacing loop's earlier waits: waking late only shortens the polling, the
   * frame is not longer (its lateness is not `late` for the frame accounting).
   */
  earlyPacingWait(deadline) { const e = this.paceEnd; return e > 0 && deadline <= e - this.est.value - 0.5; }
  /**
   * Block until the host time `deadline` (ms), or until arr[idx] is notified / no longer `value` (Atomics.wait's
   * result: 'ok' or 'not-equal' woken early, 'timed-out'). `precise` false: a wait without a deadline that matters
   * (a plain host wait, not counted as late).
   */
  waitUntil(arr, idx, value, deadline, precise = true) {
    let r = 'timed-out', t = this.now();
    if (deadline <= t) return r;
    const st = this.stats, adaptive = adaptiveOn();
    st.waits++; st.q = injectedQuantum(); st.modes |= adaptive ? 1 : 2; this.lastLate = 0;
    if (!precise || !adaptive) {
      st.plain++;
      r = this.hostWait(arr, idx, value, deadline - t);
      t = this.now();
      if (r === 'timed-out') { this.est.add(t - deadline); if (precise) this.noteEnd(st, t - deadline, deadline); }
      return r;
    }
    for (;;) {
      const left = deadline - t;
      if (left <= 0) break;
      const est = this.est.value;
      if (est > TOLERATE_MS && left > est) { // woken earlier by the estimate, the rest waited again
        st.early++;
        const t0 = t, ask = left - est; r = this.hostWait(arr, idx, value, ask);
        t = this.now();
        if (r !== 'timed-out') break; // (notified — input, a completion — or the word changed: the caller looks again)
        this.est.add(t - (t0 + ask));
        continue;
      }
      if (est > TOLERATE_MS && left <= SPIN_MAX_MS && this.lastPacingWait(deadline)) { // the frame limiter's last wait: spun
        const s0 = t;
        while ((t = this.now()) < deadline) { if (Atomics.load(arr, idx) !== value) { r = 'not-equal'; break; } }
        st.spins++; st.spinMs += t - s0; this.tot.spins++; this.tot.spinMs += t - s0;
        break;
      }
      // a precise host, or a wait whose overshoot does not lengthen a frame: one host wait (its overshoot accepted)
      st.plain++;
      r = this.hostWait(arr, idx, value, left);
      t = this.now(); if (r === 'timed-out') this.est.add(t - deadline);
      break;
    }
    if (r === 'timed-out') this.noteEnd(st, t - deadline, deadline);
    return r;
  }
  /** A wait (or a timer: st === this.timer) ended `over` ms past its deadline (`deadline`: a wait's, for lastLate). */
  noteEnd(st, over, deadline) {
    if (over < 0) over = 0;
    st.overMs += over; if (over > st.overMax) st.overMax = over;
    let b = 0; while (b < OVER_BOUNDS.length && over > OVER_BOUNDS[b]) b++;
    st.hist[b]++;
    if (st === this.timer) { this.tot.timers++; this.tot.timerOverMs += over; return; }
    this.tot.waits++; this.tot.overMs += over;
    this.lastLate = deadline !== undefined && this.earlyPacingWait(deadline) ? 0 : over;
    st.lateMs += this.lastLate; this.tot.lateMs += this.lastLate;
  }
  /** The cumulative counters (the worker's stats messages: perf-summary.js takes their differences), rounded. */
  totals() { const t = this.tot, r = (x) => Math.round(x * 100) / 100; return { waits: t.waits, overMs: r(t.overMs), lateMs: r(t.lateMs), spins: t.spins, spinMs: r(t.spinMs), timers: t.timers, timerOverMs: r(t.timerOverMs), est: r(this.est.value), timerEst: r(this.timerEst.value) }; }
  /** Sleep `ms` on a private word (tests, tools). */
  sleep(ms) {
    if (!(ms > 0)) return;
    const arr = this.ownSab ??= new Int32Array(new SharedArrayBuffer(4));
    this.waitUntil(arr, 0, 0, this.now() + ms);
  }

  /**
   * The timer to arm for a wake-up `ms` from now (the worker's schedulePump): `ask` the time it is armed for — earlier by
   * the timers' measured overshoot when that would make it late (the rest is waited by the pump: Vm.runFor waits up to
   * 2 ms in waitUntil) — and `delay` the setTimeout delay (the injected quantum applied).
   */
  timerArm(ms, now = this.now()) {
    if (!(ms > 0)) return { ask: 0, delay: 0 };
    let ask = ms;
    const est = this.timerEst.value;
    if (adaptiveOn() && est > TOLERATE_MS && ms > est) { ask = ms - est; this.timer.early++; }
    return { ask, delay: quantised(now, ask) };
  }
  /** A timer fired: `over` ms past the time it was armed for, `late` ms past the wake-up wanted. */
  noteTimer(over, late) { this.timerEst.add(over); this.timer.waits++; this.noteEnd(this.timer, late); }

  /** The statistics since the last call (then reset), compact: per source waits, mean / max overshoot, histogram, spins. */
  take() {
    const f = (s) => (s.waits ? { waits: s.waits, overMean: Math.round(s.overMs / s.waits * 1000) / 1000, overMax: Math.round(s.overMax * 100) / 100, lateMs: Math.round(s.lateMs * 10) / 10, hist: s.hist.slice(), spins: s.spins, spinMs: Math.round(s.spinMs * 10) / 10, early: s.early, plain: s.plain } : null);
    // (the switches as the window's waits saw them: `adaptive` 'mixed' when they changed within it)
    const m = this.stats.modes, r = { wait: f(this.stats), timer: f(this.timer), est: Math.round(this.est.value * 1000) / 1000, timerEst: Math.round(this.timerEst.value * 1000) / 1000, q: this.stats.waits ? this.stats.q : injectedQuantum(), adaptive: m === 2 ? false : m === 3 ? 'mixed' : m === 1 ? true : adaptiveOn() };
    this.stats = newStats(); this.timer = newStats();
    return r;
  }
}

/**
 * A pacing loop of a guest thread ended at guest time `t` (kernel32: the polling streak broken by other work). `st`:
 * the thread's sleep statistics (machine state: plain numbers in thread.sleepStats).
 */
export function paceEnded(st, t) {
  const e = st.paceEnds ??= [];
  if (e.length && t - e[e.length - 1] > 1000) e.length = 0; // (a pause: the period starts again)
  e.push(t); if (e.length > PACE_RING) e.shift();
}
/**
 * The predicted end (guest time) of the thread's current pacing loop, or -1: the last end plus the loops' period (the
 * second shortest of the last intervals — at least 3 of them). -1 as well once `now` is PACE_SLACK_MS past it.
 */
export function pacePredict(st, now) {
  const e = st.paceEnds;
  if (!e || e.length < 4) return -1;
  let a = Infinity, b = Infinity;
  for (let i = 1; i < e.length; i++) { const d = e[i] - e[i - 1]; if (d < a) { b = a; a = d; } else if (d < b) b = d; }
  const end = e[e.length - 1] + b;
  return now > end + PACE_SLACK_MS ? -1 : end;
}

// snapshot: host-side (the browser's timer behaviour, measured: not machine state)
export const hostWaiter = new HostWaiter();

// The system timer resolution (Windows' clock interrupt), as the guest sees it.
//
// Windows does not wake a sleeping or timed-out thread at an arbitrary instant: timer expirations are checked at the
// clock interrupt, which fires every 15.625 ms by default (64 Hz) and every `p` ms while some program holds
// timeBeginPeriod(p) (winmm; the smallest request wins, down to 1 ms). So:
//   - Sleep(n) / a wait timing out after n ms ends at the first interrupt at or after now + n: Sleep(1) lasts ~15.6 ms
//     at the default resolution, 1-2 ms under timeBeginPeriod(1);
//   - GetTickCount advances only at the clock tick, in steps of 15.625 ms (15 or 16) whatever the resolution;
//   - timeGetTime advances at the interrupt: in 1 ms steps under timeBeginPeriod(1), coarser otherwise.
// Before this model Orthros woke threads at the exact millisecond and both tick counters ran in 1 ms steps: a thread
// looping on Sleep(1) without timeBeginPeriod ran ~15 times more often than on Windows, and a program comparing tick
// counts saw them change between calls where Windows shows the same value.
//
// `?dbg=ORTHROS_TIMER_RES=<ms>` sets the default resolution (15.625; 0: the exact behaviour before, no rounding at all).

/** Windows' default clock interrupt period (ms) and GetTickCount's step */
export const DEFAULT_TIMER_RES = 15.625;

export class TimerResolution {
  /** @param {number} [defaultMs] the resolution with no timeBeginPeriod request (0: no rounding anywhere) */
  constructor(defaultMs = DEFAULT_TIMER_RES) {
    this.defaultMs = defaultMs;
    /** @type {Map<number, number>} active timeBeginPeriod requests: period -> count */
    this.requests = new Map();
    this.ms = defaultMs;
    /** timeGetTime's last value: it never goes back when the resolution gets coarser (timeEndPeriod) */
    this.lastMm = 0;
  }

  /** timeBeginPeriod(p): false (TIMERR_NOCANDO) for a period outside 1..1000000 */
  begin(p) {
    if (!(p >= 1 && p <= 1000000)) return false;
    this.requests.set(p, (this.requests.get(p) ?? 0) + 1);
    this.update();
    return true;
  }

  /** timeEndPeriod(p): false (TIMERR_NOCANDO) without a matching begin */
  end(p) {
    const n = this.requests.get(p);
    if (!n) return false;
    if (n === 1) this.requests.delete(p); else this.requests.set(p, n - 1);
    this.update();
    return true;
  }

  update() {
    let r = this.defaultMs;
    if (r > 0) for (const p of this.requests.keys()) if (p < r) r = p;
    this.ms = r;
  }

  /** the first clock interrupt at or after `t` (ms of the VM clock): when a timeout due at `t` is noticed */
  tickAt(t) {
    const r = this.ms;
    if (!(r > 0) || !Number.isFinite(t)) return t;
    const k = Math.ceil(t / r - 1e-9);
    return k * r;
  }

  /** GetTickCount's milliseconds at clock time `now`: the last 15.625 ms tick (integer ms) */
  tickCount(now) {
    if (!(this.defaultMs > 0)) return Math.floor(now);
    return Math.floor(Math.floor(now / DEFAULT_TIMER_RES) * DEFAULT_TIMER_RES);
  }

  /** timeGetTime's milliseconds at clock time `now`: the last interrupt (integer ms). Monotonic: after a switch to a
   * coarser period (timeEndPeriod(1) at 1010.3 ms: the 15.625 ms grid's last interrupt is 1000) the value holds until the
   * next interrupt of the new period instead of going back, as Windows' interrupt time never does */
  mmTime(now) {
    const r = this.ms;
    const v = !(r > 0) ? Math.floor(now) : Math.floor(Math.floor(now / r) * r);
    return v >= this.lastMm ? (this.lastMm = v) : this.lastMm;
  }
}

/** the resolution from the debug switch (see above) */
export function timerResFromDebug() {
  const v = globalThis.ORTHROS_TIMER_RES;
  return new TimerResolution(v === undefined || v === '' ? DEFAULT_TIMER_RES : Number(v));
}

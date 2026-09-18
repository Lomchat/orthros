// Time sources. RealClock follows wall time and really sleeps (Atomics.wait blocks the
// current JS thread, which is what the guest expects from Sleep/WaitFor*). VirtualClock is
// used by tests: sleeping just advances time.

export class RealClock {
  constructor() {
    this.origin = performance.now();
    this.sab = new Int32Array(new SharedArrayBuffer(4));
  }
  /** milliseconds since process start (fractional) */
  now() { return performance.now() - this.origin; }
  /** wall clock ms since epoch */
  wall() { return Date.now(); }
  sleep(ms) {
    if (ms <= 0) return;
    try { Atomics.wait(this.sab, 0, 0, ms); }
    catch { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
  }
  sleepUntil(t) { this.sleep(t - this.now()); }
}

export class VirtualClock {
  constructor(startWall = 1135000000000) {
    this.t = 0;
    this.wallOrigin = startWall;
    this.slept = 0;
  }
  now() { return this.t; }
  wall() { return this.wallOrigin + this.t; }
  sleep(ms) { if (ms > 0) { this.t += ms; this.slept += ms; } }
  sleepUntil(t) { if (t > this.t) { this.slept += t - this.t; this.t = t; } }
  /** advance by a small amount to model instruction execution time (called by the scheduler) */
  tick(ms) { this.t += ms; }
}

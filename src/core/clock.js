// Time sources. RealClock follows wall time and really sleeps (Atomics.wait blocks the
// current JS thread, which is what the guest expects from Sleep/WaitFor*). VirtualClock is
// used by tests: sleeping just advances time.

export class RealClock {
  /**
   * @param {number} [scale] guest milliseconds per real millisecond (debugging: below 1 the guest sees a faster
   *   machine — its time runs slower than the work done — above 1 a slower one)
   */
  constructor(scale = 1) {
    this.origin = performance.now();
    this.scale = scale;
    this.sab = new Int32Array(new SharedArrayBuffer(4));
  }
  /** milliseconds since process start (fractional) */
  now() { return this.scale === 1 ? performance.now() - this.origin : (performance.now() - this.origin) * this.scale; }
  /** real milliseconds for `ms` guest milliseconds */
  real(ms) { return ms / this.scale; }
  /** wall clock ms since epoch */
  wall() { return Date.now(); }
  sleep(ms) {
    if (ms <= 0) return;
    ms /= this.scale;
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

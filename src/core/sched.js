// Green-thread scheduler (DECISIONS.md D003). All guest threads run on this JS thread; a
// blocked thread runs other runnable threads *nested* on the JS stack until its wake condition
// holds. Preemption between busy threads happens at the outermost dispatch level only.
import { TS } from '../win32/process.js';

export const INFINITE = 0xffffffff;
export const WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff;

export class Scheduler {
  /** @param {import('./vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.rr = 0;
    this.sliceMs = 4;
    this.deadlockLimit = 60000; // ms of virtual/real time with nothing runnable and no timers
  }

  get threads() { return this.vm.proc.threads; }

  /** Next runnable thread other than `except` (round robin). */
  pickRunnable(except) {
    const ts = this.threads;
    const n = ts.length;
    for (let k = 0; k < n; k++) {
      const t = ts[(this.rr + k) % n];
      if (t !== except && t.isRunnable()) { this.rr = (this.rr + k + 1) % n; return t; }
    }
    return null;
  }

  /** Earliest wake-up time among sleeping/blocked threads and process timers. */
  nextWake() {
    let w = Infinity;
    for (const t of this.threads) if (t.state === TS.BLOCKED && t.wakeAt < w) w = t.wakeAt;
    const timers = this.vm.proc.timers;
    for (const tm of timers) if (tm.due < w) w = tm.due;
    const host = this.vm.host?.nextWake?.();
    if (host !== undefined && host < w) w = host;
    return w;
  }

  /**
   * Block `thread` until cond() is true or the timeout elapses. Other threads run meanwhile.
   * @param {import('../win32/process.js').Thread} thread
   * @param {() => boolean} cond
   * @param {number} timeoutMs (INFINITE for no timeout)
   * @param {string} reason
   * @returns {boolean} true if cond became true, false on timeout
   */
  block(thread, cond, timeoutMs, reason) {
    const clock = this.vm.clock;
    const deadline = timeoutMs === INFINITE ? Infinity : clock.now() + timeoutMs;
    let idleSince = -1;
    for (;;) {
      if (cond()) { thread.state = TS.RUNNING; thread.wakeAt = Infinity; return true; }
      if (clock.now() >= deadline) { thread.state = TS.RUNNING; thread.wakeAt = Infinity; return false; }
      if (thread.pendingExit) { thread.state = TS.RUNNING; return false; }
      thread.state = TS.BLOCKED;
      thread.blockReason = reason;
      thread.wakeAt = deadline;
      const other = this.pickRunnable(thread);
      if (other) {
        idleSince = -1;
        this.vm.runThread(other, { slice: true });
        continue;
      }
      // Nothing else can run: let the host pump events, then sleep until the earliest wake-up.
      if (this.vm.host?.pump) this.vm.host.pump();
      if (cond()) continue;
      const wake = Math.min(this.nextWake(), deadline);
      if (wake === Infinity) {
        if (idleSince < 0) idleSince = clock.now();
        // Wait for an external event (input, message) if the host can provide one.
        if (this.vm.host?.waitEvent) { this.vm.host.waitEvent(this.deadlockLimit); }
        else clock.sleep(1);
        if (clock.now() - idleSince > this.deadlockLimit) this.vm.deadlock(thread, reason);
        continue;
      }
      idleSince = -1;
      const now = clock.now();
      if (wake > now) {
        if (this.vm.host?.waitEvent) this.vm.host.waitEvent(wake - now);
        else clock.sleepUntil(wake);
      }
    }
  }

  /** Let other runnable threads run for one slice each (called on preemption). */
  yieldFrom(thread) {
    const other = this.pickRunnable(thread);
    if (!other) return false;
    this.vm.runThread(other, { slice: true });
    return true;
  }
}

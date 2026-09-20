// Green-thread scheduler (DECISIONS.md D003/D021). All guest threads run on this JS thread in
// time slices from the top-level run loop. A thread that blocks in an API handler at top level
// *unwinds*: the handler throws WaitUnwind, the API call is rolled back (EIP/ESP at the thunk),
// the thread is parked with its wake condition, and the run loop moves on. When the condition
// holds (or the timeout passes) the thread re-executes the call, whose `block()` then returns
// the recorded result. Blocking inside a nested callback (window procedure, DllMain...) cannot
// unwind through the host's JS frames: it runs other threads nested until the condition holds.
import { TS } from '../win32/process.js';

export const INFINITE = 0xffffffff;
export const WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff;

export class WaitUnwind extends Error {
  constructor(wait) { super('wait unwind'); this.wait = wait; }
}

export class Scheduler {
  /** @param {import('./vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.rr = 0;
    this.deadlockLimit = 60000; // ms of virtual/real time with nothing runnable and no timers
    this.idleSince = -1;
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

  /** Wake parked threads whose condition holds or whose timeout passed. Returns true if any woke. */
  wakeBlocked() {
    const now = this.vm.clock.now();
    let any = false;
    for (const t of this.threads) {
      if (t.state !== TS.BLOCKED || !t.wait) continue;
      if (t.pendingExit) { this.wake(t, false); any = true; continue; }
      let ok;
      try { ok = t.wait.cond(); } catch (e) { this.vm.warn(`wait condition threw: ${e.message}`); ok = true; }
      if (ok) { if (t.wait.claim) { t.wakeValue = t.wait.claim(true); this.vm.proc.syncTrace?.(`wake t${t.id} [${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}] -> ${t.wakeValue}`); } this.wake(t, true); any = true; }
      else if (now >= t.wait.deadline) { this.wake(t, false); any = true; }
    }
    return any;
  }

  /**
   * A synchronization object was released or signaled: hand it to a parked waiter right away, before the
   * signaling thread can take it back (Windows satisfies waits at signal time; a releaser that immediately
   * re-acquires never starves a waiter). Only claim-carrying waits (mutex/event/semaphore/critical section)
   * are considered; plain sleeps and message waits wake at the next scheduling point as before.
   */
  signal() {
    for (const t of this.threads) {
      if (t.state !== TS.BLOCKED || !t.wait?.claim || t.pendingExit) continue;
      let ok;
      try { ok = t.wait.cond(); } catch (e) { ok = false; }
      if (ok) { t.wakeValue = t.wait.claim(true); this.vm.proc.syncTrace?.(`signal t${t.id} [${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}] -> ${t.wakeValue}`); this.wake(t, true); }
    }
  }

  wake(t, ok) {
    t.wakeResult = ok; t.resuming = true; t.wait = null; t.wakeAt = Infinity; t.blockReason = null;
    t.state = TS.READY;
  }

  /**
   * Block `thread` until cond() is true or the timeout elapses.
   * @param {import('../win32/process.js').Thread} thread
   * @param {() => boolean} cond
   * @param {number} timeoutMs (INFINITE for no timeout)
   * @param {string} reason
   * @param {(() => any)=} claim runs as soon as cond holds — at the wake-up, before any other thread runs — to
   *   take the awaited object (mutex ownership, auto-reset event, semaphore count) exactly like the Windows kernel
   *   satisfies a wait at signal time; its value is left in `thread.wakeValue` for the re-executed call.
   * @returns {boolean} true if cond became true, false on timeout
   */
  block(thread, cond, timeoutMs, reason, claim) {
    if (thread.wakeResult !== undefined) { // re-executed call after an unwound wait: the recorded outcome
      const r = thread.wakeResult;
      thread.wakeResult = undefined; thread.resuming = false;
      thread.state = TS.RUNNING;
      return r;
    }
    const clock = this.vm.clock;
    if (cond()) { thread.wakeValue = claim ? claim(false) : undefined; return true; }
    const deadline = timeoutMs === INFINITE ? Infinity : clock.now() + timeoutMs;
    if (clock.now() >= deadline) return false;
    if (this.vm.canUnwind(thread)) throw new WaitUnwind({ cond, deadline, reason, claim });
    // Nested context: run the others on top of this JS frame until the condition holds.
    let idleSince = -1;
    for (;;) {
      if (cond()) { thread.state = TS.RUNNING; thread.wakeAt = Infinity; thread.wakeValue = claim ? claim(false) : undefined; return true; }
      if (clock.now() >= deadline) { thread.state = TS.RUNNING; thread.wakeAt = Infinity; return false; }
      if (thread.pendingExit) { thread.state = TS.RUNNING; return false; }
      thread.state = TS.BLOCKED;
      thread.blockReason = reason;
      thread.wakeAt = deadline;
      this.wakeBlocked();
      const other = this.pickRunnable(thread);
      if (other) {
        idleSince = -1;
        this.vm.runThread(other, { slice: true });
        continue;
      }
      if (this.vm.host?.pump) this.vm.host.pump();
      if (cond()) continue;
      const wake = Math.min(this.nextWake(), deadline);
      if (wake === Infinity) {
        if (idleSince < 0) idleSince = clock.now();
        if (this.vm.host?.waitEvent) this.vm.host.waitEvent(this.deadlockLimit);
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

  /** Give other runnable threads a turn. At top level this just ends the current slice. */
  yieldFrom(thread) {
    if (this.vm.canUnwind(thread)) { thread.yieldRequested = true; return this.pickRunnable(thread) !== null; }
    const other = this.pickRunnable(thread);
    if (!other) return false;
    this.vm.runThread(other, { slice: true });
    return true;
  }

  /** Top-level step when nothing is runnable: pump the host, wake threads, or sleep until the earliest wake-up. */
  idle() {
    const clock = this.vm.clock;
    if (this.vm.host?.pump) this.vm.host.pump();
    if (this.wakeBlocked()) { this.idleSince = -1; return; }
    const wake = this.nextWake();
    if (wake === Infinity) {
      if (this.idleSince < 0) this.idleSince = clock.now();
      if (this.vm.host?.waitEvent) this.vm.host.waitEvent(this.deadlockLimit);
      else clock.sleep(1);
      if (this.wakeBlocked()) { this.idleSince = -1; return; }
      if (clock.now() - this.idleSince > this.deadlockLimit) {
        const t = this.threads.find((x) => x.state === TS.BLOCKED) ?? this.threads[0];
        this.vm.deadlock(t, t?.blockReason ?? 'idle');
      }
      return;
    }
    this.idleSince = -1;
    const now = clock.now();
    if (wake > now) {
      if (this.vm.host?.waitEvent) this.vm.host.waitEvent(wake - now);
      else clock.sleepUntil(wake);
    }
    this.wakeBlocked();
  }
}

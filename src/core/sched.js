// Green-thread scheduler (DECISIONS.md D003/D021). All guest threads run on this JS thread in
// time slices from the top-level run loop. A thread that blocks in an API handler at top level
// *unwinds*: the handler throws WaitUnwind, the API call is rolled back (EIP/ESP at the thunk),
// the thread is parked with its wake condition, and the run loop moves on. When the condition
// holds (or the timeout passes) the thread re-executes the call, whose `block()` then returns
// the recorded result. Blocking inside a nested callback (window procedure, DllMain...) cannot
// unwind through the host's JS frames: it runs other threads nested until the condition holds.
import { TS } from '../win32/process.js';

export const INFINITE = 0xffffffff;
/** how long a ready thread may wait while higher-priority threads run before it runs anyway (pickRunnable): guest
 *  instructions executed (STARVE_INSNS), or scheduling decisions (threads yielding with Sleep(0) execute few) */
export const STARVE_PICKS = 1000;
/**
 * Starvation and the quantum are counted in guest instructions executed (Vm.guestInsns), not in time: a quantum is
 * processor time used, and the host's own load (the emulator descheduled for milliseconds in the middle of a few guest
 * instructions) must not decide where a thread is interrupted. 6 M instructions: ~20 ms at this emulator's speed
 * (~300 M guest instructions per second).
 */
export const STARVE_INSNS = 6_000_000;
/**
 * The quantum (guest instructions, see STARVE_INSNS): how long a thread whose time slice ended keeps the processor while no thread of
 * higher priority is ready — Windows rotates threads of equal priority at the end of a quantum (two clock ticks, ~31 ms
 * on a client system), not at every slice of this scheduler (a few hundred microseconds), and a thread preempted by a
 * higher priority resumes before its equals (see pickRunnable). The starvation delay, which ends it for a thread kept
 * waiting by an equal as well. Off by default (rotation at every slice): on a multi-core Windows machine threads of
 * equal priority run side by side, which every-slice rotation approximates better, and the quantum showed no gain
 * (BFME1 failure rate 4/40 both ways) while delaying hand-offs between polling threads by up to a quantum;
 * ?dbg=ORTHROS_QUANTUM_INSNS=<n> turns it on (QUANTUM_INSNS: the Windows-like value).
 */
export const QUANTUM_INSNS = STARVE_INSNS; // (an equal ready that long is starved anyway: see pickRunnable)
export const WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff;

/**
 * Thrown by a blocking API handler at top level to park its thread (see block()). Not an Error
 * subclass on purpose: an Error captures a stack trace at construction, which costs more than the
 * whole park/resume path (1.5 % of the worker in a scene with thousands of waits per second).
 */
export class WaitUnwind {
  constructor(wait) { this.wait = wait; }
}
/**
 * Returned (not thrown) by a handler whose wait parks its thread (Scheduler.park): the dispatcher rolls the call back
 * as for WaitUnwind, the wait being in thread.parkWait. The hot waits (Sleep, WaitForSingleObject) return it: a
 * thrown WaitUnwind costs far more than a return, at thousands of parks per second.
 */
export const PARK = Object.freeze({ park: true });

export class Scheduler {
  /** @param {import('./vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.rr = 0;
    this.deadlockLimit = 60000; // ms of virtual/real time with nothing runnable and no timers
    this.idleSince = -1;
    /** nested waits in progress (block() on top of a JavaScript frame): the event loop cannot run until they end */
    this.nestedWaits = 0;
    /** clock time of the last wakeBlocked() pass (see nextWake) */
    this.checkedAt = -Infinity;
    /** (measurement, ?dbg=ORTHROS_SCHED_ROUND_ROBIN=1: priorities ignored, every runnable thread in turn) */
    this.roundRobin = !!globalThis.ORTHROS_SCHED_ROUND_ROBIN;
    /** scheduling decisions so far (pickRunnable): starvation */
    this.picks = 0;
    /** (measurement, ?dbg=ORTHROS_STARVE_INSNS=<n>,ORTHROS_STARVE_PICKS=<n>: the starvation thresholds of pickRunnable) */
    this.starveInsns = Number(globalThis.ORTHROS_STARVE_INSNS) || STARVE_INSNS; this.starvePicks = Number(globalThis.ORTHROS_STARVE_PICKS) || STARVE_PICKS;
    /** the quantum (QUANTUM_INSNS; ?dbg=ORTHROS_QUANTUM_INSNS=<n>, 0 none), the thread holding it and where it ends (Vm.guestInsns) */
    this.quantumInsns = globalThis.ORTHROS_QUANTUM_INSNS !== undefined ? Number(globalThis.ORTHROS_QUANTUM_INSNS) : 0;
    this.quantumThread = null; this.quantumEnd = 0;
    /** a thread whose slice ended on its budget (Vm.sliceEnd), candidate to go on with its quantum (pickRunnable) */
    this.sliceExpired = null;
    /** { t, left }: a thread preempted by a higher priority with `left` ms of quantum: first among its equals afterwards */
    this.preempted = null;
  }

  /** `t` ready to run (again): the time and decision count it starts waiting from (starvation, see pickRunnable) */
  markReady(t) { t.state = TS.READY; t.readyTime = this.vm.guestInsns ?? 0; t.readyPick = this.picks; }

  get threads() { return this.vm.proc.threads; }

  /**
   * Next runnable thread other than `except`: the highest priority first (SetThreadPriority), round robin among equals —
   * as Windows schedules. A thread raised above the others (an audio mixer at THREAD_PRIORITY_TIME_CRITICAL) that its
   * time slice interrupted resumes before them: it is not left paused in the middle of its work while normal threads run
   * for whole slices (a window of thousands of their instructions where Windows has the high-priority work done at once).
   * A thread ready for STARVE_INSNS (or STARVE_PICKS scheduling decisions) runs whatever its priority (Windows boosts
   * starved threads likewise).
   */
  pickRunnable(except, top = false) {
    const ts = this.threads;
    const n = ts.length, now = this.vm.guestInsns ?? 0, picks = ++this.picks; // (instructions executed: see STARVE_INSNS)
    let best = null, bestK = 0, bestPrio = -Infinity;
    for (let k = 0; k < n; k++) {
      const t = ts[(this.rr + k) % n];
      if (t === except || !t.isRunnable()) continue;
      const prio = this.roundRobin ? 0 : now - t.readyTime > this.starveInsns || picks - t.readyPick > this.starvePicks ? 16 : (t.priority ?? 0);
      if (prio > bestPrio) { best = t; bestPrio = prio; bestK = k; }
    }
    // (the top-level pick: the thread whose slice ended — or the one a higher priority preempted — goes on with its
    // quantum unless a thread of higher priority is ready; a starved thread counts as higher)
    if (top && this.quantumInsns > 0 && !this.roundRobin) {
      const cont = this.sliceExpired;
      this.sliceExpired = null;
      let held = null;
      if (cont && cont === this.quantumThread && cont.isRunnable() && now < this.quantumEnd) held = { t: cont, left: this.quantumEnd - now };
      else if (this.preempted && this.preempted.t.isRunnable()) held = this.preempted;
      this.preempted = null;
      if (held) {
        if (bestPrio <= (held.t.priority ?? 0)) { this.quantumThread = held.t; this.quantumEnd = now + held.left; return held.t; }
        this.preempted = held; // (a higher priority first: the quantum left waits for it)
      }
      if (best) { this.quantumThread = best; this.quantumEnd = now + this.quantumInsns; }
    }
    if (best) this.rr = (this.rr + bestK + 1) % n;
    return best;
  }

  /**
   * Earliest wake-up time among sleeping/blocked threads and process timers. A timer already due at the last
   * wakeBlocked() pass does not count: every wait it could end was checked then and none did (a window timer whose
   * thread is busy or waits for something else stays due until that thread retrieves its WM_TIMER) — counted, it
   * made the idle loop spin without ever sleeping (nor returning to the event loop) until another thread woke.
   */
  nextWake() {
    let w = Infinity;
    for (const t of this.threads) if (t.state === TS.BLOCKED && t.wakeAt < w) w = t.wakeAt;
    const timers = this.vm.proc.timers, checked = this.checkedAt;
    for (const tm of timers) if (tm.due < w && tm.due > checked) w = tm.due;
    const host = this.vm.host?.nextWake?.();
    if (host !== undefined && host < w) w = host;
    const media = this.vm.media?.nextWake(); // (a movie playing: its next picture or sound refill, movie-player.js)
    if (media !== undefined && media < w) w = media;
    return w;
  }

  /** Wake parked threads whose condition holds or whose timeout passed. Returns true if any woke. */
  /** @param {number} [now] the clock's time when the caller has just read it */
  wakeBlocked(now = this.vm.clock.now()) {
    this.checkedAt = now;
    if (this.vm.media && now >= this.vm.media.due) this.vm.media.tick(now); // (movies advanced first: their events may wake waiters)
    let any = false;
    for (const t of this.threads) {
      if (t.state !== TS.BLOCKED || !t.wait) continue;
      if (t.pendingExit) { this.wake(t, false); any = true; continue; }
      let ok;
      try { ok = t.wait.cond(); } catch (e) { this.vm.warn(`wait condition threw: ${e.message} (t${t.id} ${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}; ${String(e.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim().replace(/^at /, '').replace(/\(?\S*\/src\//, '(')).join(' < ')})`); ok = true; }
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
    if (t.blockedAt !== undefined) { // (diagnostics, vm.waitLogMin: the main thread's long waits)
      const d = this.vm.clock.now() - t.blockedAt;
      if (t === this.threads[0] && this.vm.mainWaits) { const k = `${t.blockedApi}@${this.vm.proc.symbolize(t.blockedFrom)}`; this.vm.mainWaits.set(k, (this.vm.mainWaits.get(k) ?? 0) + d); }
      if (d >= this.vm.waitLogMin && t === this.threads[0]) this.vm.logFn('hang', `main thread waited ${d.toFixed(0)} ms in ${t.blockedApi} [${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}] from ${this.vm.proc.symbolize(t.blockedFrom)} (${ok ? 'satisfied' : 'timed out'})`);
      t.blockedAt = undefined;
    }
    t.wakeResult = ok; t.resuming = true; t.wait = null; t.wakeAt = Infinity; t.blockReason = null;
    this.markReady(t);
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
   * @param {boolean=} tick a guest timeout (Sleep, the Wait functions): it ends at the first clock interrupt at or after
   *   it, as Windows' kernel timers do (Sleep(1) lasts a tick: core/timer-res.js); the emulator's own short waits are exact
   * @returns {boolean} true if cond became true, false on timeout
   */
  block(thread, cond, timeoutMs, reason, claim, tick) { return this.wait(thread, cond, timeoutMs, reason, claim, false, tick); }
  /**
   * block() for a handler that returns PARK to the dispatcher instead of throwing WaitUnwind: the result is PARK when
   * the thread parks (the handler must return it at once), else block()'s result.
   */
  park(thread, cond, timeoutMs, reason, claim, tick) { return this.wait(thread, cond, timeoutMs, reason, claim, true, tick); }
  wait(thread, cond, timeoutMs, reason, claim, park, tick) {
    if (thread.wakeResult !== undefined) { // re-executed call after an unwound wait: the recorded outcome
      const r = thread.wakeResult;
      thread.wakeResult = undefined; thread.resuming = false;
      thread.state = TS.RUNNING;
      return r;
    }
    const clock = this.vm.clock;
    if (cond()) { thread.wakeValue = claim ? claim(false) : undefined; return true; }
    const now = clock.now();
    const deadline = timeoutMs === INFINITE ? Infinity : tick && timeoutMs > 0 && this.vm.timerRes ? this.vm.timerRes.tickAt(now + timeoutMs) : now + timeoutMs;
    if (now >= deadline) return false;
    if (this.vm.canUnwind(thread)) {
      const w = { cond, deadline, reason, claim };
      if (park) { thread.parkWait = w; return PARK; }
      throw new WaitUnwind(w);
    }
    // Nested context: run the others on top of this JS frame until the condition holds.
    this.nestedWaits++;
    try { return this.nestedWait(thread, cond, deadline, reason, claim); } finally { this.nestedWaits--; }
  }

  nestedWait(thread, cond, deadline, reason, claim) {
    const clock = this.vm.clock;
    let idleSince = -1;
    // (for the host's frame accounting: a wait for a file read — this thread's, or one another thread's read holds up,
    // or while the thread presenting frames waits for one — is not the game's pacing)
    const ioReason = reason === 'file read' || reason === 'file busy' || (this.vm.readsInFlight > 0 && reason !== 'sleep' && reason !== 'mmtimer' && reason !== 'peek'); // (peek: PeekMessage polling waits, user32.js peekIdle — pacing)
    const io = () => ioReason || !!this.vm.frameThreadWaitsForRead?.();
    const note = (ms) => { const k = `t${thread.id} ${reason}${io() ? ' (io)' : ''}`, m = (this.vm.nestedWaitLog ??= new Map()); if (m.size < 64 || m.has(k)) m.set(k, (m.get(k) ?? 0) + ms); }; // (diagnostics: who waits nested, for what)
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
      // (several processes, core/procs.js: the others run meanwhile — what this one waits for may be theirs)
      if (this.vm.group && this.vm.group.runOthers(this.vm)) continue;
      const wake = Math.min(this.nextWake(), deadline, this.vm.group ? clock.now() + 5 : Infinity);
      if (wake === Infinity) {
        if (idleSince < 0) idleSince = clock.now();
        if (this.vm.host?.waitEvent) { const w0 = clock.now(); this.vm.host.waitEvent(this.deadlockLimit, io()); note(clock.now() - w0); }
        else clock.sleep(1);
        if (clock.now() - idleSince > this.deadlockLimit) this.vm.deadlock(thread, reason);
        continue;
      }
      idleSince = -1;
      const now = clock.now();
      if (wake > now) {
        if (this.vm.host?.waitEvent) { this.vm.host.waitEvent(wake - now, io()); note(clock.now() - now); }
        else clock.sleepUntil(wake);
      }
    }
  }

  /** Give other runnable threads a turn. At top level this just ends the current slice. */
  yieldFrom(thread) {
    // (a yield with no other thread runnable still ends the slice: returning at once — as Windows does — was measured to
    // make a frame limiter polling Sleep(0) poll more often, not to make anything cheaper: see docs/api-layer.md)
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
      if (this.vm.host?.waitEvent) this.vm.host.waitEvent(this.deadlockLimit, !!this.vm.frameThreadWaitsForRead?.());
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
      // (frame accounting: while the thread presenting frames waits for a file read, the short waits between the other
      // threads' timers are the read's delay, not pacing)
      if (this.vm.host?.waitEvent) this.vm.host.waitEvent(wake - now, !!this.vm.frameThreadWaitsForRead?.());
      else clock.sleepUntil(wake);
    }
    this.wakeBlocked();
  }
}

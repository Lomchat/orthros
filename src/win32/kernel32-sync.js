// kernel32's synchronization primitives that live in the program's own memory (Vista+, the newer CRTs use them): slim
// reader/writer locks, condition variables, one-time initialization, interlocked singly linked lists
// (docs/compat-scan.md "kernel32 Vista+"). Green threads (DECISIONS.md D003): every operation is atomic; a thread that
// must wait parks through the scheduler (sched.block) and its call re-executes once woken, so each wait below is
// written to be re-entered: what it did before parking is recorded on the thread (`cvWait`), not done twice.
import { snapKnown } from '../core/snapshot.js';
import { INFINITE } from '../core/sched.js';
import { TS } from './process.js';
import { E } from './errors.js';

/**
 * @param {Record<string, any>} K kernel32's table (registerKernel32)
 * @param {import('../core/vm.js').Vm} vm
 * @param {{ enterCS: (c: any, p: number) => any, leaveCS: (c: any, p: number) => any }} cs kernel32's critical sections
 */
export function registerKernel32Sync(K, vm, { enterCS, leaveCS }) {
  const mem = vm.mem;

  // ---------------------------------------------------------------- SRW locks
  // SRWLOCK (pointer-sized), Windows' layout without waiters: 0 free, 1 held exclusively, (n << 4) | 1 held shared by n.
  // A shared request waits while a thread waits for exclusive access (no writer starvation), as on Windows.
  const SRW_SHARED = 0x10;
  const srwReasonX = (p) => `srw-exclusive 0x${p.toString(16)}`;
  const exclusiveWaiters = (p) => { const r = srwReasonX(p); return vm.sched.threads.some((t) => t.state === TS.BLOCKED && t.blockReason === r); };
  const freeForShared = (p) => { const v = mem.read32(p); return v === 0 || (v >>> 4 > 0 && !exclusiveWaiters(p)); };
  const acquireExclusive = (c, p) => vm.sched.block(c.thread, () => mem.read32(p) === 0, INFINITE, srwReasonX(p), () => { mem.write32(p, 1); });
  const acquireShared = (c, p) => vm.sched.block(c.thread, () => freeForShared(p), INFINITE, `srw-shared 0x${p.toString(16)}`, () => { const v = mem.read32(p); mem.write32(p, v === 0 ? SRW_SHARED | 1 : v + SRW_SHARED); });
  const releaseExclusive = (c, p) => {
    if (mem.read32(p) !== 1) vm.warn(`ReleaseSRWLockExclusive(0x${p.toString(16)}) of a lock not held exclusively (0x${mem.read32(p).toString(16)}) from ${c.proc.symbolize(c.retAddr)}`);
    mem.write32(p, 0); vm.sched.signal();
  };
  const releaseShared = (c, p) => {
    const n = mem.read32(p) >>> 4;
    if (n === 0) { vm.warn(`ReleaseSRWLockShared(0x${p.toString(16)}) of a lock not held shared from ${c.proc.symbolize(c.retAddr)}`); return; }
    mem.write32(p, n > 1 ? ((n - 1) << 4) | 1 : 0); vm.sched.signal();
  };
  K.InitializeSRWLock = [1, (c) => { mem.write32(c.arg(0), 0); }];
  K.AcquireSRWLockExclusive = [1, (c) => { acquireExclusive(c, c.arg(0)); }];
  K.AcquireSRWLockShared = [1, (c) => { acquireShared(c, c.arg(0)); }];
  K.ReleaseSRWLockExclusive = [1, (c) => { releaseExclusive(c, c.arg(0)); }];
  K.ReleaseSRWLockShared = [1, (c) => { releaseShared(c, c.arg(0)); }];
  K.TryAcquireSRWLockExclusive = [1, (c) => { const p = c.arg(0); if (mem.read32(p) !== 0) return 0; mem.write32(p, 1); return 1; }];
  K.TryAcquireSRWLockShared = [1, (c) => { const p = c.arg(0); if (!freeForShared(p)) return 0; const v = mem.read32(p); mem.write32(p, v === 0 ? SRW_SHARED | 1 : v + SRW_SHARED); return 1; }];

  // ---------------------------------------------------------------- condition variables
  // CONDITION_VARIABLE (pointer-sized) stays 0 in guest memory; its waiters, in arrival order, are here by address. A
  // sleep releases the lock, waits until a Wake takes it off the list (or the timeout), then takes the lock again.
  /** condition variable address -> ids of the threads waiting on it */
  const condVars = snapKnown(vm, 'kernel32.condVars', new Map());
  const cvSleep = (c, cv, ms, release, reacquire) => {
    const t = c.thread;
    let w = t.cvWait;
    if (!w) { // (a fresh call; a re-executed one finds its record)
      release();
      const list = condVars.get(cv) ?? []; list.push(t.id); condVars.set(cv, list);
      w = t.cvWait = { cv, phase: 0, ok: 1 };
    }
    if (w.phase === 0) {
      const woken = vm.sched.block(t, () => !condVars.get(cv)?.includes(t.id), ms === INFINITE ? INFINITE : ms, `condvar 0x${cv.toString(16)}`, undefined, true);
      if (!woken) { const list = condVars.get(cv) ?? [], i = list.indexOf(t.id); if (i >= 0) list.splice(i, 1); if (!list.length) condVars.delete(cv); w.ok = 0; }
      w.phase = 1;
    }
    reacquire(); // (may park again: the re-executed call comes back here, its claim done at the wake-up)
    t.cvWait = null;
    return w.ok ? 1 : c.fail(E.TIMEOUT);
  };
  K.InitializeConditionVariable = [1, (c) => { mem.write32(c.arg(0), 0); }];
  K.SleepConditionVariableCS = [3, (c) => { const cs = c.arg(1); return cvSleep(c, c.arg(0), c.arg(2), () => leaveCS(c, cs), () => enterCS(c, cs)); }];
  // (flags: CONDITION_VARIABLE_LOCKMODE_SHARED 1)
  K.SleepConditionVariableSRW = [4, (c) => {
    const l = c.arg(1), shared = (c.arg(3) & 1) !== 0;
    return cvSleep(c, c.arg(0), c.arg(2), () => (shared ? releaseShared(c, l) : releaseExclusive(c, l)), () => (shared ? acquireShared(c, l) : acquireExclusive(c, l)));
  }];
  K.WakeConditionVariable = [1, (c) => { const list = condVars.get(c.arg(0)); if (list) { list.shift(); if (!list.length) condVars.delete(c.arg(0)); } }];
  K.WakeAllConditionVariable = [1, (c) => { condVars.delete(c.arg(0)); }];

  // ---------------------------------------------------------------- one-time initialization
  // INIT_ONCE (pointer-sized), Windows' layout: low 2 bits 0 not started, 1 in progress, 2 done (the context, its low 2
  // bits clear, in the others). Flags: INIT_ONCE_CHECK_ONLY 1, INIT_ONCE_ASYNC 2, INIT_ONCE_INIT_FAILED 4.
  const ONCE_BUSY = 1, ONCE_DONE = 2;
  const onceState = (p) => mem.read32(p) & 3;
  /** wait while another thread initializes (and consume a re-executed call's recorded wake-up) */
  const onceWait = (c, p) => { if (c.thread.wakeResult !== undefined || onceState(p) === ONCE_BUSY) vm.sched.block(c.thread, () => onceState(p) !== ONCE_BUSY, INFINITE, `initonce 0x${p.toString(16)}`); };
  K.InitOnceInitialize = [1, (c) => { mem.write32(c.arg(0), 0); }];
  K.InitOnceExecuteOnce = [4, (c) => {
    const p = c.arg(0), fn = c.arg(1), param = c.arg(2), ctxOut = c.arg(3);
    onceWait(c, p);
    if (onceState(p) === ONCE_DONE) { if (ctxOut) mem.write32(ctxOut, mem.read32(p) & ~3); return 1; }
    mem.write32(p, ONCE_BUSY);
    // the callback BOOL CALLBACK fn(PINIT_ONCE, PVOID param, PVOID *context) runs as a guest-level callback (no JS
    // frame: it may wait); its context goes to the caller's variable, else to a word of the thread's own
    const out = ctxOut || (c.thread.onceScratch ??= c.proc.processHeap.alloc(4, true));
    mem.write32(out, 0);
    return vm.tailCallGuest(c, fn, [p, param, out], { argBytes: 16, after: (ok) => {
      if (ok) { mem.write32(p, (mem.read32(out) & ~3) | ONCE_DONE); vm.sched.signal(); return 1; }
      mem.write32(p, 0); vm.sched.signal(); return 0;
    } });
  }];
  K.InitOnceBeginInitialize = [4, (c) => {
    const p = c.arg(0), flags = c.arg(1);
    if (flags & ~3) return c.fail(E.INVALID_PARAMETER);
    if (!(flags & 1)) onceWait(c, p);
    const st = onceState(p);
    if (st === ONCE_DONE) { c.out32(2, 0); if (c.arg(3)) mem.write32(c.arg(3), mem.read32(p) & ~3); return 1; }
    if (flags & 1) return c.fail(E.GEN_FAILURE);
    mem.write32(p, ONCE_BUSY); c.out32(2, 1);
    return 1;
  }];
  K.InitOnceComplete = [3, (c) => {
    const p = c.arg(0), flags = c.arg(1), ctx = c.arg(2);
    if (onceState(p) !== ONCE_BUSY || (ctx & 3) || ((flags & 4) && ctx)) return c.fail(E.INVALID_PARAMETER);
    mem.write32(p, flags & 4 ? 0 : (ctx & ~3) | ONCE_DONE); vm.sched.signal();
    return 1;
  }];

  // ---------------------------------------------------------------- interlocked singly linked lists
  // SLIST_HEADER (8 bytes, x86): Next, Depth (16 bits), Sequence (16 bits); an entry's first word is its Next
  const depthOf = (h) => mem.read16(h + 4);
  const setHead = (h, next, depth) => { mem.write32(h, next); mem.write16(h + 4, depth & 0xffff); mem.write16(h + 6, (mem.read16(h + 6) + 1) & 0xffff); };
  K.InitializeSListHead = [1, (c) => { mem.fill(c.arg(0), 8, 0); }];
  K.InterlockedPushEntrySList = [2, (c) => { const h = c.arg(0), e = c.arg(1), old = mem.read32(h); mem.write32(e, old); setHead(h, e, depthOf(h) + 1); return old; }];
  K.InterlockedPopEntrySList = [1, (c) => { const h = c.arg(0), e = mem.read32(h); if (e) setHead(h, mem.read32(e), depthOf(h) - 1); return e; }];
  K.InterlockedFlushSList = [1, (c) => { const h = c.arg(0), e = mem.read32(h); if (e) { mem.write32(h, 0); mem.write16(h + 4, 0); } return e; }];
  K.QueryDepthSList = [1, (c) => depthOf(c.arg(0))];
}

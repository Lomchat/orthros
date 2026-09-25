// The virtual machine: guest memory, process, executor (interpreter; JIT later), API dispatch
// loop, guest callbacks, crash reports. See DECISIONS.md D003/D004.
import { GuestMemory } from '../cpu/memory.js';
import { EXIT, F, ST, CPU_MHZ } from '../cpu/state.js';
import { Interp, defaultCpuid } from '../cpu/interp.js';
import '../cpu/interp-x87.js';
import '../cpu/interp-sse.js';
import { decode, fmtInsn } from '../cpu/decoder.js';
import { ApiRegistry, CC_STDCALL } from '../win32/api.js';
import { Ctx } from '../win32/ctx.js';
import { Process, TS } from '../win32/process.js';
import { Scheduler, WaitUnwind } from './sched.js';
import { RealClock } from './clock.js';
import { registerBuiltins } from '../win32/builtins.js';
import { Jit } from '../cpu/jit/jit.js';
import { DEFER_QUEUE, DEFER_SPEC } from '../cpu/jit/runtime.js';
import { Seh, EXC } from '../win32/seh.js';
import { Com } from '../win32/com.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class ProcessExit extends Error {
  constructor(code) { super(`process exit ${code}`); this.code = code; }
}
export class ThreadExit extends Error {
  constructor(thread, code) { super(`thread ${thread.id} exit ${code}`); this.thread = thread; this.code = code; }
}
export class GuestCrash extends Error {
  constructor(report) { super('guest crash\n' + report); this.report = report; }
}

const SLICE_INSNS = Number(globalThis.ORTHROS_SLICE_INSNS ?? globalThis.process?.env?.ORTHROS_SLICE_INSNS) || 100000; // (instructions per thread slice; debugging: other interleavings)

/** Returned by an API handler that transferred control to a guest procedure (see Vm.tailCallGuest). */
export const TAIL_CALL = Symbol('tail-call');
const APIBG_QUIET = new Set(['Sleep', 'WaitForSingleObject', 'WaitForMultipleObjects', 'ReleaseMutex', 'EnterCriticalSection', 'LeaveCriticalSection', 'QueryPerformanceCounter', 'GetTickCount', 'timeGetTime', 'SetEvent', 'ResetEvent', 'InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange', 'GetCurrentThreadId', 'TlsGetValue', 'IDirectSoundBuffer::GetCurrentPosition', 'IDirectSoundBuffer::Lock', 'IDirectSoundBuffer::Unlock', 'IDirectSoundBuffer::GetStatus']);
const API_TRACE_LEN = 1024; // ring of recent API calls (crash reports, diagnostics); power of two

/** runThread options of a top-level slice, and runFor's frequent results (shared: no object per slice) */
const TOP_SLICE = Object.freeze({ slice: true, top: true });
const RUN_RUNNING = Object.freeze({ state: 'running' }), RUN_IDLE = Object.freeze({ state: 'idle' });

export class Vm {
  /**
   * @param {{ vfs: import('../vfs/vfs.js').Vfs, clock?: any, host?: any, log?: (kind: string, msg: string) => void, logKinds?: string[] }} opts
   */
  constructor(opts) {
    this.vfs = opts.vfs;
    this.clock = opts.clock ?? new RealClock();
    this.host = opts.host ?? null;
    this.mem = new GuestMemory();
    this.api = new ApiRegistry();
    this.interp = new Interp(this.mem, null);
    if (this.clock.scale && this.clock.scale !== 1) { const clock = this.clock; this.interp.hooks.rdtsc = () => BigInt(Math.floor(clock.now() * CPU_MHZ * 1000)); } // (the time stamp counter follows a scaled clock)
    const interpRanges = globalThis.ORTHROS_INTERP_RANGES ? String(globalThis.ORTHROS_INTERP_RANGES).split(',').map((r) => r.split(':').map((x) => parseInt(x, 16))) : null; // (debugging: see Jit, --interp-range)
    this.jit = opts.jit === false ? null : new Jit(this.mem, this.interp, { ...(globalThis.ORTHROS_JIT_OPTS ?? {}), interpRanges, smc: true, deferCom: !globalThis.ORTHROS_NO_DEFER, profile: !!globalThis.ORTHROS_JIT_PROFILE, countChains: !!globalThis.ORTHROS_JIT_PROFILE, fallbackHist: opts.apiHist, log: opts.logKinds?.includes('jit') ? (m) => this.log('jit', m) : null, warn: (m) => this.warn(m) });
    this.exec = this.jit ?? this.interp; // executor: { run(opts), lastFault } bound to a cpu via .cpu
    this.ctx = new Ctx(this);
    this.sched = new Scheduler(this);
    this.proc = null;
    this.depth = 0;
    this.current = null;
    this.logKinds = new Set(opts.logKinds ?? ['loader', 'warn', 'crash']);
    this.traceApi = this.logKinds.has('api') || this.logKinds.has('all');
    this.traceApiBg = opts.logKinds?.includes('apibg') ?? false;
    // 'apisite': the first calls of every (thread, call site) pair with arguments and result — a bounded trace of
    // how each thread uses the API (handles, timeouts, results) without the volume of a full trace.
    this.traceApiSite = opts.logKinds?.includes('apisite') ? new Map() : null;
    this.traceApiSiteMax = 6;
    this.logFn = opts.log ?? ((kind, msg) => console.log(`[${kind}] ${msg}`));
    this.apiTrace = new Array(API_TRACE_LEN).fill(null);
    this.apiTracePos = 0;
    this.apiCalls = 0;
    this.stdout = [];
    this.onStdout = null;
    this.deadline = 0; // host time limit (ms, performance.now based) checked at timeslice/thunk boundaries
    this.apiHistCounts = opts.apiHist ? new Uint32Array(4096) : null; // calls per thunk index (no per-call string work); see apiHist()
    this.profile = opts.profile ? new Map() : null; // eip>>6 -> timeslice samples
    this.progressAt = 0; this.progressEvery = 0; this.onProgress = null;
    this.slices = 0;
    // Internal thunks (pseudo-DLL "orthros")
    this.api.define('orthros.dll', {
      __return: [0, () => 0, { noreturn: true }],
      __callback_return: [0, (ctx) => this.onCallbackReturn(ctx), { noreturn: true }],
      __exit_thread: [0, (ctx) => this.exitThread(ctx.thread, ctx.cpu.eax), { noreturn: true }],
      __exit_process: [0, (ctx) => this.exitProcess(ctx.cpu.eax), { noreturn: true }],
      __seh_return: [0, (ctx) => this.seh.onHandlerReturn(ctx), { noreturn: true }],
      __mm_timer: [0, (ctx) => this.mmTimerTick(ctx), { noreturn: true }],
    });
    this.returnThunk = this.api.thunkFor('orthros.dll', '__return');
    this.callbackReturnThunk = this.api.thunkFor('orthros.dll', '__callback_return');
    this.exitThreadThunk = this.api.thunkFor('orthros.dll', '__exit_thread');
    this.exitProcessThunk = this.api.thunkFor('orthros.dll', '__exit_process');
    this.seh = new Seh(this);
    this.GuestCrash = GuestCrash;
    this.com = new Com(this);
    this.traceCom = !!opts.logKinds?.includes('com') || !!opts.logKinds?.includes('comx');
    this.interp.hooks.canExecute = (a) => !this.proc || this.proc.vmem.isCommitted(a, 1); // (code runs from committed memory only)
    this.traceComQuiet = !opts.logKinds?.includes('com'); // 'comx': without the per-draw calls (see com.js COM_QUIET)
    if (this.logKinds.has('cpuid')) { // which CPUID leaves software reads (each leaf and call site once)
      const seen = new Set();
      this.interp.hooks.cpuid = (I, leaf, sub) => {
        const r = defaultCpuid(leaf, sub), k = `${leaf}/${sub}/${I.cpu.eip}`;
        if (!seen.has(k)) { seen.add(k); this.logFn('cpuid', `leaf 0x${(leaf >>> 0).toString(16)} sub ${sub} at ${this.proc?.symbolize(I.cpu.eip) ?? I.cpu.eip.toString(16)} -> ${r.map((x) => '0x' + (x >>> 0).toString(16)).join(' ')}`); }
        return r;
      };
    }
    if (this.jit) { this.api.onThunk = (idx, key, def) => this.jit.markFast(idx, key, def); for (let i = 0; i < this.api.thunks.length; i++) this.jit.markFast(i, `${this.api.thunks[i].dll}!${this.api.thunks[i].name}`, this.api.thunks[i].def); }
    registerBuiltins(this.api, this);
    this.apiTraceNames = new Array(API_TRACE_LEN).fill(null);
    this.apiTraceRets = new Uint32Array(API_TRACE_LEN);
    this.apiTraceTids = new Uint32Array(API_TRACE_LEN);
  }

  log(kind, msg) { if (this.logKinds.has(kind) || this.logKinds.has('all')) this.logFn(kind, msg); }
  warn(msg) { this.log('warn', msg); }

  // ------------------------------------------------------------------ process lifecycle
  /**
   * @param {{ exePath: string, args?: string, cwd?: string, env?: any, dllOverrides?: any, exeBytes?: Uint8Array }} opts
   */
  createProcess(opts) {
    const proc = (this.proc = new Process(this, opts));
    const bytes = opts.exeBytes ?? this.vfs.readFile(proc.exePath);
    if (!bytes) throw new Error(`exe not found: ${proc.exePath}`);
    if (this.jit) this.jit.setProcessConsts(proc.processHeap.handle);
    const exe = proc.loadModule(proc.exePath.slice(proc.exePath.lastIndexOf('\\') + 1), { forExe: true, path: proc.exePath, bytes });
    proc.exe = exe;
    this.mem.write32(0x7ffdf000 + 8, exe.base); // PEB.ImageBaseAddress
    const stackSize = Math.max(exe.image.stackReserve || 0x100000, 0x100000);
    const main = proc.createThread({ start: exe.entry, param: 0, stackSize, main: true, stackBase: 0x00130000 - stackSize });
    main.name = 'main';
    return proc;
  }

  /** Run the process to completion (blocking). Returns the exit code. */
  run() {
    for (;;) { const r = this.runFor(Infinity); if (r.state === 'exited') return r.code; }
  }

  /**
   * Incremental run: execute thread slices until `untilMs` (performance.now() based) or until the
   * process exits or has nothing to do for a while. Between calls the JS stack is clean (all guest
   * state is in memory), so a browser worker can return to its event loop to present frames.
   * @returns {{ state: 'running' } | { state: 'sleep', until: number } | { state: 'idle' } | { state: 'exited', code: number }}
   */
  runFor(untilMs) {
    const proc = this.proc;
    const main = proc.threads[0];
    try {
      if (!this.started) {
        this.started = true;
        // DllMain(PROCESS_ATTACH) + TLS callbacks for native DLLs, dependencies first (load order)
        for (const mod of proc.moduleList) if (mod !== proc.exe && !mod.attached) this.attachModule(main, mod);
        for (const cb of proc.exe.tls?.callbacks ?? []) this.callGuest(main, cb, [proc.exe.base, 1, 0]);
      }
      // top-level scheduler loop: every thread runs in slices at depth 1 (see sched.js)
      for (;;) {
        const t = this.sched.pickRunnable(null);
        if (t) {
          const t0 = performance.now();
          this.runThread(t, TOP_SLICE);
          t.runMs = (t.runMs ?? 0) + performance.now() - t0; // (diagnostics: time per thread, nested slices included)
          this.sched.wakeBlocked();
          if (untilMs !== Infinity && performance.now() >= untilMs) return RUN_RUNNING;
          continue;
        }
        if (proc.threads.every((x) => x.state === TS.DONE)) break;
        if (untilMs !== Infinity && this.host?.cooperative) {
          // cooperative host (browser worker): hand the wait back to the event loop when it is long
          if (this.host.pump) this.host.pump();
          if (this.sched.wakeBlocked()) continue;
          const wake = this.sched.nextWake();
          if (wake === Infinity) return RUN_IDLE;
          const delay = wake - this.clock.now();
          if (delay > 2) return { state: 'sleep', until: performance.now() + (this.clock.real ? this.clock.real(delay) : delay) };
        }
        this.sched.idle();
      }
      // every thread returned/exited without ExitProcess: the process ends with the main thread's code
      return { state: 'exited', code: this.finish(main.exitCode === 0x103 ? main.cpu.eax : (main.exitCode ?? 0)) };
    } catch (e) {
      if (e instanceof ProcessExit) return { state: 'exited', code: this.finish(e.code) };
      throw e;
    }
  }

  finish(code) {
    this.proc.exited = true;
    this.proc.exitCode = code >>> 0;
    this.host?.onExit?.(code >>> 0);
    return code >>> 0;
  }

  attachModule(thread, mod) {
    mod.attached = true;
    for (const cb of mod.tls?.callbacks ?? []) this.callGuest(thread, cb, [mod.base, 1, 0]);
    if (mod.entry) {
      this.log('loader', `DllMain(${mod.name}, PROCESS_ATTACH)`);
      const r = this.callGuest(thread, mod.entry, [mod.base, 1, 0]);
      if (!r) this.warn(`${mod.name}: DllMain returned FALSE`);
    }
  }

  /**
   * 'apiburst' log: every API call of `thread` (arguments, result, call site) for the next `n` calls — a detailed trace
   * of what follows an interesting event (e.g. an engine creating a stand-in texture) without tracing the whole run.
   */
  startApiBurst(thread, n = 3000) { if (this.logKinds.has('apiburst') && (this.apiBursts = (this.apiBursts ?? 0) + 1) <= 8) { this.apiBurst = { tid: thread.id, left: n }; this.logFn('apiburst', `---- burst ${this.apiBursts} on t${thread.id}`); } }

  /** Time spent in API handlers (apiTimes: Map name -> ms, reset by the host per frame; diagnostics only). */
  noteApiTime(t, t0) { const ms = performance.now() - t0; this.apiTimeTotal = (this.apiTimeTotal ?? 0) + ms; if (ms > 0.05) this.apiTimes.set(t.name, (this.apiTimes.get(t.name) ?? 0) + ms); }

  /** Call counts per API as a Map "dll!name" -> count (null when the histogram is disabled). */
  apiHist() {
    if (!this.apiHistCounts) return null;
    const m = new Map();
    for (let i = 0; i < this.apiHistCounts.length; i++) { const n = this.apiHistCounts[i]; if (!n) continue; const t = this.api.thunk(i); if (t) m.set(`${t.dll}!${t.name}`, n); }
    return m;
  }

  /** The last `n` API calls (oldest first) as "dll!name from site" strings, optionally of one thread — diagnostics. */
  recentApiCalls(n = 16, tid = 0) {
    const out = [];
    for (let i = 0; i < API_TRACE_LEN && out.length < n; i++) {
      const k = (this.apiTracePos - 1 - i) & (API_TRACE_LEN - 1);
      const t = this.apiTraceNames[k];
      if (!t || (tid && this.apiTraceTids[k] !== tid)) continue;
      out.push(`${t.dll}!${t.name}${t.def ? '' : ' [stub]'} from ${this.proc.symbolize(this.apiTraceRets[k])}${tid ? '' : ` [t${this.apiTraceTids[k]}]`}`);
    }
    return out.reverse();
  }

  /** Multimedia timer thread body: run due timeSetEvent callbacks, then sleep until the next one. */
  mmTimerTick(ctx) {
    const thread = ctx.thread, proc = this.proc;
    const now = this.clock.now();
    for (const t of proc.timers.slice()) {
      if (t.kind !== 'mm' || t.due > now) continue;
      if (t.periodic) { t.due += t.elapse; if (t.due < now) t.due = now + t.elapse; }
      else { const i = proc.timers.indexOf(t); if (i >= 0) proc.timers.splice(i, 1); }
      if (t.mode & 0x10) { const o = proc.handles.getAs(t.proc, 'event'); if (o) o.signaled = true; }
      else if (t.mode & 0x20) { const o = proc.handles.getAs(t.proc, 'event'); if (o) { o.signaled = true; this.sched.wakeBlocked(); o.signaled = false; } }
      else if (t.proc) this.callGuest(thread, t.proc, [t.id, 0, t.user, 0, 0]);
    }
    let next = Infinity;
    for (const t of proc.timers) if (t.kind === 'mm' && t.due < next) next = t.due;
    const wait = next === Infinity ? 0xffffffff : Math.max(1, Math.ceil(next - this.clock.now()));
    this.sched.block(thread, () => { const n = this.clock.now(); return proc.timers.some((x) => x.kind === 'mm' && x.due <= n); }, wait, 'mmtimer');
  }

  exitProcess(code) {
    // a failure exit (abort, assertion, a filter ending an unhandled exception...): what led to it, for the host
    if (code !== 0 && !this.exitReport) {
      // (the exceptions and files first: the report sent to a server is cut at a size limit)
      try { this.exitReport = `process exit with code ${code >>> 0}\n` + this.seh.recentReport() + (this.recentFiles?.length ? `\nfiles opened last (oldest first):\n  ${this.recentFiles.join('\n  ')}` : '') + '\n' + this.crashReport(this.current ?? this.proc.threads[0], `process exit with code ${code >>> 0}`); }
      catch (e) { this.exitReport = `exit report failed: ${e.message}`; }
    }
    throw new ProcessExit(code >>> 0);
  }

  exitThread(thread, code) {
    thread.exitCode = code >>> 0;
    this.proc.removeThread(thread);
    // Unwind the JS frames belonging to this thread.
    throw new ThreadExit(thread, code >>> 0);
  }

  // ------------------------------------------------------------------ execution
  /**
   * Run a thread until: it exits, EIP reaches `until`, or (slice mode) it blocks/times out.
   * @param {import('../win32/process.js').Thread} thread
   * @param {{ until?: number, slice?: boolean }} opts
   * @returns {number} EAX at `until` (callback return value)
   */
  /** A thread's slice is over: time accounting, profiling, progress; true when the scheduler takes it back (slice mode). */
  sliceEnd(thread, opts) {
    this.clock.tick?.(0.5);
    this.slices++;
    if (this.profile) { const k = thread.cpu.eip >>> 6; this.profile.set(k, (this.profile.get(k) ?? 0) + 1); }
    if (this.deadline && performance.now() > this.deadline) throw new Error('time limit');
    if (this.progressAt && performance.now() > this.progressAt) { this.progressAt += this.progressEvery; this.onProgress?.(thread); }
    if (opts.slice) { thread.state = TS.READY; return true; }
    return false;
  }

  runThread(thread, opts) {
    const until = opts.until ?? -1;
    const prev = this.current;
    const base = thread.onStack === 0;
    this.current = thread;
    this.lastThread = thread;
    thread.onStack++;
    if (base) thread.baseDepth = this.depth;
    this.depth++;
    if (opts.top) thread.topLevel = true;
    thread.state = TS.RUNNING;
    const exec = this.exec;
    const cpu = thread.cpu;
    // the instruction budget of a slice persists across API calls (API-dense code must yield too)
    let budget = SLICE_INSNS;
    // (one options object per call, not per exec.run — that runs after every API call; the executors read it on entry)
    const runOpts = { stopAt: until, maxInsns: 0 };
    try {
      for (;;) {
        exec.cpu = cpu;
        runOpts.maxInsns = budget;
        const exit = exec.run(runOpts);
        budget = exec.remaining();
        switch (exit) {
          case EXIT.HALT:
            if (until >= 0 && cpu.eip === until) return cpu.eax;
            throw new GuestCrash(this.crashReport(thread, 'HLT executed'));
          case EXIT.THUNK:
            this.dispatchThunk(thread, cpu.exitArg);
            if (opts.slice && thread.state !== TS.RUNNING) return 0; // parked (unwound wait) or exited
            if (thread.yieldRequested) { thread.yieldRequested = false; if (opts.slice) { thread.state = TS.READY; return 0; } }
            if (budget <= 0) { budget = SLICE_INSNS; if (this.sliceEnd(thread, opts)) return 0; }
            break;
          case EXIT.TIMESLICE:
            budget = SLICE_INSNS; if (this.sliceEnd(thread, opts)) return 0;
            break;
          case EXIT.FAULT:
            this.onFault(thread);
            break;
          case EXIT.BREAK:
            this.onBreak(thread);
            break;
          case EXIT.SMC: {
            const lenAt = cpu.base + ST.EXIT_LEN, len = this.mem.read32(lenAt) || 16; // a string store's range, else 16 bytes
            this.mem.write32(lenAt, 0);
            if (this.jit?.watchHit(cpu.exitArg, cpu.eip, len, thread)) break; // write watch (debugging), not code
            this.invalidateCode(cpu.exitArg, len);
            break;
          }
          default:
            throw new GuestCrash(this.crashReport(thread, `unexpected exit ${exit}`));
        }
      }
    } catch (e) {
      if (e instanceof ThreadExit && e.thread === thread && base) return e.code;
      throw e;
    } finally {
      this.depth--;
      thread.onStack--;
      if (opts.top) thread.topLevel = false;
      this.current = prev;
      if (thread.state === TS.RUNNING && thread.onStack === 0 && !(thread.state === TS.DONE)) thread.state = thread.state === TS.DONE ? TS.DONE : TS.READY;
    }
  }

  /**
   * Call guest code on a thread and return EAX (nested dispatch). Arguments are pushed right
   * to left; the stack is restored afterwards whatever the callee's convention.
   * @param {import('../win32/process.js').Thread} thread
   * @param {number} addr
   * @param {number[]} args
   */
  callGuest(thread, addr, args = [], opts = {}) {
    const cpu = thread.cpu;
    const saved = [cpu.eip, cpu.esp, cpu.ebx, cpu.esi, cpu.edi, cpu.ebp, cpu.eflags];
    if (opts.ecx !== undefined) cpu.ecx = opts.ecx; // __thiscall
    if (opts.ebp !== undefined) cpu.ebp = opts.ebp; // SEH filter/finally fragments
    for (let i = args.length - 1; i >= 0; i--) cpu.push32(args[i] >>> 0);
    cpu.push32(this.returnThunk);
    cpu.eip = addr >>> 0;
    thread.callbackDepth++;
    let r;
    try {
      r = this.runThread(thread, { until: this.returnThunk });
    } finally {
      thread.callbackDepth--;
      [cpu.eip, cpu.esp, cpu.ebx, cpu.esi, cpu.edi, cpu.ebp, cpu.eflags] = saved;
    }
    return r;
  }

  /**
   * Guest-level callback (D028): from an API handler, transfer control to a guest procedure without a
   * JS frame in between — the API call's own return is completed later by the `__callback_return`
   * thunk (EIP/ESP restored from the recorded continuation, EAX = the procedure's result, then
   * `after(eax)` runs). Because the JS stack stays flat, a blocking wait inside the callback can be
   * unwound and parked like any top-level wait. The handler must return the value of this call.
   * @param {import('../win32/ctx.js').Ctx} c the API call context (ESP at the return address)
   * @param {number} proc guest procedure (stdcall)
   * @param {number[]} args
   * @param {{ argBytes: number, after?: (eax: number) => void }} o bytes of API arguments to pop on return
   */
  tailCallGuest(c, proc, args, o) {
    const thread = c.thread, cpu = thread.cpu;
    const sp = cpu.esp;
    (thread.continuations ??= []).push({ sp, argBytes: o.argBytes, after: o.after ?? null });
    for (let i = args.length - 1; i >= 0; i--) cpu.push32(args[i] >>> 0);
    cpu.push32(this.callbackReturnThunk);
    cpu.eip = proc >>> 0;
    return TAIL_CALL;
  }
  onCallbackReturn(ctx) {
    const thread = ctx.thread, cpu = thread.cpu;
    const ks = thread.continuations ?? [];
    while (ks.length && ks[ks.length - 1].sp < cpu.esp) ks.pop(); // frames abandoned by a non-local exit
    const k = ks.pop();
    if (!k || k.sp !== cpu.esp) throw new GuestCrash(this.crashReport(thread, `callback return without a matching continuation (esp ${cpu.esp.toString(16)})`));
    cpu.eip = this.mem.read32(k.sp);
    cpu.esp = (k.sp + 4 + k.argBytes) >>> 0;
    if (k.after) { const r = k.after(cpu.eax); if (r !== undefined) cpu.eax = r >>> 0; }
  }

  /** Can a blocking API call on this thread be unwound (parked) instead of nesting? Only at top level, outside callbacks. */
  canUnwind(thread) { return thread.topLevel && this.depth === 1 && thread.callbackDepth === 0 && this.current === thread; }

  // ------------------------------------------------------------------ API dispatch
  /**
   * Run the COM calls the JIT's fast path queued (runtime.js DEFER_SPECS: Direct3D state setters), in
   * order, before an API call handled in JavaScript observes the device state.
   */
  drainDeferred(thread) {
    const m = this.mem;
    const n = m.read32(DEFER_QUEUE);
    if (!n) return;
    m.write32(DEFER_QUEUE, 0);
    const ctx = this.ctx;
    for (let p = DEFER_QUEUE + 16, end = p + n; p < end;) {
      const idx = m.read32(p), argc = m.read32(p + 4), words = m.read32(DEFER_SPEC + 4 * idx) >>> 8;
      const def = this.api.thunk(idx).def;
      ctx.bind(thread, def); ctx.sp = p + 4; // arg(i) reads the recorded arguments
      this.apiCalls++;
      if (this.apiHistCounts && idx < this.apiHistCounts.length) this.apiHistCounts[idx]++;
      def.fn(ctx);
      p += 4 * (2 + argc + words);
    }
    this.deferredCalls = (this.deferredCalls ?? 0) + 1;
  }

  dispatchThunk(thread, idx) {
    if (this.mem.u32[DEFER_QUEUE >>> 2]) this.drainDeferred(thread);
    const t = this.api.thunk(idx);
    const cpu = thread.cpu;
    if (!t) throw new GuestCrash(this.crashReport(thread, `jump into unknown thunk ${idx}`));
    const def = t.def;
    const ctx = this.ctx.bind(thread, def);
    const sp = cpu.esp;
    this.apiCalls++;
    if ((sp & 3) && !this.warnedMisaligned) { this.warnedMisaligned = true; this.warn(`misaligned ESP ${sp.toString(16)} at API call ${t.dll}!${t.name}\n` + this.crashReport(thread, 'misaligned stack')); }
    if (this.apiHistCounts) { if (idx >= this.apiHistCounts.length) { const n = new Uint32Array(Math.max(idx + 1, this.apiHistCounts.length * 2)); n.set(this.apiHistCounts); this.apiHistCounts = n; } this.apiHistCounts[idx]++; }
    if (def) {
      if (this.traceApi) this.logFn('api', this.fmtCall(t, ctx, def.argc));
      else if (this.traceApiBg && thread !== this.proc.threads[0] && !APIBG_QUIET.has(t.name)) this.logFn('apibg', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)}`); // background threads only (loaders, audio), without the timing/sync chatter
      const tp = this.apiTracePos++ & (API_TRACE_LEN - 1);
      this.apiTraceNames[tp] = t; this.apiTraceRets[tp] = this.mem.read32(sp); this.apiTraceTids[tp] = thread.id;
      let r;
      const tApi = this.apiTimes ? performance.now() : 0; // (diagnostics: time per API within a frame, see apiTimes)
      try { r = def.fn(ctx); }
      catch (e) {
        if (this.apiTimes) this.noteApiTime(t, tApi);
        if (!(e instanceof WaitUnwind)) throw e;
        // park the thread: roll the call back to the thunk so it re-executes once woken
        cpu.esp = sp; cpu.eip = t.addr;
        thread.state = TS.BLOCKED; thread.wait = e.wait; thread.blockReason = e.wait.reason; thread.wakeAt = e.wait.deadline;
        if (this.waitLogMin) { thread.blockedAt = this.clock.now(); thread.blockedApi = t.name; thread.blockedFrom = this.mem.read32(sp); } // (diagnostics: long waits, see Scheduler.wake)
        return;
      }
      if (this.apiTimes) this.noteApiTime(t, tApi);
      if (thread.resuming) { thread.resuming = false; thread.wakeResult = undefined; } // re-executed call completed without blocking again
      if (this.apiBurst && this.apiBurst.tid === thread.id && this.apiBurst.left-- > 0 && !APIBG_QUIET.has(t.name)) this.logFn('apiburst', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)} -> ${r === undefined ? '-' : r === TAIL_CALL ? 'tail' : '0x' + (r >>> 0).toString(16)} from ${this.proc.symbolize(this.mem.read32(sp))}`);
      if (this.traceApiSite) {
        const key = this.mem.read32(sp) + thread.id * 0x100000000;
        const n = this.traceApiSite.get(key) ?? 0;
        if (n < this.traceApiSiteMax) { this.traceApiSite.set(key, n + 1); this.logFn('apisite', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)} -> ${r === undefined ? '-' : r === TAIL_CALL ? 'tail' : '0x' + (r >>> 0).toString(16)}${n === this.traceApiSiteMax - 1 ? ' (site quiet from now on)' : ''}`); }
      }
      if (r === TAIL_CALL || def.noreturn) return;
      cpu.eip = this.mem.read32(sp);
      cpu.esp = (sp + 4 + (def.cc === CC_STDCALL ? def.argc * 4 : 0)) >>> 0;
      if (r !== undefined) cpu.eax = r >>> 0;
      return;
    }
    // Unknown import: tracing stub. Stack cleanup needs the signature database.
    const key = `${t.dll}!${t.name}`;
    const info = this.proc.unknownImports.get(key) ?? { from: '?', calls: 0 };
    info.calls++;
    this.proc.unknownImports.set(key, info);
    const argc = this.api.signatures.get(t.name);
    if (info.calls <= 3) this.warn(`unimplemented ${key} called from ${this.proc.symbolize(this.mem.read32(sp))}` + (argc === undefined ? ' (unknown signature: assuming 0 args, stdcall)' : ` (${argc} args)`));
    { const tp = this.apiTracePos++ & (API_TRACE_LEN - 1); this.apiTraceNames[tp] = t; this.apiTraceRets[tp] = this.mem.read32(sp); this.apiTraceTids[tp] = thread.id; }
    cpu.eip = this.mem.read32(sp);
    cpu.esp = (sp + 4 + (argc ?? 0) * 4) >>> 0;
    cpu.eax = (this.api.stubReturns.get(t.dll) ?? 0) >>> 0;
  }

  argsOf(ctx, n) { const a = []; for (let i = 0; i < n; i++) a.push(ctx.arg(i)); return a; }

  fmtCall(t, ctx, argc) {
    const a = this.argsOf(ctx, Math.min(argc, 8)).map((v) => '0x' + v.toString(16));
    return `${t.dll}!${t.name}(${a.join(', ')}) from ${this.proc.symbolize(this.mem.read32(ctx.sp))} tid=${ctx.thread.id}`;
  }

  // ------------------------------------------------------------------ faults & diagnostics
  /** Code at [addr, addr+len) changed: drop cached decodes / translations. */
  invalidateCode(addr, len) {
    this.interp.invalidate(addr, len);
    if (this.jit) this.jit.invalidate(addr, len);
  }

  onFault(thread) {
    const fault = this.exec.lastFault;
    const cpu = thread.cpu;
    const vec = cpu.exitArg;
    const precise = !(fault instanceof WebAssembly.RuntimeError) && !(fault instanceof RangeError);
    if (precise && this.mem.read32(thread.teb) !== 0xffffffff) {
      const map = { 0: [EXC.INT_DIVIDE_BY_ZERO, []], 6: [EXC.ILLEGAL_INSTRUCTION, []], 13: [EXC.ACCESS_VIOLATION, [0, 0xffffffff]], 14: [EXC.ACCESS_VIOLATION, [0, fault?.faultAddr ?? 0]], 3: [EXC.BREAKPOINT, []], 4: [EXC.INT_OVERFLOW, []], 5: [EXC.ARRAY_BOUNDS, []] };
      const [code, params] = map[vec] ?? [EXC.ILLEGAL_INSTRUCTION, []];
      if (vec === 14 && /^(cpu fault #14 )?execution at/.test(fault?.message ?? '') && (this.execFaults = (this.execFaults ?? 0) + 1) <= 8) this.warn(`${fault.message} (thread ${thread.id}, return address on the stack: ${this.proc.symbolize(this.mem.read32(cpu.esp))}): access violation raised`);
      cpu.exit = EXIT.NONE;
      this.seh.raise(thread, code, 0, cpu.eip, params);
      return;
    }
    throw new GuestCrash(this.crashReport(thread, `fault ${fault ? fault.message : vec}${precise ? '' : ' (imprecise: WASM trap inside a JIT region)'}`));
  }

  onBreak(thread) {
    // int3: treat as a breakpoint/debug trap -> continue after it (debuggers absent)
    this.warn(`int3 at ${this.proc.symbolize(thread.cpu.eip)}`);
    thread.cpu.eip = (thread.cpu.eip + 1) >>> 0;
    thread.cpu.exit = EXIT.NONE;
  }

  /** RaiseException from guest code: dispatch through the SEH chain (continuation based, see seh.js). */
  raiseException(ctx, code, flags, nargs, argsPtr) {
    const params = [];
    for (let i = 0; i < Math.min(nargs, 15); i++) params.push(this.mem.read32(argsPtr + 4 * i));
    const cpu = ctx.cpu;
    // the exception address is the caller's return address; ESP as seen by the caller
    const addr = ctx.retAddr;
    cpu.esp = (ctx.sp + 4 + 16) >>> 0;
    this.seh.raise(ctx.thread, code, flags & 1, addr, params, { eip: addr });
    return null; // handled: RaiseException never returns normally (state set by the dispatcher)
  }
  rtlUnwind(ctx) { this.seh.rtlUnwind(ctx); }

  deadlock(thread, reason) {
    throw new GuestCrash(this.crashReport(thread, `deadlock: all threads blocked (${reason})`));
  }

  /** One line per guest thread: state, wait reason, EIP, return addresses on the stack, last API call. */
  threadsReport() {
    const proc = this.proc, mem = this.mem;
    const lines = [`threads (${proc.threads.length}):`];
    for (const t of proc.threads) {
      const cpu = t.cpu;
      const rets = [];
      for (let a = cpu.esp; a < cpu.esp + 0x800 && rets.length < 10; a += 4) {
        if (!proc.vmem.isCommitted(a, 4)) break;
        const v = mem.read32(a);
        if (proc.moduleByAddr(v) && v > 0x1000 && (mem.read8(v - 5) === 0xe8 || mem.read8(v - 2) === 0xff || mem.read8(v - 3) === 0xff || mem.read8(v - 6) === 0xff)) rets.push(proc.symbolize(v));
      }
      let last = '';
      for (let i = API_TRACE_LEN - 1; i >= 0; i--) { const k = (this.apiTracePos + i) & (API_TRACE_LEN - 1); if (this.apiTraceNames[k] && this.apiTraceTids[k] === t.id) { last = `${this.apiTraceNames[k].dll}!${this.apiTraceNames[k].name} from ${proc.symbolize(this.apiTraceRets[k])}`; break; } }
      const ss = t.sleepStats ? ` sleeps(0/≤2ms/long)=${t.sleepStats.zero}/${t.sleepStats.short}/${t.sleepStats.long} throttled=${t.sleepStats.throttled ?? 0}` : '';
      lines.push(`  ${t.id} (${t.name || '-'}) ${['ready', 'running', 'blocked', 'suspended', 'done'][t.state] ?? t.state}${t.state === 2 ? ` [${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}${t.wait ? '' : ' nested'}${t.wakeAt < Infinity ? ` until +${Math.max(0, t.wakeAt - this.clock.now()).toFixed(0)}ms` : ''}]` : ''}${t.callbackDepth ? ` cb=${t.callbackDepth}` : ''} eip=${proc.symbolize(cpu.eip)}\n      stack: ${rets.join(' < ') || '-'}\n      last API: ${last || '-'}${ss}`);
    }
    // synchronization objects (mutexes/events/semaphores) and the last ownership transitions
    const sync = [];
    for (const [h, o] of proc.handles.map) {
      if (!o) continue;
      if (o.type === 'mutex') sync.push(`0x${h.toString(16)} mutex owner=${o.owner ? 't' + o.owner : '-'} count=${o.count}${o.abandoned ? ' abandoned' : ''}${o.name ? ` "${o.name}"` : ''}`);
      else if (o.type === 'event') sync.push(`0x${h.toString(16)} event ${o.manual ? 'manual' : 'auto'} ${o.signaled ? 'signaled' : 'reset'}${o.name ? ` "${o.name}"` : ''}`);
      else if (o.type === 'semaphore') sync.push(`0x${h.toString(16)} semaphore ${o.count}/${o.max}${o.name ? ` "${o.name}"` : ''}`);
    }
    if (sync.length) lines.push(`sync objects (${sync.length}):\n  ` + sync.slice(-48).join('\n  '));
    const st = proc.syncTraceLines();
    if (st.length) lines.push('sync transitions (oldest first):\n  ' + st.join('\n  '));
    const cs = proc.syncTraceLines('cs');
    if (cs.length) lines.push('critical-section hand-offs (oldest first):\n  ' + cs.join('\n  '));
    return lines.join('\n');
  }

  crashReport(thread, reason) {
    const cpu = thread.cpu, mem = this.mem, proc = this.proc;
    const h = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
    const lines = [`*** ${reason} in thread ${thread.id} (${thread.name}) at ${proc.symbolize(cpu.eip)}`];
    lines.push(cpu.dump());
    // disassembly around EIP
    lines.push('code:');
    let a = cpu.eip;
    for (let i = 0; i < 8; i++) {
      try { const insn = decode(mem, a); lines.push(`  ${h(a)}  ${hex(mem.bytes(a, insn.len)).padEnd(20)} ${fmtInsn(insn)}`); a = insn.next; }
      catch (e) { lines.push(`  ${h(a)}  ?? ${e.message}`); break; }
    }
    lines.push('stack:');
    for (let i = 0; i < 16; i++) {
      const sa = cpu.esp + 4 * i;
      if (!proc.vmem.isCommitted(sa, 4)) break;
      const v = mem.read32(sa);
      lines.push(`  ${h(sa)}: ${h(v)}  ${proc.moduleByAddr(v) || this.api.nameOf(v) ? proc.symbolize(v) : ''}`);
    }
    lines.push('recent API calls:');
    for (const l of this.recentApiCalls(64)) lines.push('  ' + l);
    lines.push('modules:');
    for (const m of proc.moduleList) lines.push(`  ${h(m.base)}-${h(m.base + m.size)} ${m.name}`);
    if (proc.threads.length > 1) lines.push(this.threadsReport());
    return lines.join('\n');
  }
}

export { EXIT, F };

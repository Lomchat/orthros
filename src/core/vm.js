// The virtual machine: guest memory, process, executor (interpreter; JIT later), API dispatch
// loop, guest callbacks, crash reports. See DECISIONS.md D003/D004.
import { nullPageMode } from '../cpu/nullpage.js';
import { GuestMemory } from '../cpu/memory.js';
import { EXIT, F, ST, CPU_MHZ } from '../cpu/state.js';
import { Interp, defaultCpuid } from '../cpu/interp.js';
import '../cpu/interp-x87.js';
import '../cpu/interp-sse.js';
import { decode, fmtInsn } from '../cpu/decoder.js';
import { ApiRegistry, CC_STDCALL } from '../win32/api.js';
import { Ctx } from '../win32/ctx.js';
import { Process, TS } from '../win32/process.js';
import { Scheduler, WaitUnwind, PARK } from './sched.js';
import { acct, C as ACCT } from './frame-acct.js';
import { RealClock } from './clock.js';
import { timerResFromDebug } from './timer-res.js';
import { vmSnapRegistry, sealVmSnapRegistry } from './vm-snapshot.js';
import { JIT_RANGES } from './snapshot.js';
import { registerBuiltins } from '../win32/builtins.js';
import { Jit } from '../cpu/jit/jit.js';
import { DEFER_QUEUE, DEFER_SPEC, DEFER_RAW, PROC_CONSTS } from '../cpu/jit/runtime.js';
import { Seh, EXC } from '../win32/seh.js';
import { Com } from '../win32/com.js';
import { apiOpt } from './api-opt.js';

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
   * @param {{ vfs: import('../vfs/vfs.js').Vfs, clock?: any, host?: any, log?: (kind: string, msg: string) => void, logKinds?: string[], nullPage?: boolean | 'writes' }} opts
   */
  constructor(opts) {
    this.vfs = opts.vfs;
    this.clock = opts.clock ?? new RealClock();
    /** the guest's clock interrupt (timer-res.js): when timed waits end, the tick counters' steps, timeBeginPeriod */
    this.timerRes = opts.timerRes ?? timerResFromDebug();
    this.host = opts.host ?? null;
    /** instructions per thread slice (tests: other interleavings) */
    this.sliceInsns = opts.sliceInsns || Number(globalThis.ORTHROS_SLICE_INSNS) || SLICE_INSNS;
    this.mem = new GuestMemory({ shared: !!opts.sharedMemory }); // (shared: other workers read it, e.g. the background translator)
    this.api = new ApiRegistry(this.mem);
    /** what a snapshot of this machine holds (vm-snapshot.js): its modules declare their own state as they register */
    this.snap = vmSnapRegistry(this);
    this.interp = new Interp(this.mem, null);
    // what faults in the null page (nullpage.js: 'writes' by default, true reads too — ?dbg=ORTHROS_NULL_READS=1 —, false)
    const nullPage = opts.nullPage ?? nullPageMode();
    this.interp.nullPage = nullPage;
    { const clock = this.clock; this.interp.hooks.rdtsc = () => BigInt(Math.floor(clock.now() * CPU_MHZ * 1000)); } // (the time stamp counter follows the guest's clock: a scaled one, a virtual one, a snapshot's — never the host's own time)
    const interpRanges = globalThis.ORTHROS_INTERP_RANGES ? String(globalThis.ORTHROS_INTERP_RANGES).split(',').map((r) => r.split(':').map((x) => parseInt(x, 16))) : null; // (debugging: see Jit, --interp-range)
    this.jitArgs = [nullPage, interpRanges, opts]; // (newJit)
    this.jit = opts.jit === false ? null : this.newJit(nullPage, interpRanges, opts);
    this.exec = this.jit ?? this.interp; // executor: { run(opts), lastFault } bound to a cpu via .cpu
    this.ctx = new Ctx(this);
    // (debugging, ?dbg=ORTHROS_HEAP_PROV=1: the last heap operations on every block — op, thread, call site — shown in
    // crash reports for the blocks the registers point into)
    this.heapProv = null;
    if (globalThis.ORTHROS_HEAP_PROV) {
      const prov = this.heapProvMap = new Map(); let seq = 0;
      this.heapProv = (c, op, addr, size) => { if (!addr) return; const a = addr >>> 0, l = prov.get(a), e = `#${++seq} ${op}${size ? `(${size})` : ''} t${c.thread.id} from ${this.proc.symbolize(c.retAddr)}`; if (l) { l.push(e); if (l.length > 4) l.shift(); } else prov.set(a, [e]); };
    }
    this.sched = new Scheduler(this);
    this.proc = null;
    this.depth = 0;
    this.current = null;
    this.logKinds = new Set(opts.logKinds ?? ['loader', 'warn', 'crash']);
    this.traceApi = this.logKinds.has('api') || this.logKinds.has('all');
    this.traceApiBg = opts.logKinds?.includes('apibg') ?? false;
    this.traceApiRet = Number(globalThis.ORTHROS_TRACE_API ?? 0); // (debugging: every completed API call logged with its result as [api]; 1: without COM / D3DX, 2: all; --dbg / dbg: in the harness)
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
    if (this.jit) { this.api.onThunk = (idx, key, def) => this.jit.markFast(idx, key, def); this.api.thunks.forEach((t, i) => { if (t) this.jit.markFast(i, `${t.dll}!${t.name}`, t.def); }); }
    registerBuiltins(this.api, this);
    this.apiTraceNames = new Array(API_TRACE_LEN).fill(null);
    this.apiTraceRets = new Uint32Array(API_TRACE_LEN);
    this.apiTraceTids = new Uint32Array(API_TRACE_LEN);
    // Fields the hosts and the DLL modules attach later (as the game reaches them), declared here so that the Vm keeps
    // one hidden class from the start: each late addition was a new map for the property loads of the dispatcher
    // (runThread, runFor, dispatchThunk read `this.*` per slice and per API call), which went megamorphic — V8's
    // stub-cache lookup on every one of those loads.
    // (kept when registerBuiltins above has set them already)
    const late = {
      started: false, lastThread: null, runOptsByDepth: [], deferredCalls: 0,
      presentThread: null, // (the thread that presents frames: d3d8.js Present)
      waitLogMin: 0, mainWaits: null, // (diagnostics: long waits, set by the headless host)
      asyncReads: false, readsInFlight: 0, recentFiles: null, recentReads: null, // (kernel32-file.js)
      readSliceMs: 2, // (runFor: a slice ends this long after its start once a file read is in flight)
      registry: null, wm: null, winsock: null, lanDeliver: null, textEngine: null, d3dCore: null, d3dx: null,
      firstD3DCall: null, audio: null, d3dDevices: null, d3dDevice: null, effectCtx: null,
      exitReport: null, execFaults: 0, nullFaults: 0, apiTail: null,
      guestInsns: 0, // guest instructions executed (charged by the executors' budgets): see runThread
      nextPid: 0x400, // (process ids: win32/process.js)
    };
    for (const k of Object.keys(late)) this[k] ??= late[k];
    sealVmSnapRegistry(this); // (what the construction built is the same in every Vm: snapshots restore it in place)
  }

  log(kind, msg) { if (this.logKinds.has(kind) || this.logKinds.has('all')) this.logFn(kind, msg); }
  warn(msg) { this.log('warn', msg); }

  // ------------------------------------------------------------------ process lifecycle
  /**
   * @param {{ exePath: string, args?: string, cwd?: string, env?: any, dllOverrides?: any, exeBytes?: Uint8Array }} opts
   */
  /** A JIT on this machine's memory and interpreter, with the options the page or the tests ask for. */
  newJit(nullPage, interpRanges, opts) {
    return new Jit(this.mem, this.interp, { ...(globalThis.ORTHROS_JIT_OPTS ?? {}), nullPage, interpRanges, smc: true, deferCom: !globalThis.ORTHROS_NO_DEFER, profile: !!globalThis.ORTHROS_JIT_PROFILE, countChains: !!globalThis.ORTHROS_JIT_PROFILE, fallbackHist: opts.apiHist, now: () => this.clock.now(), mmTime: () => this.timerRes.mmTime(this.clock.now()), tickCount: () => this.timerRes.tickCount(this.clock.now()), log: opts.logKinds?.includes('jit') ? (m) => this.log('jit', m) : null, warn: (m) => this.warn(m) });
  }

  /**
   * An empty JIT in place of this one: its tables in guest memory cleared, every API thunk and process constant given
   * to it again — the machine then runs as one just restored from its snapshot does (tools/snapshot-check.mjs: the
   * original and its copy compared at the JIT's speed, translating alike).
   */
  resetJit() {
    for (const [s, e] of JIT_RANGES) this.mem.u8.fill(0, s, e);
    this.jit = this.newJit(...this.jitArgs); this.exec = this.jit;
    this.api.onThunk = (idx, key, def) => this.jit.markFast(idx, key, def);
    this.api.thunks.forEach((t, i) => { if (t) this.jit.markFast(i, `${t.dll}!${t.name}`, t.def); });
    if (this.proc) this.jit.setProcessConsts(this.proc.processHeap.handle);
  }

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
    this.log('loader', `main thread stack: ${(stackSize / 1024).toFixed(0)} KiB (image reserve ${((exe.image.stackReserve || 0) / 1024).toFixed(0)} KiB) at ${(main.stackLimit >>> 0).toString(16)}-${(main.stackBase >>> 0).toString(16)}`);
    main.name = 'main';
    if (globalThis.ORTHROS_WRITE_CHECK) this.writeCheck(proc.vmem);
    if (globalThis.ORTHROS_RELEASE_WATCH) this.releaseWatch(proc.vmem);
    // (debugging, ?dbg=ORTHROS_TRACE_EIP=<hex>[;<hex>...] with ORTHROS_INTERP_RANGES covering them: each arrival at those
    // addresses — a function entry — recorded with the thread, the return address and the first stack arguments; the
    // last 256 are shown in crash reports)
    if (globalThis.ORTHROS_TRACE_EIP && this.jit) {
      // (<hex>@<reg>[+<hex>]: the record keyed by that register plus the offset instead of the first stack argument — a
      // value being returned, a pointer computed in a register)
      const eips = new Map(String(globalThis.ORTHROS_TRACE_EIP).split(';').filter(Boolean).map((x) => {
        const [a, k] = x.split('@'); const [reg, off] = (k ?? '').split('+');
        return [parseInt(a, 16) >>> 0, k ? { reg, off: off ? parseInt(off, 16) : 0 } : null];
      }));
      const ring = this.traceRing = { a: new Array(256), i: 0 };
      const byArg = this.traceByArg = new Map(), depth = Number(globalThis.ORTHROS_TRACE_DEPTH) || 3; // (records kept per key)
      this.jit.onInterpRange = (eip, cpu) => {
        if (!eips.has(eip)) return;
        const key = eips.get(eip);
        const sp = cpu.esp >>> 0, m = this.mem, a0 = key ? (cpu[key.reg] + key.off) >>> 0 : m.read32(sp + 4) >>> 0;
        const rets = []; for (let a = sp; a < sp + 0x400 && rets.length < 8; a += 4) { const v = m.read32(a) >>> 0; if (this.proc.moduleByAddr(v)) rets.push(this.proc.symbolize(v)); }
        const rec = `#${ring.i + 1} @${this.clock.now().toFixed(1)}ms t${this.current?.id} ${this.proc.symbolize(eip)} arg ${a0.toString(16)} ${(m.read32(sp + 8) >>> 0).toString(16)} ecx ${(cpu.ecx >>> 0).toString(16)} stack ${rets.join(' < ')}`;
        ring.a[ring.i++ & 255] = rec;
        const l = byArg.get(a0); if (l) { l.push(rec); if (l.length > depth) l.shift(); } else { byArg.set(a0, [rec]); if (byArg.size > 200000) byArg.delete(byArg.keys().next().value); } // (bounded: the oldest arguments forgotten)
      };
    }
    if (globalThis.ORTHROS_NULL_WATCH && this.jit) { // (debugging: writes to the first 64 KB, an access violation on Windows)
      this.jit.watchWrites(0, 0x10000, 'null page', 1e9);
      const hit = this.jit.watchHit.bind(this.jit); let n = 0;
      this.jit.watchHit = (addr, eip, len, thread) => { const h = hit(addr, eip, len, thread); if (h && addr < 0x10000 && ++n <= 20) this.warn(`write to the null page: ${addr.toString(16)} (${len} bytes) by t${thread?.id} at ${this.proc.symbolize(eip)}\n${this.crashReport(thread ?? this.proc.threads[0], 'write to the null page')}`); return h; };
    }
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
      // (one clock read per slice: it ends the slice's time, starts the next one's and dates the wake-up pass — a
      // thread yielding thousands of times per second made the reads a fifth of the switch)
      let t0 = performance.now();
      const tStart = t0;
      for (;;) {
        const t = this.sched.pickRunnable(null, true);
        if (t) {
          this.runThread(t, TOP_SLICE);
          const t1 = performance.now();
          t.runMs = (t.runMs ?? 0) + t1 - t0; // (diagnostics: time per thread, nested slices included)
          this.sched.wakeBlocked(this.clock.at ? this.clock.at(t1) : undefined);
          if (untilMs !== Infinity && t1 >= untilMs) return RUN_RUNNING;
          // (a file read went to the network during this call: the host's event loop completes it, back to it soon)
          if (untilMs !== Infinity && this.readsInFlight > 0 && t1 - tStart >= this.readSliceMs) return RUN_RUNNING;
          t0 = t1;
          continue;
        }
        if (proc.threads.every((x) => x.state === TS.DONE)) break;
        if (untilMs !== Infinity && this.host?.cooperative) {
          // cooperative host (browser worker): hand the wait back to the event loop when it is long
          if (this.host.pump) this.host.pump();
          if (this.sched.wakeBlocked()) { t0 = performance.now(); continue; }
          const wake = this.sched.nextWake();
          if (wake === Infinity) return RUN_IDLE;
          const delay = wake - this.clock.now();
          if (delay > 2) return { state: 'sleep', until: performance.now() + (this.clock.real ? this.clock.real(delay) : delay) };
        }
        this.sched.idle();
        t0 = performance.now();
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
  // (noGfx: COM and D3DX calls neither logged nor counted)
  startApiBurst(thread, n = 3000, noGfx = false) { if (this.logKinds.has('apiburst') && (this.apiBursts = (this.apiBursts ?? 0) + 1) <= 8) { this.apiBurst = { tid: thread.id, left: n, noGfx }; this.logFn('apiburst', `---- burst ${this.apiBursts} on t${thread.id}`); } }

  /**
   * Time spent in API handlers (apiTimes: Map name -> ms, reset by the host per frame; apiTimesPhase: the same, reset
   * by the host at each phase mark; diagnostics only).
   */
  noteApiTime(t, t0) { const ms = performance.now() - t0; this.apiTimeTotal = (this.apiTimeTotal ?? 0) + ms; if (ms > 0.05) this.apiTimes.set(t.name, (this.apiTimes.get(t.name) ?? 0) + ms); const ph = this.apiTimesPhase; if (ph) ph.set(t.name, (ph.get(t.name) ?? 0) + ms); }

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
    if (opts.slice) { this.sched.markReady(thread); if (opts.top) this.sched.sliceExpired = thread; return true; }
    return false;
  }

  runThread(thread, opts) {
    const until = opts.until ?? -1;
    const prev = this.current;
    const base = thread.onStack === 0;
    // guest code run from inside an API handler (a callback, a nested wait running the other threads) makes API calls
    // of its own, which rebind the shared call context: the handler's binding (thread, arguments) comes back after
    const ctx = this.ctx, nested = this.depth > 0, cThread = ctx.thread, cCpu = ctx.cpu, cSp = ctx.sp, cDef = ctx.def;
    // (guest code run from inside an API call or another section — a callback, a nested wait running the other
    // threads — is charged to guest code; top-level slices already are)
    const acctPrev = this.depth > 0 ? acct.enter(ACCT.guest) : -1;
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
    let budget = this.sliceInsns;
    // (one options object per nesting depth, not per call nor per exec.run — that runs after every API call; the
    // executors read it on entry)
    const runOpts = (this.runOptsByDepth ??= [])[this.depth] ??= { stopAt: -1, maxInsns: 0 };
    runOpts.stopAt = until;
    // (debugging, ?dbg=ORTHROS_LONG_STEP_MS=N: an executor run or an API call longer than N ms logged, with where the
    // time went — a single long step freezes the frame)
    const longMs = globalThis.ORTHROS_LONG_STEP_MS || 0;
    try {
      for (;;) {
        exec.cpu = cpu;
        runOpts.maxInsns = budget;
        let tl = 0, el = 0, bl = 0;
        if (longMs) { tl = performance.now(); el = cpu.eip; bl = budget; if (this.jit) this.jit.dbgLong = { wasm: 0, calls: 0, maxWasm: 0, maxWasmEip: 0, maxWasmExit: 0, maxWasmEnd: 0, tr: 0, trN: 0, steps0: this.jit.stats.steps ?? 0, fb0: this.jit.stats.fallbackSteps ?? 0 }; }
        const exit = exec.run(runOpts);
        budget = exec.remaining();
        this.guestInsns += runOpts.maxInsns - budget; // (diagnostics: guest time per instruction, see the worker's phase marks)
        if (longMs) {
          const d = performance.now() - tl, g = this.jit?.dbgLong;
          if (d > longMs) this.logFn('hang', `long run: ${d.toFixed(0)} ms from ${this.proc.symbolize(el)} to ${this.proc.symbolize(cpu.eip)} exit ${exit}, budget ${bl} -> ${budget}${g ? `; wasm ${g.wasm.toFixed(0)} ms in ${g.calls} calls (longest ${g.maxWasm.toFixed(0)} ms from ${this.proc.symbolize(g.maxWasmEip)} to ${this.proc.symbolize(g.maxWasmEnd)} exit ${g.maxWasmExit}), translate ${g.tr.toFixed(0)} ms x${g.trN}, steps ${(this.jit.stats.steps ?? 0) - g.steps0}, fallbacks ${(this.jit.stats.fallbackSteps ?? 0) - g.fb0}` : ''}`);
          if (this.jit) this.jit.dbgLong = null;
        }
        switch (exit) {
          case EXIT.HALT:
            if (until >= 0 && cpu.eip === until) return cpu.eax;
            throw new GuestCrash(this.crashReport(thread, 'HLT executed'));
          case EXIT.THUNK:
            if (longMs) this.dispatchThunkTimed(thread, cpu.exitArg, longMs);
            else this.dispatchThunk(thread, cpu.exitArg);
            if (opts.slice && thread.state !== TS.RUNNING) return 0; // parked (unwound wait) or exited
            if (thread.yieldRequested) { thread.yieldRequested = false; if (opts.slice) { this.sched.markReady(thread); return 0; } }
            if (budget <= 0) { budget = this.sliceInsns; if (this.sliceEnd(thread, opts)) return 0; }
            break;
          case EXIT.TIMESLICE:
            budget = this.sliceInsns; if (this.sliceEnd(thread, opts)) return 0;
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
      if (acctPrev >= 0) acct.leave(acctPrev);
      if (nested) { ctx.thread = cThread; ctx.cpu = cCpu; ctx.sp = cSp; ctx.def = cDef; }
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

  /**
   * Frame accounting: does the thread that presents frames (the last to call Present, `presentThread`) wait for a
   * file read (its own on the network, or one another thread has parked)? Then the worker's waits are I/O stalls of the
   * frame, not the game's pacing.
   */
  frameThreadWaitsForRead() { const t = this.presentThread; return !!t && t.state === TS.BLOCKED && (t.blockReason === 'file read' || t.blockReason === 'file busy'); }

  // ------------------------------------------------------------------ API dispatch
  /**
   * Run the COM calls the JIT's fast path queued (runtime.js DEFER_SPECS: Direct3D state setters, D3DX effect parameter setters), in
   * order, before an API call handled in JavaScript observes the device state.
   */
  drainDeferred(thread) {
    const m = this.mem;
    const n = m.read32(DEFER_QUEUE);
    if (!n) return;
    m.write32(DEFER_QUEUE, 0); m.write32(DEFER_QUEUE + 4, 0); m.write32(DEFER_QUEUE + 8, 0);
    const ctx = this.ctx, u32 = m.u32, hist = this.apiHistCounts, thunks = this.api.thunks, cpu = thread.cpu, proc = this.proc, com = this.com;
    let calls = 0;
    for (let p = DEFER_QUEUE + 16, end = p + n; p < end; calls++) {
      const idx = u32[p >>> 2], argc = u32[(p >>> 2) + 1], spec = u32[(DEFER_SPEC >>> 2) + idx], words = spec & DEFER_RAW ? u32[(p >>> 2) + 6] >>> 2 : (spec >>> 8) & 0xff; // (DEFER_RAW: the byte count argument)
      const def = thunks[idx].def;
      ctx.thread = thread; ctx.cpu = cpu; ctx.proc = proc; ctx.def = def; ctx.sp = p + 4; // (Ctx.bind; arg(i) reads the recorded arguments)
      if (hist && idx < hist.length) hist[idx]++;
      const cm = def.com; // (a COM method: called straight on its object, see Com.callQueued)
      if (cm !== null && cm !== undefined && !apiOpt.off) com.callQueued(ctx, u32[(p >>> 2) + 2], cm.iface, cm.index); else def.fn(ctx);
      p += 4 * (2 + argc + words);
    }
    this.apiCalls += calls;
    this.deferredCalls = (this.deferredCalls ?? 0) + 1;
    if (this.shadowResync) { this.shadowResync = false; for (const d of this.d3dDevices ?? []) d.shadowOn?.(); }
    if (this.jit?.optOnPending) { this.jit.optOnPending = false; m.write32(PROC_CONSTS + 4, 0); }
  }

  /**
   * Measurement switch (harness dbg:ORTHROS_API_FAST_OFF=1, then =): the fast paths of COM AddRef/Release and the
   * issued-state filter of the Direct3D state setters off / on again within one session. The filter comes back on only
   * once the deferred queue is empty (sets queued meanwhile did not update the shadow; their handlers do when drained).
   */
  setApiFastPaths(on) {
    this.jit?.setRefFast?.(on);
    this.stateFilterOff = !on;
    if (on && this.mem.u32[DEFER_QUEUE >>> 2]) { this.shadowResync = true; return; }
    this.shadowResync = false;
    for (const d of this.d3dDevices ?? []) d.shadowOn?.();
  }

  /** (debugging, ORTHROS_LONG_STEP_MS) dispatchThunk, logging a call longer than `longMs` */
  dispatchThunkTimed(thread, idx, longMs) {
    const t0 = performance.now();
    try { return this.dispatchThunk(thread, idx); } finally {
      const d = performance.now() - t0;
      if (d > longMs) { const t = this.api.thunk(idx); this.logFn('hang', `long API call: ${d.toFixed(0)} ms in ${t?.dll}!${t?.name}`); }
    }
  }
  /**
   * An API call from guest code (thunk `idx`), timed on a sample of the calls for the frame accounting (frame-acct.js:
   * the others are counted and estimated).
   */
  dispatchThunk(thread, idx) {
    if (!acct.apiTimed(idx)) return this.dispatchThunkBody(thread, idx);
    const outer = acct.cur !== ACCT.api, p = acct.enter(ACCT.api), a0 = acct.acc[ACCT.api], d0 = acct.acc[ACCT.draw], n0 = acct.nestApi, m0 = acct.nestDraw;
    try { return this.dispatchThunkBody(thread, idx); } finally { acct.apiEnd(p, idx, a0, d0, outer, n0, m0); }
  }
  dispatchThunkBody(thread, idx) {
    if (this.mem.u32[DEFER_QUEUE >>> 2]) this.drainDeferred(thread);
    const t = this.api.thunk(idx);
    const cpu = thread.cpu;
    if (!t) throw new GuestCrash(this.crashReport(thread, `jump into unknown thunk ${idx}`));
    const def = t.def;
    const ctx = this.ctx.bind(thread, def);
    const sp = cpu.esp;
    this.apiCalls++; thread.apiCalls++;
    if (globalThis.ORTHROS_STACK_PATTERN && !this.stackPatSeen) this.stackPatternCheck(thread, t, sp);
    if ((sp & 3) && !this.warnedMisaligned) { this.warnedMisaligned = true; this.warn(`misaligned ESP ${sp.toString(16)} at API call ${t.dll}!${t.name}\n` + this.crashReport(thread, 'misaligned stack')); }
    if (this.apiHistCounts) { if (idx >= this.apiHistCounts.length) { const n = new Uint32Array(Math.max(idx + 1, this.apiHistCounts.length * 2)); n.set(this.apiHistCounts); this.apiHistCounts = n; } this.apiHistCounts[idx]++; }
    if (def) {
      if (this.traceApi) this.logFn('api', this.fmtCall(t, ctx, def.argc));
      else if (this.traceApiBg && thread !== this.proc.threads[0] && !APIBG_QUIET.has(t.name)) this.logFn('apibg', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)}`); // background threads only (loaders, audio), without the timing/sync chatter
      const tp = this.apiTracePos++ & (API_TRACE_LEN - 1);
      this.apiTraceNames[tp] = t; this.apiTraceRets[tp] = this.mem.read32(sp); this.apiTraceTids[tp] = thread.id;
      let r;
      const tApi = this.apiTimes ? performance.now() : 0; // (diagnostics: time per API within a frame, see apiTimes)
      let wait = null;
      try { r = def.fn(ctx); if (r === PARK) { wait = thread.parkWait; thread.parkWait = null; } }
      catch (e) {
        if (!(e instanceof WaitUnwind)) { if (this.apiTimes) this.noteApiTime(t, tApi); throw e; }
        wait = e.wait;
      }
      if (wait) {
        if (this.apiTimes) this.noteApiTime(t, tApi);
        // park the thread: roll the call back to the thunk so it re-executes once woken
        cpu.esp = sp; cpu.eip = t.addr;
        thread.state = TS.BLOCKED; thread.wait = wait; thread.blockReason = wait.reason; thread.wakeAt = wait.deadline;
        if (this.waitLogMin) { thread.blockedAt = this.clock.now(); thread.blockedApi = t.name; thread.blockedFrom = this.mem.read32(sp); } // (diagnostics: long waits, see Scheduler.wake)
        return;
      }
      if (this.apiTimes) this.noteApiTime(t, tApi);
      if (thread.resuming) { thread.resuming = false; thread.wakeResult = undefined; } // re-executed call completed without blocking again
      // (debugging, ?dbg=ORTHROS_API_TAIL=<n>: the last n calls of the main thread with their arguments and results, in
      // crash reports — what a thread did just before a corruption shows)
      if (globalThis.ORTHROS_API_TAIL && thread === this.proc.threads[0]) { const q = (this.apiTail ??= []); q.push(`${this.fmtCall(t, ctx, def.argc)} -> ${r === undefined ? '-' : r === TAIL_CALL ? 'tail' : '0x' + (r >>> 0).toString(16)}`); if (q.length > globalThis.ORTHROS_API_TAIL) q.shift(); }
      if (this.apiBurst && this.apiBurst.tid === thread.id && !(this.apiBurst.noGfx && (t.dll === 'com.dll' || t.dll.startsWith('d3dx9'))) && this.apiBurst.left-- > 0 && !APIBG_QUIET.has(t.name)) this.logFn('apiburst', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)} -> ${r === undefined ? '-' : r === TAIL_CALL ? 'tail' : '0x' + (r >>> 0).toString(16)} from ${this.proc.symbolize(this.mem.read32(sp))}`);
      if (this.traceApiRet && !APIBG_QUIET.has(t.name) && (this.traceApiRet > 1 || !(t.dll === 'com.dll' || t.dll.startsWith('d3dx9')))) this.logFn('api', `[t${thread.id}] ${this.fmtCall(t, ctx, def.argc)} -> ${r === undefined ? '-' : r === TAIL_CALL ? 'tail' : '0x' + (r >>> 0).toString(16)} err ${thread.lastError ?? '?'}`); // (debugging: dbg:ORTHROS_TRACE_API=1 in the harness)
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

  /**
   * (debugging, ?dbg=ORTHROS_WRITE_CHECK=1) bulk writes of the JavaScript side (API handlers: file reads, surfaces,
   * strings...) checked to stay inside one allocation of the address space: a write running past the end of a region
   * into the next one is reported with the API call and the thread
   */
  writeCheck(vmem) {
    const mem = this.mem, P = 4096, wb = mem.writeBytes.bind(mem), fl = mem.fill.bind(mem), cp = mem.copy.bind(mem);
    let n = 0;
    const check = (a, len, what) => {
      if (len <= 0) return;
      a >>>= 0;
      const p0 = (a / P) | 0, p1 = ((a + len - 1) / P) | 0;
      if (p0 >= vmem.owner.length) return;
      const o = vmem.owner[p0];
      if (o >= 0 && vmem.regions.get(o * P)?.quarantined && ++n <= 20) this.warn(`write check: ${what} of ${len} bytes at ${a.toString(16)} into a released region (${vmem.regions.get(o * P).tag}) [t${this.current?.id ?? '?'}, last API ${this.recentApiCalls(1)[0] ?? '-'}]`);
      if (o < 0 || p0 === p1) return;
      for (let p = p0 + 1; p <= Math.min(p1, vmem.owner.length - 1); p++) if (vmem.owner[p] !== o || vmem.state[p] !== vmem.state[p0]) {
        if (++n <= 20) this.warn(`write check: ${what} of ${len} bytes at ${a.toString(16)} runs past its allocation (${(o * P).toString(16)}, ${vmem.regions.get(o * P)?.tag ?? '?'}) into page ${(p * P).toString(16)} (${vmem.regions.get(vmem.owner[p] * P)?.tag ?? 'free'}) [t${this.current?.id ?? '?'}, last API ${this.recentApiCalls(1)[0] ?? '-'}]`);
        return;
      }
    };
    mem.writeBytes = (a, src) => { check(a, src.length, 'writeBytes'); wb(a, src); };
    mem.fill = (a, len, v = 0) => { check(a, len, 'fill'); fl(a, len, v); };
    mem.copy = (d, src, len) => { check(d, len, 'copy'); cp(d, src, len); };
  }

  /**
   * (debugging, ?dbg=ORTHROS_RELEASE_WATCH=1) released regions of the address space (VirtualFree, textures, buffers,
   * DIB sections, thread stacks...) stay reserved for 20 s with their pages watched before they are freed: a guest
   * write into one (translated code: an SMC-map watch) is reported with the writer's thread and call stack
   */
  releaseWatch(vmem) {
    const q = [];
    let reported = 0;
    vmem.onRelease = (base, r) => {
      if (!this.jit || r.size > 64 << 20) return false;
      r.quarantined = true; r.tag = `released ${r.tag ?? ''} (by t${this.current?.id} in ${this.recentApiCalls(1)[0] ?? '-'})`;
      const at = performance.now();
      q.push({ base, at });
      this.jit.watchWrites(base, r.size, `released:${base.toString(16)}`, 1e9);
      while (q.length && at - q[0].at > 20000) { const o = q.shift(); this.jit.unwatch(`released:${o.base.toString(16)}`); vmem.release(o.base); }
      return true;
    };
    const hit = this.jit?.watchHit.bind(this.jit);
    if (this.jit) this.jit.watchHit = (addr, eip, len, thread) => {
      const handled = hit(addr, eip, len, thread);
      const o = vmem.owner[(addr / 4096) | 0], reg = o >= 0 ? vmem.regions.get(o * 4096) : null;
      const oe = vmem.owner[((addr + len - 1) / 4096) | 0]; // (a store range only touching its last bytes: a copy into the next region)
      if (handled && reg?.quarantined && oe === o && ++reported <= 20) this.warn(`write into a released region: ${addr.toString(16)} (${len} bytes) in ${(o * 4096).toString(16)}+${reg.size.toString(16)} ${reg.tag} by t${thread?.id} at ${this.proc.symbolize(eip)}; next region ${(() => { const q = vmem.owner[((o * 4096 + reg.size) / 4096) | 0]; const nr = q >= 0 ? vmem.regions.get(q * 4096) : null; return nr ? (q * 4096).toString(16) + ' ' + nr.tag : 'free'; })()}; regs ${thread ? ['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi', 'ebp', 'esp'].map((k) => k + '=' + (thread.cpu[k] >>> 0).toString(16)).join(' ') : ''}; last API of the thread ${this.recentApiCalls(3, thread?.id).join(' | ')}\n${thread ? this.threadsReport().split('\n').filter((l) => l.includes(`  ${thread.id} (`) || l.startsWith('      stack')).slice(0, 2).join('\n') : ''}`);
      return handled;
    };
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
      const map = { 0: [EXC.INT_DIVIDE_BY_ZERO, []], 6: [EXC.ILLEGAL_INSTRUCTION, []], 13: [EXC.ACCESS_VIOLATION, [0, 0xffffffff]], 14: [EXC.ACCESS_VIOLATION, [fault?.write ? 1 : 0, fault?.faultAddr ?? 0]], 3: [EXC.BREAKPOINT, []], 4: [EXC.INT_OVERFLOW, []], 5: [EXC.ARRAY_BOUNDS, []] };
      const [code, params] = map[vec] ?? [EXC.ILLEGAL_INSTRUCTION, []];
      if (vec === 14 && /^(cpu fault #14 )?execution at/.test(fault?.message ?? '') && (this.execFaults = (this.execFaults ?? 0) + 1) <= 8) {
        this.warn(`${fault.message} (thread ${thread.id}, return address on the stack: ${this.proc.symbolize(this.mem.read32(cpu.esp))}): access violation raised`);
        // (the first one in full — a jump to nowhere usually means an overwritten return address: what ran before it,
        // which files it read and the stack's bytes are what tell why; it goes to the crash telemetry with the log)
        if (this.execFaults === 1) { try { this.warn(`${this.crashReport(thread, 'first jump to unmapped memory')}\n${this.stackBytes(cpu.esp)}${this.recentFiles?.length ? `\nfiles opened last (oldest first):\n  ${this.recentFiles.join('\n  ')}` : ''}`); } catch { /* best effort */ } }
      }
      if (vec === 14 && fault?.nullPage && (this.nullFaults = (this.nullFaults ?? 0) + 1) <= 8) {
        // (a null pointer used: the program's handlers see it as on Windows; the first ones are logged in full, with
        // the threads — the first is usually where a corruption becomes visible)
        try { this.warn(`${fault.message} at ${this.proc.symbolize(cpu.eip)} (thread ${thread.id}): access violation raised${this.nullFaults === 1 ? `\n${this.crashReport(thread, 'first null-page access')}` : ''}`); } catch { /* best effort */ }
      }
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
      lines.push(`  ${t.id} (${t.name || '-'}) prio ${t.priority ?? 0} ${['ready', 'running', 'blocked', 'suspended', 'done'][t.state] ?? t.state}${t.state === 2 ? ` [${typeof t.blockReason === 'function' ? t.blockReason() : t.blockReason}${t.wait ? '' : ' nested'}${t.wakeAt < Infinity ? ` until +${Math.max(0, t.wakeAt - this.clock.now()).toFixed(0)}ms` : ''}]` : ''}${t.callbackDepth ? ` cb=${t.callbackDepth}` : ''} eip=${proc.symbolize(cpu.eip)}\n      stack: ${rets.join(' < ') || '-'}\n      last API: ${last || '-'}${ss}`);
    }
    // (ORTHROS_HEAP_PROV: what the registers of the threads that run point to — a thread spinning in a damaged list)
    if (this.heapProvMap) for (const t of proc.threads) if (t.state === TS.READY || t.state === TS.RUNNING) { lines.push(`  t${t.id} registers: eax=${(t.cpu.eax >>> 0).toString(16)} ecx=${(t.cpu.ecx >>> 0).toString(16)} edx=${(t.cpu.edx >>> 0).toString(16)} ebx=${(t.cpu.ebx >>> 0).toString(16)} esi=${(t.cpu.esi >>> 0).toString(16)} edi=${(t.cpu.edi >>> 0).toString(16)} ebp=${(t.cpu.ebp >>> 0).toString(16)}`); try { lines.push(...this.registerMemory(t.cpu)); } catch (e) { lines.push(`  (${e.message})`); } }
    for (const hp of proc.heaps) if (hp.stats.badTags || hp.stats.brokenLists) lines.push(`heap ${hp.tag}: ${hp.stats.badTags ?? 0} overwritten boundary tags, ${hp.stats.brokenLists ?? 0} broken free lists${hp.badTagLog ? '\n  ' + hp.badTagLog.join('\n  ') : ''}`);
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

  /** Hex and text of the stack around `esp` (256 bytes below, 768 above): what overwrote a return address. */
  stackBytes(esp) {
    const lines = ['stack bytes:'];
    for (let a = ((esp - 0x100) & ~15) >>> 0; a < esp + 0x300; a += 16) {
      if (!this.proc.vmem.isCommitted(a, 16)) continue;
      const b = this.mem.bytes(a, 16);
      lines.push(`  ${a.toString(16).padStart(8, '0')}${a <= esp && esp < a + 16 ? '>' : ' '} ${hex(b)}  ${String.fromCharCode(...[...b].map((c) => (c >= 32 && c < 127 ? c : 46)))}`);
    }
    return lines.join('\n');
  }

  /**
   * Debugging (?dbg=ORTHROS_STACK_PATTERN=<text>): at every API call, whether the calling thread's stack (1.5 KiB above
   * ESP) holds `text`; the first call that finds it is logged with the calls before it — what put it there.
   */
  stackPatternCheck(thread, t, sp) {
    const pat = this.stackPat ??= Array.from(String(globalThis.ORTHROS_STACK_PATTERN), (ch) => ch.charCodeAt(0) & 0xff);
    const u8 = this.mem.u8, end = Math.min(sp + 0x600, 0x7fff0000) - pat.length;
    for (let a = sp - 0x100; a < end; a++) {
      if (u8[a] !== pat[0]) continue;
      let k = 1; while (k < pat.length && u8[a + k] === pat[k]) k++;
      if (k < pat.length) continue;
      this.stackPatSeen = true;
      this.warn(`stack pattern "${globalThis.ORTHROS_STACK_PATTERN}" at ${a.toString(16)} (esp ${sp.toString(16)}) in thread ${thread.id}, seen at ${t.dll}!${t.name} from ${this.proc.symbolize(this.mem.read32(sp))}; calls before (oldest first):\n  ${this.recentApiCalls(24).join('\n  ')}\n${this.stackBytes(sp)}`);
      return;
    }
  }

  /**
   * The instructions ending at `ret` (a return address: its call last), decoded from the earliest start up to 48 bytes
   * before it whose instruction chain lands exactly on it — empty when `ret` is not in a module.
   */
  codeBefore(ret) {
    ret >>>= 0;
    const mem = this.mem, proc = this.proc, out = [];
    if (!proc.moduleByAddr(ret) || !proc.moduleByAddr(ret - 48)) return out;
    for (let s = ret - 48; s < ret; s++) {
      const chain = [];
      let a = s;
      try { while (a < ret) { const insn = decode(mem, a); chain.push([a, insn]); a = insn.next; } } catch { continue; }
      if (a !== ret) continue;
      for (const [x, insn] of chain.slice(-12)) out.push(`  ${proc.symbolize(x)}  ${hex(mem.bytes(x, insn.len)).padEnd(20)} ${fmtInsn(insn)}`);
      return out;
    }
    return out;
  }

  /**
   * Debugging (`?dbg=ORTHROS_PEEK=<hex>[:<len>|:c<count>];...`, shown in crash reports and at the end of Node bench
   * runs): for an address in a module, the instructions before it and `count` (default 8) from it; elsewhere `len` bytes
   * (default 16) of memory.
   */
  peekReport() {
    const spec = globalThis.ORTHROS_PEEK; if (!spec) return [];
    const mem = this.mem, proc = this.proc, out = ['peek (ORTHROS_PEEK):'];
    for (const item of String(spec).split(';').filter(Boolean)) {
      const [as, ls] = item.split(':'); const a = parseInt(as, 16) >>> 0, len = ls ? parseInt(ls, 10) : 16;
      try {
        if (proc.moduleByAddr(a) && (!ls || ls[0] === 'c')) {
          out.push(`  code at ${proc.symbolize(a)}:`, ...this.codeBefore(a));
          let x = a;
          for (let i = 0, n = ls ? parseInt(ls.slice(1), 10) : 8; i < n; i++) { const insn = decode(mem, x); out.push(`  ${proc.symbolize(x)}  ${hex(mem.bytes(x, insn.len)).padEnd(20)} ${fmtInsn(insn)}  <`); x = insn.next; }
        } else if (proc.vmem.isCommitted(a, len)) out.push(`  ${a.toString(16)}: ${hex(mem.bytes(a, len))}`);
        else out.push(`  ${a.toString(16)}: not committed`);
      } catch (e) { out.push(`  ${a.toString(16)}: ${e.message}`); }
    }
    return out;
  }

  /** 32 bytes at each general register that holds a committed address (hex and text). */
  registerMemory(cpu) {
    const out = ['memory at registers:'], seen = new Set(), ptrs = [];
    for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi', 'ebp']) {
      const v = cpu[r] >>> 0;
      if (v < 0x10000 || !this.proc.vmem.isCommitted(v, 128)) continue;
      ptrs.push([r, v]);
      { const vm_ = this.proc.vmem, o = vm_.owner[(v / 4096) | 0], reg = o >= 0 ? vm_.regions.get(o * 4096) : null; if (reg) out.push(`  ${r} in region ${(o * 4096).toString(16)}+${reg.size.toString(16)} ${reg.tag ?? ''}`); }
      for (let k = 0; k < 128; k += 32) {
        const b = this.mem.bytes(v + k, 32);
        out.push(`  ${k ? '   ' : r} ${(v + k).toString(16).padStart(8, '0')}: ${hex(b)}  ${String.fromCharCode(...[...b].map((ch) => (ch >= 32 && ch < 127 ? ch : 46)))}`);
      }
      for (let k = 0; k < 128; k += 4) { const p = this.mem.read32(v + k); if (p >= 0x10000) ptrs.push([`[${r}+0x${k.toString(16)}]`, p]); }
    }
    // what the pointers held in that memory point to (an object whose fields were overwritten: by what)
    const shown = new Set(ptrs.filter(([w]) => !w.startsWith('[')).map(([, v]) => v));
    for (const [what, p] of ptrs) {
      if (!what.startsWith('[') || shown.has(p) || !this.proc.vmem.isCommitted(p, 64) || shown.size >= 40) continue;
      shown.add(p);
      const b = this.mem.bytes(p, 64);
      out.push(`  ${what} -> ${p.toString(16)}: ${hex(b)}  ${String.fromCharCode(...[...b].map((ch) => (ch >= 32 && ch < 127 ? ch : 46)))}`);
    }
    // the heap blocks they point into (with their last operations under ORTHROS_HEAP_PROV)
    for (const [what, p] of ptrs) {
      const blk = this.heapBlockOf(p);
      if (!blk || seen.has(blk.user)) continue;
      seen.add(blk.user);
      const b = this.mem.bytes(blk.user, Math.min(64, blk.size));
      out.push(`  ${what}=${p.toString(16)} in ${blk.heap} block ${blk.user.toString(16)}+${blk.size.toString(16)} ${blk.used ? 'used' : 'FREE'}: ${hex(b)}  ${String.fromCharCode(...[...b].map((ch) => (ch >= 32 && ch < 127 ? ch : 46)))}${this.heapProvMap ? `\n      ${(this.heapProvMap.get(blk.user) ?? ['(no record)']).join('\n      ')}` : ''}`);
      if (seen.size >= 24) break;
    }
    return out;
  }

  /** The heap block holding `addr` (any heap of the process): its user address, size, state */
  heapBlockOf(addr) {
    for (const h of this.proc.heaps) {
      const ch = h.chunkOf(addr);
      if (!ch) continue;
      let found = null;
      h.walk((u, s, used) => { if (!found && addr >= u - 8 && addr < u + s + 8 && u >= ch.base && u < ch.base + ch.size) found = { user: u, size: s, used, heap: h.tag }; });
      return found;
    }
    return null;
  }

  crashReport(thread, reason) {
    const cpu = thread.cpu, mem = this.mem, proc = this.proc;
    const h = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
    const lines = [`*** ${reason} in thread ${thread.id} (${thread.name}) at ${proc.symbolize(cpu.eip)} (guest clock ${this.clock.now().toFixed(1)} ms)`];
    lines.push(cpu.dump());
    // disassembly around EIP
    lines.push('code:');
    let a = cpu.eip;
    for (let i = 0; i < 8; i++) {
      try { const insn = decode(mem, a); lines.push(`  ${h(a)}  ${hex(mem.bytes(a, insn.len)).padEnd(20)} ${fmtInsn(insn)}`); a = insn.next; }
      catch (e) { lines.push(`  ${h(a)}  ?? ${e.message}`); break; }
    }
    // a jump to no code (a call through a bad pointer): the instructions that led there, before the return address
    // on top of the stack, and what the registers point to (the object the pointer was read from)
    // (or, at an API call, the call site)
    if (proc.vmem.isCommitted(cpu.esp, 4) && (!this.interp.executable(cpu.eip) || this.api.nameOf(cpu.eip))) {
      const site = this.codeBefore(mem.read32(cpu.esp));
      if (site.length) lines.push('code before the return address on the stack:', ...site);
    }
    // (in a module: the instructions before EIP, and before the first return addresses of the stack — where the values
    // in the registers came from)
    if (proc.moduleByAddr(cpu.eip)) {
      try {
        const before = this.codeBefore(cpu.eip);
        if (before.length) lines.push('code before EIP:', ...before);
        let n = 0;
        for (let sa = cpu.esp; sa < cpu.esp + 0x400 && n < 3 && proc.vmem.isCommitted(sa, 4); sa += 4) {
          const v = mem.read32(sa) >>> 0;
          if (!proc.moduleByAddr(v) || v < 0x1000 || !(mem.read8(v - 5) === 0xe8 || mem.read8(v - 2) === 0xff || mem.read8(v - 3) === 0xff || mem.read8(v - 6) === 0xff)) continue;
          const site = this.codeBefore(v);
          if (site.length) { lines.push(`code before return address ${proc.symbolize(v)} (stack ${h(sa)}):`, ...site); n++; }
        }
      } catch (e) { lines.push(`(code before: ${e.message})`); }
    }
    try { lines.push(...this.registerMemory(cpu)); } catch (e) { lines.push(`(register memory: ${e.message})`); }
    lines.push('stack:');
    for (let i = 0; i < 16; i++) {
      const sa = cpu.esp + 4 * i;
      if (!proc.vmem.isCommitted(sa, 4)) break;
      const v = mem.read32(sa);
      lines.push(`  ${h(sa)}: ${h(v)}  ${proc.moduleByAddr(v) || this.api.nameOf(v) ? proc.symbolize(v) : ''}`);
    }
    lines.push('recent API calls:');
    for (const l of this.recentApiCalls(64)) lines.push('  ' + l);
    lines.push(...this.peekReport());
    if (this.apiTail) lines.push('main thread API calls (ORTHROS_API_TAIL, oldest first):\n  ' + this.apiTail.join('\n  '));
    lines.push('modules:');
    for (const m of proc.moduleList) lines.push(`  ${h(m.base)}-${h(m.base + m.size)} ${m.name}`);
    if (proc.threads.length > 1) lines.push(this.threadsReport());
    if (this.traceRing) {
      const r = this.traceRing, out = []; for (let k = 0; k < 256; k++) { const x = r.a[(r.i + k) & 255]; if (x) out.push(x); }
      lines.push('traced entries (oldest first):\n  ' + out.slice(-64).join('\n  '));
      // the earlier entries whose first argument is a value the registers or the stack hold now (a pointer freed twice...)
      const vals = new Set([cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esi, cpu.edi, cpu.ebp].map((v) => v >>> 0));
      for (let i = 0; i < 32; i++) if (proc.vmem.isCommitted(cpu.esp + 4 * i, 4)) vals.add(mem.read32(cpu.esp + 4 * i) >>> 0);
      for (const v of vals) { for (const d of [0, 4, 8, 12]) { const l = this.traceByArg.get((v + d) >>> 0); if (l) lines.push(`traced with argument ${((v + d) >>> 0).toString(16)}:\n  ${l.join('\n  ')}`); } }
    }
    return lines.join('\n');
  }
}

export { EXIT, F };

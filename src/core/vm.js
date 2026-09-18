// The virtual machine: guest memory, process, executor (interpreter; JIT later), API dispatch
// loop, guest callbacks, crash reports. See DECISIONS.md D003/D004.
import { GuestMemory } from '../cpu/memory.js';
import { EXIT, F } from '../cpu/state.js';
import { Interp } from '../cpu/interp.js';
import '../cpu/interp-x87.js';
import '../cpu/interp-sse.js';
import { decode, fmtInsn } from '../cpu/decoder.js';
import { ApiRegistry, CC_STDCALL } from '../win32/api.js';
import { Ctx } from '../win32/ctx.js';
import { Process, TS } from '../win32/process.js';
import { Scheduler } from './sched.js';
import { RealClock } from './clock.js';
import { registerBuiltins } from '../win32/builtins.js';
import { Jit } from '../cpu/jit/jit.js';

export class ProcessExit extends Error {
  constructor(code) { super(`process exit ${code}`); this.code = code; }
}
export class ThreadExit extends Error {
  constructor(thread, code) { super(`thread ${thread.id} exit ${code}`); this.thread = thread; this.code = code; }
}
export class GuestCrash extends Error {
  constructor(report) { super('guest crash\n' + report); this.report = report; }
}

const SLICE_INSNS = 100000;

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
    this.jit = opts.jit === false ? null : new Jit(this.mem, this.interp, { smc: true, log: opts.logKinds?.includes('jit') ? (m) => this.log('jit', m) : null });
    this.exec = this.jit ?? this.interp; // executor: { run(opts), lastFault } bound to a cpu via .cpu
    this.ctx = new Ctx(this);
    this.sched = new Scheduler(this);
    this.proc = null;
    this.depth = 0;
    this.current = null;
    this.logKinds = new Set(opts.logKinds ?? ['loader', 'warn', 'crash']);
    this.logFn = opts.log ?? ((kind, msg) => console.log(`[${kind}] ${msg}`));
    this.apiTrace = new Array(64).fill(null);
    this.apiTracePos = 0;
    this.apiCalls = 0;
    this.stdout = [];
    this.onStdout = null;
    // Internal thunks (pseudo-DLL "orthros")
    this.api.define('orthros.dll', {
      __return: [0, () => 0, { noreturn: true }],
      __exit_thread: [0, (ctx) => this.exitThread(ctx.thread, ctx.cpu.eax), { noreturn: true }],
      __exit_process: [0, (ctx) => this.exitProcess(ctx.cpu.eax), { noreturn: true }],
    });
    this.returnThunk = this.api.thunkFor('orthros.dll', '__return');
    this.exitThreadThunk = this.api.thunkFor('orthros.dll', '__exit_thread');
    this.exitProcessThunk = this.api.thunkFor('orthros.dll', '__exit_process');
    registerBuiltins(this.api, this);
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
    const exe = proc.loadModule(proc.exePath.slice(proc.exePath.lastIndexOf('\\') + 1), { forExe: true, path: proc.exePath, bytes });
    proc.exe = exe;
    this.mem.write32(0x7ffdf000 + 8, exe.base); // PEB.ImageBaseAddress
    const stackSize = Math.max(exe.image.stackReserve || 0x100000, 0x100000);
    const main = proc.createThread({ start: exe.entry, param: 0, stackSize, main: true, stackBase: 0x00130000 - stackSize });
    main.name = 'main';
    return proc;
  }

  /** Run the process to completion. Returns the exit code. */
  run() {
    const proc = this.proc;
    const main = proc.threads[0];
    try {
      // DllMain(PROCESS_ATTACH) + TLS callbacks for native DLLs, dependencies first (load order)
      for (const mod of proc.moduleList) if (mod !== proc.exe && !mod.attached) this.attachModule(main, mod);
      for (const cb of proc.exe.tls?.callbacks ?? []) this.callGuest(main, cb, [proc.exe.base, 1, 0]);
      this.runThread(main, {});
      // main thread returned/exited without ExitProcess: process ends with its exit code
      return this.finish(main.exitCode === 0x103 ? main.cpu.eax : main.exitCode);
    } catch (e) {
      if (e instanceof ProcessExit) return this.finish(e.code);
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

  exitProcess(code) { throw new ProcessExit(code >>> 0); }

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
  runThread(thread, opts) {
    const until = opts.until ?? -1;
    const prev = this.current;
    const base = thread.onStack === 0;
    this.current = thread;
    thread.onStack++;
    if (base) thread.baseDepth = this.depth;
    this.depth++;
    thread.state = TS.RUNNING;
    const exec = this.exec;
    const cpu = thread.cpu;
    try {
      for (;;) {
        exec.cpu = cpu;
        const exit = exec.run({ stopAt: until, maxInsns: SLICE_INSNS });
        switch (exit) {
          case EXIT.HALT:
            if (until >= 0 && cpu.eip === until) return cpu.eax;
            throw new GuestCrash(this.crashReport(thread, 'HLT executed'));
          case EXIT.THUNK:
            this.dispatchThunk(thread, cpu.exitArg);
            if (opts.slice && thread.state !== TS.RUNNING) return 0;
            break;
          case EXIT.TIMESLICE:
            this.clock.tick?.(0.5);
            if (opts.slice) { thread.state = TS.READY; return 0; }
            if (this.depth === 1) { thread.state = TS.READY; this.sched.yieldFrom(thread); thread.state = TS.RUNNING; }
            break;
          case EXIT.FAULT:
            this.onFault(thread);
            break;
          case EXIT.BREAK:
            this.onBreak(thread);
            break;
          case EXIT.SMC:
            this.invalidateCode(cpu.exitArg, 1);
            break;
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

  // ------------------------------------------------------------------ API dispatch
  dispatchThunk(thread, idx) {
    const t = this.api.thunk(idx);
    const cpu = thread.cpu;
    if (!t) throw new GuestCrash(this.crashReport(thread, `jump into unknown thunk ${idx}`));
    const def = t.def;
    const ctx = this.ctx.bind(thread, def);
    const sp = cpu.esp;
    this.apiCalls++;
    if (def) {
      if (this.logKinds.has('api') || this.logKinds.has('all')) this.logFn('api', this.fmtCall(t, ctx, def.argc));
      this.apiTrace[this.apiTracePos++ & 63] = { name: `${t.dll}!${t.name}`, ret: this.mem.read32(sp), args: this.argsOf(ctx, Math.min(def.argc, 6)) };
      const r = def.fn(ctx);
      if (def.noreturn) return;
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
    this.apiTrace[this.apiTracePos++ & 63] = { name: key + ' [stub]', ret: this.mem.read32(sp), args: this.argsOf(ctx, 4) };
    cpu.eip = this.mem.read32(sp);
    cpu.esp = (sp + 4 + (argc ?? 0) * 4) >>> 0;
    cpu.eax = 0;
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
    // Guest SEH could be dispatched here (M4+). For now: crash.
    throw new GuestCrash(this.crashReport(thread, `fault ${fault ? fault.message : thread.cpu.exitArg}`));
  }

  onBreak(thread) {
    // int3: treat as a breakpoint/debug trap -> continue after it (debuggers absent)
    this.warn(`int3 at ${this.proc.symbolize(thread.cpu.eip)}`);
    thread.cpu.eip = (thread.cpu.eip + 1) >>> 0;
    thread.cpu.exit = EXIT.NONE;
  }

  /** RaiseException: structured exception handling is not dispatched yet (M4). */
  raiseException(ctx, code, flags, nargs, argsPtr) {
    return new GuestCrash(this.crashReport(ctx.thread, `RaiseException(0x${(code >>> 0).toString(16)}) from ${this.proc.symbolize(ctx.retAddr)}`));
  }
  rtlUnwind(ctx) {
    throw new GuestCrash(this.crashReport(ctx.thread, 'RtlUnwind: SEH unwinding not implemented yet'));
  }

  deadlock(thread, reason) {
    throw new GuestCrash(this.crashReport(thread, `deadlock: all threads blocked (${reason})`));
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
      try { const insn = decode(mem, a); lines.push(`  ${h(a)}  ${Buffer.from(mem.bytes(a, insn.len)).toString('hex').padEnd(20)} ${fmtInsn(insn)}`); a = insn.next; }
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
    for (let i = 0; i < 64; i++) {
      const e = this.apiTrace[(this.apiTracePos + i) & 63];
      if (e) lines.push(`  ${e.name}(${e.args.map((v) => h(v)).join(', ')}) from ${proc.symbolize(e.ret)}`);
    }
    lines.push('modules:');
    for (const m of proc.moduleList) lines.push(`  ${h(m.base)}-${h(m.base + m.size)} ${m.name}`);
    return lines.join('\n');
  }
}

export { EXIT, F };

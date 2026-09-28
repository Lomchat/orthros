// Structured exception handling (x86 frame-based SEH).
//
// Dispatch is continuation-based to survive handlers that never return (MSVC's _except_handler3
// performs a non-local goto into the __except block after RtlUnwind): the handler is entered with
// a return address pointing at an internal thunk (__seh_return) whose JS side reads the
// disposition and continues with the next frame or resumes execution from the CONTEXT.
import { ST, F } from '../cpu/state.js';

export const EXC = Object.freeze({
  ACCESS_VIOLATION: 0xc0000005, BREAKPOINT: 0x80000003, SINGLE_STEP: 0x80000004, ILLEGAL_INSTRUCTION: 0xc000001d,
  INT_DIVIDE_BY_ZERO: 0xc0000094, INT_OVERFLOW: 0xc0000095, ARRAY_BOUNDS: 0xc000008c, PRIV_INSTRUCTION: 0xc0000096,
  STACK_OVERFLOW: 0xc00000fd, UNWIND: 0xc0000027, CPP: 0xe06d7363, NONCONTINUABLE: 0xc0000025,
});
const EXCEPTION_NONCONTINUABLE = 1, EXCEPTION_UNWINDING = 2, EXCEPTION_EXIT_UNWIND = 4, EXCEPTION_NESTED_CALL = 0x10;
const REC_SIZE = 80, CTX_SIZE = 0x2cc;
const CHAIN_END = 0xffffffff;

export class Seh {
  /** @param {import('../core/vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.mem = vm.mem;
    this.returnThunk = vm.api.thunkFor('orthros.dll', '__seh_return');
  }

  /** Write a CONTEXT from the thread's CPU state. */
  writeContext(cpu, a) {
    const m = this.mem;
    m.fill(a, CTX_SIZE, 0);
    m.write32(a, 0x1003f); // CONTEXT_FULL | DEBUG | EXTENDED (i386)
    m.write16(a + 0x1c, cpu.fpuCw); m.write16(a + 0x20, cpu.fpuSw); m.write16(a + 0x24, cpu.fpuTw);
    m.write32(a + 0x8c, 0); m.write32(a + 0x90, 0x3b); m.write32(a + 0x94, 0x23); m.write32(a + 0x98, 0x23);
    m.write32(a + 0x9c, cpu.edi); m.write32(a + 0xa0, cpu.esi); m.write32(a + 0xa4, cpu.ebx); m.write32(a + 0xa8, cpu.edx); m.write32(a + 0xac, cpu.ecx); m.write32(a + 0xb0, cpu.eax);
    m.write32(a + 0xb4, cpu.ebp); m.write32(a + 0xb8, cpu.eip); m.write32(a + 0xbc, 0x1b); m.write32(a + 0xc0, cpu.eflags); m.write32(a + 0xc4, cpu.esp); m.write32(a + 0xc8, 0x23);
  }
  /** Load the thread's CPU state from a CONTEXT (registers only). */
  readContext(cpu, a) {
    const m = this.mem;
    cpu.edi = m.read32(a + 0x9c); cpu.esi = m.read32(a + 0xa0); cpu.ebx = m.read32(a + 0xa4); cpu.edx = m.read32(a + 0xa8); cpu.ecx = m.read32(a + 0xac); cpu.eax = m.read32(a + 0xb0);
    cpu.ebp = m.read32(a + 0xb4); cpu.eip = m.read32(a + 0xb8); cpu.eflags = (m.read32(a + 0xc0) & 0x0fd5) | F.RESERVED1 | F.IF; cpu.esp = m.read32(a + 0xc4);
  }
  writeRecord(a, code, flags, addr, params, nested = 0) {
    const m = this.mem;
    m.fill(a, REC_SIZE, 0);
    m.write32(a, code >>> 0); m.write32(a + 4, flags >>> 0); m.write32(a + 8, nested); m.write32(a + 12, addr >>> 0); m.write32(a + 16, params.length);
    params.slice(0, 15).forEach((p, i) => m.write32(a + 20 + 4 * i, p >>> 0));
  }

  /**
   * Raise an exception on `thread` at `addr` (the faulting/raising EIP). Sets the thread up to run
   * the first handler and returns; the dispatch continues through __seh_return.
   * @returns {boolean} false if the process has no handler at all (caller should crash)
   */
  raise(thread, code, flags, addr, params = [], opts = {}) {
    const cpu = thread.cpu, m = this.mem;
    if (opts.eip !== undefined) cpu.eip = opts.eip; else cpu.eip = addr;
    // area below the current stack pointer
    const base = ((cpu.esp - 0x40) & ~0xf) >>> 0;
    const ctx = (base - CTX_SIZE) >>> 0;
    const rec = (ctx - REC_SIZE) >>> 0;
    // (no usable stack to dispatch on — a stack pointer the program lost: Windows ends the process there too)
    if (!this.vm.proc.vmem.isCommitted((rec - 0x60) >>> 0, base - rec + 0x60)) throw new (this.vm.GuestCrash)(this.vm.crashReport(thread, `exception 0x${(code >>> 0).toString(16)} at ${this.vm.proc.symbolize(addr)} with no stack to dispatch it on (esp ${(cpu.esp >>> 0).toString(16)})`));
    this.writeContext(cpu, ctx);
    this.writeRecord(rec, code, flags, addr, params);
    // (a dispatch keeps the one it interrupted — an exception raised while a handler runs — which becomes current again
    // once it completes: the outer handler's return finds its own state; a C++ catch continuing without returning here
    // leaves a completed state behind: the chain is cut at 64)
    const prev = thread.seh && thread.seh.depth < 64 ? thread.seh : null;
    thread.seh = { rec, ctx, frame: m.read32(thread.teb), code, flags, addr, depth: (prev?.depth ?? 0) + 1, spBase: (rec - 0x40) >>> 0, prev };
    this.remember(thread, code, addr, params);
    this.sehLog( `exception ${code.toString(16)} at ${this.vm.proc.symbolize(addr)} (thread ${thread.id}), first frame ${m.read32(thread.teb).toString(16)}`);
    return this.next(thread);
  }

  /** Enter the next handler in the chain (or run the unhandled path). */
  next(thread) {
    const cpu = thread.cpu, m = this.mem, s = thread.seh;
    for (;;) {
      if (s.frame === CHAIN_END || s.frame === 0) return this.unhandled(thread);
      if (!this.vm.proc.vmem.isCommitted(s.frame, 8)) { this.vm.warn(`SEH: bad frame ${s.frame.toString(16)}`); return this.unhandled(thread); }
      const handler = m.read32(s.frame + 4);
      // call handler(rec, frame, ctx, dispatcherContext) with our thunk as return address
      let sp = s.spBase;
      sp -= 4; m.write32(sp, 0); // dispatcher context
      sp -= 4; m.write32(sp, s.ctx);
      sp -= 4; m.write32(sp, s.frame);
      sp -= 4; m.write32(sp, s.rec);
      sp -= 4; m.write32(sp, this.returnThunk);
      cpu.esp = sp;
      cpu.eip = handler;
      this.sehLog( `  -> handler ${this.vm.proc.symbolize(handler)} for frame ${s.frame.toString(16)}`);
      return true;
    }
  }

  /**
   * The last exceptions raised (any thread), kept for failure reports: code, address, and for C++ exceptions (MSVC
   * throw: code 0xe06d7363, parameters magic / object / ThrowInfo) the thrown type's decorated name, read through the
   * ThrowInfo -> CatchableTypeArray -> CatchableType -> TypeDescriptor chain of the compiler's ABI.
   */
  remember(thread, code, addr, params) {
    let what = '';
    if (code === EXC.CPP && params.length >= 3) {
      try {
        const m = this.mem, vmem = this.vm.proc.vmem, ok = (a, n = 4) => a > 0x10000 && vmem.isCommitted(a, n);
        const ti = params[2] >>> 0, cta = ok(ti + 12) ? m.read32(ti + 12) : 0, ct = ok(cta + 4) ? m.read32(cta + 4) : 0, td = ok(ct + 4) ? m.read32(ct + 4) : 0;
        if (ok(td + 8, 1)) what = ` ${m.readCString(td + 8, 96)}`;
        // the thrown object's first printable strings (an exception class often holds its message or a pointer to it)
        const obj = params[1] >>> 0, texts = [];
        for (let k = 0; k < 64 && ok(obj + 4 * k); k++) {
          for (const a of [obj + 4 * k, m.read32(obj + 4 * k) >>> 0]) {
            if (!ok(a, 4)) continue;
            const t = m.readCString(a, 160);
            if (t.length >= 4 && /^[\x20-\x7e\t\r\n]+$/.test(t) && !texts.includes(t)) texts.push(t);
          }
          if (texts.length >= 3) break;
        }
        if (texts.length) what += ` "${texts.join('" "').replace(/\s+/g, ' ').slice(0, 300)}"`;
      } catch { /* diagnostics only */ }
    }
    // the return addresses on the stack (who raised it: the caller of the runtime's throw)
    const rets = [], m2 = this.mem, proc = this.vm.proc;
    for (let a = thread.cpu.esp; a < thread.cpu.esp + 0x400 && rets.length < 6; a += 4) {
      if (!proc.vmem.isCommitted(a, 4)) break;
      const v = m2.read32(a) >>> 0;
      if (v > 0x1000 && proc.moduleByAddr(v) && (m2.read8(v - 5) === 0xe8 || m2.read8(v - 2) === 0xff || m2.read8(v - 3) === 0xff || m2.read8(v - 6) === 0xff)) rets.push(proc.symbolize(v));
    }
    (this.recent ??= []).push(`t${thread.id} 0x${(code >>> 0).toString(16)}${what} at ${this.vm.proc.symbolize(addr)}${rets.length ? ` (stack: ${rets.join(' < ')})` : ''}`);
    // the first C++ exceptions: what the thread did just before (its API calls, the last file reads of the process) —
    // later ones are often the program's own error handling
    if (code === EXC.CPP && (this.cppContexts ??= []).length < 2) {
      const r = this.vm.recentReads, reads = r ? Array.from({ length: 32 }, (_, k) => r.a[(r.i + k) & 31]).filter(Boolean).slice(-12) : [];
      this.cppContexts.push(`C++ exception #${this.cppContexts.length + 1} (${what.trim() || 'type unknown'}) — the thread's previous API calls:\n    ${this.vm.recentApiCalls(40, thread.id).join('\n    ')}\n  the last file reads:\n    ${reads.join('\n    ') || '-'}`);
    }
    if (this.recent.length > 16) this.recent.shift();
    this.raised = (this.raised ?? 0) + 1;
  }

  /** Report lines about the exceptions raised so far (see remember). */
  recentReport() { return (this.recent?.length ? `exceptions raised: ${this.raised}, the last ones:\n  ${this.recent.join('\n  ')}` : 'no exception raised') + (this.cppContexts?.length ? '\n' + this.cppContexts.join('\n') : ''); }

  /** 'seh' log capped at 80 lines per process (an exception storm would otherwise flood the console). */
  sehLog(msg) { if ((this.logCount = (this.logCount ?? 0) + 1) <= 80) this.vm.log('seh', msg); }

  /** __seh_return: a handler returned with a disposition in EAX. */
  onHandlerReturn(ctx) {
    const thread = ctx.thread, cpu = thread.cpu, m = this.mem, s = thread.seh;
    const disp = cpu.eax;
    // (no dispatch to return to: a crash report rather than this thunk running again and again)
    if (!s) throw new (this.vm.GuestCrash)(this.vm.crashReport(thread, 'SEH: a handler returned without an exception being dispatched'));
    cpu.esp = (ctx.sp + 4 + 16) >>> 0; // pop our return address + 4 args (cdecl)
    if (disp === 0) { // ExceptionContinueExecution
      this.sehLog( `  <- continue execution at ${m.read32(s.ctx + 0xb8).toString(16)}`);
      this.readContext(cpu, s.ctx);
      thread.seh = s.prev;
      return;
    }
    if (disp === 1) { // ExceptionContinueSearch
      s.frame = m.read32(s.frame);
      this.next(thread);
      return;
    }
    this.vm.warn(`SEH: unsupported disposition ${disp}`);
    this.unhandled(thread);
  }

  /** No frame handled the exception: top-level filter, then crash. */
  unhandled(thread) {
    const cpu = thread.cpu, m = this.mem, s = thread.seh;
    const filter = this.vm.proc.unhandledFilter;
    if (filter && !s.filtered) {
      s.filtered = true;
      // EXCEPTION_POINTERS { rec, ctx } on the stack; call the filter (stdcall, 1 arg)
      const ep = (s.spBase - 8) >>> 0;
      m.write32(ep, s.rec); m.write32(ep + 4, s.ctx);
      this.sehLog( `  -> unhandled exception filter ${this.vm.proc.symbolize(filter)}`);
      const r = this.vm.callGuest(thread, filter, [ep]) | 0;
      if (r === -1) { this.readContext(cpu, s.ctx); thread.seh = s.prev; return true; }
      if (r === 1) { this.vm.warn(`unhandled exception ${s.code.toString(16)} at ${this.vm.proc.symbolize(s.addr)}: filter requested termination`); this.vm.exitProcess(s.code); }
    }
    this.readContext(cpu, s.ctx);
    thread.seh = null;
    throw new (this.vm.GuestCrash)(this.vm.crashReport(thread, `unhandled exception 0x${s.code.toString(16)} at ${this.vm.proc.symbolize(s.addr)}`));
  }

  /** RtlUnwind(targetFrame, targetIp, record, returnValue): run unwind handlers down to targetFrame. */
  rtlUnwind(ctx) {
    const thread = ctx.thread, cpu = thread.cpu, m = this.mem;
    const target = ctx.arg(0), targetIp = ctx.arg(1);
    let rec = ctx.arg(2);
    const retval = ctx.arg(3);
    // scratch (record if none given, CONTEXT, handler frames) lives below the caller's stack pointer:
    // the caller's frames (e.g. the C++ frame handler's locals) are live across the unwind
    let base = ((cpu.esp - 0x40) & ~0xf) >>> 0;
    if (!rec) {
      rec = (base - REC_SIZE) >>> 0; base = rec;
      this.writeRecord(rec, EXC.UNWIND, EXCEPTION_UNWINDING, ctx.retAddr, []);
    }
    let flags = m.read32(rec + 4) | EXCEPTION_UNWINDING;
    if (!target) flags |= EXCEPTION_EXIT_UNWIND;
    m.write32(rec + 4, flags);
    const ctxAddr = ((base - 0x20 - CTX_SIZE) & ~0xf) >>> 0;
    this.writeContext(cpu, ctxAddr);
    m.write32(ctxAddr + 0xb0, retval); m.write32(ctxAddr + 0xb8, targetIp);
    let frame = m.read32(thread.teb);
    let guard = 0;
    while (frame !== CHAIN_END && frame !== target && guard++ < 10000) {
      if (!this.vm.proc.vmem.isCommitted(frame, 8)) { this.vm.warn(`RtlUnwind: bad frame ${frame.toString(16)}`); break; }
      const handler = m.read32(frame + 4), prev = m.read32(frame);
      this.sehLog( `  unwind frame ${frame.toString(16)} handler ${this.vm.proc.symbolize(handler)}`);
      // handlers may be builtin thunks: callGuest handles both
      const savedEsp = cpu.esp;
      cpu.esp = (ctxAddr - 0x40) >>> 0;
      this.vm.callGuest(thread, handler, [rec, frame, ctxAddr, 0]);
      cpu.esp = savedEsp;
      m.write32(thread.teb, prev);
      frame = prev;
    }
    m.write32(thread.teb, target || CHAIN_END);
    if (thread.seh && (thread.seh.frame === target || !target)) thread.seh = thread.seh.prev;
    // x86 RtlUnwind returns to its caller normally with EAX = returnValue
    return retval;
  }

  /**
   * Builtin _except_handler3 (MSVC SEH3 frames) for DLLs linked against the system msvcrt.
   * Frame layout: [0] prev [4] handler [8] scopetable [12] trylevel [16] saved ebp (at frame+16 = original ebp-4... );
   * the registration record lives at ebp-0x10 of the protected function.
   */
  exceptHandler3(ctx) {
    const thread = ctx.thread, cpu = thread.cpu, m = this.mem;
    const rec = ctx.arg(0), frame = ctx.arg(1), context = ctx.arg(2);
    const flags = m.read32(rec + 4);
    const scope = m.read32(frame + 8);
    let level = m.readS32(frame + 12);
    const frameEbp = frame + 16; // the function's ebp is the address of its saved-ebp slot + ... (record at ebp-0x10 => ebp = frame + 0x10)
    if (flags & (EXCEPTION_UNWINDING | EXCEPTION_EXIT_UNWIND)) {
      // local unwind: run __finally blocks (entries with filter == 0) from trylevel down
      this.localUnwind(thread, frame, scope, level, -1, frameEbp);
      return 1;
    }
    // EXCEPTION_POINTERS at frame-8 (the CRT stores it at ebp-0x14 relative to the function: frame + 16 - 0x14 = frame - 4)
    m.write32(frame - 4, rec); m.write32(frame - 8, context); // simplified: pointers struct at frame-8
    m.write32(frame - 4 - 8, frame - 8);
    while (level !== -1) {
      const entry = scope + 12 * level;
      const prev = m.readS32(entry), filter = m.read32(entry + 4), handler = m.read32(entry + 8);
      if (filter) {
        const r = this.vm.callGuest(thread, filter, [], { ebp: frameEbp }) | 0;
        if (r < 0) return 0; // continue execution
        if (r > 0) {
          // execute handler: global unwind to this frame, local unwind to this level, then jump into the handler
          const fake = { arg: (i) => [frame, 0, rec, 0][i], retAddr: ctx.retAddr, thread };
          this.rtlUnwind(fake);
          this.localUnwind(thread, frame, scope, m.readS32(frame + 12), level, frameEbp);
          m.write32(frame + 12, prev);
          cpu.ebp = frameEbp;
          cpu.esp = m.read32(frameEbp - 0x18);
          cpu.eip = handler;
          return undefined; // noreturn: state set directly
        }
      }
      level = prev;
    }
    return 1;
  }

  localUnwind(thread, frame, scope, from, to, ebp) {
    const m = this.mem;
    let level = from;
    let guard = 0;
    while (level !== -1 && level !== to && guard++ < 1000) {
      const entry = scope + 12 * level;
      const prev = m.readS32(entry), filter = m.read32(entry + 4), handler = m.read32(entry + 8);
      m.write32(frame + 12, prev);
      if (!filter && handler) this.vm.callGuest(thread, handler, [], { ebp });
      level = prev;
    }
  }
}

export { REC_SIZE, CTX_SIZE };

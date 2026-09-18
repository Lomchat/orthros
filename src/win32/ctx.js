// Call context handed to API handlers: argument access, string helpers, return conventions.
import { R } from '../cpu/state.js';

export class Ctx {
  /** @param {import('../core/vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.mem = vm.mem;
    this.proc = vm.proc;
    /** @type {import('./process.js').Thread} */
    this.thread = null;
    this.cpu = null;
    /** address of the return address slot (ESP at thunk entry) */
    this.sp = 0;
    this.def = null;
  }

  bind(thread, def) {
    this.thread = thread;
    this.cpu = thread.cpu;
    this.sp = thread.cpu.esp;
    this.def = def;
    this.proc = this.vm.proc;
    return this;
  }

  /** i-th 32-bit stack argument. */
  arg(i) { return this.mem.read32(this.sp + 4 + 4 * i); }
  /** i-th argument as signed int32 */
  sarg(i) { return this.mem.readS32(this.sp + 4 + 4 * i); }
  /** i-th argument as a 64-bit value (two slots) */
  arg64(i) { return this.mem.read64(this.sp + 4 + 4 * i); }
  /** i-th argument as f64 (two slots) / f32 (one slot) */
  argF64(i) { return this.mem.readF64(this.sp + 4 + 4 * i); }
  argF32(i) { return this.mem.readF32(this.sp + 4 + 4 * i); }
  /** ANSI string argument (null -> null) */
  str(i, max = 0x10000) { const a = this.arg(i); return a ? this.mem.readCString(a, max) : null; }
  /** Wide string argument */
  wstr(i, max = 0x10000) { const a = this.arg(i); return a ? this.mem.readWString(a, max) : null; }
  /** Return address of the call */
  get retAddr() { return this.mem.read32(this.sp); }

  // Registers (for handlers implementing register conventions or __fastcall)
  get eax() { return this.cpu.eax; } set eax(v) { this.cpu.eax = v; }
  get ecx() { return this.cpu.ecx; } set ecx(v) { this.cpu.ecx = v; }
  get edx() { return this.cpu.edx; } set edx(v) { this.cpu.edx = v; }

  /** Set the Win32 last error for the calling thread. */
  setLastError(code) { this.thread.lastError = code >>> 0; }
  /** Return value helper: 0 with last error set. */
  fail(code) { this.setLastError(code); return 0; }

  /** Write an out parameter (pointer arg i) if non-null. */
  out32(i, v) { const a = this.arg(i); if (a) this.mem.write32(a, v >>> 0); }
  out16(i, v) { const a = this.arg(i); if (a) this.mem.write16(a, v & 0xffff); }
  out64(i, v) { const a = this.arg(i); if (a) this.mem.write64(a, BigInt.asUintN(64, BigInt(v))); }

  /** Log helper (API trace). */
  log(...a) { this.vm.log('api', ...a); }
}

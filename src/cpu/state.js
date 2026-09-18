// Per-thread CPU state. Lives inside guest memory (emulator-private region) so that both the
// JS interpreter and JIT-generated WASM code access it through the same layout.
//
// Layout (byte offsets from the state base):
//   0x000  GPR[8]     EAX ECX EDX EBX ESP EBP ESI EDI  (x86 register numbering)
//   0x020  EIP
//   0x024  EFLAGS     materialized flags (interpreter); JIT keeps lazy flags in 0x028..0x03F
//   0x028  LZ_OP      lazy flag op kind (JIT)
//   0x02C  LZ_RES     lazy result
//   0x030  LZ_SRC1    lazy operand 1
//   0x034  LZ_SRC2    lazy operand 2
//   0x038  LZ_AUX     lazy aux (carry-in etc.)
//   0x040  SEG[6]     ES CS SS DS FS GS (u16 each)
//   0x050  FS_BASE    linear base of FS (TEB)
//   0x054  GS_BASE
//   0x058  EXIT       exit reason code written by JIT'd code before returning to the dispatcher
//   0x05C  EXIT_ARG   e.g. thunk index for API calls, or faulting address
//   0x060  FPU_CW     u16 control word
//   0x062  FPU_SW     u16 status word (C0..C3, exceptions; TOP kept separately)
//   0x064  FPU_TW     u16 tag word (abridged: bit i set = register i non-empty)
//   0x066  FPU_TOP    u8 top of stack (0..7)
//   0x080  FPR[8]     f64 physical x87 registers R0..R7 (ST(i) = R[(TOP+i)&7])
//   0x0C0  MXCSR
//   0x100  XMM[8]     16 bytes each
//   0x180  MM[8]      8 bytes each (kept separately from FPR, see D005)
//   0x1C0  ICOUNT     u32 instructions executed (low), 0x1C4 high (interpreter statistics)
//   0x400  end
import { PRIVATE_BASE } from './memory.js';

export const ST = Object.freeze({
  GPR: 0x000,
  EIP: 0x020,
  EFLAGS: 0x024,
  LZ_OP: 0x028,
  LZ_RES: 0x02c,
  LZ_SRC1: 0x030,
  LZ_SRC2: 0x034,
  LZ_AUX: 0x038,
  SEG: 0x040,
  FS_BASE: 0x050,
  GS_BASE: 0x054,
  EXIT: 0x058,
  EXIT_ARG: 0x05c,
  FPU_CW: 0x060,
  FPU_SW: 0x062,
  FPU_TW: 0x064,
  FPU_TOP: 0x066,
  FPR: 0x080,
  MXCSR: 0x0c0,
  XMM: 0x100,
  MM: 0x180,
  ICOUNT: 0x1c0,
  SIZE: 0x400,
});

// Register numbers (x86 encoding order).
export const R = Object.freeze({ EAX: 0, ECX: 1, EDX: 2, EBX: 3, ESP: 4, EBP: 5, ESI: 6, EDI: 7 });
export const REG_NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
export const REG16_NAMES = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
export const REG8_NAMES = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
export const SEG_NAMES = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];
export const SEG = Object.freeze({ ES: 0, CS: 1, SS: 2, DS: 3, FS: 4, GS: 5 });

// EFLAGS bits.
export const F = Object.freeze({
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  IF: 1 << 9,
  DF: 1 << 10,
  OF: 1 << 11,
  // Bit 1 is always 1 in EFLAGS.
  RESERVED1: 1 << 1,
});
export const FLAGS_ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;

// Exit reasons (ST.EXIT) returned by JIT'd code / interpreter run loops.
export const EXIT = Object.freeze({
  NONE: 0,
  THUNK: 1, // guest jumped into the import thunk region; EXIT_ARG = thunk index
  HALT: 2, // guest reached a trampoline / terminal address
  TIMESLICE: 3, // preemption budget exhausted
  FAULT: 4, // invalid opcode, unmapped access, etc.; EXIT_ARG = detail
  BREAK: 5, // int3 / debugger break
  SMC: 6, // self-modifying code detected, block cache must be invalidated
});

// Thread state slots are carved out of the private region.
export const THREAD_STATES_BASE = PRIVATE_BASE + 0x10000;
export const MAX_THREADS = 256;

/**
 * Thin accessor over a thread state block living in guest memory.
 */
export class CpuState {
  /**
   * @param {import('./memory.js').GuestMemory} mem
   * @param {number} base byte offset of the state block
   */
  constructor(mem, base) {
    this.mem = mem;
    this.base = base >>> 0;
    this.reset();
  }

  reset() {
    this.mem.fill(this.base, ST.SIZE, 0);
    this.eflags = F.RESERVED1 | F.IF;
    this.mem.write16(this.base + ST.FPU_CW, 0x027f); // MSVC default: double precision, round nearest
    this.mem.write32(this.base + ST.MXCSR, 0x1f80);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.CS, 0x1b);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.DS, 0x23);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.ES, 0x23);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.SS, 0x23);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.FS, 0x3b);
    this.mem.write16(this.base + ST.SEG + 2 * SEG.GS, 0x00);
  }

  // General purpose registers.
  /** @param {number} i */ reg(i) { return this.mem.u32[(this.base + ST.GPR) / 4 + i]; }
  /** @param {number} i @param {number} v */ setReg(i, v) { this.mem.u32[(this.base + ST.GPR) / 4 + i] = v >>> 0; }

  get eax() { return this.reg(0); } set eax(v) { this.setReg(0, v); }
  get ecx() { return this.reg(1); } set ecx(v) { this.setReg(1, v); }
  get edx() { return this.reg(2); } set edx(v) { this.setReg(2, v); }
  get ebx() { return this.reg(3); } set ebx(v) { this.setReg(3, v); }
  get esp() { return this.reg(4); } set esp(v) { this.setReg(4, v); }
  get ebp() { return this.reg(5); } set ebp(v) { this.setReg(5, v); }
  get esi() { return this.reg(6); } set esi(v) { this.setReg(6, v); }
  get edi() { return this.reg(7); } set edi(v) { this.setReg(7, v); }

  get eip() { return this.mem.u32[(this.base + ST.EIP) / 4]; }
  set eip(v) { this.mem.u32[(this.base + ST.EIP) / 4] = v >>> 0; }
  get eflags() { return this.mem.u32[(this.base + ST.EFLAGS) / 4]; }
  set eflags(v) { this.mem.u32[(this.base + ST.EFLAGS) / 4] = v >>> 0; }

  get fsBase() { return this.mem.u32[(this.base + ST.FS_BASE) / 4]; }
  set fsBase(v) { this.mem.u32[(this.base + ST.FS_BASE) / 4] = v >>> 0; }
  get gsBase() { return this.mem.u32[(this.base + ST.GS_BASE) / 4]; }
  set gsBase(v) { this.mem.u32[(this.base + ST.GS_BASE) / 4] = v >>> 0; }

  get exit() { return this.mem.u32[(this.base + ST.EXIT) / 4]; }
  set exit(v) { this.mem.u32[(this.base + ST.EXIT) / 4] = v >>> 0; }
  get exitArg() { return this.mem.u32[(this.base + ST.EXIT_ARG) / 4]; }
  set exitArg(v) { this.mem.u32[(this.base + ST.EXIT_ARG) / 4] = v >>> 0; }

  // x87
  get fpuCw() { return this.mem.read16(this.base + ST.FPU_CW); }
  set fpuCw(v) { this.mem.write16(this.base + ST.FPU_CW, v); }
  get fpuSw() { return this.mem.read16(this.base + ST.FPU_SW); }
  set fpuSw(v) { this.mem.write16(this.base + ST.FPU_SW, v); }
  get fpuTw() { return this.mem.read16(this.base + ST.FPU_TW); }
  set fpuTw(v) { this.mem.write16(this.base + ST.FPU_TW, v); }
  get fpuTop() { return this.mem.read8(this.base + ST.FPU_TOP); }
  set fpuTop(v) { this.mem.write8(this.base + ST.FPU_TOP, v & 7); }
  /** physical register i */
  fpr(i) { return this.mem.f64[(this.base + ST.FPR) / 8 + (i & 7)]; }
  setFpr(i, v) { this.mem.f64[(this.base + ST.FPR) / 8 + (i & 7)] = v; }
  /** ST(i) */
  st(i) { return this.fpr(this.fpuTop + i); }
  setSt(i, v) { this.setFpr(this.fpuTop + i, v); }

  get mxcsr() { return this.mem.u32[(this.base + ST.MXCSR) / 4]; }
  set mxcsr(v) { this.mem.u32[(this.base + ST.MXCSR) / 4] = v >>> 0; }

  /** byte address of XMM register i */
  xmmAddr(i) { return this.base + ST.XMM + 16 * (i & 7); }
  /** byte address of MM register i */
  mmAddr(i) { return this.base + ST.MM + 8 * (i & 7); }

  // Stack helpers.
  /** @param {number} v */
  push32(v) {
    const sp = (this.esp - 4) >>> 0;
    this.esp = sp;
    this.mem.write32(sp, v);
  }
  pop32() {
    const sp = this.esp;
    const v = this.mem.read32(sp);
    this.esp = (sp + 4) >>> 0;
    return v;
  }

  /** Human-readable dump for traces. */
  dump() {
    const h = (v) => v.toString(16).padStart(8, '0');
    const f = this.eflags;
    const fl = ['CF', 'PF', 'AF', 'ZF', 'SF', 'DF', 'OF']
      .filter((n) => f & F[n])
      .join(' ');
    return (
      `eax=${h(this.eax)} ecx=${h(this.ecx)} edx=${h(this.edx)} ebx=${h(this.ebx)}\n` +
      `esp=${h(this.esp)} ebp=${h(this.ebp)} esi=${h(this.esi)} edi=${h(this.edi)}\n` +
      `eip=${h(this.eip)} eflags=${h(f)} [${fl}] fs=${h(this.fsBase)}`
    );
  }
}

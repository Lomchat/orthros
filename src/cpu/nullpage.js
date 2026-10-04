// The null page: Windows never maps the first 64 KiB of a process's address space, so a read or a write there (a
// field of a null pointer, a call through a null vtable entry) raises EXCEPTION_ACCESS_VIOLATION at the instruction,
// with ExceptionInformation = [0 read / 1 write, address], which the program's SEH may handle. Orthros' guest memory
// is one flat WebAssembly memory where those bytes exist: without a check they read zeros and accept writes (a
// corrupted heap then fails much later, far from the cause). The same holds from the end of the user address space
// (USER_END) up: a small negative offset from a null pointer.
//
// Both executors check the memory operands of an instruction before executing it (nothing of the instruction done,
// EIP at it), with the same rule, so that they stay in agreement:
//  - every explicit memory operand that is accessed (LEA, the hint NOPs and PREFETCH access nothing), in the order the
//    processor accesses them (sources before the destination);
//  - except stack accesses addressed by ESP alone (PUSH/POP/CALL/RET are implicit anyway) and FS/GS-relative ones
//    (the TEB): their bases are never in the null page;
//  - string instructions with a REP prefix and a zero count access nothing;
//  - the bit-string forms of BT/BTS/BTR/BTC (memory, register offset) and XLAT compute their address themselves:
//    their handlers check it.
// The JIT (translate.js, Emitter.nullCheck) tests the start address of each operand and leaves the region before the
// instruction when it is in the null page; the interpreter (Interp.checkNull) then executes it and raises the fault.
// A string instruction walking down into the null page from above is only checked at each element by the interpreter.
//
// ?dbg=ORTHROS_NULL_PAGE_OPEN=1 restores the old behaviour (the null page readable and writable), for A/B.
import { OP, OT } from './decoder.js';
import { SEG } from './state.js';

export const NULL_PAGE_END = 0x10000;
/**
 * End of the user address space (the 64 KiB at 0x7fff0000 are never mapped either; above 2 GiB is the kernel's): an
 * operand there — a negative offset from a null pointer, [ecx-4] — faults the same way. (Beyond the guest memory the
 * WebAssembly access would trap, which the JIT cannot resume from: the check makes it precise.)
 */
export const USER_END = 0x7fff0000;
/** Whether the u32 address `a` is outside [NULL_PAGE_END, USER_END) */
export const unmapped = (a) => a < NULL_PAGE_END || a >= USER_END;

/** @typedef {{ o: any, write: boolean, str: boolean }} NullCheck */

const NONE = Object.freeze([]);
// (INS/OUTS: privileged, a #GP before any access)
const NO_ACCESS = new Set([OP.LEA, OP.NOP, OP.PREFETCH, OP.INS, OP.OUTS]);
// instructions that only write their destination memory operand (ops[0]): the fault is reported as a write
const WRITE_ONLY = new Set([OP.MOV, OP.MOVS, OP.STOS, OP.SETCC, OP.POP, OP.FST, OP.FSTP, OP.FIST, OP.FISTP,
  OP.FISTTP, OP.FBSTP, OP.FNSTCW, OP.FNSTSW, OP.FNSTENV, OP.FNSAVE, OP.FXSAVE, OP.STMXCSR, OP.MOVD, OP.MOVQ, OP.MOVUPS,
  OP.MOVUPD, OP.MOVSS, OP.MOVSD, OP.MOVLPS, OP.MOVLPD, OP.MOVHPS, OP.MOVHPD, OP.MOVAPS, OP.MOVAPD, OP.MOVNTPS,
  OP.MOVNTPD, OP.MOVNTI, OP.MOVNTQ, OP.MOVNTDQ, OP.MOVDQA, OP.MOVDQU]);
const BIT_OPS = new Set([OP.BT, OP.BTS, OP.BTR, OP.BTC]);

/** A memory operand whose address is never in the null page: ESP alone (the stack), FS/GS-relative (the TEB). */
export function neverNull(o) {
  if (o.seg === SEG.FS || o.seg === SEG.GS) return true;
  if (o.base === 4 && o.index < 0 && !o.a16 && !o.str) return true;
  if (o.base < 0 && o.index < 0 && !o.a16) return !unmapped(o.disp >>> 0); // (an absolute address)
  return false;
}

/**
 * The memory operands of `insn` to check against the null page before executing it, reads first (cached on the
 * instruction: decoded instructions are immutable).
 * @param {import('./decoder.js').Insn} insn
 * @returns {readonly NullCheck[]}
 */
export function nullChecks(insn) {
  let r = insn.nchk;
  if (r) return r;
  r = NONE;
  const op = insn.op;
  if (!NO_ACCESS.has(op) && !(BIT_OPS.has(op) && insn.ops[1] && insn.ops[1].t !== OT.IMM)) {
    const reads = [], writes = [];
    insn.ops.forEach((o, i) => {
      if (o.t !== OT.MEM || neverNull(o)) return;
      const write = i === 0 && WRITE_ONLY.has(op);
      (write ? writes : reads).push({ o, write, str: !!o.str });
    });
    if (reads.length || writes.length) r = Object.freeze([...reads, ...writes]);
  }
  insn.nchk = r;
  return r;
}

// x86-32 -> WebAssembly region translator.
//
// A region is a set of basic blocks reachable from an entry point through direct branches (within
// a budget). It becomes one WASM function `(block, state, eax..edi, eflags, lzop, lzres, lza, lzb,
// fs) -> nextEip|0` whose body is a dispatch loop over the blocks: guest registers live in locals
// for the whole region (the parameters *are* those locals), flags are kept lazily (op kind +
// operands). A direct jump whose target is already translated tail-calls the target region with
// the live locals (region chaining; the dispatcher is bypassed); every other exit (untranslated
// target, API thunk, fault, timeslice, stopAt) writes the state back to the thread state block and
// returns to the dispatcher. Instructions without a native translation are executed by the
// reference interpreter through the `fallback` import (registers flushed around the call).
// Regions containing x87/MMX instructions ("x87 regions") also keep the x87 register stack,
// tag word and precision control in locals between entry and the exits (translate-x87.js).
import { Code, ModuleBuilder, T } from './wasm.js';
import { inlineDeps } from './code-cache.js';
import { decode, OP, OT } from '../decoder.js';
import { ST, EXIT, F, SEG } from '../state.js';
import { NULL_PAGE_END, USER_END, nullChecks, nullCheckApplies } from '../nullpage.js';
import { LZ, REGION_PARAMS, REGION_RESULTS, HASH_ENTRY, HASH_PROBES, MATH_KERNELS, EXIT_FPUMODE, EXIT_STEP, FAST_TABLE, PROC_CONSTS } from './runtime.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, SMC_MAP_BASE, SMC_CODE, SMC_WATCH, SMC_NULL, JIT_HASH_BASE, JIT_HASH_BITS, JIT_SCRATCH_BASE, JIT_ALT_BASE, JIT_ALT_SLOTS, MUTEX_HANDLES, MUTEX_HANDLE_END, BLOCK_COUNTS_BASE, BLOCK_COUNTS_SLOTS } from '../memory.js';

// Locals 0..15 are the function parameters (REGION_PARAMS), declared locals start at 16.
// the instruction budget travels as the last parameter (a chained transition would otherwise store it for the next
// region to load it back: a store-to-load dependency on every transition); the FS base, constant for a thread, is loaded
// by the prologue into a declared local
const L_BLK = 0, L_STATE = 1, L_REG = 2, L_EFLAGS = 10, L_LZOP = 11, L_LZRES = 12, L_LZA = 13, L_LZB = 14, L_ICOUNT = 15;
const L_TA = 16, L_TV = 17, L_T2 = 18, L_T3 = 19, L_T4 = 20, L_T5 = 21, L_T6 = 22, L_T7 = 23;
const L_I64A = 24, L_I64B = 25, L_F64A = 26, L_F64B = 27, L_TOP = 28;
// the x87 stack shift pending at a region exit (Emitter.x87ExitState): set just before the branch to an exit block, which
// stores TOP = (L_TOP + L_XSH) & 7; 0 on every other path (a declared local starts at 0, and a path setting it leaves)
const L_XSH = 29;
const L_V0 = 30, L_V1 = 31, L_V2 = 32; // v128 temporaries (SSE/MMX translation)
// x87 register stack cached in locals (x87 regions only, see Emitter.usesX87): L_ST0+i holds
// ST(i) (logical order, physical slot (L_TOP+i)&7), L_FTW the abridged tag word in the same
// logical order (bit i = ST(i) non-empty; ST.FPU_TW keeps the physical order, bit s = slot s),
// L_FPC the control word's PC/RC bits (cw & 0xf00).
const L_ST0 = 33, L_FTW = 41, L_FPC = 42;
const L_F64C = 43; // f64 temporary (x87 results kept apart from their operands)
// the instruction budget (ST.ICOUNT, parameter L_ICOUNT) is decremented in a register at every block transition and
// written back to the state block only when the region returns to the dispatcher; L_FS: the FS base (the TEB)
const L_FS = 44;
// 24-bit precision x87 blocks keep register values that are exact floats in f32 locals (L_S32+k shadows
// L_ST0+k, see Emitter.f32Mask) and compute with f32 arithmetic; L_F32A..C are f32 temporaries
const L_S32 = 45, L_F32A = 53, L_F32B = 54, L_F32C = 55;
// XMM registers the region names, cached in v128 locals (L_XMM0+r) from entry to the exits (Emitter.xmmMask)
const L_XMM0 = 56;
// f64 temporaries of the exact-rounding helpers (the error of an f64 sum or product: see translate-x87.js roundF32)
const L_F64D = 64, L_F64E = 65, L_F64G = 66, L_F64H = 67;
// f32 shadows of lane 0 of the XMM registers (L_XS0+r), for scalar single-precision code (Emitter.xsValid)
const L_XS0 = 68;
// f64 shadows of the low qword of the XMM registers (L_XD0+r), for scalar double-precision code (Emitter.xdValid)
const L_XD0 = 76;
// if-conversion (Emitter.emitIfcvt): L_IC the branch condition, L_IFS0+k the value of the k-th local the arms write
// before them, L_IFR0+k its value after the taken arm (IFCVT_SLOTS: the registers and the lazy flag state)
const L_IC = 84, IFCVT_SLOTS = 13, L_IFS0 = 85, L_IFR0 = L_IFS0 + IFCVT_SLOTS;
// null page (Emitter.nullCheck): L_SPECF set when a load of an if-converted arm on the path taken is in the null page,
// L_NCK the address of that load
const L_SPECF = L_IFR0 + IFCVT_SLOTS, L_NCK = L_SPECF + 1;
// the x87 status word (x87 regions: loaded with the stack cache, written back with it), so that the compares, FNSTSW and
// the condition codes' updates chain through a register instead of a store and a load of the state block each
const L_SW = L_NCK + 1;
// the mask clearing an f64's 29 low significand bits in both lanes (x87 regions translated for a static truncating 24-bit
// mode: translate-x87.js pushCut24), set once by the prologue
const L_CUT24 = L_SW + 1;
const CUT24_BYTES = new Uint8Array(new BigUint64Array([0xffffffffe0000000n, 0xffffffffe0000000n]).buffer);
const L_FIRST_DECLARED = 16;
const LOCAL_TYPES = [...Array(8).fill(T.i32), T.i64, T.i64, T.f64, T.f64, T.i32, T.i32, T.v128, T.v128, T.v128, ...Array(8).fill(T.f64), T.i32, T.i32, T.f64, T.i32, ...Array(8).fill(T.f32), T.f32, T.f32, T.f32, ...Array(8).fill(T.v128), T.f64, T.f64, T.f64, T.f64, ...Array(8).fill(T.f32), ...Array(8).fill(T.f64),
  T.i32, ...Array(2 * IFCVT_SLOTS).fill(T.i32), T.i32, T.i32, T.i32, T.v128]; // indices 16..114
if (LOCAL_TYPES.length !== L_CUT24 + 1 - L_FIRST_DECLARED || L_IC !== L_XD0 + 8 || REGION_PARAMS.length !== L_FIRST_DECLARED) throw new Error('region local layout mismatch');
/**
 * Instructions whose handlers access their XMM operands only through the lane-0 shadow helpers of
 * translate-sse-common.js (scalarF32 / xmmStoreF32 / xmmShadowStore...), filled by translate-sse-float.js: the scalar
 * single-precision family. Any other instruction naming an XMM register first writes that register's pending
 * shadow back to its v128 local (Emitter.xmmShadowRelease).
 */
const XMM_SHADOW_OPS = new Set();
/**
 * The same for the f64 shadows (xmmShadowSync64): the scalar double-precision family and the low-qword moves, filled by
 * translate-sse-float.js / translate-sse-int.js. An instruction of both sets (the whole-register moves) handles both
 * kinds of shadow itself.
 */
const XMM_SHADOW64_OPS = new Set();
// Instructions whose handler (native or interpreter) reads or writes the x87 state: every x87
// mnemonic (the decoder names them F*: FLD..FBSTP, FNSTENV, FXSAVE/FXRSTOR, ...), EMMS, and any
// MMX-register operand (TOP = 0, tags = 0xff side effect). A region containing one is an "x87
// region" and caches the register stack in locals; other regions are translated as before.
const FPU_OPS = new Set(Object.keys(OP).filter((n) => n[0] === 'F').map((n) => OP[n]));
FPU_OPS.add(OP.EMMS);
function touchesFpu(insn) {
  if (FPU_OPS.has(insn.op)) return true;
  for (const o of insn.ops) if (o.t === OT.MM) return true;
  return false;
}
// Type index of the region signature inside a region module (declared first by buildRegionModule)
const REGION_TYPE = 0;
// Imports (function indices, positional: the order of the importFunc calls in buildRegionModule)
const IMP_FLAGS = 0, IMP_ROUND24 = 1, IMP_FALLBACK = 2;
// transcendental kernels of the runtime module (MATH_KERNELS order): 3 exp2m1, 4 log2, 5 log2p1,
// 6 scalb, 7 sin, 8 cos, 9 tan, 10 atan2, 11 sincos, 12 nan2
const IMP_MATH = 3;
const IMP_EXP2M1 = IMP_MATH, IMP_LOG2 = IMP_MATH + 1, IMP_LOG2P1 = IMP_MATH + 2, IMP_SCALB = IMP_MATH + 3;
const IMP_SIN = IMP_MATH + 4, IMP_COS = IMP_MATH + 5, IMP_TAN = IMP_MATH + 6, IMP_ATAN2 = IMP_MATH + 7, IMP_SINCOS = IMP_MATH + 8, IMP_NAN2 = IMP_MATH + 9;
const IMP_ARITH24 = IMP_MATH + 10, IMP_F32RC = IMP_MATH + 11;
// the x87 arithmetic's cold paths (fpmath-x87cold.js)
const IMP_X87_ARITHF32 = IMP_MATH + 12, IMP_X87_ROUNDF32 = IMP_MATH + 13, IMP_X87_NANARITH = IMP_MATH + 14;
// the runtime's shared region exit (runtime.js chain, opts.chainStub), after the kernels
const IMP_CHAIN = IMP_MATH + 15;

if (MATH_KERNELS.length !== 15 || MATH_KERNELS[0][0] !== 'exp2m1' || MATH_KERNELS[7][0] !== 'atan2' || MATH_KERNELS[8][0] !== 'sincos' || MATH_KERNELS[9][0] !== 'nan2' || MATH_KERNELS[10][0] !== 'arith24' || MATH_KERNELS[11][0] !== 'f32rc'
  || MATH_KERNELS[12][0] !== 'x87ArithF32' || MATH_KERNELS[13][0] !== 'x87RoundF32' || MATH_KERNELS[14][0] !== 'x87NanArith') throw new Error('math kernel import layout mismatch');

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];
const BITS = [0, 8, 16, 0, 32];
const SZLOG = [0, 0, 1, 0, 2];
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;

/**
 * Defaults of the translation options (opts.logicRes, binArith; opts.maxBlocks / opts.maxInsns, discoverRegion).
 * ORTHROS_JIT_DEFAULTS (JSON, Node only) overrides them, so that a whole test suite runs under either setting; the
 * harness's dbg:ORTHROS_JIT_AB=<json> switches them within a session (Jit.switchOpts).
 */
/**
 * x87 mode of a region (Jit translate / versions, opts.fpcAssume): the control word's PC/RC bits (cw & 0xf00), with
 * X87_MODE_TOP | TOP when the region is also specialized for the stack top at its entry (opts.x87Top) — the frame of
 * its x87 stack cache: loads, stores and tag rotations at its entry, exits and chains then address the registers at
 * constant offsets instead of computing (TOP + i) & 7 for each. A region entered with another top (the guard compares
 * TOP minus the entered block's planned shift) goes to the next version, as for the control word.
 */
export const X87_MODE_TOP = 8;
/** the x87 mode of a thread's state at a region entry (state block at `base`; `top`: specialize for the stack top too) */
export function x87ModeOf(mem, base, top) {
  const fpc = mem.read16(base + ST.FPU_CW) & 0xf00;
  return top ? fpc | X87_MODE_TOP | (mem.read8(base + ST.FPU_TOP) & 7) : fpc;
}

export const JIT_DEFAULTS = { nullPage: 'writes', logicRes: true, maxBlocks: 96, maxInsns: 800, ifcvt: false, layout: true, coldExits: true, coldMin: 64, visit: false, x87Top: false, chainStub: false, dispatchBlock: false, bgCompile: true, swLocal: true, x87Cold: 'call', x87ExitRotate: false, exitShare: true, x87VecMask: true, x87Live: true, x87LiveStores: true, imulDead: true, ...JSON.parse(globalThis.process?.env?.ORTHROS_JIT_DEFAULTS ?? '{}') };

export const MAX_BLOCKS = 96;
/** at most this many call-return sites compared inline at one RET (the first ones in address order; a return to another
 * leaves the region), and in all the RETs of a region (see regionRetSites) */
const MAX_RET_SITES = 16, MAX_RET_COMPARES = 128;
export const MAX_INSNS = 800;

/** Terminator classes */
const TERM_NONE = 0, TERM_JMP = 1, TERM_JCC = 2, TERM_CALL = 3, TERM_RET = 4, TERM_INDIRECT = 5, TERM_EXIT = 6, TERM_LOOP = 7;

function termOfInsn(insn) {
  switch (insn.op) {
    case OP.JMP: return insn.ops[0].t === OT.REL ? TERM_JMP : TERM_INDIRECT;
    case OP.JCC: return TERM_JCC;
    case OP.CALL: return insn.ops[0].t === OT.REL ? TERM_CALL : TERM_INDIRECT;
    case OP.RET: return TERM_RET;
    case OP.LOOP: case OP.LOOPE: case OP.LOOPNE: case OP.JECXZ: return TERM_LOOP;
    case OP.HLT: case OP.INT3: case OP.INT: case OP.INTO: case OP.UD2: case OP.INVALID: case OP.IRET: case OP.RETF: case OP.JMPF: case OP.CALLF: return TERM_EXIT;
    default: return TERM_NONE;
  }
}

/**
 * Fast APIs a region runs inline at a `call dword ptr [slot]` (an import slot or a function-pointer variable at an
 * absolute address) holding their thunk when the region is translated — the dispatcher's fastApi semantics
 * (runtime.js), without leaving the region: the C runtime's per-thread data accessor alone calls GetLastError,
 * TlsGetValue and SetLastError millions of times per second while the game loads. The call checks the slot and the
 * thread's RESUMING flag at run time and takes the ordinary call otherwise (see HANDLERS[OP.CALL]).
 */
const INLINE_FIDS = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18]);
/** { slot, thunk, fid } for such a call (the slot's current value is an inlinable fast API's thunk), else null */
function inlineApiOf(mem, insn) {
  if ((insn.op !== OP.CALL && insn.op !== OP.JMP) || insn.opsize !== 4) return null; // (JMP: an import stub, `jmp [slot]`)
  const o = insn.ops[0];
  if (o.t !== OT.MEM || o.base >= 0 || o.index >= 0 || o.seg === SEG.FS || o.seg === SEG.GS || insn.adsize === 2) return null;
  const slot = o.disp >>> 0, thunk = mem.read32(slot) >>> 0;
  if (thunk < THUNK_BASE || thunk >= THUNK_END || (thunk - THUNK_BASE) % THUNK_SIZE) return null;
  const fid = mem.u8[FAST_TABLE + (thunk - THUNK_BASE) / THUNK_SIZE];
  return INLINE_FIDS.has(fid) ? { slot, thunk, fid } : null;
}

// Lazy kinds whose CF / OF Emitter.pushCond computes inline (the same formulas as the flags helper); ZF, SF and PF
// come from the result for every kind. All of them now: with SHL's (the last bit shifted out, pushShlCarry) the run-time
// dispatch of a block reading flags it did not set (pushCondDynamic) has no flags helper call left.
const CF_INLINE = new Set([LZ.ADD, LZ.SUB, LZ.LOGIC, LZ.INC, LZ.DEC, LZ.NEG, LZ.ADC, LZ.SBB, LZ.SHL, LZ.SHR, LZ.SAR, LZ.MUL, LZ.IMUL, LZ.SHLD, LZ.BSF]);
const OF_INLINE = CF_INLINE;
/** highest lazy kind (LZ.SBB) */
const LZ_KINDS_MAX = Math.max(...Object.values(LZ));
/** Whether Emitter.pushCond computes condition `base` (cc >> 1) inline for lazy kind `kind` (no flags helper). */
function lazyCondInline(base, kind) {
  switch (base) {
    case 2: case 4: case 5: return true; // E, S, P: from the result
    case 1: case 3: return CF_INLINE.has(kind); // B, BE
    default: return OF_INLINE.has(kind); // O, L, LE
  }
}

// ---- arithmetic flags liveness within a block (FL_CF: CF, FL_REST: OF SF ZF AF PF). Instructions that write
// part of the flags (ROL/ROR, BT*, INC/DEC, CLC/STC) compute and preserve only what a later instruction of the
// block may still read; at the block end every flag is live (successors, exits). Unknown instructions read all.
const FL_CF = 1, FL_REST = 2, FL_ALL = 3;
const FLAGS_NONE = new Set(['MOV', 'MOVZX', 'MOVSX', 'LEA', 'XCHG', 'BSWAP', 'NOT', 'PUSH', 'POP', 'PUSHA', 'POPA', 'ENTER', 'LEAVE', 'CBW', 'CWD',
  'NOP', 'PAUSE', 'CLD', 'STD', 'MOVS', 'STOS', 'LODS', 'XLAT', 'LFENCE', 'MFENCE', 'SFENCE', 'PREFETCH', 'CLFLUSH', 'WAIT', 'EMMS',
  'JMP'].map((n) => OP[n])); // (a jump neither reads nor writes them: what its targets read, see regionFlagsLiveness)
for (const [n, op] of Object.entries(OP)) {
  if (n.startsWith('F') && !['FCOMI', 'FCOMIP', 'FUCOMI', 'FUCOMIP', 'FCMOVCC'].includes(n)) FLAGS_NONE.add(op); // x87, FXSAVE/FXRSTOR
  else if (op > OP.EMMS && op < OP.INVALID && !['UCOMISS', 'UCOMISD', 'COMISS', 'COMISD'].includes(n)) FLAGS_NONE.add(op); // MMX / SSE data
}
const FLAGS_FULL = new Set(['ADD', 'SUB', 'CMP', 'AND', 'OR', 'XOR', 'TEST', 'NEG', 'MUL', 'IMUL', 'BSF', 'BSR', 'CMPXCHG', 'XADD', 'POPF',
  'FCOMI', 'FCOMIP', 'FUCOMI', 'FUCOMIP', 'UCOMISS', 'UCOMISD', 'COMISS', 'COMISD'].map((n) => OP[n]));
/** flags read by condition code cc */
const ccFlags = (cc) => { const b = cc >> 1; return b === 1 ? FL_CF : b === 3 ? FL_ALL : FL_REST; };
/** flags live before `insn` given those live after it */
function flagsLiveBefore(insn, after) {
  const op = insn.op;
  if (FLAGS_NONE.has(op)) return after;
  if (FLAGS_FULL.has(op)) return 0;
  switch (op) {
    case OP.ADC: case OP.SBB: return FL_CF; // read CF, write all
    case OP.SHL: case OP.SHR: case OP.SAR: return shiftCountConst(insn) > 0 ? 0 : FL_ALL; // a CL count of 0 keeps them
    case OP.INC: case OP.DEC: return after & FL_CF; // CF preserved
    case OP.ROL: case OP.ROR: return shiftCountConst(insn) > 0 ? after & FL_REST : after; // CF (and OF) written
    case OP.BT: case OP.BTS: case OP.BTR: case OP.BTC: case OP.CLC: case OP.STC: case OP.SAHF: return after & FL_REST; // CF written
    case OP.CMC: case OP.RCL: case OP.RCR: return (after & FL_REST) | FL_CF;
    case OP.JCC: case OP.SETCC: case OP.CMOVCC: case OP.FCMOVCC: return after | ccFlags(insn.cc);
    default: return FL_ALL;
  }
}
/**
 * The instruction after the one being emitted, in its block, writes every arithmetic flag without reading any (CMP, TEST,
 * ADD, a shift by a constant...): the flags this one leaves are never observed — no exit of any kind lies between them
 * (the time-slice and SMC exits of a block are at its end and after stores, the next instruction's own exits after it
 * has written the flags or before it, where they are still dead) — unlike flagsLive(), which also holds across the stores
 * of later instructions, whose SMC exit might find code rewritten to read them.
 */
function nextOverwritesFlags(E, b) {
  const next = b?.insns[E.insnIdx];
  return !!next && flagsLiveBefore(next, FL_ALL) === 0;
}
/**
 * Flags live at the end of each block of a region (b.flagsOut), from the blocks it jumps to inside the region: the
 * union of what they read before writing it (backward dataflow to the least fixpoint). A successor outside the region
 * or unknown (indirect jumps, returns, calls — the callee or the code after its return may read them — exits) reads
 * them all. A block whose every successor overwrites the flags first (a JCC after an INC in the next block's CMP...)
 * no longer computes what its instructions would preserve (INC/DEC keeping CF: a flags helper call).
 * The flags at such a block end are then those a later instruction overwrites before any read: only an exception
 * raised in between (its CONTEXT) could see the difference, as within a block already.
 */
function regionFlagsLiveness(blocks, byEip) {
  const succ = blocks.map((b) => {
    const last = b.insns[b.insns.length - 1];
    switch (b.term) {
      case TERM_NONE: return [b.fallthrough];
      case TERM_JCC: case TERM_LOOP: return [last.ops[0].v, b.fallthrough];
      case TERM_JMP: return last.ops[0].t === OT.REL ? [last.ops[0].v] : null;
      default: return null; // call, return, indirect jump, exit
    }
  }).map((list) => list && list.map((a) => byEip.get(a) ?? null));
  const liveIn = new Uint8Array(blocks.length);
  const liveInOf = (b) => { let l = b.flagsOut; for (let i = b.insns.length - 1; i >= 0; i--) l = flagsLiveBefore(b.insns[i], l); return l; };
  for (const b of blocks) b.flagsOut = 0;
  for (let changed = true, rounds = 0; changed && rounds < 64; rounds++) {
    changed = false;
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k], sl = succ[k];
      let out = 0;
      if (!sl) out = FL_ALL; else for (const t of sl) out |= t ? liveIn[t.index] : FL_ALL;
      b.flagsOut = out;
      const li = liveInOf(b);
      if (li !== liveIn[k]) { liveIn[k] = li; changed = true; }
    }
  }
  for (const b of blocks) b.flagsIn = liveIn[b.index]; // (flags read at the block's entry: its budget exits, see deadFlagsExit)
}

// ---- lazy flag state predicted at block entries. A block testing flags it did not set (a JCC right after the previous
// block's JCC, a DEC/INC keeping the CF of an earlier block) dispatches on the run-time lazy op (pushCondDynamic).
// When every in-region predecessor leaves the same lazy op (kind and size, known from its instructions), that op is
// the likely one: the dispatch first tests L_LZOP against it and evaluates the condition inline for it (a compare
// and a predictable branch instead of an indirect jump). A prediction only: other entries (dispatcher, chains,
// returns) and mispredictions take the full dispatch, so it never changes what is computed.
const LZ_OF_OP = new Map([[OP.ADD, LZ.ADD], [OP.SUB, LZ.SUB], [OP.CMP, LZ.SUB], [OP.AND, LZ.LOGIC], [OP.OR, LZ.LOGIC],
  [OP.XOR, LZ.LOGIC], [OP.TEST, LZ.LOGIC], [OP.INC, LZ.INC], [OP.DEC, LZ.DEC], [OP.NEG, LZ.NEG], [OP.ADC, LZ.ADC],
  [OP.SBB, LZ.SBB], [OP.SHL, LZ.SHL], [OP.SHR, LZ.SHR], [OP.SAR, LZ.SAR]]);
/** Instructions leaving the lazy flag state as it is (they neither write nor materialize the flags). */
const LZ_KEEP = new Set([...FLAGS_NONE, OP.JCC, OP.SETCC, OP.CMOVCC]);
/**
 * Lazy op (kind << 2 | size) after `insn` given the one before it (-1: unknown): the op its handler sets (a
 * shift by a constant count; by CL: unknown, the count may be 0), the same for LZ_KEEP, unknown for the others.
 */
function lzOpAfter(insn, before) {
  if (LZ_KEEP.has(insn.op)) return before;
  const kind = LZ_OF_OP.get(insn.op);
  if (kind === undefined) return -1;
  if (kind === LZ.SHL || kind === LZ.SHR || kind === LZ.SAR) { const n = shiftCountConst(insn); if (n === 0) return before; if (n < 0) return -1; }
  return (kind << 2) | SZLOG[insn.ops[0].size];
}
/**
 * b.lzPred for every block: the lazy op every in-region predecessor leaves (forward dataflow to a fixpoint), or
 * -1 (unknown: no in-region predecessor, predecessors disagreeing, a return site, the region entry).
 */
function regionLazyPrediction(blocks, byEip) {
  const preds = blocks.map(() => []);
  for (const b of blocks) {
    const last = b.insns[b.insns.length - 1];
    let succ = [];
    switch (b.term) {
      case TERM_NONE: succ = [b.fallthrough]; break;
      case TERM_JCC: case TERM_LOOP: succ = [last.ops[0].v, b.fallthrough]; break;
      case TERM_JMP: if (last.ops[0].t === OT.REL) succ = [last.ops[0].v]; break;
      default: break;
    }
    for (const a of succ) { const t = byEip.get(a); if (t) preds[t.index].push(b); }
  }
  const UNSET = -2; // (not reached yet: the identity of the meet)
  const lzIn = new Int32Array(blocks.length).fill(UNSET), lzOut = new Int32Array(blocks.length).fill(UNSET);
  const outOf = (b, l) => { for (const insn of b.insns) l = lzOpAfter(insn, l); return l; }; // (UNSET kept up to a write)
  for (let changed = true, rounds = 0; changed && rounds < 64; rounds++) {
    changed = false;
    for (const b of blocks) {
      const k = b.index;
      let l = preds[k].length ? UNSET : -1; // (the region entry's own state is not predicted: entered once)
      for (const p of preds[k]) { const o = lzOut[p.index]; if (o === UNSET) continue; l = l === UNSET || l === o ? o : -1; }
      lzIn[k] = l;
      const o = outOf(b, l);
      if (o !== lzOut[k]) { lzOut[k] = o; changed = true; }
    }
  }
  for (const b of blocks) b.lzPred = lzIn[b.index] >= 0 ? lzIn[b.index] : -1;
}

/**
 * Return sites a RET of the region may go back to without leaving it: per block ending in a RET (or in an import
 * stub's inline-API JMP, which returns like one), the return sites of the in-region direct calls whose callee reaches
 * that block — following the callee's own control flow from its entry (fallthroughs, direct jumps and branches, a
 * call continuing at its return site, a JMP to another function: a tail call, whose RET returns to the same callers).
 * A RET compares the address it pops with these sites only: a region making many calls (the C runtime's call-heavy
 * functions with their small helpers inlined) no longer compares every RET with every call site — above
 * MAX_RET_SITES sites in the region they were all dropped, and every return of an inlined helper then left the region
 * and chained back into it — and the region entry's own RET, which returns outside, compares nothing (unless the
 * region calls callees outside it: see below). Only a
 * filter: a return to a site not listed (a callee reached otherwise, a modified return address) leaves the region as
 * before, and comparing more sites would give the same results.
 * @returns {Array<number[] | null>} per block index
 */
function regionRetSites(blocks, byEip) {
  const callers = new Map(); // callee entry block -> return sites of its calls
  const outside = []; // return sites of calls to callees outside the region
  for (const b of blocks) {
    if (b.term !== TERM_CALL || !byEip.has(b.fallthrough)) continue;
    const t = byEip.get(branchTarget(b.insns[b.insns.length - 1]));
    if (!t) { if (!outside.includes(b.fallthrough)) outside.push(b.fallthrough); continue; }
    let l = callers.get(t); if (!l) callers.set(t, l = []);
    if (!l.includes(b.fallthrough)) l.push(b.fallthrough);
  }
  const sites = blocks.map(() => null);
  const succ = (b) => {
    const last = b.insns[b.insns.length - 1];
    switch (b.term) {
      case TERM_NONE: case TERM_CALL: return [b.fallthrough];
      case TERM_JCC: case TERM_LOOP: return [last.ops[0].v, b.fallthrough];
      case TERM_JMP: return [last.ops[0].v];
      default: return [];
    }
  };
  const returns = (b) => b.term === TERM_RET || (b.term === TERM_INDIRECT && b.insns[b.insns.length - 1].inlineApi && b.insns[b.insns.length - 1].op === OP.JMP);
  for (const [entry, rs] of callers) {
    const seen = new Set([entry]), stack = [entry];
    while (stack.length) {
      const b = stack.pop();
      if (returns(b)) { const l = (sites[b.index] ??= []); for (const r of rs) if (!l.includes(r)) l.push(r); continue; }
      for (const a of succ(b)) { const t = byEip.get(a); if (t && !seen.has(t)) { seen.add(t); stack.push(t); } }
    }
  }
  // the RETs no in-region callee reaches (the region entry's function, a function the region was entered in the
  // middle of) may return to a call of a callee outside the region: a recursive function whose entry is another
  // region's (every level returns to the recursive call's site, in this region) — as the old region-wide list did
  if (outside.length) for (const b of blocks) if (returns(b) && !sites[b.index]) sites[b.index] = outside.slice();
  let budget = MAX_RET_COMPARES;
  for (let i = 0; i < sites.length; i++) {
    const l = sites[i]; if (!l) continue;
    l.sort((x, y) => x - y);
    if (l.length > MAX_RET_SITES) l.length = MAX_RET_SITES;
    if (l.length > budget) l.length = budget;
    budget -= l.length;
    if (!l.length) sites[i] = null;
  }
  return sites;
}

// ---- null-page checks of a block (Emitter.nullCheck). Accesses through the same base and index registers (and
// scale), unchanged between them, within 64 KiB of each other — the fields of one structure — share one check at the
// first of them, on the range of their displacements: [r+lo, r+hi] inside [NULL_PAGE_END, USER_END) means every one of
// them is. When it is not, the region is left before the first one; the interpreter executes it (faulting if it is itself outside), and
// the code after it is entered anew, its own accesses checked from there — so the fault is still raised at the first
// access that makes it, with the exact state.
/** Instructions writing general registers other than their register operands (or whose effects are not listed here). */
const NC_CLOBBER_ALL = new Set(['MUL', 'DIV', 'IDIV', 'IMUL', 'CMPXCHG', 'CMPXCHG8B', 'CBW', 'CWD', 'MOVS', 'CMPS', 'STOS',
  'LODS', 'SCAS', 'INS', 'OUTS', 'XLAT', 'PUSHA', 'POPA', 'ENTER', 'LEAVE', 'CPUID', 'RDTSC', 'RDPMC', 'RDMSR', 'LAHF', 'DAA',
  'DAS', 'AAA', 'AAS', 'AAM', 'AAD', 'SALC', 'IN', 'OUT', 'CALL', 'CALLF', 'JMP', 'JMPF', 'RET', 'RETF', 'LOOP', 'LOOPE',
  'LOOPNE', 'JECXZ', 'INT', 'INT3', 'INTO', 'IRET', 'SYSENTER', 'SYSEXIT', 'BOUND', 'INVALID', 'MOVCR', 'MOVDR', 'WRMSR',
  'MASKMOVQ', 'MASKMOVDQU'].map((n) => OP[n]));
const NC_SPAN = 0x10000;
/**
 * Plain stores — their memory operand written, nothing else changed — need no check before them: their self-modifying
 * code check after the store (Emitter.smcCheck) reads the page's SMC map byte, where the pages never mapped carry
 * SMC_NULL; its cold path then clears the bytes written (the null page stays zero, as nothing can have stored there) and
 * leaves the region before the instruction, for the interpreter to raise the fault. No cost on the hot path. Not exact
 * in two cases, as before these checks: a store to an address past 2 GiB ([null - 4], a register holding garbage) traps
 * in WebAssembly (an imprecise fault: the process ends), and a store straddling 0x10000 from below keeps its bytes from
 * 0x10000 on.
 */
const NC_STORE_SMC = new Set(['MOV', 'SETCC', 'MOVD', 'MOVQ', 'MOVUPS', 'MOVUPD', 'MOVSS', 'MOVSD', 'MOVLPS', 'MOVLPD', 'MOVHPS',
  'MOVHPD', 'MOVAPS', 'MOVAPD', 'MOVNTPS', 'MOVNTPD', 'MOVNTI', 'MOVNTQ', 'MOVNTDQ', 'MOVDQA', 'MOVDQU', 'STMXCSR', 'FNSTCW', 'FNSTSW',
  // (the x87 stores too: the pop of FSTP / FISTP / FISTTP, done before the check, is undone by Jit.run with the store)
  'FST', 'FSTP', 'FIST', 'FISTP', 'FISTTP'].map((n) => OP[n]));
/**
 * Read-modify-writes whose only other effect is the arithmetic flags, caught the same way when reads are not checked
 * (nullPage 'writes'): the region is left with the instruction's flags already in the lazy state, so the CONTEXT of the
 * access violation holds them instead of the flags before it (the address, the record and every register are exact).
 */
const NC_RMW_SMC = new Set(['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'NOT', 'NEG', 'INC', 'DEC', 'ROL', 'ROR', 'RCL',
  'RCR', 'SHL', 'SHR', 'SAR', 'SHLD', 'SHRD', 'BTS', 'BTR', 'BTC'].map((n) => OP[n]));
/**
 * The null-page checks of block `insns`: per instruction, null or a list of { k } (one operand: nullChecks entry) and
 * { g } (a group { key, o, lo, hi } of accesses through the same registers, checked as a range at its first access).
 */
function planNullChecks(insns, smc, mode) {
  const plan = new Array(insns.length).fill(null);
  /** @type {Map<number, { key: number, o: any, lo: number, hi: number }>} */
  const groups = new Map();
  for (let i = 0; i < insns.length; i++) {
    const insn = insns[i], nc = HANDLERS[insn.op] ? insn.nchk || nullChecks(insn) : []; // (no handler: the interpreter checks)
    for (const k of nc) {
      if (!nullCheckApplies(k, mode)) continue;
      // (checked by the store's SMC check, see NC_STORE_SMC)
      if (smc && k.writes && (k.write ? NC_STORE_SMC.has(insn.op) : mode === 'writes' && NC_RMW_SMC.has(insn.op)) && !k.o.a16) continue;
      const o = k.o;
      if (!k.str && !o.a16 && (o.base >= 0 || o.index >= 0)) {
        const key = (o.base + 1) + 9 * (o.index + 1) + 81 * o.scale, d = o.disp | 0, g = groups.get(key);
        if (g && Math.max(g.hi, d) - Math.min(g.lo, d) < NC_SPAN) { g.lo = Math.min(g.lo, d); g.hi = Math.max(g.hi, d); continue; }
        const ng = { key, o, lo: d, hi: d };
        groups.set(key, ng);
        (plan[i] ??= []).push({ g: ng });
      } else (plan[i] ??= []).push({ k });
    }
    if (!groups.size) continue;
    if (NC_CLOBBER_ALL.has(insn.op)) { groups.clear(); continue; }
    let w = 0;
    for (const o of insn.ops) if (o.t === OT.REG) w |= 1 << (o.size === 1 && o.r >= 4 ? o.r - 4 : o.r);
    if (insn.op === OP.PUSH || insn.op === OP.POP || insn.op === OP.PUSHF || insn.op === OP.POPF) w |= 1 << 4;
    if (w) for (const [key, g] of groups) if ((g.o.base >= 0 && (w >> g.o.base) & 1) || (g.o.index >= 0 && (w >> g.o.index) & 1)) groups.delete(key);
  }
  return plan;
}

// ---- if-conversion. A conditional branch over one or two short arms that meet again (a triangle `jcc M ; x ; M:`, its
// mirror, or a diamond `jcc T ; x ; jmp M ; T: y ; M:`) whose instructions only compute registers and flags — and read
// memory — is translated without the branch: both arms are computed and every local they write is selected on the
// condition (a cmov per register and lazy flag value), then the code goes on at M. A data-dependent branch (comparisons
// of the elements of an array being sorted or searched: about half of them mispredicted) then costs a few selects
// instead of a pipeline flush. The arm not taken must have no effect: no stores, no exits, no interpreter fallbacks;
// its loads read guest address 0 instead of theirs (Emitter.spec, loadMem) — an address of the arm not taken may be
// anything (a null pointer the branch tests, an address beyond the guest memory, which would trap).
// A predictable branch costs nothing when predicted, while both arms and the selects always cost: only comparisons of
// data inside loops are converted (ifcvtDataCond) — not loop counters, a loop-invariant local on the stack, nor tests of
// a value against a constant (opts.ifcvt 'all': every candidate, for tests).
/** Instructions an if-converted arm may hold (their handlers write registers and the flag locals only, without exits). */
const IFCVT_OPS = new Set(['MOV', 'MOVZX', 'MOVSX', 'LEA', 'ADD', 'SUB', 'ADC', 'SBB', 'AND', 'OR', 'XOR', 'CMP', 'TEST', 'INC', 'DEC',
  'NEG', 'NOT', 'SHL', 'SHR', 'SAR', 'SETCC', 'CMOVCC', 'XCHG', 'CBW', 'CWD', 'BSWAP', 'NOP'].map((n) => OP[n]));
/** at most this many instructions per arm (a terminating JMP not counted) and in both arms */
const IFCVT_ARM_MAX = 3, IFCVT_TOTAL_MAX = 4;
/** The locals an arm instruction writes: its register destinations (L_REG+r) and, if it writes flags, the flag locals. */
function ifcvtWrites(insn, out) {
  const reg = (o) => { if (o && o.t === OT.REG) out.add(L_REG + (o.size === 1 && o.r >= 4 ? o.r - 4 : o.r)); };
  const op = insn.op;
  if (op !== OP.CMP && op !== OP.TEST) reg(insn.ops[0]);
  if (op === OP.XCHG) reg(insn.ops[1]);
  if (op === OP.CBW) out.add(L_REG);
  if (op === OP.CWD) { out.add(L_REG + 2); if (insn.opsize === 2) out.add(L_REG); }
  if (!FLAGS_NONE.has(op) && op !== OP.SETCC && op !== OP.CMOVCC && op !== OP.CBW && op !== OP.CWD && op !== OP.BSWAP) for (const l of op === OP.NEG ? [L_LZOP, L_LZRES, L_LZA] : [L_LZOP, L_LZRES, L_LZA, L_LZB]) out.add(l);
  // (a condition read with the lazy state unknown may materialize it: EFLAGS and the lazy op written)
  if (op === OP.SETCC || op === OP.CMOVCC || op === OP.ADC || op === OP.SBB || op === OP.INC || op === OP.DEC) for (const l of [L_EFLAGS, L_LZOP]) out.add(l);
}
/** Whether `insn` may be part of an if-converted arm. */
function ifcvtInsnOk(insn) {
  if (!IFCVT_OPS.has(insn.op) || !HANDLERS[insn.op] || insn.inlineApi || insn.rep || insn.lock) return false;
  for (let i = 0; i < insn.ops.length; i++) {
    const o = insn.ops[i];
    if (o.t === OT.REG || o.t === OT.IMM) continue;
    if (o.t === OT.MEM && (i > 0 || insn.op === OP.CMP || insn.op === OP.TEST)) continue; // (a load, or LEA's address)
    return false; // a store, a segment register, an x87/MMX/XMM operand
  }
  if (insn.op === OP.XCHG && (insn.ops[0].t !== OT.REG || insn.ops[1].t !== OT.REG)) return false;
  return true;
}
/**
 * Block `X` as an if-converted arm: { block, body (its instructions but a final JMP), succ (where it goes on) }, or null
 * when it does not qualify.
 */
function ifcvtArm(X) {
  if (!X || X.decodeError) return null;
  const last = X.insns[X.insns.length - 1];
  let body, succ;
  if (X.term === TERM_JMP && last.ops[0].t === OT.REL && last.opsize === 4) { body = X.insns.slice(0, -1); succ = last.ops[0].v; }
  else if (X.term === TERM_NONE) { body = X.insns; succ = X.fallthrough; }
  else return null;
  if (body.length > IFCVT_ARM_MAX || !body.every(ifcvtInsnOk)) return null;
  return { block: X, body, succ };
}
/** a memory operand read as data (not the stack, not LEA's address) */
const dataMem = (insn, o) => o.t === OT.MEM && insn.op !== OP.LEA && !(o.base === 4 || o.base === 5) && !(o.base < 0 && o.index < 0);
/**
 * Whether block A's final branch compares data (see the if-conversion comment above): the flags it reads were last
 * written in A by a CMP / SUB of two values (no immediate) reading memory other than the stack and absolute variables, or
 * a register holding such a value (data flows through the registers written in A) — the comparisons of a sort or a
 * search. A test of a value against a constant (an object's state, a null pointer) is usually predictable, and its
 * conversion makes the code wait for the load the branch would have speculated past (measured in play: guest time per
 * instruction +17% when every data test was converted).
 */
function ifcvtDataCond(A) {
  let regs = 0, flags = false, cmp2 = false;
  for (let i = 0; i < A.insns.length - 1; i++) {
    const insn = A.insns[i], op = insn.op;
    let reads = false;
    insn.ops.forEach((o, k) => {
      if (dataMem(insn, o)) reads = true;
      else if (o.t === OT.REG && (k > 0 || !(op === OP.MOV || op === OP.MOVZX || op === OP.MOVSX || op === OP.LEA)) && (regs & (1 << (o.size === 1 && o.r >= 4 ? o.r - 4 : o.r)))) reads = true;
      else if (o.t === OT.MEM && op === OP.LEA && ((o.base >= 0 && (regs & (1 << o.base))) || (o.index >= 0 && (regs & (1 << o.index))))) reads = true;
    });
    const d = insn.ops[0];
    if (d && d.t === OT.REG && op !== OP.CMP && op !== OP.TEST) { const r = d.size === 1 && d.r >= 4 ? d.r - 4 : d.r; if (reads) regs |= 1 << r; else if (d.size === 4) regs &= ~(1 << r); }
    if (!LZ_KEEP.has(op)) { flags = reads; cmp2 = (op === OP.CMP || op === OP.SUB) && insn.ops.every((o) => o.t === OT.REG || o.t === OT.MEM); }
  }
  return flags && cmp2;
}

/** Instructions that load the x87 control word (precision / rounding control). */
const FPU_MODE_WRITERS = new Set([OP.FLDCW, OP.FNINIT, OP.FLDENV, OP.FRSTOR, OP.FXRSTOR, OP.FNSAVE]);

/** Direct in-region branch target of a block's last instruction (JMP/JCC/LOOP/CALL rel), or -1. */
function branchTarget(insn) {
  const o = insn.ops[0];
  if (!o || o.t !== OT.REL) return -1;
  switch (insn.op) {
    case OP.JMP: case OP.JCC: case OP.LOOP: case OP.LOOPE: case OP.LOOPNE: case OP.JECXZ: return o.v;
    case OP.CALL: return insn.opsize === 2 ? o.v & 0xffff : o.v;
    default: return -1;
  }
}

/**
 * Block order of the emission (opts.layout): reverse postorder of a depth-first walk from the region entry, so that
 * every transfer that is not part of a cycle goes forward — a plain `br` to a later unit's label, where a backward
 * transfer outside a structured loop costs a budget check and the region's br_table dispatch (an indirect jump, and
 * at its loop header the moves of every live value into the places the header assigns them).
 * In address order, the return of an in-region callee placed after its caller, a block the compiler moved out of
 * line jumping back into its function, and calls to callees placed before the caller were such transfers. The walk
 * follows the in-region successors (fallthrough, branch targets, a call's callee and its return site, a RET's return
 * sites, see regionRetSites); a call's callee is visited last, so that its blocks follow the call (and its return
 * site follows them), and a conditional branch's fallthrough is visited last, so that it stays next to its block when
 * it can (a natural fallthrough: no branch at all). Blocks no walk reaches keep their address order at the end. Only
 * the order changes: every transfer is emitted as before (direct when forward, through the dispatch otherwise).
 * Returns the blocks with their new indices.
 */
function layoutBlocks(blocks, byEip, entry) {
  const retSites = regionRetSites(blocks, byEip);
  const succ = (b) => {
    const last = b.insns[b.insns.length - 1];
    switch (b.term) {
      case TERM_NONE: return [b.fallthrough];
      case TERM_JCC: case TERM_LOOP: return [last.ops[0].v, b.fallthrough];
      case TERM_JMP: return last.ops[0].t === OT.REL ? [last.ops[0].v] : [];
      case TERM_CALL: return [b.fallthrough, branchTarget(last)];
      default: return retSites[b.index] ?? []; // (RET, an import stub's inline-API JMP: their local return sites)
    }
  };
  const seen = new Uint8Array(blocks.length), post = [];
  const start = byEip.get(entry) ?? blocks[0];
  // iterative DFS: [block, its successor blocks, next successor to visit]
  const stack = [[start, succ(start).map((a) => byEip.get(a)).filter(Boolean), 0]];
  seen[start.index] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top[2] < top[1].length) {
      const t = top[1][top[2]++];
      if (!seen[t.index]) { seen[t.index] = 1; stack.push([t, succ(t).map((a) => byEip.get(a)).filter(Boolean), 0]); }
      continue;
    }
    post.push(top[0]);
    stack.pop();
  }
  const order = post.reverse();
  for (const b of blocks) if (!seen[b.index]) order.push(b);
  order.forEach((b, i) => { b.index = i; });
  return order;
}

/**
 * Control-flow layout of a region: the blocks (address order) grouped into a tree of units, each a single
 * block or a structured loop [first, last] spanning a back edge's target (its header) to its latest source,
 * whose children are units in turn. Loops are kept shortest first when they are disjoint from every loop
 * kept so far or, with `nest`, contain it; the back edges of the others go through a dispatcher. Nesting is
 * off by default (opts.nestLoops): measured 13% slower in the game (V8 on deep loop nests of large
 * functions, D044), although exact.
 * Returns the top-level units, the single-block unit of every block and, per block, the loops holding it
 * (outermost first).
 */
function planUnits(blocks, byEip, nest) {
  const n = blocks.length;
  const last = new Map(); // header index -> latest back-edge source
  for (const b of blocks) {
    const t = b.insns.length ? byEip.get(branchTarget(b.insns[b.insns.length - 1])) : null;
    if (t && t.index <= b.index) last.set(t.index, Math.max(last.get(t.index) ?? -1, b.index));
  }
  const kept = [];
  for (const [h, e] of [...last].sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))) {
    if (kept.every((k) => e < k.first || h > k.last || (nest && h <= k.first && k.last <= e))) kept.push({ first: h, last: e });
  }
  const blockUnit = new Array(n), pathOf = new Array(n);
  const build = (lo, hi, path) => {
    const units = [];
    for (let i = lo; i <= hi;) {
      let L = null; // the outermost kept loop starting here, other than the enclosing ones
      for (const k of kept) if (k.first === i && k.last <= hi && !path.some((u) => u.src === k) && (!L || k.last > L.last)) L = k;
      if (L) {
        const u = { loop: true, first: L.first, last: L.last, src: L, label: null, loopL: null, children: null };
        u.children = build(L.first, L.last, [...path, u]);
        units.push(u);
        i = L.last + 1;
      } else {
        const u = { loop: false, first: i, last: i, label: null };
        blockUnit[i] = u; pathOf[i] = path;
        units.push(u);
        i++;
      }
    }
    return units;
  };
  return { top: build(0, n - 1, []), blockUnit, pathOf };
}

/**
 * Discover the blocks of a region.
 * @returns {{ blocks: Array<{eip:number, insns:any[], end:number, term:number, index:number}>, byEip: Map<number, any> }}
 */
export function discoverRegion(mem, entry, opts) {
  const boundaries = opts.boundaries ?? null;
  const ranges = opts.interpRanges ?? null; // (debugging: code left to the interpreter, never part of a region)
  const isBoundary = (a) => (boundaries && boundaries.has(a)) || (a >= THUNK_BASE && a < THUNK_END) || (ranges !== null && ranges.some(([lo, hi]) => a >= lo && a < hi));
  const leaders = new Set([entry]);
  const queue = [entry];
  const decoded = new Map(); // eip -> insn (shared cache within this translation)
  let total = 0;
  const MAX_BLOCKS = opts.maxBlocks ?? JIT_DEFAULTS.maxBlocks, MAX_INSNS = opts.maxInsns ?? JIT_DEFAULTS.maxInsns; // (region size limits)
  const dec = (a) => { let i = decoded.get(a); if (!i) { i = decode(mem, a); if (opts.inlineApi !== false) i.inlineApi = inlineApiOf(mem, i); decoded.set(a, i); } return i; };
  const termOf = (insn) => (insn.inlineApi && insn.op === OP.CALL ? TERM_NONE : termOfInsn(insn)); // (a call run inline does not end its block)
  // opts.coldExits with a heat (opts.heat, see heat.js: get(address) = executions, VISITED for the learned / visited
  // ranges): a successor of a branch that ran at least opts.coldMin times is left out of the region when it never ran
  // itself — that edge becomes an exit (exact whatever the heat says: only the region's extent changes)
  const heat = (opts.coldExits ?? JIT_DEFAULTS.coldExits) && opts.heat ? opts.heat : null;
  const coldMin = opts.coldMin ?? JIT_DEFAULTS.coldMin;
  // opts.onlyBlocks (a Set of block addresses): the blocks of an earlier translation of this entry, whose extent and
  // numbering an x87-mode version must repeat (the heat may have grown since)
  const only = opts.onlyBlocks ?? null;
  const cold = (from, t) => (only !== null ? !only.has(t) : heat !== null && (heat.get(from) ?? 0) >= coldMin && !heat.has(t));
  // (measurement, startbench --jit-sites: the successors left out for the region's size)
  const limited = globalThis.ORTHROS_SITE_PROF ? new Set() : null;
  // pass 1: find leaders
  while (queue.length && leaders.size <= MAX_BLOCKS && total < MAX_INSNS * 2) {
    let a = queue.shift();
    for (let n = 0; n < MAX_INSNS; n++) {
      if (isBoundary(a)) break;
      let insn;
      try { insn = dec(a); } catch { break; }
      total++;
      const term = termOf(insn);
      const addLeader = (t) => { if (!isBoundary(t) && !leaders.has(t) && !cold(insn.addr, t)) { if (leaders.size < MAX_BLOCKS) { leaders.add(t); queue.push(t); } else limited?.add(t); } };
      if (term === TERM_NONE) { a = insn.next; if (leaders.has(a)) break; continue; }
      if (term === TERM_JMP) { addLeader(insn.ops[0].v); break; }
      if (term === TERM_JCC || term === TERM_LOOP) { addLeader(insn.ops[0].v); addLeader(insn.next); break; }
      if (term === TERM_CALL) { addLeader(insn.ops[0].v); addLeader(insn.next); break; }
      if (term === TERM_INDIRECT || term === TERM_RET || term === TERM_EXIT) { if (term !== TERM_RET && term !== TERM_INDIRECT) addLeader(insn.next); break; }
      break;
    }
  }
  // pass 2: decode blocks up to the next leader / terminator
  const sorted = [...leaders].sort((x, y) => x - y);
  const blocks = [];
  const byEip = new Map();
  let count = 0;
  for (const eip of sorted) {
    const b = { eip, insns: [], end: eip, term: TERM_NONE, index: blocks.length, fallthrough: 0 };
    let a = eip;
    for (;;) {
      if (a !== eip && (leaders.has(a) || isBoundary(a))) { b.term = TERM_NONE; b.fallthrough = a; break; }
      let insn;
      try { insn = dec(a); } catch (e) { b.term = TERM_EXIT; b.decodeError = e; b.fallthrough = a; break; }
      b.insns.push(insn);
      count++;
      const term = termOf(insn);
      a = insn.next;
      if (term !== TERM_NONE) { b.term = term; b.fallthrough = a; break; }
      if (count > MAX_INSNS * 2) { b.fallthrough = a; break; }
    }
    b.end = a;
    if (b.insns.length === 0 && b.term === TERM_NONE) continue; // empty (boundary) block
    blocks.push(b);
    byEip.set(eip, b);
  }
  return { blocks, byEip, limited };
}

/** the type and import sections, identical in every region module, are encoded once */
const REGION_HEADER = [{}, {}]; // (per memory kind: unshared, shared)
const regionTemplate = [null, null];
/** one emission buffer reused by every translation (grown once instead of from 4 KB per region) */
let scratchCode = null;

/**
 * A translated body moved to table index `fnIdx`: the only place a body depends on its index is the offset of the
 * load of its next x87-mode version's slot (JIT_ALT_BASE + 4 * fnIdx, at `altAt`: always a 5-byte LEB, the slot
 * addresses being >= 2^28), rewritten in place. `altAt` < 0: nothing to do. Returns `code`.
 */
export function patchAltSlot(code, altAt, fnIdx) {
  if (altAt < 0) return code;
  if (!(fnIdx >= 0 && fnIdx < JIT_ALT_SLOTS) || code[altAt - 2] !== 0x28) throw new Error('patchAltSlot: not an alt slot load');
  let v = (JIT_ALT_BASE + 4 * fnIdx) >>> 0;
  for (let i = 0; i < 5; i++) { code[altAt + i] = (v & 0x7f) | (i < 4 ? 0x80 : 0); v >>>= 7; }
  return code;
}

/**
 * A translated body whose visit flags (opts.visit) move to other addresses: `sites` pairs [body offset, flag address]
 * (the offsets of stats.visitSites; the stores' 5-byte offset LEBs rewritten in place). Returns `code`.
 */
export function patchVisitSlots(code, sites) {
  for (const [at, addr] of sites) {
    if (code[at - 2] !== 0x3a || !(addr >= BLOCK_COUNTS_BASE && addr < BLOCK_COUNTS_BASE + 4 * BLOCK_COUNTS_SLOTS)) throw new Error('patchVisitSlots: not a visit flag store');
    let v = addr >>> 0;
    for (let i = 0; i < 5; i++) { code[at + i] = (v & 0x7f) | (i < 4 ? 0x80 : 0); v >>>= 7; }
  }
  return code;
}

/**
 * Emit a complete region module. Returns { bytes, blocks } where blocks[i] = { eip, index }.
 */
export function translateRegion(mem, entry, opts = {}) {
  const em = new Emitter(mem, opts);
  return em.run(entry);
}

// ---- x87 entry shifts. Inside a block the x87 handlers only move a static shift (Emitter.stShift); where the block
// is left the shift is materialized: the 8 stack locals rotated, the tag word rotated, L_TOP adjusted. A C-runtime
// math routine entered with its argument pushed (fld ; jcc to the SSE2 code) or pushing its result before a jump
// to a common epilogue (fld ; jmp L ; ... L: fstp) paid one such rotation on every in-region branch: 8 f64 moves of
// loop-carried locals (tools/crtmath-bench.mjs: 4 of them per element of an SSE2 sin). A block may instead be
// entered with a non-zero shift, its planned entry shift: an in-region transfer (fallthrough, branch, dispatch
// through L_BLK) rotates only by the difference between its shift and the target's plan, nothing when they agree.
// A region entry (dispatcher, chain, return) finds the x87 state in the state block: the prologue loads the locals
// for the entry block's plan directly (x87EntryTop: L_TOP = TOP - plan, the loads relative to it), so that no
// rotation merges into the blocks' loop-carried values. The plan only chooses where rotations happen: any plan is
// exact, so it is computed before the emission from the instructions' usual stack effects (x87StackEffect): a
// handler doing otherwise (an interpreter fallback of an operand form, a push depending on the operand) only costs
// the rotations the plan meant to avoid.
/** x87 instructions pushing (-1: the shift decreases) or popping (+1, +2) the stack, for x87EntryPlan. */
const X87_STACK = new Map([
  ...['FLD', 'FILD', 'FBLD', 'FLD1', 'FLDL2T', 'FLDL2E', 'FLDPI', 'FLDLG2', 'FLDLN2', 'FLDZ', 'FXTRACT', 'FPTAN', 'FSINCOS',
    'FDECSTP'].map((k) => [OP[k], -1]),
  ...['FSTP', 'FISTP', 'FISTTP', 'FBSTP', 'FCOMP', 'FICOMP', 'FUCOMP', 'FCOMIP', 'FUCOMIP', 'FADDP', 'FMULP', 'FSUBP', 'FSUBRP',
    'FDIVP', 'FDIVRP', 'FPATAN', 'FYL2X', 'FYL2XP1', 'FINCSTP'].map((k) => [OP[k], 1]),
  [OP.FCOMPP, 2], [OP.FUCOMPP, 2],
]);
/** Instructions whose handler leaves the stack normalized (shift 0: TOP reloaded or re-based). */
const X87_NORMALIZING = new Set(['FLDENV', 'FNSTENV', 'FRSTOR', 'FNSAVE', 'FNINIT', 'FXSAVE', 'FXRSTOR', 'EMMS'].map((k) => OP[k]));
/**
 * Usual effect of `insn` on the static shift: a change (-1 push, +1/+2 pops, 0), or null when its translation
 * normalizes the stack (interpreter fallbacks, state loads / saves, MMX instructions re-basing it on TOP = 0).
 */
function x87StackEffect(insn) {
  if (!HANDLERS[insn.op] || X87_NORMALIZING.has(insn.op)) return null;
  const d = X87_STACK.get(insn.op);
  if (d !== undefined) return d;
  return touchesFpu(insn) && !FPU_OPS.has(insn.op) ? null : 0; // (an MMX operand: TOP = 0)
}
/**
 * Planned x87 entry shift per block (null when all are 0): the value every in-region transfer into the block
 * leaves, from the blocks' stack effects (a transfer's shift: its block's entry shift plus the effects before it, or
 * from the last normalizing instruction); 0 for the blocks entered from outside on every visit (the region entry —
 * whose entries then skip the prologue's plan lookup —, return sites), without in-region predecessor, or whose
 * transfers disagree.
 */
function x87EntryPlan(blocks, byEip, entryIdx) {
  const n = blocks.length, edges = [];
  for (const b of blocks) {
    let shift = 0, abs = false;
    for (const insn of b.insns) {
      const d = x87StackEffect(insn);
      if (d === null) { shift = 0; abs = true; } else shift = (shift + d) & 7;
    }
    const last = b.insns[b.insns.length - 1];
    const succ = [];
    if (b.term === TERM_NONE || b.term === TERM_JCC || b.term === TERM_LOOP) succ.push(b.fallthrough);
    if (last && b.term !== TERM_NONE && branchTarget(last) >= 0) succ.push(branchTarget(last));
    for (const a of succ) { const t = byEip.get(a); if (t) edges.push({ src: b.index, tgt: t.index, shift, abs }); }
  }
  if (!edges.some((e) => e.shift !== 0)) return null;
  // forward dataflow to a fixpoint, optimistic like regionLazyPrediction: UNSET (no computable incoming transfer
  // yet: a loop header before its back edge is known) is the identity of the meet, disagreeing values meet to 0
  // for good (BAD). Monotone (UNSET -> a value -> BAD), so it ends
  const UNSET = -1, BAD = -2;
  const plan = new Int8Array(n).fill(BAD);
  for (const e of edges) plan[e.tgt] = UNSET;
  plan[entryIdx] = BAD;
  for (const b of blocks) if (b.term === TERM_CALL && byEip.has(b.fallthrough)) plan[byEip.get(b.fallthrough).index] = BAD;
  const at = (k) => (plan[k] < 0 ? 0 : plan[k]);
  for (let changed = true, rounds = 0; changed && rounds < 64; rounds++) {
    changed = false;
    for (const e of edges) {
      const t = e.tgt;
      if (plan[t] === BAD) continue;
      if (!e.abs && plan[e.src] === UNSET) continue; // (its source's shift not known yet)
      const v = e.abs ? e.shift : (at(e.src) + e.shift) & 7;
      if (plan[t] === v) continue;
      plan[t] = plan[t] === UNSET ? v : BAD;
      changed = true;
    }
  }
  for (let k = 0; k < n; k++) plan[k] = at(k);
  return plan.some((p) => p !== 0) ? plan : null;
}

/** Assemble region function bodies into one module exporting r0..rN (same imports for all regions). */
export function buildRegionModule(codes, names = null, shared = false) {
  const key = shared ? 1 : 0; // (the memory import declares whether the guest memory is shared between workers)
  if (!regionTemplate[key]) {
    const t = new ModuleBuilder(REGION_HEADER[key]);
    if (t.type(REGION_PARAMS, REGION_RESULTS) !== REGION_TYPE) throw new Error('region type must be type 0');
    t.importMemory('env', 'memory', 32768, 32768, shared);
    t.importTable('env', 'table', 1024, undefined); // shared funcref table (chained tail calls)
    t.importFunc('env', 'flags', [T.i32, T.i32, T.i32, T.i32, T.i32], [T.i32]);
    t.importFunc('env', 'round24', [T.f64, T.i32], [T.f64]);
    t.importFunc('env', 'fallback', [T.i32], [T.i32]);
    for (const [name, params, results] of MATH_KERNELS) t.importFunc('env', name, params, results);
    if (t.importFunc('env', 'chain', REGION_PARAMS, REGION_RESULTS) !== IMP_CHAIN) throw new Error('chain import index mismatch');
    regionTemplate[key] = t;
  }
  const m = regionTemplate[key].fork();
  codes.forEach((code, i) => { const f = m.func(REGION_PARAMS, REGION_RESULTS, LOCAL_TYPES, { buf: code, len: code.length, hints: code.hints }, names?.[i] ?? 'r' + i); m.exportFunc('r' + i, f); });
  return m.build();
}

/**
 * Measurement (startbench --jit-sites: globalThis.ORTHROS_SITE_PROF, Node only, not with block counters): the region
 * exit sites — indirect calls and jumps, returns leaving their region, static exits (to a successor left out for the
 * region's size: exitLim; of a call: ...Call) — count their executions, last target and target changes in three u32
 * counter slots (allocBlockCounters) per site address and kind, shared by the regions holding the site.
 * SITE_PROF: [guest address (static exits: the target), kind, slot address].
 */
export const SITE_PROF = [];
const SITE_SLOTS = new WeakMap(); // guest memory -> (kind:address -> slot address): the slots are allocated in that memory
/** Transition counters of profiling translations (opts.profile), ST.PROF + 4 * index. */
export const JIT_PROF = ['forward', 'backward', 'fallthrough', 'ret', 'indirect', 'exit', 'chainSelf', 'chainOther', 'dispatch', 'retLocal', 'flagsNull', 'flagsStatic', 'flagsEager', 'flagsSlowArm', 'chainFromX87',
  // (from here on in ST.PROF2) the dispatches by kind: a forward transfer into a loop elsewhere than at its header, a
  // backward transfer to a block of the innermost loop holding both ends other than its header, a backward transfer
  // no structured loop holds (the region dispatcher), and the local returns among the latter
  'unused15', 'dispatchFwdLoop', 'dispatchBackLoop', 'dispatchBackTop', 'dispatchRetTop',
  // null-page checks run (Emitter.nullCheck)
  'nullCheck',
  // x87 arithmetic (translate-x87.js arith): operations run on the 24-bit float / double paths, their entries into the
  // cold path (a result the hot tests sent aside), and the calls of the cold-path kernels (fpmath-x87cold.js)
  'x87Arith', 'x87ColdEntry', 'x87ColdCall'];
/** state block offset of profiling counter k */
export const profOffset = (k) => (k < 16 ? ST.PROF + 4 * k : ST.PROF2 + 4 * (k - 16));
const PF = Object.fromEntries(JIT_PROF.map((k, i) => [k, i]));
/** profiling translations: flags helper calls per x86 opcode (u32 per OP value) */
export const PROF_OPS_BASE = JIT_SCRATCH_BASE + 0xa0000;
/** offset from PROF_OPS_BASE of the unchained-transition counters (thunk, stop, budget, miss) */
export const NOCHAIN_PROF = 0x8000;
/**
 * n consecutive block execution counters (BLOCK_COUNTS_BASE), zeroed: the address of the first, or -1 once the area is
 * full. The bump index lives in guest memory (word 0), so that the background translator, which shares it, allocates
 * from the same area (atomically when the memory is shared).
 */
export function allocBlockCounters(mem, n) {
  const i32 = mem.i32, w = BLOCK_COUNTS_BASE >>> 2;
  const shared = typeof SharedArrayBuffer !== 'undefined' && i32.buffer instanceof SharedArrayBuffer;
  // (once full the index no longer advances: requests after that would otherwise keep adding to it until it wrapped
  // and handed out addresses outside the area — fill() with a negative start counts from the end of guest memory)
  const now = shared ? Atomics.load(i32, w) : i32[w];
  if (!(n > 0) || now < 0 || now + 1 + n > BLOCK_COUNTS_SLOTS) return -1;
  const at = (shared ? Atomics.add(i32, w, n) : (i32[w] += n) - n) || 0;
  const first = at + 1; // (slot 0 is the bump index)
  if (at < 0 || first + n > BLOCK_COUNTS_SLOTS) return -1;
  i32.fill(0, w + first, w + first + n);
  return BLOCK_COUNTS_BASE + 4 * first;
}

/**
 * Visit flags by block address (opts.visit): the byte of a block, allocated on first use from the counter area in
 * chunks of VISIT_CHUNK bytes (allocBlockCounters), -1 once the area is full.
 */
const VISIT_CHUNK = 4096;
export class VisitSlots {
  constructor() { this.map = new Map(); this.next = 0; this.end = 0; this.full = false; }
  get(mem, eip) {
    let a = this.map.get(eip);
    if (a !== undefined) return a;
    if (this.next >= this.end) {
      if (this.full) return -1;
      const base = allocBlockCounters(mem, VISIT_CHUNK >> 2);
      if (base < 0) { this.full = true; return -1; }
      this.next = base; this.end = base + VISIT_CHUNK;
    }
    a = this.next++;
    this.map.set(eip, a);
    return a;
  }
}

class Emitter {
  constructor(mem, opts) {
    this.mem = mem;
    this.opts = opts;
    this.altAt = -1; // (offset in the body of the alt slot load's address, see patchAltSlot)
    this.c = scratchCode ??= new Code(1 << 16);
    this.c.reset();
    this.lz = null;
    this.xsValid = this.xsDirty = 0; this.xsOK = false; // XMM lane-0 shadows (see xmmShadowSync)
    this.xdValid = this.xdDirty = 0; this.xdOK = false; // (f64 shadows, see xmmShadowSync64)
    this.fcmp = null;
    this.smc = opts.smc !== false;
    this.logicRes = !!(opts.logicRes ?? JIT_DEFAULTS.logicRes); // (see binArith)
    this.ifcvt = opts.ifcvt ?? JIT_DEFAULTS.ifcvt; // (see ifcvtPlan: true, 'all' or false)
    this.spec = 0; // emitting an if-converted arm: its loads read address 0 unless the arm is the path taken (see loadMem)
    this.ncPlan = null; // null-page checks of the block being emitted (planNullChecks)
    this.specCheck = false; // (the arm instruction being emitted has a memory operand to check: see nullCheck)
    this.nullPage = opts.nullPage ?? JIT_DEFAULTS.nullPage; // accesses to the first 64 KiB fault (see nullCheck)
    this.x87 = opts.x87 !== false;
    this.chain = opts.chain !== false;
    this.chainStub = !!(opts.chainStub ?? JIT_DEFAULTS.chainStub); // (see the jump exit in run)
    this.swLocal = !!(opts.swLocal ?? JIT_DEFAULTS.swLocal); // (the x87 status word in a local: see L_SW)
    this.prof = !!opts.profile; // count block transitions by kind (ST.PROF); opts.fnIdx tells self-chains apart
    // x87 mode the region is specialized for (opts.fpcAssume, null: tested at run time): the precision/rounding control
    // (cw & 0xf00) in fpcAssume, and with X87_MODE_TOP set, the stack top at the region's entry in topAssume (see
    // x87ModeOf: every TOP-relative address of the x87 stack cache becomes a constant)
    const mode = opts.fpcAssume ?? null;
    this.fpcAssume = mode === null ? null : mode & 0xf00;
    this.topAssume = mode !== null && (mode & X87_MODE_TOP) && (opts.x87Top ?? JIT_DEFAULTS.x87Top) ? mode & 7 : null;
    // x87 arithmetic's cold paths: 'call' — a call to the runtime's kernels (fpmath-x87cold.js) on the hinted-unlikely
    // path; 'inline' — the same code emitted in every instruction (the earlier translation, for measurement)
    this.x87Cold = opts.x87Cold ?? JIT_DEFAULTS.x87Cold;
    // exits rotate the x87 stack locals to shift 0 like in-region transfers (the earlier exits, for measurement): see
    // x87ExitState
    this.x87ExitRotate = !!(opts.x87ExitRotate ?? JIT_DEFAULTS.x87ExitRotate);
    // directed 24-bit rounding cuts an f64 result's significand with a vector AND (the value stays in its XMM register)
    // instead of a round trip through a general register (false: the earlier code, for measurement): see
    // translate-x87.js pushCut24
    this.x87VecMask = !!(opts.x87VecMask ?? JIT_DEFAULTS.x87VecMask);
    // only the x87 stack registers the region's code touches are loaded at its entry (and after fallbacks) and written
    // back at its exits: see x87LiveSites
    this.x87Live = !!(opts.x87Live ?? JIT_DEFAULTS.x87Live);
    /** byte ranges [start, end, register] of the per-register loads and stores of the x87 stack cache (x87LiveSites) */
    this.x87Sites = [];
    this.stats = { native: 0, fallback: 0, x87Planned: 0, ifcvt: 0 }; // (x87Planned: blocks entered with a planned x87 shift; ifcvt: if-converted branches)
    /** planned x87 shift at each block's entry (x87EntryPlan), null: every block entered at shift 0 */
    this.x87Plan = null;
    this.stShift = 0;
    this.f32Mask = this.g24Mask = 0; // (per block, see emitBlock)
  }

  run(entry) {
    let { blocks, byEip, limited } = discoverRegion(this.mem, entry, this.opts);
    this.limited = limited; // (measurement: see siteProf)
    if (!blocks.length) throw new Error(`no code at ${entry.toString(16)}`);
    this.discovered = blocks; // (address order)
    this.layout = this.opts.layout ?? JIT_DEFAULTS.layout;
    if (this.layout) blocks = layoutBlocks(blocks, byEip, entry);
    this.blocks = blocks;
    this.byEip = byEip;
    if (this.opts.flagsAcrossBlocks !== false) regionFlagsLiveness(blocks, byEip);
    if (this.opts.lazyPredict !== false) regionLazyPrediction(blocks, byEip);
    /** x87 region: the register stack, tag word and precision control live in locals (L_ST0..) */
    this.usesX87 = blocks.some((b) => b.insns.some(touchesFpu));
    if (!this.usesX87) this.fpcAssume = this.topAssume = null; // (nothing to specialize; L_FPC is not even loaded)
    this.x87EntryIdx = byEip.get(entry)?.index ?? 0; // (see x87EntryTop)
    if (this.usesX87 && this.opts.x87EntryShifts !== false) this.x87Plan = x87EntryPlan(blocks, byEip, this.x87EntryIdx);
    this.stats.x87Planned = this.x87Plan ? this.x87Plan.reduce((k, p) => k + (p !== 0), 0) : 0;
    // profiling translations (opts.blockCounts): a u32 counter per block, incremented at the block's entry (every path
    // into a block passes there: fallthrough, branch, dispatch, chain) — which blocks of a hot region the time goes to
    this.counterBase = this.opts.blockCounts ? allocBlockCounters(this.mem, blocks.length) : -1;
    this.stats.counters = this.counterBase;
    // visit flags (opts.visit, not with counters): a byte per block not known to have run (opts.heat), set to 1 at the
    // block's entry; Jit.harvestVisits collects them into the heat (see heat.js). stats.visits: [eip, end, flag address]
    // One flag per block address (opts.visitSlots, shared by the translations of a thread: the regions holding a block
    // set the same byte), from the counter area in chunks (allocVisitFlag).
    this.visitAt = null;
    if ((this.opts.visit ?? JIT_DEFAULTS.visit) && this.counterBase < 0) {
      const heat = this.opts.heat ?? null, slots = this.opts.visitSlots ?? new VisitSlots();
      const visits = [];
      for (const b of blocks) {
        if (heat && heat.has(b.eip)) continue;
        const a = slots.get(this.mem, b.eip); if (a < 0) { this.stats.visitsCut = true; break; } // (the area is full)
        (this.visitAt ??= new Int32Array(blocks.length).fill(-1))[b.index] = a;
        visits.push([b.eip, b.end, a]);
      }
      if (visits.length) this.stats.visits = visits;
    }
    // XMM registers named by the region's instructions live in v128 locals between entry and the exits (the state
    // block is written at exits, chains and around interpreter fallbacks): scalar SSE results no longer go through
    // memory, where an 8-byte store followed by a 16-byte load of the same register defeats store forwarding.
    // Registers only reached implicitly (FXSAVE/FXRSTOR, interpreter fallbacks) stay in the state block.
    this.xmmMask = 0;
    for (const b of blocks) for (const insn of b.insns) for (const o of insn.ops) if (o.t === OT.XMM) this.xmmMask |= 1 << (o.r & 7);
    const c = this.c;
    // registers/flags arrive as parameters; only the x87 TOP cache is loaded from the state block
    // (plus the whole x87 stack in x87 regions)
    // the FS base (TEB) only in regions reading it: an FS-segment operand, an API run inline (its TEB fields)
    this.usesFs = blocks.some((b) => b.insns.some((i) => i.inlineApi || i.seg === SEG.FS || i.ops.some((o) => o.seg === SEG.FS)));
    if (this.usesFs) c.get(L_STATE).i32load(ST.FS_BASE).set(L_FS);
    if (this.usesX87 && this.x87Live) c.track(L_ST0, 8); // (which stack locals the body touches: x87LiveSites)
    // (the truncation mask of translate-x87.js pushCut24, built once: TurboFan keeps it in a register or a spill slot
    // instead of rebuilding the constant at every arithmetic instruction)
    if (this.usesX87 && this.x87VecMask && this.fpcAssume === 0xc00) c.v128const(CUT24_BYTES).set(L_CUT24);
    if (this.usesX87) { // (TOP: x87 regions only, the others never change it)
      c.get(L_STATE).i32load8u(ST.FPU_TOP).set(L_TOP); this.x87EntryTop();
      // (specialized for the stack top: the stack is loaded once the guard below has made L_TOP a constant)
      if (this.topAssume === null) this.loadX87(); else this.loadX87Fpc();
    }
    this.loadXmm(); // (before any exit path: they write the cached registers back)
    this.exitCodeL = c.block();
    this.exitJmpL = c.block();
    if (this.fpcAssume !== null) {
      // specialized for one x87 mode: entered under another one, tail-call the next version of this region (the
      // same blocks translated for another mode, JIT_ALT_BASE slot of this table index) with the parameters as
      // received, or leave (EIP is the entry's, stored by the dispatcher / chain) for the JIT to add a version
      // (EXIT_ARG: the mode met, see x87ModeOf). The stack top compared is the region's (L_TOP once x87EntryTop has
      // taken the entered block's planned shift off)
      c.get(L_FPC).i32(this.fpcAssume).ne();
      if (this.topAssume !== null) c.get(L_TOP).i32(this.topAssume).ne().or();
      const i = c.hint(false).if_();
      const fnIdx = this.opts.fnIdx ?? -1;
      if (this.chain && fnIdx >= 0 && fnIdx < JIT_ALT_SLOTS) {
        c.i32(0); this.altAt = c.len + 2; c.i32load(JIT_ALT_BASE + 4 * fnIdx).tee(L_T2); // (altAt: the 5-byte offset LEB, see patchAltSlot)
        const alt = c.if_();
        for (let k = 0; k < L_FIRST_DECLARED; k++) c.get(k);
        c.get(L_T2).i32(1).sub().return_call_indirect(REGION_TYPE, 0);
        c.end(); void alt;
      }
      c.get(L_STATE).get(L_FPC).get(L_TOP).or().i32(X87_MODE_TOP).or().i32store(ST.EXIT_ARG);
      // (an entry block planned with a non-zero x87 shift loaded the stack for it, a region specialized for the stack
      // top has not loaded it yet: (re)loaded at shift 0 for the exit, which writes it back)
      if (this.x87Plan || this.topAssume !== null) { c.get(L_STATE).i32load8u(ST.FPU_TOP).set(L_TOP); this.loadX87(); }
      c.get(L_STATE).i32load(ST.EIP).set(L_TV).i32(EXIT_FPUMODE).set(L_T2).br(this.exitCodeL);
      c.end(); void i;
      if (this.topAssume !== null) { c.i32(this.topAssume).set(L_TOP); this.loadX87Tags(); this.loadX87Regs(); }
    }
    // (a loop only when some transfer goes back through the dispatcher: see the end of the region)
    this.dispatchAt = c.len; this.dispatchUsed = false;
    this.dispatchL = c.loop();
    const def = c.block();
    // one label per unit: the last unit's is outermost, the first's innermost, so that the u-th
    // `end` closes labels[u] and unit u's code follows it; a forward branch to the first block of a
    // later unit is a plain `br` to that unit's label
    const { top, blockUnit, pathOf } = planUnits(blocks, byEip, !!this.opts.nestLoops);
    this.blockUnit = blockUnit;
    this.pathOf = pathOf;
    // per RET block, the return sites of the region's direct calls it may return to: a RET to one of them stays in the
    // region (see HANDLERS[OP.RET])
    this.retSitesOf = regionRetSites(blocks, byEip);
    // top level: the region's dispatcher (entries, unstructured edges) routes a block to its top-level unit
    this.emitUnits(top, () => this.dispatchAmong(top, 0, blocks.length - 1, null, def));
    c.end(); // def
    c.unreachable();
    c.end(); // dispatch loop
    // no transfer went back through the dispatcher (every backward one stays in a structured loop): its loop is a block
    // (the same control flow — nothing branches to its start —, but TurboFan aligns a loop header, checks the stack
    // there and merges every live value into it: code run at each entry of the region)
    if (!this.dispatchUsed && (this.opts.dispatchBlock ?? JIT_DEFAULTS.dispatchBlock)) { if (c.buf[this.dispatchAt] !== 0x03) throw new Error('dispatch loop not found'); c.buf[this.dispatchAt] = 0x02; this.stats.dispatchBlock = 1; }
    c.end(); // exitJmpL: jump exit (tV = target eip)
    if (this.opts.exitShare ?? JIT_DEFAULTS.exitShare) {
      // one exit tail for both kinds: the x87 / XMM caches and the registers written back by one copy of the code
      // (the flushes were emitted once per kind, three times for the x87 stack: the chained path, the jump exit's
      // and the code exit's — ~200 operations of an x87 region's epilogue); a jump exit tries the chain first
      c.i32(-1).set(L_T2); // (a jump exit: no exit code — code exits set L_T2 >= 0)
      c.end(); // exitCodeL: every exit (tV = eip or jump target, t2 = exit code, -1 for a jump)
      this.flushFpu(true); this.flushXmm();
      c.get(L_T2).i32(-1).eq();
      const jmp = c.hint(true).if_();
      if (this.chain && this.chainStub && !this.prof) {
        c.get(L_TV);
        for (let i = L_STATE; i <= L_ICOUNT; i++) c.get(i);
        c.return_call(IMP_CHAIN);
      } else if (this.chain) this.emitChain(false); // (falls through when the target is not chained)
      c.end(); void jmp;
      c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
      this.flushRegs();
      c.get(L_STATE).get(L_TV).i32store(ST.EIP);
      c.get(L_T2).i32(-1).ne();
      const code = c.if_(); c.get(L_STATE).get(L_T2).i32store(ST.EXIT); c.end(); void code;
      c.get(L_TV).i32(0).get(L_T2).i32(-1).eq().select(); // (the next EIP for a jump, 0: the code in the state block)
    } else {
      // (measurement: exitShare off, the earlier separate tails)
      if (this.chain && this.chainStub && !this.prof) {
        // (opts.chainStub: the x87 / XMM caches written back here, the rest of the exit — chained or not — in the
        // runtime's shared chain function, tail-called with the target in place of the block)
        this.flushFpu(true); this.flushXmm();
        c.get(L_TV);
        for (let i = L_STATE; i <= L_ICOUNT; i++) c.get(i);
        c.return_call(IMP_CHAIN);
      } else {
        if (this.chain) this.emitChain(); // (the budget travels as a parameter)
        c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
        this.flushAll(true);
        c.get(L_STATE).get(L_TV).i32store(ST.EIP);
        c.get(L_TV).return_();
      }
      c.end(); // exitCodeL: exit with code (tV = eip, t2 = code)
      c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
      this.flushAll(true);
      c.get(L_STATE).get(L_TV).i32store(ST.EIP);
      c.get(L_STATE).get(L_T2).i32store(ST.EXIT);
      c.i32(0);
    }
    if (this.usesX87 && this.x87Live) this.x87LiveSites();
    // module
    // the function body is kept so several regions can later be packed into one module (see Jit.consolidate)
    this.stats.calls = c.callsTo ? c.callsTo.slice() : null; // [import, guest op] of every call (a call anywhere costs spills in the whole function)
    // (in address order whatever the layout: callers compare the blocks of translations of the same code)
    const out = blocks.map((b) => ({ eip: b.eip, index: b.index, end: b.end }));
    if (this.layout) out.sort((x, y) => x.eip - y.eip);
    // (deps in address order, as code-cache.js inlineDeps over a discovery pass gives them)
    return { code: c.finish(), blocks: out, stats: this.stats, fpcAssume: this.fpcAssume === null || this.topAssume === null ? this.fpcAssume : this.fpcAssume | X87_MODE_TOP | this.topAssume, altAt: this.altAt, deps: inlineDeps(this.discovered) };
  }

  /**
   * Emit sibling units: one label per unit, the last unit's outermost, so that the k-th `end` closes the
   * label of unit k and its code follows (a forward branch to the start of a later sibling is a `br` to its
   * label); `prologue` runs inside all the labels, before the first unit's code. A loop unit is a WASM loop
   * whose prologue dispatches among its blocks (loopPrologue).
   */
  emitUnits(units, prologue) {
    const c = this.c, blocks = this.blocks;
    for (let k = units.length - 1; k >= 0; k--) units[k].label = c.block();
    prologue();
    for (const u of units) {
      c.end(); // u.label: the unit's code follows
      if (!u.loop) { this.emitBlock(blocks[u.first], u.first + 1 < blocks.length ? blocks[u.first + 1] : null); continue; }
      u.loopL = c.loop();
      this.emitUnits(u.children, () => this.loopPrologue(u));
      c.end(); // loop
    }
  }
  /**
   * Loop head: entered normally (fallthrough, forward branch to the header, back edge to the header) L_BLK
   * is -1 and control goes to the header; a dispatch into the loop (L_BLK = a block of the loop, set just
   * before the branch) is routed to the child holding it (see dispatchAmong).
   */
  loopPrologue(u) {
    const c = this.c;
    const normal = c.block();
    c.get(L_BLK).i32(0).lt_s().hint(true).br_if(normal);
    this.dispatchAmong(u.children, u.first, u.last, u, normal);
    c.end(); // normal: the header follows
  }
  /**
   * br_table on L_BLK (blocks first..last) to the sibling `units` holding them (children of loop `parent`, or
   * the top level): a nested loop's label with L_BLK unchanged, a block through a trampoline setting L_BLK to
   * -1 first — outside a dispatch L_BLK is always -1, so a loop head only tests its sign.
   */
  dispatchAmong(units, first, last, parent, def) {
    const c = this.c;
    const childOf = (j) => { const p = this.pathOf[j], i = parent ? p.indexOf(parent) : -1; return i + 1 < p.length ? p[i + 1] : this.blockUnit[j]; };
    const direct = units.filter((ch) => !ch.loop);
    const tramp = new Map();
    for (let k = direct.length - 1; k >= 0; k--) tramp.set(direct[k], c.block());
    const targets = [];
    for (let j = first; j <= last; j++) { const ch = childOf(j); targets.push(ch.loop ? ch.label : tramp.get(ch)); }
    c.get(L_BLK); if (first) c.i32(first).sub();
    c.br_table(targets, def);
    for (const ch of direct) { c.end(); c.i32(-1).set(L_BLK).br(ch.label); }
  }

  /**
   * Region chaining (target eip in L_TV): when the target is ordinary guest code (not an API
   * thunk), not the stop address, the budget is not exhausted and the target is already
   * translated (same hash table / probe sequence as the dispatcher in runtime.js), tail-call its
   * region with the live locals: registers and the lazy flags travel as parameters, only the x87
   * state (TOP, and the cached stack of an x87 region) goes through the state block. Falls
   * through (to the flush + return path) otherwise.
   */
  emitChain(flush = true) {
    const c = this.c;
    const noChain = c.block();
    // profiling translations count why a transition is not chained (PROF_OPS_BASE + NOCHAIN_PROF: thunk, stop, budget, miss)
    const why = (k) => { if (this.prof) c.i32(0).i32(0).i32load(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k).i32(1).add().i32store(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k); };
    c.get(L_ICOUNT).i32(0).le_s(); { const t = c.hint(false).if_(); why(2); c.br(noChain); c.end(); void t; }
    if (this.prof) { // (profiling translations: each reason apart, counted)
      // an API thunk: the dispatcher runs it (fast APIs in WASM, the others in JavaScript)
      c.get(L_TV).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u(); { const t = c.if_(); why(0); c.br(noChain); c.end(); void t; }
      // address 0 (a call through a null pointer) is the key of the empty hash entries: never looked up (the dispatcher
      // raises the access violation)
      c.get(L_TV).eqz(); { const t = c.hint(false).if_(); why(3); c.br(noChain); c.end(); void t; }
    } else {
      // the same two tests in one compare: address 0 (wrapping to 0xffffffff) and every address from the thunks up (the
      // thunks — the dispatcher runs them —, the emulator's private area and past the 2 GiB guest space: no translated
      // code there, the hash probes would miss) leave through the dispatcher
      c.get(L_TV).i32(1).sub().i32(THUNK_BASE - 1).ge_u(); { const t = c.if_(); c.br(noChain); c.end(); void t; }
    }
    c.get(L_TV).get(L_STATE).i32load(ST.STOP_AT).eq(); { const t = c.hint(false).if_(); why(1); c.br(noChain); c.end(); void t; }
    // hash lookup: home slot in L_T2 (L_T3 in the shared exit tail, where L_T2 holds the exit kind and the x87 stack
    // was already written back), L_TA = the offset from JIT_HASH_BASE of the entry of the probe being tested (the base in
    // the loads' static offset: one addition less per probe; the home slot needs no mask, it is below 2^JIT_HASH_BITS)
    const found = c.block(), home = flush ? L_T2 : L_T3;
    c.get(L_TV).i32(0x9e3779b1 | 0).mul().i32(32 - JIT_HASH_BITS).shr_u().set(home);
    for (let p = 0; p < HASH_PROBES; p++) {
      c.get(home); if (p) c.i32(p).add().i32((1 << JIT_HASH_BITS) - 1).and();
      c.i32(HASH_ENTRY).mul().tee(L_TA);
      c.i32load(JIT_HASH_BASE).get(L_TV).eq().br_if(found);
    }
    why(3);
    c.br(noChain);
    c.end(); // found
    if (this.prof) { c.get(L_TA).i32load(JIT_HASH_BASE + 4).i32(this.opts.fnIdx ?? -1).eq(); const i = c.if_(); this.count(PF.chainSelf); c.else_(); this.count(PF.chainOther); c.end(); void i; if (this.usesX87) this.count(PF.chainFromX87); }
    // EIP of the region being entered: a trap inside the chained callee reports the callee's
    // entry (same imprecision as the dispatcher path); registers are not written back
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    if (flush) { this.flushFpu(true); this.flushXmm(); } // (else written back before: the shared exit tail)
    if (this.opts.countChains !== false) c.get(L_STATE).get(L_STATE).i32load(ST.TRANSITIONS).i32(1).add().i32store(ST.TRANSITIONS); // (stats)
    c.get(L_TA).i32load(JIT_HASH_BASE + 8); // block index in the target region
    for (let i = L_STATE; i < L_FIRST_DECLARED; i++) c.get(i);
    c.get(L_TA).i32load(JIT_HASH_BASE + 4).return_call_indirect(REGION_TYPE, 0);
    c.end(); // noChain
  }

  // ------------------------------------------------------------------ state <-> locals
  /** Reload every cached local from the state block (after JS may have changed it). */
  reloadAll() {
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_STATE).i32load(ST.GPR + 4 * i).set(L_REG + i);
    c.get(L_STATE).i32load(ST.EFLAGS).set(L_EFLAGS);
    c.get(L_STATE).i32load(ST.LZ_OP).set(L_LZOP);
    c.get(L_STATE).i32load(ST.LZ_RES).set(L_LZRES);
    c.get(L_STATE).i32load(ST.LZ_SRC1).set(L_LZA);
    c.get(L_STATE).i32load(ST.LZ_SRC2).set(L_LZB);
    if (this.usesFs) c.get(L_STATE).i32load(ST.FS_BASE).set(L_FS);
    if (this.usesX87) { c.get(L_STATE).i32load8u(ST.FPU_TOP).set(L_TOP); this.loadX87(); }
    this.loadXmm();
  }
  /** Load the XMM registers of xmmMask into their locals. */
  loadXmm() {
    const c = this.c;
    for (let r = 0; r < 8; r++) if (this.xmmMask & (1 << r)) c.get(L_STATE).v128load(ST.XMM + 16 * r).set(L_XMM0 + r);
    this.xsValid = this.xsDirty = this.xdValid = this.xdDirty = 0; // (the shadows are older than the reloaded registers)
  }
  /** Write the cached XMM registers back to the state block. */
  flushXmm() {
    const c = this.c;
    for (let r = 0; r < 8; r++) if (this.xmmMask & (1 << r)) c.get(L_STATE).get(L_XMM0 + r).v128store(ST.XMM + 16 * r);
  }
  /** Write the guest registers, EFLAGS and the lazy flag state back to the state block. */
  flushRegs() {
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_STATE).get(L_REG + i).i32store(ST.GPR + 4 * i);
    c.get(L_STATE).get(L_EFLAGS).i32store(ST.EFLAGS);
    c.get(L_STATE).get(L_LZOP).i32store(ST.LZ_OP);
    c.get(L_STATE).get(L_LZRES).i32store(ST.LZ_RES);
    c.get(L_STATE).get(L_LZA).i32store(ST.LZ_SRC1);
    c.get(L_STATE).get(L_LZB).i32store(ST.LZ_SRC2);
  }
  flushAll(exit = false) {
    this.flushRegs();
    this.flushFpu(exit);
    this.flushXmm();
  }

  // ------------------------------------------------------------------ x87 stack cache
  // Inside a block the x87 handlers do not move the locals on push/pop: they keep a static shift
  // (`stShift`: the block's planned entry shift at its entry, see x87EntryPlan, usually 0) such that
  // ST(i) lives in local L_ST0 + ((i + stShift) & 7) and the real TOP is (L_TOP + stShift) & 7. The
  // shift is materialized (x87Normalize: one rotation of the locals, one update of L_TOP) only where
  // the code leaves the block: exits, fallbacks, TOP resets (to shift 0), branches to other blocks (to
  // the target's planned shift). A balanced block (fld ... fstp) never moves a local.
  /** Local holding ST(i) under the pending static shift. */
  stLocal(i) { return L_ST0 + ((i + this.stShift) & 7); }
  /** Bit of ST(i) in L_FTW under the pending static shift. */
  stTagBit(i) { return 1 << ((i + this.stShift) & 7); }
  /** Push the physical slot number of ST(i): (L_TOP + stShift + i) & 7 (L_TOP is always 0..7). */
  pushStPhys(i) { const c = this.c; const k = (this.stShift + i) & 7; c.get(L_TOP); if (k) c.i32(k).add().i32(7).and(); }
  /**
   * Materialize the pending shift: write the f32 shadows back (and the XMM lane-0 shadows), rotate the
   * locals so that L_ST0+i holds ST(i) again (L_ST0+((i+target)&7) for a branch to a block planned with
   * that entry shift), rotate the logical tag word the same way and make L_TOP the real TOP (minus the
   * target shift). Returns the static state that was pending (shift, f32 mask): a conditional exit path
   * restores it afterwards (x87Restore) so that the fallthrough path keeps its unrotated locals and f32
   * values. Code emitted after it on the same path sees the target shift and no shadow: a second
   * normalization there (the budget exit of a back edge) must not write the shadows again, into locals
   * the rotation has moved.
   */
  x87Normalize(target = 0) {
    const saved = { shift: this.stShift, f32: this.f32Mask, g24: this.g24Mask, tagSet: this.tagSet, tagClr: this.tagClr, xs: this.xsDirty, xd: this.xdDirty };
    this.materializeF32();
    this.f32Mask = 0;
    this.g24Mask = 0; // (the locals rotate: what was known of their values is dropped, as the f32 shadows are)
    this.xmmShadowSync(this.xsDirty); // (XMM lane-0 shadows: the same discipline, see xsValid)
    this.xmmShadowSync64(this.xdDirty);
    this.xsDirty = this.xdDirty = 0;
    this.applyTags();
    // `target`: a direct transfer to a block planned to be entered with that shift (x87EntryPlan) rotates by the
    // difference only; everything else (exits, fallbacks, dispatches, handlers needing the real TOP) targets 0
    this.x87Rotate((this.stShift - target) & 7);
    this.stShift = target;
    return saved;
  }
  /**
   * Rotate the x87 locals by the static amount d: L_ST0+i <- L_ST0+((i+d)&7), the tag word the same way, L_TOP += d
   * (the pending shift is d lower afterwards).
   */
  x87Rotate(d) {
    if (!d) return;
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_ST0 + ((i + d) & 7)); // through the operand stack: no temporary
    for (let i = 7; i >= 0; i--) c.set(L_ST0 + i);
    c.get(L_FTW).i32(d).shr_u().get(L_FTW).i32(8 - d).shl().or().i32(0xff).and().set(L_FTW); // rotr8 by d
    c.get(L_TOP).i32(d).add().i32(7).and().set(L_TOP);
  }
  /** Planned x87 shift at the entry of block k (0 without a plan). */
  planOf(k) { return this.x87Plan ? this.x87Plan[k] : 0; }
  /**
   * Region prologue of a planned x87 region (L_TOP = TOP): L_TOP -= the entry block's planned shift, so that the
   * stack locals loaded next (loadX87) are those of a block entered with that shift. Entries at the region's entry
   * block (never planned) skip the lookup.
   */
  x87EntryTop() {
    if (!this.x87Plan) return;
    const c = this.c, plan = this.x87Plan;
    c.get(L_BLK).i32(this.x87EntryIdx).ne();
    const i = c.if_();
    c.i32(0);
    for (let k = 0; k < plan.length; k++) if (plan[k]) c.set(L_T2).i32(plan[k]).get(L_T2).get(L_BLK).i32(k).eq().select();
    c.set(L_T2);
    c.get(L_TOP).get(L_T2).sub().i32(7).and().set(L_TOP);
    c.end(); void i;
  }
  /**
   * x87Normalize for a branch to an exit block (exitTo / exitToStack / exitCode): the f32 and XMM shadows written back
   * and the tag changes applied, but no rotation of the stack locals. Local L_ST0+k holds physical register
   * (L_TOP + k) & 7 whatever the pending shift (ST(i) = L_ST0+((i+shift)&7), physical (L_TOP+shift+i)&7), and so does
   * bit k of L_FTW: the exit block's flush writes the same registers and tags from the unrotated locals; only TOP
   * differs, (L_TOP + shift) & 7, the shift travelling in L_XSH (flushFpu(true)). An exit used to rotate the eight
   * locals, the tag word and L_TOP (~30 operations, and as many moves into the exit block's merge in machine code) —
   * every exit in the middle of a block that pushed: the step exits of x87 arithmetic, SMC checks, budget exits.
   * Returns the pending static state, as x87Normalize (the caller restores it after the exit's branch).
   */
  x87ExitState() {
    // (g24: the narrow values known on the path that continues past the exit — the locals are not rotated here)
    const saved = { shift: this.stShift, f32: this.f32Mask, g24: this.g24Mask, tagSet: this.tagSet, tagClr: this.tagClr, xs: this.xsDirty, xd: this.xdDirty };
    if (this.x87ExitRotate) { this.x87Normalize(); return saved; } // (measurement: the earlier exits)
    this.materializeF32();
    this.f32Mask = 0;
    this.xmmShadowSync(this.xsDirty);
    this.xmmShadowSync64(this.xdDirty);
    this.xsDirty = this.xdDirty = 0;
    this.applyTags();
    if (this.stShift) this.c.i32(this.stShift).set(L_XSH);
    return saved;
  }
  /** Back to the static x87 state returned by x87Normalize (after an exit emitted on a conditional path). */
  x87Restore(saved) { this.stShift = saved.shift; this.f32Mask = saved.f32; this.g24Mask = saved.g24; this.tagSet = saved.tagSet; this.tagClr = saved.tagClr; this.xsDirty = saved.xs; this.xdDirty = saved.xd; }
  // ---- XMM lane-0 shadows. Scalar single-precision code (MOVSS / ADDSS / MULSS / CVTSI2SS / COMISS...) keeps lane 0
  // of an XMM register in an f32 local L_XS0+r: xsValid bit r = the shadow holds lane 0; xsDirty bit r (a subset) =
  // the v128 local's lane 0 is stale. A chain of scalar operations then runs on f32 values (the host's mulss /
  // addss on registers) without re-inserting every result into the vector (an insertps on each operation's
  // dependency chain) nor extracting operands; the lane is put back once, where the block is left (every exit,
  // branch and fallback goes through x87Normalize, which writes the dirty shadows back and, on a conditional exit
  // path, restores the mask afterwards) or before another instruction names the register (xmmShadowRelease).
  // Both masks are 0 at block entry and after the locals are reloaded from the state block (loadXmm).
  // Scalar double-precision code (MOVSD / MOVLPD / ADDSD / MULSD / CVTSI2SD / COMISD...) keeps the low qword in an f64
  // shadow L_XD0+r the same way (xdValid / xdDirty): the f64x2.replace_lane of every result (a blend on the
  // dependency chain, plus register copies around it) is gone. A register never has both kinds valid: an
  // instruction of one family writes the other family's shadows of its operands back (release) before it runs.
  /** v128 local of XMM r <- its f32 shadow in lane 0, for every r of `mask` (the masks unchanged). */
  xmmShadowSync(mask) {
    const c = this.c;
    for (let r = 0; mask; mask >>= 1, r++) if (mask & 1) c.get(L_XMM0 + r).get(L_XS0 + r).f32x4replacelane(0).set(L_XMM0 + r);
  }
  /** v128 local of XMM r <- its f64 shadow in the low qword, for every r of `mask` (the masks unchanged). */
  xmmShadowSync64(mask) {
    const c = this.c;
    for (let r = 0; mask; mask >>= 1, r++) if (mask & 1) c.get(L_XMM0 + r).get(L_XD0 + r).f64x2replacelane(0).set(L_XMM0 + r);
  }
  /**
   * Before an instruction outside XMM_SHADOW_OPS (f32: !xsOK) / XMM_SHADOW64_OPS (f64: !xdOK): its XMM operands'
   * shadows of that kind written back and dropped.
   */
  xmmShadowRelease(insn, f32, f64) {
    let m = 0;
    for (const o of insn.ops) if (o.t === OT.XMM) m |= 1 << (o.r & 7);
    if (f32 && (m & this.xsValid)) { this.xmmShadowSync(m & this.xsDirty); this.xsValid &= ~m; this.xsDirty &= ~m; }
    if (f64 && (m & this.xdValid)) { this.xmmShadowSync64(m & this.xdDirty); this.xdValid &= ~m; this.xdDirty &= ~m; }
  }
  /**
   * Tag word changes of the block are static (tagSet / tagClr: bits of L_FTW in its current order, i.e.
   * stTagBit positions): a push marks its slot valid and a pop empty without code; the pending changes are
   * applied in one operation where L_FTW is read or the block is left (x87Normalize), or before a
   * conditional tag update (FCMOVcc).
   */
  applyTags() {
    const set = this.tagSet, clr = this.tagClr;
    if (!set && !clr) return;
    const c = this.c;
    c.get(L_FTW);
    if (clr) c.i32(~clr & 0xff).and();
    if (set) c.i32(set).or();
    c.set(L_FTW);
    this.tagSet = this.tagClr = 0;
  }
  /**
   * f32Mask bit k: the value of x87 local L_ST0+k lives in its f32 shadow L_S32+k (an exact float; the f64
   * local is stale). Every exit, branch and fallback goes through x87Normalize, which first writes the
   * shadows back (promote, exact); an exit on a conditional path restores the mask afterwards (the
   * fallthrough keeps its f32 values), and at the end of a block the mask is dropped anyway (0 at block entry).
   */
  materializeF32() {
    for (let m = this.f32Mask, k = 0; m; m >>= 1, k++) if (m & 1) this.c.get(L_S32 + k).f64promote().set(L_ST0 + k);
  }
  /** L_FTW <- tag word of the state block rotated to L_TOP-relative order (bit j = slot (L_TOP+j)&7). */
  loadX87Tags() {
    const c = this.c;
    // (the byte doubled, then one variable shift: the same bits as (tw >> TOP | tw << (8 - TOP)) & 0xff, with one shift by
    // a run-time amount instead of two — x64 takes it in CL — on every x87 region entry)
    c.get(L_STATE).i32load16u(ST.FPU_TW).tee(L_T3).get(L_T3).i32(8).shl().or().get(L_TOP).shr_u().i32(0xff).and().set(L_FTW);
  }
  /** state block tag word <- L_FTW rotated back to physical order (shift 0). */
  flushX87Tags() {
    const c = this.c;
    // (rotl8 by TOP as one variable shift of the doubled byte: L_FTW holds 8 bits)
    c.get(L_STATE).get(L_FTW).get(L_FTW).i32(8).shl().or().get(L_TOP).shl().i32(8).shr_u().i32(0xff).and().i32store16(ST.FPU_TW);
  }
  /** Push the address of the physical slot of ST(i) given L_T3 = L_TOP << 3 (ST.FPR added by the memarg). */
  stSlot(i) { const c = this.c; c.get(L_STATE).get(L_T3); if (i) c.i32(8 * i).add().i32(63).and(); c.add(); }
  /** L_ST0..7 <- FPR[(L_TOP+i)&7] (shift 0, L_TOP current; clobbers L_T3). */
  loadX87Regs() {
    const c = this.c, n = c.trackN;
    c.get(L_TOP).i32(3).shl().set(L_T3);
    c.trackN = 0; // (the cache's own loads and stores are not uses: see x87LiveSites)
    for (let i = 0; i < 8; i++) { const at = c.len; this.stSlot(i); c.f64load(ST.FPR).set(L_ST0 + i); this.x87Sites.push(at, c.len, i, 0); }
    c.trackN = n;
  }
  /** FPR[(L_TOP+i)&7] <- L_ST0..7 (shift 0; clobbers L_T3). */
  flushX87Regs() {
    const c = this.c, n = c.trackN;
    c.get(L_TOP).i32(3).shl().set(L_T3);
    c.trackN = 0;
    for (let i = 0; i < 8; i++) { const at = c.len; this.stSlot(i); c.get(L_ST0 + i).f64store(ST.FPR); this.x87Sites.push(at, c.len, i, 1); }
    c.trackN = n;
  }
  /**
   * Once the body is emitted (opts.x87Live): the loads and stores of the stack locals the body never touches become
   * `nop`s (the same length: no offset recorded in the body moves — branch hints, the alt slot, visit flags). Local
   * L_ST0+k always holds physical register (L_TOP + k) & 7 for the current L_TOP: the locals only move between each
   * other through x87Rotate, whose gets and sets mark all eight, and L_TOP changes otherwise only where the cache is
   * written back and reloaded (fallbacks, FLDENV / FRSTOR, TOP resets) — so a local no instruction reads or writes holds
   * nothing the region needs, and the register's copy in the state block stays the right one. Fewer loads at the
   * entry and stores at the exits (every chained transition of an x87 region), and fewer live values for TurboFan.
   * The stores of the locals the body reads but never sets go too (opts.x87LiveStores): such a local holds what the
   * cache loaded from its register — at the entry or at a reload, after which the state block is the same — so writing
   * it back changes nothing (a region consuming a value its caller left in ST(0), an FSTP of it: a load, no store).
   */
  x87LiveSites() {
    const c = this.c, used = c.used, s = this.x87Sites;
    const stored = (this.opts.x87LiveStores ?? JIT_DEFAULTS.x87LiveStores) ? c.written : used;
    c.trackN = 0;
    this.stats.x87Live = used;
    if (used === 0xff && stored === 0xff) return;
    for (let j = 0; j < s.length; j += 4) if (!(((s[j + 3] ? stored : used) >> s[j + 2]) & 1)) c.buf.fill(0x01, s[j], s[j + 1]);
  }
  /** x87 region entry / after the interpreter ran: stack values, tag word and PC/RC bits from the state block. */
  loadX87() {
    this.loadX87Tags();
    this.loadX87Fpc();
    this.loadX87Regs();
  }
  /** L_FPC <- the control word's PC/RC bits; L_SW <- the status word (opts.swLocal). */
  loadX87Fpc() { this.c.get(L_STATE).i32load16u(ST.FPU_CW).i32(0xf00).and().set(L_FPC); if (this.swLocal) this.c.get(L_STATE).i32load16u(ST.FPU_SW).set(L_SW); }
  /**
   * Write the cached x87 state back (shift 0): TOP always, the stack values, tag word and status word (opts.swLocal) in
   * x87 regions. `exit`: in an exit block, where the branch left a pending shift in L_XSH (x87ExitState):
   * TOP = (L_TOP + L_XSH) & 7.
   */
  flushFpu(exit = false) {
    const c = this.c;
    if (!this.usesX87) return; // (other regions never change TOP)
    this.flushX87Regs(); this.flushX87Tags();
    c.get(L_STATE).get(L_TOP); if (exit && !this.x87ExitRotate) c.get(L_XSH).add().i32(7).and(); c.i32store8(ST.FPU_TOP);
    if (this.swLocal) c.get(L_STATE).get(L_SW).i32store16(ST.FPU_SW);
  }
  /** push the x87 status word: its local (opts.swLocal, x87 regions), else the state block's */
  swGet() { if (this.swLocal) this.c.get(L_SW); else this.c.get(L_STATE).i32load16u(ST.FPU_SW); }
  /** x87 status word <- the i32 on the stack (16 bits) */
  swSet() { const c = this.c; c.set(L_SW); if (!this.swLocal) c.get(L_STATE).get(L_SW).i32store16(ST.FPU_SW); }
  /**
   * TOP <- 0 (MMX access, EMMS, FNINIT). In an x87 region the logical locals must follow the
   * physical registers: when TOP is not already 0 the values are written back with the old TOP
   * and reloaded with TOP = 0 (a rotation of the 8 locals by a run-time amount).
   */
  x87SetTop0() {
    const c = this.c;
    if (!this.usesX87) { c.i32(0).set(L_TOP); return; }
    this.x87Normalize();
    c.get(L_TOP);
    const i = c.if_();
    this.flushX87Regs(); this.flushX87Tags();
    c.i32(0).set(L_TOP);
    this.loadX87Regs(); this.loadX87Tags();
    c.end(); void i;
    this.f32Mask = this.g24Mask = 0; // the f64 locals were written back (x87Normalize) and possibly reloaded
  }

  // ------------------------------------------------------------------ exits & jumps
  /**
   * Charge n instructions to the budget without checking it: the dispatcher (or the chain guard)
   * checks ST.ICOUNT at the next region entry, so a loop made only of cross-region edges still
   * ends with a time slice.
   */
  count(k) {
    if (!this.prof) return;
    this.c.get(L_STATE).get(L_STATE).i32load(profOffset(k)).i32(1).add().i32store(profOffset(k));
    // flags helper calls are also counted per x86 mnemonic (JIT_PROF_OPS: opcode -> counter at PROF_OPS_BASE)
    if (k >= PF.flagsNull && k <= PF.flagsSlowArm) {
      const a = PROF_OPS_BASE + 4 * (this.curOp ?? 0);
      this.c.i32(0).i32(0).i32load(a).i32(1).add().i32store(a);
    }
  }
  charge(n) {
    if (n > 0) this.c.get(L_ICOUNT).i32(n).sub().set(L_ICOUNT);
  }
  // Every exit / branch first materializes the x87 static shift (x87Normalize) and restores it
  // afterwards: an exit emitted inside an `if` (SMC check, budget, JCC) must not alter the state
  // the fallthrough path continues with.
  /** exit the region jumping to the eip on the stack (charges the block's instructions so far) */
  /** Measurement (see SITE_PROF): count an exit of kind `kind` at `addr`, target in L_TV. */
  siteProf(addr, kind) {
    if (!globalThis.ORTHROS_SITE_PROF || this.opts.blockCounts) return;
    const key = kind + ':' + addr;
    let slots = SITE_SLOTS.get(this.mem); if (!slots) SITE_SLOTS.set(this.mem, slots = new Map());
    let a = slots.get(key);
    if (a === undefined) { a = allocBlockCounters(this.mem, 3); if (a < 0) return; slots.set(key, a); SITE_PROF.push([addr, kind, a]); }
    const c = this.c;
    c.i32(0).i32(0).i32load(a).i32(1).add().i32store(a);
    c.i32(0).i32load(a + 4).get(L_TV).ne();
    const i = c.if_(); c.i32(0).i32(0).i32load(a + 8).i32(1).add().i32store(a + 8); c.i32(0).get(L_TV).i32store(a + 4); c.end(); void i;
  }
  exitToStack() { this.c.set(L_TV); this.charge(this.insnIdx); const s = this.x87ExitState(); this.c.br(this.exitJmpL); this.x87Restore(s); }
  exitTo(eip, n = this.insnIdx) { this.count(PF.exit); this.c.i32(eip).set(L_TV); this.siteProf(eip, (this.limited?.has(eip) ? 'exitLim' : 'exit') + (this.inCall ? 'Call' : '')); this.charge(n); const s = this.x87ExitState(); this.c.br(this.exitJmpL); this.x87Restore(s); }
  exitCode(code, eip, arg) {
    const c = this.c;
    if (arg !== undefined) c.get(L_STATE).i32(arg).i32store(ST.EXIT_ARG);
    c.i32(eip).set(L_TV).i32(code).set(L_T2);
    const s = this.x87ExitState(); c.br(this.exitCodeL); this.x87Restore(s);
  }
  /** address on the stack -> 1 when outside [NULL_PAGE_END, USER_END) (one subtraction and an unsigned compare) */
  unmappedTest() { this.c.i32(-NULL_PAGE_END).add().i32(USER_END - NULL_PAGE_END).ge_u(); }
  /**
   * Windows semantics for the null page (nullpage.js): when an access of the block's plan for `insn` (planNullChecks:
   * single operands and groups) is in the first 64 KiB or past the user address space, leave the region before the
   * instruction; the interpreter executes it and raises the access violation with the exact state. A subtraction, a
   * compare and a branch never taken per check (the address computation is shared with the handler's by the WebAssembly
   * compiler). String operands: the register (ESI / EDI), not with a REP prefix and a zero count (nothing accessed).
   */
  nullCheck(insn, plan) {
    const c = this.c;
    for (let i = 0; i < plan.length; i++) {
      const { k, g } = plan[i];
      if (g) {
        // (a group: its address at displacement lo inside [NULL_PAGE_END, USER_END - (hi - lo)) — [null - 4] and a
        // register holding garbage past 2 GiB included, which would otherwise trap)
        this.ea({ ...g.o, disp: (g.lo - NULL_PAGE_END) | 0, seg: -1 });
        c.i32(USER_END - NULL_PAGE_END - (g.hi - g.lo)).ge_u();
      } else if (k.str) {
        c.get(L_REG + k.o.base); if (insn.adsize === 2) c.i32(0xffff).and();
        this.unmappedTest();
        if (insn.rep) { c.get(L_REG + 1); if (insn.adsize === 2) c.i32(0xffff).and(); c.i32(0).ne().and(); }
      } else { this.ea(k.o); this.unmappedTest(); }
      if (i) c.or();
    }
    this.count(PF.nullCheck);
    const j = c.hint(false).if_();
    this.stepExit(insn);
    c.end(); void j;
  }
  /**
   * Leave the region before `insn` (none of its effects applied) for the interpreter to execute it: the
   * rare cases whose exact handling would otherwise put a call in hot code (V8 keeps no register across
   * a call, so a call even on a cold path costs spills on the hot one). Charges the instructions before it.
   */
  stepExit(insn) {
    this.charge(this.insnIdx - 1);
    this.exitCode(EXIT_STEP, insn.addr);
  }
  /**
   * Every block of a region specialized for an x87 mode runs under that mode: the region entry checks it, and an
   * in-region transfer made where the mode is not statically known (after an FLDCW/FNINIT/FRSTOR... of the block)
   * checks it too — when it differs, the transfer leaves the region, whose entry then selects (or adds) the version
   * for the current mode. The usual pattern, a function restoring the caller's control word before returning,
   * passes the check and keeps its loops specialized (they used to be translated for a mode tested at run time,
   * with kernel calls in every x87 operation, as soon as a mode writer could reach them).
   */
  fpuModeGuard(target, n) {
    if (this.fpcAssume === null || this.fpcStatic === this.fpcAssume) return;
    const c = this.c;
    c.get(L_FPC).i32(this.fpcAssume).ne();
    const g = c.hint(false).if_();
    this.exitTo(target, n);
    c.end(); void g;
  }
  /**
   * An exit resuming at an address where no arithmetic flag is live (`live`: the flags read there before being written,
   * from the region's liveness — 0 when every path from it writes them all first) leaves no lazy operation: the lazy op
   * and its operands are written as zeros instead of their values. Otherwise the lazy values of every instruction
   * before such an exit stay live up to it — around a whole loop for the time-slice exit of its back edge, which is
   * where they cost registers (V8 keeps them in registers or spill slots across the loop only for that cold path).
   * What the resumed code reads is unchanged: it writes the flags before reading them; the arithmetic bits left in
   * EFLAGS meanwhile are those of an older instruction, which only an exception raised in between (its CONTEXT) could
   * see, as for the flags regionFlagsLiveness already leaves uncomputed. Only on the exit path (inside the exit's
   * conditional): the fallthrough keeps its lazy state.
   * Not for SMC exits: the liveness was computed on the bytes translated, and the store that takes that exit may have
   * just rewritten the code the proof walked (a JMP patched into a JCC reads the flags the exit would have dropped).
   */
  deadFlagsExit(live) {
    if (live !== 0 || this.opts.deadExitFlags === false) return;
    const c = this.c;
    c.i32(0).set(L_LZOP).i32(0).set(L_LZRES).i32(0).set(L_LZA).i32(0).set(L_LZB);
  }
  /**
   * Budget check: subtract n and exit TIMESLICE (to eip) when exhausted. `live`: the flags live at eip (see
   * deadFlagsExit).
   */
  budget(n, eip, live = FL_ALL) {
    const c = this.c;
    c.get(L_ICOUNT).i32(n).sub().tee(L_ICOUNT).i32(0).le_s();
    const i = c.hint(false).if_();
    this.deadFlagsExit(live);
    this.exitCode(EXIT.TIMESLICE, eip);
    c.end(); void i;
  }
  /** Jump to a guest address: intra-region branch or exit. `n` instructions consumed for the budget. */
  jumpTo(target, n) {
    const b = this.byEip.get(target);
    if (!b) { this.exitTo(target, n); return; }
    const c = this.c;
    this.fpuModeGuard(target, n);
    const t = b.index, sp = this.pathOf[this.cur], tp = this.pathOf[t];
    let d = 0; // loops holding both
    while (d < sp.length && d < tp.length && sp[d] === tp[d]) d++;
    const s = this.x87Normalize(this.planOf(t)); // (blocks are entered with their planned shift: see x87EntryPlan)
    // the budget is checked on the transfers to an address no higher than the block's (every cycle has one): those
    // that are backward in address order, whatever the emission order (opts.layout) — so that time slices end at the
    // same points as in address order, as do the threads' interleavings
    const addrBack = b.eip <= this.blocks[this.cur].eip;
    if (t > this.cur) {
      // forward: no budget check (every cycle contains a backward edge, which checks it). The unit holding t
      // among the children of the innermost common loop (or the top level) is a later sibling of the one
      // holding the source: its label is in scope; a loop entered elsewhere than at its header dispatches
      this.count(PF.forward);
      if (addrBack) this.budget(n, target, b.flagsIn ?? FL_ALL); else this.charge(n);
      const ct = d < tp.length ? tp[d] : this.blockUnit[t];
      if (!ct.loop || ct.first === t) c.br(ct.label);
      else { this.count(PF.dispatch); this.count(PF.dispatchFwdLoop); c.i32(t).set(L_BLK).br(ct.label); }
    } else {
      this.count(PF.backward);
      if (addrBack || !this.layout) this.budget(n, target, b.flagsIn ?? FL_ALL); else this.charge(n);
      const common = d > 0 ? sp[d - 1] : null;
      if (common) { if (t !== common.first) { this.count(PF.dispatch); this.count(PF.dispatchBackLoop); c.i32(t).set(L_BLK); } c.br(common.loopL); }
      else { this.count(PF.dispatch); this.count(this.inRet ? PF.dispatchRetTop : PF.dispatchBackTop); this.dispatchUsed = true; c.i32(t).set(L_BLK).br(this.dispatchL); }
    }
    this.x87Restore(s);
  }

  // ------------------------------------------------------------------ registers & operands
  loadReg(size, r) {
    const c = this.c;
    if (size === 4) { c.get(L_REG + r); return; }
    if (size === 2) { c.get(L_REG + r).i32(0xffff).and(); return; }
    if (r >= 4) c.get(L_REG + r - 4).i32(8).shr_u().i32(0xff).and(); else c.get(L_REG + r).i32(0xff).and();
  }
  /** store the value in local `src` into register r (size-aware) */
  storeRegFrom(size, r, src) {
    const c = this.c;
    if (size === 4) { c.get(src).set(L_REG + r); return; }
    if (size === 2) { c.get(L_REG + r).i32(-0x10000).and().get(src).i32(0xffff).and().or().set(L_REG + r); return; }
    if (r >= 4) c.get(L_REG + r - 4).i32(~0xff00).and().get(src).i32(0xff).and().i32(8).shl().or().set(L_REG + r - 4);
    else c.get(L_REG + r).i32(-0x100).and().get(src).i32(0xff).and().or().set(L_REG + r);
  }
  /** push the effective address of memory operand o */
  ea(o) {
    const c = this.c;
    let first = true;
    if (o.base >= 0) { c.get(L_REG + o.base); first = false; }
    if (o.index >= 0) { c.get(L_REG + o.index); if (o.scale > 1) c.i32(Math.log2(o.scale)).shl(); if (!first) c.add(); first = false; }
    if (o.disp !== 0 || first) { c.i32(o.disp); if (!first) c.add(); first = false; }
    if (o.a16) c.i32(0xffff).and();
    if (o.seg === SEG.FS) c.get(L_FS).add();
    else if (o.seg === SEG.GS) c.get(L_STATE).i32load(ST.GS_BASE).add();
  }
  /** address on stack -> value */
  loadMem(size) {
    const c = this.c;
    if (this.spec) { // (an if-converted arm: see emitIfcvt)
      if (this.specCheck) { // (a null-page load on the path taken: noted — it reads address 0 too — and the arms' effects undone after them, see emitIfcvt)
        c.tee(L_NCK); this.unmappedTest(); c.get(L_IC); if (this.spec === 2) c.eqz();
        c.and().get(L_SPECF).or().set(L_SPECF);
        c.get(L_NCK).i32(0).get(L_IC); if (this.spec === 2) c.eqz();
        c.get(L_NCK); this.unmappedTest(); c.eqz().and().select();
      } else { c.i32(0).get(L_IC); if (this.spec === 2) c.eqz(); c.select(); }
    }
    if (size === 4) c.i32load(0, 0); else if (size === 2) c.i32load16u(0); else c.i32load8u(0);
  }
  /** (addr, value) on stack -> store */
  storeMem(size) {
    const c = this.c;
    if (size === 4) c.i32store(0, 0); else if (size === 2) c.i32store16(0); else c.i32store8(0);
  }
  /** push operand value (zero-extended to 32) */
  loadOp(o) {
    const c = this.c;
    switch (o.t) {
      case OT.REG: this.loadReg(o.size, o.r); return;
      case OT.MEM: this.ea(o); this.loadMem(o.size); return;
      case OT.IMM: c.i32(o.size === 4 ? o.v | 0 : o.v & MASK[o.size]); return;
      case OT.SEG: c.get(L_STATE).i32load16u(ST.SEG + 2 * o.r); return;
    }
    throw new Error('loadOp: bad operand');
  }
  /** load a memory operand's EA into L_TA (for read-modify-write) */
  eaTo(o) { this.ea(o); this.c.set(L_TA); }
  /** store local `src` to operand o; for MEM operands the EA must already be in L_TA */
  storeOpFrom(o, src, insn) {
    const c = this.c;
    if (o.t === OT.REG) { this.storeRegFrom(o.size, o.r, src); return; }
    if (o.t === OT.MEM) { c.get(L_TA).get(src); this.storeMem(o.size); this.smcCheck(insn); return; }
    throw new Error('storeOp: bad operand');
  }
  /**
   * Page number on the stack -> a value that is non-zero iff the page's SMC map byte is (translated code on the page
   * or the next one, or a watch). The byte is shifted to the top of the word rather than tested directly: V8
   * (TurboFan, x64) turns `if (i32.load8_u ...)` into a movzx load, kept for its out-of-bounds trap, plus a
   * `cmpb [mem], 0` that reads the byte again — two loads per check where the shift leaves one (movzx ; shl ; jnz).
   * The check follows every store not addressed by ESP (tools/memop-bench.mjs, a `mov [edi+4], eax` over an empty
   * loop: 0.63 -> 0.37 ns per store, 0.15 without any check).
   * `shift` 30 keeps SMC_CODE | SMC_WATCH only (the byte's other bits leave the word).
   */
  smcFlag(shift = 24) { this.c.i32load8u(SMC_MAP_BASE).i32(shift).shl(); }
  /**
   * After a string store (MOVS/STOS, single or repeated) from the EDI saved in local `start` to the current
   * EDI, either direction: exit with SMC (the instruction completed, EXIT_LEN = the range length) when a page
   * of the range holds translated code.
   */
  smcRange(start, insn) {
    if (!this.smc) return;
    const c = this.c;
    c.get(start).get(L_REG + 7).ne();
    const any = c.if_();
    c.get(start).get(L_REG + 7).get(start).get(L_REG + 7).lt_u().select().i32(4).sub().set(L_TA); // lo (an element either side)
    c.get(start).get(L_REG + 7).get(start).get(L_REG + 7).gt_u().select().i32(4).add().set(L_T5); // hi
    c.get(L_TA).i32(12).shr_u().set(L_TV);
    const done = c.block(); const lp = c.loop();
    c.get(L_TV); this.smcFlag(30); // (every page of the range is tested: SMC_NEXT is not needed)
    const hit = c.hint(false).if_();
    c.get(L_STATE).get(L_TA).i32store(ST.EXIT_ARG); c.get(L_STATE).get(L_T5).get(L_TA).sub().i32store(ST.EXIT_LEN);
    this.exitCode(EXIT.SMC, insn.next); // (the lazy state kept whole: see deadFlagsExit)
    c.end(); void hit;
    c.get(L_TV).i32(1).add().tee(L_TV).i32(12).shl().get(L_T5).lt_u().br_if(lp);
    c.end(); c.end(); void done;
    c.end(); void any;
  }
  /**
   * After a `bytes`-wide store through L_TA (default: the size of the instruction's memory operand): exit with SMC
   * when the store wrote a page holding translated code (or a watched page) — one map byte read on the hot path, the
   * byte of the store's first page, whose SMC_NEXT bit tells the next page holds code: only then (a rare, cold path)
   * does the store's end decide, so an unaligned store crossing into a code page is caught too (it used to be only
   * for the 16-byte and larger forms, by a second check on every store). Stores addressed by ESP alone (the stack:
   * locals and arguments without a frame pointer) are not checked, like PUSH: stacks do not hold code.
   */
  smcCheck(insn, bytes) {
    if (!this.smc || !insn) return;
    const m = insn.ops.find((o) => o.t === OT.MEM);
    if (m && m.base === 4 && m.index < 0 && !m.a16 && m.seg !== SEG.FS && m.seg !== SEG.GS) return;
    bytes ??= m && m.size > 0 ? m.size : 1;
    const c = this.c;
    c.get(L_TA).i32(12).shr_u(); this.smcFlag();
    const i = c.hint(false).if_();
    // (a plain store: a page never mapped takes the same exit, with the instruction's start — Jit.run undoes the store
    // and raises the fault there, see NC_STORE_SMC)
    const nullStore = this.nullPage && (NC_STORE_SMC.has(insn.op) || (this.nullPage === 'writes' && NC_RMW_SMC.has(insn.op)));
    // (cold) this page, or the next one when the store reaches it
    c.get(L_TA).i32(12).shr_u().i32load8u(SMC_MAP_BASE).i32(SMC_CODE | SMC_WATCH | (nullStore ? SMC_NULL : 0)).and();
    if (bytes > 1) c.get(L_TA).i32(0xfff).and().i32(0x1000 - bytes).gt_u().or();
    const hit = c.if_();
    c.get(L_STATE).get(L_TA).i32store(ST.EXIT_ARG);
    if (bytes > 16 || nullStore) c.get(L_STATE).i32(bytes).i32store(ST.EXIT_LEN); // (the range the host invalidates: 16 bytes by default)
    if (nullStore) c.get(L_STATE).i32(insn.addr).i32store(ST.EXIT_PC);
    this.exitCode(EXIT.SMC, insn.next); // (the instruction's own flags are in the lazy state: see binArith, deadFlagsExit)
    c.end(); void hit;
    c.end(); void i;
  }

  // ------------------------------------------------------------------ flags
  setLazy(kind, size) { this.c.i32((kind << 2) | SZLOG[size]).set(L_LZOP); this.lz = { kind, sz: SZLOG[size] }; }
  /** Ensure L_EFLAGS holds the real flags (lazy op = NONE). */
  materialize() {
    if (this.lz && this.lz.kind === LZ.NONE) return;
    const c = this.c;
    if (this.lz === null) {
      // runtime: only call when needed
      c.get(L_LZOP);
      const i = c.if_();
      this.count(PF.flagsNull);
      c.get(L_LZOP).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
      c.i32(0).set(L_LZOP);
      c.end(); void i;
    } else if (this.lz.kind === -1) {
      this.count(PF.flagsSlowArm);
      c.get(L_LZOP).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
      c.i32(0).set(L_LZOP);
    } else {
      this.count(PF.flagsStatic);
      this.materializeInline(this.lz);
      c.i32(0).set(L_LZOP);
    }
    this.lz = { kind: LZ.NONE, sz: 2 };
  }
  /**
   * L_EFLAGS <- the six arithmetic flags of a lazy state whose kind is known at translation time, inline (the
   * flags helper's formulas, runtime.js materializeFlags; lazy values already masked to the size): no call.
   */
  materializeInline(lz) {
    const c = this.c, k = lz.kind, bits = 8 << lz.sz, sign = SIGN[1 << lz.sz];
    c.get(L_EFLAGS).i32(~(F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF)).and();
    // CF
    if (k === LZ.SHL) this.pushShlCarry(bits); else this.pushCarry(lz);
    c.or();
    // OF (bit 11)
    if (k === LZ.SHL) { c.get(L_LZRES).i32(sign).and().i32(0).ne(); this.pushShlCarry(bits); c.xor(); }
    else this.pushOverflowOf(lz);
    c.i32(11).shl().or();
    // AF (bit 4)
    switch (k) {
      case LZ.ADD: case LZ.SUB: case LZ.ADC: case LZ.SBB: c.get(L_LZA).get(L_LZB).xor().get(L_LZRES).xor().i32(0x10).and().or(); break;
      case LZ.INC: c.get(L_LZRES).i32(0xf).and().eqz().i32(4).shl().or(); break;
      case LZ.DEC: c.get(L_LZRES).i32(0xf).and().i32(0xf).eq().i32(4).shl().or(); break;
      case LZ.NEG: c.get(L_LZA).i32(0xf).and().i32(0).ne().i32(4).shl().or(); break;
      default: break; // 0
    }
    // ZF (bit 6): BSF's is its source being zero (L_LZA), the others' the result being zero
    if (k === LZ.BSF) c.get(L_LZA).i32(0).ne(); else c.get(L_LZRES).eqz();
    c.i32(6).shl().or();
    // SF (bit 7)
    c.get(L_LZRES).i32(sign).and().i32(0).ne().i32(7).shl().or();
    // PF (bit 2): even parity of the low byte
    c.get(L_LZRES).i32(0xff).and().popcnt().i32(1).and().eqz().i32(2).shl().or();
    c.set(L_EFLAGS);
  }
  /** SHL's CF: the last bit shifted out, a >> (bits - count) (count == bits: a & 1; count > bits: 0) */
  pushShlCarry(bits) {
    const c = this.c;
    if (bits === 32) { c.get(L_LZA).i32(32).get(L_LZB).sub().shr_u().i32(1).and(); return; } // count 1..31
    c.get(L_LZA).i32(bits).get(L_LZB).sub().i32(31).and().shr_u().i32(1).and();
    c.i32(0).get(L_LZB).i32(bits).le_u().select();
  }
  /** arithmetic flags (FL_*) a later instruction may read, after the instruction being emitted */
  flagsLive() { return this.flagsAfter[this.insnIdx - 1]; }
  /**
   * The instruction being emitted defines all six arithmetic flags (FCOMI, COMISS, POPF...): the pending lazy
   * state is dropped instead of materialized (its values can no longer be observed); L_EFLAGS keeps the
   * other bits.
   */
  discardFlags() {
    if (this.lz && this.lz.kind === LZ.NONE) return;
    this.c.i32(0).set(L_LZOP);
    this.lz = { kind: LZ.NONE, sz: 2 };
  }
  /** push CF (0/1) */
  pushCF() {
    const c = this.c;
    const lz = this.lz;
    if (lz && lz.kind === LZ.SUB) { c.get(L_LZA).get(L_LZB).lt_u(); return; }
    if (lz && lz.kind === LZ.ADD) { c.get(L_LZRES).get(L_LZA).lt_u(); return; }
    if (lz && lz.kind === LZ.LOGIC) { c.i32(0); return; }
    if (lz && (lz.kind === LZ.INC || lz.kind === LZ.DEC)) { c.get(L_LZB).i32(1).and(); return; }
    if (lz && (lz.kind === LZ.ADC || lz.kind === LZ.SBB || lz.kind === LZ.NEG)) { this.pushCarryOf(lz); return; }
    if (lz === null) { this.pushCondDynamic(2); return; } // CF = condition B
    this.materialize();
    c.get(L_EFLAGS).i32(1).and();
  }
  /**
   * Condition cc when the lazy flag state is unknown at translation time (a block that tests flags
   * set by its predecessors): dispatch on the run-time lazy op (L_LZOP = kind << 2 | size) to an
   * inline computation for every kind pushCond evaluates inline (flags already materialized, and the
   * lazy kinds of lazyCondInline); lazy ops whose code is identical (ZF of any kind, CF of a subtraction
   * of any size...) share one arm. Only the other kinds (none left: see CF_INLINE) would call the flags helper.
   * When the block's predecessors in the region agree on the lazy op (b.lzPred), that op is tested first and its
   * condition evaluated inline (a compare and a predictable branch before the indirect jump). The lazy state is
   * left as is.
   */
  pushCondDynamic(cc) {
    const c = this.c, base = cc >> 1;
    const pred = this.insnIdx - 1 <= this.lzPredUntil ? this.lzPred : -1;
    if (pred > 0 && lazyCondInline(base, pred >> 2)) {
      // the lazy op every in-region predecessor leaves (regionLazyPrediction): tested first, inline
      c.get(L_LZOP).i32(pred).eq();
      c.hint(true).if_(T.i32);
      this.lz = { kind: pred >> 2, sz: pred & 3 }; this.pushCond(cc);
      c.else_();
      this.lzPred = -1; this.pushCondDynamic(cc); // (the full dispatch, which leaves this.lz null)
      this.lzPred = pred;
      c.end();
      return;
    }
    // arms by generated code: each candidate lazy op is emitted into a scratch body, identical bytes share an arm
    const byCode = new Map();
    const scratch = (this.armScratch ??= new Code());
    const add = (op, lz) => {
      scratch.reset(); this.c = scratch; this.lz = lz; this.pushCond(cc); this.c = c;
      const key = String.fromCharCode.apply(null, scratch.buf.subarray(0, scratch.len));
      let arm = byCode.get(key);
      if (!arm) byCode.set(key, (arm = { lz, ops: [] }));
      arm.ops.push(op);
    };
    add(0, { kind: LZ.NONE, sz: 2 });
    let allInline = true;
    for (let kind = 1; kind <= LZ_KINDS_MAX; kind++) {
      if (!lazyCondInline(base, kind)) { allInline = false; continue; }
      for (const sz of [0, 1, 2]) add((kind << 2) | sz, { kind, sz });
    }
    const arms = [...byCode.values()];
    const done = c.block(T.i32);
    const slow = allInline ? null : c.block();
    for (let k = arms.length - 1; k >= 0; k--) arms[k].label = c.block();
    // every lazy kind inline: no helper call in the function (a call site, even never taken, makes V8 spill the
    // values live across it on every path). The remaining table entries (no translation writes such an L_LZOP)
    // share the NONE arm: EFLAGS as is, what the flags helper returns for an unknown kind.
    const other = slow ?? arms[0].label;
    const table = new Array(Math.max(...arms.flatMap((a) => a.ops)) + 1).fill(other);
    for (const a of arms) for (const op of a.ops) table[op] = a.label;
    c.get(L_LZOP).br_table(table, other);
    for (const a of arms) {
      c.end(); // a.label
      this.lz = a.lz; this.pushCond(cc);
      c.br(done);
    }
    if (slow) {
      c.end(); // slow: another lazy kind
      this.lz = { kind: -1, sz: 2 }; this.materialize(); this.pushCond(cc); // flags helper, then EFLAGS
    }
    c.end(); // done
    this.lz = null;
  }
  /** CF (0/1) of a lazy kind of CF_INLINE (the flags helper's formulas, lazy values already masked to the size) */
  pushCarry(lz) {
    const c = this.c;
    switch (lz.kind) {
      case LZ.SUB: c.get(L_LZA).get(L_LZB).lt_u(); return;
      case LZ.ADD: c.get(L_LZRES).get(L_LZA).lt_u(); return;
      case LZ.LOGIC: case LZ.BSF: c.i32(0); return;
      case LZ.INC: case LZ.DEC: case LZ.IMUL: c.get(L_LZB).i32(1).and(); return;
      case LZ.SHR: case LZ.SAR: c.get(L_LZA).get(L_LZB).i32(1).sub().shr_u().i32(1).and(); return;
      case LZ.MUL: c.get(L_LZA).i32(0).ne(); return;
      case LZ.SHLD: c.get(L_LZA).i32(1).and(); return;
      case LZ.SHL: this.pushShlCarry(8 << lz.sz); return;
      default: this.pushCarryOf(lz); // ADC, SBB, NEG
    }
  }
  /** OF (0/1) of a lazy kind of OF_INLINE */
  pushOverflowOf(lz) {
    const c = this.c, sign = SIGN[1 << lz.sz];
    switch (lz.kind) {
      case LZ.ADD: case LZ.ADC: c.get(L_LZA).get(L_LZRES).xor().get(L_LZB).get(L_LZRES).xor().and().i32(sign).and().i32(0).ne(); return;
      case LZ.SUB: case LZ.SBB: c.get(L_LZA).get(L_LZB).xor().get(L_LZA).get(L_LZRES).xor().and().i32(sign).and().i32(0).ne(); return;
      case LZ.LOGIC: case LZ.SAR: case LZ.BSF: c.i32(0); return;
      case LZ.INC: c.get(L_LZRES).i32(sign | 0).eq(); return;
      case LZ.DEC: c.get(L_LZRES).i32((sign - 1) | 0).eq(); return;
      case LZ.NEG: c.get(L_LZA).i32(sign | 0).eq(); return;
      case LZ.SHR: c.get(L_LZA).i32(sign).and().i32(0).ne(); return;
      case LZ.MUL: c.get(L_LZA).i32(0).ne(); return;
      case LZ.SHL: c.get(L_LZRES).i32(sign).and().i32(0).ne(); this.pushShlCarry(8 << lz.sz); c.xor(); return;
      default: c.get(L_LZB).i32(1).and(); // IMUL, SHLD
    }
  }
  /**
   * CF of the lazy kinds ADC/SBB/NEG: NEG: a != 0; ADC: res <u a | cin & res == a; SBB: a <u b | cin & a == b, the
   * carry-in being (res - a - b) / (a - b - res) masked to the operand size.
   */
  pushCarryOf(lz) {
    const c = this.c;
    if (lz.kind === LZ.NEG) { c.get(L_LZA).i32(0).ne(); return; }
    const [x, y] = lz.kind === LZ.ADC ? [L_LZRES, L_LZA] : [L_LZA, L_LZB];
    c.get(x).get(y).lt_u();
    if (lz.kind === LZ.ADC) c.get(L_LZRES).get(L_LZA).sub().get(L_LZB).sub(); else c.get(L_LZA).get(L_LZB).sub().get(L_LZRES).sub();
    if (lz.sz !== 2) c.i32(MASK[1 << lz.sz]).and();
    c.i32(0).ne().get(x).get(y).eq().and().or();
  }
  /** push condition cc (0/1) */
  pushCond(cc) {
    const c = this.c;
    const lz = this.lz;
    const fc = this.fcmp;
    if (fc && fc.blk === this.cur && fc.at === this.insnIdx) { this.pushFcmpCond(cc, fc); return; }
    if (lz === null) { this.pushCondDynamic(cc); return; }
    const neg = cc & 1;
    const base = cc >> 1;
    const sx = (loc, sz) => { c.get(loc); if (sz === 0) c.extend8_s(); else if (sz === 1) c.extend16_s(); };
    const sign = lz ? SIGN[1 << lz.sz] : 0;
    let done = false;
    if (lz && lz.kind !== LZ.NONE) {
      const k = lz.kind;
      switch (base) {
        case 2: c.get(L_LZRES).eqz(); done = true; break; // E
        case 4: c.get(L_LZRES).i32(sign).and().i32(0).ne(); done = true; break; // S
        case 1: if (k === LZ.SUB) { c.get(L_LZA).get(L_LZB).lt_u(); done = true; } else if (k === LZ.ADD) { c.get(L_LZRES).get(L_LZA).lt_u(); done = true; } else if (k === LZ.LOGIC) { c.i32(0); done = true; } else if (k === LZ.INC || k === LZ.DEC) { c.get(L_LZB).i32(1).and(); done = true; } else if (k === LZ.ADC || k === LZ.SBB || k === LZ.NEG) { this.pushCarryOf(lz); done = true; } break; // B
        case 3: if (k === LZ.SUB) { c.get(L_LZA).get(L_LZB).le_u(); done = true; } else if (k === LZ.LOGIC) { c.get(L_LZRES).eqz(); done = true; } break; // BE
        case 6: if (k === LZ.SUB) { sx(L_LZA, lz.sz); sx(L_LZB, lz.sz); c.lt_s(); done = true; } else if (k === LZ.LOGIC) { c.get(L_LZRES).i32(sign).and().i32(0).ne(); done = true; } break; // L
        case 7: if (k === LZ.SUB) { sx(L_LZA, lz.sz); sx(L_LZB, lz.sz); c.le_s(); done = true; } else if (k === LZ.LOGIC) { sx(L_LZRES, lz.sz); c.i32(0).le_s(); done = true; } break; // LE
        case 0: if (k === LZ.LOGIC) { c.i32(0); done = true; } break; // O
      }
      if (!done && lazyCondInline(base, k)) {
        // generic inline evaluation from the lazy values
        const zf = () => c.get(L_LZRES).eqz(), sf = () => c.get(L_LZRES).i32(sign).and().i32(0).ne();
        switch (base) {
          case 0: this.pushOverflowOf(lz); break;
          case 1: this.pushCarry(lz); break;
          case 3: this.pushCarry(lz); zf(); c.or(); break;
          case 5: c.get(L_LZRES).i32(0xff).and().popcnt().i32(1).and().eqz(); break; // PF: even parity of the low byte
          case 6: sf(); this.pushOverflowOf(lz); c.xor(); break;
          case 7: sf(); this.pushOverflowOf(lz); c.xor(); zf(); c.or(); break;
        }
        done = true;
      }
    }
    if (!done) {
      this.materialize();
      switch (base) {
        case 0: c.get(L_EFLAGS).i32(F.OF).and().i32(0).ne(); break;
        case 1: c.get(L_EFLAGS).i32(F.CF).and().i32(0).ne(); break;
        case 2: c.get(L_EFLAGS).i32(F.ZF).and().i32(0).ne(); break;
        case 3: c.get(L_EFLAGS).i32(F.CF | F.ZF).and().i32(0).ne(); break;
        case 4: c.get(L_EFLAGS).i32(F.SF).and().i32(0).ne(); break;
        case 5: c.get(L_EFLAGS).i32(F.PF).and().i32(0).ne(); break;
        case 6: c.get(L_EFLAGS).i32(7).shr_u().get(L_EFLAGS).i32(11).shr_u().xor().i32(1).and(); break; // SF^OF
        case 7: c.get(L_EFLAGS).i32(7).shr_u().get(L_EFLAGS).i32(11).shr_u().xor().i32(1).and().get(L_EFLAGS).i32(6).shr_u().i32(1).and().or(); break;
      }
    }
    if (neg) c.eqz();
  }
  /**
   * Condition cc straight from the operands of the COMISS/UCOMISS/COMISD/UCOMISD just before (this.fcmp, set by
   * translate-sse-float.js: locals fc.a / fc.b of type fc.p, 'f32' or 'f64'): ZF,PF,CF = 111 unordered, 000
   * a > b, 001 a < b, 100 a == b; OF, SF (and AF) 0. With the IEEE comparisons (false when unordered):
   * CF = !(a >= b), ZF = !(a < b || a > b), CF|ZF = !(a > b), PF = !(a >= b || a < b); O, S, L are never
   * set, LE is ZF. The instruction's EFLAGS update is skipped when nothing reads the flags after the consumer.
   */
  pushFcmpCond(cc, fc) {
    const c = this.c, p = fc.p;
    const cmp = (op) => { c.get(fc.a).get(fc.b)[p + op](); };
    let inv = cc & 1; // result to invert
    switch (cc >> 1) {
      case 0: case 4: case 6: c.i32(inv); return; // O, S, L: 0 (negated: 1)
      case 1: cmp('ge'); inv ^= 1; break; // B: !(a >= b)
      case 3: cmp('gt'); inv ^= 1; break; // BE: !(a > b)
      case 2: case 7: cmp('lt'); cmp('gt'); c.or(); inv ^= 1; break; // E, LE: !(a < b || a > b)
      default: cmp('ge'); cmp('lt'); c.or(); inv ^= 1; break; // P: unordered
    }
    if (inv) c.eqz();
  }
  /** Compute arithmetic flags eagerly from (res in lzRes, a in lzA, b in lzB) with kind, into EFLAGS. */
  eagerFlags(kind, size) {
    const c = this.c;
    this.count(PF.flagsEager);
    c.i32((kind << 2) | SZLOG[size]).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
    c.i32(0).set(L_LZOP);
    this.lz = { kind: LZ.NONE, sz: 2 };
  }

  // ------------------------------------------------------------------ blocks
  emitBlock(b, nextBlock) {
    this.lz = null; // unknown at block entry
    this.stValid = 0; // bit i: the tag of ST(i) is known set (a store in this block set it), x87 regions
    this.stShift = this.planOf(b.index); // pending static rotation of the x87 locals (see stLocal), x87 regions
    this.f32Mask = 0; // x87 locals whose value is in the f32 shadow (see materializeF32)
    this.g24Mask = 0; // x87 locals known to hold a value whose significand fits in 24 bits (translate-x87.js narrow)
    this.tagSet = this.tagClr = 0; // pending tag word changes (see applyTags)
    this.c1Clear = false; // the status word's C1 known clear (translate-x87.js: cleared once per block)
    this.insnIdx = 0; // instructions of the block emitted so far (charged to the budget at an exit)
    this.fcmp = null; // a float compare whose condition the next instruction evaluates directly (see pushFcmpCond)
    this.xsValid = this.xsDirty = this.xdValid = this.xdDirty = 0; // XMM lane-0 shadows (see xmmShadowSync)
    this.cur = b.index;
    if (this.counterBase >= 0) { const a = this.counterBase + 4 * b.index; this.c.i32(0).i32(0).i32load(a).i32(1).add().i32store(a); }
    if (this.visitAt !== null && this.visitAt[b.index] >= 0) {
      // (stats.visitSites: the body offset of each flag address, a 5-byte LEB — the area is above 2^28 —: see patchVisitSlots)
      this.c.i32(0).i32(1); (this.stats.visitSites ??= []).push(b.eip, this.c.len + 2); this.c.i32store8(this.visitAt[b.index]);
    }
    // the predicted lazy op at entry (regionLazyPrediction) holds up to the block's first instruction changing it
    this.lzPred = b.lzPred ?? -1;
    this.lzPredUntil = 0;
    if (this.lzPred >= 0) while (this.lzPredUntil < b.insns.length && LZ_KEEP.has(b.insns[this.lzPredUntil].op)) this.lzPredUntil++;
    // flags live after each instruction of the block
    const live = (this.flagsAfter = new Uint8Array(b.insns.length));
    for (let i = b.insns.length - 1, l = b.flagsOut ?? FL_ALL; i >= 0; i--) { live[i] = l; l = flagsLiveBefore(b.insns[i], l); }
    /** x87 mode (cw & 0xf00) known at this point of the emission, or null (L_FPC tested at run time) */
    this.fpcStatic = this.fpcAssume; // (entries and in-region transfers are checked: see fpuModeGuard)
    const ifc = this.ifcvt && b.term === TERM_JCC ? this.ifcvtPlan(b) : null;
    this.ncPlan = this.nullPage ? planNullChecks(b.insns, this.smc, this.nullPage) : null;
    for (const insn of b.insns) {
      this.insnIdx++;
      if (ifc && this.insnIdx === b.insns.length) { this.emitIfcvt(insn, b, ifc); this.c.site = -1; return; } // (it jumps to the merge)
      this.emitInsn(insn, b);
    }
    this.c.site = -1; // (call statistics: block-end code)
    // block end
    const n = b.insns.length;
    switch (b.term) {
      case TERM_NONE:
      case TERM_CALL:
      case TERM_JCC:
      case TERM_LOOP: {
        // fallthrough (terminators already emitted their taken path)
        if (b.term === TERM_CALL) return; // call emitted its own jump
        const ft = b.fallthrough;
        if (nextBlock && nextBlock.eip === ft) { // natural fallthrough into the next block's code
          this.count(PF.fallthrough);
          this.fpuModeGuard(ft, n);
          this.x87Normalize(this.planOf(nextBlock.index));
          this.charge(n); // (a loop entered by its top sees L_BLK outside its blocks: see loopPrologue)
          return;
        }
        this.jumpTo(ft, n);
        return;
      }
      case TERM_EXIT:
        // an undecodable instruction ends the block (discoverRegion): every instruction before it done, the
        // interpreter executes it — raises its fault with the exact state (no instruction's handler exits here)
        if (b.decodeError) { this.charge(n); this.exitCode(EXIT_STEP, b.fallthrough); }
        return;
      default: return; // JMP/RET/INDIRECT/EXIT emitted their own exits
    }
  }

  /**
   * If-conversion of block A's final JCC (see IFCVT_OPS): { taken, not (arms, null when empty), merge, writes (the locals
   * the arms write) }, or null. The arms are blocks of the region (still translated as such: they stay entry points of
   * the region, for other paths into them) going on at the same merge address.
   */
  ifcvtPlan(A) {
    const last = A.insns[A.insns.length - 1];
    if (last.op !== OP.JCC || last.ops[0].t !== OT.REL) return null;
    if (this.ifcvt !== 'all' && (!ifcvtDataCond(A) || !this.pathOf[A.index].some((u) => u.loop))) return null; // (data compares in loops)
    const tgt = last.ops[0].v >>> 0, ft = A.fallthrough >>> 0;
    if (tgt === ft) return null;
    const armOf = (a) => { const X = this.byEip.get(a); return X && X !== A ? ifcvtArm(X) : null; };
    const aT = armOf(tgt), aN = armOf(ft);
    let plan = null;
    if (aN && aN.succ >>> 0 === tgt) plan = { taken: null, not: aN, merge: tgt };
    else if (aT && aT.succ >>> 0 === ft) plan = { taken: aT, not: null, merge: ft };
    else if (aT && aN && aT.succ >>> 0 === aN.succ >>> 0 && aT.block !== aN.block) plan = { taken: aT, not: aN, merge: aT.succ >>> 0 };
    if (!plan || (plan.taken?.body.length ?? 0) + (plan.not?.body.length ?? 0) > IFCVT_TOTAL_MAX) return null;
    const w = new Set();
    for (const a of [plan.taken, plan.not]) if (a) for (const insn of a.body) ifcvtWrites(insn, w);
    plan.writes = [...w].sort((x, y) => x - y);
    if (plan.writes.length > IFCVT_SLOTS) return null;
    return plan;
  }
  /**
   * Block A's final JCC, if-converted (plan: ifcvtPlan): the condition into L_IC, each arm emitted in turn from the same
   * state (the locals it writes saved before and restored after the first one), its loads made harmless when it is not
   * the path taken (spec: loadMem), then every written local selected on the condition, the instruction budget charged
   * for the path taken, and a jump to the merge block. The static lazy flag state after the merge is the arms' common
   * one, or unknown (the locals hold it either way).
   */
  emitIfcvt(insn, A, plan) {
    const c = this.c;
    this.curOp = insn.op; c.site = insn.op;
    this.stats.ifcvt++;
    this.pushCond(insn.cc); c.set(L_IC);
    const lz0 = this.lz, W = plan.writes, nA = A.insns.length;
    // loads of the arm taken in the null page (see loadMem): after the arms, their effects undone and the region left
    // before the JCC, whose arm then runs as a block of its own (its accesses checked before each instruction)
    const checked = this.nullPage === true && [plan.taken, plan.not].some((a) => a && a.body.some((i) => (i.nchk || nullChecks(i)).length));
    if (checked) c.i32(0).set(L_SPECF);
    const emitArm = (arm, spec) => {
      const X = arm.block, saved = [this.flagsAfter, this.insnIdx, this.lzPred, this.lzPredUntil, this.fcmp];
      const live = (this.flagsAfter = new Uint8Array(X.insns.length));
      for (let i = X.insns.length - 1, l = X.flagsOut ?? FL_ALL; i >= 0; i--) { live[i] = l; l = flagsLiveBefore(X.insns[i], l); }
      this.lz = lz0; this.lzPred = -1; this.lzPredUntil = -1; this.fcmp = null; this.insnIdx = 0;
      this.spec = spec;
      if (this.counterBase >= 0) { const a = this.counterBase + 4 * X.index; c.i32(0).i32(0).i32load(a).get(L_IC); if (spec === 2) c.eqz(); c.add().i32store(a); }
      for (const i of arm.body) { this.insnIdx++; this.emitInsn(i, X); }
      this.spec = 0;
      const lz = this.lz;
      [this.flagsAfter, this.insnIdx, this.lzPred, this.lzPredUntil, this.fcmp] = saved;
      return lz;
    };
    let lzT = lz0, lzN = lz0;
    if (plan.taken) {
      W.forEach((l, k) => c.get(l).set(L_IFS0 + k));
      lzT = emitArm(plan.taken, 1);
      W.forEach((l, k) => c.get(l).set(L_IFR0 + k).get(L_IFS0 + k).set(l)); // (its results kept, the state before it back)
    } else W.forEach((l, k) => c.get(l).set(L_IFR0 + k)); // (the taken path changes nothing)
    if (plan.not) lzN = emitArm(plan.not, 2);
    if (checked) {
      c.get(L_SPECF);
      const f = c.hint(false).if_();
      const pre = plan.taken ? L_IFS0 : L_IFR0; // (the state before the arms: saved for the taken arm, or unchanged by it)
      if (plan.not) W.forEach((l, k) => c.get(pre + k).set(l));
      this.stepExit(insn);
      c.end(); void f;
    }
    W.forEach((l, k) => c.get(L_IFR0 + k).get(l).get(L_IC).select().set(l));
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.kind === b.kind && a.sz === b.sz && a.kind >= 0);
    this.lz = same(lzT, lzN) ? lzT : null;
    const nT = plan.taken ? plan.taken.block.insns.length : 0, nN = plan.not ? plan.not.block.insns.length : 0;
    if (nT !== nN) c.get(L_ICOUNT).i32(nT).i32(nN).get(L_IC).select().sub().set(L_ICOUNT);
    this.insnIdx = nA;
    this.jumpTo(plan.merge, nA + (nT === nN ? nT : 0));
  }

  emitInsn(insn, b) {
    this.curOp = insn.op;
    this.c.site = insn.op; // (call statistics)
    const h = HANDLERS[insn.op];
    this.xsOK = XMM_SHADOW_OPS.has(insn.op); this.xdOK = XMM_SHADOW64_OPS.has(insn.op); // (read by the shadow helpers)
    if ((!this.xsOK && this.xsValid) || (!this.xdOK && this.xdValid)) this.xmmShadowRelease(insn, !this.xsOK, !this.xdOK);
    if (h && this.nullPage) {
      if (this.spec) this.specCheck = this.nullPage === true && (insn.nchk || nullChecks(insn)).length > 0; // (arms only load)
      else { const p = this.ncPlan?.[this.insnIdx - 1]; if (p) this.nullCheck(insn, p); }
    }
    if (h) { this.stats.native++; h(this, insn, b); }
    else this.fallback(insn);
    this.specCheck = false;
  }

  /** Execute one instruction with the interpreter. */
  fallback(insn) {
    this.stats.fallback++;
    if (FPU_MODE_WRITERS.has(insn.op)) this.fpcStatic = null;
    const c = this.c;
    this.materialize();
    this.x87Normalize();
    this.flushAll();
    c.get(L_STATE).i32(insn.addr).i32store(ST.EIP);
    c.i32(insn.addr).call(IMP_FALLBACK).tee(L_T2);
    const i = c.hint(false).if_();
    c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
    c.i32(0).return_(); // exit code already stored by the host
    c.end(); void i;
    this.reloadAll();
    this.lz = { kind: LZ.NONE, sz: 2 };
    this.stValid = 0;
    this.f32Mask = this.g24Mask = 0; // x87 values reloaded as f64, nothing known of them
    this.tagSet = this.tagClr = 0; // (applied by x87Normalize before the flush, the tag word reloaded)
    this.c1Clear = false; // (the interpreter may have set C1: FPREM's quotient bit)
    // did the instruction branch?
    c.get(L_STATE).i32load(ST.EIP).i32(insn.next).ne();
    const j = c.if_();
    c.get(L_STATE).i32load(ST.EIP);
    this.exitToStack();
    c.end(); void j;
  }
}

// =============================================================================================
// Instruction handlers: (E: Emitter, insn, block) => void
const HANDLERS = new Array(Object.keys(OP).length).fill(null);

// ---- helpers shared by handlers
/** Load dst operand (EA into L_TA for memory) and push its value. */
function loadDst(E, d) {
  if (d.t === OT.MEM) { E.eaTo(d); E.c.get(L_TA); E.loadMem(d.size); }
  else E.loadOp(d);
}
function maskTo(E, size) { if (size !== 4) E.c.i32(MASK[size]).and(); }

function binArith(kind, opEmit, store = true) {
  return (E, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
    loadDst(E, d); E.c.set(L_LZA);
    E.loadOp(s); E.c.set(L_LZB);
    E.c.get(L_LZA).get(L_LZB); opEmit(E.c); maskTo(E, size); E.c.set(L_LZRES);
    // AND/OR/XOR/TEST flags depend on the result alone (CF = OF = AF = 0, as the flags helper and the inline conditions
    // compute them): the result stands in for the lazy operands too (opts.logicRes), one value instead of three where the
    // lazy state stays live (merges, exits) rather than copies of both operands kept in registers of their own
    if (kind === LZ.LOGIC && E.logicRes) E.c.get(L_LZRES).tee(L_LZA).set(L_LZB);
    E.setLazy(kind, size); // before the store: an SMC exit inside storeOpFrom flushes a coherent lazy state
    if (store) E.storeOpFrom(d, L_LZRES, insn);
  };
}
HANDLERS[OP.ADD] = binArith(LZ.ADD, (c) => c.add());
HANDLERS[OP.SUB] = binArith(LZ.SUB, (c) => c.sub());
HANDLERS[OP.CMP] = binArith(LZ.SUB, (c) => c.sub(), false);
HANDLERS[OP.AND] = binArith(LZ.LOGIC, (c) => c.and());
HANDLERS[OP.OR] = binArith(LZ.LOGIC, (c) => c.or());
HANDLERS[OP.XOR] = binArith(LZ.LOGIC, (c) => c.xor());
HANDLERS[OP.TEST] = binArith(LZ.LOGIC, (c) => c.and(), false);

function adcSbb(isAdc) {
  // lazy: (res, a, b) with kind ADC/SBB, the carry-in being recoverable from them (see LZ)
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
    E.pushCF(); c.set(L_T4);
    loadDst(E, d); c.set(L_LZA);
    E.loadOp(s); c.set(L_LZB);
    if (isAdc) { c.get(L_LZA).get(L_LZB).add().get(L_T4).add(); } else { c.get(L_LZA).get(L_LZB).sub().get(L_T4).sub(); }
    maskTo(E, size); c.set(L_LZRES);
    E.setLazy(isAdc ? LZ.ADC : LZ.SBB, size); // (before the store: see binArith)
    E.storeOpFrom(d, L_LZRES, insn);
  };
}
HANDLERS[OP.ADC] = adcSbb(true);
HANDLERS[OP.SBB] = adcSbb(false);

HANDLERS[OP.INC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  if (E.flagsLive() & FL_CF) E.pushCF(); else c.i32(0); // the preserved CF, when still read
  c.set(L_T4);
  loadDst(E, d); c.set(L_LZA);
  c.get(L_LZA).i32(1).add(); maskTo(E, size); c.set(L_LZRES);
  c.get(L_T4).set(L_LZB);
  E.setLazy(LZ.INC, size); // (before the store: see binArith)
  E.storeOpFrom(d, L_LZRES, insn);
};
HANDLERS[OP.DEC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  if (E.flagsLive() & FL_CF) E.pushCF(); else c.i32(0);
  c.set(L_T4);
  loadDst(E, d); c.set(L_LZA);
  c.get(L_LZA).i32(1).sub(); maskTo(E, size); c.set(L_LZRES);
  c.get(L_T4).set(L_LZB);
  E.setLazy(LZ.DEC, size); // (before the store: see binArith)
  E.storeOpFrom(d, L_LZRES, insn);
};
HANDLERS[OP.NEG] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  loadDst(E, d); c.set(L_LZA);
  c.i32(0).get(L_LZA).sub(); maskTo(E, size); c.set(L_LZRES);
  E.setLazy(LZ.NEG, size); // (before the store: see binArith)
  E.storeOpFrom(d, L_LZRES, insn);
};
HANDLERS[OP.NOT] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  loadDst(E, d); c.i32(-1).xor(); maskTo(E, size); c.set(L_TV);
  E.storeOpFrom(d, L_TV, insn);
};

// ---- shifts
function shiftCountConst(insn) { const s = insn.ops[1]; return s.t === OT.IMM ? s.v & 31 : -1; }
function shiftOp(kind) {
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0]; const size = d.size; const bits = BITS[size];
    const cnt = shiftCountConst(insn);
    if (cnt === 0) return;
    const emitCore = (constCnt) => {
      loadDst(E, d); c.set(L_LZA);
      if (constCnt < 0) c.get(L_REG + 1).i32(31).and().set(L_LZB); else c.i32(constCnt).set(L_LZB);
      if (kind === LZ.SHL) { c.get(L_LZA).get(L_LZB).shl(); maskTo(E, size); }
      else if (kind === LZ.SHR) { c.get(L_LZA).get(L_LZB).shr_u(); }
      else { c.get(L_LZA); if (size === 1) c.extend8_s(); else if (size === 2) c.extend16_s(); c.get(L_LZB).shr_s(); maskTo(E, size); }
      c.set(L_LZRES);
      E.setLazy(kind, size); // (before the store: see binArith)
      E.storeOpFrom(d, L_LZRES, insn);
      void bits;
    };
    if (cnt > 0) { emitCore(cnt); return; }
    // CL count: skip everything when masked count is 0 (flags unchanged)
    c.get(L_REG + 1).i32(31).and();
    const i = c.if_();
    emitCore(-1);
    c.end(); void i;
    E.lz = null;
  };
}
HANDLERS[OP.SHL] = shiftOp(LZ.SHL);
HANDLERS[OP.SHR] = shiftOp(LZ.SHR);
HANDLERS[OP.SAR] = shiftOp(LZ.SAR);

function rotateOp(kind) {
  // eager flags: CF/OF computed inline after materializing
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0]; const size = d.size; const bits = BITS[size];
    const cnt = shiftCountConst(insn);
    if (cnt === 0) return;
    // ROL/ROR write CF and OF and keep the rest: the previous flags only when a later instruction reads them
    const live = (kind === 'rol' || kind === 'ror') && cnt > 0 ? E.flagsLive() : FL_ALL; // (a CL count of 0 keeps every flag)
    if (live & FL_REST) E.materialize(); else E.discardFlags();
    const core = (constCnt) => {
      loadDst(E, d); c.set(L_LZA);
      if (constCnt < 0) c.get(L_REG + 1).i32(31).and().set(L_LZB); else c.i32(constCnt).set(L_LZB);
      if (kind === 'rol' || kind === 'ror') {
        // n = cnt % bits
        if (bits === 32) { c.get(L_LZA).get(L_LZB); if (kind === 'rol') c.rotl(); else c.rotr(); }
        else {
          c.get(L_LZB).i32(bits).rem_u().set(L_T3);
          if (kind === 'rol') c.get(L_LZA).get(L_T3).shl().get(L_LZA).i32(bits).get(L_T3).sub().i32(bits - 1).and().shr_u().or();
          else c.get(L_LZA).get(L_T3).shr_u().get(L_LZA).i32(bits).get(L_T3).sub().i32(bits - 1).and().shl().or();
          // when n == 0 the second term shifted by bits&mask=0 gives a duplicate; result correct anyway (a|a)
          maskTo(E, size);
        }
        c.set(L_LZRES);
        // (the flags before the store: an SMC exit after it leaves with this instruction's flags, see binArith)
        if (live) { // (else no flag of this rotate is ever read)
          // CF = rol ? res&1 : msb(res); OF = rol ? msb(res)^cf : msb(res)^msb-1(res)  (count==1 defined; we always compute)
          c.get(L_EFLAGS).i32(~(F.CF | F.OF)).and().set(L_EFLAGS);
          if (kind === 'rol') c.get(L_LZRES).i32(1).and().set(L_T3); else c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().set(L_T3);
          c.get(L_EFLAGS).get(L_T3).or().set(L_EFLAGS);
          if (kind === 'rol') c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_T3).xor();
          else c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_LZRES).i32(bits - 2).shr_u().i32(1).and().xor();
          c.i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
        }
        E.storeOpFrom(d, L_LZRES, insn);
      } else {
        // RCL/RCR through carry: loop-free formulation using i64 (value:carry) for bits<32; use loop for simplicity
        c.get(L_EFLAGS).i32(1).and().set(L_T3); // cf
        if (bits < 32) c.get(L_LZB).i32(bits + 1).rem_u().set(L_LZB);
        c.get(L_LZA).set(L_TV);
        if (kind === 'rcr') { // OF = msb(a) ^ cf (before)
          c.get(L_LZA).i32(bits - 1).shr_u().i32(1).and().get(L_T3).xor().set(L_T5);
        }
        const loop = c.loop();
        c.get(L_LZB).eqz();
        const brk = c.if_();
        c.else_();
        if (kind === 'rcl') {
          c.get(L_TV).i32(bits - 1).shr_u().i32(1).and().set(L_T6); // msb
          c.get(L_TV).i32(1).shl().get(L_T3).or(); maskTo(E, size); c.set(L_TV);
          c.get(L_T6).set(L_T3);
        } else {
          c.get(L_TV).i32(1).and().set(L_T6);
          c.get(L_TV).i32(1).shr_u().get(L_T3).i32(bits - 1).shl().or().set(L_TV);
          c.get(L_T6).set(L_T3);
        }
        c.get(L_LZB).i32(1).sub().set(L_LZB);
        c.br(loop);
        c.end(); void brk;
        c.end();
        c.get(L_TV).set(L_LZRES);
        c.get(L_EFLAGS).i32(~(F.CF | F.OF)).and().get(L_T3).or().set(L_EFLAGS);
        if (kind === 'rcl') c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_T3).xor().i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
        else c.get(L_T5).i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
        E.storeOpFrom(d, L_LZRES, insn); // (after the flags: see binArith)
      }
    };
    if (cnt > 0) { core(cnt); E.lz = { kind: LZ.NONE, sz: 2 }; return; }
    c.get(L_REG + 1).i32(31).and();
    const i = c.if_(); core(-1); c.end(); void i;
    E.lz = { kind: LZ.NONE, sz: 2 };
  };
}
HANDLERS[OP.ROL] = rotateOp('rol');
HANDLERS[OP.ROR] = rotateOp('ror');
HANDLERS[OP.RCL] = rotateOp('rcl');
HANDLERS[OP.RCR] = rotateOp('rcr');

function shldShrd(isLeft) {
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0]; const size = d.size; const bits = BITS[size];
    const cs = insn.ops[2];
    const cnt = cs.t === OT.IMM ? cs.v & 31 : -1;
    if (cnt === 0) return;
    const core = (k) => {
      loadDst(E, d); c.set(L_T4); // a
      E.loadOp(insn.ops[1]); c.set(L_T5); // b
      if (k < 0) c.get(L_REG + 1).i32(31).and().set(L_T6); else c.i32(k).set(L_T6);
      // result (count <= bits assumed; larger counts are undefined on hardware)
      if (isLeft) c.get(L_T4).get(L_T6).shl().get(L_T5).i32(bits).get(L_T6).sub().i32(31).and().shr_u().or();
      else c.get(L_T4).get(L_T6).shr_u().get(L_T5).i32(bits).get(L_T6).sub().i32(31).and().shl().or();
      maskTo(E, size); c.set(L_LZRES);
      // CF: left: bit (bits - cnt) of a ; right: bit (cnt-1) of a. OF: msb(a) ^ msb(res)
      if (isLeft) c.get(L_T4).i32(bits).get(L_T6).sub().i32(31).and().shr_u().i32(1).and().set(L_LZA);
      else c.get(L_T4).get(L_T6).i32(1).sub().shr_u().i32(1).and().set(L_LZA);
      c.get(L_T4).get(L_LZRES).xor().i32(bits - 1).shr_u().i32(1).and().set(L_LZB);
      E.setLazy(LZ.SHLD, size); // (before the store: see binArith)
      E.storeOpFrom(d, L_LZRES, insn);
    };
    if (cnt > 0) { core(cnt); return; }
    c.get(L_REG + 1).i32(31).and();
    const i = c.if_(); core(-1); c.end(); void i;
    E.lz = null;
  };
}
HANDLERS[OP.SHLD] = shldShrd(true);
HANDLERS[OP.SHRD] = shldShrd(false);

// ---- multiply / divide
HANDLERS[OP.MUL] = (E, insn) => {
  const c = E.c; const s = insn.ops[0]; const size = s.size;
  E.loadOp(s); c.set(L_T4);
  if (size === 4) {
    c.get(L_REG).extend_u().get(L_T4).extend_u().i64mul().set(L_I64A);
    c.get(L_I64A).wrap().set(L_REG); c.get(L_I64A).i64(32n).i64shr_u().wrap().set(L_REG + 2);
    c.get(L_REG + 2).set(L_LZA); c.get(L_REG).set(L_LZRES);
  } else if (size === 2) {
    E.loadReg(2, 0); c.get(L_T4).mul().set(L_T5);
    c.get(L_T5).i32(0xffff).and().set(L_TV); E.storeRegFrom(2, 0, L_TV);
    c.get(L_T5).i32(16).shr_u().set(L_TV); E.storeRegFrom(2, 2, L_TV);
    c.get(L_TV).set(L_LZA); c.get(L_T5).i32(0xffff).and().set(L_LZRES);
  } else {
    E.loadReg(1, 0); c.get(L_T4).mul().set(L_T5);
    c.get(L_T5).set(L_TV); E.storeRegFrom(2, 0, L_TV);
    c.get(L_T5).i32(8).shr_u().set(L_LZA); c.get(L_T5).i32(0xff).and().set(L_LZRES);
  }
  E.setLazy(LZ.MUL, size);
};
HANDLERS[OP.IMUL] = (E, insn, b) => {
  const c = E.c;
  const sx = (sz) => { if (sz === 1) c.extend8_s(); else if (sz === 2) c.extend16_s(); };
  if (insn.ops.length === 1) {
    const s = insn.ops[0]; const size = s.size;
    E.loadOp(s); sx(size); c.set(L_T4);
    if (size === 4) {
      c.get(L_REG).extend_s().get(L_T4).extend_s().i64mul().set(L_I64A);
      c.get(L_I64A).wrap().set(L_REG); c.get(L_I64A).i64(32n).i64shr_u().wrap().set(L_REG + 2);
      // overflow if hi != sign-extension of lo
      c.get(L_I64A).get(L_I64A).wrap().extend_s().i64ne().extend_u().wrap().set(L_LZB);
      c.get(L_REG).set(L_LZRES);
    } else if (size === 2) {
      E.loadReg(2, 0); sx(2); c.get(L_T4).mul().set(L_T5);
      c.get(L_T5).i32(0xffff).and().set(L_TV); E.storeRegFrom(2, 0, L_TV);
      c.get(L_T5).i32(16).shr_u().set(L_TV); E.storeRegFrom(2, 2, L_TV);
      c.get(L_T5).extend16_s().get(L_T5).ne().set(L_LZB); c.get(L_T5).i32(0xffff).and().set(L_LZRES);
    } else {
      E.loadReg(1, 0); sx(1); c.get(L_T4).mul().set(L_T5);
      c.get(L_T5).set(L_TV); E.storeRegFrom(2, 0, L_TV);
      c.get(L_T5).extend8_s().get(L_T5).ne().set(L_LZB); c.get(L_T5).i32(0xff).and().set(L_LZRES);
    }
    E.setLazy(LZ.IMUL, size);
    return;
  }
  const d = insn.ops[0]; const size = d.size;
  const a = insn.ops.length === 3 ? insn.ops[1] : d, bop = insn.ops.length === 3 ? insn.ops[2] : insn.ops[1];
  if (d.t === OT.MEM) throw new Error('imul dest must be a register');
  E.loadOp(a); sx(size); c.set(L_T4);
  E.loadOp(bop); sx(size); c.set(L_T5);
  if (size === 4 && (E.opts.imulDead ?? JIT_DEFAULTS.imulDead) && nextOverwritesFlags(E, b)) {
    // CF / OF (the product not fitting 32 bits) never observed: the low half alone, no 64-bit product (two sign
    // extensions and a 64-bit multiply, one more register on the hot path), the overflow flag left clear
    c.get(L_T4).get(L_T5).mul().set(L_LZRES);
    c.i32(0).set(L_LZB);
  } else if (size === 4) {
    c.get(L_T4).extend_s().get(L_T5).extend_s().i64mul().set(L_I64A);
    c.get(L_I64A).wrap().set(L_LZRES);
    c.get(L_I64A).get(L_I64A).wrap().extend_s().i64ne().extend_u().wrap().set(L_LZB);
  } else {
    c.get(L_T4).get(L_T5).mul().set(L_T6);
    c.get(L_T6); sx(size); c.get(L_T6).ne().set(L_LZB);
    c.get(L_T6); maskTo(E, size); c.set(L_LZRES);
  }
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.IMUL, size);
};
function divOp(signed) {
  return (E, insn) => {
    const c = E.c; const s = insn.ops[0]; const size = s.size;
    E.loadOp(s);
    if (signed) { if (size === 1) c.extend8_s(); else if (size === 2) c.extend16_s(); }
    c.set(L_T4);
    // divide by zero -> #DE
    c.get(L_T4).eqz();
    const i = c.hint(false).if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void i;
    if (size === 4) {
      // dividend edx:eax as i64
      c.get(L_REG + 2).extend_u().i64(32n).i64shl().get(L_REG).extend_u().i64or().set(L_I64A);
      if (signed) {
        c.get(L_I64A).get(L_T4).extend_s().i64div_s().set(L_I64B);
        // quotient must fit in i32
        c.get(L_I64B).get(L_I64B).wrap().extend_s().i64ne();
        const j = c.hint(false).if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
        c.get(L_I64A).get(L_T4).extend_s().i64rem_s().wrap().set(L_REG + 2);
      } else {
        c.get(L_I64A).get(L_T4).extend_u().i64div_u().set(L_I64B);
        c.get(L_I64B).i64(0xffffffffn).i64gt_u();
        const j = c.hint(false).if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
        c.get(L_I64A).get(L_T4).extend_u().i64rem_u().wrap().set(L_REG + 2);
      }
      c.get(L_I64B).wrap().set(L_REG);
    } else if (size === 2) {
      E.loadReg(2, 2); c.i32(16).shl(); E.loadReg(2, 0); c.or().set(L_T5); // dx:ax
      if (signed) { c.get(L_T5).get(L_T4).div_s().set(L_T6); c.get(L_T6).extend16_s().get(L_T6).ne(); } else { c.get(L_T5).get(L_T4).div_u().set(L_T6); c.get(L_T6).i32(0xffff).gt_u(); }
      const j = c.hint(false).if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
      c.get(L_T5).get(L_T4); if (signed) c.rem_s(); else c.rem_u(); c.set(L_TV); E.storeRegFrom(2, 2, L_TV);
      c.get(L_T6).set(L_TV); E.storeRegFrom(2, 0, L_TV);
    } else {
      E.loadReg(2, 0); if (signed) c.extend16_s(); c.set(L_T5);
      if (signed) { c.get(L_T5).get(L_T4).div_s().set(L_T6); c.get(L_T6).extend8_s().get(L_T6).ne(); } else { c.get(L_T5).get(L_T4).div_u().set(L_T6); c.get(L_T6).i32(0xff).gt_u(); }
      const j = c.hint(false).if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
      c.get(L_T5).get(L_T4); if (signed) c.rem_s(); else c.rem_u(); c.i32(0xff).and().i32(8).shl().get(L_T6).i32(0xff).and().or().set(L_TV);
      E.storeRegFrom(2, 0, L_TV);
    }
    // signed division: i64.div_s traps on overflow (MIN / -1): guarded above by the range check? No: the trap
    // happens before. Guard: dividend == MIN && divisor == -1 is caught by WASM trap -> treated as fault by the host.
  };
}
HANDLERS[OP.DIV] = divOp(false);
HANDLERS[OP.IDIV] = divOp(true);

// ---- moves
HANDLERS[OP.MOV] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  if (d.t === OT.SEG) { E.fallback(insn); return; }
  if (s.t === OT.SEG) {
    E.loadOp(s); c.set(L_TV);
    if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA).get(L_TV).i32store16(0); E.smcCheck(insn, 2); } else E.storeRegFrom(d.size, d.r, L_TV);
    return;
  }
  if (d.t === OT.MEM) { E.eaTo(d); E.loadOp(s); c.set(L_TV); c.get(L_TA).get(L_TV); E.storeMem(d.size); E.smcCheck(insn); return; }
  E.loadOp(s); c.set(L_TV); E.storeRegFrom(d.size, d.r, L_TV);
};
HANDLERS[OP.MOVZX] = (E, insn) => { const c = E.c; const d = insn.ops[0], s = insn.ops[1]; E.loadOp(s); c.set(L_TV); E.storeRegFrom(d.size, d.r, L_TV); };
HANDLERS[OP.MOVSX] = (E, insn) => { const c = E.c; const d = insn.ops[0], s = insn.ops[1]; E.loadOp(s); if (s.size === 1) c.extend8_s(); else c.extend16_s(); c.set(L_TV); E.storeRegFrom(d.size, d.r, L_TV); };
HANDLERS[OP.LEA] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  const o = { ...s, seg: -1 };
  E.ea(o); c.set(L_TV); E.storeRegFrom(d.size, d.r, L_TV);
};
HANDLERS[OP.XCHG] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  loadDst(E, d); c.set(L_T4);
  E.loadOp(s); c.set(L_T5);
  E.storeOpFrom(d, L_T5, insn);
  if (s.t === OT.REG) E.storeRegFrom(s.size, s.r, L_T4); else { E.eaTo(s); c.get(L_TA).get(L_T4); E.storeMem(s.size); }
};
HANDLERS[OP.XADD] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
  loadDst(E, d); c.set(L_LZA);
  E.loadOp(s); c.set(L_LZB);
  c.get(L_LZA).get(L_LZB).add(); maskTo(E, size); c.set(L_LZRES);
  E.storeRegFrom(size, s.r, L_LZA);
  E.setLazy(LZ.ADD, size); // (before the store: see binArith)
  E.storeOpFrom(d, L_LZRES, insn);
};
HANDLERS[OP.CMPXCHG] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
  E.loadReg(size, 0); c.set(L_LZA);
  loadDst(E, d); c.set(L_LZB);
  c.get(L_LZA).get(L_LZB).sub(); maskTo(E, size); c.set(L_LZRES);
  E.setLazy(LZ.SUB, size);
  c.get(L_LZA).get(L_LZB).eq();
  const i = c.if_();
  E.loadOp(s); c.set(L_TV); E.storeOpFrom(d, L_TV, insn);
  c.else_();
  E.storeRegFrom(size, 0, L_LZB);
  c.end(); void i;
};
HANDLERS[OP.BSWAP] = (E, insn) => {
  const c = E.c; const r = insn.ops[0].r;
  c.get(L_REG + r).i32(24).shr_u().get(L_REG + r).i32(8).shr_u().i32(0xff00).and().or().get(L_REG + r).i32(8).shl().i32(0xff0000).and().or().get(L_REG + r).i32(24).shl().or().set(L_REG + r);
};
HANDLERS[OP.CMOVCC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  E.loadOp(s); c.set(L_TV);
  E.pushCond(insn.cc);
  const i = c.if_(); E.storeRegFrom(d.size, d.r, L_TV); c.end(); void i;
};
HANDLERS[OP.SETCC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0];
  if (d.t === OT.MEM) E.eaTo(d);
  E.pushCond(insn.cc); c.set(L_TV);
  E.storeOpFrom(d, L_TV, insn);
};
// XLAT: AL = [(E)BX + AL] (segment override, 16-bit addressing)
HANDLERS[OP.XLAT] = (E, insn) => {
  const c = E.c;
  c.get(L_REG + 3).get(L_REG).i32(0xff).and().add();
  if (insn.adsize === 2) c.i32(0xffff).and();
  if (insn.seg === SEG.FS) c.get(L_FS).add(); else if (insn.seg === SEG.GS) c.get(L_STATE).i32load(ST.GS_BASE).add();
  if (E.nullPage === true) { // (the null page, when reads are checked: its address is not an operand, see nullpage.js)
    c.tee(L_TA); E.unmappedTest();
    const j = c.hint(false).if_(); E.stepExit(insn); c.end(); void j;
    c.get(L_TA);
  }
  c.i32load8u(0).set(L_TV);
  E.storeRegFrom(1, 0, L_TV);
};
HANDLERS[OP.CBW] = (E, insn) => { const c = E.c; if (insn.opsize === 2) { c.get(L_REG).extend8_s().set(L_TV); E.storeRegFrom(2, 0, L_TV); } else c.get(L_REG).extend16_s().set(L_REG); };
HANDLERS[OP.CWD] = (E, insn) => { const c = E.c; if (insn.opsize === 2) { c.get(L_REG).extend16_s().i32(31).shr_s().set(L_TV); E.storeRegFrom(2, 2, L_TV); } else c.get(L_REG).i32(31).shr_s().set(L_REG + 2); };

// ---- bit ops
function bitOp(kind) {
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0], s = insn.ops[1]; const size = d.size; const bits = BITS[size];
    if (d.t === OT.MEM && s.t !== OT.IMM) { E.fallback(insn); return; } // bit-string addressing
    if (E.flagsLive() & FL_REST) E.materialize(); else E.discardFlags(); // ZF kept (the rest undefined): only if read
    E.loadOp(s); c.i32(bits - 1).and().set(L_T4);
    loadDst(E, d); c.set(L_T5);
    // CF = (v >> off) & 1
    c.get(L_EFLAGS).i32(~F.CF).and().get(L_T5).get(L_T4).shr_u().i32(1).and().or().set(L_EFLAGS);
    if (kind === 0) return;
    if (kind === 1) c.get(L_T5).i32(1).get(L_T4).shl().or();
    else if (kind === 2) c.get(L_T5).i32(1).get(L_T4).shl().i32(-1).xor().and();
    else c.get(L_T5).i32(1).get(L_T4).shl().xor();
    maskTo(E, size); c.set(L_TV);
    E.storeOpFrom(d, L_TV, insn);
  };
}
HANDLERS[OP.BT] = bitOp(0); HANDLERS[OP.BTS] = bitOp(1); HANDLERS[OP.BTR] = bitOp(2); HANDLERS[OP.BTC] = bitOp(3);
HANDLERS[OP.BSF] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  E.loadOp(s); c.set(L_T4);
  c.get(L_T4).eqz().set(L_LZA); c.get(L_T4).set(L_LZRES);
  c.get(L_T4);
  const i = c.if_(); c.get(L_T4).ctz().set(L_TV); E.storeRegFrom(d.size, d.r, L_TV); c.end(); void i;
  E.setLazy(LZ.BSF, d.size);
};
HANDLERS[OP.BSR] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  E.loadOp(s); c.set(L_T4);
  c.get(L_T4).eqz().set(L_LZA); c.get(L_T4).set(L_LZRES);
  c.get(L_T4);
  const i = c.if_(); c.i32(31).get(L_T4).clz().sub().set(L_TV); E.storeRegFrom(d.size, d.r, L_TV); c.end(); void i;
  E.setLazy(LZ.BSF, d.size);
};

// ---- stack
function pushValue(E, size) { // value in L_TV
  const c = E.c;
  c.get(L_REG + 4).i32(size).sub().set(L_REG + 4);
  c.get(L_REG + 4).get(L_TV); if (size === 2) c.i32store16(0); else c.i32store(0, 0);
}
HANDLERS[OP.PUSH] = (E, insn) => {
  const c = E.c; const s = insn.ops[0]; const size = insn.opsize;
  if (s.t === OT.SEG) { // 16-bit store of the selector, the upper bytes of the slot untouched (as the interpreter)
    c.get(L_REG + 4).i32(size).sub().set(L_REG + 4);
    c.get(L_REG + 4).get(L_STATE).i32load16u(ST.SEG + 2 * s.r).i32store16(0);
    return;
  }
  if (s.t === OT.IMM) c.i32(s.size === 1 ? (s.v << 24) >> 24 : s.v | 0); else E.loadOp(s);
  c.set(L_TV);
  pushValue(E, size);
};
HANDLERS[OP.POP] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = insn.opsize;
  if (d.t === OT.SEG) { // the selector only (flat model: no descriptor load, as the interpreter)
    c.get(L_STATE).get(L_REG + 4).i32load16u(0).i32store16(ST.SEG + 2 * d.r);
    c.get(L_REG + 4).i32(size).add().set(L_REG + 4);
    return;
  }
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
  c.get(L_REG + 4).i32(size).add().set(L_REG + 4);
  if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA).get(L_TV); E.storeMem(size); E.smcCheck(insn); } else E.storeRegFrom(size, d.r, L_TV);
};
HANDLERS[OP.PUSHA] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  c.get(L_REG + 4).set(L_T4);
  for (const r of [0, 1, 2, 3]) { E.loadReg(size, r); c.set(L_TV); pushValue(E, size); }
  c.get(L_T4); maskTo(E, size); c.set(L_TV); pushValue(E, size);
  for (const r of [5, 6, 7]) { E.loadReg(size, r); c.set(L_TV); pushValue(E, size); }
};
HANDLERS[OP.POPA] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  for (const r of [7, 6, 5, -1, 3, 2, 1, 0]) {
    c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
    c.get(L_REG + 4).i32(size).add().set(L_REG + 4);
    if (r >= 0) E.storeRegFrom(size, r, L_TV);
  }
};
HANDLERS[OP.PUSHF] = (E, insn) => { const c = E.c; E.materialize(); c.get(L_EFLAGS).i32(0x00fcffff).and(); maskTo(E, insn.opsize); c.set(L_TV); pushValue(E, insn.opsize); };
HANDLERS[OP.POPF] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  E.discardFlags(); // every arithmetic flag comes from the stack
  const w = (F.CF | F.PF | F.AF | F.ZF | F.SF | F.DF | F.OF | (1 << 14) | (1 << 18) | (1 << 21)) & (size === 2 ? 0xffff : -1);
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.i32(w).and().set(L_TV);
  c.get(L_REG + 4).i32(size).add().set(L_REG + 4);
  c.get(L_EFLAGS).i32(~w).and().get(L_TV).or().i32(F.RESERVED1).or().set(L_EFLAGS);
};
HANDLERS[OP.LAHF] = (E) => { const c = E.c; E.materialize(); c.get(L_EFLAGS).i32(0xd5).and().i32(2).or().set(L_TV); E.storeRegFrom(1, 4, L_TV); };
HANDLERS[OP.SAHF] = (E) => { const c = E.c; E.materialize(); E.loadReg(1, 4); c.i32(0xd5).and().get(L_EFLAGS).i32(~0xd5).and().or().i32(F.RESERVED1).or().set(L_EFLAGS); };
HANDLERS[OP.ENTER] = (E, insn) => {
  if ((insn.ext & 31) !== 0 || insn.opsize !== 4) { E.fallback(insn); return; }
  const c = E.c;
  c.get(L_REG + 5).set(L_TV); pushValue(E, 4);
  c.get(L_REG + 4).set(L_REG + 5);
  c.get(L_REG + 4).i32(insn.imm).sub().set(L_REG + 4);
};
HANDLERS[OP.LEAVE] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  c.get(L_REG + 5).set(L_REG + 4);
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
  c.get(L_REG + 4).i32(size).add().set(L_REG + 4);
  E.storeRegFrom(size, 5, L_TV);
};

// ---- control flow
HANDLERS[OP.JMP] = (E, insn, b) => {
  const t = insn.ops[0];
  if (t.t === OT.REL) { E.jumpTo(t.v, b.insns.length); return; }
  const api = insn.inlineApi;
  if (api) { // an import stub `jmp [slot]` to a fast API: run inline, then return (as RET does: to a return site of the region locally)
    const c = E.c, slow = c.block();
    c.i32(0).i32load(api.slot).i32(api.thunk).ne().get(L_STATE).i32load(ST.RESUMING).or().hint(false).br_if(slow);
    emitInlineApi(E, api.fid, slow, true);
    E.stats.inlineApi = (E.stats.inlineApi ?? 0) + 1;
    for (const site of E.retSitesOf[E.cur] ?? []) {
      c.get(L_TV).i32(site).eq();
      const i = c.if_(); E.count(PF.retLocal); E.inRet = true; E.jumpTo(site, E.insnIdx); E.inRet = false; c.end(); void i;
    }
    E.count(PF.ret);
    c.get(L_TV);
    E.exitToStack();
    c.end(); // slow
  }
  E.loadOp(t); if (insn.opsize === 2) E.c.i32(0xffff).and();
  E.count(PF.indirect);
  if (globalThis.ORTHROS_SITE_PROF) { E.c.set(L_TV); E.siteProf(insn.addr, 'ijmp'); E.c.get(L_TV); }
  E.exitToStack();
};
HANDLERS[OP.JCC] = (E, insn, b) => {
  const c = E.c;
  E.pushCond(insn.cc);
  const i = c.if_();
  E.jumpTo(insn.ops[0].v, b.insns.length);
  c.end(); void i;
};
HANDLERS[OP.CALL] = (E, insn, b) => {
  const c = E.c; const t = insn.ops[0];
  if (t.t === OT.REL) {
    c.i32(insn.next).set(L_TV); pushValue(E, insn.opsize);
    E.inCall = true; E.jumpTo(insn.opsize === 2 ? t.v & 0xffff : t.v, b.insns.length); E.inCall = false; // (inCall: see siteProf)
    return;
  }
  // a fast API through a slot that still holds its thunk (and no parked call being resumed): run inline, the block
  // goes on (see inlineApiOf); otherwise the ordinary call below
  const api = insn.inlineApi, done = api ? c.block() : null;
  if (api) {
    const slow = c.block();
    c.i32(0).i32load(api.slot).i32(api.thunk).ne().get(L_STATE).i32load(ST.RESUMING).or().hint(false).br_if(slow);
    emitInlineApi(E, api.fid, slow);
    E.stats.inlineApi = (E.stats.inlineApi ?? 0) + 1;
    c.br(done);
    c.end(); // slow
  }
  E.loadOp(t); c.set(L_T4);
  c.i32(insn.next).set(L_TV); pushValue(E, insn.opsize);
  c.get(L_T4); if (insn.opsize === 2) c.i32(0xffff).and();
  E.count(PF.indirect);
  if (globalThis.ORTHROS_SITE_PROF) { c.set(L_TV); E.siteProf(insn.addr, t.t === OT.MEM && t.base < 0 && t.index < 0 ? 'icallAbs' : 'icall'); c.get(L_TV); }
  E.exitToStack();
  if (api) c.end(); // done: the block continues after the call
};
/**
 * The dispatcher's fast path (runtime.js fastApi) of API `fid` on the register locals: stdcall arguments at [esp]
 * (no return address pushed), popped; result in eax; `slow` taken for the cases left to the JavaScript handler
 * (a critical section owned by another thread, a TLS index beyond the TEB's slots).
 */
function emitInlineApi(E, fid, slow, viaJmp = false) {
  const c = E.c, SP = L_REG + 4, AX = L_REG, TEB = L_FS, A = L_T4, T = L_T3;
  // reached by a jump from an import stub: the caller's return address on top of the stack (into L_TV, popped with the
  // arguments); called: the arguments at [esp]
  const base = viaJmp ? 4 : 0;
  if (viaJmp) c.get(SP).i32load(0).set(L_TV);
  const arg = (k) => { c.get(SP).i32load(base + 4 * k); };
  const pop = (n) => { if (base + 4 * n) c.get(SP).i32(base + 4 * n).add().set(SP); };
  switch (fid) {
    case 1: c.get(TEB).i32load(0x34).set(AX); pop(0); break; // GetLastError
    case 2: c.get(TEB); arg(0); c.i32store(0x34); c.i32(0).set(AX); pop(1); break; // SetLastError
    case 3: // TlsGetValue(i < 64): the last error cleared
      arg(0); c.tee(A).i32(64).ge_u().br_if(slow);
      c.get(TEB).i32(0).i32store(0x34);
      c.get(TEB).get(A).i32(2).shl().add().i32load(0xe10).set(AX); pop(1); break;
    case 4: // TlsSetValue(i < 64, v)
      arg(0); c.tee(A).i32(64).ge_u().br_if(slow);
      c.get(TEB).get(A).i32(2).shl().add(); arg(1); c.i32store(0xe10); c.i32(1).set(AX); pop(2); break;
    case 5: { // EnterCriticalSection: owned by this thread -> recursion; free -> taken; else the JavaScript handler
      arg(0); c.set(A);
      const done = c.block(), own = c.block();
      c.get(A).i32load(12).get(TEB).i32load(0x24).eq().br_if(own);
      c.get(A).i32load(4).i32(-1).ne().br_if(slow);
      c.get(A).i32(0).i32store(4); c.get(A).i32(1).i32store(8); c.get(A).get(TEB).i32load(0x24).i32store(12);
      c.br(done);
      c.end(); // own
      c.get(A).get(A).i32load(8).i32(1).add().i32store(8); c.get(A).get(A).i32load(4).i32(1).add().i32store(4);
      c.end(); // done
      c.i32(0).set(AX); pop(1); break;
    }
    case 6: { // LeaveCriticalSection
      arg(0); c.set(A);
      c.get(A).get(A).i32load(8).i32(1).sub().tee(T).i32store(8);
      c.get(A).get(A).i32load(4).i32(1).sub().i32store(4);
      c.get(T).i32(0).le_s(); const i = c.if_(); c.get(A).i32(0).i32store(12); c.get(A).i32(-1).i32store(4); c.get(A).i32(0).i32store(8); c.end(); void i;
      c.i32(0).set(AX); pop(1); break;
    }
    case 8: arg(0); c.set(A); c.get(A).get(A).i32load(0).i32(1).add().tee(AX).i32store(0); pop(1); break; // InterlockedIncrement
    case 9: arg(0); c.set(A); c.get(A).get(A).i32load(0).i32(1).sub().tee(AX).i32store(0); pop(1); break; // InterlockedDecrement
    case 10: arg(0); c.set(A); c.get(A).i32load(0).set(T); c.get(A); arg(1); c.i32store(0); c.get(T).set(AX); pop(2); break; // InterlockedExchange
    case 11: arg(0); c.set(A); c.get(A).i32load(0).set(T); c.get(A).get(T); arg(1); c.add().i32store(0); c.get(T).set(AX); pop(2); break; // ExchangeAdd
    case 12: { // InterlockedCompareExchange(dest, exchange, comparand)
      arg(0); c.set(A); c.get(A).i32load(0).set(T);
      c.get(T); arg(2); c.eq(); const i = c.if_(); c.get(A); arg(1); c.i32store(0); c.end(); void i;
      c.get(T).set(AX); pop(3); break;
    }
    case 13: c.get(TEB).i32load(0x24).set(AX); pop(0); break; // GetCurrentThreadId
    case 14: c.get(TEB).i32load(0x20).set(AX); pop(0); break; // GetCurrentProcessId
    case 15: c.i32(0).i32load(PROC_CONSTS).set(AX); pop(0); break; // GetProcessHeap
    case 17: case 18: { // a mutex (memory.js MUTEX_HANDLES; A = its state: owner, count, flags)
      arg(0); c.tee(A).i32(MUTEX_HANDLE_END).ge_u().get(A).i32(3).and().or().br_if(slow);
      c.get(A).i32load(MUTEX_HANDLES).tee(A).eqz().br_if(slow);
      if (fid === 17) { // WaitForSingleObject: owned by this thread -> recursion; free, no flag -> taken
        const done = c.block(), own = c.block();
        c.get(A).i32load(0).tee(T).get(TEB).i32load(0x24).eq().br_if(own);
        c.get(T).get(A).i32load(8).or().br_if(slow);
        c.get(A).get(TEB).i32load(0x24).i32store(0); c.get(A).i32(1).i32store(4);
        c.br(done);
        c.end(); // own
        c.get(A).get(A).i32load(4).i32(1).add().i32store(4);
        c.end(); // done
        c.i32(0).set(AX); pop(2);
      } else { // ReleaseMutex by its owner: one level less; the last one without a parked waiter
        c.get(A).i32load(0).get(TEB).i32load(0x24).ne().br_if(slow);
        c.get(A).i32load(4).i32(1).sub().tee(T).eqz().get(A).i32load(8).i32(0).ne().and().br_if(slow);
        c.get(A).get(T).i32store(4);
        c.get(T).eqz(); const i = c.if_(); c.get(A).i32(0).i32store(0); c.end(); void i;
        c.i32(1).set(AX); pop(1);
      }
      break;
    }
    default: throw new Error(`emitInlineApi: fid ${fid}`);
  }
}
HANDLERS[OP.RET] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
  c.get(L_REG + 4).i32(size + (insn.ops.length ? insn.ops[0].v : 0)).add().set(L_REG + 4);
  // returning to a call site of this region (a callee inlined into the caller's region): intra-region jump
  // instead of leaving the region and chaining back into it
  for (const site of E.retSitesOf[E.cur] ?? []) {
    c.get(L_TV).i32(site).eq();
    const i = c.if_(); E.count(PF.retLocal); E.inRet = true; E.jumpTo(site, E.insnIdx); E.inRet = false; c.end(); void i;
  }
  E.count(PF.ret);
  E.siteProf(insn.addr, 'ret');
  c.get(L_TV);
  E.exitToStack();
};
function loopOp(kind) {
  return (E, insn, b) => {
    const c = E.c;
    if (insn.adsize === 2) { E.fallback(insn); return; }
    if (kind === 'jecxz') { c.get(L_REG + 1).eqz(); }
    else {
      c.get(L_REG + 1).i32(1).sub().set(L_REG + 1);
      c.get(L_REG + 1).i32(0).ne();
      if (kind === 'loope') { E.pushCond(4); c.and(); } else if (kind === 'loopne') { E.pushCond(5); c.and(); }
    }
    const i = c.if_(); E.jumpTo(insn.ops[0].v, b.insns.length); c.end(); void i;
  };
}
HANDLERS[OP.LOOP] = loopOp('loop'); HANDLERS[OP.LOOPE] = loopOp('loope'); HANDLERS[OP.LOOPNE] = loopOp('loopne'); HANDLERS[OP.JECXZ] = loopOp('jecxz');
HANDLERS[OP.HLT] = (E, insn) => E.exitCode(EXIT.HALT, insn.addr);
HANDLERS[OP.INT3] = (E, insn) => E.exitCode(EXIT.BREAK, insn.addr, 3);
HANDLERS[OP.UD2] = (E, insn) => E.exitCode(EXIT.FAULT, insn.addr, 6);
HANDLERS[OP.INVALID] = (E, insn) => E.exitCode(EXIT.FAULT, insn.addr, 6);
HANDLERS[OP.NOP] = () => {};
HANDLERS[OP.PAUSE] = () => {};
HANDLERS[OP.WAIT] = () => {};
HANDLERS[OP.LFENCE] = () => {}; HANDLERS[OP.MFENCE] = () => {}; HANDLERS[OP.SFENCE] = () => {}; HANDLERS[OP.PREFETCH] = () => {}; HANDLERS[OP.CLFLUSH] = () => {};
HANDLERS[OP.CLC] = (E) => { if (E.flagsLive() & FL_REST) E.materialize(); else E.discardFlags(); E.c.get(L_EFLAGS).i32(~F.CF).and().set(L_EFLAGS); };
HANDLERS[OP.STC] = (E) => { if (E.flagsLive() & FL_REST) E.materialize(); else E.discardFlags(); E.c.get(L_EFLAGS).i32(F.CF).or().set(L_EFLAGS); };
HANDLERS[OP.CMC] = (E) => { E.materialize(); E.c.get(L_EFLAGS).i32(F.CF).xor().set(L_EFLAGS); };
HANDLERS[OP.CLD] = (E) => { E.c.get(L_EFLAGS).i32(~F.DF).and().set(L_EFLAGS); };
HANDLERS[OP.STD] = (E) => { E.c.get(L_EFLAGS).i32(F.DF).or().set(L_EFLAGS); };
HANDLERS[OP.CLI] = () => {}; HANDLERS[OP.STI] = () => {};

// ---- string ops (32-bit address size; DF from EFLAGS)
/** REP MOVS / REP STOS below this many elements run the element loop: memory.copy / memory.fill cost a call into
 *  the engine (~8-10 ns in V8, more for overlapping copies) where the loop moves an element in ~0.6 ns (MOVS) or
 *  ~0.4 ns (STOS) — the crossovers measured with tools/strop-bench.mjs. */
const REP_BULK_MIN = { movs: 12, stos: 28 };
/**
 * REP MOVS / REP STOS (L_T4 = the signed element step, L_T6 = EDI before). The whole range goes to one
 * memory.copy / memory.fill when that gives the element-by-element result:
 * - MOVS, either direction, unless the destination starts inside the source range on the side the copy moves
 *   towards (forward with 0 < EDI-ESI < bytes, backward with 0 < ESI-EDI < bytes): there the x86 element order
 *   reads bytes it has already written and replicates a pattern, which memmove semantics would not. (A C
 *   runtime's memmove copies forward when dst < src and backward — STD — when dst > src: both qualify.)
 *   Not with an FS-overridden source (a segment base: the element loop adds it).
 * - STOS, either direction, when the element is one byte repeated (always for bytes; memset's replicated
 *   pattern for words/dwords): the filled range is the same whatever the order.
 * The range is [ESI/EDI, +bytes) forward and [ESI/EDI + size - bytes, ESI/EDI + size) backward; ESI/EDI end
 * moved by ECX * step, ECX = 0. A range reaching outside the memory traps before writing anything where the
 * element loop traps part-way: JIT'd code reports either as a fault in the region, without precise registers.
 * Counts under REP_BULK_MIN or whose byte length would not fit in 31 bits (no wrap-around in the arithmetic),
 * and the cases above, run the element loop.
 */
function repStore(E, insn, kind, size, fsSrc, body) {
  const c = E.c; const sz = size; const min = REP_BULK_MIN[kind];
  const outer = c.block();
  if (!(kind === 'movs' && fsSrc)) {
    c.get(L_REG + 1).i32(min).sub().i32(((0x7fffffff / sz) | 0) - min + 1).lt_u();
    const cand = c.if_();
    c.get(L_REG + 1).i32(sz).mul().set(L_T7); // byte length
    // one arm per direction (constant offsets: measured 1-2 ns cheaper than selecting them from L_T4)
    const arm = (back) => {
      if (kind === 'movs') {
        // how far the destination lies ahead of the source in the copy direction: unsafe when in [1, bytes-1]
        if (back) c.get(L_REG + 6).get(L_REG + 7); else c.get(L_REG + 7).get(L_REG + 6);
        c.sub().i32(1).sub().get(L_T7).i32(1).sub().ge_u();
      } else if (sz > 1) { E.loadReg(sz, 0); E.loadReg(1, 0); c.i32(sz === 4 ? 0x01010101 : 0x0101).mul().eq(); }
      const ok = kind === 'movs' || sz > 1 ? c.if_() : null;
      // the low ends of the ranges: ESI/EDI forward, ESI/EDI + size - bytes backward
      const low = (r) => { c.get(L_REG + r); if (back) c.i32(sz).add().get(L_T7).sub(); };
      if (kind === 'movs') { low(7); low(6); c.get(L_T7).memcopy(); } else { low(7); E.loadReg(1, 0); c.get(L_T7).memfill(); }
      if (kind === 'movs') { c.get(L_REG + 6).get(L_T7); if (back) c.sub(); else c.add(); c.set(L_REG + 6); }
      c.get(L_REG + 7).get(L_T7); if (back) c.sub(); else c.add(); c.set(L_REG + 7);
      c.i32(0).set(L_REG + 1);
      c.br(outer);
      if (ok) c.end();
    };
    c.get(L_T4).i32(0).lt_s(); const dir = c.if_(); arm(true); c.else_(); arm(false); c.end(); void dir;
    c.end(); void cand;
  }
  // element loop (one loop stepping by L_T4: two loops with constant steps, one per direction, measured ~1 ns slower)
  c.get(L_REG + 1);
  const any = c.if_();
  const lp = c.loop(); body(); c.get(L_REG + 1).i32(1).sub().tee(L_REG + 1).br_if(lp); c.end();
  c.end(); void any;
  c.end(); void outer;
}
function strOp(kind) {
  return (E, insn) => {
    const c = E.c;
    if (insn.adsize === 2) { E.fallback(insn); return; }
    const size = insn.ops[0].size; const sz = size;
    const fsBase = insn.ops.some((o) => o.seg === SEG.FS) ? L_FS : -1;
    // delta = DF ? -size : size
    c.get(L_EFLAGS).i32(F.DF).and(); const ifd = c.if_(T.i32); c.i32(-sz); c.else_(); c.i32(sz); c.end(); void ifd; c.set(L_T4);
    const body = () => {
      switch (kind) {
        case 'movs': c.get(L_REG + 7).get(L_REG + 6); if (fsBase >= 0) c.get(L_FS).add(); E.loadMem(size); E.storeMem(size); c.get(L_REG + 6).get(L_T4).add().set(L_REG + 6); c.get(L_REG + 7).get(L_T4).add().set(L_REG + 7); break;
        case 'stos': c.get(L_REG + 7); E.loadReg(size, 0); E.storeMem(size); c.get(L_REG + 7).get(L_T4).add().set(L_REG + 7); break;
        case 'lods': c.get(L_REG + 6); if (fsBase >= 0) c.get(L_FS).add(); E.loadMem(size); c.set(L_TV); E.storeRegFrom(size, 0, L_TV); c.get(L_REG + 6).get(L_T4).add().set(L_REG + 6); break;
        case 'scas': E.loadReg(size, 0); c.set(L_LZA); c.get(L_REG + 7); E.loadMem(size); c.set(L_LZB); c.get(L_LZA).get(L_LZB).sub(); maskTo(E, size); c.set(L_LZRES); c.i32((LZ.SUB << 2) | SZLOG[size]).set(L_LZOP); c.get(L_REG + 7).get(L_T4).add().set(L_REG + 7); break;
        case 'cmps': c.get(L_REG + 6); if (fsBase >= 0) c.get(L_FS).add(); E.loadMem(size); c.set(L_LZA); c.get(L_REG + 7); E.loadMem(size); c.set(L_LZB); c.get(L_LZA).get(L_LZB).sub(); maskTo(E, size); c.set(L_LZRES); c.i32((LZ.SUB << 2) | SZLOG[size]).set(L_LZOP); c.get(L_REG + 6).get(L_T4).add().set(L_REG + 6); c.get(L_REG + 7).get(L_T4).add().set(L_REG + 7); break;
      }
    };
    const isCmp = kind === 'scas' || kind === 'cmps';
    const writes = kind === 'movs' || kind === 'stos';
    if (writes) c.get(L_REG + 7).set(L_T6); // EDI before: the written range is checked for translated code afterwards
    if (!insn.rep) { body(); if (isCmp) E.lz = { kind: LZ.SUB, sz: SZLOG[size] }; if (writes) E.smcRange(L_T6, insn); return; }
    // (every REP MOVS/STOS checks its range for translated code, word/dword STOS included)
    if (writes) { repStore(E, insn, kind, size, fsBase >= 0, body); E.lz = null; E.smcRange(L_T6, insn); return; }
    if (isCmp) E.materialize();
    // generic rep loop (lods/scas/cmps)
    const lp = c.loop();
    c.get(L_REG + 1).eqz();
    const ex = c.if_();
    c.else_();
    body();
    c.get(L_REG + 1).i32(1).sub().set(L_REG + 1);
    if (isCmp) {
      // repe: continue while ZF; repne: continue while !ZF
      c.get(L_LZRES).eqz(); if (insn.rep === 0xf2) c.eqz();
      const cont = c.if_(); c.br(lp); c.end(); void cont;
    } else c.br(lp);
    c.end(); void ex;
    c.end();
    // cmps/scas: the lazy op is set per iteration, so ecx == 0 leaves the (materialized) flags untouched
    E.lz = null;
  };
}
HANDLERS[OP.MOVS] = strOp('movs'); HANDLERS[OP.STOS] = strOp('stos'); HANDLERS[OP.LODS] = strOp('lods');
HANDLERS[OP.SCAS] = strOp('scas'); HANDLERS[OP.CMPS] = strOp('cmps');

export { L_S32, L_F32A, L_F32B, L_F32C, L_F64D, L_F64E, L_F64G, L_F64H, L_SW, L_CUT24, L_XS0, L_XD0, XMM_SHADOW_OPS, XMM_SHADOW64_OPS, Emitter, PF };
export { HANDLERS, L_STATE, L_REG, L_EFLAGS, L_LZOP, L_LZRES, L_LZA, L_LZB, L_TA, L_TV, L_T2, L_T3, L_T4, L_T5, L_T6, L_T7, L_XSH, L_I64A, L_I64B, L_F64A, L_F64B, L_TOP, L_FS, L_V0, L_V1, L_V2, L_XMM0, L_ST0, L_FTW, L_FPC, L_F64C, IMP_FLAGS, IMP_ROUND24, IMP_FALLBACK, IMP_EXP2M1, IMP_LOG2, IMP_LOG2P1, IMP_SCALB, IMP_SIN, IMP_COS, IMP_TAN, IMP_ATAN2, IMP_SINCOS, IMP_NAN2, IMP_ARITH24, IMP_F32RC, IMP_X87_ARITHF32, IMP_X87_ROUNDF32, IMP_X87_NANARITH, MASK, SIGN, BITS, touchesFpu };

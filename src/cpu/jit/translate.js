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
import { decode, OP, OT } from '../decoder.js';
import { ST, EXIT, F, SEG } from '../state.js';
import { LZ, REGION_PARAMS, REGION_RESULTS, HASH_ENTRY, HASH_PROBES, MATH_KERNELS, EXIT_FPUMODE, EXIT_STEP } from './runtime.js';
import { THUNK_BASE, THUNK_END, SMC_MAP_BASE, JIT_HASH_BASE, JIT_HASH_BITS, JIT_SCRATCH_BASE } from '../memory.js';

// Locals 0..15 are the function parameters (REGION_PARAMS), declared locals start at 16.
const L_BLK = 0, L_STATE = 1, L_REG = 2, L_EFLAGS = 10, L_LZOP = 11, L_LZRES = 12, L_LZA = 13, L_LZB = 14, L_FS = 15;
const L_TA = 16, L_TV = 17, L_T2 = 18, L_T3 = 19, L_T4 = 20, L_T5 = 21, L_T6 = 22, L_T7 = 23;
const L_I64A = 24, L_I64B = 25, L_F64A = 26, L_F64B = 27, L_TOP = 28, L_T8 = 29;
const L_V0 = 30, L_V1 = 31, L_V2 = 32; // v128 temporaries (SSE/MMX translation)
// x87 register stack cached in locals (x87 regions only, see Emitter.usesX87): L_ST0+i holds
// ST(i) (logical order, physical slot (L_TOP+i)&7), L_FTW the abridged tag word in the same
// logical order (bit i = ST(i) non-empty; ST.FPU_TW keeps the physical order, bit s = slot s),
// L_FPC the control word's PC/RC bits (cw & 0xf00).
const L_ST0 = 33, L_FTW = 41, L_FPC = 42;
const L_F64C = 43; // f64 temporary (x87 results kept apart from their operands)
// the instruction budget (ST.ICOUNT) cached in a local for the whole region: decremented in a register at every
// block transition, written back to the state block only when the region is left (exit, chain)
const L_ICOUNT = 44;
// 24-bit precision x87 blocks keep register values that are exact floats in f32 locals (L_S32+k shadows
// L_ST0+k, see Emitter.f32Mask) and compute with f32 arithmetic; L_F32A..C are f32 temporaries
const L_S32 = 45, L_F32A = 53, L_F32B = 54, L_F32C = 55;
const L_FIRST_DECLARED = 16;
const LOCAL_TYPES = [...Array(8).fill(T.i32), T.i64, T.i64, T.f64, T.f64, T.i32, T.i32, T.v128, T.v128, T.v128, ...Array(8).fill(T.f64), T.i32, T.i32, T.f64, T.i32, ...Array(8).fill(T.f32), T.f32, T.f32, T.f32]; // indices 16..55
if (LOCAL_TYPES.length !== L_F32C + 1 - L_FIRST_DECLARED || REGION_PARAMS.length !== L_FIRST_DECLARED) throw new Error('region local layout mismatch');
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
if (MATH_KERNELS.length !== 12 || MATH_KERNELS[0][0] !== 'exp2m1' || MATH_KERNELS[7][0] !== 'atan2' || MATH_KERNELS[8][0] !== 'sincos' || MATH_KERNELS[9][0] !== 'nan2' || MATH_KERNELS[10][0] !== 'arith24' || MATH_KERNELS[11][0] !== 'f32rc') throw new Error('math kernel import layout mismatch');

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];
const BITS = [0, 8, 16, 0, 32];
const SZLOG = [0, 0, 1, 0, 2];
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;

export const MAX_BLOCKS = 48;
/** at most this many call-return sites compared inline at a RET (more: the RET leaves the region) */
const MAX_RET_SITES = 16;
export const MAX_INSNS = 400;

/** Terminator classes */
const TERM_NONE = 0, TERM_JMP = 1, TERM_JCC = 2, TERM_CALL = 3, TERM_RET = 4, TERM_INDIRECT = 5, TERM_EXIT = 6, TERM_LOOP = 7;

function termOf(insn) {
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

// Lazy kinds whose CF / OF Emitter.pushCond computes inline (the same formulas as the flags helper); ZF, SF and PF
// come from the result for every kind. SHL (CF/OF depend on the count in a way not worth inlining) is left to the helper.
const CF_INLINE = new Set([LZ.ADD, LZ.SUB, LZ.LOGIC, LZ.INC, LZ.DEC, LZ.NEG, LZ.ADC, LZ.SBB, LZ.SHR, LZ.SAR, LZ.MUL, LZ.IMUL, LZ.SHLD, LZ.BSF]);
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
  'NOP', 'PAUSE', 'CLD', 'STD', 'MOVS', 'STOS', 'LODS', 'XLAT', 'LFENCE', 'MFENCE', 'SFENCE', 'PREFETCH', 'CLFLUSH', 'WAIT', 'EMMS'].map((n) => OP[n]));
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
/** Instructions that load the x87 control word (precision / rounding control). */
const FPU_MODE_WRITERS = new Set([OP.FLDCW, OP.FNINIT, OP.FLDENV, OP.FRSTOR, OP.FXRSTOR, OP.FNSAVE]);

/**
 * Blocks whose x87 precision/rounding control is statically the region's assumed one: every block
 * entered from outside runs under it (the region entry checks it), and it holds until an instruction
 * of FPU_MODE_WRITERS; blocks reachable inside the region from such an instruction get the dynamic
 * (L_FPC-tested) code. Returns known[i] (1 = the assumed mode holds at block entry).
 */
function planFpuModes(blocks, byEip, retSites) {
  const n = blocks.length, known = new Uint8Array(n).fill(1);
  const succ = blocks.map((b) => {
    const s = [], last = b.insns[b.insns.length - 1];
    const add = (eip) => { const t = byEip.get(eip); if (t) s.push(t.index); };
    if (last) {
      const t = branchTarget(last);
      if (t >= 0) add(t);
      if (b.term === TERM_RET) for (const r of retSites) add(r);
    }
    if (b.term === TERM_NONE || b.term === TERM_JCC || b.term === TERM_LOOP) add(b.fallthrough);
    return s;
  });
  const work = [];
  blocks.forEach((b, i) => { if (b.insns.some((x) => FPU_MODE_WRITERS.has(x.op))) work.push(i); });
  const seen = new Uint8Array(n);
  while (work.length) {
    const i = work.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    for (const j of succ[i]) { known[j] = 0; if (!seen[j]) work.push(j); }
  }
  return known;
}

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
  const isBoundary = (a) => (boundaries && boundaries.has(a)) || (a >= THUNK_BASE && a < THUNK_END);
  const leaders = new Set([entry]);
  const queue = [entry];
  const decoded = new Map(); // eip -> insn (shared cache within this translation)
  let total = 0;
  const dec = (a) => { let i = decoded.get(a); if (!i) { i = decode(mem, a); decoded.set(a, i); } return i; };
  // pass 1: find leaders
  while (queue.length && leaders.size <= MAX_BLOCKS && total < MAX_INSNS * 2) {
    let a = queue.shift();
    for (let n = 0; n < MAX_INSNS; n++) {
      if (isBoundary(a)) break;
      let insn;
      try { insn = dec(a); } catch { break; }
      total++;
      const term = termOf(insn);
      const addLeader = (t) => { if (!isBoundary(t) && !leaders.has(t) && leaders.size < MAX_BLOCKS) { leaders.add(t); queue.push(t); } };
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
  return { blocks, byEip };
}

/** the type and import sections, identical in every region module, are encoded once */
const REGION_HEADER = {};
let regionTemplate = null;
/** one emission buffer reused by every translation (grown once instead of from 4 KB per region) */
let scratchCode = null;

/**
 * Emit a complete region module. Returns { bytes, blocks } where blocks[i] = { eip, index }.
 */
export function translateRegion(mem, entry, opts = {}) {
  const em = new Emitter(mem, opts);
  return em.run(entry);
}

/** Assemble region function bodies into one module exporting r0..rN (same imports for all regions). */
export function buildRegionModule(codes, names = null) {
  if (!regionTemplate) {
    const t = new ModuleBuilder(REGION_HEADER);
    if (t.type(REGION_PARAMS, REGION_RESULTS) !== REGION_TYPE) throw new Error('region type must be type 0');
    t.importMemory('env', 'memory', 32768, 32768);
    t.importTable('env', 'table', 1024, undefined); // shared funcref table (chained tail calls)
    t.importFunc('env', 'flags', [T.i32, T.i32, T.i32, T.i32, T.i32], [T.i32]);
    t.importFunc('env', 'round24', [T.f64, T.i32], [T.f64]);
    t.importFunc('env', 'fallback', [T.i32], [T.i32]);
    for (const [name, params, results] of MATH_KERNELS) t.importFunc('env', name, params, results);
    regionTemplate = t;
  }
  const m = regionTemplate.fork();
  codes.forEach((code, i) => { const f = m.func(REGION_PARAMS, REGION_RESULTS, LOCAL_TYPES, { buf: code, len: code.length, hints: code.hints }, names?.[i] ?? 'r' + i); m.exportFunc('r' + i, f); });
  return m.build();
}

/** Transition counters of profiling translations (opts.profile), ST.PROF + 4 * index. */
export const JIT_PROF = ['forward', 'backward', 'fallthrough', 'ret', 'indirect', 'exit', 'chainSelf', 'chainOther', 'dispatch', 'retLocal', 'flagsNull', 'flagsStatic', 'flagsEager', 'flagsSlowArm', 'chainFromX87'];
const PF = Object.fromEntries(JIT_PROF.map((k, i) => [k, i]));
/** profiling translations: flags helper calls per x86 opcode (u32 per OP value) */
export const PROF_OPS_BASE = JIT_SCRATCH_BASE + 0xa0000;

class Emitter {
  constructor(mem, opts) {
    this.mem = mem;
    this.opts = opts;
    this.c = scratchCode ??= new Code(1 << 16);
    this.c.reset();
    this.lz = null;
    this.smc = opts.smc !== false;
    this.x87 = opts.x87 !== false;
    this.chain = opts.chain !== false;
    this.prof = !!opts.profile; // count block transitions by kind (ST.PROF); opts.fnIdx tells self-chains apart
    // x87 precision/rounding control (cw & 0xf00) the region is specialized for (null: tested at run time)
    this.fpcAssume = opts.fpcAssume ?? null;
    this.stats = { native: 0, fallback: 0 };
  }

  run(entry) {
    const { blocks, byEip } = discoverRegion(this.mem, entry, this.opts);
    if (!blocks.length) throw new Error(`no code at ${entry.toString(16)}`);
    this.blocks = blocks;
    this.byEip = byEip;
    /** x87 region: the register stack, tag word and precision control live in locals (L_ST0..) */
    this.usesX87 = blocks.some((b) => b.insns.some(touchesFpu));
    if (!this.usesX87) this.fpcAssume = null; // (nothing to specialize; L_FPC is not even loaded)
    const c = this.c;
    // registers/flags arrive as parameters; only the x87 TOP cache is loaded from the state block
    // (plus the whole x87 stack in x87 regions)
    c.get(L_STATE).i32load8u(ST.FPU_TOP).set(L_TOP);
    c.get(L_STATE).i32load(ST.ICOUNT).set(L_ICOUNT);
    if (this.usesX87) this.loadX87();
    this.exitCodeL = c.block();
    this.exitJmpL = c.block();
    if (this.fpcAssume !== null) {
      // specialized for one x87 mode: entered under another one, leave (EIP is the entry's, stored by the
      // dispatcher / chain) for the dispatcher to replace the region by one tested at run time
      c.get(L_FPC).i32(this.fpcAssume).ne();
      const i = c.hint(false).if_();
      c.get(L_STATE).i32load(ST.EIP).set(L_TV).i32(EXIT_FPUMODE).set(L_T2).br(this.exitCodeL);
      c.end(); void i;
    }
    this.dispatchL = c.loop();
    const def = c.block();
    // one label per unit: the last unit's is outermost, the first's innermost, so that the u-th
    // `end` closes labels[u] and unit u's code follows it; a forward branch to the first block of a
    // later unit is a plain `br` to that unit's label
    const { top, blockUnit, pathOf } = planUnits(blocks, byEip, !!this.opts.nestLoops);
    this.blockUnit = blockUnit;
    this.pathOf = pathOf;
    // return sites of the region's direct calls: a RET to one of them stays in the region (see HANDLERS[OP.RET])
    this.retSites = blocks.filter((b) => b.term === TERM_CALL && byEip.has(b.fallthrough)).map((b) => b.fallthrough);
    if (this.retSites.length > MAX_RET_SITES) this.retSites = [];
    this.fpcKnown = this.fpcAssume !== null ? planFpuModes(blocks, byEip, this.retSites) : null;
    // top level: the region's dispatcher (entries, unstructured edges) routes a block to its top-level unit
    this.emitUnits(top, () => this.dispatchAmong(top, 0, blocks.length - 1, null, def));
    c.end(); // def
    c.unreachable();
    c.end(); // dispatch loop
    c.end(); // exitJmpL: jump exit (tV = target eip)
    c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
    if (this.chain) this.emitChain();
    this.flushAll();
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    c.get(L_TV).return_();
    c.end(); // exitCodeL: exit with code (tV = eip, t2 = code)
    c.get(L_STATE).get(L_ICOUNT).i32store(ST.ICOUNT);
    this.flushAll();
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    c.get(L_STATE).get(L_T2).i32store(ST.EXIT);
    c.i32(0);
    // module
    // the function body is kept so several regions can later be packed into one module (see Jit.consolidate)
    this.stats.calls = c.callsTo ? c.callsTo.slice() : null; // [import, guest op] of every call (a call anywhere costs spills in the whole function)
    return { code: c.finish(), blocks: blocks.map((b) => ({ eip: b.eip, index: b.index, end: b.end })), stats: this.stats, fpcAssume: this.fpcAssume };
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
  emitChain() {
    const c = this.c;
    const noChain = c.block();
    c.get(L_TV).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u().br_if(noChain);
    c.get(L_TV).get(L_STATE).i32load(ST.STOP_AT).eq().hint(false).br_if(noChain);
    c.get(L_ICOUNT).i32(0).le_s().hint(false).br_if(noChain); // (L_ICOUNT was written back before this chain attempt)
    // hash lookup: L_T2 = home slot, L_TA = entry address of the probe being tested
    const found = c.block();
    c.get(L_TV).i32(0x9e3779b1 | 0).mul().i32(32 - JIT_HASH_BITS).shr_u().set(L_T2);
    for (let p = 0; p < HASH_PROBES; p++) {
      c.get(L_T2); if (p) c.i32(p).add();
      c.i32((1 << JIT_HASH_BITS) - 1).and().i32(HASH_ENTRY).mul().i32(JIT_HASH_BASE).add().tee(L_TA);
      c.i32load(0).get(L_TV).eq().br_if(found);
    }
    c.br(noChain);
    c.end(); // found
    if (this.prof) { c.get(L_TA).i32load(4).i32(this.opts.fnIdx ?? -1).eq(); const i = c.if_(); this.count(PF.chainSelf); c.else_(); this.count(PF.chainOther); c.end(); void i; if (this.usesX87) this.count(PF.chainFromX87); }
    // EIP of the region being entered: a trap inside the chained callee reports the callee's
    // entry (same imprecision as the dispatcher path); registers are not written back
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    this.flushFpu();
    if (this.opts.countChains !== false) c.get(L_STATE).get(L_STATE).i32load(ST.TRANSITIONS).i32(1).add().i32store(ST.TRANSITIONS); // (stats)
    c.get(L_TA).i32load(8); // block index in the target region
    for (let i = L_STATE; i < L_FIRST_DECLARED; i++) c.get(i);
    c.get(L_TA).i32load(4).return_call_indirect(REGION_TYPE, 0);
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
    c.get(L_STATE).i32load(ST.FS_BASE).set(L_FS);
    c.get(L_STATE).i32load8u(ST.FPU_TOP).set(L_TOP);
    if (this.usesX87) this.loadX87();
  }
  flushAll() {
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_STATE).get(L_REG + i).i32store(ST.GPR + 4 * i);
    c.get(L_STATE).get(L_EFLAGS).i32store(ST.EFLAGS);
    c.get(L_STATE).get(L_LZOP).i32store(ST.LZ_OP);
    c.get(L_STATE).get(L_LZRES).i32store(ST.LZ_RES);
    c.get(L_STATE).get(L_LZA).i32store(ST.LZ_SRC1);
    c.get(L_STATE).get(L_LZB).i32store(ST.LZ_SRC2);
    this.flushFpu();
  }

  // ------------------------------------------------------------------ x87 stack cache
  // Inside a block the x87 handlers do not move the locals on push/pop: they keep a static shift
  // (`stShift`, 0 at block entry) such that ST(i) lives in local L_ST0 + ((i + stShift) & 7) and
  // the real TOP is (L_TOP + stShift) & 7. The shift is materialized (x87Normalize: one rotation
  // of the locals, one update of L_TOP) only where the code leaves the block: exits, branches to
  // other blocks, fallbacks, TOP resets. A balanced block (fld ... fstp) never moves a local.
  /** Local holding ST(i) under the pending static shift. */
  stLocal(i) { return L_ST0 + ((i + this.stShift) & 7); }
  /** Bit of ST(i) in L_FTW under the pending static shift. */
  stTagBit(i) { return 1 << ((i + this.stShift) & 7); }
  /** Push the physical slot number of ST(i): (L_TOP + stShift + i) & 7 (L_TOP is always 0..7). */
  pushStPhys(i) { const c = this.c; const k = (this.stShift + i) & 7; c.get(L_TOP); if (k) c.i32(k).add().i32(7).and(); }
  /**
   * Materialize the pending shift: write the f32 shadows back, rotate the locals so that L_ST0+i holds
   * ST(i) again, rotate the logical tag word the same way and make L_TOP the real TOP. Returns the static
   * state that was pending (shift, f32 mask): a conditional exit path restores it afterwards (x87Restore)
   * so that the fallthrough path keeps its unrotated locals and f32 values. Code emitted after it on the
   * same path sees shift 0 and no shadow: a second normalization there (the budget exit of a back edge)
   * must not write the shadows again, into locals the rotation has moved.
   */
  x87Normalize() {
    const saved = { shift: this.stShift, f32: this.f32Mask, tagSet: this.tagSet, tagClr: this.tagClr };
    this.materializeF32();
    this.f32Mask = 0;
    this.applyTags();
    const s = this.stShift;
    if (!s) return saved;
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_ST0 + ((i + s) & 7)); // through the operand stack: no temporary
    for (let i = 7; i >= 0; i--) c.set(L_ST0 + i);
    c.get(L_FTW).i32(s).shr_u().get(L_FTW).i32(8 - s).shl().or().i32(0xff).and().set(L_FTW); // rotr8 by s
    c.get(L_TOP).i32(s).add().i32(7).and().set(L_TOP);
    this.stShift = 0;
    return saved;
  }
  /** Back to the static x87 state returned by x87Normalize (after an exit emitted on a conditional path). */
  x87Restore(saved) { this.stShift = saved.shift; this.f32Mask = saved.f32; this.tagSet = saved.tagSet; this.tagClr = saved.tagClr; }
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
    c.get(L_STATE).i32load16u(ST.FPU_TW).tee(L_T3).get(L_TOP).shr_u().get(L_T3).i32(8).get(L_TOP).sub().shl().or().i32(0xff).and().set(L_FTW);
  }
  /** state block tag word <- L_FTW rotated back to physical order (shift 0). */
  flushX87Tags() {
    const c = this.c;
    c.get(L_STATE).get(L_FTW).get(L_TOP).shl().get(L_FTW).i32(8).get(L_TOP).sub().shr_u().or().i32(0xff).and().i32store16(ST.FPU_TW);
  }
  /** Push the address of the physical slot of ST(i) given L_T3 = L_TOP << 3 (ST.FPR added by the memarg). */
  stSlot(i) { const c = this.c; c.get(L_STATE).get(L_T3); if (i) c.i32(8 * i).add().i32(63).and(); c.add(); }
  /** L_ST0..7 <- FPR[(L_TOP+i)&7] (shift 0, L_TOP current; clobbers L_T3). */
  loadX87Regs() {
    this.c.get(L_TOP).i32(3).shl().set(L_T3);
    for (let i = 0; i < 8; i++) { this.stSlot(i); this.c.f64load(ST.FPR).set(L_ST0 + i); }
  }
  /** FPR[(L_TOP+i)&7] <- L_ST0..7 (shift 0; clobbers L_T3). */
  flushX87Regs() {
    this.c.get(L_TOP).i32(3).shl().set(L_T3);
    for (let i = 0; i < 8; i++) { this.stSlot(i); this.c.get(L_ST0 + i).f64store(ST.FPR); }
  }
  /** x87 region entry / after the interpreter ran: stack values, tag word and PC/RC bits from the state block. */
  loadX87() {
    const c = this.c;
    this.loadX87Tags();
    c.get(L_STATE).i32load16u(ST.FPU_CW).i32(0xf00).and().set(L_FPC);
    this.loadX87Regs();
  }
  /** Write the cached x87 state back (shift 0): TOP always, the stack values and tag word in x87 regions. */
  flushFpu() {
    const c = this.c;
    if (this.usesX87) { this.flushX87Regs(); this.flushX87Tags(); }
    c.get(L_STATE).get(L_TOP).i32store8(ST.FPU_TOP);
  }
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
    this.f32Mask = 0; // the f64 locals were written back (x87Normalize) and possibly reloaded
  }

  // ------------------------------------------------------------------ exits & jumps
  /**
   * Charge n instructions to the budget without checking it: the dispatcher (or the chain guard)
   * checks ST.ICOUNT at the next region entry, so a loop made only of cross-region edges still
   * ends with a time slice.
   */
  count(k) {
    if (!this.prof) return;
    this.c.get(L_STATE).get(L_STATE).i32load(ST.PROF + 4 * k).i32(1).add().i32store(ST.PROF + 4 * k);
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
  exitToStack() { this.c.set(L_TV); this.charge(this.insnIdx); const s = this.x87Normalize(); this.c.br(this.exitJmpL); this.x87Restore(s); }
  exitTo(eip, n = this.insnIdx) { this.count(PF.exit); this.c.i32(eip).set(L_TV); this.charge(n); const s = this.x87Normalize(); this.c.br(this.exitJmpL); this.x87Restore(s); }
  exitCode(code, eip, arg) {
    const c = this.c;
    if (arg !== undefined) c.get(L_STATE).i32(arg).i32store(ST.EXIT_ARG);
    c.i32(eip).set(L_TV).i32(code).set(L_T2);
    const s = this.x87Normalize(); c.br(this.exitCodeL); this.x87Restore(s);
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
  /** Budget check: subtract n and exit TIMESLICE (to eip) when exhausted. */
  budget(n, eip) {
    const c = this.c;
    c.get(L_ICOUNT).i32(n).sub().tee(L_ICOUNT).i32(0).le_s();
    const i = c.hint(false).if_();
    this.exitCode(EXIT.TIMESLICE, eip);
    c.end(); void i;
  }
  /** Jump to a guest address: intra-region branch or exit. `n` instructions consumed for the budget. */
  jumpTo(target, n) {
    const b = this.byEip.get(target);
    if (!b) { this.exitTo(target, n); return; }
    const c = this.c;
    const t = b.index, sp = this.pathOf[this.cur], tp = this.pathOf[t];
    let d = 0; // loops holding both
    while (d < sp.length && d < tp.length && sp[d] === tp[d]) d++;
    const s = this.x87Normalize(); // blocks are entered with shift 0
    if (t > this.cur) {
      // forward: no budget check (every cycle contains a backward edge, which checks it). The unit holding t
      // among the children of the innermost common loop (or the top level) is a later sibling of the one
      // holding the source: its label is in scope; a loop entered elsewhere than at its header dispatches
      this.count(PF.forward);
      this.charge(n);
      const ct = d < tp.length ? tp[d] : this.blockUnit[t];
      if (!ct.loop || ct.first === t) c.br(ct.label);
      else { this.count(PF.dispatch); c.i32(t).set(L_BLK).br(ct.label); }
    } else {
      this.count(PF.backward);
      this.budget(n, target);
      const common = d > 0 ? sp[d - 1] : null;
      if (common) { if (t !== common.first) { this.count(PF.dispatch); c.i32(t).set(L_BLK); } c.br(common.loopL); }
      else { this.count(PF.dispatch); c.i32(t).set(L_BLK).br(this.dispatchL); }
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
    c.get(L_TV).i32load8u(SMC_MAP_BASE);
    const hit = c.hint(false).if_();
    c.get(L_STATE).get(L_TA).i32store(ST.EXIT_ARG); c.get(L_STATE).get(L_T5).get(L_TA).sub().i32store(ST.EXIT_LEN);
    this.exitCode(EXIT.SMC, insn.next);
    c.end(); void hit;
    c.get(L_TV).i32(1).add().tee(L_TV).i32(12).shl().get(L_T5).lt_u().br_if(lp);
    c.end(); c.end(); void done;
    c.end(); void any;
  }
  /**
   * After a store through L_TA: exit with SMC if the page holds translated code (one byte per page). Stores
   * addressed by ESP alone (the stack: locals and arguments without a frame pointer) are not checked, like
   * PUSH: stacks do not hold code.
   */
  smcCheck(insn) {
    if (!this.smc || !insn) return;
    const m = insn.ops.find((o) => o.t === OT.MEM);
    if (m && m.base === 4 && m.index < 0 && !m.a16 && m.seg !== SEG.FS && m.seg !== SEG.GS) return;
    const c = this.c;
    c.get(L_TA).i32(12).shr_u().i32load8u(SMC_MAP_BASE);
    const i = c.hint(false).if_();
    c.get(L_STATE).get(L_TA).i32store(ST.EXIT_ARG);
    this.exitCode(EXIT.SMC, insn.next);
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
   * of any size...) share one arm. Only the other kinds (SHL's CF/OF...) call the flags helper. The lazy
   * state is left as is.
   */
  pushCondDynamic(cc) {
    const c = this.c, base = cc >> 1;
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
    for (let kind = 1; kind <= LZ_KINDS_MAX; kind++) {
      if (!lazyCondInline(base, kind)) continue;
      for (const sz of [0, 1, 2]) add((kind << 2) | sz, { kind, sz });
    }
    const arms = [...byCode.values()];
    const done = c.block(T.i32);
    const slow = c.block();
    for (let k = arms.length - 1; k >= 0; k--) arms[k].label = c.block();
    const table = new Array(Math.max(...arms.flatMap((a) => a.ops)) + 1).fill(slow);
    for (const a of arms) for (const op of a.ops) table[op] = a.label;
    c.get(L_LZOP).br_table(table, slow);
    for (const a of arms) {
      c.end(); // a.label
      this.lz = a.lz; this.pushCond(cc);
      c.br(done);
    }
    c.end(); // slow: another lazy kind
    this.lz = { kind: -1, sz: 2 }; this.materialize(); this.pushCond(cc); // flags helper, then EFLAGS
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
    this.stShift = 0; // pending static rotation of the x87 locals (see stLocal), x87 regions
    this.f32Mask = 0; // x87 locals whose value is in the f32 shadow (see materializeF32)
    this.tagSet = this.tagClr = 0; // pending tag word changes (see applyTags)
    this.insnIdx = 0; // instructions of the block emitted so far (charged to the budget at an exit)
    this.cur = b.index;
    // flags live after each instruction of the block
    const live = (this.flagsAfter = new Uint8Array(b.insns.length));
    for (let i = b.insns.length - 1, l = FL_ALL; i >= 0; i--) { live[i] = l; l = flagsLiveBefore(b.insns[i], l); }
    /** x87 mode (cw & 0xf00) known at this point of the emission, or null (L_FPC tested at run time) */
    this.fpcStatic = this.fpcKnown?.[b.index] ? this.fpcAssume : null;
    for (const insn of b.insns) { this.insnIdx++; this.emitInsn(insn, b); }
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
          this.x87Normalize();
          this.charge(n); // (a loop entered by its top sees L_BLK outside its blocks: see loopPrologue)
          return;
        }
        this.jumpTo(ft, n);
        return;
      }
      default: return; // JMP/RET/INDIRECT/EXIT emitted their own exits
    }
  }

  emitInsn(insn, b) {
    this.curOp = insn.op;
    this.c.site = insn.op; // (call statistics)
    const h = HANDLERS[insn.op];
    if (h) { this.stats.native++; h(this, insn, b); }
    else this.fallback(insn);
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
    this.f32Mask = 0; // x87 values reloaded as f64
    this.tagSet = this.tagClr = 0; // (applied by x87Normalize before the flush, the tag word reloaded)
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
    E.storeOpFrom(d, L_LZRES, insn);
    E.setLazy(isAdc ? LZ.ADC : LZ.SBB, size);
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
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.INC, size);
};
HANDLERS[OP.DEC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  if (E.flagsLive() & FL_CF) E.pushCF(); else c.i32(0);
  c.set(L_T4);
  loadDst(E, d); c.set(L_LZA);
  c.get(L_LZA).i32(1).sub(); maskTo(E, size); c.set(L_LZRES);
  c.get(L_T4).set(L_LZB);
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.DEC, size);
};
HANDLERS[OP.NEG] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  loadDst(E, d); c.set(L_LZA);
  c.i32(0).get(L_LZA).sub(); maskTo(E, size); c.set(L_LZRES);
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.NEG, size);
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
      E.storeOpFrom(d, L_LZRES, insn);
      E.setLazy(kind, size);
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
        E.storeOpFrom(d, L_LZRES, insn);
        if (!live) return; // no flag of this rotate is ever read
        // CF = rol ? res&1 : msb(res); OF = rol ? msb(res)^cf : msb(res)^msb-1(res)  (count==1 defined; we always compute)
        c.get(L_EFLAGS).i32(~(F.CF | F.OF)).and().set(L_EFLAGS);
        if (kind === 'rol') c.get(L_LZRES).i32(1).and().set(L_T3); else c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().set(L_T3);
        c.get(L_EFLAGS).get(L_T3).or().set(L_EFLAGS);
        if (kind === 'rol') c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_T3).xor();
        else c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_LZRES).i32(bits - 2).shr_u().i32(1).and().xor();
        c.i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
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
        E.storeOpFrom(d, L_LZRES, insn);
        c.get(L_EFLAGS).i32(~(F.CF | F.OF)).and().get(L_T3).or().set(L_EFLAGS);
        if (kind === 'rcl') c.get(L_LZRES).i32(bits - 1).shr_u().i32(1).and().get(L_T3).xor().i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
        else c.get(L_T5).i32(11).shl().get(L_EFLAGS).or().set(L_EFLAGS);
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
      E.storeOpFrom(d, L_LZRES, insn);
      // CF: left: bit (bits - cnt) of a ; right: bit (cnt-1) of a. OF: msb(a) ^ msb(res)
      if (isLeft) c.get(L_T4).i32(bits).get(L_T6).sub().i32(31).and().shr_u().i32(1).and().set(L_LZA);
      else c.get(L_T4).get(L_T6).i32(1).sub().shr_u().i32(1).and().set(L_LZA);
      c.get(L_T4).get(L_LZRES).xor().i32(bits - 1).shr_u().i32(1).and().set(L_LZB);
      E.setLazy(LZ.SHLD, size);
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
HANDLERS[OP.IMUL] = (E, insn) => {
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
  if (size === 4) {
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
    if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA).get(L_TV).i32store16(0); } else E.storeRegFrom(d.size, d.r, L_TV);
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
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.ADD, size);
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
  E.loadOp(t); if (insn.opsize === 2) E.c.i32(0xffff).and();
  E.count(PF.indirect);
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
    E.jumpTo(insn.opsize === 2 ? t.v & 0xffff : t.v, b.insns.length);
    return;
  }
  E.loadOp(t); c.set(L_T4);
  c.i32(insn.next).set(L_TV); pushValue(E, insn.opsize);
  c.get(L_T4); if (insn.opsize === 2) c.i32(0xffff).and();
  E.count(PF.indirect);
  E.exitToStack();
};
HANDLERS[OP.RET] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
  c.get(L_REG + 4).i32(size + (insn.ops.length ? insn.ops[0].v : 0)).add().set(L_REG + 4);
  // returning to a call site of this region (a callee inlined into the caller's region): intra-region jump
  // instead of leaving the region and chaining back into it
  for (const site of E.retSites) {
    c.get(L_TV).i32(site).eq();
    const i = c.if_(); E.count(PF.retLocal); E.jumpTo(site, E.insnIdx); c.end(); void i;
  }
  E.count(PF.ret);
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
    if (isCmp) E.materialize();
    // fast path: rep movs/stos forward with size 4/1 -> memory.copy/fill when non-overlapping-backwards
    if (kind === 'stos' && !isCmp) {
      c.get(L_T4).i32(0).gt_s().get(L_REG + 1).i32(0).ne().and();
      const fast = c.if_();
      if (size === 1) { c.get(L_REG + 7); E.loadReg(1, 0); c.get(L_REG + 1).memfill(); }
      else {
        // dword/word fill: loop (memory.fill only fills bytes); use a simple loop
        const lp = c.loop(); c.get(L_REG + 7); E.loadReg(size, 0); E.storeMem(size); c.get(L_REG + 7).i32(sz).add().set(L_REG + 7); c.get(L_REG + 1).i32(1).sub().tee(L_REG + 1).br_if(lp); c.end();
        c.i32(0).set(L_REG + 1);
        c.else_();
        const lp2 = c.loop(); c.get(L_REG + 1).eqz(); const ex2 = c.if_(); c.else_(); body(); c.get(L_REG + 1).i32(1).sub().set(L_REG + 1); c.br(lp2); c.end(); void ex2; c.end();
        c.end(); void fast;
        E.lz = null;
        return;
      }
      c.get(L_REG + 7).get(L_REG + 1).add().set(L_REG + 7); c.i32(0).set(L_REG + 1);
      c.else_();
      const lp2 = c.loop(); c.get(L_REG + 1).eqz(); const ex2 = c.if_(); c.else_(); body(); c.get(L_REG + 1).i32(1).sub().set(L_REG + 1); c.br(lp2); c.end(); void ex2; c.end();
      c.end(); void fast;
      E.lz = null;
      E.smcRange(L_T6, insn);
      return;
    }
    if (kind === 'movs') {
      // forward, non-overlapping-or-dst<src: memory.copy of ecx*size bytes
      c.get(L_T4).i32(0).gt_s().get(L_REG + 1).i32(0).ne().and();
      c.get(L_REG + 7).get(L_REG + 6).le_u().get(L_REG + 6).get(L_REG + 1).i32(sz).mul().add().get(L_REG + 7).le_u().or().and();
      if (fsBase >= 0) { c.drop(); c.i32(0); }
      const fast = c.if_();
      c.get(L_REG + 7).get(L_REG + 6).get(L_REG + 1).i32(sz).mul().memcopy();
      c.get(L_REG + 1).i32(sz).mul().set(L_T5);
      c.get(L_REG + 6).get(L_T5).add().set(L_REG + 6); c.get(L_REG + 7).get(L_T5).add().set(L_REG + 7); c.i32(0).set(L_REG + 1);
      c.else_();
      const lp2 = c.loop(); c.get(L_REG + 1).eqz(); const ex2 = c.if_(); c.else_(); body(); c.get(L_REG + 1).i32(1).sub().set(L_REG + 1); c.br(lp2); c.end(); void ex2; c.end();
      c.end(); void fast;
      E.lz = null;
      E.smcRange(L_T6, insn);
      return;
    }
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

export { L_S32, L_F32A, L_F32B, L_F32C, Emitter };
export { HANDLERS, L_STATE, L_REG, L_EFLAGS, L_LZOP, L_LZRES, L_LZA, L_LZB, L_TA, L_TV, L_T2, L_T3, L_T4, L_T5, L_T6, L_T7, L_T8, L_I64A, L_I64B, L_F64A, L_F64B, L_TOP, L_FS, L_V0, L_V1, L_V2, L_ST0, L_FTW, L_FPC, L_F64C, IMP_FLAGS, IMP_ROUND24, IMP_FALLBACK, IMP_EXP2M1, IMP_LOG2, IMP_LOG2P1, IMP_SCALB, IMP_SIN, IMP_COS, IMP_TAN, IMP_ATAN2, IMP_SINCOS, IMP_NAN2, IMP_ARITH24, IMP_F32RC, MASK, SIGN, BITS, touchesFpu };

// x86-32 -> WebAssembly region translator.
//
// A region is a set of basic blocks reachable from an entry point through direct branches (within
// a budget). It becomes one WASM function `(block, state) -> nextEip|0` whose body is a dispatch
// loop over the blocks: guest registers live in locals for the whole region, flags are kept lazily
// (op kind + operands), and every exit (cross-region jump, API thunk, fault, timeslice) writes the
// state back to the thread state block. Instructions without a native translation are executed
// by the reference interpreter through the `fallback` import (registers flushed around the call).
import { Code, ModuleBuilder, T } from './wasm.js';
import { decode, OP, OT } from '../decoder.js';
import { ST, EXIT, F, SEG } from '../state.js';
import { LZ } from './runtime.js';
import { THUNK_BASE, THUNK_END, SMC_BITMAP_BASE } from '../memory.js';

// Locals
const L_BLK = 0, L_STATE = 1, L_REG = 2, L_EFLAGS = 10, L_LZOP = 11, L_LZRES = 12, L_LZA = 13, L_LZB = 14, L_FS = 15;
const L_TA = 16, L_TV = 17, L_T2 = 18, L_T3 = 19, L_T4 = 20, L_T5 = 21, L_T6 = 22, L_T7 = 23;
const L_I64A = 24, L_I64B = 25, L_F64A = 26, L_F64B = 27, L_TOP = 28, L_T8 = 29;
const L_V0 = 30, L_V1 = 31, L_V2 = 32; // v128 temporaries (SSE/MMX translation)
const LOCAL_TYPES = [...Array(22).fill(T.i32), T.i64, T.i64, T.f64, T.f64, T.i32, T.i32, T.v128, T.v128, T.v128]; // indices 2..32
// Imports (function indices)
const IMP_FLAGS = 0, IMP_ROUND24 = 1, IMP_FALLBACK = 2;

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];
const BITS = [0, 8, 16, 0, 32];
const SZLOG = [0, 0, 1, 0, 2];
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;

export const MAX_BLOCKS = 48;
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

/**
 * Emit a complete region module. Returns { bytes, blocks } where blocks[i] = { eip, index }.
 */
export function translateRegion(mem, entry, opts = {}) {
  const em = new Emitter(mem, opts);
  return em.run(entry);
}

/** Assemble region function bodies into one module exporting r0..rN (same imports for all regions). */
export function buildRegionModule(codes) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 32768, 32768);
  m.importFunc('env', 'flags', [T.i32, T.i32, T.i32, T.i32, T.i32], [T.i32]);
  m.importFunc('env', 'round24', [T.f64, T.i32], [T.f64]);
  m.importFunc('env', 'fallback', [T.i32], [T.i32]);
  codes.forEach((code, i) => { const f = m.func([T.i32, T.i32], [T.i32], LOCAL_TYPES, { buf: code, len: code.length }, 'r' + i); m.exportFunc('r' + i, f); });
  return m.build();
}

class Emitter {
  constructor(mem, opts) {
    this.mem = mem;
    this.opts = opts;
    this.c = new Code();
    this.lz = null;
    this.smc = opts.smc !== false;
    this.x87 = opts.x87 !== false;
    this.stats = { native: 0, fallback: 0 };
  }

  run(entry) {
    const { blocks, byEip } = discoverRegion(this.mem, entry, this.opts);
    if (!blocks.length) throw new Error(`no code at ${entry.toString(16)}`);
    this.blocks = blocks;
    this.byEip = byEip;
    const c = this.c;
    this.reloadAll();
    this.exitCodeL = c.block();
    this.exitJmpL = c.block();
    this.dispatchL = c.loop();
    const def = c.block();
    // labels[i] for block i: block n-1 is outermost, block 0 innermost, so that the i-th `end`
    // closes labels[i] and block i's code follows it.
    const labels = new Array(blocks.length);
    for (let i = blocks.length - 1; i >= 0; i--) labels[i] = c.block();
    this.labels = labels;
    c.get(L_BLK).br_table(labels, def);
    for (let i = 0; i < blocks.length; i++) {
      c.end(); // closes labels[i]
      this.emitBlock(blocks[i], i + 1 < blocks.length ? blocks[i + 1] : null);
    }
    c.end(); // def
    c.unreachable();
    c.end(); // dispatch loop
    c.end(); // exitJmpL: jump exit (tV = target eip)
    this.flushAll();
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    c.get(L_TV).return_();
    c.end(); // exitCodeL: exit with code (tV = eip, t2 = code)
    this.flushAll();
    c.get(L_STATE).get(L_TV).i32store(ST.EIP);
    c.get(L_STATE).get(L_T2).i32store(ST.EXIT);
    c.i32(0);
    // module
    // the function body is kept so several regions can later be packed into one module (see Jit.consolidate)
    return { code: c.finish(), blocks: blocks.map((b) => ({ eip: b.eip, index: b.index, end: b.end })), stats: this.stats };
  }

  // ------------------------------------------------------------------ state <-> locals
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
  }
  flushAll() {
    const c = this.c;
    for (let i = 0; i < 8; i++) c.get(L_STATE).get(L_REG + i).i32store(ST.GPR + 4 * i);
    c.get(L_STATE).get(L_EFLAGS).i32store(ST.EFLAGS);
    c.get(L_STATE).get(L_LZOP).i32store(ST.LZ_OP);
    c.get(L_STATE).get(L_LZRES).i32store(ST.LZ_RES);
    c.get(L_STATE).get(L_LZA).i32store(ST.LZ_SRC1);
    c.get(L_STATE).get(L_LZB).i32store(ST.LZ_SRC2);
    c.get(L_STATE).get(L_TOP).i32store8(ST.FPU_TOP);
  }

  // ------------------------------------------------------------------ exits & jumps
  /** exit the region jumping to the eip on the stack */
  exitToStack() { this.c.set(L_TV).br(this.exitJmpL); }
  exitTo(eip) { this.c.i32(eip).set(L_TV).br(this.exitJmpL); }
  exitCode(code, eip, arg) {
    const c = this.c;
    if (arg !== undefined) c.get(L_STATE).i32(arg).i32store(ST.EXIT_ARG);
    c.i32(eip).set(L_TV).i32(code).set(L_T2).br(this.exitCodeL);
  }
  /** Budget check: subtract n and exit TIMESLICE (to eip) when exhausted. */
  budget(n, eip) {
    const c = this.c;
    c.get(L_STATE).get(L_STATE).i32load(ST.ICOUNT).i32(n).sub().tee(L_T3).i32store(ST.ICOUNT);
    c.get(L_T3).i32(0).le_s();
    const i = c.if_();
    this.exitCode(EXIT.TIMESLICE, eip);
    c.end(); void i;
  }
  /** Jump to a guest address: intra-region branch or exit. `n` instructions consumed for the budget. */
  jumpTo(target, n) {
    const b = this.byEip.get(target);
    if (b) {
      this.budget(n, target);
      this.c.i32(b.index).set(L_BLK).br(this.dispatchL);
    } else this.exitTo(target);
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
  /** After a store through L_TA: exit with SMC if the page holds translated code. */
  smcCheck(insn) {
    if (!this.smc || !insn) return;
    const c = this.c;
    c.get(L_TA).i32(15).shr_u().i32load8u(SMC_BITMAP_BASE).i32(1).get(L_TA).i32(12).shr_u().i32(7).and().shl().and();
    const i = c.if_();
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
      c.get(L_LZOP).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
      c.i32(0).set(L_LZOP);
      c.end(); void i;
    } else {
      c.get(L_LZOP).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
      c.i32(0).set(L_LZOP);
    }
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
    this.materialize();
    c.get(L_EFLAGS).i32(1).and();
  }
  /** push condition cc (0/1) */
  pushCond(cc) {
    const c = this.c;
    const lz = this.lz;
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
        case 1: if (k === LZ.SUB) { c.get(L_LZA).get(L_LZB).lt_u(); done = true; } else if (k === LZ.ADD) { c.get(L_LZRES).get(L_LZA).lt_u(); done = true; } else if (k === LZ.LOGIC) { c.i32(0); done = true; } break; // B
        case 3: if (k === LZ.SUB) { c.get(L_LZA).get(L_LZB).le_u(); done = true; } else if (k === LZ.LOGIC) { c.get(L_LZRES).eqz(); done = true; } break; // BE
        case 6: if (k === LZ.SUB) { sx(L_LZA, lz.sz); sx(L_LZB, lz.sz); c.lt_s(); done = true; } else if (k === LZ.LOGIC) { c.get(L_LZRES).i32(sign).and().i32(0).ne(); done = true; } break; // L
        case 7: if (k === LZ.SUB) { sx(L_LZA, lz.sz); sx(L_LZB, lz.sz); c.le_s(); done = true; } else if (k === LZ.LOGIC) { sx(L_LZRES, lz.sz); c.i32(0).le_s(); done = true; } break; // LE
        case 0: if (k === LZ.LOGIC) { c.i32(0); done = true; } break; // O
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
    c.i32((kind << 2) | SZLOG[size]).get(L_LZRES).get(L_LZA).get(L_LZB).get(L_EFLAGS).call(IMP_FLAGS).set(L_EFLAGS);
    c.i32(0).set(L_LZOP);
    this.lz = { kind: LZ.NONE, sz: 2 };
  }

  // ------------------------------------------------------------------ blocks
  emitBlock(b, nextBlock) {
    this.lz = null; // unknown at block entry
    this.topKnown = false;
    for (const insn of b.insns) this.emitInsn(insn, b);
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
        if (nextBlock && nextBlock.eip === ft) { this.budget(n, ft); return; } // natural fallthrough into the next block's code
        this.jumpTo(ft, n);
        return;
      }
      default: return; // JMP/RET/INDIRECT/EXIT emitted their own exits
    }
  }

  emitInsn(insn, b) {
    const h = HANDLERS[insn.op];
    if (h) { this.stats.native++; h(this, insn, b); }
    else this.fallback(insn);
  }

  /** Execute one instruction with the interpreter. */
  fallback(insn) {
    this.stats.fallback++;
    const c = this.c;
    this.materialize();
    this.flushAll();
    c.get(L_STATE).i32(insn.addr).i32store(ST.EIP);
    c.i32(insn.addr).call(IMP_FALLBACK).tee(L_T2);
    const i = c.if_();
    c.i32(0).return_(); // exit code already stored by the host
    c.end(); void i;
    this.reloadAll();
    this.lz = { kind: LZ.NONE, sz: 2 };
    this.topKnown = false;
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
    if (store) E.storeOpFrom(d, L_LZRES, insn);
    E.setLazy(kind, size);
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
  return (E, insn) => {
    const c = E.c; const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
    E.pushCF(); c.set(L_T4);
    E.materialize();
    loadDst(E, d); c.set(L_LZA);
    E.loadOp(s); c.set(L_LZB);
    if (isAdc) { c.get(L_LZA).get(L_LZB).add().get(L_T4).add(); } else { c.get(L_LZA).get(L_LZB).sub().get(L_T4).sub(); }
    maskTo(E, size); c.set(L_LZRES);
    E.storeOpFrom(d, L_LZRES, insn);
    // flags: CF = isAdc ? (res <u a) | (cf & (res == a)) : (a <u b) | (cf & (a == b)) ; OF/AF/ZF/SF/PF via helper on ADD/SUB then patch CF
    E.eagerFlags(isAdc ? LZ.ADD : LZ.SUB, size);
    c.get(L_EFLAGS).i32(~F.CF).and();
    if (isAdc) c.get(L_LZRES).get(L_LZA).lt_u().get(L_T4).get(L_LZRES).get(L_LZA).eq().and().or();
    else c.get(L_LZA).get(L_LZB).lt_u().get(L_T4).get(L_LZA).get(L_LZB).eq().and().or();
    c.or().set(L_EFLAGS);
  };
}
HANDLERS[OP.ADC] = adcSbb(true);
HANDLERS[OP.SBB] = adcSbb(false);

HANDLERS[OP.INC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  E.pushCF(); c.set(L_T4);
  loadDst(E, d); c.set(L_LZA);
  c.get(L_LZA).i32(1).add(); maskTo(E, size); c.set(L_LZRES);
  c.get(L_T4).set(L_LZB);
  E.storeOpFrom(d, L_LZRES, insn);
  E.setLazy(LZ.INC, size);
};
HANDLERS[OP.DEC] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = d.size;
  E.pushCF(); c.set(L_T4);
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
    E.materialize();
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
    const i = c.if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void i;
    if (size === 4) {
      // dividend edx:eax as i64
      c.get(L_REG + 2).extend_u().i64(32n).i64shl().get(L_REG).extend_u().i64or().set(L_I64A);
      if (signed) {
        c.get(L_I64A).get(L_T4).extend_s().i64div_s().set(L_I64B);
        // quotient must fit in i32
        c.get(L_I64B).get(L_I64B).wrap().extend_s().i64ne();
        const j = c.if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
        c.get(L_I64A).get(L_T4).extend_s().i64rem_s().wrap().set(L_REG + 2);
      } else {
        c.get(L_I64A).get(L_T4).extend_u().i64div_u().set(L_I64B);
        c.get(L_I64B).i64(0xffffffffn).i64gt_u();
        const j = c.if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
        c.get(L_I64A).get(L_T4).extend_u().i64rem_u().wrap().set(L_REG + 2);
      }
      c.get(L_I64B).wrap().set(L_REG);
    } else if (size === 2) {
      E.loadReg(2, 2); c.i32(16).shl(); E.loadReg(2, 0); c.or().set(L_T5); // dx:ax
      if (signed) { c.get(L_T5).get(L_T4).div_s().set(L_T6); c.get(L_T6).extend16_s().get(L_T6).ne(); } else { c.get(L_T5).get(L_T4).div_u().set(L_T6); c.get(L_T6).i32(0xffff).gt_u(); }
      const j = c.if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
      c.get(L_T5).get(L_T4); if (signed) c.rem_s(); else c.rem_u(); c.set(L_TV); E.storeRegFrom(2, 2, L_TV);
      c.get(L_T6).set(L_TV); E.storeRegFrom(2, 0, L_TV);
    } else {
      E.loadReg(2, 0); if (signed) c.extend16_s(); c.set(L_T5);
      if (signed) { c.get(L_T5).get(L_T4).div_s().set(L_T6); c.get(L_T6).extend8_s().get(L_T6).ne(); } else { c.get(L_T5).get(L_T4).div_u().set(L_T6); c.get(L_T6).i32(0xff).gt_u(); }
      const j = c.if_(); E.exitCode(EXIT.FAULT, insn.addr, 0); c.end(); void j;
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
    E.materialize();
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
  E.materialize();
  E.loadOp(s); c.set(L_T4);
  c.get(L_T4).eqz().set(L_LZA); c.get(L_T4).set(L_LZRES);
  c.get(L_T4);
  const i = c.if_(); c.get(L_T4).ctz().set(L_TV); E.storeRegFrom(d.size, d.r, L_TV); c.end(); void i;
  E.setLazy(LZ.BSF, d.size);
};
HANDLERS[OP.BSR] = (E, insn) => {
  const c = E.c; const d = insn.ops[0], s = insn.ops[1];
  E.materialize();
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
  if (s.t === OT.SEG) { E.fallback(insn); return; }
  if (s.t === OT.IMM) c.i32(s.size === 1 ? (s.v << 24) >> 24 : s.v | 0); else E.loadOp(s);
  c.set(L_TV);
  pushValue(E, size);
};
HANDLERS[OP.POP] = (E, insn) => {
  const c = E.c; const d = insn.ops[0]; const size = insn.opsize;
  if (d.t === OT.SEG) { E.fallback(insn); return; }
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
  E.materialize();
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
  E.exitToStack();
};
HANDLERS[OP.RET] = (E, insn) => {
  const c = E.c; const size = insn.opsize;
  c.get(L_REG + 4); if (size === 2) c.i32load16u(0); else c.i32load(0, 0); c.set(L_TV);
  c.get(L_REG + 4).i32(size + (insn.ops.length ? insn.ops[0].v : 0)).add().set(L_REG + 4);
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
HANDLERS[OP.CLC] = (E) => { E.materialize(); E.c.get(L_EFLAGS).i32(~F.CF).and().set(L_EFLAGS); };
HANDLERS[OP.STC] = (E) => { E.materialize(); E.c.get(L_EFLAGS).i32(F.CF).or().set(L_EFLAGS); };
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
    if (!insn.rep) { body(); if (isCmp) E.lz = { kind: LZ.SUB, sz: SZLOG[size] }; return; }
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

export { HANDLERS, L_STATE, L_REG, L_EFLAGS, L_LZOP, L_LZRES, L_LZA, L_LZB, L_TA, L_TV, L_T2, L_T3, L_T4, L_T5, L_T6, L_T7, L_T8, L_I64A, L_I64B, L_F64A, L_F64B, L_TOP, L_FS, L_V0, L_V1, L_V2, IMP_FLAGS, IMP_ROUND24, IMP_FALLBACK, MASK, SIGN, BITS };

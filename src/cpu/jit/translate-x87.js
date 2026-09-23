// Native x87 emission for the JIT. Inside an x87 region (Emitter.usesX87, any region holding an
// x87/MMX instruction) the register stack lives in WASM locals: L_ST0+i is ST(i) in logical
// order at block boundaries, L_TOP the physical top, L_FTW the abridged tag word in the same
// logical order (bit i = ST(i) non-empty; ST.FPU_TW holds the physical order, rotated by TOP at
// load/flush) and L_FPC the control word's precision/rounding bits (cw & 0xf00). Within a
// block push/pop only move a static shift (Emitter.stShift); the locals are rotated once where
// the block is left, and the Emitter writes everything back to the thread state at every exit
// and around interpreter fallbacks (FXAM, FNSTENV, transcendentals, m80 loads/stores...), which
// work on the memory copy. Precision control (24-bit mode) rounds inline through f32 for
// normal-range values in round-to-nearest mode and through the runtime's round24 helper
// otherwise (extended exponent range, directed rounding); rounding control applies to integer
// conversions and FRNDINT.
// Stack faults (empty register access) are not emulated here (D014): the tags are maintained for
// the interpreter and FNSTENV/FXAM, not checked.
import { HANDLERS, L_STATE, L_EFLAGS, L_TA, L_TV, L_T4, L_I64A, L_F64A, L_F64B, L_FTW, L_FPC, IMP_EXP2M1, IMP_LOG2, IMP_LOG2P1, IMP_SCALB, IMP_SIN, IMP_COS, IMP_TAN, IMP_ATAN2, IMP_SINCOS, IMP_NAN2, IMP_ARITH24, IMP_F32RC, L_F64C } from './translate.js';
import { OP, OT } from '../decoder.js';
import { ST, F } from '../state.js';
import { T } from './wasm.js';

const C0 = 1 << 8, C2 = 1 << 10, C3 = 1 << 14, SW_CC = C0 | (1 << 9) | C2 | C3;
/** x87 indefinite QNaN (the interpreter's INDEFINITE) */
const INDEFINITE_BITS = 0xfff8000000000000n;
const TWO_63 = 2 ** 63;
/** FYL2XP1 tiny-argument scaling (see the handler): threshold and exact scale factors */
const YL2XP1_TINY = 2 ** -1000, TWO_600 = 2 ** 600, TWO_M600 = 2 ** -600;
const FLT_MIN_NORMAL = 2 ** -126;
// largest magnitude that f32.demote rounds (to nearest) without overflowing to infinity:
// FLT_MAX + half an ulp (the tie rounds up to 2^128 as FLT_MAX's mantissa is odd)
const F32_ROUND_LIMIT = 2 ** 128 - 2 ** 103;

// ---- helpers (E = Emitter)
// ST(i) is local E.stLocal(i) = L_ST0 + ((i + E.stShift) & 7): push/pop/FINCSTP/FDECSTP only
// change the static shift (and the tag word); the Emitter rotates the locals and updates L_TOP
// when the block is left (E.x87Normalize). E.stValid tracks, per logical index, the tags known
// to be set by a store earlier in the block (rotated with the shift).
/** push ST(i) */
function loadST(E, i) { E.c.get(E.stLocal(i)); }
/**
 * Set the tag bit of ST(i)'s physical slot. Skipped when a store earlier in the block already
 * set it (E.stValid, reset at block entry, after fallbacks and by every op that clears tags);
 * `record` = false for a conditional store (FCMOVCC) whose bit is not known afterwards.
 */
function tagValid(E, i, record = true) {
  if (E.stValid & (1 << i)) return;
  E.c.get(L_FTW).i32(E.stTagBit(i)).or().set(L_FTW);
  if (record) E.stValid |= 1 << i;
}
/** store local `local` into ST(i) and mark it valid */
function storeST(E, i, local = L_F64A) { E.c.get(local).set(E.stLocal(i)); tagValid(E, i); }
/** f64 on the stack -> ST(i), marked valid */
function storeSTStack(E, i) { E.c.set(E.stLocal(i)); tagValid(E, i); }
/** logical rotation up (ST(k) <- ST(k-1), ST(0) <- ST(7)): TOP--, no code */
function rotateUp(E) {
  E.stShift = (E.stShift - 1) & 7;
  E.stValid = ((E.stValid << 1) | (E.stValid >> 7)) & 0xff;
}
/** logical rotation down (ST(k) <- ST(k+1), ST(7) <- ST(0)): TOP++, no code */
function rotateDown(E) {
  E.stShift = (E.stShift + 1) & 7;
  E.stValid = ((E.stValid >> 1) | (E.stValid << 7)) & 0xff;
}
/**
 * TOP--: the new ST(0) is the physical slot that held ST(7), which the caller overwrites right
 * away (storeSTStack(E, 0) / storeST(E, 0)).
 */
function push(E) { rotateUp(E); }
/** clear the tag of ST(0), TOP++ (the popped value stays in its physical slot, now ST(7)) */
function pop(E) {
  E.c.get(L_FTW).i32(~E.stTagBit(0)).and().set(L_FTW);
  rotateDown(E);
  E.stValid &= 0x7f;
}
/** rc (0 nearest, 1 down, 2 up, 3 trunc) from the cached control word bits */
function pushRC(E) { E.c.get(L_FPC).i32(10).shr_u(); }
/**
 * f64 result on the stack -> rounded per precision control; the operands are still in L_F64A and
 * L_F64B (FSQRT: L_F64A), `op` numbers the operation (arith's: 0 add, 1 mul, 4 sub, 5 subr, 6 div,
 * 7 divr; 8 sqrt). 24-bit mode, round to nearest, result in the normal float range and not exactly
 * on a 24-bit midpoint: f32.demote/f64.promote inline (bit-identical to exact rounding there).
 * Every other 24-bit case (directed rounding, midpoints, zero/denormal/huge/inf/nan results) goes
 * through the arith24 kernel, which redoes the operation with its exact error term: the same result
 * as the interpreter, without double-rounding artefacts (fpmath-round.js).
 */
function roundPC(E, op) {
  const c = E.c;
  c.set(L_F64C);
  c.get(L_FPC).i32(0x300).and().eqz();
  const pc = c.if_();
  // fast when rounding to nearest and the result is 0 (exact: nothing to round) or in the normal float range off a midpoint
  c.get(L_FPC).eqz();
  c.get(L_F64C).f64abs().f64c(FLT_MIN_NORMAL).f64ge();
  c.get(L_F64C).f64abs().f64c(F32_ROUND_LIMIT).f64lt().and();
  c.get(L_F64C).i64reinterpret_f64().i64(0x1fffffffn).i64and().i64(0x10000000n).i64ne().and();
  c.get(L_F64C).f64c(0).f64eq().or();
  c.and();
  const fast = c.if_();
  c.get(L_F64C).f32demote().f64promote().set(L_F64C);
  c.else_();
  c.get(L_F64A).get(op === 8 ? L_F64A : L_F64B).i32(op); pushRC(E); c.call(IMP_ARITH24).set(L_F64C);
  c.end(); void fast;
  c.end(); void pc;
  c.get(L_F64C);
}
/** f64 on stack -> rounded to integer per RC (or trunc) */
function roundRC(E, trunc) {
  const c = E.c;
  if (trunc) { c.f64trunc(); return; }
  c.set(L_F64B);
  const done = c.block();
  const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
  pushRC(E); c.br_table([l0, l1, l2, l3], done);
  c.end(); c.get(L_F64B).f64nearest().set(L_F64B); c.br(done);
  c.end(); c.get(L_F64B).f64floor().set(L_F64B); c.br(done);
  c.end(); c.get(L_F64B).f64ceil().set(L_F64B); c.br(done);
  c.end(); c.get(L_F64B).f64trunc().set(L_F64B);
  c.end();
  c.get(L_F64B);
}
function loadFpOperand(E, o) {
  const c = E.c;
  if (o.t === OT.ST) { loadST(E, o.r); return true; }
  if (o.t === OT.MEM) {
    if (o.size === 4) { E.ea(o); c.f32load(0, 0).f64promote(); return true; }
    if (o.size === 8) { E.ea(o); c.f64load(0, 0); return true; }
    return false; // m80
  }
  return false;
}
function loadIntOperand(E, o) {
  const c = E.c;
  E.ea(o);
  if (o.size === 2) c.i32load16s(0).f64convert_i32_s();
  else if (o.size === 4) c.i32load(0, 0).f64convert_i32_s();
  else c.i64load(0, 0).f64convert_i64_s();
}
function setCC(E, c0, c2, c3) { // constants 0/1
  const c = E.c;
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~SW_CC).and().i32((c0 ? C0 : 0) | (c2 ? C2 : 0) | (c3 ? C3 : 0)).or().i32store16(ST.FPU_SW);
}
/** compare F64A (a) with F64B (b): sets C0/C2/C3 */
function compareCC(E) {
  const c = E.c;
  // bits = a<b ? C0 : a==b ? C3 : (a>b ? 0 : C0|C2|C3)
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~SW_CC).and();
  c.get(L_F64A).get(L_F64B).f64lt(); const i1 = c.if_(T.i32); c.i32(C0); c.else_();
  c.get(L_F64A).get(L_F64B).f64eq(); const i2 = c.if_(T.i32); c.i32(C3); c.else_();
  c.get(L_F64A).get(L_F64B).f64gt(); const i3 = c.if_(T.i32); c.i32(0); c.else_(); c.i32(C0 | C2 | C3); c.end(); void i3;
  c.end(); void i2;
  c.end(); void i1;
  c.or().i32store16(ST.FPU_SW);
}
/** compare F64A with F64B into EFLAGS (FCOMI family) */
function compareEflags(E) {
  const c = E.c;
  E.materialize();
  c.get(L_EFLAGS).i32(~(F.ZF | F.PF | F.CF | F.OF | F.SF | F.AF)).and();
  c.get(L_F64A).get(L_F64B).f64lt(); const i1 = c.if_(T.i32); c.i32(F.CF); c.else_();
  c.get(L_F64A).get(L_F64B).f64eq(); const i2 = c.if_(T.i32); c.i32(F.ZF); c.else_();
  c.get(L_F64A).get(L_F64B).f64gt(); const i3 = c.if_(T.i32); c.i32(0); c.else_(); c.i32(F.ZF | F.PF | F.CF); c.end(); void i3;
  c.end(); void i2;
  c.end(); void i1;
  c.or().set(L_EFLAGS);
}

// ---- loads / stores
HANDLERS[OP.FLD] = (E, insn) => {
  const o = insn.ops[0];
  if (o.t === OT.MEM && o.size === 10) { E.fallback(insn); return; }
  loadFpOperand(E, o); // value on the WASM stack survives the rotation of the locals
  push(E); storeSTStack(E, 0);
};
HANDLERS[OP.FILD] = (E, insn) => { loadIntOperand(E, insn.ops[0]); push(E); storeSTStack(E, 0); };
function fstore(E, insn, doPop) {
  const c = E.c; const o = insn.ops[0];
  if (o.t === OT.ST) { loadST(E, 0); storeSTStack(E, o.r); if (doPop) pop(E); return; }
  if (o.size === 10) { E.fallback(insn); return; }
  E.eaTo(o);
  loadST(E, 0); c.set(L_F64A);
  if (o.size === 4) {
    // nearest: f32.demote (IEEE, exact); directed rounding: the f32rc kernel (float denormals and overflow included)
    c.get(L_TA);
    pushRC(E); c.set(L_T4);
    c.get(L_T4); const i = c.if_(T.f32); c.get(L_F64A).get(L_T4).call(IMP_F32RC); c.else_(); c.get(L_F64A).f32demote(); c.end(); void i;
    c.f32store(0, 0);
  } else c.get(L_TA).get(L_F64A).f64store(0, 0);
  // pop before the SMC check: its exit resumes at insn.next with the instruction completed
  if (doPop) pop(E);
  E.smcCheck(insn);
}
HANDLERS[OP.FST] = (E, insn) => fstore(E, insn, false);
HANDLERS[OP.FSTP] = (E, insn) => fstore(E, insn, true);
function istore(E, insn, doPop, trunc) {
  const c = E.c; const o = insn.ops[0];
  E.eaTo(o);
  loadST(E, 0); roundRC(E, trunc); c.set(L_F64A);
  if (o.size === 8) {
    // out of range / NaN -> 0x8000000000000000
    c.get(L_F64A).f64c(-9223372036854775808).f64ge().get(L_F64A).f64c(9223372036854775808).f64lt().and();
    const i = c.if_(T.i64); c.get(L_F64A).i64trunc_sat_f64_s(); c.else_(); c.i64(-0x8000000000000000n); c.end(); void i;
    c.set(L_I64A); c.get(L_TA).get(L_I64A).i64store(0, 0);
  } else {
    const lim = o.size === 4 ? 2147483648 : 32768;
    const indef = o.size === 4 ? -2147483648 : -32768;
    c.get(L_F64A).f64c(-lim).f64ge().get(L_F64A).f64c(lim).f64lt().and();
    const i = c.if_(T.i32); c.get(L_F64A).i32trunc_sat_f64_s(); c.else_(); c.i32(indef); c.end(); void i;
    c.set(L_TV); c.get(L_TA).get(L_TV); if (o.size === 4) c.i32store(0, 0); else c.i32store16(0);
  }
  if (doPop) pop(E); // before the SMC check (see fstore)
  E.smcCheck(insn);
}
HANDLERS[OP.FIST] = (E, insn) => istore(E, insn, false, false);
HANDLERS[OP.FISTP] = (E, insn) => istore(E, insn, true, false);
HANDLERS[OP.FISTTP] = (E, insn) => istore(E, insn, true, true);

// ---- constants
const constant = (v) => (E) => { E.c.f64c(v); push(E); storeSTStack(E, 0); };
HANDLERS[OP.FLD1] = constant(1); HANDLERS[OP.FLDZ] = constant(0); HANDLERS[OP.FLDPI] = constant(Math.PI);
HANDLERS[OP.FLDL2E] = constant(Math.LOG2E); HANDLERS[OP.FLDL2T] = constant(Math.log2(10)); HANDLERS[OP.FLDLG2] = constant(Math.LOG10E * Math.LN2); HANDLERS[OP.FLDLN2] = constant(Math.LN2);

// ---- arithmetic: op codes 0 add, 1 mul, 4 sub, 5 subr, 6 div, 7 divr
function arith(op, doPop, integer) {
  return (E, insn) => {
    const c = E.c;
    let dst = 0;
    if (insn.ops.length === 2 && insn.ops[0].t === OT.ST && insn.ops[1].t === OT.ST) {
      dst = insn.ops[0].r;
      loadST(E, dst); c.set(L_F64A);
      loadST(E, insn.ops[1].r); c.set(L_F64B);
    } else {
      const o = insn.ops[insn.ops.length - 1];
      loadST(E, 0); c.set(L_F64A);
      if (o.t === OT.ST) loadST(E, o.r);
      else if (integer) loadIntOperand(E, o);
      else if (!loadFpOperand(E, o)) { c.drop(); E.fallback(insn); return; }
      c.set(L_F64B);
    }
    switch (op) {
      case 0: c.get(L_F64A).get(L_F64B).f64add(); break;
      case 1: c.get(L_F64A).get(L_F64B).f64mul(); break;
      case 4: c.get(L_F64A).get(L_F64B).f64sub(); break;
      case 5: c.get(L_F64B).get(L_F64A).f64sub(); break;
      case 6: c.get(L_F64A).get(L_F64B).f64div(); break;
      default: c.get(L_F64B).get(L_F64A).f64div(); break;
    }
    roundPC(E, op);
    storeSTStack(E, dst);
    if (doPop) pop(E);
  };
}
HANDLERS[OP.FADD] = arith(0, false, false); HANDLERS[OP.FADDP] = arith(0, true, false); HANDLERS[OP.FIADD] = arith(0, false, true);
HANDLERS[OP.FMUL] = arith(1, false, false); HANDLERS[OP.FMULP] = arith(1, true, false); HANDLERS[OP.FIMUL] = arith(1, false, true);
HANDLERS[OP.FSUB] = arith(4, false, false); HANDLERS[OP.FSUBP] = arith(4, true, false); HANDLERS[OP.FISUB] = arith(4, false, true);
HANDLERS[OP.FSUBR] = arith(5, false, false); HANDLERS[OP.FSUBRP] = arith(5, true, false); HANDLERS[OP.FISUBR] = arith(5, false, true);
HANDLERS[OP.FDIV] = arith(6, false, false); HANDLERS[OP.FDIVP] = arith(6, true, false); HANDLERS[OP.FIDIV] = arith(6, false, true);
HANDLERS[OP.FDIVR] = arith(7, false, false); HANDLERS[OP.FDIVRP] = arith(7, true, false); HANDLERS[OP.FIDIVR] = arith(7, false, true);

// ---- comparisons
function cmp(pops, integer, eflags) {
  return (E, insn) => {
    const c = E.c;
    loadST(E, 0); c.set(L_F64A);
    if (insn.ops.length === 0) loadST(E, 1);
    else {
      const o = insn.ops[insn.ops.length - 1];
      if (o.t === OT.ST) loadST(E, o.r);
      else if (integer) loadIntOperand(E, o);
      else if (!loadFpOperand(E, o)) { E.fallback(insn); return; }
    }
    c.set(L_F64B);
    if (eflags) compareEflags(E); else compareCC(E);
    for (let i = 0; i < pops; i++) pop(E);
  };
}
HANDLERS[OP.FCOM] = cmp(0, false, false); HANDLERS[OP.FCOMP] = cmp(1, false, false); HANDLERS[OP.FCOMPP] = cmp(2, false, false);
HANDLERS[OP.FUCOM] = cmp(0, false, false); HANDLERS[OP.FUCOMP] = cmp(1, false, false); HANDLERS[OP.FUCOMPP] = cmp(2, false, false);
HANDLERS[OP.FICOM] = cmp(0, true, false); HANDLERS[OP.FICOMP] = cmp(1, true, false);
HANDLERS[OP.FCOMI] = cmp(0, false, true); HANDLERS[OP.FCOMIP] = cmp(1, false, true);
HANDLERS[OP.FUCOMI] = cmp(0, false, true); HANDLERS[OP.FUCOMIP] = cmp(1, false, true);
HANDLERS[OP.FTST] = (E) => { const c = E.c; loadST(E, 0); c.set(L_F64A); c.f64c(0).set(L_F64B); compareCC(E); };

// ---- unary / stack
HANDLERS[OP.FCHS] = (E) => { loadST(E, 0); E.c.f64neg(); storeSTStack(E, 0); };
HANDLERS[OP.FABS] = (E) => { loadST(E, 0); E.c.f64abs(); storeSTStack(E, 0); };
// FSQRT of a negative operand is an invalid arithmetic operand (IE, the indefinite); a NaN operand
// follows the x87 rule (nanOutcome, D034) like the transcendentals; sqrt(-0) = -0
HANDLERS[OP.FSQRT] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  c.get(L_F64A).f64sqrt(); roundPC(E, 8); c.set(E.stLocal(0));
  nanOutcome(E, L_F64A, L_F64A, E.stLocal(0));
  tagValid(E, 0);
};
HANDLERS[OP.FRNDINT] = (E) => { loadST(E, 0); roundRC(E, false); storeSTStack(E, 0); };

// ---- transcendentals: pure-WASM kernels of the runtime module (fpmath-exp.js, fpmath-trig.js,
// fpmath-atan.js), imported like round24. Same semantics as the interpreter's handlers (D034):
// results are stored as computed (setSt applies no precision-control rounding: PC only concerns
// the arithmetic instructions and FSQRT), and C1 is left alone like every other native handler
// (the interpreter clears it; the JIT keeps only the condition codes it computes). Exceptions:
// the kernels return a NaN for a NaN operand or an invalid arithmetic operand, and the handler
// then takes the rare path through the nan2 kernel (fpmath-nan.js: SNaN -> IE and quieted, QNaN
// propagated, two NaNs -> the larger significand, no NaN -> IE and the indefinite).
/** status word |= bits (C2 for an out-of-range trig argument) */
function orSW(E, bits) { const c = E.c; c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(bits).or().i32store16(ST.FPU_SW); }
/**
 * Raise the exception `bit` (0 IE ... 5 PE) like X87.raise: the flag is set; ES (the summary bit)
 * only when the exception is unmasked in the control word (mask bit `bit` clear), SDM 8.1.3.
 */
function raise(E, bit) {
  const c = E.c;
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(1 << bit).or();
  c.get(L_STATE).i32load16u(ST.FPU_CW).i32(bit).shr_u().i32(1).and().i32(1).xor().i32(7).shl().or();
  c.i32store16(ST.FPU_SW);
}
function indefinite(c) { c.i64(INDEFINITE_BITS).f64reinterpret_i64(); }
/**
 * NaN outcome of a kernel result held in local `res` computed from operands `a` and `b` (locals):
 * when the result is a NaN, nan2(a, b) replaces it by the x87 result (a propagated / quieted
 * operand NaN, or the indefinite for an invalid arithmetic operand) and tells whether to raise IE;
 * `otherwise` emits the non-NaN path (e.g. a zero-divide check).
 */
function nanOutcome(E, a, b, res, otherwise = null) {
  const c = E.c;
  c.get(res).get(res).f64ne();
  const nan = c.if_();
  c.get(a).get(b).call(IMP_NAN2);
  const ie = c.if_(); raise(E, 0); c.end(); void ie;
  c.set(res);
  if (otherwise) { c.else_(); otherwise(c); }
  c.end(); void nan;
}
// F2XM1: finite |x| > 1 is undefined by the SDM and leaves ST(0) unchanged on the reference
// hardware (mirrored, as in the interpreter); +-inf follow the SDM (+inf, -1) through the kernel
HANDLERS[OP.F2XM1] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  c.get(L_F64A); c.get(L_F64A).call(IMP_EXP2M1);
  c.get(L_F64A).f64abs().f64c(1).f64gt().get(L_F64A).f64abs().f64c(Number.MAX_VALUE).f64le().and();
  c.select().set(E.stLocal(0)); // outside ? x : 2^x - 1
  nanOutcome(E, L_F64A, L_F64A, E.stLocal(0));
  tagValid(E, 0);
};
// FSCALE: the kernel's special cases (0 * 2^inf, inf * 2^-inf -> NaN) and NaN operands go through nanOutcome
HANDLERS[OP.FSCALE] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A); loadST(E, 1); c.set(L_F64B);
  c.get(L_F64A).get(L_F64B).call(IMP_SCALB).set(E.stLocal(0));
  nanOutcome(E, L_F64A, L_F64B, E.stLocal(0));
  tagValid(E, 0);
};
// ST(1) <- ST(1) * f(ST(0)), pop: the product is the one f64 rounding after the kernel's, as in the
// interpreter's `b * Math.log2(a)`; FYL2XP1 uses the log2(1 + x) kernel directly (one rounding
// instead of the interpreter's log1p * LOG2E: closer to the hardware, well inside its tolerance).
// Invalid operands (x < 0, 0 log2 0, 0 log2 inf, inf log2 1) give a NaN product -> nanOutcome;
// y log2 0 with a finite non-zero y is a zero divide (ZE, -+inf), y = +-inf is not (SDM, hardware).
HANDLERS[OP.FYL2X] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A); loadST(E, 1); c.set(L_F64B);
  c.get(L_F64B).get(L_F64A).call(IMP_LOG2).f64mul().set(E.stLocal(1));
  nanOutcome(E, L_F64A, L_F64B, E.stLocal(1), (c) => {
    c.get(L_F64A).f64c(0).f64eq().get(L_F64B).f64abs().f64c(Infinity).f64lt().and();
    const ze = c.if_(); raise(E, 2); c.end(); void ze;
  });
  tagValid(E, 1); pop(E);
};
// FYL2XP1 with a denormal x: log2(1 + x) is then itself a denormal double (up to half of its
// bits lost before the product with y), whereas the hardware keeps it in extended precision:
// FYL2XP1(5e-324, 1e300) is 7.13e-24 on the hardware (and in the interpreter, whose product
// order y * log1p(x) * log2e avoids the tiny intermediate), 4.94e-24 with the plain composition.
// For |x| < 2^-1000, where log2(1 + x) = x log2e to better than 2^-1000 relative, the kernel is
// applied to x 2^600 (an exact exponent shift, giving a normal intermediate) and the product is
// scaled back by 2^-600 (exact unless the final result is denormal): one rounding in the kernel,
// one in the product, as in the normal-range path. Zeros keep their sign, NaN -> nanOutcome.
HANDLERS[OP.FYL2XP1] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  c.get(L_F64A).f64abs().f64c(YL2XP1_TINY).f64lt().set(L_TV); // tiny flag
  loadST(E, 1); c.set(L_F64B);
  c.get(L_F64B);
  c.get(L_F64A).f64c(TWO_600).f64mul().get(L_F64A).get(L_TV).select().call(IMP_LOG2P1).f64mul();
  c.f64c(TWO_M600).f64c(1).get(L_TV).select().f64mul().set(E.stLocal(1));
  nanOutcome(E, L_F64A, L_F64B, E.stLocal(1));
  tagValid(E, 1); pop(E);
};
// FPATAN: atan2(y, x) never produces a NaN from non-NaN operands; NaN operands -> nanOutcome
HANDLERS[OP.FPATAN] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A); loadST(E, 1); c.set(L_F64B);
  c.get(L_F64B).get(L_F64A).call(IMP_ATAN2).set(E.stLocal(1));
  nanOutcome(E, L_F64A, L_F64B, E.stLocal(1));
  tagValid(E, 1); pop(E);
};
/**
 * Trig argument classification shared by FSIN/FCOS (trig1) and FSINCOS/FPTAN (trig2), the
 * interpreter's trigSpecial(), on the argument in L_F64A: a NaN -> C0-C3 cleared, nan2(x, x)
 * (SNaN: IE and quieted; QNaN propagated); +-inf -> C0-C3 cleared, IE, the indefinite; a finite
 * |x| >= 2^63 -> C2 set, ST(0) unchanged, no push (`oor`); else C0-C3 cleared and the kernel
 * (`compute`). `store` consumes the special value left on the stack by the first two paths.
 */
function trigArg(E, store, oor, compute) {
  const c = E.c;
  c.get(L_F64A).get(L_F64A).f64ne();
  const nan = c.if_();
  setCC(E, 0, 0, 0);
  c.get(L_F64A).get(L_F64A).call(IMP_NAN2);
  const ie = c.if_(); raise(E, 0); c.end(); void ie;
  store(c);
  c.else_();
  c.get(L_F64A).f64abs().f64c(TWO_63).f64ge();
  const big = c.if_();
  c.get(L_F64A).f64abs().f64c(Infinity).f64eq();
  const inf = c.if_();
  setCC(E, 0, 0, 0); raise(E, 0); indefinite(c); store(c);
  c.else_();
  orSW(E, C2); oor(c);
  c.end(); void inf;
  c.else_();
  setCC(E, 0, 0, 0); compute(c);
  c.end(); void big;
  c.end(); void nan;
}
// FSIN / FCOS: ST(0) <- the classified result (untouched on the out-of-range path)
function trig1(kernel) {
  return (E) => {
    const c = E.c;
    loadST(E, 0); c.set(L_F64A);
    trigArg(E, (c) => c.set(E.stLocal(0)), () => {}, (c) => c.get(L_F64A).call(kernel).set(E.stLocal(0)));
    tagValid(E, 0);
  };
}
HANDLERS[OP.FSIN] = trig1(IMP_SIN);
HANDLERS[OP.FCOS] = trig1(IMP_COS);
// FSINCOS / FPTAN: ST(0) <- first result (L_F64A) and push the second (L_F64B); both are the same
// NaN / indefinite on the NaN and infinity paths, as on the hardware. The push is a static
// rotation of the locals, so the out-of-range path (no push) cannot rejoin the block: it sets C2
// and leaves the region at the next instruction, like the SMC check does.
function trig2(insn, E, results) {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  trigArg(E, (c) => c.tee(L_F64A).set(L_F64B), () => E.exitTo(insn.next), results);
  storeST(E, 0, L_F64A);
  push(E); storeST(E, 0, L_F64B);
}
// sincos returns (sin, cos): one range reduction for both, bit-identical to the sin / cos kernels;
// `results` (x in L_F64A) leaves ST(0)'s new value in L_F64A and the pushed value in L_F64B
HANDLERS[OP.FSINCOS] = (E, insn) => trig2(insn, E, (c) => { c.get(L_F64A).call(IMP_SINCOS).set(L_F64B).set(L_F64A); });
HANDLERS[OP.FPTAN] = (E, insn) => trig2(insn, E, (c) => { c.get(L_F64A).call(IMP_TAN).set(L_F64A); c.f64c(1).set(L_F64B); });
HANDLERS[OP.FXCH] = (E, insn) => {
  const c = E.c; const i = insn.ops.length ? insn.ops[0].r : 1;
  const a = E.stLocal(0), b = E.stLocal(i);
  c.get(a).get(b).set(a).set(b); // swap through the operand stack
  tagValid(E, 0); tagValid(E, i);
};
HANDLERS[OP.FFREE] = (E, insn) => {
  const r = insn.ops[0].r;
  E.c.get(L_FTW).i32(~E.stTagBit(r)).and().set(L_FTW);
  E.stValid &= ~(1 << r);
};
HANDLERS[OP.FINCSTP] = (E) => rotateDown(E);
HANDLERS[OP.FDECSTP] = (E) => rotateUp(E);
HANDLERS[OP.FNOP] = () => {};
HANDLERS[OP.FLDCW] = (E, insn) => {
  const c = E.c;
  c.get(L_STATE); E.ea(insn.ops[0]); c.i32load16u(0).i32(0x1f3f).and().i32(0x40).or().tee(L_TV).i32store16(ST.FPU_CW);
  c.get(L_TV).i32(0xf00).and().set(L_FPC);
};
HANDLERS[OP.FNSTCW] = (E, insn) => { const c = E.c; E.ea(insn.ops[0]); c.get(L_STATE).i32load16u(ST.FPU_CW).i32store16(0); };
HANDLERS[OP.FNSTSW] = (E, insn) => {
  const c = E.c; const o = insn.ops[0];
  c.get(L_STATE).i32load16u(ST.FPU_SW).i32(~0x3800).and(); E.pushStPhys(0); c.i32(11).shl().or().set(L_TV);
  if (o.t === OT.REG) E.storeRegFrom(2, 0, L_TV); else { E.ea(o); c.get(L_TV).i32store16(0); }
};
HANDLERS[OP.FNCLEX] = (E) => { const c = E.c; c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~0x80ff).and().i32store16(ST.FPU_SW); };
HANDLERS[OP.FCMOVCC] = (E, insn) => {
  const c = E.c; const i = insn.ops[0].r;
  E.pushCond(insn.cc);
  const t = c.if_(); loadST(E, i); c.set(E.stLocal(0)); tagValid(E, 0, false); c.end(); void t;
};
HANDLERS[OP.FNINIT] = (E) => {
  const c = E.c;
  c.get(L_STATE).i32(0x037f).i32store16(ST.FPU_CW); c.get(L_STATE).i32(0).i32store16(ST.FPU_SW);
  E.x87SetTop0(); // register contents are kept (as the interpreter does), only re-based on TOP = 0
  c.i32(0).set(L_FTW); E.stValid = 0;
  c.i32(0x300).set(L_FPC);
};

export {};

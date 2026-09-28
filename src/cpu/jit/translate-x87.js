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
import { L_ST0, L_S32, L_F32A, L_F32B, L_F32C, L_F64D, L_F64E, L_F64G, L_F64H } from './translate.js';
import { HANDLERS, L_STATE, L_EFLAGS, L_TA, L_TV, L_T4, L_I64A, L_F64A, L_F64B, L_FTW, L_FPC, IMP_EXP2M1, IMP_LOG2, IMP_LOG2P1, IMP_SCALB, IMP_SIN, IMP_COS, IMP_TAN, IMP_ATAN2, IMP_SINCOS, IMP_NAN2, IMP_ARITH24, IMP_F32RC, L_F64C } from './translate.js';
import { OP, OT } from '../decoder.js';
import { ST, F } from '../state.js';
import { T } from './wasm.js';
import { emitExp2m1Core, EXP2M1_CORE_MIN } from './fpmath-exp.js';
import { emitSinPoly, emitCosPoly, PIO4, TINY_SIN, TINY_COS } from './fpmath-trig.js';

const C0 = 1 << 8, C2 = 1 << 10, C3 = 1 << 14, SW_CC = C0 | (1 << 9) | C2 | C3;
/** x87 indefinite QNaN (the interpreter's INDEFINITE) */
const INDEFINITE_BITS = 0xfff8000000000000n;
const TWO_63 = 2 ** 63;
/** FYL2XP1 tiny-argument scaling (see the handler): threshold and exact scale factors */
const YL2XP1_TINY = 2 ** -1000, TWO_600 = 2 ** 600, TWO_M600 = 2 ** -600;

// ---- helpers (E = Emitter)
// ST(i) is local E.stLocal(i) = L_ST0 + ((i + E.stShift) & 7): push/pop/FINCSTP/FDECSTP only
// change the static shift (and the tag word); the Emitter rotates the locals and updates L_TOP
// when the block is left (E.x87Normalize). E.stValid tracks, per logical index, the tags known
// to be set by a store earlier in the block (rotated with the shift).
/** index k of the local pair (L_ST0+k f64, L_S32+k f32 shadow) holding ST(i) */
function slot(E, i) { return E.stLocal(i) - L_ST0; }
/** ST(i) is held as an exact float in its f32 shadow (Emitter.f32Mask) */
function isF32(E, i) { return ((E.f32Mask >> slot(E, i)) & 1) === 1; }
/** push ST(i) (f64) */
function loadST(E, i) { const k = slot(E, i); if ((E.f32Mask >> k) & 1) E.c.get(L_S32 + k).f64promote(); else E.c.get(L_ST0 + k); }
/** the f64 local of ST(i), about to be written with an f64 value (the f32 shadow no longer holds it) */
function stW(E, i) { const k = slot(E, i); E.f32Mask &= ~(1 << k); return L_ST0 + k; }
/** ST(i) back in its f64 local (before code that writes the f64 local conditionally) */
function toF64(E, i) { const k = slot(E, i); if ((E.f32Mask >> k) & 1) { E.c.get(L_S32 + k).f64promote().set(L_ST0 + k); E.f32Mask &= ~(1 << k); } }
/** f32 on the stack (an exact float) -> ST(i) held in the f32 shadow, marked valid */
function storeST32Stack(E, i) { const k = slot(E, i); E.c.set(L_S32 + k); E.f32Mask |= 1 << k; tagValid(E, i); }
/** 24-bit precision, round to nearest, known statically: register values may be kept as floats */
function f32Mode(E) { return E.fpcStatic === 0 && !globalThis.ORTHROS_NO_F32; }
/**
 * debugging: parts of the float representation turned off (globalThis.ORTHROS_F32_OFF = 'arith,round,m32,const');
 * 'part@lo:hi' (hex) keeps the part only for instructions in [lo, hi)
 */
function f32Off(part, addr) {
  const opts = (globalThis.ORTHROS_F32_OFF ?? '').split(',');
  if (opts.includes(part)) return true;
  const r = opts.find((s) => s.startsWith(part + '@'));
  if (!r) return false;
  const [lo, hi] = r.slice(part.length + 1).split(':').map((x) => parseInt(x, 16));
  return !(addr >= lo && addr < hi);
}
/**
 * Mark ST(i)'s physical slot valid: a static change (E.tagSet, applied where the block is left, see
 * Emitter.applyTags); skipped when a store earlier in the block already did (E.stValid, reset at block
 * entry, after fallbacks and by every op that clears tags). `record` = false for a conditional store
 * (FCMOVcc, inside its `if`): a run-time update, the pending changes having been applied before the `if`.
 */
function tagValid(E, i, record = true) {
  if (E.stValid & (1 << i)) return;
  const bit = E.stTagBit(i);
  if (!record) { E.c.get(L_FTW).i32(bit).or().set(L_FTW); return; }
  E.tagSet |= bit; E.tagClr &= ~bit;
  E.stValid |= 1 << i;
}
/** Mark ST(i)'s physical slot empty (static, see tagValid). */
function tagEmpty(E, i) { const bit = E.stTagBit(i); E.tagClr |= bit; E.tagSet &= ~bit; E.stValid &= ~(1 << i); }
/** store local `local` into ST(i) and mark it valid */
function storeST(E, i, local = L_F64A) { E.c.get(local).set(stW(E, i)); tagValid(E, i); }
/** f64 on the stack -> ST(i), marked valid */
function storeSTStack(E, i) { E.c.set(stW(E, i)); tagValid(E, i); }
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
  tagEmpty(E, 0);
  rotateDown(E);
}
/** rc (0 nearest, 1 down, 2 up, 3 trunc) from the cached control word bits */
function pushRC(E) { if (E.fpcStatic !== null) E.c.i32(E.fpcStatic >> 10); else E.c.get(L_FPC).i32(10).shr_u(); }
/**
 * f64 result on the stack -> rounded per precision control; the operands are still in L_F64A and
 * L_F64B (FSQRT: L_F64A), `op` numbers the operation (arith's: 0 add, 1 mul, 4 sub, 5 subr, 6 div,
 * 7 divr; 8 sqrt). 24-bit mode, round to nearest, result in the normal float range and not exactly
 * on a 24-bit midpoint: f32.demote/f64.promote inline (bit-identical to exact rounding there).
 * Every other 24-bit case (directed rounding, midpoints, zero/denormal/huge/inf/nan results) goes
 * through the arith24 kernel, which redoes the operation with its exact error term: the same result
 * as the interpreter, without double-rounding artefacts (fpmath-round.js).
 */
function roundPC(E, op, insn) {
  const c = E.c;
  // mode known statically (region specialized for it): 53/64-bit precision rounds nothing; 24-bit precision
  // with rounding to nearest keeps only the result tests
  if (E.fpcStatic !== null && (E.fpcStatic & 0x300) !== 0) return;
  if (E.fpcStatic !== null && E.fpcStatic !== 0) { roundDirected24(E, op, insn, E.fpcStatic >> 10); return; }
  if (E.fpcStatic === 0) {
    c.set(L_F64C);
    const done = c.block();
    const cold = c.block();
    c.get(L_F64C).i64reinterpret_f64().tee(L_I64A).wrap().i32(0x1fffffff).and().i32(0x10000000).eq().hint(false).br_if(cold);
    c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).ge_u().hint(false).br_if(cold);
    c.get(L_F64C).f32demote().f64promote().set(L_F64C);
    c.br(done);
    c.end(); // cold: zero is exact, anything else takes the exact kernel
    c.get(L_I64A).i64(1n).i64shl().i64eqz().br_if(done);
    c.get(L_F64A).get(op === 8 ? L_F64A : L_F64B).i32(op).i32(0).call(IMP_ARITH24).set(L_F64C);
    c.end(); // done
    c.get(L_F64C);
    return;
  }
  c.set(L_F64C);
  c.get(L_FPC).i32(0x300).and().eqz();
  const pc = c.if_();
  // hot path: rounding to nearest (L_FPC == 0 once PC is 24-bit), the result off a 24-bit midpoint and in
  // [2^-126, 2^127) (the float normal range, below the magnitudes that could round up to 2^128): three integer
  // tests on the bit pattern, each an unlikely branch to the cold block, then f32.demote/f64.promote
  const done = c.block();
  const cold = c.block();
  c.get(L_F64C).i64reinterpret_f64().set(L_I64A); // (the result's bits, read by the cold path whichever test sends there)
  c.get(L_FPC).hint(false).br_if(cold);
  c.get(L_I64A).wrap().i32(0x1fffffff).and().i32(0x10000000).eq().hint(false).br_if(cold);
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).ge_u().hint(false).br_if(cold);
  c.get(L_F64C).f32demote().f64promote().set(L_F64C);
  c.br(done);
  c.end(); // cold (L_I64A = the result's bits)
  // zero when rounding to nearest: exact, nothing to round
  c.get(L_FPC).eqz().get(L_I64A).i64(1n).i64shl().i64eqz().and().br_if(done);
  // directed rounding (down / up / toward zero) of an f64-normal result
  c.get(L_FPC).i32(0xc00).and().i32(0).ne();
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7ff00000).and().i32(0x00100000).sub().i32(0x7fe00000).lt_u().and();
  const directed = c.hint(true).if_();
  c.get(L_I64A).wrap().i32(0x1fffffff).and();
  const offGrid = c.if_();
  // not on the 24-bit grid: the exact value lies strictly between the same two grid points, so masking the low 29
  // significand bits (plus one 24-bit step away from zero for down-negative / up-positive) is exact
  // step = (rc == down && negative) || (rc == up && positive) ? 2^29 : 0 ; rc = L_FPC >> 10 (1 down, 2 up, 3 zero)
  c.get(L_I64A).i64(~0x1fffffffn).i64and();
  c.get(L_FPC).i32(0xc00).and().i32(0x400).eq().get(L_I64A).i64(0n).i64lt_s().and();
  c.get(L_FPC).i32(0xc00).and().i32(0x800).eq().get(L_I64A).i64(0n).i64ge_s().and().or();
  c.extend_u().i64(29n).i64shl().i64add();
  c.f64reinterpret_i64().set(L_F64C);
  c.else_();
  // on the grid: the result as computed when it is exact — float operands of a product, quotient or square root
  // (the f64 result is then the exact value or at least 2^-49 relative away from any 24-bit value, farther than the
  // f64 rounding can move it), or a sum whose TwoSum error term is zero; otherwise the exact kernel
  pushExactOnGrid(E, op);
  c.eqz();
  const inexact = c.if_();
  c.get(L_F64A).get(op === 8 ? L_F64A : L_F64B).i32(op); pushRC(E); c.call(IMP_ARITH24).set(L_F64C);
  c.end(); void inexact;
  c.end(); void offGrid;
  c.else_();
  // zero-adjacent, denormal, infinite and NaN results (and every case the hot path rejected when rounding to nearest)
  c.get(L_F64A).get(op === 8 ? L_F64A : L_F64B).i32(op); pushRC(E); c.call(IMP_ARITH24).set(L_F64C);
  c.end(); void directed;
  c.end(); // done
  c.end(); void pc;
  c.get(L_F64C);
}
/**
 * 24-bit precision with a directed rounding (1 down, 2 up, 3 toward zero) known statically — code written to truncate
 * its FISTPs sets it for whole functions. The f64 result on the stack is rounded without any call: off the 24-bit grid,
 * masking (plus one step away from zero for down-negative / up-positive) is exact (see the generic path); on the grid,
 * the result is exact for float operands (pushExactOnGrid); a zero is exact except when rounding down (x - x = -0).
 * Anything else — inexact on the grid, denormal, infinite or NaN results, zeros rounding down — leaves the region for
 * the interpreter (stepExit: no call in the region, whose hot paths would otherwise keep no value in a register).
 */
function roundDirected24(E, op, insn, rc) {
  const c = E.c;
  c.set(L_F64C);
  c.get(L_F64C).i64reinterpret_f64().set(L_I64A);
  const done = c.block();
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7ff00000).and().i32(0x00100000).sub().i32(0x7fe00000).lt_u();
  const normal = c.hint(true).if_();
  c.get(L_I64A).wrap().i32(0x1fffffff).and();
  const offGrid = c.hint(true).if_();
  c.get(L_I64A).i64(~0x1fffffffn).i64and();
  if (rc !== 3) { c.get(L_I64A).i64(0n); if (rc === 1) c.i64lt_s(); else c.i64ge_s(); c.extend_u().i64(29n).i64shl().i64add(); }
  c.f64reinterpret_i64().set(L_F64C);
  c.else_();
  pushExactOnGrid(E, op); c.eqz();
  const inexact = c.hint(false).if_(); E.stepExit(insn); c.end(); void inexact;
  c.end(); void offGrid;
  c.else_();
  if (rc !== 1) c.get(L_I64A).i64(1n).i64shl().i64eqz().br_if(done); // (a zero as computed: +0 for x - x)
  E.stepExit(insn);
  c.end(); void normal;
  c.end(); // done
  c.get(L_F64C);
}
/**
 * f32 of L_F64A rounded by a directed rounding (1 down, 2 up, 3 toward zero): f32.demote rounds to nearest, then one
 * step (the integer pattern +-1, through zero to the smallest denormal) when it went the wrong way; overflow to
 * infinity steps back to the largest float when rounding toward zero or away from that infinity. NaNs: as demoted.
 */
function pushF32Directed(E, rc) {
  const c = E.c;
  c.get(L_F64A).f32demote().tee(L_F32C);
  if (rc === 3) c.f64promote().f64abs().get(L_F64A).f64abs().f64gt();
  else if (rc === 1) c.f64promote().get(L_F64A).f64gt();
  else c.f64promote().get(L_F64A).f64lt();
  const adj = c.if_(T.f32);
  c.get(L_F32C).i32reinterpret_f32().set(L_T4);
  if (rc === 3) c.get(L_T4).i32(1).sub(); // |t| > |v| >= 0: t is not a zero
  else {
    // toward -inf (down) or +inf (up): the magnitude shrinks on the side of that infinity's opposite sign, grows on its
    // own side; from a zero, the smallest denormal of the rounding's sign
    const away = rc === 1 ? 0x80000001 : 0x00000001;
    c.get(L_T4).i32(1).sub(); // t on the side where stepping shrinks the magnitude (positive when down, negative when up)
    c.get(L_T4).i32(1).add(); // t on the other side
    c.get(L_T4).i32(0).lt_s(); if (rc === 1) c.eqz(); // shrink: up when negative, down when positive
    c.select();
    c.i32(away);
    c.get(L_T4).i32(0x7fffffff).and(); // (select: the step unless t is a zero)
    c.select();
  }
  c.f32reinterpret_i32();
  c.else_(); c.get(L_F32C); c.end(); void adj;
}
/**
 * i32 1 when the f64 result in L_F64C (on the 24-bit grid) of operation `op` on L_F64A / L_F64B is exact: both
 * operands floats and a product, quotient or square root, or a sum / difference whose TwoSum error term is zero.
 */
function pushExactOnGrid(E, op) {
  const c = E.c;
  const isFloat = (l) => { c.get(l).f32demote().f64promote().get(l).f64eq(); };
  isFloat(L_F64A);
  if (op !== 8) { isFloat(L_F64B); c.and(); }
  if (op === 1 || op >= 6) return;
  // TwoSum: s = x + y computed; err = (x - (s - (s - x))) + (y - (s - x)) with y = B (add), -B (sub), and x = B, y = -A (subr)
  const [x, y, negY] = op === 0 ? [L_F64A, L_F64B, false] : op === 4 ? [L_F64A, L_F64B, true] : [L_F64B, L_F64A, true];
  const pushY = () => { c.get(y); if (negY) c.f64neg(); };
  // bb = s - x (in L_F64B's place would clobber an operand: computed twice instead)
  const pushBB = () => { c.get(L_F64C).get(x).f64sub(); };
  c.get(x); c.get(L_F64C); pushBB(); c.f64sub(); c.f64sub(); // x - (s - bb)
  pushY(); pushBB(); c.f64sub(); // y - bb
  c.f64add().f64c(0).f64eq().and();
}
/** f64 on the stack rounded to an integer by rounding control 0 nearest, 1 down, 2 up, 3 toward zero */
const ROUND_BY_RC = [(c) => c.f64nearest(), (c) => c.f64floor(), (c) => c.f64ceil(), (c) => c.f64trunc()];
/** f64 on stack -> rounded to integer per RC (or trunc) */
function roundRC(E, trunc) {
  const c = E.c;
  if (trunc) { c.f64trunc(); return; }
  if (E.fpcStatic !== null) { ROUND_BY_RC[E.fpcStatic >> 10](c); return; }
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
  E.discardFlags(); // ZF/PF/CF set, OF/SF/AF cleared: nothing of the previous flags survives
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
  // 24-bit mode: a float operand (or a register held as one) stays a float
  if (f32Mode(E) && !f32Off('m32', insn.addr) && o.t === OT.MEM && o.size === 4) { E.ea(o); E.c.f32load(0, 0); push(E); storeST32Stack(E, 0); return; }
  if (o.t === OT.ST && isF32(E, o.r)) { E.c.get(L_S32 + slot(E, o.r)); push(E); storeST32Stack(E, 0); return; }
  loadFpOperand(E, o); // value on the WASM stack survives the rotation of the locals
  push(E); storeSTStack(E, 0);
};
HANDLERS[OP.FILD] = (E, insn) => { loadIntOperand(E, insn.ops[0]); push(E); storeSTStack(E, 0); };
function fstore(E, insn, doPop) {
  const c = E.c; const o = insn.ops[0];
  if (o.t === OT.ST) {
    if (isF32(E, 0)) { c.get(L_S32 + slot(E, 0)); storeST32Stack(E, o.r); } else { loadST(E, 0); storeSTStack(E, o.r); }
    if (doPop) pop(E);
    return;
  }
  if (o.size === 10) { E.fallback(insn); return; }
  E.eaTo(o);
  if (o.size === 4 && isF32(E, 0)) {
    c.get(L_TA).get(L_S32 + slot(E, 0)).f32store(0, 0); // an exact float: no rounding in any mode
  } else if (o.size === 4) {
    loadST(E, 0); c.set(L_F64A);
    // nearest: f32.demote (IEEE, exact); directed rounding: a value that is already a float (every 24-bit precision
    // result in the float range) is stored as is, anything else through the f32rc kernel (denormals, overflow)
    c.get(L_TA);
    if (E.fpcStatic !== null && (E.fpcStatic & 0xc00) === 0) c.get(L_F64A).f32demote();
    else if (E.fpcStatic !== null) pushF32Directed(E, E.fpcStatic >> 10); // (no call: see pushF32Directed)
    else {
      c.get(L_F64A).f32demote().tee(L_F32C).f64promote().get(L_F64A).f64eq();
      const exact = c.if_(T.f32); c.get(L_F32C); c.else_();
      pushRC(E); c.set(L_T4); c.get(L_T4); const i = c.if_(T.f32); c.get(L_F64A).get(L_T4).call(IMP_F32RC); c.else_(); c.get(L_F64A).f32demote(); c.end(); void i;
      c.end(); void exact;
    }
    c.f32store(0, 0);
  } else { loadST(E, 0); c.set(L_F64A); c.get(L_TA).get(L_F64A).f64store(0, 0); }
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
const constant = (v) => (E, insn) => {
  if (f32Mode(E) && !f32Off('const', insn.addr) && Math.fround(v) === v) { E.c.f32c(v); push(E); storeST32Stack(E, 0); return; }
  E.c.f64c(v); push(E); storeSTStack(E, 0);
};
HANDLERS[OP.FLD1] = constant(1); HANDLERS[OP.FLDZ] = constant(0); HANDLERS[OP.FLDPI] = constant(Math.PI);
HANDLERS[OP.FLDL2E] = constant(Math.LOG2E); HANDLERS[OP.FLDL2T] = constant(Math.log2(10)); HANDLERS[OP.FLDLG2] = constant(Math.LOG10E * Math.LN2); HANDLERS[OP.FLDLN2] = constant(Math.LN2);

// ---- arithmetic: op codes 0 add, 1 mul, 4 sub, 5 subr, 6 div, 7 divr
const F32_OP = { 0: (c) => c.f32add(), 1: (c) => c.f32mul(), 4: (c) => c.f32sub(), 6: (c) => c.f32div() };
/**
 * 24-bit mode, round to nearest, both operands exact floats (L_F32A = ST(dst) or ST(0), L_F32B = the
 * other): the f32 operation is the x87 result (one IEEE rounding to 24 bits) unless it over/underflows the
 * float range, where the x87's wider exponent differs. Such results (exponent field 0 or 255) take the
 * cold path, which keeps the exact cases inline — a zero (a sum is exact at zero; a product or quotient
 * only with a zero dividend/factor or an infinite divisor), an infinity coming from an infinite operand —
 * and leaves everything else (NaN rule, overflow and underflow into the x87 range) to the interpreter
 * (stepExit): no call in the region, whose values V8 would otherwise spill on the hot path. Result in L_F32C.
 */
function arithF32(E, insn, op) {
  const c = E.c;
  const [x, y] = op === 5 || op === 7 ? [L_F32B, L_F32A] : [L_F32A, L_F32B];
  c.get(x).get(y); F32_OP[op === 5 || op === 7 ? op - 1 : op](c); c.set(L_F32C);
  const done = c.block();
  c.get(L_F32C).i32reinterpret_f32().i32(23).shr_u().i32(0xff).and().i32(1).sub().i32(254).lt_u().hint(true).br_if(done);
  // cold: exact zero?
  c.get(L_F32C).f32c(0).f32eq();
  if (op === 1) c.get(L_F32A).f32c(0).f32eq().get(L_F32B).f32c(0).f32eq().or().and();
  else if (op >= 6) c.get(x).f32c(0).f32eq().get(y).f32abs().f32c(Infinity).f32eq().or().and();
  c.br_if(done);
  // an infinite result from an infinite operand (a dividend for a quotient) is exact
  c.get(L_F32C).f32abs().f32c(Infinity).f32eq();
  if (op >= 6) c.get(x).f32abs(); else c.get(L_F32A).f32abs().get(L_F32B).f32abs().f32max();
  c.f32c(Infinity).f32eq().and().br_if(done);
  E.stepExit(insn);
  c.end(); // done
}
/**
 * 24-bit mode, round to nearest, f64 operands in L_F64A/L_F64B and their f64 result on the stack: the
 * rounded result as a float in L_F32C. Hot path: roundPC's tests (off a 24-bit midpoint, in the float
 * normal range), f32.demote. A midpoint is frequent (a sum of floats one exponent apart, a product by a
 * small integer) and still exact when both operands are floats: the f64 result is then the exact value
 * or its correct rounding to 53 >= 2 * 24 + 2 bits, which rounds correctly to 24 bits (double rounding is
 * innocuous for + - * /). In the cold path a zero or an infinity from an infinite operand is exact too;
 * anything else (a midpoint from a non-float operand, a result outside the float range) is left to the
 * interpreter as in arithF32.
 */
function roundF32(E, insn, op) {
  const c = E.c;
  c.set(L_F64C);
  const done = c.block();
  const cold = c.block();
  c.get(L_F64C).i64reinterpret_f64().tee(L_I64A).wrap().i32(0x1fffffff).and().i32(0x10000000).eq().hint(false).br_if(cold);
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).ge_u().hint(false).br_if(cold);
  c.get(L_F64C).f32demote().set(L_F32C);
  c.br(done);
  c.end(); // cold
  c.get(L_F64C).f32demote().set(L_F32C);
  c.get(L_I64A).i64(1n).i64shl().i64eqz().br_if(done); // zero: exact
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).lt_u();
  c.get(L_F64A).f32demote().f64promote().get(L_F64A).f64eq().and();
  c.get(L_F64B).f32demote().f64promote().get(L_F64B).f64eq().and().br_if(done);
  c.get(L_F64C).f64abs().f64c(Infinity).f64eq().get(L_F64A).f64abs().get(L_F64B).f64abs().f64max().f64c(Infinity).f64eq().and().br_if(done);
  if (op <= 5) midpointF32(E, op, done);
  E.stepExit(insn);
  c.end(); // done
}
/**
 * roundF32's cold path for a sum, difference or product (op 0, 4, 5, 1) whose f64 result p (L_F64C, bits in L_I64A)
 * is a 24-bit midpoint inside the float range while an operand is not a float (a multiplier such as 0.9 read as a
 * double makes it frequent: its repeating significand puts ~9 % of the products of floats exactly on a midpoint).
 * The exact result's side of p comes from the error of the f64 operation — TwoSum for a sum, Dekker's product with
 * Veltkamp splitting (no FMA in WebAssembly) for a product, operands kept within 2^±900 so that the splitting
 * neither overflows nor underflows: p moved one f64 step toward it then rounds to the right float (a zero error
 * leaves the tie to f32.demote's even rule). Branches to `done` with L_F32C set, else falls through.
 */
function midpointF32(E, op, done) {
  const c = E.c, [A, B, D, Er, G, H] = [L_F64A, L_F64B, L_F64D, L_F64E, L_F64G, L_F64H];
  c.get(L_I64A).wrap().i32(0x1fffffff).and().i32(0x10000000).eq();
  c.get(L_I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).lt_u().and();
  for (const x of [A, B]) { c.get(x).f64abs().f64c(2 ** 900).f64lt().and(); c.get(x).f64abs().f64c(2 ** -900).f64gt().and(); }
  const mid = c.if_();
  if (op === 1) {
    const SPLIT = 134217729; // 2^27 + 1
    c.get(A).f64c(SPLIT).f64mul().set(D); c.get(D).get(D).get(A).f64sub().f64sub().set(D); c.get(A).get(D).f64sub().set(Er); // a = ah + al
    c.get(B).f64c(SPLIT).f64mul().set(G); c.get(G).get(G).get(B).f64sub().f64sub().set(G); c.get(B).get(G).f64sub().set(H); // b = bh + bl
    c.get(D).get(G).f64mul().get(L_F64C).f64sub().get(D).get(H).f64mul().f64add().get(Er).get(G).f64mul().f64add().get(Er).get(H).f64mul().f64add().set(D);
  } else {
    // p = x + y with (x, y) = (a, b), (a, -b) or (b, -a): bb = p - x; error = (x - (p - bb)) + (y - bb)
    const x = op === 5 ? B : A, y = op === 5 ? A : B, neg = op !== 0;
    c.get(L_F64C).get(x).f64sub().set(D);
    c.get(x).get(L_F64C).get(D).f64sub().f64sub();
    c.get(y); if (neg) c.f64neg(); c.get(D).f64sub();
    c.f64add().set(D);
  }
  // bits + 1 moves away from zero, - 1 toward it: toward the exact value (error of the same sign as p: away)
  c.get(L_I64A).i64(1n).i64(-1n).get(D).f64c(0).f64gt().get(L_F64C).f64c(0).f64gt().eq().select().i64add();
  c.get(L_I64A);
  c.get(D).f64c(0).f64ne().select();
  c.f64reinterpret_i64().f32demote().set(L_F32C);
  c.br(done);
  c.end(); void mid;
}
function arith(op, doPop, integer) {
  return (E, insn) => {
    const c = E.c;
    let dst = 0;
    if (f32Mode(E) && !integer && !f32Off('arith')) {
      // the operands as floats when both are: ST registers held in f32 shadows, m32
      const two = insn.ops.length === 2 && insn.ops[0].t === OT.ST && insn.ops[1].t === OT.ST;
      const d = two ? insn.ops[0].r : 0, o = two ? insn.ops[1] : insn.ops[insn.ops.length - 1];
      if (isF32(E, d) && ((o.t === OT.ST && isF32(E, o.r)) || (o.t === OT.MEM && o.size === 4))) {
        c.get(L_S32 + slot(E, d)).set(L_F32A);
        if (o.t === OT.ST) c.get(L_S32 + slot(E, o.r)); else { E.ea(o); c.f32load(0, 0); }
        c.set(L_F32B);
        arithF32(E, insn, op);
        c.get(L_F32C); storeST32Stack(E, d);
        if (doPop) pop(E);
        return;
      }
    }
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
    if (f32Mode(E) && !f32Off('round')) { roundF32(E, insn, op); c.get(L_F32C); storeST32Stack(E, dst); }
    else {
      roundPC(E, op, insn); c.set(L_F64C);
      // a NaN result follows the x87 rule (operand NaN / larger significand / IE and the indefinite): the
      // interpreter runs the instruction (an exit rather than a call to the nan2 kernel, see stepExit)
      c.get(L_F64C).get(L_F64C).f64ne();
      const nan = c.hint(false).if_(); E.stepExit(insn); c.end(); void nan;
      c.get(L_F64C); storeSTStack(E, dst);
    }
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
/**
 * FXAM: the class of ST(0) in C3 C2 C0 (empty 101, NaN 001, infinity 011, zero 100, denormal 110, normal 010) and its
 * sign in C1 — every condition code, C1 included (code tests the sign through FNSTSW). Empty: from the block's static
 * tag changes, else the run-time tag word.
 */
HANDLERS[OP.FXAM] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~SW_CC).and();
  c.get(L_F64A).i64reinterpret_f64().i64(63).i64shr_u().wrap().i32(9).shl().or(); // C1 = sign (NaN and -0 included)
  const bit = E.stTagBit(0);
  const known = (E.stValid & 1) || (E.tagSet & bit) ? 0 : (E.tagClr & bit) ? 1 : -1; // (0 valid, 1 empty, -1 run time)
  if (known === -1) c.get(L_FTW).i32(bit).and().eqz(); else c.i32(known);
  const ie = c.if_(T.i32); c.i32(C0 | C3); c.else_();
  c.get(L_F64A).get(L_F64A).f64ne(); const i1 = c.if_(T.i32); c.i32(C0); c.else_();
  c.get(L_F64A).f64abs().f64c(Infinity).f64eq(); const i2 = c.if_(T.i32); c.i32(C0 | C2); c.else_();
  c.get(L_F64A).f64c(0).f64eq(); const i3 = c.if_(T.i32); c.i32(C3); c.else_();
  c.get(L_F64A).f64abs().f64c(2.2250738585072014e-308).f64lt(); const i4 = c.if_(T.i32); c.i32(C2 | C3); c.else_(); c.i32(C2); c.end();
  c.end(); c.end(); c.end(); c.end();
  void ie; void i1; void i2; void i3; void i4;
  c.or().i32store16(ST.FPU_SW);
};
HANDLERS[OP.FTST] = (E) => { const c = E.c; loadST(E, 0); c.set(L_F64A); c.f64c(0).set(L_F64B); compareCC(E); };

// ---- unary / stack
HANDLERS[OP.FCHS] = (E) => { if (isF32(E, 0)) { E.c.get(L_S32 + slot(E, 0)).f32neg(); storeST32Stack(E, 0); } else { loadST(E, 0); E.c.f64neg(); storeSTStack(E, 0); } };
HANDLERS[OP.FABS] = (E) => { if (isF32(E, 0)) { E.c.get(L_S32 + slot(E, 0)).f32abs(); storeST32Stack(E, 0); } else { loadST(E, 0); E.c.f64abs(); storeSTStack(E, 0); } };
// FSQRT of a negative operand is an invalid arithmetic operand (IE, the indefinite); a NaN operand
// follows the x87 rule (nanOutcome, D034) like the transcendentals; sqrt(-0) = -0
HANDLERS[OP.FSQRT] = (E, insn) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  c.get(L_F64A).f64sqrt(); roundPC(E, 8, insn); c.set(stW(E, 0));
  nanOutcome(E, L_F64A, L_F64A, stW(E, 0));
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
/**
 * Inline fast paths of F2XM1 / FSCALE / FSIN / FCOS for their common argument ranges (below). Debugging and tests:
 * globalThis.ORTHROS_NO_X87_INLINE = true at translation time keeps only the kernel paths (the fast-path test is
 * then a constant false), which must give the same bits (tests/jit-x87-inline.test.js).
 */
function inlineTrans() { return !globalThis.ORTHROS_NO_X87_INLINE; }
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
  const nan = c.hint(false).if_();
  c.get(a).get(b).call(IMP_NAN2);
  const ie = c.if_(); raise(E, 0); c.end(); void ie;
  c.set(res);
  if (otherwise) { c.else_(); otherwise(c); }
  c.end(); void nan;
}
// F2XM1: finite |x| > 1 is undefined by the SDM and leaves ST(0) unchanged on the reference
// hardware (mirrored, as in the interpreter); +-inf follow the SDM (+inf, -1) through the kernel
// Inline fast path for 2^-1000 <= |x| < 1 (the x87 exp/pow sequences apply F2XM1 to a fraction): the kernel's own
// core (emitExp2m1Core, the same operations on the same operands) without its call, special-value tests and
// recombination, which are identities there: k = trunc(x) = +-0, r = x - k = x, and 2^k p + (2^k - 1) = 1 p + 0 = p
// (p != 0). NaN, zeros, tiny, |x| >= 1 and infinities fail the test and take the kernel path.
HANDLERS[OP.F2XM1] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A);
  if (inlineTrans()) c.get(L_F64A).f64abs().f64c(1).f64lt().get(L_F64A).f64abs().f64c(EXP2M1_CORE_MIN).f64ge().and(); else c.i32(0);
  const fast = c.if_();
  emitExp2m1Core(c, { R: L_F64A, TT: L_F64B, RL: L_F64B, RH: L_F64C, HI: L_F64C, Z: L_F64D, E: L_F64E, O: L_F64G, LO: L_F64H });
  c.get(L_F64C).get(L_F64H).f64add().set(stW(E, 0));
  c.else_();
  c.get(L_F64A); c.get(L_F64A).call(IMP_EXP2M1);
  c.get(L_F64A).f64abs().f64c(1).f64gt().get(L_F64A).f64abs().f64c(Number.MAX_VALUE).f64le().and();
  c.select().set(stW(E, 0)); // outside ? x : 2^x - 1
  nanOutcome(E, L_F64A, L_F64A, stW(E, 0));
  c.end(); void fast;
  tagValid(E, 0);
};
// FSCALE: the kernel's special cases (0 * 2^inf, inf * 2^-inf -> NaN) and NaN operands go through nanOutcome.
// Inline fast path for |ST(1)| < 1023 (the x87 pow/exp sequences scale by a small integer): e = trunc(ST(1)) is in
// [-1022, 1022], so 2^e is a normal double built from its exponent field and the IEEE product a 2^e is the exact
// value rounded once to nearest — the kernel's (and the hardware's) result for every a: normal or denormal results,
// overflow to +-inf, zeros and infinities unchanged; a NaN a gives a NaN, replaced by nanOutcome as on the kernel
// path. A NaN or larger ST(1) fails the test and calls the kernel.
HANDLERS[OP.FSCALE] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A); loadST(E, 1); c.set(L_F64B);
  if (inlineTrans()) {
    // a 2^e, e = trunc(b) (saturating: no trap; the product is only kept when |b| < 1023, else replaced below)
    c.get(L_F64A).get(L_F64B).i32trunc_sat_f64_s().i32(1023).add().extend_u().i64(52n).i64shl().f64reinterpret_i64().f64mul().set(stW(E, 0));
    c.get(L_F64B).f64abs().f64c(1023).f64lt().eqz(); // (NaN: true)
  } else c.i32(1);
  const slow = c.hint(false).if_();
  c.get(L_F64A).get(L_F64B).call(IMP_SCALB).set(stW(E, 0));
  c.end(); void slow;
  nanOutcome(E, L_F64A, L_F64B, stW(E, 0));
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
  c.get(L_F64B).get(L_F64A).call(IMP_LOG2).f64mul().set(stW(E, 1));
  nanOutcome(E, L_F64A, L_F64B, stW(E, 1), (c) => {
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
  c.f64c(TWO_M600).f64c(1).get(L_TV).select().f64mul().set(stW(E, 1));
  nanOutcome(E, L_F64A, L_F64B, stW(E, 1));
  tagValid(E, 1); pop(E);
};
// FPATAN: atan2(y, x) never produces a NaN from non-NaN operands; NaN operands -> nanOutcome
HANDLERS[OP.FPATAN] = (E) => {
  const c = E.c;
  loadST(E, 0); c.set(L_F64A); loadST(E, 1); c.set(L_F64B);
  c.get(L_F64B).get(L_F64A).call(IMP_ATAN2).set(stW(E, 1));
  nanOutcome(E, L_F64A, L_F64B, stW(E, 1));
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
  const nan = c.hint(false).if_();
  setCC(E, 0, 0, 0);
  c.get(L_F64A).get(L_F64A).call(IMP_NAN2);
  const ie = c.if_(); raise(E, 0); c.end(); void ie;
  store(c);
  c.else_();
  c.get(L_F64A).f64abs().f64c(TWO_63).f64ge();
  const big = c.hint(false).if_();
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
// FSIN / FCOS: ST(0) <- the classified result (untouched on the out-of-range path).
// Inline fast path for tiny <= |x| < pi/4 (the kernel's first two tests: no tiny shortcut, and the range reduction
// is the identity r = x + 0, quadrant 0 for the sine, 1 for the cosine, no sign change): the kernel's polynomial
// emitter on (x, +0), i.e. the same operations on the same operands, without the call, the reduction dispatch and
// the special-value classification (C0-C3 cleared as on the kernel path). Every other argument (NaN included:
// the test is false) takes the classified kernel path.
function trig1(kernel, isCos) {
  return (E) => {
    const c = E.c;
    loadST(E, 0); c.set(L_F64A);
    toF64(E, 0); // written on some paths only (out of range: unchanged)
    if (inlineTrans()) c.get(L_F64A).f64abs().f64c(PIO4).f64lt().get(L_F64A).f64abs().f64c(isCos ? TINY_COS : TINY_SIN).f64ge().and(); else c.i32(0);
    const fast = c.if_();
    setCC(E, 0, 0, 0);
    c.f64c(0).set(L_F64B); // rl
    c.get(L_F64A).get(L_F64A).f64mul().set(L_F64D); // z = rh^2
    if (isCos) emitCosPoly(c, L_F64A, L_F64B, L_F64D, L_F64E, L_F64G); else emitSinPoly(c, L_F64A, L_F64B, L_F64D);
    c.set(stW(E, 0));
    c.else_();
    trigArg(E, (c) => c.set(stW(E, 0)), () => {}, (c) => c.get(L_F64A).call(kernel).set(stW(E, 0)));
    c.end(); void fast;
    tagValid(E, 0);
  };
}
HANDLERS[OP.FSIN] = trig1(IMP_SIN, false);
HANDLERS[OP.FCOS] = trig1(IMP_COS, true);
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
  const ka = slot(E, 0), kb = slot(E, i);
  c.get(L_ST0 + ka).get(L_ST0 + kb).set(L_ST0 + ka).set(L_ST0 + kb); // swap through the operand stack
  // f32 shadows move with their values (the mask bits are swapped)
  const ma = (E.f32Mask >> ka) & 1, mb = (E.f32Mask >> kb) & 1;
  if (ma || mb) {
    c.get(L_S32 + ka).get(L_S32 + kb).set(L_S32 + ka).set(L_S32 + kb);
    E.f32Mask = (E.f32Mask & ~((1 << ka) | (1 << kb))) | (ma << kb) | (mb << ka);
  }
  tagValid(E, 0); tagValid(E, i);
};
HANDLERS[OP.FFREE] = (E, insn) => {
  const r = insn.ops[0].r;
  tagEmpty(E, r);
};
HANDLERS[OP.FINCSTP] = (E) => rotateDown(E);
HANDLERS[OP.FDECSTP] = (E) => rotateUp(E);
HANDLERS[OP.FNOP] = () => {};
HANDLERS[OP.FLDCW] = (E, insn) => {
  const c = E.c;
  c.get(L_STATE); E.ea(insn.ops[0]); c.i32load16u(0).i32(0x1f3f).and().i32(0x40).or().tee(L_TV).i32store16(ST.FPU_CW);
  c.get(L_TV).i32(0xf00).and().set(L_FPC);
  E.fpcStatic = null; // unknown from here on (tested at run time)
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
  E.applyTags(); // the tag update below is conditional (run time)
  E.pushCond(insn.cc);
  toF64(E, 0); // conditionally overwritten: the f64 local must hold the current value on both paths
  const t = c.if_(); loadST(E, i); c.set(stW(E, 0)); tagValid(E, 0, false); c.end(); void t;
};
HANDLERS[OP.FNINIT] = (E) => {
  const c = E.c;
  c.get(L_STATE).i32(0x037f).i32store16(ST.FPU_CW); c.get(L_STATE).i32(0).i32store16(ST.FPU_SW);
  E.x87SetTop0(); // register contents are kept (as the interpreter does), only re-based on TOP = 0
  c.i32(0).set(L_FTW); E.stValid = 0;
  c.i32(0x300).set(L_FPC);
  E.fpcStatic = null;
};

export {};

// ---- C1. Nearly every x87 instruction clears it; FXAM (the sign), FPREM/FPREM1 (a quotient bit) and a stack overflow
// set it. The native handlers leave the status word alone, so C1 is cleared once per block, by the first instruction
// that clears it on the processor (and again after an interpreter fallback or FXAM, which may set it): a C1 left set
// by FPREM changed the outcome of the C runtime's fmod for the code examining the status word afterwards (a game's
// endless loop). FCOMI/FUCOMI leave it, as the interpreter does.
const C1_CLEARING = ['FLD', 'FILD', 'FST', 'FSTP', 'FIST', 'FISTP', 'FISTTP', 'FBLD', 'FBSTP', 'FLD1', 'FLDZ', 'FLDPI', 'FLDL2E', 'FLDL2T', 'FLDLG2', 'FLDLN2',
  'FADD', 'FADDP', 'FIADD', 'FMUL', 'FMULP', 'FIMUL', 'FSUB', 'FSUBP', 'FISUB', 'FSUBR', 'FSUBRP', 'FISUBR', 'FDIV', 'FDIVP', 'FIDIV', 'FDIVR', 'FDIVRP', 'FIDIVR',
  'FCOM', 'FCOMP', 'FCOMPP', 'FUCOM', 'FUCOMP', 'FUCOMPP', 'FICOM', 'FICOMP', 'FTST', 'FCHS', 'FABS', 'FSQRT', 'FRNDINT', 'F2XM1', 'FYL2X', 'FYL2XP1',
  'FPTAN', 'FPATAN', 'FSCALE', 'FXTRACT', 'FXCH', 'FINCSTP', 'FDECSTP', 'FCMOVCC', 'FSIN', 'FCOS', 'FSINCOS'];
for (const name of C1_CLEARING) {
  const op = OP[name], h = HANDLERS[op];
  if (op === undefined || !h) continue;
  HANDLERS[op] = (E, insn, b) => {
    if (!E.c1Clear) { E.c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~(1 << 9)).and().i32store16(ST.FPU_SW); E.c1Clear = true; }
    h(E, insn, b);
  };
}
{ const fxam = HANDLERS[OP.FXAM]; HANDLERS[OP.FXAM] = (E, insn, b) => { fxam(E, insn, b); E.c1Clear = false; }; }

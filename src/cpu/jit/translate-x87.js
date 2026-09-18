// Native x87 emission for the JIT. Registers are f64 slots in the thread state (ST.FPR), TOP is
// kept in a local, the abridged tag word is maintained in memory on push/pop so that interpreter
// fallbacks (FXAM, FNSTENV, ...) stay consistent. Precision control (24-bit mode) is honoured via
// the runtime's round24 helper; rounding control on integer conversions and FRNDINT.
// Stack faults (empty register access) are not emulated here: valid programs never rely on them.
import { HANDLERS, L_STATE, L_REG, L_EFLAGS, L_LZOP, L_TA, L_TV, L_T2, L_T3, L_T4, L_I64A, L_F64A, L_F64B, L_TOP, IMP_ROUND24 } from './translate.js';
import { OP, OT } from '../decoder.js';
import { ST, F } from '../state.js';
import { T } from './wasm.js';
import { LZ } from './runtime.js';

const C0 = 1 << 8, C2 = 1 << 10, C3 = 1 << 14, SW_CC = C0 | (1 << 9) | C2 | C3;

// ---- helpers (E = Emitter)
function stAddr(E, i) { const c = E.c; c.get(L_STATE).get(L_TOP); if (i) c.i32(i).add(); c.i32(7).and().i32(3).shl().add(); }
function loadST(E, i) { stAddr(E, i); E.c.f64load(ST.FPR); }
/** store F64A into ST(i) and mark it valid */
function storeST(E, i, local = L_F64A) {
  const c = E.c;
  stAddr(E, i); c.get(local).f64store(ST.FPR);
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_TW).i32(1).get(L_TOP); if (i) c.i32(i).add(); c.i32(7).and().shl().or().i32store16(ST.FPU_TW);
}
function push(E) {
  const c = E.c;
  c.get(L_TOP).i32(1).sub().i32(7).and().set(L_TOP);
}
function pop(E) {
  const c = E.c;
  // clear tag of current top, then top++
  c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_TW).i32(1).get(L_TOP).shl().i32(-1).xor().and().i32store16(ST.FPU_TW);
  c.get(L_TOP).i32(1).add().i32(7).and().set(L_TOP);
}
/** f64 on stack -> rounded per precision control */
function roundPC(E) {
  const c = E.c;
  c.set(L_F64B);
  c.get(L_STATE).i32load16u(ST.FPU_CW).i32(0x300).and().eqz();
  const i = c.if_();
  c.get(L_F64B).get(L_STATE).i32load16u(ST.FPU_CW).i32(10).shr_u().i32(3).and().call(IMP_ROUND24).set(L_F64B);
  c.end(); void i;
  c.get(L_F64B);
}
/** f64 on stack -> rounded to integer per RC (or trunc) */
function roundRC(E, trunc) {
  const c = E.c;
  if (trunc) { c.f64trunc(); return; }
  c.set(L_F64B);
  const done = c.block();
  const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
  c.get(L_STATE).i32load16u(ST.FPU_CW).i32(10).shr_u().i32(3).and().br_table([l0, l1, l2, l3], done);
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
  loadFpOperand(E, o); E.c.set(L_F64A);
  push(E); storeST(E, 0);
};
HANDLERS[OP.FILD] = (E, insn) => { loadIntOperand(E, insn.ops[0]); E.c.set(L_F64A); push(E); storeST(E, 0); };
function fstore(E, insn, doPop) {
  const c = E.c; const o = insn.ops[0];
  if (o.t === OT.ST) { loadST(E, 0); c.set(L_F64A); storeST(E, o.r); if (doPop) pop(E); return; }
  if (o.size === 10) { E.fallback(insn); return; }
  E.eaTo(o);
  loadST(E, 0); c.set(L_F64A);
  if (o.size === 4) {
    // directed rounding to single: round24 then demote (exact for normal values)
    c.get(L_STATE).i32load16u(ST.FPU_CW).i32(10).shr_u().i32(3).and().set(L_T4);
    c.get(L_T4);
    const i = c.if_(); c.get(L_F64A).get(L_T4).call(IMP_ROUND24).set(L_F64A); c.end(); void i;
    c.get(L_TA).get(L_F64A).f32demote().f32store(0, 0);
  } else c.get(L_TA).get(L_F64A).f64store(0, 0);
  E.smcCheck(insn);
  if (doPop) pop(E);
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
  E.smcCheck(insn);
  if (doPop) pop(E);
}
HANDLERS[OP.FIST] = (E, insn) => istore(E, insn, false, false);
HANDLERS[OP.FISTP] = (E, insn) => istore(E, insn, true, false);
HANDLERS[OP.FISTTP] = (E, insn) => istore(E, insn, true, true);

// ---- constants
const constant = (v) => (E) => { E.c.f64c(v).set(L_F64A); push(E); storeST(E, 0); };
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
    roundPC(E); c.set(L_F64A);
    storeST(E, dst);
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
HANDLERS[OP.FCHS] = (E) => { const c = E.c; loadST(E, 0); c.f64neg().set(L_F64A); storeST(E, 0); };
HANDLERS[OP.FABS] = (E) => { const c = E.c; loadST(E, 0); c.f64abs().set(L_F64A); storeST(E, 0); };
HANDLERS[OP.FSQRT] = (E) => { const c = E.c; loadST(E, 0); c.f64sqrt(); roundPC(E); c.set(L_F64A); storeST(E, 0); };
HANDLERS[OP.FRNDINT] = (E) => { const c = E.c; loadST(E, 0); roundRC(E, false); c.set(L_F64A); storeST(E, 0); };
HANDLERS[OP.FXCH] = (E, insn) => {
  const c = E.c; const i = insn.ops.length ? insn.ops[0].r : 1;
  loadST(E, 0); c.set(L_F64A); loadST(E, i); c.set(L_F64B);
  storeST(E, 0, L_F64B); storeST(E, i, L_F64A);
};
HANDLERS[OP.FFREE] = (E, insn) => { const c = E.c; c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_TW).i32(1).get(L_TOP).i32(insn.ops[0].r).add().i32(7).and().shl().i32(-1).xor().and().i32store16(ST.FPU_TW); };
HANDLERS[OP.FINCSTP] = (E) => { E.c.get(L_TOP).i32(1).add().i32(7).and().set(L_TOP); };
HANDLERS[OP.FDECSTP] = (E) => { E.c.get(L_TOP).i32(1).sub().i32(7).and().set(L_TOP); };
HANDLERS[OP.FNOP] = () => {};
HANDLERS[OP.FLDCW] = (E, insn) => { const c = E.c; c.get(L_STATE); E.ea(insn.ops[0]); c.i32load16u(0).i32(0x1f3f).and().i32(0x40).or().i32store16(ST.FPU_CW); };
HANDLERS[OP.FNSTCW] = (E, insn) => { const c = E.c; E.ea(insn.ops[0]); c.get(L_STATE).i32load16u(ST.FPU_CW).i32store16(0); };
HANDLERS[OP.FNSTSW] = (E, insn) => {
  const c = E.c; const o = insn.ops[0];
  c.get(L_STATE).i32load16u(ST.FPU_SW).i32(~0x3800).and().get(L_TOP).i32(11).shl().or().set(L_TV);
  if (o.t === OT.REG) E.storeRegFrom(2, 0, L_TV); else { E.ea(o); c.get(L_TV).i32store16(0); }
};
HANDLERS[OP.FNCLEX] = (E) => { const c = E.c; c.get(L_STATE).get(L_STATE).i32load16u(ST.FPU_SW).i32(~0x80ff).and().i32store16(ST.FPU_SW); };
HANDLERS[OP.FCMOVCC] = (E, insn) => {
  const c = E.c; const i = insn.ops[0].r;
  E.pushCond(insn.cc);
  const t = c.if_(); loadST(E, i); c.set(L_F64A); storeST(E, 0); c.end(); void t;
};
HANDLERS[OP.FNINIT] = (E) => {
  const c = E.c;
  c.get(L_STATE).i32(0x037f).i32store16(ST.FPU_CW); c.get(L_STATE).i32(0).i32store16(ST.FPU_SW); c.get(L_STATE).i32(0).i32store16(ST.FPU_TW); c.i32(0).set(L_TOP);
};

export {};

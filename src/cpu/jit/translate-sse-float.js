// Native SSE/SSE2/SSE3 floating-point emission for the JIT (WASM SIMD): moves, packed and scalar
// arithmetic, logic, shuffles/unpacks, compares (CMP*/COMIS*), MOVMSK*, all float conversions
// (including the MMX-coupled CVTPI2PS/CVTPS2PI families) and LDMXCSR/STMXCSR.
//
// Semantics follow src/cpu/interp-sse.js bit for bit (the oracle suite tests/generated/sse is the
// judge): XMM registers live in v128 locals (lane 0 of scalar single-precision code in f32 shadows:
// XMM_SHADOW_OPS, Emitter.xmmShadowSync; the low qword of scalar double-precision code in f64 shadows:
// XMM_SHADOW64_OPS, Emitter.xmmShadowSync64), MM/MXCSR in the thread state, scalar forms write lane 0 only,
// MIN/MAX return the source on NaN/equal (f32x4.pmin(src, dst)), float->int conversions yield
// 0x80000000 on NaN/overflow and the non-truncating ones honour MXCSR.RC at run time, RCP/RSQRT
// are the exact f32(1/x) / f32(1/sqrt(x in f64)) of the interpreter. DAZ/FTZ are ignored (WASM
// SIMD has no flush-to-zero). Every MM access mirrors opAddr (tag word 0xff, TOP 0) through the
// common helpers. Not registered here: FXSAVE/FXRSTOR (interpreter fallback).
import { HANDLERS, XMM_SHADOW_OPS, XMM_SHADOW64_OPS, L_STATE, L_REG, L_EFLAGS, L_TA, L_F64A, L_F64B, L_V0, L_V1, L_V2, L_F32A, L_F32B, L_XS0, L_XD0 } from './translate.js';
import { OP, OT } from '../decoder.js';
import { ST, F } from '../state.js';
import {
  xmmOff, xmmLocal, xmmLoad, xmmStore, xmmStoreLow, mmStore, loadVec, storeVec,
  scalarF32, scalarF64, xmmStoreF32, xmmStoreF64, xmmStoreShadowed, xmmStoreShadowed64, xmmSyncWhole, xmmDropShadows,
  pushSplatI32, pushSplatF32, pushSplatF64, pushLowMask,
  elemMask, shufps, shufpd, unpackMask,
} from './translate-sse-common.js';

const TWO31 = 2147483648;

// ------------------------------------------------------------------ helpers (E = Emitter)

/** dword-selector shuffle masks (A = first pushed operand: 0..3, B: 4..7) */
const M_ADDSUB_PS = elemMask(4, [0, 5, 2, 7]);      // shuffle(diff, sum): odd lanes from sum
const M_ADDSUB_PD = elemMask(8, [0, 3]);            // shuffle(diff, sum) on qwords
const M_EVEN_PS = elemMask(4, [0, 2, 4, 6]), M_ODD_PS = elemMask(4, [1, 3, 5, 7]);
const M_EVEN_PD = elemMask(8, [0, 2]), M_ODD_PD = elemMask(8, [1, 3]);
const M_MOVSLDUP = elemMask(4, [0, 0, 2, 2]), M_MOVSHDUP = elemMask(4, [1, 1, 3, 3]);
const M_HIGH_PAIR = elemMask(4, [2, 3, 2, 3]);      // lanes 2,3 brought down to 0,1
const M_LOW_PAIRS = elemMask(4, [0, 1, 4, 5]);      // [A0, A1, B0, B1]
const M_QMASK_TO_D = elemMask(4, [0, 2, 0, 2]);     // low dword of each qword lane, twice

/**
 * Round the vector in L_V0 to an integer according to MXCSR.RC (bits 13-14: nearest-even,
 * floor, ceil, trunc), like translate-x87.js roundRC does for the FPU control word.
 */
function roundMxVec(E, dbl) {
  const c = E.c;
  const done = c.block();
  const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
  c.get(L_STATE).i32load(ST.MXCSR).i32(13).shr_u().i32(3).and().br_table([l0, l1, l2, l3], done);
  c.end(); c.get(L_V0); if (dbl) c.f64x2nearest(); else c.f32x4nearest(); c.set(L_V0); c.br(done);
  c.end(); c.get(L_V0); if (dbl) c.f64x2floor(); else c.f32x4floor(); c.set(L_V0); c.br(done);
  c.end(); c.get(L_V0); if (dbl) c.f64x2ceil(); else c.f32x4ceil(); c.set(L_V0); c.br(done);
  c.end(); c.get(L_V0); if (dbl) c.f64x2trunc(); else c.f32x4trunc(); c.set(L_V0);
  c.end();
}

/** Round the f64 in L_F64A to an integer per MXCSR.RC (or truncate). */
function roundMxScalar(E, trunc) {
  const c = E.c;
  if (trunc) { c.get(L_F64A).f64trunc().set(L_F64A); return; }
  const done = c.block();
  const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
  c.get(L_STATE).i32load(ST.MXCSR).i32(13).shr_u().i32(3).and().br_table([l0, l1, l2, l3], done);
  c.end(); c.get(L_F64A).f64nearest().set(L_F64A); c.br(done);
  c.end(); c.get(L_F64A).f64floor().set(L_F64A); c.br(done);
  c.end(); c.get(L_F64A).f64ceil().set(L_F64A); c.br(done);
  c.end(); c.get(L_F64A).f64trunc().set(L_F64A);
  c.end();
}

/**
 * f32x4 -> i32x4 of the (already rounded) vector in L_V0, x86 style: lanes that are NaN or
 * >= 2^31 become 0x80000000 (trunc_sat already yields 0x80000000 below -2^31). Pushes the result.
 */
function f32ToI32Vec(E) {
  const c = E.c;
  c.get(L_V0).i32x4trunc_sat_f32x4_s();
  pushSplatI32(E, 0x80000000);
  c.get(L_V0); pushSplatF32(E, TWO31); c.f32x4lt();
  c.v128bitselect();
}

/** f64x2 (rounded, in L_V0) -> two i32 lanes + zero upper qword, x86 style. Pushes the result. */
function f64ToI32Vec(E) {
  const c = E.c;
  c.get(L_V0).i32x4trunc_sat_f64x2_s_zero();
  pushSplatI32(E, 0x80000000);
  c.get(L_V0); pushSplatF64(E, TWO31); c.f64x2lt(); c.set(L_V1);
  c.get(L_V1).get(L_V1).i8x16shuffle(M_QMASK_TO_D);
  c.v128bitselect();
  pushLowMask(E, 8); c.v128and();
}

/**
 * f64 in L_F64A (already an integer, or any value when truncating) -> i32 on the stack, 0x80000000 (the x86
 * "integer indefinite") when NaN / out of range. Branch-free: trunc_sat already gives 0x80000000 at or below
 * -2^31 (and truncates toward zero, so -2^31 - 0.5 -> -2^31 like CVTTSD2SI); only NaN and x >= 2^31 need the
 * select (x < 2^31 is false for both).
 */
function f64ToI32Scalar(E) {
  const c = E.c;
  c.get(L_F64A).i32trunc_sat_f64_s().i32(-TWO31).get(L_F64A).f64c(TWO31).f64lt().select();
}

/**
 * Compare local a with local b (type p: 'f32' / 'f64') into EFLAGS, COMISS/UCOMISS semantics (see interp comis):
 * ZF,PF,CF = 111 unordered, 000 greater, 001 less, 100 equal; OF, SF, AF cleared. Branch-free, with the IEEE
 * comparisons (all false on a NaN): CF = !(a >= b), ZF = !(a < b || a > b), PF = !(a >= b || a < b).
 */
function compareEflags(E, a, b, p) {
  const c = E.c;
  const cmp = (op) => { c.get(a).get(b)[p + op](); };
  c.get(L_EFLAGS).i32(~(F.ZF | F.PF | F.CF | F.OF | F.SF | F.AF)).and();
  cmp('ge'); c.eqz().or(); // CF (bit 0)
  cmp('lt'); cmp('gt'); c.or().eqz().i32(6).shl().or(); // ZF
  cmp('ge'); cmp('lt'); c.or().eqz().i32(2).shl().or(); // PF
  c.set(L_EFLAGS);
}

/** Push 1/sqrt(x) for the two f32 lanes 0,1 of the v128 on the stack, computed in f64 and demoted (lanes 2,3 zero). */
function rsqrtLowPair(E) {
  const c = E.c;
  c.set(L_V2);
  pushSplatF64(E, 1); c.get(L_V2).f64x2promote_low_f32x4().f64x2sqrt().f64x2div().f32x4demote_f64x2_zero();
}

// ------------------------------------------------------------------ 16-byte moves

// Whole-register moves belong to both shadow families (XMM_SHADOW_OPS and XMM_SHADOW64_OPS, see the end of this file):
// a register copy (`movapd xmm1, xmm0` before a scalar operation on the copy, frequent in compiled scalar code) copies
// the v128 local and the source's shadows with their dirty bits, so that a scalar chain goes on in the copy without
// the lane being written back first; a load drops the destination's shadows; a store writes the source's dirty
// shadows back first.
function mov16() {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    if (d.t === OT.XMM && s.t === OT.XMM) {
      const sr = s.r & 7, dr = d.r & 7, sb = 1 << sr, db = 1 << dr;
      c.get(xmmLocal(sr)).set(xmmLocal(dr));
      if (E.xsValid & sb) { c.get(L_XS0 + sr).set(L_XS0 + dr); E.xsValid |= db; E.xsDirty = E.xsDirty & sb ? E.xsDirty | db : E.xsDirty & ~db; } else { E.xsValid &= ~db; E.xsDirty &= ~db; }
      if (E.xdValid & sb) { c.get(L_XD0 + sr).set(L_XD0 + dr); E.xdValid |= db; E.xdDirty = E.xdDirty & sb ? E.xdDirty | db : E.xdDirty & ~db; } else { E.xdValid &= ~db; E.xdDirty &= ~db; }
      return;
    }
    if (s.t === OT.XMM) xmmSyncWhole(E, s.r);
    storeVec(E, d, insn, 16, () => loadVec(E, s, 16)); // (an unaligned store straddling two pages: see Emitter.smcCheck)
    if (d.t === OT.XMM) xmmDropShadows(E, d.r);
  };
}
const MOV16 = ['MOVAPS', 'MOVAPD', 'MOVDQA', 'LDDQU', 'MOVNTPS', 'MOVNTPD', 'MOVNTDQ', 'MOVUPS', 'MOVUPD', 'MOVDQU'];
for (const k of MOV16) HANDLERS[OP[k]] = mov16();

// MOVSS / MOVSD: mem dest -> 4/8-byte store; xmm <- mem zero-extends; xmm <- xmm merges lane 0.
// MOVSD through the f64 shadows (XMM_SHADOW64_OPS): m64 <- the shadow; xmm <- m64 loads the zero-extended vector and
// its low qword into the shadow; xmm <- xmm copies shadow to shadow (the destination's high qword kept)
HANDLERS[OP.MOVSD] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA); scalarF64(E, s); c.f64store(0, 0); E.smcCheck(insn); }
  else if (s.t === OT.MEM) xmmStoreShadowed64(E, d.r, () => { E.ea(s); c.v128load64zero(0); });
  else xmmStoreF64(E, d.r, () => scalarF64(E, s));
};
// MOVSS through the lane-0 shadows (XMM_SHADOW_OPS below): m32 <- the shadow; xmm <- m32 loads the zero-extended
// vector and its lane 0 into the shadow; xmm <- xmm copies shadow to shadow (lanes 1-3 of the destination kept)
HANDLERS[OP.MOVSS] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA); scalarF32(E, s); c.f32store(0, 0); E.smcCheck(insn); }
  else if (s.t === OT.MEM) xmmStoreShadowed(E, d.r, () => { E.ea(s); c.v128load32zero(0); });
  else xmmStoreF32(E, d.r, () => scalarF32(E, s));
};

// MOVLPS/MOVLPD: low qword <-> m64 (upper preserved), through the f64 shadow: the C runtimes' way of moving a double
// between memory and a register (the x87 stack's included: fstp m64 ; movlpd xmm, m64). Bit-exact for any
// contents (two floats, integers, signaling NaNs): WASM loads, stores and locals keep an f64's bits
HANDLERS[OP.MOVLPS] = HANDLERS[OP.MOVLPD] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA); scalarF64(E, s); c.f64store(0, 0); E.smcCheck(insn); }
  else xmmStoreF64(E, d.r, () => { E.ea(s); c.f64load(0, 0); });
};
// MOVHPS/MOVHPD: high qword <-> m64 (low preserved). In XMM_SHADOW64_OPS without using the shadow: they never read nor
// write the low qword, which may stay stale in the v128 local (a dirty f64 shadow)
HANDLERS[OP.MOVHPS] = HANDLERS[OP.MOVHPD] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  if (d.t === OT.MEM) { E.eaTo(d); c.get(L_TA); xmmLoad(E, s.r); c.v128store64lane(0, 1); E.smcCheck(insn); return; }
  c.get(xmmLocal(d.r)); E.ea(s); c.i64load(0, 0).i64x2replacelane(1).set(xmmLocal(d.r));
};
// MOVHLPS: d.q0 = s.q1 ; MOVLHPS: d.q1 = s.q0
HANDLERS[OP.MOVHLPS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; c.get(xmmLocal(d.r)).get(xmmLocal(s.r)).i64x2extractlane(1).i64x2replacelane(0).set(xmmLocal(d.r)); };
HANDLERS[OP.MOVLHPS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; c.get(xmmLocal(d.r)).get(xmmLocal(s.r)).i64x2extractlane(0).i64x2replacelane(1).set(xmmLocal(d.r)); };

// SSE3 duplicating moves
function dupMove(mask) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    loadVec(E, s, 16); c.set(L_V0);
    xmmStore(E, d.r, () => c.get(L_V0).get(L_V0).i8x16shuffle(mask));
  };
}
HANDLERS[OP.MOVSLDUP] = dupMove(M_MOVSLDUP);
HANDLERS[OP.MOVSHDUP] = dupMove(M_MOVSHDUP);
HANDLERS[OP.MOVDDUP] = (E, insn) => { // Vpd,Wq: low qword of xmm / m64 into both qwords
  const c = E.c; const [d, s] = insn.ops;
  xmmStore(E, d.r, () => { if (s.t === OT.XMM) c.get(xmmLocal(s.r)).i64x2extractlane(0).i64x2splat(); else { E.ea(s); c.v128load64splat(0); } });
};

// ------------------------------------------------------------------ packed / scalar arithmetic

/** dst = op(dst, src) on the whole vector (PS/PD); source width from the operand (16). */
function packedBin(op) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStore(E, d.r, () => { xmmLoad(E, d.r); loadVec(E, s); c[op](); });
  };
}
/** MIN/MAX packed: pmin(src, dst) / pmax(src, dst) = x86 semantics (source on NaN / equal). */
function packedMinMax(op) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStore(E, d.r, () => { loadVec(E, s); xmmLoad(E, d.r); c[op](); });
  };
}
/** dst = op(src) (SQRT) on the whole vector. */
function packedUn(op) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStore(E, d.r, () => { loadVec(E, s); c[op](); });
  };
}
// Scalar SS/SD forms: lane 0 is computed with WASM scalar f32/f64 arithmetic (extract_lane 0, the op,
// replace_lane 0 — the host's mulss/addsd...), never on the whole vector: lanes 1-3 of an x86 register
// written by scalar code are arbitrary (the integers of an earlier MOVD/PINSRW, the lanes CVTSI2SS keeps...),
// and a packed host op would also compute on them — every denormal lane costing a microcode assist on the
// host (DAZ is off in browsers): measured with tools/ssef-bench.mjs, the kernel whose xmm0 carries denormal
// upper lanes took 0.92 ns per instruction computed packed, twice its clean-lanes time. Same results bit for bit: the
// host's scalar and packed instructions round and propagate NaNs alike (first operand's NaN quieted, the
// default NaN for invalid operations), and an m32/m64 source is read with a plain scalar load.
/** f32 / f64 prefix of the WASM scalar ops for a 4- / 8-byte scalar */
const fp = (n) => (n === 4 ? 'f32' : 'f64');
/** Push lane 0 of operand o as an f32 (n = 4) or f64 (n = 8). */
function scalarF(E, o, n) { if (n === 4) scalarF32(E, o); else scalarF64(E, o); }
/** XMM r lane 0 <- the f32 / f64 pushed by emitValue(E), other lanes preserved. */
function xmmStoreF(E, r, n, emitValue) { if (n === 4) xmmStoreF32(E, r, emitValue); else xmmStoreF64(E, r, emitValue); }
/** Scalar SS/SD binary: lane 0 = op(dst0, src0), other lanes preserved. */
function scalarBin(op, n) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStoreF(E, d.r, n, () => { scalarF(E, d, n); scalarF(E, s, n); c[fp(n) + op](); });
  };
}
/**
 * MINSS/MAXSS/MINSD/MAXSD: dst0 < src0 (resp. >) ? dst0 : src0 — the source when either is NaN or both are
 * equal (±0 included), exactly f32x4.pmin(src, dst) of the packed forms.
 */
function scalarMinMax(max, n) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops; const p = fp(n);
    const A = n === 4 ? L_F32A : L_F64A, B = n === 4 ? L_F32B : L_F64B;
    xmmStoreF(E, d.r, n, () => {
      scalarF(E, d, n); c.set(A); scalarF(E, s, n); c.set(B);
      c.get(A).get(B).get(A).get(B)[p + (max ? 'gt' : 'lt')]().select();
    });
  };
}
function scalarUn(op, n) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStoreF(E, d.r, n, () => { scalarF(E, s, n); c[fp(n) + op](); });
  };
}
for (const [k, w] of [['ADD', 'add'], ['SUB', 'sub'], ['MUL', 'mul'], ['DIV', 'div']]) {
  HANDLERS[OP[k + 'PS']] = packedBin('f32x4' + w); HANDLERS[OP[k + 'PD']] = packedBin('f64x2' + w);
  HANDLERS[OP[k + 'SS']] = scalarBin(w, 4); HANDLERS[OP[k + 'SD']] = scalarBin(w, 8);
}
HANDLERS[OP.MINPS] = packedMinMax('f32x4pmin'); HANDLERS[OP.MAXPS] = packedMinMax('f32x4pmax');
HANDLERS[OP.MINPD] = packedMinMax('f64x2pmin'); HANDLERS[OP.MAXPD] = packedMinMax('f64x2pmax');
HANDLERS[OP.MINSS] = scalarMinMax(false, 4); HANDLERS[OP.MAXSS] = scalarMinMax(true, 4);
HANDLERS[OP.MINSD] = scalarMinMax(false, 8); HANDLERS[OP.MAXSD] = scalarMinMax(true, 8);
HANDLERS[OP.SQRTPS] = packedUn('f32x4sqrt'); HANDLERS[OP.SQRTPD] = packedUn('f64x2sqrt');
HANDLERS[OP.SQRTSS] = scalarUn('sqrt', 4); HANDLERS[OP.SQRTSD] = scalarUn('sqrt', 8);

// RCP: exact f32 reciprocal (== fround(1/x)); RSQRT: fround(1/sqrt(x)) computed in f64
HANDLERS[OP.RCPPS] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  xmmStore(E, d.r, () => { pushSplatF32(E, 1); loadVec(E, s); c.f32x4div(); });
};
HANDLERS[OP.RCPSS] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  xmmStoreF32(E, d.r, () => { c.f32c(1); scalarF32(E, s); c.f32div(); });
};
HANDLERS[OP.RSQRTPS] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  loadVec(E, s); c.set(L_V0);
  c.get(L_V0); rsqrtLowPair(E); c.set(L_V1);
  c.get(L_V0).get(L_V0).i8x16shuffle(M_HIGH_PAIR); rsqrtLowPair(E); c.set(L_V2);
  xmmStore(E, d.r, () => c.get(L_V1).get(L_V2).i8x16shuffle(M_LOW_PAIRS));
};
HANDLERS[OP.RSQRTSS] = (E, insn) => {
  const c = E.c; const [d, s] = insn.ops;
  xmmStoreF32(E, d.r, () => { c.f64c(1); scalarF32(E, s); c.f64promote().f64sqrt().f64div().f32demote(); });
};

// ------------------------------------------------------------------ logic

function logic(op, swap) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmStore(E, d.r, () => {
      if (swap) { loadVec(E, s, 16); xmmLoad(E, d.r); } else { xmmLoad(E, d.r); loadVec(E, s, 16); }
      c[op]();
    });
  };
}
HANDLERS[OP.ANDPS] = HANDLERS[OP.ANDPD] = logic('v128and', false);
HANDLERS[OP.ANDNPS] = HANDLERS[OP.ANDNPD] = logic('v128andnot', true); // src & ~dst
HANDLERS[OP.ORPS] = HANDLERS[OP.ORPD] = logic('v128or', false);
HANDLERS[OP.XORPS] = HANDLERS[OP.XORPD] = logic('v128xor', false);

// ------------------------------------------------------------------ shuffles / unpacks

function shuffle2(maskOf) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    const mask = maskOf(insn);
    xmmStore(E, d.r, () => { xmmLoad(E, d.r); loadVec(E, s, 16); c.i8x16shuffle(mask); });
  };
}
HANDLERS[OP.SHUFPS] = shuffle2((insn) => shufps(insn.ops[2].v));
HANDLERS[OP.SHUFPD] = shuffle2((insn) => shufpd(insn.ops[2].v));
HANDLERS[OP.UNPCKLPS] = shuffle2(() => unpackMask(4, false));
HANDLERS[OP.UNPCKHPS] = shuffle2(() => unpackMask(4, true));
HANDLERS[OP.UNPCKLPD] = shuffle2(() => unpackMask(8, false));
HANDLERS[OP.UNPCKHPD] = shuffle2(() => unpackMask(8, true));

// ------------------------------------------------------------------ SSE3 horizontal / addsub

function addsub(dbl) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmLoad(E, d.r); c.set(L_V0); loadVec(E, s, 16); c.set(L_V1);
    xmmStore(E, d.r, () => {
      c.get(L_V0).get(L_V1); if (dbl) c.f64x2sub(); else c.f32x4sub();
      c.get(L_V0).get(L_V1); if (dbl) c.f64x2add(); else c.f32x4add();
      c.i8x16shuffle(dbl ? M_ADDSUB_PD : M_ADDSUB_PS);
    });
  };
}
HANDLERS[OP.ADDSUBPS] = addsub(false);
HANDLERS[OP.ADDSUBPD] = addsub(true);
function horizontal(op, dbl) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    xmmLoad(E, d.r); c.set(L_V0); loadVec(E, s, 16); c.set(L_V1);
    xmmStore(E, d.r, () => {
      c.get(L_V0).get(L_V1).i8x16shuffle(dbl ? M_EVEN_PD : M_EVEN_PS);
      c.get(L_V0).get(L_V1).i8x16shuffle(dbl ? M_ODD_PD : M_ODD_PS);
      c[op]();
    });
  };
}
HANDLERS[OP.HADDPS] = horizontal('f32x4add', false); HANDLERS[OP.HSUBPS] = horizontal('f32x4sub', false);
HANDLERS[OP.HADDPD] = horizontal('f64x2add', true); HANDLERS[OP.HSUBPD] = horizontal('f64x2sub', true);

// ------------------------------------------------------------------ compares

/** CMPPS/CMPPD/CMPSS/CMPSD predicate 0..7 on (L_V0 = dst, L_V1 = src); pushes the mask vector. */
function cmpPredicate(E, pred, dbl) {
  const c = E.c;
  const p = dbl ? 'f64x2' : 'f32x4';
  const ordered = () => { c.get(L_V0).get(L_V0)[p + 'eq'](); c.get(L_V1).get(L_V1)[p + 'eq'](); c.v128and(); };
  switch (pred) {
    case 0: c.get(L_V0).get(L_V1)[p + 'eq'](); break;
    case 1: c.get(L_V0).get(L_V1)[p + 'lt'](); break;
    case 2: c.get(L_V0).get(L_V1)[p + 'le'](); break;
    case 3: ordered(); c.v128not(); break;
    case 4: c.get(L_V0).get(L_V1)[p + 'ne'](); break;
    case 5: c.get(L_V0).get(L_V1)[p + 'lt'](); c.v128not(); break;
    case 6: c.get(L_V0).get(L_V1)[p + 'le'](); c.v128not(); break;
    default: ordered(); break;
  }
}
function cmpHandler(dbl, n) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops; const pred = insn.ops[2].v & 7;
    xmmLoad(E, d.r); c.set(L_V0); loadVec(E, s); c.set(L_V1);
    xmmStoreLow(E, d.r, n, () => cmpPredicate(E, pred, dbl));
  };
}
HANDLERS[OP.CMPPS] = cmpHandler(false, 16); HANDLERS[OP.CMPPD] = cmpHandler(true, 16);
HANDLERS[OP.CMPSS] = cmpHandler(false, 4); HANDLERS[OP.CMPSD] = cmpHandler(true, 8);

/** Instructions evaluating a condition code once through E.pushCond, before anything else of theirs could
 * overwrite the float temporaries: they can test a compare's operands directly (Emitter.pushFcmpCond). */
const FCMP_READERS = new Set([OP.JCC, OP.SETCC, OP.CMOVCC]);
/**
 * COMISS/UCOMISS/COMISD/UCOMISD (the same flags: SSE exceptions are masked, the translator raises none). Compared
 * in the operands' own precision (promoting f32 to f64 is exact, so it cannot change an ordering). When the next
 * instruction of the block is a JCC/SETCC/CMOVCC, its condition is computed from the operands kept in L_F32A/B
 * (L_F64A/B) instead of from EFLAGS, and EFLAGS is only written if a later instruction (or a successor block, an
 * exit...) may read it: the common `ucomiss ; jp/jae` then costs one or two host compares.
 */
function comis(dbl) {
  return (E, insn, b) => {
    const c = E.c; const [d, s] = insn.ops;
    const A = dbl ? L_F64A : L_F32A, B = dbl ? L_F64B : L_F32B, p = dbl ? 'f64' : 'f32';
    if (dbl) { scalarF64(E, d); c.set(A); scalarF64(E, s); c.set(B); }
    else { scalarF32(E, d); c.set(A); scalarF32(E, s); c.set(B); }
    E.discardFlags(); // ZF/PF/CF set, OF/SF/AF cleared: nothing of the previous flags survives
    const next = b.insns[E.insnIdx]; // (insnIdx: this instruction's index + 1)
    const fused = next !== undefined && FCMP_READERS.has(next.op);
    E.fcmp = fused ? { blk: E.cur, at: E.insnIdx + 1, a: A, b: B, p } : null;
    if (fused ? E.flagsAfter[E.insnIdx] : E.flagsLive()) compareEflags(E, A, B, p);
  };
}
HANDLERS[OP.COMISS] = HANDLERS[OP.UCOMISS] = comis(false);
HANDLERS[OP.COMISD] = HANDLERS[OP.UCOMISD] = comis(true);

HANDLERS[OP.MOVMSKPS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; loadVec(E, s, 16); c.i32x4bitmask().set(L_REG + d.r); };
HANDLERS[OP.MOVMSKPD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; loadVec(E, s, 16); c.i64x2bitmask().set(L_REG + d.r); };

// ------------------------------------------------------------------ conversions

HANDLERS[OP.CVTDQ2PS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStore(E, d.r, () => { loadVec(E, s, 16); c.f32x4convert_i32x4_s(); }); };
HANDLERS[OP.CVTPS2PD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStore(E, d.r, () => { loadVec(E, s); c.f64x2promote_low_f32x4(); }); };
HANDLERS[OP.CVTPD2PS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStore(E, d.r, () => { loadVec(E, s, 16); c.f32x4demote_f64x2_zero(); }); };
HANDLERS[OP.CVTDQ2PD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStore(E, d.r, () => { loadVec(E, s); c.f64x2convert_low_i32x4_s(); }); };
HANDLERS[OP.CVTPI2PS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStoreLow(E, d.r, 8, () => { loadVec(E, s, 8); c.f32x4convert_i32x4_s(); }); };
HANDLERS[OP.CVTPI2PD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStore(E, d.r, () => { loadVec(E, s, 8); c.f64x2convert_low_i32x4_s(); }); };

/** Packed float -> int32 (CVT(T)PS2DQ / CVT(T)PD2DQ / CVT(T)PS2PI / CVT(T)PD2PI): result to xmm or mm. */
function cvtToInt(dbl, trunc) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    loadVec(E, s); c.set(L_V0);
    if (!trunc) roundMxVec(E, dbl);
    if (dbl) f64ToI32Vec(E); else f32ToI32Vec(E);
    c.set(L_V0);
    if (d.t === OT.MM) mmStore(E, d.r, () => c.get(L_V0));
    else xmmStore(E, d.r, () => c.get(L_V0));
  };
}
HANDLERS[OP.CVTPS2DQ] = cvtToInt(false, false); HANDLERS[OP.CVTTPS2DQ] = cvtToInt(false, true);
HANDLERS[OP.CVTPD2DQ] = cvtToInt(true, false); HANDLERS[OP.CVTTPD2DQ] = cvtToInt(true, true);
HANDLERS[OP.CVTPS2PI] = cvtToInt(false, false); HANDLERS[OP.CVTTPS2PI] = cvtToInt(false, true);
HANDLERS[OP.CVTPD2PI] = cvtToInt(true, false); HANDLERS[OP.CVTTPD2PI] = cvtToInt(true, true);

HANDLERS[OP.CVTSS2SD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStoreF64(E, d.r, () => { scalarF32(E, s); c.f64promote(); }); };
HANDLERS[OP.CVTSD2SS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStoreF32(E, d.r, () => { scalarF64(E, s); c.f32demote(); }); };
HANDLERS[OP.CVTSI2SS] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStoreF32(E, d.r, () => { E.loadOp(s); c.f32convert_i32_s(); }); };
HANDLERS[OP.CVTSI2SD] = (E, insn) => { const c = E.c; const [d, s] = insn.ops; xmmStoreF64(E, d.r, () => { E.loadOp(s); c.f64convert_i32_s(); }); };

/** Scalar float -> r32 (CVT(T)SS2SI / CVT(T)SD2SI). */
function cvtToGpr(dbl, trunc) {
  return (E, insn) => {
    const c = E.c; const [d, s] = insn.ops;
    if (!dbl && trunc) { // CVTTSS2SI: straight from the f32 (same select as f64ToI32Scalar)
      scalarF32(E, s); c.tee(L_F32A).i32trunc_sat_f32_s().i32(-TWO31).get(L_F32A).f32c(TWO31).f32lt().select();
      c.set(L_REG + d.r);
      return;
    }
    if (dbl) scalarF64(E, s); else { scalarF32(E, s); c.f64promote(); }
    c.set(L_F64A);
    roundMxScalar(E, trunc);
    f64ToI32Scalar(E);
    c.set(L_REG + d.r);
  };
}
HANDLERS[OP.CVTSS2SI] = cvtToGpr(false, false); HANDLERS[OP.CVTTSS2SI] = cvtToGpr(false, true);
HANDLERS[OP.CVTSD2SI] = cvtToGpr(true, false); HANDLERS[OP.CVTTSD2SI] = cvtToGpr(true, true);

// Scalar single-precision instructions whose every XMM access goes through the lane-0 shadow helpers (scalarF32,
// xmmStoreF32, xmmStoreShadowed): chains of them keep their values in f32 locals (Emitter.xmmShadowSync). Not
// CVTSS2SD / CVTSD2SS (an f64 lane of the vector), nor the packed or double forms.
for (const k of ['MOVSS', 'ADDSS', 'SUBSS', 'MULSS', 'DIVSS', 'MINSS', 'MAXSS', 'SQRTSS', 'RCPSS', 'RSQRTSS',
  'CVTSI2SS', 'CVTSS2SI', 'CVTTSS2SI', 'COMISS', 'UCOMISS']) XMM_SHADOW_OPS.add(OP[k]);
// Their double-precision counterparts and the low-qword moves, through the f64 shadow helpers (scalarF64,
// xmmStoreF64, xmmStoreShadowed64): the scalar code of the C runtimes' SSE2 math routines; MOVHPS/MOVHPD, which leave
// the low qword alone; PEXTRW / MOVD / MOVQ (translate-sse-int.js) reading the shadow's bits. The whole-register moves
// are in both sets (mov16 handles both kinds of shadow).
for (const k of ['MOVSD', 'MOVLPD', 'MOVLPS', 'MOVHPD', 'MOVHPS', 'ADDSD', 'SUBSD', 'MULSD', 'DIVSD', 'MINSD', 'MAXSD',
  'SQRTSD', 'CVTSI2SD', 'CVTSD2SI', 'CVTTSD2SI', 'COMISD', 'UCOMISD']) XMM_SHADOW64_OPS.add(OP[k]);
for (const k of MOV16) { XMM_SHADOW_OPS.add(OP[k]); XMM_SHADOW64_OPS.add(OP[k]); }

// ------------------------------------------------------------------ MXCSR

HANDLERS[OP.LDMXCSR] = (E, insn) => { const c = E.c; c.get(L_STATE); E.ea(insn.ops[0]); c.i32load(0, 0).i32(0xffff).and().i32store(ST.MXCSR); };
HANDLERS[OP.STMXCSR] = (E, insn) => { const c = E.c; E.eaTo(insn.ops[0]); c.get(L_TA).get(L_STATE).i32load(ST.MXCSR).i32store(0, 0); E.smcCheck(insn, 4); }; // (the decoder gives m32 no size)

export {};

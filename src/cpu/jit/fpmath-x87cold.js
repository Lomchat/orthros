// Cold paths of the translated x87 arithmetic (translate-x87.js arith): the outcomes a hot path's tests send aside —
// a NaN result (the x87 NaN rule), an infinite or zero result that may or may not be exact, a 24-bit midpoint from a
// double operand —, emitted once here as runtime kernels (pure WebAssembly, D004) instead of inline in every arithmetic
// instruction of every region. The same emitters produce the inline form (translation option x87Cold: 'inline', the
// earlier code, kept for measurement), so both forms run the same operations on the same values.
//   x87ArithF32(state, a, b, r, op) -> (f32 result, i32 settled): 24-bit precision, round to nearest, float operands a / b
//     (ST(dst) or ST(0), the other operand: L_F32A / L_F32B, not swapped for the reversed operations) whose f32 result r
//     has an exponent field of 0 or 255 — an exact zero, an infinity from an infinite operand, a NaN by the x87 rule;
//     settled 0: anything else (underflow / overflow into the x87's wider exponent range), left to the interpreter.
//   x87RoundF32(state, a, b, p, op) -> (f32 result, i32 settled): the same mode, double operands and their f64 result p,
//     after the inline tests (a zero, a result in the float range from float operands): an infinity from an infinite
//     operand, a 24-bit midpoint settled by the error of the f64 operation, a NaN by the x87 rule when it is a float.
//   x87NanArith(state, a, b) -> f64: the x87 NaN result of an operation on double operands whose f64 result is a NaN.
// IE is raised in the state block's status word (ES as well when IE is unmasked), as X87.raise does.
// Why calls are fine here: the paths are cold and branch-hinted — TurboFan places them out of line with the spills around
// the call (the hot loops measured kept or lowered their host instruction counts: docs/jit-code-shape.md "x87 regions:
// the size of the arithmetic"; without the hints, as in Node by default, a call on a cold path does cost spills on the
// hot one) — and a call costs a few nanoseconds where an inline copy of this code cost ~100-250 WASM operations and
// ~0.3-1.5 KiB of machine code per arithmetic instruction.
import { Code, T } from './wasm.js';
import { ST } from '../state.js';
import { INDEFINITE_BITS } from './fpmath-exp.js';

/** Raise the exception `bit` (0 IE ... 5 PE) like X87.raise, the state block address in local `state`: the flag, and ES
 * (status word bit 7) when the exception is unmasked in the control word (SDM 8.1.3). */
export function emitRaise(c, state, bit) {
  c.get(state).get(state).i32load16u(ST.FPU_SW).i32(1 << bit).or();
  c.get(state).i32load16u(ST.FPU_CW).i32(bit).shr_u().i32(1).and().i32(1).xor().i32(7).shl().or();
  c.i32store16(ST.FPU_SW);
}

/**
 * arithF32's cold path for a NaN result (L.C), no exit: X87.arith's rule on float operands as the interpreter sees them —
 * promoted to f64 they are quiet NaNs, so they raise nothing and the result is the NaN operand (of two, the larger
 * significand, quiet bit included, the positive one on a tie) quieted; without a NaN operand (inf - inf, 0 * inf, 0 / 0,
 * inf / inf) IE is raised and the result is the indefinite (0xffc00000 as a float). Branches to `done` with the result in
 * L.C; a non-NaN result falls through. L: { state, A, B, C (f32), T4, T5 (i32 scratch) }.
 */
export function emitNanF32(c, L, done) {
  const { A, B, C, T4, T5 } = L;
  c.get(C).get(C).f32ne();
  const isNan = c.hint(false).if_();
  c.get(A).get(A).f32ne().get(B).get(B).f32ne().or();
  const some = c.if_();
  // T4 / T5: the operands' bits; a wins when it is a NaN and b is not, or its fraction (quiet bit forced, as the
  // promotion does) is larger, or the same with a clear sign
  c.get(A).i32reinterpret_f32().set(T4); c.get(B).i32reinterpret_f32().set(T5);
  c.get(T4).get(T5);
  c.get(B).get(B).f32eq();
  c.get(T4).i32(0x7fffff).and().i32(0x400000).or().get(T5).i32(0x7fffff).and().i32(0x400000).or().gt_u().or();
  c.get(T4).i32(0x7fffff).and().i32(0x400000).or().get(T5).i32(0x7fffff).and().i32(0x400000).or().eq().get(T4).i32(0).ge_s().and().or();
  c.get(A).get(A).f32ne().and();
  c.select().i32(0x400000).or().f32reinterpret_i32().set(C);
  c.else_();
  emitRaise(c, L.state, 0);
  c.i32(0xffc00000 | 0).f32reinterpret_i32().set(C);
  c.end(); void some;
  c.br(done);
  c.end(); void isNan;
}

/**
 * The same rule for f64 operands (L.A, L.B: registers held as doubles, m64 operands — their signaling NaNs raise IE, as
 * in X87.nan2) and an f64 result L.C: with `done` (roundF32's cold path, a float result in L.F32C) the NaN must be a
 * float — its payload in the 23 high fraction bits — else it falls through (to the interpreter step); without (the
 * double paths) L.C is a NaN on entry and the NaN, or the indefinite, replaces it.
 * L: { state, A, B, C (f64), I64A, I64B (i64 scratch), F32C (f32) }.
 */
export function emitNanF64(c, L, done) {
  const { A, B, C, I64A, I64B } = L, QUIET = 0x0008000000000000n, FRAC = 0x000fffffffffffffn;
  if (done) { c.get(C).get(C).f64ne(); }
  const isNan = done ? c.hint(false).if_() : null;
  c.get(A).get(A).f64ne().get(B).get(B).f64ne().or();
  const some = c.if_();
  c.get(A).i64reinterpret_f64().set(I64A); c.get(B).i64reinterpret_f64().set(I64B);
  // IE when a NaN operand is signaling
  c.get(A).get(A).f64ne().get(I64A).i64(QUIET).i64and().i64eqz().and();
  c.get(B).get(B).f64ne().get(I64B).i64(QUIET).i64and().i64eqz().and().or();
  const ie = c.if_(); emitRaise(c, L.state, 0); c.end(); void ie;
  // the winner (X87.nan2 / pickNaN): a when b is not a NaN, or a's fraction is larger, or equal with a clear sign
  c.get(I64A).get(I64B);
  c.get(B).get(B).f64eq();
  c.get(I64A).i64(FRAC).i64and().get(I64B).i64(FRAC).i64and().i64gt_u().or();
  c.get(I64A).i64(FRAC).i64and().get(I64B).i64(FRAC).i64and().i64eq().get(I64A).i64(0n).i64ge_s().and().or();
  c.get(A).get(A).f64ne().and();
  c.select().i64(QUIET).i64or().set(I64A);
  if (done) {
    // a float when the 29 low fraction bits are clear: sign, all-ones exponent, the 23 high fraction bits
    c.get(I64A).i64(0x1fffffffn).i64and().i64eqz();
    const fits = c.if_();
    c.get(I64A).i64(32n).i64shr_u().wrap().i32(0x80000000 | 0).and().i32(0x7f800000).or();
    c.get(I64A).i64(29n).i64shr_u().wrap().i32(0x7fffff).and().or().f32reinterpret_i32().set(L.F32C);
    c.br(done);
    c.end(); void fits;
  } else c.get(I64A).f64reinterpret_i64().set(C);
  c.else_();
  emitRaise(c, L.state, 0);
  if (done) { c.i32(0xffc00000 | 0).f32reinterpret_i32().set(L.F32C); c.br(done); } else c.i64(INDEFINITE_BITS).f64reinterpret_i64().set(C);
  c.end(); void some;
  if (done) c.end(); void isNan;
}

/**
 * arithF32's cold path (after the exponent test sent there), operation `op` (0 add, 1 mul, 4 sub, 5 subr, 6 div,
 * 7 divr) on L.A / L.B with the f32 result in L.C: an exact zero (a sum is exact at zero; a product or quotient only
 * with a zero dividend / factor or an infinite divisor), an infinity coming from an infinite operand (a dividend for a
 * quotient), a NaN by the x87 rule (emitNanF32) branch to `done` with the result in L.C; anything else falls through.
 */
export function emitArithF32Cold(c, L, op, done) {
  const { A, B, C } = L;
  const [x, y] = op === 5 || op === 7 ? [B, A] : [A, B];
  c.get(C).f32c(0).f32eq();
  if (op === 1) c.get(A).f32c(0).f32eq().get(B).f32c(0).f32eq().or().and();
  else if (op >= 6) c.get(x).f32c(0).f32eq().get(y).f32abs().f32c(Infinity).f32eq().or().and();
  c.br_if(done);
  // an infinite result from an infinite operand (a dividend for a quotient) is exact
  c.get(C).f32abs().f32c(Infinity).f32eq();
  if (op >= 6) c.get(x).f32abs(); else c.get(A).f32abs().get(B).f32abs().f32max();
  c.f32c(Infinity).f32eq().and().br_if(done);
  emitNanF32(c, L, done);
}

/**
 * roundF32's cold path for a sum, difference or product (op 0, 4, 5, 1) whose f64 result p (L.C, bits in L.I64A) is a
 * 24-bit midpoint inside the float range while an operand is not a float (a multiplier such as 0.9 read as a double
 * makes it frequent: its repeating significand puts ~9 % of the products of floats exactly on a midpoint). The exact
 * result's side of p comes from the error of the f64 operation — TwoSum for a sum, Dekker's product with Veltkamp
 * splitting (no FMA in WebAssembly) for a product, operands kept within 2^±900 so that the splitting neither overflows
 * nor underflows: p moved one f64 step toward it then rounds to the right float (a zero error leaves the tie to
 * f32.demote's even rule). Branches to `done` with L.F32C set, else falls through.
 * L: { A, B, C (f64: operands, p), I64A, F32C, D, Er, G, H (f64 scratch) }.
 */
export function emitMidpointF32(c, L, op, done) {
  const { A, B, D, Er, G, H } = L;
  c.get(L.I64A).wrap().i32(0x1fffffff).and().i32(0x10000000).eq();
  c.get(L.I64A).i64(32n).i64shr_u().wrap().i32(0x7fffffff).and().i32(0x38100000).sub().i32(0x47e00000 - 0x38100000).lt_u().and();
  for (const x of [A, B]) { c.get(x).f64abs().f64c(2 ** 900).f64lt().and(); c.get(x).f64abs().f64c(2 ** -900).f64gt().and(); }
  const mid = c.if_();
  if (op === 1) {
    const SPLIT = 134217729; // 2^27 + 1
    c.get(A).f64c(SPLIT).f64mul().set(D); c.get(D).get(D).get(A).f64sub().f64sub().set(D); c.get(A).get(D).f64sub().set(Er); // a = ah + al
    c.get(B).f64c(SPLIT).f64mul().set(G); c.get(G).get(G).get(B).f64sub().f64sub().set(G); c.get(B).get(G).f64sub().set(H); // b = bh + bl
    c.get(D).get(G).f64mul().get(L.C).f64sub().get(D).get(H).f64mul().f64add().get(Er).get(G).f64mul().f64add().get(Er).get(H).f64mul().f64add().set(D);
  } else {
    // p = x + y with (x, y) = (a, b), (a, -b) or (b, -a): bb = p - x; error = (x - (p - bb)) + (y - bb)
    const x = op === 5 ? B : A, y = op === 5 ? A : B, neg = op !== 0;
    c.get(L.C).get(x).f64sub().set(D);
    c.get(x).get(L.C).get(D).f64sub().f64sub();
    c.get(y); if (neg) c.f64neg(); c.get(D).f64sub();
    c.f64add().set(D);
  }
  // bits + 1 moves away from zero, - 1 toward it: toward the exact value (error of the same sign as p: away)
  c.get(L.I64A).i64(1n).i64(-1n).get(D).f64c(0).f64gt().get(L.C).f64c(0).f64gt().eq().select().i64add();
  c.get(L.I64A);
  c.get(D).f64c(0).f64ne().select();
  c.f64reinterpret_i64().f32demote().set(L.F32C);
  c.br(done);
  c.end(); void mid;
}

/**
 * roundF32's cold path after its inline tests (a zero; a result in the float range from float operands), `op` on L.A /
 * L.B with the f64 result L.C (bits in L.I64A, L.F32C its demotion): an infinity from an infinite operand, a midpoint
 * (emitMidpointF32, + - * only), a NaN that is a float (emitNanF64) branch to `done` with the float in L.F32C;
 * anything else falls through.
 */
export function emitRoundF32Rare(c, L, op, done) {
  c.get(L.C).f64abs().f64c(Infinity).f64eq().get(L.A).f64abs().get(L.B).f64abs().f64max().f64c(Infinity).f64eq().and().br_if(done);
  if (op <= 5) emitMidpointF32(c, L, op, done);
  emitNanF64(c, L, done);
}

/** the arithmetic operation codes (translate-x87.js arith: 0 add, 1 mul, 4 sub, 5 subr, 6 div, 7 divr) */
const OPS = [0, 1, 4, 5, 6, 7];

/**
 * Define the kernels in a module under construction (nothing exported; the caller decides).
 * @param {import('./wasm.js').ModuleBuilder} m
 * @returns {{ arithF32: number, roundF32: number, nanArith: number }} function indices
 */
export function addX87ColdKernels(m) {
  // one copy of the emitter's code per operation code (op is a constant in the region): the same operations as inline
  const perOp = (c, OP, body) => {
    for (const op of OPS) { c.get(OP).i32(op).eq(); const k = c.if_(); body(op); c.end(); void k; }
  };
  let arithF32, roundF32, nanArith;
  {
    const c = new Code();
    // params: 0 state, 1 a, 2 b, 3 r, 4 op ; locals: 5 t4, 6 t5
    const L = { state: 0, A: 1, B: 2, C: 3, T4: 5, T5: 6 };
    perOp(c, 4, (op) => {
      const done = c.block();
      emitArithF32Cold(c, L, op, done);
      c.get(L.C).i32(0).return_();
      c.end(); // done
      c.get(L.C).i32(1).return_();
    });
    c.get(L.C).i32(0);
    arithF32 = m.func([T.i32, T.f32, T.f32, T.f32, T.i32], [T.f32, T.i32], [T.i32, T.i32], c, 'x87ArithF32');
  }
  {
    const c = new Code();
    // params: 0 state, 1 a, 2 b, 3 p, 4 op ; locals: 5 i64a, 6 i64b, 7 f32c, 8 d, 9 e, 10 g, 11 h
    const L = { state: 0, A: 1, B: 2, C: 3, I64A: 5, I64B: 6, F32C: 7, D: 8, Er: 9, G: 10, H: 11 };
    c.get(L.C).i64reinterpret_f64().set(L.I64A);
    c.get(L.C).f32demote().set(L.F32C);
    perOp(c, 4, (op) => {
      const done = c.block();
      emitRoundF32Rare(c, L, op, done);
      c.get(L.F32C).i32(0).return_();
      c.end(); // done
      c.get(L.F32C).i32(1).return_();
    });
    c.get(L.F32C).i32(0);
    roundF32 = m.func([T.i32, T.f64, T.f64, T.f64, T.i32], [T.f32, T.i32], [T.i64, T.i64, T.f32, T.f64, T.f64, T.f64, T.f64], c, 'x87RoundF32');
  }
  {
    const c = new Code();
    // params: 0 state, 1 a, 2 b ; locals: 3 r, 4 i64a, 5 i64b
    const L = { state: 0, A: 1, B: 2, C: 3, I64A: 4, I64B: 5 };
    emitNanF64(c, L, null);
    c.get(L.C);
    nanArith = m.func([T.i32, T.f64, T.f64], [T.f64], [T.f64, T.i64, T.i64], c, 'x87NanArith');
  }
  return { arithF32, roundF32, nanArith };
}

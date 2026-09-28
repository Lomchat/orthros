// Pure-WebAssembly exponential/logarithm kernels for the JIT's x87 instructions: F2XM1 (2^x - 1),
// FYL2X (log2 x), FYL2XP1 (log2(1 + x)) and FSCALE (x * 2^trunc(y)). No imports, no memory, no
// calls into JS (D004): everything lives in locals and immediate constants. Constants and the
// two fitted polynomials come from tools/gen_fpmath_exp.py (Decimal least squares on Chebyshev
// nodes; every formula below is derived from the series definitions).
//
// Common tool — exact leading product. A double f split by Veltkamp (t = f (2^27 + 1),
// fh = t - (t - f), fl = f - fh) has fh and fl of at most 26 significant bits, so their products
// with a 27-bit constant head are exact; the constant tail (~2^-27 relative) times f is rounded
// but contributes ~2^-80. That gives the leading term of each series as an exact double-double
// (hi, lo) and the result is rounded once when hi + (lo + small corrections) is formed.
//
// exp2m1(x) = 2^x - 1. k = trunc(x), r = x - k in (-1, 1) (exact), 2^x - 1 = 2^k (2^r - 1) + (2^k - 1)
//   with 2^r - 1 = r ln2 + r^2 R(r), R a degree-13 least-squares polynomial on [-1, 1] (its error
//   is < 1.3e-17 relative to 2^r - 1, evaluated as even/odd Horner chains in r^2 to shorten the
//   dependency chain). r ln2 is the exact double-double rh LN2_HI + (rl LN2_HI + r LN2_LO); the
//   polynomial part r (r R) carries about 1 ulp of its own value, which is at most 0.45 of the
//   result at |r| = 1 and vanishes as r^2 for small r; the final sum rounds once: worst case about
//   1 ulp, and for |x| < 2^-27 the result is the correctly rounded x ln2 (no cancellation, since
//   the -1 is never computed for k = 0: 2^k - 1 = 0 exactly; |x| < 2^-1000 is scaled by 2^600 and
//   back through roundTiny so that denormal results are correctly rounded). For |x| >= 1 both terms of the
//   recombination have the same sign (P(r) >= 0 for r >= 0, <= 0 for r <= 0), so no cancellation
//   either; 2^k is built from the exponent bits, k in [-59, 1023] after the clamps.
//
// log2(x): x = 2^e m, m in [sqrt(1/2), sqrt(2)) by the mantissa bits (denormals first scaled by
//   2^54), f = m - 1 (exact by Sterbenz), s = f / (2 + f), z = s^2. From ln(1 + f) = 2 atanh(s) =
//   2 s + s R(z), R(z) = 2 z / 3 + 2 z^2 / 5 + ..., and 2 s = f - f s = f - hfsq (1 - s) with
//   hfsq = f^2 / 2 (since f s = f^2 / (2 + f) = hfsq (1 - s)):
//     ln(1 + f) = f - c,  c = hfsq - s (hfsq + z G(z)),  G a degree-6 least-squares fit on z <= 0.0295.
//   The rounding of s (about 1 ulp: 2 + f then the quotient) only reaches c through the term
//   s (hfsq + ...), i.e. weighted by f^2 / 4 relative to f, and c itself is at most 0.2 |f|, so the
//   correction carries about 0.2 ulp of the result. Then log2 x = e + f log2e - c log2e with
//   f log2e exact as fh LOG2E_HI + (fl LOG2E_HI + f LOG2E_LO), e + hi made exact by Fast2Sum
//   (|e| >= 1 > |hi| whenever e != 0), and one final rounding: about 0.8 ulp worst case.
//   Powers of two give f = 0 -> exactly e (log2(1) = +0).
//
// log2p1(x) = log2(1 + x): for x in [sqrt(1/2) - 1, sqrt(2) - 1] the same core with f = x directly
//   (nothing is added to x, so tiny x gives the correctly rounded x log2e; |x| < 2^-1000 takes the
//   scaled exact-product path through roundTiny like exp2m1); outside, y = 1 + x with its exact
//   rounding error d (TwoSum) and log2(y + d) = log2(y) + d / (y ln2) folded into the low part.
//
// scalb(a, b): FSCALE with the interpreter's special cases (src/cpu/interp-x87.js): NaN rule
//   (both NaN -> indefinite, else the NaN operand), b = +inf -> a * inf (a == 0 -> indefinite),
//   b = -inf -> a * 0 for finite a (else indefinite), a = 0 or inf unchanged. Otherwise the
//   result is a 2^e, e = trunc(b), rounded ONCE like the hardware: e is clamped to [-2200, 2200]
//   (beyond, every finite non-zero double overflows / underflows), a denormal a is normalized
//   (a 2^54, exact), t = exponent(a) + e is the exponent of the exact result; t > 1023 -> inf,
//   t >= -1022 -> the exponent field is rewritten (exact), else the mantissa is placed at
//   exponent -1022 (exact) and multiplied by the power of two 2^max(t + 1022, -1074) (a normal or
//   denormal double), whose IEEE product is the single correct rounding of the exact value. The
//   interpreter's 2^-1000 stepping rounds twice in the denormal range (e.g. 1.25 2^-74 by 2^-1001:
//   0.625 units of 2^-1074, hardware and kernel 2^-1074, interpreter 0).
import { Code, T } from './wasm.js';

// ---- constants (tools/gen_fpmath_exp.py)
/** ln 2 as a 27-bit head (exact products with 26-bit values) and its tail. */
export const LN2_HI = 0.693147175014019, LN2_LO = 5.5459262969660605e-09;
/** log2 e: 27-bit head, tail, and the plain double (for the small correction term). */
export const LOG2E_HI = 1.4426950365304947, LOG2E_LO = 4.3584687174185184e-09, LOG2E = 1.4426950408889634;
/** Mantissa field of sqrt(2): x = 2^e m with m in [sqrt(1/2), sqrt(2)) picks e by this threshold. */
export const SQRT2_MANT = 0x6a09e667f3bcdn;
/** Window of log2p1 where the series is applied to x itself: f = m - 1 range of the log2 core. */
export const LOG2P1_LO = -0.2928932188134525, LOG2P1_HI = 0.41421356237309503;
/** R(r) = (2^r - 1 - r ln2) / r^2 on [-1, 1], least squares, low to high (relative error < 1.22e-17). */
export const EXP_R = Object.freeze([0.24022650695910072, 0.05550410866482158, 0.009618129107628475, 0.0013333558146428441, 0.00015403530393384222, 1.5252733804061894e-05, 1.3215486788577438e-06, 1.0178086008262126e-07, 7.0549120683278866e-09, 4.4455385107572736e-10, 2.567777998853124e-11, 1.3691176295591378e-12, 6.826382367298916e-14, 3.1532518369821457e-15]);
/** G(z) = (2 atanh(s) - 2 s) / s^3, z = s^2 on [0, 0.0295], least squares, low to high (tail error < 4.81e-18 relative). */
export const LOG_G = Object.freeze([0.666666666666667, 0.39999999999897684, 0.2857142862677037, 0.2222221100883431, 0.18182898079840507, 0.15331430055741951, 0.1461998992141016]);

/** x87 indefinite QNaN bit pattern (negative quiet NaN). */
export const INDEFINITE_BITS = 0xfff8000000000000n;
const SPLIT = 134217729; // 2^27 + 1 (Veltkamp)
const TWO_M1000 = 2 ** -1000, TWO_54 = 2 ** 54, TWO_600 = 2 ** 600, TWO_M600 = 2 ** -600, TWO_474 = 2 ** 474;

/** Horner evaluation of coefs (low to high) at the value in local v; leaves the result on the stack. */
function horner(c, coefs, v) {
  c.f64c(coefs[coefs.length - 1]);
  for (let j = coefs.length - 2; j >= 0; j--) c.get(v).f64mul().f64c(coefs[j]).f64add();
}

/** Push the x87 indefinite QNaN. */
function indefinite(c) { c.i64(INDEFINITE_BITS).f64reinterpret_i64(); }

/**
 * Emit the core of exp2m1: 2^r - 1 = HI + LO for the value r in local R (|r| < 1), the exact
 * double-double r ln2 plus the polynomial part (see the header). Shared by the kernel and by the
 * translator's inline F2XM1 fast path (translate-x87.js), so both perform the same operations on the
 * same operands and give the same bits. Locals (f64): R is only read; TT and RL may be the same local,
 * and so may RH and HI (each is dead when the other is written); all others distinct.
 * @param {Code} c
 * @param {{ R: number, TT: number, RH: number, RL: number, Z: number, E: number, O: number, HI: number, LO: number }} L
 */
export function emitExp2m1Core(c, { R, TT, RH, RL, Z, E, O, HI, LO }) {
  // Veltkamp split of r
  c.get(R).f64c(SPLIT).f64mul().set(TT);
  c.get(TT).get(TT).get(R).f64sub().f64sub().set(RH);
  c.get(R).get(RH).f64sub().set(RL);
  // R(r) = E(z) + r O(z), z = r^2 (two independent Horner chains)
  c.get(R).get(R).f64mul().set(Z);
  horner(c, EXP_R.filter((_, i) => i % 2 === 0), Z); c.set(E);
  horner(c, EXP_R.filter((_, i) => i % 2 === 1), Z); c.set(O);
  // 2^r - 1 = hi + lo, hi = rh LN2_HI (exact), lo = (rl LN2_HI + r LN2_LO) + r (r (E + r O))
  c.get(RL).f64c(LN2_HI).f64mul().get(R).f64c(LN2_LO).f64mul().f64add();
  c.get(R).get(R).get(E).get(R).get(O).f64mul().f64add().f64mul().f64mul().f64add().set(LO);
  c.get(RH).f64c(LN2_HI).f64mul().set(HI);
}
/** Inline F2XM1 fast-path window: TWO_M1000 <= |x| < 1 (k = trunc(x) = 0, no tiny scaling). */
export const EXP2M1_CORE_MIN = TWO_M1000;

/**
 * Define the kernels in a module under construction. Nothing is exported; the caller decides
 * (m.exportFunc) or calls them by index.
 * @param {import('./wasm.js').ModuleBuilder} m
 * @returns {{ exp2m1: number, log2: number, log2p1: number, scalb: number }} function indices:
 *   exp2m1(x: f64) -> f64 : 2^x - 1. NaN -> the input NaN; +-0 -> the same zero; +inf -> +inf;
 *     x >= 1024 -> +inf (overflow); x <= -60 (incl. -inf) -> -1; otherwise about 1 ulp, and the
 *     correctly rounded x ln2 for |x| < 2^-27 (denormal results included).
 *   log2(x: f64) -> f64 : NaN -> the input NaN; +-0 -> -inf; x < 0 (incl. -inf) -> indefinite QNaN
 *     (0xFFF8000000000000); +inf -> +inf; powers of two exact (log2(1) = +0); denormals normalized.
 *   log2p1(x: f64) -> f64 : log2(1 + x). NaN -> the input NaN; +-0 -> the same zero; x = -1 -> -inf;
 *     x < -1 (incl. -inf) -> indefinite QNaN; +inf -> +inf; any x > -1 otherwise, tiny x accurate.
 *   scalb(a: f64, b: f64) -> f64 : a 2^trunc(b) correctly rounded (single rounding, denormal
 *     results included) with the interpreter's FSCALE special cases (see the header).
 */
export function addExpKernels(m) {
  // ---- roundTiny(hi, lo) -> (hi + lo) 2^-600 correctly rounded, for |hi + lo| < 2^-400 (results
  // that may be denormal after scaling). p = hi + lo is the 53-bit rounding; when p sits exactly
  // on a midpoint of the target grid (unit 2^-1074, i.e. 2^-474 before scaling), the exact
  // residual (hi - p) + lo tells which side the true value is on; otherwise p's rounding to the
  // grid is the correct one (p is within half a 53-bit ulp of the value and at least one full
  // 53-bit ulp away from any midpoint). Normal results have no fractional grid part and scale exactly.
  const roundTiny = (() => {
    const c = new Code();
    // params: 0 hi, 1 lo ; f64 locals: 2 p, 3 res, 4 q
    const [HI, LO, P, RES, Q] = [0, 1, 2, 3, 4];
    c.get(HI).get(LO).f64add().set(P);
    c.get(HI).get(P).f64sub().get(LO).f64add().set(RES);
    c.get(P).f64c(TWO_474).f64mul().set(Q); // p in grid units (exact)
    c.get(Q).get(Q).f64trunc().f64sub().f64abs().f64c(0.5).f64eq().get(RES).f64c(0).f64ne().and(); const tie = c.if_();
    c.get(Q).f64c(0.5).get(RES).f64copysign().f64add().f64c(Number.MIN_VALUE).f64mul().return_(); // integer units * 2^-1074, exact
    c.end(); void tie;
    c.get(P).f64c(TWO_M600).f64mul();
    return m.func([T.f64, T.f64], [T.f64], [T.f64, T.f64, T.f64], c, 'roundTiny');
  })();

  // ---- exp2m1(x)
  const exp2m1 = (() => {
    const c = new Code();
    // params: 0 x ; f64 locals: 1 r, 2 k (then 2^k), 3 t, 4 rh, 5 rl, 6 z, 7 e, 8 o, 9 p, 10 scale
    // (10 hi, 11 lo) ; i32 local: 12 tiny
    const [X, R, K, TT, RH, RL, Z, E, O, P, HI, LO, TINY] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    c.get(X).get(X).f64ne(); const nan = c.if_(); c.get(X).return_(); c.end(); void nan;
    c.get(X).f64c(0).f64eq(); const zero = c.if_(); c.get(X).return_(); c.end(); void zero;
    c.get(X).f64c(1024).f64ge(); const big = c.if_(); c.f64c(Infinity).return_(); c.end(); void big;
    c.get(X).f64c(-60).f64le(); const neg = c.if_(); c.f64c(-1).return_(); c.end(); void neg;
    // |x| < 2^-1000 (result ~ x ln2 down in the denormals): work on x 2^600 (k = 0) and let
    // roundTiny scale back with a single correct rounding
    c.get(X).f64abs().f64c(TWO_M1000).f64lt().tee(TINY); const tiny = c.if_();
    c.get(X).f64c(TWO_600).f64mul().set(X);
    c.end(); void tiny;
    // k = trunc(x), r = x - k (exact)
    c.get(X).f64trunc().set(K);
    c.get(X).get(K).f64sub().set(R);
    emitExp2m1Core(c, { R, TT, RH, RL, Z, E, O, HI, LO });
    c.get(TINY); const tinyOut = c.if_(); c.get(HI).get(LO).call(roundTiny).return_(); c.end(); void tinyOut;
    c.get(HI).get(LO).f64add().set(P);
    // 2^k from the exponent bits (k in [-59, 1023]); result = 2^k p + (2^k - 1)
    c.get(K).i64trunc_f64_s().i64(1023n).i64add().i64(52n).i64shl().f64reinterpret_i64().set(K);
    c.get(K).get(P).f64mul().get(K).f64c(1).f64sub().f64add();
    return m.func([T.f64], [T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.i32], c, 'exp2m1');
  })();

  // ---- lncore(f, e, extra) -> e + log2(1 + f) + extra, f in [sqrt(1/2) - 1, sqrt(2) - 1], e integral
  const lncore = (() => {
    const c = new Code();
    // params: 0 f, 1 e, 2 extra ; f64 locals: 3 s, 4 z, 5 hfsq, 6 c, 7 t, 8 fh, 9 fl, 10 hi, 11 lo, 12 sum
    const [F, E, EXTRA, S, Z, HF, CC, TT, FH, FL, HI, LO, SUM] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    // s = f / (2 + f), z = s^2
    c.get(F).f64c(2).get(F).f64add().f64div().set(S);
    c.get(S).get(S).f64mul().set(Z);
    // hfsq = f^2 / 2 ; c = hfsq - s (hfsq + z G(z))
    c.f64c(0.5).get(F).f64mul().get(F).f64mul().set(HF);
    c.get(HF).get(S).get(HF).get(Z);
    horner(c, LOG_G, Z);
    c.f64mul().f64add().f64mul().f64sub().set(CC);
    // Veltkamp split of f
    c.get(F).f64c(SPLIT).f64mul().set(TT);
    c.get(TT).get(TT).get(F).f64sub().f64sub().set(FH);
    c.get(F).get(FH).f64sub().set(FL);
    // hi = fh LOG2E_HI (exact) ; lo = (fl LOG2E_HI + f LOG2E_LO) - c LOG2E + extra
    c.get(FH).f64c(LOG2E_HI).f64mul().set(HI);
    c.get(FL).f64c(LOG2E_HI).f64mul().get(F).f64c(LOG2E_LO).f64mul().f64add().get(CC).f64c(LOG2E).f64mul().f64sub().get(EXTRA).f64add().set(LO);
    // Fast2Sum(e, hi): sum = e + hi, err = (e - sum) + hi ; result = sum + (err + lo)
    c.get(E).get(HI).f64add().set(SUM);
    c.get(E).get(SUM).f64sub().get(HI).f64add().get(LO).f64add().get(SUM).f64add();
    return m.func([T.f64, T.f64, T.f64], [T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64], c, 'lncore');
  })();

  // ---- log2core(y, extra) -> log2(y) + extra, y positive finite (denormals allowed)
  const log2core = (() => {
    const c = new Code();
    // params: 0 y, 1 extra ; locals: 2 bits (i64), 3 e (f64)
    const [Y, EXTRA, B, E] = [0, 1, 2, 3];
    c.get(Y).i64reinterpret_f64().set(B);
    // denormal: scale by 2^54, e = -54
    c.get(B).i64(0x0010000000000000n).i64lt_u(); const den = c.if_();
    c.get(Y).f64c(TWO_54).f64mul().i64reinterpret_f64().set(B);
    c.f64c(-54).set(E);
    c.end(); void den;
    // e += biased exponent - 1023 ; keep the mantissa field
    c.get(E).get(B).i64(52n).i64shr_u().wrap().i32(1023).sub().f64convert_i32_s().f64add().set(E);
    c.get(B).i64(0xfffffffffffffn).i64and().set(B);
    // m in [sqrt(1/2), sqrt(2)): mantissa >= sqrt(2)'s -> m = 0.5 (1.mant), e += 1 ; f = m - 1 (exact)
    c.get(B).i64(SQRT2_MANT).i64ge_u(); const up = c.if_(T.f64);
    c.get(B).i64(0x3fe0000000000000n).i64or().f64reinterpret_i64().f64c(1).f64sub();
    c.get(E).f64c(1).f64add().set(E);
    c.else_();
    c.get(B).i64(0x3ff0000000000000n).i64or().f64reinterpret_i64().f64c(1).f64sub();
    c.end(); void up;
    c.get(E).get(EXTRA).call(lncore);
    return m.func([T.f64, T.f64], [T.f64], [T.i64, T.f64], c, 'log2core');
  })();

  // ---- log2(x)
  const log2 = (() => {
    const c = new Code();
    const X = 0;
    c.get(X).get(X).f64ne(); const nan = c.if_(); c.get(X).return_(); c.end(); void nan;
    c.get(X).f64c(0).f64le(); const le0 = c.if_();
    c.f64c(-Infinity); indefinite(c); c.get(X).f64c(0).f64eq().select().return_();
    c.end(); void le0;
    c.get(X).f64c(Infinity).f64eq(); const inf = c.if_(); c.f64c(Infinity).return_(); c.end(); void inf;
    c.get(X).f64c(0).call(log2core);
    return m.func([T.f64], [T.f64], [], c, 'log2');
  })();

  // ---- log2p1(x) = log2(1 + x)
  const log2p1 = (() => {
    const c = new Code();
    // params: 0 x ; f64 locals: 1 y, 2 bb, 3 d
    const [X, Y, BB, D] = [0, 1, 2, 3];
    c.get(X).get(X).f64ne(); const nan = c.if_(); c.get(X).return_(); c.end(); void nan;
    c.get(X).f64c(0).f64eq(); const zero = c.if_(); c.get(X).return_(); c.end(); void zero;
    c.get(X).f64c(-1).f64le(); const lem1 = c.if_();
    c.f64c(-Infinity); indefinite(c); c.get(X).f64c(-1).f64eq().select().return_();
    c.end(); void lem1;
    c.get(X).f64c(Infinity).f64eq(); const inf = c.if_(); c.f64c(Infinity).return_(); c.end(); void inf;
    // |x| < 2^-1000: log2(1 + x) = x log2e to within 2^-1000 relative; the exact double-double
    // product of x 2^600 (Veltkamp split, as in lncore) goes through roundTiny so that denormal
    // results are correctly rounded
    c.get(X).f64abs().f64c(TWO_M1000).f64lt(); const tiny = c.if_();
    c.get(X).f64c(TWO_600).f64mul().set(Y);
    c.get(Y).f64c(SPLIT).f64mul().set(D);
    c.get(D).get(D).get(Y).f64sub().f64sub().set(BB); // head
    c.get(BB).f64c(LOG2E_HI).f64mul(); // hi
    c.get(Y).get(BB).f64sub().f64c(LOG2E_HI).f64mul().get(Y).f64c(LOG2E_LO).f64mul().f64add(); // lo = tail LOG2E_HI + y LOG2E_LO
    c.call(roundTiny).return_();
    c.end(); void tiny;
    // series window: f = x itself, e = 0
    c.get(X).f64c(LOG2P1_LO).f64ge().get(X).f64c(LOG2P1_HI).f64le().and(); const direct = c.if_();
    c.get(X).f64c(0).f64c(0).call(lncore).return_();
    c.end(); void direct;
    // y = 1 + x, d = its exact rounding error (TwoSum), extra = d / y * log2e
    c.f64c(1).get(X).f64add().set(Y);
    c.get(Y).f64c(1).f64sub().set(BB);
    c.f64c(1).get(Y).get(BB).f64sub().f64sub().get(X).get(BB).f64sub().f64add().set(D);
    c.get(Y).get(D).get(Y).f64div().f64c(LOG2E).f64mul().call(log2core);
    return m.func([T.f64], [T.f64], [T.f64, T.f64, T.f64], c, 'log2p1');
  })();

  // ---- scalb(a, b): FSCALE, a 2^trunc(b) rounded once
  const scalb = (() => {
    const c = new Code();
    // params: 0 a, 1 b ; i64 locals: 2 e, 3 bits (of a, then sign + mantissa), 4 t (target exponent)
    const [A, B, E, BITS, TT] = [0, 1, 2, 3, 4];
    // NaN propagation: both -> indefinite, else the NaN operand
    c.get(A).get(A).f64ne(); const na = c.if_();
    c.get(A); indefinite(c); c.get(B).get(B).f64eq().select().return_(); // b not NaN ? a : indefinite
    c.end(); void na;
    c.get(B).get(B).f64ne(); const nb = c.if_(); c.get(B).return_(); c.end(); void nb;
    // b infinite
    c.get(B).f64abs().f64c(Infinity).f64eq(); const binf = c.if_();
    c.get(B).f64c(0).f64gt(); const pos = c.if_(T.f64);
    indefinite(c); c.get(A).f64c(Infinity).f64mul().get(A).f64c(0).f64eq().select(); // a == 0 ? indefinite : a * inf
    c.else_();
    indefinite(c); c.get(A).f64c(0).f64mul().get(A).f64abs().f64c(Infinity).f64eq().select(); // finite a ? a * 0 : indefinite
    c.end(); void pos;
    c.return_();
    c.end(); void binf;
    // a = 0 or infinite: unchanged
    c.get(A).f64c(0).f64eq().get(A).f64abs().f64c(Infinity).f64eq().or(); const a0 = c.if_(); c.get(A).return_(); c.end(); void a0;
    // e = trunc(b) clamped to [-2200, 2200] (any finite non-zero a overflows / underflows beyond)
    c.get(B).i64trunc_sat_f64_s().set(E);
    c.get(E).i64(2200n).get(E).i64(2200n).i64lt_s().select().set(E);
    c.get(E).i64(-2200n).get(E).i64(-2200n).i64gt_s().select().set(E);
    // a denormal a is normalized (a 2^54, exact) so that its exponent field is meaningful
    c.get(A).i64reinterpret_f64().set(BITS);
    c.get(BITS).i64(0x7ff0000000000000n).i64and().i64eqz(); const den = c.if_();
    c.get(A).f64c(TWO_54).f64mul().i64reinterpret_f64().set(BITS);
    c.get(E).i64(54n).i64sub().set(E);
    c.end(); void den;
    // t = exponent of the exact result a 2^e = (biased exponent - 1023) + e
    c.get(BITS).i64(52n).i64shr_u().i64(0x7ffn).i64and().i64(1023n).i64sub().get(E).i64add().set(TT);
    c.get(TT).i64(1023n).i64gt_s(); const ovf = c.if_(); c.f64c(Infinity).get(A).f64copysign().return_(); c.end(); void ovf;
    c.get(BITS).i64(0x800fffffffffffffn).i64and().set(BITS); // sign + mantissa
    // normal result: exact, the exponent field is rewritten
    c.get(TT).i64(-1022n).i64ge_s(); const normal = c.if_();
    c.get(BITS).get(TT).i64(1023n).i64add().i64(52n).i64shl().i64or().f64reinterpret_i64().return_();
    c.end(); void normal;
    // denormal or zero result: the mantissa at exponent -1022 (exact) times 2^n, n = max(t + 1022,
    // -1074) (every n below -1074 gives 0 as well); the IEEE product rounds the exact value once
    c.get(BITS).i64(0x0010000000000000n).i64or().f64reinterpret_i64();
    c.get(TT).i64(1022n).i64add().set(TT);
    c.get(TT).i64(-1074n).get(TT).i64(-1074n).i64gt_s().select().set(TT);
    // 2^n: exponent field n + 1023 when n >= -1022, else the denormal bit 1 << (n + 1074)
    c.get(TT).i64(1023n).i64add().i64(52n).i64shl();
    c.i64(1n).get(TT).i64(1074n).i64add().i64shl();
    c.get(TT).i64(-1022n).i64ge_s().select();
    c.f64reinterpret_i64().f64mul();
    return m.func([T.f64, T.f64], [T.f64], [T.i64, T.i64, T.i64], c, 'scalb');
  })();

  return { exp2m1, log2, log2p1, scalb };
}

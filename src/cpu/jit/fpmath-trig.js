// Pure-WebAssembly sine / cosine / tangent kernels for the JIT (FSIN, FCOS, FSINCOS, FPTAN).
// No imports, no memory, no calls into JS (D004): everything lives in locals and immediate
// constants. Constants come from tools/gen_pi_bits.py (pi by Machin's formula in 700-digit
// decimal arithmetic; all derivations are in that script).
//
// Algorithm (all from the definitions):
//   1. Tiny arguments: sin(x) = tan(x) = x for |x| < 2^-26 (the cubic term is below half an
//      ulp), cos(x) = 1 for |x| < 2^-27. Signed zeros follow: sin(-0) = tan(-0) = -0.
//   2. Range reduction x = k pi/2 + r, |r| <= pi/4 (+ an ulp), r as a double-double (rh, rl),
//      q = k mod 4:
//      - |x| < pi/4: r = x.
//      - |x| < 2^20 pi/2 (Cody-Waite): k = nearest(x 2/pi); pi/2 = P1 + P2 + P3 + P4 with P1..P3
//        truncated to 33 bits so k Pi is exact for |k| <= 2^20 (P4 is a full double, k P4 and the
//        tail beyond it are below 2^-131). t = x - k P1 is exact (Sterbenz); each further
//        subtraction is a 2Sum whose exact error is accumulated. A subtraction can only round when
//        its result is above 2^53 lsb(Pi) (below that everything is a multiple of lsb(Pi) that
//        fits in 53 bits), and then the remaining terms are < 2^-33 of it, so no cancellation
//        follows a rounding: (rh, rl) = Fast2Sum(sum, errors) carries ~106 bits.
//      - larger |x| (Payne-Hanek): x = m 2^e (53-bit integer m). Only the bits of 2/pi from
//        position e - 1 on can change m 2^e (2/pi) mod 4 (earlier bits give multiples of 4 m):
//        the kernel takes 256 bits of 2/pi from bit max(0, e - 2) + 1 (five 64-bit words of a
//        24-word table, selected by br_table), multiplies them by m in 32-bit limbs (exact 320-bit
//        product), reads the two integer bits and the top 128 fraction bits at the binary point,
//        rounds to nearest (a fraction >= 1/2 is taken negative, k += 1), normalizes the fraction
//        (leading zeros count, so a fraction near 2^-61 keeps 106 significant bits) and
//        multiplies it by pi/2 in double-double (Dekker product with a pre-split pi/2).
//        Truncation of 2/pi: < 2^-201 of a quadrant; dropped fraction bits: 2^-128.
//   3. sin(r) = rh + (rh r2 P(r2) + rl (1 - r2/2)), r2 = rh^2, P the Taylor series to r^17
//      (truncation 1.1e-19 relative on |r| <= pi/4); the parenthesis is at most 11% of the result.
//      cos(r) = w + (((1 - w) - hz) + (r2^2 Q(r2) - rh rl)), hz = r2/2, w = 1 - hz (exact error
//      recovered by Fast2Sum), Q to r^16 (truncation 2.9e-18 relative).
//   4. Quadrant: sin uses q, cos uses q + 1 (cos x = sin(x + pi/2)): odd q -> cos(r), q & 2 ->
//      negate. tan = sin(r) / cos(r) for even q, -cos(r) / sin(r) for odd q.
//   Error budget (measured in tests/fpmath-trig.test.js): reduction ~2^-100 relative, sin/cos
//   about 1.5 * 2^-53 worst case (final rounding plus the small term's evaluation), tan up to
//   ~3 * 2^-53 (quotient of two rounded values plus the division).
//   Domain: any finite x (also above 2^63: the x87 caller still reports C2 there); inf / NaN do
//   not trap (NaN propagates through the Cody-Waite path, inf gives an arbitrary finite value).
import { Code, T } from './wasm.js';

/** Bits of 2/pi: word i holds bits 64 i + 1 .. 64 i + 64 after the binary point (tools/gen_pi_bits.py). */
export const TWO_OVER_PI_WORDS = Object.freeze([
  0xa2f9836e4e441529n, 0xfc2757d1f534ddc0n, 0xdb6295993c439041n, 0xfe5163abdebbc561n,
  0xb7246e3a424dd2e0n, 0x06492eea09d1921cn, 0xfe1deb1cb129a73en, 0xe88235f52ebb4484n,
  0xe99c7026b45f7e41n, 0x3991d639835339f4n, 0x9c845f8bbdf9283bn, 0x1ff897ffde05980fn,
  0xef2f118b5a0a6d1fn, 0x6d367ecf27cb09b7n, 0x4f463f669e5fea2dn, 0x7527bac7ebe5f17bn,
  0x3d0739f78a5292ean, 0x6bfb5fb11f8d5d08n, 0x56033046fc7b6babn, 0xf0cfbc209af4361dn,
  0xa9e391615ee61b08n, 0x6599855f14a06840n, 0x8dffd8804d732731n, 0x06061556ca73a8c9n,
]);
/** pi/2 = P1 + P2 + P3 + P4, P1..P3 with 33 significant bits (k Pi exact for |k| <= 2^20). */
export const PIO2_PIECES = Object.freeze([1.5707963267341256, 6.077100506303966e-11, 2.0222662487111665e-21, 8.4784276603689e-32]);
export const PIO2_HI = 1.5707963267948966, PIO2_LO = 6.123233995736766e-17;
export const INV_PIO2 = 0.6366197723675814;
export const PIO4 = 0.7853981633974483;
/** Cody-Waite limit: 2^20 pi/2 rounded down, so nearest(x 2/pi) <= 2^20 below it. */
export const CW_LIMIT = 1647099.0;
/** Taylor coefficients: sin r = r + r^3 P(r^2), P(z) = sum_{j=0..7} (-1)^(j+1) z^j / (2j+3)! */
export const SIN_POLY = Object.freeze([-0.16666666666666666, 0.008333333333333333, -0.0001984126984126984, 2.7557319223985893e-06, -2.505210838544172e-08, 1.6059043836821613e-10, -7.647163731819816e-13, 2.8114572543455206e-15]);
/** cos r = 1 - r^2/2 + r^4 Q(r^2), Q(z) = sum_{j=0..6} (-1)^j z^j / (2j+4)! */
export const COS_POLY = Object.freeze([0.041666666666666664, -0.001388888888888889, 2.48015873015873e-05, -2.755731922398589e-07, 2.08767569878681e-09, -1.1470745597729725e-11, 4.779477332387385e-14]);

/** Below these |x|, sin(x) = tan(x) = x and cos(x) = 1 exactly (the kernels return at once). */
export const TINY_SIN = 2 ** -26, TINY_COS = 2 ** -27;
const MASK32 = 0xffffffffn;

/** Veltkamp split of PIO2_HI into two 26-bit halves (exact partial products in Dekker's product). */
const SPLIT = 134217729; // 2^27 + 1
const PIO2_B1 = (() => { const t = PIO2_HI * SPLIT; return t - (t - PIO2_HI); })();
const PIO2_B2 = PIO2_HI - PIO2_B1;

/**
 * Emit sin(r) for r = rh + rl (|r| <= ~pi/4) onto the stack. Locals: RH, RL, Z (= rh^2, set).
 * Also used by the translator's inline FSIN / FCOS fast path (|x| < pi/4, where the reduction is
 * the identity (x, +0, quadrant 0)), which therefore gives the kernel's bits.
 * @param {Code} c
 */
export function emitSinPoly(c, RH, RL, Z) {
  c.get(RH);
  c.get(RH).get(Z).f64mul();
  c.f64c(SIN_POLY[SIN_POLY.length - 1]);
  for (let j = SIN_POLY.length - 2; j >= 0; j--) c.get(Z).f64mul().f64c(SIN_POLY[j]).f64add();
  c.f64mul(); // (rh z) P(z)
  c.get(RL).f64c(1).get(Z).f64c(0.5).f64mul().f64sub().f64mul().f64add(); // + rl (1 - z/2)
  c.f64add();
}

/**
 * Emit cos(r) for r = rh + rl onto the stack. Locals: RH, RL, Z (set), HZ and W (scratch f64).
 * @param {Code} c
 */
export function emitCosPoly(c, RH, RL, Z, HZ, W) {
  c.get(Z).f64c(0.5).f64mul().set(HZ);
  c.f64c(1).get(HZ).f64sub().set(W);
  c.get(W);
  c.f64c(1).get(W).f64sub().get(HZ).f64sub(); // exact error of 1 - hz
  c.get(Z).get(Z).f64mul();
  c.f64c(COS_POLY[COS_POLY.length - 1]);
  for (let j = COS_POLY.length - 2; j >= 0; j--) c.get(Z).f64mul().f64c(COS_POLY[j]).f64add();
  c.f64mul(); // z^2 Q(z)
  c.get(RH).get(RL).f64mul().f64sub(); // - rh rl
  c.f64add();
  c.f64add();
}

/**
 * Emit the quadrant selection: value = (q & 1 ? cos(r) : sin(r)), negated when q & 2.
 * Locals: RH, RL, Z, HZ, W (f64), Q (i32 holding the quadrant to use), V (f64 scratch).
 * @param {Code} c
 */
function emitSinCosQ(c, RH, RL, Z, HZ, W, Q, V) {
  c.get(RH).get(RH).f64mul().set(Z);
  c.get(Q).i32(1).and(); const odd = c.if_(T.f64);
  emitCosPoly(c, RH, RL, Z, HZ, W);
  c.else_();
  emitSinPoly(c, RH, RL, Z);
  c.end(); void odd;
  c.set(V);
  c.get(V).f64neg().get(V).get(Q).i32(2).and().select();
}

/**
 * Define the trigonometric kernels in a module under construction. Nothing is exported; the
 * caller decides (m.exportFunc) or calls them by index.
 * @param {import('./wasm.js').ModuleBuilder} m
 * @returns {{ sin: number, cos: number, tan: number, sincos: number, reduce: number, reduce3: number, reduceLarge: number }}
 *   sin(x: f64) -> f64, cos(x: f64) -> f64, tan(x: f64) -> f64 for any finite x (see header);
 *   sincos(x: f64) -> (sin x: f64, cos x: f64): both from one reduction, bit-identical to sin/cos;
 *   reduce(x: f64) -> f64: the reduced argument r = x - k pi/2 rounded to a double (debugging);
 *   reduce3(x: f64) -> (rh: f64, rl: f64, q: i32): full reduction, r = rh + rl, q = k mod 4;
 *   reduceLarge(x: f64) -> (rh, rl, q): the Payne-Hanek path alone (any |x| >= 2^20, testing).
 */
export function addTrigKernels(m) {
  // ---- reduceLarge(x) -> (rh, rl, q): Payne-Hanek
  const reduceLarge = (() => {
    const c = new Code();
    // param 0 X (f64); i64 locals 1..: BITS, M, MLO, MHI, CARRY, ACC, SUM, L0..L7, P0..P9, Q0..Q4,
    // T0..T3, R0..R2, FH, FL, HI, LO, W0..W4; i32: E, OFF, S, BS, LZ, SIGN, QQ; f64: FHD, FLD, P,
    // A1, A2, RL, RH, SC
    let n = 1;
    const i64s = [], i32s = [], f64s = [];
    const I64 = () => { i64s.push(T.i64); return n++; };
    const BITS = I64(), M = I64(), MLO = I64(), MHI = I64(), CARRY = I64(), ACC = I64(), SUM = I64();
    const L = Array.from({ length: 8 }, I64), P = Array.from({ length: 10 }, I64), Q = Array.from({ length: 5 }, I64);
    const TT = Array.from({ length: 4 }, I64), R = Array.from({ length: 3 }, I64);
    const FH = I64(), FL = I64(), HI = I64(), LO = I64(), W = Array.from({ length: 5 }, I64);
    const I32 = () => { i32s.push(T.i32); return n++; };
    const E = I32(), OFF = I32(), S = I32(), BS = I32(), LZ = I32(), SIGN = I32(), QQ = I32();
    const F64 = () => { f64s.push(T.f64); return n++; };
    const FHD = F64(), FLD = F64(), PP = F64(), A1 = F64(), A2 = F64(), RL = F64(), RH = F64(), SC = F64();
    const X = 0;

    c.get(X).f64abs().i64reinterpret_f64().set(BITS);
    c.get(BITS).i64(52).i64shr_u().wrap().i32(1075).sub().set(E); // x = m 2^e
    c.get(BITS).i64(0xfffffffffffffn).i64and().i64(0x10000000000000n).i64or().set(M);
    c.get(M).i64(MASK32).i64and().set(MLO);
    c.get(M).i64(32).i64shr_u().set(MHI);
    // off = max(0, e - 2): bits of 2/pi at positions <= off contribute multiples of 4
    c.get(E).i32(2).sub().i32(0).get(E).i32(2).gt_s().select().set(OFF);
    // W0..W4 = table words off >> 6 .. off >> 6 + 4 (br_table; out of range -> zeros, no trap)
    {
      const NW = TWO_OVER_PI_WORDS.length - 4; // 20 starting indices
      const done = c.block();
      const def = c.block();
      const labels = [];
      for (let i = 0; i < NW; i++) labels.push(c.block());
      c.get(OFF).i32(6).shr_u().br_table(labels, def);
      for (let i = 0; i < NW; i++) {
        c.end(); // innermost remaining = labels[NW - 1 - i] -> case wi = NW - 1 - i
        const wi = NW - 1 - i;
        for (let j = 0; j < 5; j++) c.i64(TWO_OVER_PI_WORDS[wi + j]).set(W[j]);
        c.br(done);
      }
      c.end(); void def; // default: zeros
      for (let j = 0; j < 5; j++) c.i64(0).set(W[j]);
      c.end(); void done;
    }
    // bit shift within the words: B_i = (W_i << bs) | ((W_{i+1} >> 1) >> (63 - bs)), bs = off & 63;
    // limbs L7 (most significant) .. L0 of the 256-bit B
    c.get(OFF).i32(63).and().set(BS);
    for (let i = 0; i < 4; i++) {
      c.get(W[i]).get(BS).extend_u().i64shl().get(W[i + 1]).i64(1).i64shr_u().i32(63).get(BS).sub().extend_u().i64shr_u().i64or().set(ACC);
      c.get(ACC).i64(32).i64shr_u().set(L[7 - 2 * i]);
      c.get(ACC).i64(MASK32).i64and().set(L[6 - 2 * i]);
    }
    // product m * B in 32-bit limbs P0..P9 (each column: mlo L_i split in halves so no i64 overflow)
    c.i64(0).set(CARRY);
    for (let i = 0; i < 10; i++) {
      if (i <= 7) c.get(MLO).get(L[i]).i64mul().set(ACC); else c.i64(0).set(ACC);
      c.get(ACC).i64(MASK32).i64and();
      if (i >= 1 && i <= 8) c.get(MHI).get(L[i - 1]).i64mul().i64add();
      c.get(CARRY).i64add().set(SUM);
      c.get(SUM).i64(MASK32).i64and().set(P[i]);
      c.get(SUM).i64(32).i64shr_u().get(ACC).i64(32).i64shr_u().i64add().set(CARRY);
    }
    for (let j = 0; j < 5; j++) c.get(P[2 * j]).get(P[2 * j + 1]).i64(32).i64shl().i64or().set(Q[j]);
    // binary point of m 2^e (2/pi) mod 4 in the product: bit sh = 256 - min(e, 2); the window
    // [s, s + 192) with s = sh - 128 in [126, 160] holds the 128 fraction bits then the 2 integer bits
    c.i32(128).get(E).i32(2).get(E).i32(2).lt_s().select().sub().set(S);
    c.get(S).i32(63).and().set(BS);
    for (let j = 0; j < 4; j++) { // T_j = (s >> 6 == 1) ? Q_{j+1} : Q_{j+2}
      c.get(Q[j + 1]);
      if (j + 2 <= 4) c.get(Q[j + 2]); else c.i64(0);
      c.get(S).i32(6).shr_u().i32(1).eq().select().set(TT[j]);
    }
    for (let j = 0; j < 3; j++) { // R_j = (T_j >> bs) | ((T_{j+1} << 1) << (63 - bs))
      c.get(TT[j]).get(BS).extend_u().i64shr_u().get(TT[j + 1]).i64(1).i64shl().i32(63).get(BS).sub().extend_u().i64shl().i64or().set(R[j]);
    }
    // q = integer bits + (fraction >= 1/2); fraction as signed 128-bit (FH:FL) in [-1/2, 1/2)
    c.get(R[2]).wrap().i32(3).and().get(R[1]).i64(0).i64lt_s().add().set(QQ);
    c.get(R[1]).set(FH);
    c.get(R[0]).set(FL);
    c.get(X).f64c(0).f64lt().set(SIGN);
    c.get(FH).i64(0).i64lt_s(); const neg = c.if_();
    c.i64(0).get(FH).i64sub().get(FL).i64(0).i64ne().extend_u().i64sub().set(FH);
    c.i64(0).get(FL).i64sub().set(FL);
    c.get(SIGN).i32(1).xor().set(SIGN);
    c.end(); void neg;
    // x < 0: k -> -k
    c.i32(0).get(QQ).sub().get(QQ).get(X).f64c(0).f64lt().select().i32(3).and().set(QQ);
    // normalize |fraction| : lz leading zeros, (HI:LO) = |fraction| << lz
    c.get(FH).i64eqz(); const z = c.if_(T.i32); c.get(FL).i64clz().wrap().i32(64).add(); c.else_(); c.get(FH).i64clz().wrap(); c.end(); void z;
    c.set(LZ);
    c.get(LZ).i32(64).lt_u(); const small = c.if_();
    c.get(FH).get(LZ).extend_u().i64shl().get(FL).i64(1).i64shr_u().i32(63).get(LZ).sub().extend_u().i64shr_u().i64or().set(HI);
    c.get(FL).get(LZ).extend_u().i64shl().set(LO);
    c.else_();
    c.get(FL).get(LZ).i32(64).sub().extend_u().i64shl().set(HI);
    c.i64(0).set(LO);
    c.end(); void small;
    // f = (fhd + fld) 2^-lz, fhd = top 53 bits in [1/2, 1), fld = next 53 bits (both exact)
    c.get(HI).i64(11).i64shr_u().f64convert_i64_s().f64c(2 ** -53).f64mul().set(FHD);
    c.get(HI).i64(0x7ffn).i64and().i64(42).i64shl().get(LO).i64(22).i64shr_u().i64or().f64convert_i64_s().f64c(2 ** -106).f64mul().set(FLD);
    // r = f pi/2 in double-double: Dekker product fhd * PIO2_HI with exact error
    c.get(FHD).f64c(PIO2_HI).f64mul().set(PP);
    c.get(FHD).f64c(SPLIT).f64mul().set(A1);
    c.get(A1).get(A1).get(FHD).f64sub().f64sub().set(A1);
    c.get(FHD).get(A1).f64sub().set(A2);
    c.get(A1).f64c(PIO2_B1).f64mul().get(PP).f64sub().get(A1).f64c(PIO2_B2).f64mul().f64add().get(A2).f64c(PIO2_B1).f64mul().f64add().get(A2).f64c(PIO2_B2).f64mul().f64add();
    c.get(FHD).f64c(PIO2_LO).f64mul().f64add().get(FLD).f64c(PIO2_HI).f64mul().f64add().set(RL);
    c.get(PP).get(RL).f64add().set(RH);
    c.get(RL).get(RH).get(PP).f64sub().f64sub().set(RL);
    // scale by 2^-lz (exact) and apply the sign
    c.i32(1023).get(LZ).sub().extend_u().i64(52).i64shl().f64reinterpret_i64().set(SC);
    c.get(RH).get(SC).f64mul().set(RH);
    c.get(RL).get(SC).f64mul().set(RL);
    c.get(RH).f64neg().get(RH).get(SIGN).select();
    c.get(RL).f64neg().get(RL).get(SIGN).select();
    c.get(QQ);
    return m.func([T.f64], [T.f64, T.f64, T.i32], [...i64s, ...i32s, ...f64s], c, 'trig_reduce_large');
  })();

  // ---- reduce3(x) -> (rh, rl, q)
  const reduce3 = (() => {
    const c = new Code();
    const [X, AX, KF, S, W, SUM, BB, E, RH, K] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    c.get(X).f64abs().set(AX);
    c.get(AX).f64c(PIO4).f64lt(); const small = c.if_(); c.get(X).f64c(0).i32(0).return_(); c.end(); void small;
    c.get(AX).f64c(CW_LIMIT).f64ge(); const large = c.if_(); c.get(X).call(reduceLarge).return_(); c.end(); void large;
    // Cody-Waite: k = nearest(x 2/pi), s = x - k P1 (exact), then 2Sum steps accumulating errors
    c.get(X).f64c(INV_PIO2).f64mul().f64nearest().tee(KF).i32trunc_sat_f64_s().set(K);
    c.get(X).get(KF).f64c(PIO2_PIECES[0]).f64mul().f64sub().set(S);
    c.f64c(0).set(E);
    for (let i = 1; i < PIO2_PIECES.length; i++) {
      c.get(KF).f64c(PIO2_PIECES[i]).f64mul().set(W);
      c.get(S).get(W).f64sub().set(SUM);
      c.get(SUM).get(S).f64sub().set(BB);
      // err = (s - (sum - bb)) - (w + bb)  (2Sum of s and -w)
      c.get(S).get(SUM).get(BB).f64sub().f64sub().get(W).get(BB).f64add().f64sub().get(E).f64add().set(E);
      c.get(SUM).set(S);
    }
    c.get(S).get(E).f64add().set(RH);
    c.get(RH);
    c.get(E).get(RH).get(S).f64sub().f64sub();
    c.get(K).i32(3).and();
    return m.func([T.f64], [T.f64, T.f64, T.i32], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.i32], c, 'trig_reduce');
  })();

  // ---- reduce(x) -> rh
  const reduce = (() => {
    const c = new Code();
    c.get(0).call(reduce3).drop().drop();
    return m.func([T.f64], [T.f64], [], c, 'trig_reduce_f64');
  })();

  // ---- sin(x) / cos(x)
  const sinCos = (isCos) => {
    const c = new Code();
    const [X, RH, RL, Z, HZ, W, V, Q] = [0, 1, 2, 3, 4, 5, 6, 7];
    c.get(X).f64abs().f64c(isCos ? TINY_COS : TINY_SIN).f64lt(); const tiny = c.if_();
    if (isCos) c.f64c(1).return_(); else c.get(X).return_();
    c.end(); void tiny;
    c.get(X).call(reduce3);
    if (isCos) c.i32(1).add();
    c.set(Q).set(RL).set(RH);
    emitSinCosQ(c, RH, RL, Z, HZ, W, Q, V);
    return m.func([T.f64], [T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.i32], c, isCos ? 'cos' : 'sin');
  };
  const sin = sinCos(false);
  const cos = sinCos(true);

  // ---- tan(x)
  const tan = (() => {
    const c = new Code();
    const [X, RH, RL, Z, HZ, W, SN, CS, Q] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    c.get(X).f64abs().f64c(TINY_SIN).f64lt(); const tiny = c.if_(); c.get(X).return_(); c.end(); void tiny;
    c.get(X).call(reduce3).set(Q).set(RL).set(RH);
    c.get(RH).get(RH).f64mul().set(Z);
    emitSinPoly(c, RH, RL, Z); c.set(SN);
    emitCosPoly(c, RH, RL, Z, HZ, W); c.set(CS);
    c.get(Q).i32(1).and(); const odd = c.if_(T.f64);
    c.get(CS).f64neg().get(SN).f64div();
    c.else_();
    c.get(SN).get(CS).f64div();
    c.end(); void odd;
    return m.func([T.f64], [T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.i32], c, 'tan');
  })();

  // ---- sincos(x) -> (sin x, cos x): one reduction for FSINCOS. Bit-identical to sin and cos:
  // same tiny threshold as cos (sin(x) = x holds below 2^-26, so below 2^-27 too; between the
  // two the sine polynomial gives back x exactly), same reduction, same polynomials, and the
  // quadrant selection of each (q for the sine, q + 1 for the cosine).
  const sincos = (() => {
    const c = new Code();
    const [X, RH, RL, Z, HZ, W, SN, CS, V, Q] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    c.get(X).f64abs().f64c(TINY_COS).f64lt(); const tiny = c.if_(); c.get(X).f64c(1).return_(); c.end(); void tiny;
    c.get(X).call(reduce3).set(Q).set(RL).set(RH);
    c.get(RH).get(RH).f64mul().set(Z);
    emitSinPoly(c, RH, RL, Z); c.set(SN);
    emitCosPoly(c, RH, RL, Z, HZ, W); c.set(CS);
    // sin x = (q & 1 ? cos r : sin r), negated when q & 2
    c.get(CS).get(SN).get(Q).i32(1).and().select().set(V);
    c.get(V).f64neg().get(V).get(Q).i32(2).and().select();
    // cos x = sin(x + pi/2): quadrant q + 1
    c.get(SN).get(CS).get(Q).i32(1).and().select().set(V);
    c.get(V).f64neg().get(V).get(Q).i32(1).add().i32(2).and().select();
    return m.func([T.f64], [T.f64, T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.f64, T.i32], c, 'sincos');
  })();

  return { sin, cos, tan, sincos, reduce, reduce3, reduceLarge };
}

// 80-bit extended memory operands for the JIT: inline WebAssembly for FLD m80 / FSTP m80 and the register images of
// FNSAVE / FRSTOR (translate-x87.js), which used to leave translated code for the interpreter (an exit costing
// ~0.3 us for an FLD m80, ~0.5 us for an FNSAVE, mostly the interpreter's BigInt conversions). Inline rather than
// runtime kernels: a call from region code costs ~6 ns by itself (measured with an empty kernel), 16 of them for an
// FNSAVE/FRSTOR pair. The conversions are the interpreter's (interp-x87.js readF80 / writeF80) operation for
// operation, so both executors agree bit for bit:
//   load: the 64-bit significand converted to f64 (round to nearest even, as Number(BigInt) does) then scaled by
//     2^(exp - 16446) in the same steps (a factor 2^+-1000 while the exponent is out of [-1000, 1000], then one exact
//     power of two), so the double rounding of results in the f64 denormal range is reproduced; infinity when the
//     exponent is all ones and the 63 fraction bits are zero (the integer bit ignored); a NaN keeps its sign and the
//     top 52 fraction bits (quiet bit included), a NaN whose payload is only in the low 11 bits becoming the quiet
//     NaN of that sign.
//   store: exact (f64 denormals normalized, infinities and NaNs with their sign, quiet bit and payload).
import { T } from './wasm.js';

const FRAC = 0x000fffffffffffffn, QUIET = 0x0008000000000000n;
/** biased extended exponent of 2^0 for a 64-bit integer significand: value = mant * 2^(exp - BIAS64) */
const BIAS64 = 16383 + 63;

/**
 * Push the f64 value of the extended operand at local `a` + `off` (the interpreter's readF80).
 * @param {import('./wasm.js').Code} c
 * @param {number} a i32 local holding the address
 * @param {number} off constant offset
 * @param {{ m: number, se: number, e: number, r: number }} L scratch locals: i64, i32, i32, f64
 */
export function emitF80Load(c, a, off, L) {
  const neg = () => c.get(L.se).i32(0x8000).and();
  const out = c.block(T.f64);
  c.get(a).i64load(off, 0).set(L.m);
  c.get(a).i32load16u(off + 8).set(L.se);
  c.get(L.se).i32(0x7fff).and().tee(L.e).i32(0x7fff).eq();
  const special = c.hint(false).if_();
  {
    // infinity (the 63 fraction bits zero) or NaN (sign, top 52 fraction bits; low bits only: the quiet NaN)
    c.get(L.m).i64(0x7fffffffffffffffn).i64and().i64eqz().set(L.e);
    c.get(L.m).i64(11n).i64shr_u().i64(FRAC).i64and().set(L.m);
    c.f64c(-Infinity).f64c(Infinity); neg(); c.select();
    c.i64(QUIET).get(L.m).get(L.m).i64eqz().select();
    c.i64(-0x10000000000000n).i64(0x7ff0000000000000n); neg(); c.select().i64or().f64reinterpret_i64();
    c.get(L.e).select().br(out);
  }
  c.end(); void special;
  // Far out of the f64 range the result is known (the interpreter's scaling loop would take up to 16 steps):
  // e < -2000: the second factor 2^-1000 brings any r < 2^64 below 2^-1936, rounded to 0 (the first product is
  // exact) -> +-0 ; e > 2000: r = 0 stays 0, any r >= 1 overflows at the second factor 2^1000 -> +-inf.
  c.get(L.e).i32(BIAS64 - 2000).lt_u();
  const tiny = c.hint(false).if_(); c.f64c(-0).f64c(0); neg(); c.select().br(out); c.end(); void tiny;
  c.get(L.e).i32(BIAS64 + 2000).gt_u();
  const huge = c.hint(false).if_();
  c.f64c(-0).f64c(0); neg(); c.select();
  c.f64c(-Infinity).f64c(Infinity); neg(); c.select();
  c.get(L.m).i64eqz().select().br(out);
  c.end(); void huge;
  c.get(L.m).f64convert_i64_u().set(L.r);
  c.get(L.e).i32(BIAS64).sub().set(L.e); // now in [-2000, 2000]: one step of the interpreter's loops at most
  for (const lim of [1000, -1000]) {
    c.get(L.e).i32(lim); if (lim > 0) c.gt_s(); else c.lt_s();
    const step = c.hint(false).if_();
    c.get(L.r).f64c(2 ** lim).f64mul().set(L.r);
    c.get(L.e).i32(-lim).add().set(L.e);
    c.end(); void step;
  }
  // r * 2^e (e in [-1000, 1000]: a normal power of two, exact), then the sign (sign * value: -0 for a zero)
  c.get(L.r).get(L.e).i32(1023).add().extend_u().i64(52n).i64shl().f64reinterpret_i64().f64mul().set(L.r);
  c.get(L.r).f64neg().get(L.r); neg(); c.select();
  c.end(); void out;
}

/**
 * Store f64 local `v` as an extended value at local `a` + `off` (the interpreter's writeF80).
 * @param {import('./wasm.js').Code} c
 * @param {number} a i32 local holding the address
 * @param {number} off constant offset
 * @param {number} v f64 local
 * @param {{ b: number, exp: number, sg: number }} L scratch locals: i64, i32, i32
 */
export function emitF80Store(c, a, off, v, L) {
  const out = c.block();
  c.get(v).i64reinterpret_f64().set(L.b);
  c.get(L.b).i64(48n).i64shr_u().wrap().i32(0x8000).and().set(L.sg);
  c.get(L.b).i64(52n).i64shr_u().wrap().i32(0x7ff).and().set(L.exp);
  c.get(L.b).i64(FRAC).i64and().set(L.b); // the 52 fraction bits from here on
  c.get(L.exp).eqz();
  const low = c.hint(false).if_();
  {
    // zero: significand 0, exponent 0 ; f64 denormal: normalized (integer bit at 63), exponent 15372 - clz
    c.get(L.b).i64eqz();
    const z = c.if_(); c.get(a).i64(0n).i64store(off, 0); c.get(a).get(L.sg).i32store16(off + 8); c.br(out); c.end(); void z;
    c.get(L.b).i64clz().wrap().set(L.exp);
    c.get(a).get(L.b).get(L.exp).extend_u().i64shl().i64store(off, 0);
    c.get(a).get(L.sg).i32(15372).get(L.exp).sub().or().i32store16(off + 8);
    c.br(out);
  }
  c.end(); void low;
  c.get(a).get(L.b).i64(11n).i64shl().i64(-0x8000000000000000n).i64or().i64store(off, 0);
  c.get(a).get(L.sg).i32(0x7fff).get(L.exp).i32(16383 - 1023).add().get(L.exp).i32(0x7ff).eq().select().or().i32store16(off + 8);
  c.end(); void out;
}

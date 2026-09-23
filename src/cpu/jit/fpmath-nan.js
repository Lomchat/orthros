// x87 NaN-operand rule for the JIT's transcendental handlers (translate-x87.js), in pure
// WebAssembly like the other kernels (no imports, no calls into JS, D004). The rule is the SDM's
// x87 table (4.8.3.5) as measured on the reference hardware (tools/gen/verify_trans_probe.py,
// AMD EPYC 7402P, DECISIONS D034):
//   - an SNaN operand raises IE and the result is that NaN quieted (sign and payload kept);
//   - a QNaN operand propagates unchanged (sign and payload kept), no exception;
//   - with two NaN operands the one with the larger significand (the 52-bit fraction, quiet bit
//     included, so a QNaN always beats an SNaN) wins; on a tie the positive one; its sign is kept;
//   - without any NaN operand the operation was an invalid arithmetic operand (0 log2 0,
//     inf * 0, 0 * 2^inf...): IE and the indefinite (negative QNaN, 0xFFF8000000000000).
// The handlers call it only on the rare path where the kernel's result is a NaN, so the hot path
// costs one comparison; a unary instruction passes its operand twice.
import { Code, T } from './wasm.js';
import { INDEFINITE_BITS } from './fpmath-exp.js';

const QUIET = 0x0008000000000000n, FRAC = 0x000fffffffffffffn;

/**
 * Define the kernel in a module under construction (nothing exported; the caller decides).
 * @param {import('./wasm.js').ModuleBuilder} m
 * @returns {{ nan2: number }} function index:
 *   nan2(a: f64, b: f64) -> (f64 result, i32 ie): the x87 result of an operation on a and b of
 *     which at least one is a NaN (else the indefinite), and whether IE must be raised.
 */
export function addNanKernels(m) {
  const c = new Code();
  // params: 0 a, 1 b ; i64 locals: 2 ab, 3 bb, 4 r ; i32 locals: 5 an, 6 bn
  const [A, B, AB, BB, R, AN, BN] = [0, 1, 2, 3, 4, 5, 6];
  c.get(A).get(A).f64ne().set(AN);
  c.get(B).get(B).f64ne().set(BN);
  // no NaN operand: invalid arithmetic operand -> (indefinite, IE)
  c.get(AN).get(BN).or().eqz(); const none = c.if_(); c.i64(INDEFINITE_BITS).f64reinterpret_i64().i32(1).return_(); c.end(); void none;
  c.get(A).i64reinterpret_f64().set(AB);
  c.get(B).i64reinterpret_f64().set(BB);
  // r = a wins ? ab : bb ; a wins when it is the only NaN, or has the larger significand, or the
  // same significand and a clear sign bit (equal significands of the same sign: identical bits)
  c.get(AB).get(BB);
  c.get(BN).eqz();
  c.get(AB).i64(FRAC).i64and().get(BB).i64(FRAC).i64and().i64gt_u(); c.or();
  c.get(AB).i64(FRAC).i64and().get(BB).i64(FRAC).i64and().i64eq().get(AB).i64(0n).i64ge_s().and(); c.or();
  c.get(AN).and();
  c.select().set(R);
  // result quieted ; ie = an SNaN among the NaN operands
  c.get(R).i64(QUIET).i64or().f64reinterpret_i64();
  c.get(AN).get(AB).i64(QUIET).i64and().i64eqz().and();
  c.get(BN).get(BB).i64(QUIET).i64and().i64eqz().and(); c.or();
  const nan2 = m.func([T.f64, T.f64], [T.f64, T.i32], [T.i64, T.i64, T.i64, T.i32, T.i32], c, 'nan2');
  return { nan2 };
}

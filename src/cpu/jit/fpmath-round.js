// Exact x87 rounding for the JIT, in pure WebAssembly like the other runtime kernels (D004): the
// same semantics as the interpreter (interp-x87.js arith/round/toF32), so both executors agree
// bit for bit.
//   arith24(a, b, op, rc) -> f64: the result of a two-operand x87 operation (op: 0 add, 1 mul,
//     4 sub, 5 subr, 6 div, 7 divr, 8 sqrt of a) rounded to a 24-bit significand (precision
//     control 24 bits, extended exponent range) with rounding mode rc (0 nearest, 1 down, 2 up,
//     3 toward zero). The f64 operation is itself rounded to nearest; its exact error term
//     (error-free transformations: TwoSum, Dekker's TwoProduct, exact remainders for division and
//     square root) decides the two cases a plain re-rounding gets wrong: an f64 result on the
//     24-bit grid under directed rounding, and an f64 result on a 24-bit midpoint.
//   f32rc(x, rc) -> f32: what FST/FSTP m32 writes under rounding mode rc, including the float
//     denormal range (granularity 2^-149) and overflow (infinity or the largest float per rc).
// The region code takes these slow paths only when they matter (directed rounding, results off the
// normal float range, or exactly on a 24-bit midpoint); round-to-nearest stays inline.
import { Code, T } from './wasm.js';

const LOW29 = 0x1fffffffn, HALF29 = 0x10000000n, ULP24 = 0x20000000n;
const TWO_54 = 2 ** 54, TWO_M54 = 2 ** -54, DBL_MIN = 2 ** -1022;
const FLT_MIN = 1.1754943508222875e-38, FLT_MAX = 3.4028234663852886e38, FLT_DENORM = 2 ** -149;
const SPLIT = 134217729; // 2^27 + 1 (Veltkamp)

/**
 * @param {import('./wasm.js').ModuleBuilder} m
 * @returns {{ arith24: number, f32rc: number }} function indices (not exported; the caller decides)
 */
export function addRoundKernels(m) {
  // ---- twoSumErr(x, y, s) -> exact (x + y) - s for s = fl(x + y) (0 when s is not finite)
  let twoSum;
  {
    const c = new Code();
    const [X, Y, S, BB] = [0, 1, 2, 3];
    c.get(S).get(S).f64sub().f64c(0).f64eq().eqz(); const nf = c.if_(); c.f64c(0).return_(); c.end(); void nf; // inf/nan: s - s is nan
    c.get(S).get(X).f64sub().set(BB);
    c.get(X).get(S).get(BB).f64sub().f64sub().get(Y).get(BB).f64sub().f64add();
    twoSum = m.func([T.f64, T.f64, T.f64], [T.f64], [T.f64], c, 'twoSumErr');
  }
  // ---- twoProdErr(x, y, p) -> exact x * y - p for p = fl(x * y) (0 when p is 0 / not finite or splitting would overflow)
  let twoProd;
  {
    const c = new Code();
    const [X, Y, P, AH, AL, BH, BL, TT] = [0, 1, 2, 3, 4, 5, 6, 7];
    c.get(P).f64c(0).f64eq().get(P).get(P).f64sub().f64c(0).f64eq().eqz().or(); const z = c.if_(); c.f64c(0).return_(); c.end(); void z;
    const range = (v) => { c.get(v).f64abs().f64c(2 ** 500).f64gt().get(v).f64abs().f64c(2 ** -500).f64lt().or(); };
    range(X); range(Y); c.or(); const r = c.if_(); c.f64c(0).return_(); c.end(); void r;
    c.f64c(SPLIT).get(X).f64mul().set(TT); c.get(TT).get(TT).get(X).f64sub().f64sub().set(AH); c.get(X).get(AH).f64sub().set(AL);
    c.f64c(SPLIT).get(Y).f64mul().set(TT); c.get(TT).get(TT).get(Y).f64sub().f64sub().set(BH); c.get(Y).get(BH).f64sub().set(BL);
    // ((ah*bh - p) + ah*bl + al*bh) + al*bl
    c.get(AH).get(BH).f64mul().get(P).f64sub().get(AH).get(BL).f64mul().f64add().get(AL).get(BH).f64mul().f64add().get(AL).get(BL).f64mul().f64add();
    twoProd = m.func([T.f64, T.f64, T.f64], [T.f64], [T.f64, T.f64, T.f64, T.f64, T.f64], c, 'twoProdErr');
  }
  // ---- divErr(x, y, q) -> a value with the sign of x / y - q (0 when q is exact, 0 or not finite)
  let divErr;
  {
    const c = new Code();
    const [X, Y, Q, P, E] = [0, 1, 2, 3, 4];
    const bad = (v) => { c.get(v).get(v).f64sub().f64c(0).f64eq().eqz(); };
    c.get(Q).f64c(0).f64eq(); bad(Q); c.or(); bad(X); c.or(); bad(Y); c.or(); const z = c.if_(); c.f64c(0).return_(); c.end(); void z;
    c.get(Q).get(Y).f64mul().set(P);
    c.get(X).get(P).f64sub().get(Q).get(Y).get(P).call(twoProd).f64sub().set(E); // x - q*y exactly
    c.get(Y).f64c(0).f64gt(); const pos = c.if_(T.f64); c.get(E); c.else_(); c.get(E).f64neg(); c.end(); void pos;
    divErr = m.func([T.f64, T.f64, T.f64], [T.f64], [T.f64, T.f64], c, 'divErr');
  }
  // ---- rnd24(r, rc, es) -> r rounded to a 24-bit significand; es: sign of (exact - r)
  let rnd24;
  {
    const c = new Code();
    const [R, RC, ES, BITS, LOW, NEG, DEN, INC, DEC] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    // zero, infinities, NaNs unchanged
    c.get(R).f64c(0).f64eq().get(R).get(R).f64sub().f64c(0).f64eq().eqz().or(); const pass = c.if_(); c.get(R).return_(); c.end(); void pass;
    // f64 denormals are normal extended values: scale (exactly) into the normal range around the rounding
    c.get(R).f64abs().f64c(DBL_MIN).f64lt().set(DEN);
    c.get(DEN); const d0 = c.if_(); c.get(R).f64c(TWO_54).f64mul().set(R); c.end(); void d0;
    c.get(R).i64reinterpret_f64().set(BITS);
    c.get(BITS).i64(0n).i64lt_s().set(NEG);
    c.get(BITS).i64(LOW29).i64and().set(LOW);
    const done = c.block();
    const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
    c.get(RC).i32(3).and().br_table([l0, l1, l2, l3], done);
    c.end(); // nearest
    c.get(LOW).i64(HALF29).i64gt_u(); const n1 = c.if_(); c.i32(1).set(INC); c.else_();
    c.get(LOW).i64(HALF29).i64eq(); const n2 = c.if_();
    c.get(ES); const n3 = c.if_(); // exact value beyond the midpoint: its side decides (magnitude up when exact is larger)
    c.get(ES).i32(0).gt_s().get(NEG).eqz().eq().set(INC);
    c.else_(); c.get(BITS).i64(29n).i64shr_u().i64(1n).i64and().wrap().set(INC); // ties to even
    c.end(); void n3;
    c.end(); void n2;
    c.end(); void n1;
    c.br(done);
    c.end(); // down (toward -inf)
    c.get(LOW).i64eqz().eqz(); const dn = c.if_(); c.get(NEG).set(INC); c.else_();
    c.get(ES).i32(0).lt_s(); const dn2 = c.if_(); c.get(NEG); const dn3 = c.if_(); c.i32(1).set(INC); c.else_(); c.i32(1).set(DEC); c.end(); void dn3; c.end(); void dn2;
    c.end(); void dn;
    c.br(done);
    c.end(); // up (toward +inf)
    c.get(LOW).i64eqz().eqz(); const up = c.if_(); c.get(NEG).eqz().set(INC); c.else_();
    c.get(ES).i32(0).gt_s(); const up2 = c.if_(); c.get(NEG); const up3 = c.if_(); c.i32(1).set(DEC); c.else_(); c.i32(1).set(INC); c.end(); void up3; c.end(); void up2;
    c.end(); void up;
    c.br(done);
    c.end(); // toward zero: on the grid with the exact magnitude smaller -> one step down
    c.get(LOW).i64eqz().get(ES).and(); const tz = c.if_(); c.get(ES).i32(0).gt_s().get(NEG).eq().set(DEC); c.end(); void tz;
    c.end(); // done
    c.get(BITS).i64(~LOW29).i64and().set(BITS);
    c.get(INC); const i1 = c.if_(); c.get(BITS).i64(ULP24).i64add().set(BITS); c.end(); void i1;
    c.get(DEC); const i2 = c.if_(); c.get(BITS).i64(ULP24).i64sub().set(BITS); c.end(); void i2;
    c.get(BITS).f64reinterpret_i64().set(R);
    c.get(DEN); const d1 = c.if_(); c.get(R).f64c(TWO_M54).f64mul().set(R); c.end(); void d1;
    c.get(R);
    rnd24 = m.func([T.f64, T.i32, T.i32], [T.f64], [T.i64, T.i64, T.i32, T.i32, T.i32, T.i32], c, 'rnd24');
  }
  // ---- arith24(a, b, op, rc) -> f64
  let arith24;
  {
    const c = new Code();
    const [A, B, OP, RC, R, E] = [0, 1, 2, 3, 4, 5];
    const done = c.block();
    const ls = []; for (let i = 0; i < 9; i++) ls.push(c.block());
    c.get(OP).br_table(ls, done);
    for (let i = 8; i >= 0; i--) {
      c.end(); // the innermost remaining block (ls[i]) ends first: code for op i
      switch (i) {
        case 0: c.get(A).get(B).f64add().set(R); c.get(A).get(B).get(R).call(twoSum).set(E); break;
        case 1: c.get(A).get(B).f64mul().set(R); c.get(A).get(B).get(R).call(twoProd).set(E); break;
        case 4: c.get(A).get(B).f64sub().set(R); c.get(A).get(B).f64neg().get(R).call(twoSum).set(E); break;
        case 5: c.get(B).get(A).f64sub().set(R); c.get(B).get(A).f64neg().get(R).call(twoSum).set(E); break;
        case 6: c.get(A).get(B).f64div().set(R); c.get(A).get(B).get(R).call(divErr).set(E); break;
        case 7: c.get(B).get(A).f64div().set(R); c.get(B).get(A).get(R).call(divErr).set(E); break;
        case 8: { // sqrt: a - r*r exactly (0 for 0 / non-finite roots)
          c.get(A).f64sqrt().set(R);
          c.get(R).f64c(0).f64eq().get(R).get(R).f64sub().f64c(0).f64eq().eqz().or(); const z = c.if_(); c.f64c(0).set(E); c.else_();
          c.get(A).get(R).get(R).f64mul().f64sub().get(R).get(R).get(R).get(R).f64mul().call(twoProd).f64sub().set(E);
          c.end(); void z;
          break;
        }
        default: c.get(A).set(R); break; // unused op numbers
      }
      c.br(done);
    }
    c.end();
    c.get(R).get(RC);
    c.get(E).f64c(0).f64gt().get(E).f64c(0).f64lt().sub(); // sign of the error
    c.call(rnd24);
    arith24 = m.func([T.f64, T.f64, T.i32, T.i32], [T.f64], [T.f64, T.f64], c, 'arith24');
  }
  // ---- f32rc(x, rc) -> f32
  let f32rc;
  {
    const c = new Code();
    const [X, RC, R, AX] = [0, 1, 2, 3];
    c.get(RC).i32(3).and().eqz().get(X).f64c(0).f64eq().or().get(X).get(X).f64sub().f64c(0).f64eq().eqz().or();
    const plain = c.if_(); c.get(X).f32demote().return_(); c.end(); void plain;
    c.get(X).f64abs().set(AX);
    c.get(AX).f64c(FLT_MIN).f64lt(); const den = c.if_();
    // float denormal range: nearest conversion, then one 2^-149 step toward the rounding direction
    c.get(X).f32demote().f64promote().set(R);
    c.get(R).get(X).f64ne(); const ne = c.if_();
    const sel = c.block(); const t3 = c.block(), t2 = c.block(), t1 = c.block(), t0 = c.block();
    c.get(RC).i32(3).and().br_table([t0, t1, t2, t3], sel);
    c.end(); c.br(sel); // nearest (not reached)
    c.end(); c.get(R).get(X).f64gt(); const a1 = c.if_(); c.get(R).f64c(FLT_DENORM).f64sub().set(R); c.end(); void a1; c.br(sel);
    c.end(); c.get(R).get(X).f64lt(); const a2 = c.if_(); c.get(R).f64c(FLT_DENORM).f64add().set(R); c.end(); void a2; c.br(sel);
    c.end(); c.get(R).f64abs().get(AX).f64gt(); const a3 = c.if_(); c.get(R).f64c(FLT_DENORM).get(R).f64copysign().f64sub().set(R); c.end(); void a3;
    c.end();
    c.end(); void ne;
    // a step to zero keeps the value's sign (IEEE -2^-149 + 2^-149 is +0)
    c.get(R).f64c(0).f64eq(); const zs = c.if_(); c.f64c(0).get(X).f64copysign().set(R); c.end(); void zs;
    c.get(R).f32demote().return_();
    c.end(); void den;
    c.get(X).get(RC).i32(0).call(rnd24).set(R);
    c.get(R).f64abs().f64c(FLT_MAX).f64gt(); const ovf = c.if_();
    // overflow: infinity or the largest float depending on the direction
    c.get(RC).i32(3).and().i32(1).eq(); const o1 = c.if_(T.f64); c.get(R).f64c(0).f64gt(); const o1a = c.if_(T.f64); c.f64c(FLT_MAX); c.else_(); c.f64c(-Infinity); c.end(); void o1a;
    c.else_(); c.get(RC).i32(3).and().i32(2).eq(); const o2 = c.if_(T.f64); c.get(R).f64c(0).f64gt(); const o2a = c.if_(T.f64); c.f64c(Infinity); c.else_(); c.f64c(-FLT_MAX); c.end(); void o2a;
    c.else_(); c.f64c(FLT_MAX).get(R).f64copysign(); c.end(); void o2;
    c.end(); void o1;
    c.f32demote().return_();
    c.end(); void ovf;
    c.get(R).f32demote();
    f32rc = m.func([T.f64, T.i32], [T.f32], [T.f64, T.f64], c, 'f32rc');
  }
  return { arith24, f32rc };
}

// Conformance of the pure-WASM exp2m1 / log2 / log2p1 / scalb kernels (src/cpu/jit/fpmath-exp.js):
// special values bit-exactly, exact cases (powers of two, 2^1 - 1, 2^-1 - 1, ...), random sweeps
// against JavaScript's Math functions with a true relative-error criterion at tol = 1e-14 (the
// maximum observed is printed in ulp@1 = 2^-52 units), the same sweeps against a BigInt
// fixed-point reference (220 fractional bits) that isolates the kernels' own error from the
// reference's, scalb bit-for-bit against an exact BigInt reference (a 2^trunc(b) rounded once,
// with the interpreter's FSCALE special cases), and timing loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';
import { addExpKernels, INDEFINITE_BITS, LOG2P1_LO, LOG2P1_HI } from '../src/cpu/jit/fpmath-exp.js';
import { scalb as scalbInterp } from '../src/cpu/interp-x87.js';

const TOL = 1e-14;
const ULP1 = 2 ** -52;
const MIN_NORMAL = 2 ** -1022;
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const bitsOf = (v) => { f64[0] = v; return u64[0]; };
const fromBits = (b) => { u64[0] = b; return f64[0]; };
const INDEFINITE = fromBits(INDEFINITE_BITS);

/** Build a module exporting the four kernels, i64-bits variants and benchmark loops; no imports (D004). */
function build() {
  const m = new ModuleBuilder();
  const k = addExpKernels(m);
  for (const name of ['exp2m1', 'log2', 'log2p1', 'scalb']) m.exportFunc(name, k[name]);
  // bit-pattern wrappers (NaN payloads are not reliably observable through JS numbers)
  for (const name of ['log2', 'log2p1', 'exp2m1']) {
    const c = new Code(); c.get(0).call(k[name]).i64reinterpret_f64();
    m.exportFunc(name + '_bits', m.func([T.f64], [T.i64], [], c, name + '_bits'));
  }
  { const c = new Code(); c.get(0).get(1).call(k.scalb).i64reinterpret_f64(); m.exportFunc('scalb_bits', m.func([T.f64, T.f64], [T.i64], [], c, 'scalb_bits')); }
  // bench_<f>(n, x, dx) -> sum of f(x) over n iterations with x += dx
  for (const name of ['exp2m1', 'log2', 'log2p1']) {
    const c = new Code();
    const [N, X, DX, ACC] = [0, 1, 2, 3];
    const L = c.loop();
    c.get(ACC).get(X).call(k[name]).f64add().set(ACC);
    c.get(X).get(DX).f64add().set(X);
    c.get(N).i32(1).sub().tee(N).br_if(L);
    c.end();
    c.get(ACC);
    m.exportFunc('bench_' + name, m.func([T.i32, T.f64, T.f64], [T.f64], [T.f64], c, 'bench_' + name));
  }
  { // bench_scalb(n, a, b, db)
    const c = new Code();
    const [N, A, B, DB, ACC] = [0, 1, 2, 3, 4];
    const L = c.loop();
    c.get(ACC).get(A).get(B).call(k.scalb).f64add().set(ACC);
    c.get(B).get(DB).f64add().set(B);
    c.get(N).i32(1).sub().tee(N).br_if(L);
    c.end();
    c.get(ACC);
    m.exportFunc('bench_scalb', m.func([T.i32, T.f64, T.f64, T.f64], [T.f64], [T.f64], c, 'bench_scalb'));
  }
  const bytes = m.build();
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return { ...inst.exports, size: bytes.length };
}
const W = build();
const { exp2m1, log2, log2p1, scalb } = W;

// ---- deterministic PRNG (xorshift128+) so a failure is reproducible
function rng(seed) {
  let s0 = BigInt(seed) * 0x9e3779b97f4a7c15n | 1n, s1 = 0xda942042e4dd58b5n;
  return () => {
    let x = s0, y = s1; s0 = y; x ^= (x << 23n) & 0xffffffffffffffffn; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x;
    return Number(((s0 + s1) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  };
}
const next = rng(20260923);
const sign = () => (next() < 0.5 ? -1 : 1);
const uniform = (lo, hi) => lo + (hi - lo) * next();
const logUniform = (lo, hi) => Math.pow(10, lo + (hi - lo) * next());
const denormal = () => sign() * Math.floor(next() * 2 ** 52) * Number.MIN_VALUE;
/** a random double with the given number of leading mantissa bits chosen freely (any full 53-bit value) */
const fullBits = (lo, hi) => { const v = uniform(lo, hi); f64[0] = v; u64[0] ^= BigInt(Math.floor(next() * 2 ** 20)); return f64[0]; };

/** true relative error (not the oracle's max(1, ...) normalization) */
const relErr = (got, want) => Math.abs(got - want) / Math.abs(want);
const fmtUlp = (e) => `${e.toExponential(3)} (${(e / ULP1).toFixed(3)} ulp@1)`;
const report = (name, stats, n) => console.log(`[fpmath-exp] ${name}: n=${n} max rel err ${fmtUlp(stats.max)} at ${stats.at?.map((v) => String(v)).join(', ')}`);

/**
 * Compare with a JS reference: bit-exact for NaN / zeros / infinities, one unit of 2^-1074 for
 * denormal results (both sides round on that grid), relative tolerance otherwise.
 */
function check(name, fn, ref, x, stats) {
  const got = fn(x), want = ref(x);
  if (Number.isNaN(want)) { assert.ok(Number.isNaN(got), `${name}(${x}) = ${got}, want NaN`); return; }
  if (want === 0 || !Number.isFinite(want)) { assert.ok(Object.is(got, want), `${name}(${x}) = ${got} (1/x=${1 / got}), want ${want}`); return; }
  if (Math.abs(want) < MIN_NORMAL) { assert.ok(Math.abs(got - want) <= 2 * Number.MIN_VALUE, `${name}(${x}) = ${got}, want ${want} (denormal)`); return; }
  const e = relErr(got, want);
  if (stats && e > stats.max) { stats.max = e; stats.at = [x, got, want]; }
  assert.ok(e <= TOL, `${name}(${x}) = ${got}, want ${want}, rel err ${e}`);
}

// ---- BigInt fixed-point reference (220 fractional bits), everything from the series definitions
const FB = 220n, ONE = 1n << FB;
/** v / 2^220 truncated toward zero (BigInt >> floors, which would never reach 0 from below) */
const shr = (v) => (v < 0n ? -((-v) >> FB) : v >> FB);
/** x = m 2^e exactly (m signed integer, |m| < 2^53), finite non-zero x */
function decomp(x) {
  const b = bitsOf(x);
  const neg = b >> 63n, ex = Number((b >> 52n) & 0x7ffn);
  let mant = b & ((1n << 52n) - 1n), e;
  if (ex === 0) e = -1074; else { mant |= 1n << 52n; e = ex - 1075; }
  return { m: neg ? -mant : mant, e };
}
/** fixed-point value of a double (exact when its last bit is >= 2^-220) */
function fixed(x) { const { m, e } = decomp(x); const sh = BigInt(e) + FB; return sh >= 0n ? m << sh : m >> -sh; }
const LN2F = (() => { let s = 0n, t = ONE / 3n, k = 0n; while (t) { s += t / (2n * k + 1n); t /= 9n; k++; } return 2n * s; })(); // 2 atanh(1/3)
const LOG2EF = (ONE << FB) / LN2F;
/** exp(t) - 1, |t| <= 1, fixed in/out */
function expm1F(t) { let s = 0n, term = ONE; for (let n = 1n; ; n++) { term = shr(term * t) / n; if (term === 0n) return s; s += term; } }
/** log2 of a positive fixed-point value: v = 2^E M, M in [0.75, 1.5), ln M = 2 atanh((M - 1) / (M + 1)) */
function log2F(v) {
  let E = BigInt(v.toString(2).length - 1) - FB;
  let M = E >= 0n ? v >> E : v << -E;
  if (M >= 3n * (ONE >> 1n)) { M >>= 1n; E++; }
  const s = ((M - ONE) << FB) / (M + ONE), z = s * s >> FB;
  let sum = 0n, t = s;
  for (let k = 0n; t !== 0n; k++) { sum += t / (2n * k + 1n); t = shr(t * z); }
  return E * ONE + ((2n * sum) << FB) / LN2F;
}
/** relative error of the double got against the reference q 2^s (q BigInt) */
function relErrFixed(got, q, s) {
  if (q === 0n) return got === 0 ? 0 : Infinity;
  const { m, e } = decomp(got);
  let G = m, Q = q;
  if (e >= s) G <<= BigInt(e - s); else Q <<= BigInt(s - e);
  let d = G - Q; if (d < 0n) d = -d;
  if (Q < 0n) Q = -Q;
  return Number((d << 64n) / Q) / 2 ** 64;
}
/** 2^x - 1 as (q, scale), |x| <= 1: exp(x ln2) - 1, or for |x| < 2^-30 the two-term x ln2 (1 + x ln2 / 2) */
function exp2m1Ref(x) {
  if (Math.abs(x) < 2 ** -30) {
    const { m, e } = decomp(x);
    const c = shr(fixed(x) * LN2F) / 2n; // x ln2 / 2 (0 when x is below the fixed-point grid)
    const q = m * LN2F + shr(m * LN2F * c);
    return [q, e - 220];
  }
  return [expm1F(shr(fixed(x) * LN2F)), -220];
}
/** log2(x) as (q, -220) */
function log2Ref(x) { const { m, e } = decomp(x); return [log2F(m << FB) + BigInt(e) * ONE, -220]; }
/** log2(1 + x) as (q, scale): 1 + x exactly in fixed point, or for |x| < 2^-30 x log2e (1 - x / 2) */
function log2p1Ref(x) {
  if (Math.abs(x) < 2 ** -30) {
    const { m, e } = decomp(x);
    const c = fixed(x) / 2n;
    const q = m * LOG2EF - shr(m * LOG2EF * c);
    return [q, e - 220];
  }
  return [log2F(ONE + fixed(x)), -220];
}
function checkExact(name, fn, ref, x, stats) {
  const got = fn(x);
  const [q, s] = ref(x);
  const e = relErrFixed(got, q, s);
  if (e > stats.max) { stats.max = e; stats.at = [x, got]; }
  assert.ok(e <= TOL, `${name}(${x}) = ${got}, rel err vs exact ${e}`);
}
/**
 * Tiny results against the exact reference: normal results within 2 ulp; denormal results within
 * half a unit of 2^-1074 (correct rounding on that grid; the 2^600 scaling rounds once, the only
 * slack is a tie produced by the first rounding).
 */
function checkTiny(name, fn, ref, x) {
  const got = fn(x);
  const [q, s] = ref(x);
  const e = relErrFixed(got, q, s);
  if (Math.abs(got) >= MIN_NORMAL) { assert.ok(e <= 4.5e-16, `${name}(${x}) = ${got} rel err vs exact ${e}`); return; }
  const units = e * Math.abs(got) / Number.MIN_VALUE;
  assert.ok(units <= 0.5 + 1e-9, `${name}(${x}) = ${got}: ${units} units of 2^-1074 off the exact value`);
}

// ---- FSCALE reference: the special cases of src/cpu/interp-x87.js H[OP.FSCALE], then a 2^trunc(b)
// rounded ONCE to nearest-even from the exact value (BigInt: |a| = mant 2^s, the result is either
// exact with a rewritten exponent, or mant shifted into units of 2^-1074 with the dropped bits
// deciding the rounding), as the hardware does
function scalbRef(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? INDEFINITE : Number.isNaN(a) ? a : b;
  if (!Number.isFinite(b)) return b > 0 ? (a === 0 ? INDEFINITE : a * Infinity) : (Number.isFinite(a) ? a * 0 : INDEFINITE);
  if (a === 0 || !Number.isFinite(a)) return a;
  const e = Math.max(-5000, Math.min(5000, Math.trunc(b)));
  const bits = bitsOf(a), sign = bits >> 63n;
  let mant = bits & 0xfffffffffffffn, exp = Number((bits >> 52n) & 0x7ffn);
  if (exp === 0) exp = -1074; else { mant |= 1n << 52n; exp -= 1075; }
  let s = exp + e; // |result| = mant 2^s
  while (mant < (1n << 52n)) { mant <<= 1n; s--; }
  if (s + 52 > 1023) return fromBits((sign << 63n) | 0x7ff0000000000000n);
  if (s + 52 >= -1022) return fromBits((sign << 63n) | (BigInt(s + 52 + 1023) << 52n) | (mant & 0xfffffffffffffn));
  const shift = -1074 - s; // > 0: denormal or zero
  if (shift > 60) return fromBits(sign << 63n);
  const sh = BigInt(shift), rem = mant & ((1n << sh) - 1n), half = 1n << (sh - 1n);
  let q = mant >> sh;
  if (rem > half || (rem === half && (q & 1n))) q++;
  return fromBits((sign << 63n) | q);
}

const SPECIALS = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 0.25, 1024, -1024, 1023.5, -1023.5, 1e-10, -1e-10, 1e-300, -1e-300,
  Number.MIN_VALUE, -Number.MIN_VALUE, MIN_NORMAL, -MIN_NORMAL, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE, Math.SQRT2, Math.SQRT1_2,
  1.0000000000000002, 0.9999999999999999, 0.9999999999999998, LOG2P1_LO, LOG2P1_HI, -0.29289321881345254, 0.41421356237309515, 59.9, -59.9, -60, -61, 1023.9999];

const expRef = (x) => (Math.abs(x) <= 1 ? Math.expm1(x * Math.LN2) : Math.pow(2, x) - 1);
const log2p1MathRef = (x) => Math.log1p(x) / Math.LN2;

test('module builds without imports; sizes', () => {
  assert.ok(W.size < 8192, `module size ${W.size}`);
  console.log(`[fpmath-exp] module ${W.size} bytes (kernels + test wrappers)`);
});

test('exp2m1: special values and exact cases', () => {
  const stats = { max: 0, at: null };
  for (const x of SPECIALS) check('exp2m1', exp2m1, expRef, x, stats);
  assert.ok(Object.is(exp2m1(0), 0) && Object.is(exp2m1(-0), -0));
  assert.equal(exp2m1(1), 1); assert.equal(exp2m1(-1), -0.5); assert.equal(exp2m1(2), 3); assert.equal(exp2m1(-2), -0.75);
  assert.equal(exp2m1(10), 1023); assert.equal(exp2m1(-10), -0.9990234375); assert.equal(exp2m1(53), 2 ** 53 - 1);
  assert.equal(exp2m1(Infinity), Infinity); assert.equal(exp2m1(-Infinity), -1); assert.equal(exp2m1(1024), Infinity); assert.equal(exp2m1(-60), -1);
  assert.equal(exp2m1(1023), 2 ** 1023); assert.ok(Number.isFinite(exp2m1(1023.9999)));
  // NaN payload passes through
  assert.equal(W.exp2m1_bits(fromBits(0x7ff8000000001234n)), 0x7ff8000000001234n);
  assert.equal(BigInt.asUintN(64, W.exp2m1_bits(fromBits(0xfff8000000005678n))), 0xfff8000000005678n);
  // tiny x: correctly rounded x ln2 (checked against the exact reference), denormals included
  for (const x of [1e-10, -1e-10, 1e-20, 1e-100, 1e-300, -1e-300, 2 ** -1000, 2 ** -1030, 1e-310, -1e-310, 3 * Number.MIN_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE]) checkTiny('exp2m1', exp2m1, exp2m1Ref, x);
  for (let i = 0; i < 20_000; i++) checkTiny('exp2m1', exp2m1, exp2m1Ref, denormal() || Number.MIN_VALUE);
  for (let i = 0; i < 5_000; i++) checkTiny('exp2m1', exp2m1, exp2m1Ref, sign() * logUniform(-323, -300));
  assert.equal(exp2m1(Number.MIN_VALUE), Number.MIN_VALUE); // 0.69 units rounds to 1 unit
  assert.equal(exp2m1(-Number.MIN_VALUE), -Number.MIN_VALUE);
  report('exp2m1 specials vs Math', stats, SPECIALS.length);
});

test('exp2m1: random sweeps vs Math (tol 1e-14) and vs the exact reference', () => {
  const N = 200_000, NX = 10_000;
  const sweeps = {
    'uniform [-1, 1]': () => uniform(-1, 1),
    'uniform [-1, 1] full mantissas': () => fullBits(-1, 1),
    'uniform [-0.01, 0.01]': () => uniform(-0.01, 0.01),
    'log-uniform |x| in 1e-300..1 (signed)': () => sign() * logUniform(-300, 0),
    'near +-1 (1 - 1e-6..1)': () => sign() * (1 - logUniform(-16, -6)),
    'uniform [-60, 1024] (outside the F2XM1 domain, vs pow)': () => uniform(-60, 1024),
    'uniform [-8, 8]': () => uniform(-8, 8),
  };
  let overall = 0;
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < N; i++) check('exp2m1', exp2m1, expRef, gen(), stats);
    report('exp2m1 ' + name, stats, N);
    overall = Math.max(overall, stats.max);
  }
  // denormal inputs: within one unit of 2^-1074 of Math (both round on the grid)
  for (let i = 0; i < N; i++) check('exp2m1', exp2m1, expRef, denormal());
  console.log(`[fpmath-exp] exp2m1 overall max rel err vs Math ${fmtUlp(overall)}`);
  assert.ok(overall <= TOL);
  let exact = 0;
  for (const [name, gen] of Object.entries({ 'exact uniform [-1, 1]': () => uniform(-1, 1), 'exact full mantissas [-1, 1]': () => fullBits(-1, 1), 'exact log-uniform 1e-300..1 (signed)': () => sign() * logUniform(-300, 0), 'exact near +-1': () => sign() * (1 - logUniform(-16, -3)) })) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < NX; i++) checkExact('exp2m1', exp2m1, exp2m1Ref, gen(), stats);
    report('exp2m1 ' + name, stats, NX);
    exact = Math.max(exact, stats.max);
  }
  console.log(`[fpmath-exp] exp2m1 overall max rel err vs exact ${fmtUlp(exact)}`);
  assert.ok(exact <= 4.5e-16, `exp2m1 exceeds 2 ulp: ${exact}`);
});

test('log2: special values and exact powers of two', () => {
  const stats = { max: 0, at: null };
  for (const x of SPECIALS) check('log2', log2, Math.log2, x, stats);
  assert.ok(Object.is(log2(1), 0), `log2(1) = ${log2(1)} (1/x = ${1 / log2(1)})`);
  for (let k = -1074; k <= 1023; k++) assert.ok(Object.is(log2(2 ** k), k === 0 ? 0 : k), `log2(2^${k}) = ${log2(2 ** k)}`);
  assert.equal(log2(0), -Infinity); assert.equal(log2(-0), -Infinity); assert.equal(log2(Infinity), Infinity);
  for (const x of [-1, -0.5, -Infinity, -Number.MIN_VALUE, -Number.MAX_VALUE]) assert.equal(BigInt.asUintN(64, W.log2_bits(x)), INDEFINITE_BITS, `log2(${x}) should be the indefinite QNaN`);
  assert.equal(W.log2_bits(fromBits(0x7ff8000000001234n)), 0x7ff8000000001234n);
  assert.equal(BigInt.asUintN(64, W.log2_bits(fromBits(0xfff8000000005678n))), 0xfff8000000005678n);
  // near 1: log2(1 + k 2^-52) ~ k 2^-52 / ln2 relative accuracy
  for (let k = -8; k <= 8; k++) {
    if (k === 0) continue;
    const x = 1 + k * 2 ** -52;
    const [q, s] = log2Ref(x);
    assert.ok(relErrFixed(log2(x), q, s) <= 4.5e-16, `log2(${x}) = ${log2(x)}`);
  }
  report('log2 specials vs Math', stats, SPECIALS.length);
});

test('log2: random sweeps vs Math.log2 (tol 1e-14) and vs the exact reference', () => {
  const N = 200_000, NX = 10_000;
  const sweeps = {
    'log-uniform 1e-300..1e300': () => logUniform(-300, 300),
    'uniform [0.5, 2]': () => uniform(0.5, 2),
    'uniform [0.5, 2] full mantissas': () => fullBits(0.5, 2),
    'near 1: 1 + (1e-16..1e-2)': () => 1 + sign() * logUniform(-16, -2),
    'near sqrt(2) and sqrt(1/2) (both sides)': () => (next() < 0.5 ? Math.SQRT2 : Math.SQRT1_2) * (1 + sign() * logUniform(-16, -6)),
    'denormals': () => Math.abs(denormal()) || Number.MIN_VALUE,
    'huge 1e290..MAX': () => logUniform(290, 308),
  };
  let overall = 0;
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < N; i++) check('log2', log2, Math.log2, gen(), stats);
    report('log2 ' + name, stats, N);
    overall = Math.max(overall, stats.max);
  }
  console.log(`[fpmath-exp] log2 overall max rel err vs Math ${fmtUlp(overall)}`);
  assert.ok(overall <= TOL);
  let exact = 0;
  for (const [name, gen] of Object.entries({ 'exact log-uniform 1e-300..1e300': () => logUniform(-300, 300), 'exact uniform [0.5, 2] full mantissas': () => fullBits(0.5, 2), 'exact near 1': () => 1 + sign() * logUniform(-16, -2), 'exact denormals': () => Math.abs(denormal()) || Number.MIN_VALUE })) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < NX; i++) checkExact('log2', log2, log2Ref, gen(), stats);
    report('log2 ' + name, stats, NX);
    exact = Math.max(exact, stats.max);
  }
  console.log(`[fpmath-exp] log2 overall max rel err vs exact ${fmtUlp(exact)}`);
  assert.ok(exact <= 4.5e-16, `log2 exceeds 2 ulp: ${exact}`);
});

test('log2p1: special values and exact cases', () => {
  const stats = { max: 0, at: null };
  for (const x of SPECIALS) check('log2p1', log2p1, log2p1MathRef, x, stats);
  assert.ok(Object.is(log2p1(0), 0) && Object.is(log2p1(-0), -0));
  assert.equal(log2p1(1), 1); assert.equal(log2p1(3), 2); assert.equal(log2p1(-0.5), -1); assert.equal(log2p1(-0.75), -2); assert.equal(log2p1(2 ** 60 - 1), 60);
  assert.equal(log2p1(-1), -Infinity); assert.equal(log2p1(Infinity), Infinity);
  for (const x of [-1.5, -2, -Infinity, -Number.MAX_VALUE, -1.0000000000000002]) assert.equal(BigInt.asUintN(64, W.log2p1_bits(x)), INDEFINITE_BITS, `log2p1(${x}) should be the indefinite QNaN`);
  assert.equal(W.log2p1_bits(fromBits(0x7ff8000000001234n)), 0x7ff8000000001234n);
  // tiny x: x log2e correctly rounded, denormals within half a unit
  for (const x of [1e-10, -1e-10, 1e-20, 1e-100, 1e-300, -1e-300, 2 ** -1000, 2 ** -1030, 1e-310, -1e-310, 3 * Number.MIN_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -52, -(2 ** -53)]) checkTiny('log2p1', log2p1, log2p1Ref, x);
  for (let i = 0; i < 20_000; i++) checkTiny('log2p1', log2p1, log2p1Ref, denormal() || Number.MIN_VALUE);
  for (let i = 0; i < 5_000; i++) checkTiny('log2p1', log2p1, log2p1Ref, sign() * logUniform(-323, -300));
  // both sides of the direct window join continuously
  for (const x0 of [LOG2P1_LO, LOG2P1_HI]) for (const d of [-2, -1, 1, 2]) {
    const x = x0 + d * ULP1 / 4;
    const [q, s] = log2p1Ref(x);
    assert.ok(relErrFixed(log2p1(x), q, s) <= 4.5e-16, `log2p1(${x}) at the window edge`);
  }
  report('log2p1 specials vs Math', stats, SPECIALS.length);
});

test('log2p1: random sweeps vs Math.log1p / ln2 (tol 1e-14) and vs the exact reference', () => {
  const N = 200_000, NX = 10_000;
  const sweeps = {
    'FYL2XP1 domain |x| < 1 - sqrt(2)/2': () => uniform(-0.29289, 0.29289),
    'direct window full mantissas': () => fullBits(LOG2P1_LO, LOG2P1_HI),
    'log-uniform |x| in 1e-300..0.29 (signed)': () => sign() * logUniform(-300, Math.log10(0.29)),
    'uniform (-1, 8]': () => uniform(-0.999999, 8),
    'near -1: -1 + (1e-16..1e-1)': () => -1 + logUniform(-16, -1),
    'log-uniform 1..1e300': () => logUniform(0, 300),
    'around the window edges': () => (next() < 0.5 ? LOG2P1_LO : LOG2P1_HI) + sign() * logUniform(-16, -3),
  };
  let overall = 0;
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < N; i++) check('log2p1', log2p1, log2p1MathRef, gen(), stats);
    report('log2p1 ' + name, stats, N);
    overall = Math.max(overall, stats.max);
  }
  for (let i = 0; i < N; i++) check('log2p1', log2p1, log2p1MathRef, denormal());
  console.log(`[fpmath-exp] log2p1 overall max rel err vs Math ${fmtUlp(overall)}`);
  assert.ok(overall <= TOL);
  let exact = 0;
  for (const [name, gen] of Object.entries({ 'exact FYL2XP1 domain': () => uniform(-0.29289, 0.29289), 'exact direct window full mantissas': () => fullBits(LOG2P1_LO, LOG2P1_HI), 'exact tiny signed 1e-300..0.29': () => sign() * logUniform(-300, Math.log10(0.29)), 'exact (-1, 8]': () => uniform(-0.999999, 8), 'exact near -1': () => -1 + logUniform(-16, -1), 'exact 1..1e300': () => logUniform(0, 300) })) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < NX; i++) checkExact('log2p1', log2p1, log2p1Ref, gen(), stats);
    report('log2p1 ' + name, stats, NX);
    exact = Math.max(exact, stats.max);
  }
  console.log(`[fpmath-exp] log2p1 overall max rel err vs exact ${fmtUlp(exact)}`);
  assert.ok(exact <= 4.5e-16, `log2p1 exceeds 2 ulp: ${exact}`);
});

test('scalb: bit-for-bit against the exact single-rounding reference (specials and random)', () => {
  // the hardware corner a 2^-1000 stepping gets wrong (two roundings -> 0; the interpreter's former algorithm)
  assert.equal(scalb(1.25 * 2 ** -74, -1001), 5e-324);
  assert.equal(scalbRef(1.25 * 2 ** -74, -1001), 5e-324);
  const same = (a, b) => {
    const got = BigInt.asUintN(64, W.scalb_bits(a, b)), want = bitsOf(scalbRef(a, b));
    assert.equal(got, want, `scalb(${a}, ${b}) = ${fromBits(got)} [${got.toString(16)}], want ${fromBits(want)} [${want.toString(16)}]`);
  };
  const vals = [0, -0, 1, -1, 1.5, -1.5, 0.1, 3.9, -3.9, 1000, 1001, -1000, -1001, 1024, -1074, -1075, 2000, -2000, 2100, -2100, 1e10, -1e10, 1e300, -1e300, 2 ** 63, -(2 ** 63), 2 ** 64,
    Number.MIN_VALUE, -Number.MIN_VALUE, MIN_NORMAL, 1.0000000000000002 * MIN_NORMAL, Number.MAX_VALUE, -Number.MAX_VALUE, 1e-310, 2.5e-320, Infinity, -Infinity, NaN, fromBits(0x7ff8000000001234n), fromBits(0xfff0000000000001n)];
  for (const a of vals) for (const b of vals) same(a, b);
  // the interpreter's scalb(a, e) (integer e = trunc(b), no NaN / infinite b: the FSCALE handler
  // deals with those) is the same single rounding, bit for bit
  for (const a of vals) for (const b of vals) {
    if (!Number.isFinite(b)) continue;
    const got = bitsOf(scalbInterp(a, Math.trunc(b))), want = BigInt.asUintN(64, W.scalb_bits(a, b));
    assert.equal(got, want, `interpreter scalb(${a}, ${Math.trunc(b)}) = ${fromBits(got)} [${got.toString(16)}], kernel ${fromBits(want)} [${want.toString(16)}]`);
  }
  // the NaN rule: a's NaN wins over b's NaN? no: both NaN -> indefinite; one NaN -> that one (payload kept)
  assert.equal(W.scalb_bits(fromBits(0x7ff8000000001234n), 3), 0x7ff8000000001234n);
  assert.equal(W.scalb_bits(3, fromBits(0x7ff8000000004321n)), 0x7ff8000000004321n);
  assert.equal(BigInt.asUintN(64, W.scalb_bits(fromBits(0x7ff8000000001234n), fromBits(0x7ff8000000004321n))), INDEFINITE_BITS);
  assert.equal(BigInt.asUintN(64, W.scalb_bits(0, Infinity)), INDEFINITE_BITS);
  assert.equal(BigInt.asUintN(64, W.scalb_bits(Infinity, -Infinity)), INDEFINITE_BITS);
  assert.ok(Object.is(scalb(-3, -Infinity), -0) && Object.is(scalb(3, -Infinity), 0));
  assert.equal(scalb(-3, Infinity), -Infinity);
  // random: mantissas everywhere, exponents that cross the denormal/overflow thresholds and the clamps
  const N = 300_000;
  for (let i = 0; i < N; i++) {
    const a = (next() < 0.1 ? denormal() : sign() * logUniform(-308, 308));
    const kind = next();
    const b = kind < 0.5 ? uniform(-1100, 1100) : kind < 0.8 ? Math.round(uniform(-2200, 2200)) : kind < 0.9 ? sign() * logUniform(3, 20) : uniform(-1075, -1020);
    same(a, b);
  }
  // sample with fractional exponents (trunc toward zero) in the denormal-producing region
  for (let i = 0; i < 50_000; i++) same(fullBits(0.5, 2), uniform(-1080, -1020));
});

test('timing: 1e7 calls of each kernel from a WASM loop', () => {
  const n = 1e7;
  const time = (name, fn, jsFn) => {
    fn(1e6); // warm-up (tier-up)
    const t0 = process.hrtime.bigint();
    const acc = fn(n);
    const ns = Number(process.hrtime.bigint() - t0) / n;
    const t1 = process.hrtime.bigint();
    const ref = jsFn(n);
    const nsJs = Number(process.hrtime.bigint() - t1) / n;
    console.log(`[fpmath-exp] ${name}: ${ns.toFixed(1)} ns/call (WASM loop, 1e7 calls); JS Math equivalent: ${nsJs.toFixed(1)} ns/call; sums ${acc} vs ${ref}`);
    assert.ok(Math.abs(acc - ref) <= 1e-9 * Math.max(1, Math.abs(ref)), `sum mismatch ${acc} vs ${ref}`);
    assert.ok(ns < 500, `${name} too slow: ${ns} ns/call`);
  };
  time('exp2m1 x in [-1, 1]', (k) => W.bench_exp2m1(k, -1, 2 / k), (k) => { let x = -1, s = 0; for (let i = 0; i < k; i++) { s += Math.expm1(x * Math.LN2); x += 2 / k; } return s; });
  time('log2 x in [0.5, 1.5]', (k) => W.bench_log2(k, 0.5, 1 / k), (k) => { let x = 0.5, s = 0; for (let i = 0; i < k; i++) { s += Math.log2(x); x += 1 / k; } return s; });
  time('log2 x in [1e-3, 1e3]', (k) => W.bench_log2(k, 1e-3, 1e3 / k), (k) => { let x = 1e-3, s = 0; for (let i = 0; i < k; i++) { s += Math.log2(x); x += 1e3 / k; } return s; });
  time('log2p1 x in [-0.29, 0.29] (direct window)', (k) => W.bench_log2p1(k, -0.29, 0.58 / k), (k) => { let x = -0.29, s = 0; for (let i = 0; i < k; i++) { s += Math.log1p(x) / Math.LN2; x += 0.58 / k; } return s; });
  time('log2p1 x in [0.5, 8] (fallback)', (k) => W.bench_log2p1(k, 0.5, 7.5 / k), (k) => { let x = 0.5, s = 0; for (let i = 0; i < k; i++) { s += Math.log1p(x) / Math.LN2; x += 7.5 / k; } return s; });
  time('scalb b in [-100, 100]', (k) => W.bench_scalb(k, 1.5, -100, 200 / k), (k) => { let b = -100, s = 0; for (let i = 0; i < k; i++) { s += 1.5 * 2 ** Math.trunc(b); b += 200 / k; } return s; });
});

// Lane-level checks of every WASM SIMD encoder in src/cpu/jit/wasm.js. A mis-encoded opcode id
// otherwise only surfaces as "JIT module failed" at instantiation time, so every family is
// built into a tiny module with ModuleBuilder, instantiated, and executed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';

// ---------------------------------------------------------------- harness
const A = 0, B = 16, R = 32; // memory slots: operand a, operand b, result

/**
 * Build one exported function `f` over an imported 1-page memory.
 * @param {(c: Code) => void} emit body (the function end is appended by ModuleBuilder)
 * @param {{ params?: number[], results?: number[], locals?: number[] }} [sig]
 */
function build(emit, sig = {}) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, 1);
  const c = new Code();
  emit(c);
  const f = m.func(sig.params ?? [], sig.results ?? [], sig.locals ?? [], { buf: c.buf, len: c.len }, 'f');
  m.exportFunc('f', f);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const bytes = m.build();
  let inst;
  try {
    inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  } catch (e) {
    throw new Error(`module failed: ${e.message}`);
  }
  return { f: inst.exports.f, u8: new Uint8Array(memory.buffer), memory };
}

// lane packers (little-endian byte arrays of 16 bytes)
const pack = (Ctor, vals) => { const b = new Uint8Array(16); new Ctor(b.buffer).set(vals); return b; };
const i8 = (...v) => pack(Int8Array, v), u8 = (...v) => pack(Uint8Array, v);
const i16 = (...v) => pack(Int16Array, v), u16 = (...v) => pack(Uint16Array, v);
const i32 = (...v) => pack(Int32Array, v), u32 = (...v) => pack(Uint32Array, v);
const i64 = (...v) => pack(BigInt64Array, v), u64 = (...v) => pack(BigUint64Array, v);
const f32 = (...v) => pack(Float32Array, v), f64 = (...v) => pack(Float64Array, v);
// lane readers
const as = (Ctor, b) => Array.from(new Ctor(b.buffer, b.byteOffset, 16 / Ctor.BYTES_PER_ELEMENT));
const rdI8 = (b) => as(Int8Array, b), rdU8 = (b) => as(Uint8Array, b), rdI16 = (b) => as(Int16Array, b), rdU16 = (b) => as(Uint16Array, b);
const rdI32 = (b) => as(Int32Array, b), rdU32 = (b) => as(Uint32Array, b), rdI64 = (b) => as(BigInt64Array, b), rdU64 = (b) => as(BigUint64Array, b);
const rdF32 = (b) => as(Float32Array, b), rdF64 = (b) => as(Float64Array, b);
/** compare floats with NaN == NaN and distinguishing -0 from +0 */
function eqFloats(actual, expected, msg) {
  assert.equal(actual.length, expected.length, msg);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i], e = expected[i];
    const ok = Number.isNaN(e) ? Number.isNaN(a) : Object.is(a, e);
    assert.ok(ok, `${msg}: lane ${i}: got ${a} expected ${e}`);
  }
}

/** result bytes of a binary op: (a, b) -> R */
function bin(emitOp, a, b) {
  const { f, u8: m } = build((c) => { c.i32(R); c.i32(A).v128load(0); c.i32(B).v128load(0); emitOp(c); c.v128store(0); });
  m.set(a, A); m.set(b, B); f();
  return m.slice(R, R + 16);
}
/** result bytes of a unary op: a -> R */
function un(emitOp, a) {
  const { f, u8: m } = build((c) => { c.i32(R); c.i32(A).v128load(0); emitOp(c); c.v128store(0); });
  m.set(a, A); f();
  return m.slice(R, R + 16);
}
/** i32 result of a unary op (bitmask, extract_lane, any_true, all_true) */
function unI32(emitOp, a) {
  const { f, u8: m } = build((c) => { c.i32(A).v128load(0); emitOp(c); }, { results: [T.i32] });
  m.set(a, A);
  return f();
}
/** i64 result of a unary op (i64x2.extract_lane) */
function unI64(emitOp, a) {
  const { f, u8: m } = build((c) => { c.i32(A).v128load(0); emitOp(c); }, { results: [T.i64] });
  m.set(a, A);
  return f();
}
/** shift by an i32 count: (a, count) -> R */
function shift(emitOp, a, count) {
  const { f, u8: m } = build((c) => { c.i32(R); c.i32(A).v128load(0); c.i32(count); emitOp(c); c.v128store(0); });
  m.set(a, A); f();
  return m.slice(R, R + 16);
}

// ---------------------------------------------------------------- constants, shuffles, splats
test('simd: v128.const, shuffle, swizzle', () => {
  const k = Array.from({ length: 16 }, (_, i) => 0xf0 + i);
  const r = un((c) => { c.drop(); c.v128const(k); }, u8());
  assert.deepEqual(Array.from(r), k);
  // shuffle: lanes 0..15 from a, 16..31 from b
  const a = u8(...Array.from({ length: 16 }, (_, i) => i)), b = u8(...Array.from({ length: 16 }, (_, i) => 100 + i));
  const s = bin((c) => c.i8x16shuffle([15, 14, 13, 12, 16, 17, 18, 19, 0, 1, 2, 3, 31, 30, 29, 28]), a, b);
  assert.deepEqual(rdU8(s), [15, 14, 13, 12, 100, 101, 102, 103, 0, 1, 2, 3, 115, 114, 113, 112]);
  // MOVHLPS-like: dst.q0 = src.q1
  const h = bin((c) => c.i8x16shuffle([24, 25, 26, 27, 28, 29, 30, 31, 8, 9, 10, 11, 12, 13, 14, 15]), a, b);
  assert.deepEqual(rdU8(h), [108, 109, 110, 111, 112, 113, 114, 115, 8, 9, 10, 11, 12, 13, 14, 15]);
  // swizzle: indices >= 16 give 0
  const sw = bin((c) => c.i8x16swizzle(), a, u8(3, 2, 1, 0, 16, 255, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15));
  assert.deepEqual(rdU8(sw), [3, 2, 1, 0, 0, 0, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.throws(() => new Code().i8x16shuffle([1, 2, 3]));
  assert.throws(() => new Code().v128const([1]));
});

test('simd: splats', () => {
  const spl = (emit, results, results2) => {
    const { f, u8: m } = build((c) => { c.i32(R); emit(c); c.v128store(0); });
    f(); return m.slice(R, R + 16);
  };
  assert.deepEqual(rdU8(spl((c) => c.i32(0x1ab).i8x16splat())), Array(16).fill(0xab));
  assert.deepEqual(rdU16(spl((c) => c.i32(0x1beef).i16x8splat())), Array(8).fill(0xbeef));
  assert.deepEqual(rdU32(spl((c) => c.i32(0xdeadbeef | 0).i32x4splat())), Array(4).fill(0xdeadbeef));
  assert.deepEqual(rdU64(spl((c) => c.i64(0x123456789abcdef0n).i64x2splat())), Array(2).fill(0x123456789abcdef0n));
  eqFloats(rdF32(spl((c) => c.f32c(1.5).f32x4splat())), [1.5, 1.5, 1.5, 1.5], 'f32x4.splat');
  eqFloats(rdF64(spl((c) => c.f64c(-0).f64x2splat())), [-0, -0], 'f64x2.splat');
});

test('simd: extract / replace lanes', () => {
  const a = i8(-1, 2, -3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -128);
  assert.equal(unI32((c) => c.i8x16extractlane_s(0), a), -1);
  assert.equal(unI32((c) => c.i8x16extractlane_u(0), a), 255);
  assert.equal(unI32((c) => c.i8x16extractlane_s(15), a), -128);
  assert.equal(unI32((c) => c.i8x16extractlane_u(15), a), 128);
  const w = i16(-2, 0x7fff, -32768, 4, 5, 6, 7, 8);
  assert.equal(unI32((c) => c.i16x8extractlane_s(2), w), -32768);
  assert.equal(unI32((c) => c.i16x8extractlane_u(2), w), 32768);
  assert.equal(unI32((c) => c.i16x8extractlane_s(1), w), 0x7fff);
  const d = i32(1, -2, 3, 0x7fffffff);
  assert.equal(unI32((c) => c.i32x4extractlane(1), d), -2);
  assert.equal(unI32((c) => c.i32x4extractlane(3), d), 0x7fffffff);
  const q = i64(-5n, 0x7fffffffffffffffn);
  assert.equal(unI64((c) => c.i64x2extractlane(0), q), -5n);
  assert.equal(unI64((c) => c.i64x2extractlane(1), q), 0x7fffffffffffffffn);
  // float extracts
  const { f: fe } = (() => {
    const r = build((c) => { c.i32(A).v128load(0).f32x4extractlane(2); }, { results: [T.f32] });
    r.u8.set(f32(1, 2, -3.25, 4), A); return r;
  })();
  assert.equal(fe(), -3.25);
  const { f: de } = (() => {
    const r = build((c) => { c.i32(A).v128load(0).f64x2extractlane(1); }, { results: [T.f64] });
    r.u8.set(f64(1, -6.5), A); return r;
  })();
  assert.equal(de(), -6.5);
  // replace lanes
  assert.deepEqual(rdI8(un((c) => c.i32(0x1ff).i8x16replacelane(3), a)), [-1, 2, -3, -1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -128]);
  assert.deepEqual(rdU16(un((c) => c.i32(0x1abcd).i16x8replacelane(7), w)).slice(6), [7, 0xabcd]);
  assert.deepEqual(rdI32(un((c) => c.i32(-9).i32x4replacelane(0), d)), [-9, -2, 3, 0x7fffffff]);
  assert.deepEqual(rdI64(un((c) => c.i64(77n).i64x2replacelane(1), q)), [-5n, 77n]);
  eqFloats(rdF32(un((c) => c.f32c(9.5).f32x4replacelane(0), f32(1, 2, 3, 4))), [9.5, 2, 3, 4], 'f32x4.replace_lane');
  eqFloats(rdF64(un((c) => c.f64c(-1).f64x2replacelane(1), f64(1, 2))), [1, -1], 'f64x2.replace_lane');
});

// ---------------------------------------------------------------- compares
test('simd: integer compares', () => {
  const a = i8(0, 1, -1, 127, -128, 5, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0), b = i8(0, 2, 1, -128, 127, 5, 4, 6, 0, 0, 0, 0, 0, 0, 0, 0);
  const T8 = (op) => rdI8(bin(op, a, b)).slice(0, 8).map((v) => (v === -1 ? 1 : v === 0 ? 0 : NaN));
  assert.deepEqual(T8((c) => c.i8x16eq()), [1, 0, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(T8((c) => c.i8x16ne()), [0, 1, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(T8((c) => c.i8x16lt_s()), [0, 1, 1, 0, 1, 0, 0, 1]);
  assert.deepEqual(T8((c) => c.i8x16lt_u()), [0, 1, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(T8((c) => c.i8x16gt_s()), [0, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual(T8((c) => c.i8x16gt_u()), [0, 0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(T8((c) => c.i8x16le_s()), [1, 1, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(T8((c) => c.i8x16le_u()), [1, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(T8((c) => c.i8x16ge_s()), [1, 0, 0, 1, 0, 1, 1, 0]);
  assert.deepEqual(T8((c) => c.i8x16ge_u()), [1, 0, 1, 0, 1, 1, 1, 0]);
  const w1 = i16(0, 1, -1, 32767, -32768, 5, 5, 5), w2 = i16(0, 2, 1, -32768, 32767, 5, 4, 6);
  const T16 = (op) => rdI16(bin(op, w1, w2)).map((v) => (v === -1 ? 1 : 0));
  assert.deepEqual(T16((c) => c.i16x8eq()), [1, 0, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(T16((c) => c.i16x8ne()), [0, 1, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(T16((c) => c.i16x8lt_s()), [0, 1, 1, 0, 1, 0, 0, 1]);
  assert.deepEqual(T16((c) => c.i16x8lt_u()), [0, 1, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(T16((c) => c.i16x8gt_s()), [0, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual(T16((c) => c.i16x8gt_u()), [0, 0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(T16((c) => c.i16x8le_s()), [1, 1, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(T16((c) => c.i16x8le_u()), [1, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(T16((c) => c.i16x8ge_s()), [1, 0, 0, 1, 0, 1, 1, 0]);
  assert.deepEqual(T16((c) => c.i16x8ge_u()), [1, 0, 1, 0, 1, 1, 1, 0]);
  const d1 = i32(0, 1, -1, 0x7fffffff), d2 = i32(0, 2, 1, -0x80000000);
  const T32 = (op) => rdI32(bin(op, d1, d2)).map((v) => (v === -1 ? 1 : 0));
  assert.deepEqual(T32((c) => c.i32x4eq()), [1, 0, 0, 0]);
  assert.deepEqual(T32((c) => c.i32x4ne()), [0, 1, 1, 1]);
  assert.deepEqual(T32((c) => c.i32x4lt_s()), [0, 1, 1, 0]);
  assert.deepEqual(T32((c) => c.i32x4lt_u()), [0, 1, 0, 1]);
  assert.deepEqual(T32((c) => c.i32x4gt_s()), [0, 0, 0, 1]);
  assert.deepEqual(T32((c) => c.i32x4gt_u()), [0, 0, 1, 0]);
  assert.deepEqual(T32((c) => c.i32x4le_s()), [1, 1, 1, 0]);
  assert.deepEqual(T32((c) => c.i32x4le_u()), [1, 1, 0, 1]);
  assert.deepEqual(T32((c) => c.i32x4ge_s()), [1, 0, 0, 1]);
  assert.deepEqual(T32((c) => c.i32x4ge_u()), [1, 0, 1, 0]);
  const q1 = i64(-1n, 5n), q2 = i64(1n, 5n);
  const T64 = (op) => rdI64(bin(op, q1, q2)).map((v) => (v === -1n ? 1 : 0));
  assert.deepEqual(T64((c) => c.i64x2eq()), [0, 1]);
  assert.deepEqual(T64((c) => c.i64x2ne()), [1, 0]);
  assert.deepEqual(T64((c) => c.i64x2lt_s()), [1, 0]);
  assert.deepEqual(T64((c) => c.i64x2gt_s()), [0, 0]);
  assert.deepEqual(T64((c) => c.i64x2le_s()), [1, 1]);
  assert.deepEqual(T64((c) => c.i64x2ge_s()), [0, 1]);
});

test('simd: float compares (NaN unordered, -0 == +0)', () => {
  const a = f32(1, NaN, -0, 2), b = f32(2, 1, 0, 2);
  const Tf = (op) => rdI32(bin(op, a, b)).map((v) => (v === -1 ? 1 : 0));
  assert.deepEqual(Tf((c) => c.f32x4eq()), [0, 0, 1, 1]);
  assert.deepEqual(Tf((c) => c.f32x4ne()), [1, 1, 0, 0]);
  assert.deepEqual(Tf((c) => c.f32x4lt()), [1, 0, 0, 0]);
  assert.deepEqual(Tf((c) => c.f32x4gt()), [0, 0, 0, 0]);
  assert.deepEqual(Tf((c) => c.f32x4le()), [1, 0, 1, 1]);
  assert.deepEqual(Tf((c) => c.f32x4ge()), [0, 0, 1, 1]);
  const d = f64(NaN, -0), e = f64(NaN, 0);
  const Td = (op) => rdI64(bin(op, d, e)).map((v) => (v === -1n ? 1 : 0));
  assert.deepEqual(Td((c) => c.f64x2eq()), [0, 1]);
  assert.deepEqual(Td((c) => c.f64x2ne()), [1, 0]);
  assert.deepEqual(Td((c) => c.f64x2lt()), [0, 0]);
  assert.deepEqual(Td((c) => c.f64x2gt()), [0, 0]);
  assert.deepEqual(Td((c) => c.f64x2le()), [0, 1]);
  assert.deepEqual(Td((c) => c.f64x2ge()), [0, 1]);
});

// ---------------------------------------------------------------- bitwise
test('simd: bitwise ops, andnot order, bitselect, any_true', () => {
  const a = u32(0xff00ff00, 0x12345678, 0, 0xffffffff), b = u32(0x0ff00ff0, 0xffffffff, 0, 0x0000ffff);
  assert.deepEqual(rdU32(un((c) => c.v128not(), a)), [0x00ff00ff, 0xedcba987, 0xffffffff, 0]);
  assert.deepEqual(rdU32(bin((c) => c.v128and(), a, b)), [0x0f000f00, 0x12345678, 0, 0x0000ffff]);
  // andnot(a, b) = a & ~b
  assert.deepEqual(rdU32(bin((c) => c.v128andnot(), a, b)), [0xf000f000, 0, 0, 0xffff0000]);
  assert.deepEqual(rdU32(bin((c) => c.v128or(), a, b)), [0xfff0fff0, 0xffffffff, 0, 0xffffffff]);
  assert.deepEqual(rdU32(bin((c) => c.v128xor(), a, b)), [0xf0f0f0f0, 0xedcba987, 0, 0xffff0000]);
  // bitselect(v1, v2, mask): mask bit set -> v1
  const { f, u8: m } = build((c) => { c.i32(R); c.i32(A).v128load(0); c.i32(B).v128load(0); c.v128const(u32(0xffffffff, 0, 0x0000ffff, 0)); c.v128bitselect(); c.v128store(0); });
  m.set(a, A); m.set(b, B); f();
  assert.deepEqual(rdU32(m.slice(R, R + 16)), [0xff00ff00, 0xffffffff, 0, 0x0000ffff]);
  assert.equal(unI32((c) => c.v128anytrue(), u32(0, 0, 0, 0)), 0);
  assert.equal(unI32((c) => c.v128anytrue(), u32(0, 0, 0, 0x100)), 1);
});

// ---------------------------------------------------------------- conversions
test('simd: conversions', () => {
  eqFloats(rdF32(un((c) => c.f32x4demote_f64x2_zero(), f64(1.5, -2.25))), [1.5, -2.25, 0, 0], 'demote_zero');
  eqFloats(rdF64(un((c) => c.f64x2promote_low_f32x4(), f32(1.5, -0, 9, 9))), [1.5, -0], 'promote_low');
  // trunc_sat: NaN -> 0, overflow saturates, truncation toward zero
  assert.deepEqual(rdU32(un((c) => c.i32x4trunc_sat_f32x4_s(), f32(NaN, 3e9, -3e9, 2.5))), [0, 0x7fffffff, 0x80000000, 2]);
  assert.deepEqual(rdI32(un((c) => c.i32x4trunc_sat_f32x4_s(), f32(-2.5, 2147483648, -2147483648, -0.9))), [-2, 0x7fffffff, -0x80000000, 0]);
  assert.deepEqual(rdU32(un((c) => c.i32x4trunc_sat_f32x4_u(), f32(NaN, 5e9, -3, 2.9))), [0, 0xffffffff, 0, 2]);
  eqFloats(rdF32(un((c) => c.f32x4convert_i32x4_s(), i32(-1, 16777217, 0x7fffffff, 0))), [-1, 16777216, 2147483648, 0], 'convert_s');
  eqFloats(rdF32(un((c) => c.f32x4convert_i32x4_u(), u32(0xffffffff, 1, 0, 0x80000000))), [4294967296, 1, 0, 2147483648], 'convert_u');
  assert.deepEqual(rdU32(un((c) => c.i32x4trunc_sat_f64x2_s_zero(), f64(NaN, -1e12))), [0, 0x80000000, 0, 0]);
  assert.deepEqual(rdU32(un((c) => c.i32x4trunc_sat_f64x2_s_zero(), f64(2147483647.9, -7.9))), [0x7fffffff, 0xfffffff9, 0, 0]);
  assert.deepEqual(rdU32(un((c) => c.i32x4trunc_sat_f64x2_u_zero(), f64(-5, 1e12))), [0, 0xffffffff, 0, 0]);
  eqFloats(rdF64(un((c) => c.f64x2convert_low_i32x4_s(), i32(-7, 0x7fffffff, 1, 1))), [-7, 2147483647, 'convert_low_s'].slice(0, 2), 'convert_low_s');
  eqFloats(rdF64(un((c) => c.f64x2convert_low_i32x4_u(), u32(0xffffffff, 3, 1, 1))), [4294967295, 3], 'convert_low_u');
});

// ---------------------------------------------------------------- i8x16
test('simd: i8x16 ops', () => {
  const a = i8(-1, 2, -128, 127, 0, 100, -100, 50, 1, 1, 1, 1, 1, 1, 1, 1), b = i8(1, -2, -1, 1, 0, 100, -100, -50, 1, 1, 1, 1, 1, 1, 1, 1);
  assert.deepEqual(rdI8(un((c) => c.i8x16abs(), a)).slice(0, 4), [1, 2, -128, 127]);
  assert.deepEqual(rdI8(un((c) => c.i8x16neg(), a)).slice(0, 4), [1, -2, -128, -127]);
  assert.deepEqual(rdU8(un((c) => c.i8x16popcnt(), u8(0, 1, 3, 255, 0x80, 0x0f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).slice(0, 6), [0, 1, 2, 8, 1, 4]);
  assert.equal(unI32((c) => c.i8x16alltrue(), a), 0);
  assert.equal(unI32((c) => c.i8x16alltrue(), b), 0);
  assert.equal(unI32((c) => c.i8x16alltrue(), u8(...Array(16).fill(3))), 1);
  assert.equal(unI32((c) => c.i8x16bitmask(), a), 0b0000000001000101);
  assert.equal(unI32((c) => c.i8x16bitmask(), u8(0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80)), 0x8001);
  // narrow: a lanes first, then b lanes; saturating
  assert.deepEqual(rdI8(bin((c) => c.i8x16narrow_i16x8_s(), i16(1, 2, 300, -300, 127, -128, 0, 0), i16(9, 8, 7, 6, 5, 4, 3, 2))), [1, 2, 127, -128, 127, -128, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual(rdU8(bin((c) => c.i8x16narrow_i16x8_u(), i16(1, -2, 300, 255, 256, -32768, 0, 0), i16(9, 8, 7, 6, 5, 4, 3, 2))), [1, 0, 255, 255, 255, 0, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2]);
  // shifts (count mod 8)
  assert.deepEqual(rdU8(shift((c) => c.i8x16shl(), u8(1, 0x80, 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 1)).slice(0, 4), [2, 0, 0xfe, 6]);
  assert.deepEqual(rdU8(shift((c) => c.i8x16shl(), u8(1, 0x80, 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 9)).slice(0, 4), [2, 0, 0xfe, 6]);
  assert.deepEqual(rdI8(shift((c) => c.i8x16shr_s(), i8(-128, 127, -1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 2)).slice(0, 4), [-32, 31, -1, 1]);
  assert.deepEqual(rdU8(shift((c) => c.i8x16shr_u(), u8(0x80, 127, 0xff, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 2)).slice(0, 4), [0x20, 31, 0x3f, 1]);
  assert.deepEqual(rdU8(shift((c) => c.i8x16shr_u(), u8(0x80, 127, 0xff, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 8)).slice(0, 4), [0x80, 127, 0xff, 4]);
  // add/sub (wrapping and saturating)
  assert.deepEqual(rdI8(bin((c) => c.i8x16add(), a, b)).slice(0, 8), [0, 0, 127, -128, 0, -56, 56, 0]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16add_sat_s(), a, b)).slice(0, 8), [0, 0, -128, 127, 0, 127, -128, 0]);
  assert.deepEqual(rdU8(bin((c) => c.i8x16add_sat_u(), u8(200, 1, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), u8(100, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).slice(0, 3), [255, 2, 255]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16sub(), a, b)).slice(0, 8), [-2, 4, -127, 126, 0, 0, 0, 100]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16sub_sat_s(), a, b)).slice(0, 8), [-2, 4, -127, 126, 0, 0, 0, 100]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16sub_sat_s(), i8(-128, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), i8(1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).slice(0, 2), [-128, 127]);
  assert.deepEqual(rdU8(bin((c) => c.i8x16sub_sat_u(), u8(5, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), u8(10, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).slice(0, 2), [0, 100]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16min_s(), a, b)).slice(0, 4), [-1, -2, -128, 1]);
  assert.deepEqual(rdU8(bin((c) => c.i8x16min_u(), a, b)).slice(0, 4), [1, 2, 128, 1]);
  assert.deepEqual(rdI8(bin((c) => c.i8x16max_s(), a, b)).slice(0, 4), [1, 2, -1, 127]);
  assert.deepEqual(rdU8(bin((c) => c.i8x16max_u(), a, b)).slice(0, 4), [255, 254, 255, 127]);
  // avgr_u = (a + b + 1) >> 1
  assert.deepEqual(rdU8(bin((c) => c.i8x16avgr_u(), u8(255, 0, 1, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), u8(255, 1, 2, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).slice(0, 4), [255, 1, 2, 255]);
});

// ---------------------------------------------------------------- rounding
test('simd: f32x4 / f64x2 rounding', () => {
  const v = f32(2.5, -2.5, 3.5, -0.4);
  eqFloats(rdF32(un((c) => c.f32x4ceil(), v)), [3, -2, 4, -0], 'f32x4.ceil');
  eqFloats(rdF32(un((c) => c.f32x4floor(), v)), [2, -3, 3, -1], 'f32x4.floor');
  eqFloats(rdF32(un((c) => c.f32x4trunc(), v)), [2, -2, 3, -0], 'f32x4.trunc');
  eqFloats(rdF32(un((c) => c.f32x4nearest(), v)), [2, -2, 4, -0], 'f32x4.nearest');
  const d = f64(2.5, -3.5);
  eqFloats(rdF64(un((c) => c.f64x2ceil(), d)), [3, -3], 'f64x2.ceil');
  eqFloats(rdF64(un((c) => c.f64x2floor(), d)), [2, -4], 'f64x2.floor');
  eqFloats(rdF64(un((c) => c.f64x2trunc(), d)), [2, -3], 'f64x2.trunc');
  eqFloats(rdF64(un((c) => c.f64x2nearest(), d)), [2, -4], 'f64x2.nearest');
});

// ---------------------------------------------------------------- pairwise
test('simd: extadd_pairwise', () => {
  const a = i8(-1, -1, 127, 127, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
  assert.deepEqual(rdI16(un((c) => c.i16x8extadd_pairwise_i8x16_s(), a)), [-2, 254, 3, 7, 11, 15, 19, 23]);
  assert.deepEqual(rdU16(un((c) => c.i16x8extadd_pairwise_i8x16_u(), a)), [510, 254, 3, 7, 11, 15, 19, 23]);
  const w = i16(-1, -1, 32767, 32767, 1, 2, 3, 4);
  assert.deepEqual(rdI32(un((c) => c.i32x4extadd_pairwise_i16x8_s(), w)), [-2, 65534, 3, 7]);
  assert.deepEqual(rdU32(un((c) => c.i32x4extadd_pairwise_i16x8_u(), w)), [131070, 65534, 3, 7]);
});

// ---------------------------------------------------------------- i16x8
test('simd: i16x8 ops', () => {
  const a = i16(-1, 2, -32768, 32767, 0, 1000, -1000, 7), b = i16(1, -2, -1, 1, 0, 1000, -1000, -7);
  assert.deepEqual(rdI16(un((c) => c.i16x8abs(), a)).slice(0, 4), [1, 2, -32768, 32767]);
  assert.deepEqual(rdI16(un((c) => c.i16x8neg(), a)).slice(0, 4), [1, -2, -32768, -32767]);
  // q15mulr_sat_s: round((a*b) >> 15) saturated
  assert.deepEqual(rdI16(bin((c) => c.i16x8q15mulr_sat_s(), i16(-32768, 16384, 0x7fff, 0, 0, 0, 0, 0), i16(-32768, 16384, 2, 0, 0, 0, 0, 0))).slice(0, 3), [32767, 8192, 2]);
  assert.equal(unI32((c) => c.i16x8alltrue(), a), 0);
  assert.equal(unI32((c) => c.i16x8alltrue(), b), 0);
  assert.equal(unI32((c) => c.i16x8alltrue(), i16(1, 1, 1, 1, 1, 1, 1, -1)), 1);
  assert.equal(unI32((c) => c.i16x8bitmask(), a), 0b01000101);
  // narrow: a first, saturating
  assert.deepEqual(rdI16(bin((c) => c.i16x8narrow_i32x4_s(), i32(0x10000, 0x20001, -0x10000, 4), i32(5, 6, 7, -8))), [32767, 32767, -32768, 4, 5, 6, 7, -8]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8narrow_i32x4_u(), i32(0x10000, -1, 65535, 4), i32(5, 6, 7, -8))), [65535, 0, 65535, 4, 5, 6, 7, 0]);
  const bytes = i8(-1, 2, -3, 4, -5, 6, -7, 8, 100, -100, 50, -50, 0, 1, 127, -128);
  assert.deepEqual(rdI16(un((c) => c.i16x8extend_low_i8x16_s(), bytes)), [-1, 2, -3, 4, -5, 6, -7, 8]);
  assert.deepEqual(rdI16(un((c) => c.i16x8extend_high_i8x16_s(), bytes)), [100, -100, 50, -50, 0, 1, 127, -128]);
  assert.deepEqual(rdU16(un((c) => c.i16x8extend_low_i8x16_u(), bytes)), [255, 2, 253, 4, 251, 6, 249, 8]);
  assert.deepEqual(rdU16(un((c) => c.i16x8extend_high_i8x16_u(), bytes)), [100, 156, 50, 206, 0, 1, 127, 128]);
  // shifts (count mod 16)
  assert.deepEqual(rdU16(shift((c) => c.i16x8shl(), u16(1, 0x8000, 0xffff, 3, 0, 0, 0, 0), 1)).slice(0, 4), [2, 0, 0xfffe, 6]);
  assert.deepEqual(rdU16(shift((c) => c.i16x8shl(), u16(1, 0x8000, 0xffff, 3, 0, 0, 0, 0), 17)).slice(0, 4), [2, 0, 0xfffe, 6]);
  assert.deepEqual(rdI16(shift((c) => c.i16x8shr_s(), i16(-32768, 32767, -1, 4, 0, 0, 0, 0), 3)).slice(0, 4), [-4096, 4095, -1, 0]);
  assert.deepEqual(rdU16(shift((c) => c.i16x8shr_u(), u16(0x8000, 32767, 0xffff, 4, 0, 0, 0, 0), 3)).slice(0, 4), [0x1000, 4095, 0x1fff, 0]);
  assert.deepEqual(rdU16(shift((c) => c.i16x8shr_u(), u16(0x8000, 32767, 0xffff, 4, 0, 0, 0, 0), 17)).slice(0, 4), [0x4000, 16383, 0x7fff, 2]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8add(), a, b)), [0, 0, 32767, -32768, 0, 2000, -2000, 0]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8add_sat_s(), a, b)), [0, 0, -32768, 32767, 0, 2000, -2000, 0]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8add_sat_u(), u16(65000, 1, 0, 0, 0, 0, 0, 0), u16(1000, 1, 0, 0, 0, 0, 0, 0))).slice(0, 2), [65535, 2]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8sub(), a, b)), [-2, 4, -32767, 32766, 0, 0, 0, 14]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8sub_sat_s(), i16(-32768, 32767, 0, 0, 0, 0, 0, 0), i16(1, -1, 0, 0, 0, 0, 0, 0))).slice(0, 2), [-32768, 32767]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8sub_sat_u(), u16(5, 200, 0, 0, 0, 0, 0, 0), u16(10, 100, 0, 0, 0, 0, 0, 0))).slice(0, 2), [0, 100]);
  // mul: low 16 bits
  assert.deepEqual(rdI16(bin((c) => c.i16x8mul(), i16(300, -2, 0x7fff, 3, 0, 0, 0, 0), i16(300, 3, 2, -3, 0, 0, 0, 0))).slice(0, 4), [90000 & 0xffff, -6, -2, -9].map((v) => (v << 16) >> 16));
  assert.deepEqual(rdI16(bin((c) => c.i16x8min_s(), a, b)).slice(0, 4), [-1, -2, -32768, 1]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8min_u(), a, b)).slice(0, 4), [1, 2, 32768, 1]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8max_s(), a, b)).slice(0, 4), [1, 2, -1, 32767]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8max_u(), a, b)).slice(0, 4), [65535, 65534, 65535, 32767]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8avgr_u(), u16(65535, 0, 1, 0, 0, 0, 0, 0), u16(65535, 1, 2, 0, 0, 0, 0, 0))).slice(0, 3), [65535, 1, 2]);
  // extmul from i8x16 halves
  assert.deepEqual(rdI16(bin((c) => c.i16x8extmul_low_i8x16_s(), bytes, bytes)), [1, 4, 9, 16, 25, 36, 49, 64]);
  assert.deepEqual(rdI16(bin((c) => c.i16x8extmul_high_i8x16_s(), bytes, bytes)), [10000, 10000, 2500, 2500, 0, 1, 16129, 16384]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8extmul_low_i8x16_u(), bytes, bytes)), [65025, 4, 64009, 16, 63001, 36, 62001, 64]);
  assert.deepEqual(rdU16(bin((c) => c.i16x8extmul_high_i8x16_u(), bytes, bytes)), [10000, 24336, 2500, 42436, 0, 1, 16129, 16384]);
});

// ---------------------------------------------------------------- i32x4
test('simd: i32x4 ops', () => {
  const a = i32(-1, 2, -0x80000000, 0x7fffffff), b = i32(1, -2, -1, 1);
  assert.deepEqual(rdI32(un((c) => c.i32x4abs(), a)), [1, 2, -0x80000000, 0x7fffffff]);
  assert.deepEqual(rdI32(un((c) => c.i32x4neg(), a)), [1, -2, -0x80000000, -0x7fffffff]);
  assert.equal(unI32((c) => c.i32x4alltrue(), a), 1);
  assert.equal(unI32((c) => c.i32x4alltrue(), i32(1, 0, 1, 1)), 0);
  assert.equal(unI32((c) => c.i32x4bitmask(), a), 0b0101);
  assert.equal(unI32((c) => c.i32x4bitmask(), u32(0, 0x80000000, 0x7fffffff, 0xffffffff)), 0b1010);
  const w = i16(-1, 2, -3, 4, 30000, -30000, 32767, -32768);
  assert.deepEqual(rdI32(un((c) => c.i32x4extend_low_i16x8_s(), w)), [-1, 2, -3, 4]);
  assert.deepEqual(rdI32(un((c) => c.i32x4extend_high_i16x8_s(), w)), [30000, -30000, 32767, -32768]);
  assert.deepEqual(rdU32(un((c) => c.i32x4extend_low_i16x8_u(), w)), [65535, 2, 65533, 4]);
  assert.deepEqual(rdU32(un((c) => c.i32x4extend_high_i16x8_u(), w)), [30000, 35536, 32767, 32768]);
  assert.deepEqual(rdI32(shift((c) => c.i32x4shl(), i32(1, 2, 3, 4), 33)), [2, 4, 6, 8]);
  assert.deepEqual(rdI32(shift((c) => c.i32x4shl(), i32(1, 2, 3, 4), 31)), [-0x80000000, 0, -0x80000000, 0]);
  assert.deepEqual(rdI32(shift((c) => c.i32x4shr_s(), i32(-8, 8, -1, 0x7fffffff), 2)), [-2, 2, -1, 0x1fffffff]);
  assert.deepEqual(rdU32(shift((c) => c.i32x4shr_u(), u32(0x80000000, 8, 0xffffffff, 1), 31)), [1, 0, 1, 0]);
  assert.deepEqual(rdU32(shift((c) => c.i32x4shr_u(), u32(0x80000000, 8, 0xffffffff, 1), 32)), [0x80000000, 8, 0xffffffff, 1]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4add(), a, b)), [0, 0, 0x7fffffff, -0x80000000]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4sub(), a, b)), [-2, 4, -0x7fffffff, 0x7ffffffe]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4mul(), i32(3, -4, 0x10000, 0x7fffffff), i32(5, 6, 0x10000, 2))), [15, -24, 0, -2]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4min_s(), a, b)), [-1, -2, -0x80000000, 1]);
  assert.deepEqual(rdU32(bin((c) => c.i32x4min_u(), a, b)), [1, 2, 0x80000000, 1]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4max_s(), a, b)), [1, 2, -1, 0x7fffffff]);
  assert.deepEqual(rdU32(bin((c) => c.i32x4max_u(), a, b)), [0xffffffff, 0xfffffffe, 0xffffffff, 0x7fffffff]);
  // dot: pairs of i16 products summed (PMADDWD); wraps on 0x8000*0x8000*2
  assert.deepEqual(rdI32(bin((c) => c.i32x4dot_i16x8_s(), i16(1, 2, -3, 4, -32768, -32768, 100, 200), i16(10, 20, 30, 40, -32768, -32768, 1, 1))), [50, 70, -0x80000000, 300]);
  const w2 = i16(-1, 2, -3, 4, 30000, -30000, 32767, -32768);
  assert.deepEqual(rdI32(bin((c) => c.i32x4extmul_low_i16x8_s(), w2, w2)), [1, 4, 9, 16]);
  assert.deepEqual(rdI32(bin((c) => c.i32x4extmul_high_i16x8_s(), w2, w2)), [900000000, 900000000, 1073676289, 1073741824]);
  assert.deepEqual(rdU32(bin((c) => c.i32x4extmul_low_i16x8_u(), w2, w2)), [65535 * 65535, 4, 65533 * 65533, 16]);
  assert.deepEqual(rdU32(bin((c) => c.i32x4extmul_high_i16x8_u(), w2, w2)), [900000000, 35536 * 35536, 1073676289, 1073741824]);
});

// ---------------------------------------------------------------- i64x2
test('simd: i64x2 ops', () => {
  const a = i64(-1n, -0x8000000000000000n), b = i64(3n, 1n);
  assert.deepEqual(rdI64(un((c) => c.i64x2abs(), a)), [1n, -0x8000000000000000n]);
  assert.deepEqual(rdI64(un((c) => c.i64x2neg(), i64(5n, -7n))), [-5n, 7n]);
  assert.equal(unI32((c) => c.i64x2alltrue(), a), 1);
  assert.equal(unI32((c) => c.i64x2alltrue(), i64(0n, 1n)), 0);
  assert.equal(unI32((c) => c.i64x2bitmask(), a), 3);
  assert.equal(unI32((c) => c.i64x2bitmask(), u64(0x7fffffffffffffffn, 0x8000000000000000n)), 2);
  const d = i32(-1, 2, 0x7fffffff, -0x80000000);
  assert.deepEqual(rdI64(un((c) => c.i64x2extend_low_i32x4_s(), d)), [-1n, 2n]);
  assert.deepEqual(rdI64(un((c) => c.i64x2extend_high_i32x4_s(), d)), [0x7fffffffn, -0x80000000n]);
  assert.deepEqual(rdU64(un((c) => c.i64x2extend_low_i32x4_u(), d)), [0xffffffffn, 2n]);
  assert.deepEqual(rdU64(un((c) => c.i64x2extend_high_i32x4_u(), d)), [0x7fffffffn, 0x80000000n]);
  assert.deepEqual(rdU64(shift((c) => c.i64x2shl(), u64(1n, 0x8000000000000000n), 65)), [2n, 0n]);
  assert.deepEqual(rdI64(shift((c) => c.i64x2shr_s(), i64(-16n, 16n), 2)), [-4n, 4n]);
  assert.deepEqual(rdU64(shift((c) => c.i64x2shr_u(), u64(0x8000000000000000n, 16n), 63)), [1n, 0n]);
  assert.deepEqual(rdU64(shift((c) => c.i64x2shr_u(), u64(0x8000000000000000n, 16n), 64)), [0x8000000000000000n, 16n]);
  assert.deepEqual(rdI64(bin((c) => c.i64x2add(), a, b)), [2n, -0x7fffffffffffffffn]);
  assert.deepEqual(rdI64(bin((c) => c.i64x2sub(), a, b)), [-4n, 0x7fffffffffffffffn]);
  assert.deepEqual(rdU64(bin((c) => c.i64x2mul(), u64(0xffffffffn, 0x100000000n), u64(0xffffffffn, 0x100000000n))), [0xfffffffe00000001n, 0n]);
  const u = u32(0xffffffff, 7, 0x80000000, 2);
  assert.deepEqual(rdU64(bin((c) => c.i64x2extmul_low_i32x4_u(), u, u)), [0xfffffffe00000001n, 49n]);
  assert.deepEqual(rdU64(bin((c) => c.i64x2extmul_high_i32x4_u(), u, u)), [0x4000000000000000n, 4n]);
  assert.deepEqual(rdI64(bin((c) => c.i64x2extmul_low_i32x4_s(), u, u)), [1n, 49n]);
  assert.deepEqual(rdI64(bin((c) => c.i64x2extmul_high_i32x4_s(), u, u)), [0x4000000000000000n, 4n]);
});

// ---------------------------------------------------------------- floats
test('simd: f32x4 arithmetic, min/max vs pmin/pmax semantics', () => {
  const a = f32(1, -4, 9, 2.5), b = f32(3, 2, 4, -0.5);
  eqFloats(rdF32(un((c) => c.f32x4abs(), f32(-1, 2, -0, NaN))), [1, 2, 0, NaN], 'f32x4.abs');
  eqFloats(rdF32(un((c) => c.f32x4neg(), f32(-1, 2, 0, Infinity))), [1, -2, -0, -Infinity], 'f32x4.neg');
  eqFloats(rdF32(un((c) => c.f32x4sqrt(), f32(4, 2, -1, 0))), [2, Math.fround(Math.SQRT2), NaN, 0], 'f32x4.sqrt');
  eqFloats(rdF32(bin((c) => c.f32x4add(), a, b)), [4, -2, 13, 2], 'f32x4.add');
  eqFloats(rdF32(bin((c) => c.f32x4sub(), a, b)), [-2, -6, 5, 3], 'f32x4.sub');
  eqFloats(rdF32(bin((c) => c.f32x4mul(), a, b)), [3, -8, 36, -1.25], 'f32x4.mul');
  eqFloats(rdF32(bin((c) => c.f32x4div(), a, b)), [Math.fround(1 / 3), -2, 2.25, -5], 'f32x4.div');
  // IEEE min/max: NaN propagates, -0 < +0
  const x = f32(NaN, 1, -0, 2), y = f32(1, NaN, 0, -0);
  eqFloats(rdF32(bin((c) => c.f32x4min(), x, y)), [NaN, NaN, -0, -0], 'f32x4.min');
  eqFloats(rdF32(bin((c) => c.f32x4max(), x, y)), [NaN, NaN, 0, 2], 'f32x4.max');
  // pmin(b, a) == x86 MINPS(a, b) == (a < b ? a : b); pmax(b, a) == MAXPS(a, b) == (a > b ? a : b)
  const minps = rdF32(x).map((v, i) => (v < rdF32(y)[i] ? v : rdF32(y)[i]));
  const maxps = rdF32(x).map((v, i) => (v > rdF32(y)[i] ? v : rdF32(y)[i]));
  eqFloats(rdF32(bin((c) => c.f32x4pmin(), y, x)), minps, 'pmin(b,a) == MINPS(a,b)');
  eqFloats(rdF32(bin((c) => c.f32x4pmax(), y, x)), maxps, 'pmax(b,a) == MAXPS(a,b)');
  eqFloats(minps, [1, NaN, 0, -0], 'reference min');
  eqFloats(maxps, [1, NaN, 0, 2], 'reference max');
});

test('simd: f64x2 arithmetic, min/max, pmin/pmax', () => {
  const a = f64(1, -4), b = f64(3, 2);
  eqFloats(rdF64(un((c) => c.f64x2abs(), f64(-1, -0))), [1, 0], 'f64x2.abs');
  eqFloats(rdF64(un((c) => c.f64x2neg(), f64(-1, 0))), [1, -0], 'f64x2.neg');
  eqFloats(rdF64(un((c) => c.f64x2sqrt(), f64(4, 2))), [2, Math.SQRT2], 'f64x2.sqrt');
  eqFloats(rdF64(bin((c) => c.f64x2add(), a, b)), [4, -2], 'f64x2.add');
  eqFloats(rdF64(bin((c) => c.f64x2sub(), a, b)), [-2, -6], 'f64x2.sub');
  eqFloats(rdF64(bin((c) => c.f64x2mul(), a, b)), [3, -8], 'f64x2.mul');
  eqFloats(rdF64(bin((c) => c.f64x2div(), a, b)), [1 / 3, -2], 'f64x2.div');
  const x = f64(NaN, -0), y = f64(1, 0);
  eqFloats(rdF64(bin((c) => c.f64x2min(), x, y)), [NaN, -0], 'f64x2.min');
  eqFloats(rdF64(bin((c) => c.f64x2max(), x, y)), [NaN, 0], 'f64x2.max');
  eqFloats(rdF64(bin((c) => c.f64x2pmin(), y, x)), [1, 0], 'f64x2.pmin(b,a) == MINPD(a,b)');
  eqFloats(rdF64(bin((c) => c.f64x2pmax(), y, x)), [1, 0], 'f64x2.pmax(b,a) == MAXPD(a,b)');
  const x2 = f64(1, 2), y2 = f64(NaN, -0);
  eqFloats(rdF64(bin((c) => c.f64x2pmin(), y2, x2)), [NaN, -0], 'pmin NaN in b');
  eqFloats(rdF64(bin((c) => c.f64x2pmax(), y2, x2)), [NaN, 2], 'pmax NaN in b');
});

// ---------------------------------------------------------------- memory forms
test('simd: extending / splatting / zero loads', () => {
  const src = i8(-1, 2, -3, 4, -5, 6, -7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
  assert.deepEqual(rdI16(un((c) => { c.drop(); c.i32(A).v128load8x8s(0); }, src)), [-1, 2, -3, 4, -5, 6, -7, 8]);
  assert.deepEqual(rdU16(un((c) => { c.drop(); c.i32(A).v128load8x8u(0); }, src)), [255, 2, 253, 4, 251, 6, 249, 8]);
  const w = i16(-1, 2, -3, 4, 5, 6, 7, 8);
  assert.deepEqual(rdI32(un((c) => { c.drop(); c.i32(A).v128load16x4s(0); }, w)), [-1, 2, -3, 4]);
  assert.deepEqual(rdU32(un((c) => { c.drop(); c.i32(A).v128load16x4u(0); }, w)), [65535, 2, 65533, 4]);
  const d = i32(-1, 2, 3, 4);
  assert.deepEqual(rdI64(un((c) => { c.drop(); c.i32(A).v128load32x2s(0); }, d)), [-1n, 2n]);
  assert.deepEqual(rdU64(un((c) => { c.drop(); c.i32(A).v128load32x2u(0); }, d)), [0xffffffffn, 2n]);
  // offsets in the memarg
  assert.deepEqual(rdI64(un((c) => { c.drop(); c.i32(0).v128load32x2s(A + 4); }, d)), [2n, 3n]);
  // splats
  assert.deepEqual(rdU8(un((c) => { c.drop(); c.i32(A).v128load8splat(1); }, src)), Array(16).fill(2));
  assert.deepEqual(rdI16(un((c) => { c.drop(); c.i32(A).v128load16splat(2); }, w)), Array(8).fill(2));
  assert.deepEqual(rdI32(un((c) => { c.drop(); c.i32(A + 4).v128load32splat(0); }, d)), Array(4).fill(2));
  assert.deepEqual(rdU64(un((c) => { c.drop(); c.i32(A).v128load64splat(0); }, u64(0x1122334455667788n, 0n))), Array(2).fill(0x1122334455667788n));
  // zero loads
  assert.deepEqual(rdU32(un((c) => { c.drop(); c.i32(A).v128load32zero(0); }, u32(0xaabbccdd, 1, 2, 3))), [0xaabbccdd, 0, 0, 0]);
  assert.deepEqual(rdU64(un((c) => { c.drop(); c.i32(A).v128load64zero(0); }, u64(0x1122334455667788n, 99n))), [0x1122334455667788n, 0n]);
  assert.deepEqual(rdU64(un((c) => { c.drop(); c.i32(0).v128load64zero(A + 8); }, u64(1n, 99n))), [99n, 0n]);
});

test('simd: load_lane / store_lane', () => {
  const base = u8(...Array.from({ length: 16 }, (_, i) => i));
  const mem = u8(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00);
  // load lane: stack (addr, v128)
  const ld = (emit) => {
    const { f, u8: m } = build((c) => { c.i32(R); c.i32(B); c.i32(A).v128load(0); emit(c); c.v128store(0); });
    m.set(base, A); m.set(mem, B); f();
    return m.slice(R, R + 16);
  };
  assert.deepEqual(rdU8(ld((c) => c.v128load8lane(0, 15))), [...Array.from({ length: 15 }, (_, i) => i), 0xaa]);
  assert.deepEqual(rdU8(ld((c) => c.v128load16lane(2, 0))).slice(0, 3), [0xcc, 0xdd, 2]);
  assert.deepEqual(rdU32(ld((c) => c.v128load32lane(0, 3)))[3], 0xddccbbaa);
  assert.deepEqual(rdU64(ld((c) => c.v128load64lane(0, 1)))[1], 0x2211ffeeddccbbaan);
  assert.deepEqual(rdU64(ld((c) => c.v128load64lane(8, 0)))[0], 0x0099887766554433n);
  // store lane: stack (addr, v128); result area pre-filled with 0xee to see what was untouched
  const st = (emit) => {
    const { f, u8: m } = build((c) => { c.i32(R); c.i32(A).v128load(0); emit(c); });
    m.set(mem, A); m.fill(0xee, R, R + 16); f();
    return m.slice(R, R + 16);
  };
  assert.deepEqual(rdU8(st((c) => c.v128store8lane(0, 2))).slice(0, 2), [0xcc, 0xee]);
  assert.deepEqual(rdU8(st((c) => c.v128store16lane(4, 1))).slice(0, 8), [0xee, 0xee, 0xee, 0xee, 0xcc, 0xdd, 0xee, 0xee]);
  assert.deepEqual(rdU32(st((c) => c.v128store32lane(0, 1))), [0x2211ffee, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee]);
  assert.deepEqual(rdU64(st((c) => c.v128store64lane(0, 0))), [0x2211ffeeddccbbaan, 0xeeeeeeeeeeeeeeeen]);
  assert.deepEqual(rdU64(st((c) => c.v128store64lane(8, 1))), [0xeeeeeeeeeeeeeeeen, 0x0099887766554433n]);
});

// ---------------------------------------------------------------- control flow with v128
test('simd: v128 locals, untyped select, if (result v128)', () => {
  // locals: get/set/tee with v128
  const { f, u8: m } = build((c) => {
    c.i32(A).v128load(0).set(2);           // v0 = a
    c.i32(B).v128load(0).tee(3).drop();    // v1 = b
    c.i32(R); c.get(2).get(3).i32x4add(); c.v128store(0);
    // untyped select: (v0, v1, cond)
    c.i32(R + 16); c.get(2).get(3).get(0).select(); c.v128store(0);
    // if (result v128)
    c.i32(R + 32); c.get(1); c.if_(T.v128); c.get(2); c.else_(); c.get(3); c.end(); c.v128store(0);
  }, { params: [T.i32, T.i32], locals: [T.v128, T.v128] });
  m.set(i32(1, 2, 3, 4), A); m.set(i32(10, 20, 30, 40), B);
  f(1, 0);
  assert.deepEqual(rdI32(m.slice(R, R + 16)), [11, 22, 33, 44]);
  assert.deepEqual(rdI32(m.slice(R + 16, R + 32)), [1, 2, 3, 4]);
  assert.deepEqual(rdI32(m.slice(R + 32, R + 48)), [10, 20, 30, 40]);
  f(0, 1);
  assert.deepEqual(rdI32(m.slice(R + 16, R + 32)), [10, 20, 30, 40]);
  assert.deepEqual(rdI32(m.slice(R + 32, R + 48)), [1, 2, 3, 4]);
});

// ---------------------------------------------------------------- encoding sanity
test('simd: ids >= 0x80 are two-byte LEB128, lane/const immediates are raw bytes', () => {
  const c = new Code();
  c.f32x4add();
  assert.deepEqual(Array.from(c.buf.subarray(0, c.len)), [0xfd, 0xe4, 0x01]);
  const c2 = new Code();
  c2.i32x4extractlane(3);
  assert.deepEqual(Array.from(c2.buf.subarray(0, c2.len)), [0xfd, 0x1b, 3]);
  const c3 = new Code();
  c3.v128load64zero(0x100);
  assert.deepEqual(Array.from(c3.buf.subarray(0, c3.len)), [0xfd, 0x5d, 3, 0x80, 0x02]);
  const c4 = new Code();
  c4.v128store64lane(8, 1);
  assert.deepEqual(Array.from(c4.buf.subarray(0, c4.len)), [0xfd, 0x5b, 3, 8, 1]);
  const c5 = new Code();
  c5.i64x2extmul_high_i32x4_u();
  assert.deepEqual(Array.from(c5.buf.subarray(0, c5.len)), [0xfd, 0xdf, 0x01]);
  const c6 = new Code();
  c6.f64x2convert_low_i32x4_u();
  assert.deepEqual(Array.from(c6.buf.subarray(0, c6.len)), [0xfd, 0xff, 0x01]);
});

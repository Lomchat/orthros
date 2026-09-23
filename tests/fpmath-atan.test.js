// Conformance of the pure-WASM atan2/atan kernels (src/cpu/jit/fpmath-atan.js) against
// JavaScript's Math.atan2 / Math.atan: every special-value combination (signed zeros,
// infinities, NaN, denormals, extreme magnitudes) bit-exactly where JS is exact, random sweeps
// with the oracle-suite criterion |got - want| <= tol * max(1, |got|, |want|) at tol = 1e-14
// (the maximum relative error observed is printed), and a timing loop (ns/call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';
import { addAtanKernels, BASES } from '../src/cpu/jit/fpmath-atan.js';

const TOL = 1e-14;

/** Build a module exporting atan2, atan and a benchmark loop; no imports at all (D004). */
function build() {
  const m = new ModuleBuilder();
  const { atan2, atan } = addAtanKernels(m);
  m.exportFunc('atan2', atan2);
  m.exportFunc('atan', atan);
  // bench(n, y, x, dy, dx) -> sum of atan2(y, x) over n iterations with y += dy, x += dx
  {
    const c = new Code();
    const [N, Y, X, DY, DX, ACC] = [0, 1, 2, 3, 4, 5];
    const L = c.loop();
    c.get(ACC).get(Y).get(X).call(atan2).f64add().set(ACC);
    c.get(Y).get(DY).f64add().set(Y);
    c.get(X).get(DX).f64add().set(X);
    c.get(N).i32(1).sub().tee(N).br_if(L);
    c.end();
    c.get(ACC);
    m.exportFunc('bench', m.func([T.i32, T.f64, T.f64, T.f64, T.f64], [T.f64], [T.f64], c, 'bench'));
  }
  const bytes = m.build();
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return { atan2: inst.exports.atan2, atan: inst.exports.atan, bench: inst.exports.bench, size: bytes.length };
}

const { atan2, atan, bench, size } = build();

/** relative error with the oracle-suite normalization */
const relErr = (got, want) => Math.abs(got - want) / Math.max(1, Math.abs(got), Math.abs(want));

/** compare with Math.atan2: bit-exact for NaN / zeros / infinities, relative tolerance otherwise */
function check(y, x, stats) {
  const got = atan2(y, x), want = Math.atan2(y, x);
  if (Number.isNaN(want)) { assert.ok(Number.isNaN(got), `atan2(${y}, ${x}) = ${got}, want NaN`); return; }
  if (want === 0 || !Number.isFinite(want)) { assert.ok(Object.is(got, want), `atan2(${y}, ${x}) = ${got} (${1 / got}), want ${want} (${1 / want})`); return; }
  const e = relErr(got, want);
  if (stats && e > stats.max) { stats.max = e; stats.at = [y, x, got, want]; }
  assert.ok(e <= TOL, `atan2(${y}, ${x}) = ${got}, want ${want}, rel err ${e}`);
}

function checkAtan(x, stats) {
  const got = atan(x), want = Math.atan(x);
  if (Number.isNaN(want)) { assert.ok(Number.isNaN(got), `atan(${x}) = ${got}, want NaN`); return; }
  if (want === 0 || !Number.isFinite(want)) { assert.ok(Object.is(got, want), `atan(${x}) = ${got}, want ${want}`); return; }
  const e = relErr(got, want);
  if (stats && e > stats.max) { stats.max = e; stats.at = [x, got, want]; }
  assert.ok(e <= TOL, `atan(${x}) = ${got}, want ${want}, rel err ${e}`);
}

// deterministic PRNG (xorshift128+) so a failure is reproducible
function rng(seed) {
  let s0 = BigInt(seed) * 0x9e3779b97f4a7c15n | 1n, s1 = 0xda942042e4dd58b5n;
  return () => {
    let x = s0, y = s1; s0 = y; x ^= (x << 23n) & 0xffffffffffffffffn; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x;
    return Number(((s0 + s1) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  };
}
const next = rng(20260920);
const sign = () => (next() < 0.5 ? -1 : 1);
const logUniform = (lo, hi) => sign() * Math.pow(10, lo + (hi - lo) * next());
const uniform = (lo, hi) => lo + (hi - lo) * next();
const denormal = () => sign() * Math.floor(next() * 2 ** 52) * Number.MIN_VALUE;

const report = (name, stats, n) => console.log(`[fpmath-atan] ${name}: n=${n} max rel err ${stats.max.toExponential(3)} (${(stats.max / 2 ** -52).toFixed(2)} ulp@1) at ${stats.at?.map((v) => String(v)).join(', ')}`);

test('atan table hi parts match Math.atan(k/8) and the quadrant bases', () => {
  for (let k = 0; k <= 8; k++) {
    const a = Math.atan(k / 8);
    const wants = [a, Math.PI / 2 - a, Math.PI - a, Math.PI / 2 + a];
    for (let q = 0; q < 4; q++) {
      const [hi, lo] = BASES[4 * k + q];
      assert.ok(Math.abs(hi - wants[q]) <= 2 * 2 ** -52 * Math.max(1, wants[q]), `BASES[${4 * k + q}] hi ${hi} vs ${wants[q]}`);
      assert.ok(Math.abs(lo) <= 2 ** -52 * Math.max(hi, 2 ** -60), `BASES[${4 * k + q}] lo ${lo} too large for hi ${hi}`);
    }
  }
  assert.ok(size < 4096, `module size ${size}`);
});

test('atan2 special values: signed zeros, infinities, NaN, denormals, extremes', () => {
  const specials = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 3, -3, Number.MIN_VALUE, -Number.MIN_VALUE,
    2.2250738585072014e-308, -2.2250738585072014e-308, 1e-300, -1e-300, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE,
    Math.PI, -Math.PI, 1e-10, -1e-10, 1e10, -1e10, 0.125, 0.1875, 0.9375, 1.0000000000000002, 0.9999999999999999];
  const stats = { max: 0, at: null };
  for (const y of specials) for (const x of specials) check(y, x, stats);
  // the exact-value table from the task, bit-exact
  const exact = [
    [0, 0, 0], [-0, 0, -0], [0, -0, Math.PI], [-0, -0, -Math.PI],
    [0, 2, 0], [-0, 2, -0], [0, -2, Math.PI], [-0, -2, -Math.PI],
    [Infinity, Infinity, Math.PI / 4], [-Infinity, Infinity, -Math.PI / 4], [Infinity, -Infinity, 3 * Math.PI / 4], [-Infinity, -Infinity, -3 * Math.PI / 4],
    [Infinity, 5, Math.PI / 2], [-Infinity, 5, -Math.PI / 2], [Infinity, -5, Math.PI / 2], [-Infinity, -5, -Math.PI / 2], [Infinity, 0, Math.PI / 2], [-Infinity, -0, -Math.PI / 2],
    [5, Infinity, 0], [-5, Infinity, -0], [5, -Infinity, Math.PI], [-5, -Infinity, -Math.PI], [0, -Infinity, Math.PI], [-0, Infinity, -0],
    [1e300, 1e-300, Math.PI / 2], [-1e300, 1e-300, -Math.PI / 2], [1e300, -1e-300, Math.PI / 2],
    [1e-300, 1e300, 0], [-1e-300, 1e300, -0], [1e-300, -1e300, Math.PI], [-1e-300, -1e300, -Math.PI],
    [3, 0, Math.PI / 2], [-3, 0, -Math.PI / 2], [3, -0, Math.PI / 2], [-3, -0, -Math.PI / 2],
    [1, 1, Math.PI / 4], [-1, 1, -Math.PI / 4], [1, -1, 3 * Math.PI / 4], [-1, -1, -3 * Math.PI / 4],
    [Number.MIN_VALUE, Number.MIN_VALUE, Math.PI / 4], [Number.MAX_VALUE, Number.MAX_VALUE, Math.PI / 4], [Number.MAX_VALUE, -Number.MAX_VALUE, 3 * Math.PI / 4],
    [Number.MIN_VALUE, 1, Number.MIN_VALUE], [-Number.MIN_VALUE, 1, -Number.MIN_VALUE], [1e-300, 1, 1e-300],
  ];
  for (const [y, x, want] of exact) {
    const got = atan2(y, x);
    assert.ok(Object.is(got, want), `atan2(${y}, ${x}) = ${got} (1/x=${1 / got}), want ${want}`);
    assert.ok(Object.is(Math.atan2(y, x), want) || relErr(Math.atan2(y, x), want) <= 2 ** -52, `oracle disagrees on atan2(${y}, ${x}): ${Math.atan2(y, x)} vs ${want}`);
  }
  // NaN pass-through: the NaN input comes back (y wins when both are NaN)
  const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
  const nanBits = (v) => { f64[0] = v; return u64[0]; };
  const qnanY = (() => { u64[0] = 0x7ff8000000001234n; return f64[0]; })();
  const qnanX = (() => { u64[0] = 0xfff8000000005678n; return f64[0]; })();
  assert.equal(nanBits(atan2(qnanY, 1)), 0x7ff8000000001234n);
  assert.equal(nanBits(atan2(1, qnanX)), 0xfff8000000005678n);
  assert.equal(nanBits(atan2(qnanY, qnanX)), 0x7ff8000000001234n);
  assert.ok(Number.isNaN(atan2(NaN, Infinity)) && Number.isNaN(atan2(0, NaN)) && Number.isNaN(atan2(NaN, -0)));
  // atan(1, huge): the tiny result must be accurate relatively (not just absolutely)
  for (const x of [1e300, 1e200, 1e100, 1e20, 4503599627370496, 1e308]) {
    const got = atan2(1, x), want = Math.atan2(1, x);
    assert.ok(Math.abs(got - want) <= 2 * 2 ** -52 * want, `atan2(1, ${x}) = ${got} want ${want}`);
    assert.ok(Math.abs(got - 1 / x) <= 2 * 2 ** -52 / x, `atan2(1, ${x}) = ${got} want ~${1 / x}`);
  }
  report('specials', stats, specials.length ** 2);
});

test('atan2 random sweeps (tol 1e-14, max relative error printed)', () => {
  const N = 200_000;
  const sweeps = {
    'log-uniform 1e-300..1e300, random signs': () => [logUniform(-300, 300), logUniform(-300, 300)],
    'uniform [-10, 10]': () => [uniform(-10, 10), uniform(-10, 10)],
    'y tiny (1e-320..1e-280), x huge (1e280..1e308)': () => [logUniform(-320, -280), logUniform(280, 308)],
    'y huge, x tiny': () => [logUniform(280, 308), logUniform(-320, -280)],
    'denormals both': () => [denormal(), denormal()],
    'denormal y, normal x': () => [denormal(), logUniform(-308, 308)],
    'near the diagonal |y| ~ |x|': () => { const x = logUniform(-300, 300); return [x * (1 + uniform(-1e-3, 1e-3)) * sign(), x]; },
    'ratio near the table boundaries': () => { const k = Math.floor(next() * 17) / 16; const x = logUniform(-100, 100); return [(k + uniform(-1e-12, 1e-12)) * x * sign(), x]; },
    'small ratio |y/x| in 1e-8..1/8 (k = 0 branch)': () => { const x = logUniform(-100, 100); return [x * logUniform(-8, Math.log10(0.125)), x]; },
  };
  let overall = 0;
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < N; i++) { const [y, x] = gen(); check(y, x, stats); }
    report(name, stats, N);
    overall = Math.max(overall, stats.max);
  }
  console.log(`[fpmath-atan] atan2 overall max rel err ${overall.toExponential(3)} (${(overall / 2 ** -52).toFixed(2)} ulp@1)`);
  assert.ok(overall <= TOL);
});

test('atan(x) whole real line, specials and random sweeps', () => {
  for (const x of [0, -0, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-300, -1e-300, 1, -1, 1e300, -1e300, Number.MAX_VALUE]) checkAtan(x);
  assert.ok(Object.is(atan(Infinity), Math.PI / 2) && Object.is(atan(-Infinity), -Math.PI / 2));
  assert.ok(Object.is(atan(0), 0) && Object.is(atan(-0), -0));
  assert.ok(Object.is(atan(1e-300), 1e-300) && Object.is(atan(-Number.MIN_VALUE), -Number.MIN_VALUE));
  assert.ok(Object.is(atan(1), Math.PI / 4) && Object.is(atan(-1), -Math.PI / 4));
  const N = 200_000;
  const sweeps = {
    'atan log-uniform 1e-300..1e300': () => logUniform(-300, 300),
    'atan uniform [-10, 10]': () => uniform(-10, 10),
    'atan uniform [-1, 1]': () => uniform(-1, 1),
    'atan denormals': () => denormal(),
  };
  let overall = 0;
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = { max: 0, at: null };
    for (let i = 0; i < N; i++) checkAtan(gen(), stats);
    report(name, stats, N);
    overall = Math.max(overall, stats.max);
  }
  console.log(`[fpmath-atan] atan overall max rel err ${overall.toExponential(3)} (${(overall / 2 ** -52).toFixed(2)} ulp@1)`);
  assert.ok(overall <= TOL);
});

test('timing: 1e7 atan2 calls from a WASM loop', () => {
  const n = 1e7;
  // warm-up (tier-up), then measure; arguments sweep through all quadrants and table entries
  bench(1e6, -3.7, 2.1, 7.4e-6, -4.2e-6);
  const t0 = process.hrtime.bigint();
  const acc = bench(n, -3.7, 2.1, 7.4e-6, -4.2e-6);
  const ns = Number(process.hrtime.bigint() - t0) / n;
  // the same sweep in JS for reference
  let y = -3.7, x = 2.1, ref = 0;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { ref += Math.atan2(y, x); y += 7.4e-6; x -= 4.2e-6; }
  const nsJs = Number(process.hrtime.bigint() - t1) / n;
  console.log(`[fpmath-atan] atan2: ${ns.toFixed(1)} ns/call (WASM loop, 1e7 calls); Math.atan2 in a JS loop: ${nsJs.toFixed(1)} ns/call; sums ${acc} vs ${ref}`);
  assert.ok(Math.abs(acc - ref) <= 1e-9 * Math.max(1, Math.abs(ref)), `sum mismatch ${acc} vs ${ref}`);
  assert.ok(ns < 1000, `atan2 too slow: ${ns} ns/call`);
});

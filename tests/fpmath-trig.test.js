// Conformance of the pure-WASM sin/cos/tan kernels (src/cpu/jit/fpmath-trig.js) against
// JavaScript's Math.sin / Math.cos / Math.tan (V8: ~1 ulp on the whole double range): special
// values (signed zeros, tiny arguments returned exactly, NaN), the quadrant boundaries (doubles
// nearest to k pi/2 and their neighbours), random sweeps with the oracle-suite criterion
// |got - want| <= tol * max(1, |got|, |want|) at tol = 1e-14 (the maximum observed error is
// printed), cross-checks of the two reduction paths, and timing loops (ns/call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';
import { addTrigKernels, PIO4, PIO2_LO, CW_LIMIT } from '../src/cpu/jit/fpmath-trig.js';

const TOL = 1e-14;

/** Build a module exporting the kernels and one benchmark loop per function; no imports (D004). */
function build() {
  const m = new ModuleBuilder();
  const k = addTrigKernels(m);
  for (const n of ['sin', 'cos', 'tan', 'sincos', 'reduce', 'reduce3', 'reduceLarge']) m.exportFunc(n, k[n]);
  // bench_f(n, x, dx) -> sum of f(x) over n iterations with x += dx (sincos: sum of both results)
  for (const n of ['sin', 'cos', 'tan', 'sincos']) {
    const c = new Code();
    const [N, X, DX, ACC] = [0, 1, 2, 3];
    const L = c.loop();
    c.get(ACC).get(X).call(k[n]); if (n === 'sincos') c.f64add(); c.f64add().set(ACC);
    c.get(X).get(DX).f64add().set(X);
    c.get(N).i32(1).sub().tee(N).br_if(L);
    c.end();
    c.get(ACC);
    m.exportFunc('bench_' + n, m.func([T.i32, T.f64, T.f64], [T.f64], [T.f64], c, 'bench_' + n));
  }
  const bytes = m.build();
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return { ...inst.exports, size: bytes.length };
}

const W = build();
const FN = { sin: [W.sin, Math.sin], cos: [W.cos, Math.cos], tan: [W.tan, Math.tan] };

const relErr = (got, want) => Math.abs(got - want) / Math.max(1, Math.abs(got), Math.abs(want));

const f64 = new Float64Array(1), u64 = new BigInt64Array(f64.buffer);
const nextUp = (x, n = 1) => { f64[0] = x; u64[0] += BigInt(n) * (x < 0 ? -1n : 1n); return f64[0]; };
const neighbours = (x, span) => { const out = []; for (let j = -span; j <= span; j++) { const y = nextUp(x, j); if (Number.isFinite(y)) out.push(y); } return out; };

/** check sin/cos/tan of x against Math with the relative criterion; stats[name] tracks the max */
function checkAll(x, stats) {
  for (const [name, [got_, want_]] of Object.entries(FN)) {
    const got = got_(x), want = want_(x);
    if (Number.isNaN(want)) { assert.ok(Number.isNaN(got), `${name}(${x}) = ${got}, want NaN`); continue; }
    const e = relErr(got, want);
    if (stats && e > stats[name].max) { stats[name].max = e; stats[name].at = [x, got, want]; }
    assert.ok(e <= TOL, `${name}(${x}) = ${got}, want ${want}, rel err ${e}`);
  }
}
const newStats = () => ({ sin: { max: 0, at: null }, cos: { max: 0, at: null }, tan: { max: 0, at: null } });
const report = (label, stats, n) => {
  for (const name of ['sin', 'cos', 'tan']) {
    const s = stats[name];
    console.log(`[fpmath-trig] ${label}: ${name} n=${n} max rel err ${s.max.toExponential(3)} (${(s.max / 2 ** -52).toFixed(2)} ulp@1) at ${s.at?.map(String).join(', ')}`);
  }
};
const merge = (a, b) => { for (const n of ['sin', 'cos', 'tan']) if (b[n].max > a[n].max) a[n] = b[n]; };

// deterministic PRNG (xorshift128+) so a failure is reproducible
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
const logUniform = (lo, hi) => sign() * Math.pow(10, lo + (hi - lo) * next());

test('special values: signed zeros, tiny arguments, NaN, no trap on infinities', () => {
  assert.ok(W.size < 8192, `module size ${W.size}`);
  assert.ok(Object.is(W.sin(0), 0) && Object.is(W.sin(-0), -0), 'sin(±0)');
  assert.ok(Object.is(W.tan(0), 0) && Object.is(W.tan(-0), -0), 'tan(±0)');
  assert.ok(W.cos(0) === 1 && W.cos(-0) === 1, 'cos(±0)');
  const tiny = [Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, 1e-300, -1e-300, 1e-100, 1e-30, -1e-20, 1e-10, -1e-9, 2 ** -27, -(2 ** -27), 1.4e-8, -(2 ** -26 * 0.999)];
  for (const x of tiny) {
    assert.ok(Object.is(W.sin(x), x), `sin(${x}) = ${W.sin(x)}`);
    assert.ok(Object.is(W.tan(x), x), `tan(${x}) = ${W.tan(x)}`);
    if (Math.abs(x) < 2 ** -27) assert.equal(W.cos(x), 1, `cos(${x})`);
  }
  // around the tiny thresholds the general path must agree with Math
  const stats = newStats();
  for (const b of [2 ** -27, 2 ** -26, 2 ** -25, 2 ** -20, 1e-5, 0.01]) for (const x of [...neighbours(b, 3), ...neighbours(-b, 3)]) checkAll(x, stats);
  assert.ok(Number.isNaN(W.sin(NaN)) && Number.isNaN(W.cos(NaN)) && Number.isNaN(W.tan(NaN)), 'NaN propagates');
  for (const x of [Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** 63, 2 ** 64, 1e308]) {
    for (const f of [W.sin, W.cos, W.tan, W.reduce]) assert.doesNotThrow(() => f(x));
  }
  report('tiny thresholds', stats, 6 * 14);
});

test('quadrant boundaries: doubles near k pi/2, 1e6, the Cody-Waite limit, 2^62, 2^63, 1e300', () => {
  const stats = newStats();
  let n = 0;
  // sin(Math.PI/2) = 1, cos(Math.PI/2) = 6.123e-17 (the reduction must resolve the tail of pi/2)
  assert.equal(W.sin(Math.PI / 2), 1);
  assert.equal(W.cos(Math.PI / 2), 6.123233995736766e-17);
  assert.equal(W.reduce(Math.PI / 2), -PIO2_LO);
  assert.equal(W.sin(Math.PI), 1.2246467991473532e-16);
  assert.equal(W.cos(Math.PI), -1);
  assert.equal(W.tan(Math.PI), -1.2246467991473532e-16);
  assert.equal(W.sin(3 * Math.PI / 2), -1);
  assert.equal(W.cos(2 * Math.PI), 1);
  for (const x of [Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI, Math.PI / 4, 3 * Math.PI / 4]) {
    for (const s of [1, -1]) for (const y of neighbours(s * x, 20)) { checkAll(y, stats); n++; }
  }
  // every multiple of pi/2 up to 4000 (Cody-Waite, all quadrants) and its neighbours
  for (let k = 1; k <= 4000; k++) {
    for (const y of neighbours(k * (Math.PI / 2), 2)) { checkAll(y, stats); checkAll(-y, stats); n += 2; }
    assert.ok(Math.abs(W.reduce(k * (Math.PI / 2))) <= PIO4 * (1 + 1e-9), `reduce(${k} pi/2) out of [-pi/4, pi/4]`);
  }
  // multiples of pi/2 with large k (Payne-Hanek) via the nearest double of k pi/2
  for (const k of [2 ** 20, 2 ** 21 + 1, 12345678901, 2 ** 40 + 3, 2 ** 52 - 1, 2 ** 60, 1e18, 1e25, 1e50, 1e100, 1e200, 1e300]) {
    for (const y of neighbours(k * (Math.PI / 2), 4)) { checkAll(y, stats); checkAll(-y, stats); n += 2; }
  }
  // 1e6 neighbours, the Cody-Waite / Payne-Hanek boundary, 2^62, the largest below 2^63, and beyond
  for (const x of [1e6, CW_LIMIT, 2 ** 20 * (Math.PI / 2), 2 ** 62, 2 ** 63 - 1024, 2 ** 63, 1e15, 1e100, 1e300, 2 ** 1023, Number.MAX_VALUE]) {
    for (const y of neighbours(x, 50)) { checkAll(y, stats); checkAll(-y, stats); n += 2; }
  }
  report('boundaries', stats, n);
});

test('the two reduction paths agree on [2^20, Cody-Waite limit)', () => {
  // both paths are valid there: the Cody-Waite pieces of pi/2 and the 2/pi word table are
  // independent constants, so agreement to an ulp of r cross-checks them
  let maxd = 0, n = 0;
  for (let i = 0; i < 50_000; i++) {
    const x = sign() * uniform(2 ** 20, CW_LIMIT);
    const [ah, al, aq] = W.reduce3(x), [bh, bl, bq] = W.reduceLarge(x);
    assert.equal(aq, bq, `quadrant mismatch at ${x}: ${aq} vs ${bq}`);
    const d = Math.abs((ah - bh) + (al - bl)) / Math.max(Math.abs(ah), 2 ** -60);
    if (d > maxd) maxd = d;
    assert.ok(d <= 2 ** -50, `reduction mismatch at ${x}: ${ah}+${al} vs ${bh}+${bl}`);
    n++;
  }
  // and the reduced argument is always within pi/4 (plus the rounding of k)
  for (let i = 0; i < 50_000; i++) {
    const x = logUniform(-1, 308);
    const [rh] = W.reduce3(x);
    assert.ok(Math.abs(rh) <= PIO4 * (1 + 1e-9), `reduce(${x}) = ${rh}`);
  }
  console.log(`[fpmath-trig] reduce vs reduceLarge on [2^20, ${CW_LIMIT}): n=${n} max relative difference ${maxd.toExponential(3)}`);
});

test('random sweeps (tol 1e-14, max relative error printed)', () => {
  const N = 200_000;
  const sweeps = {
    'uniform [-10, 10]': () => uniform(-10, 10),
    'uniform [-pi/4, pi/4] (no reduction)': () => uniform(-PIO4, PIO4),
    'uniform [-1e6, 1e6]': () => uniform(-1e6, 1e6),
    'uniform [-2^20 pi/2, 2^20 pi/2] (Cody-Waite edge)': () => uniform(-CW_LIMIT, CW_LIMIT),
    'uniform [1.6e6, 1e8] (small Payne-Hanek)': () => sign() * uniform(1.6e6, 1e8),
    'log-uniform 1e-8..1e15': () => logUniform(-8, 15),
    'log-uniform 1e15..1e100': () => logUniform(15, 100),
    'log-uniform 1e100..1e308': () => logUniform(100, 308),
    'uniform [-2^63, 2^63]': () => uniform(-(2 ** 63), 2 ** 63),
  };
  const overall = newStats();
  for (const [name, gen] of Object.entries(sweeps)) {
    const stats = newStats();
    for (let i = 0; i < N; i++) checkAll(gen(), stats);
    report(name, stats, N);
    merge(overall, stats);
  }
  for (const x of [1e300, -1e300, 2 ** 62, 2 ** 63 - 1024, 1e15, 1e100, 0, 1e6, -1e6]) checkAll(x, overall);
  report('OVERALL', overall, N * Object.keys(sweeps).length);
  for (const name of ['sin', 'cos', 'tan']) assert.ok(overall[name].max <= TOL);
});

test('sincos: bit-identical to sin and cos (specials, thresholds, random sweeps)', () => {
  const r = rng(7);
  const xs = [0, -0, Number.MIN_VALUE, 1e-300, 1e-9, 2 ** -27, -(2 ** -27), 2 ** -26.5, 2 ** -26, 1.4e-8, 0.5, PIO4, 1, 2, 3, 1e6, CW_LIMIT, 1e18, 2 ** 62, 2 ** 63, 1e300];
  for (const b of [2 ** -27, 2 ** -26, 1e-5, PIO4, Math.PI / 2, Math.PI]) xs.push(...neighbours(b, 3));
  for (let i = 0; i < 200_000; i++) {
    const k = r();
    xs.push((k < 0.4 ? r() * 10 : k < 0.7 ? r() * 1e6 : k < 0.9 ? 10 ** (-8 + 23 * r()) : 10 ** (15 + 285 * r())));
  }
  let n = 0;
  for (const x0 of xs) for (const x of [x0, -x0]) {
    const [s, c] = W.sincos(x);
    assert.ok(Object.is(s, W.sin(x)), `sincos(${x}).sin = ${s}, sin ${W.sin(x)}`);
    assert.ok(Object.is(c, W.cos(x)), `sincos(${x}).cos = ${c}, cos ${W.cos(x)}`);
    n++;
  }
  const [sn, cn] = W.sincos(NaN);
  assert.ok(Number.isNaN(sn) && Number.isNaN(cn), 'NaN propagates');
  for (const x of [Infinity, -Infinity, Number.MAX_VALUE]) assert.doesNotThrow(() => W.sincos(x));
  console.log(`[fpmath-trig] sincos: ${n} arguments bit-identical to sin/cos`);
});

test('timing: 1e7 calls from a WASM loop (small, medium, huge arguments)', () => {
  const n = 1e7;
  const cases = { 'small |x| < 10': [-10, 2e-6], 'medium ~1e6': [-1e6, 0.2], 'huge ~1e300': [1e300, 1e284] };
  for (const name of ['sin', 'cos', 'tan', 'sincos']) {
    const bench = W['bench_' + name], ref = name === 'sincos' ? (x) => Math.sin(x) + Math.cos(x) : FN[name][1];
    const lines = [];
    for (const [label, [x0, dx]] of Object.entries(cases)) {
      bench(1e6, x0, dx); // warm-up (tier-up)
      const t0 = process.hrtime.bigint();
      const acc = bench(n, x0, dx);
      const ns = Number(process.hrtime.bigint() - t0) / n;
      let x = x0, sum = 0;
      const t1 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) { sum += ref(x); x += dx; }
      const nsJs = Number(process.hrtime.bigint() - t1) / n;
      assert.ok(Math.abs(acc - sum) <= 1e-8 * Math.max(1, Math.abs(sum)) + 1e-6 * n * 1e-16, `${name} sum mismatch ${acc} vs ${sum}`);
      assert.ok(ns < 1000, `${name} too slow: ${ns} ns/call`);
      lines.push(`${label}: ${ns.toFixed(1)} ns/call (Math ${name}: ${nsJs.toFixed(1)})`);
    }
    console.log(`[fpmath-trig] ${name} timing, 1e7 calls: ${lines.join('; ')}`);
  }
});

// Adversarial verification of the native x87 transcendentals (verify_trans lens): the oracle
// suite tests/generated/verify_trans (tools/gen/gen_cases.py suite_verify_trans: domain edges,
// special values, condition codes, out-of-range trig, idiom sequences) is run through the
// interpreter and the JIT, then the two executors are compared bit for bit on what the oracle
// runner cannot see (signed zeros, NaN class, IE/ES, TOP/tags, exact ulp distance of the
// results), and the pure-WASM kernels are checked against reference values read off the native
// FPU (tools/gen/gen_cases.py probes, AMD EPYC 7402P) at the exact corner inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Conformance, runSuite, CODE, f80ToF64 } from './conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { ModuleBuilder, T } from '../src/cpu/jit/wasm.js';
import { addExpKernels, INDEFINITE_BITS } from '../src/cpu/jit/fpmath-exp.js';
import { addTrigKernels } from '../src/cpu/jit/fpmath-trig.js';
import { addAtanKernels } from '../src/cpu/jit/fpmath-atan.js';

const DIR = new URL('./generated/', import.meta.url).pathname;
const SUITE = 'verify_trans';
const HAVE_SUITE = fs.existsSync(`${DIR}${SUITE}.results.bin`);
const SHOW = +(process.env.SHOW_FAILURES || 8);
const SW_CC = 0x4500, SW_IE_ES = 0x81;

const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const bitsOf = (v) => { f64[0] = v; return u64[0]; };
const fromBits = (b) => { u64[0] = b; return f64[0]; };
/** ordered integer of a double: consecutive doubles differ by 1, -0 and +0 both map to 0 */
const ordered = (v) => { const u = bitsOf(v); return u >> 63n ? -(u & 0x7fffffffffffffffn) : u; };
const ulpDist = (a, b) => { const d = ordered(a) - ordered(b); return d < 0n ? -d : d; };

/**
 * Real stack faults only (SF in the oracle's status word): the shared isStackFaultCase also masks
 * IE, which the invalid-operand transcendental cases (FYL2X of 0/inf/negative...) set legitimately.
 */
function isRealStackFault(i, c) {
  if (!c.meta[i].fpu) return false;
  return (c.results.readUInt16LE(i * 2624 + 48 + 2) & 0x40) !== 0;
}

function makeInterp(mem, cpu) {
  const I = new Interp(mem, cpu);
  return { run(end) { I.cache.clear(); const r = I.run({ stopAt: end, maxInsns: 100000 }); this.lastFault = I.lastFault; return r; } };
}
function makeJit(mem, cpu) {
  const I = new Interp(mem, cpu);
  const jit = new Jit(mem, I);
  return {
    jit,
    run(end) {
      jit.reset(); I.cache.clear(); jit.boundaries = new Set([end]); jit.cpu = cpu;
      const r = jit.run({ stopAt: end, maxInsns: 100000 }); this.lastFault = jit.lastFault; return r;
    },
  };
}

test(`interp conformance: ${SUITE} (oracle, transcendental edges)`, { skip: !HAVE_SUITE && 'run make gen' }, () => {
  const res = runSuite(DIR, SUITE, makeInterp);
  if (res.failures.length) console.log(`${SUITE} interp: ${res.failures.length}/${res.total} failures\n${res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n')}`);
  assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches (interpreter)`);
});

test(`jit conformance: ${SUITE} (oracle, no fallback expected)`, { skip: !HAVE_SUITE && 'run make gen' }, () => {
  let exec;
  const res = runSuite(DIR, SUITE, (mem, cpu) => (exec = makeJit(mem, cpu)), { skip: isRealStackFault });
  if (res.failures.length) console.log(`${SUITE} jit: ${res.failures.length}/${res.total} failures\n${res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n')}`);
  assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches (JIT)`);
  const s = exec.jit.stats;
  console.log(`[verify-trans] jit: ${res.total} cases, ${res.skipped} skipped, native ${s.native} fallback ${s.fallback}`);
  assert.equal(s.fallback, 0, 'every transcendental must be translated natively');
});

/** State snapshot after a case: what the oracle runner compares plus the bits it ignores. */
function snapshot(c, exit) {
  const cpu = c.cpu;
  return {
    exit, eip: cpu.eip, regs: Array.from({ length: 8 }, (_, r) => cpu.reg(r)),
    top: cpu.fpuTop, tw: cpu.fpuTw, sw: cpu.fpuSw, cw: cpu.fpuCw,
    fpr: Array.from({ length: 8 }, (_, k) => cpu.fpr(k)),
  };
}

test(`${SUITE}: interpreter and JIT agree bit for bit on what the oracle runner ignores`, { skip: !HAVE_SUITE && 'run make gen' }, () => {
  const ci = new Conformance(DIR, SUITE), cj = new Conformance(DIR, SUITE);
  const ei = makeInterp(ci.mem, ci.cpu), ej = makeJit(cj.mem, cj.cpu);
  const diffs = [];
  let n = 0, zeros = 0, maxUlp = 0n, maxUlpAt = null;
  for (let i = 0; i < ci.count; i++) {
    if (isRealStackFault(i, ci)) continue;
    const asm = ci.meta[i].asm;
    const single = !asm.includes(';');
    const endI = ci.load(i).end; ci.cpu.eip = CODE; const a = snapshot(ci, ei.run(endI));
    const endJ = cj.load(i).end; cj.cpu.eip = CODE; const b = snapshot(cj, ej.run(endJ));
    n++;
    const d = [];
    if (a.exit !== b.exit || a.eip !== b.eip) d.push(`exit/eip ${a.exit}@${a.eip.toString(16)} vs ${b.exit}@${b.eip.toString(16)}`);
    for (let r = 0; r < 8; r++) if (a.regs[r] !== b.regs[r]) d.push(`reg${r} ${a.regs[r].toString(16)} vs ${b.regs[r].toString(16)}`);
    if (a.top !== b.top) d.push(`top ${a.top} vs ${b.top}`);
    if (a.tw !== b.tw) d.push(`tags ${a.tw.toString(2)} vs ${b.tw.toString(2)}`);
    if (a.cw !== b.cw) d.push(`cw ${a.cw.toString(16)} vs ${b.cw.toString(16)}`);
    // condition codes always; IE/ES for the single-instruction cases (the native arithmetic of a
    // sequence does not raise ZE/OE like the interpreter does: out of this lens)
    const m = SW_CC | (single ? SW_IE_ES : 0);
    if ((a.sw & m) !== (b.sw & m)) d.push(`sw ${(a.sw & m).toString(16)} vs ${(b.sw & m).toString(16)} (mask ${m.toString(16)})`);
    for (let k = 0; k < 8; k++) {
      if (!((a.tw >> k) & 1)) continue;
      const x = a.fpr[k], y = b.fpr[k];
      if (Number.isNaN(x) || Number.isNaN(y)) { if (!(Number.isNaN(x) && Number.isNaN(y))) d.push(`fpr${k} ${x} vs ${y}`); continue; }
      if (x === 0 || y === 0 || !Number.isFinite(x) || !Number.isFinite(y)) { if (!Object.is(x, y)) d.push(`fpr${k} ${x} (1/x ${1 / x}) vs ${y} (1/y ${1 / y})`); continue; }
      if (single) {
        // one kernel against one Math call: a few ulps at most (kernels ~1 ulp, V8 ~1 ulp)
        const u = ulpDist(x, y);
        if (u > maxUlp) { maxUlp = u; maxUlpAt = `#${i} ${asm}: ${x} vs ${y}`; }
        if (u > 8n) d.push(`fpr${k} ${x} vs ${y} (${u} ulp apart)`);
      } else if (Math.abs(x - y) > 1e-13 * Math.max(1, Math.abs(x), Math.abs(y))) d.push(`fpr${k} ${x} vs ${y}`);
    }
    // signs of zero results against the native FPU (the oracle runner's fpEqual treats 0 == -0)
    const rv = new DataView(ci.results.buffer, ci.results.byteOffset + i * 2624, 2624);
    const otop = (rv.getUint16(50, true) >> 11) & 7, otw = rv.getUint8(52);
    for (let k = 0; k < 8; k++) {
      const phys = (otop + k) & 7;
      if (!((otw >> phys) & 1)) continue;
      const want = f80ToF64(rv.getBigUint64(48 + 32 + 16 * k, true), rv.getUint16(48 + 40 + 16 * k, true));
      if (want !== 0) continue;
      zeros++;
      for (const [name, s] of [['interp', a], ['jit', b]]) if (!Object.is(s.fpr[phys], want)) d.push(`${name} st(${k}) ${s.fpr[phys]} (1/x ${1 / s.fpr[phys]}) vs hardware ${want} (1/x ${1 / want})`);
    }
    if (d.length) diffs.push(`#${i} ${asm}\n    ${d.join('\n    ')}`);
  }
  console.log(`[verify-trans] cross-check interp vs jit: ${n} cases, ${diffs.length} differences; ${zeros} zero results sign-checked against the FPU; max single-instruction distance ${maxUlp} ulp at ${maxUlpAt}`);
  if (diffs.length) console.log(diffs.slice(0, SHOW).join('\n'));
  assert.equal(diffs.length, 0);
});

// ---- the kernels alone, at the corner inputs whose hardware results were read off the oracle
function buildKernels() {
  const m = new ModuleBuilder();
  const k = { ...addExpKernels(m), ...addTrigKernels(m), ...addAtanKernels(m) };
  for (const n of ['exp2m1', 'log2', 'log2p1', 'scalb', 'sin', 'cos', 'tan', 'atan2']) m.exportFunc(n, k[n]);
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), {}).exports;
}
const K = buildKernels();
const INDEFINITE = fromBits(INDEFINITE_BITS);
/** got within `ulps` units of 2^-52 |want| (ulp@1 convention of the kernel tests; exact for specials) */
const within = (got, want, ulps, what) => {
  if (Number.isNaN(want)) { assert.ok(Number.isNaN(got), `${what}: ${got}, want NaN`); return; }
  if (want === 0 || !Number.isFinite(want)) { assert.ok(Object.is(got, want), `${what}: ${got} (1/x ${1 / got}), want ${want}`); return; }
  const u = Math.abs(got - want) / (Math.abs(want) < 2 ** -1022 ? Number.MIN_VALUE : 2 ** -52 * Math.abs(want)); // denormals: units of 2^-1074
  assert.ok(u <= ulps, `${what}: ${got}, want ${want} (${u.toFixed(2)} ulp@1 apart, allowed ${ulps})`);
};

test('kernels at the hardware-probed corners: F2XM1 / FYL2X / FYL2XP1', () => {
  // values the native FPU produced (f80 rounded to the nearest f64) for these exact inputs
  within(K.exp2m1(1 - 2 ** -53), 0.9999999999999999, 1, 'exp2m1(1 - 2^-53)');
  within(K.exp2m1(-(1 - 2 ** -53)), -0.49999999999999994, 1, 'exp2m1(-(1 - 2^-53))');
  within(K.exp2m1(2 ** -30), 6.455436169949115e-10, 1, 'exp2m1(2^-30)');
  within(K.exp2m1(1e-300), 6.931471805599453e-301, 1, 'exp2m1(1e-300)');
  within(K.exp2m1(0.5), 0.41421356237309503, 1, 'exp2m1(0.5)');
  within(K.exp2m1(-0.5), -0.2928932188134525, 1, 'exp2m1(-0.5)');
  assert.equal(K.exp2m1(1), 1); assert.equal(K.exp2m1(-1), -0.5);
  assert.ok(Object.is(K.exp2m1(Number.MIN_VALUE), Number.MIN_VALUE) && Object.is(K.exp2m1(-Number.MIN_VALUE), -Number.MIN_VALUE));
  assert.ok(Object.is(K.exp2m1(0), 0) && Object.is(K.exp2m1(-0), -0));
  within(K.log2(1 + 2 ** -52), 3.203426503814917e-16, 1, 'log2(1 + 2^-52)');
  within(K.log2(1 - 2 ** -53), -1.6017132519074588e-16, 1, 'log2(1 - 2^-53)');
  assert.equal(K.log2(2 ** -1074), -1074); assert.equal(K.log2(2 ** -1022), -1022); assert.equal(K.log2(2 ** 1023), 1023);
  within(1e300 * K.log2(1e300), 9.965784284662087e+302, 2, '1e300 log2(1e300)');
  assert.equal(K.log2(0), -Infinity); assert.equal(K.log2(Infinity), Infinity);
  assert.equal(bitsOf(K.log2(-1)), INDEFINITE_BITS); assert.equal(bitsOf(K.log2(-Infinity)), INDEFINITE_BITS);
  // FYL2X special products as the handler computes them (ST(1) * log2 ST(0)), signs of zero included
  assert.ok(Object.is(5 * K.log2(1), 0) && Object.is(-5 * K.log2(1), -0), 'y log2(1) keeps the sign of y');
  assert.equal(5 * K.log2(0), -Infinity); assert.equal(-5 * K.log2(0), Infinity); assert.equal(Infinity * K.log2(0), -Infinity);
  assert.ok(Number.isNaN(0 * K.log2(0)) && Number.isNaN(0 * K.log2(Infinity)) && Number.isNaN(Infinity * K.log2(1)));
  within(K.log2p1(2 ** -1074), 5e-324, 0, 'log2p1(2^-1074)');
  within(K.log2p1(1e-300), 1.4426950408889634e-300, 1, 'log2p1(1e-300)');
  within(K.log2p1(-(1 - Math.SQRT2 / 2)), -0.5, 1, 'log2p1(domain low edge)');
  within(K.log2p1(Math.SQRT2 - 1), 0.5, 1, 'log2p1(domain high edge)');
  assert.ok(Object.is(K.log2p1(0), 0) && Object.is(K.log2p1(-0), -0));
  assert.ok(Object.is(5 * K.log2p1(-0), -0) && Object.is(-5 * K.log2p1(0), -0), 'y log2p1(+-0) signs');
  assert.equal(K.log2p1(-0.5), -1); assert.equal(K.log2p1(1), 1); assert.equal(K.log2p1(3), 2); assert.equal(K.log2p1(7), 3);
});

test('kernels at the hardware-probed corners: FSCALE / FPATAN', () => {
  const inf = Infinity;
  // FSCALE table read off the oracle (a = ST(0), b = ST(1))
  const table = [[0, inf, INDEFINITE], [-0, inf, INDEFINITE], [inf, inf, inf], [-inf, inf, -inf], [3, inf, inf], [-3, inf, -inf],
    [0, -inf, 0], [3, -inf, 0], [-3, -inf, -0], [inf, -inf, INDEFINITE], [-inf, -inf, INDEFINITE],
    [1.5, 1e300, inf], [1.5, -1e300, 0], [1.5, 1023.9, 1.348269851146737e+308], [1.5, -1074.5, 1e-323], [1.5, -1075, 5e-324],
    [2 ** -1073, -1, 5e-324], [2 ** -1073, -2, 0], [1.5, 0.9, 1.5], [1.5, -0.9, 1.5], [1e308, 1, inf], [1e-308, -60, 0],
    [inf, 5, inf], [0, 5, 0], [-0, -5, -0], [5, 0, 5], [5, -0, 5], [1.0000000000000002 * 2 ** -1022, -1, 1.1125369292536007e-308],
    [3 * 2 ** -1074, -1, 1e-323], [5 * 2 ** -1074, -1, 1e-323]];
  for (const [a, b, want] of table) {
    const got = K.scalb(a, b);
    if (Number.isNaN(want)) assert.equal(bitsOf(got), INDEFINITE_BITS, `scalb(${a}, ${b}) = ${got}, want the indefinite`);
    else assert.ok(Object.is(got, want), `scalb(${a}, ${b}) = ${got} (1/x ${1 / got}), want ${want}`);
  }
  // NaN operands propagate (one NaN: that NaN, payload kept; both: indefinite)
  assert.equal(bitsOf(K.scalb(fromBits(0x7ff8000000000123n), 3)), 0x7ff8000000000123n);
  assert.equal(bitsOf(K.scalb(3, fromBits(0x7ff8000000000123n))), 0x7ff8000000000123n);
  assert.equal(bitsOf(K.scalb(NaN, NaN)), INDEFINITE_BITS);
  // FPATAN: the 7 x 7 special table (x = ST(0), y = ST(1)) matches the hardware = Math.atan2, signs of zero included
  const specials = [-inf, -2, -0, 0, 2, inf, NaN];
  for (const x of specials) for (const y of specials) {
    const got = K.atan2(y, x), want = Math.atan2(y, x);
    if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `atan2(${y}, ${x})`);
    else assert.ok(Object.is(got, want), `atan2(${y}, ${x}) = ${got} (1/x ${1 / got}), want ${want}`);
  }
  within(K.atan2(2, 1), 1.1071487177940904, 1, 'atan2(2, 1)');
  within(K.atan2(1, 2), 0.4636476090008061, 1, 'atan2(1, 2)');
});

test('trig kernels at the C2 threshold: every double below 2^63 yields a value, |v| <= 1', () => {
  const xs = [];
  for (let k = 0; k <= 64; k++) xs.push(2 ** 63 - 1024 * (k + 1));
  for (let i = 1; i <= 8; i++) xs.push(fromBits(bitsOf(2 ** 63) - BigInt(i)));
  xs.push(2 ** 62, 2 ** 61 * 1.5, 1e18, 3e17, 2 ** 52 + 1, 2 ** 53 - 1);
  let maxRel = 0;
  for (const x0 of xs) for (const x of [x0, -x0]) {
    const s = K.sin(x), c = K.cos(x), t = K.tan(x);
    assert.ok(Math.abs(s) <= 1 && Math.abs(c) <= 1 && Number.isFinite(t), `trig(${x}) = ${s}, ${c}, ${t}`);
    for (const [got, want] of [[s, Math.sin(x)], [c, Math.cos(x)], [t, Math.tan(x)]]) {
      const e = Math.abs(got - want) / Math.max(1, Math.abs(got), Math.abs(want));
      if (e > maxRel) maxRel = e;
      assert.ok(e <= 1e-14, `trig(${x}): ${got} vs Math ${want}`);
    }
    assert.ok(Math.abs(s * s + c * c - 1) <= 4e-16, `sin^2 + cos^2 at ${x}`);
  }
  console.log(`[verify-trans] trig below 2^63: ${xs.length * 2} arguments, max rel err vs Math ${maxRel.toExponential(2)}`);
  // hardware-probed values at 2^63 - 1024 are meaningless (66-bit pi): the emulator is the accurate one
  assert.ok(Math.abs(K.sin(2 ** 63 - 1024) - 0.989155581390811) < 1e-14);
});

test('FSCALE denormal results are rounded once by the kernel (hardware: once; interpreter: twice)', () => {
  // exact product 1.25 2^-1075 = 0.625 units of 2^-1074 -> hardware rounds up to 1 unit; the
  // interpreter's 2^-1000 stepping rounds 1.25 2^-1074 to 1 unit first, then halves to a tie
  // that rounds to 0 (src/cpu/interp-x87.js scalb(), not fixed here); the kernel rounds once
  assert.equal(K.scalb(1.25 * 2 ** -74, -1001), 5e-324);
  assert.equal(K.scalb(-1.25 * 2 ** -74, -1001), -5e-324);
  assert.equal(K.scalb(1.75 * 2 ** -60, -1015), 5e-324); // 0.875 units
  assert.equal(K.scalb(2 ** -1073, -2), 0); // exactly half a unit: ties to even
  assert.equal(K.scalb(3 * 2 ** -1074, -1), 1e-323); // 1.5 units -> 2 (even)
});

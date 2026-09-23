// Adversarial verification of the native x87 transcendentals (verify_trans lens): the oracle
// suites tests/generated/verify_trans (tools/gen/gen_cases.py suite_verify_trans: domain edges,
// special values, condition codes, out-of-range trig, idiom sequences) and verify_trans2
// (suite_verify_trans2, the hardware-truth pass after D034: control words with exceptions
// unmasked other than the one raised, FLDCW right before the instruction, initial condition
// codes on every path, NaN sign / significand choices, F2XM1 at 1 +- ulp, FYL2X zero divides,
// PC / RC on the transcendentals, f64 denormals without DE) are run through the interpreter and
// the JIT, then the two executors are compared bit for bit on what the oracle runner cannot see
// (signed zeros, NaN class, IE/ES, TOP/tags, exact ulp distance of the results), and the
// pure-WASM kernels are checked against reference values read off the native FPU
// (tools/gen/gen_cases.py probes, AMD EPYC 7402P) at the exact corner inputs. The measured gaps
// both executors still have (tools/gen/gen_cases.py suite_verify_trans_known, tagged) are
// reported by a todo test with their per-tag counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Conformance, runSuite, CODE, f80ToF64 } from './conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import { scalb as scalbInterp } from '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';
import { addExpKernels, INDEFINITE_BITS } from '../src/cpu/jit/fpmath-exp.js';
import { addTrigKernels } from '../src/cpu/jit/fpmath-trig.js';
import { addAtanKernels } from '../src/cpu/jit/fpmath-atan.js';
import { addNanKernels } from '../src/cpu/jit/fpmath-nan.js';

const DIR = new URL('./generated/', import.meta.url).pathname;
const SUITES = ['verify_trans', 'verify_trans2'];
const haveSuite = (suite) => fs.existsSync(`${DIR}${suite}.results.bin`);
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

for (const suite of SUITES) {
  test(`interp conformance: ${suite} (oracle, transcendental edges)`, { skip: !haveSuite(suite) && 'run make gen' }, () => {
    const res = runSuite(DIR, suite, makeInterp);
    if (res.failures.length) console.log(`${suite} interp: ${res.failures.length}/${res.total} failures\n${res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n')}`);
    assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches (interpreter)`);
  });

  test(`jit conformance: ${suite} (oracle, no fallback expected)`, { skip: !haveSuite(suite) && 'run make gen' }, () => {
    let exec;
    const res = runSuite(DIR, suite, (mem, cpu) => (exec = makeJit(mem, cpu)), { skip: isRealStackFault });
    if (res.failures.length) console.log(`${suite} jit: ${res.failures.length}/${res.total} failures\n${res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n')}`);
    assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches (JIT)`);
    const s = exec.jit.stats;
    console.log(`[verify-trans] jit: ${res.total} cases, ${res.skipped} skipped, native ${s.native} fallback ${s.fallback}`);
    assert.equal(s.fallback, 0, 'every transcendental must be translated natively');
  });

  /**
   * State snapshot after a case: what the oracle runner compares plus the bits it ignores. The
   * registers are captured as their 64-bit patterns (BigInt): a plain Array of doubles would let
   * V8 canonicalize a NaN on some of its store paths (double-element arrays cannot hold the hole
   * pattern; which path runs depends on the tier and IC state), which showed up as a spurious
   * 0x7ff8000000000000 vs payload-NaN difference in about one run out of seven (verify_trans2
   * #952, FSCALE of two NaNs: both executors hold the oracle's bits).
   */
  function snapshot(c, exit) {
    const cpu = c.cpu;
    return {
      exit, eip: cpu.eip, regs: Array.from({ length: 8 }, (_, r) => cpu.reg(r)),
      top: cpu.fpuTop, tw: cpu.fpuTw, sw: cpu.fpuSw, cw: cpu.fpuCw,
      fprBits: Array.from({ length: 8 }, (_, k) => bitsOf(cpu.fpr(k))),
      fpr(k) { return fromBits(this.fprBits[k]); },
    };
  }

  test(`${suite}: interpreter and JIT agree bit for bit on what the oracle runner ignores`, { skip: !haveSuite(suite) && 'run make gen' }, () => {
    const ci = new Conformance(DIR, suite), cj = new Conformance(DIR, suite);
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
        const x = a.fpr(k), y = b.fpr(k);
        // NaN results bit for bit: the indefinite for invalid operands, the propagated (quieted) operand NaN (D034)
        if (Number.isNaN(x) || Number.isNaN(y)) { if (a.fprBits[k] !== b.fprBits[k]) d.push(`fpr${k} ${x} (0x${a.fprBits[k].toString(16)}) vs ${y} (0x${b.fprBits[k].toString(16)})`); continue; }
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
        for (const [name, s] of [['interp', a], ['jit', b]]) if (!Object.is(s.fpr(phys), want)) d.push(`${name} st(${k}) ${s.fpr(phys)} (1/x ${1 / s.fpr(phys)}) vs hardware ${want} (1/x ${1 / want})`);
      }
      if (d.length) diffs.push(`#${i} ${asm}\n    ${d.join('\n    ')}`);
    }
    console.log(`[verify-trans] cross-check interp vs jit: ${n} cases, ${diffs.length} differences; ${zeros} zero results sign-checked against the FPU; max single-instruction distance ${maxUlp} ulp at ${maxUlpAt}`);
    if (diffs.length) console.log(diffs.slice(0, SHOW).join('\n'));
    assert.equal(diffs.length, 0);
  });
}

// The gaps both executors still have against the oracle machine, tagged in
// tools/gen/gen_cases.py suite_verify_trans_known (generated on demand: python3
// tools/gen/gen_cases.py --suite verify_trans_known --count 600 --out tests/generated). The
// todo reports the per-tag failure counts of both executors; it passes only once a tag is fixed
// in both and removed from the suite. Tags (D034 review): cc-preserved (trig keeps C0/C3),
// precision-flag (PE / DE / OE / UE), fyl2xp1-outside-domain (x <= -1 gives ST(0) back),
// unmasked-abort (an unmasked IE / ZE / stack fault aborts the instruction: no result, no
// push / pop, the SNaN not quieted, ES and B set), stack-overflow-push (FSINCOS / FPTAN with
// ST(7) occupied: the overflow pre-empts the argument, the indefinite lands in ST(1) too),
// unmasked-post-computation (PE / OE / UE unmasked: flag + ES with the result written, the
// exponent wrapped by 24576 for OE / UE).
const KNOWN = 'verify_trans_known';
test(`${KNOWN}: per-tag gaps of both executors against the oracle (informational)`, { skip: !haveSuite(KNOWN) && 'not generated', todo: 'measured hardware gaps, not modelled (see suite_verify_trans_known)' }, () => {
  const meta = JSON.parse(fs.readFileSync(`${DIR}${KNOWN}.meta.json`, 'utf8'));
  const tags = [...new Set(meta.map((m) => m.tag ?? '-'))];
  const report = [];
  let total = 0;
  const conf = new Conformance(DIR, KNOWN); // the oracle status words, for the SF cases the JIT skips
  for (const [name, make, opts] of [['interp', makeInterp, {}], ['jit', makeJit, { skip: isRealStackFault }]]) {
    const res = runSuite(DIR, KNOWN, make, opts);
    const fail = new Map(), seen = new Map();
    for (let i = 0; i < meta.length; i++) { if (opts.skip && isRealStackFault(i, conf)) continue; const t = meta[i].tag ?? '-'; seen.set(t, (seen.get(t) ?? 0) + 1); }
    for (const f of res.failures) { const t = meta[f.i].tag ?? '-'; fail.set(t, (fail.get(t) ?? 0) + 1); }
    total += res.failures.length;
    report.push(`${name}: ${res.failures.length}/${res.total} (${res.skipped} SF skipped) ` + tags.map((t) => `${t} ${fail.get(t) ?? 0}/${seen.get(t) ?? 0}`).join(', '));
  }
  console.log(`[verify-trans] ${KNOWN}:\n  ${report.join('\n  ')}`);
  assert.equal(total, 0, `${KNOWN}: ${total} known gaps remain`);
});

// ---- the kernels alone, at the corner inputs whose hardware results were read off the oracle
const KMEM = new WebAssembly.Memory({ initial: 1, maximum: 1 });
function buildKernels() {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, 1);
  const k = { ...addExpKernels(m), ...addTrigKernels(m), ...addAtanKernels(m), ...addNanKernels(m) };
  for (const n of ['exp2m1', 'log2', 'log2p1', 'scalb', 'sin', 'cos', 'tan', 'atan2']) m.exportFunc(n, k[n]);
  // nan2 through memory: the JS -> WASM call boundary quiets SNaNs (as the x87 handlers only ever
  // read their operands from memory / locals, the kernel is tested the same way), result as bits
  const c = new Code();
  c.get(0).f64load(0, 0).get(1).f64load(0, 0).call(k.nan2).set(2).i64reinterpret_f64().get(2);
  m.exportFunc('nan2_bits', m.func([T.i32, T.i32], [T.i64, T.i32], [T.i32], c, 'nan2_bits'));
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory: KMEM } }).exports;
}
const K = buildKernels();
/** nan2(a, b) with the operands written to the kernel memory as bits (BigInt) or values */
function nan2(a, b) {
  const dv = new DataView(KMEM.buffer);
  for (const [off, v] of [[0, a], [8, b]]) { if (typeof v === 'bigint') dv.setBigUint64(off, v, true); else dv.setFloat64(off, v, true); }
  const [bits, ie] = K.nan2_bits(0, 8);
  return [BigInt.asUintN(64, bits), ie];
}
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
  // NaN operands of the kernel alone (the FSCALE handler applies the x87 rule through nan2 instead)
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

test('FSCALE denormal results are rounded once by the kernel and the interpreter (hardware: once)', () => {
  // exact product 1.25 2^-1075 = 0.625 units of 2^-1074 -> the hardware rounds up to 1 unit; the
  // interpreter's former 2^-1000 stepping rounded 1.25 2^-1074 to 1 unit first, then halved to a
  // tie that rounds to 0; both the kernel and src/cpu/interp-x87.js scalb() now round once
  for (const [name, f] of [['kernel', K.scalb], ['interpreter', scalbInterp]]) {
    assert.equal(f(1.25 * 2 ** -74, -1001), 5e-324, name);
    assert.equal(f(-1.25 * 2 ** -74, -1001), -5e-324, name);
    assert.equal(f(1.75 * 2 ** -60, -1015), 5e-324, name); // 0.875 units
    assert.equal(f(2 ** -1073, -2), 0, name); // exactly half a unit: ties to even
    assert.equal(f(3 * 2 ** -1074, -1), 1e-323, name); // 1.5 units -> 2 (even)
    assert.equal(f(1.5, -1075), 5e-324, name); assert.equal(f(1.5, 1023), 1.348269851146737e+308, name); assert.equal(f(1.5, 1024), Infinity, name);
    assert.equal(f(1e-308, -60), 0, name); assert.equal(f(1e308, 1), Infinity, name); assert.equal(f(2 ** -1074, 2200), Infinity, name); assert.equal(f(-1.5, -2200), -0, name);
  }
});

// The x87 NaN-operand rule as measured on the hardware (tools/gen/verify_trans_probe.py):
// nan2(a, b) -> (result, ie)
test('nan2 kernel: SNaN quieted with IE, QNaN sign and payload kept, larger significand of two (positive on a tie), indefinite otherwise', () => {
  const sN1 = 0x7ff0000000000001n, sN2 = 0x7ff0000000000002n, nsN1 = 0xfff0000000000001n, qN = 0x7ff8000000000000n, nqN = 0xfff8000000000000n;
  const q1 = 0x7ff8000000000001n, q2 = 0x7ff8000000000002n, nq1 = 0xfff8000000000001n, nq2 = 0xfff8000000000002n;
  const table = [ // [a, b, result, ie]
    [sN1, 3, q1, 1], [3, sN1, q1, 1], [nsN1, 3, 0xfff8000000000001n, 1], [qN, 3, qN, 0], [3, nqN, nqN, 0], [q1, 3, q1, 0], [3, q1, q1, 0],
    [q1, q2, q2, 0], [q2, q1, q2, 0], [qN, nqN, qN, 0], [nqN, qN, qN, 0], [q1, nq1, q1, 0], [nq1, q1, q1, 0], [nq1, nq2, nq2, 0], [nq2, nq1, nq2, 0], [nqN, nqN, nqN, 0], [nq2, q1, nq2, 0], [q1, nq2, nq2, 0],
    [sN1, qN, qN, 1], [qN, sN1, qN, 1], [sN2, q1, q1, 1], [q1, sN2, q1, 1], [sN1, sN2, q2, 1], [sN2, sN1, q2, 1], [nsN1, q1, q1, 1], [q1, nsN1, q1, 1],
    [sN1, 0, q1, 1], [0, sN1, q1, 1], [qN, 0, qN, 0], [qN, Infinity, qN, 0], [Infinity, qN, qN, 0], [-2, q1, q1, 0], [q1, -2, q1, 0], [0, nq1, nq1, 0],
    [0, 0, INDEFINITE_BITS, 1], [Infinity, -Infinity, INDEFINITE_BITS, 1], [1, 2, INDEFINITE_BITS, 1],
  ];
  for (const [a, b, want, ie] of table) {
    const [r, flag] = nan2(a, b);
    const tag = `nan2(${typeof a === 'bigint' ? '0x' + a.toString(16) : a}, ${typeof b === 'bigint' ? '0x' + b.toString(16) : b})`;
    assert.equal(r, want, `${tag} = 0x${r.toString(16)}, want 0x${want.toString(16)}`);
    assert.equal(flag, ie, `${tag}: IE`);
  }
});

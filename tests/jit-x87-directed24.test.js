// x87 arithmetic under 24-bit precision with a directed rounding (control words 0x047f down, 0x087f up, 0x0c7f toward
// zero) in regions specialized for the mode (translate-x87.js roundDirected24: the 24-bit cut in a vector register,
// one cold tail for everything but normal results off the grid or exact on it, no NaN test of its own in the caller).
// Every operation and operand form over operand pairs chosen for each outcome — results off the 24-bit grid, exactly
// on it (float products and quotients, small integers, exact sums), on it but inexact (a sum whose f64 rounding lands
// on a grid point: the exact value is just beside it), zeros (x - x: +0, or -0 when rounding down), denormal, infinite
// and NaN results, infinite and NaN operands, division by zero, square roots — against the reference interpreter:
// every register image and the status word's condition codes / TOP, whole runs and time slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, VALS = DATA, OUT = DATA + 0x4000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const MODES = [0x047f, 0x087f, 0x0c7f];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** operand pairs [a, b] (a is ST(0) / the first operand, b the second) chosen per outcome */
function pairs() {
  const R = rng(7), P = [];
  const f = Math.fround, rnd53 = () => (R() - 0.5) * 2 ** Math.floor(R() * 40 - 20);
  for (let i = 0; i < 24; i++) P.push([rnd53(), rnd53()]); // off the grid
  for (let i = 0; i < 16; i++) P.push([f(rnd53()), f(rnd53())]); // floats: products / quotients exact on the grid or off it
  for (let i = 0; i < 8; i++) P.push([Math.round(R() * 1000) - 500, Math.round(R() * 64) - 32]); // small integers: on the grid
  P.push([1, -(2 ** -60)], [1, 2 ** -60], [-1, 2 ** -60], [-1, -(2 ** -60)], [2 ** 30, -0.25 * 2 ** -30], [f(1.5), 2 ** -55]); // inexact sums landing on the grid
  P.push([1 + 2 ** -23, -(1 + 2 ** -23)], [3.5, 3.5], [-2, -2], [0, 0], [-0, 0], [0, -0], [5, 0], [0, 5]); // zeros (x - x, x + -x, 0 * y)
  P.push([2 ** -1000, 2 ** -60], [-(2 ** -1020), 2 ** -10], [2 ** -1022, 0.5]); // denormal products / quotients
  P.push([1e300, 1e10], [-1e300, 1e300], [Number.MAX_VALUE, 2]); // overflow
  P.push([Infinity, 2], [-Infinity, Infinity], [NaN, 1], [1, NaN], [Infinity, 0], [0, 0.5], [1, 0], [-3, 0]); // inf, NaN, 0 / x, x / 0
  P.push([Number.MAX_VALUE, -Number.MAX_VALUE * 0.5], [2 ** -1022, -(2 ** -1023)]); // the ends of the f64 normal range
  return P;
}

/**
 * For each pair and each form: fld m64 b ; fld m64 a ; <op> ; the stack stored as m64 ; then the m32 / m-int forms
 * with the second operand from memory, FSQRT of a, and the popping forms. Returns the code.
 */
function program(P) {
  const b = [];
  let out = OUT;
  const fld = (k) => b.push(0xdd, 0x05, ...le(VALS + 8 * k)); // fld m64
  const stp = () => { b.push(0xdd, 0x1d, ...le(out)); out += 8; }; // fstp m64
  P.forEach((_, i) => {
    const ka = 2 * i, kb = 2 * i + 1;
    for (const op of [0, 1, 4, 5, 6, 7]) {
      fld(kb); fld(ka); b.push(0xd8, 0xc1 | (op << 3)); stp(); stp(); // fop st(0), st(1)
      fld(kb); fld(ka); b.push(0xdc, 0xc1 | (op << 3)); stp(); stp(); // fop st(1), st(0)
      fld(kb); fld(ka); b.push(0xde, 0xc1 | (op << 3)); stp(); // fopp st(1), st(0)
      fld(ka); b.push(0xdc, (op << 3) | 5, ...le(VALS + 8 * kb)); stp(); // fop m64
      fld(ka); b.push(0xd8, (op << 3) | 5, ...le(VALS + 0x2000 + 4 * kb)); stp(); // fop m32 (b as a float)
      fld(ka); b.push(0xda, (op << 3) | 5, ...le(VALS + 0x3000 + 4 * kb)); stp(); // fiop m32 (b as an integer)
    }
    fld(ka); b.push(0xd9, 0xfa); stp(); // fsqrt
    fld(ka); b.push(0xd9, 0xe8, 0xde, 0xe9, 0xd9, 0xfa); stp(); // fld1 ; fsubp (1 - a... a - 1) ; fsqrt
  });
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return { code: Uint8Array.from(b), outLen: out - OUT };
}

function exec(useJit, code, outLen, P, cw, slice = 1e7) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  cpu.reset();
  P.forEach(([a, b], i) => {
    mem.writeF64(VALS + 16 * i, a); mem.writeF64(VALS + 16 * i + 8, b);
    mem.writeF32(VALS + 0x2000 + 4 * (2 * i + 1), b);
    mem.write32(VALS + 0x3000 + 4 * (2 * i + 1), Number.isFinite(b) ? Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(b))) | 0 : 7);
  });
  mem.writeBytes(CODE, code);
  mem.write16(cpu.base + ST.FPU_CW, cw);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
  const end = CODE + code.length - 1;
  let r, jit = null;
  if (useJit) {
    jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]);
    let n = 0;
    do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e7);
  } else r = I.run({ stopAt: end, maxInsns: 1e7 });
  assert.equal(r, EXIT.HALT);
  return { out: Buffer.from(mem.bytes(OUT, outLen)).toString('hex'), sw: cpu.eax & 0x7d00, jit };
}

test('24-bit directed rounding: every arithmetic form over off-grid, on-grid, inexact-on-grid, zero, denormal, inf and NaN outcomes matches the interpreter', () => {
  const P = pairs(), { code, outLen } = program(P);
  for (const cw of MODES) {
    const want = exec(false, code, outLen, P, cw);
    const got = exec(true, code, outLen, P, cw);
    if (got.out !== want.out) {
      const n = got.out.length / 16;
      for (let k = 0; k < n; k++) {
        const g = got.out.slice(16 * k, 16 * k + 16), w = want.out.slice(16 * k, 16 * k + 16);
        assert.equal(g, w, `cw ${cw.toString(16)}: result #${k} differs`);
      }
    }
    assert.equal(got.sw, want.sw, `cw ${cw.toString(16)}: status word`);
    // the rare outcomes left the region for the interpreter (EXIT_STEP), the common ones did not
    assert.ok((got.jit.stats.steps ?? 0) > 0, 'some outcomes went to the interpreter');
    assert.ok((got.jit.stats.steps ?? 0) < outLen / 8 / 4, `most results are rounded inline (steps ${got.jit.stats.steps})`);
  }
});

test('24-bit directed rounding: time slices of every length through the same sequences', () => {
  const P = pairs().slice(0, 40), { code, outLen } = program(P);
  for (const cw of MODES) {
    const want = exec(false, code, outLen, P, cw);
    for (const slice of [1, 2, 3, 5, 8, 13]) {
      const got = exec(true, code, outLen, P, cw, slice);
      assert.equal(got.out, want.out, `cw ${cw.toString(16)} slice ${slice}`);
      assert.equal(got.sw, want.sw, `cw ${cw.toString(16)} slice ${slice}: status word`);
    }
  }
});

test('24-bit directed rounding in a loop: a truncating recurrence with branches on its sign matches the interpreter', () => {
  // fld m64 x0 ; mov ecx, 300 ; L: fmul m32 [k] ; fadd m64 [d] ; fcom m32 [zero] ; fnstsw ax ; sahf ; jae P ; fchs ; P:
  // fld st(0) ; fsqrt ; fstp m64 [out + 8 * (ecx & 7)]... (kept simple: fstp m64 [out]) ; dec ecx ; jnz L ; fstp m64 [out+8] ; hlt
  const X0 = VALS, K = VALS + 8, D = VALS + 16, Z = VALS + 24;
  const body = [0xd8, 0x0d, ...le(K), 0xdc, 0x05, ...le(D), 0xd8, 0x15, ...le(Z), 0xdf, 0xe0, 0x9e, 0x73, 0x02, 0xd9, 0xe0,
    0xd9, 0xc0, 0xd9, 0xfa, 0xdd, 0x1d, ...le(OUT), 0x49];
  const code = Uint8Array.from([0xdd, 0x05, ...le(X0), 0xb9, ...le(300), ...body, 0x0f, 0x85, ...le(-(body.length + 6)), 0xdd, 0x1d, ...le(OUT + 8), 0xdf, 0xe0, 0xf4]);
  for (const [x0, k, d] of [[1.1, Math.fround(-0.7), -0.3], [3, Math.fround(0.5), 1 / 3], [0.001, Math.fround(-1.25), 1e-7]]) {
    for (const cw of MODES) {
      const run = (useJit, slice) => {
        const mem = new GuestMemory();
        const cpu = new CpuState(mem, THREAD_STATES_BASE);
        const I = new Interp(mem, cpu);
        cpu.reset();
        mem.writeF64(X0, x0); mem.writeF32(K, k); mem.writeF64(D, d); mem.writeF32(Z, 0);
        mem.writeBytes(CODE, code);
        mem.write16(cpu.base + ST.FPU_CW, cw);
        cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
        const end = CODE + code.length - 1;
        let r;
        if (useJit) { const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE); }
        else r = I.run({ stopAt: end, maxInsns: 1e7 });
        assert.equal(r, EXIT.HALT);
        return [mem.readF64(OUT), mem.readF64(OUT + 8), cpu.eax & 0x7d00].map((v) => Object.is(v, -0) ? '-0' : String(v)).join(' ');
      };
      const want = run(false);
      for (const slice of [1e7, 7, 1]) assert.equal(run(true, slice), want, `x0 ${x0} k ${k} d ${d} cw ${cw.toString(16)} slice ${slice}`);
    }
  }
});

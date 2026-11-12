// Narrow x87 values (translate-x87.js narrow / Emitter.g24Mask: registers known to hold a value whose significand fits in
// 24 bits — m32 operands, FLD1 / FLDZ, 16-bit integers, results of 24-bit precision arithmetic, their copies) and the
// toward-zero rounding that relies on them (roundTowardZero24: integer tests on the result's bits, a product or quotient
// of two narrow operands masked without the grid test). Randomized x87 programs — loads of every width, arithmetic in
// every operand form, FXCH, FST / FSTP ST(i), FCHS / FABS / FSQRT, block boundaries in the middle, values of every
// exponent (float denormals, the ends of the float and double ranges, products chained past both ends), zeros,
// infinities and NaNs — run by the JIT under every rounding control at 24-bit precision (and at 53 / 64 bits, where the
// tracking must change nothing) against the reference interpreter: every value stored, the condition codes and TOP,
// whole runs and time slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { depth } from './depth.js';

const CODE = 0x20000000, DATA = 0x10000000, T32 = DATA, T64 = DATA + 0x1000, T16 = DATA + 0x2000, TI32 = DATA + 0x3000, OUT = DATA + 0x8000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const MODES = [0x0c7f, 0x047f, 0x087f, 0x007f, 0x027f, 0x037f, 0x0f7f];
const N_TAB = 64;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** operand tables: floats of every exponent and the special values, doubles, 16- and 32-bit integers */
function tables(R) {
  const f = Math.fround;
  const floats = [0, -0, 1, -1, 0.5, 3, 1e30, -1e30, 3.4e38, -3.4e38, f(3.4028234663852886e38), 1.1754943508222875e-38, 1e-38, 1e-45, -1.401298464324817e-45,
    f(1 / 3), f(-2 / 3), Infinity, -Infinity, NaN, 2 ** 100, 2 ** -100, f(1 + 2 ** -23), f(-(2 - 2 ** -23)), 1024, -7, 65536, 2 ** 24 + 2];
  while (floats.length < N_TAB) floats.push(f((R() - 0.5) * 2 ** Math.floor(R() * 120 - 60)));
  const doubles = [0, 1, -1, 0.1, 1 / 3, 2 ** -1022, 2 ** -1021 * 1.5, 1e300, -1e-300, Number.MAX_VALUE, Infinity, NaN, 1 + 2 ** -52];
  while (doubles.length < N_TAB) doubles.push(R() < 0.3 ? f((R() - 0.5) * 2 ** Math.floor(R() * 60 - 30)) : (R() - 0.5) * 2 ** Math.floor(R() * 200 - 100));
  const i16 = [0, 1, -1, 7, -32768, 32767, 1000];
  while (i16.length < N_TAB) i16.push(Math.floor(R() * 65536) - 32768);
  const i32 = [0, 1, -1, 0x7fffffff, -0x80000000, 16777217, 123456789];
  while (i32.length < N_TAB) i32.push((R() * 2 ** 32) | 0);
  return { floats, doubles, i16, i32 };
}

/** a random x87 program over the tables: the stack kept 1..6 deep, every value stored at the end */
function program(R) {
  const b = [];
  let depth = 0, out = OUT;
  const pick = (n) => Math.floor(R() * n);
  const tab = (base, size) => le(base + size * pick(N_TAB));
  const OPS = [0, 1, 4, 5, 6, 7];
  for (let n = 0; n < 60; n++) {
    const r = R();
    if (depth === 0 || (depth < 6 && r < 0.3)) { // a push
      const k = pick(7);
      if (k === 0 || k === 1) b.push(0xd9, 0x05, ...tab(T32, 4)); // fld m32
      else if (k === 2) b.push(0xdd, 0x05, ...tab(T64, 8)); // fld m64
      else if (k === 3) b.push(0xdf, 0x05, ...tab(T16, 2)); // fild m16
      else if (k === 4) b.push(0xdb, 0x05, ...tab(TI32, 4)); // fild m32
      else if (k === 5) b.push(0xd9, R() < 0.5 ? 0xe8 : 0xee); // fld1 / fldz
      else if (depth) b.push(0xd9, 0xc0 + pick(depth)); // fld st(i)
      else b.push(0xd9, 0x05, ...tab(T32, 4));
      depth++;
      continue;
    }
    const op = OPS[pick(OPS.length)];
    if (r < 0.55) { // a memory operand
      const k = pick(4);
      b.push([0xd8, 0xdc, 0xde, 0xda][k], (op << 3) | 5, ...[tab(T32, 4), tab(T64, 8), tab(T16, 2), tab(TI32, 4)][k]);
    } else if (r < 0.75 && depth >= 2) { // two registers
      const i = 1 + pick(depth - 1), form = pick(3);
      b.push([0xd8, 0xdc, 0xde][form], 0xc0 + (op << 3) + i);
      if (form === 2) depth--;
    } else if (r < 0.8 && depth >= 2) b.push(0xd9, 0xc8 + 1 + pick(depth - 1)); // fxch
    else if (r < 0.85 && depth >= 2) { const pop = R() < 0.5; b.push(0xdd, (pop ? 0xd8 : 0xd0) + 1 + pick(depth - 1)); if (pop) depth--; } // fst(p) st(i)
    else if (r < 0.9) b.push(0xd9, [0xe0, 0xe1, 0xfa][pick(3)]); // fchs / fabs / fsqrt
    else if (r < 0.95) { b.push(0xdd, 0x1d, ...le(out)); out += 8; depth--; } // fstp m64
    else if (r < 0.97) { b.push(0xd9, 0x15, ...le(out)); out += 8; } // fst m32
    else b.push(0xeb, 0x00); // jmp to the next instruction: a block boundary
  }
  while (depth--) { b.push(0xdd, 0x1d, ...le(out)); out += 8; }
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return { code: Uint8Array.from(b), outLen: out - OUT };
}

function exec(useJit, code, outLen, T, cw, slice = 1e7) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  cpu.reset();
  T.floats.forEach((v, k) => mem.writeF32(T32 + 4 * k, v));
  T.doubles.forEach((v, k) => mem.writeF64(T64 + 8 * k, v));
  T.i16.forEach((v, k) => mem.write16(T16 + 2 * k, v & 0xffff));
  T.i32.forEach((v, k) => mem.write32(TI32 + 4 * k, v));
  mem.writeBytes(CODE, code);
  mem.write16(cpu.base + ST.FPU_CW, cw);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
  const end = CODE + code.length - 1;
  let r;
  if (useJit) {
    const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]);
    let n = 0;
    do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e7);
  } else r = I.run({ stopAt: end, maxInsns: 1e7 });
  assert.equal(r, EXIT.HALT);
  return { out: Buffer.from(mem.bytes(OUT, outLen)).toString('hex'), sw: cpu.eax & 0x7d00 };
}

function check(seed, cw, slices) {
  const R = rng(seed), T = tables(R), { code, outLen } = program(R);
  const want = exec(false, code, outLen, T, cw);
  for (const slice of slices) {
    const got = exec(true, code, outLen, T, cw, slice);
    if (got.out !== want.out) {
      for (let k = 0; k < outLen / 8; k++) assert.equal(got.out.slice(16 * k, 16 * k + 16), want.out.slice(16 * k, 16 * k + 16), `seed ${seed} cw ${cw.toString(16)} slice ${slice}: value #${k}`);
    }
    assert.equal(got.sw, want.sw, `seed ${seed} cw ${cw.toString(16)} slice ${slice}: status word`);
  }
}

test('narrow x87 values: random programs under every rounding and precision control match the interpreter', () => {
  for (let seed = 1, n = depth(300, 6); seed <= n; seed++) for (const cw of MODES) check(seed, cw, [1e7]);
});

test('narrow x87 values: time slices through random programs', () => {
  for (let seed = 1000, n = 1000 + depth(40, 3); seed < n; seed++) for (const cw of [0x0c7f, 0x047f, 0x007f]) check(seed, cw, [1, 2, 3, 7]);
});

test('a product of a wide operand that rounds onto the 24-bit grid while inexact is not taken as exact', () => {
  // a * b with a a 31-bit integer or double and b = m / 2^23 a float, a * m = g * 2^30 - 1 (a = -1/m mod 2^30): the f64
  // product rounds up onto the grid point g * 2^7, the exact value lies just below it — truncation gives the grid point
  // below. FILD m32 / FLD m64 operands are not narrow: their products must take the grid test.
  const inv = (m) => { let x = 1n; for (let k = 0; k < 6; k++) x = (x * (2n - BigInt(m) * x)) & ((1n << 30n) - 1n); return Number(x); }; // m^-1 mod 2^30 (Newton)
  const cases = [];
  for (let m = (1 << 23) + 1; cases.length < 12; m += 2 * 7919) {
    for (const hi of [0, 2 ** 30]) {
      const a = ((2 ** 30 - inv(m)) % 2 ** 30) + hi;
      if (a >= 2 ** 31 || a * m < 2 ** 53 || a * m >= 2 ** 54) continue;
      cases.push([a, m / 2 ** 23]);
    }
  }
  const A = DATA, A64 = DATA + 0x100, B = DATA + 0x200;
  const b = [];
  cases.forEach((_, i) => {
    b.push(0xdb, 0x05, ...le(A + 4 * i), 0xd8, 0x0d, ...le(B + 4 * i), 0xdd, 0x1d, ...le(OUT + 16 * i)); // fild m32 a ; fmul m32 b ; fstp m64
    b.push(0xdd, 0x05, ...le(A64 + 8 * i), 0xd8, 0x0d, ...le(B + 4 * i), 0xdd, 0x1d, ...le(OUT + 16 * i + 8)); // fld m64 a ; fmul m32 b ; fstp m64
  });
  b.push(0xdf, 0xe0, 0xf4);
  const code = Uint8Array.from(b);
  const run = (useJit) => {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    const I = new Interp(mem, cpu);
    cpu.reset();
    cases.forEach(([a, bv], i) => { mem.write32(A + 4 * i, a | 0); mem.writeF64(A64 + 8 * i, a); mem.writeF32(B + 4 * i, bv); });
    mem.writeBytes(CODE, code);
    mem.write16(cpu.base + ST.FPU_CW, 0x0c7f);
    cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
    const end = CODE + code.length - 1;
    let r;
    if (useJit) { const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: 1e7 }); while (r === EXIT.TIMESLICE); }
    else r = I.run({ stopAt: end, maxInsns: 1e7 });
    assert.equal(r, EXIT.HALT);
    return cases.map((_, i) => [mem.readF64(OUT + 16 * i), mem.readF64(OUT + 16 * i + 8)]);
  };
  const want = run(false), got = run(true);
  cases.forEach(([a, bv], i) => {
    assert.ok(want[i][0] < a * bv, `case ${i}: the truncated product lies below the rounded one`);
    assert.deepEqual(got[i], want[i], `a ${a} b ${bv}`);
  });
});

test('narrow products and quotients chained past both ends of the double range under truncation', () => {
  // fld1 ; L: fmul m32 [k] (or fdiv) ; fst m64 [out] ; add out, 8 ; dec ecx ; jnz L ; fstp m64 [end] ; fnstsw ax ; hlt
  // — every step a product (quotient) of two narrow values: through the float range, past it, down to and below the
  // smallest normal double, the lowest normal binade included, and up to infinity
  for (const [k, div] of [[1e30, false], [1e-30, false], [3.4e38, false], [1.17e-38, false], [Math.fround(0.7), false], [1e30, true], [1e-30, true], [Math.fround(-3e-7), true]]) {
    for (const cw of [0x0c7f, 0x047f, 0x087f, 0x007f]) {
      const K = DATA, body = [0xd8, div ? 0x35 : 0x0d, ...le(K), 0xdd, 0x17, 0x83, 0xc7, 0x08, 0x49]; // fmul/fdiv m32 ; fst m64 [edi] ; add edi, 8 ; dec ecx
      const code = Uint8Array.from([0xd9, 0xe8, 0xb9, ...le(48), 0xbf, ...le(OUT), ...body, 0x75, -(body.length + 2) & 0xff, 0xdd, 0x1f, 0xdf, 0xe0, 0xf4]);
      const run = (useJit, slice) => {
        const mem = new GuestMemory();
        const cpu = new CpuState(mem, THREAD_STATES_BASE);
        const I = new Interp(mem, cpu);
        cpu.reset();
        mem.writeF32(K, k);
        mem.writeBytes(CODE, code);
        mem.write16(cpu.base + ST.FPU_CW, cw);
        cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
        const end = CODE + code.length - 1;
        let r;
        if (useJit) { const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE); }
        else r = I.run({ stopAt: end, maxInsns: 1e7 });
        assert.equal(r, EXIT.HALT);
        return Buffer.from(mem.bytes(OUT, 8 * 49)).toString('hex') + ' ' + (cpu.eax & 0x7d00);
      };
      const want = run(false);
      for (const slice of [1e7, 5]) assert.equal(run(true, slice), want, `k ${k} ${div ? 'div' : 'mul'} cw ${cw.toString(16)} slice ${slice}`);
    }
  }
});

test('narrow values survive the exits of a block (x87ExitState keeps g24Mask for the path that continues)', async () => {
  // fld m32 ; fld m32 ; fmul st, st(1) ; fmul m32 ; fmul st, st(1) ; fstp m64 ; fstp m64 ; hlt under truncation at 24 bits:
  // every product of two narrow values has a cold exit (roundTowardZero24); the knowledge must be the same after it
  const { Emitter } = await import('../src/cpu/jit/translate.js');
  const K = DATA;
  const code = Uint8Array.from([0xd9, 0x05, ...le(K), 0xd9, 0x05, ...le(K + 4), 0xd8, 0xc9, 0xd8, 0x0d, ...le(K + 8), 0xd8, 0xc9,
    0xdd, 0x1d, ...le(OUT), 0xdd, 0x1d, ...le(OUT + 8), 0xf4]);
  const P = Emitter.prototype, exitState = P.x87ExitState, restore = P.x87Restore;
  const seen = [];
  P.x87ExitState = function () { const s = exitState.call(this); this._g24AtExit = this.g24Mask; return s; };
  P.x87Restore = function (s) { const at = this._g24AtExit; restore.call(this, s); if (at !== undefined) seen.push([at, this.g24Mask]); };
  try {
    const run = (useJit) => {
      const mem = new GuestMemory();
      const cpu = new CpuState(mem, THREAD_STATES_BASE);
      const I = new Interp(mem, cpu);
      cpu.reset();
      mem.writeF32(K, 1.5); mem.writeF32(K + 4, Math.fround(0.7)); mem.writeF32(K + 8, Math.fround(1.1));
      mem.writeBytes(CODE, code);
      mem.write16(cpu.base + ST.FPU_CW, 0x0c7f);
      cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
      const end = CODE + code.length - 1;
      let r;
      if (useJit) { const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: 1e7 }); while (r === EXIT.TIMESLICE); }
      else r = I.run({ stopAt: end, maxInsns: 1e7 });
      assert.equal(r, EXIT.HALT);
      return Buffer.from(mem.bytes(OUT, 16)).toString('hex');
    };
    assert.equal(run(true), run(false));
  } finally { P.x87ExitState = exitState; P.x87Restore = restore; delete P._g24AtExit; }
  assert.ok(seen.some(([at]) => at !== 0), 'exits taken with narrow values known');
  for (const [at, after] of seen) assert.equal(after, at, 'g24Mask after the exit\'s restore');
});

test('bounded narrow arithmetic under truncation (x87Bounds): straight-line programs against the interpreter', () => {
  // translate-x87.js rngOf / roundTowardZeroBounded: add / sub / subr / mul of narrow values whose exponent bounds keep
  // every f64 result normal skip the exponent test; a sum on the 24-bit grid is kept only when exact. One block of x87
  // code (no boundary: the bounds are known across the whole program) over floats chosen for absorption (1 + 2^-30,
  // 2^24 - 2^-40: inexact sums landing on the grid, both signs), cancellation, zeros of both signs, float denormals, the
  // float range's ends, infinities, quiet and signaling NaNs; products chained past the bounds' limit (the plain path
  // again). Compared with the interpreter: every value stored, the condition codes, TOP and IE; whole runs and slices,
  // the option on and off, and with the path counted (profiling translation) so that it is known to run.
  const f = Math.fround;
  const SNAN = 0x7fa00001, QNAN_NEG = 0xffc12345;
  const special = [1, -1, 2 ** -30, -(2 ** -30), 2 ** -60, -(2 ** -60), 3, 1.5, 2 ** 24, -(2 ** 24) + 1, f(1 / 3), f(-2 / 3), 1e30, -1e30,
    3.4e38, -3.4e38, 1.1754943508222875e-38, 1e-45, -(2 ** -149), 0, -0, Infinity, -Infinity, NaN, 'snan', 'qnan', 2 ** 100, 2 ** -100,
    f(1 + 2 ** -23), -f(1 + 2 ** -23), 7, -7];
  const run = (code, outLen, floats, i16, useJit, slice, opts) => {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    const I = new Interp(mem, cpu);
    cpu.reset();
    floats.forEach((v, k) => { if (v === 'snan') mem.write32(T32 + 4 * k, SNAN); else if (v === 'qnan') mem.write32(T32 + 4 * k, QNAN_NEG); else mem.writeF32(T32 + 4 * k, v); });
    i16.forEach((v, k) => mem.write16(T16 + 2 * k, v & 0xffff));
    mem.writeBytes(CODE, code);
    mem.write16(cpu.base + ST.FPU_CW, 0x0c7f);
    cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
    const end = CODE + code.length - 1;
    let r, jit = null;
    if (useJit) { jit = new Jit(mem, I, { smc: true, ...opts }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE); }
    else r = I.run({ stopAt: end, maxInsns: 1e7 });
    assert.equal(r, EXIT.HALT);
    if (jit?.opts.profile) jit.harvest(cpu.b4);
    return { out: Buffer.from(mem.bytes(OUT, outLen)).toString('hex') + ' ' + (cpu.eax & 0x7d01).toString(16), bounded: jit?.stats.prof?.x87DirBounded ?? 0 };
  };
  let bounded = 0;
  {
    // every pair of 14 special operands through add, mul, sub, subr: `fld m32 a ; fop m32 b ; fnstsw m16 ; fnclex ; fst
    // m32 ; fstp m64` (IE of 0 x inf, inf - inf, the NaN rules; absorption both ways; FST m32 of narrow values out of the
    // float range and just below its normals: (2 - 2^-23) x 2^-127 = 2^-126 - 2^-150, which f32.demote rounds up to a
    // normal)
    const vals = [0, -0, 1, -1, 2 ** -30, -(2 ** -60), 2 ** 24, f(1 + 2 ** -23), -3.4e38, 1e-45, Infinity, NaN, 2 ** -127, f(2 - 2 ** -23)];
    // (one loop over the pairs, so that the exits re-enter one translation: A[k] at T32, B[k] at T32 + 4096)
    const P = vals.length ** 2, A = [], B = [];
    for (const x of vals) for (const y of vals) { A.push(x); B.push(y); }
    while (A.length < 1024) A.push(0);
    const b = [0x31, 0xc0, 0xbe, ...le(T32), 0xbf, ...le(T32 + 4096), 0xbb, ...le(OUT)]; // xor eax, eax ; mov esi / edi / ebx
    const top = b.length;
    for (const op of [0, 1, 4, 5]) b.push(0xd9, 0x04, 0x86, 0xd8, 0x04 | (op << 3), 0x87, 0xdd, 0x3b, 0xdb, 0xe2, 0xd9, 0x53, 0x02, 0xdd, 0x5b, 0x06, 0x83, 0xc3, 0x0e);
    b.push(0x40, 0x3d, ...le(P)); // inc eax ; cmp eax, P
    b.push(0x0f, 0x82, ...le(top - (b.length + 6)), 0xdf, 0xe0, 0xf4); // jb top ; fnstsw ax ; hlt
    const out = OUT + 14 * 4 * P;
    const code = Uint8Array.from(b), outLen = out - OUT;
    const want = run(code, outLen, [...A, ...B], [], false).out;
    const got = run(code, outLen, [...A, ...B], [], true, 1e7, { x87Bounds: true, profile: true });
    if (got.out !== want) {
      for (let k = 0; k < outLen / 14; k++) {
        const g = got.out.slice(28 * k, 28 * k + 28), w = want.slice(28 * k, 28 * k + 28);
        assert.equal(g, w, `${A[Math.floor(k / 4)]} op ${[0, 1, 4, 5][k % 4]} ${B[Math.floor(k / 4)]}: status word, values`);
      }
    }
    bounded += got.bounded;
  }
  for (const k of [1e30, 1e-30, 3.4e38, 1e-45]) {
    // products chained in one block past the bounds' limit (1e30: hi grows by 100 a step; 1e-45: lo by 149), then sums:
    // `fld m32 k ; (fmul m32 k ; fst m64) x 12 ; (fadd st, st(0) ; fst m64) x 4 ; fstp m64 ; fnstsw m16` — the results leave the
    // double range, which the bounds must see coming (the plain path's exponent test then sends them to the interpreter)
    const b = [0xd9, 0x05, ...le(T32)];
    let out = OUT;
    for (let i = 0; i < 12; i++) { b.push(0xd8, 0x0d, ...le(T32), 0xdd, 0x15, ...le(out)); out += 8; }
    for (let i = 0; i < 4; i++) { b.push(0xd8, 0xc0, 0xdd, 0x15, ...le(out)); out += 8; }
    b.push(0xdd, 0x1d, ...le(out), 0xdd, 0x3d, ...le(out + 8), 0xf4); out += 10; // (fnstsw m16: OE / UE as well)
    const code = Uint8Array.from(b), outLen = out - OUT;
    assert.equal(run(code, outLen, [f(k)], [], true, 1e7, { x87Bounds: true }).out, run(code, outLen, [f(k)], [], false).out, `chain of ${k}`);
  }
  for (let seed = 1, n = depth(400, 8); seed <= n; seed++) {
    const R = rng(seed * 7919);
    const pick = (k) => Math.floor(R() * k);
    // mostly ordinary floats (a NaN or an infinity sends what depends on it to the interpreter), some special ones
    const floats = [], pSpecial = 0.4 * R();
    for (let k = 0; k < N_TAB; k++) floats.push(R() < pSpecial ? special[pick(special.length)] : f((R() < 0.5 ? -1 : 1) * (1 + R()) * 2 ** (pick(40) - 20)));
    const i16 = Array.from({ length: N_TAB }, () => (R() < 0.5 ? pick(16) - 8 : pick(65536) - 32768));
    const b = [];
    let d = 0, out = OUT;
    const tab32 = () => le(T32 + 4 * pick(N_TAB)), tab16 = () => le(T16 + 2 * pick(N_TAB));
    for (let n = 0; n < 50; n++) {
      const r = R();
      if (d === 0 || (d < 6 && r < 0.25)) {
        const k = pick(8);
        if (k < 4) b.push(0xd9, 0x05, ...tab32()); // fld m32
        else if (k === 4) b.push(0xdf, 0x05, ...tab16()); // fild m16
        else if (k === 5) b.push(0xd9, R() < 0.5 ? 0xe8 : 0xee); // fld1 / fldz
        else if (d) b.push(0xd9, 0xc0 + pick(d)); // fld st(i)
        else b.push(0xd9, 0x05, ...tab32());
        d++;
        continue;
      }
      const op = [0, 0, 1, 1, 4, 5, 6][pick(7)];
      if (r < 0.6) { const k = pick(4); b.push(k === 3 ? 0xde : 0xd8, (op << 3) | 5, ...(k === 3 ? tab16() : tab32())); } // m32 / m16 operand
      else if (r < 0.8 && d >= 2) { const i = 1 + pick(d - 1), form = pick(3); b.push([0xd8, 0xdc, 0xde][form], 0xc0 + (op << 3) + i); if (form === 2) d--; }
      else if (r < 0.84 && d >= 2) b.push(0xd9, 0xc8 + 1 + pick(d - 1)); // fxch
      else if (r < 0.88) b.push(0xd9, R() < 0.5 ? 0xe0 : 0xe1); // fchs / fabs
      else if (r < 0.92) { b.push(0xd9, 0x15, ...le(out)); out += 4; } // fst m32
      else if (r < 0.95) { b.push(0xdd, 0x3d, ...le(out), 0xdb, 0xe2); out += 2; } // fnstsw m16 ; fnclex (IE of what ran since)
      else { b.push(0xdd, 0x1d, ...le(out)); out += 8; d--; } // fstp m64
    }
    while (d--) { b.push(0xdd, 0x1d, ...le(out)); out += 8; }
    b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
    const code = Uint8Array.from(b), outLen = out - OUT;
    const want = run(code, outLen, floats, i16, false).out;
    for (const [slice, opts] of [[1e7, { x87Bounds: true, profile: true }], [3, { x87Bounds: true }], [1e7, { x87Bounds: false }]]) {
      const got = run(code, outLen, floats, i16, true, slice, opts);
      assert.equal(got.out, want, `seed ${seed} slice ${slice} ${JSON.stringify(opts)}`);
      bounded += got.bounded;
    }
  }
  assert.ok(bounded > 0, 'the bounded path ran');
});

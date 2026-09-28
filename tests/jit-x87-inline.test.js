// Inline fast paths of the JIT's x87 transcendentals (translate-x87.js): F2XM1 for 2^-1000 <= |x| < 1, FSCALE for
// |ST(1)| < 1023, FSIN / FCOS for tiny <= |x| < pi/4. They must give exactly the bits of the kernel path they bypass:
// every input is run through the JIT twice, with the fast paths and with globalThis.ORTHROS_NO_X87_INLINE (the kernel
// path only, the translation before the fast paths existed), and the results, status words and register files must
// be identical — at the window boundaries (and one ulp either side), on random arguments inside the windows, and on
// special values (zeros, denormals, infinities, NaN / SNaN, out-of-range trig arguments, overflowing and denormal
// FSCALE results). The status words (C1 aside: the JIT leaves it to the block convention) must also match the
// interpreter, and FSCALE's results too (its rounding is exact on both executors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { PIO4, TINY_SIN, TINY_COS } from '../src/cpu/jit/fpmath-trig.js';

const CODE = 0x20000000, DATA = 0x10000000, REC = 32; // record: +0 a (ST(0)), +8 b (ST(1), FSCALE), +16 result, +24 status word
const C1 = 1 << 9;

const dv = new DataView(new ArrayBuffer(8));
const bitsOf = (x) => { dv.setFloat64(0, x, true); return dv.getBigUint64(0, true); };
const fromBits = (b) => { dv.setBigUint64(0, BigInt.asUintN(64, b), true); return dv.getFloat64(0, true); };
/** the doubles one ulp below and above x (x finite, non-zero), and x itself, with both signs */
const around = (x) => [fromBits(bitsOf(x) - 1n), x, fromBits(bitsOf(x) + 1n)].flatMap((v) => [v, -v]);
const SNAN = 0x7ff4000000000001n, QNAN_NEG = 0xfff8000000000123n;
const SPECIAL = [0, -0, Infinity, -Infinity, NaN, 5e-324, -5e-324, 1e-310, 2.2250738585072014e-308, 1e-300, 1e300, -1e300, 1.7976931348623157e308];
/** deterministic pseudo-random doubles in (-r, r) */
function randoms(n, r, seed = 12345) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  return Array.from({ length: n }, () => (2 * next() - 1) * r * (next() < 0.2 ? next() ** 8 : 1));
}

/**
 * mov esi, DATA ; mov ecx, n
 * L: [fld qword [esi+8]] ; fld qword [esi] ; <op> ; fstp qword [esi+16] ; [fstp st(0)] ; fnstsw ax ; mov [esi+24], eax ;
 *    fnclex ; add esi, 32 ; dec ecx ; jnz L ; hlt
 */
function program(op, two, n) {
  const b = [0xbe, ...le32(DATA), 0xb9, ...le32(n)];
  const L = b.length;
  if (two) b.push(0xdd, 0x46, 8);
  b.push(0xdd, 0x06, ...op, 0xdd, 0x5e, 16);
  if (two) b.push(0xdd, 0xd8);
  b.push(0xdf, 0xe0, 0x89, 0x46, 24, 0xdb, 0xe2, 0x83, 0xc6, REC, 0x49);
  const rel = L - (b.length + 6);
  b.push(0x0f, 0x85, ...le32(rel), 0xf4);
  return { code: Uint8Array.from(b), end: CODE + b.length - 1 };
}
function le32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

/** Run the program on `pairs` ([a, b] as doubles or bigint bit patterns) under one executor; returns the data bytes and the CPU. */
function run(kind, op, two, pairs) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const { code, end } = program(op, two, pairs.length);
  cpu.reset();
  mem.writeBytes(CODE, code);
  pairs.forEach(([a, b], i) => {
    for (const [off, v] of [[0, a], [8, b]]) {
      if (typeof v === 'bigint') { mem.write32(DATA + REC * i + off, Number(v & 0xffffffffn)); mem.write32(DATA + REC * i + off + 4, Number(v >> 32n)); } else mem.writeF64(DATA + REC * i + off, v);
    }
  });
  cpu.eip = CODE; cpu.esp = DATA - 0x100; cpu.eflags = F.RESERVED1 | F.IF;
  let r;
  if (kind === 'interp') r = I.run({ stopAt: end, maxInsns: 1e8 });
  else {
    const saved = globalThis.ORTHROS_NO_X87_INLINE;
    globalThis.ORTHROS_NO_X87_INLINE = kind === 'kernel';
    try {
      const jit = new Jit(mem, I);
      jit.cpu = cpu; jit.boundaries = new Set([end]);
      r = jit.run({ stopAt: end, maxInsns: 1e8 });
      assert.equal(jit.stats.fallbackSteps, 0, 'no interpreter fallback');
    } finally { globalThis.ORTHROS_NO_X87_INLINE = saved; }
  }
  assert.equal(r, EXIT.HALT, kind);
  return { bytes: Buffer.from(mem.bytes(DATA, REC * pairs.length)), mem, cpu };
}

const show = (v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : Object.is(v, -0) ? '-0' : String(v));
/** fast path == kernel path bit for bit; status words (and optionally results) == interpreter */
function check(name, op, two, pairs, { interpResults = false } = {}) {
  const fast = run('fast', op, two, pairs), kern = run('kernel', op, two, pairs), ref = run('interp', op, two, pairs);
  for (let i = 0; i < pairs.length; i++) {
    const at = REC * i, what = `${name}(${pairs[i].map(show).join(', ')})`;
    const got = fast.mem.readF64(DATA + at + 16), want = kern.mem.readF64(DATA + at + 16);
    assert.equal(fast.bytes.subarray(at, at + REC).toString('hex'), kern.bytes.subarray(at, at + REC).toString('hex'), `${what}: fast ${got} kernel ${want}`);
    const swJ = fast.mem.read16(DATA + at + 24), swI = ref.mem.read16(DATA + at + 24);
    assert.equal(swJ & ~C1, swI & ~C1, `${what}: status word jit 0x${swJ.toString(16)} interp 0x${swI.toString(16)}`);
    if (interpResults) assert.equal(bitsOf(got), bitsOf(ref.mem.readF64(DATA + at + 16)), `${what}: jit ${got} interp ${ref.mem.readF64(DATA + at + 16)}`);
  }
  assert.equal(fast.cpu.fpuSw & ~C1, kern.cpu.fpuSw & ~C1);
  for (let k = 0; k < 8; k++) assert.ok(Object.is(fast.cpu.fpr(k), kern.cpu.fpr(k)) || (Number.isNaN(fast.cpu.fpr(k)) && Number.isNaN(kern.cpu.fpr(k))), `fpr[${k}]`);
}

test('F2XM1 inline path (2^-1000 <= |x| < 1) gives the kernel bits: window edges, random fractions, specials', () => {
  const xs = [...around(1), ...around(2 ** -1000), ...around(0.5), ...around(2 ** -27), ...around(2 ** -53), ...SPECIAL, 2, -2, 1e-20, -0.75,
    ...randoms(3000, 1), ...randoms(200, 2 ** -30, 7)];
  check('f2xm1', [0xd9, 0xf0], false, [...xs.map((x) => [x, 0]), [SNAN, 0], [QNAN_NEG, 0]]);
});

test('FSIN / FCOS inline path (tiny <= |x| < pi/4) gives the kernel bits: window edges, random angles, specials, out of range', () => {
  const xs = [...around(PIO4), ...around(TINY_SIN), ...around(TINY_COS), ...around(0.5), ...around(1e-5), ...SPECIAL, 1, -3, 1e6, 2 ** 63, -(2 ** 63), 2 ** 62,
    ...randoms(3000, PIO4 * 1.05), ...randoms(300, 4, 99)];
  const pairs = [...xs.map((x) => [x, 0]), [SNAN, 0], [QNAN_NEG, 0]];
  check('fsin', [0xd9, 0xfe], false, pairs);
  check('fcos', [0xd9, 0xff], false, pairs);
});

test('FSCALE inline path (|ST(1)| < 1023) gives the kernel (and interpreter) bits: overflow, denormal results, specials, edges of the window', () => {
  const as = [1, -1.5, 0.1234567891234567, 3.999999999999999, ...SPECIAL, -5e-324, 2 ** -1022 * 1.75, 1.5 * 2 ** 1000, ...randoms(20, 1e10, 3)];
  const bs = [0, -0, 0.5, -0.5, 0.999, 1, -1, 3.7, -3.7, 52, -52, 1000, -1000, 1022, -1022, ...around(1023), 1022.99, -1022.99, 1023.5, -1023.5, 1024, -1024, 1074, -1074, -1075, 2000, -2000,
    1e10, -1e10, Infinity, -Infinity, NaN, ...randoms(40, 1100, 5).map(Math.trunc)];
  const pairs = as.flatMap((a) => bs.map((b) => [a, b]));
  pairs.push([SNAN, 1], [1, SNAN], [QNAN_NEG, 2], [2, QNAN_NEG], [SNAN, QNAN_NEG]);
  check('fscale', [0xd9, 0xfd], true, pairs, { interpResults: true });
});

// Adversarial review of the f64 shadows of the low qword of the XMM registers (XMM_SHADOW64_OPS): generated programs
// leaving dirty f64 / f32 shadows before the instructions around the shadowed family (MOVHPS / MOVLPS / MOVHLPS /
// MOVLHPS / SHUFPD / MOVDDUP / UNPCKHPD / MOVMSKPD / CVTPD2PS / ANDNPD / MOVUPD / MOVNTPD / LDDQU / MOVD m32, same-register
// MOVSD / MOVQ / MOVAPS, loops), whole and at every time slice, against the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100; // eax: base of the [eax+disp8] operands (16-aligned)
const FXAREA = DATA + 0x800; // edi: FXSAVE area
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(jit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, I, J,
    run(end, slice = 1e6) {
      I.cache.clear();
      if (!J) return I.run({ stopAt: end, maxInsns: 1e6 });
      J.reset(); J.cpu = cpu; J.boundaries = new Set([end]);
      let r, n = 0;
      do r = J.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e5);
      return r;
    },
  };
}
const EI = makeExec(false), EJ = makeExec(true);

/** deterministic bytes (xorshift32) */
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

// doubles (as [lo, hi] dwords) that exercise the rounding, NaN, denormal and conversion-limit paths
const f64words = (v) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); return [b.getUint32(0, true), b.getUint32(4, true)]; };
const SPECIAL = [0, -0, 1, -1, 0.5, 1.5, 2.5, -2.5, 3, Infinity, -Infinity, 3e9, 2147483647.5, 2147483648, -2147483648.5,
  -2147483649, 1e-310, -5e-324, 1e300, 65536.75, Math.PI, 1 / 3].map(f64words)
  .concat([[0, 0x7ff80000], [0, 0xfff80000], [1, 0x7ff00000], [0x12345, 0xfff40000], [0xdeadbeef, 0x7ff81234], [0x3f800000, 0x40490fdb]]);

function setup(mem, cpu, r, mxcsr) {
  const val = () => ((r() & 3) ? SPECIAL[r() % SPECIAL.length] : f64words(((r() % 20000) - 10000) / 64));
  const w = (a, [lo, hi]) => { mem.write32(a, lo); mem.write32(a + 4, hi); };
  for (let k = 0; k < 8; k++) for (let q = 0; q < 2; q++) (r() & 7) ? w(cpu.xmmAddr(k) + 8 * q, val()) : w(cpu.xmmAddr(k) + 8 * q, [r(), r()]);
  for (let i = 0; i < 0x100; i += 8) (r() & 7) ? w(MEMOP + i, val()) : w(MEMOP + i, [r(), r() % 5 === 0 ? 0 : r()]);
  for (let k = 0; k < 8; k++) cpu.setReg(k, (r() & 1) ? [0, 1, -1, 3, 0x7fffffff, 0x80000000, 12345678][r() % 7] : r());
  cpu.eax = MEMOP; cpu.edi = FXAREA; cpu.esp = DATA + 0xf00;
  cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
  cpu.mxcsr = mxcsr;
}

function snapshot(E) {
  const { mem, cpu } = E;
  const s = { eip: hex(cpu.eip), eflags: hex(cpu.eflags & ARITH), regs: [], xmm: [], mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  for (let k = 0; k < 8; k++) s.xmm.push(Buffer.from(mem.bytes(cpu.xmmAddr(k), 16)).toString('hex'));
  s.fpr = Buffer.from(mem.bytes(cpu.base + ST.FPR, 64)).toString('hex');
  s.fpu = [mem.u8[cpu.base + ST.FPU_TOP], mem.read16(cpu.base + ST.FPU_TW), mem.read16(cpu.base + ST.FPU_SW) & 0x4700];
  return s;
}

/** Run `code` on both executors from the same state (`init` may adjust it); compare everything visible. */
function runBoth(code, seed, mxcsr, label, slice, init) {
  for (const E of [EI, EJ]) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x100, 0x2000, 0xcc);
    mem.writeBytes(CODE, code);
    mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
    setup(mem, cpu, prng(seed), mxcsr);
    init?.(E);
    cpu.eip = CODE;
  }
  const end = CODE + code.length;
  const ri = EI.run(end), rj = EJ.run(end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), `${label}: jit state differs from the interpreter`);
}


// ---------------------------------------------------------------- program generator
const X = (r) => r() & 7;
const G = (r) => [2, 3, 5, 6][r() & 3]; // (not ecx: loop counter)
const regrm = (reg, rm) => 0xc0 | (reg << 3) | rm;
const mem8 = (r, reg) => [0x40 | (reg << 3), (r() % 0x20) * 8];
const mem16 = (r, reg) => [0x40 | (reg << 3), (r() % 0x10) * 16];
/** producers leaving dirty f64 / f32 shadows, then consumers the patch did not list */
function insn(r) {
  const k = r() % 64;
  const x = X(r);
  if (k < 8) return [0xf2, 0x0f, [0x58, 0x59, 0x5c, 0x51][r() & 3], regrm(x, X(r))]; // addsd / mulsd / subsd / sqrtsd
  if (k < 10) return [0x66, 0x0f, 0x12, ...mem8(r, x)]; // movlpd x,m
  if (k < 11) return [0x0f, 0x12, ...mem8(r, x)]; // movlps x,m
  if (k < 12) return [0x0f, 0x13, ...mem8(r, x)]; // movlps m,x
  if (k < 13) return [0x0f, 0x16, ...mem8(r, x)]; // movhps x,m
  if (k < 14) return [0x0f, 0x17, ...mem8(r, x)]; // movhps m,x
  if (k < 15) return [0xf2, 0x0f, 0x10, regrm(x, x)]; // movsd x,x (same register)
  if (k < 16) return [0xf3, 0x0f, 0x7e, regrm(x, x)]; // movq x,x (same register)
  if (k < 17) return [0x66, 0x0f, 0x6e, 0x40 | (x << 3), (r() % 0x40) * 4]; // movd x,m32
  if (k < 18) return [0x66, 0x0f, 0x7e, 0x40 | (x << 3), (r() % 0x40) * 4]; // movd m32,x
  if (k < 19) return [0x0f, 0x12, regrm(x, X(r))]; // movhlps
  if (k < 20) return [0x0f, 0x16, regrm(x, X(r))]; // movlhps
  if (k < 21) return [0x66, 0x0f, 0xc6, regrm(x, X(r)), r() & 3]; // shufpd
  if (k < 22) return [0xf2, 0x0f, 0x12, regrm(x, X(r))]; // movddup
  if (k < 23) return [0x66, 0x0f, 0x15, regrm(x, X(r))]; // unpckhpd
  if (k < 24) return [0x66, 0x0f, 0x50, regrm(G(r), x)]; // movmskpd
  if (k < 25) return [0x66, 0x0f, 0x5a, regrm(x, X(r))]; // cvtpd2ps
  if (k < 26) return [0x66, 0x0f, 0x55, regrm(x, X(r))]; // andnpd
  if (k < 27) return [0x66, 0x0f, 0x11, 0x40 | (x << 3), (r() % 0x1f) * 8]; // movupd m,x (unaligned)
  if (k < 28) return [0x66, 0x0f, 0x2b, ...mem16(r, x)]; // movntpd m,x
  if (k < 29) return [0xf2, 0x0f, 0xf0, 0x40 | (x << 3), (r() % 0x1f) * 8]; // lddqu x,m
  if (k < 31) return [0x66, 0x0f, 0x28, regrm(x, X(r))]; // movapd x,x
  if (k < 32) return [0x0f, 0x28, regrm(x, x)]; // movaps x,x (same)
  if (k < 34) return [0xf3, 0x0f, [0x10, 0x58, 0x59, 0x51][r() & 3], regrm(x, X(r))]; // movss / addss / mulss / sqrtss
  if (k < 36) return [0x66, 0x0f, 0xc5, regrm(G(r), x), r() & 7]; // pextrw
  if (k < 37) return [0xf3, 0x0f, 0x7e, ...mem8(r, x)]; // movq x,m
  if (k < 38) return [0x66, 0x0f, 0xd6, ...mem8(r, x)]; // movq m,x
  if (k < 39) return [0x66, 0x0f, 0x7e, regrm(x, G(r))]; // movd r32,x
  if (k < 40) return [0xf2, 0x0f, 0x2d, regrm(G(r), x)]; // cvtsd2si
  if (k < 41) return [0xf2, 0x0f, 0x2a, regrm(x, G(r))]; // cvtsi2sd
  if (k < 42) return [0x66, 0x0f, 0x2f, regrm(x, X(r))]; // comisd (flags read later or by a jcc)
  if (k < 43) return [0x66, 0x0f, 0xd4, regrm(x, X(r))]; // paddq
  if (k < 44) return [0x66, 0x0f, 0x73, regrm(3, x), r() & 15]; // psrldq
  if (k < 45) return [0x0f, 0xc6, regrm(x, X(r)), r() & 0xff]; // shufps
  if (k < 46) return [0xf3, 0x0f, 0xe6, regrm(x, X(r))]; // cvtdq2pd
  if (k < 47) return [0x66, 0x0f, 0x14, regrm(x, X(r))]; // unpcklpd
  if (k < 50) return [0xeb, 0x00];
  if (k < 52) return 'loop';
  return null;
}
function program(seed, n = 40) {
  const r = prng(seed);
  const out = [];
  let pendingJcc = -1;
  for (let i = 0; i < n; i++) {
    let b = insn(r);
    if (b === null) { out.push(0x70 + (r() & 15), 0); pendingJcc = out.length - 1; continue; }
    if (b === 'loop') { // mov ecx, n ; L: a few instructions ; dec ecx ; jnz L
      if (pendingJcc >= 0) continue;
      const body = [];
      for (let j = 0, m = 1 + (r() % 4); j < m; j++) { const x = insn(r); if (Array.isArray(x)) body.push(...x); }
      b = [0xb9, 1 + (r() % 3), 0, 0, 0, ...body, 0x49, 0x75, (-(body.length + 3)) & 0xff];
    }
    out.push(...b);
    if (pendingJcc >= 0) { out[pendingJcc] = b.length; pendingJcc = -1; }
  }
  return Uint8Array.from(out);
}

test('review: dirty f64 / f32 shadows meet the instructions around them (moves, shuffles, MMX-free packed ops)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const code = program(seed * 6151 + 13);
    runBoth(code, seed, 0x1f80 | ((seed & 3) << 13), `seed ${seed} (${Buffer.from(code).toString('hex')})`);
  }
});
test('review: the same at every time slice', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const code = program(seed * 1543 + 29, 25);
    runBoth(code, seed + 7000, 0x1f80, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 3));
  }
});

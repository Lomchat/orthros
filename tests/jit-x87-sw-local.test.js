// The x87 status word kept in a local of x87 regions (JIT option swLocal, translate.js L_SW): loaded with the stack
// cache, written back with it at every exit, fallback and time slice. Randomized programs mixing compares (FCOM / FCOMP /
// FUCOM / FTST / FXAM / FCOMI / FUCOMI), FNSTSW AX read back through SAHF / TEST AH and conditional branches (the loop-carried
// compare-and-branch shape), FNCLEX, arithmetic raising the masked exception flags (division by zero, invalid
// operations, overflow), FPREM (the interpreter sets C0..C3 in the middle of the region), run
// by the JIT with the option on and off against the reference interpreter: the whole status word (exception flags
// included: IE of an unordered FCOM / FTST, which the JIT once left out; but ZE and OE at 53 / 64-bit precision), every value
// stored, the branch counts, whole runs and time slices. (No stack faults: the JIT does not emulate them, D014; no
// transcendentals: their kernels differ from Math.* by an ulp, see jit-x87-trans.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, T32 = DATA, T64 = DATA + 0x1000, OUT = DATA + 0x8000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const N_TAB = 32;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function tables(R) {
  const floats = [0, -0, 1, -1, 0.5, 3, -7, 1e30, 3.4e38, 1e-45, Infinity, -Infinity, NaN, 2 ** 100];
  while (floats.length < N_TAB) floats.push(Math.fround((R() - 0.5) * 2 ** Math.floor(R() * 20 - 10)));
  const doubles = [0, 1, -1, 0.1, 1 / 3, 1e300, -1e-300, Infinity, NaN, Math.PI];
  while (doubles.length < N_TAB) doubles.push((R() - 0.5) * 2 ** Math.floor(R() * 20 - 10));
  return { floats, doubles };
}

/** a random program: the stack kept 1..6 deep, AX (FNSTSW) and EBX (branches taken) stored as it goes */
function program(R, ext = false) {
  const b = [];
  let depth = 0, out = OUT;
  const pick = (n) => Math.floor(R() * n);
  const m32 = () => le(T32 + 4 * pick(N_TAB)), m64 = () => le(T64 + 8 * pick(N_TAB));
  const axAt = []; // (where AX values are stored)
  const saveAx = () => { axAt.push(out - OUT); b.push(0x66, 0xa3, ...le(out)); out += 4; }; // mov [out], ax
  for (let n = 0; n < 70; n++) {
    // ext: the instructions whose condition codes the reference CPU leaves or clears differently from the SDM
    // (x87-cc-hw.test.js), each followed by FNSTSW AX stored: FCOMIP / FUCOMIP, FCMOVcc, FFREE of an empty register,
    // FPREM1, FXAM, FINCSTP + FDECSTP
    if (ext && depth >= 1 && R() < 0.2) {
      const k = pick(6);
      if (k === 0 && depth >= 2) { b.push(0xdf, (R() < 0.5 ? 0xf0 : 0xe8) + 1 + pick(depth - 1)); depth--; } // fcomip / fucomip
      else if (k === 1 && depth >= 2) b.push(0xda + pick(2), 0xc0 + 8 * pick(4) + 1 + pick(depth - 1)); // fcmovcc st(i)
      else if (k === 2 && depth < 8) b.push(0xdd, 0xc0 + depth + pick(8 - depth)); // ffree of an empty register
      else if (k === 3 && depth >= 2) b.push(0xd9, 0xf5); // fprem1
      else if (k === 4) b.push(0xd9, 0xf7, 0xd9, 0xf6); // fincstp ; fdecstp
      else b.push(0xd9, 0xe5); // fxam
      b.push(0xdf, 0xe0); saveAx();
      continue;
    }
    const r = R();
    if (depth === 0 || (depth < 6 && r < 0.25)) { // a push
      const k = pick(4);
      if (k === 0) b.push(0xd9, 0x05, ...m32()); // fld m32
      else if (k === 1) b.push(0xdd, 0x05, ...m64()); // fld m64
      else if (k === 2) b.push(0xd9, [0xe8, 0xee, 0xeb][pick(3)]); // fld1 / fldz / fldpi
      else if (depth) b.push(0xd9, 0xc0 + pick(depth)); // fld st(i)
      else b.push(0xd9, 0x05, ...m32());
      depth++;
      continue;
    }
    if (r < 0.1 && depth >= 2) { // fcomi / fucomi st(i) ; jp / jb / jz over inc ebx
      b.push(0xdb, (R() < 0.5 ? 0xf0 : 0xe8) + 1 + pick(depth - 1), [0x7a, 0x72, 0x74][pick(3)], 0x01, 0x43);
      continue;
    }
    if (r < 0.45) { // a compare
      const k = pick(6);
      if (k === 0) b.push(0xd8, 0x15, ...m32()); // fcom m32
      else if (k === 1) b.push(0xdc, 0x15, ...m64()); // fcom m64
      else if (k === 2 && depth >= 2) b.push(0xdd, 0xe0 + 1 + pick(depth - 1)); // fucom st(i)
      else if (k === 3 && depth >= 2) { b.push(0xd8, 0xd8 + 1 + pick(depth - 1)); depth--; } // fcomp st(i)
      else if (k === 4) b.push(0xd9, 0xe4); // ftst
      else b.push(0xd9, 0xe5); // fxam
      // read back: fnstsw ax, then either sahf ; jcc or test ah, imm ; jcc over inc ebx; sometimes store ax
      b.push(0xdf, 0xe0);
      if (R() < 0.5) b.push(0x9e, [0x72, 0x74, 0x76, 0x7a][pick(4)], 0x01, 0x43); // sahf ; jb/je/jbe/jp +1 ; inc ebx
      else b.push(0xf6, 0xc4, [0x01, 0x40, 0x41, 0x05, 0x45][pick(5)], R() < 0.5 ? 0x74 : 0x75, 0x01, 0x43); // test ah ; jz/jnz ; inc ebx
      if (R() < 0.4) saveAx();
      continue;
    }
    if (r < 0.7) { // arithmetic on a memory operand (division by zero, invalid, inexact, overflow flags)
      const wide = R() < 0.5;
      b.push(wide ? 0xdc : 0xd8, ([0, 1, 4, 6, 7][pick(5)] << 3) | 5, ...(wide ? m64() : m32()));
      continue;
    }
    if (r < 0.75) b.push(0xd9, 0xfa); // fsqrt (negative operands: invalid)
    else if (r < 0.8) b.push(0xdb, 0xe2); // fnclex
    else if (r < 0.84 && depth >= 2) b.push(0xd9, 0xf8); // fprem (the interpreter: C0..C3 from the quotient)
    else if (r < 0.87) b.push(0xd9, 0xe0); // fchs
    else if (r < 0.9 && depth >= 2) b.push(0xd9, 0xc8 + 1 + pick(depth - 1)); // fxch
    else if (r < 0.95) { b.push(0xdd, 0x1d, ...le(out)); out += 8; depth--; } // fstp m64
    else if (r < 0.97) { b.push(0xdf, 0xe0); saveAx(); }
    else b.push(0xeb, 0x00); // a block boundary
  }
  while (depth--) { b.push(0xdd, 0x1d, ...le(out)); out += 8; }
  b.push(0x89, 0x1d, ...le(out)); out += 4; // mov [out], ebx
  b.push(0xf4);
  return { code: Uint8Array.from(b), outLen: out - OUT, axAt };
}

function exec(jitOpts, code, outLen, T, cw, slice = 1e7) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  cpu.reset();
  T.floats.forEach((v, k) => mem.writeF32(T32 + 4 * k, v));
  T.doubles.forEach((v, k) => mem.writeF64(T64 + 8 * k, v));
  mem.writeBytes(CODE, code);
  mem.write16(cpu.base + ST.FPU_CW, cw);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
  const end = CODE + code.length - 1;
  let r;
  if (jitOpts) {
    const jit = new Jit(mem, I, { smc: true, ...jitOpts }); jit.cpu = cpu; jit.boundaries = new Set([end]);
    let n = 0;
    do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e7);
  } else r = I.run({ stopAt: end, maxInsns: 1e7 });
  assert.equal(r, EXIT.HALT);
  return { out: Buffer.from(mem.bytes(OUT, outLen)).toString('hex'), sw: cpu.fpuSw, top: cpu.fpuTop };
}

function check(seed, cw, slices, ext = false) {
  const R = rng(seed), T = tables(R), { code, outLen, axAt } = program(R, ext);
  // ZE / OE at 53 / 64-bit precision: not raised by the JIT (translate-x87.js arith), left out of the comparison
  const ign = (cw & 0x300) ? 0x0c : 0;
  const mask = (r) => {
    const out = Buffer.from(r.out, 'hex');
    for (const k of axAt) out[k] &= ~ign;
    return { out: out.toString('hex'), sw: r.sw & ~ign, top: r.top };
  };
  const want = mask(exec(null, code, outLen, T, cw));
  for (const swLocal of [true, false]) {
    for (const slice of slices) {
      const got = mask(exec({ swLocal }, code, outLen, T, cw, slice));
      const at = `seed ${seed} cw ${cw.toString(16)} swLocal ${swLocal} slice ${slice}`;
      assert.equal(got.out, want.out, `${at}: values stored`);
      assert.equal(got.sw.toString(16), want.sw.toString(16), `${at}: status word`);
      assert.equal(got.top, want.top, `${at}: TOP`);
    }
  }
}

test('x87 status word in a local: random compare / branch / exception programs match the interpreter', () => {
  for (let seed = 1; seed <= 100; seed++) for (const cw of [0x037f, 0x0c7f, 0x007f]) check(seed, cw, [1e7]);
});

test('x87 status word in a local: the seeds that found FCOMI / FUCOMI clearing C1 in the interpreter only', () => {
  // FXAM (C1 = the sign) -> FUCOMI st(3) -> FNSTSW AX: the interpreter cleared C1 (0x1400), the JIT kept it (0x1600);
  // the reference CPU keeps it (x87-cc-hw.test.js)
  for (const seed of [1034, 1646, 1921]) for (const cw of [0x037f, 0x0c7f, 0x007f, 0x027f, 0x047f, 0x087f]) check(seed, cw, [1e7]);
});

test('x87 status word in a local: FCOMIP / FCMOVcc / FFREE / FPREM1 / FXAM / FINCSTP mixed in', () => {
  for (let seed = 3000; seed < 3030; seed++) for (const cw of [0x037f, 0x0c7f, 0x007f]) check(seed, cw, [1e7], true);
  for (let seed = 3100; seed < 3110; seed++) check(seed, 0x037f, [1, 7], true);
});

test('x87 status word in a local: time slices through random programs', () => {
  for (let seed = 500; seed < 520; seed++) for (const cw of [0x037f, 0x0c7f]) check(seed, cw, [1, 7]);
});

test('x87 status word in a local: a loop-carried FCOM / FNSTSW / TEST AH / Jcc chain', () => {
  // ecx = 200 ; fldz ; L: fadd m32 [step] ; fcom m32 [lim] ; fnstsw ax ; test ah, 0x41 ; jnz skip ; inc ebx ; skip:
  // dec ecx ; jnz L ; fstp m64 [out] ; mov [out+8], ebx ; hlt — and the flags of an inexact sum accumulate
  const STEP = DATA, LIM = DATA + 4;
  const body = [0xd8, 0x05, ...le(STEP), 0xd8, 0x15, ...le(LIM), 0xdf, 0xe0, 0xf6, 0xc4, 0x41, 0x75, 0x01, 0x43, 0x49];
  const code = Uint8Array.from([0xb9, ...le(200), 0xd9, 0xee, ...body, 0x75, -(body.length + 2) & 0xff, 0xdd, 0x1d, ...le(OUT), 0x89, 0x1d, ...le(OUT + 8), 0xf4]);
  for (const cw of [0x037f, 0x0c7f, 0x007f]) {
    const run = (jitOpts, slice) => {
      const mem = new GuestMemory();
      const cpu = new CpuState(mem, THREAD_STATES_BASE);
      const I = new Interp(mem, cpu);
      cpu.reset();
      mem.writeF32(STEP, 0.1); mem.writeF32(LIM, 7.5);
      mem.writeBytes(CODE, code);
      mem.write16(cpu.base + ST.FPU_CW, cw);
      cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
      const end = CODE + code.length - 1;
      let r;
      if (jitOpts) { const jit = new Jit(mem, I, { smc: true, ...jitOpts }); jit.cpu = cpu; jit.boundaries = new Set([end]); do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE); }
      else r = I.run({ stopAt: end, maxInsns: 1e7 });
      assert.equal(r, EXIT.HALT);
      return `${Buffer.from(mem.bytes(OUT, 12)).toString('hex')} sw ${cpu.fpuSw.toString(16)}`;
    };
    const want = run(null);
    for (const swLocal of [true, false]) for (const slice of [1e7, 13]) assert.equal(run({ swLocal }, slice), want, `cw ${cw.toString(16)} swLocal ${swLocal} slice ${slice}`);
  }
});

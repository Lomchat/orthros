// JIT translation of scalar single-precision SSE code (translate-sse-float.js): lane 0 kept in f32 shadows across
// MOVSS / ADDSS / MULSS / CVTSI2SS / COMISS... (Emitter.xmmShadowSync), scalar SS/SD arithmetic on WASM scalars,
// COMISS/UCOMISS conditions evaluated by the next JCC/SETCC/CMOVCC (Emitter.pushFcmpCond), branch-free CVT(T)SS2SI.
// Checked against the reference interpreter on generated programs mixing those instructions with packed / double
// SSE ops (which must see the shadows written back), integer flag writers, conditional branches (block ends),
// interpreter fallbacks (FXSAVE reads the XMM registers from the state block) and time slices, over special values
// (NaNs with payloads, signaling NaNs, ±0, ±inf, denormals, the ±2^31 conversion limits) and every MXCSR rounding mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';
import { XMM_SHADOW_OPS } from '../src/cpu/jit/translate.js';
import { OP } from '../src/cpu/decoder.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100; // eax: base of the [eax+disp8] operands
const FXAREA = DATA + 0x800; // edi: FXSAVE area
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const f32bits = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); };

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

// f32 values that exercise the rounding, NaN, denormal and conversion-limit paths
const SPECIAL = [0, -0, 1, -1, 0.5, 1.5, 2.5, -2.5, -0.5, 3, Infinity, -Infinity, 3e9, 2147483648, 2147483520, -2147483648,
  -2147483904, 1e-40, -1e-45, 1e30, 65536.75, -7.25].map(f32bits).concat([0x7fc00000, 0xffc00000, 0x7fa00001, 0xff812345, 0x7fc54321]);
const INTS = [0, 1, -1, 3, 0x7fffffff, 0x80000000, 0x01000001, 0xfeffffff, 16777217, -16777217, 12345678];

function setup(mem, cpu, r, mxcsr) {
  const val = () => ((r() & 3) ? SPECIAL[r() % SPECIAL.length] : f32bits(((r() % 20000) - 10000) / 64));
  for (let k = 0; k < 8; k++) for (let l = 0; l < 4; l++) mem.write32(cpu.xmmAddr(k) + 4 * l, (r() & 7) ? val() : r()); // some integer lanes
  for (let i = 0; i < 0x100; i += 4) mem.write32(MEMOP + i, (r() & 3) ? val() : INTS[r() % INTS.length]);
  for (let k = 0; k < 8; k++) cpu.setReg(k, (r() & 1) ? INTS[r() % INTS.length] : r());
  cpu.eax = MEMOP; cpu.edi = FXAREA; cpu.esp = DATA + 0xf00;
  cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
  cpu.mxcsr = mxcsr;
}

function snapshot(E) {
  const { mem, cpu } = E;
  const s = { eip: hex(cpu.eip), eflags: hex(cpu.eflags & ARITH), regs: [], xmm: [], mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  for (let k = 0; k < 8; k++) s.xmm.push(Buffer.from(mem.bytes(cpu.xmmAddr(k), 16)).toString('hex'));
  return s;
}

/** Run `code` (bytes) on both executors from the same state; compare everything visible. */
function runBoth(code, seed, mxcsr, label, slice) {
  for (const E of [EI, EJ]) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x100, 0x2000, 0xcc);
    mem.writeBytes(CODE, code);
    mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
    setup(mem, cpu, prng(seed), mxcsr);
    cpu.eip = CODE;
  }
  const end = CODE + code.length;
  const ri = EI.run(end), rj = EJ.run(end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), `${label}: jit state differs from the interpreter`);
}

// ---------------------------------------------------------------- program generator
const X = (r) => r() & 7; // any XMM register
const G = (r) => [1, 2, 3, 5, 6][r() % 5]; // GPR destinations: not eax (operand base), esp, edi (FXSAVE area)
const regrm = (reg, rm) => 0xc0 | (reg << 3) | rm;
const mem8 = (r, reg) => [0x40 | (reg << 3), (r() % 0x40) * 4]; // [eax + disp8], 4-aligned within the 256 bytes
const SS_OPS = [0x58, 0x59, 0x5c, 0x5e, 0x5d, 0x5f, 0x51, 0x53, 0x52]; // add mul sub div min max sqrt rcp rsqrt
/** one instruction (array of bytes) of the mix; `consumer` = a JCC/SETCC/CMOVCC may follow a compare */
function insn(r) {
  const k = r() % 100;
  if (k < 10) return [0xf3, 0x0f, 0x10, regrm(X(r), X(r))]; // movss x,x
  if (k < 18) return [0xf3, 0x0f, 0x10, ...mem8(r, X(r))]; // movss x,m
  if (k < 24) return [0xf3, 0x0f, 0x11, ...mem8(r, X(r))]; // movss m,x
  if (k < 40) { const op = SS_OPS[r() % SS_OPS.length]; return (r() & 3) ? [0xf3, 0x0f, op, regrm(X(r), X(r))] : [0xf3, 0x0f, op, ...mem8(r, X(r))]; }
  if (k < 45) return (r() & 3) ? [0xf3, 0x0f, 0x2a, regrm(X(r), r() & 7)] : [0xf3, 0x0f, 0x2a, ...mem8(r, X(r))]; // cvtsi2ss
  if (k < 50) { const op = (r() & 1) ? 0x2c : 0x2d; return (r() & 3) ? [0xf3, 0x0f, op, regrm(G(r), X(r))] : [0xf3, 0x0f, op, ...mem8(r, G(r))]; } // cvt(t)ss2si
  if (k < 60) { // (u)comiss, then a condition consumer most of the time
    const op = (r() & 1) ? 0x2f : 0x2e;
    const cmp = (r() & 3) ? [0x0f, op, regrm(X(r), X(r))] : [0x0f, op, ...mem8(r, X(r))];
    const cc = r() & 15, c = r() % 5;
    if (c === 0) return [...cmp, 0x0f, 0x90 + cc, regrm(0, [1, 2, 3, 5, 6][r() % 5])]; // setcc r8 (cl dl bl ch dh)
    if (c === 1) return [...cmp, 0x0f, 0x40 + cc, regrm(G(r), r() & 7)]; // cmovcc
    if (c === 2) return [...cmp, 0x83, 0xd1, 0x00]; // adc ecx, 0 (CF through EFLAGS)
    return cmp; // a JCC may be generated next (see program), or the flags read later
  }
  if (k < 63) return [0x0f, 0x58, regrm(X(r), X(r))]; // addps
  if (k < 65) return [0x0f, 0xc6, regrm(X(r), X(r)), r() & 0xff]; // shufps
  if (k < 67) return [0x0f, 0x28, regrm(X(r), X(r))]; // movaps
  if (k < 68) return [0x0f, 0x57, regrm(X(r), X(r))]; // xorps
  if (k < 70) return [0xf3, 0x0f, 0x5a, regrm(X(r), X(r))]; // cvtss2sd
  if (k < 72) return [0xf2, 0x0f, 0x5a, regrm(X(r), X(r))]; // cvtsd2ss
  if (k < 74) return [0xf2, 0x0f, [0x58, 0x59, 0x5d][r() % 3], regrm(X(r), X(r))]; // addsd / mulsd / minsd
  if (k < 76) return [0x66, 0x0f, 0x6e, regrm(X(r), r() & 7)]; // movd x, r32
  if (k < 78) return [0x66, 0x0f, 0x7e, regrm(X(r), G(r))]; // movd r32, x
  if (k < 79) return [0xf3, 0x0f, 0xc2, regrm(X(r), X(r)), r() & 7]; // cmpss
  if (k < 80) return [0x0f, 0x14, regrm(X(r), X(r))]; // unpcklps
  if (k < 84) return [[0x01, 0xd1], [0x29, 0xf3], [0x31, 0xd2], [0xff, 0xc1]][r() % 4]; // add ecx,edx / sub ebx,esi / xor edx,edx / inc ecx
  if (k < 87) return [0x0f, 0x90 + (r() & 15), regrm(0, 2)]; // setcc dl (flags of whatever came before)
  if (k < 88) return [0x0f, 0xae, 0x07]; // fxsave [edi] (interpreter fallback: reads the XMM registers)
  if (k < 90) return [0xeb, 0x00]; // jmp +0 (a block boundary)
  return null; // jcc over the next instruction
}
function program(seed, n = 40) {
  const r = prng(seed);
  const out = [];
  let pendingJcc = -1;
  for (let i = 0; i < n; i++) {
    const b = insn(r);
    if (b === null) { out.push(0x70 + (r() & 15), 0); pendingJcc = out.length - 1; continue; }
    out.push(...b);
    if (pendingJcc >= 0) { out[pendingJcc] = b.length; pendingJcc = -1; }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- tests
test('the scalar single-precision family is translated through the lane-0 shadows', () => {
  for (const k of ['MOVSS', 'ADDSS', 'MULSS', 'SUBSS', 'CVTSI2SS', 'CVTTSS2SI', 'COMISS', 'UCOMISS']) assert.ok(XMM_SHADOW_OPS.has(OP[k]), k);
  for (const k of ['CVTSS2SD', 'CVTSD2SS', 'ADDSD', 'ADDPS', 'MOVSD']) assert.ok(!XMM_SHADOW_OPS.has(OP[k]), k);
});

test('generated scalar-single programs match the interpreter (every MXCSR rounding mode)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const code = program(seed * 7919);
    const mx = 0x1f80 | ((seed & 3) << 13);
    runBoth(code, seed, mx, `seed ${seed} (${Buffer.from(code).toString('hex')})`);
  }
});

test('generated programs survive time slices at every instruction (exits with dirty shadows)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const code = program(seed * 104729 + 3, 25);
    runBoth(code, seed + 1000, 0x1f80, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 3));
  }
});

test('COMISS/UCOMISS + every JCC / SETCC / CMOVCC, flags dead or read afterwards', () => {
  const pairs = [[1, 2], [2, 1], [2, 2], [0, -0], [NaN, 1], [1, NaN], [-Infinity, Infinity], [1e-40, 0]];
  for (const cc of Array.from({ length: 16 }, (_, i) => i)) {
    for (const [a, b] of pairs) {
      for (const op of [0x2e, 0x2f]) {
        // comiss xmm1, xmm2 ; jcc +3 ; mov cl, 1 (b1 01) ... ; setcc dl ; cmovcc ebx, esi ; then
        // a: add ecx, edx (flags dead after the jcc) / b: setb dh ; seto ch (flags read after: materialized)
        const tail = [[0x01, 0xd1], [0x0f, 0x92, 0xc6, 0x0f, 0x90, 0xc5]];
        for (const t of tail) {
          const code = Uint8Array.from([0x0f, op, 0xca, 0x70 + cc, 2, 0xb1, 0x01, 0x0f, 0x2f, 0xca, 0x0f, 0x90 + cc, 0xc2,
            0x0f, 0x2e, 0xca, 0x0f, 0x40 + cc, 0xde, ...t]);
          const label = `cc ${cc} op ${hex(op)} a=${a} b=${b} tail ${t.length}`;
          const set = (E) => { E.mem.write32(E.cpu.xmmAddr(1), f32bits(a)); E.mem.write32(E.cpu.xmmAddr(2), f32bits(b)); };
          for (const E of [EI, EJ]) {
            const { mem, cpu } = E;
            cpu.reset(); mem.fill(DATA, DATA_SIZE, 0); mem.fill(CODE - 0x100, 0x2000, 0xcc); mem.writeBytes(CODE, code);
            setup(mem, cpu, prng(cc * 31 + 7), 0x1f80); set(E); cpu.eip = CODE;
          }
          const end = CODE + code.length;
          assert.equal(EI.run(end), EXIT.HALT, label);
          assert.equal(EJ.run(end), EXIT.HALT, label);
          assert.deepEqual(snapshot(EJ), snapshot(EI), label);
        }
      }
    }
  }
});

test('CVTTSS2SI / CVTSS2SI at the conversion limits and in every rounding mode', () => {
  // cvttss2si ecx, xmm0 ; cvtss2si edx, xmm0 ; cvttss2si ebx, [eax] ; cvtss2si esi, [eax]
  const code = Uint8Array.from([0xf3, 0x0f, 0x2c, 0xc8, 0xf3, 0x0f, 0x2d, 0xd0, 0xf3, 0x0f, 0x2c, 0x18, 0xf3, 0x0f, 0x2d, 0x30]);
  const vals = [2147483648, 2147483520, -2147483648, -2147483904, 2.5, -2.5, 3.5, -0.5, 0.5, 1e-40, NaN, Infinity, -Infinity, -0, 1e10, -1e10];
  for (const v of vals) for (let rc = 0; rc < 4; rc++) {
    for (const E of [EI, EJ]) {
      const { mem, cpu } = E;
      cpu.reset(); mem.fill(DATA, DATA_SIZE, 0); mem.fill(CODE - 0x100, 0x2000, 0xcc); mem.writeBytes(CODE, code);
      setup(mem, cpu, prng(5), 0x1f80 | (rc << 13));
      mem.write32(cpu.xmmAddr(0), f32bits(v)); mem.write32(MEMOP, f32bits(-v)); cpu.eip = CODE;
    }
    const end = CODE + code.length;
    assert.equal(EI.run(end), EXIT.HALT); assert.equal(EJ.run(end), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), snapshot(EI), `v=${v} rc=${rc}`);
  }
});

test('shadowed values cross a loop back edge, a packed use and a fallback', () => {
  //    mov ecx, 20
  // L: cvtsi2ss xmm0, ecx ; mulss xmm1, xmm0 ; addss xmm1, [eax] ; movss xmm2, xmm1 ; fxsave [edi] ;
  //    subss xmm2, xmm0 ; shufps xmm3, xmm2, 0 ; movss [eax+8], xmm2 ; dec ecx ; jnz L ;
  //    comiss xmm2, xmm1 ; ja +4 ; mulss xmm2, xmm2 ; addps xmm3, xmm2
  const code = Uint8Array.from([0xb9, 20, 0, 0, 0,
    0xf3, 0x0f, 0x2a, 0xc1, 0xf3, 0x0f, 0x59, 0xc8, 0xf3, 0x0f, 0x58, 0x08, 0xf3, 0x0f, 0x10, 0xd1, 0x0f, 0xae, 0x07,
    0xf3, 0x0f, 0x5c, 0xd0, 0x0f, 0xc6, 0xda, 0x00, 0xf3, 0x0f, 0x11, 0x50, 0x08, 0x49, 0x75, 0xdd,
    0x0f, 0x2f, 0xd1, 0x77, 0x04, 0xf3, 0x0f, 0x59, 0xd2, 0x0f, 0x58, 0xda]);
  for (const slice of [1e6, 7, 3, 1]) {
    for (const E of [EI, EJ]) {
      const { mem, cpu } = E;
      cpu.reset(); mem.fill(DATA, DATA_SIZE, 0); mem.fill(CODE - 0x100, 0x2000, 0xcc); mem.writeBytes(CODE, code);
      setup(mem, cpu, prng(99), 0x1f80);
      mem.write32(cpu.xmmAddr(1), f32bits(0.75)); mem.write32(MEMOP, f32bits(1.25)); cpu.eip = CODE;
    }
    const end = CODE + code.length;
    assert.equal(EI.run(end), EXIT.HALT); assert.equal(EJ.run(end, slice), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), snapshot(EI), `slice ${slice}`);
  }
});

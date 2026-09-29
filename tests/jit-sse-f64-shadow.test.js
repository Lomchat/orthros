// JIT translation of scalar double-precision SSE2 code through f64 shadows of the low qword of the XMM registers
// (translate-sse-float.js / translate-sse-int.js, XMM_SHADOW64_OPS, Emitter.xmmShadowSync64): MOVSD / MOVLPD /
// MOVLPS / MOVQ loads and stores, ADDSD..SQRTSD, CVTSI2SD / CVT(T)SD2SI, (U)COMISD, the whole-register moves copying
// the shadows (MOVAPD reg, reg), MOVHPD leaving a stale low qword alone, PEXTRW / MOVD / MOVQ reading a shadow's bits.
// Checked against the reference interpreter on generated programs mixing them with packed SSE2 (which must see the
// shadows written back), scalar single-precision code (the f32 shadows: a register never holds both kinds),
// CVTSS2SD / CVTSD2SS, PINSRW, x87 loads/stores of the same memory, integer flag writers, block ends, interpreter
// fallbacks (FXSAVE reads the XMM registers from the state block) and time slices, over special values (NaNs with
// payloads, signaling NaNs whose bits a move must keep, ±0, ±inf, denormals, the ±2^31 conversion limits) and every
// MXCSR rounding mode.
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
import { XMM_SHADOW_OPS, XMM_SHADOW64_OPS } from '../src/cpu/jit/translate.js';
import { OP } from '../src/cpu/decoder.js';

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
const X = (r) => r() & 7; // any XMM register
const G = (r) => [1, 2, 3, 5, 6][r() % 5]; // GPR destinations: not eax (operand base), esp, edi (FXSAVE area)
const regrm = (reg, rm) => 0xc0 | (reg << 3) | rm;
const mem8 = (r, reg) => [0x40 | (reg << 3), (r() % 0x20) * 8]; // [eax + disp8], 8-aligned within the 256 bytes
const mem16 = (r, reg) => [0x40 | (reg << 3), (r() % 0x10) * 16]; // 16-aligned (MOVAPD)
const SD_OPS = [0x58, 0x59, 0x5c, 0x5e, 0x5d, 0x5f, 0x51]; // add mul sub div min max sqrt
/** one instruction (array of bytes) of the mix, or null for a JCC over the next one */
function insn(r) {
  const k = r() % 120;
  if (k < 6) return [0xf2, 0x0f, 0x10, regrm(X(r), X(r))]; // movsd x,x
  if (k < 11) return [0xf2, 0x0f, 0x10, ...mem8(r, X(r))]; // movsd x,m
  if (k < 14) return [0xf2, 0x0f, 0x11, ...mem8(r, X(r))]; // movsd m,x
  if (k < 20) return [0x66, 0x0f, 0x12, ...mem8(r, X(r))]; // movlpd x,m
  if (k < 24) return [0x66, 0x0f, 0x13, ...mem8(r, X(r))]; // movlpd m,x
  if (k < 25) return [0x0f, 0x12, ...mem8(r, X(r))]; // movlps x,m
  if (k < 26) return [0x0f, 0x13, ...mem8(r, X(r))]; // movlps m,x
  if (k < 28) return [0x66, 0x0f, 0x16, ...mem8(r, X(r))]; // movhpd x,m
  if (k < 29) return [0x66, 0x0f, 0x17, ...mem8(r, X(r))]; // movhpd m,x
  if (k < 45) { const op = SD_OPS[r() % SD_OPS.length]; return (r() & 3) ? [0xf2, 0x0f, op, regrm(X(r), X(r))] : [0xf2, 0x0f, op, ...mem8(r, X(r))]; }
  if (k < 49) return (r() & 3) ? [0xf2, 0x0f, 0x2a, regrm(X(r), r() & 7)] : [0xf2, 0x0f, 0x2a, 0x40 | (X(r) << 3), (r() % 0x40) * 4]; // cvtsi2sd
  if (k < 53) { const op = (r() & 1) ? 0x2c : 0x2d; return (r() & 3) ? [0xf2, 0x0f, op, regrm(G(r), X(r))] : [0xf2, 0x0f, op, ...mem8(r, G(r))]; } // cvt(t)sd2si
  if (k < 60) { // (u)comisd, then a condition consumer most of the time
    const op = (r() & 1) ? 0x2f : 0x2e;
    const cmp = (r() & 3) ? [0x66, 0x0f, op, regrm(X(r), X(r))] : [0x66, 0x0f, op, ...mem8(r, X(r))];
    const cc = r() & 15, c = r() % 4;
    if (c === 0) return [...cmp, 0x0f, 0x90 + cc, regrm(0, [1, 2, 3, 5, 6][r() % 5])]; // setcc r8
    if (c === 1) return [...cmp, 0x0f, 0x40 + cc, regrm(G(r), r() & 7)]; // cmovcc
    return cmp; // a JCC may be generated next, or the flags read later
  }
  if (k < 66) return [0x66, 0x0f, 0x28, regrm(X(r), X(r))]; // movapd x,x
  if (k < 68) return [0x66, 0x0f, 0x28, ...mem16(r, X(r))]; // movapd x,m
  if (k < 70) return [0x66, 0x0f, 0x29, ...mem16(r, X(r))]; // movapd m,x
  if (k < 71) return [0x0f, 0x28, regrm(X(r), X(r))]; // movaps x,x
  if (k < 72) return [0x0f, 0x10, 0x40 | (X(r) << 3), (r() % 0x1f) * 8]; // movups x,m
  if (k < 74) return [0xf3, 0x0f, 0x7e, ...mem8(r, X(r))]; // movq x,m
  if (k < 75) return [0xf3, 0x0f, 0x7e, regrm(X(r), X(r))]; // movq x,x
  if (k < 76) return [0x66, 0x0f, 0xd6, ...mem8(r, X(r))]; // movq m,x
  if (k < 78) return [0x66, 0x0f, 0x7e, regrm(X(r), G(r))]; // movd r32,x
  if (k < 79) return [0x66, 0x0f, 0x6e, regrm(X(r), r() & 7)]; // movd x,r32
  if (k < 83) return [0x66, 0x0f, 0xc5, regrm(G(r), X(r)), r() & 7]; // pextrw r32,x,imm
  if (k < 84) return [0x66, 0x0f, 0xc4, regrm(X(r), r() & 7), r() & 7]; // pinsrw x,r32,imm
  if (k < 86) return [0x66, 0x0f, [0x58, 0x59, 0x14, 0x57, 0x54][r() % 5], regrm(X(r), X(r))]; // addpd mulpd unpcklpd xorpd andpd
  if (k < 87) return [0x66, 0x0f, 0x70, regrm(X(r), X(r)), r() & 0xff]; // pshufd
  if (k < 88) return [0x66, 0x0f, 0x73, regrm(2, X(r)), [1, 32, 52, 63][r() & 3]]; // psrlq x,imm
  if (k < 90) return [0xf3, 0x0f, [0x10, 0x58, 0x59][r() % 3], regrm(X(r), X(r))]; // movss / addss / mulss (f32 shadows)
  if (k < 91) return [0xf3, 0x0f, 0x10, 0x40 | (X(r) << 3), (r() % 0x40) * 4]; // movss x,m
  if (k < 93) return [0xf3, 0x0f, 0x5a, regrm(X(r), X(r))]; // cvtss2sd
  if (k < 95) return [0xf2, 0x0f, 0x5a, regrm(X(r), X(r))]; // cvtsd2ss
  if (k < 96) return [0xf2, 0x0f, 0xc2, regrm(X(r), X(r)), r() & 7]; // cmpsd
  if (k < 98) return 'fld';
  if (k < 100) return 'fstp';
  if (k < 105) return [[0x01, 0xd1], [0x29, 0xf3], [0x31, 0xd2], [0x81, 0xe1, 0xf0, 0x7f, 0, 0], [0x83, 0xfa, 0x10]][r() % 5]; // add sub xor and cmp
  if (k < 107) return [0x0f, 0x90 + (r() & 15), regrm(0, 2)]; // setcc dl
  if (k < 108) return [0x0f, 0xae, 0x07]; // fxsave [edi] (interpreter fallback: reads the XMM registers)
  if (k < 111) return [0xeb, 0x00]; // jmp +0 (a block boundary)
  return null; // jcc over the next instruction
}
function program(seed, n = 40) {
  const r = prng(seed);
  const out = [];
  let pendingJcc = -1, depth = 0;
  for (let i = 0; i < n; i++) {
    let b = insn(r);
    if (b === null) { out.push(0x70 + (r() & 15), 0); pendingJcc = out.length - 1; continue; }
    // x87 loads / stores of the same memory: never an empty or a full stack (the JIT does not model stack faults), so
    // never skipped by a JCC either
    if ((b === 'fld' || b === 'fstp') && pendingJcc >= 0) continue;
    if (b === 'fld') { if (depth === 8) continue; depth++; b = [0xdd, 0x40, (r() % 0x20) * 8]; } // fld qword [eax+d]
    else if (b === 'fstp') { if (depth === 0) continue; depth--; b = [0xdd, 0x58, (r() % 0x20) * 8]; } // fstp qword [eax+d]
    out.push(...b);
    if (pendingJcc >= 0) { out[pendingJcc] = b.length; pendingJcc = -1; }
  }
  out.push(0xdb, 0xe3); // fninit (x87 pushes of the program left behind: the same state on both sides anyway)
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- tests
test('the scalar double-precision family and the low-qword moves go through the f64 shadows', () => {
  for (const k of ['MOVSD', 'MOVLPD', 'MOVLPS', 'ADDSD', 'MULSD', 'SQRTSD', 'CVTSI2SD', 'CVTTSD2SI', 'COMISD', 'UCOMISD', 'MOVQ', 'MOVD', 'PEXTRW', 'MOVAPD']) assert.ok(XMM_SHADOW64_OPS.has(OP[k]), k);
  for (const k of ['CVTSS2SD', 'CVTSD2SS', 'ADDSS', 'ADDPD', 'UNPCKLPD', 'PSHUFD', 'PINSRW', 'CMPSD']) assert.ok(!XMM_SHADOW64_OPS.has(OP[k]), k);
  // no instruction of one family only is in the other set: a register never holds both kinds of shadow
  for (const op of XMM_SHADOW_OPS) if (XMM_SHADOW64_OPS.has(op)) assert.ok(['MOVAPS', 'MOVAPD', 'MOVDQA', 'MOVUPS', 'MOVUPD', 'MOVDQU', 'LDDQU', 'MOVNTPS', 'MOVNTPD', 'MOVNTDQ'].some((k) => OP[k] === op));
});

test('generated scalar-double programs match the interpreter (every MXCSR rounding mode)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const code = program(seed * 7919 + 11);
    const mx = 0x1f80 | ((seed & 3) << 13);
    runBoth(code, seed, mx, `seed ${seed} (${Buffer.from(code).toString('hex')})`);
  }
});

test('generated scalar-double programs survive time slices at every instruction (exits with dirty shadows)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const code = program(seed * 104729 + 5, 25);
    runBoth(code, seed + 2000, 0x1f80, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 3));
  }
});

test('signaling NaNs and payloads keep their bits through shadowed moves', () => {
  // movlpd xmm0,[eax] ; movapd xmm1,xmm0 ; movsd xmm2,xmm1 ; movlpd [eax+8],xmm2 ; movq xmm3,[eax+16] ; movsd [eax+24],xmm3 ;
  // movhpd xmm1,[eax+32] ; movapd [eax+48],xmm1 ; pextrw ecx,xmm2,3 ; pextrw edx,xmm2,0 ; movd ebx,xmm3 ; movq [eax+64],xmm1
  const code = Uint8Array.from([0x66, 0x0f, 0x12, 0x00, 0x66, 0x0f, 0x28, 0xc8, 0xf2, 0x0f, 0x10, 0xd1, 0x66, 0x0f, 0x13, 0x50, 0x08,
    0xf3, 0x0f, 0x7e, 0x58, 0x10, 0xf2, 0x0f, 0x11, 0x58, 0x18, 0x66, 0x0f, 0x16, 0x48, 0x20, 0x66, 0x0f, 0x29, 0x48, 0x30,
    0x66, 0x0f, 0xc5, 0xca, 0x03, 0x66, 0x0f, 0xc5, 0xd2, 0x00, 0x66, 0x0f, 0x7e, 0xdb, 0x66, 0x0f, 0xd6, 0x48, 0x40]);
  for (const [lo, hi] of [[1, 0x7ff00000], [0xabcdef01, 0xfff7ffff], [0, 0x7ff80000], [0x12345678, 0x7ff81234], [5, 0], [0, 0x80000000]]) {
    const init = (E) => { E.mem.write32(MEMOP, lo); E.mem.write32(MEMOP + 4, hi); E.mem.write32(MEMOP + 16, hi); E.mem.write32(MEMOP + 20, lo); };
    runBoth(code, 7, 0x1f80, `${hex(hi)}:${hex(lo)}`, undefined, init);
    assert.equal(EJ.mem.read32(MEMOP + 8), lo); assert.equal(EJ.mem.read32(MEMOP + 12), hi);
  }
});

test('a CRT-shaped classification: x87 argument through memory, PEXTRW exponent tests, polynomial, result to x87', () => {
  //    mov ecx, 12
  // L: fld qword [eax] ; fstp qword [eax+8] ; movlpd xmm0,[eax+8] ; pextrw edx,xmm0,3 ; and edx,0x7ff0 ; cmp edx,0x3ff0 ;
  //    jae big ; movapd xmm1,xmm0 ; mulsd xmm1,xmm0 ; addsd xmm1,[eax+16] ; mulsd xmm1,xmm0 ; movlpd [eax+24],xmm1 ;
  //    fld qword [eax+24] ; jmp store
  // big: movsd xmm1,[eax+32] ; divsd xmm1,xmm0 ; movlpd [eax+24],xmm1 ; fld qword [eax+24]
  // store: fstp qword [eax+40] ; movsd xmm2,[eax+40] ; addsd xmm0,xmm2 ; movlpd [eax],xmm0 ; dec ecx ; jnz L
  const a = [0xb9, 12, 0, 0, 0];
  const L = [0xdd, 0x00, 0xdd, 0x58, 0x08, 0x66, 0x0f, 0x12, 0x40, 0x08, 0x66, 0x0f, 0xc5, 0xd0, 0x03, 0x81, 0xe2, 0xf0, 0x7f, 0, 0,
    0x81, 0xfa, 0xf0, 0x3f, 0, 0];
  const body = [0x66, 0x0f, 0x28, 0xc8, 0xf2, 0x0f, 0x59, 0xc8, 0xf2, 0x0f, 0x58, 0x48, 0x10, 0xf2, 0x0f, 0x59, 0xc8,
    0x66, 0x0f, 0x13, 0x48, 0x18, 0xdd, 0x40, 0x18];
  const big = [0xf2, 0x0f, 0x10, 0x48, 0x20, 0xf2, 0x0f, 0x5e, 0xc8, 0x66, 0x0f, 0x13, 0x48, 0x18, 0xdd, 0x40, 0x18];
  const store = [0xdd, 0x58, 0x28, 0xf2, 0x0f, 0x10, 0x50, 0x28, 0xf2, 0x0f, 0x58, 0xc2, 0x66, 0x0f, 0x13, 0x00, 0x49];
  const code = [...a, ...L, 0x73, body.length + 2, ...body, 0xeb, big.length, ...big, ...store];
  code.push(0x75, (-(code.length - a.length + 2)) & 0xff);
  for (const x of [0.25, -0.75, 3, 1e-300, 1e300, NaN, -Infinity]) for (const slice of [1e6, 5, 1]) {
    const init = (E) => { E.mem.writeF64(MEMOP, x); E.mem.writeF64(MEMOP + 16, 0.125); E.mem.writeF64(MEMOP + 32, 2); };
    runBoth(Uint8Array.from(code), 3, 0x1f80, `x=${x} slice ${slice}`, slice, init);
  }
});

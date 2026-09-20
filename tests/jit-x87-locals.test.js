// x87 register stack cached in WASM locals (translate-x87.js): regions holding x87/MMX
// instructions keep ST(0..7), the tag word and the precision control in locals and write them
// back at every exit (chaining, exit codes, time slices) and around interpreter fallbacks.
// Hand-built guest snippets run through the JIT and the reference interpreter; the whole x87
// state (all 8 physical registers, TOP, tags, condition bits, control word) must match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const SW_CC = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 14);
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(useJit, opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, fallbackHist: true, ...opts }) : null;
  return {
    mem, cpu, I, jit,
    run(stopAt, boundaries = [], maxInsns = 1000000) {
      I.cache.clear();
      if (!jit) return I.run({ stopAt, maxInsns });
      jit.boundaries = new Set([...boundaries, stopAt]);
      jit.cpu = cpu;
      return jit.run({ stopAt, maxInsns });
    },
  };
}

/** Tiny assembler (32-bit operand/address size); memory operands are absolute addresses. */
class Asm {
  constructor(base) { this.base = base; this.bytes = []; this.labels = new Map(); this.fixups = []; }
  get pc() { return this.base + this.bytes.length; }
  label(name) { this.labels.set(name, this.pc); return this; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  /** opcode bytes + ModRM (mod 00, rm 101 = disp32) with reg field `ext` */
  abs(op, ext, addr) { return this.emit(...op, (ext << 3) | 5).imm32(addr); }
  movEcxImm(v) { return this.emit(0xb9).imm32(v); }
  movEaxAbs(a) { return this.emit(0xa1).imm32(a); }
  movAbsEax(a) { return this.emit(0xa3).imm32(a); }
  decEcx() { return this.emit(0x49); }
  jmp(name) { this.emit(0xe9); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  jcc(cc, name) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  hlt() { return this.emit(0xf4); }
  // x87
  fld1() { return this.emit(0xd9, 0xe8); }
  fldz() { return this.emit(0xd9, 0xee); }
  fldpi() { return this.emit(0xd9, 0xeb); }
  fldSt(i) { return this.emit(0xd9, 0xc0 + i); }
  fxch(i) { return this.emit(0xd9, 0xc8 + i); }
  fstSt(i) { return this.emit(0xdd, 0xd0 + i); }
  fstpSt(i) { return this.emit(0xdd, 0xd8 + i); }
  ffree(i) { return this.emit(0xdd, 0xc0 + i); }
  faddSt0St(i) { return this.emit(0xd8, 0xc0 + i); }
  faddStSt0(i) { return this.emit(0xdc, 0xc0 + i); }
  faddp(i = 1) { return this.emit(0xde, 0xc0 + i); }
  fmulSt0St(i) { return this.emit(0xd8, 0xc8 + i); }
  fmulp(i = 1) { return this.emit(0xde, 0xc8 + i); }
  fsubp(i = 1) { return this.emit(0xde, 0xe8 + i); }
  fdivp(i = 1) { return this.emit(0xde, 0xf8 + i); }
  fldQ(a) { return this.abs([0xdd], 0, a); }
  fldD(a) { return this.abs([0xd9], 0, a); }
  fstpQ(a) { return this.abs([0xdd], 3, a); }
  fstQ(a) { return this.abs([0xdd], 2, a); }
  fstpD(a) { return this.abs([0xd9], 3, a); }
  faddQ(a) { return this.abs([0xdc], 0, a); }
  fmulQ(a) { return this.abs([0xdc], 1, a); }
  fdivQ(a) { return this.abs([0xdc], 6, a); }
  fildD(a) { return this.abs([0xdb], 0, a); }
  fistpD(a) { return this.abs([0xdb], 3, a); }
  fsin() { return this.emit(0xd9, 0xfe); }
  fcos() { return this.emit(0xd9, 0xff); }
  fsqrt() { return this.emit(0xd9, 0xfa); }
  fchs() { return this.emit(0xd9, 0xe0); }
  fxam() { return this.emit(0xd9, 0xe5); }
  fnstswAx() { return this.emit(0xdf, 0xe0); }
  fnstswM(a) { return this.abs([0xdd], 7, a); }
  fnstenv(a) { return this.abs([0xd9], 6, a); }
  fldcw(a) { return this.abs([0xd9], 5, a); }
  fnstcw(a) { return this.abs([0xd9], 7, a); }
  fincstp() { return this.emit(0xd9, 0xf7); }
  fdecstp() { return this.emit(0xd9, 0xf6); }
  fninit() { return this.emit(0xdb, 0xe3); }
  fcompp() { return this.emit(0xde, 0xd9); }
  fucomip(i) { return this.emit(0xdf, 0xe8 + i); }
  fcmovb(i) { return this.emit(0xda, 0xc0 + i); }
  // MMX
  movqMm0(a) { return this.abs([0x0f, 0x6f], 0, a); }
  movqToMem(a) { return this.abs([0x0f, 0x7f], 0, a); }
  padddMm0Mm0() { return this.emit(0x0f, 0xfe, 0xc0); }
  emms() { return this.emit(0x0f, 0x77); }
  finish() {
    for (const [at, name] of this.fixups) {
      const target = this.labels.get(name); if (target === undefined) throw new Error('label ' + name);
      const rel = target - (this.base + at + 4);
      this.bytes[at] = rel & 0xff; this.bytes[at + 1] = (rel >> 8) & 0xff; this.bytes[at + 2] = (rel >> 16) & 0xff; this.bytes[at + 3] = (rel >>> 24) & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

function load(E, code, data = []) {
  E.cpu.reset();
  E.mem.fill(DATA, 0x1000, 0);
  E.mem.fill(CODE, 0x1000, 0xcc);
  E.mem.writeBytes(CODE, code);
  for (const [off, v] of data) E.mem.writeF64(DATA + off, v);
  E.cpu.eip = CODE;
  E.cpu.esp = DATA + 0x800;
  E.cpu.eflags = F.RESERVED1 | F.IF;
}
/** Every observable piece of state: GPRs, arithmetic flags, the full x87 state, the data page. */
function snapshot(E) {
  const c = E.cpu;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cw: hex(c.fpuCw), cc: hex(c.fpuSw & SW_CC), fpr: [], mem: Buffer.from(E.mem.bytes(DATA, 128)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(c.fpr(k));
  return s;
}
/** Run `code` on both executors (JIT with region boundaries) and compare the snapshots. */
function both(code, data, stopAt, boundaries = [], maxInsns) {
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code, data); load(EJ, code, data);
  assert.equal(EI.run(stopAt, [], maxInsns), EXIT.HALT);
  assert.equal(EJ.run(stopAt, boundaries, maxInsns), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  return { EI, EJ };
}

// acc/x kept on the x87 stack across a loop whose body spans two regions (boundary at L1, L2
// becomes its own region through the `jmp L2` exit): every iteration chains L1 -> L2 -> L1, so
// the cached stack is flushed and reloaded at each transition.
//   fldz ; fld1 ; mov ecx, N                 (acc = ST1, x = ST0)
//   L1: fadd st1, st0 ; fmul st0, [k] ; jmp L2
//   L2: fld st1 ; fmul st0, st0 ; fstp [D+8] ; dec ecx ; jnz L1
//   fstp [D+16] ; fstp [D+24] ; end: hlt
const N = 500;
function loopProgram() {
  const a = new Asm(CODE);
  a.fldz().fld1().movEcxImm(N);
  a.label('L1').faddStSt0(1).fmulQ(DATA).jmp('L2');
  a.label('L2').fldSt(1).fmulSt0St(0).fstpQ(DATA + 8).decEcx().jcc(0x5, 'L1');
  a.fstpQ(DATA + 16).fstpQ(DATA + 24);
  a.label('end').hlt();
  return { code: a.finish(), L1: a.labels.get('L1'), end: a.labels.get('end') };
}

test('x87 values in locals survive chained transitions between regions', () => {
  const { code, L1, end } = loopProgram();
  const { EJ } = both(code, [[0, 1.001]], end, [L1]);
  // x = 1.001^N, acc = sum of 1.001^i for i < N (geometric series)
  const x = 1.001 ** N;
  assert.ok(Math.abs(EJ.mem.readF64(DATA + 16) - x) < 1e-9 * x, 'x');
  assert.ok(Math.abs(EJ.mem.readF64(DATA + 24) - (x - 1) / 0.001) < 1e-6 * x, 'acc');
  assert.equal(EJ.mem.readF64(DATA + 8), EJ.mem.readF64(DATA + 24) ** 2);
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
  assert.ok(EJ.jit.stats.regions >= 3, `regions: ${EJ.jit.stats.regions}`);
  assert.ok(EJ.jit.stats.chained >= 2 * N - 4, `chained: ${EJ.jit.stats.chained}`);
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
});

test('time-slice exits inside an x87 loop flush and reload the cached stack', () => {
  const { code, L1, end } = loopProgram();
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code, [[0, 1.001]]); load(EJ, code, [[0, 1.001]]);
  assert.equal(EI.run(end), EXIT.HALT);
  let slices = 0, r;
  for (;;) {
    r = EJ.run(end, [L1], 37);
    if (r !== EXIT.TIMESLICE) break;
    slices++;
    assert.ok(EJ.jit.remaining() <= 0, 'budget exhausted at the time slice');
    // the state block holds the live stack at the slice: TOP = 6 with two valid registers
    assert.equal(EJ.cpu.fpuTop, 6); assert.equal(EJ.cpu.fpuTw, 0b11000000);
    assert.ok(Number.isFinite(EJ.cpu.fpr(6)) && Number.isFinite(EJ.cpu.fpr(7)));
    assert.ok(slices < 10 * N, 'runaway');
  }
  assert.equal(r, EXIT.HALT);
  assert.ok(slices >= 50, `slices: ${slices}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
});

test('an interpreter fallback (FSIN) in the middle of a native x87 sequence', () => {
  // fld1 ; fld [D] ; fsin ; fadd st0, st1 ; fxch ; fsqrt ; fld [D+8] ; fcos ; faddp ; fstp [D+16] ; fstp [D+24] ; hlt
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).fsin().faddSt0St(1).fxch(1).fsqrt().fldQ(DATA + 8).fcos().faddp().fstpQ(DATA + 16).fstpQ(DATA + 24);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 0.7], [8, 2.5]], end);
  assert.equal(EJ.mem.readF64(DATA + 16), 1 + Math.cos(2.5));
  assert.equal(EJ.mem.readF64(DATA + 24), Math.sin(0.7) + 1);
  assert.equal(EJ.jit.stats.fallbackSteps, 2, 'FSIN and FCOS fell back');
  assert.equal(EJ.cpu.fpuTw, 0);
});

test('FXCH / FSTP st(i) / FLD st(i) / FFREE / FINCSTP permutations with tags via FNSTENV and FXAM', () => {
  // build a stack of 4 values, permute it, free one, then observe tags/values with FNSTENV, FXAM
  // (fallback, reads the memory copy) and FNSTSW, rotate TOP with FINCSTP/FDECSTP, and pop the rest
  // (no instruction reads an empty register: the interpreter answers those with the indefinite
  // NaN, which the JIT does not emulate, D014)
  //   fld1 ; fldz ; fldpi ; fld 3.5       p7=1 p6=0 p5=pi p4=3.5, TOP=4
  //   fld st2 ; fxch st1                  p3=0 pushed, then swapped with p4: p3=3.5 p4=0
  //   fstp st2                            p5=3.5, pop (p3 freed), TOP=4
  //   fld st1 ; ffree st3 ; fst st4       p3=3.5 (TOP=3), p6 freed, p7=3.5
  //   fnstenv ; fxam (3.5) ; fincstp x3 ; fxam (empty p6) ; fdecstp x3
  //   fld1 ; faddp                        p2=1 then p3 = 4.5, TOP=3
  //   fstp x3 ; fincstp ; fstp            4.5, 0, 3.5, skip the freed p6, 3.5 -> TOP=0
  const a = new Asm(CODE);
  a.fld1().fldz().fldpi().fldQ(DATA);
  a.fldSt(2).fxch(1).fstpSt(2).fldSt(1).ffree(3).fstSt(4);
  a.fnstenv(DATA + 32);
  a.fxam().fnstswAx().movAbsEax(DATA + 64);
  a.fincstp().fincstp().fincstp().fxam().fnstswM(DATA + 68);
  a.fdecstp().fdecstp().fdecstp();
  a.fld1().faddp().fstpQ(DATA + 72);
  a.fstpQ(DATA + 80).fstpQ(DATA + 88).fincstp().fstpQ(DATA + 96);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 3.5]], end);
  const env = (o) => EJ.mem.read32(DATA + 32 + o);
  assert.equal((env(4) >> 11) & 7, 3, 'TOP in the saved status word');
  const fullTags = env(8) & 0xffff;
  const tagOf = (phys) => (fullTags >> (2 * phys)) & 3;
  assert.equal(tagOf(3), 0, 'ST0 valid'); assert.equal(tagOf(4), 1, 'ST1 zero'); assert.equal(tagOf(5), 0, 'ST2 valid');
  assert.equal(tagOf(6), 3, 'ST3 freed'); assert.equal(tagOf(7), 0, 'ST4 valid'); assert.equal(tagOf(0), 3, 'never used');
  assert.equal(EJ.mem.read32(DATA + 64) & SW_CC, 1 << 10, 'FXAM of 3.5: C2');
  assert.equal(EJ.mem.read16(DATA + 68) & SW_CC, (1 << 8) | (1 << 14), 'FXAM of the freed slot: empty');
  assert.equal(EJ.mem.readF64(DATA + 72), 4.5);
  assert.equal(EJ.mem.readF64(DATA + 80), 0); assert.equal(EJ.mem.readF64(DATA + 88), 3.5);
  assert.equal(EJ.mem.readF64(DATA + 96), 3.5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((p) => EJ.cpu.fpr(p)), [0, 0, 1, 4.5, 0, 3.5, 0, 3.5], 'physical registers written back');
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
  assert.equal(EJ.jit.stats.fallbackSteps, 3, 'FNSTENV and the two FXAM');
});

test('FCMOVcc, FUCOMIP and FCOMPP condition results with the cached stack', () => {
  // fld 2 ; fld 3 ; fucomip st1 (3 > 2: no CF, pop) ; fld 9 ; fcmovb st1 (not taken) ; fst [D+24] ; fcompp (9 vs 2)
  // fld 3 ; fld 2 ; fucomip st1 (2 < 3: CF, pop) ; fld 9 ; fcmovb st1 (ST0 = 3) ; fst [D+32] ; fcompp (3 vs 3: C3)
  const a = new Asm(CODE);
  a.fldQ(DATA).fldQ(DATA + 8).fucomip(1).fldQ(DATA + 16).fcmovb(1).fstQ(DATA + 24).fcompp();
  a.fldQ(DATA + 8).fldQ(DATA).fucomip(1).fldQ(DATA + 16).fcmovb(1).fstQ(DATA + 32).fcompp();
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 2], [8, 3], [16, 9]], end);
  assert.equal(EJ.mem.readF64(DATA + 24), 9, 'not moved (3 > 2)');
  assert.equal(EJ.mem.readF64(DATA + 32), 3, 'moved (2 < 3)');
  assert.equal(EJ.cpu.fpuTw, 0); assert.equal(EJ.cpu.fpuTop, 0);
  assert.equal(EJ.cpu.fpuSw & SW_CC, 1 << 14, 'FCOMPP of equal values: C3');
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
});

test('MMX instructions between x87 instructions re-base the cached stack on TOP = 0', () => {
  // TOP != 0 at the MMX access: the rotation path (flush with the old TOP, reload with 0)
  //   fld1 ; fld [D] ; faddp                     (ST0 = 3.5+1 in physical slot 7, TOP = 7)
  //   movq mm0, [D+8] ; paddd mm0, mm0 ; movq [D+16], mm0   (TOP = 0, all tags valid)
  //   fxch st(7) ; fst [D+24]                    (ST(7) is now physical slot 7 = 4.5 -> slot 0; no
  //                                               push: with every tag valid a push would overflow)
  //   fadd st0, st(6) ; fstp [D+32]              (slot 6 still holds the popped 3.5 -> 8; pop -> TOP = 1)
  //   emms ; fld1 ; fstp [D+40] ; hlt            (tags cleared, TOP 1 -> 0: rotation again)
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).faddp();
  a.movqMm0(DATA + 8).padddMm0Mm0().movqToMem(DATA + 16);
  a.fxch(7).fstQ(DATA + 24);
  a.faddSt0St(6).fstpQ(DATA + 32);
  a.emms().fld1().fstpQ(DATA + 40);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 3.5], [8, 1.5]], end);
  assert.equal(EJ.mem.readF64(DATA + 24), 4.5, 'the value left at TOP 7 is ST(7) once TOP is 0 (rotation of the cached stack)');
  assert.equal(EJ.mem.readF64(DATA + 32), 8);
  assert.equal(EJ.mem.readF64(DATA + 40), 1);
  assert.equal(EJ.mem.read32(DATA + 20), 0x7ff00000, 'paddd of 1.5 as integer lanes: high dword 0x3ff80000 doubled');
  assert.deepEqual([EJ.cpu.fpr(0), EJ.cpu.fpr(6), EJ.cpu.fpr(7)], [8, 3.5, 1], 'physical slots after the rotations');
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
  // TOP == 0 at the MMX access (no rotation), EMMS before the pushes (every tag is valid after an
  // MMX op: a push would overflow), then FNINIT with TOP = 7 (rotation, tags cleared)
  const b = new Asm(CODE);
  b.movqMm0(DATA + 8).padddMm0Mm0().movqToMem(DATA + 16).emms().fld1().fldpi().faddp().fstpQ(DATA + 24);
  b.fld1().fninit().fldpi().fstpQ(DATA + 32);
  b.label('end').hlt();
  const { EJ: EJ2 } = both(b.finish(), [[8, 1.5]], b.labels.get('end'));
  assert.equal(EJ2.mem.readF64(DATA + 24), 1 + Math.PI);
  assert.equal(EJ2.mem.readF64(DATA + 32), Math.PI);
  assert.equal(EJ2.cpu.fpuTop, 0); assert.equal(EJ2.cpu.fpuTw, 0); assert.equal(EJ2.cpu.fpuCw, 0x037f);
  assert.equal(EJ2.jit.stats.fallbackSteps, 0);
});

test('24-bit precision control through FLDCW rounds natively (nearest) and via round24 otherwise', () => {
  // cw24 = 0x007f (PC = single, RC = nearest), cw24d = 0x047f (RC = down), cw53 = 0x027f
  const CW24 = DATA + 120, CW24D = DATA + 122, CW53 = DATA + 124;
  const a = new Asm(CODE);
  a.fldcw(CW24);
  a.fldQ(DATA).fmulQ(DATA + 8).fstpQ(DATA + 32); // normal range: fround(product)
  a.fldQ(DATA + 16).fmulQ(DATA + 16).fstpQ(DATA + 40); // 1e30^2 = 1e60: beyond the f32 range, extended exponent kept
  a.fldz().fmulQ(DATA + 8).fstpQ(DATA + 48); // zero
  a.fldQ(DATA + 24).fmulQ(DATA + 24).fstpQ(DATA + 56); // 1e-30^2: below the f32 normal range
  a.fldQ(DATA).fsqrt().fstpQ(DATA + 64);
  a.fldcw(CW24D).fldQ(DATA).fmulQ(DATA + 8).fstpQ(DATA + 72); // directed rounding
  a.fldcw(CW53).fldQ(DATA).fmulQ(DATA + 8).fstpQ(DATA + 80); // double precision: no rounding
  a.fnstcw(DATA + 88);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const EI = makeExec(false), EJ = makeExec(true);
  const data = [[0, 1.1], [8, 3.3], [16, 1e30], [24, 1e-30]];
  for (const E of [EI, EJ]) { load(E, a.finish(), data); E.mem.write16(CW24, 0x007f); E.mem.write16(CW24D, 0x047f); E.mem.write16(CW53, 0x027f); }
  assert.equal(EI.run(end), EXIT.HALT);
  assert.equal(EJ.run(end), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  const r = (o) => EJ.mem.readF64(DATA + o);
  assert.equal(r(32), Math.fround(1.1 * 3.3));
  assert.ok(Number.isFinite(r(40)) && Math.abs(r(40) - 1e60) < 1e60 * 2 ** -24, `1e60 rounded to 24 bits, not infinity: ${r(40)}`);
  assert.equal(r(48), 0);
  assert.ok(r(56) !== 0 && r(56) !== Math.fround(1e-60), 'denormal-range value keeps the f64 exponent');
  assert.equal(r(64), Math.fround(Math.sqrt(1.1)));
  assert.ok(r(72) <= 1.1 * 3.3 && r(72) >= Math.fround(1.1 * 3.3) - 2 ** -20, 'rounded down');
  assert.equal(r(80), 1.1 * 3.3);
  assert.equal(EJ.mem.read16(DATA + 88), 0x027f);
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
  // NaN / infinity / negative zero pass through the 24-bit rounding unchanged
  const b = new Asm(CODE);
  b.fldcw(CW24).fldQ(DATA + 16).faddQ(DATA).fstpQ(DATA + 32).fldQ(DATA + 24).fmulQ(DATA).fstpQ(DATA + 40).fldQ(DATA + 8).fmulQ(DATA).fstpQ(DATA + 48);
  b.label('end').hlt();
  const EI2 = makeExec(false), EJ2 = makeExec(true);
  for (const E of [EI2, EJ2]) { load(E, b.finish(), [[0, 1.5], [8, -0], [16, NaN], [24, Infinity]]); E.mem.write16(CW24, 0x007f); }
  assert.equal(EI2.run(b.labels.get('end')), EXIT.HALT);
  assert.equal(EJ2.run(b.labels.get('end')), EXIT.HALT);
  assert.deepEqual(snapshot(EJ2), snapshot(EI2));
  assert.ok(Number.isNaN(EJ2.mem.readF64(DATA + 32)));
  assert.equal(EJ2.mem.readF64(DATA + 40), Infinity);
  assert.ok(Object.is(EJ2.mem.readF64(DATA + 48), -0));
});

test('x87 regions and plain regions mix: a non-x87 region between two x87 regions keeps the stack', () => {
  //   A: fld1 ; fld [D] ; jmp B          (x87 region, TOP = 6)
  //   B: mov eax, [D+8] ; dec ecx ; jmp C   (integer-only region: FPR untouched in memory)
  //   C: faddp ; fstp [D+16] ; hlt
  const a = new Asm(CODE);
  a.label('A').fld1().fldQ(DATA).jmp('B');
  a.label('B').movEaxAbs(DATA + 8).decEcx().jmp('C');
  a.label('C').faddp().fstpQ(DATA + 16);
  a.label('end').hlt();
  const B = a.labels.get('B'), C = a.labels.get('C'), end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 2.25]], end, [B, C]);
  assert.equal(EJ.mem.readF64(DATA + 16), 3.25);
  assert.equal(EJ.cpu.fpuTop, 0);
  // run again: A -> B -> C now chain (B was translated without the x87 cache)
  load(EJ, a.finish(), [[0, 2.25]]);
  assert.equal(EJ.run(end, [B, C]), EXIT.HALT);
  assert.equal(EJ.mem.readF64(DATA + 16), 3.25);
  assert.ok(EJ.jit.stats.chained >= 2, `chained: ${EJ.jit.stats.chained}`);
});

test('integer conversions and RC with the cached stack (FILD / FISTP / FRNDINT)', () => {
  // fild [D] (7) ; fld 2.5 ; faddp ; fistp [D+16]   nearest: 9.5 -> 10 (ties to even)
  // fldcw down ; fld 2.5 ; fistp [D+20]              -> 2 ; fld 2.5 ; frndint ; fstp [D+24] -> 2
  const CWD = DATA + 120;
  const b = new Asm(CODE);
  b.fildD(DATA).fldQ(DATA + 8).faddp().fistpD(DATA + 16).fldcw(CWD).fldQ(DATA + 8).fistpD(DATA + 20).fldQ(DATA + 8).emit(0xd9, 0xfc).fstpQ(DATA + 24);
  b.label('end').hlt();
  const EI = makeExec(false), EJ = makeExec(true);
  for (const E of [EI, EJ]) { load(E, b.finish(), [[8, 2.5]]); E.mem.write32(DATA, 7); E.mem.write16(CWD, 0x067f); }
  assert.equal(EI.run(b.labels.get('end')), EXIT.HALT);
  assert.equal(EJ.run(b.labels.get('end')), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  assert.equal(EJ.mem.read32(DATA + 16), 10);
  assert.equal(EJ.mem.read32(DATA + 20), 2);
  assert.equal(EJ.mem.readF64(DATA + 24), 2);
});

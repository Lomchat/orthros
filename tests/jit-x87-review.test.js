// Adversarial review of the x87-in-locals JIT change (translate-x87.js, translate.js x87 cache):
// hand-encoded guest snippets run through the JIT and the reference interpreter, the complete
// x87 state (8 physical registers, TOP, tags, condition bits, control word), GPRs, arithmetic
// flags and the data page must match. Each test targets one way the cached stack could go out
// of sync with the memory copy: exit ordering (SMC), time slices at every possible instruction
// count, precision control changes (FLDCW / FNINIT / FLDENV fallback), comparison flags with a
// pending static shift, MMX re-basing with a pending shift, fallbacks that branch.
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
    /** run to the halt, invalidating translated code at SMC exits (as core/vm.js does) */
    runSmc(stopAt, boundaries = []) {
      for (let guard = 0; guard < 100; guard++) {
        const r = this.run(stopAt, boundaries);
        if (r !== EXIT.SMC) return r;
        jit.invalidate(mem.read32(cpu.base + ST.EXIT_ARG), 16);
      }
      throw new Error('SMC loop');
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
  abs(op, ext, addr) { return this.emit(...op, (ext << 3) | 5).imm32(addr); }
  movEcxImm(v) { return this.emit(0xb9).imm32(v); }
  movEaxImm(v) { return this.emit(0xb8).imm32(v); }
  jmpEax() { return this.emit(0xff, 0xe0); }
  movCxImm(v) { return this.emit(0x66, 0xb9, v & 0xff, (v >> 8) & 0xff); }
  movAbsEax(a) { return this.emit(0xa3).imm32(a); }
  pushfd() { return this.emit(0x9c); }
  popEax() { return this.emit(0x58); }
  decEcx() { return this.emit(0x49); }
  jmp(name) { this.emit(0xe9); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  jcc(cc, name) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  /** addr16 LOOP rel8 (interpreter fallback in the JIT) */
  loop16(name) { this.emit(0x67, 0xe2); this.fixups.push([this.bytes.length, name, 1]); return this.emit(0); }
  hlt() { return this.emit(0xf4); }
  // x87
  fld1() { return this.emit(0xd9, 0xe8); }
  fldz() { return this.emit(0xd9, 0xee); }
  fldSt(i) { return this.emit(0xd9, 0xc0 + i); }
  fxch(i = 1) { return this.emit(0xd9, 0xc8 + i); }
  fstSt(i) { return this.emit(0xdd, 0xd0 + i); }
  fstpSt(i) { return this.emit(0xdd, 0xd8 + i); }
  ffree(i) { return this.emit(0xdd, 0xc0 + i); }
  faddSt0St(i) { return this.emit(0xd8, 0xc0 + i); }
  faddStSt0(i) { return this.emit(0xdc, 0xc0 + i); }
  faddp(i = 1) { return this.emit(0xde, 0xc0 + i); }
  fmulSt0St(i) { return this.emit(0xd8, 0xc8 + i); }
  fldQ(a) { return this.abs([0xdd], 0, a); }
  fstpQ(a) { return this.abs([0xdd], 3, a); }
  fstQ(a) { return this.abs([0xdd], 2, a); }
  fstpD(a) { return this.abs([0xd9], 3, a); }
  faddQ(a) { return this.abs([0xdc], 0, a); }
  fmulQ(a) { return this.abs([0xdc], 1, a); }
  fistpD(a) { return this.abs([0xdb], 3, a); }
  fistD(a) { return this.abs([0xdb], 2, a); }
  fchs() { return this.emit(0xd9, 0xe0); }
  fxam() { return this.emit(0xd9, 0xe5); }
  ftst() { return this.emit(0xd9, 0xe4); }
  fcomSt(i) { return this.emit(0xd8, 0xd0 + i); }
  fcomi(i) { return this.emit(0xdb, 0xf0 + i); }
  fucomi(i) { return this.emit(0xdb, 0xe8 + i); }
  fucompp() { return this.emit(0xda, 0xe9); }
  fcompp() { return this.emit(0xde, 0xd9); }
  fcmovne(i) { return this.emit(0xdb, 0xc8 + i); }
  fnstswAx() { return this.emit(0xdf, 0xe0); }
  fnstenv(a) { return this.abs([0xd9], 6, a); }
  fldenv(a) { return this.abs([0xd9], 4, a); }
  fldcw(a) { return this.abs([0xd9], 5, a); }
  fnstcw(a) { return this.abs([0xd9], 7, a); }
  fincstp() { return this.emit(0xd9, 0xf7); }
  fdecstp() { return this.emit(0xd9, 0xf6); }
  fninit() { return this.emit(0xdb, 0xe3); }
  // MMX
  movqMm0(a) { return this.abs([0x0f, 0x6f], 0, a); }
  movqToMem(a) { return this.abs([0x0f, 0x7f], 0, a); }
  padddMm0Mm0() { return this.emit(0x0f, 0xfe, 0xc0); }
  emms() { return this.emit(0x0f, 0x77); }
  finish() {
    for (const [at, name, size = 4] of this.fixups) {
      const target = this.labels.get(name); if (target === undefined) throw new Error('label ' + name);
      const rel = target - (this.base + at + size);
      if (size === 1) { if (rel < -128 || rel > 127) throw new Error('rel8'); this.bytes[at] = rel & 0xff; continue; }
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
function snapshot(E) {
  const c = E.cpu;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cw: hex(c.fpuCw), cc: hex(c.fpuSw & SW_CC), fpr: [], mem: Buffer.from(E.mem.bytes(DATA, 128)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(c.fpr(k));
  return s;
}
/** Run `code` on both executors and compare the snapshots; `setup` may write extra memory. */
function both(code, data, stopAt, boundaries = [], setup = null, msg = '') {
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code, data); load(EJ, code, data);
  if (setup) { setup(EI); setup(EJ); }
  assert.equal(EI.run(stopAt), EXIT.HALT, 'interpreter halts ' + msg);
  assert.equal(EJ.run(stopAt, boundaries), EXIT.HALT, 'JIT halts ' + msg);
  assert.deepEqual(snapshot(EJ), snapshot(EI), msg);
  return { EI, EJ };
}

// (1) exit ordering: a store into a page holding translated code exits with SMC at insn.next,
// i.e. the instruction is complete: FSTP/FISTP must have popped before the exit is taken.
test('FSTP / FISTP into a translated code page: the pop is applied before the SMC exit', () => {
  const T0 = CODE + 0x800, T1 = CODE + 0x808; // same page as the code -> SMC exits
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).fstpQ(T0).fldQ(DATA + 8).fistpD(T1).fstpQ(DATA + 16);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, a.finish(), [[0, 2.5], [8, 7.25]]); load(EJ, a.finish(), [[0, 2.5], [8, 7.25]]);
  assert.equal(EI.run(end), EXIT.HALT);
  assert.equal(EJ.runSmc(end), EXIT.HALT);
  assert.ok(EJ.jit.stats.invalidations >= 2, `SMC exits taken: ${EJ.jit.stats.invalidations}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  assert.equal(EJ.mem.readF64(T0), 2.5); assert.equal(EJ.mem.read32(T1), 7);
  assert.equal(EJ.mem.readF64(DATA + 16), 1, 'the FLD1 is what is left after the two pops');
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
});

// (1)(2) every possible time-slice point: a loop whose blocks end with a pending static shift
// (a JCC right after pushes), TOP wrapping through FINCSTP/FDECSTP, FNSTSW in the middle of a
// shifted block, both JCC directions, region boundaries inside the loop. Run under every
// instruction budget from 1 upwards: each TIMESLICE exit lands at a different block boundary.
function shiftProgram() {
  const a = new Asm(CODE);
  a.movEcxImm(6).fldz();
  a.label('L1').fldQ(DATA).faddSt0St(1).fcomi(1).fnstswAx().movAbsEax(DATA + 64).jcc(0x7, 'L2'); // ja: shift -1 pending at the JCC
  a.fchs().fnstswAx().movAbsEax(DATA + 68);
  a.label('L2').fincstp().fnstswAx().movAbsEax(DATA + 72).fdecstp().fstpSt(1).decEcx().jcc(0x5, 'L1');
  a.fstpQ(DATA + 16);
  a.label('end').hlt();
  return { code: a.finish(), L1: a.labels.get('L1'), L2: a.labels.get('L2'), end: a.labels.get('end') };
}
test('pending static shift at block ends: both JCC directions, region boundaries, every time slice', () => {
  const { code, L1, L2, end } = shiftProgram();
  for (const v of [1.25, -1.25]) {
    for (const bounds of [[], [L1], [L2], [L1, L2]]) {
      const { EJ } = both(code, [[0, v]], end, bounds, null, `v=${v} bounds=${bounds}`);
      // v > 0: the JA is always taken (acc grows); v < 0: never taken, the FCHS alternates acc
      // between 1.25 and -0 (0 negated on even iterations)
      assert.ok(Object.is(EJ.mem.readF64(DATA + 16), v > 0 ? 6 * v : -0), `result for v=${v}`);
      assert.equal(EJ.cpu.fpuTop, 0);
    }
    const EI = makeExec(false); load(EI, code, [[0, v]]); assert.equal(EI.run(end), EXIT.HALT);
    const ref = snapshot(EI);
    for (let budget = 1; budget <= 40; budget++) {
      const EJ = makeExec(true); load(EJ, code, [[0, v]]);
      let r, slices = 0;
      for (;;) {
        r = EJ.run(end, [L1], budget);
        if (r !== EXIT.TIMESLICE) break;
        if (++slices > 2000) throw new Error('runaway');
      }
      assert.equal(r, EXIT.HALT, `budget ${budget}`);
      assert.deepEqual(snapshot(EJ), ref, `v=${v} budget=${budget} slices=${slices}`);
    }
  }
});

// (2) TOP wrap-around and a full stack: 8 pushes (TOP 0 -> 7 -> ... -> 0 wraps), FNSTSW at each
// TOP, FFREE/FXCH/FSTP st(i) permutations, FINCSTP past 7, observed through FNSTENV (fallback).
test('TOP wrap-around with a full stack, FFREE / FXCH / FSTP st(i) tags via FNSTENV', () => {
  const a = new Asm(CODE);
  for (let i = 0; i < 8; i++) a.fldQ(DATA + 8 * i).fnstswAx().movAbsEax(DATA + 64 + 4 * i);
  // TOP = 0, slots 7..0 = 0.5..7.5. fxch: slot0 <-> slot3 ; fstp st5: slot5 = 4.5, slot 0 freed
  // (TOP 1) ; ffree st2: slot 3 freed ; TOP 3 at the FNSTENV ; TOP 2 ; fst st6: slot 0 refilled
  a.fxch(3).fstpSt(5).ffree(2).fincstp().fincstp().fnstenv(DATA + 96).fdecstp().fstSt(6);
  // pop slot 2, skip the freed slot 3 (never read: D014), pop 4..7 (TOP wraps 7 -> 0), 0, then 1
  a.fstpQ(DATA + 128).fincstp().fstpQ(DATA + 136).fstpQ(DATA + 144).fstpQ(DATA + 152).fstpQ(DATA + 160);
  a.fstpQ(DATA + 168).fnstswAx().movAbsEax(DATA + 176).fstpQ(DATA + 184);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const data = [];
  for (let i = 0; i < 8; i++) data.push([8 * i, i + 0.5]);
  const { EJ } = both(a.finish(), data, end);
  for (let i = 0; i < 8; i++) assert.equal((EJ.mem.read32(DATA + 64 + 4 * i) >> 11) & 7, (7 - i) & 7, `TOP after push ${i}`);
  assert.equal(EJ.jit.stats.fallbackSteps, 1, 'only FNSTENV fell back');
});

// (3) precision control: FLDCW with a pending shift then arithmetic in the same block, FNINIT
// resetting PC in the middle of a block, and a fallback (FLDENV) changing the control word.
test('precision control changes inside a block: FLDCW, FNINIT and the FLDENV fallback', () => {
  const CW24 = DATA + 120, ENV = DATA + 200;
  const a = new Asm(CODE);
  a.fldQ(DATA).fldQ(DATA + 8).fldcw(CW24).fmulSt0St(1).fstpQ(DATA + 32); // rounded to 24 bits
  a.fninit().fldQ(DATA).fmulQ(DATA + 8).fstpQ(DATA + 40); // PC back to 64: no rounding
  a.fldcw(CW24).fldenv(ENV).fldQ(DATA).fmulQ(DATA + 8).fstpQ(DATA + 48); // env CW = 0x027f: no rounding
  a.fldQ(DATA).fmulQ(DATA + 8).fldcw(CW24).fstQ(DATA + 56); // FLDCW after the product: unrounded value stored
  a.fmulQ(DATA + 8).fstpQ(DATA + 64); // (1.1 * 3.3) * 3.3 under PC=24 once more
  a.fnstcw(DATA + 72);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const setup = (E) => {
    E.mem.write16(CW24, 0x007f);
    E.mem.write32(ENV, 0x027f); E.mem.write32(ENV + 4, 0); E.mem.write32(ENV + 8, 0xffff);
  };
  const { EJ } = both(a.finish(), [[0, 1.1], [8, 3.3]], end, [], setup);
  const r = (o) => EJ.mem.readF64(DATA + o);
  assert.equal(r(32), Math.fround(1.1 * 3.3));
  assert.equal(r(40), 1.1 * 3.3);
  assert.equal(r(48), 1.1 * 3.3, 'FLDENV set PC = 53');
  assert.equal(r(56), 1.1 * 3.3, 'value computed before the FLDCW is stored unrounded');
  assert.equal(r(64), Math.fround(r(56) * 3.3));
  assert.equal(EJ.mem.read16(DATA + 72), 0x007f);
});

// (4) comparison results: FCOMI (EFLAGS), FCOM/FTST/FUCOMPP (C0/C2/C3), FCMOVcc on them, with a
// pending shift, for ordered, equal, unordered and signed-zero pairs.
test('FCOMI / FCOM / FTST / FUCOMPP / FCMOVcc results for ordered, equal, NaN and signed-zero operands', () => {
  const a = new Asm(CODE);
  a.fldQ(DATA).fldQ(DATA + 8); // ST0 = b, ST1 = a (shift -2)
  a.fcomi(1).pushfd().popEax().movAbsEax(DATA + 64);
  a.fcomSt(1).fnstswAx().movAbsEax(DATA + 68);
  a.ftst().fnstswAx().movAbsEax(DATA + 72);
  a.fucomi(1).pushfd().popEax().movAbsEax(DATA + 76);
  a.fcmovne(1).fstQ(DATA + 80); // ST0 = a when b != a (unordered counts as not-equal)
  a.fucompp().fnstswAx().movAbsEax(DATA + 88);
  a.label('end').hlt();
  const end = a.labels.get('end');
  for (const [x, y] of [[2, 3], [3, 2], [2, 2], [-0, 0], [Infinity, Infinity], [-Infinity, 5]]) {
    both(a.finish(), [[0, x], [8, y]], end, [], null, `a=${x} b=${y}`);
  }
  // unordered operands through the quiet comparisons (the signalling ones also raise IE in the
  // status word, which the JIT never sets: see the todo below)
  const q = new Asm(CODE);
  q.fldQ(DATA).fldQ(DATA + 8);
  q.fucomi(1).pushfd().popEax().movAbsEax(DATA + 64);
  q.fcmovne(1).fstQ(DATA + 72);
  q.fucompp().fnstswAx().movAbsEax(DATA + 80);
  q.label('end').hlt();
  for (const [x, y] of [[NaN, 1], [1, NaN], [NaN, NaN]]) {
    const { EJ } = both(q.finish(), [[0, x], [8, y]], q.labels.get('end'), [], null, `quiet a=${x} b=${y}`);
    assert.equal(EJ.mem.read32(DATA + 64) & (F.ZF | F.PF | F.CF), F.ZF | F.PF | F.CF, 'unordered: ZF PF CF');
    assert.equal(EJ.mem.read32(DATA + 80) & SW_CC, (1 << 8) | (1 << 10) | (1 << 14), 'unordered: C0 C2 C3');
  }
});

// Pre-existing divergence (unchanged by the locals change): the JIT does not set the exception
// flags of the status word for the comparisons (IE on an unordered FCOM / FCOMI / FTST, stack
// faults...); only the condition codes are maintained. A masked IE sets no ES (D034).
test('FCOM with a NaN raises IE (no ES while masked) in the status word', { todo: 'pre-existing: the JIT keeps only the condition codes of the status word' }, () => {
  const a = new Asm(CODE);
  a.fldQ(DATA).fld1().fcomSt(1).fnstswAx();
  a.label('end').hlt();
  const EJ = makeExec(true); load(EJ, a.finish(), [[0, NaN]]);
  assert.equal(EJ.run(a.labels.get('end')), EXIT.HALT);
  assert.equal(EJ.cpu.eax & 0x81, 0x01);
});

// (5) MMX access with a pending shift and TOP != 0 in the same block (run-time rotation of the
// locals), then tag edits on the re-based stack observed through FNSTENV, EMMS, and a push into
// the slot freed afterwards.
test('MMX with a pending shift re-bases the cached stack; tags after MMX / FFREE / EMMS', () => {
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).fldQ(DATA + 8); // slots 7, 6, 5; shift -3 pending
  a.movqMm0(DATA + 16).padddMm0Mm0().movqToMem(DATA + 24); // TOP = 0, tags 0xff
  a.ffree(2).ffree(7).fnstenv(DATA + 32); // physical 2 and 7 freed
  a.fldSt(5).fstpQ(DATA + 64); // ST(5) = slot 5, pushed into the freed slot 7
  a.fxch(6).fstQ(DATA + 72); // slot 6
  a.emms().fnstenv(DATA + 96).fld1().fstpQ(DATA + 128);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [[0, 2.5], [8, 4.5], [16, 1.5]], end);
  assert.equal(EJ.mem.readF64(DATA + 64), 4.5);
  assert.equal(EJ.mem.readF64(DATA + 72), 2.5);
  assert.equal(EJ.mem.readF64(DATA + 128), 1);
  const tags = EJ.mem.read32(DATA + 32 + 8) & 0xffff;
  assert.equal((tags >> 4) & 3, 3, 'slot 2 freed'); assert.equal((tags >> 14) & 3, 3, 'slot 7 freed'); assert.equal((tags >> 10) & 3, 0, 'slot 5 valid');
  assert.equal(EJ.mem.read32(DATA + 96 + 8) & 0xffff, 0xffff, 'all empty after EMMS');
});

// (1) a fallback that branches (addr16 LOOP) with a pending shift at the fallback, inside an x87
// region: the stack must be normalized and flushed before the interpreter runs, and reloaded
// after it, whether it branches or falls through.
test('an interpreter fallback that branches (LOOP with addr16) in the middle of x87 pushes', () => {
  const a = new Asm(CODE);
  a.movCxImm(3).fldz();
  a.label('L').fld1().loop16('L');
  a.faddp().faddp().faddp().fstpQ(DATA);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const { EJ } = both(a.finish(), [], end);
  assert.equal(EJ.mem.readF64(DATA), 3);
  assert.equal(EJ.jit.stats.fallbackSteps, 3, 'three LOOP fallbacks');
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
});

// (6) chaining into the middle of an x87 region (block index parameter) from another x87 region
// and from a non-x87 region, TOP != 0 and tags in memory at each transition.
test('chained entries into an inner block of an x87 region, from x87 and non-x87 regions', () => {
  // Indirect jumps keep M out of the jumping regions, so their exits chain into M as an inner
  // block of region R (block index parameter) with TOP = 6 and two valid registers in memory.
  //   A: fld1 ; fld [D] ; mov eax, M ; jmp eax          (x87 region)
  //   N: mov ecx, 2 ; dec ecx ; mov eax, M ; jmp eax    (non-x87 region: FPR untouched)
  //   R: fadd st0, st0
  //   M: fadd st0, st0 ; fst [D+16] ; dec ecx ; jnz N ; hlt
  const a = new Asm(CODE);
  a.label('A').fld1().fldQ(DATA).movEaxImm(0).jmpEax();
  const fixA = a.bytes.length - 6;
  a.label('N').movEcxImm(2).decEcx().movEaxImm(0).jmpEax();
  const fixN = a.bytes.length - 6;
  a.label('R').faddSt0St(0).jmp('M'); // the jump makes M a block leader inside R
  a.label('M').faddSt0St(0).fstQ(DATA + 16).decEcx().jcc(0x5, 'N');
  a.label('end').hlt();
  const R = a.labels.get('R'), N = a.labels.get('N'), M = a.labels.get('M'), end = a.labels.get('end');
  for (const at of [fixA, fixN]) { a.bytes[at] = M & 0xff; a.bytes[at + 1] = (M >> 8) & 0xff; a.bytes[at + 2] = (M >> 16) & 0xff; a.bytes[at + 3] = (M >>> 24) & 0xff; }
  const code = a.finish();
  const data = [[0, 2.5]];
  // translate R first (M becomes its inner block) from a hand-made stack state
  const EJ = makeExec(true);
  load(EJ, code, data);
  EJ.cpu.eip = R; EJ.cpu.ecx = 1; EJ.cpu.fpuTop = 6; EJ.cpu.fpuTw = 0xc0;
  EJ.mem.writeF64(EJ.cpu.base + ST.FPR + 48, 3); EJ.mem.writeF64(EJ.cpu.base + ST.FPR + 56, 1);
  assert.equal(EJ.run(end, [N, R]), EXIT.HALT);
  assert.equal(EJ.mem.readF64(DATA + 16), 12);
  const EI = makeExec(false); load(EI, code, data); assert.equal(EI.run(end), EXIT.HALT);
  for (let pass = 0; pass < 2; pass++) {
    load(EJ, code, data);
    assert.equal(EJ.run(end, [N, R]), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), snapshot(EI), `pass ${pass}`);
    assert.equal(EJ.mem.readF64(DATA + 16), 10);
    assert.equal(EJ.cpu.fpuTop, 6); assert.equal(EJ.cpu.fpuTw, 0xc0);
  }
  // pass 1: A -> M (x87 -> inner block of R), M -> N (x87 -> plain), N -> M (plain -> x87) all chain
  assert.ok(EJ.jit.stats.chained >= 4, `chained: ${EJ.jit.stats.chained}`);
  assert.ok(EJ.jit.stats.regions >= 3);
});

// Double rounding in 24-bit precision mode: the interpreter rounds the exact result once (error term
// of the f64 operation); the JIT used to round the f64 result again, which differed when the f64
// result sits exactly on a 24-bit midpoint. The arith24 kernel now does the same as the interpreter
// (DECISIONS D037).
test('PC=24 round-to-nearest of an f64 result that is exactly a 24-bit midpoint (double rounding)', () => {
  const CW24 = DATA + 120;
  const a = new Asm(CODE);
  a.fldcw(CW24).fldQ(DATA).faddQ(DATA + 8).fstpQ(DATA + 32);
  a.label('end').hlt();
  const { EJ } = both(a.finish(), [[0, 1 + 2 ** -24], [8, 2 ** -60]], a.labels.get('end'), [], (E) => E.mem.write16(CW24, 0x007f));
  assert.equal(EJ.mem.readF64(DATA + 32), 1 + 2 ** -23);
});

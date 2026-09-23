// Adversarial verification of the native transcendental handlers of the JIT (translate-x87.js:
// F2XM1, FSCALE, FYL2X, FYL2XP1, FPATAN, FSIN, FCOS, FSINCOS, FPTAN) as JIT mechanics: the
// static stack shift and tag word across the FSINCOS/FPTAN pushes and the FYL2X/FYL2XP1/FPATAN
// pops, FXCH/FINCSTP/FDECSTP/FFREE around them, the status word (C2 out of range, IE | ES and
// the indefinite for NaN, C0-C3 cleared), precision control, time slices at every budget, the
// out-of-range FSINCOS/FPTAN region exit, interpreter fallbacks (FXAM, FNSTENV, m80 loads and
// stores) next to the native ops, SMC exits with a pending shift, region consolidation, chained
// entries, the region classifier and the fallback histogram, and a seeded random differential
// test against the reference interpreter (the generator steps the interpreter as it goes, so no
// sequence ever reads an empty register or pushes onto a full one: the JIT does not emulate
// stack faults, D014). Values computed by the kernels are compared with a relative tolerance
// (the interpreter uses Math.*, both about 1 ulp from the truth); everything else (TOP, tags,
// status word, control word, GPRs, flags, the data page) must match exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { decode, OP, OP_NAMES } from '../src/cpu/decoder.js';
import { touchesFpu } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const C0 = 1 << 8, C1 = 1 << 9, C2 = 1 << 10, C3 = 1 << 14, SW_CC = C0 | C1 | C2 | C3;
const SW_IE = 1, SW_SF = 1 << 6, SW_ES = 1 << 7;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const TRANS = [OP.F2XM1, OP.FSCALE, OP.FYL2X, OP.FYL2XP1, OP.FPATAN, OP.FSIN, OP.FCOS, OP.FSINCOS, OP.FPTAN];

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
    /** run to the halt through time slices of `budget` instructions; returns the number of slices */
    runSliced(stopAt, boundaries, budget) {
      let slices = 0;
      for (;;) {
        const r = this.run(stopAt, boundaries, budget);
        if (r !== EXIT.TIMESLICE) { assert.equal(r, EXIT.HALT, `budget ${budget}`); return slices; }
        if (++slices > 5000) throw new Error('runaway');
      }
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
  movEsiImm(v) { return this.emit(0xbe).imm32(v); }
  jmpEax() { return this.emit(0xff, 0xe0); }
  movAbsEax(a) { return this.emit(0xa3).imm32(a); }
  addEsiImm8(v) { return this.emit(0x83, 0xc6, v & 0xff); }
  decEcx() { return this.emit(0x49); }
  jmp(name) { this.emit(0xe9); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  jcc(cc, name) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  hlt() { return this.emit(0xf4); }
  // x87
  fld1() { return this.emit(0xd9, 0xe8); }
  fldz() { return this.emit(0xd9, 0xee); }
  fldl2e() { return this.emit(0xd9, 0xea); }
  fldSt(i) { return this.emit(0xd9, 0xc0 + i); }
  fxch(i = 1) { return this.emit(0xd9, 0xc8 + i); }
  fstSt(i) { return this.emit(0xdd, 0xd0 + i); }
  fstpSt(i) { return this.emit(0xdd, 0xd8 + i); }
  ffree(i) { return this.emit(0xdd, 0xc0 + i); }
  faddSt0St(i) { return this.emit(0xd8, 0xc0 + i); }
  faddStSt0(i) { return this.emit(0xdc, 0xc0 + i); }
  faddp(i = 1) { return this.emit(0xde, 0xc0 + i); }
  fmulp(i = 1) { return this.emit(0xde, 0xc8 + i); }
  fsubStSt0(i) { return this.emit(0xdc, 0xe8 + i); } // fsub st(i), st
  fldQ(a) { return this.abs([0xdd], 0, a); }
  fldQEsi(off) { return this.emit(0xdd, 0x46, off & 0xff); } // fld qword [esi+disp8]
  fstpQ(a) { return this.abs([0xdd], 3, a); }
  fstQ(a) { return this.abs([0xdd], 2, a); }
  fldT(a) { return this.abs([0xdb], 5, a); } // fld tbyte (interpreter fallback)
  fstpT(a) { return this.abs([0xdb], 7, a); } // fstp tbyte (interpreter fallback)
  faddQ(a) { return this.abs([0xdc], 0, a); }
  fsin() { return this.emit(0xd9, 0xfe); }
  fcos() { return this.emit(0xd9, 0xff); }
  fsincos() { return this.emit(0xd9, 0xfb); }
  fptan() { return this.emit(0xd9, 0xf2); }
  fpatan() { return this.emit(0xd9, 0xf3); }
  f2xm1() { return this.emit(0xd9, 0xf0); }
  fyl2x() { return this.emit(0xd9, 0xf1); }
  fyl2xp1() { return this.emit(0xd9, 0xf9); }
  fscale() { return this.emit(0xd9, 0xfd); }
  frndint() { return this.emit(0xd9, 0xfc); }
  fabs() { return this.emit(0xd9, 0xe1); }
  fxam() { return this.emit(0xd9, 0xe5); }
  fnstswAx() { return this.emit(0xdf, 0xe0); }
  fnstswM(a) { return this.abs([0xdd], 7, a); }
  fnstenv(a) { return this.abs([0xd9], 6, a); }
  fldcw(a) { return this.abs([0xd9], 5, a); }
  fnstcw(a) { return this.abs([0xd9], 7, a); }
  fincstp() { return this.emit(0xd9, 0xf7); }
  fdecstp() { return this.emit(0xd9, 0xf6); }
  fninit() { return this.emit(0xdb, 0xe3); }
  finish() {
    for (const [at, name] of this.fixups) {
      const target = this.labels.get(name); if (target === undefined) throw new Error('label ' + name);
      const rel = target - (this.base + at + 4);
      this.bytes[at] = rel & 0xff; this.bytes[at + 1] = (rel >> 8) & 0xff; this.bytes[at + 2] = (rel >> 16) & 0xff; this.bytes[at + 3] = (rel >>> 24) & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

/** reset the CPU and the data page (the code and the JIT's translations are kept) */
function reload(E, data = []) {
  E.cpu.reset();
  E.mem.fill(DATA, 0x1000, 0);
  for (const [off, v] of data) E.mem.writeF64(DATA + off, v);
  E.cpu.eip = CODE;
  E.cpu.esp = DATA + 0x800;
  E.cpu.eflags = F.RESERVED1 | F.IF;
}
function load(E, code, data = []) {
  E.mem.fill(CODE, 0x1000, 0xcc);
  E.mem.writeBytes(CODE, code);
  if (E.jit) E.jit.reset(); // the code page is rewritten by every load
  reload(E, data);
}
const u64 = (bytes) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; };
const memBits = (E, a) => u64(E.mem.bytes(a, 8));
/** Every observable piece of state: GPRs, arithmetic flags, the full x87 state (whole status word), the data page. */
function snapshot(E) {
  const c = E.cpu;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cw: hex(c.fpuCw), sw: hex(c.fpuSw), fpr: [], mem: Buffer.from(E.mem.bytes(DATA, 256)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(c.fpr(k));
  return s;
}
/** a and b equal up to a relative tolerance (NaN matches NaN, infinities must match exactly) */
function closeRel(a, b, tol = 1e-13) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-300);
}
/**
 * Compare two snapshots: exact except the register values and the doubles at `slots` (offsets in
 * the data page), which may differ by the kernels' rounding; `swMask` masks status-word bits.
 */
function compareSnapshots(sj, si, EJ, EI, slots, msg, tol = 1e-13, swMask = 0xffff) {
  for (let k = 0; k < 8; k++) assert.ok(closeRel(sj.fpr[k], si.fpr[k], tol), `${msg}: fpr[${k}] jit ${sj.fpr[k]} interp ${si.fpr[k]}`);
  for (const o of slots) assert.ok(closeRel(EJ.mem.readF64(DATA + o), EI.mem.readF64(DATA + o), tol), `${msg}: [D+${o}] jit ${EJ.mem.readF64(DATA + o)} interp ${EI.mem.readF64(DATA + o)}`);
  const rest = (s, E) => { const m = Buffer.from(E.mem.bytes(DATA, 256)); for (const o of slots) m.fill(0, o, o + 8); return { ...s, fpr: undefined, sw: hex(E.cpu.fpuSw & swMask), mem: m.toString('hex') }; };
  assert.deepEqual(rest(sj, EJ), rest(si, EI), msg);
}
/** Run `code` on both executors (JIT with region boundaries) and compare, tolerant at `slots`. */
function both(code, data, stopAt, { boundaries = [], slots = [], setup = null, msg = '', tol = 1e-13, opts = {}, swMask = 0xffff, EI = null, EJ = null } = {}) {
  EI = EI ?? makeExec(false); EJ = EJ ?? makeExec(true, opts);
  load(EI, code, data); load(EJ, code, data);
  if (setup) { setup(EI); setup(EJ); }
  assert.equal(EI.run(stopAt), EXIT.HALT, 'interpreter halts ' + msg);
  assert.equal(EJ.run(stopAt, boundaries), EXIT.HALT, 'JIT halts ' + msg);
  compareSnapshots(snapshot(EJ), snapshot(EI), EJ, EI, slots, msg, tol, swMask);
  return { EI, EJ };
}

// --------------------------------------------------------------------------- classifier / histogram
test('region classifier: every transcendental is an x87 instruction; none reaches the fallback histogram', () => {
  const mem = new GuestMemory();
  const a = new Asm(CODE);
  a.f2xm1().fscale().fyl2x().fyl2xp1().fpatan().fsin().fcos().fsincos().fptan();
  mem.writeBytes(CODE, a.finish());
  const seen = new Set();
  for (let at = CODE, i = 0; i < 9; i++) { const insn = decode(mem, at); assert.ok(touchesFpu(insn), OP_NAMES[insn.op]); seen.add(insn.op); at = insn.next; }
  assert.deepEqual(seen, new Set(TRANS));
  // a program using all of them, with FXAM (interpreter) as a control for the histogram
  const b = new Asm(CODE);
  b.fldQ(DATA).f2xm1().fld1().fscale().fxam().fyl2x().fldQ(DATA).fyl2xp1().fldQ(DATA).fpatan().fsin().fcos().fsincos().fptan().fstpQ(DATA + 8).fstpQ(DATA + 16).fstpQ(DATA + 24);
  b.label('end').hlt();
  const { EJ } = both(b.finish(), [[0, 0.75]], b.labels.get('end'), { slots: [8, 16, 24] });
  for (const op of TRANS) assert.equal(EJ.jit.fallbackHist.get(op), undefined, `${OP_NAMES[op]} fell back`);
  assert.equal(EJ.jit.fallbackHist.get(OP.FXAM), 1);
  assert.equal(EJ.jit.stats.fallbackSteps, 1);
  assert.equal(EJ.jit.stats.fallback, 1, 'one fallback site (FXAM) in the region');
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
});

// --------------------------------------------------------------------------- static shift / tags
test('pushes (FSINCOS/FPTAN) and pops (FYL2X/FYL2XP1/FPATAN) under a pending shift with FXCH/FINCSTP/FDECSTP/FFREE; tags via FNSTENV', () => {
  // physical slots tracked in the comments (p7..p0); no instruction reads an empty register
  const a = new Asm(CODE);
  a.fldQ(DATA).fldQ(DATA + 8).fldQ(DATA + 16); // p7=a p6=b p5=c, TOP=5
  a.fsincos().fnstswM(DATA + 64); // p5=sin c, p4=cos c, TOP=4
  a.fxch(3); // p4=a, p7=cos c
  a.fyl2x().fnstswM(DATA + 66); // p5 = sin c * log2 a, pop -> TOP=5 (p4 freed)
  a.ffree(0).fincstp(); // p5 freed, TOP=6: ST0=b ST1=cos c
  a.fptan().fnstswM(DATA + 68); // p6 = tan b, p5 = 1.0, TOP=5
  a.fxch(1); // p5 = tan b, p6 = 1.0
  a.fyl2xp1(); // p6 = 1.0 * log2(1 + tan b), pop -> TOP=6 (p5 freed, still holds tan b)
  a.fdecstp().fld1(); // TOP=5 (ST0 = empty p5), then p4 = 1, TOP=4: ST0=1 ST1=empty ST2=log2.. ST3=cos c
  a.fxch(2); // p4 = log2(1 + tan b), p6 = 1
  a.fsin().fnstswM(DATA + 70); // p4 = sin(log2(1 + tan b))
  a.fincstp().fincstp(); // TOP=6: ST0 = 1 (p6), ST1 = cos c (p7)
  a.fpatan().fnstswM(DATA + 72); // p7 = atan2(cos c, 1), pop -> TOP=7
  a.fnstenv(DATA + 96); // tags: p4 valid, p5 empty, p6 empty, p7 valid, p0..p3 empty
  a.fstpQ(DATA + 24); // TOP=0
  a.fdecstp().fdecstp().fdecstp().fdecstp().fstpQ(DATA + 32); // TOP=4: pop p4 -> TOP=5
  a.label('end').hlt();
  const end = a.labels.get('end');
  const data = [[0, 0.5], [8, 1.5], [16, 0.25]];
  for (const opts of [{}, { chain: false }]) {
    const { EJ } = both(a.finish(), data, end, { slots: [24, 32], opts, msg: JSON.stringify(opts) });
    assert.ok(closeRel(EJ.mem.readF64(DATA + 24), Math.atan2(Math.cos(0.25), 1)), 'fpatan');
    assert.ok(closeRel(EJ.mem.readF64(DATA + 32), Math.sin(Math.log2(1 + Math.tan(1.5))), 1e-12), 'sin(log2(1 + tan b))');
    const tags = EJ.mem.read32(DATA + 96 + 8) & 0xffff;
    assert.equal(tags, 0b00_11_11_00_11_11_11_11, 'FNSTENV tags: only p4 and p7 valid'); // 2 bits per slot, slot 0 at the bottom, 11 = empty
    assert.equal((EJ.mem.read32(DATA + 96 + 4) >> 11) & 7, 7, 'TOP at the FNSTENV');
    for (const o of [64, 66, 68, 70, 72]) assert.equal(EJ.mem.read16(DATA + o) & 0x4700, 0, `no C0/C2/C3 after the transcendental at [D+${o}]`);
    assert.equal(EJ.cpu.fpuTop, 5); assert.equal(EJ.cpu.fpuTw, 0);
    assert.equal(EJ.jit.stats.fallbackSteps, 1, 'FNSTENV only');
  }
});

// --------------------------------------------------------------------------- status word
test('C2 out of range then cleared by the next in-range op; the whole status word matches (preset bits included)', () => {
  //   fld big ; fsin ; fnstsw ; fld small ; fsin ; fnstsw ; fstp ; fcos ; fnstsw ; fstp
  //   fld big ; fptan ; fnstsw ; fld small ; fsincos ; fnstsw ; fstp ; fstp ; fstp
  const a = new Asm(CODE);
  a.fldQ(DATA).fsin().fnstswM(DATA + 64).fldQ(DATA + 8).fsin().fnstswM(DATA + 66).fstpQ(DATA + 16).fcos().fnstswM(DATA + 68).fstpQ(DATA + 24);
  a.fldQ(DATA).fptan().fnstswM(DATA + 70).fldQ(DATA + 8).fsincos().fnstswM(DATA + 72).fstpQ(DATA + 32).fstpQ(DATA + 40).fstpQ(DATA + 48);
  a.label('end').hlt();
  const end = a.labels.get('end');
  for (const big of [2 ** 63, -(2 ** 63), 1e300, Infinity, -Infinity]) {
    for (const preset of [0, C0 | C3, SW_IE | SW_ES | (1 << 5)]) {
      const setup = (E) => { E.cpu.fpuSw = preset; };
      const { EJ } = both(a.finish(), [[0, big], [8, 0.3]], end, { slots: [16, 24, 32, 40], setup, msg: `big=${big} preset=${hex(preset)}` });
      const sw = (o) => EJ.mem.read16(DATA + o);
      assert.equal(sw(64) & SW_CC, (preset & SW_CC) | C2, 'FSIN out of range: C2 set, other condition bits kept');
      assert.equal(sw(66) & SW_CC, 0, 'the next in-range FSIN clears C0-C3');
      assert.equal(sw(68) & SW_CC, C2, 'FCOS of the big value (ST(0) again after the pop): C2 set again');
      assert.equal(sw(70) & SW_CC, C2, 'FPTAN out of range');
      assert.equal(sw(72) & SW_CC, 0, 'FSINCOS in range clears C2');
      assert.equal(sw(72) & 0xff, preset & 0xff, 'exception bits untouched by in-range ops');
      assert.equal(EJ.mem.readF64(DATA + 48), big, 'FPTAN left the big value in place, no push');
      assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
    }
  }
});

test('inf / NaN / zero / huge inputs of every transcendental: status word (IE, ES, C0-C3) and result bits vs the interpreter', () => {
  const sNaN = 0x7ff0000000000001n, nNaN = 0xfff8000000000000n, payload = 0x7ff80000deadbeefn;
  const bitsToF64 = (b) => { const buf = new DataView(new ArrayBuffer(8)); buf.setBigUint64(0, b, true); return buf.getFloat64(0, true); };
  const specials = [NaN, bitsToF64(sNaN), bitsToF64(nNaN), bitsToF64(payload), Infinity, -Infinity, 0, -0, 5e-324, -5e-324, 2 ** -1074 * 3, 1e-300, 2 ** 63, -(2 ** 63), 2 ** 63 - 1024, 1e300, -1e300, 1, -1, 1025, -61, 2000.7, -1100.5, 0.5, -0.5, 1.5, 1e-10];
  // one program per instruction: unary ones read [D], binary ones [D] into ST(0) and [D+8] into ST(1);
  // the pushing ones start with an extra FLD1 so that the out-of-range path (no push) still has
  // two registers to pop
  const progs = {
    F2XM1: (a) => a.fldQ(DATA).f2xm1(),
    FSIN: (a) => a.fldQ(DATA).fsin(),
    FCOS: (a) => a.fldQ(DATA).fcos(),
    FSINCOS: (a) => a.fld1().fldQ(DATA).fsincos().fstpQ(DATA + 32),
    FPTAN: (a) => a.fld1().fldQ(DATA).fptan().fstpQ(DATA + 32),
    FSCALE: (a) => a.fldQ(DATA + 8).fldQ(DATA).fscale().fstpQ(DATA + 32),
    FYL2X: (a) => a.fldQ(DATA + 8).fldQ(DATA).fyl2x(),
    FYL2XP1: (a) => a.fldQ(DATA + 8).fldQ(DATA).fyl2xp1(),
    FPATAN: (a) => a.fldQ(DATA + 8).fldQ(DATA).fpatan(),
  };
  const EI = makeExec(false), EJ = makeExec(true);
  const mismatches = [], nanBits = [];
  let cases = 0;
  for (const [name, body] of Object.entries(progs)) {
    const a = new Asm(CODE);
    body(a); a.fnstswM(DATA + 64).fstpQ(DATA + 16).fnstswM(DATA + 66);
    a.label('end').hlt();
    const code = a.finish(), end = a.labels.get('end');
    const binary = ['FSCALE', 'FYL2X', 'FYL2XP1', 'FPATAN'].includes(name);
    const pairs = [];
    for (const x of specials) { if (binary) for (const y of [1, -1, 0, -0, Infinity, -Infinity, NaN, 2.5, 1e300, -1e300]) pairs.push([x, y]); else pairs.push([x, 0]); }
    load(EI, code); load(EJ, code);
    for (const [x, y] of pairs) {
      const data = [[0, x], [8, y]];
      reload(EI, data); reload(EJ, data);
      EI.cpu.fpuSw = C0 | C1 | C3; EJ.cpu.fpuSw = C0 | C1 | C3; // preset condition bits (C1 included: the interpreter clears it on every op)
      assert.equal(EI.run(end), EXIT.HALT); assert.equal(EJ.run(end), EXIT.HALT);
      const tag = `${name}(x=${x}, y=${y})`;
      const swI = EI.mem.read16(DATA + 64), swJ = EJ.mem.read16(DATA + 64);
      const vI = EI.mem.readF64(DATA + 16), vJ = EJ.mem.readF64(DATA + 16);
      const bI = memBits(EI, DATA + 16), bJ = memBits(EJ, DATA + 16);
      if ((swI & ~C1) !== (swJ & ~C1)) mismatches.push(`${tag}: sw interp ${hex(swI)} jit ${hex(swJ)}`);
      if (!closeRel(vJ, vI)) mismatches.push(`${tag}: value interp ${vI} jit ${vJ}`);
      else if (Number.isNaN(vI) && bI !== bJ) nanBits.push(`${tag}: NaN bits interp ${bI.toString(16)} jit ${bJ.toString(16)}`);
      else if (vI === 0 && bI !== bJ) mismatches.push(`${tag}: zero sign interp ${bI.toString(16)} jit ${bJ.toString(16)}`);
      if (['FSINCOS', 'FPTAN', 'FSCALE'].includes(name)) {
        const wI = EI.mem.readF64(DATA + 32), wJ = EJ.mem.readF64(DATA + 32);
        if (!closeRel(wJ, wI)) mismatches.push(`${tag}: second value interp ${wI} jit ${wJ}`);
        else if (Number.isNaN(wI) && memBits(EI, DATA + 32) !== memBits(EJ, DATA + 32)) nanBits.push(`${tag}: second NaN bits interp ${memBits(EI, DATA + 32).toString(16)} jit ${memBits(EJ, DATA + 32).toString(16)}`);
      }
      assert.equal(EJ.cpu.fpuTop, EI.cpu.fpuTop, tag + ' TOP'); assert.equal(EJ.cpu.fpuTw, EI.cpu.fpuTw, tag + ' tags');
      assert.equal(EJ.mem.read16(DATA + 66) & ~C1, EI.mem.read16(DATA + 66) & ~C1, tag + ' final sw');
      cases++;
    }
  }
  assert.ok(cases > 1000, `${cases} cases`);
  assert.deepEqual(mismatches, [], `${mismatches.length} mismatches:\n` + mismatches.join('\n'));
  // NaN bit patterns are not compared: the kernels return the x87 indefinite (0xfff8...) for
  // invalid operations (log2 of a negative number, ...) and propagate one input NaN, as the
  // hardware does; the interpreter's Math.* results are V8's NaNs (positive, 0x7ff8... / 0x7ffc...).
  // Only FYL2X / FYL2XP1 / FPATAN produce them (the trig instructions write the indefinite on both).
  assert.deepEqual(new Set(nanBits.map((s) => s.split('(')[0])), new Set(['FYL2X', 'FYL2XP1', 'FPATAN']), nanBits.join('\n'));
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
});

// FYL2XP1 with a denormal x: log2(1 + x) is a denormal double, so y * log2p1(x) loses up to half
// of its bits, while the hardware keeps the intermediate in extended precision. The handler
// scales tiny arguments (see translate-x87.js): the results must be the hardware's values.
test('FYL2XP1 with a denormal ST(0): the product with ST(1) does not go through a denormal intermediate', () => {
  const a = new Asm(CODE);
  a.fldQ(DATA + 8).fldQ(DATA).fyl2xp1().fstpQ(DATA + 16);
  a.label('end').hlt();
  const end = a.labels.get('end'), code = a.finish();
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code); load(EJ, code);
  // [x, y, exact y log2(1 + x) rounded once to a double]
  const cases = [
    [5e-324, 1e300, 7.127860571287694e-24], // 2^-1074 log2e 1e300
    [1.5e-323, -1e300, -2.138358171386308e-23],
    [-5e-324, 1e300, -7.127860571287694e-24],
    [2 ** -1050, 2 ** 1000, 2 ** -50 * Math.LOG2E],
    [2 ** -1000, 2 ** 900, 2 ** -100 * Math.LOG2E], // at the threshold: normal path
    [2 ** -1001, 2 ** 900, 2 ** -101 * Math.LOG2E], // just below: scaled path
    [5e-324, 2.5, 4 * 2 ** -1074], // 2.5 log2e = 3.61 units of 2^-1074 -> 4 (the interpreter's double rounding gives 3)
    [0, -1, -0], [-0, -1, 0], [0, 1e300, 0],
  ];
  for (const [x, y, want] of cases) {
    reload(EI, [[0, x], [8, y]]); reload(EJ, [[0, x], [8, y]]);
    assert.equal(EI.run(end), EXIT.HALT); assert.equal(EJ.run(end), EXIT.HALT);
    const got = EJ.mem.readF64(DATA + 16);
    const tag = `fyl2xp1(x=${x}, y=${y}): jit ${got} interp ${EI.mem.readF64(DATA + 16)} want ${want}`;
    if (want === 0) assert.ok(Object.is(got, want), tag);
    else if (Math.abs(want) < 2 ** -1000) assert.equal(got, want, tag); // denormal result: exact
    else assert.ok(closeRel(got, want, 4.5e-16), tag); // 2 ulp
    assert.equal(EJ.cpu.fpuTop, EI.cpu.fpuTop); assert.equal(EJ.cpu.fpuTw, EI.cpu.fpuTw);
  }
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
});

// The sign of a NaN is observable through FXAM (C1): the kernels' indefinite for log2 of a
// negative number is negative like the hardware's, the interpreter's Math.log2 NaN is positive.
test('FXAM of the NaN produced by FYL2X of a negative number: C1 (sign) differs between the interpreter (positive NaN) and the JIT (indefinite)', { todo: 'interpreter-side: Math.* NaNs are positive, the x87 indefinite is negative' }, () => {
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).fyl2x().fxam().fnstswM(DATA + 64).fstpQ(DATA + 16);
  a.label('end').hlt();
  both(a.finish(), [[0, -1]], a.labels.get('end'), { slots: [16] });
});

// --------------------------------------------------------------------------- precision control
test('precision control (PC = 24 / 53 / 64) and rounding control before the transcendentals: same results as the interpreter, PC does not round them', () => {
  const CW = DATA + 120;
  // exp sequence (FRNDINT follows RC), then each instruction once; results in [D+8..]
  const a = new Asm(CODE);
  a.fldcw(CW);
  a.fldQ(DATA).fldl2e().fmulp().fldSt(0).frndint().fsubStSt0(1).fxch(1).f2xm1().fld1().faddp().fscale().fstpSt(1).fstpQ(DATA + 8);
  a.fldQ(DATA + 16).fldQ(DATA).fyl2x().fstpQ(DATA + 24);
  a.fldQ(DATA + 16).fldQ(DATA).fyl2xp1().fstpQ(DATA + 32);
  a.fldQ(DATA + 16).fldQ(DATA).fpatan().fstpQ(DATA + 40);
  a.fldQ(DATA).fsin().fstpQ(DATA + 48).fldQ(DATA).fcos().fstpQ(DATA + 56);
  a.fldQ(DATA).fsincos().fstpQ(DATA + 64).fstpQ(DATA + 72).fldQ(DATA).fptan().fstpQ(DATA + 80).fstpQ(DATA + 88);
  a.fnstcw(DATA + 96);
  a.label('end').hlt();
  const end = a.labels.get('end'), code = a.finish();
  const slots = [8, 24, 32, 40, 48, 56, 64, 72, 80, 88];
  const results = {};
  // PC is bits 8-9 (00 = 24, 10 = 53, 11 = 64), RC bits 10-11 (00 nearest, 01 down, 10 up, 11 trunc)
  for (const cw of [0x007f, 0x027f, 0x037f, 0x047f, 0x0f7f, 0x0b7f]) { // PC 24/53/64 nearest, PC 24 down, PC 64 trunc, PC 64 up
    const { EI, EJ } = both(code, [[0, 0.8], [16, 3.25]], end, { slots, setup: (E) => E.mem.write16(CW, cw), msg: `cw=${hex(cw)}` });
    assert.equal(EJ.mem.read16(DATA + 96), cw);
    results[cw] = { jit: slots.map((o) => EJ.mem.readF64(DATA + o)), interp: slots.map((o) => EI.mem.readF64(DATA + o)) };
  }
  // neither the precision control nor the rounding control changes transcendental results (the
  // interpreter's setSt rule): identical bits across the control words
  for (const [cwa, cwb] of [[0x007f, 0x037f], [0x027f, 0x037f], [0x047f, 0x037f], [0x0f7f, 0x037f], [0x0b7f, 0x037f]]) {
    for (let i = 1; i < slots.length; i++) { // slot 8 (the exp sequence) contains FRNDINT (RC) and arithmetic (PC)
      assert.equal(results[cwa].jit[i], results[cwb].jit[i], `JIT [D+${slots[i]}] cw ${hex(cwa)} vs ${hex(cwb)}`);
      assert.equal(results[cwa].interp[i], results[cwb].interp[i], `interp [D+${slots[i]}] cw ${hex(cwa)} vs ${hex(cwb)}`);
    }
  }
  assert.ok(closeRel(results[0x037f].jit[0], Math.exp(0.8), 1e-14), 'exp');
  // RC = truncate / up change FRNDINT in the exp sequence (both executors agree through `both`), the result is still e^x
  assert.ok(closeRel(results[0x0f7f].jit[0], Math.exp(0.8), 1e-14), 'exp with RC = trunc');
  assert.ok(closeRel(results[0x0b7f].jit[0], Math.exp(0.8), 1e-14), 'exp with RC = up');
  // PC = 24 rounds the arithmetic of the exp sequence (FMULP / FADDP) to 24 bits: e^x to ~2^-24
  assert.ok(closeRel(results[0x007f].jit[0], Math.exp(0.8), 2 ** -22) && !closeRel(results[0x007f].jit[0], Math.exp(0.8), 1e-14), 'exp under PC = 24');
});

// --------------------------------------------------------------------------- time slices / loops
// A loop over a table of (x, y, z) triples with FSINCOS/FPTAN pushes and FYL2X/FPATAN pops in
// different blocks. x and z may be out of range (no push at FSINCOS / FPTAN: the region is left
// in the middle of the block), y is always in range so that both paths keep enough registers
// for the pops; FNINIT ends every iteration (the stack height differs between the paths) and
// the accumulator lives in memory. Every budget from 1 upwards puts the time slice at a
// different point, including right before / after the transcendentals and at the out-of-range
// exits.
function tableProgram() {
  const a = new Asm(CODE);
  a.movEcxImm(6).movEsiImm(DATA);
  a.label('L1').fldQEsi(0).fsincos().fnstswAx().movAbsEax(DATA + 128).fsin().fldQEsi(8).fptan().fmulp().fpatan().fstQ(DATA + 200).jcc(0x5, 'L2'); // jnz: always taken (ZF clear from reset, then from DEC / ADD)
  a.label('L2').fldQEsi(16).fyl2x().fnstswAx().movAbsEax(DATA + 132).faddQ(DATA + 208).fstpQ(DATA + 208);
  a.fldQEsi(16).fptan().fnstswAx().movAbsEax(DATA + 136).fstQ(DATA + 216).fninit().addEsiImm8(24).decEcx().jcc(0x5, 'L1');
  a.label('end').hlt();
  return { code: a.finish(), L1: a.labels.get('L1'), L2: a.labels.get('L2'), end: a.labels.get('end') };
}
// (x, y, z) per iteration: x in range / 2^63 / 1e300 / -inf (FSINCOS and FSIN out of range), y
// always in range, z in range / 2^70 / 1e300 (FPTAN out of range, FYL2X finite)
const TABLE = [[0, 0.5], [8, 1.2], [16, 3], [24, 2 ** 63], [32, 0.7], [40, 8], [48, 0.25], [56, -1.5], [64, 2 ** 70], [72, 1e300], [80, 0.5], [88, 4], [96, -0.5], [104, 4], [112, 1e300], [120, -Infinity], [128, 7], [136, 0.5]];
test('loop with pushes and pops across blocks and out-of-range exits: region boundaries and every time-slice budget', () => {
  const { code, L1, L2, end } = tableProgram();
  const slots = [200, 208, 216];
  for (const bounds of [[], [L1], [L2], [L1, L2]]) {
    both(code, TABLE, end, { boundaries: bounds, slots, msg: `bounds=${bounds}`, tol: 1e-10 });
  }
  const EI = makeExec(false); load(EI, code, TABLE); assert.equal(EI.run(end), EXIT.HALT);
  const ref = snapshot(EI);
  assert.ok(Number.isFinite(EI.mem.readF64(DATA + 208)) && EI.mem.readF64(DATA + 208) !== 0, 'the accumulator is a plain number');
  const EJ = makeExec(true);
  for (let budget = 1; budget <= 48; budget++) {
    load(EJ, code, TABLE);
    const slices = EJ.runSliced(end, [L1], budget);
    assert.ok(slices > 0, `budget ${budget}: slices ${slices}`);
    compareSnapshots(snapshot(EJ), ref, EJ, EI, slots, `budget=${budget} slices=${slices}`, 1e-10);
  }
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
});

// --------------------------------------------------------------------------- fallbacks next to the native ops
test('interpreter fallbacks (FXAM, FLD/FSTP m80, FNSTENV) adjacent to the transcendentals with a pending shift', () => {
  const a = new Asm(CODE);
  a.fldQ(DATA).fstpT(DATA + 96); // an 80-bit copy of x for the m80 load below (interpreter)
  a.fldQ(DATA + 8).fldQ(DATA).fxam().fnstswM(DATA + 64).fsincos().fxam().fnstswM(DATA + 66); // FXAM before and after the push
  a.fldT(DATA + 96).fpatan().fnstswM(DATA + 68); // m80 load right before the pop
  a.fptan().fstpT(DATA + 112).fnstenv(DATA + 128); // m80 store right after the push (pops the 1.0), then the environment
  a.fabs().fyl2xp1().fxam().fnstswM(DATA + 70).fstpQ(DATA + 16).fstpQ(DATA + 24); // fabs: keep 1 + tan(...) positive (the NaN sign would differ, see the todo below)
  a.label('end').hlt();
  const end = a.labels.get('end');
  for (const x of [0.6, -0.6]) {
    const { EJ } = both(a.finish(), [[0, x], [8, 2.5]], end, { slots: [16, 24], msg: `x=${x}`, swMask: ~C1 });
    assert.equal(EJ.jit.stats.fallbackSteps, 7, 'FSTP m80, FXAM x2, FLD m80, FSTP m80, FNSTENV, FXAM');
    assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
  }
});

// FXAM sets C1 to the sign of ST(0); the interpreter clears C1 in every following arithmetic /
// transcendental instruction (its approximation of the hardware's rounding indicator), the JIT's
// native handlers never write C1 (shared convention of every native x87 handler: FADD...FSQRT
// do not either). Documented as a todo: the fix is one `sw &= ~C1` per handler.
test('C1 after FXAM of a negative value is cleared by the interpreter on F2XM1 but not by the JIT', { todo: 'JIT native handlers never write C1 (convention shared with FADD..FSQRT); the interpreter clears it on every op' }, () => {
  const a = new Asm(CODE);
  a.fldQ(DATA).fxam().f2xm1().fnstswM(DATA + 64).fstpQ(DATA + 16);
  a.label('end').hlt();
  both(a.finish(), [[0, -0.5]], a.labels.get('end'), { slots: [16] });
});

// --------------------------------------------------------------------------- SMC exits
test('FSTP into a translated code page right after FSINCOS / FPTAN pushes and FYL2X pops: pending shift applied before the SMC exit', () => {
  const T0 = CODE + 0x800, T1 = CODE + 0x810, T2 = CODE + 0x820, T3 = CODE + 0x830;
  // fld1 ; fld x ; fsincos ; fstp T0 (cos x) ; fld y ; fptan ; fstp T1 (1.0) ; fld y ; fyl2x ; fstp T2 (tan y log2 y) ;
  // fld y ; fpatan ; fstp T3 (atan2(sin x, y)) ; fstp [D+16] (1)
  const a = new Asm(CODE);
  a.fld1().fldQ(DATA).fsincos().fstpQ(T0).fldQ(DATA + 8).fptan().fstpQ(T1).fldQ(DATA + 8).fyl2x().fstpQ(T2).fldQ(DATA + 8).fpatan().fstpQ(T3).fstpQ(DATA + 16);
  a.label('end').hlt();
  const end = a.labels.get('end');
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, a.finish(), [[0, 0.9], [8, 1.5]]); load(EJ, a.finish(), [[0, 0.9], [8, 1.5]]);
  assert.equal(EI.run(end), EXIT.HALT);
  assert.equal(EJ.runSmc(end), EXIT.HALT);
  assert.ok(EJ.jit.stats.invalidations >= 4, `SMC exits taken: ${EJ.jit.stats.invalidations}`);
  compareSnapshots(snapshot(EJ), snapshot(EI), EJ, EI, [16], 'smc');
  for (const [t, want] of [[T0, Math.cos(0.9)], [T1, 1], [T2, Math.tan(1.5) * Math.log2(1.5)], [T3, Math.atan2(Math.sin(0.9), 1.5)]]) assert.ok(closeRel(EJ.mem.readF64(t), want), `[${hex(t)}] ${EJ.mem.readF64(t)} vs ${want}`);
  for (const t of [T0, T1, T2, T3]) assert.ok(closeRel(EJ.mem.readF64(t), EI.mem.readF64(t)), hex(t));
  assert.equal(EJ.mem.readF64(DATA + 16), 1);
  assert.equal(EJ.cpu.fpuTop, 0); assert.equal(EJ.cpu.fpuTw, 0);
});

// --------------------------------------------------------------------------- consolidation / chaining
test('regions holding transcendentals survive consolidation (kernel imports of the packed module) and chained entries', () => {
  const { code, L1, L2, end } = tableProgram();
  const slots = [200, 208, 216];
  // consolidateEvery 2: every second region (the L2 one included) is packed with its predecessor
  const EJ = makeExec(true, { consolidateEvery: 2 });
  const { EI } = both(code, TABLE, end, { boundaries: [L1, L2], slots, tol: 1e-10, EJ });
  const c0 = EJ.jit.stats.consolidations ?? 0;
  assert.ok(c0 >= 2, `consolidations: ${c0}`);
  // second run without a reset: everything executes from the packed module, chaining between the regions
  reload(EJ, TABLE);
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT);
  assert.equal(EJ.jit.stats.consolidations, c0, 'no new region on the second run');
  assert.ok(EJ.jit.stats.chained >= 6, `chained: ${EJ.jit.stats.chained}`);
  compareSnapshots(snapshot(EJ), snapshot(EI), EJ, EI, slots, 'second run', 1e-10);
});

test('chained entry into an inner block that starts with a pop, from an x87 region ending with a push and from a non-x87 region', () => {
  //   A: fld y ; fld x ; fsincos ; mov eax, M ; jmp eax   (TOP = 5, three valid registers at the exit)
  //   N: mov ecx, 2 ; dec ecx ; mov eax, M ; jmp eax       (non-x87 region)
  //   R: fadd st0, st0 ; jmp M
  //   M: fpatan ; fyl2x ; fst [D+16] ; fptan ; fstp st0 ; fabs ; fld st0 ; fld1 ; dec ecx ; jnz N ; hlt
  const a = new Asm(CODE);
  a.label('A').fldQ(DATA).fldQ(DATA + 8).fsincos().movEaxImm(0).jmpEax();
  const fixA = a.bytes.length - 6;
  a.label('N').movEcxImm(2).decEcx().movEaxImm(0).jmpEax();
  const fixN = a.bytes.length - 6;
  a.label('R').faddSt0St(0).jmp('M');
  a.label('M').fpatan().fyl2x().fstQ(DATA + 16).fptan().fstpSt(0).fabs().fldSt(0).fld1().decEcx().jcc(0x5, 'N');
  a.label('end').hlt();
  const R = a.labels.get('R'), N = a.labels.get('N'), M = a.labels.get('M'), end = a.labels.get('end');
  for (const at of [fixA, fixN]) { a.bytes[at] = M & 0xff; a.bytes[at + 1] = (M >> 8) & 0xff; a.bytes[at + 2] = (M >> 16) & 0xff; a.bytes[at + 3] = (M >>> 24) & 0xff; }
  const code = a.finish(), data = [[0, 3], [8, 0.4]];
  const EI = makeExec(false); load(EI, code, data); assert.equal(EI.run(end), EXIT.HALT);
  const EJ = makeExec(true);
  // translate R first so that M is an inner block of R, from a hand-made stack (TOP = 5: 0.5, 0.25, 3)
  load(EJ, code, data);
  EJ.cpu.eip = R; EJ.cpu.ecx = 1; EJ.cpu.fpuTop = 5; EJ.cpu.fpuTw = 0xe0;
  EJ.mem.writeF64(EJ.cpu.base + ST.FPR + 40, 0.5); EJ.mem.writeF64(EJ.cpu.base + ST.FPR + 48, 0.25); EJ.mem.writeF64(EJ.cpu.base + ST.FPR + 56, 3);
  assert.equal(EJ.run(end, [N, R]), EXIT.HALT);
  assert.ok(closeRel(EJ.mem.readF64(DATA + 16), 3 * Math.log2(Math.atan2(0.25, 1))));
  for (let pass = 0; pass < 2; pass++) {
    reload(EJ, data);
    assert.equal(EJ.run(end, [N, R]), EXIT.HALT);
    compareSnapshots(snapshot(EJ), snapshot(EI), EJ, EI, [16], `pass ${pass}`);
  }
  assert.ok(EJ.jit.stats.chained >= 4, `chained: ${EJ.jit.stats.chained}`);
  assert.equal(EJ.jit.stats.fallbackSteps, 0);
  assert.equal(EJ.cpu.fpuTop, 5); assert.equal(EJ.cpu.fpuTw, 0xe0);
});

// --------------------------------------------------------------------------- out-of-range exit corner cases
test('FSINCOS / FPTAN out of range as the last instruction of a block, before a jump target, and at the stop address', () => {
  // (a) FSINCOS right before a block leader (the JCC target): the exit lands on a block of the same region
  const a = new Asm(CODE);
  a.movEcxImm(2).fldQ(DATA);
  a.label('L').fsincos();
  a.label('M').fnstswAx().movAbsEax(DATA + 64).decEcx().jcc(0x5, 'L');
  a.fstpQ(DATA + 16);
  a.label('end').hlt();
  for (const v of [2 ** 63, 1e300, 0.5]) {
    const { EJ } = both(a.finish(), [[0, v]], a.labels.get('end'), { slots: [16], msg: `v=${v}` });
    if (v !== 0.5) { assert.equal(EJ.mem.read32(DATA + 64) & SW_CC, C2); assert.equal(EJ.mem.readF64(DATA + 16), v); assert.equal(EJ.cpu.fpuTop, 0); }
    else assert.equal(EJ.cpu.fpuTop, 6, 'two pushes, one pop');
  }
  // (b) FPTAN is the last instruction before the stop address
  const b = new Asm(CODE);
  b.fldQ(DATA).fldQ(DATA + 8).fptan();
  b.label('end').hlt();
  for (const v of [2 ** 63, 1e300, 0.5]) {
    const { EJ } = both(b.finish(), [[0, 1.5], [8, v]], b.labels.get('end'), { msg: `v=${v}` });
    assert.equal(EJ.cpu.fpuTop, v === 0.5 ? 5 : 6);
  }
  // (c) FSINCOS out of range with pending pushes before it and FXCH / pops / a JCC after it
  const c = new Asm(CODE);
  c.movEcxImm(3).fldz();
  c.label('L').fld1().fldQ(DATA).fsincos().fxch(1).fnstswAx().movAbsEax(DATA + 64).fstpSt(0).fstpSt(0).decEcx().jcc(0x5, 'L');
  c.fstpQ(DATA + 16);
  c.label('end').hlt();
  for (const v of [2 ** 63, 0.5, -Infinity]) {
    const { EJ } = both(c.finish(), [[0, v]], c.labels.get('end'), { slots: [16], msg: `v=${v}` });
    assert.equal(EJ.cpu.fpuTop, v === 0.5 ? 5 : 0, 'one value left per iteration when the push happened');
    assert.equal(EJ.jit.stats.fallbackSteps, 0);
  }
});

// --------------------------------------------------------------------------- random differential test
// Random straight-line sequences over a pool of x87 instructions. The generator executes each
// candidate on the reference interpreter as it goes, so the choices see the real stack (TOP,
// tags, out-of-range FSINCOS/FPTAN that pushed nothing) and never read an empty register or push
// onto a full one (D014). Constants include out-of-range and negative values so that the C2
// exits, the NaN paths and the indefinite propagate through the following instructions. Every
// program runs on the JIT as one region, split into two regions at a random instruction, and
// under a random small time-slice budget.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const CONSTS = [0.5, 1.5, 0.25, -0.75, 2, 3, 0.1, 1e-5, 2 ** 63, 2 ** 70, 1e300, -2, 7.5, 0.999];
const CONST_DATA = CONSTS.map((c, i) => [8 * (i + 40), c]); // outside the compared window
const SLOT_BASE = 0, SW_BASE = 600;
function randomProgram(r, EM) {
  // EM: the model interpreter; the code is assembled instruction by instruction at its EIP
  load(EM, new Uint8Array(0), CONST_DATA);
  EM.I.cache.clear();
  const a = new Asm(CODE);
  const ops = [];
  let slot = 0, sw = 0;
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const phys = (i) => (EM.cpu.fpuTop + i) & 7;
  const valid = (i) => (EM.cpu.fpuTw >> phys(i)) & 1;
  const canPush = () => !((EM.cpu.fpuTw >> ((EM.cpu.fpuTop - 1) & 7)) & 1);
  const n = 6 + Math.floor(r() * 26);
  while (ops.length < n) {
    const at = a.bytes.length;
    const choice = Math.floor(r() * 24);
    let name = null;
    if (choice < 5) { if (canPush()) { const i = Math.floor(r() * CONSTS.length); a.fldQ(DATA + 8 * (i + 40)); name = `fld ${CONSTS[i]}`; } }
    else if (choice === 5) { if (valid(0) && canPush()) { a.fsincos(); name = 'fsincos'; } }
    else if (choice === 6) { if (valid(0) && canPush()) { a.fptan(); name = 'fptan'; } }
    else if (choice === 7) { if (valid(0)) { a.fsin(); name = 'fsin'; } }
    else if (choice === 8) { if (valid(0)) { a.fcos(); name = 'fcos'; } }
    else if (choice === 9) { if (valid(0)) { a.f2xm1(); name = 'f2xm1'; } }
    else if (choice === 10) { if (valid(0) && valid(1)) { a.fscale(); name = 'fscale'; } }
    else if (choice === 11) { if (valid(0) && valid(1)) { a.fyl2x(); name = 'fyl2x'; } }
    else if (choice === 12) { if (valid(0) && valid(1)) { a.fyl2xp1(); name = 'fyl2xp1'; } }
    else if (choice === 13) { if (valid(0) && valid(1)) { a.fpatan(); name = 'fpatan'; } }
    else if (choice === 14) { const i = 1 + Math.floor(r() * 7); if (valid(0) && valid(i)) { a.fxch(i); name = `fxch st${i}`; } }
    else if (choice === 15) { a.fincstp(); name = 'fincstp'; }
    else if (choice === 16) { a.fdecstp(); name = 'fdecstp'; }
    else if (choice === 17) { const i = Math.floor(r() * 8); a.ffree(i); name = `ffree st${i}`; }
    else if (choice === 18) { if (valid(0)) { a.fstpQ(DATA + SLOT_BASE + 8 * slot); name = `fstp [${slot}]`; slot++; } }
    else if (choice === 19) { if (valid(0)) { a.fstQ(DATA + SLOT_BASE + 8 * slot); name = `fst [${slot}]`; slot++; } }
    else if (choice === 20) { const i = Math.floor(r() * 8); if (valid(0) && valid(i)) { a.faddSt0St(i); name = `fadd st0, st${i}`; } }
    else if (choice === 21) { a.fnstswM(DATA + SW_BASE + 2 * sw); name = 'fnstsw'; sw++; }
    else if (choice === 22) { a.fxam(); name = 'fxam'; }
    else if (choice === 23) { const i = Math.floor(r() * 8); if (valid(i) && canPush()) { a.fldSt(i); name = `fld st${i}`; } }
    if (name === null) continue;
    // execute the instruction on the model interpreter
    EM.mem.writeBytes(CODE + at, Uint8Array.from(a.bytes.slice(at)));
    EM.cpu.eip = CODE + at;
    assert.equal(EM.I.step(), EXIT.NONE, name);
    assert.equal(EM.cpu.fpuSw & SW_SF, 0, `stack fault in the model after ${name}: ${ops.join(' ; ')}`);
    ops.push(name);
  }
  a.label('end').hlt();
  return { code: a.finish(), end: a.labels.get('end'), ops, slots: slot, swSlots: sw, top: EM.cpu.fpuTop, tags: EM.cpu.fpuTw };
}
test('random x87 sequences with transcendentals: interpreter vs JIT (single region, split regions, time slices)', () => {
  const r = rng(0x5eed);
  const EM = makeExec(false), EI = makeExec(false), EJ = makeExec(true);
  let checked = 0, oor = 0;
  for (let p = 0; p < 400; p++) {
    const prog = randomProgram(r, EM);
    const slots = []; for (let i = 0; i < prog.slots; i++) slots.push(SLOT_BASE + 8 * i);
    load(EI, prog.code, CONST_DATA);
    assert.equal(EI.run(prog.end), EXIT.HALT);
    const si = snapshot(EI);
    assert.equal(EI.cpu.fpuTop, prog.top, 'model TOP'); assert.equal(EI.cpu.fpuTw, prog.tags, 'model tags: ' + prog.ops.join(' ; '));
    assert.equal(EI.cpu.fpuSw & SW_SF, 0, 'no stack fault in the reference run: ' + prog.ops.join(' ; '));
    if (EI.cpu.fpuSw & C2) oor++;
    // JIT: (1) one region, (2) boundary at a random instruction, (3) time slices of a random budget
    const insnAddrs = []; for (let at = CODE; at < prog.end;) { const insn = decode(EI.mem, at); insnAddrs.push(at); at = insn.next; }
    const boundary = insnAddrs[1 + Math.floor(r() * (insnAddrs.length - 1))];
    const budget = 1 + Math.floor(r() * 8);
    for (const [mode, run] of [['single', () => EJ.run(prog.end)], ['split', () => EJ.run(prog.end, [boundary])], ['sliced', () => (EJ.runSliced(prog.end, [boundary], budget), EXIT.HALT)]]) {
      load(EJ, prog.code, CONST_DATA);
      assert.equal(run(), EXIT.HALT, mode);
      // C1 is masked: FXAM sets it and only the interpreter clears it afterwards (see the todo above)
      const tag = `program ${p} (${mode}, boundary ${hex(boundary)}, budget ${budget}): ${prog.ops.join(' ; ')}`;
      compareSnapshots(snapshot(EJ), si, EJ, EI, slots, tag, 1e-9, ~C1);
      for (let k = 0; k < prog.swSlots; k++) assert.equal(EJ.mem.read16(DATA + SW_BASE + 2 * k) & ~C1, EI.mem.read16(DATA + SW_BASE + 2 * k) & ~C1, `fnstsw #${k} of ${tag}`);
      checked++;
    }
  }
  assert.equal(checked, 1200);
  assert.ok(oor > 10, `programs ending with C2 set: ${oor}`);
  for (const op of TRANS) assert.equal(EJ.jit.fallbackHist.get(op), undefined, `${OP_NAMES[op]} fell back`);
});

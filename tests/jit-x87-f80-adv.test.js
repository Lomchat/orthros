// Adversarial checks of the native FLD/FSTP m80, FNSAVE/FRSTOR, FNSTENV/FLDENV (translate-x87.js): JIT against the
// reference interpreter on the whole x87 state, in the situations the first tests do not reach: 24-bit precision
// blocks holding f32 shadows at the save / m80 store, a precision mode switched by FLDENV/FRSTOR inside a loop (mode
// guards at the back edge), restored tag words marking live values empty (then FXAM), a restored status word with C1
// and condition codes set followed by C1-clearing instructions, and an ESP-relative image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, START = CODE + 0x100;
const hex = (v) => '0x' + (v >>> 0).toString(16);
class Asm {
  constructor(base) { this.base = base; this.bytes = []; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  abs(op, ext, addr) { return this.emit(...op, (ext << 3) | 5).imm32(addr); }
  get pc() { return this.base + this.bytes.length; }
  fld1() { return this.emit(0xd9, 0xe8); }
  fxam() { return this.emit(0xd9, 0xe5); }
  fmulp() { return this.emit(0xde, 0xc9); }
  faddp() { return this.emit(0xde, 0xc1); }
  fdivp() { return this.emit(0xde, 0xf9); }
  fnstswAx() { return this.emit(0xdf, 0xe0); }
  movMemEax(a) { return this.emit(0xa3).imm32(a); }
  fldD(a) { return this.abs([0xd9], 0, a); }
  fstpD(a) { return this.abs([0xd9], 3, a); }
  fldQ(a) { return this.abs([0xdd], 0, a); }
  fstpQ(a) { return this.abs([0xdd], 3, a); }
  fldT(a) { return this.abs([0xdb], 5, a); }
  fstpT(a) { return this.abs([0xdb], 7, a); }
  fnsave(a) { return this.abs([0xdd], 6, a); }
  frstor(a) { return this.abs([0xdd], 4, a); }
  fnstenv(a) { return this.abs([0xd9], 6, a); }
  fldenv(a) { return this.abs([0xd9], 4, a); }
  fldcw(a) { return this.abs([0xd9], 5, a); }
  fnsaveEsp(d) { return this.emit(0xdd, 0x74, 0x24, d); }
  frstorEsp(d) { return this.emit(0xdd, 0x64, 0x24, d); }
  movEcxImm(v) { return this.emit(0xb9).imm32(v); }
  decEcx() { return this.emit(0x49); }
  jnzBack(to) { const rel = to - (this.pc + 2); return this.emit(0x75, rel & 0xff); }
  hlt() { return this.emit(0xf4); }
}
function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, fallbackHist: true }) : null;
  return { mem, cpu, I, jit };
}
function exec(E, code, data, cw) {
  E.mem.fill(CODE, 0x3000, 0xcc);
  E.mem.writeBytes(START, code);
  E.cpu.reset();
  if (cw !== undefined) E.cpu.fpuCw = cw;
  E.mem.fill(DATA, 0x2000, 0);
  for (const [off, v, sz] of data) if (sz === 2) E.mem.write16(DATA + off, v); else if (sz === 4) E.mem.writeF32(DATA + off, v); else E.mem.writeF64(DATA + off, v);
  E.cpu.eip = START; E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
  E.I.cache.clear();
  if (!E.jit) { assert.equal(E.I.run({ maxInsns: 1e7 }), EXIT.HALT); return; }
  E.jit.cpu = E.cpu;
  assert.equal(E.jit.run({ maxInsns: 1e7 }), EXIT.HALT);
}
function snapshot(E) {
  const c = E.cpu;
  return { cw: hex(c.fpuCw), sw: hex(c.fpuSw), tw: c.fpuTw.toString(2).padStart(8, '0'), top: c.fpuTop,
    fpr: Buffer.from(E.mem.bytes(c.base + ST.FPR, 64)).toString('hex'),
    regs: Array.from({ length: 8 }, (_, k) => hex(c.reg(k))), data: Buffer.from(E.mem.bytes(DATA, 0x2000)).toString('hex') };
}
function both(code, data, msg, cw) {
  const EI = makeExec(false), EJ = makeExec(true);
  exec(EI, code, data, cw); exec(EJ, code, data, cw);
  assert.deepEqual(snapshot(EJ), snapshot(EI), msg);
  assert.equal(EJ.jit.stats.fallbackSteps, 0, `${msg}: fallbacks ${[...EJ.jit.fallbackHist.keys()]}`);
  return { EI, EJ };
}

test('24-bit mode: f32 shadows at FNSAVE / FNSTENV / FSTP m80, FLD m80 among f32 arithmetic', () => {
  for (const cw of [0x007f, 0x0c7f, 0x027f]) {
    const a = new Asm(START);
    a.fldD(DATA).fldD(DATA + 4).fmulp().fldD(DATA + 8).fnstenv(DATA + 0x100).fnsave(DATA + 0x200);
    a.fld1().fldD(DATA + 4).faddp().fstpQ(DATA + 0x300);
    a.frstor(DATA + 0x200).fldT(DATA + 0x200 + 28).fdivp().fldD(DATA + 4).fmulp().fstpT(DATA + 0x310);
    a.fldD(DATA + 8).fstpT(DATA + 0x320).fstpD(DATA + 0x330).fnstenv(DATA + 0x340).hlt();
    both(Uint8Array.from(a.bytes), [[0, 1.1, 4], [4, 3.3, 4], [8, -0.7, 4]], `cw ${hex(cw)}`, cw);
  }
});

test('precision mode switched by FLDENV / FRSTOR inside a loop (the mode guards of the back edge)', () => {
  const a = new Asm(START);
  a.fld1().fnstenv(DATA + 0x100).fnsave(DATA + 0x180).frstor(DATA + 0x180); // two images, patched below
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x100).emit(0x7f, 0x00); // env: 24-bit
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x180).emit(0x7f, 0x02); // save: 53-bit
  a.movEcxImm(50);
  const L = a.pc;
  a.fldQ(DATA + 8).fdivp().fldenv(DATA + 0x100).fldQ(DATA + 16).fmulp().fnsave(DATA + 0x400).frstor(DATA + 0x180).fldQ(DATA + 24).faddp().decEcx().jnzBack(L);
  a.fstpQ(DATA + 0x300).fnstenv(DATA + 0x320).hlt();
  both(Uint8Array.from(a.bytes), [[8, 3], [16, 7.1], [24, 0.3]], 'mode loop');
});

test('restored tags marking live values empty, then FXAM / stores; a restored status word with C1 and codes', () => {
  const a = new Asm(START);
  // (stores of an empty register are left out: the JIT does not emulate stack faults, D014)
  a.fldQ(DATA).fldQ(DATA + 8).fldQ(DATA + 16).fnstenv(DATA + 0x100).fnstenv(DATA + 0x1c0); // TOP 5
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x108).emit(0xff, 0xcf); // tags: only slot 6 valid (ST(0) = slot 5 empty)
  a.emit(0x66, 0x81, 0x0d).imm32(DATA + 0x104).emit(0x00, 0x47); // status: C3 C2 C1 C0
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x1c8).emit(0xff, 0xf3); // tags: only slot 5 valid
  a.emit(0x66, 0x81, 0x0d).imm32(DATA + 0x1c4).emit(0x00, 0x02); // status: C1
  a.fldenv(DATA + 0x100).fnstswAx().movMemEax(DATA + 0x500).fxam().fnstswAx().movMemEax(DATA + 0x504);
  a.fnstenv(DATA + 0x140).fldenv(DATA + 0x1c0).fxam().fnstswAx().movMemEax(DATA + 0x50c).fldenv(DATA + 0x1c0).fld1().fnstswAx().movMemEax(DATA + 0x508);
  a.fstpQ(DATA + 0x300).fstpQ(DATA + 0x308).fnstenv(DATA + 0x180).hlt();
  both(Uint8Array.from(a.bytes), [[0, 2], [8, -3], [16, 0]], 'tags');
});

test('ESP-relative FNSAVE / FRSTOR (no SMC check) and FLDENV to an image moving TOP inside a loop', () => {
  const a = new Asm(START);
  a.emit(0x83, 0xec, 0x70); // sub esp, 0x70
  a.fldQ(DATA).fldQ(DATA + 8).fnsaveEsp(0).fld1().fldQ(DATA + 8).fnstenv(DATA + 0x100).frstorEsp(0).fnstenv(DATA + 0x120);
  a.movEcxImm(20);
  const L = a.pc;
  a.fldenv(DATA + 0x100).fldQ(DATA + 16).faddp().fldenv(DATA + 0x120).fldQ(DATA + 16).fmulp().decEcx().jnzBack(L);
  a.fnsave(DATA + 0x400).hlt();
  both(Uint8Array.from(a.bytes), [[0, 1.25], [8, 9], [16, 0.5]], 'esp');
});

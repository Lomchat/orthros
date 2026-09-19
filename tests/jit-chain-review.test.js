// Adversarial checks of region chaining (translate.js emitChain): budget delivery on loops made
// only of cross-region edges, imprecise-trap reporting inside a chained callee, invalidation and
// consolidation of a chain target, FS/GS bases, per-thread state blocks, interpreter fallbacks and
// indirect jumps inside chained regions. Hand-built code, the interpreter is the reference.
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
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(useJit, opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, ...opts }) : null;
  return {
    mem, cpu, I, jit,
    run(stopAt, boundaries, maxInsns = 1000000) {
      I.cache.clear();
      if (!jit) return I.run({ stopAt, maxInsns });
      jit.boundaries = new Set([...boundaries, stopAt]);
      jit.cpu = cpu;
      return jit.run({ stopAt, maxInsns });
    },
  };
}

class Asm {
  constructor(base) { this.base = base; this.bytes = []; this.labels = new Map(); this.fixups = []; }
  get pc() { return this.base + this.bytes.length; }
  label(name) { this.labels.set(name, this.pc); return this; }
  at(name) { const v = this.labels.get(name); if (v === undefined) throw new Error('label ' + name); return v; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  movRegImm(r, v) { return this.emit(0xb8 + r).imm32(v); }
  incReg(r) { return this.emit(0x40 + r); }
  decReg(r) { return this.emit(0x48 + r); }
  addEaxEcx() { return this.emit(0x01, 0xc8); }
  /** mov eax, fs:[disp32] / mov ecx, gs:[disp32] */
  movEaxFs(d) { return this.emit(0x64, 0xa1).imm32(d); }
  movEcxGs(d) { return this.emit(0x65, 0x8b, 0x0d).imm32(d); }
  /** mov [disp32], eax */
  movMemEax(d) { return this.emit(0xa3).imm32(d); }
  /** mov [eax], ecx */
  movEaxPtrEcx() { return this.emit(0x89, 0x08); }
  xlat() { return this.emit(0xd7); }
  jmpEax() { return this.emit(0xff, 0xe0); }
  jmp(name) { this.emit(0xe9); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  jcc(cc, name) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  hlt() { return this.emit(0xf4); }
  finish() {
    for (const [at, name] of this.fixups) {
      const rel = this.at(name) - (this.base + at + 4);
      this.bytes[at] = rel & 0xff; this.bytes[at + 1] = (rel >> 8) & 0xff; this.bytes[at + 2] = (rel >> 16) & 0xff; this.bytes[at + 3] = (rel >>> 24) & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

function load(E, code, cpu = E.cpu) {
  cpu.reset();
  E.mem.fill(DATA, 0x1000, 0);
  E.mem.fill(CODE, 0x1000, 0xcc);
  E.mem.writeBytes(CODE, code);
  cpu.eip = CODE;
  cpu.esp = DATA + 0x800;
  cpu.eflags = F.RESERVED1 | F.IF;
}
function snapshot(E, cpu = E.cpu) {
  const s = { eip: hex(cpu.eip), eflags: hex(cpu.eflags & ARITH), regs: [] };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  return s;
}

// A loop whose every edge is a cross-region jump (both L1 and L2 are region boundaries, so each
// region is a single block ending in a jump out of it):
//   L1: add eax, ecx ; jmp L2
//   L2: dec ecx ; jnz L1 ; hlt      (the not-taken jnz falls through to another region: end)
function crossOnlyLoop() {
  const a = new Asm(CODE);
  a.movRegImm(1, 1000).movRegImm(0, 0);
  a.label('L1').addEaxEcx().jmp('L2');
  a.label('L2').decReg(1).jcc(0x5, 'L1');
  a.label('end').hlt();
  return { code: a.finish(), L1: a.at('L1'), L2: a.at('L2'), end: a.at('end') };
}

test('a chained loop made only of cross-region edges still delivers time slices', () => {
  const { code, L1, L2, end } = crossOnlyLoop();
  for (const chain of [true, false]) {
    const EJ = makeExec(true, { chain });
    load(EJ, code);
    assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT); // warm up: all three regions translated
    assert.equal(EJ.cpu.eax, 500500);
    load(EJ, code);
    let slices = 0, r;
    for (;;) {
      r = EJ.run(end, [L1, L2], 100);
      if (r !== EXIT.TIMESLICE) break;
      slices++;
      assert.ok(EJ.jit.remaining() <= 0, 'budget exhausted at the slice');
      assert.ok(slices < 10000, 'runaway');
    }
    assert.equal(r, EXIT.HALT);
    assert.equal(EJ.cpu.eax, 500500);
    // ~4000 instructions executed in slices of 100 (regions charge whole blocks): at least 20 slices
    assert.ok(slices >= 20, `chain=${chain}: slices ${slices}, remaining ${EJ.jit.remaining()}`);
  }
});

test('a WASM trap inside a chained callee reports the entry of the faulting region', () => {
  // L0: mov eax, 5 ; mov ecx, 0x90000000 ; jmp L1      L1: mov [ecx], eax (out of the 2 GB memory: trap)
  const a = new Asm(CODE);
  a.label('L0').movRegImm(0, 5).movRegImm(1, 0x90000000).jmp('L1');
  a.label('L1').movRegImm(2, 9).emit(0x89, 0x01).hlt(); // mov [ecx], eax
  const code = a.finish();
  const L1 = a.at('L1'), end = a.at('L1') + 5 + 2;
  const EJ = makeExec(true);
  // translate L1 first (so that the L0 -> L1 jump chains), then run from L0
  load(EJ, code); EJ.cpu.eip = L1; EJ.cpu.ecx = DATA;
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  load(EJ, code);
  const chainedBefore = EJ.jit.stats.chained;
  assert.equal(EJ.run(end, [L1]), EXIT.FAULT);
  assert.ok(EJ.jit.lastFault instanceof WebAssembly.RuntimeError, 'trap');
  assert.equal(EJ.jit.stats.chained, chainedBefore + 1, 'the L0 -> L1 transition chained');
  // parity with the non-chained dispatcher: EIP is the entry of the region that trapped
  assert.equal(hex(EJ.cpu.eip), hex(L1));
});

test('invalidating the target of a chain removes it from the hash table (no stale tail call)', () => {
  const { code, L1, L2, end } = crossOnlyLoop();
  const EJ = makeExec(true);
  load(EJ, code);
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT);
  assert.ok(EJ.jit.stats.chained > 100);
  const before = EJ.jit.stats.regions;
  // drop the regions of L2's page (as an SMC exit would; invalidation is page-granular): the
  // table slots are cleared, so any stale hash entry would make the next chain trap on a null entry
  EJ.jit.invalidate(L2, 1);
  assert.equal(EJ.jit.hashLookup(L1), null); assert.equal(EJ.jit.hashLookup(L2), null);
  assert.ok(EJ.jit.stats.dropped >= 3, `dropped ${EJ.jit.stats.dropped}`);
  load(EJ, code);
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT);
  assert.equal(EJ.cpu.eax, 500500);
  assert.ok(EJ.jit.stats.regions > before, 'retranslated');
  // self-modifying code in a chained callee: L2 patches L1 (`add eax, ecx` -> `sub eax, ecx`)
  const a = new Asm(CODE);
  a.movRegImm(1, 3).movRegImm(0, 0);
  a.label('L1').addEaxEcx().jmp('L2');
  a.label('L2').movRegImm(2, 0x29).emit(0x88, 0x15).imm32(a.at('L1')).decReg(1).jcc(0x5, 'L1'); // mov [L1], dl
  a.label('end').hlt();
  const smc = a.finish();
  const ES = makeExec(true); // fresh translations (a program written from JS is not an SMC event)
  load(ES, smc);
  let r, smcExits = 0;
  for (;;) { // as vm.js: an SMC exit invalidates the written code and resumes
    r = ES.run(a.at('end'), [a.at('L1'), a.at('L2')]);
    if (r !== EXIT.SMC) break;
    smcExits++; ES.jit.invalidate(ES.cpu.exitArg, 16); ES.I.invalidate(ES.cpu.exitArg, 16);
    assert.ok(smcExits < 100, 'runaway');
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(ES.cpu.eax, (3 - 2 - 1) >>> 0);
  assert.equal(ES.cpu.ecx, 0);
  assert.ok(smcExits >= 1 && ES.jit.stats.invalidations >= 1, `smc exits ${smcExits}`);
});

test('chains survive region consolidation (table entries replaced by the packed module)', () => {
  const { code, L1, L2, end } = crossOnlyLoop();
  const EJ = makeExec(true, { consolidateEvery: 2 });
  load(EJ, code);
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT);
  assert.ok(EJ.jit.stats.consolidations >= 1, `consolidations ${EJ.jit.stats.consolidations}`);
  load(EJ, code);
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT);
  assert.equal(EJ.cpu.eax, 500500);
  assert.ok(EJ.jit.stats.chained > 100);
});

test('FS and GS bases are seen by a chained callee', () => {
  // L0: mov eax, fs:[0] ; jmp L1      L1: mov ecx, gs:[4] ; add eax, ecx ; hlt
  const a = new Asm(CODE);
  a.label('L0').movEaxFs(0).jmp('L1');
  a.label('L1').movEcxGs(4).addEaxEcx().hlt();
  const code = a.finish();
  const L1 = a.at('L1'), end = a.at('L1') + 7 + 2;
  const EJ = makeExec(true);
  load(EJ, code);
  EJ.mem.write32(DATA + 0x100, 0x1111); EJ.mem.write32(DATA + 0x204, 0x2222);
  EJ.cpu.fsBase = DATA + 0x100; EJ.cpu.gsBase = DATA + 0x200;
  EJ.cpu.eip = L1; assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  EJ.cpu.eip = CODE; EJ.cpu.eax = 0; EJ.cpu.ecx = 0;
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eax, 0x3333);
  assert.ok(EJ.jit.stats.chained >= 1);
  // another thread state with other bases runs the same translated code
  const cpu2 = new CpuState(EJ.mem, THREAD_STATES_BASE + ST.SIZE);
  cpu2.reset(); cpu2.eip = CODE; cpu2.esp = DATA + 0x900; cpu2.eflags = F.RESERVED1 | F.IF;
  EJ.mem.write32(DATA + 0x300, 0x10); EJ.mem.write32(DATA + 0x404, 0x20);
  cpu2.fsBase = DATA + 0x300; cpu2.gsBase = DATA + 0x400;
  EJ.jit.cpu = cpu2; EJ.I.cache.clear();
  assert.equal(EJ.jit.run({ stopAt: end, maxInsns: 1000 }), EXIT.HALT);
  assert.equal(cpu2.eax, 0x30);
  assert.equal(EJ.cpu.eax, 0x3333, 'first thread state untouched');
});

test('two thread states alternate through the same chained regions', () => {
  const { code, L1, L2, end } = crossOnlyLoop();
  const EJ = makeExec(true);
  const cpuA = EJ.cpu, cpuB = new CpuState(EJ.mem, THREAD_STATES_BASE + ST.SIZE);
  load(EJ, code, cpuA); load(EJ, code, cpuB); cpuB.esp = DATA + 0x900;
  assert.equal(EJ.run(end, [L1, L2]), EXIT.HALT); // warm up on A
  load(EJ, code, cpuA); cpuA.ecx = 0; cpuA.eax = 0; cpuA.eip = CODE;
  // run both in interleaved slices; B enters the loop directly at L1 with a shorter count
  EJ.mem.writeBytes(CODE, code);
  cpuB.eip = L1; cpuB.ecx = 10; cpuB.eax = 0;
  const runOn = (cpu, n) => { EJ.jit.cpu = cpu; EJ.jit.boundaries = new Set([L1, L2, end]); return EJ.jit.run({ stopAt: end, maxInsns: n }); };
  let doneA = false, doneB = false, guard = 0;
  while ((!doneA || !doneB) && guard++ < 10000) {
    if (!doneA) { const r = runOn(cpuA, 37); if (r === EXIT.HALT) doneA = true; else assert.equal(r, EXIT.TIMESLICE); }
    if (!doneB) { const r = runOn(cpuB, 11); if (r === EXIT.HALT) doneB = true; else assert.equal(r, EXIT.TIMESLICE); }
  }
  assert.ok(doneA && doneB, 'both threads finished');
  assert.equal(cpuA.eax, 500500); assert.equal(cpuA.ecx, 0);
  assert.equal(cpuB.eax, 55); assert.equal(cpuB.ecx, 0);
  assert.equal(EJ.mem.read32(cpuA.base + ST.TRANSITIONS), 0);
  assert.equal(EJ.mem.read32(cpuB.base + ST.TRANSITIONS), 0);
});

test('interpreter fallback and indirect jumps inside chained regions', () => {
  // L0: mov ebx, DATA ; mov eax, L1 ; sub eax, 0 (lazy flags) ; jmp eax        (indirect exit -> chain)
  // L1: xlat (fallback: al = [ebx + al]) ; jz L2 ; inc edx ; L2: hlt
  const a = new Asm(CODE);
  a.label('L0').movRegImm(3, DATA).movRegImm(0, 0).emit(0x83, 0xe8, 0x00); // sub eax, 0 -> ZF=1 lazily
  const movEaxAt = a.bytes.length; a.movRegImm(0, 0); // mov eax, L1 (absolute, patched below)
  a.jmpEax();
  a.label('L1').xlat().jcc(0x4, 'L2').incReg(2);
  a.label('L2').hlt();
  const code = a.finish();
  const L1 = a.at('L1'), L2 = a.at('L2');
  new DataView(code.buffer).setUint32(movEaxAt + 1, L1, true);
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code); load(EJ, code);
  EJ.mem.write8(DATA + (L1 & 0xff), 0x77); EI.mem.write8(DATA + (L1 & 0xff), 0x77);
  EJ.cpu.eip = L1; EJ.cpu.ebx = DATA; assert.equal(EJ.run(L2, [L1]), EXIT.HALT); // translate L1 first
  load(EJ, code); EJ.mem.write8(DATA + (L1 & 0xff), 0x77);
  assert.equal(EI.run(L2, []), EXIT.HALT);
  assert.equal(EJ.run(L2, [L1]), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  assert.equal(EJ.cpu.eax & 0xff, 0x77);
  assert.ok(EJ.jit.stats.chained >= 1, `chained ${EJ.jit.stats.chained}`);
  assert.ok(EJ.jit.stats.fallbackSteps >= 1, 'xlat ran in the interpreter');
});

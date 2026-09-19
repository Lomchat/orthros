// Region chaining: a translated region tail-calls the next region directly when the jump target
// is already translated (registers/lazy flags travel as parameters, see translate.js emitChain).
// Hand-built loops are split into several regions with explicit boundaries and checked against
// the reference interpreter; the stop address and untranslated targets must still return to
// the dispatcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { MAX_BLOCKS } from '../src/cpu/jit/translate.js';

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

/** Tiny assembler for the handful of encodings used here (32-bit operand/address size). */
class Asm {
  constructor(base) { this.base = base; this.bytes = []; this.labels = new Map(); this.fixups = []; }
  get pc() { return this.base + this.bytes.length; }
  label(name) { this.labels.set(name, this.pc); return this; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  movEcxImm(v) { return this.emit(0xb9).imm32(v); }
  movEaxImm(v) { return this.emit(0xb8).imm32(v); }
  addEaxEcx() { return this.emit(0x01, 0xc8); }
  subEaxImm8(v) { return this.emit(0x83, 0xe8, v & 0xff); }
  decEcx() { return this.emit(0x49); }
  incEdx() { return this.emit(0x42); }
  /** rel32 jump/jcc to a label */
  jmp(name) { this.emit(0xe9); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  jcc(cc, name) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, name]); return this.imm32(0); }
  fld1() { return this.emit(0xd9, 0xe8); }
  faddSt0St0() { return this.emit(0xd8, 0xc0); }
  fstpQword(addr) { return this.emit(0xdd, 0x1d).imm32(addr); }
  hlt() { return this.emit(0xf4); }
  finish() {
    for (const [at, name] of this.fixups) {
      const target = this.labels.get(name); if (target === undefined) throw new Error('label ' + name);
      const rel = target - (this.base + at + 4);
      this.bytes[at] = rel & 0xff; this.bytes[at + 1] = (rel >> 8) & 0xff; this.bytes[at + 2] = (rel >> 16) & 0xff; this.bytes[at + 3] = (rel >>> 24) & 0xff;
    }
    return Uint8Array.from(this.bytes);
  }
}

function load(E, code) {
  E.cpu.reset();
  E.mem.fill(DATA, 0x1000, 0);
  E.mem.fill(CODE, 0x1000, 0xcc);
  E.mem.writeBytes(CODE, code);
  E.cpu.eip = CODE;
  E.cpu.esp = DATA + 0x800;
  E.cpu.eflags = F.RESERVED1 | F.IF;
}
function snapshot(E) {
  const s = { eip: hex(E.cpu.eip), eflags: hex(E.cpu.eflags & ARITH), regs: [], top: E.cpu.fpuTop, mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(E.cpu.reg(k)));
  return s;
}

// eax = sum(1..N) computed by a loop whose body spans three regions (region boundary at L1 only:
// a region whose entry is itself a boundary is discovered as a single block, so L2 is left to
// become a region entry through the `jmp L2` exit of L1 and keeps its two blocks):
//   entry:  mov ecx, N ; mov eax, 0        -> falls into L1 (boundary)
//   L1:     add eax, ecx ; jmp L2          (region; every iteration chains L1 -> L2)
//   L2:     dec ecx ; jz end ; jmp L1      (region of two blocks: the not-taken jz falls through
//                                           inside the region, which charges the instruction
//                                           budget; the jmp chains L2 -> L1 with lazy DEC flags)
//   end:    hlt                            (stop address)
const N = 1000;
function loopProgram() {
  const a = new Asm(CODE);
  a.movEcxImm(N).movEaxImm(0);
  a.label('L1').addEaxEcx().jmp('L2');
  a.label('L2').decEcx().jcc(0x4, 'end').jmp('L1'); // jz end
  a.label('end').hlt();
  return { code: a.finish(), L1: a.labels.get('L1'), L2: a.labels.get('L2'), end: a.labels.get('end') };
}

test('a loop split across regions chains between them and matches the interpreter', () => {
  const { code, L1, L2, end } = loopProgram();
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code); load(EJ, code);
  assert.equal(EI.run(end, []), EXIT.HALT);
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
  assert.equal(EJ.cpu.eax, (N * (N + 1)) / 2);
  assert.equal(EJ.cpu.eip, end);
  assert.ok(EJ.jit.stats.regions >= 3, `regions: ${EJ.jit.stats.regions}`);
  // every iteration crosses L1 -> L2 and L2 -> L1 (minus the first entries that miss the hash table)
  assert.ok(EJ.jit.stats.chained >= 2 * N - 4, `chained: ${EJ.jit.stats.chained}`);
  assert.equal(EJ.mem.read32(EJ.cpu.base + ST.TRANSITIONS), 0, 'counter harvested');
});

test('chaining never targets the stop address or an untranslated region', () => {
  const { code, L1, L2, end } = loopProgram();
  const EJ = makeExec(true);
  load(EJ, code);
  // stop at L2: the first pass through L1 must halt at L2 even once L2 gets translated later
  assert.equal(EJ.run(L2, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eip, L2);
  assert.equal(EJ.cpu.eax, N); assert.equal(EJ.cpu.ecx, N);
  const chainedBefore = EJ.jit.stats.chained;
  // run to the end from L2 (translating it), then restart the whole program with L2 translated:
  // the L1 -> L2 transition must still stop at L2 when L2 is the stop address
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eax, (N * (N + 1)) / 2);
  assert.ok(EJ.jit.stats.chained > chainedBefore, 'chained after both regions exist');
  const chainedMid = EJ.jit.stats.chained;
  EJ.cpu.eip = CODE; EJ.cpu.eax = 0; EJ.cpu.ecx = 0;
  assert.equal(EJ.run(L2, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eip, L2);
  assert.equal(EJ.cpu.eax, N); assert.equal(EJ.cpu.ecx, N);
  // exactly one transition chained (entry -> L1); L1 -> L2 returned to the dispatcher instead
  assert.equal(EJ.jit.stats.chained, chainedMid + 1, 'no chained transition into the stop address');
  // stop at L1 while looping: the L2 -> L1 back edge must halt at L1 with the lazy DEC flags folded
  EJ.cpu.eip = L2; EJ.cpu.ecx = 5; EJ.cpu.eax = 7;
  assert.equal(EJ.run(L1, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eip, L1);
  assert.equal(EJ.cpu.ecx, 4);
  assert.equal(EJ.cpu.eflags & F.ZF, 0);
  assert.equal(EJ.mem.read32(EJ.cpu.base + ST.LZ_OP), 0, 'lazy flags materialized at the halt');
});

test('the instruction budget still ends a chained loop with time slices', () => {
  const { code, L1, L2, end } = loopProgram();
  const EI = makeExec(false), EJ = makeExec(true);
  load(EI, code); load(EJ, code);
  assert.equal(EI.run(end, []), EXIT.HALT);
  // warm up: translate everything, then rerun in slices of a few instructions
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  load(EJ, code);
  let slices = 0, r;
  for (;;) {
    r = EJ.run(end, [L1], 50);
    if (r !== EXIT.TIMESLICE) break;
    slices++;
    assert.ok(EJ.jit.remaining() <= 0, 'budget exhausted at the time slice');
    void EJ.cpu.eflags; // flags stay lazy across the slice; reading EFLAGS folds the pending operation
    assert.equal(EJ.mem.read32(EJ.cpu.base + ST.LZ_OP), 0, 'lazy flags fold when EFLAGS are read');
    assert.ok(slices < N, 'runaway');
  }
  assert.equal(r, EXIT.HALT);
  assert.ok(slices >= 10, `slices: ${slices}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI));
});

test('chaining with the chain option disabled produces the same results and no transitions', () => {
  const { code, L1, L2, end } = loopProgram();
  const EJ = makeExec(true, { chain: false });
  assert.equal(EJ.jit.chaining, false);
  load(EJ, code);
  assert.equal(EJ.run(end, [L1]), EXIT.HALT);
  assert.equal(EJ.cpu.eax, (N * (N + 1)) / 2);
  assert.equal(EJ.jit.stats.chained, 0);
});

test('x87 TOP and lazy flags survive a chained transition', () => {
  // L0: fld1 ; sub eax, 1 ; jmp L1      (TOP changes, lazy SUB flags pending at the exit)
  // L1: fadd st0, st0 ; fstp [DATA] ; jz L2 ; inc edx   (flags evaluated in the next region)
  // L2: hlt
  const a = new Asm(CODE);
  a.label('L0').fld1().subEaxImm8(1).jmp('L1');
  a.label('L1').faddSt0St0().fstpQword(DATA).jcc(0x4, 'L2').incEdx();
  a.label('L2').hlt();
  const code = a.finish();
  const L1 = a.labels.get('L1'), L2 = a.labels.get('L2');
  for (const eax of [1, 2]) {
    const EI = makeExec(false), EJ = makeExec(true);
    load(EI, code); load(EJ, code);
    EI.cpu.eax = eax; EJ.cpu.eax = eax;
    // translate L1 first so the L0 -> L1 jump chains
    EJ.cpu.eip = L1; assert.equal(EJ.run(L2, [L1]), EXIT.HALT);
    load(EJ, code); EJ.cpu.eax = eax;
    assert.equal(EI.run(L2, []), EXIT.HALT);
    assert.equal(EJ.run(L2, [L1]), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), snapshot(EI), `eax=${eax}`);
    assert.equal(EJ.mem.f64[DATA >>> 3], 2);
    assert.equal(EJ.cpu.edx, eax === 1 ? 0 : 1);
    assert.ok(EJ.jit.stats.chained >= 1, `chained: ${EJ.jit.stats.chained}`);
  }
});

test('a jump chain longer than MAX_BLOCKS spans several regions and chains through them', () => {
  // a straight chain of MAX_BLOCKS*3 tiny blocks `inc edx ; jmp next`, run twice
  const a = new Asm(CODE);
  const n = MAX_BLOCKS * 3;
  for (let i = 0; i < n; i++) a.label('b' + i).incEdx().jmp('b' + (i + 1));
  a.label('b' + n).hlt();
  const code = a.finish();
  const end = a.labels.get('b' + n);
  const EJ = makeExec(true);
  load(EJ, code);
  assert.equal(EJ.run(end, []), EXIT.HALT);
  assert.equal(EJ.cpu.edx, n);
  assert.ok(EJ.jit.stats.regions >= 3, `regions: ${EJ.jit.stats.regions}`);
  assert.equal(EJ.jit.stats.chained, 0, 'first pass: every region was a translation miss');
  load(EJ, code);
  assert.equal(EJ.run(end, []), EXIT.HALT);
  assert.equal(EJ.cpu.edx, n);
  assert.ok(EJ.jit.stats.chained >= EJ.jit.stats.regions - 1, `chained: ${EJ.jit.stats.chained} regions: ${EJ.jit.stats.regions}`);
});

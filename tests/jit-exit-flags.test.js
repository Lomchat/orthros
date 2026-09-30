// The lazy flag state at the JIT's exits (translate.js): what a region leaves in the state block when it exits in the
// middle of a block (a self-modifying-code exit after a store, a time slice at a back edge) must be the flags the guest
// sees at the resume address.
// 1. A read-modify-write instruction whose store hits a page holding translated code exits after the instruction
//    (EXIT.SMC): its own flags must be in the state (INC/DEC/NEG/ADC/SBB/shifts/SHLD/XADD... used to set the lazy kind
//    after the store, so that exit flushed the new operands with the previous instruction's kind).
// 2. Where no flag is live at the resume address (every path from it writes the flags before reading them: the region's
//    liveness), a time-slice exit writes "no lazy op" instead of the lazy operands, so that they are not kept live
//    around loops for the exit path alone; flags that are live are still exact. SMC exits keep the whole lazy state
//    (their store may rewrite the code the liveness was computed on). JIT against the interpreter, whole and
//    time-sliced runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { listRegion } from '../src/cpu/jit/listing.js';

const CODE = 0x20000000, DATA = 0x10000000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;

/** Run `code` at CODE (ending in HLT) under the interpreter or the JIT (SMC exits handled as the VM does: the written
 * range invalidated, the run resumed); `slice`: instructions per run() call (time slices). */
function run(code, useJit, { slice = 1e7, init = () => {} } = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(code));
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1 | F.IF;
  init(mem, cpu);
  const I = new Interp(mem, cpu);
  if (!useJit) I.cache = new (class extends Map { set() { return this; } })(); // (stores into code: decode afresh)
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  if (jit) jit.cpu = cpu;
  const end = CODE + code.length - 1;
  let r, smc = 0, runs = 0;
  for (;;) {
    r = useJit ? jit.run({ stopAt: end, maxInsns: slice }) : I.run({ stopAt: end, maxInsns: slice });
    runs++;
    if (r === EXIT.SMC) { const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0); jit.invalidate(cpu.exitArg, len); smc++; continue; }
    if (r === EXIT.TIMESLICE) { assert.ok(runs < 1e6, 'runaway'); continue; }
    break;
  }
  assert.equal(r, EXIT.HALT, `exit ${r}`);
  if (useJit) CpuState.foldLazyFlags?.(cpu);
  return { regs: [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.ebp, cpu.esi, cpu.edi].map((v) => v >>> 0), flags: cpu.eflags & ARITH, mem: [...mem.bytes(DATA, 64)], smc };
}

// ---- 1. flags of an instruction whose store takes the SMC exit
// the data word sits in the code's own page, after the HLT: a store there leaves the region (translated code page)
const WORD = CODE + 0x800;
/** mov edi, WORD ; mov eax, 0x80000001 ; cmp eax, 3 (a SUB lazy op first) ; stc/clc ; <insn [edi]> ; pushfd ; pop ebx ; hlt */
function smcProgram(insn, carry) {
  return [0xbf, ...le(WORD), 0xb8, ...le(0x80000001), 0x83, 0xf8, 0x03, carry ? 0xf9 : 0xf8, 0xb9, ...le(0x7ffffffe), ...insn, 0x9c, 0x5b, 0xf4];
}
const RMW = [
  ['inc dword [edi]', [0xff, 0x07]],
  ['dec dword [edi]', [0xff, 0x0f]],
  ['inc byte [edi]', [0xfe, 0x07]],
  ['neg dword [edi]', [0xf7, 0x1f]],
  ['not dword [edi] (no flags)', [0xf7, 0x17]],
  ['adc dword [edi], ecx', [0x11, 0x0f]],
  ['sbb dword [edi], ecx', [0x19, 0x0f]],
  ['add dword [edi], ecx', [0x01, 0x0f]],
  ['shl dword [edi], 1', [0xd1, 0x27]],
  ['shr dword [edi], 3', [0xc1, 0x2f, 0x03]],
  ['sar word [edi], 1', [0x66, 0xd1, 0x3f]],
  ['rol dword [edi], 1', [0xd1, 0x07]],
  ['rcl dword [edi], 1', [0xd1, 0x17]],
  ['shld [edi], ecx, 4', [0x0f, 0xa4, 0x0f, 0x04]],
  ['shrd [edi], ecx, 4', [0x0f, 0xac, 0x0f, 0x04]],
  ['xadd [edi], ecx', [0x0f, 0xc1, 0x0f]],
  ['cmpxchg [edi], ecx (equal)', [0x0f, 0xb1, 0x0f]],
  ['bts dword [edi], 5', [0x0f, 0xba, 0x2f, 0x05]],
  ['setc byte [edi]', [0x0f, 0x92, 0x07]],
];
for (const [name, insn] of RMW) {
  for (const [label, value] of (name.startsWith('cmpxchg') ? [['0x80000001 (equal)', 0x80000001]] : [['0x7fffffff', 0x7fffffff], ['0xffffffff', 0xffffffff], ['1', 1], ['0x80000001', 0x80000001]])) {
    for (const carry of [false, true]) {
      test(`SMC exit after ${name}, [edi] = ${label}, CF ${carry ? 1 : 0}: its flags reach the state block`, () => {
        const code = smcProgram(insn, carry);
        const init = (mem) => mem.write32(WORD, value);
        const want = run(code, false, { init }), got = run(code, true, { init });
        assert.ok(got.smc >= 1, 'the store takes the SMC exit');
        assert.deepEqual(got.regs, want.regs);
        assert.equal(got.flags, want.flags);
      });
    }
  }
}

// ---- 2. in-region exits where the flags are dead at the resume address
// a counting loop: L: mov edx, [esi+ecx*4] ; add eax, edx ; mov [edi+ecx*4], eax ; inc ecx ; cmp ecx, ebx ; jb L ; <tail> ; hlt
// the back edge's time-slice exit resumes at L, whose first flag access is the ADD (a write): flags dead there
const LOOP = [0x8b, 0x14, 0x8e, 0x01, 0xd0, 0x89, 0x04, 0x8f, 0x41, 0x39, 0xd9, 0x72, 0xf3];
const TAILS = [
  ['hlt', []],
  ['setb dl (the loop\'s last CMP read after it)', [0x0f, 0x92, 0xc2]],
  ['adc eax, 0', [0x83, 0xd0, 0x00]],
  ['pushfd ; pop edx', [0x9c, 0x5a]],
];
const loopInit = (mem, cpu) => { cpu.esi = DATA; cpu.edi = DATA + 0x100; cpu.ebx = 13; cpu.ecx = 0; cpu.eax = 0xfffffff0; for (let k = 0; k < 16; k++) mem.write32(DATA + 4 * k, (k * 0x10000001) >>> 0); };
for (const [name, tail] of TAILS) {
  for (const slice of [1e7, 1, 2, 3, 5, 7]) {
    test(`loop with dead flags at its back edge, tail ${name}, slices of ${slice}`, () => {
      const code = [0x31, 0xc0, 0x2d, ...le(0x10), ...LOOP, ...tail, 0xf4]; // xor eax, eax ; sub eax, 16 ; loop ; tail ; hlt
      const want = run(code, false, { slice, init: loopInit }), got = run(code, true, { slice, init: loopInit });
      assert.deepEqual(got.regs, want.regs);
      assert.equal(got.flags, want.flags);
      assert.deepEqual(got.mem, want.mem);
    });
  }
}
// the same loop with the flags live at its head (an ADC reading the CMP's carry across the back edge): the exit keeps them
const LOOP_LIVE = [0x8b, 0x14, 0x8e, 0x11, 0xd0, 0x89, 0x04, 0x8f, 0x41, 0x39, 0xd9, 0x72, 0xf3]; // adc eax, edx instead of add
for (const slice of [1e7, 1, 2, 3, 4, 5, 6]) {
  test(`loop with flags live at its back edge (ADC), slices of ${slice}`, () => {
    const code = [0x31, 0xc0, 0x2d, ...le(0x10), ...LOOP_LIVE, 0x9c, 0x5a, 0xf4];
    const want = run(code, false, { slice, init: loopInit }), got = run(code, true, { slice, init: loopInit });
    assert.deepEqual(got.regs, want.regs);
    assert.equal(got.flags, want.flags);
    assert.deepEqual(got.mem, want.mem);
  });
}
// a store into the loop's own code page at every iteration, flags dead after it (the SMC exit resumes at the INC)
test('SMC exits in a loop with dead flags after the store', () => {
  // L: add eax, 5 ; mov [edi], eax ; inc ecx ; cmp ecx, ebx ; jb L ; hlt   (edi -> a word of the code page)
  const code = [0x83, 0xc0, 0x05, 0x89, 0x07, 0x41, 0x39, 0xd9, 0x72, 0xf6, 0xf4];
  const init = (mem, cpu) => { cpu.edi = WORD; cpu.ebx = 6; cpu.ecx = 0; cpu.eax = 0x7ffffff0; };
  const want = run(code, false, { init }), got = run(code, true, { init });
  assert.ok(got.smc >= 1);
  assert.deepEqual(got.regs, want.regs);
  assert.equal(got.flags, want.flags);
});

test('the time-slice exit of a back edge whose flags are dead does not use the lazy operands', () => {
  const mem = new GuestMemory();
  const code = [...LOOP, 0xf4];
  mem.writeBytes(CODE, Uint8Array.from(code));
  const { groups } = listRegion(mem, CODE, { smc: true });
  const jcc = groups.find((g) => /\bjb\b/.test(g.label));
  assert.ok(jcc, 'the JB is listed');
  const i = jcc.ops.indexOf('i32 0'); // (the exit path: the lazy op cleared)
  assert.ok(jcc.ops.includes('set lzop'), `the exit clears the lazy op: ${jcc.ops.join(' | ')}`);
  void i;
  // with the flags live at the head (ADC), the exit keeps the lazy state
  const mem2 = new GuestMemory();
  mem2.writeBytes(CODE, Uint8Array.from([...LOOP_LIVE, 0xf4]));
  const j2 = listRegion(mem2, CODE, { smc: true }).groups.find((g) => /\bjb\b/.test(g.label));
  assert.ok(!j2.ops.includes('set lzop'), 'live flags: the lazy state is kept');
});
// the store taking the SMC exit rewrites the code right after it: a JMP (flags dead: its target's CMP writes them) becomes
// a JZ reading the ZF of the CMP before the store — the SMC exit keeps the whole lazy state (the region's liveness was
// computed on the old bytes)
test('SMC exit whose store turns the next JMP into a JZ: the flags before the store survive', () => {
  // mov edi, L ; mov eax, 5 ; cmp eax, 5 ; mov byte [edi], 0x74 ; L: jmp +2 ; mov bl, 1 ; cmp eax, eax ; hlt
  const pre = [0xbf, 0, 0, 0, 0, 0xb8, ...le(5), 0x83, 0xf8, 0x05, 0xc6, 0x07, 0x74];
  pre.splice(1, 4, ...le(CODE + pre.length));
  const code = [...pre, 0xeb, 0x02, 0xb3, 0x01, 0x39, 0xc0, 0xf4];
  const want = run(code, false), got = run(code, true);
  assert.ok(got.smc >= 1, 'the store takes the SMC exit');
  assert.equal(want.regs[3] & 0xff, 0, 'the JZ is taken');
  assert.deepEqual(got.regs, want.regs);
});

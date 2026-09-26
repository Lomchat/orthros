// One interpreter runs every thread (the JIT's fallbacks switch Interp.cpu): its x87 instructions must work on the
// current thread's FPU state. The x87 helper once kept the state of the thread current at its creation, so an FPREM
// run for another thread left that thread's C2 set — the C runtime's fmod loop (fprem / fnstsw / sahf / jp) never
// ended on it (a game's second loading screen hung).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';

const CODE = 0x20000000;

function thread(mem, slot, a, b) {
  const cpu = new CpuState(mem, THREAD_STATES_BASE + slot * ST.SIZE);
  cpu.reset();
  cpu.eip = CODE; cpu.esp = 0x10008000 - slot * 0x1000; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x037f); mem.write16(cpu.base + ST.FPU_SW, 0x0400); // (C2 set, as FXAM leaves it for a normal number)
  cpu.fpuTop = 6; mem.write16(cpu.base + ST.FPU_TW, 0xc0);
  cpu.setSt(0, a); cpu.setSt(1, b);
  return cpu;
}

test('interpreter x87 instructions act on the current thread, whichever thread used the x87 first', () => {
  const mem = new GuestMemory();
  mem.writeBytes(CODE, Uint8Array.from([0xd9, 0xf8, 0xf4])); // fprem ; hlt
  const t1 = thread(mem, 0, 7.5, 2), t2 = thread(mem, 1, 2.296250163228251, 6.2831854820251465);
  const I = new Interp(mem, t1);
  assert.equal(I.run({ maxInsns: 10 }), EXIT.HALT);
  assert.equal(t1.st(0), 1.5);
  I.cpu = t2;
  assert.equal(I.run({ maxInsns: 10 }), EXIT.HALT);
  assert.equal(t2.st(0), 2.296250163228251, 'the remainder of thread 2');
  assert.equal(t2.fpuSw & 0x0400, 0, 'C2 clear on thread 2: complete reduction');
  assert.equal(t1.st(0), 1.5, 'thread 1 untouched');
});

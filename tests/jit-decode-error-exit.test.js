// A block ended by an undecodable instruction (discoverRegion: TERM_EXIT with decodeError) leaves the region there for
// the interpreter, which raises the fault with the exact state: the instructions before it done, EIP at it. (The block
// used to end without any exit: the code ran on into the next block's — or trapped, the fault then reported with the
// registers of the region's entry.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
function run(code, useJit, slice = 0) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, Uint8Array.from(code));
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eax = 5; cpu.ecx = 3; cpu.ebp = 4; cpu.eflags = F.RESERVED1 | F.IF;
  const interp = new Interp(mem, cpu);
  let r;
  if (!useJit) r = interp.run({ maxInsns: 1e5 });
  else {
    const jit = new Jit(mem, interp, { smc: true }); jit.cpu = cpu;
    let k = 0; do r = jit.run({ maxInsns: slice || 1e5 }); while (r === EXIT.TIMESLICE && ++k < 1e5);
  }
  return `${r} eip=${(cpu.eip >>> 0).toString(16)} eax=${cpu.eax} ecx=${cpu.ecx} ebp=${cpu.ebp} esp=${(cpu.esp >>> 0).toString(16)} fl=${(cpu.eflags & 0x8d5).toString(16)}`;
}

test('an undecodable instruction faults where it is, after the instructions before it', () => {
  const programs = [
    [0x40, 0x0f, 0x00, 0x00, 0x40, 0xf4], // inc eax ; (0f 00 /0: undecodable here)
    [0x0f, 0x00, 0x00], // at the region's entry
    [0x40, 0x41, 0x74, 0x02, 0x0f, 0x00, 0x00, 0x48, 0xf4], // after a conditional branch not taken
    [0x49, 0x75, 0x03, 0x0f, 0x00, 0x00, 0x48, 0xeb, 0xf7], // in a loop: reached once the counter is 0
    [0x4d, 0x74, 0x03, 0x40, 0xeb, 0xfa, 0x0f, 0x00, 0x00, 0xf4], // loop exit into it (ebp counts down)
    [0x40, 0x07, 0x00, 0xe9, 0x0f, 0x00, 0x00, 0x40, 0xf4], // after pop es ; add cl, ch
  ];
  for (const p of programs) {
    const ref = run(p, false);
    assert.match(ref, /^4 /, 'the interpreter faults');
    for (const slice of [0, 1, 2]) assert.equal(run(p, true, slice), ref, `${Buffer.from(p).toString('hex')} slice ${slice}`);
  }
});

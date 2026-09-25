// Regions translated ahead: the JIT records the entries it translated at a miss (with the x87 mode it assumed); a
// later run given that list translates them before executing anything (Jit.prewarm) and then runs without a miss,
// with the interpreter's results. A prewarm of an address without memory, or already translated, does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

// the loop of jit-fpu-mode-guard.test.js: x87 code with mode switches, a local call, a conditional branch
const CODE_HEX = 'b914000000d906d84e04d99f00020000f7c1010000007404d92beb03d96b02d94608d8760cdd1ccfe8040000004975d5f4d97b08d96b04d94610db9c8f00010000d96b08c3';
const CODE = 0x20000000, DATA = 0x10000000, OUT = 0x10001000, CW = 0x10002000;
const bytes = Uint8Array.from(CODE_HEX.match(/../g).map((h) => parseInt(h, 16)));

function setup() {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  [1.1, 3.3, 1.0, 3.0, 2.7].forEach((v, i) => mem.writeF32(DATA + 4 * i, v));
  mem.write16(CW, 0x027f); mem.write16(CW + 2, 0x007f); mem.write16(CW + 4, 0x0c7f);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.ebx = CW; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x007f);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  return { mem, cpu, jit };
}
const runAll = (jit) => { let r, n = 0; do r = jit.run({ maxInsns: 1e6 }); while (r === EXIT.TIMESLICE && ++n < 1e4); return r; };

test('regions learned by one run are translated ahead by the next: no miss, same results', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  assert.ok(a.jit.learned.length >= 1);
  assert.equal(a.jit.learned.length, a.jit.stats.misses, 'one entry per miss');
  assert.ok(a.jit.learned.some(([, fpc]) => fpc === 0), 'the x87 mode assumed (24-bit) is kept');

  const b = setup();
  for (const [eip, fpc] of a.jit.learned) assert.equal(b.jit.prewarm(eip, fpc), true);
  assert.equal(b.jit.prewarm(a.jit.learned[0][0], a.jit.learned[0][1]), false, 'already translated');
  assert.equal(b.jit.prewarm(0x7000, null), false, 'no memory there');
  assert.equal(b.jit.stats.prewarmed, a.jit.learned.length);
  assert.equal(runAll(b.jit), EXIT.HALT);
  assert.equal(b.jit.stats.misses, 0, 'every region was ready');
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(a.mem.bytes(OUT, 0x300)).toString('hex'));
});

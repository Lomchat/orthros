#!/usr/bin/env node
// Tight integer loop microbenchmark: a strlen byte loop (movzx / inc / test / jnz) over a 4 KB string, repeated;
// ns per inner iteration under the JIT. With `node --no-liftoff --print-wasm-code` it shows V8's code for the loop.
// Usage: node tools/loop-bench.mjs [repetitions]
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, LEN = 4095;
const REPS = +(process.argv[2] ?? 4000);
// outer: xor ecx, ecx ; L: movzx edx, byte [esi+ecx] ; inc ecx ; test dl, dl ; jne L ; dec edi ; jne outer ; hlt
const code = Uint8Array.from([0x31, 0xc9, 0x0f, 0xb6, 0x14, 0x0e, 0x41, 0x84, 0xd2, 0x75, 0xf7, 0x4f, 0x75, 0xf2, 0xf4]);
let best = Infinity;
for (let rep = 0; rep < 5; rep++) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, code);
  mem.fill(DATA, LEN, 0x61); mem.write8(DATA + LEN, 0);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.esi = DATA; cpu.edi = REPS; cpu.eflags = F.RESERVED1 | F.IF;
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  const end = CODE + code.length - 1;
  const t0 = performance.now();
  let r; do r = jit.run({ stopAt: end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  best = Math.min(best, performance.now() - t0);
  if (r !== EXIT.HALT) throw new Error('exit ' + r);
}
console.log(`strlen loop: ${(best * 1e6 / (REPS * (LEN + 1))).toFixed(2)} ns per byte (4 instructions)`);

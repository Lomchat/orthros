#!/usr/bin/env node
// Lazy-flags microbenchmark: ns per iteration of small integer loops whose blocks read flags set by another block
// (the lazy flag state is unknown at a block entry: a DEC/INC at the head of a block must keep the CF of whatever
// came before, a JCC right after another JCC tests the flags of the previous block's CMP), next to equivalent
// loops where every flag read is resolved within its block. Shows the cost of the run-time dispatch on the lazy op
// (Emitter.pushCondDynamic) and of the flags helper calls it may contain.
// Usage: node tools/flags-bench.mjs [iterations] [--runs 7]
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const args = process.argv.slice(2);
const N = +(args.find((a) => !a.startsWith('--')) ?? 2e7);
const runsArg = args.indexOf('--runs');
const RUNS = runsArg >= 0 ? +args[runsArg + 1] : 7;
const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));

// every case: ecx = N iterations, eax = 0, edx = 0x7fffffff, esi -> a data page (dwords 1, 0 ; at +64: 0..9, 0..5); ends on HLT
const CASES = [
  // L: dec ecx ; jnz L ; hlt                          (the block starts with DEC: CF of the previous block's DEC)
  ['dec at block head', '49 75fd f4'],
  // L: sub ecx, 1 ; jnz L ; hlt                       (reference: nothing to preserve)
  ['  ref: sub ecx, 1', '83e901 75fb f4'],
  // L: add eax, 1 ; cmp eax, edx ; je X ; jb Y ; Y: sub ecx, 1 ; jnz L ; hlt ; X: hlt   (JB alone in its block)
  ['jcc after jcc', '83c001 39d0 7408 7200 83e901 75f2 f4 f4'],
  // same, the JB's block recomputing its CMP (reference: the condition from a known lazy op)
  ['  ref: cmp in the block', '83c001 39d0 740a 39d0 7200 83e901 75f0 f4 f4'],
  // L: mov ebx, [esi] ; add ebx, eax ; test ebx, ebx ; je X ; inc dword [esi+4] ; jb Y ; Y: dec ecx ; jnz L ; hlt ; X: hlt
  // (a mixed region: memory INC, a JB after a JCC, a DEC at a block head)
  ['mixed', '8b1e 01c3 85db 740a ff4604 7200 49 75f1 f4 f4'],
  // L: mov edx, ecx ; and edx, 15 ; mov eax, [esi+edx*4+64] ; cmp eax, 5 ; je E ; jl S ; add ebx, eax ; jmp N ;
  // S: sub ebx, eax ; jmp N ; E: inc ebx ; N: dec ecx ; jnz L ; hlt     (a 3-way compare on table values 0..9: the JL
  // after the JE; the DEC at the join of three blocks leaving different lazy ops: not predicted)
  ['3-way compare', '89ca 83e20f 8b449640 83f805 740a 7c04 01c3 eb05 29c3 eb01 43 49 75e4 f4'],
];

async function once(bytes) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.esi = DATA; cpu.ecx = N; cpu.eax = 0; cpu.edx = 0x7fffffff;
  cpu.eflags = F.RESERVED1 | F.IF;
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  const end = CODE + bytes.length - 1;
  let r;
  const reset = () => { cpu.eip = CODE; cpu.ecx = N; cpu.eax = 0; mem.fill(DATA, 4096, 0); mem.write32(DATA, 1); for (let k = 0; k < 16; k++) mem.write32(DATA + 64 + 4 * k, k % 10); };
  reset();
  do r = jit.run({ stopAt: end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE); // warm-up: translation, then
  await new Promise((res) => setTimeout(res, 100)); // V8's background tier-up of the region to optimized code
  reset();
  const t0 = performance.now();
  do r = jit.run({ stopAt: end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error('exit ' + r);
  if (cpu.ecx !== 0) throw new Error('did not run to the end');
  return (ms * 1e6) / N;
}

// one discarded round first: the first translations of a process run slower (V8 still optimizing the JS dispatcher
// and translator), which otherwise lands on the first case
for (const [, h] of CASES) await once(hex(h));
for (const [name, h] of CASES) {
  const bytes = hex(h);
  const t = [];
  for (let k = 0; k < RUNS; k++) t.push(await once(bytes));
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(26)} ${t[t.length >> 1].toFixed(3)} ns/iter (median of ${RUNS}; min ${t[0].toFixed(3)}, max ${t[t.length - 1].toFixed(3)})`);
}

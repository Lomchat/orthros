#!/usr/bin/env node
// Boot hot-loop microbenchmark: the shape of the loop that dominated half of BFME2's single-threaded startup in the
// profiler's region listings (harness --profile-wasm / jitlist, block counts): an in-place heapsort of 32-bit integers
// (compiler-generated sift-down, 1-based indexing off a base register, the child comparison and the swap in separate
// blocks, the swap's two stores, the outer loop swapping the root out), called on many arrays in a row. Written from
// the listing's instruction shapes, assembled here (no game code): ns per sorted element and per inner iteration.
// Usage: node tools/hotloop-bench.mjs [arrays] [n] [--interp]   (with `node --no-liftoff --print-wasm-code`: V8's code)
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

// f (ecx = n, eax = array - 4, [esp+4] = 0): heapsort; drv: `push 0 ; mov ecx, edi ; call f ; add esp, 4 ; add eax, ebx ;
// dec esi ; jne drv ; hlt` — esi arrays of edi elements, ebx bytes apart
export const HEAPSORT = '51535589cb89ddd1ed85ed565776508d4c2d00894c2410395c241089ea7730908d0c1239d9730a8b34883b7488047d01418b34908b3c8839fe7d0a893488893c9089caeb038d53018d0c1239d976d18b5424104d83ea0285ed8954241077b885db764f8b6c241801ed8d242439dd8b542418772f8d0c1239d9730a8b34883b7488047d01418b34908b3c8839fe7d0a893488893c9089caeb038d53018d0c1239d976d14b8b5498048b088910894c980475ba5f5e5d5b59c36a0089f9e8' + '41ffffff' + '83c40401d84e75eff4ebfe'; // (a jmp-to-self after the hlt: the region does not decode on into zeros)
export const DRIVER = 0xb8;

const CODE = 0x20000000, DATA = 0x10000000;
const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--jit-opts');
const ARRAYS = +(pos[0] ?? 40), N = +(pos[1] ?? 8192);
const interp = process.argv.includes('--interp');
const jitOpts = process.argv.includes('--jit-opts') ? JSON.parse(process.argv[process.argv.indexOf('--jit-opts') + 1]) : {}; // (A/B: e.g. {"deadExitFlags":false})
const code = Uint8Array.from(HEAPSORT.match(/../g).map((h) => parseInt(h, 16)));
// the call's rel32: from the end of the call (DRIVER + 9) back to f
new DataView(code.buffer).setInt32(DRIVER + 5, -(DRIVER + 9), true);

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
const results = [];
let sum = 0;
for (let rep = 0; rep < (interp ? 1 : 7); rep++) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, code);
  seed = 12345;
  for (let i = 0; i < ARRAYS * N; i++) mem.write32(DATA + 4 * i, rnd() % 1000000);
  cpu.eip = CODE + DRIVER; cpu.esp = 0x0f000000; cpu.eax = DATA - 4; cpu.ebx = 4 * N; cpu.esi = ARRAYS; cpu.edi = N;
  cpu.eflags = F.RESERVED1 | F.IF;
  const i = new Interp(mem, cpu);
  const jit = new Jit(mem, i, { smc: true, ...jitOpts }); jit.cpu = cpu;
  const end = CODE + code.length - 3;
  const t0 = performance.now();
  let r;
  if (interp) { do r = i.run({ stopAt: end, maxInsns: 1e7 }); while (r === EXIT.TIMESLICE); }
  else { do r = jit.run({ stopAt: end, maxInsns: 100000 }); while (r === EXIT.TIMESLICE); } // (time slices as the VM runs them: V8 swaps in the optimized code of a region at its next entry, never inside a running loop)
  results.push(performance.now() - t0);
  if (r !== EXIT.HALT && cpu.eip !== end) throw new Error('exit ' + r);
  // (the listing's routine orders from its own base and argument: a checksum of the result, compare with --interp)
  let h = 0; for (let k = 0; k < ARRAYS * N; k++) h = (Math.imul(h, 31) + mem.read32(DATA + 4 * k)) | 0;
  sum = h;
}
results.sort((a, b) => a - b);
const med = results[results.length >> 1];
console.log(`heapsort ${ARRAYS} x ${N}: median ${med.toFixed(1)} ms (min ${results[0].toFixed(1)}, max ${results[results.length - 1].toFixed(1)}), ${(med * 1e6 / (ARRAYS * N)).toFixed(1)} ns per element; result checksum ${(sum >>> 0).toString(16)}`);

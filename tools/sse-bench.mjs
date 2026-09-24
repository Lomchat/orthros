#!/usr/bin/env node
// SSE2 microbenchmark: ns per instruction of a straight-line scalar/packed double kernel (the shape of the SSE2
// math routines of C runtimes: table constants, mulsd/addsd chains, pshufd/unpcklpd, movlpd to memory), looped.
// Usage: node tools/sse-bench.mjs [iterations]
//
// Kernel (written for this benchmark, assembled with clang-18 --target=i686-pc-windows-msvc):
//   L: addsd xmm4,xmm0 ; movsd xmm0,xmm3 ; addsd xmm3,[ebx] ; mulpd xmm2,xmm7 ; subsd xmm3,[ebx] ; mulpd xmm7,xmm7
//      subsd xmm0,xmm3 ; movapd xmm3,[ebx+16] ; movapd xmm6,[ebx+32] ; mulpd xmm1,xmm7 ; addpd xmm2,xmm1
//      pshufd xmm1,xmm2,0xee ; mulsd xmm2,xmm7 ; xorpd xmm7,xmm7 ; mov edx,0x3f80 ; addsd xmm2,xmm1
//      pinsrw xmm7,edx,3 ; addsd xmm2,xmm4 ; movlpd xmm4,[ebx+48] ; movd xmm1,ecx ; mulsd xmm2,[esp+12]
//      mulsd xmm0,xmm7 ; psllq xmm1,45 ; pshufd xmm1,xmm1,0x44 ; movapd xmm7,[ebx+64] ; addsd xmm5,xmm2
//      mulpd xmm3,xmm1 ; addsd xmm0,xmm5 ; unpcklpd xmm0,xmm0 ; mulpd xmm6,xmm0 ; mulsd xmm4,xmm0 ; mulpd xmm0,xmm0
//      addpd xmm7,xmm6 ; mulpd xmm7,xmm0 ; mulsd xmm0,xmm3 ; pshufd xmm6,xmm7,0xee ; mulsd xmm0,xmm7
//      pshufd xmm5,xmm3,0xee ; mulsd xmm6,xmm3 ; mulsd xmm4,xmm3 ; addsd xmm0,xmm5 ; addsd xmm0,xmm6
//      addsd xmm0,xmm4 ; addsd xmm0,xmm3 ; movlpd [esp+4],xmm0 ; xorpd xmm0,xmm0 ; xorpd xmm4,xmm4
//      xorpd xmm5,xmm5 ; dec ecx ; jnz L ; hlt
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const KERNEL = 'f20f58e0f20f10c3f20f581b660f59d7f20f5c1b660f59fff20f5cc3660f285b10660f287320660f59cf660f58d1660f70caeef20f59d7660f57ffba803f0000f20f58d1660fc4fa03f20f58d4660f126330660f6ec9f20f5954240cf20f59c7660f73f12d660f70c944660f287b40f20f58ea660f59d9f20f58c5660f14c0660f59f0f20f59e0660f59c0660f58fe660f59f8f20f59c3660f70f7eef20f59c7660f70ebeef20f59f3f20f59e3f20f58c5f20f58c6f20f58c4f20f58c3660f13442404660f57c0660f57e4660f57ed490f852afffffff4';
const INSNS = 50; // per iteration
const CODE = 0x20000000, DATA = 0x10000000;
const N = +(process.argv[2] ?? 2e6);
const bytes = Uint8Array.from(KERNEL.match(/../g).map((h) => parseInt(h, 16)));

let best = Infinity;
for (let rep = 0; rep < 5; rep++) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  for (let i = 0; i < 10; i++) mem.writeF64(DATA + 8 * i, 1 + i / 16); // table constants
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.ebx = DATA; cpu.ecx = N; cpu.eflags = F.RESERVED1 | F.IF;
  mem.writeF64(cpu.esp + 12, 0.5);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  const t0 = performance.now();
  let r;
  do r = jit.run({ maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error(`exit ${r}`);
  best = Math.min(best, ms);
}
console.log(`sse2 kernel: ${(best * 1e6 / N).toFixed(1)} ns per iteration, ${(best * 1e6 / N / INSNS).toFixed(2)} ns per instruction`);

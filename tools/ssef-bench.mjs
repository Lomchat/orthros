#!/usr/bin/env node
// SSE scalar single-precision microbenchmark: ns per instruction of a looped kernel with the shape of compiled 3D
// UI / camera code (movss loads, mulss/addss/subss chains, cvtsi2ss / cvttss2si, comiss / ucomiss + jcc, mixed with
// integer mov / lea / push / pop), 29 instructions per iteration, 3 blocks (a jbe that falls through, a jae taken).
// Two runs: `clean` (lanes 1-3 of every xmm register zero, as after movss loads) and `dirty` (lanes 1-3 of xmm0 —
// only ever written by cvtsi2ss, which preserves them — hold denormals, as when a register last carried integer
// data): any translation that computes the scalar ops on the whole vector then pays the host's denormal assists.
// Usage: node tools/ssef-bench.mjs [iterations]
//
// Kernel (written for this benchmark, assembled with clang-18 --target=i686-pc-windows-msvc):
//   L: mov eax,[ebx+36] ; cvtsi2ss xmm0,eax ; movss xmm1,[ebx+8] ; mulss xmm1,xmm0 ; movss xmm2,[ebx+12]
//      mulss xmm2,xmm0 ; subss xmm1,[ebx+16] ; addss xmm2,xmm1 ; movss xmm3,xmm2 ; mulss xmm3,xmm3
//      lea edx,[esi+8] ; push edx ; movss xmm4,[ebx+20] ; comiss xmm3,xmm4 ; jbe 1f ; movss xmm3,xmm4
//   1: movss [esp],xmm3 ; pop edx ; cvttss2si eax,xmm2 ; mov [ebx+24],eax ; movss xmm5,[ebx+28] ; subss xmm5,xmm2
//      mulss xmm5,xmm1 ; addss xmm5,xmm3 ; ucomiss xmm5,xmm0 ; jae 2f ; subss xmm5,xmm0
//   2: movss [ebx+32],xmm5 ; sub ecx,1 ; jnz L ; hlt
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const KERNEL = '8b4324f30f2ac0f30f104b08f30f59c8f30f10530cf30f59d0f30f5c4b10f30f58d1f30f10daf30f59db8d560852f30f1063140f2fdc7604f30f10dcf30f111c245af30f2cc2894318f30f106b1cf30f5ceaf30f59e9f30f58eb0f2ee87304f30f5ce8f30f116b2083e9017593f4';
const INSNS = 29; // per iteration (the subss after the jae is skipped)
const CODE = 0x20000000, DATA = 0x10000000;
const N = +(process.argv[2] ?? 5e6);
const bytes = Uint8Array.from(KERNEL.match(/../g).map((h) => parseInt(h, 16)));

function run(dirty) {
  let best = Infinity;
  const times = [];
  for (let rep = 0; rep < 7; rep++) {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    mem.writeBytes(CODE, bytes);
    mem.write32(DATA + 36, 3);
    mem.writeF32(DATA + 8, 1.5); mem.writeF32(DATA + 12, 0.25); mem.writeF32(DATA + 16, 0.5);
    mem.writeF32(DATA + 20, 2); mem.writeF32(DATA + 28, 10);
    if (dirty) for (let k = 1; k < 4; k++) mem.write32(cpu.xmmAddr(0) + 4 * k, k); // denormals 1e-45..4e-45
    cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.ebx = DATA; cpu.esi = DATA; cpu.ecx = N; cpu.eflags = F.RESERVED1 | F.IF;
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
    jit.cpu = cpu;
    const t0 = performance.now();
    let r;
    do r = jit.run({ maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
    const ms = performance.now() - t0;
    if (r !== EXIT.HALT) throw new Error(`exit ${r}`);
    if (mem.readF32(DATA + 32) !== 23 || mem.read32(DATA + 24) !== 4) throw new Error('wrong result');
    times.push(ms); best = Math.min(best, ms);
  }
  times.sort((a, b) => a - b);
  const ns = (ms) => (ms * 1e6 / N / INSNS).toFixed(2);
  console.log(`ssef kernel (${dirty ? 'dirty' : 'clean'} upper lanes): ${ns(times[3])} ns per instruction median, ${ns(best)} best, ${ns(times[6])} worst (${(times[3] * 1e6 / N).toFixed(1)} ns per iteration)`);
}
run(false);
run(true);

#!/usr/bin/env node
// C-runtime SSE2 transcendental microbenchmark: ns per evaluated element of two synthetic kernels written in the
// style of the SSE2 paths of C-runtime math routines (argument classification on the high word of the double,
// range reduction with table lookups, SSE2 polynomial; written for this benchmark, not taken from any program),
// each looped over a 64-element input array. The result of every run is checked bit for bit against the
// reference interpreter's.
//   sin: x87 argument (fld m64) spilled with fstp m64 / movlpd, FNSTCW precision check, pextrw exponent tests +
//        jcc, round(x*2/pi) with the 1.5*2^52 shifter (movd of the low dword), Cody-Waite reduction (mulsd/subsd),
//        quadrant sign-mask table (movapd [ebx+eax+128]), packed sin/cos polynomial (unpcklpd, mulpd/addpd, pshufd),
//        quadrant select, xorpd sign, result back through movlpd m64 / fld m64 / fstp m64. 64 insns per element.
//   log: movlpd load, pextrw + cmp/test classification, psrlq/movd exponent, mantissa bits -> 128-entry table
//        index, andpd/orpd mantissa, cvtsi2sd, scalar mulsd/addsd polynomial, comisd + jb, movlpd store.
//        40 insns per element.
//   sinsse, sinbal: controls for `sin` — sinsse without the x87 glue (movlpd loads/stores instead, no fnstcw),
//        sinbal with each fld paired with its fstp in the same block (no x87 value alive across a branch).
// Usage: node --no-liftoff tools/crtmath-bench.mjs [passes] [sin|sinsse|sinbal|log]   (passes over the 64-element
// array, default 100000; every timed run follows a short warm-up and a pause for V8's tier-up, but under load the
// optimizing compile can still land late: --no-liftoff measures the optimized code only)
//
// Kernels (assembled with llvm-mc-18 -triple=i686-pc-windows-msvc; ebx = data, ebp = passes):
// sin: outer: lea esi,[ebx+1024] ; lea edi,[ebx+2048] ; mov ecx,64
//   L: fld qword [esi] ; fnstcw [esp+16] ; movzx eax,word [esp+16] ; and eax,0x300 ; cmp eax,0x200 ; jne Lcw
//   Lcw: fstp qword [esp+4] ; movlpd xmm0,[esp+4] ; pextrw eax,xmm0,3 ; and eax,0x7fff ; cmp eax,0x3e40 ; jb Ltiny
//      cmp eax,0x4090 ; jae Ltiny ; movapd xmm1,xmm0 ; mulsd xmm1,[ebx] ; addsd xmm1,[ebx+8] ; movd edx,xmm1
//      subsd xmm1,[ebx+8] ; movapd xmm2,xmm1 ; mulsd xmm1,[ebx+16] ; mulsd xmm2,[ebx+24] ; subsd xmm0,xmm1
//      subsd xmm0,xmm2 ; and edx,3 ; mov eax,edx ; shl eax,4 ; movapd xmm3,[ebx+eax+128] ; movapd xmm4,xmm0
//      unpcklpd xmm4,xmm4 ; mulpd xmm4,xmm4 ; movapd xmm5,[ebx+32] ; mulpd xmm5,xmm4 ; addpd xmm5,[ebx+48]
//      mulpd xmm5,xmm4 ; addpd xmm5,[ebx+64] ; mulpd xmm5,xmm4 ; pshufd xmm6,xmm5,0xee ; mulsd xmm5,xmm0
//      addsd xmm5,xmm0 ; addsd xmm6,[ebx+80] ; test edx,1 ; jz Lnoswap ; movapd xmm5,xmm6
//   Lnoswap: xorpd xmm5,xmm3 ; movlpd [esp+4],xmm5 ; fld qword [esp+4] ; jmp Lstore
//   Ltiny: fld qword [esp+4]
//   Lstore: fstp qword [edi] ; add esi,8 ; add edi,8 ; dec ecx ; jnz L ; dec ebp ; jnz outer ; hlt
// log: outer: (same) ; L: movlpd xmm0,[esi] ; pextrw edx,xmm0,3 ; cmp edx,0x7ff0 ; jae Lspecial ; test edx,0x7ff0
//      jz Lspecial ; movapd xmm1,xmm0 ; psrlq xmm1,52 ; movd eax,xmm1 ; sub eax,1023 ; and edx,0xfe0 ; shr edx,1
//      andpd xmm0,[ebx+32] ; orpd xmm0,[ebx+48] ; mulsd xmm0,[ebx+edx+4096] ; subsd xmm0,[ebx+48]
//      cvtsi2sd xmm2,eax ; mulsd xmm2,[ebx] ; addsd xmm2,[ebx+edx+4104] ; movapd xmm3,xmm0 ; mulsd xmm3,xmm3
//      movsd xmm4,[ebx+8] ; mulsd xmm4,xmm0 ; addsd xmm4,[ebx+16] ; mulsd xmm4,xmm0 ; addsd xmm4,[ebx+24]
//      mulsd xmm4,xmm3 ; addsd xmm4,xmm0 ; addsd xmm4,xmm2 ; comisd xmm4,[ebx+64] ; jb Lneg ; addsd xmm7,xmm4
//   Lneg: movlpd [edi],xmm4 ; jmp Lnext
//   Lspecial: movlpd [edi],xmm0
//   Lnext: add esi,8 ; add edi,8 ; dec ecx ; jnz L ; dec ebp ; jnz outer ; movlpd [ebx+72],xmm7 ; hlt
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

export const KERNELS = {
  sin: '8db3000400008dbb00080000b940000000dd06d97c24100fb744241025000300003d000200007500dd5c2404660f12442404660fc5c00325ff7f00003d403e00000f829d0000003d904000000f8392000000660f28c8f20f590bf20f584b08660f7ecaf20f5c4b08660f28d1f20f594b10f20f595318f20f5cc1f20f5cc283e20389d0c1e004660f289c0380000000660f28e0660f14e4660f59e4660f286b20660f59ec660f586b30660f59ec660f586b40660f59ec660f70f5eef20f59e8f20f58e8f20f587350f7c2010000007404660f28ee660f57eb660f136c2404dd442404eb04dd442404dd1f83c60883c708490f851affffff4d0f8502fffffff4',
  sinsse: '8db3000400008dbb00080000b940000000660f1206660f1344240425000300003d00020000750090660f12442404660fc5c00325ff7f00003d403e00000f829f0000003d904000000f8394000000660f28c8f20f590bf20f584b08660f7ecaf20f5c4b08660f28d1f20f594b10f20f595318f20f5cc1f20f5cc283e20389d0c1e004660f289c0380000000660f28e0660f14e4660f59e4660f286b20660f59ec660f586b30660f59ec660f586b40660f59ec660f70f5eef20f59e8f20f58e8f20f587350f7c2010000007404660f28ee660f57eb660f136c2404660f126c2404eb06660f126c2404660f132f83c60883c708490f8518ffffff4d0f8500fffffff4',
  sinbal: '8db3000400008dbb00080000b940000000dd06dd5c2404d97c24100fb744241025000300003d000200007500660f12442404660fc5c00325ff7f00003d403e00000f829f0000003d904000000f8394000000660f28c8f20f590bf20f584b08660f7ecaf20f5c4b08660f28d1f20f594b10f20f595318f20f5cc1f20f5cc283e20389d0c1e004660f289c0380000000660f28e0660f14e4660f59e4660f286b20660f59ec660f586b30660f59ec660f586b40660f59ec660f70f5eef20f59e8f20f58e8f20f587350f7c2010000007404660f28ee660f57eb660f136c2404dd442404dd1feb06dd442404dd1f83c60883c708490f8518ffffff4d0f8500fffffff4',
  log: '8db3000400008dbb00080000b940000000660f1206660fc5d00381faf07f00000f8387000000f7c2f07f0000747f660f28c8660f73d134660f7ec82dff03000081e2e00f0000d1ea660f544320660f564330f20f59841300100000f20f5c4330f20f2ad0f20f5913f20f58941308100000660f28d8f20f59dbf20f106308f20f59e0f20f586310f20f59e0f20f586318f20f59e3f20f58e0f20f58e2660f2f63407204f20f58fc660f1327eb04660f130783c60883c708490f8553ffffff4d0f853bffffff660f137b48f4',
};
const CODE = 0x20000000, DATA = 0x10000000;
const REPS = 9;

/** Guest memory, CPU and data of kernel `name` for `passes` passes over the inputs. */
export function setupKernel(name, passes) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(KERNELS[name].match(/../g).map((h) => parseInt(h, 16))));
  const w64 = (a, v) => mem.writeF64(DATA + a, v);
  const w64bits = (a, hi, lo = 0) => { mem.write32(DATA + a, lo); mem.write32(DATA + a + 4, hi); };
  if (name.startsWith('sin')) {
    w64(0, 2 / Math.PI); w64(8, 1.5 * 2 ** 52); w64(16, 1.5707963267341256); w64(24, 6.077100506506192e-11);
    w64(32, -1 / 5040); w64(40, -1 / 720); w64(48, 1 / 120); w64(56, 1 / 24); w64(64, -1 / 6); w64(72, -0.5); w64(80, 1);
    for (let q = 0; q < 4; q++) w64bits(128 + 16 * q, q >= 2 ? 0x80000000 : 0);
    for (let i = 0; i < 64; i++) w64(1024 + 8 * i, i % 16 === 7 ? 1e-9 * (i + 1) : (i - 31.5) * 0.37);
  } else {
    w64(0, Math.LN2); w64(8, -0.25); w64(16, 1 / 3); w64(24, -0.5); w64(64, 0);
    w64bits(32, 0x000fffff, 0xffffffff); w64bits(40, 0x000fffff, 0xffffffff); // mantissa mask (both lanes)
    w64(48, 1); w64(56, 1);
    for (let i = 0; i < 128; i++) { const c = 1 + (i + 0.5) / 128; w64(4096 + 16 * i, 1 / c); w64(4104 + 16 * i, Math.log(c)); }
    for (let i = 0; i < 64; i++) w64(1024 + 8 * i, i === 13 ? Infinity : i === 40 ? 0 : 0.01 + i * i * 0.731);
  }
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.ebx = DATA; cpu.ebp = passes; cpu.eflags = F.RESERVED1 | F.IF;
  return { mem, cpu };
}

/** Output bytes of a finished run: the result array (the same after any number of passes) and, with `all`, the data
 * block's scalars (the log kernel's accumulator depends on the pass count). */
export function resultOf(mem, all = true) { return Buffer.from(mem.bytes(DATA + (all ? 0 : 2048), all ? 2048 + 512 : 512)).toString('hex'); }

/**
 * Run kernel `name` for `passes` passes under the JIT. `warm`: a first short run translates the region, then V8 is
 * given time to tier it up to optimized code (its baseline compiler's code is what a short run would measure), and
 * the timed run starts over.
 */
async function runJit(name, passes, warm = true) {
  const { mem, cpu } = setupKernel(name, passes);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  let r;
  if (warm) {
    cpu.ebp = 200;
    do r = jit.run({ maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
    await new Promise((res) => setTimeout(res, 150));
    cpu.eip = CODE; cpu.ebp = passes;
  }
  const t0 = performance.now();
  do r = jit.run({ maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error(`exit ${r}`);
  return { ms, out: resultOf(mem, passes <= 2) };
}

function runInterp(name, passes) {
  const { mem, cpu } = setupKernel(name, passes);
  const I = new Interp(mem, cpu);
  let r;
  do r = I.run({ maxInsns: 1e8 }); while (r === EXIT.TIMESLICE);
  if (r !== EXIT.HALT) throw new Error(`interp exit ${r}`);
  return resultOf(mem);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const passes = +(process.argv[2] ?? 100000);
  const which = process.argv[3] ? [process.argv[3]] : Object.keys(KERNELS);
  for (const name of which) {
    // (the interpreter runs ~5 MIPS: it checks a 2-pass run in full, the timed runs are checked on the result array)
    const full = runInterp(name, 2);
    if ((await runJit(name, 2, false)).out !== full) throw new Error(`${name}: JIT result differs from the interpreter`);
    const ref = full.slice(2 * 2048);
    const times = [];
    for (let rep = 0; rep < REPS; rep++) {
      const { ms, out } = await runJit(name, passes);
      if (out !== ref) throw new Error(`${name}: JIT result differs from the interpreter`);
      times.push(ms);
    }
    times.sort((a, b) => a - b);
    const ns = (ms) => (ms * 1e6 / passes / 64).toFixed(2);
    console.log(`crtmath ${name}: ${ns(times[REPS >> 1])} ns per element median of ${REPS}, ${ns(times[0])} best, ${ns(times[REPS - 1])} worst`);
  }
}

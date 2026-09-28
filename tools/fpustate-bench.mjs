#!/usr/bin/env node
// x87 state / extended-precision microbenchmark: ns per loop iteration of the instructions that used to leave
// translated code for the interpreter (FLD/FSTP m80, FNSAVE/FRSTOR, FNSTENV/FLDENV), alone and inside the shape of a
// C-runtime math routine that saves the x87 state around SSE2 double code. Median and spread of 7 runs.
// Usage: node tools/fpustate-bench.mjs [iterations] [--root <dir holding src/>] (--root: measure another checkout,
// e.g. `git archive HEAD~1 src | tar -x -C /tmp/base` for a before/after in the same session)
//
// Kernels (hand-assembled, ebx = data, ecx = iterations):
//   m80:        L: fld tbyte [ebx+0x200] ; fstp tbyte [ebx+0x210] ; dec ecx ; jnz L
//   save:       L: fnsave [ebx+0x100] ; frstor [ebx+0x100] ; dec ecx ; jnz L
//   env:        L: fnstenv [ebx+0x100] ; fldenv [ebx+0x100] ; dec ecx ; jnz L
//   crt:        L: fnsave [ebx+0x100] ; movsd xmm0,[ebx] ; mulsd xmm0,[ebx+8] ; addsd xmm0,[ebx+16] ;
//                  movsd [ebx+0x80],xmm0 ; frstor [ebx+0x100] ; fld tbyte [ebx+0x200] ; fstp st0 ; dec ecx ; jnz L
//   (baseline)  L: fld qword [ebx+0x200] ; fstp st0 ; dec ecx ; jnz L
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const root = ri >= 0 ? path.resolve(args.splice(ri, 2)[1]) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { GuestMemory } = await imp('src/cpu/memory.js');
const { CpuState, THREAD_STATES_BASE, EXIT, F } = await imp('src/cpu/state.js');
const { Interp } = await imp('src/cpu/interp.js');
const { writeF80 } = await imp('src/cpu/interp-x87.js');
await imp('src/cpu/interp-sse.js');
const { Jit } = await imp('src/cpu/jit/jit.js');

const KERNELS = {
  m80: ['DBAB00020000 DBBB10020000 49 75F1', 1e7],
  save: ['DDB300010000 DDA300010000 49 75F1', 3e6],
  env: ['D9B300010000 D9A300010000 49 75F1', 3e6],
  crt: ['DDB300010000 F20F1003 F20F594308 F20F584310 F20F118380000000 DDA300010000 DBAB00020000 DDD8 49 75D3', 3e6],
  baseline: ['DD8300020000 DDD8 49 75F5', 1e7],
};
const CODE = 0x20000000, DATA = 0x10000000;
const scale = args[0] ? +args[0] : 1;

for (const [name, [hex, n0]] of Object.entries(KERNELS)) {
  const N = Math.round(n0 * scale);
  const bytes = Uint8Array.from((hex.replace(/\s+/g, '') + 'F4').match(/../g).map((h) => parseInt(h, 16)));
  const all = [];
  for (let rep = 0; rep < 7; rep++) {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    mem.writeBytes(CODE, bytes);
    for (let i = 0; i < 16; i++) mem.writeF64(DATA + 8 * i, 1 + i / 16);
    writeF80(mem, DATA + 0x200, 1.2345); // (normal extended values: the conversion's common path)
    cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.ebx = DATA; cpu.ecx = N; cpu.eflags = F.RESERVED1 | F.IF;
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
    jit.cpu = cpu;
    const t0 = performance.now();
    let r;
    do r = jit.run({ maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
    const ms = performance.now() - t0;
    if (r !== EXIT.HALT) throw new Error(`${name}: exit ${r}`);
    all.push(ms * 1e6 / N);
  }
  all.sort((a, b) => a - b);
  console.log(`${name.padEnd(9)} median ${all[3].toFixed(1).padStart(7)} ns/iter  (min ${all[0].toFixed(1)}, max ${all[6].toFixed(1)})`);
}

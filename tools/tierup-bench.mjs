#!/usr/bin/env node
// When does V8 run a region's optimized code? A small loop kernel entered over and over for a short run each time (as
// game code is in play: thousands of regions, each run for a few hundred instructions per frame), its time per guest
// instruction printed as the entries accumulate. V8 compiles a function with its baseline compiler (Liftoff) first
// and with TurboFan once it has used a tiering budget (--wasm-tiering-budget, ~13 MB of "bytes executed"); a region
// run briefly per entry may stay in the baseline tier for a long time.
//   node [--wasm-tiering-budget=N] tools/tierup-bench.mjs [iterations per entry] [entries] [--opts json]
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const args = process.argv.slice(2).filter((a, i, l) => !a.startsWith('--') && l[i - 1] !== '--opts');
const optsI = process.argv.indexOf('--opts');
const opts = optsI >= 0 ? JSON.parse(process.argv[optsI + 1]) : {};
const ITER = Number(args[0] ?? 20), ENTRIES = Number(args[1] ?? 200000);
const CODE = 0x20000000, STACK = 0x11000000;
// xor ecx, ecx ; L: mov eax, ecx ; and eax, 7 ; cmp eax, 3 ; jne s1 ; inc ebx ; s1: cmp eax, 5 ; jb s2 ; add edx, eax ;
// s2: inc ecx ; cmp ecx, ITER ; jb L ; hlt ; ret
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const code = Uint8Array.from([0x31, 0xc9, 0x89, 0xc8, 0x83, 0xe0, 0x07, 0x83, 0xf8, 0x03, 0x75, 0x01, 0x43, 0x83, 0xf8, 0x05, 0x72, 0x02, 0x01, 0xc2,
  0x41, 0x81, 0xf9, ...le(ITER), 0x72, 0xe4, 0xf4, 0xc3]);
const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
cpu.reset(); mem.writeBytes(CODE, code);
const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...opts }); jit.cpu = cpu;
const end = CODE + code.length - 2;
let insns = 0, t0 = performance.now(), mark = 1000;
const tStart = t0;
for (let e = 1; e <= ENTRIES; e++) {
  cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
  let r; do { r = jit.run({ stopAt: end, maxInsns: 1e9 }); insns += 1e9 - jit.remaining(); } while (r === EXIT.TIMESLICE);
  if (r !== EXIT.HALT) throw new Error('exit ' + r);
  if (e === mark) {
    const t = performance.now();
    console.log(`entries ${String(e).padStart(7)}: ${((t - t0) * 1e6 / insns).toFixed(2)} ns per guest instruction (${((t - tStart) / 1000).toFixed(2)} s since start)`);
    t0 = t; insns = 0; mark *= 2;
  }
}

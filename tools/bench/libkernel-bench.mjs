#!/usr/bin/env node
// Library kernels (src/cpu/jit/libkernels.js) one call at a time: a guest loop calls a C-runtime function of msvcr71.dll
// through a function-pointer slot (as a game calls an import: `call [slot]`), with the kernels on and off, alternated;
// prints ns per call of each and the difference. Arguments typical of play: floor / ceil / fabs of a varying value,
// memcmp of 16 equal bytes, memcpy of 64 aligned bytes.
// Usage: node --no-liftoff tools/bench/libkernel-bench.mjs <msvcr71.dll> [calls per run, default 2000000] [rounds, default 3]
import './node-wasm-flags.mjs';
import fs from 'node:fs';
import { GuestMemory } from '../../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE } from '../../src/cpu/state.js';
import { Interp } from '../../src/cpu/interp.js';
import '../../src/cpu/interp-x87.js';
import '../../src/cpu/interp-sse.js';
import { Jit } from '../../src/cpu/jit/jit.js';
import { PeImage, mapImage } from '../../src/loader/pe.js';

const [file, callsArg, roundsArg] = process.argv.slice(2);
if (!file) { console.error('usage: node --no-liftoff tools/bench/libkernel-bench.mjs <msvcr71.dll> [calls] [rounds]'); process.exit(2); }
const CALLS = Number(callsArg ?? 2e6), ROUNDS = Number(roundsArg ?? 3);
const img = new PeImage(new Uint8Array(fs.readFileSync(file)));
const CODE = 0x00500000, SLOT = 0x00600000, DATA = 0x00610000, HALT = 0x00500f00;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

/** the loop: mov ecx, CALLS ; L: push ecx ; <arguments> ; call [SLOT] ; <cleanup> ; pop ecx ; dec ecx ; jnz L ; jmp HALT */
function loop(fn) {
  const call = [0xff, 0x15, ...le(SLOT)];
  let body;
  if (fn === 'memcmp') body = [0x6a, 16, 0x68, ...le(DATA + 0x100), 0x68, ...le(DATA), ...call, 0x83, 0xc4, 12];
  else if (fn === 'memcpy') body = [0x6a, 64, 0x68, ...le(DATA + 0x100), 0x68, ...le(DATA + 0x200), ...call, 0x83, 0xc4, 12];
  // fld [x] ; fadd [step] ; fst [x] ; sub esp, 8 ; fstp [esp] ; call ; fstp st0 ; add esp, 8 (x varies by 0.25 per call)
  else body = [0xdd, 0x05, ...le(DATA + 0x300), 0xdc, 0x05, ...le(DATA + 0x308), 0xdd, 0x15, ...le(DATA + 0x300), 0x83, 0xec, 8, 0xdd, 0x1c, 0x24, ...call, 0xdd, 0xd8, 0x83, 0xc4, 8];
  const code = [0xb9, ...le(CALLS), 0x51, ...body, 0x59, 0x49];
  code.push(0x0f, 0x85, ...le(5 - (code.length + 6)));
  code.push(0xe9, ...le(HALT - (CODE + code.length + 5)));
  return code;
}
function run(fn, on) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE), I = new Interp(mem, cpu);
  const vmem = { isFree: () => true, reserve: (size, b) => b, commit() {}, protect() {} };
  const mod = mapImage(img, mem, vmem, { name: 'msvcr71.dll', path: file });
  mem.write32(mod.base + 0x4b300, 1); // (__sse2_available, as the C runtime's start-up leaves it on an SSE2 CPU)
  mem.writeBytes(CODE, loop(fn)); mem.write8(HALT, 0xf4); mem.write32(SLOT, mod.exports.get(fn)); // (hlt at the end)
  mem.writeF64(DATA + 0x300, -1000.1); mem.writeF64(DATA + 0x308, 0.25);
  const jit = new Jit(mem, I, { smc: true, libKernels: on }); jit.cpu = cpu;
  cpu.esp = 0x00400000; cpu.eip = CODE;
  const t0 = performance.now();
  for (let r; (r = jit.run({ stopAt: HALT, maxInsns: 2e9 })) !== 2;) if (r !== 3) throw new Error(`exit ${r} at ${cpu.eip.toString(16)}`);
  return { ns: ((performance.now() - t0) * 1e6) / CALLS, kernels: jit.libLive?.size ?? 0 };
}
for (const fn of ['floor', 'ceil', 'fabs', 'memcmp', 'memcpy']) {
  const on = [], off = [];
  for (let k = 0; k < ROUNDS; k++) { on.push(run(fn, true)); off.push(run(fn, false)); }
  const med = (l) => l.map((x) => x.ns).sort((a, b) => a - b)[l.length >> 1];
  console.log(`${fn.padEnd(7)} kernel ${med(on).toFixed(1)} ns per call [${on.map((x) => x.ns.toFixed(1)).join(' ')}] (${on[0].kernels} live), translated ${med(off).toFixed(1)} [${off.map((x) => x.ns.toFixed(1)).join(' ')}]: ${(med(off) - med(on)).toFixed(1)} ns saved per call`);
}

#!/usr/bin/env node
// Translated code listing: the WASM instructions the JIT emits for each guest instruction of a region, as a
// pseudo-WAT trace of the emitter calls (locals by name), with per-instruction counts and the block structure — to
// judge the code quality of common x86 patterns without a WASM disassembler (src/cpu/jit/listing.js; the page worker
// lists live regions of a running game the same way: harness input `jitlist:<hex eip>`).
// Usage: node tools/jit-dump.mjs <hex bytes | preset> [--cw 0x7f] [--quiet]
//   presets: prologue (frame setup, loads/stores, call, epilogue), xform (x87 float transform), loop (integer loop)
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST } from '../src/cpu/state.js';
import { listRegion } from '../src/cpu/jit/listing.js';
import '../src/cpu/jit/translate-x87.js'; // (the translators register their handlers on import, as jit.js does)
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';

const CODE = 0x20000000;
const PRESETS = {
  // push ebp ; mov ebp, esp ; sub esp, 16 ; push esi ; mov esi, [ebp+8] ; mov eax, [esi+4] ; test eax, eax ; jz L ;
  // mov ecx, [eax+0x10] ; add [esi+8], ecx ; L: mov eax, [ebp-4] ; pop esi ; mov esp, ebp ; pop ebp ; ret 4
  prologue: '55 8bec 83ec10 56 8b7508 8b4604 85c0 7406 8b4810 014e08 8b45fc 5e 8be5 5d c20400',
  // fld [esi] ; fmul [edi] ; fld [esi+4] ; fmul [edi+4] ; faddp ; fld [esi+8] ; fmul [edi+8] ; faddp ; fadd [edi+12] ; fstp [ebx] ; ret
  xform: 'd906 d80f d94604 d84f04 dec1 d94608 d84f08 dec1 d8470c d91b c3',
  // xor eax, eax ; L: add eax, [esi+ecx*4] ; inc ecx ; cmp ecx, edx ; jl L ; ret
  loop: '31c0 03048e 41 39d1 7cf8 c3',
};
const args = process.argv.slice(2);
const src = PRESETS[args[0]] ?? args.filter((a) => !a.startsWith('--') && !/^0x/.test(a)).join('');
const cwArg = args.indexOf('--cw');
const cw = cwArg >= 0 ? parseInt(args[cwArg + 1], 16) : 0x027f;
const bytes = Uint8Array.from(src.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));

const mem = new GuestMemory();
const cpu = new CpuState(mem, THREAD_STATES_BASE);
cpu.reset();
mem.writeBytes(CODE, bytes);
mem.write16(cpu.base + ST.FPU_CW, cw);
console.log(listRegion(mem, CODE, { fpcAssume: cw & 0xf00, smc: true }, { ops: !args.includes('--quiet') }).text);

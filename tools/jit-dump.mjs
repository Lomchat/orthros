#!/usr/bin/env node
// Translated code listing: the WASM instructions the JIT emits for each guest instruction of a region, as a
// pseudo-WAT trace of the emitter calls (locals by name), with per-instruction counts — to judge the code
// quality of common x86 patterns without a WASM disassembler.
// Usage: node tools/jit-dump.mjs <hex bytes | preset> [--cw 0x7f] [--quiet]
//   presets: prologue (frame setup, loads/stores, call, epilogue), xform (x87 float transform), loop (integer loop)
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST } from '../src/cpu/state.js';
import { decode, fmtInsn } from '../src/cpu/decoder.js';
import { Code } from '../src/cpu/jit/wasm.js';
import { translateRegion, Emitter } from '../src/cpu/jit/translate.js';

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

// locals by name (translate.js layout)
const LOCALS = { 0: 'blk', 1: 'state', 10: 'eflags', 11: 'lzop', 12: 'lzres', 13: 'lza', 14: 'lzb', 15: 'fs', 16: 'ta', 17: 'tv', 18: 't2', 19: 't3', 20: 't4', 21: 't5', 22: 't6', 23: 't7', 24: 'i64a', 25: 'i64b', 26: 'f64a', 27: 'f64b', 28: 'top', 29: 't8', 30: 'v0', 31: 'v1', 32: 'v2', 41: 'ftw', 42: 'fpc', 43: 'f64c', 44: 'icount', 53: 'f32a', 54: 'f32b', 55: 'f32c' };
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const localName = (i) => (i >= 2 && i < 10 ? REGS[i - 2] : i >= 33 && i < 41 ? `st${i - 33}` : i >= 45 && i < 53 ? `s32_${i - 45}` : LOCALS[i] ?? `l${i}`);

// trace the instruction-level emitter methods (not the byte writers they are built on)
const RAW = new Set(['constructor', 'byte', 'bytes', 'u', 's', 's64', 'f32', 'f64', 'str', 'sized', 'raw', 'finish', 'ensure', 'reset', 'depth', 'hint']);
let trace = null, depth = 0;
for (const name of Object.getOwnPropertyNames(Code.prototype)) {
  if (RAW.has(name)) continue;
  const d = Object.getOwnPropertyDescriptor(Code.prototype, name);
  if (typeof d.value !== 'function') continue;
  const fn = d.value;
  Code.prototype[name] = function (...a) {
    if (trace && depth === 0) trace.push(['get', 'set', 'tee'].includes(name) ? `${name} ${localName(a[0])}` : a.length && typeof a[0] !== 'object' ? `${name} ${a.map((x) => (typeof x === 'number' && Math.abs(x) > 255 ? '0x' + (x >>> 0).toString(16) : String(x))).join(',')}` : name);
    depth++;
    try { return fn.apply(this, a); } finally { depth--; }
  };
}
const groups = []; // [label, ops]
const emitInsn = Emitter.prototype.emitInsn;
Emitter.prototype.emitInsn = function (insn, b) { trace = []; groups.push([`${insn.addr.toString(16)}  ${fmtInsn(insn)}`, trace]); return emitInsn.call(this, insn, b); };
const emitBlock = Emitter.prototype.emitBlock;
Emitter.prototype.emitBlock = function (b, next) {
  trace = []; groups.push([`-- block ${b.index} @${b.eip.toString(16)} entry`, trace]);
  const r = emitBlock.call(this, b, next);
  return r;
};

const mem = new GuestMemory();
const cpu = new CpuState(mem, THREAD_STATES_BASE);
cpu.reset();
mem.writeBytes(CODE, bytes);
mem.write16(cpu.base + ST.FPU_CW, cw);
trace = []; groups.push(['-- region prologue', trace]);
const r = translateRegion(mem, CODE, { fpcAssume: cw & 0xf00, smc: true });
trace = null;
let total = 0;
const quiet = args.includes('--quiet');
for (const [label, ops] of groups) {
  if (!ops.length && label.startsWith('--')) continue;
  total += ops.length;
  console.log(`${label.padEnd(44)} ${String(ops.length).padStart(4)} ops`);
  if (!quiet) for (const o of ops) console.log(`      ${o}`);
}
console.log(`total ${total} emitter ops, ${r.code.length} body bytes, ${r.blocks.length} blocks; decoded: ${decode(mem, CODE) ? 'ok' : '?'}`);

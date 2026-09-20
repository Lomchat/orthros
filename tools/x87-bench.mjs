#!/usr/bin/env node
// x87 microbenchmark for the JIT: ns per iteration of a dot-product loop (FLD m64, FMUL m64,
// FADDP, two ADDs, DEC/JNZ) in three configurations:
//   pc53    one region, MSVC default control word (0x027f: 53-bit precision)
//   pc24    same loop with FLDCW 0x007f (24-bit precision: every result goes through roundPC)
//   chained loop body split across two regions (a region boundary in the middle): every
//           iteration flushes/reloads the cached x87 stack twice (entry/exit cost of x87 regions)
// Usage: node tools/x87-bench.mjs [iterations]
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, VEC_A = DATA + 0x1000, VEC_B = DATA + 0x3000, CW = DATA + 0x10;
const LEN = 256; // elements per pass (the loop restarts the pointers every LEN elements)
const ITER = +(process.argv[2] ?? 2e6);

class Asm {
  constructor(base) { this.base = base; this.bytes = []; this.labels = new Map(); this.fixups = []; }
  get pc() { return this.base + this.bytes.length; }
  label(n) { this.labels.set(n, this.pc); return this; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  jcc(cc, n) { this.emit(0x0f, 0x80 | cc); this.fixups.push([this.bytes.length, n]); return this.imm32(0); }
  jmp(n) { this.emit(0xe9); this.fixups.push([this.bytes.length, n]); return this.imm32(0); }
  finish() {
    for (const [at, n] of this.fixups) { const rel = this.labels.get(n) - (this.base + at + 4); this.bytes[at] = rel & 0xff; this.bytes[at + 1] = (rel >> 8) & 0xff; this.bytes[at + 2] = (rel >> 16) & 0xff; this.bytes[at + 3] = (rel >>> 24) & 0xff; }
    return Uint8Array.from(this.bytes);
  }
}

/**
 * fldz ; [fldcw [CW]] ; mov ecx, ITER ; mov edx, LEN ; mov esi, A ; mov edi, B
 * L: fld [esi] ; fmul [edi] ; faddp ; add esi, 8 ; add edi, 8 ; [M:] dec edx ; jnz K ; mov edx, LEN ; mov esi, A ; mov edi, B
 * K: dec ecx ; jnz L ; fstp [DATA] ; end: hlt
 */
function program(pc24, split) {
  const a = new Asm(CODE);
  a.emit(0xd9, 0xee);
  if (pc24) a.emit(0xd9, 0x2d).imm32(CW);
  a.emit(0xb9).imm32(ITER).emit(0xba).imm32(LEN).emit(0xbe).imm32(VEC_A).emit(0xbf).imm32(VEC_B);
  a.label('L').emit(0xdd, 0x06).emit(0xdc, 0x0f).emit(0xde, 0xc1).emit(0x83, 0xc6, 8).emit(0x83, 0xc7, 8);
  if (split) a.jmp('M');
  a.label('M').emit(0x4a).jcc(0x5, 'K').emit(0xba).imm32(LEN).emit(0xbe).imm32(VEC_A).emit(0xbf).imm32(VEC_B);
  a.label('K').emit(0x49).jcc(0x5, 'L').emit(0xdd, 0x1d).imm32(DATA);
  a.label('end').emit(0xf4);
  return { code: a.finish(), end: a.labels.get('end'), M: a.labels.get('M') };
}

function run(name, pc24, split) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = new Jit(mem, I);
  const { code, end, M } = program(pc24, split);
  cpu.reset();
  mem.writeBytes(CODE, code);
  for (let i = 0; i < LEN; i++) { mem.writeF64(VEC_A + 8 * i, 1 + i * 1e-3); mem.writeF64(VEC_B + 8 * i, 2 - i * 1e-3); }
  mem.write16(CW, 0x007f);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
  jit.cpu = cpu;
  jit.boundaries = new Set(split ? [M, end] : [end]);
  const t0 = performance.now();
  const r = jit.run({ stopAt: end, maxInsns: 1e9 });
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error(`${name}: exit ${r}`);
  const perIter = (ms * 1e6) / ITER;
  console.log(`${name.padEnd(8)} ${ms.toFixed(0).padStart(5)} ms  ${perIter.toFixed(1).padStart(6)} ns/iter  sum=${mem.readF64(DATA).toPrecision(12)}  regions=${jit.stats.regions} chained=${jit.stats.chained} fallbacks=${jit.stats.fallbackSteps}`);
}

console.log(`x87 dot-product loop, ${ITER} iterations (7 instructions each: FLD m64, FMUL m64, FADDP, 2x ADD, DEC, JNZ)`);
run('pc53', false, false);
run('pc24', true, false);
run('chained', false, true);

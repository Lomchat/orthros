#!/usr/bin/env node
// x87 microbenchmark for the JIT: ns per iteration of a dot-product loop (FLD m64, FMUL m64,
// FADDP, two ADDs, DEC/JNZ) in three configurations:
//   pc53    one region, MSVC default control word (0x027f: 53-bit precision)
//   pc24    same loop under control word 0x007f (24-bit precision: every result goes through roundPC);
//           pc24 gen: the same with the mode tested at run time
//   chained loop body split across two regions (a region boundary in the middle): every
//           iteration flushes/reloads the cached x87 stack twice (entry/exit cost of x87 regions)
// Usage: node tools/x87-bench.mjs [iterations]
//
// The control word is set in the thread state before the run (not by an FLDCW inside the timed
// region): x87 regions are specialized for the precision/rounding control in force when they are
// translated, as a game's hot code is; `generic` runs the same loop with the mode tested at run time
// (Jit option fpuSpecialize: false).
//
// Transform mode: node tools/x87-bench.mjs xform [vertices]
//   ns per vertex of a 3D transform loop the way x87 compilers emit it (per output component:
//   FLD m32, FMUL m32, FLD m32, FMUL m32, FADDP, FLD m32, FMUL m32, FADDP, FADD m32, FSTP m32),
//   at 24-bit precision (the Direct3D FPU mode) and 53-bit precision; results checked against a
//   JavaScript reference that rounds like the x87.
//
// Transcendental mode: node tools/x87-bench.mjs trans [iterations]
//   ns per transcendental instruction (F2XM1, FSCALE, FSIN small / 1e6 argument, FCOS, FSINCOS,
//   FPTAN, FPATAN, FYL2X, FYL2XP1, and the game's e^x sequence) with the loop shape of
//   tools/pe/bench.c's TRANS_LOOP (acc / x / dx on the register stack, one kernel applied to a copy
//   of x per iteration), under three executors:
//     jit      the JIT with the native kernels of the runtime module (fpmath-*.js)
//     jit-fb   the JIT with the transcendental handlers removed from HANDLERS: the region calls the
//              interpreter for the instruction (flush/reload of the x87 locals around the call) —
//              the translator's state before the kernels existed
//     interp   the interpreter alone (iterations / 10)
//   Each case is paired with a base loop (same body without the transcendental) so that the cost of
//   the instruction itself is the difference; a JS reference sum validates every encoding.
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { HANDLERS } from '../src/cpu/jit/translate.js';
import { OP } from '../src/cpu/decoder.js';

const CODE = 0x20000000, DATA = 0x10000000, VEC_A = DATA + 0x1000, VEC_B = DATA + 0x3000;
const LEN = 256; // elements per pass (the loop restarts the pointers every LEN elements)
const MODE = ['trans', 'xform'].includes(process.argv[2]) ? process.argv[2] : 'dot';
const CW_PC24 = 0x007f, CW_PC53 = 0x027f;
const ITER = +(process.argv.slice(2).find((a) => /^\d/.test(a)) ?? (MODE === 'trans' ? 1e6 : 2e6));

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
 * fldz ; mov ecx, ITER ; mov edx, LEN ; mov esi, A ; mov edi, B
 * L: fld [esi] ; fmul [edi] ; faddp ; add esi, 8 ; add edi, 8 ; [M:] dec edx ; jnz K ; mov edx, LEN ; mov esi, A ; mov edi, B
 * K: dec ecx ; jnz L ; fstp [DATA] ; end: hlt
 */
function program(pc24, split) {
  const a = new Asm(CODE);
  a.emit(0xd9, 0xee);
  a.emit(0xb9).imm32(ITER).emit(0xba).imm32(LEN).emit(0xbe).imm32(VEC_A).emit(0xbf).imm32(VEC_B);
  a.label('L').emit(0xdd, 0x06).emit(0xdc, 0x0f).emit(0xde, 0xc1).emit(0x83, 0xc6, 8).emit(0x83, 0xc7, 8);
  if (split) a.jmp('M');
  a.label('M').emit(0x4a).jcc(0x5, 'K').emit(0xba).imm32(LEN).emit(0xbe).imm32(VEC_A).emit(0xbf).imm32(VEC_B);
  a.label('K').emit(0x49).jcc(0x5, 'L').emit(0xdd, 0x1d).imm32(DATA);
  a.label('end').emit(0xf4);
  return { code: a.finish(), end: a.labels.get('end'), M: a.labels.get('M') };
}

function run(name, pc24, split, generic = false) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = new Jit(mem, I, { fpuSpecialize: !generic });
  const { code, end, M } = program(pc24, split);
  cpu.reset();
  mem.writeBytes(CODE, code);
  for (let i = 0; i < LEN; i++) { mem.writeF64(VEC_A + 8 * i, 1 + i * 1e-3); mem.writeF64(VEC_B + 8 * i, 2 - i * 1e-3); }
  mem.write16(cpu.base + ST.FPU_CW, pc24 ? CW_PC24 : CW_PC53);
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

// ============================================================================================
// Transform mode

const NV = 64, VIN = DATA + 0x1000, VOUT = DATA + 0x2000, MAT = DATA + 0x3000;
function xformProgram() {
  const a = new Asm(CODE);
  a.emit(0xb9).imm32(ITER).emit(0xba).imm32(NV).emit(0xbe).imm32(VIN).emit(0xbb).imm32(VOUT).emit(0xbf).imm32(MAT);
  a.label('L');
  for (let r = 0; r < 3; r++) {
    a.emit(0xd9, 0x06).emit(0xd8, 0x4f, 4 * r); // fld [esi] ; fmul [edi + 4r]
    a.emit(0xd9, 0x46, 4).emit(0xd8, 0x4f, 16 + 4 * r).emit(0xde, 0xc1); // fld [esi+4] ; fmul [edi+16+4r] ; faddp
    a.emit(0xd9, 0x46, 8).emit(0xd8, 0x4f, 32 + 4 * r).emit(0xde, 0xc1); // fld [esi+8] ; fmul [edi+32+4r] ; faddp
    a.emit(0xd8, 0x47, 48 + 4 * r).emit(0xd9, 0x5b, 4 * r); // fadd [edi+48+4r] ; fstp [ebx+4r]
  }
  a.emit(0x83, 0xc6, 12).emit(0x83, 0xc3, 12); // add esi, 12 ; add ebx, 12
  a.emit(0x4a).jcc(0x5, 'K').emit(0xba).imm32(NV).emit(0xbe).imm32(VIN).emit(0xbb).imm32(VOUT);
  a.label('K').emit(0x49).jcc(0x5, 'L');
  a.label('end').emit(0xf4);
  return { code: a.finish(), end: a.labels.get('end') };
}
function xformMode() {
  console.log(`x87 vertex transform loop, ${ITER} vertices (3 components x 10 x87 instructions + 5 integer instructions per vertex)`);
  for (const [name, pc24, generic] of [['pc24', true, false], ['pc24 generic', true, true], ['pc53', false, false], ['pc53 generic', false, true]]) {
    let best = Infinity, ok = true;
    for (let rep = 0; rep < 3; rep++) {
      const mem = new GuestMemory();
      const cpu = new CpuState(mem, THREAD_STATES_BASE);
      const jit = new Jit(mem, new Interp(mem, cpu), { fpuSpecialize: !generic });
      const { code, end } = xformProgram();
      cpu.reset();
      mem.writeBytes(CODE, code);
      const m = Array.from({ length: 16 }, (_, i) => Math.fround(0.5 + 0.37 * Math.sin(i + 1)));
      m.forEach((v, i) => mem.writeF32(MAT + 4 * i, v));
      for (let i = 0; i < 3 * NV; i++) mem.writeF32(VIN + 4 * i, Math.fround(Math.cos(i) * 10));
      mem.write16(cpu.base + ST.FPU_CW, pc24 ? CW_PC24 : CW_PC53);
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
      jit.cpu = cpu; jit.boundaries = new Set([end]);
      const t0 = performance.now();
      const r = jit.run({ stopAt: end, maxInsns: 1e9 });
      best = Math.min(best, performance.now() - t0);
      if (r !== EXIT.HALT) throw new Error(`xform: exit ${r}`);
      // reference: every x87 result rounded to 24 bits (pc24) or to double (pc53), stored as float
      const rnd = pc24 ? Math.fround : (x) => x;
      for (let v = 0; v < NV && ok; v++) for (let c = 0; c < 3; c++) {
        const x = mem.readF32(VIN + 12 * v), y = mem.readF32(VIN + 12 * v + 4), z = mem.readF32(VIN + 12 * v + 8);
        let acc = rnd(x * m[c]); acc = rnd(acc + rnd(y * m[4 + c])); acc = rnd(acc + rnd(z * m[8 + c])); acc = rnd(acc + m[12 + c]);
        if (Math.fround(acc) !== mem.readF32(VOUT + 12 * v + 4 * c)) { ok = false; console.log(`  MISMATCH vertex ${v} component ${c}: ${mem.readF32(VOUT + 12 * v + 4 * c)} want ${Math.fround(acc)}`); break; }
      }
    }
    console.log(`${name.padEnd(13)} ${best.toFixed(0).padStart(5)} ms  ${((best * 1e6) / ITER).toFixed(1).padStart(6)} ns/vertex${ok ? '' : '  (MISMATCH)'}`);
  }
}

// ============================================================================================
// Transcendental mode

const X0 = DATA, DX = DATA + 8, OUT = DATA + 0x20;
/**
 * mov ecx, n ; fld qword [DX] ; fld qword [X0] ; fldz            (st0 = acc, st1 = x, st2 = dx)
 * L: fld st(1) ; <body> ; faddp st(1), st ; fxch st(1) ; fadd st, st(2) ; fxch st(1) ; dec ecx ; jnz L
 * fstp qword [OUT] ; fstp st(0) ; fstp st(0) ; end: hlt
 * The body sees a copy of x in st(0) and must leave its result there at the same depth.
 */
function transProgram(body, n) {
  const a = new Asm(CODE);
  a.emit(0xb9).imm32(n);
  a.emit(0xdd, 0x05).imm32(DX).emit(0xdd, 0x05).imm32(X0).emit(0xd9, 0xee);
  a.label('L').emit(0xd9, 0xc1).emit(...body);
  a.emit(0xde, 0xc1).emit(0xd9, 0xc9).emit(0xd8, 0xc2).emit(0xd9, 0xc9).emit(0x49).jcc(0x5, 'L');
  a.emit(0xdd, 0x1d).imm32(OUT).emit(0xdd, 0xd8).emit(0xdd, 0xd8);
  a.label('end').emit(0xf4);
  return { code: a.finish(), end: a.labels.get('end') };
}

const FLD1 = [0xd9, 0xe8], FLD_ST0 = [0xd9, 0xc0], FXCH = [0xd9, 0xc9], FSTP_ST0 = [0xdd, 0xd8], FSTP_ST1 = [0xdd, 0xd9], FADDP = [0xde, 0xc1];
const F2XM1 = [0xd9, 0xf0], FYL2X = [0xd9, 0xf1], FPTAN = [0xd9, 0xf2], FPATAN = [0xd9, 0xf3], FYL2XP1 = [0xd9, 0xf9];
const FSINCOS = [0xd9, 0xfb], FRNDINT = [0xd9, 0xfc], FSCALE = [0xd9, 0xfd], FSIN = [0xd9, 0xfe], FCOS = [0xd9, 0xff];
const FLDL2E = [0xd9, 0xea], FMULP = [0xde, 0xc9], FSUB_ST1_ST = [0xdc, 0xe9];
/** name, body (transcendental included), base (same body without it), x0/dx of the argument sweep, reference f(x) */
const TRANS_CASES = [
  { name: 'f2xm1', body: F2XM1, base: [], x0: -0.5, dx: 1e-6, ref: (x) => 2 ** x - 1 },
  // FSCALE with ST(1) = 1: fld1 ; fxch ; fscale ; fstp st(1)  ->  2 x
  { name: 'fscale', body: [...FLD1, ...FXCH, ...FSCALE, ...FSTP_ST1], base: [...FLD1, ...FXCH, ...FSTP_ST1], x0: -0.5, dx: 1e-6, ref: (x) => 2 * x },
  { name: 'fsin', body: FSIN, base: [], x0: -2, dx: 6e-6, ref: Math.sin },
  { name: 'fsin 1e6', body: FSIN, base: [], x0: 1e6, dx: 1, ref: Math.sin },
  { name: 'fcos', body: FCOS, base: [], x0: -2, dx: 6e-6, ref: Math.cos },
  { name: 'fsincos', body: [...FSINCOS, ...FADDP], base: [], x0: -2, dx: 6e-6, ref: (x) => Math.sin(x) + Math.cos(x) },
  { name: 'fptan', body: [...FPTAN, ...FSTP_ST0], base: [], x0: -1, dx: 2.4e-6, ref: Math.tan },
  // atan2(x, 1): fld1 ; fpatan
  { name: 'fpatan', body: [...FLD1, ...FPATAN], base: [...FLD1, ...FSTP_ST0], x0: -2, dx: 6e-6, ref: Math.atan },
  // x log2 x: fld st(0) ; fyl2x
  { name: 'fyl2x', body: [...FLD_ST0, ...FYL2X], base: [...FLD_ST0, ...FSTP_ST0], x0: 0.5, dx: 2e-6, ref: (x) => x * Math.log2(x) },
  { name: 'fyl2xp1', body: [...FLD_ST0, ...FYL2XP1], base: [...FLD_ST0, ...FSTP_ST0], x0: -0.25, dx: 5e-7, ref: (x) => x * Math.log2(1 + x) },
  // the classic e^x = 2^(x log2 e) sequence (the game's start-up benchmark hits F2XM1 + FSCALE this way)
  { name: 'exp seq', body: [...FLDL2E, ...FMULP, ...FLD_ST0, ...FRNDINT, ...FSUB_ST1_ST, ...FXCH, ...F2XM1, ...FLD1, ...FADDP, ...FSCALE, ...FSTP_ST1], base: [], x0: -0.5, dx: 1e-6, ref: Math.exp },
];
const TRANS_OPS = [OP.F2XM1, OP.FSCALE, OP.FYL2X, OP.FYL2XP1, OP.FPATAN, OP.FSIN, OP.FCOS, OP.FSINCOS, OP.FPTAN];

/** Run one loop under an executor; returns { ms, sum, fallbacks }. */
function runTrans(exec, body, n, x0, dx) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const { code, end } = transProgram(body, n);
  cpu.reset();
  mem.writeBytes(CODE, code);
  mem.writeF64(X0, x0); mem.writeF64(DX, dx);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
  let r, ms, fallbacks = 0;
  if (exec === 'interp') {
    const t0 = performance.now();
    r = I.run({ stopAt: end });
    ms = performance.now() - t0;
  } else {
    const saved = TRANS_OPS.map((op) => HANDLERS[op]);
    if (exec === 'jit-fb') for (const op of TRANS_OPS) HANDLERS[op] = null;
    try {
      const jit = new Jit(mem, I);
      jit.cpu = cpu;
      jit.boundaries = new Set([end]);
      const t0 = performance.now();
      r = jit.run({ stopAt: end, maxInsns: 1e9 });
      ms = performance.now() - t0;
      fallbacks = jit.stats.fallbackSteps;
    } finally { TRANS_OPS.forEach((op, i) => { HANDLERS[op] = saved[i]; }); }
  }
  if (r !== EXIT.HALT) throw new Error(`${exec}: exit ${r}`);
  return { ms, sum: mem.readF64(OUT), fallbacks };
}

function refSum(c, n) { let s = 0, x = c.x0; for (let i = 0; i < n; i++) { s += c.ref(x); x += c.dx; } return s; }

function transMode() {
  const EXECS = [['jit', ITER, 3], ['jit-fb', ITER, 2], ['interp', Math.max(1, Math.round(ITER / 4)), 3]];
  console.log(`x87 transcendentals, ${ITER} iterations (interp: ${EXECS[2][1]}), best of ${EXECS.map(([, , r]) => r).join('/')} runs; loop = fld st(1) ; <body> ; faddp ; fxch ; fadd st,st(2) ; fxch ; dec ; jnz (7 insns + body)`);
  console.log('ns/insn = (case - base) per iteration; jit-fb = JIT with the transcendental handlers removed (interpreter fallback inside the region)');
  console.log('case       ' + EXECS.map(([e]) => `${e.padStart(9)} ns/iter ${'base'.padStart(6)} ${'ns/insn'.padStart(7)}`).join(' |') + ' | fb/jit');
  for (const c of TRANS_CASES) {
    let line = c.name.padEnd(11), per = {};
    for (const [exec, n, reps] of EXECS) {
      let best = Infinity, bestBase = Infinity, sum = 0, fb = 0;
      for (let k = 0; k < reps; k++) {
        const r = runTrans(exec, c.body, n, c.x0, c.dx); best = Math.min(best, r.ms); sum = r.sum; fb = r.fallbacks;
        const b = runTrans(exec, c.base, n, c.x0, c.dx); bestBase = Math.min(bestBase, b.ms);
      }
      const want = refSum(c, n);
      if (!(Math.abs(sum - want) <= 1e-8 * Math.max(1, Math.abs(want)))) console.log(`  MISMATCH ${c.name} ${exec}: got ${sum} want ${want}`);
      if (exec === 'jit' && fb !== 0) console.log(`  ${c.name}: ${fb} fallbacks under the native JIT`);
      if (exec === 'jit-fb' && fb !== n * (c.name === 'exp seq' ? 2 : 1)) console.log(`  ${c.name}: ${fb} fallbacks under jit-fb (expected ${n} per transcendental)`);
      const nsIter = (best * 1e6) / n, nsBase = (bestBase * 1e6) / n;
      per[exec] = nsIter - nsBase;
      line += ` ${exec.padStart(9)} ${nsIter.toFixed(1).padStart(7)} ${nsBase.toFixed(1).padStart(6)} ${(nsIter - nsBase).toFixed(1).padStart(7)} |`;
    }
    console.log(line + ` ${(per['jit-fb'] / per['jit']).toFixed(1).padStart(5)}x`);
  }
}

if (MODE === 'trans') transMode();
else if (MODE === 'xform') xformMode();
else {
  console.log(`x87 dot-product loop, ${ITER} iterations (7 instructions each: FLD m64, FMUL m64, FADDP, 2x ADD, DEC, JNZ)`);
  run('pc53', false, false);
  run('pc24', true, false);
  run('pc24 gen', true, false, true);
  run('chained', false, true);
}

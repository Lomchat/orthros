// x87 NaN results settled in the region (fpmath-x87cold.js emitNanF32 / emitNanF64, called as kernels) under the control words jit-x87-nan-f32.test.js
// does not cover: IE unmasked (ES set), directed rounding (the f32 fast paths are for round-to-nearest), 64-bit
// precision; and registers loaded from m64 (signaling double NaNs held in registers). Bits of the result and the status
// word compared with the interpreter's for every operand pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, A = DATA, B = DATA + 8, OUT = DATA + 0x100;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const BITS32 = [0x7fc00000, 0xffc00000, 0x7fc12345, 0xffc12345, 0x7fd00001, 0xffd00001, 0x7f800001, 0xff812345, 0x7f800000, 0xff800000, 0x00000000, 0x80000000, 0x3f800000, 0xc0490fdb, 0x00000001];
// doubles: quiet / signaling NaNs whose payload fits a float (low 29 fraction bits clear) or not, infinities, zeros
const BITS64 = [0x7ff8000000000000n, 0xfff8000000000000n, 0x7ffa468ac0000000n, 0xfff2468ac0000000n, 0x7ff8000000000001n, 0x7ff0000000000001n, 0x7ff0000020000000n, 0x7ff0000000000000n, 0xfff0000000000000n, 0n, 0x3ff0000000000000n];
const OPS = [0, 1, 4, 5, 6, 7]; // fadd fmul fsub fsubr fdiv fdivr
const snan32 = (x) => (x & 0x7fc00000) === 0x7f800000 && (x & 0x3fffff) !== 0;

/**
 * fld m32 [A]; then form 0: fop m32 [B] / 1: fld m32 [B]; fop st(0), st(1) / 2: ...; fop st(1), st(0) / 3: fop m64 [B];
 * every register stored (fstp m64), fnstsw ax, hlt
 */
function program(op, form) {
  const b = form >= 4 ? [0xdd, 0x05, ...le(A)] : [0xd9, 0x05, ...le(A)];
  if (form === 0) b.push(0xd8, (op << 3) | 5, ...le(B));
  else if (form === 3 || form === 5) b.push(0xdc, (op << 3) | 5, ...le(B));
  else if (form === 4) { b.push(0xdd, 0x05, ...le(B)); b.push(0xd8, 0xc0 | (op << 3) | 1); }
  else { b.push(0xd9, 0x05, ...le(B)); b.push(form === 1 ? 0xd8 : 0xdc, 0xc0 | (op << 3) | 1); }
  b.push(0xdd, 0x1d, ...le(OUT));
  if (form === 1 || form === 2 || form === 4) b.push(0xdd, 0x1d, ...le(OUT + 8));
  b.push(0xdf, 0xe0, 0xf4);
  return Uint8Array.from(b);
}
/** an executor (the interpreter, or a JIT translating `code` once under control word `cw`) on its own memory */
function executor(code, jit, cw) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.writeBytes(CODE, code);
  const interp = new Interp(mem, cpu);
  const ex = jit ? new Jit(mem, interp, { smc: true }) : interp;
  ex.cpu = cpu;
  return (a, b, b64) => {
    cpu.reset();
    if (typeof a === 'bigint') mem.write64(A, a); else mem.write32(A, a); if (b64) mem.write64(B, b); else mem.write32(B, b);
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1;
    mem.write16(cpu.base + ST.FPU_CW, cw);
    const steps0 = jit ? (ex.stats.steps ?? 0) : 0;
    let r; do r = ex.run({ maxInsns: 1e6 }); while (r === EXIT.TIMESLICE);
    assert.equal(r, EXIT.HALT);
    return { out: [mem.read64(OUT), mem.read64(OUT + 8)], ax: cpu.eax & 0xffff, steps: jit ? (ex.stats.steps ?? 0) - steps0 : 0 };
  };
}
const isNan64 = (v) => (v & 0x7ff0000000000000n) === 0x7ff0000000000000n && (v & 0x000fffffffffffffn) !== 0n;

for (const cw of [0x007e, 0x027e, 0x0c7f, 0x0e7f, 0x037f, 0x047f]) {
  test(`NaN results of x87 arithmetic, control word ${cw.toString(16)}, m32 / m64 operands and registers: the interpreter's bits and status word`, () => {
    let nanCases = 0;
    for (const op of OPS) for (const form of [0, 1, 2, 3, 4, 5]) {
      const code = program(op, form), interp = executor(code, false, cw), jit = executor(code, true, cw);
      for (const a of form >= 4 ? BITS64 : BITS32) for (const b of form >= 3 ? BITS64 : BITS32) {
        const i = interp(a, b, form >= 3), j = jit(a, b, form >= 3);
        const what = `cw ${cw.toString(16)} op ${op} form ${form} a ${a.toString(16)} b ${b.toString(16)}`;
        // (a register loaded from a signaling float NaN and stored unchanged keeps its bits in the JIT's float shadow
        // but not in the interpreter, whose m32 load quiets it: a difference of FLD / FSTP, not of the arithmetic —
        // only the result is compared then)
        const k = form === 2 ? 1 : 0;
        if (form < 4 && (snan32(a) || (form !== 3 && snan32(b)))) assert.equal(j.out[k], i.out[k], what); else assert.deepEqual(j.out, i.out, what);
        // (the status word for the NaN results: the JIT's double path does not raise ZE / OE, a known difference)
        if (!isNan64(i.out[k])) continue;
        assert.equal(j.ax, i.ax, `${what}: status word`);
        nanCases++;
      }
    }
    assert.ok(nanCases > 900, `${nanCases} NaN results`);
  });
}

// x87 arithmetic producing a NaN in a region specialized for 24-bit precision (translate-x87.js nanF32): settled inline
// with the interpreter's rule — the NaN operand quieted (of two, the larger significand, the positive one on a tie),
// the indefinite and IE for an invalid operation — without leaving the region (no interpreter step).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, A = DATA, B = DATA + 4, OUT = DATA + 0x100;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const BITS = [0x7fc00000, 0xffc00000, 0x7fc12345, 0xffc12345, 0x7fd00001, 0xffd00001, 0x7f800001, 0xff812345, 0x7f800000, 0xff800000, 0x00000000, 0x80000000, 0x3f800000, 0xc0490fdb, 0x00000001];
const OPS = [0, 1, 4, 5, 6, 7]; // fadd fmul fsub fsubr fdiv fdivr

/** fld m32 [A]; fld m32 [B]; <op> st(1), st (both forms) / <op> m32 [B]; fstp m32 [OUT]...; fnstsw ax; hlt */
function program(op, form) {
  const b = [0xd9, 0x05, ...le(A)];
  if (form === 0) b.push(0xd8, (op << 3) | 5, ...le(B)); // fop m32
  else { b.push(0xd9, 0x05, ...le(B)); b.push(form === 1 ? 0xd8 : 0xdc, 0xc0 | (op << 3) | 1); } // fop st(0), st(1) / fop st(1), st(0)
  b.push(0xd9, 0x1d, ...le(OUT)); // fstp m32
  if (form) b.push(0xd9, 0x1d, ...le(OUT + 4)); // fstp m32
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return Uint8Array.from(b);
}
/** an executor (the interpreter, or a JIT translating `code` once) on its own memory, run per operand pair */
function executor(code, jit) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.writeBytes(CODE, code);
  const interp = new Interp(mem, cpu);
  const ex = jit ? new Jit(mem, interp, { smc: true }) : interp;
  ex.cpu = cpu;
  return (a, b) => {
    cpu.reset();
    mem.write32(A, a); mem.write32(B, b);
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1;
    mem.write16(cpu.base + ST.FPU_CW, 0x007f); // 24-bit precision, round to nearest, exceptions masked
    const steps0 = jit ? (ex.stats.steps ?? 0) : 0;
    let r; do r = ex.run({ maxInsns: 1e6 }); while (r === EXIT.TIMESLICE);
    assert.equal(r, EXIT.HALT);
    return { out: [mem.read32(OUT) >>> 0, mem.read32(OUT + 4) >>> 0], ax: cpu.eax & 0xffff, steps: jit ? (ex.stats.steps ?? 0) - steps0 : 0 };
  };
}

test('NaN results of float arithmetic under 24-bit precision: the interpreter\'s bits and IE, inline', () => {
  let nanCases = 0;
  for (const op of OPS) for (const form of [0, 1, 2]) {
    const code = program(op, form), interp = executor(code, false), jit = executor(code, true);
    for (const a of BITS) for (const b of BITS) {
      const i = interp(a, b), j = jit(a, b);
      const what = `op ${op} form ${form} a ${a.toString(16)} b ${b.toString(16)}`;
      // (an operand passed through unchanged keeps a signaling NaN's bits in the JIT's float register but not in the
      // interpreter's, which loads m32 through a conversion that quiets it: a difference of FLD / FSTP, not of the
      // arithmetic — only the result is compared then)
      const snan = (x) => (x & 0x7fc00000) === 0x7f800000 && (x & 0x3fffff) !== 0;
      const k = form === 2 ? 1 : 0; // (the result: st(0), or st(1) for the st(1), st(0) form)
      if (snan(a) || snan(b)) assert.equal(j.out[k], i.out[k], what); else assert.deepEqual(j.out, i.out, what);
      assert.equal(j.ax, i.ax, `${what}: status word`);
      const nan = (i.out[k] & 0x7f800000) === 0x7f800000 && (i.out[k] & 0x7fffff) !== 0;
      if (nan) { nanCases++; assert.equal(j.steps, 0, `${what}: no interpreter step`); }
    }
  }
  assert.ok(nanCases > 500, `${nanCases} NaN results`);
});

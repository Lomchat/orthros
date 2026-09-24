// x87 regions are specialized for the precision/rounding mode in force at their entry; an in-region transfer made
// after a mode write (FLDCW...) checks the mode and leaves the region when it differs (Emitter.fpuModeGuard). Here a
// loop switches between 24- and 53-bit precision on every iteration (FLDCW on both arms of a branch) and calls a
// function that saves the control word, sets truncation for an FISTP and restores it before its RET (a local return
// inside the region): every result stored must be the interpreter's, under both initial modes and any time slice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

//    mov ecx,20
// L: fld [esi] ; fmul [esi+4] ; fstp dword [edi+0x200] ; test ecx,1 ; jz A ; fldcw [ebx] ; jmp C
// A: fldcw [ebx+2]
// C: fld [esi+8] ; fdiv [esi+12] ; fstp qword [edi+ecx*8] ; call F ; dec ecx ; jnz L ; hlt
// F: fnstcw [ebx+8] ; fldcw [ebx+4] ; fld [esi+16] ; fistp dword [edi+ecx*4+0x100] ; fldcw [ebx+8] ; ret
const CODE_HEX = 'b914000000d906d84e04d99f00020000f7c1010000007404d92beb03d96b02d94608d8760cdd1ccfe8040000004975d5f4d97b08d96b04d94610db9c8f00010000d96b08c3';
const CODE = 0x20000000, DATA = 0x10000000, OUT = 0x10001000, CW = 0x10002000;
const bytes = Uint8Array.from(CODE_HEX.match(/../g).map((h) => parseInt(h, 16)));
const HLT = CODE + bytes.indexOf(0xf4);

function setup(cw0) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  [1.1, 3.3, 1.0, 3.0, 2.7].forEach((v, i) => mem.writeF32(DATA + 4 * i, v));
  mem.write16(CW, 0x027f); mem.write16(CW + 2, 0x007f); mem.write16(CW + 4, 0x0c7f); // 53-bit, 24-bit, 24-bit truncating
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.ebx = CW; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, cw0);
  return { mem, cpu };
}
const result = ({ mem, cpu }) => ({ out: Buffer.from(mem.bytes(OUT, 0x300)).toString('hex'), cw: mem.read16(cpu.base + ST.FPU_CW) }); // (EIP after HLT: the JIT reports the HLT itself)

test('regions specialized for an x87 mode check it on in-region transfers after FLDCW (loops, local calls/returns)', () => {
  for (const cw0 of [0x007f, 0x027f]) {
    const ref = setup(cw0);
    const I = new Interp(ref.mem, ref.cpu);
    assert.equal(I.run({ maxInsns: 1e6 }), EXIT.HALT);
    const want = result(ref);
    for (const slice of [1e6, 23, 7]) {
      const s = setup(cw0);
      const jit = new Jit(s.mem, new Interp(s.mem, s.cpu), { smc: true });
      jit.cpu = s.cpu;
      let r, n = 0;
      do r = jit.run({ maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e5);
      assert.equal(r, EXIT.HALT, `cw ${cw0.toString(16)} slice ${slice}: exit ${r}`);
      assert.deepEqual(result(s), want, `cw ${cw0.toString(16)} slice ${slice}`);
      if (slice === 1e6) assert.equal(jit.stats.fallback, 0, 'no interpreter fallback in the loop');
    }
  }
});

// FST(P) m32 under a directed rounding known statically (a region specialized for it) rounds inline (no kernel):
// every rounding control at 53- and 64-bit precision, on values at the edges — overflow past the largest float,
// denormals, underflow to zero, both zeros, 2^24 + 1, NaN.
test('FSTP m32 under directed rounding at 53/64-bit precision: the interpreter\'s results for edge values', () => {
  // xor ecx,ecx ; L: fld qword [esi+ecx*8] ; fstp dword [edi+ecx*4] ; inc ecx ; cmp ecx,16 ; jne L ; hlt
  const code = Uint8Array.from('31c9dd04ced91c8f4183f91075f4f4'.match(/../g).map((h) => parseInt(h, 16)));
  const values = [1 / 3, -1 / 3, 1e39, -1e39, 3.4028235677973366e38, -3.4028235677973366e38, 1e-40, -1e-40, 1e-50, -1e-50, 0, -0, 16777217, -16777217, NaN, 2.5];
  const run = (cw, useJit) => {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    mem.writeBytes(CODE, code);
    values.forEach((v, i) => mem.writeF64(DATA + 8 * i, v));
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.eflags = F.RESERVED1 | F.IF;
    mem.write16(cpu.base + ST.FPU_CW, cw);
    const I = new Interp(mem, cpu);
    let r;
    if (useJit) { const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; r = jit.run({ maxInsns: 1e6 }); assert.equal(jit.stats.fallback, 0); }
    else r = I.run({ maxInsns: 1e6 });
    assert.equal(r, EXIT.HALT);
    return Buffer.from(mem.bytes(OUT, 4 * values.length)).toString('hex');
  };
  for (const pc of [0x200, 0x300]) for (const rc of [0x000, 0x400, 0x800, 0xc00]) {
    const cw = 0x7f | pc | rc;
    assert.equal(run(cw, true), run(cw, false), `control word ${cw.toString(16)}`);
  }
});

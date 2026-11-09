// opts.memarg (translate.js Emitter.foldDisp): [base + disp] loads, and stores addressed by ESP alone, carry a small
// positive displacement in the WebAssembly memarg offset instead of an i32.add. The memarg does not wrap at 32 bits:
// a large displacement with a register holding a negative offset (table[-1]: [ecx + 0x10010], ECX = -16) must still
// reach the wrapped address, so it is not folded. JIT with memarg on and off against the interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const PROG = Uint8Array.from([
  0x8b, 0x81, 0x10, 0x00, 0x01, 0x00, // mov eax, [ecx+0x10010] (ECX = -16: reads 0x10000, not folded)
  0x8b, 0x53, 0x08, // mov edx, [ebx+8]
  0x89, 0x54, 0x24, 0x08, // mov [esp+8], edx
  0x8b, 0x74, 0x24, 0x08, // mov esi, [esp+8]
  0x0f, 0xbf, 0x7b, 0x0c, // movsx edi, word [ebx+0xc]
  0x03, 0x43, 0x04, // add eax, [ebx+4]
  0xd9, 0x43, 0x04, // fld dword [ebx+4]
  0xd9, 0x5c, 0x24, 0x10, // fstp dword [esp+0x10]
  0xf3, 0x0f, 0x10, 0x43, 0x10, // movss xmm0, [ebx+0x10]
  0xf3, 0x0f, 0x11, 0x44, 0x24, 0x14, // movss [esp+0x14], xmm0
  0x8b, 0x6c, 0x24, 0x14, // mov ebp, [esp+0x14]
  0xf4, // hlt
]);

function run(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  cpu.reset(); mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, PROG);
  mem.write32(0x10000, 0x11223344); mem.write32(0, 0); // (the wrapped address; the folded one would trap or differ)
  for (let i = 0; i < 8; i++) mem.write32(DATA + 4 * i, (0x3f800000 + i * 0x123457) >>> 0);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.ecx = 0xfffffff0; cpu.ebx = DATA; cpu.eflags = F.RESERVED1 | F.IF;
  const stop = CODE + PROG.length - 1;
  let jit = null;
  if (jitOpts) { jit = new Jit(mem, I, { smc: true, ...jitOpts }); jit.cpu = cpu; jit.run({ stopAt: stop, maxInsns: 1000 }); } else I.run({ stopAt: stop, maxInsns: 1000 });
  return { regs: [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.ebp, cpu.esi, cpu.edi].map((v) => v >>> 0), eip: cpu.eip >>> 0,
    stack: Array.from({ length: 8 }, (_, i) => mem.read32(DATA + 0x800 + 4 * i) >>> 0), bytes: jit?.stats.bytes ?? 0, regions: jit?.regions.length ?? 0 };
}

test('memarg: folded displacements read and write what the interpreter does; a large one with a negative register wraps', () => {
  const ref = run(null), on = run({ memarg: true }), off = run({ memarg: false });
  assert.equal(ref.regs[0], (0x11223344 + 0x3f800000 + 0x123457) >>> 0);
  for (const r of [on, off]) { assert.deepEqual(r.regs, ref.regs); assert.equal(r.eip, ref.eip); assert.deepEqual(r.stack, ref.stack); }
  assert.ok(on.regions === 1 && off.regions === 1, `one region each (${on.regions}, ${off.regions}): no translation failed`);
  assert.ok(on.bytes < off.bytes, `folded code is smaller (${on.bytes} vs ${off.bytes} bytes)`);
});

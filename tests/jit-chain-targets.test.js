// A region's jump exits test their target with one compare before the hash probes (translate.js emitChain): address 0
// and every address from the thunks up leave through the dispatcher instead of chaining. Checked: an indirect jump or
// call to an API thunk ends the run on that thunk, to address 0 or past the 2 GiB guest space on an access violation at
// the target, and to translated code it chains (the run goes on to the HLT) — the same whether the target region was
// translated before or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE, THUNK_SIZE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

function runTo(target, form) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  // L: mov eax, target ; (jmp eax | call eax) ; hlt     T (CODE + 0x100): inc ecx ; hlt
  const code = [0xb8, ...le(target), ...(form === 'call' ? [0xff, 0xd0] : [0xff, 0xe0]), 0xf4];
  cpu.reset(); mem.writeBytes(CODE, Uint8Array.from(code)); mem.writeBytes(CODE + 0x100, Uint8Array.from([0x41, 0xf4]));
  cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
  // translated first (the region of T exists: a chain probe would find it), then the region of L
  cpu.eip = CODE + 0x100; assert.equal(jit.run({ maxInsns: 1e6 }), EXIT.HALT);
  cpu.eip = CODE; cpu.ecx = 0;
  const r = jit.run({ maxInsns: 1e6 });
  return { r, eip: cpu.eip >>> 0, arg: cpu.exitArg, ecx: cpu.ecx, fault: jit.lastFault?.message ?? '' };
}

test('chained exits: thunks, address 0 and addresses past the guest space leave through the dispatcher', () => {
  for (const form of ['jmp', 'call']) {
    const t = runTo(THUNK_BASE + 3 * THUNK_SIZE, form);
    assert.equal(t.r, EXIT.THUNK, `${form} to a thunk`); assert.equal(t.arg, 3);
    const z = runTo(0, form);
    assert.equal(z.r, EXIT.FAULT, `${form} to 0`); assert.match(z.fault, /0x0\b/);
    const hi = runTo(0x80001000, form);
    assert.equal(hi.r, EXIT.FAULT, `${form} past the guest space`);
    const ok = runTo(CODE + 0x100, form);
    assert.equal(ok.r, EXIT.HALT, `${form} to translated code`); assert.equal(ok.eip, CODE + 0x101); assert.equal(ok.ecx, 1);
  }
});

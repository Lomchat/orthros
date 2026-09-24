// Fast APIs run inline in regions (translate.js inlineApiOf / emitInlineApi) against the dispatcher's fast path
// (runtime.js fastApi) that they reproduce: every inlinable API through `call dword ptr [slot]`, two through an import
// stub `jmp dword ptr [slot]`, and a TLS index beyond the TEB's slots (left to the JavaScript handler: an exit, handled
// here) — registers, memory, the TEB and a critical section must end identical with and without inlining, under any
// time slice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { PROC_CONSTS } from '../src/cpu/jit/runtime.js';

const CODE_HEX = '6a07ff1500010010ff150401001089076a03ff1508010010894704ff15040100108947346a556a03ff150c0100108947086a03ff150801001089470c56ff151001001056ff151001001056ff151401001056ff151401001055ff151801001089471055ff151c0100106a0955ff15200100108947146a0455ff15240100108947186a0d6a6355ff152801001089471cff152c010010894720ff1530010010894724ff15340100108947286a0be814000000e81500000089472c6a46ff1508010010894730f4ff2500010010ff2504010010';
const CODE = 0x20000000, SLOTS = 0x10000100, OUT = 0x10001000, TEB = 0x10002000, CS = 0x10003000, COUNTER = 0x10003100;
const THUNK_SIZE = 16;
const APIS = ['SetLastError', 'GetLastError', 'TlsGetValue', 'TlsSetValue', 'EnterCriticalSection', 'LeaveCriticalSection', 'InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange', 'InterlockedExchangeAdd', 'InterlockedCompareExchange', 'GetCurrentThreadId', 'GetCurrentProcessId', 'GetProcessHeap'];
const bytes = Uint8Array.from(CODE_HEX.match(/../g).map((h) => parseInt(h, 16)));

function run(inlineApi, slice) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, inlineApi });
  jit.cpu = cpu;
  APIS.forEach((n, k) => { jit.markFast(k + 1, `kernel32.dll!${n}`, true); mem.write32(SLOTS + 4 * k, THUNK_BASE + (k + 1) * THUNK_SIZE); });
  mem.write32(TEB + 0x20, 0x4d2); mem.write32(TEB + 0x24, 0x800); mem.write32(TEB + 0x34, 0);
  for (let i = 0; i < 64; i++) mem.write32(TEB + 0xe10 + 4 * i, 0x1000 + i);
  mem.write32(CS + 4, -1); mem.write32(CS + 8, 0); mem.write32(CS + 12, 0);
  mem.write32(COUNTER, 13);
  mem.write32(PROC_CONSTS, 0x777);
  cpu.fsBase = TEB; cpu.eip = CODE; cpu.esp = 0x10008000; cpu.edi = OUT; cpu.esi = CS; cpu.ebp = COUNTER; cpu.eflags = F.RESERVED1 | F.IF;
  let r, n = 0, handled = 0;
  for (;;) {
    r = jit.run({ maxInsns: slice });
    if (r === EXIT.TIMESLICE && ++n < 1e5) continue;
    if (r === EXIT.THUNK) { // the JavaScript handler's part: TlsGetValue of an index beyond the TEB's slots
      const ret = mem.read32(cpu.esp);
      assert.equal(cpu.eip, THUNK_BASE + 3 * THUNK_SIZE, 'only TlsGetValue(70) leaves');
      cpu.eax = 0xabcd; cpu.esp = cpu.esp + 8; cpu.eip = ret; handled++;
      continue;
    }
    break;
  }
  assert.equal(r, EXIT.HALT);
  return {
    state: { out: Buffer.from(mem.bytes(OUT, 64)).toString('hex'), teb: Buffer.from(mem.bytes(TEB + 0x20, 24)).toString('hex'), cs: Buffer.from(mem.bytes(CS, 16)).toString('hex'), counter: mem.read32(COUNTER), esp: cpu.esp, eax: cpu.eax, handled },
    inlined: jit.stats.inlineApi ?? 0,
  };
}

test('fast APIs inline in regions: the dispatcher fast path\'s results, with calls and import stubs, any time slice', () => {
  const want = run(false, 1e6);
  assert.equal(want.inlined, 0);
  assert.deepEqual(want.state.handled, 1);
  assert.equal(want.state.counter, 99);
  assert.equal(Buffer.from(want.state.out, 'hex').readUInt32LE(52), 0, 'TlsGetValue clears the last error');
  for (const slice of [1e6, 13, 3]) {
    const got = run(true, slice);
    assert.deepEqual(got.state, want.state, `slice ${slice}`);
    if (slice === 1e6) assert.ok(got.inlined >= 16, `call sites inlined: ${got.inlined}`);
  }
});

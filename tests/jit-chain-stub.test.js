// The runtime's shared chain function (runtime.js chainStubCode, used by regions translated with opts.chainStub) is
// built into every runtime module, chainStub on or off: on an engine without WASM tail calls the module must still be
// built (the JIT then runs without chaining, as before the function existed), and the function must not chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, JIT_HASH_BASE, JIT_HASH_BITS } from '../src/cpu/memory.js';
import { THREAD_STATES_BASE, ST } from '../src/cpu/state.js';
import { buildRuntime, HASH_ENTRY, REGION_ARG_OFFSETS } from '../src/cpu/jit/runtime.js';

function instance(tailCalls) {
  const mem = new GuestMemory();
  const table = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
  const rt = new WebAssembly.Instance(new WebAssembly.Module(buildRuntime({ tailCalls })), { env: { memory: mem.memory, table, now: () => 0 } }).exports;
  return { mem, table, rt };
}

// chain(T, ...) with T in the hash table, its region being chain itself entered at "block" 0: chained, the second call
// sees target 0 and returns 0 (EIP 0); not chained, T comes back with the state written.
function probe(tailCalls) {
  const { mem, table, rt } = instance(tailCalls);
  const T = 0x401000, base = THREAD_STATES_BASE;
  table.set(0, rt.chain);
  mem.write32(base + ST.STOP_AT, 0xffffffff);
  const slot = Math.imul(T, 0x9e3779b1) >>> (32 - JIT_HASH_BITS);
  const e = JIT_HASH_BASE + slot * HASH_ENTRY;
  mem.write32(e, T); mem.write32(e + 4, 0); mem.write32(e + 8, 0);
  const regs = REGION_ARG_OFFSETS.map((_, k) => (k === REGION_ARG_OFFSETS.length - 1 ? 100 : 0x1000 + k));
  const r = rt.chain(T, base, ...regs);
  return { r: r >>> 0, eip: mem.read32(base + ST.EIP) >>> 0, regs: REGION_ARG_OFFSETS.map((off) => mem.read32(base + off) >>> 0), want: regs.map((v) => v >>> 0) };
}

test('chain: tail-calls the target region with tail calls, only writes the state back without', () => {
  const on = probe(true);
  assert.equal(on.r, 0); assert.equal(on.eip, 0);
  const off = probe(false);
  assert.equal(off.r, 0x401000); assert.equal(off.eip, 0x401000);
  assert.deepEqual(off.regs, off.want);
});

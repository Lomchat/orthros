// Time APIs answered by the dispatcher's fast path from the VM clock (runtime.js fastApi 19/20, env.now): timeGetTime
// and GetTickCount give the milliseconds from TICK_BASE as their JavaScript handlers do (wrapping at 2^32),
// QueryPerformanceCounter the clock in 100 ns units (nothing written through a null pointer), all without an exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { TICK_BASE } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, SLOTS = 0x10000100, OUT = 0x10001000, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const call = (k) => [0xff, 0x15, ...le(SLOTS + 4 * k)];
const store = (a) => [0xa3, ...le(a)]; // mov [a], eax
const push = (v) => [0x68, ...le(v)];
const PROGRAM = [...call(0), ...store(OUT), ...call(1), ...store(OUT + 4), ...push(OUT + 8), ...call(2), ...store(OUT + 16), ...push(0), ...call(2), ...store(OUT + 20), 0xf4];

function run(now) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(PROGRAM));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, now: () => now });
  jit.cpu = cpu;
  ['winmm.dll!timeGetTime', 'kernel32.dll!GetTickCount', 'kernel32.dll!QueryPerformanceCounter'].forEach((key, k) => { jit.markFast(k + 1, key, true); mem.write32(SLOTS + 4 * k, THUNK_BASE + (k + 1) * THUNK_SIZE); });
  cpu.eip = CODE; cpu.esp = 0x10009000; cpu.eflags = F.RESERVED1 | F.IF;
  assert.equal(jit.run({ maxInsns: 1e6 }), EXIT.HALT, 'no exit to JavaScript');
  assert.equal(cpu.esp, 0x10009000, 'stdcall returns');
  return { tgt: mem.read32(OUT), gtc: mem.read32(OUT + 4), qpc: mem.read64(OUT + 8), qpcRet: mem.read32(OUT + 16), qpcNull: mem.read32(OUT + 20) };
}

test('time APIs from the VM clock without leaving the translated code, the JavaScript handlers\' values', () => {
  for (const now of [0, 1234.75, 1234.7, 5e6 + 0.999, 2 ** 32 + 17.5]) {
    const r = run(now), ms = (TICK_BASE + Math.floor(now)) >>> 0;
    assert.equal(r.tgt, ms, `timeGetTime at ${now}`);
    assert.equal(r.gtc, ms, `GetTickCount at ${now}`);
    assert.equal(r.qpc, BigInt(Math.floor(now * 10000)), `QueryPerformanceCounter at ${now}`);
    assert.deepEqual([r.qpcRet, r.qpcNull], [1, 1]);
  }
});

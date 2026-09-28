// An exception on a thread whose stack pointer the program lost (a smashed frame restored into ESP) has no stack to be
// dispatched on: the process ends with a crash report (as on Windows), not with an emulator error writing its CONTEXT
// outside the address space (BFME2 on a player's machine: RangeError in Seh.writeContext).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { VMem } from '../src/win32/vmem.js';
import { Seh } from '../src/win32/seh.js';

class GuestCrash extends Error { constructor(report) { super(report); this.report = report; } }

test('seh: an exception with ESP outside committed memory is a guest crash with a report', () => {
  const mem = new GuestMemory(), vmem = new VMem();
  const vm = { mem, GuestCrash, api: { thunkFor: () => 0x1000 }, proc: { vmem, symbolize: (a) => '0x' + a.toString(16) }, crashReport: (t, why) => `report: ${why}` };
  const seh = new Seh(vm);
  for (const esp of [0x65757213, 0x10, 0xfffffff0]) {
    const thread = { id: 1, teb: 0, cpu: { esp, eip: 0, fpuCw: 0, fpuSw: 0, fpuTw: 0 } };
    assert.throws(() => seh.raise(thread, 0xc0000005, 0, 0x53524852, [8, 0x53524852]), (e) => e instanceof GuestCrash && /no stack to dispatch it on/.test(e.report));
  }
});

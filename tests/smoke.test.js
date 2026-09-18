import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, PRIVATE_BASE, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, F } from '../src/cpu/state.js';

test('guest memory: 2 GB identity-mapped space, unaligned little-endian access', () => {
  const mem = new GuestMemory();
  assert.equal(mem.size, 0x80000000);
  mem.write32(0x00400001, 0xdeadbeef); // unaligned
  assert.equal(mem.read32(0x00400001), 0xdeadbeef);
  assert.equal(mem.read8(0x00400001), 0xef);
  assert.equal(mem.read16(0x00400003), 0xdead);
  assert.equal(mem.readS8(0x00400001), -17);
  mem.write64(0x7ffffff0, 0x1122334455667788n);
  assert.equal(mem.read64(0x7ffffff0), 0x1122334455667788n);
  mem.writeCString(0x1000, 'hello');
  assert.equal(mem.readCString(0x1000), 'hello');
  mem.writeWString(0x2000, 'wide');
  assert.equal(mem.readWString(0x2000), 'wide');
  assert.ok(THUNK_BASE < PRIVATE_BASE);
});

test('cpu state: register accessors map onto the state block in guest memory', () => {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.eax = 0xffffffff;
  cpu.esp = 0x0012ff00;
  assert.equal(cpu.eax, 0xffffffff);
  assert.equal(mem.read32(THREAD_STATES_BASE + ST.GPR + 0), 0xffffffff);
  cpu.push32(0x11223344);
  assert.equal(cpu.esp, 0x0012fefc);
  assert.equal(cpu.pop32(), 0x11223344);
  assert.equal(cpu.esp, 0x0012ff00);
  assert.ok(cpu.eflags & F.RESERVED1);
  cpu.fpuTop = 7;
  cpu.setSt(0, 1.5);
  assert.equal(cpu.fpr(7), 1.5);
  assert.match(cpu.dump(), /eax=ffffffff/);
});

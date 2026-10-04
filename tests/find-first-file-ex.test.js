// FindFirstFileExA/W(name, infoLevel, data, searchOp, filter, flags): the WIN32_FIND_DATA goes to the third argument.
// It used to be written at the second one — the info level, 0 or 1: into the null page — leaving the caller's buffer
// as it was. Through the handlers of a booted process (as tests/time-locale-api.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

test('FindFirstFileExA/W fill the buffer of their third argument, FindNextFile goes on from there', { skip }, () => {
  const vfs = new Vfs(); const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', t);
  t.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  t.open('alpha.dat', { create: true }).write(0, new Uint8Array(1234));
  t.open('beta.dat', { create: true }).write(0, new Uint8Array(7));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 64, height: 64 }), logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, p = vm.proc.processHeap.alloc(0x1000, true), frame = vm.proc.processHeap.alloc(64, true);
  const call = (name, ...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame;
    const r = vm.api.lookup('kernel32.dll', name).fn(c); return r === undefined ? r : r >>> 0;
  };
  mem.writeCString(p, 'C:\\Test\\*.dat');
  const nullBefore = Buffer.from(mem.bytes(0, 0x400));
  for (const level of [0, 1]) { // FindExInfoStandard, FindExInfoBasic
    const data = p + 0x100;
    mem.fill(data, 592, 0xcc);
    const h = call('FindFirstFileExA', p, level, data, 0, 0, 0);
    assert.notEqual(h, 0xffffffff);
    assert.equal(mem.readCString(data + 44), 'alpha.dat');
    assert.equal(mem.read32(data + 32), 1234, 'nFileSizeLow');
    assert.equal(call('FindNextFileA', h, data), 1);
    assert.equal(mem.readCString(data + 44), 'beta.dat');
    assert.equal(call('FindNextFileA', h, data), 0);
    call('FindClose', h);
  }
  mem.writeWString(p + 0x400, 'C:\\Test\\b*.dat');
  const h = call('FindFirstFileExW', p + 0x400, 0, p + 0x600, 0, 0, 0);
  assert.notEqual(h, 0xffffffff);
  assert.equal(mem.readWString(p + 0x600 + 44), 'beta.dat');
  assert.equal(call('FindFirstFileExA', p, 2, p + 0x100, 0, 0, 0), 0xffffffff, 'an unknown info level fails');
  assert.deepEqual(Buffer.from(mem.bytes(0, 0x400)), nullBefore, 'nothing written at the info level as an address');
});

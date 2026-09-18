// M2: PE loader + Win32 bootstrap. Runs CRT-free test programs built by tools/pe/build.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { NodeBackend } from '../src/vfs/node-backend.js';
import { VirtualClock } from '../src/core/clock.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;

function makeVm(opts = {}) {
  const vfs = new Vfs();
  const mb = new MemBackend();
  vfs.mount('C:\\', mb);
  mb.mkdir('Test');
  vfs.mount('C:\\Test', new NodeBackend(PE_DIR, { readOnly: true }));
  vfs.mount('C:\\Users', new MemBackend());
  const vm = new Vm({ vfs, clock: new VirtualClock(), logKinds: opts.logKinds ?? ['warn', 'crash'], ...opts });
  return vm;
}

test('hello.exe: PE load, imports, heap, TLS, VirtualAlloc, files, exit code', { skip: !fs.existsSync(PE_DIR + 'hello.exe') && 'build/pe missing (make pe-tests)' }, () => {
  const vfs = new Vfs();
  const test = new MemBackend();
  test.mkdir('');
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', test);
  // copy the exe into a writable dir so the program can create out.txt next to it
  test.open('hello.exe', { create: true }).write(0, fs.readFileSync(PE_DIR + 'hello.exe'));
  const vm = new Vm({ vfs, clock: new VirtualClock(), logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const code = vm.run();
  const out = vm.stdout.join('');
  assert.equal(code, 42);
  assert.equal(out,
    'hello from guest\n' +
    'abcdefghijklmnopqrstuvwxyz\n' +
    'abcdefghijklmnopqrstuvwxyz\n' +
    '1234\n' +
    '42\n' +
    '"C:\\Test\\hello.exe"\n' +
    'C:\\Test\\hello.exe\n' +
    'read back: written by guest\n' +
    '16\n' +
    '1234\n' +
    '8\n');
  assert.equal(vm.proc.unknownImports.size, 0);
});

export { makeVm };

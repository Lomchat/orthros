// Child processes (docs/processes.md, core/procs.js): CreateProcess runs a program in a machine of its own, the
// kernel-object namespace, inherited handles, paging-file mappings, thread messages and process handles shared as on
// Windows; a machine that starts no child keeps its single-process path. Runs tools/pe/multiproc.c (make pe-tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { notQuiet } from '../src/core/vm-snapshot.js';
import { wmOf } from '../src/win32/user32.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

function boot(exe, opts = {}) {
  const vfs = new Vfs();
  const dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', dir);
  for (const name of [exe, ...(opts.more ?? [])]) dir.open(name, { create: true }).write(0, fs.readFileSync(PE_DIR + name));
  const clock = new VirtualClock();
  const host = new HeadlessHost({ clock, width: 800, height: 600 });
  const logs = [];
  const vm = new Vm({ vfs, clock, host, jit: opts.jit, logKinds: ['warn', 'crash', 'loader'], log: (k, m) => logs.push(`[${k}] ${m}`) });
  const out = [];
  vm.onStdout = (s) => out.push(s);
  vm.createProcess({ exePath: 'C:\\Test\\' + exe });
  return { vm, host, out, logs };
}

for (const jit of [true, false]) {
  test(`multiproc.exe (${jit ? 'JIT' : 'interpreter'}): launcher/game handshake across two processes`, { skip: skip('multiproc.exe') }, () => {
    const { vm, out, logs } = boot('multiproc.exe', { jit });
    const code = vm.run();
    const text = out.join('');
    assert.equal(code, 0, `${text}\n${logs.filter((l) => l.startsWith('[warn]') || l.startsWith('[crash]')).join('\n')}`);
    for (const line of ['created=1', 'stillActive=1', 'readyWait=0', 'posted=1', 'writtenWait=0', 'liveView=1', 'processWait=0', 'exitCode=42', 'answered=1', 'fails=0',
      'child.mutexExists=1', 'child.openEvent=1', 'child.message=1', 'child.inheritedView=1', 'child.namedView=1']) assert.ok(text.includes(line + '\n'), `${line} missing in:\n${text}`);
    // two machines, each its own memory; ids distinct; the child ended before its parent
    const [root, child] = vm.group.vms;
    assert.equal(root, vm);
    assert.notEqual(child.mem, vm.mem);
    assert.notEqual(child.proc.pid, vm.proc.pid);
    assert.ok(child.proc.threads.every((t) => !vm.proc.threads.some((u) => u.id === t.id)));
    assert.ok(child.proc.exited && child.proc.exitCode === 42);
    assert.equal(child.proc.cmdline, 'multiproc.exe child'); // (its command line as its creator gave it)
    assert.ok(logs.some((l) => /CreateProcess\(app=-, cmd=multiproc.exe child.*inherit=1.*: process \d+ \(C:\\Test\\multiproc.exe/.test(l)), logs.join('\n'));
    assert.equal(notQuiet(vm), 'several processes (a child process was started)'); // (never snapshotted)
  });
}

test('a machine without child processes keeps its single-process path', { skip: skip('hello.exe') }, () => {
  const { vm } = boot('hello.exe');
  assert.equal(vm.run(), 42);
  assert.equal(vm.group, null);
});

test('CreateProcess of a file that is not a program fails like Windows, without a child machine', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const dir = vm.vfs.resolve('C:\\Test').backend;
  dir.open('notes.txt', { create: true }).write(0, new TextEncoder().encode('not a program'));
  const c = vm.ctx, mem = vm.mem, t = vm.proc.threads[0];
  const scratch = vm.proc.processHeap.alloc(0x200);
  mem.writeCString(scratch, 'notes.txt');
  mem.writeCString(scratch + 0x40, 'missing.exe');
  // CreateProcessA(NULL, cmd, ..., pi) called straight on its handler
  const call = (cmdAddr) => {
    const sp = t.cpu.esp - 0x40; for (let i = 0; i < 11; i++) mem.write32(sp + 4 * i, 0);
    mem.write32(sp + 8, cmdAddr); mem.write32(sp + 40, scratch + 0x100); t.cpu.esp = sp;
    c.bind(t, vm.api.lookup('kernel32.dll', 'CreateProcessA'));
    const r = vm.api.lookup('kernel32.dll', 'CreateProcessA').fn(c); t.cpu.esp = sp + 0x40; return [r, t.lastError];
  };
  assert.deepEqual(call(scratch), [0, 193]); // ERROR_BAD_EXE_FORMAT
  assert.deepEqual(call(scratch + 0x40), [0, 2]); // ERROR_FILE_NOT_FOUND
  assert.equal(vm.group, null);
});

test('the display and the input belong to the foreground process', { skip: skip('multiproc.exe') }, () => {
  const { vm, host } = boot('multiproc.exe');
  const child = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  const g = vm.group;
  assert.equal(g.foreground, vm);
  const a = wmOf(vm), b = wmOf(child);
  host.inputQueue.push({ type: 'keydown', vk: 0x41, scan: 0x1e });
  b.pump(); // (a background process: the event stays the host's)
  assert.equal(host.inputQueue.length, 1);
  g.setForeground(child);
  a.pump();
  assert.equal(host.inputQueue.length, 1);
  b.pump();
  assert.equal(host.inputQueue.length, 0);
  assert.equal(b.keyState[0x41] & 0x80, 0x80);
  // the foreground process ending hands the display back to its parent
  g.exited(child, 0);
  assert.equal(g.foreground, vm);
});

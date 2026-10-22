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
import { Ctx } from '../src/win32/ctx.js';
import { MAX_LIVE_PROCESSES } from '../src/core/procs.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

/** a handler called straight on a machine's main thread: (vm, dll, name, ...args) -> its result (unsigned) */
function caller() {
  const frames = new Map();
  return (vm, dll, name, ...args) => {
    const frame = frames.get(vm) ?? frames.set(vm, vm.proc.processHeap.alloc(64, true)).get(vm);
    args.forEach((a, i) => vm.mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame;
    const r = vm.api.lookup(dll, name).fn(c); return r === undefined ? r : r >>> 0;
  };
}
const K = 'kernel32.dll';
/** a string in `vm`'s heap */
const str = (vm, s) => { const p = vm.proc.processHeap.alloc(s.length + 1, true); vm.mem.writeCString(p, s); return p; };
/** the children a machine starts (the test keeps them: the group releases them once they end) */
function keepChildren(vm) {
  const kids = [], spawn = vm.spawnProcess;
  vm.spawnProcess = function (o) { const c = spawn.call(this, o); kids.push(c); return c; };
  return kids;
}

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
    const kids = keepChildren(vm);
    const code = vm.run();
    const text = out.join('');
    assert.equal(code, 0, `${text}\n${logs.filter((l) => l.startsWith('[warn]') || l.startsWith('[crash]')).join('\n')}`);
    for (const line of ['created=1', 'stillActive=1', 'readyWait=0', 'posted=1', 'writtenWait=0', 'liveView=1', 'processWait=0', 'exitCode=42', 'answered=1', 'fails=0',
      'child.mutexExists=1', 'child.openEvent=1', 'child.message=1', 'child.inheritedView=1', 'child.namedView=1']) assert.ok(text.includes(line + '\n'), `${line} missing in:\n${text}`);
    // two machines, each its own memory; ids distinct; the child ended before its parent
    const [child] = kids;
    assert.deepEqual(vm.group.vms, [vm]); // (the child left the group when it ended: reap)
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

test('render worker: devices created after a MEMORY command read that guest memory (a child process\'s)', async () => {
  const { OP, RingWriter } = await import('../src/gfx/cmd-ring.js');
  const { Replayer } = await import('../src/gfx/d3d-mirror.js');
  const words = new Int32Array(1 << 12), w = new RingWriter(words, () => { throw new Error('full'); });
  const a = { name: 'root memory' }, b = { name: 'child memory' };
  const replayer = new Replayer(words, { mem: a, createBackend: () => null });
  replayer.mems[1] = b;
  w.put(OP.DEVICE, 1, 1, 800, 600, 1);
  w.put(OP.MEMORY, 1);
  w.put(OP.DEVICE, 2, 1, 800, 600, 1);
  replayer.run(w.produced);
  assert.equal(replayer.devices.get(1).proc.mem, a);
  assert.equal(replayer.devices.get(2).proc.mem, b);
});

// ---------------------------------------------------------------- review fixes (2026-10-22)
for (const jit of [true, false]) {
  test(`multiproc2.exe (${jit ? 'JIT' : 'interpreter'}): relaunches, FindWindow, a mapping written while the parent waits, PulseEvent, SignalObjectAndWait, DuplicateHandle into the child`, { skip: skip('multiproc2.exe') }, () => {
    const { vm, out, logs } = boot('multiproc2.exe', { jit });
    const code = vm.run();
    const text = out.join('');
    assert.equal(code, 0, `${text}\n${logs.filter((l) => l.startsWith('[warn]') || l.startsWith('[crash]')).slice(-20).join('\n')}`);
    for (const line of ['relaunch=10', 'window.found=1', 'window.exit=73', 'bigmap=1', 'pulseWait=0', 'soawWait=0', 'soawChild=258', 'dup.made=1', 'dup.wait=0', 'dup.child=30', 'fails=0'])
      assert.ok(text.includes(line + '\n'), `${line} missing in:\n${text}`);
    // fifteen children came and went: none of them is kept (reap), the names they held are gone
    assert.deepEqual(vm.group.vms, [vm]);
    assert.equal(vm.group.spawned, 15);
    assert.ok(!vm.kernelNamed.has('orthros-mp2-single'));
    // the parent waited on the child's process while the child wrote its 1 MiB view a hundred times: the parent, which
    // only waits, never had the bytes copied in or out at each switch (once, when the child ended)
    assert.ok(vm.group.syncBytes <= 2 << 20, `shared mapping bytes moved: ${vm.group.syncBytes}`);
  });
}

test('handle values (window handles too) of the processes of a group never overlap', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  for (let i = 0; i < 3; i++) call(vm, K, 'CreateEventA', 0, 0, 0, 0);
  const child = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  const parentHandles = new Set(), childHandles = new Set();
  for (let i = 0; i < 200; i++) { parentHandles.add(call(vm, K, 'CreateEventA', 0, 0, 0, 0)); childHandles.add(call(child, K, 'CreateEventA', 0, 0, 0, 0)); }
  // (everything in either table — windows are handles of their process's table too)
  for (const h of vm.proc.handles.map.keys()) parentHandles.add(h);
  for (const h of child.proc.handles.map.keys()) childHandles.add(h);
  const both = [...parentHandles].filter((h) => childHandles.has(h));
  assert.deepEqual(both, [], 'values handed out in both processes');
  // a table that used up its block takes another one, still the group's own
  const t = child.proc.handles; t.next = t.limit;
  const h = t.create({ type: 'event' });
  assert.ok(!vm.proc.handles.map.has(h) && h >= t.limit - 0x10000);
});

test('a named object leaves the namespace with its last handle: a process started again finds no other instance', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  const err = (v) => v.proc.threads[0].lastError;
  // one process: close, create again — a new object (ERROR_ALREADY_EXISTS before)
  const n = str(vm, 'orthros-name-test');
  const e1 = call(vm, K, 'CreateEventA', 0, 0, 0, n);
  assert.equal(err(vm), 0);
  call(vm, K, 'CloseHandle', e1);
  call(vm, K, 'CreateEventA', 0, 0, 0, n);
  assert.equal(err(vm), 0, 'a new event');
  // across processes: a child's owned mutex, the child ends (abandoned), a new child creates it: a new one
  const a = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  call(a, K, 'CreateMutexA', 0, 1, str(a, 'orthros-single'));
  assert.equal(err(a), 0);
  vm.group.exited(a, 0);
  const b = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  call(b, K, 'CreateMutexA', 0, 1, str(b, 'orthros-single'));
  assert.equal(err(b), 0, 'no other instance (183 before)');
  // a mapping keeps its name while a view of it is mapped
  const m = str(vm, 'orthros-map'), hm = call(vm, K, 'CreateFileMappingA', 0xffffffff, 0, 4, 0, 4096, m);
  const view = call(vm, K, 'MapViewOfFile', hm, 0xf001f, 0, 0, 0);
  call(vm, K, 'CloseHandle', hm);
  const again = call(vm, K, 'OpenFileMappingA', 0xf001f, 0, m);
  assert.ok(again, 'still there: a view holds it');
  call(vm, K, 'CloseHandle', again);
  call(vm, K, 'UnmapViewOfFile', view);
  assert.equal(call(vm, K, 'OpenFileMappingA', 0xf001f, 0, m), 0, 'gone with its last view');
});

test('DuplicateHandle: into and out of another process, DUPLICATE_CLOSE_SOURCE', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  const child = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  const hChild = vm.proc.handles.create(child.proc); // (CreateProcess's pi.hProcess)
  const out = vm.proc.processHeap.alloc(4, true);
  // the parent's event into the child
  const ev = call(vm, K, 'CreateEventA', 0, 1, 0, 0);
  assert.equal(call(vm, K, 'DuplicateHandle', 0xffffffff, ev, hChild, out, 0, 0, 2), 1);
  const inChild = vm.mem.read32(out);
  assert.equal(child.proc.handles.get(inChild), vm.proc.handles.get(ev));
  assert.equal(call(child, K, 'SetEvent', inChild), 1);
  assert.equal(vm.proc.handles.get(ev).signaled, true);
  // the child's event into the parent, its own handle closed (DUPLICATE_CLOSE_SOURCE)
  const ce = call(child, K, 'CreateEventA', 0, 1, 1, 0);
  const obj = child.proc.handles.get(ce);
  assert.equal(call(vm, K, 'DuplicateHandle', hChild, ce, 0xffffffff, out, 0, 0, 3), 1);
  assert.equal(vm.proc.handles.get(vm.mem.read32(out)), obj);
  assert.equal(child.proc.handles.get(ce), undefined);
  assert.equal(obj.refs, 1);
  // a process handle that is not one
  assert.equal(call(vm, K, 'DuplicateHandle', ev, ev, 0xffffffff, out, 0, 0, 2), 0);
  assert.equal(vm.proc.threads[0].lastError, 6);
});

test('a paging-file mapping shared by two processes never loses a write (several views in one process, a view mapped later)', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  const name = 'orthros-shared-31';
  const h = call(vm, K, 'CreateFileMappingA', 0xffffffff, 0, 4, 0, 4096, str(vm, name));
  const p1 = call(vm, K, 'MapViewOfFile', h, 0xf001f, 0, 0, 0);
  const child = vm.spawnProcess({ exePath: 'C:\\Test\\multiproc.exe', cmdline: 'multiproc.exe child' });
  const g = vm.group;
  const hc = call(child, K, 'OpenFileMappingA', 0xf001f, 0, str(child, name));
  const c1 = call(child, K, 'MapViewOfFile', hc, 0xf001f, 0, 0, 0);
  assert.equal(g.mappings.size, 1);
  // the parent's turn: it writes into its view, then maps a second one — which shows the write
  g.enter(vm);
  vm.mem.write32(p1, 0x1111);
  const p2 = call(vm, K, 'MapViewOfFile', h, 0xf001f, 0, 0, 0);
  assert.equal(vm.mem.read32(p2), 0x1111, 'the second view shows the first one\'s write');
  // the child's turn sees it; the parent's next turn keeps it
  g.enter(child);
  assert.equal(child.mem.read32(c1), 0x1111);
  child.mem.write32(c1 + 4, 0x2222);
  g.enter(vm);
  assert.equal(vm.mem.read32(p1), 0x1111);
  assert.equal(vm.mem.read32(p1 + 4), 0x2222);
  // a write into the second view while the first one holds the same bytes: the first (unchanged) does not win
  vm.mem.write32(p2 + 8, 0x3333);
  g.enter(child);
  assert.equal(child.mem.read32(c1 + 8), 0x3333);
  g.enter(vm);
  assert.equal(vm.mem.read32(p1 + 8), 0x3333, 'the parent\'s other view brought up to date');
  assert.equal(vm.mem.read32(p2 + 8), 0x3333);
  // and the other way round: a write into the first view while the second, later in the list, holds the old bytes
  vm.mem.write32(p1 + 12, 0x4444);
  g.enter(child);
  assert.equal(child.mem.read32(c1 + 12), 0x4444, 'a stale view overwrote the write');
  g.enter(vm);
  assert.equal(vm.mem.read32(p1 + 12), 0x4444);
  assert.equal(vm.mem.read32(p2 + 12), 0x4444);
});

test('a large paging-file mapping viewed through a small window costs what the view covers', { skip: skip('hello.exe') }, () => {
  const { vm } = boot('hello.exe');
  const call = caller();
  const h = call(vm, K, 'CreateFileMappingA', 0xffffffff, 0, 4, 4, 0, 0); // 16 GiB (dwMaximumSizeHigh = 4)
  const v = call(vm, K, 'MapViewOfFile', h, 0xf001f, 0, 0x10000, 0x10000);
  assert.ok(v, `MapViewOfFile failed: ${vm.proc.threads[0].lastError}`);
  assert.ok(vm.proc.handles.get(h).data.length <= 0x20000, 'bytes kept: up to the end of its view only');
  vm.mem.write32(v, 7);
  call(vm, K, 'UnmapViewOfFile', v);
  const w = call(vm, K, 'MapViewOfFile', h, 0xf001f, 0, 0x10000, 16);
  assert.equal(vm.mem.read32(w), 7);
  assert.equal(vm.group, null);
});

test('a child whose image does not load leaves the machine on its single-process path', { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  const dir = vm.vfs.resolve('C:\\Test').backend;
  const bad = new Uint8Array(0x200); bad[0] = 0x4d; bad[1] = 0x5a; // MZ, nothing after it
  dir.open('broken.exe', { create: true }).write(0, bad);
  const si = vm.proc.processHeap.alloc(0x44, true), pi = vm.proc.processHeap.alloc(16, true);
  assert.equal(call(vm, K, 'CreateProcessA', 0, str(vm, 'broken.exe'), 0, 0, 0, 0, 0, 0, si, pi), 0);
  assert.equal(vm.proc.threads[0].lastError, 193);
  assert.equal(vm.group, null);
  assert.equal(vm.proc.handles.limit, 0);
});

test(`at most ${MAX_LIVE_PROCESSES} processes run at once; an exited one does not count`, { skip: skip('multiproc.exe') }, () => {
  const { vm } = boot('multiproc.exe');
  const call = caller();
  const si = vm.proc.processHeap.alloc(0x44, true), pi = vm.proc.processHeap.alloc(16, true), cmd = str(vm, 'multiproc.exe child');
  for (let i = 1; i < MAX_LIVE_PROCESSES; i++) assert.equal(call(vm, K, 'CreateProcessA', 0, cmd, 0, 0, 0, 4, 0, 0, si, pi), 1);
  assert.equal(call(vm, K, 'CreateProcessA', 0, cmd, 0, 0, 0, 4, 0, 0, si, pi), 0);
  assert.equal(vm.proc.threads[0].lastError, 8); // ERROR_NOT_ENOUGH_MEMORY
  vm.group.exited(vm.group.vms[1], 0);
  assert.equal(call(vm, K, 'CreateProcessA', 0, cmd, 0, 0, 0, 4, 0, 0, si, pi), 1);
});

test('an exited child\'s machine is released: its guest memory is garbage once it ended, its handles answer still', { skip: skip('multiproc.exe') }, async () => {
  const v8 = await import('node:v8'), { runInNewContext } = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const refs = [];
  const { vm } = boot('multiproc.exe');
  const spawn = vm.spawnProcess;
  vm.spawnProcess = function (o) { const c = spawn.call(this, o); refs.push(new WeakRef(c.mem.memory)); return c; };
  const forgot = [];
  vm.host.forgetProcess = (v) => forgot.push(v.proc.pid);
  assert.equal(vm.run(), 0);
  assert.equal(refs.length, 1);
  assert.equal(forgot.length, 1, 'the host told (the render worker forgets the memory)');
  for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setImmediate(r)); }
  assert.equal(refs[0].deref(), undefined, 'the child\'s WebAssembly.Memory is still reachable');
  // the parent's handles on the child: a record of its end
  const p = [...vm.proc.handles.map.values()].find((o) => o.type === 'process' && o !== vm.proc);
  if (p) { assert.equal(p.exited, true); assert.equal(p.exitCode, 42); }
});

test('render worker: a released guest memory is forgotten, its devices destroyed, the first memory current again', async () => {
  const { OP, RingWriter } = await import('../src/gfx/cmd-ring.js');
  const { Replayer } = await import('../src/gfx/d3d-mirror.js');
  const words = new Int32Array(1 << 12), w = new RingWriter(words, () => { throw new Error('full'); });
  const a = { name: 'root memory' }, b = { name: 'child memory' };
  const replayer = new Replayer(words, { mem: a, createBackend: () => null });
  replayer.mems[1] = b;
  w.put(OP.DEVICE, 1, 1, 800, 600, 1);
  w.put(OP.MEMORY, 1);
  w.put(OP.DEVICE, 2, 1, 800, 600, 1);
  w.put(OP.FORGET, 1);
  w.put(OP.DEVICE, 3, 1, 800, 600, 1);
  replayer.run(w.produced);
  assert.equal(replayer.devices.has(2), false);
  assert.equal(replayer.mems[1], null);
  assert.equal(replayer.devices.get(1).proc.mem, a);
  assert.equal(replayer.devices.get(3).proc.mem, a);
});

test('audio: the page\'s worklet follows the machine the page follows, back to the parent when its child ends', async () => {
  const { BrowserHost } = await import('../src/host/browser-host.js');
  const posted = [];
  const host = { post: (m) => posted.push(m), audioVm: null };
  const mkAudio = () => ({ voices: null, attachVoices(sab) { this.voices = new Int32Array(sab); } });
  const parent = { audio: mkAudio(), mem: { memory: { buffer: 'parent memory' } } }, child = { audio: mkAudio(), mem: { memory: { buffer: 'child memory' } } };
  const table = () => new SharedArrayBuffer(64);
  BrowserHost.prototype.pointAudio.call(host, parent, table);
  BrowserHost.prototype.pointAudio.call(host, parent, table); // (the same machine: nothing new)
  assert.equal(posted.length, 1);
  parent.audio.voices[2] = 1; // (the worklet mixes it)
  BrowserHost.prototype.pointAudio.call(host, child, table);
  assert.equal(posted.at(-1).memory, 'child memory');
  assert.equal(parent.audio.voices[2], 0, 'the table it left: no longer mixed');
  child.audio.voices[2] = 1;
  BrowserHost.prototype.forgetProcess.call(host, child); // (the child ended)
  BrowserHost.prototype.pointAudio.call(host, parent, table);
  assert.equal(posted.length, 3);
  assert.equal(posted.at(-1).memory, 'parent memory');
  assert.equal(posted.at(-1).voices, parent.audio.voices.buffer);
});

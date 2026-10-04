// The objects the dispatcher reads on every slice and API call (the Vm, its threads, the JIT and its stats) keep the
// property set their constructor gives them: a property added later is a new hidden class for V8, and the dispatcher's
// loads of `vm.*` / `thread.*`, seeing several, went megamorphic (a stub-cache lookup each). Same keys in the same
// order is what one hidden class needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

function boot(exeName, jit) {
  const vfs = new Vfs();
  const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', t);
  t.open(exeName, { create: true }).write(0, fs.readFileSync(PE_DIR + exeName));
  // (the images gdiplus.exe loads: without them it uses the null bitmap data it gets, a fault as on Windows)
  if (exeName === 'gdiplus.exe') for (const f of ['rgb.png', 'base.jpg']) t.open(f, { create: true }).write(0, fs.readFileSync(new URL(`./fixtures/codec/${f}`, import.meta.url).pathname));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 800, height: 600 }), jit, logKinds: ['crash'] });
  return vm;
}

for (const exe of ['threads.exe', 'sync.exe', 'window.exe', 'seh.exe', 'asyncread.exe', 'dx.exe', 'dx9.exe', 'gdiplus.exe', 'net.exe']) {
  test(`${exe}: the Vm, its threads and the JIT keep their constructors' properties`, { skip: skip(exe) }, () => {
    const vm = boot(exe, true);
    const same = (o, keys, what) => { const now = Object.keys(o); assert.deepEqual(now, keys, `${what}: added ${now.filter((k) => !keys.includes(k)).join(', ')}`); };
    const vmKeys = Object.keys(vm), jitKeys = Object.keys(vm.jit), statsKeys = Object.keys(vm.jit.stats);
    vm.createProcess({ exePath: 'C:\\Test\\' + exe });
    const threadKeys = Object.keys(vm.proc.threads[0]);
    vm.run();
    same(vm, vmKeys, 'Vm');
    same(vm.jit, jitKeys, 'Jit');
    same(vm.jit.stats, statsKeys, 'Jit stats');
    assert.ok(vm.proc.threads.length >= 1);
    for (const th of vm.proc.threads) same(th, threadKeys, `thread ${th.id}`);
  });
}

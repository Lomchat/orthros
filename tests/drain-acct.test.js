// The frame accounting's entry for the deferred Direct3D queue's drain (Vm.drainTimed): each drain counted and timed on
// a sample as an API of its own (Vm.drainAcctIdx, named by Vm.acctApiName), not charged to the JavaScript API call that
// happened to follow the queued calls. Runs build/pe/dx9state.exe under the JIT (its state setters are queued).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { acct } from '../src/core/frame-acct.js';

const PE = new URL('../build/pe/dx9state.exe', import.meta.url).pathname;
const skip = !fs.existsSync(PE) && 'build/pe/dx9state.exe missing (make pe-tests)';

test('deferred queue drain: its own accounting entry, every drain counted once', { skip }, () => {
  const vfs = new Vfs(), t = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', t);
  t.open('dx9state.exe', { create: true }).write(0, fs.readFileSync(PE));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 800, height: 600 }), jit: true, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\dx9state.exe' });
  const idx = vm.drainAcctIdx, calls0 = acct.idxCalls[idx] ?? 0;
  assert.equal(vm.api.thunk(idx), undefined, 'outside the thunk table');
  assert.equal(vm.acctApiName(idx), '(deferred queue drain)');
  assert.equal(vm.run(), 0);
  const drains = vm.deferredCalls ?? 0;
  assert.ok(drains > 0, 'the program queues Direct3D calls');
  assert.equal(acct.idxCalls[idx] - calls0, drains, 'each drain counted once in its entry');
});

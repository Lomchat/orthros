// Vm.runFor ends its slice early once a file read is on the network (vm.readsInFlight > 0, set by an API the guest
// called during the slice): the host's event loop completes the read, so the parked thread is not held behind the
// whole slice. Without a read in flight the slice runs to its deadline as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vm } from '../src/core/vm.js';
import { TS } from '../src/win32/process.js';

/** A Vm whose single thread runs 0.25 ms "thread slices"; `onSlice(vm, n)` plays the guest's API calls. */
function fakeVm(onSlice) {
  const t = { id: 1, state: 1 };
  const vm = Object.create(Vm.prototype);
  Object.assign(vm, {
    started: true, readsInFlight: 0, slices: 0,
    proc: { threads: [t], moduleList: [], exe: {} },
    clock: {},
    host: { cooperative: true },
    sched: { pickRunnable: () => t, wakeBlocked: () => false },
    runThread() { const end = performance.now() + 0.25; while (performance.now() < end); const n = ++this.slices; onSlice?.(this, n); },
  });
  return vm;
}

test('runFor: a read put in flight mid-slice ends the slice after ~2 ms with the shared running result', () => {
  const plain = fakeVm();
  let t0 = performance.now();
  const shared = plain.runFor(t0 + 12);
  const plainMs = performance.now() - t0;
  assert.equal(shared.state, 'running');
  assert.ok(plainMs >= 12, `no read: the slice runs to its deadline (${plainMs.toFixed(2)} ms)`);
  assert.ok(plain.slices >= 10);

  const vm = fakeVm((v, n) => { if (n === 3) v.readsInFlight = 1; }); // (ReadFile parks its thread on a network read)
  t0 = performance.now();
  const r = vm.runFor(t0 + 12);
  const ms = performance.now() - t0;
  assert.equal(r, shared, 'the shared result object (no allocation per slice)');
  assert.ok(ms >= 2 && ms < 7, `ended about 2 ms after the start: ${ms.toFixed(2)} ms`);
  // a later call with the read still in flight: one slice of at least 2 ms again, not 12
  t0 = performance.now();
  assert.equal(vm.runFor(t0 + 12), shared);
  assert.ok(performance.now() - t0 < 7);
  // the read done: full slices again
  vm.readsInFlight = 0;
  t0 = performance.now();
  vm.runFor(t0 + 12);
  assert.ok(performance.now() - t0 >= 12);
});

test('runFor: an unbounded run (untilMs Infinity) is not cut by reads in flight', () => {
  const vm = fakeVm((v, n) => { v.readsInFlight = 1; if (n === 30) v.proc.threads[0].state = TS.DONE; });
  const t = vm.proc.threads[0];
  Object.assign(t, { exitCode: 0, cpu: { eax: 0 } });
  vm.sched.pickRunnable = () => (t.state === TS.DONE ? null : t);
  vm.finish = (c) => c;
  const r = vm.runFor(Infinity);
  assert.deepEqual(r, { state: 'exited', code: 0 });
  assert.equal(vm.slices, 30);
});

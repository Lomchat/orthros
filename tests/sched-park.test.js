// Scheduler.park: the wait of a hot handler (Sleep, WaitForSingleObject) parks its thread by returning PARK — the wait
// left in thread.parkWait — where block() throws WaitUnwind; the same outcomes otherwise (condition already true,
// timeout already passed, nested context, re-executed call after the wake-up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, WaitUnwind, PARK, INFINITE } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';

function fakeVm(unwind = true) {
  const clock = new VirtualClock();
  const vm = { clock, proc: { threads: [], timers: [] }, warn() {}, logFn() {}, canUnwind: () => unwind };
  vm.sched = new Scheduler(vm);
  return vm;
}
const NEVER = () => false;

test('park: PARK and the wait record at top level, where block throws the same record', () => {
  const vm = fakeVm(), s = vm.sched, t = { id: 1, state: TS.RUNNING };
  vm.clock.sleep(100);
  assert.equal(s.park(t, NEVER, 5, 'sleep'), PARK);
  assert.deepEqual([t.parkWait.deadline, t.parkWait.reason, t.parkWait.cond], [105, 'sleep', NEVER]);
  let thrown = null;
  try { s.block(t, NEVER, 5, 'sleep'); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof WaitUnwind);
  assert.deepEqual([thrown.wait.deadline, thrown.wait.reason], [105, 'sleep']);
  assert.equal(s.park(t, NEVER, INFINITE, 'wait'), PARK);
  assert.equal(t.parkWait.deadline, Infinity);
});

test('park: no parking when the condition holds, the timeout is 0, or the context cannot unwind', () => {
  const vm = fakeVm(), s = vm.sched, t = { id: 1, state: TS.RUNNING };
  let claimed = 0;
  assert.equal(s.park(t, () => true, 10, 'wait', () => ++claimed), true);
  assert.equal(t.wakeValue, 1, 'the claim runs at once');
  assert.equal(s.park(t, NEVER, 0, 'wait'), false, 'a poll times out at once');
  // nested: runs the other threads on top of the frame until the deadline (none here: the virtual clock sleeps)
  const nested = fakeVm(false), n = nested.sched, u = { id: 2, state: TS.RUNNING };
  nested.proc.threads.push(u);
  assert.equal(n.park(u, NEVER, 20, 'sleep'), false);
  assert.equal(nested.clock.now(), 20);
});

test('park: the re-executed call returns the outcome recorded at the wake-up', () => {
  const vm = fakeVm(), s = vm.sched, t = { id: 1, state: TS.BLOCKED, wakeAt: 50 };
  vm.proc.threads.push(t);
  assert.equal(s.park(t, NEVER, 50, 'sleep'), PARK);
  t.wait = t.parkWait; t.parkWait = null; // (what the dispatcher does)
  vm.clock.sleep(60);
  assert.equal(s.wakeBlocked(), true);
  assert.equal(t.state, TS.READY);
  assert.equal(s.park(t, NEVER, 50, 'sleep'), false, 'timed out');
  assert.equal(t.state, TS.RUNNING);
  assert.equal(t.wakeResult, undefined);
});

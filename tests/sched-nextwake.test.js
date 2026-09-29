// Scheduler.nextWake: a process timer already due when the parked waits were last checked (a window timer whose thread
// is busy or waits for something else) must not make the idle loop spin: the next wake-up is the earliest *future* one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';

function fakeVm() {
  const clock = new VirtualClock();
  const vm = { clock, proc: { threads: [], timers: [] }, warn() {}, logFn() {} };
  vm.sched = new Scheduler(vm);
  return vm;
}
const parked = (vm, id, cond, deadline) => {
  const t = { id, state: TS.BLOCKED, wait: { cond, deadline }, wakeAt: deadline };
  vm.proc.threads.push(t);
  return t;
};

test('nextWake: timers due at the last check are left out, later ones and thread deadlines count', () => {
  const vm = fakeVm(), s = vm.sched;
  vm.clock.sleep(1000);
  const sleeper = parked(vm, 1, () => false, 1050); // (a Sleep(50))
  vm.proc.timers.push({ kind: 'wm', due: 900, thread: {} }); // (overdue: its thread does not retrieve messages now)
  assert.equal(s.nextWake(), 900, 'before any check, an overdue timer is a wake-up (nobody looked at it yet)');
  assert.equal(s.wakeBlocked(), false);
  assert.equal(s.nextWake(), 1050, 'checked and overdue: the next wake-up is the sleeper\'s');
  vm.proc.timers.push({ kind: 'wm', due: 1020, thread: {} });
  assert.equal(s.nextWake(), 1020, 'a timer due after the check counts');
  vm.clock.sleep(30); // (1030: that timer now due as well)
  assert.equal(s.wakeBlocked(), false);
  assert.equal(s.nextWake(), 1050);
  vm.clock.sleep(20);
  assert.equal(s.wakeBlocked(), true, 'the sleeper wakes at its deadline');
  assert.equal(sleeper.state, TS.READY);
  assert.equal(s.nextWake(), Infinity);
});

test('idle(): with an overdue timer nobody waits for, it sleeps until the next deadline instead of returning at once', () => {
  const vm = fakeVm(), s = vm.sched;
  const sleeper = parked(vm, 1, () => false, 40);
  vm.proc.timers.push({ kind: 'wm', due: 0, thread: {} });
  vm.clock.sleep(5);
  s.idle();
  assert.equal(vm.clock.now(), 40, 'one idle step sleeps to the deadline');
  assert.equal(sleeper.state, TS.READY);
});

test('a timer a parked thread waits for still wakes it when due', () => {
  const vm = fakeVm(), s = vm.sched;
  const tm = { kind: 'wm', due: 25, thread: {} };
  vm.proc.timers.push(tm);
  const waiter = parked(vm, 1, () => vm.clock.now() >= tm.due, Infinity); // (GetMessage: a due timer is a message)
  s.idle();
  assert.equal(vm.clock.now(), 25);
  assert.equal(waiter.state, TS.READY);
});

test('a timer set with elapse 0 at the very time of the last check still wakes its waiter at the next idle step', () => {
  const vm = fakeVm(), s = vm.sched;
  vm.clock.sleep(10);
  const timers = vm.proc.timers;
  const waiter = parked(vm, 1, () => timers.some((t) => t.due <= vm.clock.now()), Infinity);
  assert.equal(s.wakeBlocked(), false); // (checkedAt = 10)
  timers.push({ kind: 'wm', due: 10, thread: {} }); // (another thread's SetTimer(..., 0) at the same virtual time)
  assert.equal(s.nextWake(), Infinity, 'due at the check time: not a future wake-up');
  s.idle(); // (the idle step checks the waits first)
  assert.equal(waiter.state, TS.READY);
  assert.equal(vm.clock.now(), 10, 'no sleep needed');
});

test('nested wait: the waiting thread\'s own timer falling due is seen even though it is not a parked wait', () => {
  const vm = fakeVm(), s = vm.sched;
  const me = { id: 1, state: TS.RUNNING, wakeAt: Infinity, isRunnable: () => false };
  vm.proc.threads.push(me);
  const other = parked(vm, 2, () => false, 50); other.isRunnable = () => false; // (keeps a finite wake-up so the loop sleeps rather than deadlocks)
  const tm = { kind: 'wm', due: 30, thread: me };
  vm.proc.timers.push(tm);
  vm.canUnwind = () => false;
  vm.runThread = () => assert.fail('nothing runnable');
  const ok = s.block(me, () => vm.clock.now() >= tm.due, 0xffffffff, 'getmessage');
  assert.equal(ok, true);
  assert.equal(vm.clock.now(), 30, 'woke at the timer, not at the other thread\'s deadline');
  assert.equal(other.state, TS.BLOCKED);
});

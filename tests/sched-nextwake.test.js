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

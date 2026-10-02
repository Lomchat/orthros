// Scheduler.yieldFrom (Sleep(0), SwitchToThread) at top level: the slice ends only when another thread can run — one
// ready, or one whose wait the scheduler pass ends now (a deadline passed, a condition holds) — otherwise the call
// returns false at once and the thread keeps its slice, as Windows returns without switching. Nested: unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';

function setup(unwind = true) {
  const clock = new VirtualClock();
  const vm = { clock, proc: { threads: [], timers: [] }, warn() {}, logFn() {}, canUnwind: () => unwind, runThread: (t) => { vm.ran = t; } };
  vm.sched = new Scheduler(vm);
  const mk = (id, state) => { const t = { id, state, onStack: 0, wakeAt: Infinity, isRunnable() { return this.state === TS.READY && this.onStack === 0; } }; vm.proc.threads.push(t); return t; };
  return { vm, s: vm.sched, mk };
}

test('yield with no other thread able to run: false, the slice goes on', () => {
  const { s, mk } = setup(), t = mk(1, TS.RUNNING);
  mk(2, TS.BLOCKED).wait = { cond: () => false, deadline: Infinity };
  assert.equal(s.yieldFrom(t), false);
  assert.ok(!t.yieldRequested);
});

test('yield with a ready thread: true, the slice ends', () => {
  const { s, mk } = setup(), t = mk(1, TS.RUNNING);
  mk(2, TS.READY);
  assert.equal(s.yieldFrom(t), true);
  assert.equal(t.yieldRequested, true);
});

test('yield wakes a thread whose wait is over (deadline passed, condition true) and ends the slice', () => {
  for (const kind of ['deadline', 'cond']) {
    const { vm, s, mk } = setup(), t = mk(1, TS.RUNNING), u = mk(2, TS.BLOCKED);
    u.wait = kind === 'deadline' ? { cond: () => false, deadline: 5 } : { cond: () => true, deadline: Infinity };
    vm.clock.sleep(10);
    assert.equal(s.yieldFrom(t), true, kind);
    assert.equal(u.state, TS.READY, kind);
    assert.equal(t.yieldRequested, true, kind);
  }
});

test('nested yield runs another thread on top of the frame, or returns false', () => {
  const { vm, s, mk } = setup(false), t = mk(1, TS.RUNNING);
  assert.equal(s.yieldFrom(t), false);
  const u = mk(2, TS.READY);
  assert.equal(s.yieldFrom(t), true);
  assert.equal(vm.ran, u);
});

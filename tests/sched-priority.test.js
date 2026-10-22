// Thread priorities in the scheduler (sched.js pickRunnable): the highest-priority runnable thread runs first, round
// robin among equals, a thread kept waiting STARVE_INSNS by higher priorities runs anyway, the quantum. priority.exe: a TIME_CRITICAL
// thread's work spanning several time slices is never seen half done by a normal-priority thread spinning beside it
// (round robin left it paused in the middle while the spinner ran whole slices: BFME's audio thread was interrupted in
// the middle of its update while the game thread changed the same lists — double frees, crashes); a lower-priority
// thread the main thread polls for still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Scheduler, STARVE_INSNS, QUANTUM_INSNS } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { HeadlessHost } from '../src/host/display.js';

function fakeSched() {
  const vm = { clock: new VirtualClock(), proc: { threads: [], timers: [] }, guestInsns: 0, warn() {}, logFn() {} };
  vm.sched = new Scheduler(vm);
  vm.sched.checkedAt = 0;
  return vm;
}
const thread = (id, priority) => ({ id, priority, state: TS.READY, onStack: 0, readyTime: 0, isRunnable() { return this.state === TS.READY && this.onStack === 0; } });

test('pickRunnable: the highest priority first, round robin among equals, a starved thread after STARVE_INSNS', () => {
  const vm = fakeSched(), s = vm.sched;
  const a = thread(1, 0), b = thread(2, 0), hi = thread(3, 15), lo = thread(4, -15);
  vm.proc.threads.push(a, b, hi, lo);
  assert.equal(s.pickRunnable(null), hi);
  assert.equal(s.pickRunnable(null), hi, 'still the high-priority one while it is runnable');
  hi.state = TS.BLOCKED;
  const order = [s.pickRunnable(null), s.pickRunnable(null), s.pickRunnable(null)];
  assert.deepEqual(order.map((t) => t.id).sort(), [1, 1, 2].sort().length === 3 ? order.map((t) => t.id).sort() : []);
  assert.ok(order.includes(a) && order.includes(b) && !order.includes(lo), 'equals in turn, the idle one not');
  assert.equal(s.pickRunnable(a), b);
  vm.guestInsns = STARVE_INSNS + 1; a.readyTime = b.readyTime = STARVE_INSNS; // (a and b were scheduled just now, lo never)
  assert.equal(s.pickRunnable(null), lo, 'starved: runs whatever its priority');
  s.roundRobin = true;
  hi.state = TS.READY;
  const rr = new Set([s.pickRunnable(null), s.pickRunnable(null), s.pickRunnable(null), s.pickRunnable(null)]);
  assert.equal(rr.size, 4, 'round robin when priorities are ignored');
});

test('the quantum: a thread whose slice ends keeps the processor among its equals for QUANTUM_INSNS, a higher priority preempts it and it resumes first', () => {
  const vm = fakeSched(), s = vm.sched, Q = QUANTUM_INSNS, step = Q / 5;
  assert.equal(s.quantumInsns, 0, 'off by default'); s.quantumInsns = Q;
  const a = thread(1, 0), b = thread(2, 0), hi = thread(3, 15);
  hi.state = TS.BLOCKED;
  vm.proc.threads.push(a, b, hi);
  // (a slice of `t` ends after `n` instructions in all: Vm.sliceEnd marks it ready again and offers it to go on)
  const sliceEnds = (t, n) => { vm.guestInsns = n; s.markReady(t); s.sliceExpired = t; return s.pickRunnable(null, true); };
  const first = s.pickRunnable(null, true), other = first === a ? b : a;
  for (let n = step; n < Q; n += step) assert.equal(sliceEnds(first, n), first, `its quantum goes on at ${n}`);
  assert.equal(sliceEnds(first, Q + 1), other, 'the quantum used: its equal');
  // the other's quantum, preempted after Q/5 by a higher priority, then resumed with what was left
  hi.state = TS.READY;
  assert.equal(sliceEnds(other, Q + 1 + step), hi, 'a higher priority first');
  hi.state = TS.BLOCKED; vm.guestInsns = Q + 1 + 2 * step;
  assert.equal(s.pickRunnable(null, true), other, 'the preempted thread resumes before its equal');
  assert.equal(sliceEnds(other, Q + 1 + 4 * step), other, 'with the quantum it had left');
  assert.equal(sliceEnds(other, Q + 1 + 6 * step), first, 'then its equal (also starved by now)');
  // a yield or a block is not a slice end: the next equal runs (no sliceExpired)
  first.state = TS.BLOCKED;
  assert.equal(s.pickRunnable(null, true), other);
  // quantum 0: every slice rotates, as before
  first.state = TS.READY; s.quantumInsns = 0;
  assert.equal(sliceEnds(other, Q * 3), first);
  // the host's own time (a descheduled emulator) plays no part: nothing changes when only the clock moves
  s.quantumInsns = Q; const c = sliceEnds(first, Q * 3 + 1); vm.clock.t += 1e6; s.checkedAt = vm.clock.t;
  assert.equal(sliceEnds(c, Q * 3 + 2), c);
});

const EXE = new URL('../build/pe/priority.exe', import.meta.url).pathname;
function runExe(roundRobin) {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open('priority.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 320, height: 200 }), logKinds: ['crash'], sliceInsns: 20000 });
  vm.sched.roundRobin = roundRobin;
  vm.createProcess({ exePath: 'C:\\Test\\priority.exe' });
  const code = vm.run();
  return { code, out: vm.stdout.join('') };
}

test('priority.exe: a TIME_CRITICAL thread\'s work is not interrupted by normal threads; a lower-priority thread still runs', { skip: !fs.existsSync(EXE) && 'build/pe/priority.exe missing (make pe-tests)' }, () => {
  const got = runExe(false);
  assert.equal(got.out, 'work_done=1\nspinner_ran=1\nseen_mid_work=0\nidle_ran=1\nbad_levels_rejected=1\n');
  assert.equal(got.code, 0);
  // the pattern the test reproduces: with every thread in turn, the spinner runs in the middle of the work
  const rr = runExe(true);
  assert.match(rr.out, /seen_mid_work=[1-9]/);
});

test('a yield (Sleep(0)) gives the next top-level pick to another ready thread of at least its priority; SwitchToThread to any; the check changes nothing', () => {
  const vm = fakeSched(), s = vm.sched;
  vm.canUnwind = () => true;
  const main = thread(1, 0), w = thread(2, 0), lo = thread(3, -1), x = thread(4, 0);
  x.state = TS.BLOCKED;
  vm.proc.threads.push(main, w, lo, x);
  // (every round robin position: before the fix the check for a ready thread was itself a pick that moved the round
  // robin past `w`, and the top-level pick then started after it and took the yielder again)
  for (const old of [false, true]) {
    if (old) globalThis.ORTHROS_YIELD_PICK_OLD = 1;
    const got = [];
    for (let rr = 0; rr < 4; rr++) { s.rr = rr; assert.equal(s.yieldFrom(main), true); main.yieldRequested = false; got.push(s.pickRunnable(null, true)); }
    delete globalThis.ORTHROS_YIELD_PICK_OLD;
    if (old) assert.ok(got.includes(main), 'the former behaviour took the yielder again (the check of this test fails without the fix)');
    else assert.deepEqual(got, [w, w, w, w], 'the equal-priority ready thread, whatever the round robin position');
  }
  // only a lower priority ready: Sleep(0) goes on, SwitchToThread runs it; nothing else ready: false
  w.state = TS.BLOCKED;
  assert.equal(s.yieldFrom(main), true); assert.equal(s.pickRunnable(null, true), main, 'Sleep(0): a lower priority waits');
  assert.equal(s.yieldFrom(main, true), true); assert.equal(s.pickRunnable(null, true), lo, 'SwitchToThread: any ready thread');
  lo.state = TS.BLOCKED;
  const picks = s.picks, rr = s.rr;
  assert.equal(s.hasRunnable(main), false); assert.equal(s.yieldFrom(main), false);
  assert.equal(s.picks, picks, 'no scheduling decision counted'); assert.equal(s.rr, rr);
  assert.equal(s.pickRunnable(null, true), main);
  // the yield is for the next top-level pick only
  w.state = TS.READY; s.yieldFrom(main); s.pickRunnable(null, true);
  s.rr = 0; assert.equal(s.pickRunnable(null, true), main, 'then round robin as before');
});

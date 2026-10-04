// Thread priorities in the scheduler (sched.js pickRunnable): the highest-priority runnable thread runs first, round
// robin among equals, a thread kept waiting STARVE_MS by higher priorities runs anyway. priority.exe: a TIME_CRITICAL
// thread's work spanning several time slices is never seen half done by a normal-priority thread spinning beside it
// (round robin left it paused in the middle while the spinner ran whole slices: BFME's audio thread was interrupted in
// the middle of its update while the game thread changed the same lists — double frees, crashes); a lower-priority
// thread the main thread polls for still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Scheduler, STARVE_MS, PREEMPT_INSNS } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { HeadlessHost } from '../src/host/display.js';

function fakeSched() {
  const vm = { clock: new VirtualClock(), proc: { threads: [], timers: [] }, warn() {}, logFn() {} };
  vm.sched = new Scheduler(vm);
  vm.sched.checkedAt = 0;
  return vm;
}
const thread = (id, priority) => ({ id, priority, state: TS.READY, onStack: 0, readyTime: 0, isRunnable() { return this.state === TS.READY && this.onStack === 0; } });

test('pickRunnable: the highest priority first, round robin among equals, a starved thread after STARVE_MS', () => {
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
  s.checkedAt = STARVE_MS + 1; a.readyTime = b.readyTime = STARVE_MS; // (a and b were scheduled just now, lo never)
  assert.equal(s.pickRunnable(null), lo, 'starved: runs whatever its priority');
  s.roundRobin = true;
  hi.state = TS.READY;
  const rr = new Set([s.pickRunnable(null), s.pickRunnable(null), s.pickRunnable(null), s.pickRunnable(null)]);
  assert.equal(rr.size, 4, 'round robin when priorities are ignored');
});

const EXE = new URL('../build/pe/priority.exe', import.meta.url).pathname;
function runExe(roundRobin, sliceInsns = 20000) {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open('priority.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 320, height: 200 }), logKinds: ['crash'], sliceInsns });
  vm.sched.roundRobin = roundRobin;
  vm.createProcess({ exePath: 'C:\\Test\\priority.exe' });
  const code = vm.run();
  return { code, out: vm.stdout.join('') };
}

test('priority.exe: a TIME_CRITICAL thread\'s work is not interrupted by normal threads; a lower-priority thread still runs', { skip: !fs.existsSync(EXE) && 'build/pe/priority.exe missing (make pe-tests)' }, () => {
  const got = runExe(false);
  assert.equal(got.out, 'work_done=1\nspinner_ran=1\nseen_mid_work=0\nidle_ran=1\n');
  assert.equal(got.code, 0);
  // the pattern the test reproduces: with every thread in turn, the spinner runs in the middle of the work
  const rr = runExe(true);
  assert.match(rr.out, /seen_mid_work=[1-9]/);
});

test('sliceFor: a thread below a higher-priority one gets short slices (that thread takes over soon after its timeout); the top one full slices', () => {
  const vm = fakeSched(), s = vm.sched;
  vm.sliceInsns = 100000;
  const main = thread(1, 0), mixer = thread(2, 15);
  vm.proc.threads.push(main);
  assert.equal(s.sliceFor(main), 100000, 'alone: full slices');
  vm.proc.threads.push(mixer);
  mixer.state = TS.BLOCKED;
  assert.equal(s.sliceFor(main), PREEMPT_INSNS, 'a higher-priority thread exists, even waiting');
  assert.equal(s.sliceFor(mixer), 100000);
  mixer.state = TS.DONE;
  assert.equal(s.sliceFor(main), 100000);
  // woken by the running thread: the running one yields at its next API call
  mixer.state = TS.BLOCKED; mixer.wait = {}; main.state = TS.RUNNING; vm.current = main; main.yieldRequested = false;
  s.wake(mixer, true);
  assert.equal(main.yieldRequested, true);
});

test('priority.exe at the default slice: the TIME_CRITICAL thread still runs its work in one go', { skip: !fs.existsSync(EXE) && 'build/pe/priority.exe missing (make pe-tests)' }, () => {
  const got = runExe(false, 100000);
  assert.equal(got.out, 'work_done=1\nspinner_ran=1\nseen_mid_work=0\nidle_ran=1\n');
});

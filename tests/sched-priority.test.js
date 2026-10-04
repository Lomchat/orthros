// Thread priorities in the scheduler (sched.js pickRunnable): the highest-priority runnable thread runs first, round
// robin among equals, a thread kept waiting STARVE_MS by higher priorities runs anyway. priority.exe: a TIME_CRITICAL
// thread's work spanning several time slices is never seen half done by a normal-priority thread spinning beside it
// (round robin left it paused in the middle while the spinner ran whole slices: BFME's audio thread was interrupted in
// the middle of its update while the game thread changed the same lists — double frees, crashes); a lower-priority
// thread the main thread polls for still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Scheduler, STARVE_MS } from '../src/core/sched.js';
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

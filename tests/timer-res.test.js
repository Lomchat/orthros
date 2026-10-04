// The system timer resolution (core/timer-res.js): timed waits end at the clock interrupt (15.625 ms by default, the
// smallest timeBeginPeriod request otherwise), GetTickCount steps by the 15.625 ms tick whatever the resolution,
// timeGetTime by the interrupt; the same values from the JIT's fast paths as from the handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TimerResolution, DEFAULT_TIMER_RES } from '../src/core/timer-res.js';
import { Scheduler, PARK, INFINITE } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { TS } from '../src/win32/process.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';
import { TICK_BASE } from '../src/cpu/jit/runtime.js';

test('TimerResolution: requests, ticks, tick counters', () => {
  const r = new TimerResolution();
  assert.equal(r.ms, DEFAULT_TIMER_RES);
  assert.equal(r.tickAt(1), 15.625, 'Sleep(1) from 0: the next tick');
  assert.equal(r.tickAt(15.625), 15.625, 'a deadline on a tick is that tick');
  assert.equal(r.tickAt(16), 31.25);
  // GetTickCount: 15 / 16 ms steps
  assert.deepEqual([0, 15.6, 15.625, 31.2, 31.25, 46.875, 62.5].map((t) => r.tickCount(t)), [0, 0, 15, 15, 31, 46, 62]);
  assert.equal(r.mmTime(20), 15);
  assert.equal(r.begin(0), false, 'period 0: TIMERR_NOCANDO');
  assert.equal(r.begin(5), true); assert.equal(r.ms, 5);
  assert.equal(r.begin(1), true); assert.equal(r.begin(1), true); assert.equal(r.ms, 1);
  assert.equal(r.tickAt(10.3 + 1), 12, 'Sleep(1) under timeBeginPeriod(1): 1 to 2 ms');
  assert.equal(r.mmTime(10.7), 10);
  assert.equal(r.tickCount(20.5), 15, 'GetTickCount keeps the 15.625 ms tick under timeBeginPeriod');
  assert.equal(r.end(1), true); assert.equal(r.ms, 1, 'one request of 1 ms left');
  assert.equal(r.end(1), true); assert.equal(r.ms, 5);
  assert.equal(r.end(1), false, 'no matching begin');
  assert.equal(r.end(5), true); assert.equal(r.ms, DEFAULT_TIMER_RES);
  assert.equal(r.end(200), false);
  // the switch's 0: the exact behaviour (no rounding anywhere)
  const exact = new TimerResolution(0);
  exact.begin(1);
  assert.deepEqual([exact.ms, exact.tickAt(10.3), exact.tickCount(20.5), exact.mmTime(20.5)], [0, 10.3, 20, 20]);
  assert.equal(r.tickAt(Infinity), Infinity);
});

test('Scheduler: a guest timeout ends at a tick, the emulator\'s own waits are exact', () => {
  const clock = new VirtualClock();
  const vm = { clock, proc: { threads: [], timers: [] }, warn() {}, logFn() {}, canUnwind: () => true, timerRes: new TimerResolution() };
  const s = vm.sched = new Scheduler(vm), t = { id: 1, state: TS.RUNNING };
  clock.sleep(100);
  const never = () => false;
  assert.equal(s.park(t, never, 1, 'sleep', undefined, true), PARK);
  assert.equal(t.parkWait.deadline, 109.375, 'Sleep(1) at 100 ms: the tick at 109.375');
  assert.equal(s.park(t, never, 1, 'sleep'), PARK);
  assert.equal(t.parkWait.deadline, 101, 'not a guest timeout: exact');
  assert.equal(s.park(t, never, INFINITE, 'wait', undefined, true), PARK);
  assert.equal(t.parkWait.deadline, Infinity);
  assert.equal(s.park(t, never, 0, 'wait', undefined, true), false, 'a poll still times out at once');
  vm.timerRes.begin(1);
  assert.equal(s.park(t, never, 1, 'sleep', undefined, true), PARK);
  assert.equal(t.parkWait.deadline, 101);
  clock.sleep(0.25);
  assert.equal(s.park(t, never, 1, 'sleep', undefined, true), PARK);
  assert.equal(t.parkWait.deadline, 102);
});

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

test('handlers: GetTickCount, timeGetTime, timeBeginPeriod, Sleep and WaitForSingleObject timeouts', { skip }, () => {
  const vfs = new Vfs(); const b = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', b);
  b.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 64, height: 64 }), logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, frame = vm.proc.processHeap.alloc(64, true), th = vm.proc.threads[0];
  const call = (dll, name, ...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = th; c.cpu = th.cpu; c.sp = frame;
    const r = vm.api.lookup(dll, name).fn(c); return r === PARK || r === undefined ? r : r >>> 0;
  };
  clock.t = 40;
  assert.equal(call('kernel32.dll', 'GetTickCount'), (TICK_BASE + 31) >>> 0);
  assert.equal(call('winmm.dll', 'timeGetTime'), (TICK_BASE + 31) >>> 0);
  // (outside the dispatcher the waits are nested: the virtual clock sleeps to the deadline)
  call('kernel32.dll', 'Sleep', 1);
  assert.equal(clock.t, 46.875, 'Sleep(1) at 40 ms: until the tick at 46.875 ms');
  clock.t = 40;
  assert.equal(call('winmm.dll', 'timeBeginPeriod', 0), 97, 'TIMERR_NOCANDO');
  assert.equal(call('winmm.dll', 'timeBeginPeriod', 1), 0);
  assert.equal(call('kernel32.dll', 'GetTickCount'), (TICK_BASE + 31) >>> 0);
  assert.equal(call('winmm.dll', 'timeGetTime'), (TICK_BASE + 40) >>> 0);
  call('kernel32.dll', 'Sleep', 1);
  assert.equal(clock.t, 41);
  const ev = call('kernel32.dll', 'CreateEventA', 0, 1, 0, 0);
  clock.t = 40.5;
  assert.equal(call('kernel32.dll', 'WaitForSingleObject', ev, 3), 0x102);
  assert.equal(clock.t, 44, 'a 3 ms timeout from 40.5 ms: the interrupt at 44 ms');
  assert.equal(call('winmm.dll', 'timeEndPeriod', 1), 0);
  assert.equal(call('winmm.dll', 'timeEndPeriod', 1), 97, 'no matching timeBeginPeriod');
  clock.t = 40.5;
  assert.equal(call('kernel32.dll', 'WaitForSingleObject', ev, 3), 0x102);
  assert.equal(clock.t, 46.875);
});

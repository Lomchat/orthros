// PeekMessage polling (user32.js peekIdle): a thread calling PeekMessage with nothing to get, over and over, waits in
// short steps instead of spinning, and spins again around the time its previous bouts of polling ended, so that a
// frame limiter polling its clock is not made late. Driven on the virtual clock (outside the dispatcher the waits are
// nested: the clock sleeps through them): a guest frame loop — some API calls, then PeekMessage + a clock read until
// its deadline — with each polling iteration costing 1 µs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PARK } from '../src/core/sched.js';
import { VirtualClock } from '../src/core/clock.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

function setup() {
  const vfs = new Vfs(); const b = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', b);
  b.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 64, height: 64 }), logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, frame = vm.proc.processHeap.alloc(64, true), msg = vm.proc.processHeap.alloc(64, true), th = vm.proc.threads[0];
  const call = (dll, name, ...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    th.apiCalls++; vm.apiCalls++; // (as the dispatcher counts them)
    const c = new Ctx(vm); c.thread = th; c.cpu = th.cpu; c.sp = frame;
    const r = vm.api.lookup(dll, name).fn(c); return r === PARK || r === undefined ? r : r >>> 0;
  };
  const peek = () => call('user32.dll', 'PeekMessageA', msg, 0, 0, 0, 1);
  return { vm, clock, th, call, peek };
}

/**
 * `frames` frames of a limiter: `work` ms of other calls (8 API calls), then PeekMessage until the clock reaches the
 * deadline (`rel`: the previous frame's start + period, else the next multiple of the period); returns the frame start
 * times and the PeekMessage calls of each frame. `period` may be a function of the frame index.
 */
function limiter(env, frames, period, work = 12, rel = true) {
  const { clock, call, peek } = env, starts = [], peeks = [];
  let start = clock.now();
  for (let f = 0; f < frames; f++) {
    starts.push(start);
    for (let i = 0; i < 8; i++) { call('kernel32.dll', 'GetLastError'); clock.t += work / 8; }
    const p = typeof period === 'function' ? period(f) : period;
    const deadline = rel ? start + p : (Math.floor(start / p) + 1) * p;
    let n = 0;
    while (clock.now() < deadline) { peek(); n++; clock.t += 0.001; }
    peeks.push(n);
    start = clock.now();
  }
  return { starts, peeks };
}

test('PeekMessage polling waits, and frames start on time once the polling rate is known', { skip }, () => {
  const env = setup();
  const { starts, peeks } = limiter(env, 40, 100 / 3);
  const st = env.th.peekIdle;
  assert.ok(st.parks > 0, 'the polling waited');
  // without waits each frame polls ~21 ms at 1 µs per call: ~21 000 calls
  for (let f = 6; f < 40; f++) assert.ok(peeks[f] < 1500, `frame ${f}: ${peeks[f]} PeekMessage calls`);
  // the frame intervals: as without waits (the deadline plus at most one polling iteration) once learned
  for (let f = 6; f < 39; f++) { const d = starts[f + 1] - starts[f] - 100 / 3; assert.ok(d >= 0 && d < 0.01, `frame ${f}: ${d.toFixed(4)} ms late`); }
  // before the estimate (the first frames), late by at most one short wait
  for (let f = 0; f < 39; f++) assert.ok(starts[f + 1] - starts[f] - 100 / 3 < 0.3, `frame ${f}`);
});

test('PeekMessage polling: an absolute deadline rule and a higher rate are followed', { skip }, () => {
  const env = setup();
  const a = limiter(env, 30, 25, 10, false);
  for (let f = 6; f < 29; f++) { const d = a.starts[f + 1] % 25; assert.ok(d < 0.01 || d > 24.99, `frame ${f}: ${d.toFixed(4)}`); }
  // the rate goes up (25 -> 12.5 ms): a few frames late at most by a long wait, then on time again
  const b = limiter(env, 40, 12.5, 4, true);
  let late = 0;
  for (let f = 0; f < 39; f++) { const d = b.starts[f + 1] - b.starts[f] - 12.5; if (d > 0.01) late++; if (f > 12) assert.ok(d < 0.01, `frame ${f}: ${d.toFixed(4)} ms late`); assert.ok(d < 4.5, `frame ${f}: ${d.toFixed(3)}`); }
  assert.ok(late <= 6, `${late} late frames`);
});

test('PeekMessage polling: waits that last longer than asked (a coarse host timer) widen the margin', { skip }, () => {
  const env = setup();
  // every wait ends at the next whole millisecond after its deadline, plus 0.5 ms
  env.vm.host.waitEvent = (ms) => { const c = env.clock; c.sleepUntil(Math.ceil(c.now() + ms) + 0.5); };
  const { starts } = limiter(env, 60, 100 / 3);
  let late = 0;
  for (let f = 10; f < 59; f++) { const d = starts[f + 1] - starts[f] - 100 / 3; if (d > 0.01) late++; assert.ok(d < 2, `frame ${f}: ${d.toFixed(3)} ms late`); }
  assert.ok(late <= 2, `${late} frames late after the first ten`);
  assert.ok(env.th.peekIdle.over > 0.5, 'the overshoot is known');
  // a 15.625 ms system timer: the first frames late, then on time (spinning where a wait would overshoot)
  const env2 = setup();
  env2.vm.host.waitEvent = (ms) => { const c = env2.clock; c.sleepUntil(Math.ceil((c.now() + ms) / 15.625) * 15.625); };
  const r = limiter(env2, 80, 100 / 3);
  for (let f = 30; f < 79; f++) { const d = r.starts[f + 1] - r.starts[f] - 100 / 3; assert.ok(d < 0.01, `15.625 ms timer, frame ${f}: ${d.toFixed(3)} ms late`); }
});

test('PeekMessage: no wait with ORTHROS_PEEK_IDLE_MS=0, nor when other calls come between, nor with a message', { skip }, () => {
  globalThis.ORTHROS_PEEK_IDLE_MS = 0;
  try {
    const env = setup();
    const t0 = env.clock.now();
    for (let i = 0; i < 5000; i++) { env.peek(); env.clock.t += 0.001; }
    assert.ok(Math.abs(env.clock.now() - t0 - 5) < 1e-6, 'the clock moved by the polling only');
    assert.equal(env.th.peekIdle, null);
  } finally { globalThis.ORTHROS_PEEK_IDLE_MS = undefined; }
  { // two other API calls between the polls: not message-loop polling
    const env = setup(), t0 = env.clock.now();
    for (let i = 0; i < 5000; i++) { env.peek(); env.call('kernel32.dll', 'GetLastError'); env.call('kernel32.dll', 'GetLastError'); env.clock.t += 0.001; }
    assert.ok(Math.abs(env.clock.now() - t0 - 5) < 1e-6);
    assert.equal(env.th.peekIdle.parks, 0);
  }
  { // a message is returned at once
    const env = setup();
    for (let i = 0; i < 200; i++) { env.peek(); env.clock.t += 0.001; }
    assert.ok(env.th.peekIdle.parks > 0);
    env.call('user32.dll', 'PostThreadMessageA', env.vm.proc.threads[0].id, 0x400, 7, 9);
    const t0 = env.clock.now();
    assert.equal(env.peek(), 1);
    assert.equal(env.clock.now(), t0);
  }
});

test('PeekMessage: a loop pumping messages between small chunks of guest work (no API call) is not slowed down', { skip }, () => {
  for (const [chunkMs, insns] of [[0.005, 5000], [0.02, 20000], [0.049, 50000]]) {
    const env = setup(), t0 = env.clock.now(), n = 20000;
    for (let i = 0; i < n; i++) { env.peek(); env.clock.t += chunkMs; env.vm.guestInsns += insns; }
    assert.ok(Math.abs(env.clock.now() - t0 - n * chunkMs) < 1e-6, `${chunkMs} ms chunks: ${(env.clock.now() - t0).toFixed(1)} ms for ${(n * chunkMs).toFixed(1)}`);
    assert.equal(env.th.peekIdle.parks, 0);
  }
  // a polling loop of ~100 guest instructions per call still waits
  const env = setup();
  for (let i = 0; i < 2000; i++) { env.peek(); env.clock.t += 0.001; env.vm.guestInsns += 100; }
  assert.ok(env.th.peekIdle.parks > 0);
});

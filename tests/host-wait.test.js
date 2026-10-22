// Host wake-up overshoot (src/core/host-wait.js, docs/thread-scheduling.md "Host wake-up overshoot"): the injected
// coarse timer, the overshoot estimate, the adaptive waits (early wake-up, a spin only for a frame limiter's last
// waits), the pacing-loop prediction, the frame-relevant lateness, the timer arming; and a guest frame limiter without
// catch-up (build/pe/pacing.exe) on an injected 15.625 ms host timer: its frames back to its period with the adaptive
// waits, ~47 ms without — the owner's Windows numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { quantised, OvershootEstimate, HostWaiter, paceEnded, pacePredict, hostWaiter, PACE_SLACK_MS } from '../src/core/host-wait.js';
import { measureHostTiming, summarise, probeLine } from '../src/host/web/timing-probe.js';
import { PerfWindow, compactPhase } from '../src/host/perf-summary.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

/** Run `f` with the debug globals `g` set (then restored). */
function withGlobals(g, f) {
  const prev = {};
  for (const [k, v] of Object.entries(g)) { prev[k] = globalThis[k]; if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  try { return f(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
}

/**
 * A fake host: a clock advancing only when waited on (and by `tick` per clock read: a spin advances it), and a host
 * wait that ends at the first `q` boundary at or after the time asked (q 0: `over` ms late), never notified.
 */
function fakeHost({ q = 15.625, over = 0, tick = 0.01, t = 1000.3 } = {}) {
  const h = { t, waits: [], reads: 0 };
  h.now = () => { h.reads++; const v = h.t; h.t += tick; return v; };
  h.wait = (arr, idx, value, ms) => { h.waits.push(ms); const end = h.t + ms; h.t = q > 0 ? Math.ceil(end / q - 1e-9) * q : end + over; return 'timed-out'; };
  return h;
}

test('quantised: whole milliseconds, then the first multiple of the quantum at or after the end', () => {
  assert.equal(quantised(3, 1, 0), 1);
  assert.ok(Math.abs(quantised(3, 1, 15.625) - 12.625) < 1e-9);
  assert.ok(Math.abs(quantised(15, 1, 15.625) - 16.25) < 1e-9); // (16 > 15.625: the next tick)
  assert.ok(Math.abs(quantised(3.4, 0.3, 1) - 1.6) < 1e-9); // (0.3 -> 1 ms, ends at 4.4 -> 5)
  assert.ok(Math.abs(quantised(31.25, 15.625, 15.625) - 31.25) < 1e-9); // (15.625 -> 16 ms: past the next tick)
  withGlobals({ ORTHROS_HOST_TIMER_Q: 15.625 }, () => assert.ok(Math.abs(quantised(3, 1) - 12.625) < 1e-9)); // (the switch)
  assert.equal(quantised(3, 0, 15.625), 0);
});

test('OvershootEstimate: the second largest of the recent samples (one stall does not raise it, a coarse timer does)', () => {
  const e = new OvershootEstimate();
  for (let i = 0; i < 10; i++) e.add(0.05);
  e.add(30); // (a garbage collection)
  assert.ok(e.value < 0.1, `${e.value}`);
  e.add(14); e.add(9);
  assert.equal(e.value, 14);
  for (let i = 0; i < 16; i++) e.add(0.06);
  assert.ok(e.value < 0.1, 'the window forgets');
});

test('HostWaiter: a precise host is waited on plainly (no spin, no early wake-up)', () => {
  withGlobals({ ORTHROS_ADAPTIVE_SLEEP: undefined, ORTHROS_HOST_TIMER_Q: undefined }, () => {
    const h = fakeHost({ q: 0, over: 0.06 }), w = new HostWaiter(h.now, h.wait), arr = new Int32Array(1);
    for (let i = 0; i < 20; i++) { w.pace(h.t + 0.5); w.waitUntil(arr, 0, 0, h.t + 1); }
    const s = w.take();
    assert.equal(s.wait.spins, 0); assert.equal(s.wait.early, 0); assert.equal(h.waits.length, 20);
    assert.ok(s.est < 0.1);
  });
});

test('HostWaiter: on a coarse host a frame limiter\'s last waits are spun to the deadline, the others wait', () => {
  withGlobals({ ORTHROS_ADAPTIVE_SLEEP: undefined, ORTHROS_HOST_TIMER_Q: undefined }, () => {
    const h = fakeHost(), w = new HostWaiter(h.now, h.wait), arr = new Int32Array(1);
    for (let i = 0; i < 4; i++) w.waitUntil(arr, 0, 0, h.t + 1); // (the estimate learns the coarse timer)
    assert.ok(w.est.value > 10, `estimate ${w.est.value}`);
    // no pacing loop known: a 1 ms wait is a plain host wait (its overshoot accepted: no long spin)
    let d = h.t + 1, n = h.waits.length; w.waitUntil(arr, 0, 0, d);
    assert.equal(h.waits.length, n + 1); assert.ok(h.t - d > 1, 'overslept');
    assert.ok(w.lastLate > 1, 'late for the frame: no loop known');
    // a loop predicted to end 1.5 ms from now: its 1 ms wait is spun, exactly to the deadline
    w.take();
    d = h.t + 1; w.pace(h.t + 1.5); n = h.waits.length; w.waitUntil(arr, 0, 0, d);
    assert.equal(h.waits.length, n, 'no host wait'); assert.ok(h.t >= d && h.t - d < 0.05, `woke ${h.t - d} ms after`);
    const s = w.take(); assert.equal(s.wait.spins, 1); assert.ok(s.wait.spinMs > 0.9 && s.wait.spinMs < 1.1);
    // the same loop 40 ms before its end: an early wait, waited on (late, but not for the frame)
    w.pace(h.t + 40); d = h.t + 1; n = h.waits.length; w.waitUntil(arr, 0, 0, d);
    assert.equal(h.waits.length, n + 1); assert.equal(w.lastLate, 0);
    // a deadline far away: woken earlier by the estimate, the rest waited again
    w.pace(0); d = h.t + 60; n = h.waits.length; w.waitUntil(arr, 0, 0, d);
    assert.ok(h.waits.length >= n + 2 && h.waits[n] < 60 - 10, `asks ${h.waits.slice(n)}`);
    // the switch off: one plain host wait, even at the loop's end
    withGlobals({ ORTHROS_ADAPTIVE_SLEEP: 0 }, () => { w.pace(h.t + 1.5); d = h.t + 1; n = h.waits.length; w.waitUntil(arr, 0, 0, d); assert.equal(h.waits.length, n + 1); assert.ok(h.t - d > 1); });
    // a wait without a deadline that matters (the deadlock watch's): plain, not counted
    w.take(); w.pace(h.t + 1.5); d = h.t + 1; n = h.waits.length; w.waitUntil(arr, 0, 0, d, false);
    assert.equal(h.waits.length, n + 1); assert.equal(w.take().wait.spins, 0);
  });
});

test('HostWaiter: a notified wait returns at once; the window\'s switches reported as its waits saw them', () => {
  withGlobals({ ORTHROS_ADAPTIVE_SLEEP: undefined, ORTHROS_HOST_TIMER_Q: 15.625 }, () => {
    const h = fakeHost({ q: 0 }), w = new HostWaiter(h.now, (a, i, v, ms) => { h.t += 0.2; return 'ok'; }), arr = new Int32Array(1);
    assert.equal(w.waitUntil(arr, 0, 0, h.t + 5), 'ok');
    withGlobals({ ORTHROS_ADAPTIVE_SLEEP: 0 }, () => w.waitUntil(arr, 0, 0, h.t + 5));
    const s = w.take(); assert.equal(s.q, 15.625); assert.equal(s.adaptive, 'mixed'); assert.equal(s.wait.waits, 2);
  });
});

test('HostWaiter.timerArm: armed earlier by the timers\' overshoot, the injected quantum applied', () => {
  withGlobals({ ORTHROS_ADAPTIVE_SLEEP: undefined, ORTHROS_HOST_TIMER_Q: undefined }, () => {
    const w = new HostWaiter(() => 0, () => 'timed-out');
    assert.deepEqual(w.timerArm(10, 0), { ask: 10, delay: 10 });
    w.noteTimer(4, 4); w.noteTimer(5, 5);
    assert.equal(w.timerArm(10, 0).ask, 6);
    assert.equal(w.timerArm(3, 0).ask, 3, 'a wake-up within the estimate: armed plainly');
    withGlobals({ ORTHROS_HOST_TIMER_Q: 15.625 }, () => assert.ok(Math.abs(w.timerArm(3, 1).delay - 14.625) < 1e-9));
    withGlobals({ ORTHROS_ADAPTIVE_SLEEP: 0 }, () => assert.equal(w.timerArm(10, 0).ask, 10));
    assert.equal(w.take().timer.waits, 2);
  });
});

test('pacing loops: the next end from the period (second shortest interval), a late end ignored, a pause forgotten', () => {
  const st = {};
  for (const t of [0, 33.3, 66.6, 100]) paceEnded(st, t);
  assert.ok(Math.abs(pacePredict(st, 110) - 133.3) < 1e-9);
  paceEnded(st, 147); // (one late frame)
  assert.ok(Math.abs(pacePredict(st, 150) - 180.3) < 1e-9, `${pacePredict(st, 150)}`);
  assert.equal(pacePredict(st, 180.3 + PACE_SLACK_MS + 1), -1, 'past the end: no prediction');
  paceEnded(st, 5000); // (a pause)
  assert.equal(st.paceEnds.length, 1); assert.equal(pacePredict(st, 5001), -1);
  const odd = {}; for (const t of [0, 33.3, 40, 73.3, 106.6]) paceEnded(odd, t); // (one short loop in between)
  assert.ok(Math.abs(pacePredict(odd, 110) - 139.9) < 1e-9, `${pacePredict(odd, 110)}`);
  const few = {}; for (const t of [0, 33, 66]) paceEnded(few, t);
  assert.equal(pacePredict(few, 70), -1, 'three ends: too few');
});

test('frame summaries and bench phases carry the host waits', () => {
  const win = new PerfWindow();
  const acct = { frames: 15, h: [33, 15], max: 34, w: 10, c: { wait: 20 } };
  win.add({ dt: 0.5, acct, hostWait: { waits: 100, overMs: 50, lateMs: 30, spins: 10, spinMs: 5, est: 14, timerEst: 3 } });
  win.add({ dt: 0.5, acct, hostWait: { waits: 300, overMs: 150, lateMs: 60, spins: 40, spinMs: 35, est: 14.5, timerEst: 3 } });
  const s = win.take();
  assert.deepEqual(s.hostWait, { waits: 200, overMean: 0.5, lateMsPerFrame: 1, spinMsPerFrame: 1, est: 14.5, timerEst: 3 });
  const ph = compactPhase({ label: 'menu', frames: 100, hostWait: { wait: { waits: 10, overMean: 1, overMax: 15, lateMs: 50, hist: [1], spins: 3, spinMs: 20 }, est: 14, timerEst: 2, timer: null, q: 15.625, adaptive: true } });
  assert.equal(ph.hostWait.lateMsPerFrame, 0.5); assert.equal(ph.hostWait.spinMsPerFrame, 0.2); assert.equal(ph.hostWait.injected, 15.625);
});

test('timing probe: Atomics.wait / setTimeout / hop overshoots measured, the injected timer seen', async () => {
  assert.deepEqual(summarise([3, 1, 2]), { n: 3, mean: 2, p50: 2, p90: 3, max: 3 });
  const p = await measureHostTiming({ n: 6 });
  for (const k of ['atomicsWait1', 'atomicsWait1Timer', 'setTimeout0', 'setTimeout1', 'messageHop']) assert.equal(p[k].n, 6, k);
  assert.ok(p.atomicsWait1.p50 < 5, `this host: ${probeLine(p)}`);
  const c = await measureHostTiming({ n: 4, q: 15.625 });
  assert.ok(c.atomicsWait1.p50 > 5 && c.setTimeout1.p50 > 5, probeLine(c));
  assert.match(probeLine({ ...c, battery: { charging: false, level: 0.42 } }), /Atomics\.wait\(1\) \+[\d.]+ \/ [\d.]+.*battery 42 % on battery \[injected 15\.625 ms timer\]/);
});

const PE = new URL('../build/pe/pacing.exe', import.meta.url).pathname;
const skip = !fs.existsSync(PE) && 'build/pe/pacing.exe missing (make pe-tests)';

/** pacing.exe on the real clock with the debug globals `g`: its frame intervals (ms, sorted) after the first ten. */
function runPacing(g) {
  return withGlobals(g, () => {
    const vfs = new Vfs(), t = new MemBackend();
    vfs.mount('C:\\', new MemBackend());
    vfs.mount('C:\\Test', t);
    t.open('pacing.exe', { create: true }).write(0, fs.readFileSync(PE));
    const clock = new RealClock();
    const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock }), jit: true, logKinds: ['warn', 'crash'] });
    vm.createProcess({ exePath: 'C:\\Test\\pacing.exe' });
    const marks = [], dispatch = vm.dispatchThunk.bind(vm);
    vm.dispatchThunk = (th, i) => { if (vm.api.thunk(i)?.name === 'GetVersion') marks.push(performance.now()); return dispatch(th, i); };
    hostWaiter.take();
    const code = vm.run();
    assert.equal(code, 0);
    const iv = marks.slice(11).map((x, k) => x - marks[10 + k]).sort((a, b) => a - b);
    return { iv, p50: iv[iv.length >> 1], p90: iv[Math.floor(iv.length * 0.9)], hw: hostWaiter.take() };
  });
}

test('a frame limiter on an injected 15.625 ms host timer: ~47 ms frames, back to its 33 ms with the adaptive waits', { skip }, (t) => {
  const off = runPacing({ ORTHROS_HOST_TIMER_Q: 15.625, ORTHROS_ADAPTIVE_SLEEP: 0 });
  const on = runPacing({ ORTHROS_HOST_TIMER_Q: 15.625, ORTHROS_ADAPTIVE_SLEEP: undefined });
  const msg = `off p50 ${off.p50.toFixed(1)} p90 ${off.p90.toFixed(1)}, on p50 ${on.p50.toFixed(1)} p90 ${on.p90.toFixed(1)} (spin ${on.hw.wait?.spinMs} ms)`;
  t.diagnostic(msg);
  assert.ok(off.p50 > 40, msg); // (each frame: the last throttled Sleep(0) wakes at the next 15.625 ms tick)
  assert.ok(on.p50 < 35.5 && on.p90 < 37, msg);
  assert.ok(on.hw.wait.spins > 0 && off.hw.wait.spins === 0, msg);
  // (bounded CPU: the spin covers the loop's last ~estimate ms, not the whole wait — under half of the 33 ms frame)
  assert.ok(on.hw.wait.spinMs / on.iv.length < 20, msg);
});

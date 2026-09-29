// Simulated player link of the test server: answers share one rate (see src/host/sim-link.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimLink } from '../src/host/sim-link.js';

/** A fake clock: timers run in time order when advanced. */
function fakeClock() {
  let now = 0, seq = 0; const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    run(until) {
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = until;
    },
  };
}

test('one answer: a round trip plus its transfer time', () => {
  const c = fakeClock(), link = new SimLink({ delayMs: 40, bytesPerSec: 1e6 }, c);
  let at = -1; link.send(100000, () => { at = c.now(); });
  c.run(1000);
  assert.ok(Math.abs(at - 140) < 1e-6, `done at ${at}`);
});

test('two answers in flight share the rate', () => {
  const c = fakeClock(), link = new SimLink({ delayMs: 0, bytesPerSec: 1e6 }, c);
  const done = {};
  link.send(100000, () => { done.a = c.now(); });
  link.send(300000, () => { done.b = c.now(); });
  c.run(2000);
  // both at half rate until a is done (200 ms), then b alone: 200 KB left at full rate
  assert.ok(Math.abs(done.a - 200) < 1e-6, `a at ${done.a}`);
  assert.ok(Math.abs(done.b - 400) < 1e-6, `b at ${done.b}`);
});

test('a cancelled answer leaves the link to the others', () => {
  const c = fakeClock(), link = new SimLink({ delayMs: 0, bytesPerSec: 1e6 }, c);
  const done = {};
  const cancel = link.send(1000000, () => { done.big = c.now(); });
  link.send(100000, () => { done.small = c.now(); });
  c.run(100); // 50 KB of each moved
  cancel();
  c.run(2000);
  assert.equal(done.big, undefined);
  assert.ok(Math.abs(done.small - 150) < 1e-6, `small at ${done.small}`);
});

test('an answer cancelled during its round trip never enters the link', () => {
  const c = fakeClock(), link = new SimLink({ delayMs: 50, bytesPerSec: 1e6 }, c);
  let ran = false; const cancel = link.send(1000, () => { ran = true; });
  c.run(10); cancel(); c.run(1000);
  assert.equal(ran, false);
  assert.equal(link.active.length, 0);
});

// Lost wake-ups between two threads (an answer stored and notified after the waiter's last look, before its wait): the
// interleaving forced on one thread — the "other side" acts inside the waiter's own check — so the outcome is exact.
// A wait on the value read before the check returns at once; one on a value read after it slept its whole timeout
// (the render worker's frames, fences and readbacks: 20 ms each, src/gfx/d3d-recorder.js; input during a nested wait:
// up to 50 ms, src/web/browser-host.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderLink } from '../src/gfx/d3d-recorder.js';
import { CTL as RCTL, CTL_WORDS, ACK_SLOTS } from '../src/gfx/cmd-ring.js';
import { BrowserHost, CTL, IN_RING, EV } from '../src/web/browser-host.js';
import { hostWaiter } from '../src/core/host-wait.js';

test('render worker: an answer stored between the emulator\'s look and its wait does not leave it asleep', () => {
  const ctl = new Int32Array(new SharedArrayBuffer(CTL_WORDS * 4));
  const link = new RenderLink({ words: new Int32Array(new SharedArrayBuffer(1 << 16)), ctl, ack: new Int32Array(new SharedArrayBuffer(ACK_SLOTS * 4)) });
  for (const [word, kind] of [[RCTL.SHOWN, 'frame'], [RCTL.READBACK, 'readback'], [RCTL.TAIL, 'fence']]) {
    let looks = 0;
    // (the condition reads the word, then the render worker answers: store and notify — nobody waits yet)
    const cond = () => { const ok = Atomics.load(ctl, word) === 1; if (!ok && ++looks === 2) { Atomics.store(ctl, word, 1); Atomics.notify(ctl, word); } return ok; };
    assert.ok(link.waitFor(cond, word, kind));
    assert.deepEqual([link.stats.waitTimeouts, link.stats.lostWakes], [0, 0], `${kind}: no wait reached its 20 ms timeout`);
  }
});

test('nested wait: an input event pushed after the last pump, before the wait, ends the wait at once', () => {
  const ctl = new Int32Array(new SharedArrayBuffer(64 * 4)), inputRing = new Int32Array(new SharedArrayBuffer(IN_RING * 4));
  // (the page's push, main.js: the event in the ring, the head moved, the waiters notified — during the host's work
  // before it blocks)
  const push = () => { inputRing.set([EV.KEYDOWN, 0x41, 0x1e, 0], 0); Atomics.store(ctl, CTL.IN_HEAD, 1); Atomics.notify(ctl, CTL.IN_HEAD); };
  const host = { ctl, inputRing, inputQueue: [], playerActions: 0, idleWork: push, pump: BrowserHost.prototype.pump };
  const raw = hostWaiter.rawWait, results = [];
  hostWaiter.rawWait = (a, i, v, ms) => { const r = raw(a, i, v, ms); results.push(r); return r; };
  try { BrowserHost.prototype.waitEvent.call(host, 50); } finally { hostWaiter.rawWait = raw; }
  assert.deepEqual(results, ['not-equal'], 'woken at once, not at its 50 ms deadline');
  assert.equal(host.inputQueue.length, 1);
});

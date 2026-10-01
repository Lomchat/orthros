// Per-frame time accounting (src/core/frame-acct.js): exclusive nested sections, sampled API / interpreter time
// estimated per frame, the planned / late split of a gap, interval and phase statistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameAccount, FrameStats, C, CATS, N_CATS, workOf, catsObject } from '../src/core/frame-acct.js';

const fakeClock = () => { const c = { t: 0 }; c.now = () => c.t; return c; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('nested sections are exclusive and a frame adds up to its duration', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest); clk.t = 10;
  const p = a.enter(C.api); clk.t = 12;
  const q = a.enter(C.tex); clk.t = 17; a.leave(q); // 5 ms of texture upload inside the API call
  clk.t = 18; a.leave(p); // 3 ms of the API call itself
  clk.t = 30;
  const f = a.frame();
  assert.equal(f[C.guest], 22); assert.equal(f[C.api], 3); assert.equal(f[C.tex], 5);
  assert.equal(sum(f), 30);
  // the next frame starts at the boundary
  clk.t = 40; assert.equal(sum(a.frame()), 10);
});

test('untimed API calls are estimated from the timed ones and taken out of guest time', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest);
  let timed = 0, untimed = 0;
  for (let i = 0; i < 4000; i++) {
    clk.t += 0.01; // guest code between calls
    if (a.apiTimed(7)) { timed++; const outer = a.cur !== C.api, p = a.enter(C.api), a0 = a.acc[C.api], d0 = a.acc[C.draw]; clk.t += 0.002; a.apiEnd(p, 7, a0, d0, outer); }
    else { untimed++; clk.t += 0.002; } // (its time runs on in guest code's segment)
  }
  assert.ok(timed > 100 && timed < 500, `about 1 in 16 timed (${timed})`);
  const f = a.frame();
  assert.ok(Math.abs(f[C.api] - 4000 * 0.002) < 1e-6, `api ${f[C.api]}`);
  assert.ok(Math.abs(f[C.guest] - 4000 * 0.01) < 1e-6, `guest ${f[C.guest]}`);
  assert.ok(Math.abs(sum(f) - clk.t) < 1e-6);
});

test('an API with a long timed call is timed on every call from then on', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest);
  let n = 0;
  while (!a.apiTimed(3)) n++;
  const p = a.enter(C.api), a0 = a.acc[C.api]; clk.t += 2; a.apiEnd(p, 3, a0, a.acc[C.draw], true);
  assert.equal(a.heavyApis, 1);
  for (let i = 0; i < 50; i++) assert.equal(a.apiTimed(3), true);
  assert.ok(n < 32);
  // 1024 short calls in a row: sampled again
  for (let i = 0; i < 1024; i++) { assert.equal(a.apiTimed(3), true); const q = a.enter(C.api), b0 = a.acc[C.api]; clk.t += 0.001; a.apiEnd(q, 3, b0, a.acc[C.draw], true); }
  let untimed = 0; for (let i = 0; i < 64; i++) if (!a.apiTimed(3)) untimed++;
  assert.ok(untimed > 32, `${untimed}`);
});

test('draws are timed inside timed API calls; the untimed calls\' draws are estimated with them', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest);
  for (let i = 0; i < 2000; i++) {
    clk.t += 0.01;
    const draw = () => { if (a.cur !== C.api) { clk.t += 0.05; return; } const q = a.enter(C.draw); clk.t += 0.05; a.leave(q); };
    if (a.apiTimed(9)) { const outer = a.cur !== C.api, p = a.enter(C.api), a0 = a.acc[C.api], d0 = a.acc[C.draw]; clk.t += 0.003; draw(); a.apiEnd(p, 9, a0, d0, outer); }
    else { clk.t += 0.003; draw(); }
  }
  const f = a.frame();
  assert.ok(Math.abs(f[C.draw] - 2000 * 0.05) < 1e-6, `draw ${f[C.draw]}`);
  assert.ok(Math.abs(f[C.api] - 2000 * 0.003) < 1e-6, `api ${f[C.api]}`);
  assert.ok(Math.abs(f[C.guest] - 2000 * 0.01) < 1e-6, `guest ${f[C.guest]}`);
  assert.equal(a.heavyApis, 0); // (slow draws do not make the API heavy)
});

test('a timed call spanning a frame boundary (a Present) is measured whole, no category goes negative', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest);
  for (let f = 0; f < 50; f++) {
    for (let i = 0; i < 200; i++) { clk.t += 0.05; if (a.apiTimed(2)) { const p = a.enter(C.api), a0 = a.acc[C.api]; clk.t += 0.01; a.apiEnd(p, 2, a0, a.acc[C.draw], true); } else clk.t += 0.01; }
    // the present: timed by sampling or not, the frame boundary inside it
    const timed = a.apiTimed(5), outer = a.cur !== C.api, p = timed ? a.enter(C.api) : -1, a0 = a.acc[C.api], d0 = a.acc[C.draw];
    clk.t += 0.2; const fr = a.frame(); clk.t += 0.2;
    if (timed) a.apiEnd(p, 5, a0, d0, outer);
    for (let i = 0; i < N_CATS; i++) assert.ok(fr[i] >= 0, `${CATS[i]} ${fr[i]}`);
    if (f > 0) assert.ok(fr[C.api] > 1.5 && fr[C.api] < 2.6, `api ${fr[C.api]}`); // (the 200 small calls, plus the present when it was timed)
  }
});

test('the estimate never takes more than guest time holds', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.guest);
  // 20 timed calls of 1 ms set the per-call mean; then 1000 untimed calls happen inside a 1 ms guest segment
  for (let i = 0; i < 20; i++) { while (!a.apiTimed(1)) { /* skip */ } const p = a.enter(C.api), a0 = a.acc[C.api]; clk.t += 0.4; a.apiEnd(p, 1, a0, a.acc[C.draw], true); }
  a.frame();
  a.enter(C.guest); clk.t += 1;
  a.apiUntimedN = 1000;
  const f = a.frame();
  assert.equal(f[C.guest], 0); assert.ok(Math.abs(f[C.api] - 1) < 1e-9);
});

test('move() shifts time already charged (a gap\'s late part)', () => {
  const clk = fakeClock(), a = new FrameAccount(clk.now);
  a.enter(C.sleep); clk.t = 20; a.enter(C.host);
  a.move(C.sleep, C.late, 4); a.move(C.sleep, C.late, 100); // (never more than the category holds)
  const f = a.frame();
  assert.equal(f[C.sleep], 0); assert.equal(f[C.late], 20);
});

test('work excludes pacing', () => {
  const f = new Float64Array(N_CATS); f[C.guest] = 10; f[C.sleep] = 20; f[C.wait] = 2; f[C.late] = 3;
  assert.equal(workOf(f), 13);
  assert.deepEqual(catsObject(f, 2.5), { sleep: 20, guest: 10, late: 3 });
});

test('interval and phase statistics', () => {
  const s = new FrameStats(1000);
  const frame = (dt, guest, extra = {}) => { const f = new Float64Array(N_CATS); f[C.guest] = guest; f[C.sleep] = dt - guest - Object.values(extra).reduce((x, y) => x + y, 0); for (const [k, v] of Object.entries(extra)) f[C[k]] = v; return f; };
  let at = 0;
  for (let i = 0; i < 1780; i++) { at += 33.3; s.add(33.3, frame(33.3, 20), at); } // a minute of steady frames (ring keeps the last 1000)
  at += 60; s.add(60, frame(60, 20, { jit: 40 }), at);
  at += 40; s.add(40, frame(40, 20, { prog: 15, tex: 5 }), at);
  const iv = s.takeInterval();
  assert.equal(iv.frames, 1782); assert.equal(iv.s33, 2); assert.equal(iv.s50, 1); assert.equal(iv.max, 60);
  assert.deepEqual(iv.wf, [60, 60, { jit: 40, guest: 20 }]);
  assert.equal(s.takeInterval(), null);
  const ph = s.phase('play', at);
  assert.equal(ph.label, 'start'); assert.equal(ph.frames, 1000); assert.equal(ph.slow33, 2); assert.equal(ph.slow50, 1);
  assert.ok(ph.seconds > 59 && ph.seconds < 60.1, `${ph.seconds}`);
  assert.equal(ph.per33, 2);
  assert.deepEqual(ph.excessShares, { jit: 67, prog: 25, tex: 8 });
  assert.deepEqual(ph.dominant, { jit: 1, prog: 1 });
  assert.equal(ph.worst[0].dt, 60);
  assert.match(ph.text, /phase start: 1000 frames/);
  assert.equal(s.phase('next', at + 1000).frames, 0);
  assert.equal(CATS.length, N_CATS);
});

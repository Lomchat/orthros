// The page's alignment of a Direct3D game's frames on the display's refreshes (src/shared/display-pacing.js): a game
// whose limiter presents every 33.7 ms (BFME's 30 fps loop) with ±1.5 ms of jitter, its frames arriving close to a
// 60 Hz refresh — the owner's Age of the Ring display report of 2026-11-18, shown 1 and 3 refreshes in turn. Aligned,
// every frame stays 2 refreshes (3 when the game falls a refresh behind), none 1, and none is shown more than one
// refresh after the refresh it would have reached as it came; frames whose interval does not wait for the retrace
// (IMMEDIATE) are shown at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePacer } from '../src/shared/display-pacing.js';

const P = 1000 / 60;

/** 300 frames 33.7 ms apart (± deterministic jitter) from 15.5 ms after a refresh, the animation frames every P */
function run(on) {
  let now = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const shown = [], late = [];
  const p = new FramePacer({ show: (f) => { f.shownAt = now; shown.push(f); }, now: () => now, on, setTimeout: () => {} });
  const ev = [];
  for (let k = 0; k < 640; k++) ev.push({ t: k * P, tick: true });
  for (let i = 0; i < 300; i++) ev.push({ t: 50 + 15.5 + i * 33.7 + (rnd() * 3 - 1.5) });
  ev.sort((a, b) => a.t - b.t);
  for (const e of ev) { now = e.t; if (e.tick) p.tick(e.t); else p.arrive({ at: e.t }, 'gl', true); }
  // (each frame against the refresh it would have reached as it came: the first animation frame after its arrival)
  for (const f of shown) late.push(Math.round((f.shownAt - Math.ceil(f.at / P) * P) / P));
  return { c: p.counters(), late };
}

test('a 30 fps limiter close to a refresh: 2 refreshes a frame (3 when behind), never 1; IMMEDIATE frames shown at once', () => {
  const before = run(false), after = run(true);
  assert.ok(before.c.h[1] > 0 && before.c.h[3] > 0, `the judder reproduced as frames come: ${before.c.h}`);
  assert.equal(after.c.h[1], 0, `aligned: no frame held 1 refresh (${after.c.h})`);
  assert.equal(after.c.h[0], 0, 'none dropped');
  assert.ok(after.c.h[3] <= 9 && after.c.h[2] >= 280, `2 refreshes each, 3 once per drift cycle: ${after.c.h}`);
  assert.ok(after.c.jud / after.c.jn < before.c.jud / before.c.jn / 2, `judder ${after.c.jud / after.c.jn} vs ${before.c.jud / before.c.jn}`);
  assert.ok(after.late.every((d) => d >= 0 && d <= 1), 'never more than a refresh later than as it came');
  assert.ok(after.late.filter((d) => d === 1).length < 30, `a refresh later rarely: ${after.late.filter((d) => d === 1).length}`);
  // a device that does not wait for the retrace: shown in the call, nothing held
  const shown = [];
  const p = new FramePacer({ show: (f) => shown.push(f), now: () => 5, setTimeout: () => {} });
  p.tick(0); p.arrive({ id: 1 }, 'gl', false); p.arrive({ id: 2 }, '2d', false);
  assert.deepEqual(shown.map((f) => f.id), [1, 2]);
  assert.equal(p.queue.length, 0);
});

// The game data's indicator (src/host/web/data-meter-worker.js), run in a context of its own with a clock, a canvas
// that records what it shows and the game data's shared counters driven by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../src/host/web/data-meter-worker.js', import.meta.url), 'utf8');

/** The worker, its canvas (`shown`: what the screen would show after the worker's turn; `texts`: its last frame's lines). */
function meter() {
  let now = 0, tick = null, texts = [], frame = [];
  const canvas = { width: 480, height: 90 };
  const screen = { shown: false, get texts() { return texts; } };
  const ctx = new Proxy({ canvas }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'clearRect') return () => { screen.shown = false; frame = []; };
      if (key === 'fillText') return (text) => { frame.push(String(text)); texts = frame; screen.shown = true; };
      if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const scope = {
    performance: { now: () => now }, Atomics, Int32Array, Intl, Math, Object,
    setInterval: (f) => { tick = f; }, setTimeout: () => {},
  };
  runInNewContext(SOURCE, scope);
  const ctrl = new Int32Array(new SharedArrayBuffer(64));
  const send = (m) => scope.onmessage({ data: m });
  send({ canvas: { getContext: () => ctx }, dpr: 1, lang: 'en' });
  send({ arrived: ctrl.buffer });
  /** `ms` go by: the page paints (a beat every 100 ms) or not, the interval runs; what the screen shows meanwhile. */
  const run = (ms, { paints = true } = {}) => {
    const seen = [];
    for (let t = 0; t < ms; t += 100) {
      now += 100;
      if (paints) { send({ beat: 1 }); seen.push(screen.shown); }
      tick(); seen.push(screen.shown);
    }
    return seen;
  };
  return { ctrl, screen, run };
}

test('data meter: shown steadily while an engine that suspends (the page painting) waits for its data', () => {
  const m = meter();
  Atomics.store(m.ctrl, 6, 1);   // (a read waiting for the network)
  const seen = m.run(6000);
  const first = seen.indexOf(true);
  assert.ok(first > 0, 'shown once the reads have waited');
  assert.deepEqual(seen.slice(first).filter((v) => !v), [], 'no frame without it while the wait goes on');
  // (the reads end: it stays a moment, then goes)
  Atomics.store(m.ctrl, 6, 0);
  const after = m.run(5000);
  assert.equal(after[0], true);
  assert.equal(after.at(-1), false);
  assert.deepEqual(after.slice(after.indexOf(false)).filter((v) => v), [], 'gone once, not back');
});

test('data meter: shown steadily over reads that come and go, the page held between frames', () => {
  const m = meter();
  Atomics.store(m.ctrl, 6, 1);
  m.run(2500, { paints: false });
  assert.equal(m.screen.shown, true);
  // (the page paints a frame between two held reads)
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push(...m.run(100), ...m.run(1200, { paints: false })); }
  assert.deepEqual(seen.filter((v) => !v), []);
});

test('data meter: the step\'s total and percentage only while earlier sessions tell what remains', () => {
  const m = meter();
  Atomics.store(m.ctrl, 6, 1);
  Atomics.store(m.ctrl, 4, 10240); Atomics.store(m.ctrl, 5, 20480);   // (KB of the step received / in all)
  m.run(3000);
  assert.ok(m.screen.texts.includes('50 %'), m.screen.texts.join(' | '));
  assert.match(m.screen.texts.join(' | '), /10 \/ 20 MB/);
  // (all it learned has come, the reads still wait: no end known)
  Atomics.store(m.ctrl, 4, 21299); Atomics.store(m.ctrl, 5, 21299);
  m.run(200);
  const line = m.screen.texts.join(' | ');
  assert.ok(!m.screen.texts.some((t) => t.endsWith('%')), line);
  assert.doesNotMatch(line, /\//);
  assert.match(line, /20\.8 MB/);
});

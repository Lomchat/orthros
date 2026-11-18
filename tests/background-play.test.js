// The game kept at full speed in a hidden tab (src/web/background-play.js): an inaudible signal that Chrome counts as
// audible — or its process is lowered (2.5-4 times slower on the owner's laptop) —, only while hidden and the game
// works, never against the player's choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAKE_LEVEL, CHROME_AUDIBLE_DBFS, AWAKE_MAX_HIDDEN_MS, awakeDecision, backgroundChoice, KeepAwake } from '../src/web/background-play.js';

test('the signal: audible to Chrome with a margin, a constant no one hears; the player\'s choice and the game\'s work decide it', () => {
  const dbfs = 20 * Math.log10(AWAKE_LEVEL);
  // (Chrome averages the power over the channels: on 2 channels of 8 the level loses 6 dB — still over the threshold)
  assert.ok(dbfs + 10 * Math.log10(2 / 8) >= CHROME_AUDIBLE_DBFS + 6, `${dbfs.toFixed(1)} dBFS`);
  assert.ok(AWAKE_LEVEL <= 1 / 256, 'a small offset only');
  const base = { hidden: true, active: true, awake: true, working: true, hiddenMs: 1000 };
  assert.equal(awakeDecision(base), 'on');
  assert.equal(awakeDecision({ ...base, hidden: false }), 'visible');
  assert.equal(awakeDecision({ ...base, active: false }), 'pause');
  assert.equal(awakeDecision({ ...base, awake: false }), 'optout');
  assert.equal(awakeDecision({ ...base, working: false }), 'idle');
  assert.equal(awakeDecision({ ...base, hiddenMs: AWAKE_MAX_HIDDEN_MS }), 'capped');
  const store = (v) => ({ getItem: (k) => v[k] ?? null });
  assert.deepEqual(backgroundChoice('', store({})), { active: true, awake: true });
  assert.deepEqual(backgroundChoice('?bg=pause', store({})), { active: false, awake: true });
  assert.deepEqual(backgroundChoice('', store({ 'orthros.bg': 'pause', 'orthros.awake': '0' })), { active: false, awake: false });
  assert.deepEqual(backgroundChoice('?bg=1&awake=1', store({ 'orthros.bg': 'pause', 'orthros.awake': '0' })), { active: true, awake: true }, 'the URL wins');
});

test('KeepAwake: faded in while hidden and working, out and suspended once shown; its time in the telemetry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0, working = true;
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const contexts = [];
  class ConstantSourceNode {
    constructor(ctx, o) { this.ctx = ctx; this.ramps = []; this.offset = { value: o.offset, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime: (v) => { this.ramps.push(v); this.offset.value = v; } }; }
    connect(d) { this.to = d; } start() { this.started = true; } stop() {}
  }
  const win = Object.assign(new EventTarget(), { document: doc, location: { search: '' }, ConstantSourceNode });
  const createContext = () => { const c = { state: 'running', currentTime: 0, destination: {}, resume() { this.state = 'running'; return Promise.resolve(); }, suspend() { this.state = 'suspended'; return Promise.resolve(); }, close() {} }; contexts.push(c); return c; };
  const k = new KeepAwake({ win, choice: { active: true, awake: true }, working: () => working, createContext, now: () => now });
  const show = (v) => { doc.visibilityState = v; doc.dispatchEvent(new Event('visibilitychange')); };
  assert.equal(k.state, 'visible'); assert.equal(contexts.length, 0, 'no audio while visible');
  now = 1000; show('hidden');
  assert.equal(k.state, 'on'); assert.equal(contexts.length, 1);
  assert.equal(k.node.to, contexts[0].destination); assert.ok(k.node.started);
  assert.equal(k.node.ramps.at(-1), AWAKE_LEVEL); assert.equal(k.sample(), 1);
  now = 21000; const w = k.take();
  assert.deepEqual([w.hid, w.on, w.st], [20, 20, 'on']);
  now = 22000; show('visible');
  assert.equal(k.node.ramps.at(-1), 0); assert.equal(k.sample(), undefined);
  t.mock.timers.tick(1000);
  assert.equal(contexts[0].state, 'suspended', 'faded out, then suspended');
  assert.equal(k.take().hid, 1); assert.equal(k.take(), null, 'not hidden in the window: nothing');
  // hidden again: the same context resumed; the game ending stops it; the player's pause never starts it
  now = 30000; show('hidden');
  assert.equal(contexts.length, 1); assert.equal(contexts[0].state, 'running'); assert.equal(k.node.ramps.at(-1), AWAKE_LEVEL);
  working = false; now = 32000; t.mock.timers.tick(2000);
  assert.equal(k.state, 'idle'); assert.equal(k.node.ramps.at(-1), 0); assert.equal(k.sample(), 0);
  k.dispose();
  const paused = new KeepAwake({ win, choice: { active: false, awake: true }, working: () => true, createContext, now: () => now, checkMs: 0 });
  assert.equal(paused.state, 'pause'); assert.equal(contexts.length, 1);
  paused.dispose();
});

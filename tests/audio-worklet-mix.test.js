// The AudioWorklet's direct mixer (audio-worklet.js) against the reference: a 16-bit stereo buffer at 22050 Hz, played
// looping from its cursor, mixed at 44100 Hz with gains — the same samples as linear interpolation gives, cursor
// snapping on a new generation, one-shot end, and resynchronisation to a fresh cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let Processor = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { Processor = cls; };
globalThis.sampleRate = 44100;
await import('../src/host/web/audio-worklet.js');
const { VOICE_BASE, VOICE_INTS, VOICE_TABLE_BYTES } = await import('../src/win32/dsound.js');

function setup() {
  const memory = new SharedArrayBuffer(1 << 16), voices = new SharedArrayBuffer(VOICE_TABLE_BYTES);
  const p = new Processor({ processorOptions: { audio: new SharedArrayBuffer(8), ctl: new SharedArrayBuffer(64), frames: 1, write: 0, read: 1, underruns: 2 } });
  p.port.onmessage({ data: { type: 'voices', memory, voices } });
  return { p, mem: new DataView(memory), v: new Int32Array(voices), vf: new Float32Array(voices) };
}
const ADDR = 0x1000, FRAMES = 1000;
function fill(mem) { for (let i = 0; i < FRAMES; i++) { mem.setInt16(ADDR + 4 * i, Math.round(Math.sin(i / 7) * 20000), true); mem.setInt16(ADDR + 4 * i + 2, Math.round(Math.cos(i / 5) * 10000), true); } }
function voice(v, vf, { gen = 1, cursor = 0, loop = 1, gl = 0.5, gr = 0.25, playing = 1, pub = 0 } = {}) {
  const o = VOICE_BASE; // slot 0
  v[o] = playing; v[o + 2] = ADDR; v[o + 3] = FRAMES * 4; v[o + 4] = 4; v[o + 5] = 16; v[o + 6] = 2; v[o + 7] = 0; v[o + 8] = 22050; v[o + 9] = loop;
  vf[o + 10] = gl; vf[o + 11] = gr; v[o + 12] = cursor; v[o + 13] = pub; Atomics.store(v, o + 1, gen);
}
const render = (p, n = 128) => { const l = new Float32Array(n), r = new Float32Array(n); p.process([], [[l, r]]); return [l, r]; };
const ref = (mem, frame, ch) => { const s = (f) => mem.getInt16(ADDR + (f % FRAMES) * 4 + 2 * ch, true) / 32768; const fi = Math.floor(frame), t = frame - fi; return s(fi) + (s(fi + 1) - s(fi)) * t; };

test('the worklet mixes a looping buffer from its cursor, with gains and resampling', () => {
  const { p, mem, v, vf } = setup(); fill(mem);
  voice(v, vf, { cursor: 40 * 4 });
  let frame = 40;
  for (let q = 0; q < 20; q++) { // 2560 output frames: 1280 buffer frames, the loop wraps once
    const [l, r] = render(p);
    for (let k = 0; k < 128; k++, frame = (frame + 0.5) % FRAMES) { assert.ok(Math.abs(l[k] - 0.5 * ref(mem, frame, 0)) < 1e-6, `L q${q} k${k}`); assert.ok(Math.abs(r[k] - 0.25 * ref(mem, frame, 1)) < 1e-6, `R q${q} k${k}`); }
  }
  assert.equal(v[0], 20 * 128, 'frame counter'); assert.equal(v[2], 1, 'mixing');
  assert.ok(vf[1] > 0.2, 'peak');
});

test('a new generation snaps to the cursor; a one-shot stops at its end; a fresh cursor resynchronises', () => {
  const { p, mem, v, vf } = setup(); fill(mem);
  voice(v, vf, { cursor: (FRAMES - 10) * 4, loop: 0 });
  const [l] = render(p); // 20 output frames from the last 10 buffer frames, then silence
  assert.ok(Math.abs(l[0] - 0.5 * ref(mem, FRAMES - 10, 0)) < 1e-6);
  assert.ok(l.slice(21).every((x) => x === 0), 'silent past the end');
  voice(v, vf, { gen: 2, cursor: 100 * 4 }); // Play again from 100
  const [l2] = render(p);
  assert.ok(Math.abs(l2[0] - 0.5 * ref(mem, 100, 0)) < 1e-6, 'from the new cursor');
  // cursor published now (pub = the frame counter) 300 frames away from the mix position: resync
  voice(v, vf, { gen: 2, cursor: 500 * 4, pub: v[0] });
  const [l3] = render(p);
  assert.ok(Math.abs(l3[0] - 0.5 * ref(mem, 500, 0)) < 1e-6, 'resynchronised');
  // an old publication (as when the worker stalls): no resync, the mix goes on
  voice(v, vf, { gen: 2, cursor: 900 * 4, pub: (v[0] - 44100) | 0 });
  const [l4] = render(p);
  assert.ok(Math.abs(l4[0] - 0.5 * ref(mem, 564, 0)) < 1e-6, 'continued from 564');
});

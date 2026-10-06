// The page's sound output under the browser's autoplay rules (src/host/web/sound.js): resumed at gestures, the
// "click to enable sound" button, the audio part of the telemetry summaries; the worker's figures it reads
// (playing DirectSound buffers, audio decoder failures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GESTURES, resumeOnGesture, soundHintNeeded, AudioStats } from '../src/host/web/sound.js';
import { audioPlaying } from '../src/win32/dsound.js';
import { AsyncAudio, audioDecodeStats } from '../src/media/mpeg-source.js';

/** an AudioContext as far as the page uses it: Chrome's autoplay policy lets resume() succeed only after a gesture */
function fakeContext(state = 'suspended') {
  const ctx = { state, calls: 0, allowed: false, resume() { this.calls++; if (this.allowed) this.state = 'running'; return Promise.resolve(); } };
  return ctx;
}

test('resumeOnGesture: every gesture kind resumes a suspended context, a running one is left alone', () => {
  const target = new EventTarget(), ctx = fakeContext();
  let tries = 0;
  const off = resumeOnGesture(ctx, target, () => tries++);
  target.dispatchEvent(new Event('mousemove')); // (not an activation)
  assert.equal(ctx.calls, 0);
  for (const g of GESTURES) target.dispatchEvent(new Event(g));
  assert.equal(ctx.calls, GESTURES.length, 'a refused resume is tried again at the next gesture');
  ctx.allowed = true; target.dispatchEvent(new Event('keydown'));
  assert.equal(ctx.state, 'running');
  const before = ctx.calls;
  target.dispatchEvent(new Event('pointerdown'));
  assert.equal(ctx.calls, before, 'running: no call');
  ctx.state = 'interrupted'; target.dispatchEvent(new Event('click')); // (the system took the output: the next click asks again)
  assert.equal(ctx.state, 'running');
  assert.equal(tries, GESTURES.length + 2);
  off(); ctx.state = 'suspended'; target.dispatchEvent(new Event('mousedown'));
  assert.equal(ctx.state, 'suspended', 'listeners removed');
});

test('resumeOnGesture: a closed context is not resumed, a rejected resume does not throw', async () => {
  const target = new EventTarget(), closed = fakeContext('closed');
  resumeOnGesture(closed, target);
  target.dispatchEvent(new Event('click'));
  assert.equal(closed.calls, 0);
  const rej = { state: 'suspended', resume: () => Promise.reject(new Error('not allowed')) };
  resumeOnGesture(rej, target);
  target.dispatchEvent(new Event('click'));
  await new Promise((r) => setTimeout(r, 0)); // (an unhandled rejection would fail the test run)
});

test('soundHintNeeded: shown only while the game runs with the context not running past the grace time', () => {
  const base = { status: 'running', ctxState: 'suspended', notRunningSince: 1000, now: 3000 };
  assert.equal(soundHintNeeded(base), true);
  assert.equal(soundHintNeeded({ ...base, ctxState: 'interrupted' }), true);
  assert.equal(soundHintNeeded({ ...base, status: 'starting' }), true, 'while loading: one click before the first sounds');
  assert.equal(soundHintNeeded({ ...base, now: 1500 }), false, 'a context resuming after a click: not flashed');
  assert.equal(soundHintNeeded({ ...base, ctxState: 'running', notRunningSince: null }), false);
  assert.equal(soundHintNeeded({ ...base, ctxState: null }), false, 'no sound output set up (headless)');
  assert.equal(soundHintNeeded({ ...base, ctxState: 'closed' }), false);
  for (const status of ['menu', 'loading', 'exited', 'crashed']) assert.equal(soundHintNeeded({ ...base, status }), false, status);
});

test('AudioStats: one bounded record per window — context, worklet output rate, mix level, buffers, decoder failures', () => {
  const a = new AudioStats();
  assert.equal(a.take(), null, 'nothing added: no record');
  const ctx = { state: 'suspended', sampleRate: 44100, outputLatency: 0.02, baseLatency: 0.005 };
  // 20 s: suspended for 4 s (the worklet does not play), then running (44100 frames/s)
  let frames = 0;
  for (let i = 0; i <= 40; i++) {
    const t = i * 500;
    if (i === 8) { ctx.state = 'running'; a.noteChange(); a.noteResume(); }
    if (ctx.state === 'running' && i > 0) frames += 22050;
    a.add({ audioPeak: i === 20 ? 0.41 : 0.1, audioPlaying: i % 7, audioBuffers: 12, audioDecodeFailures: i > 30 ? 1 : 0, audioMix: 'worklet' }, ctx, frames, t, 'voices');
  }
  const r = a.take();
  assert.equal(r.ctx, 'running'); assert.equal(r.rate, 44100); assert.equal(r.lat, 25);
  assert.equal(r.run, Math.round((33 / 41) * 100) / 100);
  assert.equal(r.out, Math.round((22050 * 33) / 20));
  assert.equal(r.peak, 0.41); assert.equal(r.play, 6); assert.equal(r.bufs, 12); assert.equal(r.dec, 1); assert.equal(r.mix, 'worklet');
  assert.equal(r.resumes, 1); assert.equal(r.changes, 1);
  assert.equal(r.err, undefined);
  assert.ok(JSON.stringify(r).length < 300, 'bounded');
  // the next window starts afresh (the counters of the session's gestures and changes go on)
  a.add({ audioPeak: 0 }, ctx, frames + 44100, 20500, 'voices');
  const r2 = a.take();
  assert.equal(r2.peak, 0); assert.equal(r2.play, 0); assert.equal(r2.out, 88200); assert.equal(r2.resumes, 1);
});

test('AudioStats: a stalled worklet reads 0 frames/s; a change of counter is not counted as played frames; errors kept short', () => {
  const a = new AudioStats(), ctx = { state: 'running', sampleRate: 44100 };
  a.add({}, ctx, 5000, 0, 'ring'); a.add({}, ctx, 5000, 1000, 'ring');
  assert.equal(a.take().out, 0, 'running but the worklet does not advance: stalled');
  a.add({}, ctx, 9000, 1500, 'ring'); a.add({}, ctx, 123456789, 2000, 'voices'); a.add({}, ctx, 123456789 + 22050, 2500, 'voices');
  assert.equal(a.take().out, Math.round((4000 + 22050) / 1), 'the jump between the ring index and the voice counter is ignored');
  a.add({}, null, null, 3000); a.noteError('x'.repeat(1000)); a.noteError('second');
  const r = a.take();
  assert.equal(r.ctx, 'running', 'the last known state'); assert.equal(r.err.length, 200); assert.equal(r.out, null);
  const none = new AudioStats(); none.add({}, null, null, 0); assert.equal(none.take().ctx, 'none');
});

test('audioPlaying: the secondary buffers playing (not the primary, not empty ones)', () => {
  assert.equal(audioPlaying(null), 0);
  const buffers = new Set([{ playing: true, primary: true, size: 0 }, { playing: true, primary: false, size: 4096 }, { playing: false, primary: false, size: 4096 }, { playing: true, primary: false, size: 0 }, { playing: true, primary: false, size: 100 }]);
  assert.equal(audioPlaying({ buffers }), 2);
});

test('audioDecodeStats: a browser audio decoder that refuses the codec or fails is counted once', () => {
  const saved = [globalThis.AudioDecoder, globalThis.EncodedAudioChunk];
  try {
    let errorCb = null;
    globalThis.EncodedAudioChunk = class { constructor(o) { Object.assign(this, o); } };
    globalThis.AudioDecoder = class { constructor(o) { errorCb = o.error; } configure() { throw new Error('unsupported codec'); } close() {} };
    const n0 = audioDecodeStats.failures, logs = [];
    const a = new AsyncAudio('mp3', 44100, 2, (m) => logs.push(m));
    assert.equal(a.failed, true); assert.equal(audioDecodeStats.failures, n0 + 1); assert.match(logs[0], /unavailable/);
    a.submit(new Uint8Array(4), 0); assert.equal(audioDecodeStats.failures, n0 + 1, 'failed already: not counted again');
    globalThis.AudioDecoder = class { constructor(o) { errorCb = o.error; } configure() {} decode() {} close() {} };
    const b = new AsyncAudio('mp3', 44100, 2, (m) => logs.push(m));
    errorCb(new Error('decode error')); errorCb(new Error('again'));
    assert.equal(b.failed, true); assert.equal(audioDecodeStats.failures, n0 + 2);
  } finally { [globalThis.AudioDecoder, globalThis.EncodedAudioChunk] = saved; }
});

test('renderAudio (worker mix into the ring): the play cursors follow the VM clock while the output consumes nothing', async () => {
  const { BrowserHost, CTL, AUDIO_RING_FRAMES } = await import('../src/host/browser-host.js');
  // an AudioContext suspended until the first click: the ring is full and stays full (nothing read)
  const ctl = new Int32Array(CTL.SIZE); ctl[CTL.AUDIO_WRITE] = 12288; ctl[CTL.AUDIO_READ] = 0;
  let ticks = 0, renders = 0;
  const audio = { worklet: false, buffers: new Set(), tick() { ticks++; }, render() { renders++; this.tick(); } };
  const host = { ctl, audioRing: new Float32Array(AUDIO_RING_FRAMES * 2), audioPeak: 0, audioMs: 0, audioFrames: 0, audioDiag: 0, chunk: null };
  for (let i = 0; i < 5; i++) BrowserHost.prototype.renderAudio.call(host, { audio, log() {} });
  assert.equal(renders, 0, 'nothing rendered: the ring is full');
  assert.equal(ticks, 5, 'the cursors advanced at every call (a game waiting on a position or a notification goes on)');
  ctl[CTL.AUDIO_READ] = 12288; // (the output plays again: the ring is filled ahead)
  BrowserHost.prototype.renderAudio.call(host, { audio, log() {} });
  assert.ok(renders > 0);
});

test('audioVerdict: what the summaries say about a session\'s sound', async () => {
  const { audioVerdict, audioText } = await import('../src/host/web/sound.js');
  const rec = (o) => ({ ctx: 'running', rate: 44100, lat: 30, run: 1, out: 44100, mix: 'worklet', peak: 0.3, play: 4, bufs: 9, dec: 0, resumes: 0, changes: 0, ...o });
  assert.equal(audioVerdict([]).verdict, 'none');
  assert.equal(audioVerdict([undefined, null]).verdict, 'none', 'summaries of an older build');
  assert.equal(audioVerdict([rec({ ctx: 'suspended', run: 0, out: 0, peak: 0.4 })]).verdict, 'suspended', 'the worker mixed, nothing played');
  assert.equal(audioVerdict([rec({ ctx: 'none', run: 0, out: null, err: 'AbortError: Unable to load a worklet' })]).verdict, 'error');
  assert.equal(audioVerdict([rec({ out: 0 })]).verdict, 'stalled');
  assert.equal(audioVerdict([rec({ peak: 0 })]).verdict, 'silent');
  assert.equal(audioVerdict([rec({ peak: 0, play: 0 })]).verdict, 'quiet');
  assert.equal(audioVerdict([rec({ ctx: 'suspended', run: 0, out: 0, peak: 0.4 }), rec({ peak: 0 })]).verdict, 'silent', 'a level mixed before the first click (never heard) is not sound reaching the output');
  const v = audioVerdict([rec({ ctx: 'suspended', run: 0, out: 0, peak: 0 }), rec({ run: 0.5, resumes: 1, changes: 1 }), rec({ dec: 2 })]);
  assert.equal(v.verdict, 'ok'); assert.equal(v.states, 'suspended/running'); assert.equal(v.run, 0.5); assert.equal(v.out, 44100); assert.equal(v.dec, 2); assert.equal(v.resumes, 1);
  assert.match(audioText(v), /^sound: OK — context suspended\/running @44100 Hz, running 50% .* 2 audio decoder failure/);
});

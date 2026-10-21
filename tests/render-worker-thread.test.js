// The render worker's protocol under real concurrency: a randomized Direct3D session recorded on this thread and
// replayed by the render loop in a worker thread (shared guest memory, ring, control words, acknowledgements) must
// drive the WebGL backend exactly as the in-thread path does — fences, renames, deferred releases, readbacks and frame
// pacing racing a replay that runs late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { randomSession } from './d3d-random.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { CTL_WORDS, ACK_SLOTS } from '../src/gfx/cmd-ring.js';
import { fakeGl, firstDifference } from './fake-gl.js';

async function threaded(seed, api9, slow, reads) {
  const ring = new SharedArrayBuffer(4 << 18), ctl = new SharedArrayBuffer(CTL_WORDS * 4), ack = new SharedArrayBuffer(ACK_SLOTS * 4), stop = new SharedArrayBuffer(4);
  new Int32Array(ack).fill(-1);
  const link = new RenderLink({ words: new Int32Array(ring), ctl: new Int32Array(ctl), ack: new Int32Array(ack), onFail: (r) => { throw new Error(r); } });
  let worker = null, done = null;
  randomSession({ createDevice: (dev) => {
    if (!worker) {
      worker = new Worker(new URL('./render-thread-worker.js', import.meta.url), { workerData: { memory: dev.proc.mem.memory, ring, ctl, ack, stop, slow, reads } });
      done = new Promise((resolve, reject) => { worker.on('message', resolve); worker.on('error', reject); });
    }
    return new Recorder(link, dev);
  } }, seed, api9, () => {}, true);
  link.publish(true);
  assert.ok(link.waitConsumed(link.w.produced, 'end'), 'replayed to the end');
  Atomics.store(new Int32Array(stop), 0, 1);
  const r = await done;
  await worker.terminate();
  return { calls: r.calls, stats: link.stats };
}

// (buffer bytes copied at Unlock — ORTHROS_VB_LAZY=0: the same WebGL calls —, or at the draws that read them: the same
// draws, compared by the bytes they read, fakeGl `reads`)
for (const api9 of [true, false]) for (const lazy of [false, true]) {
  test(`Direct3D ${api9 ? 9 : 8}: random sequences replayed in a worker thread — the same WebGL ${lazy ? 'draws (buffer bytes copied at draws)' : 'calls'} as in-thread`, async () => {
    const seeds = process.env.RW_THREAD_SEEDS ? process.env.RW_THREAD_SEEDS.split(',').map((x, i) => [Number(x), i % 3]) : [[11, 0], [12, 0], [13, 1], [14, 2]];
    globalThis.ORTHROS_VB_LAZY = lazy ? undefined : 0;
    try { for (const [seed, slow] of seeds) {
      const A = fakeGl(800, 600, { reads: lazy });
      randomSession({ createDevice: (dev) => new WebGLDevice(A.gl, dev, {}) }, seed, api9, () => {});
      const B = await threaded(seed, api9, slow, lazy);
      const d = firstDifference(A.calls, B.calls);
      assert.equal(d, null, d ? `seed ${seed}${slow ? ' (slow worker)' : ''}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nworker\n  ${d.b.join('\n  ')}` : '');
      assert.ok(B.stats.waits > 0, 'the emulator waited for the worker');
    } } finally { globalThis.ORTHROS_VB_LAZY = undefined; }
  });
}

test('a render worker that stops answering: the emulator stops waiting for it and reports the failure once', () => {
  const ring = new SharedArrayBuffer(4 << 16), ctl = new SharedArrayBuffer(CTL_WORDS * 4), ack = new SharedArrayBuffer(ACK_SLOTS * 4);
  new Int32Array(ack).fill(-1);
  const fails = [];
  const link = new RenderLink({ words: new Int32Array(ring), ctl: new Int32Array(ctl), ack: new Int32Array(ack), stallMs: 200, onFail: (r) => fails.push(r) });
  const t0 = Date.now();
  randomSession({ createDevice: (dev) => new Recorder(link, dev) }, 3, true, () => {}, true); // (nobody replays: the ring fills, frames are never shown)
  assert.equal(fails.length, 1, fails.join('; '));
  assert.match(fails[0], /stalled/);
  assert.ok(link.failed && Date.now() - t0 < 5000, 'one stall, then no more waits');
});

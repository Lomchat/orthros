// Node worker of tests/render-worker-thread.test.js: the render worker's replay loop (src/gfx/render-loop.js) with the
// WebGL backend on a recording context, on another thread than the recording emulator.
import { parentPort, workerData } from 'node:worker_threads';
import { GuestMemory } from '../src/cpu/memory.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { replayLoop, publishTail } from '../src/gfx/render-loop.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { CTL } from '../src/gfx/cmd-ring.js';
import { fakeGl } from './fake-gl.js';

const { memory, ring, ctl: ctlSab, ack, stop: stopSab, slow, reads } = workerData;
const ctl = new Int32Array(ctlSab), stop = new Int32Array(stopSab), G = fakeGl(800, 600, { reads: !!reads });
const replayer = new Replayer(new Int32Array(ring), {
  mem: new GuestMemory({ memory }), ack: new Int32Array(ack),
  createBackend: (m) => new WebGLDevice(G.gl, m, {}),
  onPresent: (m, frame) => { Atomics.store(ctl, CTL.SHOWN, frame); Atomics.notify(ctl, CTL.SHOWN); },
  onReadback: (ticket) => { publishTail(ctl, replayer); Atomics.store(ctl, CTL.READBACK, ticket); Atomics.notify(ctl, CTL.READBACK); },
});
if (slow) { const run = replayer.run.bind(replayer); replayer.run = (a, n) => { const t = Date.now() + slow; while (Date.now() < t); return run(a, n); }; } // (a slow render worker: the emulator runs ahead)
Atomics.store(ctl, CTL.READY, 1);
const stats = { ms: 0, waitMs: 0 };
await replayLoop(ctl, replayer, null, stats, () => Atomics.load(stop, 0) !== 0);
parentPort.postMessage({ calls: G.calls, commands: replayer.commands });

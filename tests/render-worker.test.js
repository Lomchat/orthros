// Render worker (docs/render-worker.md, D063): the Direct3D work recorded into the command ring and replayed into a
// device mirror must drive the unchanged WebGL backend exactly as the device itself does in the in-thread path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OPS, OP, RingWriter, RingReader } from '../src/gfx/cmd-ring.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { fakeGl, firstDifference } from './fake-gl.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

test('every ring command round-trips through the table (random arguments, wrapping)', () => {
  const words = new Int32Array(1 << 10);
  const w = new RingWriter(words, () => { throw new Error('full'); }), r = new RingReader(words);
  let seed = 12345; const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0);
  const value = (k) => {
    switch (k) {
      case 'u': return rnd();
      case 'i': return rnd() | 0;
      case 'f': return new Float32Array([(rnd() / 65536) - 30000])[0];
      case 'n': { const c = rnd() % 4; return c === 0 ? rnd() : c === 1 ? -(rnd() % 1000) - 1 : c === 2 ? rnd() / 7 : undefined; }
      case 'w': return rnd() % 5 === 0 ? null : Int32Array.from({ length: rnd() % 9 }, () => rnd() | 0);
      case 'b': return Uint8Array.from({ length: rnd() % 13 }, () => rnd() & 255);
    }
  };
  for (let round = 0; round < 40; round++) {
    for (let op = 1; op < OPS.length; op++) {
      const args = [...OPS[op][1]].map(value);
      w.put(op, ...args);
      w.consumed = w.produced; // (read at once: the ring wraps many times)
      let c; while (!(c = r.next())); // (skip a WRAP)
      assert.equal(c.op, op, OPS[op][0]);
      const got = c.decode();
      [...OPS[op][1]].forEach((k, i) => {
        const a = args[i], b = got[i];
        if (k === 'w') assert.deepEqual(b === null ? null : Array.from(b), a === null ? null : Array.from(a), `${OPS[op][0]} arg ${i}`);
        else if (k === 'b') assert.deepEqual(Array.from(b), Array.from(a), `${OPS[op][0]} arg ${i}`);
        else if (k === 'u') assert.equal(b, a >>> 0);
        else assert.ok(Object.is(b, a), `${OPS[op][0]} arg ${i}: ${b} vs ${a}`);
      });
      assert.equal(r.consumed, w.produced);
    }
  }
});

/** Boot a test exe with a WebGL backend on a fake context: in-thread, or recorded and replayed inline. */
function runExe(exeName, mode) {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open(exeName, { create: true }).write(0, fs.readFileSync(PE_DIR + exeName));
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
  const vm = new Vm({ vfs, clock, host, jit: true, logKinds: ['warn', 'crash'] });
  const G = fakeGl();
  let link = null;
  if (mode === 'thread') host.gfx = { createDevice: (dev) => new WebGLDevice(G.gl, dev, {}) };
  else {
    const words = new Int32Array(1 << 16); // (small: the ring wraps, and fills up — replayed on this thread then)
    const replayer = new Replayer(words, { mem: vm.mem, createBackend: (m) => new WebGLDevice(G.gl, m, {}) });
    link = new RenderLink({ words, replayer });
    host.gfx = { createDevice: (dev) => new Recorder(link, dev) };
  }
  vm.createProcess({ exePath: 'C:\\Test\\' + exeName });
  const code = vm.run();
  link?.publish(true);
  return { code, calls: G.calls, out: vm.stdout.join(''), link };
}

for (const exe of ['dx.exe', 'dx9.exe', 'd3dlost.exe']) {
  test(`${exe}: the same WebGL calls in-thread and recorded + replayed (inline)`, { skip: skip(exe) }, () => {
    const a = runExe(exe, 'thread'), b = runExe(exe, 'inline');
    assert.equal(b.code, a.code);
    assert.equal(b.out, a.out, 'the program saw the same results');
    assert.ok(a.calls.length > 50, `${a.calls.length} GL calls`);
    const d = firstDifference(a.calls, b.calls);
    assert.equal(d, null, d ? `first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
  });
}
void OP;

// ------------------------------------------------------------------ randomized Direct3D 9 / 8 call sequences
import { randomSession } from './d3d-random.js';
import { compareDevice } from '../src/gfx/d3d-mirror.js';

for (const api9 of [true, false]) {
  test(`Direct3D ${api9 ? 9 : 8}: random call sequences — the mirror equals the device at every draw, and the backend issues the same WebGL calls`, () => {
    for (const seed of (process.env.RW_SEEDS ?? "1,2,3,4,5,6").split(",").map(Number)) {
      const A = fakeGl(), B = fakeGl();
      randomSession({ createDevice: (dev) => new WebGLDevice(A.gl, dev, {}) }, seed, api9, () => {});
      const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: (m) => new WebGLDevice(B.gl, m, {}) });
      const link = new RenderLink({ words, replayer, ack });
      let draws = 0;
      randomSession({ createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } }, seed, api9, (dev) => {
        link.publish(true);
        const m = replayer.devices.get(dev.gfx.id);
        const diff = compareDevice(dev, m);
        assert.deepEqual(diff, [], `seed ${seed}, draw ${draws}: mirror differs:\n  ${diff.join('\n  ')}`);
        draws++;
      });
      link.publish(true);
      const d = firstDifference(A.calls, B.calls);
      assert.equal(d, null, d ? `seed ${seed}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
      assert.ok(draws > 100 && A.calls.length > 1000, `${draws} draws, ${A.calls.length} GL calls`);
    }
  });
  // replayed late (at presents, waits and when the ring is full, as a render worker would be behind): guest memory
  // written or released meanwhile must not reach the replayed draws (fences, renaming, deferred releases)
  test(`Direct3D ${api9 ? 9 : 8}: random call sequences replayed late — the same WebGL calls (buffer contents in the ring, surface copies on write or fences)`, () => {
    const seen = { cows: 0, waits: 0, bufDataBytes: 0, eagerBufs: 0 };
    for (const seed of (process.env.RW_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number)) for (const cow of [true, false]) {
      globalThis.ORTHROS_RW_COW = cow ? undefined : 0;
      const A = fakeGl(), B = fakeGl();
      randomSession({ createDevice: (dev) => new WebGLDevice(A.gl, dev, {}) }, seed, api9, () => {});
      const words = new Int32Array(1 << 17), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: (m) => new WebGLDevice(B.gl, m, {}) });
      const link = new RenderLink({ words, replayer, ack });
      randomSession({ createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } }, seed, api9, () => {});
      link.publish(true);
      const d = firstDifference(A.calls, B.calls);
      assert.equal(d, null, d ? `seed ${seed}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
      for (const k of ['bufDataBytes', 'eagerBufs']) seen[k] += link.stats[k];
      seen[cow ? 'cows' : 'waits'] += cow ? link.stats.cows : link.stats.waits;
      globalThis.ORTHROS_RW_COW = undefined;
    }
    // (every path taken somewhere in the sessions)
    for (const k of Object.keys(seen)) assert.ok(seen[k] > 0, `${k}: ${seen[k]}`);
  });
}

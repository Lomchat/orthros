// The render worker as the browser runs it (src/gfx/render-worker.js and the emulator side of render-host.js), in a
// Node worker thread with a recording WebGL context: the Direct3D test programs issue the same WebGL calls there as
// with the backend on the emulator's thread, frames are presented and readbacks answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker, MessageChannel } from 'node:worker_threads';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { createRemoteGfx } from '../src/gfx/render-host.js';
import { createWebGLBackend } from '../src/gfx/d3d8-webgl.js';
import { fakeGl, firstDifference } from './fake-gl.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

/** the Worker of a page, over a Node worker thread running the shimmed render worker */
class ShimWorker {
  constructor() { this.w = new NodeWorker(new URL('./render-worker-shim.js', import.meta.url)); this.w.on('message', (m) => { if (m?.type === 'test-calls') this.onCalls?.(m.calls); else this.onmessage?.({ data: m }); }); this.w.on('error', (e) => this.onerror?.(e)); }
  postMessage(m, t) { this.w.postMessage(m, t); }
  terminate() { return this.w.terminate(); }
}

async function run(exe, remote) {
  const vfs = new Vfs(), dir = new MemBackend(); vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open(exe, { create: true }).write(0, fs.readFileSync(PE_DIR + exe));
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
  const logs = [], frames = [];
  let G = null, worker = null;
  if (remote) {
    host.gfx = createRemoteGfx({ log: (m) => logs.push(m), workerUrl: 'shim', onFail: (r) => logs.push(`FAIL ${r}`) });
  } else { G = fakeGl(); host.gfx = createWebGLBackend({ getContext: () => G.gl }, () => {}); } // (the backend factory, as the render worker uses it)
  const vm = new Vm({ vfs, clock, host, jit: true, sharedMemory: remote, logKinds: ['warn', 'crash'] });
  let ready = null;
  if (remote) {
    const ch = new MessageChannel();
    ch.port1.on('message', (m) => { if (m.type === 'frame') frames.push(m); else if (m.type === 'log') logs.push(m.msg); });
    ready = new Promise((r, j) => { const t0 = Date.now(), t = setInterval(() => { if (host.gfx.ready || Date.now() - t0 > 20000) { clearInterval(t); if (host.gfx.ready) r(); else j(new Error(`render worker not ready: ${logs.join('; ')}`)); } }, 10); });
    globalThis.Worker = class extends ShimWorker { constructor() { super(); worker = this; } }; // (the page's Worker, for start())
    try { host.gfx.start(vm.mem.memory, { width: 800, height: 600, globals: {} }, ch.port2); } finally { delete globalThis.Worker; }
    await ready;
    ch.port1.unref?.();
  }
  vm.createProcess({ exePath: 'C:\\Test\\' + exe });
  const t0 = Date.now(), code = vm.run(), ms = Date.now() - t0;
  let calls = G?.calls;
  if (remote) {
    host.gfx.link.publish(true); host.gfx.link.waitConsumed(host.gfx.link.w.produced, 'end');
    calls = await new Promise((r) => { worker.onCalls = r; worker.postMessage({ type: 'test-calls' }); });
    await worker.terminate();
  }
  return { code, out: vm.stdout.join(''), calls, logs, frames, stats: host.gfx.link?.stats, ms };
}

for (const exe of ['dx.exe', 'dx9.exe']) {
  test(`${exe} through the render worker (worker thread): the same WebGL calls, frames presented, readbacks answered`, { skip: skip(exe) }, async () => {
    const a = await run(exe, false), b = await run(exe, true);
    assert.equal(b.code, a.code);
    assert.equal(b.out, a.out, 'the program saw the same results (readbacks)');
    assert.ok(!b.logs.some((l) => /FAIL|failed|stalled/.test(l)), b.logs.join('\n'));
    assert.ok(b.frames.length >= 1, 'frames posted to the page');
    console.log(`${exe}: in-thread ${a.ms} ms, render worker ${b.ms} ms, ${b.frames.length} frames; waits ${b.stats.gpuWaitMs.toFixed(0)} ms in ${b.stats.waits}`);
    const draw = (c) => c.filter((x) => !/^get/.test(x[0])); // (the queries of the setup differ: the render worker reports the renderer)
    const d = firstDifference(draw(a.calls), draw(b.calls));
    assert.equal(d, null, d ? `first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nrender worker\n  ${d.b.join('\n  ')}` : '');
  });
}

// The GPU process's backlog seen by the worker: every present places a fence, gpuLagMs() is the age of the oldest
// presented frame whose fence has not signaled yet (the signaled ones are freed) — the worker holds the guest back
// above a limit.
// A render target's framebuffer is not checked with checkFramebufferStatus (a synchronous round trip that waited for
// the whole GPU queue) outside --gl-validate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { createWebGLBackend } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

for (const exe of ['dx.exe', 'dx9.exe']) {
  test(`${exe}: a fence per present, gpuLagMs is the age of the oldest unsignaled one; no framebuffer status query`, { skip: skip(exe) }, () => {
    const G = fakeGl();
    let signaled = false;
    const gl = new Proxy(G.gl, { get: (t, k) => (k === 'getSyncParameter' ? (s, p) => { t.getSyncParameter(s, p); return signaled ? t.SIGNALED : t.UNSIGNALED; } : t[k]) });
    const vfs = new Vfs(), dir = new MemBackend(); vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
    dir.open(exe, { create: true }).write(0, fs.readFileSync(PE_DIR + exe));
    const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
    host.gfx = createWebGLBackend({ getContext: () => gl }, () => {});
    const vm = new Vm({ vfs, clock, host, jit: true, logKinds: ['warn', 'crash'] });
    vm.createProcess({ exePath: 'C:\\Test\\' + exe });
    vm.run();
    const n = (name) => G.calls.filter((c) => c[0] === name).length;
    const presents = host.gfx.device.frame;
    assert.ok(presents >= 1, 'frames presented');
    assert.equal(n('fenceSync'), presents, 'one fence per present (no program prewarm pending)');
    assert.equal(n('checkFramebufferStatus'), 0, 'no synchronous framebuffer check');
    const queued = Math.min(presents, 16), q = host.gfx.programCache.frameFences;
    assert.equal(q.length, queued, 'unsignaled frames kept (the last 16)');
    const now = performance.now();
    assert.equal(host.gfx.gpuLagMs(now), now - q[0].t, 'the oldest unfinished frame\'s age');
    assert.ok(q.every((f, i) => i === 0 || f.t >= q[i - 1].t));
    assert.equal(n('deleteSync'), presents - queued, 'fences beyond 16 deleted');
    signaled = true;
    assert.equal(host.gfx.gpuLagMs(now), 0, 'caught up: signaled frames leave the queue');
    assert.equal(q.length, 0);
    assert.equal(n('deleteSync'), presents, 'and their fences are deleted');
  });
}

// The GPU process's backlog seen by the worker: every present places a fence, gpuFramesBehind() counts the presented
// frames whose fence has not signaled yet (and frees the signaled ones) — the worker holds the guest back above a few.
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
  test(`${exe}: a fence per present, gpuFramesBehind counts the unsignaled ones; no framebuffer status query`, { skip: skip(exe) }, () => {
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
    const queued = Math.min(presents, 16);
    assert.equal(host.gfx.gpuFramesBehind(), queued, 'unsignaled frames counted (the queue keeps the last 16)');
    assert.equal(n('deleteSync'), presents - queued, 'fences beyond 16 deleted');
    signaled = true;
    assert.equal(host.gfx.gpuFramesBehind(), 0, 'signaled frames leave the queue');
    assert.equal(n('deleteSync'), presents, 'and their fences are deleted');
  });
}

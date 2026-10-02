// A render target's framebuffer is not checked with checkFramebufferStatus outside --gl-validate: the query is a
// synchronous round trip to the GPU process that waits for every command queued before it (seconds behind a GPU
// backlog), for a status that was only logged.
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

function run(exe) {
  const G = fakeGl();
  const vfs = new Vfs(), dir = new MemBackend(); vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open(exe, { create: true }).write(0, fs.readFileSync(PE_DIR + exe));
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
  host.gfx = createWebGLBackend({ getContext: () => G.gl }, () => {});
  const vm = new Vm({ vfs, clock, host, jit: true, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\' + exe });
  vm.run();
  return G.calls.filter((c) => c[0] === 'checkFramebufferStatus').length;
}

for (const exe of ['dx.exe', 'dx9.exe']) {
  test(`${exe}: no framebuffer status query (a GPU round trip) unless the GL state is validated`, { skip: skip(exe) }, () => {
    assert.equal(run(exe), 0);
    globalThis.ORTHROS_FBO_CHECK = 1;
    try { assert.ok(run(exe) >= 1, 'with ?dbg=ORTHROS_FBO_CHECK=1: checked'); } finally { delete globalThis.ORTHROS_FBO_CHECK; }
  });
}

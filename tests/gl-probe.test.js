// Measurement probes of the WebGL backend (render-worker study, docs/render-worker.md): GL timing over N frames and
// the GL null mode, switched by worker debug globals at a present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { StateTable } from '../src/win32/state-table.js';

/** A WebGL-like context whose functions live on its prototype (as on a real WebGL2RenderingContext). */
function fakeGl() {
  const calls = new Map(); let next = 1;
  const hit = (k) => calls.set(k, (calls.get(k) ?? 0) + 1);
  class FakeGL {
    get drawingBufferWidth() { return 800; } get drawingBufferHeight() { return 600; }
    createTexture() { hit('createTexture'); return { id: next++ }; } createBuffer() { return { id: next++ }; } createVertexArray() { return { id: next++ }; }
    createFramebuffer() { return { id: next++ }; } createRenderbuffer() { return { id: next++ }; } createSampler() { return { id: next++ }; } deleteSampler() {}
    useProgram(p) { hit('useProgram'); } uniform1i(l, v) { hit('uniform1i:' + l.n + '=' + v); }
    getParameter() { return 32; } getExtension() { return null; } checkFramebufferStatus() { return 0x8cd5; } getError() { return 0; }
    deleteTexture() { hit('deleteTexture'); } deleteBuffer() {} deleteFramebuffer() {} deleteRenderbuffer() {} deleteVertexArray() {} deleteProgram() {}
    bindVertexArray() { hit('bindVertexArray'); } bindFramebuffer() { hit('bindFramebuffer'); } bindRenderbuffer() {} renderbufferStorage() {} framebufferRenderbuffer() {}
    disable() { hit('disable'); } enable() {} viewport() { hit('viewport'); } colorMask() {} depthMask() {} stencilMask() {} clearColor() {} clear() { hit('clear'); } scissor() {}
    clearDepth() {} clearStencil() {} blitFramebuffer() { hit('blitFramebuffer'); } flush() { hit('flush'); }
  }
  const gl = new FakeGL();
  gl.canvas = { width: 800, height: 600, transferToImageBitmap() { hit('transfer'); return {}; } };
  Object.assign(gl, {}); // (no own functions: the probes install and remove their own)
  for (const k of ['FRAMEBUFFER', 'RENDERBUFFER', 'RGBA8', 'COLOR_ATTACHMENT0', 'DEPTH24_STENCIL8', 'DEPTH_STENCIL_ATTACHMENT', 'FRAMEBUFFER_COMPLETE', 'SCISSOR_TEST', 'DRAW_FRAMEBUFFER', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT', 'STENCIL_BUFFER_BIT', 'NEAREST', 'LINEAR', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'RENDERER', 'MAX_TEXTURE_SIZE']) FakeGL.prototype[k] = k === 'FRAMEBUFFER_COMPLETE' ? 0x8cd5 : k.length;
  return { gl, calls };
}

function device(gl, logs) {
  const back = { id: 9, width: 800, height: 600, fmt: 21 };
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0, rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)),
    samplers: Array.from({ length: 16 }, () => new StateTable(16)), textures: new Array(8).fill(0), com: { implAt: () => null },
    viewport: { x: 0, y: 0, w: 800, h: 600, minZ: 0, maxZ: 1 }, backBuffers: [back], renderTarget: back,
  };
  return new WebGLDevice(gl, dev, { log: (m) => logs.push(m) });
}

test('GL timing: a report after N presents, the wrappers removed', () => {
  const { gl, calls } = fakeGl(), logs = [];
  const W = device(gl, logs);
  globalThis.ORTHROS_GL_TIME = 3;
  try {
    W.present(); // (starts at this present)
    assert.ok(Object.prototype.hasOwnProperty.call(gl, 'clear'), 'GL functions wrapped while timing');
    for (let i = 0; i < 3; i++) { W.clear(0, 0, 1, 0, 1, 0); W.present(); }
  } finally { globalThis.ORTHROS_GL_TIME = undefined; }
  const report = logs.find((m) => m.includes('GL timing report over 3 frames'));
  assert.ok(report, logs.join('\n'));
  assert.match(logs.find((m) => m.includes('GL timing by function')), /clear 1\.0 /, 'one clear per frame counted');
  assert.match(logs.find((m) => m.includes('GL timing entry points')), /clear 1\.0 /);
  assert.equal(Object.keys(gl).filter((k) => typeof gl[k] === 'function').length, 0, 'no wrapper left on the context');
  assert.ok(!Object.prototype.hasOwnProperty.call(W, 'clear'), 'no wrapper left on the device');
  assert.ok(calls.get('clear') >= 3);
});

test('GL null mode: calls that return nothing dropped; leaving it recreates the GL objects but keeps the programs', () => {
  const { gl, calls } = fakeGl(), logs = [];
  const W = device(gl, logs);
  W.textures.set(1, { tex: gl.createTexture(), target: 1 });
  const prog = { prog: { id: 99 }, u: (n) => (n === 'u_tex0' ? { n } : null), v: { s: 3 }, cs: [1, 2] };
  W.programsBySrc.set('src', prog);
  globalThis.ORTHROS_GL_NULL = 1;
  try {
    W.present();
    const before = calls.get('clear') ?? 0;
    W.clear(0, 0, 1, 0, 1, 0);
    assert.equal(calls.get('clear') ?? 0, before, 'clear dropped');
    const t = calls.get('createTexture'); gl.createTexture(); assert.equal(calls.get('createTexture'), t + 1, 'creation kept (its result is used)');
    globalThis.ORTHROS_GL_NULL = 0;
    W.present();
  } finally { globalThis.ORTHROS_GL_NULL = undefined; }
  assert.equal(Object.keys(gl).filter((k) => typeof gl[k] === 'function').length, 0, 'stubs removed');
  assert.equal(W.textures.size, 0, 'texture records dropped (re-uploaded on use)');
  assert.ok(calls.get('deleteTexture') >= 1, 'GL objects deleted');
  assert.equal(W.programsBySrc.get('src'), prog, 'programs kept');
  assert.equal(prog.v, undefined, 'program uniforms marked unsent'); assert.equal(prog.cs, null);
  assert.equal(calls.get('uniform1i:u_tex0=0'), 1, 'sampler unit set again');
  const n = calls.get('clear') ?? 0; W.clear(0, 0, 1, 0, 1, 0); assert.equal(calls.get('clear'), n + 1, 'clear issued again');
  assert.ok(logs.some((m) => m.includes('GL null mode on')) && logs.some((m) => m.includes('GL null mode off')));
});

test('GL timing from a given frame on (N@F): nothing timed before that frame', () => {
  const { gl } = fakeGl(), logs = [];
  const W = device(gl, logs);
  globalThis.ORTHROS_GL_TIME = '2@4';
  try {
    for (let i = 0; i < 3; i++) W.present(); // frames 1..3
    assert.ok(!Object.prototype.hasOwnProperty.call(gl, 'clear'), 'not started before frame 4');
    W.present(); // frame 4: starts
    assert.ok(Object.prototype.hasOwnProperty.call(gl, 'clear'), 'started at frame 4');
    W.present(); W.present();
  } finally { globalThis.ORTHROS_GL_TIME = undefined; }
  assert.ok(logs.some((m) => m.includes('GL timing report over 2 frames')), logs.join('\n'));
});

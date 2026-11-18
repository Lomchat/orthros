// The depth-stencil surface the game selects (Direct3D 9 SetDepthStencilSurface) is the one the WebGL backend draws
// with (d3d8-webgl.js syncDepth). The backend gave every render target a depth-stencil of its own (the back buffers one
// shared): a scene drawn into a texture with the back buffer's depth surface tested against a depth of its own, a
// surface selected for a render target was ignored, and NULL (no depth: the tests pass, nothing written) still tested
// and wrote depth. A target smaller than its depth surface needs a storage of its own size (WebGL 2: a framebuffer whose
// attachments differ in size is incomplete, nothing is drawn). Checked on both paths: the backend on the emulator's
// thread and behind the render worker's recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { fakeGl } from './fake-gl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { OP_NAMES } from '../src/gfx/cmd-ring.js';

const X8R8G8B8 = 22, A8R8G8B8 = 21, D24S8 = 75, CLEAR_TARGET = 1, CLEAR_ZBUFFER = 2, CLEAR_STENCIL = 4;

for (const recorded of [false, true]) {
  test(`draws and clears use the depth-stencil the game selected, none for NULL, one storage per depth surface${recorded ? ' (render worker)' : ''}`, () => {
    const { gl, calls } = fakeGl(320, 240);
    const backend = (dev) => new WebGLDevice(gl, dev, {});
    let gfx = { createDevice: backend }, link = null;
    if (recorded) {
      const words = new Int32Array(1 << 15), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: backend });
      link = new RenderLink({ words, replayer, ack });
      gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
    }
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16);
    [320, 240, X8R8G8B8, 1, 0, 0, 1, 0, 1, 1, D24S8, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v)); // (windowed, automatic D24S8)
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    const make = (name, ...args) => { assert.equal(call(name, ...args, out), 0, name); return mem.read32(out); };
    const back = make('GetBackBuffer', 0, 0, 0), auto = make('GetDepthStencilSurface');
    const tex = make('CreateTexture', 320, 240, 1, 1 /* RENDERTARGET */, A8R8G8B8, 0);
    assert.equal(com.implAt(tex).GetSurfaceLevel(ctx([tex, 0, out])), 0);
    const level = mem.read32(out), own = make('CreateDepthStencilSurface', 320, 240, D24S8, 0, 0, 0);
    const smallTex = make('CreateTexture', 128, 128, 1, 1, A8R8G8B8, 0);
    assert.equal(com.implAt(smallTex).GetSurfaceLevel(ctx([smallTex, 0, out])), 0);
    const smallLevel = mem.read32(out);
    const clear = (flags) => assert.equal(call('Clear', 0, 0, flags, 0, 0x3f800000, 0), 0);
    calls.length = 0;
    call('BeginScene');
    clear(CLEAR_TARGET | CLEAR_ZBUFFER | CLEAR_STENCIL); // 1: the back buffer, its automatic depth
    call('SetRenderTarget', 0, level); clear(CLEAR_TARGET | CLEAR_ZBUFFER); // 2: a texture with the same depth (its stencil kept: mirrored)
    call('SetDepthStencilSurface', own); clear(CLEAR_TARGET | CLEAR_ZBUFFER); // 3: the texture with a depth surface of its own
    call('SetDepthStencilSurface', 0); clear(CLEAR_TARGET); // 4: no depth
    call('SetRenderTarget', 0, smallLevel); call('SetDepthStencilSurface', auto); clear(CLEAR_TARGET); // 5: a smaller texture with the automatic depth (Direct3D: its top-left part)
    call('SetRenderTarget', 0, back); clear(CLEAR_TARGET | CLEAR_ZBUFFER); // 6: the back buffer and its depth again (mirrored back)
    call('SetRenderTarget', 0, level); clear(CLEAR_TARGET); // 7: the texture again, color only: depth attached, not mirrored
    call('EndScene');
    com.release(com.objectAt(own)); // (its storage goes with it)
    link?.publish(true);
    // (the GL calls as a working context would see them: the framebuffers bound for drawing and reading, the depth
    // attached to each, the depth blits)
    const DS = gl.DEPTH_STENCIL_ATTACHMENT, att = new Map(), size = new Map(), clears = [], blits = [], deleted = new Set();
    let draw = null, read = null, rb = null;
    for (const [k, ...a] of calls) {
      if (k === 'bindRenderbuffer') rb = a[1];
      else if (k === 'renderbufferStorage') size.set(rb, `${a[2]}x${a[3]}`);
      else if (k === 'deleteRenderbuffer') deleted.add(a[0]);
      else if (k === 'bindFramebuffer') { if (a[0] !== gl.READ_FRAMEBUFFER) draw = a[1]; if (a[0] !== gl.DRAW_FRAMEBUFFER) read = a[1]; }
      else if (k === 'framebufferRenderbuffer' && a[1] === DS) att.set(a[0] === gl.READ_FRAMEBUFFER ? read : draw, a[3]);
      else if (k === 'clear') clears.push({ fbo: draw, depth: att.get(draw) ?? null });
      else if (k === 'blitFramebuffer' && (a[8] & gl.DEPTH_BUFFER_BIT)) blits.push({ from: att.get(read), to: att.get(draw), src: [a[1], a[3]], dst: [a[5], a[7]] });
    }
    const [c1, c2, c3, c4, c5, c6, c7] = clears.slice(-7); // (the render worker's backend, made as the work is replayed, clears the canvas first)
    assert.ok(c1.depth, 'the automatic depth-stencil attached to the back buffer');
    assert.notEqual(c2.fbo, c1.fbo, 'the texture: a framebuffer of its own');
    assert.equal(c2.depth, c1.depth, 'with the same depth-stencil storage');
    assert.equal(c3.fbo, c2.fbo); assert.ok(c3.depth); assert.notEqual(c3.depth, c1.depth, 'the selected depth surface\'s own storage');
    assert.equal(c4.depth, null, 'NULL: no depth-stencil');
    assert.ok(deleted.has(c3.depth), 'a released depth surface\'s storage deleted'); assert.ok(!deleted.has(c1.depth));
    // (WebGL 2 refuses a framebuffer whose attachments differ in size — FRAMEBUFFER_INCOMPLETE_DIMENSIONS, nothing drawn)
    assert.ok(c5.depth); assert.notEqual(c5.depth, c1.depth); assert.equal(size.get(c5.depth), '128x128', 'a storage of the smaller target\'s size');
    assert.equal(c6.fbo, c1.fbo); assert.equal(c6.depth, c1.depth, 'the back buffer with its depth again');
    assert.equal(size.get(c1.depth), '320x240');
    assert.equal(c7.fbo, c2.fbo); assert.equal(c7.depth, c1.depth);
    // the automatic depth went from the back buffer (rows going up) to the texture (top row first) and back: mirrored
    // twice, through a scratch storage (rows reversed on the way in, copied straight back); a clear or draw that uses
    // neither depth nor stencil does not mirror it (a post-process pass would pay two full blits a frame)
    assert.equal(blits.length, 4, 'two mirrorings of two blits each');
    for (const [i, b] of blits.entries()) {
      if (i % 2 === 0) { assert.equal(b.from, c1.depth); assert.deepEqual(b.dst, b.src.slice().reverse(), 'rows reversed'); } else { assert.equal(b.to, c1.depth); assert.deepEqual(b.dst, b.src, 'copied back'); }
    }
  });
}

test('the render worker\'s command names are unique (a duplicate gives two commands one number)', () => {
  assert.equal(new Set(OP_NAMES).size, OP_NAMES.length, OP_NAMES.filter((n, i) => OP_NAMES.indexOf(n) !== i).join());
});

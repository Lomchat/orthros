// A draw's program and uniforms as GL holds them, in both render paths (the backend on the emulator's thread, and the
// render worker's: the device recorded, replayed into a mirror — createInlineGfx, as ?glworker=inline). The backend
// sends a program a uniform only when its source changed since that program last received it (per-program caches,
// d3d8-webgl.js applyState); a GL that keeps each program's values shows what the draw really ran with.
// - The viewport after SetRenderTarget: Direct3D resets it to the new target's surface without moving viewportVersion,
//   the cache's key for u_viewport / u_depthRange — a program drawing into the new target kept the previous target's
//   size (pre-transformed vertices placed for it). The cache now keys on the viewport object as well.
// - Several devices on one GL context (a process with two devices; a launcher's and its game's, which share the page's
//   or the render worker's context): the GL state cache is the context's (glCtx). With one per device, a device drawing
//   after the other found its own program "in use" while GL had the other's: its uniforms went to that program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGLBackend } from '../src/gfx/d3d8-webgl.js';
import { createInlineGfx } from '../src/gfx/render-host.js';
import { d3dEnv } from './d3d-random.js';

/**
 * A WebGL2 context that keeps what a draw runs with: the program in use, its uniform values (getUniform reads them
 * back: the uniform check), the vertex array bound. `corrupt(prog, name, value)`: a value changed behind the backend.
 */
function trackingGl() {
  const E = (n) => { let v = 0x10000; for (let i = 0; i < n.length; i++) v = (v * 31 + n.charCodeAt(i)) % 0xfff0000; return v + 0x10000; };
  let cur = null, vao = null;
  const draws = [], errors = [];
  const draw = () => draws.push({ prog: cur, tf: cur?.vals.get('u_tfactor') ?? null, vp: cur?.vals.get('u_viewport') ?? null, vao });
  const own = {
    canvas: { width: 320, height: 240 }, drawingBufferWidth: 320, drawingBufferHeight: 240,
    createProgram: () => ({ shaders: [], vals: new Map(), uniforms: new Set() }),
    createShader: () => ({ src: '' }), shaderSource: (s, src) => { s.src = src; }, attachShader: (p, s) => p.shaders.push(s),
    // (linking resets the uniforms; the active ones: those the sources declare)
    linkProgram: (p) => { p.vals = new Map(); p.uniforms = new Set(p.shaders.flatMap((s) => [...s.src.matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)].map((m) => m[1]))); },
    useProgram: (p) => { cur = p; }, bindVertexArray: (v) => { vao = v; },
    getUniformLocation: (p, n) => (p.uniforms.has(n.replace(/\[\d+\]$/, '')) ? { p, n } : null),
    getUniform: (p, l) => { const v = p.vals.get(l.n); return v === undefined ? null : v.length === 1 ? Math.fround(v[0]) : Float32Array.from(v); },
    getProgramParameter: (p, q) => (q === E('ACTIVE_UNIFORMS') || q === E('ACTIVE_ATTRIBUTES') ? 0 : true),
    getParameter: (q) => (q === E('CURRENT_PROGRAM') ? cur : q === E('MAX_COMBINED_TEXTURE_IMAGE_UNITS') ? 32 : q === E('MAX_TEXTURE_SIZE') ? 4096 : 0),
    getExtension: () => null, getShaderParameter: () => true, getProgramInfoLog: () => '', getShaderInfoLog: () => '', getError: () => 0,
    checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'), getSyncParameter: () => E('SIGNALED'), isEnabled: () => false,
    drawArrays: draw, drawElements: draw,
  };
  // (a uniform sent while another program is in use: GL refuses it — INVALID_OPERATION)
  const set = (l, v) => { if (!l) return; if (l.p !== cur) { errors.push(`${l.n} for a program not in use`); return; } l.p.vals.set(l.n, v); };
  const gl = new Proxy(own, { get(t, k) {
    if (k in t) return t[k];
    if (typeof k !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(k)) return k === 'TEXTURE0' ? 0x84c0 : E(k);
    if (k === 'uniform4fv') return (l, d, o = 0) => set(l, Array.from(d.subarray(o, o + 4)));
    if (k.startsWith('uniform')) return (l, ...a) => set(l, a);
    if (k.startsWith('create') || k === 'fenceSync') return () => ({});
    return () => {};
  } });
  return { gl, draws, errors, corrupt: (p, n, v) => p.vals.set(n, v) };
}

/**
 * The Direct3D 9 environment over a tracking GL, in one render path. `glOf(D)`: the WebGL backend that drew a device's
 * work (the render worker's: its mirror's, once the commands recorded so far are replayed).
 */
function setup(recorded) {
  const T = trackingGl(), logs = [], log = (m) => logs.push(m), canvas = { getContext: () => T.gl };
  let gfx, glOf;
  if (recorded) {
    gfx = createInlineGfx(canvas, log, null);
    glOf = (D) => { gfx.link.publish(true); return gfx.link.replayer.devices.get(D.d.gfx.id).gfx; };
  } else {
    const backend = createWebGLBackend(canvas, log);
    gfx = { createDevice: (dev) => backend.createDevice(dev), programCache: backend.programCache };
    glOf = (D) => D.d.gfx;
  }
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  // (320x240 X8R8G8B8, one back buffer, DISCARD, windowed, D24S8 depth-stencil)
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
  const device = () => {
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const D = { p: mem.read32(out) }; D.d = com.implAt(D.p);
    D.call = (name, ...args) => D.d[name](ctx([D.p, ...args]));
    return D;
  };
  return { T, E, gfx, glOf, logs, out, device };
}

for (const recorded of [false, true]) {
  test(`a program drawing into another render target gets that target's viewport${recorded ? ' (render worker)' : ''}`, () => {
    globalThis.ORTHROS_GL_UNIFORM_CHECK = 1; // (and the uniform check reads the values back: none stale)
    try {
      const { T, E, glOf, logs, out, device } = setup(recorded), { mem, ctx, com } = E;
      const D = device();
      // (one pre-transformed triangle, XYZRHW | DIFFUSE: every draw below runs the same program)
      const tri = E.alloc(60);
      [[0, 0], [30, 0], [0, 30]].forEach(([x, y], i) => { const a = tri + 20 * i; mem.writeF32(a, x); mem.writeF32(a + 4, y); mem.writeF32(a + 8, 0.5); mem.writeF32(a + 12, 1); mem.write32(a + 16, 0xff00ff00); });
      D.call('SetFVF', 0x44);
      assert.equal(D.call('CreateTexture', 64, 64, 1, 1, 21, 0, out, 0), 0); // (a 64x64 render target texture)
      const rt = com.implAt(mem.read32(out)).levels[0].ptrOf(ctx([])), back = D.d.backBuffers[0].ptrOf(ctx([]));
      const vp = E.alloc(24); [10, 20, 100, 50].forEach((v, i) => mem.write32(vp + 4 * i, v)); mem.writeF32(vp + 16, 0); mem.writeF32(vp + 20, 1);
      const want = [];
      const draw = () => { D.call('DrawPrimitiveUP', 4, 1, tri, 20); const v = D.d.viewport; want.push([v.x, v.y, v.w, v.h]); };
      D.call('BeginScene');
      draw(); // the back buffer: 320x240
      D.call('SetRenderTarget', 0, rt); draw(); // the texture: its whole surface, 64x64
      D.call('SetRenderTarget', 0, back); draw(); // the back buffer again
      D.call('SetViewport', vp); draw();
      const W = glOf(D);
      assert.deepEqual(want, [[0, 0, 320, 240], [0, 0, 64, 64], [0, 0, 320, 240], [10, 20, 100, 50]], 'the device\'s viewports');
      assert.equal(new Set(T.draws.map((d) => d.prog)).size, 1, 'one program for every draw');
      assert.deepEqual(T.draws.map((d) => d.vp), want, 'the viewport each draw ran with');
      assert.deepEqual({ checked: W.stats.uniformChecks, stale: W.stats.uniformStale ?? 0 }, { checked: 4, stale: 0 });
      // the uniform check finds a value GL does not hold: the program's texture factor changed behind the backend
      T.corrupt(T.draws[0].prog, 'u_tfactor', [0, 0, 0, 0]);
      draw(); glOf(D);
      assert.equal(W.stats.uniformStale, 1, 'a stale u_tfactor found');
      assert.match(logs.find((l) => typeof l === 'string' && l.includes('uniform check: stale')) ?? '', /u_tfactor 0,0,0,0 instead of 1,1,1,1/);
      assert.deepEqual(T.errors, []);
    } finally { delete globalThis.ORTHROS_GL_UNIFORM_CHECK; }
  });

  // (in the emulator's thread tests/webgl-bindings.test.js covers it; here the render worker's path and the uniform values)
  if (recorded) test(`two devices on one GL context: each draw runs with its own program, uniforms and vertex array${recorded ? ' (render worker)' : ''}`, () => {
    const { T, E, gfx, glOf, out, device: create } = setup(recorded), { mem, ctx, com } = E;
    const device = (tf, colorOp) => {
      const D = create(); D.tf = tf;
      // (XYZ | DIFFUSE vertices, unlit; stage 0: alpha = diffuse x TFACTOR, a color operation per device: two programs)
      D.call('SetFVF', 0x42); D.call('SetRenderState', 137, 0); D.call('SetRenderState', 60, tf);
      D.call('SetTextureStageState', 0, 1, colorOp); D.call('SetTextureStageState', 0, 4, 4); D.call('SetTextureStageState', 0, 5, 3); D.call('SetTextureStageState', 0, 6, 0);
      assert.equal(D.call('CreateVertexBuffer', 48, 0, 0x42, 1, out, 0), 0); D.vb = mem.read32(out);
      const b = com.implAt(D.vb); assert.equal(b.Lock(ctx([D.vb, 0, 0, out, 0])), 0);
      for (let i = 0; i < 12; i++) mem.write32(mem.read32(out) + 4 * i, i % 4 === 3 ? 0xff808080 : 0x3f000000);
      b.Unlock(ctx([D.vb]));
      D.call('SetStreamSource', 0, D.vb, 0, 16);
      return D;
    };
    const A = device(0xcc000000, 2), up = E.alloc(64);
    for (let i = 0; i < 12; i++) mem.write32(up + 4 * i, i % 4 === 3 ? 0xff808080 : 0x3f000000);
    const check = (D, what) => {
      const W = glOf(D), d = T.draws.at(-1);
      assert.deepEqual({ ownProgram: d.prog === W.lastProgram.p.prog, tfactorAlpha: d.tf?.[3], ownVertexArray: d.vao === W.curVao.vao }, { ownProgram: true, tfactorAlpha: Math.fround((D.tf >>> 24) / 255), ownVertexArray: true }, what);
    };
    A.call('BeginScene'); A.call('DrawPrimitive', 4, 0, 1); check(A, 'A alone');
    const B = device(0x40000000, 3); // (created while A draws: its set-up binds GL state too)
    for (let frame = 0; frame < 3; frame++) {
      for (const [D, name] of [[B, 'B'], [A, 'A']]) {
        D.call('DrawPrimitive', 4, 0, 1); check(D, `frame ${frame}, ${name}`);
        D.call('DrawPrimitiveUP', 4, 1, up, 16); check(D, `frame ${frame}, ${name} (UP)`);
      }
      for (const D of [A, B]) D.call('Present', 0, 0, 0, 0);
    }
    // a device's vertex buffer destroyed after the other one drew (its vertex arrays deleted — the one the cache names
    // as bound among them): the other's next draws still run with their own vertex array and program
    A.call('DrawPrimitive', 4, 0, 1); check(A, 'A with its buffer');
    B.call('DrawPrimitive', 4, 0, 1); check(B, 'B last');
    const WA = glOf(A), buffers = WA.buffers.size;
    A.call('SetStreamSource', 0, 0, 0, 0); com.release(com.objectAt(A.vb));
    B.call('DrawPrimitive', 4, 0, 1); check(B, 'B after A\'s buffer was destroyed');
    assert.equal(WA.buffers.size, buffers - 1, 'A\'s buffer destroyed');
    A.call('DrawPrimitiveUP', 4, 1, up, 16); check(A, 'A again');
    B.call('DrawPrimitiveUP', 4, 1, up, 16); check(B, 'B again');
    assert.deepEqual(T.errors, [], 'no uniform sent to a program not in use');
    assert.equal(gfx.programCache.devices.size, 2);
  });
}

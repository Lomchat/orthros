// GL state of a draw as GL really receives it (a recording context, independent of the backend's own cache).
// Texture bindings of a draw as GL really holds them (a recording context, independent of the backend's own cache):
// uploading a dirty texture while the stages are being bound must not replace a stage bound before it. Seen in a
// game: stage 0 a terrain atlas, stage 1 a shroud texture updated every frame — the upload of the shroud went
// through the active unit (unit 0, just bound for stage 0), so the draw sampled the shroud on both units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice, createWebGLBackend } from '../src/gfx/d3d8-webgl.js';
import { StateTable } from '../src/win32/state-table.js';

function recordingGl() {
  const units = new Map(); let active = 0, next = 1;
  const calls = [];
  const base = {
    stencilFunc: (...a) => calls.push(['stencilFunc', ...a]),
    canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600,
    TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
    activeTexture: (u) => { active = u - 0x84c0; },
    bindTexture: (target, t) => { units.set(active, t); },
    createTexture: () => ({ id: next++ }),
    getParameter: (p) => (p === 0x8b4d ? 32 : 0),
    getExtension: () => null,
    getShaderParameter: () => true, getProgramParameter: (p, q) => (q === 'ACTIVE_UNIFORMS' ? 0 : true),
    getUniformLocation: (p, n) => ({ n }),
    checkFramebufferStatus: () => 0,
  };
  const gl = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return k.length; // other enum constants
      if (k === 'getActiveUniform') return () => ({ name: '' });
      return () => ({});
    },
  });
  return { gl, unitTexture: (u) => units.get(u), calls };
}

test('a dirty texture uploaded while a draw binds its stages leaves the earlier stages bound', () => {
  const R = recordingGl();
  const level = (w) => ({ width: w, height: w, fmt: 21, mem: 0, pitch: w * 4, dirty: false, uploaded: false });
  const atlas = { id: 1, fmt: 21, levels: [level(8)] }, shroud = { id: 2, fmt: 21, levels: [level(4)] };
  const textures = new Map([[0x1000, atlas], [0x2000, shroud]]);
  const back = { id: 9, width: 800, height: 600, fmt: 21 };
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: [0x1000, 0x2000, 0, 0, 0, 0, 0, 0], com: { implAt: (p) => textures.get(p) ?? null },
    fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null, lights: new Map(), lightEnabled: new Set(),
    transforms: new Map(), transformSlotVersion: new Map(), transformVersion: 0, transformAllVersion: 0,
    viewport: { x: 0, y: 0, w: 800, h: 600, minZ: 0, maxZ: 1 }, backBuffers: [back], renderTarget: back,
    material: new Float32Array(17), vsConst: new Float32Array(1024), psConst: new Float32Array(128), vsConstI: new Int32Array(64), psConstI: new Int32Array(64),
    vsConstB: new Uint8Array(16), psConstB: new Uint8Array(16), constVersion: 0, lightVersion: 0, stateVersion: 0,
  };
  dev.tss[0].set(1, 4); dev.tss[1].set(1, 4); dev.tss[1].set(2, 2); dev.tss[1].set(3, 1); // stage 0 and 1: MODULATE texture
  const W = new WebGLDevice(R.gl, dev, {});
  const draw = () => { const info = W.program(); W.applyState(info.p, info); };
  const glTex = (t) => W.textures.get(t.id).tex;
  draw();
  assert.equal(R.unitTexture(0), glTex(atlas), 'first draw: unit 0 holds stage 0');
  assert.equal(R.unitTexture(1), glTex(shroud), 'first draw: unit 1 holds stage 1');
  shroud.levels[0].dirty = true; // the game updated the shroud (LockRect/UnlockRect) since the last draw
  draw();
  assert.equal(R.unitTexture(0), glTex(atlas), 'unit 0 still holds stage 0 after the upload of stage 1');
  assert.equal(R.unitTexture(1), glTex(shroud));
  assert.equal(shroud.levels[0].dirty, false, 'the dirty level was uploaded');
});

test('the stencil reference keeps the low 8 bits (Direct3D), not a clamped value (GL clamps a signed int)', () => {
  const R = recordingGl();
  const back = { id: 9, width: 800, height: 600, fmt: 21 };
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(8).fill(0), com: { implAt: () => null },
    fvf: 0x142, vertexDecl: null, vsObj: null, psObj: null, lights: new Map(), lightEnabled: new Set(),
    transforms: new Map(), transformSlotVersion: new Map(), transformVersion: 0, transformAllVersion: 0,
    viewport: { x: 0, y: 0, w: 800, h: 600, minZ: 0, maxZ: 1 }, backBuffers: [back], renderTarget: back,
    material: new Float32Array(17), vsConst: new Float32Array(1024), psConst: new Float32Array(128), vsConstI: new Int32Array(64), psConstI: new Int32Array(64),
    vsConstB: new Uint8Array(16), psConstB: new Uint8Array(16), constVersion: 0, lightVersion: 0, stateVersion: 0,
  };
  dev.rs.set(52, 1); // STENCILENABLE
  dev.rs.set(56, 5); // STENCILFUNC GREATER
  dev.rs.set(57, 0x80808080); // STENCILREF as a game sets it (a byte replicated)
  dev.rs.set(58, 0x80808080); // STENCILMASK
  const W = new WebGLDevice(R.gl, dev, {});
  const info = W.program(); W.applyState(info.p, info);
  const f = R.calls.filter((c) => c[0] === 'stencilFunc').pop();
  assert.ok(f, 'stencilFunc called');
  assert.equal(f[2], 0x80, 'reference = 0x80808080 & 0xff');
});

/**
 * A WebGL2 context keeping the state its calls leave, as GL does: the program in use (useProgram of a program that did
 * not link is refused — INVALID_OPERATION, the previous one stays), the draw framebuffer, the vertex array, units'
 * textures, capabilities and raster functions; every draw records them. `refuse(vs, fs)`: the programs that fail to link.
 */
function contextGl(refuse = () => false) {
  let next = 1, active = 0, prog = null, fbo = null, vao = null, error = 0;
  const E = (n) => { let v = 0x10000; for (let i = 0; i < n.length; i++) v = (v * 31 + n.charCodeAt(i)) % 0xfff0000; return v + 0x10000; };
  const src = new Map(), shaders = new Map(), linked = new Set(), units = new Map(), caps = new Map(), fns = new Map(), draws = [];
  const name = (o) => (o ? o.n : 0);
  const draw = () => { if (!prog) error = E('INVALID_OPERATION'); else draws.push({ prog: name(prog), fbo: name(fbo), vao: name(vao), unit0: name(units.get(0)), caps: Object.fromEntries(caps), ...Object.fromEntries(fns) }); };
  const own = {
    canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600, TEXTURE0: 0x84c0,
    shaderSource: (sh, s) => src.set(sh, s), attachShader: (p, sh) => (shaders.get(p) ?? shaders.set(p, []).get(p)).push(sh),
    linkProgram: (p) => { const [vs, fs] = (shaders.get(p) ?? []).map((sh) => src.get(sh)); if (!refuse(vs ?? '', fs ?? '')) linked.add(p); },
    getProgramParameter: (p, q) => (q === E('LINK_STATUS') ? linked.has(p) : q === E('ACTIVE_UNIFORMS') || q === E('ACTIVE_ATTRIBUTES') ? 0 : true),
    useProgram: (p) => { if (p && !linked.has(p)) error = E('INVALID_OPERATION'); else prog = p; },
    bindFramebuffer: (t, f) => { if (t !== E('READ_FRAMEBUFFER')) fbo = f; }, bindVertexArray: (v) => { vao = v; },
    activeTexture: (u) => { active = u - 0x84c0; }, bindTexture: (t, x) => units.set(active, x),
    enable: (c) => caps.set(c, true), disable: (c) => caps.set(c, false),
    drawArrays: draw, drawElements: draw, getError: () => { const e = error; error = 0; return e; },
    getShaderParameter: () => true, getExtension: () => null, getParameter: (p) => (p === E('MAX_COMBINED_TEXTURE_IMAGE_UNITS') ? 32 : 0),
    getUniformLocation: (p, n) => ({ n }), getActiveUniform: () => ({ name: '' }), getProgramInfoLog: () => 'refused', getShaderInfoLog: () => '',
    checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'), getSyncParameter: () => E('SIGNALED'), isEnabled: () => false,
  };
  for (const f of ['blendFuncSeparate', 'blendEquationSeparate', 'colorMask', 'depthMask', 'depthFunc', 'viewport', 'cullFace', 'frontFace']) own[f] = (...a) => fns.set(f, a.join(','));
  const gl = new Proxy(own, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) return E(k);
      if (k.startsWith('create') || k === 'fenceSync') return () => ({ n: next++ });
      return () => {};
    },
  });
  return { gl, draws, program: () => prog, error: () => own.getError() };
}

/** a Direct3D 9 device as the backend reads it: an FVF, a texture on stage 0 (MODULATE), its own back buffer */
function fakeDevice(id, fvf, tex) {
  const back = { id, width: 800, height: 600, fmt: 21 };
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: [0x1000, 0, 0, 0, 0, 0, 0, 0], com: { implAt: (p) => (p === 0x1000 ? tex : null) },
    fvf, vertexDecl: null, vsObj: null, psObj: null, lights: new Map(), lightEnabled: new Set(),
    transforms: new Map(), transformSlotVersion: new Map(), transformVersion: 0, transformAllVersion: 0,
    viewport: { x: 0, y: 0, w: 800, h: 600, minZ: 0, maxZ: 1 }, backBuffers: [back], renderTarget: back,
    material: new Float32Array(17), vsConst: new Float32Array(1024), psConst: new Float32Array(128), vsConstI: new Int32Array(64), psConstI: new Int32Array(64),
    vsConstB: new Uint8Array(16), psConstB: new Uint8Array(16), constVersion: 0, lightVersion: 0, stateVersion: 0,
  };
  dev.tss[0].set(1, 4); dev.rs.set(137, 0); // stage 0 MODULATE, no lighting
  return dev;
}
const texture = (id) => ({ id, fmt: 21, levels: [{ width: 8, height: 8, fmt: 21, mem: 0, pitch: 32, dirty: false, uploaded: false }] });
const drawUP = (W, stride) => W.drawPrimitiveUP(4, 1, new Uint8Array(3 * stride), stride); // (one triangle from memory)

// Two Direct3D devices on one WebGL context (both render paths make every device of a context from one backend): the
// GL state cache is the context's. With one per device, A -> B -> A left device A believing its program, framebuffer,
// vertex array, texture and blending still bound — A's draw ran with B's, without a GL error.
test('two devices on one context: a device drawing after another finds its own GL state bound again', () => {
  const C = contextGl(), backend = createWebGLBackend({ getContext: () => C.gl }, () => {});
  const devA = fakeDevice(9, 0x142, texture(1)), devB = fakeDevice(19, 0x152, texture(2));
  devA.rs.set(27, 1); devA.rs.set(19, 5); devA.rs.set(20, 6); // A blends (SRCALPHA, INVSRCALPHA)
  devB.rs.set(22, 1); devB.viewport = { x: 0, y: 0, w: 400, h: 300, minZ: 0, maxZ: 1 }; // B: no culling, another viewport
  const A = backend.createDevice(devA), B = backend.createDevice(devB);
  drawUP(A, 24); drawUP(B, 36); drawUP(A, 24);
  const [a1, b, a2] = C.draws;
  for (const k of ['prog', 'fbo', 'vao', 'unit0']) assert.notEqual(b[k], a1[k], `B draws with its own ${k}`);
  assert.deepEqual(a2, a1, "A's second draw: the GL state of its first");
  assert.equal(C.error(), 0);
});

// A program GL refuses to link: never made current, never drawn with (GL would run the program left in use), its
// draws counted and logged once, not learned for later sessions; the other programs draw as before.
test('a program that fails to link: its draws are skipped, the program in use and the cache stay right', () => {
  const C = contextGl((vs) => vs.includes('a_normal')), logs = [];
  const backend = createWebGLBackend({ getContext: () => C.gl }, (m) => logs.push(m));
  const dev = fakeDevice(9, 0x142, texture(1)), W = backend.createDevice(dev);
  drawUP(W, 24);
  assert.equal(C.draws.length, 1);
  const good = C.program();
  dev.fvf = 0x152; dev.programVersion++; // (a normal: the program that fails)
  drawUP(W, 36); drawUP(W, 36);
  assert.equal(C.draws.length, 1, 'no draw with the refused program');
  assert.equal(W.stats.failedDraws, 2);
  assert.equal(logs.filter((l) => l.includes('link error')).length, 1, 'link error logged once');
  assert.equal(logs.filter((l) => l.includes('are skipped')).length, 1, 'skipped draws logged once');
  assert.equal(C.program(), good, 'GL kept the program in use'); assert.equal(W.gs.prog, good, 'and the cache says so');
  dev.fvf = 0x142; dev.programVersion++;
  drawUP(W, 24);
  assert.equal(C.draws.length, 2); assert.equal(C.draws[1].prog, C.draws[0].prog);
  assert.equal(C.error(), 0, 'no GL error');
  assert.equal(backend.programCache.learned.length, 1, 'the refused program is not learned');
});

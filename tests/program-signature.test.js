// The WebGL backend finds programs by a numeric signature of their inputs (program() / programSignature) and
// builds the key strings only for a new combination (programUncached). A state that feeds the key but is missing
// from the signature would silently reuse a wrong program: random sequences of state changes on a device over a
// mock GL check that program() always yields the program programUncached builds for the current state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice, createWebGLBackend } from '../src/gfx/d3d8-webgl.js';
import { RS, TSS, PROGRAM_RS, PROGRAM_TSS } from '../src/gfx/d3d8-shaders.js';
import { StateTable } from '../src/win32/state-table.js';

/** A WebGL2 context that accepts every call: objects are plain tokens, statuses succeed. */
function mockGl() {
  const base = { canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600 };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return k.length; // enum constants
      if (k === 'getShaderParameter' || k === 'getProgramParameter') return (o, p) => (p === 'ACTIVE_UNIFORMS'.length ? 0 : true);
      if (k === 'getExtension') return () => null;
      if (k === 'getParameter') return () => 0;
      if (k === 'getUniformLocation') return (p, n) => ({ n });
      return () => ({});
    },
  });
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('program signature: program() matches programUncached() over random state changes', () => {
  const textures = new Map([[0x1000, { id: 1, levels: [{}] }], [0x2000, { id: 2, faces: [[{}]] }], [0x3000, { id: 3, depth: 4, levels: [{}] }]]);
  const lights = new Map([[0, Float32Array.from({ length: 26 }, (_, i) => (i === 0 ? 1 : 0))], [1, Float32Array.from({ length: 26 }, (_, i) => (i === 0 ? 3 : 0))]]);
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: (p) => textures.get(p) ?? null },
    fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null, lights, lightEnabled: new Set([0]), lightVersion: 0,
    transforms: new Map(), transformSlotVersion: new Map(),
  };
  const W = new WebGLDevice(mockGl(), dev, {});
  const R = rng(7), pick = (a) => a[Math.floor(R() * a.length)];
  const rsStates = [...PROGRAM_RS], tssStates = [...PROGRAM_TSS];
  const values = [0, 1, 2, 3, 4, 5, 7, 8, 13, 22, 24, 25, 0x10000, 0x20000, 0x30000, 0x100, 0x102];
  let checked = 0;
  for (let step = 0; step < 3000; step++) {
    // one change; programVersion moves as the Direct3D devices move it: for the states of PROGRAM_RS / PROGRAM_TSS,
    // textures of another kind, vertex format, lights (and lightVersion, as SetLight / LightEnable move it; any other
    // state changed must not matter to the program)
    let bump = true;
    switch (Math.floor(R() * 7)) {
      case 0: dev.rs.set(pick(rsStates), pick(values)); break;
      case 1: dev.tss[Math.floor(R() * 3)].set(pick(tssStates), pick(values)); break;
      case 6: { // any state
        if (R() < 0.5) { const st = Math.floor(R() * 210); dev.rs.set(st, pick(values)); bump = PROGRAM_RS.has(st); }
        else { const ty = Math.floor(R() * 33); dev.tss[Math.floor(R() * 3)].set(ty, pick(values)); bump = PROGRAM_TSS.has(ty); }
        break;
      }
      case 2: dev.textures[Math.floor(R() * 3)] = pick([0, 0x1000, 0x2000, 0x3000]); break;
      case 3: dev.fvf = pick([0x152, 0x142, 0x1c4, 0x112, 0x2c4]); break;
      case 4: { const i = Math.floor(R() * 2); if (dev.lightEnabled.has(i)) dev.lightEnabled.delete(i); else dev.lightEnabled.add(i); dev.lightVersion++; break; }
      default: lights.get(Math.floor(R() * 2))[0] = pick([1, 2, 3]); dev.lightVersion++; break;
    }
    if (bump) dev.programVersion++;
    const got = W.program();
    const want = W.programUncached();
    assert.equal(got.p.key, want.p.key, `step ${step}`);
    checked++;
  }
  assert.equal(checked, 3000);
  assert.ok(W.programs.size > 20, 'many distinct programs exercised');
});

// Programs compiled ahead: a device builds a program at a draw and learns it (key, sources); another device given
// that list compiles it before its first draw and takes it then (no build at the draw), found by its sources whatever
// key it had (keys name shader objects by handle, which vary between sessions) — a learned program of other sources
// (other translators) is not taken: the draw builds the current sources.
test('program cache: learned programs compiled ahead are used at the first draw by their sources', () => {
  const mk = (programCache) => {
    const dev = {
      api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
      rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
      textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
      lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
    };
    return { dev, W: new WebGLDevice(mockGl(), dev, { programCache }) };
  };
  const cache = () => ({ queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: true, started: 0, hits: 0 });
  const c1 = cache(), a = mk(c1);
  const key = a.W.program().p.key;
  assert.equal(a.W.stats.programs, 1);
  assert.equal(c1.learned.length, 1); assert.equal(c1.learned[0].key, key);
  const c2 = cache(), b = mk(c2);
  c2.queue.push({ ...c1.learned[0], key: 'vs9:1234|another handle', id: 'x1' }, c1.learned[0]);
  b.W.prewarmStep();
  assert.equal(c2.started, 1, 'the same sources compiled once'); assert.equal(c2.queue.length, 0);
  assert.equal(b.W.program().p.key, key);
  assert.equal(b.W.stats.programs, 0, 'no build at the draw'); assert.equal(c2.hits, 1); assert.equal(c2.learned.length, 0, 'nothing new learned');
  assert.deepEqual(c2.used, ['x1'], 'its use reported by id');
  // (a fixed-function program over an FVF layout is regenerated from its key — tests/program-version.test.js: the
  // same with a key that names a shader object, whose sources cannot be)
  const c3 = cache(), d = mk(c3), shaderKey = 'vs9:1234|ps9:77:tttttttttttttttt:0:0';
  c3.queue.push({ ...c1.learned[0], key: shaderKey, vs: c1.learned[0].vs + '\n// other translator' });
  d.W.prewarmStep();
  assert.equal(d.W.program().p.key, key);
  assert.equal(c3.hits, 0); assert.equal(d.W.stats.programs, 1, 'built from the current sources'); assert.equal(c3.learned.length, 1);
  assert.deepEqual(c3.used, []);
});

// Program keys record states the generated sources may ignore (an argument of a texture operation that does not
// read it) and name shader objects by handle (two objects of the same code): keys that build the same sources share
// one GL program, and a shader object deleted takes the programs of its keys with it (the other keys rebuild).
test('programs: keys of the same sources share one GL program', () => {
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
    lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
  };
  const W = new WebGLDevice(mockGl(), dev, {});
  const p1 = W.program().p;
  dev.tss[0].set(TSS.COLORARG0, 35); dev.programVersion++; // (MODULATE reads arguments 1 and 2 only)
  const p2 = W.program().p;
  assert.equal(W.programs.size, 2, 'two keys'); assert.equal(p2, p1, 'one program'); assert.equal(W.stats.programs, 1); assert.equal(W.stats.programsShared, 1);
  dev.tss[0].set(TSS.COLOROP, 2); dev.programVersion++; // (SELECTARG1: other sources)
  assert.notEqual(W.program().p, p1); assert.equal(W.stats.programs, 2);
  // shader objects: the programs they are part of go with them, every key of those programs too
  const shA = { handle: 7 }, shB = { handle: 9 };
  p1.shaders.add(shA);
  W.deletePixelShader(shB);
  assert.equal(W.programs.size, 3);
  W.deletePixelShader(shA);
  assert.equal(W.programs.size, 1, 'both keys of the shared program dropped'); assert.equal(W.programsBySrc.size, 1);
  dev.tss[0].set(TSS.COLOROP, 4); dev.programVersion++;
  assert.notEqual(W.program().p, p1, 'built again'); assert.equal(W.stats.programs, 3);
});

/** A GL context over mockGl whose fences signal when `gpu.caughtUp` is set, counting program queries and live fences. */
function fencedGl(base, gpu) {
  return new Proxy({}, { get(t, k) {
    if (k === 'fenceSync') return () => { gpu.fences++; return { fence: true }; };
    if (k === 'deleteSync') return () => { gpu.fences--; };
    if (k === 'getSyncParameter') return (f, p) => (p === base.SYNC_STATUS && gpu.caughtUp ? base.SIGNALED : base.UNSIGNALED);
    if (k === 'getProgramParameter') return (o, p) => { gpu.queries++; return base.getProgramParameter(o, p); };
    return base[k];
  } });
}

// Before the game has a device (it computes for a long time before its window), the backend starts the learned
// programs without querying anything (a query waits for the GPU process). They are resolved (link status, uniforms)
// only when the GPU process has caught up: a fence placed when the worker yields (afterSlice) found signaled when it
// comes back (beforeSlice). The draw that takes one then queries nothing.
test('program cache: learned programs started before the device, resolved when the GPU process has caught up', () => {
  const a = new WebGLDevice(mockGl(), {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
    lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
  }, { programCache: { queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: false, started: 0, hits: 0 } });
  a.program();
  const learned = a.pc.learned;
  const gpu = { caughtUp: false, queries: 0, fences: 0 };
  const backend = createWebGLBackend({ getContext: () => fencedGl(mockGl(), gpu) }, () => {});
  const pc = backend.programCache;
  backend.beforeSlice(2); backend.afterSlice();
  assert.equal(gpu.fences, 0, 'nothing pending: no fence');
  pc.queue.push(...learned);
  backend.beforeSlice(2); backend.prewarm(); backend.afterSlice();
  assert.equal(pc.started, 1); assert.equal(pc.pending, 1); assert.equal(gpu.queries, 0, 'started, not waited for'); assert.equal(gpu.fences, 1);
  backend.beforeSlice(2); backend.prewarm(); backend.afterSlice();
  assert.equal(gpu.queries, 0, 'the GPU process is behind: not resolved'); assert.equal(gpu.fences, 1, 'one fence at a time');
  gpu.caughtUp = true;
  backend.beforeSlice(2);
  assert.equal(pc.resolved, 1); assert.equal(pc.pending, 0); const q = gpu.queries; assert.ok(q > 0);
  assert.equal(gpu.fences, 0);
  backend.afterSlice(); backend.beforeSlice(2);
  assert.equal(gpu.queries, q, 'nothing left to resolve: no query'); assert.equal(gpu.fences, 0);
  const W = backend.createDevice({ ...a.dev, programVersion: 1 });
  assert.equal(W.program().p.key, learned[0].key);
  assert.equal(W.stats.programs, 0); assert.equal(pc.hits, 1); assert.equal(pc.resolvedHits, 1);
  assert.equal(gpu.queries, q, 'no query at the draw');
});

// One vertex shader over two declarations that place or type its inputs differently generates the same GLSL: the
// two keys share a GL program, but not its vertex array objects (a VAO holds one layout's offsets and types).
test('programs: a program shared by keys of other vertex layouts binds each layout\'s attributes', () => {
  const vs20 = new Uint32Array([0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff]);
  const decl = (texOff, texType) => {
    const attrs = [{ name: 'pos', sem: 's0_0', offset: 0, comps: 3, type: 'float', usage: 0, index: 0, reg: 0 }, { name: 'tex0', sem: 's5_0', offset: texOff, comps: 2, type: texType, usage: 5, index: 0, reg: 7 }];
    return { layout: { streams: new Map([[0, { attrs, stride: 20 }]]), elements: [], rhw: false, texCount: 1, blend: 0, attrs, dx9: true } };
  };
  const vb = { id: 5 }, calls = [], gl = mockGl();
  const recording = new Proxy({}, { get(t, k) { return k === 'vertexAttribPointer' ? (...a) => { calls.push(a); } : gl[k]; } });
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: (p) => (p === 1 ? vb : null) }, fvf: 0, vertexDecl: decl(12, 'float'), vsObj: { handle: 3, code: vs20 }, psObj: null,
    lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(), streams: [{ vb: 1, stride: 20, offset: 0 }],
  };
  const W = new WebGLDevice(recording, dev, {});
  W.glBuffer = () => ({ buf: {} });
  const texPointer = () => calls.find((c) => c[0] === 1)?.slice(1, 6) ?? null;
  const a = W.program(); calls.length = 0; W.bindAttributes(a.p, a.L);
  assert.deepEqual(texPointer(), [2, recording.FLOAT, false, 20, 12]);
  const declA = dev.vertexDecl;
  dev.vertexDecl = decl(16, 'half'); dev.programVersion++;
  const b = W.program();
  assert.equal(b.p, a.p, 'one GL program for both keys');
  calls.length = 0; W.bindAttributes(b.p, b.L);
  assert.deepEqual(texPointer(), [2, recording.HALF_FLOAT, false, 20, 16], 'the second layout\'s offset and type');
  dev.vertexDecl = declA; dev.programVersion++;
  const c = W.program(); calls.length = 0; W.bindAttributes(c.p, c.L);
  assert.equal(W.curVao.specs[4 + 5], 12, 'the first layout\'s VAO again');
  // (UP draws: a VAO per stride, per layout too)
  calls.length = 0; W.bindAttributes(c.p, c.L, 20);
  assert.deepEqual(texPointer(), [2, recording.FLOAT, false, 20, 12]);
  dev.vertexDecl = decl(16, 'half'); dev.programVersion++;
  const d = W.program(); calls.length = 0; W.bindAttributes(d.p, d.L, 20);
  assert.deepEqual(texPointer(), [2, recording.HALF_FLOAT, false, 20, 16]);
  // declaration objects of the same elements (one per mesh, or created again each frame) share their VAOs: no VAO
  // created, no owner kept per object
  const vaos = W.stats.vaos;
  for (let i = 0; i < 50; i++) {
    dev.vertexDecl = decl(i & 1 ? 16 : 12, i & 1 ? 'half' : 'float'); dev.programVersion++;
    const e = W.program(); calls.length = 0; W.bindAttributes(e.p, e.L);
    assert.equal(W.curVao.specs[4 + 5], i & 1 ? 16 : 12);
    W.bindAttributes(e.p, e.L, 20);
  }
  assert.equal(W.stats.vaos, vaos, 'no VAO per declaration object'); assert.equal(a.p.vaoOwners.size, 2);
});

// With KHR_parallel_shader_compile, builds run on other threads of the GPU process: when it has caught up, only those
// it reports finished are resolved (the completion query does not wait); an unfinished one taken by a draw is resolved
// there. A resolve leaves its
// program in use: the device's GL state cache follows.
test('program cache: parallel compilation, only finished builds resolved', () => {
  const src = new WebGLDevice(mockGl(), {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
    lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
  }, { programCache: { queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: false, started: 0, hits: 0 } });
  src.program();
  src.dev.tss[0].set(TSS.COLOROP, 2); src.dev.programVersion++; src.program();
  const learned = src.pc.learned;
  assert.equal(learned.length, 2);
  const gl = mockGl(), ext = { COMPLETION_STATUS_KHR: 0x91b1 }, finished = new Set();
  let linkQueries = 0;
  const fake = new Proxy({}, { get(t, k) {
    if (k === 'getSyncParameter') return () => gl.SIGNALED;
    if (k === 'getExtension') return (n) => (n === 'KHR_parallel_shader_compile' ? ext : null);
    if (k === 'createProgram') return () => ({ n: Math.random() });
    if (k === 'getProgramParameter') return (o, p) => { if (p === ext.COMPLETION_STATUS_KHR) return finished.has(o); linkQueries++; return gl.getProgramParameter(o, p); };
    return gl[k];
  } });
  const backend = createWebGLBackend({ getContext: () => fake }, () => {});
  const pc = backend.programCache;
  assert.equal(pc.parallel, true);
  pc.queue.push(...learned);
  backend.prewarm(); backend.afterSlice();
  assert.equal(pc.started, 2); assert.equal(pc.pending, 2);
  const [e1, e2] = [...pc.ready.values()];
  backend.beforeSlice(4); backend.afterSlice();
  assert.equal(pc.resolved ?? 0, 0); assert.equal(linkQueries, 0, 'unfinished: not resolved');
  finished.add(e2.prog);
  const W = backend.createDevice({ ...src.dev, programVersion: 100 });
  const W0 = new WebGLDevice(fake, { ...src.dev }, { programCache: pc }); W0.gs.prog = { other: true }; // (an older device, still alive)
  const Wx = new WebGLDevice(fake, { ...src.dev }, { programCache: pc }); Wx.destroy();
  backend.beforeSlice(4);
  assert.equal(pc.resolved, 1); assert.ok(e2.rec); assert.equal(e1.rec, null);
  assert.equal(W.gs.prog, e2.prog, 'the device knows the program left in use');
  assert.equal(W0.gs.prog, e2.prog, 'so does every other live device of the context'); assert.equal(pc.devices.size, 2);
  // the first learned program (unfinished) is taken by a draw: resolved there
  src.dev.tss[0].set(TSS.COLOROP, 4); src.dev.programVersion++;
  W.dev.tss[0].set(TSS.COLOROP, 4); W.dev.programVersion++;
  const q = linkQueries;
  assert.equal(W.program().p.key, learned[0].key);
  assert.ok(linkQueries > q, 'resolved at the draw'); assert.equal(pc.pending, 0); assert.equal(W.stats.programs, 0);
  W.dev.tss[0].set(TSS.COLOROP, 2); W.dev.programVersion++;
  const q2 = linkQueries;
  assert.equal(W.program().p.key, learned[1].key); assert.equal(linkQueries, q2, 'resolved ahead: no query'); assert.equal(pc.resolvedHits, 1);
});

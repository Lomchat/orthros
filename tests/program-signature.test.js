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
  const c3 = cache(), d = mk(c3);
  c3.queue.push({ ...c1.learned[0], vs: c1.learned[0].vs + '\n// other translator' });
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

// Before the game has a device (it computes for a long time before its window), the backend starts the learned
// programs and resolves them (link status, uniforms) a while later: the draw that takes one then queries nothing.
test('program cache: learned programs started and resolved before the device exists', () => {
  const a = new WebGLDevice(mockGl(), {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
    lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
  }, { programCache: { queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: false, started: 0, hits: 0 } });
  a.program();
  const learned = a.pc.learned;
  let queries = 0;
  const gl = mockGl(), getProgramParameter = gl.getProgramParameter;
  const counting = new Proxy({}, { get(t, k) { return k === 'getProgramParameter' ? (o, p) => { queries++; return getProgramParameter(o, p); } : gl[k]; } });
  const backend = createWebGLBackend({ getContext: () => counting }, () => {});
  const pc = backend.programCache;
  pc.queue.push(...learned);
  backend.prewarm();
  assert.equal(pc.started, 1); assert.equal(queries, 0, 'started, not waited for');
  backend.prewarm();
  assert.equal(pc.resolved ?? 0, 0, 'too recent to be resolved without waiting');
  for (const e of pc.ready.values()) e.t0 -= 5000;
  backend.prewarm();
  assert.equal(pc.resolved, 1); const q = queries; assert.ok(q > 0);
  const W = backend.createDevice({ ...a.dev, programVersion: 1 });
  assert.equal(W.program().p.key, learned[0].key);
  assert.equal(W.stats.programs, 0); assert.equal(pc.hits, 1); assert.equal(pc.resolvedHits, 1);
  assert.equal(queries, q, 'no query at the draw');
});

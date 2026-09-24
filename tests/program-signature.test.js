// The WebGL backend finds programs by a numeric signature of their inputs (program() / programSignature) and
// builds the key strings only for a new combination (programUncached). A state that feeds the key but is missing
// from the signature would silently reuse a wrong program: random sequences of state changes on a device over a
// mock GL check that program() always yields the program programUncached builds for the current state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
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
    fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null, lights, lightEnabled: new Set([0]),
    transforms: new Map(), transformSlotVersion: new Map(),
  };
  const W = new WebGLDevice(mockGl(), dev, {});
  const R = rng(7), pick = (a) => a[Math.floor(R() * a.length)];
  const rsStates = [...PROGRAM_RS], tssStates = [...PROGRAM_TSS];
  const values = [0, 1, 2, 3, 4, 5, 7, 8, 13, 22, 24, 25, 0x10000, 0x20000, 0x30000, 0x100, 0x102];
  let checked = 0;
  for (let step = 0; step < 3000; step++) {
    // one change; programVersion moves as the Direct3D devices move it: for the states of PROGRAM_RS / PROGRAM_TSS,
    // textures of another kind, vertex format, lights (any other state changed must not matter to the program)
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
      case 4: { const i = Math.floor(R() * 2); if (dev.lightEnabled.has(i)) dev.lightEnabled.delete(i); else dev.lightEnabled.add(i); break; }
      default: lights.get(Math.floor(R() * 2))[0] = pick([1, 2, 3]); break;
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

// Programs predicted from a D3DX effect's pass (WebGLDevice.predictPrograms) are only worth their builds if the draw
// that needs one finds it by its sources: the sources a prediction guesses (predictedSources) must be those the draw
// builds (programUncached). A change to either alone silently turns every prediction into a wasted build — this checks
// that a pass's pair is taken at its first draw, without a build there, and learned for the next sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { assembleShader } from '../src/win32/d3dx9-asm.js';
import { StateTable } from '../src/win32/state-table.js';
import { noopGl } from '../tools/bench/noop-gl.mjs';

const VS = 'vs_2_0\ndcl_position v0\ndcl_color v1\ndcl_texcoord v2\ndp4 oPos.x, v0, c0\ndp4 oPos.y, v0, c1\ndp4 oPos.z, v0, c2\ndp4 oPos.w, v0, c3\nmov oD0, v1\nmov oT0, v2\n';
const PS = (op) => `ps_2_0\ndcl t0\ndcl v0\ndcl_2d s0\ntexld r0, t0, s0\n${op} r0, r0, v0\nmov oC0, r0\n`;

test('a pass predicted from its effect gives its draws their programs without a build at the draw', () => {
  const vs = assembleShader(VS), ps1 = assembleShader(PS('mul')), ps2 = assembleShader(PS('add'));
  const dev = {
    api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: () => null },
    fvf: 0x142, vertexDecl: null, vsObj: { code: vs, handle: 1 }, psObj: null, lights: new Map(), lightEnabled: new Set(), lightVersion: 0,
    transforms: new Map(), transformSlotVersion: new Map(),
  };
  const pc = { queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: true, started: 0, pending: 0, hits: 0, devices: new Set() };
  const W = new WebGLDevice(noopGl(800, 600, { compileMs: 1 }), dev, { programCache: pc });
  // the pass: one vertex shader, an array of two pixel shaders, alpha test on (GREATEREQUAL) as its draws will have it
  dev.rs.set(15, 1); dev.rs.set(25, 7);
  W.predictPrograms({ vs: [vs], ps: [ps1, ps2], at: 1, af: 7, fog: 0, table: 0 });
  for (let i = 0; i < 4; i++) W.predictStep();
  assert.equal(pc.predictStarted, 2);
  for (const [ps, n] of [[ps2, 1], [ps1, 2]]) {
    dev.psObj = { code: ps, handle: 2 + n }; dev.programVersion++;
    W.program();
    assert.equal(W.stats.programs, 0, 'no program built at the draw');
    assert.equal(pc.predictHits, n);
  }
  assert.equal(pc.learned.length, 2, 'the predicted programs taken are learned for the next sessions');
});

// Texture bindings of a draw as GL really holds them (a recording context, independent of the backend's own cache):
// uploading a dirty texture while the stages are being bound must not replace a stage bound before it. Seen in a
// game: stage 0 a terrain atlas, stage 1 a shroud texture updated every frame — the upload of the shroud went
// through the active unit (unit 0, just bound for stage 0), so the draw sampled the shroud on both units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { StateTable } from '../src/win32/state-table.js';

function recordingGl() {
  const units = new Map(); let active = 0, next = 1;
  const base = {
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
  return { gl, unitTexture: (u) => units.get(u) };
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

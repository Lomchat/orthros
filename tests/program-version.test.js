// Learned GL programs and the translators' versions. A fixed-function program with an FVF layout is regenerated from
// its key alone (ffProgramFromKey): random draw states on a device over a mock GL check that the key a draw builds
// regenerates exactly the sources it was built from. The GLSL every translator generates for a fixed corpus is
// hashed: when it changes, PROGRAM_GLSL_VERSION (program-id.js) must change too — learned programs of an older version
// are then no longer compiled ahead (the server lists a session only those of its version).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { RS, TSS, PROGRAM_RS, PROGRAM_TSS, ffProgramFromKey, translateVertexShader, translatePixelShader, declLayout } from '../src/gfx/d3d8-shaders.js';
import { translateVertexShader9, translatePixelShader9 } from '../src/gfx/d3d9-shaders.js';
import { PROGRAM_GLSL_VERSION, ffKeyRegenerable } from '../src/gfx/program-id.js';
import { StateTable } from '../src/win32/state-table.js';

function mockGl() {
  const base = { canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600 };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return k.length;
      if (k === 'getShaderParameter' || k === 'getProgramParameter') return (o, p) => (p === 'ACTIVE_UNIFORMS'.length ? 0 : true);
      if (k === 'getExtension') return () => null;
      if (k === 'getParameter') return () => 0;
      if (k === 'getUniformLocation') return (p, n) => ({ n });
      return () => ({});
    },
  });
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** a device with random fixed-function states, `built` collecting every program its backend builds (key, sources) */
function randomDevices(api9, seed, steps, onBuild) {
  const textures = new Map([[0x1000, { id: 1, levels: [{}] }], [0x2000, { id: 2, faces: [[{}]] }], [0x3000, { id: 3, depth: 4, levels: [{}] }]]);
  const light = (type) => Float32Array.from({ length: 26 }, (_, i) => (i === 0 ? type : 0));
  const lights = new Map([[0, light(1)], [1, light(3)], [2, light(2)]]);
  const dev = {
    api9, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
    textures: new Array(16).fill(0), com: { implAt: (p) => textures.get(p) ?? null },
    fvf: 0x152, vertexShader: 0x152, vertexShaders: new Map(), pixelShaders: new Map(), pixelShader: 0, vertexDecl: null, vsObj: null, psObj: null,
    lights, lightEnabled: new Set([0]), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
  };
  const W = new WebGLDevice(mockGl(), dev, {});
  const compile = W.compile.bind(W);
  W.compile = (vs, fs, key, attrs) => { onBuild(key, vs, fs, attrs); return compile(vs, fs, key, attrs); };
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)];
  const rsStates = [...PROGRAM_RS], tssStates = [...PROGRAM_TSS];
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 22, 24, 25, 26, 0x10000, 0x10001, 0x20000, 0x30000, 0x100, 0x102, 0x103, 0x104, 0x22, 0x13];
  const fvfs = [0x152, 0x142, 0x1c4, 0x112, 0x2c4, 0x004, 0x044, 0x144, 0x1006 | 0x10 | 0x100, 0x008 | 0x10 | 0x200, 0x00e | 0x40 | 0x100, 0x0a | 0x1000 | 0x10 | 0x100, 0x252 | (1 << 16) | (3 << 18), 0x342 | (2 << 16), 0x0c2 | 0x20];
  for (let step = 0; step < steps; step++) {
    switch (Math.floor(R() * 8)) {
      case 0: case 7: dev.rs.set(pick(rsStates), pick(values)); break;
      case 1: dev.tss[Math.floor(R() * 4)].set(pick(tssStates), pick(values)); break;
      case 2: dev.textures[Math.floor(R() * 4)] = pick([0, 0x1000, 0x2000, 0x3000]); break;
      case 3: { const f = pick(fvfs); dev.fvf = f; dev.vertexShader = f; break; }
      case 4: { const i = Math.floor(R() * 3); if (dev.lightEnabled.has(i)) dev.lightEnabled.delete(i); else dev.lightEnabled.add(i); dev.lightVersion++; break; }
      case 5: dev.rs.set(RS.SHADEMODE, pick([1, 2])); break;
      default: dev.tss[Math.floor(R() * 4)].set(TSS.TEXCOORDINDEX, pick([0, 1, 2, 0x10000, 0x20001, 0x30000])); break;
    }
    dev.programVersion++;
    W.program();
  }
  return W;
}

test('fixed-function programs: the key a draw builds regenerates its exact sources', () => {
  let n = 0, flat = 0, lit = 0, rhw = 0;
  for (const api9 of [true, false]) {
    randomDevices(api9, api9 ? 11 : 12, 4000, (key, vs, fs, attrs) => {
      assert.ok(ffKeyRegenerable(key), key);
      const r = ffProgramFromKey(key);
      assert.ok(r, key);
      assert.equal(r.vs, vs, key); assert.equal(r.fs, fs, key); assert.deepEqual(r.attrs, attrs, key);
      n++; if (key.endsWith('|flat')) flat++; if (key.split(':')[2] === '1') lit++; if (vs.includes('float rhw')) rhw++;
    });
  }
  assert.ok(n > 300, `${n} programs`); assert.ok(flat > 10 && lit > 10 && rhw > 10, `${flat} flat, ${lit} lit, ${rhw} pre-transformed`);
});

test('fixed-function programs: keys of other kinds are not regenerated', () => {
  for (const k of ['vs9:3:f322|ps9:4:tttttttttttttttt:0:0', 'ff:d0:pos@0float3|ff:4,2,1,1,2,2,1,1,0,0,0,0;1,2,1,1,1,2,1,1,0,0,0,0:0:0:0', 'ff:f322:0::1:1:2:0:0:0:1:0:0:0:0/0:0|ps9:4:t:0:0', 'ff:h5:0::1:1:2:0:0:0:1:0:0:0:0/0:0|ff:4,2,1,1,2,2,1,1,0,0,0,0:0:0:0', null, 5]) {
    assert.equal(ffKeyRegenerable(k), false, String(k)); assert.equal(ffProgramFromKey(k), null);
  }
  assert.equal(ffProgramFromKey('ff:f322:0|ff:x'), null, 'a malformed key');
});

/** The GLSL of a fixed corpus: fixed-function programs of random states (both APIs) and translated shaders. */
function corpusHash() {
  const h = createHash('sha256');
  for (const api9 of [true, false]) randomDevices(api9, 99 + (api9 ? 1 : 0), 1500, (key, vs, fs, attrs) => { h.update(key + '\0' + vs + '\0' + fs + '\0' + attrs.join(',') + '\0'); });
  // vs_2_0: dcl_position v0, dcl_texcoord v1, dp4 oPos.xyzw, mov oT0, v1
  const vs20 = new Uint32Array([0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff]);
  h.update(translateVertexShader9(vs20, new Set()).glsl);
  // ps_2_0: dcl t0, dcl_2d s0, texld r0, t0, s0; mul r0, r0, c0; mov oC0, r0
  const ps20 = new Uint32Array([0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800, 0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x03000005, 0x800f0000, 0x80e40000, 0xa0e40000, 0x02000001, 0x800f0800, 0x80e40000, 0xffff]);
  for (const fog of [0, -1, 3]) for (const alphaTest of [0, 5]) h.update(translatePixelShader9(ps20, { cube: [], volume: [], projected: [], fog, alphaTest }).glsl);
  // vs_1_1 (DX8): m4x4 oPos, v0, c0; mov oD0, v5; mov oT0, v7 over a declaration of v0, v5 (color), v7
  const decl = new Uint32Array([0x20000000, 0x40020000, 0x40040005, 0x40010007, 0xffffffff]);
  const vs11 = new Uint32Array([0xfffe0101, 0x00000014, 0xc00f0000, 0x90e40000, 0xa0e40000, 0x00000001, 0xd00f0000, 0x90e40005, 0x00000001, 0xe00f0000, 0x90e40007, 0xffff]);
  h.update(translateVertexShader(vs11, declLayout(decl)));
  // ps_1_1 (DX8): tex t0; mul r0, t0, v0
  const ps11 = new Uint32Array([0xffff0101, 0x00000042, 0xb00f0000, 0x00000005, 0x800f0000, 0xb0e40000, 0x90e40000, 0xffff]);
  for (const fog of [0, -1]) h.update(translatePixelShader(ps11, { cube: [], volume: [], projected: [], fog, alphaTest: 0 }));
  return h.digest('hex').slice(0, 16);
}

// The hash of the corpus for each version: a translator change that alters it needs a new PROGRAM_GLSL_VERSION and its
// hash added here (the learned programs of older versions are then left out of the lists sessions compile ahead).
const CORPUS = { 1: '0de594aa20df8326' };

test('program GLSL version: the corpus of generated GLSL matches the version', () => {
  const h = corpusHash();
  assert.equal(h, CORPUS[PROGRAM_GLSL_VERSION], `the GLSL the translators generate changed (corpus ${h}): bump PROGRAM_GLSL_VERSION in src/gfx/program-id.js and add { ${PROGRAM_GLSL_VERSION + 1}: '${h}' } to CORPUS here`);
});

// The server lists a session the learned programs of its translator version, the fixed-function ones (regenerated
// from their key) and, for a few sessions after their last use, those learned before versions existed; a program a
// session built at a draw or took from the list is stamped with its version. Without ?v= the list is whole.
test('learned programs: listed by translator version', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { createServer } = await import('../src/host/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-programs-v-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  fs.mkdirSync(path.join(dir, 'learn'));
  const ffKey = 'ff:f322:0::1:1:2:0:0:0:1:0:0:0:0/0:0|ff:4,2,1,1,2,2,1,1,0,0,0,0:0:0:0';
  // (a list of the format before versions: one shader program, one fixed-function program, one used long ago)
  fs.writeFileSync(path.join(dir, 'learn', 'programs2-g.json'), JSON.stringify({ sessions: 10, programs: [['old1', 'vs9:1|ps9:2', 'vs-a', 'fs-a', [], 5, 1, 10], ['ff1', ffKey, 'vs-ff-old', 'fs-ff-old', [], 6, 1, 10], ['gone', 'vs9:3|ps9:4', 'vs-g', 'fs-g', [], 7, 1, 2]] }));
  const server = createServer({ manifests: path.join(dir, 'man'), learnDir: path.join(dir, 'learn') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/programs/g`;
  const list = async (v) => (await (await fetch(v ? `${base}?v=${v}` : base)).json()).map((e) => `${e.id}:${e.v}`);
  const post = (v, programs, used) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v, programs, used }) });
  try {
    assert.deepEqual(await list(1), ['old1:null', 'ff1:null'], 'unstamped entries used recently, not the one used long ago');
    assert.deepEqual(await list(null), ['old1:null', 'ff1:null', 'gone:null'], 'no version asked: all');
    // a version-1 session takes 'old1' (stamped 1) and 'ff1' (regenerated: not stamped) and builds two programs; a
    // version-2 session builds one
    assert.equal((await post(1, [{ key: 'vs9:5|ps9:6', vs: 'vs-b', fs: 'fs-b', attrs: [], t: 1 }, { key: 'vs9:7|ps9:8', vs: 'vs-c', fs: 'fs-c', attrs: [], t: 2 }], ['old1', 'ff1'])).status, 204);
    assert.equal((await post(2, [{ key: 'vs9:5|ps9:6', vs: 'vs-b2', fs: 'fs-b2', attrs: [], t: 3 }])).status, 204);
    const one = await list(1);
    assert.deepEqual(one.filter((e) => !e.startsWith('ff1')).map((e) => e.split(':')[1]), ['1', '1', '1'], `version 1: its entries (${one})`);
    assert.ok(one.includes('ff1:null'), 'the fixed-function entry for every version, unstamped');
    const two = await list(2);
    assert.equal(two.length, 2, `version 2: its entry and the fixed-function one (${two})`);
    assert.ok(two.includes('ff1:null'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// A learned fixed-function program is compiled ahead from its key with the current translator, whatever sources an
// older one gave it (taken at its first draw: no build there); a shader program of another version is skipped.
test('program cache: fixed-function programs regenerated from their key, other versions skipped', () => {
  const mk = (programCache) => {
    const dev = {
      api9: true, proc: { mem: {} }, pp: { width: 800, height: 600 }, programVersion: 0,
      rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 16 }, () => new StateTable(16)),
      textures: new Array(16).fill(0), com: { implAt: () => null }, fvf: 0x152, vertexDecl: null, vsObj: null, psObj: null,
      lights: new Map(), lightEnabled: new Set(), lightVersion: 0, transforms: new Map(), transformSlotVersion: new Map(),
    };
    return new WebGLDevice(mockGl(), dev, { programCache });
  };
  const cache = () => ({ queue: [], ready: new Map(), learned: [], used: [], t0: 0, parallel: true, started: 0, hits: 0 });
  const a = mk(cache()), key = a.program().p.key;
  assert.ok(ffKeyRegenerable(key));
  const c2 = cache(), b = mk(c2);
  c2.queue.push({ id: 'old', key, vs: 'an older translator', fs: 'its fragment shader', attrs: ['a_pos'], v: PROGRAM_GLSL_VERSION - 1 });
  c2.queue.push({ id: 'shader', key: 'vs9:1|ps9:2', vs: 'x', fs: 'y', attrs: [], v: PROGRAM_GLSL_VERSION + 1 });
  b.prewarmStep();
  assert.equal(c2.started, 1, 'the fixed-function one only'); assert.equal(c2.stale, 1); assert.equal(c2.regenerated, 1);
  assert.equal(b.program().p.key, key);
  assert.equal(b.stats.programs, 0, 'no build at the draw'); assert.deepEqual(c2.used, ['old']);
});

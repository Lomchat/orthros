// Cost of D3DX effect parameters and shader binding (setters, BeginPass / CommitChanges: parameters laid out into
// constant registers, compared with the device's, sampler parameters applied) on a game-shaped load: two effects sharing
// a Direct3D 9 device, a vertex shader with matrices (rows and columns), a bone array, a struct array, vectors, a bool
// and an int, a preshader, a pixel shader with vectors, a scalar and four sampler parameters. Per frame, OBJECTS objects
// in groups of GROUP (Begin / BeginPass, then per object its parameters set — most to the values they hold, as games do
// — and CommitChanges), alternating the effects. Prints µs per frame and ns per shader bind (CPU time of the process,
// setters included), for this tree, this tree with dbg:ORTHROS_FX_BIND_OFF=1 (the binding before the raw-word path) and
// with dbg:ORTHROS_API_OPT_OFF=1 (the reference path), and with --base <tree> another checkout — alternated in one
// process (--only <prefix>: one of them).
// Usage: node tools/effect-bind-bench.mjs [--base /path/to/other/tree] [--only branch|fx|ref|base] [--objects 300] [--frames 300] [--rounds 7] [--group 10]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { effectBinary, shader, op } from '../tests/fx-build.js';
import { PT, PC } from '../src/win32/d3dx9-fxparse.js';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OBJECTS = Number(opt('--objects', 300)), FRAMES = Number(opt('--frames', 300)), ROUNDS = Number(opt('--rounds', 7)), GROUP = Number(opt('--group', 10));
const BASE = opt('--base', null), HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const F = PT.FLOAT, MC = PC.MATRIX_COLUMNS, V = PC.VECTOR;
function fxDesc(k) {
  const lights = { cls: PC.STRUCT, type: PT.VOID, elements: 3, members: [{ name: 'Dir', t: { cls: V, type: F, rows: 1, cols: 3 } }, { name: 'Color', t: { cls: V, type: F, rows: 1, cols: 4 } }] };
  const vsConsts = [
    ['ViewProj', 2, 0, 4, { cls: MC, type: F, rows: 4, cols: 4 }], ['World', 2, 4, 3, { cls: PC.MATRIX_ROWS, type: F, rows: 3, cols: 4 }],
    ['Bones', 2, 7, 48, { cls: MC, type: F, rows: 4, cols: 3, elements: 16 }], ['EyePos', 2, 55, 1, { cls: V, type: F, rows: 1, cols: 3 }],
    ['Lights', 2, 56, 6, lights], ['Diffuse', 2, 62, 1, { cls: V, type: F, rows: 1, cols: 4 }], ['Fog', 2, 63, 1, { cls: V, type: F, rows: 1, cols: 4 }],
    ['HasShadow', 0, 0, 1, { cls: PC.SCALAR, type: PT.BOOL }], ['NumLights', 1, 0, 1, { cls: PC.SCALAR, type: PT.INT }],
  ];
  const pre = { literals: [0.5, 2], insns: [[0x1080, 1, [{ table: 2, offset: 0 }], { table: 4, offset: 0 }], [0x2050, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 1 }], { table: 4, offset: 1 }]],
    inputs: [['Time', 2, 0, 1, { cls: PC.SCALAR, type: F }]], outRanges: [[64, 1]] };
  const psConsts = [['Diffuse', 2, 0, 1, { cls: V, type: F, rows: 1, cols: 4 }], ['Spec', 2, 1, 1, { cls: V, type: F, rows: 1, cols: 4 }], ['Shadow', 2, 2, 1, { cls: V, type: F, rows: 1, cols: 4 }], ['Alpha', 2, 3, 1, { cls: PC.SCALAR, type: F }],
    ...[0, 1, 2, 3].map((i) => [`S${i}`, 3, i, 1, { cls: PC.OBJECT, type: PT.SAMPLER2D }])];
  const params = [
    { name: 'ViewProj', t: vsConsts[0][4] }, { name: 'World', t: vsConsts[1][4] }, { name: 'Bones', t: vsConsts[2][4] }, { name: 'EyePos', t: vsConsts[3][4] },
    { name: 'Lights', t: lights }, { name: 'Diffuse', t: vsConsts[5][4] }, { name: 'Fog', t: vsConsts[6][4] }, { name: 'HasShadow', t: vsConsts[7][4] }, { name: 'NumLights', t: vsConsts[8][4] },
    { name: 'Time', t: { cls: PC.SCALAR, type: F } }, { name: 'Spec', t: psConsts[1][4] }, { name: 'Shadow', t: psConsts[2][4] }, { name: 'Alpha', t: psConsts[3][4] },
    ...[0, 1, 2, 3].map((i) => ({ name: `T${i}`, t: { cls: PC.OBJECT, type: PT.TEXTURE } })),
    ...[0, 1, 2, 3].map((i) => ({ name: `S${i}`, t: { cls: PC.OBJECT, type: PT.SAMPLER2D }, samplers: [[[op('texture'), 0, `T${i}`], [op('samp', 1), 0, 1 + (i & 1)], [op('samp', 2), 0, 1], [op('samp', 5), 0, 2], [op('samp', 6), 0, 2], [op('samp', 7), 0, k + 1]]] })),
  ];
  const states = [{ op: op('vs'), value: shader(true, vsConsts, pre) }, { op: op('ps'), value: shader(false, psConsts) },
    { op: op('rs', 7), value: 1 }, { op: op('rs', 14), value: 1 }, { op: op('rs', 27), value: k }, { op: op('rs', 22), value: 3 }];
  return effectBinary({ params, techniques: [{ name: 'T', passes: [{ name: 'P', states }] }] });
}

async function makeSession(root, refPath) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const [{ d3dEnv }, { defineEffects }, { apiOpt }] = await Promise.all([imp('tests/d3d-random.js'), imp('src/win32/d3dx9-effect.js'), imp('src/core/api-opt.js')]);
  const E = d3dEnv({ createDevice: () => null }), { mem, ctx, com, vm } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...a) => dev[name](ctx([devPtr, ...a]));
  Object.assign(vm, { effectCtx: null, callGuest: () => 0, log: () => {} });
  const X = {}; com.interface ??= () => {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const tex = []; for (let i = 0; i < 12; i++) { call('CreateTexture', 64, 64, 1, 0, 21, 1, out, 0); tex.push(mem.read32(out)); }
  const fxs = [0, 1].map((k) => {
    const bytes = fxDesc(k), src = E.alloc(bytes.length); mem.writeBytes(src, bytes);
    if (X.D3DXCreateEffect[1](ctx([devPtr, src, bytes.length, 0, 0, 0, 0, out, 0])) !== 0) throw new Error('effect not created');
    const ptr = mem.read32(out), fx = com.implAt(ptr), fc = (...a) => ctx([ptr, ...a]);
    const h = (s) => { const p = E.alloc(s.length + 1); mem.writeCString(p, s); return fx.GetParameterByName(fc(0, p)) >>> 0; };
    const H = Object.fromEntries(['ViewProj', 'World', 'Bones', 'EyePos', 'Lights', 'Diffuse', 'Fog', 'HasShadow', 'NumLights', 'Time', 'Spec', 'Shadow', 'Alpha'].map((n) => [n, h(n)]));
    H.T = [0, 1, 2, 3].map((i) => h(`T${i}`));
    return { fx, fc, H };
  });
  // (the values the frames set, written to guest memory once: MATS matrices, VECS vectors, bone palettes)
  const MATS = 509, VECS = 61, PALS = 7, mats = E.alloc(64 * MATS), vecs = E.alloc(16 * VECS), bones = E.alloc(1024 * PALS), nPasses = E.alloc(4);
  for (let m = 0; m < MATS; m++) for (let i = 0; i < 16; i++) mem.writeF32(mats + 64 * m + 4 * i, (i % 5 === 0 ? 1 : 0) + (i === 12 ? m : 0) + (i === 13 ? m * 0.5 : 0));
  for (let v = 0; v < VECS; v++) for (let i = 0; i < 4; i++) mem.writeF32(vecs + 16 * v + 4 * i, ((v * 7 + i) % 9) * 0.125);
  for (let i = 0; i < 256 * PALS; i++) mem.writeF32(bones + 4 * i, (i % 11) * 0.25);
  // (a bound argument holder per effect: the calls cost what the effect runtime does, not the benchmark)
  for (const e of fxs) { const c = e.fc(); e.c = (a1 = 0, a2 = 0, a3 = 0) => { c.args[1] = a1; c.args[2] = a2; c.args[3] = a3; return c; }; }
  let k = 0, fn = 0;
  // (as games do: every parameter set again per object, most with the values they hold — the camera and time per
  // frame, the material every few objects — the world matrix new per object)
  const frame = () => {
    call('BeginScene'); fn++;
    for (let o = 0; o < OBJECTS; o += GROUP) {
      const { fx, c, H } = fxs[(o / GROUP) & 1];
      for (let s = 0; s < 4; s++) fx.SetTexture(c(H.T[s], tex[(k + s) % tex.length]));
      fx.Begin(c(nPasses, 1)); fx.BeginPass(c(0));
      for (let j = 0; j < GROUP; j++, k++) {
        fx.SetMatrix(c(H.ViewProj, mats + 64 * (fn % MATS)));
        fx.SetVector(c(H.EyePos, vecs + 16 * (fn % VECS)));
        fx.SetFloat(c(H.Time, 0x3f000000 + (fn & 0xff)));
        fx.SetMatrixTranspose(c(H.World, mats + 64 * ((k * 3) % MATS)));
        fx.SetVector(c(H.Diffuse, vecs + 16 * ((k >> 2) % VECS)));
        fx.SetMatrixTransposeArray(c(H.Bones, bones + 1024 * ((k >> 2) % PALS), 16));
        if ((k & 7) === 0) fx.SetTexture(c(H.T[0], tex[k % tex.length]));
        fx.CommitChanges(c());
      }
      fx.EndPass(c()); fx.End(c());
    }
    call('EndScene');
  };
  const run = () => {
    const was = [apiOpt.off, apiOpt.fxRef]; apiOpt.off = refPath === 'off'; apiOpt.fxRef = !!refPath;
    try { const t0 = process.cpuUsage(); for (let f = 0; f < FRAMES; f++) frame(); const d = process.cpuUsage(t0); return (d.user + d.system) / FRAMES; } finally { [apiOpt.off, apiOpt.fxRef] = was; }
  };
  // the state the frames leave: constants (raw words) and sampler states, to check the variants agree
  const state = () => JSON.stringify([Array.from(new Uint32Array(dev.vsConst.buffer).subarray(0, 4 * 65)), Array.from(new Uint32Array(dev.psConst.buffer).subarray(0, 16)), Array.from(dev.vsConstI.subarray(0, 4)), dev.vsConstB[0], dev.textures.slice(0, 4), [0, 1, 2, 3].map((r) => [1, 2, 5, 6, 7].map((t) => dev.samplers[r].get(t)))]);
  return { run, state };
}

let variants = [['branch', HERE, false], ['fx (FX_BIND_OFF)', HERE, 'fx'], ['ref (API_OPT_OFF)', HERE, 'off']];
if (BASE) variants.push(['base', path.resolve(BASE), false]);
if (opt('--only', null)) variants = variants.filter((v) => v[0].startsWith(opt('--only')));
const sessions = [];
for (const [name, root, ref] of variants) sessions.push({ name, s: await makeSession(root, ref), res: [] });
for (let r = 0; r < ROUNDS; r++) for (const v of sessions) v.res.push(v.s.run());
const st = sessions.map((v) => v.s.state());
for (let i = 1; i < st.length; i++) if (st[i] !== st[0]) console.log(`warning: ${sessions[i].name} left another device state than ${sessions[0].name}`);
const binds = OBJECTS * 2; // (two shaders per BeginPass / CommitChanges)
const med = (a) => { const s = [...a].slice(1).sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`effect binds: ${OBJECTS} objects x ${FRAMES} frames, ${ROUNDS} rounds (median, first round dropped)`);
for (const v of sessions) console.log(`  ${v.name.padEnd(18)} ${med(v.res).toFixed(0).padStart(6)} us/frame  ${(med(v.res) * 1000 / binds).toFixed(0).padStart(5)} ns/bind  [${v.res.map((x) => x.toFixed(0)).join(' ')}]`);

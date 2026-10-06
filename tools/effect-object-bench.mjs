// Cost of D3DX effect calls per drawn object, the way an engine drawing each object with its material's effect calls
// them: per object its effect's technique set, its parameters set (most to the values they hold), Begin (render states
// saved), BeginPass, then per mesh part new parameters and CommitChanges, EndPass, End — with a few device states set
// directly between objects, as engines do. EFFECTS effects share a Direct3D 9 device (runs of RUN objects per effect),
// each a technique whose pass picks its vertex shader in an array by an expression of a parameter (a bone count), with
// preshaders, render states from constants, parameters and expressions, and two sampler parameters. Prints µs per frame
// and per object (CPU time of the process, effect calls only — no draw), for this tree, this tree with
// dbg:ORTHROS_API_OPT_OFF=1 (the reference path) and with --base <tree> another checkout, alternated in one process
// (--only <prefix>: one of them). Every variant must leave the same device state (checked).
// Usage: node tools/effect-object-bench.mjs [--base /path/to/other/tree] [--only branch|ref|base] [--objects 40] [--frames 1500] [--rounds 7] [--parts 4] [--effects 6] [--run 3]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { effectBinary, shader, op } from '../tests/fx-build.js';
import { PT, PC } from '../src/win32/d3dx9-fxparse.js';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OBJECTS = Number(opt('--objects', 40)), FRAMES = Number(opt('--frames', 1500)), ROUNDS = Number(opt('--rounds', 7)), PARTS = Number(opt('--parts', 4));
const EFFECTS = Number(opt('--effects', 6)), RUN = Number(opt('--run', 3));
const BASE = opt('--base', null), HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const F = PT.FLOAT, MC = PC.MATRIX_COLUMNS, V = PC.VECTOR, S = PC.SCALAR;
const T = {
  ViewProj: { cls: MC, type: F, rows: 4, cols: 4 }, World: { cls: PC.MATRIX_ROWS, type: F, rows: 3, cols: 4 }, Bones: { cls: MC, type: F, rows: 4, cols: 3, elements: 16 },
  EyePos: { cls: V, type: F, rows: 1, cols: 3 }, LightDir: { cls: V, type: F, rows: 1, cols: 3, elements: 3 }, LightColor: { cls: V, type: F, rows: 1, cols: 4, elements: 3 },
  Ambient: { cls: V, type: F, rows: 1, cols: 4 }, Diffuse: { cls: V, type: F, rows: 1, cols: 4 }, Fog: { cls: V, type: F, rows: 1, cols: 4 }, Time: { cls: S, type: F },
  Opacity: { cls: S, type: F }, NumBones: { cls: S, type: PT.INT }, AlphaRef: { cls: S, type: PT.INT }, Shadow: { cls: V, type: F, rows: 1, cols: 4 },
};
const tex = { cls: PC.OBJECT, type: PT.TEXTURE }, samplerT = { cls: PC.OBJECT, type: PT.SAMPLER2D };
// expressions: out = (input >= 1 ? 1 : 0) — an array index from NumBones (0..2: min(NumBones, 2)), a bool from Opacity < 1
const ge = (lit) => ({ literals: [lit], insns: [[0x2030, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 0 }]] });
const lt1 = { literals: [1], insns: [[0x2020, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 0 }]] };
const minIdx = { literals: [2], insns: [[0x2000, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 0 }]] };
const input = (name, t) => [[name, 2, 0, 1, t]];

function fxDesc(k) {
  const vsConsts = (bones) => [
    ['ViewProj', 2, 0, 4, T.ViewProj], ['World', 2, 4, 3, T.World], ['EyePos', 2, 7, 1, T.EyePos], ['LightDir', 2, 8, 3, T.LightDir], ['LightColor', 2, 11, 3, T.LightColor],
    ['Ambient', 2, 14, 1, T.Ambient], ['Fog', 2, 15, 1, T.Fog], ...(bones ? [['Bones', 2, 16, 3 * bones, { ...T.Bones, elements: bones }]] : []),
  ];
  const pre = { literals: [0.5, 2], insns: [[0x1080, 1, [{ table: 2, offset: 0 }], { table: 4, offset: 0 }], [0x2050, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 1 }], { table: 4, offset: 1 }]],
    inputs: input('Time', T.Time), outRanges: [[64, 1]] };
  const vss = [0, 4, 16].map((b) => shader(true, vsConsts(b), pre));
  const ps = shader(false, [['Diffuse', 2, 0, 1, T.Diffuse], ['Shadow', 2, 1, 1, T.Shadow], ['Opacity', 2, 2, 1, T.Opacity], ['S0', 3, 0, 1, samplerT], ['S1', 3, 1, 1, samplerT]],
    { literals: [0.25], insns: [[0x2050, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 12 }]], inputs: input('Opacity', T.Opacity), outRanges: [[3, 1]] });
  const params = [
    ...Object.entries(T).map(([name, t]) => ({ name, t })),
    { name: 'VSArr', t: { cls: PC.OBJECT, type: PT.VERTEXSHADER, elements: 3 }, shaders: vss },
    { name: 'T0', t: tex }, { name: 'T1', t: tex },
    { name: 'S0', t: samplerT, samplers: [[[op('texture'), 0, 'T0'], [op('samp', 1), 0, 1], [op('samp', 2), 0, 1], [op('samp', 5), 0, 2], [op('samp', 6), 0, 2], [op('samp', 7), 0, 2]]] },
    { name: 'S1', t: samplerT, samplers: [[[op('texture'), 0, 'T1'], [op('samp', 1), 0, 3], [op('samp', 2), 0, 3], [op('samp', 5), 0, 1 + (k & 1)], [op('samp', 6), 0, 2]]] },
  ];
  const states = [
    { op: op('vs'), select: { array: 'VSArr', expr: { ...minIdx, inputs: input('NumBones', T.NumBones) } } }, { op: op('ps'), value: ps },
    { op: op('rs', 7), value: 1 }, { op: op('rs', 14), value: k & 1 }, { op: op('rs', 22), value: 2 + (k % 2) }, { op: op('rs', 28), value: 1 },
    { op: op('rs', 27), expr: { ...lt1, inputs: input('Opacity', T.Opacity) } }, { op: op('rs', 19), value: 5 }, { op: op('rs', 20), value: 6 },
    { op: op('rs', 15), expr: { ...ge(0.5), inputs: input('Opacity', T.Opacity) } }, { op: op('rs', 24), ref: 'AlphaRef' }, { op: op('rs', 25), value: 7 },
    { op: op('sampler'), index: 0, ref: 'S0' }, { op: op('sampler'), index: 1, ref: 'S1' },
  ];
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
  const dc = ctx([devPtr, 0, 0, 0, 0]), call = (name, a1 = 0, a2 = 0, a3 = 0) => { dc.args[1] = a1; dc.args[2] = a2; dc.args[3] = a3; return dev[name](dc); };
  Object.assign(vm, { effectCtx: null, callGuest: () => 0, log: () => {} });
  const X = {}; com.interface ??= () => {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const texs = []; for (let i = 0; i < 16; i++) { dev.CreateTexture(ctx([devPtr, 64, 64, 1, 0, 21, 1, out, 0])); texs.push(mem.read32(out)); }
  const fxs = Array.from({ length: EFFECTS }, (_, k) => {
    const bytes = fxDesc(k), src = E.alloc(bytes.length); mem.writeBytes(src, bytes);
    if (X.D3DXCreateEffect[1](ctx([devPtr, src, bytes.length, 0, 0, 0, 0, out, 0])) !== 0) throw new Error('effect not created');
    const ptr = mem.read32(out), fx = com.implAt(ptr), fc = (...a) => ctx([ptr, ...a]);
    const h = (s) => { const p = E.alloc(s.length + 1); mem.writeCString(p, s); return fx.GetParameterByName(fc(0, p)) >>> 0; };
    const H = Object.fromEntries([...Object.keys(T), 'T0', 'T1'].map((n) => [n, h(n)]));
    const tp = E.alloc(4); mem.writeCString(tp, 'T');
    const c = fc(0, 0, 0);
    return { fx, H, tech: fx.GetTechniqueByName(fc(tp)) >>> 0, c: (a1 = 0, a2 = 0, a3 = 0) => { c.args[1] = a1; c.args[2] = a2; c.args[3] = a3; return c; } };
  });
  // (the values the frames set, in guest memory: matrices, vectors, bone palettes)
  const MATS = 509, VECS = 61, PALS = 7, mats = E.alloc(64 * MATS), vecs = E.alloc(16 * VECS), bones = E.alloc(1024 * PALS), nPasses = E.alloc(4);
  for (let m = 0; m < MATS; m++) for (let i = 0; i < 16; i++) mem.writeF32(mats + 64 * m + 4 * i, (i % 5 === 0 ? 1 : 0) + (i === 12 ? m : 0) + (i === 13 ? m * 0.5 : 0));
  for (let v = 0; v < VECS; v++) for (let i = 0; i < 4; i++) mem.writeF32(vecs + 16 * v + 4 * i, ((v * 7 + i) % 9) * 0.125);
  for (let i = 0; i < 256 * PALS; i++) mem.writeF32(bones + 4 * i, (i % 11) * 0.25);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), fw = (x) => { f32[0] = x; return u32[0]; };
  let k = 0, fn = 0;
  const frame = () => {
    call('BeginScene'); fn++;
    for (let o = 0; o < OBJECTS; o++, k++) {
      const e = fxs[((o / RUN) | 0) % EFFECTS], { fx, c, H } = e;
      // (the engine's own device states between objects: a few changes, mostly the values held)
      call('SetRenderState', 7, 1); call('SetRenderState', 27, k & 1); call('SetTextureStageState', 0, 1, 2 + (k & 1)); call('SetSamplerState', 2, 5, 2);
      fx.SetTechnique(c(e.tech));
      fx.SetMatrix(c(H.ViewProj, mats + 64 * (fn % MATS)));
      fx.SetVector(c(H.EyePos, vecs + 16 * (fn % VECS)));
      for (let l = 0; l < 3; l++) fx.SetVector(c(H.LightDir, vecs + 16 * ((fn + l) % VECS))); // (an element would be by its own handle: the whole array's first here)
      fx.SetVector(c(H.LightColor, vecs + 16 * 3)); fx.SetVector(c(H.Ambient, vecs + 16 * 4)); fx.SetVector(c(H.Fog, vecs + 16 * 5));
      fx.SetFloat(c(H.Time, fw((fn & 0xff) / 64)));
      fx.SetFloat(c(H.Opacity, fw((k % 7) === 0 ? 0.5 : 1)));
      fx.SetInt(c(H.NumBones, (k % 5) === 0 ? 4 : (k % 5) === 1 ? 1 : 0));
      fx.SetInt(c(H.AlphaRef, 96 + (k & 1)));
      fx.SetTexture(c(H.T0, texs[(k >> 1) % texs.length])); fx.SetTexture(c(H.T1, texs[(k * 3) % texs.length]));
      fx.Begin(c(nPasses, 6)); fx.BeginPass(c(0));
      for (let j = 0; j < PARTS; j++) {
        fx.SetMatrixTranspose(c(H.World, mats + 64 * ((k * 3 + j) % MATS)));
        fx.SetVector(c(H.Diffuse, vecs + 16 * ((k + j) % VECS)));
        fx.SetVector(c(H.Shadow, vecs + 16 * 7));
        if ((k % 5) === 0) fx.SetMatrixTransposeArray(c(H.Bones, bones + 1024 * ((k + j) % PALS), 16));
        fx.CommitChanges(c());
      }
      fx.EndPass(c()); fx.End(c());
    }
    call('EndScene');
  };
  const run = () => {
    const was = [apiOpt.off, apiOpt.fxRef]; apiOpt.off = !!refPath; apiOpt.fxRef = !!refPath;
    try { const t0 = process.cpuUsage(); for (let f = 0; f < FRAMES; f++) frame(); const d = process.cpuUsage(t0); return (d.user + d.system) / FRAMES; } finally { [apiOpt.off, apiOpt.fxRef] = was; }
  };
  // the state the frames leave: constants (raw words), render / sampler states, textures, shaders
  const state = () => JSON.stringify([Array.from(new Uint32Array(dev.vsConst.buffer).subarray(0, 4 * 70)), Array.from(new Uint32Array(dev.psConst.buffer).subarray(0, 16)),
    [7, 14, 15, 19, 20, 22, 24, 25, 27, 28].map((s) => dev.rs.get(s)), dev.textures.slice(0, 2), [0, 1, 2].map((r) => [1, 2, 5, 6, 7].map((t) => dev.samplers[r].get(t))),
    dev.vsObj?.code?.length ?? 0, dev.psObj?.code?.length ?? 0, dev.tss[0].get(1)]);
  return { run, state };
}

let variants = [['branch', HERE, false], ['ref (API_OPT_OFF)', HERE, true]];
if (BASE) variants.push(['base', path.resolve(BASE), false]);
if (opt('--only', null)) variants = variants.filter((v) => v[0].startsWith(opt('--only')));
const sessions = [];
for (const [name, root, ref] of variants) sessions.push({ name, s: await makeSession(root, ref), res: [] });
for (let r = 0; r < ROUNDS; r++) for (const v of (r & 1 ? [...sessions].reverse() : sessions)) v.res.push(v.s.run());
const st = sessions.map((v) => v.s.state());
for (let i = 1; i < st.length; i++) if (st[i] !== st[0]) console.log(`warning: ${sessions[i].name} left another device state than ${sessions[0].name}`);
const med = (a) => { const s = [...a].slice(1).sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`effect objects: ${OBJECTS} objects x ${FRAMES} frames, ${PARTS} commits each, ${EFFECTS} effects in runs of ${RUN}, ${ROUNDS} rounds (median, first round dropped)`);
for (const v of sessions) console.log(`  ${v.name.padEnd(18)} ${med(v.res).toFixed(0).padStart(6)} us/frame  ${(med(v.res) / OBJECTS).toFixed(2).padStart(6)} us/object  [${v.res.map((x) => x.toFixed(0)).join(' ')}]`);

// Cost of D3DX effect calls per drawn object, the way an engine drawing each object with its material's effect calls
// them: per object its effect's technique set, its parameters set (most to the values they hold), Begin (render states
// saved), BeginPass, then per mesh part new parameters and CommitChanges, EndPass, End — with a few device states set
// directly between objects, as engines do. EFFECTS effects share a Direct3D 9 device (runs of RUN objects per effect),
// each a technique whose pass picks its vertex shader in an array by an expression of a parameter (a bone count), with
// preshaders, render states from constants, parameters and expressions, and two sampler parameters. Prints µs per frame
// and per object (CPU time of the process, effect calls only — no draw), for this tree, this tree with
// dbg:ORTHROS_API_OPT_OFF=1 (the reference path) and with --base <tree> another checkout, alternated in one process
// (--only <prefix>: one of them). Every variant must leave the same device state (checked).
// --jit: the calls made by guest code run through the JIT instead (frames of generated x86 calling the methods' thunks),
// the deferred queue drained before every call handled in JavaScript as the VM does — what the queued calls save shows
// (no drawing: the device's draws are not called). Under `perf stat -e instructions:u`, a measure insensitive to load.
// Usage: node tools/effect-object-bench.mjs [--base /path/to/other/tree] [--only branch|ref|base] [--jit [--no-defer]] [--objects 40] [--frames 1500] [--rounds 7] [--parts 4] [--effects 6] [--run 3]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { effectBinary, shader, op } from '../tests/fx-build.js';
import { PT, PC } from '../src/win32/d3dx9-fxparse.js';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OBJECTS = Number(opt('--objects', 40)), FRAMES = Number(opt('--frames', 1500)), ROUNDS = Number(opt('--rounds', 7)), PARTS = Number(opt('--parts', 4));
const EFFECTS = Number(opt('--effects', 6)), RUN = Number(opt('--run', 3));
const BASE = opt('--base', null), HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), JIT = argv.includes('--jit');

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

/**
 * --jit: the same frames as guest code (CYCLE different frames, repeated) calling the methods' thunks through the JIT of
 * tree `root`; a minimal VM (full guest memory, COM objects of 24 bytes as com.js makes them) built from that tree's modules.
 */
async function makeJitSession(root) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const [{ GuestMemory, THUNK_BASE }, { CpuState, THREAD_STATES_BASE, EXIT, F: FL }, { Interp }, { Jit }, R, { registerDirect3D9 }, { registerDirect3D8 }, { defineEffects }] = await Promise.all(
    ['src/cpu/memory.js', 'src/cpu/state.js', 'src/cpu/interp.js', 'src/cpu/jit/jit.js', 'src/cpu/jit/runtime.js', 'src/win32/d3d9.js', 'src/win32/d3d8.js', 'src/win32/d3dx9-effect.js'].map(imp));
  const mem = new GuestMemory();
  let top = 0x1000000; const alloc = (n) => { const a = top; top += (Math.max(n, 16) + 15) & ~15; return a; };
  const proc = { mem, processHeap: { alloc, free_() {} }, symbolize: () => '?' };
  const objects = new Map();
  const com = { objects, interface() {}, supports: () => true,
    create(p, iface, impl) { const ptr = alloc(24); mem.write32(ptr + 4, R.COM_MARKER); mem.write32(ptr + 16, 1); const obj = { ptr, impl, refs: 1, proc: p }; objects.set(ptr, obj); impl.comObject = obj; return ptr; },
    objectAt: (ptr) => objects.get(ptr >>> 0) ?? null, implAt: (ptr) => objects.get(ptr >>> 0)?.impl ?? null, addRef: (o) => ++o.refs, release: (o) => --o.refs, unpin() {}, dispose() {} };
  const vm = { mem, com, proc, host: { gfx: { createDevice: () => null } }, log() {}, clock: { now: () => 0 }, recentApiCalls: () => [], startApiBurst() {}, effectCtx: null, callGuest: () => 0 };
  const defs = {}, api = { define(dll, d) { Object.assign(defs, d); } };
  registerDirect3D8(api, vm); registerDirect3D9(api, vm);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const ctxAt = (sp) => ({ sp, proc, thread: { id: 1 }, get retAddr() { return mem.read32(this.sp); }, arg(i) { return mem.read32(this.sp + 4 + 4 * i); }, sarg(i) { return mem.readS32(this.sp + 4 + 4 * i); }, argF32(i) { return mem.readF32(this.sp + 4 + 4 * i); }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } });
  const ctx = (args) => { const sp = alloc(4 + 4 * args.length); args.forEach((a, i) => mem.write32(sp + 4 + 4 * i, a >>> 0)); return ctxAt(sp); };
  const out = alloc(64), pp = alloc(64);
  [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const X = {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const texs = []; for (let i = 0; i < 16; i++) { dev.CreateTexture(ctx([devPtr, 64, 64, 1, 0, 21, 1, out, 0])); texs.push(mem.read32(out)); }
  const fxs = Array.from({ length: EFFECTS }, (_, k) => {
    const bytes = fxDesc(k), src = alloc(bytes.length); mem.writeBytes(src, bytes);
    if (X.D3DXCreateEffect[1](ctx([devPtr, src, bytes.length, 0, 0, 0, 0, out, 0])) !== 0) throw new Error('effect not created');
    const ptr = mem.read32(out), fx = com.implAt(ptr);
    const h = (s) => { const p = alloc(s.length + 1); mem.writeCString(p, s); return fx.GetParameterByName(ctx([ptr, 0, p])) >>> 0; };
    const tp = alloc(4); mem.writeCString(tp, 'T');
    return { ptr, H: Object.fromEntries([...Object.keys(T), 'T0', 'T1'].map((n) => [n, h(n)])), tech: fx.GetTechniqueByName(ctx([ptr, tp])) >>> 0 };
  });
  const MATS = 509, VECS = 61, PALS = 7, mats = alloc(64 * MATS), vecs = alloc(16 * VECS), bones = alloc(1024 * PALS), nPasses = alloc(4);
  for (let m = 0; m < MATS; m++) for (let i = 0; i < 16; i++) mem.writeF32(mats + 64 * m + 4 * i, (i % 5 === 0 ? 1 : 0) + (i === 12 ? m : 0) + (i === 13 ? m * 0.5 : 0));
  for (let v = 0; v < VECS; v++) for (let i = 0; i < 4; i++) mem.writeF32(vecs + 16 * v + 4 * i, ((v * 7 + i) % 9) * 0.125);
  for (let i = 0; i < 256 * PALS; i++) mem.writeF32(bones + 4 * i, (i % 11) * 0.25);
  const fw = (x) => { f32[0] = x; return u32[0]; };
  // the methods (their stack arguments after `this`) and their thunks
  const ARGC = { BeginScene: 0, EndScene: 0, SetRenderState: 2, SetTextureStageState: 3, SetSamplerState: 3, SetTechnique: 1, SetMatrix: 2, SetVector: 2, SetFloat: 2, SetInt: 2, SetTexture: 2, Begin: 2, BeginPass: 1,
    SetMatrixTranspose: 2, SetMatrixTransposeArray: 3, CommitChanges: 0, EndPass: 0, End: 0 };
  const METHODS = Object.keys(ARGC).map((m, i) => (i < 5 ? `IDirect3DDevice9::${m}` : `ID3DXEffect::${m}`));
  const names = METHODS.map((m) => m.split('::')[1]), argcOf = names.map((m) => ARGC[m]), Mi = Object.fromEntries(names.map((m, i) => [m, i]));
  const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  const noDefer = argv.includes('--no-defer'); // (this tree with its technique calls in JavaScript: Jit.setFxDefer)
  const SLOTS = 0x10000100, CODE = 0x20000000, STACK = 0x10090000, THUNK_SIZE = 16, CYCLE = 2, FRAME_BYTES = 1 << 20;
  METHODS.forEach((m, i) => { jit.markFast(i, `com.dll!${m}`, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
  if (noDefer) jit.setFxDefer?.(false);
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  let k = 0;
  for (let fn = 1; fn <= CYCLE; fn++) { // (the frames of frame(), as x86: push the arguments, call [slot])
    const code = [], c = (m, ...a) => { for (let i = a.length - 1; i >= 0; i--) code.push(0x68, ...le(a[i])); code.push(0xff, 0x15, ...le(SLOTS + 4 * Mi[m])); };
    c('BeginScene', devPtr);
    for (let o = 0; o < OBJECTS; o++, k++) {
      const e = fxs[((o / RUN) | 0) % EFFECTS], { ptr, H } = e;
      c('SetRenderState', devPtr, 7, 1); c('SetRenderState', devPtr, 27, k & 1); c('SetTextureStageState', devPtr, 0, 1, 2 + (k & 1)); c('SetSamplerState', devPtr, 2, 5, 2);
      c('SetTechnique', ptr, e.tech);
      c('SetMatrix', ptr, H.ViewProj, mats + 64 * (fn % MATS));
      c('SetVector', ptr, H.EyePos, vecs + 16 * (fn % VECS));
      for (let l = 0; l < 3; l++) c('SetVector', ptr, H.LightDir, vecs + 16 * ((fn + l) % VECS));
      c('SetVector', ptr, H.LightColor, vecs + 16 * 3); c('SetVector', ptr, H.Ambient, vecs + 16 * 4); c('SetVector', ptr, H.Fog, vecs + 16 * 5);
      c('SetFloat', ptr, H.Time, fw((fn & 0xff) / 64)); c('SetFloat', ptr, H.Opacity, fw((k % 7) === 0 ? 0.5 : 1));
      c('SetInt', ptr, H.NumBones, (k % 5) === 0 ? 4 : (k % 5) === 1 ? 1 : 0); c('SetInt', ptr, H.AlphaRef, 96 + (k & 1));
      c('SetTexture', ptr, H.T0, texs[(k >> 1) % texs.length]); c('SetTexture', ptr, H.T1, texs[(k * 3) % texs.length]);
      c('Begin', ptr, nPasses, 6); c('BeginPass', ptr, 0);
      for (let j = 0; j < PARTS; j++) {
        c('SetMatrixTranspose', ptr, H.World, mats + 64 * ((k * 3 + j) % MATS)); c('SetVector', ptr, H.Diffuse, vecs + 16 * ((k + j) % VECS)); c('SetVector', ptr, H.Shadow, vecs + 16 * 7);
        if ((k % 5) === 0) c('SetMatrixTransposeArray', ptr, H.Bones, bones + 1024 * ((k + j) % PALS), 16);
        c('CommitChanges', ptr);
      }
      c('EndPass', ptr); c('End', ptr);
    }
    c('EndScene', devPtr);
    code.push(0xf4);
    if (code.length > FRAME_BYTES) throw new Error('frame code too long');
    mem.writeBytes(CODE + (fn - 1) * FRAME_BYTES, Uint8Array.from(code));
  }
  // the dispatcher: the queue drained first (Vm.drainDeferred), then the method JavaScript handles (Vm.dispatchThunk)
  const qctx = ctxAt(0), cctx = ctxAt(0);
  const callAt = (c, idx) => { const r = com.implAt(c.arg(0))[names[idx]](c); return r === undefined ? 0 : r >>> 0; };
  const drain = () => {
    const n = mem.read32(R.DEFER_QUEUE);
    if (!n) return;
    mem.write32(R.DEFER_QUEUE, 0); mem.write32(R.DEFER_QUEUE + 4, 0); mem.write32(R.DEFER_QUEUE + 8, 0);
    for (let p = R.DEFER_QUEUE + 16, end = p + n; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), spec = mem.read32(R.DEFER_SPEC + 4 * idx), words = spec & R.DEFER_RAW ? mem.read32(p + 24) >>> 2 : (spec >>> 8) & R.DEFER_WORDS;
      qctx.sp = p + 4; callAt(qctx, idx);
      p += 4 * (2 + argc + words);
    }
  };
  let f = 0, toJs = 0;
  const frame = () => {
    cpu.eip = CODE + (f++ % CYCLE) * FRAME_BYTES; cpu.esp = STACK; cpu.eflags = FL.RESERVED1 | FL.IF;
    for (;;) {
      const r = jit.run({ maxInsns: 1e8 });
      if (r !== EXIT.THUNK) { if (r !== EXIT.HALT) throw new Error(`exit ${r}`); break; }
      drain();
      const idx = cpu.exitArg; cctx.sp = cpu.esp; toJs++;
      const eax = callAt(cctx, idx);
      cpu.eip = mem.read32(cpu.esp); cpu.esp += 4 + 4 * (argcOf[idx] + 1); cpu.eax = eax;
    }
    drain();
  };
  for (let i = 0; i < 100 * CYCLE; i++) frame(); // (warm: every frame translated before timing, see translations)
  const regions0 = jit.stats.regions;
  toJs = 0;
  const run = () => { const t0 = process.cpuUsage(); for (let i = 0; i < FRAMES; i++) frame(); const d = process.cpuUsage(t0); return (d.user + d.system) / FRAMES; };
  const state = () => JSON.stringify([Array.from(new Uint32Array(dev.vsConst.buffer).subarray(0, 4 * 70)), Array.from(new Uint32Array(dev.psConst.buffer).subarray(0, 16)),
    [7, 14, 15, 19, 20, 22, 24, 25, 27, 28].map((s) => dev.rs.get(s)), dev.textures.slice(0, 2), [0, 1, 2].map((r) => [1, 2, 5, 6, 7].map((t) => dev.samplers[r].get(t))),
    dev.vsObj?.code?.length ?? 0, dev.psObj?.code?.length ?? 0, dev.tss[0].get(1)]);
  return { run, state, calls: () => toJs, translations: () => jit.stats.regions - regions0 };
}

let variants = [['branch', HERE, false], ['ref (API_OPT_OFF)', HERE, true]];
if (BASE) variants.push(['base', path.resolve(BASE), false]);
if (opt('--only', null)) variants = variants.filter((v) => v[0].startsWith(opt('--only')));
const sessions = [];
if (JIT) variants = variants.filter((v) => !v[2]); // (the reference path's switches are the VM's: not here)
for (const [name, root, ref] of variants) sessions.push({ name, s: JIT ? await makeJitSession(root) : await makeSession(root, ref), res: [] });
for (let r = 0; r < ROUNDS; r++) for (const v of (r & 1 ? [...sessions].reverse() : sessions)) v.res.push(v.s.run());
const st = sessions.map((v) => v.s.state());
for (let i = 1; i < st.length; i++) if (st[i] !== st[0]) console.log(`warning: ${sessions[i].name} left another device state than ${sessions[0].name}`);
const med = (a) => { const s = [...a].slice(1).sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`effect objects${JIT ? ' (guest code through the JIT)' : ''}: ${OBJECTS} objects x ${FRAMES} frames, ${PARTS} commits each, ${EFFECTS} effects in runs of ${RUN}, ${ROUNDS} rounds (median, first round dropped)`);
for (const v of sessions) console.log(`  ${v.name.padEnd(18)} ${med(v.res).toFixed(0).padStart(6)} us/frame  ${(med(v.res) / OBJECTS).toFixed(2).padStart(6)} us/object  [${v.res.map((x) => x.toFixed(0)).join(' ')}]${JIT ? `  ${(v.s.calls() / (ROUNDS * FRAMES) / OBJECTS).toFixed(2)} calls to JavaScript per object, ${v.s.translations()} translations while timed` : ''}`);

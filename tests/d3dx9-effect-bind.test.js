// D3DX effect binding (d3dx9-effect.js bindShader / bindShaderSampler: float words compared and written as raw bits
// straight from the parameters, the sampler shortcut, device methods resolved once; setters moving a parameter's version
// only when a word changed) against the reference path (dbg:ORTHROS_API_OPT_OFF=1: bindShaderRef / bindSampler, a
// version move per write). Identical sessions — a Direct3D 9 device and three effects sharing it — play the same random
// sequence of parameter writes (every setter, by handle, by name, elements and struct members, often the values they
// hold), parameter blocks, Begin / BeginPass / CommitChanges / EndPass / End, raw Set*ShaderConstantF/I/B, sampler and
// texture states, state blocks (recorded and applied), Reset and a state manager: one session on the reference path, one
// on the optimized path, one switching paths at random between calls. After every call the devices hold the same
// constants (bit for bit), textures, sampler / render states and shaders, with the same constant-change notifications
// (constTouched) and state manager calls, and every register a call changed was announced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { defineEffects } from '../src/win32/d3dx9-effect.js';
import { apiOpt } from '../src/core/api-opt.js';
import { effectBinary, shader, op } from './fx-build.js';
import { PT, PC } from '../src/win32/d3dx9-fxparse.js';

const F = PT.FLOAT, V = PC.VECTOR, S = PC.SCALAR, MC = PC.MATRIX_COLUMNS, MR = PC.MATRIX_ROWS;
const vec = (n, elements = 0) => ({ cls: V, type: F, rows: 1, cols: n, elements });
const struct = { cls: PC.STRUCT, type: PT.VOID, elements: 2, members: [{ name: 'Dir', t: vec(3) }, { name: 'Color', t: vec(4) }] };
const samplerT = { cls: PC.OBJECT, type: PT.SAMPLER2D };

/** effect 0: two passes over most shapes; effect 1: overlapping registers and other sampler states; effect 2: ints and bools */
function effects(overlap) {
  const T = {
    M: { cls: MC, type: F, rows: 4, cols: 4 }, MRow: { cls: MR, type: F, rows: 3, cols: 4 }, Arr: vec(4, 3), St: struct, Fs: { cls: S, type: F },
    Bf: { cls: S, type: PT.BOOL }, Iv: { cls: V, type: PT.INT, rows: 1, cols: 2 }, B: { cls: S, type: PT.BOOL }, Ba: { cls: S, type: PT.BOOL, elements: 3 },
    Mt: { cls: MC, type: F, rows: 4, cols: 4 }, Big: vec(4, 4), Color: vec(4), Iref: { cls: S, type: PT.INT }, Mats: { cls: MC, type: F, rows: 4, cols: 3, elements: 2 },
  };
  const tex = (i) => ({ name: `T${i}`, t: { cls: PC.OBJECT, type: PT.TEXTURE } });
  const sampler = (name, texName, states) => ({ name, t: samplerT, samplers: [[[op('texture'), 0, texName], ...states]] });
  const pre = { literals: [0.5, 2], inputs: [['Fs', 2, 0, 1, T.Fs], ['Arr', 2, 1, 3, T.Arr]],
    insns: [[0x1080, 1, [{ table: 2, offset: 0 }], { table: 4, offset: 80 }], [0x2050, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 1 }], { table: 4, offset: 81 }],
      [0x2040, 4, [{ table: 2, offset: 4 }, { table: 2, offset: 8 }], { table: 4, offset: 84 }], ...(overlap ? [[0x2050, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 56 }]] : [])],
    outRanges: overlap ? [[14, 1], [20, 2]] : [[20, 2]] }; // (c14 shared with the Fs binding: the preshader's value wins)
  const vs0 = shader(true, [['M', 2, 0, 4, T.M], ['MRow', 2, 4, 3, T.MRow], ['Arr', 2, 7, 3, T.Arr], ['St', 2, 10, 4, T.St], ['Fs', 2, 14, 1, T.Fs], ['Bf', 2, 15, 1, T.Bf],
    ['Iv', 1, 1, 1, T.Iv], ['B', 0, 2, 1, T.B], ['Ba', 0, 4, 3, T.Ba], ['Mt', 2, 16, 2, T.Mt], ['Big', 2, 254, 4, T.Big], ['Mats', 2, 24, 6, T.Mats]], pre);
  const ps0 = shader(false, [['Color', 2, 0, 1, T.Color], ['Fs', 2, 1, 1, T.Fs], ['Iv', 1, 0, 1, T.Iv], ['Ba', 0, 1, 3, T.Ba], ['S0', 3, 0, 1, samplerT], ['S1', 3, 1, 1, samplerT]]);
  const vs1 = shader(true, [['M', 2, 30, 4, T.M], ['Arr', 2, 7, 3, T.Arr], ['B', 0, 3, 1, T.B]]);
  const ps1 = shader(false, [['Color', 2, 2, 1, T.Color], ['S1', 3, 0, 1, samplerT]]);
  const fx0 = effectBinary({
    params: [{ name: 'M', t: T.M }, { name: 'MRow', t: T.MRow }, { name: 'Arr', t: T.Arr }, { name: 'St', t: T.St }, { name: 'Fs', t: T.Fs }, { name: 'Bf', t: T.Bf }, { name: 'Iv', t: T.Iv },
      { name: 'B', t: T.B }, { name: 'Ba', t: T.Ba }, { name: 'Mt', t: T.Mt }, { name: 'Big', t: T.Big }, { name: 'Mats', t: T.Mats }, { name: 'Color', t: T.Color }, { name: 'Iref', t: T.Iref },
      tex(0), tex(1),
      sampler('S0', 'T0', [[op('samp', 5), 0, 2], [op('samp', 6), 0, 2], [op('samp', 1), 0, 1]]),
      sampler('S1', 'T1', [[op('samp', 5), 0, 1], [op('samp', 1), 0, 'Iref']])], // (a state from a parameter: not constant)
    techniques: [{ name: 'T', passes: [
      { name: 'P0', states: [{ op: op('vs'), value: vs0 }, { op: op('ps'), value: ps0 }, { op: op('rs', 7), value: 1 }, { op: op('rs', 24), ref: 'Iref' }] },
      { name: 'P1', states: [{ op: op('vs'), value: vs1 }, { op: op('ps'), value: ps1 }, { op: op('const', 'vsf'), index: 40, ref: 'Arr' }, { op: op('rs', 7), value: 0 }] }] }],
  });
  const vs2 = shader(true, [['M', 2, 0, 4, T.M], ['W', 2, 4, 3, { cls: MC, type: F, rows: 4, cols: 3 }], ['Fs', 2, 9, 1, T.Fs]]);
  const ps2 = shader(false, [['Color', 2, 0, 1, T.Color], ['S0', 3, 0, 1, samplerT]]);
  const fx1 = effectBinary({
    params: [{ name: 'M', t: T.M }, { name: 'W', t: { cls: MC, type: F, rows: 4, cols: 3 } }, { name: 'Fs', t: T.Fs }, { name: 'Color', t: T.Color }, tex(0),
      sampler('S0', 'T0', [[op('samp', 5), 0, 1], [op('samp', 6), 0, 1], [op('samp', 1), 0, 3]])],
    techniques: [{ name: 'T', passes: [{ name: 'P0', states: [{ op: op('vs'), value: vs2 }, { op: op('ps'), value: ps2 }] }] }],
  });
  const vs3 = shader(true, [['I4', 1, 0, 2, { cls: V, type: PT.INT, rows: 1, cols: 4, elements: 2 }], ['Bs', 0, 0, 2, { cls: S, type: PT.BOOL, elements: 2 }], ['V', 2, 100, 1, vec(4)], ['Fi', 2, 101, 1, { cls: S, type: PT.INT }]]);
  const fx2 = effectBinary({
    params: [{ name: 'I4', t: { cls: V, type: PT.INT, rows: 1, cols: 4, elements: 2 } }, { name: 'Bs', t: { cls: S, type: PT.BOOL, elements: 2 } }, { name: 'V', t: vec(4) }, { name: 'Fi', t: { cls: S, type: PT.INT } }],
    techniques: [{ name: 'T', passes: [{ name: 'P0', states: [{ op: op('vs'), value: vs3 }] }] }],
  });
  return [fx0, fx1, fx2];
}

/** handles and names of the effects' parameters by shape: [name, kind, words] */
const PARAMS = [
  [['M', 'mat', 16], ['MRow', 'mat', 12], ['Arr', 'vecs', 12], ['Arr[1]', 'vec', 4], ['St', 'raw', 14], ['St[1].Color', 'vec', 4], ['St[0].Dir', 'vec', 3], ['Fs', 'float', 1], ['Bf', 'bool', 1],
    ['Iv', 'int', 2], ['B', 'bool', 1], ['Ba', 'bools', 3], ['Ba[2]', 'bool', 1], ['Mt', 'mat', 16], ['Big', 'vecs', 16], ['Mats', 'mats', 24], ['Mats[1]', 'mat', 12], ['Color', 'vec', 4], ['Iref', 'int', 1]],
  [['M', 'mat', 16], ['W', 'mat', 12], ['Fs', 'float', 1], ['Color', 'vec', 4]],
  [['I4', 'ints', 8], ['I4[1]', 'int', 4], ['Bs', 'bools', 2], ['V', 'vec', 4], ['Fi', 'int', 1]],
];
const TEXTURES = [['T0', 'T1'], ['T0'], []];

/** a session: environment, device, effects; every call made with the effect runtime's path given (reference or not) */
function session(ref, overlap = false) { // (ref: the reference path, or null: either)
  const touched = [], smCalls = [];
  const E = d3dEnv({ createDevice: () => ({ constTouched: (s, a, b) => touched.push(s, a, b) }) }), { mem, ctx, com, vm } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  Object.assign(vm, { effectCtx: null, callGuest: (t, fn, args) => { smCalls.push(fn, ...args.map((a) => a >>> 0)); return 0; }, log: () => {} });
  const X = {}; com.interface ??= () => {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const fxs = effects(overlap).map((bytes) => {
    const src = E.alloc(bytes.length); mem.writeBytes(src, bytes);
    assert.equal(X.D3DXCreateEffect[1](ctx([devPtr, src, bytes.length, 0, 0, 0, 0, out, 0])), 0);
    const ptr = mem.read32(out);
    return { ptr, fx: com.implAt(ptr), begun: false, pass: -1, names: new Map() };
  });
  // (kept alive whatever the references: state blocks set textures without counting them, see d3d-random.js)
  const textures = []; for (let i = 0; i < 4; i++) { dev.CreateTexture(ctx([devPtr, 16, 16, 1, 0, 21, 1, out, 0])); textures.push(mem.read32(out)); com.objectAt(textures[i]).refs += 1e6; }
  const scratch = E.alloc(4096), sm = E.alloc(256);
  for (let i = 0; i < 32; i++) mem.write32(sm + 64 + 4 * i, 0x30000000 + 4 * i); mem.write32(sm, sm + 64); // (a guest state manager: its vtable)
  const blocks = [];
  // (ref null: the path switched at random between calls, as dbg:ORTHROS_API_OPT_OFF / ORTHROS_FX_BIND_OFF do within a
  // session — all the API optimizations off, the effect binding's only, or none)
  let calls = 0;
  const run = (f) => {
    const was = [apiOpt.off, apiOpt.fxRef], r = ref === null ? (Math.imul(++calls, 0x9e3779b1) >>> 0) % 3 : ref ? 2 : 0;
    apiOpt.off = r === 2; apiOpt.fxRef = r >= 1;
    try { return f(); } finally { [apiOpt.off, apiOpt.fxRef] = was; }
  };
  return { E, mem, ctx, dev, devPtr, pp, fxs, textures, scratch, sm, blocks, touched, smCalls, run, name: (s) => { const p = E.alloc(s.length + 1); mem.writeCString(p, s); return p; } };
}

const SPECIAL = [0x80000000, 0x7fc00000, 0x7fc0beef, 0x7f800001, 0xffc00001, 0xff800123];
function rng(seed) { let s = seed >>> 0 || 1; return (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % n; }; }
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const fw = (v) => { f32[0] = v; return u32[0]; };

/** the same random step on both sessions (`special`: -0 and NaNs among the floats) */
function step(rnd, all, special) {
  const A = all[0];
  const floatWord = () => (special && rnd(6) === 0 ? SPECIAL[rnd(SPECIAL.length)] : rnd(5) === 0 ? 0 : rnd(9) === 0 ? fw([1e-40, 3e38, Infinity, -Infinity][rnd(4)]) : fw((rnd(2001) - 1000) / 8));
  const words = (n, kind) => Array.from({ length: n }, () => (kind === 'int' || kind === 'ints' ? (rnd(4) === 0 ? 0xffffffff - rnd(5) : rnd(9)) : kind === 'bool' || kind === 'bools' ? [0, 1, 2, 0xffffffff][rnd(4)] : floatWord()));
  const both = (f) => { const ra = A.run(() => f(A)); for (const S of all.slice(1)) assert.equal(S.run(() => f(S)), ra, 'results'); };
  const each = (g) => { for (const S of all) g(S.fxs[e]); };
  const trace = (x) => { if (process.env.FXTRACE) console.log(`fx${e} ${x}`); };
  const e = rnd(3), k = rnd(100);
  const call = (S, name, ...a) => S.fxs[e].fx[name](S.ctx([S.fxs[e].ptr, ...a]));
  const dcall = (S, name, ...a) => S.dev[name](S.ctx([S.devPtr, ...a]));
  const handle = (S, nm, byName) => { const p = S.fxs[e].names.get(nm) ?? S.fxs[e].names.set(nm, S.name(nm)).get(nm); return byName ? p : S.fxs[e].fx.GetParameterByName(S.ctx([S.fxs[e].ptr, 0, p])) >>> 0; };
  if (k < 40) { // a parameter
    const [nm, kind, n] = PARAMS[e][rnd(PARAMS[e].length)], byName = rnd(3) === 0, how = rnd(4), x = rnd(n), y = 1 + rnd(n), cnt = 1 + rnd(3);
    // (one write in three the values it was given last time: games set most parameters again unchanged)
    const last = all.last ??= new Map(), key = `${e}:${nm}`, ws = rnd(3) === 0 && last.has(key) ? last.get(key) : words(n + 2, kind);
    last.set(key, ws);
    const put = (S) => { for (let i = 0; i < ws.length; i++) S.mem.write32(S.scratch + 4 * i, ws[i]); for (let i = 0; i < 16 * 2; i++) S.mem.write32(S.scratch + 256 + 4 * i, ws[i % ws.length]); return S.scratch; };
    trace(`${nm} ${kind} how ${how} ${ws.map((w) => w.toString(16)).join(',')}`);
    both((S) => {
      const h = handle(S, nm, byName), p = put(S);
      if (how === 0) return call(S, 'SetValue', h, p, 4 * n); // (raw words)
      if (how === 1) return call(S, 'SetRawValue', h, p, 4 * x, 4 * y);
      switch (kind) {
        case 'mat': return call(S, ['SetMatrix', 'SetMatrixTranspose'][how & 1], h, S.scratch + 256);
        case 'mats': return call(S, ['SetMatrixArray', 'SetMatrixTransposeArray'][how & 1], h, S.scratch + 256, 1 + (cnt & 1));
        case 'vec': return call(S, 'SetVector', h, p);
        case 'vecs': return how === 2 ? call(S, 'SetVectorArray', h, p, cnt) : call(S, 'SetFloatArray', h, p, n);
        case 'float': return call(S, 'SetFloat', h, ws[0]);
        case 'bool': return call(S, 'SetBool', h, ws[0]);
        case 'bools': return call(S, 'SetBoolArray', h, p, n);
        case 'int': return call(S, 'SetInt', h, ws[0]);
        case 'ints': return call(S, 'SetIntArray', h, p, n);
        default: return call(S, 'SetValue', h, p, 4 * n);
      }
    });
  } else if (k < 43) { // parameter blocks
    const st = A.fxs[e], r = rnd(3);
    if (r === 0 && !st.recording) { both((S) => call(S, 'BeginParameterBlock')); each((x) => { x.recording = true; }); }
    else if (r === 1 && st.recording) { let id = 0; both((S) => (id = call(S, 'EndParameterBlock'))); each((x) => { x.recording = false; (x.pblocks ??= []).push(id); }); }
    else if (st.pblocks?.length) { const id = st.pblocks[rnd(st.pblocks.length)]; both((S) => call(S, 'ApplyParameterBlock', id)); }
  } else if (k < 46) { // a texture parameter
    const t = TEXTURES[e]; if (!t.length) return;
    const nm = t[rnd(t.length)], ti = rnd(5);
    const byName = rnd(2) === 0;
    both((S) => call(S, 'SetTexture', handle(S, nm, byName), ti < 4 ? S.textures[ti] : 0));
  } else if (k < 78) { // passes
    const st = A.fxs[e], r = rnd(10);
    trace(`pass begun ${st.begun} pass ${st.pass} r ${r}`);
    if (!st.begun) { const flags = rnd(2); both((S) => call(S, 'Begin', S.scratch + 2048, flags)); each((x) => { x.begun = true; }); }
    else if (st.pass < 0) { if (r < 7) { const p = rnd(e === 0 ? 2 : 1); both((S) => call(S, 'BeginPass', p)); each((x) => { x.pass = p; }); } else { both((S) => call(S, 'End')); each((x) => { x.begun = false; }); } }
    else if (r < 8) both((S) => call(S, 'CommitChanges'));
    else { both((S) => call(S, 'EndPass')); each((x) => { x.pass = -1; }); }
  } else if (k < 92) { // the application's own constants and states
    const r = rnd(9), vs = rnd(2) === 0, reg = r < 3 ? rnd(vs ? 256 : 32) : rnd(16), n = 1 + rnd(4), ws = words(4 * n, r < 3 ? 'float' : 'int');
    trace(`device r ${r} vs ${vs} reg ${reg} n ${n}`);
    both((S) => {
      for (let i = 0; i < ws.length; i++) S.mem.write32(S.scratch + 4 * i, ws[i]);
      if (r < 3) return dcall(S, vs ? 'SetVertexShaderConstantF' : 'SetPixelShaderConstantF', Math.min(reg, (vs ? 256 : 32) - n), S.scratch, n);
      if (r < 5) return dcall(S, vs ? 'SetVertexShaderConstantI' : 'SetPixelShaderConstantI', Math.min(reg, 16 - n), S.scratch, n);
      if (r < 7) return dcall(S, vs ? 'SetVertexShaderConstantB' : 'SetPixelShaderConstantB', Math.min(reg, 16 - n), S.scratch, n);
      if (r < 8) return dcall(S, 'SetSamplerState', reg & 3, 1 + (reg % 7), ws[0] & 7);
      return dcall(S, 'SetTexture', reg & 3, ws[0] & 1 ? S.textures[ws[0] & 3] : 0);
    });
  } else if (k < 97) { // state blocks
    const r = rnd(4);
    if (r === 0 && !A.dev.recording) { const regs = [rnd(2), rnd(2)], v = rnd(4); both((S) => { dcall(S, 'BeginStateBlock'); dcall(S, 'SetSamplerState', regs[0], 5, v); dcall(S, 'SetRenderState', 7, v & 1); return 0; }); }
    else if (r === 1 && A.dev.recording) both((S) => { const x = dcall(S, 'EndStateBlock', S.scratch + 3000); if (x === 0) S.blocks.push(S.mem.read32(S.scratch + 3000)); return x; });
    else if (r === 2 && !A.dev.recording) both((S) => { const x = dcall(S, 'CreateStateBlock', 1, S.scratch + 3000); if (x === 0) S.blocks.push(S.mem.read32(S.scratch + 3000)); return x; });
    else if (A.blocks.length && !A.dev.recording) { const i = rnd(A.blocks.length); both((S) => { const b = S.E.com.implAt(S.blocks[i]); return b ? b.Apply(S.ctx([S.blocks[i]])) : -1; }); }
  } else if (k < 98) { // Reset (the device's registers replaced)
    if (!A.dev.recording) both((S) => dcall(S, 'Reset', S.pp));
  } else if (e === 2) { // a state manager set or removed
    const on = rnd(2) === 0; both((S) => call(S, 'SetStateManager', on ? S.sm : 0));
  }
}

/** the devices' observable state, equal between the sessions (`special`: NaNs equal whatever their payload, -0 = +0) */
function compare(A, B, special, overlap, where) {
  const a = A.dev, b = B.dev;
  for (const k of ['vsConst', 'psConst']) {
    const x = new Uint32Array(a[k].buffer), y = new Uint32Array(b[k].buffer);
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      const nan = (w) => (w & 0x7f800000) === 0x7f800000 && (w & 0x7fffff) !== 0;
      if (special && ((nan(x[i]) && nan(y[i])) || ((x[i] | y[i]) & 0x7fffffff) === 0)) continue;
      assert.fail(`${where}: ${k}[${i}] 0x${x[i].toString(16)} (reference) vs 0x${y[i].toString(16)}`);
    }
  }
  for (const k of ['vsConstI', 'psConstI', 'vsConstB', 'psConstB']) assert.deepEqual(Array.from(b[k]), Array.from(a[k]), `${where}: ${k}`);
  assert.deepEqual(b.textures, a.textures, `${where}: textures`);
  for (let r = 0; r < 4; r++) assert.deepEqual(b.samplers[r].v, a.samplers[r].v, `${where}: sampler ${r}`);
  assert.deepEqual(b.rs.v, a.rs.v, `${where}: render states`);
  assert.equal(b.vsObj?.ptr ?? 0, a.vsObj?.ptr ?? 0, `${where}: vertex shader`);
  assert.equal(b.psObj?.ptr ?? 0, a.psObj?.ptr ?? 0, `${where}: pixel shader`);
  assert.deepEqual(B.smCalls, A.smCalls, `${where}: state manager calls`);
  if (!special && !overlap) {
    assert.deepEqual(B.touched, A.touched, `${where}: constTouched ranges`);
    assert.equal(b.constVersion - B.v0, a.constVersion - A.v0, `${where}: constant versions`);
  }
}

const STAGE_ARRAYS = ['vsConst', 'psConst', 'vsConstI', 'psConstI', 'vsConstB', 'psConstB'];
const snapshot = (S) => ({ arrays: STAGE_ARRAYS.map((k) => S.dev[k]), words: STAGE_ARRAYS.map((k) => Array.from(new Uint32Array(S.dev[k].buffer.slice(0)))), at: S.touched.length });
/** every register changed by a step announced by a constTouched range of that step (what the backends rely on) */
function covered(S, before, where) {
  if (STAGE_ARRAYS.some((k, i) => S.dev[k] !== before.arrays[i])) return; // (Reset: new arrays, the backend told by reset)
  const t = S.touched.slice(before.at);
  STAGE_ARRAYS.forEach((k, st) => {
    const now = new Uint32Array(S.dev[k].buffer), old = before.words[st], per = k.endsWith('B') ? 4 : 1; // (bools: one byte per register)
    for (let i = 0; i < old.length; i++) {
      if (now[i] === old[i]) continue;
      for (let b = 0; b < per; b++) {
        const idx = i * per + b; // (an index of the typed array)
        if (per === 4 && ((now[i] >>> (8 * b)) & 255) === ((old[i] >>> (8 * b)) & 255)) continue;
        let ok = false; for (let j = 0; j < t.length; j += 3) if (t[j] === st && t[j + 1] <= idx && idx < t[j + 2]) ok = true;
        assert.ok(ok, `${where}: ${k}[${idx}] changed without constTouched`);
      }
    }
  });
}

// (overlap: a preshader output on a binding's register — the reference path compares any binding again after a change
// of the other stage too, writing that register twice per pass: same state, more notifications; compared by coverage)
for (const [special, overlap] of [[false, false], [false, true], [true, true]]) {
  test(`effect binding: the same device state as the reference path after every call (random sessions${special ? ', -0 and NaNs' : ''}${overlap ? ', overlapping preshader' : ''})`, () => {
    for (let seed = 1; seed <= 6; seed++) {
      // (A the reference path, B the optimized one, C either at random from call to call)
      const A = session(true, overlap), B = session(false, overlap), C = session(null, overlap), all = [A, B, C], rnd = rng(seed * 7919 + (special ? 1 : 0) + (overlap ? 2 : 0));
      for (const S of all) S.v0 = S.dev.constVersion;
      for (let i = 0; i < 2500; i++) {
        const snaps = all.map(snapshot), where = `seed ${seed} step ${i}`;
        step(rnd, all, special);
        compare(A, B, special, overlap, where);
        compare(A, C, special, true, `${where} (switched paths)`); // (the reference's extra notifications: coverage)
        all.forEach((S, k) => covered(S, snaps[k], where));
      }
      assert.ok(A.touched.length > 300, 'constants reached the device');
    }
  });
}

test('effect binding: float words reach the registers bit for bit (-0, NaN payloads), the reference path as before', () => {
  for (const ref of [false, true]) {
    const S = session(ref), { mem } = S, fx = S.fxs[1];
    const h = (nm) => fx.fx.GetParameterByName(S.ctx([fx.ptr, 0, S.name(nm)])) >>> 0;
    const words = [0x80000000, 0x7fc0beef, 0x7f800001, 0x3f800000];
    for (let i = 0; i < 4; i++) mem.write32(S.scratch + 4 * i, words[i]);
    S.run(() => {
      fx.fx.SetValue(S.ctx([fx.ptr, h('Color'), S.scratch, 16]));
      fx.fx.Begin(S.ctx([fx.ptr, 0, 1])); fx.fx.BeginPass(S.ctx([fx.ptr, 0]));
    });
    const got = Array.from(new Uint32Array(S.dev.psConst.buffer, 0, 4));
    // (the reference path decodes and re-encodes the words: -0 against the register's +0 is no change, a signalling NaN is quietened)
    assert.deepEqual(got, ref ? [0, 0x7fc0beef, 0x7fc00001, 0x3f800000] : words);
  }
});

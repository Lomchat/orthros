// ID3DXEffect's technique calls on the JIT's deferred queue (runtime.js DEFER_TECH / DEFER_BEGIN / DEFER_END):
// SetTechnique, Begin and End are queued like the parameter setters — Begin's pass count answered at once from the
// technique slot, End making the issued-state filter forget the states its restore may set. Random engine-shaped call
// sequences (techniques by handle, by name, invalid handles, techniques without passes, Begin with and without saving
// states, BeginPass out of range, commits, the application's own state sets — often the values a pass or a restore
// leaves —, state blocks, End without Begin) run as guest code through the JIT, with JavaScript draining the queue
// before every call it handles, and on a reference executing every call in order: the same results (EAX, the pass
// counts written), the same device state at every draw and at the end. A restore list missing a state is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { DEFER_QUEUE, DEFER_SPEC, DEFER_RAW, COM_MARKER, FAST_STATS, FX_SLOTS } from '../src/cpu/jit/runtime.js';
import { d3dEnv } from './d3d-random.js';
import { defineEffects } from '../src/win32/d3dx9-effect.js';
import { effectBinary, shader, op } from './fx-build.js';
import { PT, PC } from '../src/win32/d3dx9-fxparse.js';

const CODE = 0x20000000, SLOTS = 0x10000100, STACK = 0x10090000, RESULTS = 0x10100000, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const callSlot = (i) => [0xff, 0x15, ...le(SLOTS + 4 * i)];
// [interface method, stack arguments after `this`]; 'Observe' (a draw: the device state recorded) is handled in JavaScript
const METHODS = [
  ['ID3DXEffect::SetTechnique', 1], ['ID3DXEffect::Begin', 2], ['ID3DXEffect::BeginPass', 1], ['ID3DXEffect::CommitChanges', 0], ['ID3DXEffect::EndPass', 0],
  ['ID3DXEffect::End', 0], ['ID3DXEffect::SetInt', 2], ['ID3DXEffect::SetTexture', 2], ['IDirect3DDevice9::SetRenderState', 2], ['IDirect3DDevice9::SetTextureStageState', 3],
  ['IDirect3DDevice9::SetTexture', 2], ['IDirect3DDevice9::SetSamplerState', 3], ['IDirect3DDevice9::BeginStateBlock', 0], ['IDirect3DDevice9::EndStateBlock', 1], ['IDirect3DDevice9::Observe', 0],
  ['IDirect3DDevice9::SetTransform', 2], ['ID3DXEffect::SetVector', 2],
];
const M = Object.fromEntries(METHODS.map(([k], i) => [k.split('::')[1] + (k.startsWith('IDirect3DDevice9') && k.endsWith('SetTexture') ? '9' : ''), i]));

const I = { cls: PC.SCALAR, type: PT.INT }, tex = { cls: PC.OBJECT, type: PT.TEXTURE }, samplerT = { cls: PC.OBJECT, type: PT.SAMPLER2D };
const vec4 = { cls: PC.VECTOR, type: PT.FLOAT, rows: 1, cols: 4 };
/** effect k: techniques of one and two passes (render, stage, sampler states and textures — constants, parameters, expressions), one without passes */
function effect(k) {
  const vs = shader(true, [['C', 2, 0, 1, vec4]]), ps = shader(false, [['S0', 3, 0, 1, samplerT]]);
  const ge1 = { literals: [1], insns: [[0x2030, 1, [{ table: 2, offset: 0 }, { table: 1, offset: 0 }], { table: 4, offset: 0 }]], inputs: [['R', 2, 0, 1, I]] };
  return effectBinary({
    params: [{ name: 'R', t: I }, { name: 'C', t: vec4 }, { name: 'Tex0', t: tex }, { name: 'Tex1', t: tex },
      { name: 'S0', t: samplerT, samplers: [[[op('texture'), 0, 'Tex0'], [op('samp', 6), 0, 2], [op('samp', 1), 0, 'R']]] }],
    techniques: [
      { name: 'T0', passes: [
        { name: 'P0', states: [{ op: op('vs'), value: vs }, { op: op('ps'), value: ps }, { op: op('rs', 7), value: 1 }, { op: op('rs', 22), ref: 'R' }, { op: op('rs', 27), expr: ge1 },
          { op: op('tss', 1), index: 0, value: 4 + k }, { op: op('texture'), index: 1, ref: 'Tex1' }, { op: op('sampler'), index: 0, ref: 'S0' }] },
        { name: 'P1', states: [{ op: op('rs', 7), value: 0 }, { op: op('rs', 14), value: 1 }, { op: op('tss', 2), index: 1, value: 2 }, { op: op('samp', 5), index: 2, value: 3 }] }] },
      { name: 'T1', passes: [{ name: 'P0', states: [{ op: op('rs', 27), value: 1 }, { op: op('rs', 20), value: 5 + k }, { op: op('rs', 14), ref: 'R' }, { op: op('texture'), index: 3, ref: 'Tex0' }] }] },
      { name: 'T2', passes: [] },
    ],
  });
}

/** an environment: device, two effects, textures; `jit`: guest code through the JIT (else the reference runs every call) */
function session(jit) {
  const E = d3dEnv(null, false, { fullMemory: true, objectBytes: 24 }), { mem, ctx, com, vm } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  mem.write32(devPtr + 4, COM_MARKER);
  Object.assign(vm, { effectCtx: null, callGuest: () => 0, log: () => {} });
  const X = {}; com.interface ??= () => {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const fxs = [0, 1].map((k) => {
    const bytes = effect(k), src = E.alloc(bytes.length); mem.writeBytes(src, bytes);
    assert.equal(X.D3DXCreateEffect[1](ctx([devPtr, src, bytes.length, 0, 0, 0, 0, out, 0])), 0);
    const ptr = mem.read32(out), fx = com.implAt(ptr); mem.write32(ptr + 4, COM_MARKER);
    const name = (s) => { const p = E.alloc(s.length + 1); mem.writeCString(p, s); return p; };
    const h = (s) => fx.GetParameterByName(ctx([ptr, 0, name(s)])) >>> 0;
    return { ptr, fx, techs: ['T0', 'T1', 'T2'].map((t) => fx.GetTechniqueByName(ctx([ptr, name(t)])) >>> 0), techNames: ['T0', 'T1'].map(name), R: h('R'), Tex0: h('Tex0'), Tex1: h('Tex1') };
  });
  const textures = []; for (let i = 0; i < 3; i++) { dev.CreateTexture(ctx([devPtr, 16, 16, 1, 0, 21, 1, out, 0])); textures.push(mem.read32(out)); com.objectAt(textures[i]).refs += 1e6; }
  const S = { E, mem, ctx, com, dev, devPtr, fxs, textures, draws: [], sbOut: E.alloc(16) };
  /** a call of METHODS[m] with its arguments (`this` first), as the COM dispatcher makes it */
  S.call = (m, args) => {
    if (m === M.Observe) { S.draws.push(S.state()); return 0; }
    const name = METHODS[m][0].split('::')[1], impl = com.implAt(args[0]);
    const r = impl[name](ctx(args));
    return r === undefined ? 0 : r >>> 0;
  };
  S.state = () => JSON.stringify([[...dev.rs].sort((a, b) => a[0] - b[0]), dev.tss.slice(0, 3).map((t) => [...t].sort((a, b) => a[0] - b[0])), dev.samplers.slice(0, 3).map((t) => [...t].sort((a, b) => a[0] - b[0])),
    dev.textures.slice(0, 4), dev.vsObj?.comObject?.ptr ?? 0, dev.psObj?.comObject?.ptr ?? 0, Array.from(dev.vsConst.subarray(0, 4))]);
  if (jit) {
    const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
    S.cpu = cpu; S.jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); S.jit.cpu = cpu;
    METHODS.forEach(([k], i) => { S.jit.markFast(i, `com.dll!${k}`, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
  }
  return S;
}

/** a random engine-shaped sequence of [method, args] (the same for every session: addresses are equal between them) */
function program(S, seed, n) {
  let x = seed >>> 0;
  const rnd = (k) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % k; };
  const calls = [], { fxs, devPtr, textures } = S;
  let out = 0;
  const devStates = () => { // (the application's own states: often those the effects' passes and restores leave)
    const r = rnd(10);
    if (r < 5) calls.push([M.SetRenderState, [devPtr, [7, 14, 20, 22, 27][rnd(5)], rnd(3) === 0 ? 5 + rnd(2) : rnd(3)]]);
    else if (r < 7) calls.push([M.SetTextureStageState, [devPtr, rnd(3), [1, 2][rnd(2)], [2, 4, 5][rnd(3)]]]);
    else if (r < 8) calls.push([M.SetSamplerState, [devPtr, rnd(3), [1, 5, 6][rnd(3)], rnd(4)]]);
    else calls.push([M.SetTexture9, [devPtr, rnd(4), [0, ...textures][rnd(4)]]]);
  };
  for (let i = 0; i < n; i++) {
    const f = fxs[rnd(2)], r = rnd(100);
    if (r < 3) { calls.push([M.BeginStateBlock, [devPtr]]); for (let k = rnd(3); k >= 0; k--) devStates(); calls.push([M.EndStateBlock, [devPtr, S.sbOut]]); continue; }
    if (r < 8) { calls.push([M.End, [f.ptr]]); continue; } // (an End out of place)
    for (let k = rnd(4); k > 0; k--) devStates();
    // the technique: by handle (mostly), by name, a parameter's handle (invalid), one without passes
    const t = rnd(20);
    calls.push([M.SetTechnique, [f.ptr, t < 14 ? f.techs[rnd(2)] : t < 16 ? f.techNames[rnd(2)] : t < 18 ? f.R : f.techs[2]]]);
    if (rnd(3) === 0) calls.push([M.SetInt, [f.ptr, f.R, rnd(3)]]);
    if (rnd(4) === 0) calls.push([M.SetTexture, [f.ptr, [f.Tex0, f.Tex1][rnd(2)], [0, ...textures][rnd(4)]]]);
    calls.push([M.Begin, [f.ptr, rnd(5) === 0 ? 0 : RESULTS + 4 * (out++ % 1024), [0, 0, 1, 2, 6][rnd(5)]]]);
    if (rnd(6) === 0) continue; // (Begin without the rest)
    const passes = 1 + rnd(2);
    for (let p = 0; p < passes; p++) {
      calls.push([M.BeginPass, [f.ptr, rnd(8) === 0 ? 2 : p]]);
      for (let d = rnd(3); d >= 0; d--) {
        if (rnd(2)) calls.push([M.SetInt, [f.ptr, f.R, rnd(3)]]);
        if (rnd(3) === 0) devStates();
        calls.push([M.CommitChanges, [f.ptr]]);
        calls.push([M.Observe, [devPtr]]);
      }
      calls.push([M.EndPass, [f.ptr]]);
    }
    if (rnd(8) !== 0) calls.push([M.End, [f.ptr]]);
    if (rnd(3) === 0) calls.push([M.Observe, [devPtr]]);
  }
  return calls;
}

/** run `calls` as guest code through the JIT; every call left to JavaScript drains the queue first (Vm.dispatchThunk) */
function runJit(S, calls, hook) {
  const { mem, cpu, jit } = S;
  const code = [];
  calls.forEach(([m, args], i) => { for (let k = args.length - 1; k >= 0; k--) code.push(...push(args[k])); code.push(...callSlot(m), 0xa3, ...le(RESULTS + 0x10000 + 4 * i)); });
  code.push(0xf4);
  mem.writeBytes(CODE, Uint8Array.from(code)); jit.invalidate(CODE, code.length);
  cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
  const drain = () => {
    const n = mem.read32(DEFER_QUEUE);
    mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 4, 0); mem.write32(DEFER_QUEUE + 8, 0);
    for (let p = DEFER_QUEUE + 16, end = p + n; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), spec = mem.read32(DEFER_SPEC + 4 * idx), words = spec & DEFER_RAW ? mem.read32(p + 24) >>> 2 : (spec >>> 8) & 0xff;
      S.call(idx, Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i)));
      p += 4 * (2 + argc + words);
    }
  };
  const toJs = new Array(METHODS.length).fill(0);
  let r;
  for (let k = 0; k < 1e6; k++) {
    r = jit.run({ maxInsns: 1e7 });
    if (r !== EXIT.THUNK) break;
    drain();
    const idx = cpu.exitArg, argc = METHODS[idx][1] + 1, args = Array.from({ length: argc }, (_, i) => mem.read32(cpu.esp + 4 + 4 * i));
    toJs[idx]++;
    const eax = S.call(idx, args);
    hook?.(S);
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 4 + 4 * argc; cpu.eax = eax >>> 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(cpu.esp, STACK, 'stdcall returns');
  drain();
  return toJs;
}

/** the reference: every call in order, its result stored as the guest program stores EAX */
function runRef(S, calls) { calls.forEach(([m, args], i) => S.mem.write32(RESULTS + 0x10000 + 4 * i, S.call(m, args))); }

function compare(A, B, calls, where) {
  for (let i = 0; i < calls.length; i++) assert.equal(A.mem.read32(RESULTS + 0x10000 + 4 * i), B.mem.read32(RESULTS + 0x10000 + 4 * i), `${where}: result of call ${i} (${METHODS[calls[i][0]][0]})`);
  for (let i = 0; i < 1024; i++) assert.equal(A.mem.read32(RESULTS + 4 * i), B.mem.read32(RESULTS + 4 * i), `${where}: pass count ${i}`);
  assert.equal(A.draws.length, B.draws.length, `${where}: draws`);
  for (let i = 0; i < A.draws.length; i++) assert.equal(A.draws[i], B.draws[i], `${where}: device state at draw ${i}`);
  assert.equal(A.state(), B.state(), `${where}: final device state`);
}

test('effect technique calls queued: the same results, pass counts and device states as running every call in order', () => {
  const queued = new Array(METHODS.length).fill(0), total = new Array(METHODS.length).fill(0);
  let dropped = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const A = session(true), B = session(false), calls = program(A, seed, 160);
    const d0 = A.mem.read32(FAST_STATS);
    const toJs = runJit(A, calls);
    runRef(B, calls);
    compare(A, B, calls, `seed ${seed}`);
    dropped += A.mem.read32(FAST_STATS) - d0;
    for (const [m] of calls) { total[m]++; queued[m]++; }
    toJs.forEach((n, m) => { queued[m] -= n; });
  }
  // (the fast paths did their part: most technique calls queued, redundant sets dropped)
  assert.ok(queued[M.SetTechnique] > total[M.SetTechnique] / 2, `SetTechnique queued ${queued[M.SetTechnique]} of ${total[M.SetTechnique]}`);
  assert.ok(queued[M.Begin] > total[M.Begin] / 2, `Begin queued ${queued[M.Begin]} of ${total[M.Begin]}`);
  assert.ok(queued[M.End] > total[M.End] / 2, `End queued ${queued[M.End]} of ${total[M.End]}`);
  assert.equal(queued[M.BeginPass], 0, 'BeginPass in JavaScript');
  assert.ok(dropped > 50, `redundant sets dropped: ${dropped}`);
});

test('effect technique calls queued: Begin answers the pass count of the technique set last, JavaScript the rest (no technique, no passes, a state manager)', () => {
  const A = session(true), f = A.fxs[0], { mem } = A;
  const calls = [[M.SetTechnique, [f.ptr, f.techs[0]]], [M.Begin, [f.ptr, RESULTS, 0]], [M.End, [f.ptr]], [M.SetTechnique, [f.ptr, f.techs[1]]], [M.Begin, [f.ptr, RESULTS + 4, 1]], [M.End, [f.ptr]],
    [M.SetTechnique, [f.ptr, f.techs[2]]], [M.Begin, [f.ptr, RESULTS + 8, 0]], [M.SetTechnique, [f.ptr, f.R]]];
  const toJs = runJit(A, calls);
  assert.deepEqual([0, 1, 2].map((i) => mem.read32(RESULTS + 4 * i)), [2, 1, 0]);
  assert.equal(mem.read32(RESULTS + 0x10000 + 4 * 8), 0x8876086c, 'a parameter handle: D3DERR_INVALIDCALL');
  assert.deepEqual([toJs[M.SetTechnique], toJs[M.Begin], toJs[M.End]], [2, 1, 0], 'technique without passes and parameter handle in JavaScript');
  assert.equal(mem.read32(A.fxs[0].fx.handleBlock + FX_SLOTS), 0, 'technique slot: no passes');
  // a state manager set: every technique call to JavaScript (its +12 cleared)
  const B = session(true), g = B.fxs[1];
  g.fx.SetStateManager(B.ctx([g.ptr, 0x10200000]));
  const toJs2 = runJit(B, [[M.SetTechnique, [g.ptr, g.techs[1]]], [M.Begin, [g.ptr, RESULTS, 0]], [M.End, [g.ptr]]]);
  assert.deepEqual([toJs2[M.SetTechnique], toJs2[M.Begin], toJs2[M.End]], [1, 1, 1]);
  // the measurement switch (dbg:ORTHROS_FX_DEFER_OFF, and the D3DX fast paths' switch): to JavaScript, then queued again
  const C = session(true), h = C.fxs[0], seq = [[M.SetTechnique, [h.ptr, h.techs[1]]], [M.Begin, [h.ptr, RESULTS, 0]], [M.End, [h.ptr]]], n = (t) => [t[M.SetTechnique], t[M.Begin], t[M.End]];
  C.jit.setFxDefer(false); assert.deepEqual(n(runJit(C, seq)), [1, 1, 1], 'switched off');
  C.jit.setFxDefer(true); assert.deepEqual(n(runJit(C, seq)), [0, 0, 0], 'switched on');
  C.jit.setD3dxFast(false); assert.deepEqual(n(runJit(C, seq)), [1, 1, 1], 'with the D3DX fast paths off');
  C.jit.setD3dxFast(true); assert.deepEqual(n(runJit(C, seq)), [0, 0, 0], 'and on');
});

test('effect technique calls queued: a restore list missing a state is caught by the randomized comparison', () => {
  // (the test's sensitivity: every list published by Begin loses its last entry)
  let mismatches = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const A = session(true), B = session(false), calls = program(A, seed, 160);
    const cut = new Set();
    const hook = (S) => { for (const f of S.fxs) { const L = S.mem.read32(f.fx.handleBlock + FX_SLOTS + 4), n = L ? S.mem.read32(L + 4) : 0; if (L && n > 0 && n < 0xffffffff && !cut.has(L)) { cut.add(L); S.mem.write32(L + 4, n - 1); } } };
    runJit(A, calls, hook); runRef(B, calls);
    try { compare(A, B, calls, `seed ${seed}`); } catch { mismatches++; }
  }
  assert.ok(mismatches > 0, 'an incomplete restore list makes the filter drop sets it must not');
});

test('queued setters carrying a structure (SetTransform, an effect\'s SetVector) leave the filter on, the reference counts alone and the effect\'s lists untouched', () => {
  const A = session(true), f = A.fxs[0], { mem, devPtr } = A;
  const MAT = 0x10180000; for (let i = 0; i < 16; i++) mem.writeF32(MAT + 4 * i, i % 5 === 0 ? 1 : 0.5);
  // (a pass begun first: the effect has published its commit list; the program stops at the first call left to JavaScript)
  runJit(A, [[M.SetTechnique, [f.ptr, f.techs[0]]], [M.Begin, [f.ptr, 0, 0]], [M.BeginPass, [f.ptr, 0]]]);
  const list = mem.read32(f.ptr + 20), entries = mem.read32(list + 4), restore = mem.read32(f.fx.handleBlock + FX_SLOTS + 4), slot = mem.read32(f.fx.handleBlock + FX_SLOTS);
  assert.ok(list && entries > 0 && restore, 'commit and restore lists published');
  const rs7 = A.dev.rs.get(7), d0 = mem.read32(FAST_STATS);
  const { cpu, jit } = A, code = [...push(MAT), ...push(256), ...push(devPtr), ...callSlot(M.SetTransform), ...push(MAT), ...push(f.R), ...push(f.ptr), ...callSlot(M.SetVector),
    ...push(rs7), ...push(7), ...push(devPtr), ...callSlot(M.SetRenderState), 0xf4];
  mem.writeBytes(CODE, Uint8Array.from(code)); jit.invalidate(CODE, code.length);
  cpu.eip = CODE; cpu.esp = STACK;
  assert.equal(jit.run({ maxInsns: 1e6 }), EXIT.HALT, 'all three on the fast path');
  assert.deepEqual([mem.read32(DEFER_QUEUE + 4), mem.read32(DEFER_QUEUE + 8)], [0, 0], 'no reference change pending, the filter on');
  assert.equal(mem.read32(FAST_STATS) - d0, 1, 'the redundant render state dropped');
  assert.deepEqual([mem.read32(list + 4), mem.read32(f.fx.handleBlock + FX_SLOTS + 4), mem.read32(f.fx.handleBlock + FX_SLOTS)], [entries, restore, slot], 'the effect\'s lists and technique slot untouched');
  const rec = DEFER_QUEUE + 16 + 4 * (2 + 3 + 16);
  assert.deepEqual([mem.read32(rec + 8), mem.read32(rec + 12)], [f.ptr, f.R], 'SetVector recorded with its handle');
});

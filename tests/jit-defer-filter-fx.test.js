// Issued-state filter of the fixed-function lights, the material and the Direct3D 9 FVF (runtime.js DEFER_FX_*), against
// the real Direct3D 8 / 9 devices (d3d8.js, d3d9.js): random call sequences — lights set again with the same words, with
// -0 for +0, NaN members, types that are not floats, null pointers, lights out of the shadowed range, switches with odd
// BOOL values, declarations that reset the FVF, state blocks, Reset, an effect commit that sets lights and the FVF behind
// the shadow's back, drains at random points — run through the JIT (calls queued, filtered, drained before every call
// left to JavaScript, as Vm.dispatchThunk does) and through a reference device that executes every call in order. The
// filter may only drop calls that change nothing: the devices must agree at every draw (queued too: compared when it
// runs), version counters included. Also: a queued call carrying a structure (a transform) leaves the filter on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { registerDirect3D8 } from '../src/win32/d3d8.js';
import { registerDirect3D9 } from '../src/win32/d3d9.js';
import { DEFER_QUEUE, DEFER_SPEC, DEFER_RAW, COM_MARKER, COMMIT_LIST, FAST_STATS, COMMIT_LIST_WORDS } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, SLOTS = 0x10000100, STACK = 0x10090000, DATA = 0x10100000, HEAP = 0x11000000, THUNK_SIZE = 16;
const FX = 0x10004100, FX_HANDLES = 0x10006000, FX_LIST = 0x10007800;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const callSlot = (i) => [0xff, 0x15, ...le(SLOTS + 4 * i)];

/** guest memory, a bump allocator, COM objects as com.js lays them out (+4 marker, +12 the fast paths' word) */
function d3dWorld(api9, gfx = null) {
  const mem = new GuestMemory();
  let top = HEAP;
  const alloc = (n) => { const a = top; top += (Math.max(n, 16) + 15) & ~15; return a; };
  const vmem = { alloc, release() {} };
  const proc = { mem, vmem, processHeap: { alloc, free_() {} }, symbolize: () => '?' };
  const objects = new Map();
  const com = {
    objects, interface() {}, supports: () => true,
    create(p, iface, impl) { const ptr = alloc(24); mem.write32(ptr + 4, COM_MARKER); const obj = { ptr, impl, refs: 1, proc: p }; objects.set(ptr, obj); impl.comObject = obj; return ptr; },
    objectAt: (ptr) => objects.get(ptr >>> 0) ?? null, implAt: (ptr) => objects.get(ptr >>> 0)?.impl ?? null,
    addRef: (o) => ++o.refs, release: (o) => --o.refs, unpin() {}, dispose() {},
  };
  const vm = { mem, com, proc, host: { gfx }, log() {}, clock: { now: () => 0 }, recentApiCalls: () => [], startApiBurst() {} };
  const defs = {};
  registerDirect3D8({ define(dll, d) { Object.assign(defs, d); } }, vm); registerDirect3D9({ define(dll, d) { Object.assign(defs, d); } }, vm);
  const ctx = (args) => ({ args, proc, thread: { id: 1 }, retAddr: 0, arg(i) { return (this.args[i] ?? 0) >>> 0; }, sarg(i) { return (this.args[i] ?? 0) | 0; }, argF32(i) { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, this.args[i] ?? 0, true); return b.getFloat32(0, true); }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } });
  const pp = alloc(64);
  if (api9) [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  else [320, 240, 22, 1, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  const out = alloc(16);
  com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  // a vertex declaration (Direct3D 9): position only
  let decl = 0;
  if (api9) { const el = alloc(32); [0, 0x00020000, 0, 0, 0xff, 0x00110000, 0, 0].forEach((v, i) => mem.write32(el + 4 * i, v)); mem.write32(el + 16, 0x000000ff); mem.write32(el + 20, 0x00000011); dev.CreateVertexDeclaration(ctx([devPtr, el, out])); decl = mem.read32(out); }
  return { mem, dev, devPtr, ctx, pp, decl, alloc };
}

const f32w = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return b.getUint32(0, true); };
/** the structures the program points to (the same addresses in both worlds): light and material variants */
function writeData(mem) {
  const lights = [], mats = [];
  const base = [3, ...[0.5, 0.25, 1, 1, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0, 1, 2, 3, -0.5, -1, 0, 100, 1, 1, 0, 0, 0.7, 0.3].map(f32w)];
  const variants = [
    base, // and a copy at another address: same words
    base,
    base.map((w, k) => (k === 6 ? 0x80000000 : w)), // -0 where the light holds +0
    base.map((w, k) => (k === 1 ? f32w(0.75) : w)), // another diffuse
    base.map((w, k) => (k === 0 ? 1 : w)), // another type (a point light)
    base.map((w, k) => (k === 0 ? 0x01000001 : w)), // a type no float holds exactly
    base.map((w, k) => (k === 9 ? 0x7fc00001 : w)), // a NaN member
    base.map((w, k) => (k === 9 ? 0x7f800000 : w)), // +inf
  ];
  let a = DATA;
  for (const v of variants) { v.forEach((w, k) => mem.write32(a + 4 * k, w)); lights.push(a); a += 128; }
  const mbase = [0.8, 0.8, 0.8, 1, 0.2, 0.2, 0.2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 8].map(f32w);
  const mvar = [mbase, mbase, mbase.map((w, k) => (k === 8 ? 0x80000000 : w)), mbase.map((w, k) => (k === 16 ? f32w(16) : w)), mbase.map((w, k) => (k === 3 ? 0xffc00000 : w))];
  for (const v of mvar) { v.forEach((w, k) => mem.write32(a + 4 * k, w)); mats.push(a); a += 128; }
  const xf = a; for (let i = 0; i < 16; i++) mem.write32(xf + 4 * i, f32w(i % 5 === 0 ? 1 : 0.5)); a += 64;
  return { lights, mats, xf };
}

function methodsOf(api9) {
  const I = `com.dll!IDirect3DDevice${api9 ? 9 : 8}::`;
  const list = [['SetLight', 2], ['LightEnable', 2], ['SetMaterial', 1], ['SetRenderState', 2], ['SetTransform', 2], ['DrawPrimitive', 3], ['BeginStateBlock', 0], ['EndStateBlock', 1], ['Reset', 1], ['ApplyStateBlock', 1], ['TestCooperativeLevel', 0]];
  if (api9) list.push(['SetFVF', 1], ['SetVertexDeclaration', 1]);
  const m = list.map(([n, argc]) => [I + n, argc]);
  m.push(['com.dll!ID3DXEffect::CommitChanges', 0]);
  return m;
}

function randomProgram(seed, n, api9, data, W) {
  let x = seed >>> 0;
  const rnd = (k) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % k; };
  const M = Object.fromEntries(methodsOf(api9).map(([k], i) => [k.split('::')[1], i]));
  const calls = [];
  const light = () => (rnd(8) === 0 ? 0 : data.lights[rnd(data.lights.length)]); // (null now and then: INVALIDCALL)
  const idx = () => (rnd(8) === 0 ? 8 + rnd(3) : rnd(3));
  for (let i = 0; i < n; i++) {
    const r = rnd(100);
    if (r < 30) calls.push([M.SetLight, [W.devPtr, idx(), light()]]);
    else if (r < 55) calls.push([M.LightEnable, [W.devPtr, idx(), [0, 1, 1, 1, 0x80][rnd(5)]]]);
    else if (r < 65) calls.push([M.SetMaterial, [W.devPtr, rnd(10) === 0 ? 0 : data.mats[rnd(data.mats.length)]]]);
    else if (r < 70) calls.push([M.SetRenderState, [W.devPtr, [7, 137][rnd(2)], rnd(2)]]);
    else if (r < 74) calls.push([M.SetTransform, [W.devPtr, 256, data.xf]]);
    else if (api9 && r < 82) calls.push([M.SetFVF, [W.devPtr, [0, 0x142, 0x152][rnd(3)]]]);
    else if (api9 && r < 85) calls.push([M.SetVertexDeclaration, [W.devPtr, rnd(3) === 0 ? 0 : W.decl]]);
    else if (r < 89) calls.push([M.DrawPrimitive, [W.devPtr, 4, 0, 1]]); // (queued: the state compared when it runs)
    else if (r < 92) calls.push([M.TestCooperativeLevel, [W.devPtr]]); // (handled in JavaScript: the queue runs)
    else if (r < 94) calls.push([M.CommitChanges, [FX]]);
    else if (r < 95) { // (a state block recorded: lights apply at once, the FVF is recorded)
      calls.push([M.BeginStateBlock, [W.devPtr]]);
      for (let k = rnd(3); k >= 0; k--) calls.push([M.LightEnable, [W.devPtr, rnd(2), rnd(2)]], [M.SetLight, [W.devPtr, rnd(2), light()]]);
      if (api9) calls.push([M.SetFVF, [W.devPtr, [0x142, 0x152][rnd(2)]]], [M.SetVertexDeclaration, [W.devPtr, rnd(2) ? W.decl : 0]]);
      calls.push([M.EndStateBlock, [W.devPtr, W.alloc(16)]]);
    }
    else if (r < 96) calls.push([M.Reset, [W.devPtr, W.pp]]);
    else if (r < 97) calls.push([M.ApplyStateBlock, [W.devPtr, 1 + rnd(3)]]); // (Direct3D 9: the FVF / declaration it holds)
    else calls.push([M.DrawPrimitive, [W.devPtr, 4, 0, 1]]);
  }
  return calls;
}

/** what the backend reads of these states (bitwise), and the version counters */
function stateOf(dev) {
  const lights = [...dev.lights].sort((a, b) => a[0] - b[0]).map(([i, l]) => [i, [...new Int32Array(l.buffer, l.byteOffset, l.length)]]);
  return JSON.stringify([lights, [...dev.lightEnabled], [...new Int32Array(dev.material.buffer, dev.material.byteOffset, 17)], dev.fvf ?? null, dev.vertexDecl ? 1 : 0, dev.rs.get(7), dev.rs.get(137), dev.stateVersion, dev.programVersion, dev.lightVersion, dev.transformVersion]);
}

/** the effect's CommitChanges: sets a light switch and the FVF (states the device shadows but commit lists do not name) */
function commit(W, api9, n) {
  const c = W.ctx([W.devPtr, n % 3, n % 2]);
  W.dev.LightEnable(c);
  if (api9) W.dev.SetFVF(W.ctx([W.devPtr, n % 2 ? 0x142 : 0x152]));
}

function call(W, api9, name, args, st) {
  if (name === 'CommitChanges') return commit(W, api9, ++st.commits);
  if (name === 'DrawPrimitive') { st.draws.push(stateOf(W.dev)); return; }
  return W.dev[name](W.ctx(args));
}

function runReference(seed, n, api9) {
  const W = d3dWorld(api9), data = writeData(W.mem);
  const calls = randomProgram(seed, n, api9, data, W);
  const names = methodsOf(api9).map(([k]) => k.split('::')[1]);
  const st = { commits: 0, draws: [] };
  for (const [m, a] of calls) call(W, api9, names[m], a, st);
  st.draws.push(stateOf(W.dev));
  return { draws: st.draws };
}

function runJitted(seed, n, api9, switching = false) {
  const W = d3dWorld(api9), { mem } = W, data = writeData(mem);
  const calls = randomProgram(seed, n, api9, data, W);
  const methods = methodsOf(api9), names = methods.map(([k]) => k.split('::')[1]);
  const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  methods.forEach(([k], i) => { jit.markFast(i, k, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
  // the effect: an Orthros object with a handle block (+12) and a commit list naming no shadowed state
  mem.write32(FX + 4, COM_MARKER); mem.write32(FX + 12, FX_HANDLES);
  mem.write32(FX_LIST, W.dev.shadow); mem.write32(FX_LIST + 4, 0); mem.write32(FX + COMMIT_LIST, FX_LIST);
  void COMMIT_LIST_WORDS;
  const code = [];
  for (const [m, args] of calls) { for (let i = args.length - 1; i >= 0; i--) code.push(...push(args[i])); code.push(...callSlot(m)); }
  code.push(0xf4);
  mem.writeBytes(CODE, Uint8Array.from(code));
  cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
  const st = { commits: 0, draws: [] };
  const drain = () => {
    const nb = mem.read32(DEFER_QUEUE);
    mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 4, 0); mem.write32(DEFER_QUEUE + 8, 0);
    for (let p = DEFER_QUEUE + 16, end = p + nb; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), spec = mem.read32(DEFER_SPEC + 4 * idx), words = spec & DEFER_RAW ? mem.read32(p + 24) >>> 2 : (spec >>> 8) & 0xff;
      call(W, api9, names[idx], Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i)), st);
      p += 4 * (2 + argc + words);
    }
  };
  const dropped0 = mem.read32(FAST_STATS);
  let r, x = seed * 7919;
  const rnd = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
  for (let k = 0; k < 100000; k++) {
    // (switching: short time slices — the measurement switch, dbg:ORTHROS_DRAW_OPT_OFF, arrives between slices, calls
    // queued or not; and now and then at a call left to JavaScript, before its queue runs)
    r = jit.run({ maxInsns: switching ? 1 + rnd() : 1e7 });
    if (r === EXIT.TIMESLICE) { if (rnd() < 32) jit.setDrawOpt(!!jit.drawOptOff); continue; }
    if (r !== EXIT.THUNK) break;
    if (switching && rnd() < 32) jit.setDrawOpt(!!jit.drawOptOff);
    drain();
    if (jit.drawOptPending) { jit.drawOptPending = false; jit.setFxSpecs(true); } // (as Vm.drainDeferred)
    const idx = cpu.exitArg, argc = methods[idx][1] + 1, args = Array.from({ length: argc }, (_, i) => mem.read32(cpu.esp + 4 + 4 * i));
    const eax = call(W, api9, names[idx], args, st) ?? 0;
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 4 + 4 * argc; cpu.eax = eax >>> 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(cpu.esp, STACK, 'stdcall returns');
  drain();
  st.draws.push(stateOf(W.dev));
  return { draws: st.draws, dropped: mem.read32(FAST_STATS) - dropped0 };
}

for (const api9 of [true, false]) {
  test(`lights / material / FVF filter (Direct3D ${api9 ? 9 : 8}): the devices agree at every draw with the reference that executes every call`, () => {
    let dropped = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const ref = runReference(seed, 300, api9);
      const jit = runJitted(seed, 300, api9);
      assert.equal(jit.draws.length, ref.draws.length);
      for (let i = 0; i < ref.draws.length; i++) assert.equal(jit.draws[i], ref.draws[i], `seed ${seed}, draw ${i}`);
      dropped += jit.dropped;
    }
    assert.ok(dropped > 1000, `the filter drops the redundant calls (${dropped})`);
  });
  test(`lights / material / FVF filter (Direct3D ${api9 ? 9 : 8}): the same with the measurement switch (queued draws and this filter off / on) flipped at random points`, () => {
    for (let seed = 101; seed <= 115; seed++) {
      const ref = runReference(seed, 300, api9);
      const jit = runJitted(seed, 300, api9, true);
      assert.equal(jit.draws.length, ref.draws.length);
      for (let i = 0; i < ref.draws.length; i++) assert.equal(jit.draws[i], ref.draws[i], `seed ${seed}, draw ${i}`);
    }
  });
}

test('lights filter: a light set again with its own words, and its switch, never reach JavaScript', () => {
  const W = d3dWorld(true), { mem } = W, data = writeData(mem);
  const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  const methods = methodsOf(true); methods.forEach(([k], i) => { jit.markFast(i, k, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
  const M = Object.fromEntries(methods.map(([k], i) => [k.split('::')[1], i]));
  const names = methods.map(([k]) => k.split('::')[1]);
  const runCode = (emitAll) => {
    const code = [];
    const emit = (m, args) => { for (let i = args.length - 1; i >= 0; i--) code.push(...push(args[i])); code.push(...callSlot(m)); };
    emitAll(emit); code.push(0xf4);
    mem.writeBytes(CODE, Uint8Array.from(code)); jit.invalidate?.(CODE, code.length);
    cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
    assert.equal(jit.run({ maxInsns: 1e7 }), EXIT.HALT);
  };
  const drain = () => { // (the queued calls run on the device, as Vm.drainDeferred does)
    const nb = mem.read32(DEFER_QUEUE); mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 8, 0);
    for (let p = DEFER_QUEUE + 16, end = p + nb; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), words = (mem.read32(DEFER_SPEC + 4 * idx) >>> 8) & 0xff;
      W.dev[names[idx]](W.ctx(Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i))));
      p += 4 * (2 + argc + words);
    }
  };
  // JavaScript sets light 1, enables it and sets the material
  W.dev.SetLight(W.ctx([W.devPtr, 1, data.lights[0]])); W.dev.LightEnable(W.ctx([W.devPtr, 1, 1])); W.dev.SetMaterial(W.ctx([W.devPtr, data.mats[0]]));
  W.dev.SetRenderState(W.ctx([W.devPtr, 7, 1]));
  // the program sets them again with -0 where they hold +0 (queued: the handlers find nothing changed and write the
  // shadow entries back), then repeats the calls with their own words 50 times, a transform (a queued structure) and
  // a redundant render state between them
  const d0 = mem.read32(FAST_STATS), v0 = W.dev.lightVersion;
  runCode((emit) => { emit(M.SetLight, [W.devPtr, 1, data.lights[2]]); emit(M.SetMaterial, [W.devPtr, data.mats[2]]); });
  assert.equal(mem.read32(FAST_STATS) - d0, 0, '-0 for +0: queued');
  drain();
  assert.equal(W.dev.lightVersion, v0, 'nothing changed');
  runCode((emit) => { for (let i = 0; i < 50; i++) { emit(M.SetTransform, [W.devPtr, 256, data.xf]); emit(M.SetLight, [W.devPtr, 1, data.lights[1]]); emit(M.LightEnable, [W.devPtr, 1, 1]); emit(M.SetMaterial, [W.devPtr, data.mats[1]]); emit(M.SetRenderState, [W.devPtr, 7, 1]); } });
  assert.equal(mem.read32(FAST_STATS) - d0, 200, 'every light, switch, material and render state set dropped');
  assert.equal(mem.read32(DEFER_QUEUE), 50 * 4 * (2 + 3 + 16), 'only the transforms queued');
});

for (const api9 of [true, false]) {
  test(`queued draws (Direct3D ${api9 ? 9 : 8}): run in order with the state of their call, before the next call handled in JavaScript`, () => {
    const seen = [];
    const gfx = { createDevice: (dev) => ({
      drawPrimitive: (type, start, count) => seen.push(['draw', type, start, count, dev.rs.get(7), dev.fvf ?? dev.vertexShader]),
      drawIndexedPrimitive: (type, minIdx, numV, start, count, base) => seen.push(['drawIndexed', type, minIdx, numV, start, count, base ?? null, dev.rs.get(7), dev.fvf ?? dev.vertexShader]),
    }) };
    const W = d3dWorld(api9, gfx), { mem } = W;
    const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
    const I = `com.dll!IDirect3DDevice${api9 ? 9 : 8}::`;
    const methods = [[I + 'SetRenderState', 2], [I + 'DrawPrimitive', 3], [I + 'DrawIndexedPrimitive', api9 ? 6 : 5], [I + 'TestCooperativeLevel', 0], [I + (api9 ? 'SetFVF' : 'SetVertexShader'), 1]];
    methods.forEach(([k], i) => { jit.markFast(i, k, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
    const code = [];
    const emit = (m, args) => { for (let i = args.length - 1; i >= 0; i--) code.push(...push(args[i])); code.push(...callSlot(m)); code.push(0xa3, ...le(0x10007000 + 4 * (code.length & 0xff))); }; // (EAX stored after each call)
    emit(0, [W.devPtr, 7, 1]); emit(4, [W.devPtr, 0x142]); emit(1, [W.devPtr, 4, 3, 2]);
    emit(0, [W.devPtr, 7, 0]); emit(4, [W.devPtr, 0x152]);
    emit(2, api9 ? [W.devPtr, 4, -5, 1, 30, 6, 10] : [W.devPtr, 4, 1, 30, 6, 10]);
    emit(3, [W.devPtr]);
    code.push(0xf4);
    mem.writeBytes(CODE, Uint8Array.from(code));
    cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF; cpu.eax = 0x12345678;
    const r = jit.run({ maxInsns: 1e6 });
    assert.equal(r, EXIT.THUNK, 'the first call left to JavaScript');
    assert.equal(cpu.exitArg, 3, 'TestCooperativeLevel: the draws were queued');
    assert.deepEqual(seen, [], 'nothing drawn yet');
    // (Vm.dispatchThunkBody: the queue runs before the call)
    const names = methods.map(([k]) => k.split('::')[1]);
    const nb = mem.read32(DEFER_QUEUE); mem.write32(DEFER_QUEUE, 0);
    for (let p = DEFER_QUEUE + 16, end = p + nb; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), words = (mem.read32(DEFER_SPEC + 4 * idx) >>> 8) & 0xff;
      W.dev[names[idx]](W.ctx(Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i))));
      p += 4 * (2 + argc + words);
    }
    assert.deepEqual(seen, [['draw', 4, 3, 2, 1, 0x142], api9 ? ['drawIndexed', 4, 1, 30, 6, 10, -5, 0, 0x152] : ['drawIndexed', 4, 1, 30, 6, 10, null, 0, 0x152]]);
    assert.equal(W.dev.draws, 2);
    assert.equal(cpu.esp, STACK - 4 - 4 * 1, 'the queued calls returned (stdcall): only the pending call\'s argument and return address on the stack');
  });
}

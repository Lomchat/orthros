// Issued-state filter of the deferred Direct3D state setters (runtime.js DEFER_F_*) and the COM AddRef/Release fast
// path (FID_ADDREF/FID_RELEASE). The filter drops a set whose value the device's shadow entry holds — the state as of
// every call issued so far, queued ones included — so it must never change what the device ends up with nor the
// sequence of state changes its handlers see: randomized call sequences (repeated values, out-of-range keys, state
// block recording, effect passes that change states behind the shadow's back, drains at random points) are run
// through the JIT and through a reference that executes every call in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { DEFER_QUEUE, DEFER_SPEC, REFS_ANY, SHADOW_BYTES, SHADOW_RS, SHADOW_TSS, SHADOW_SAMP, SHADOW_TEX, SHADOW_STREAM, SHADOW_IB, COM_MARKER, COM_REFS, FAST_STATS, COMMIT_LIST } from '../src/cpu/jit/runtime.js';
import { StateTable } from '../src/win32/state-table.js';

const CODE = 0x20000000, SLOTS = 0x10000100, DEV = 0x10004000, FX = 0x10004100, SB = 0x10005000, TEX = 0x10004200, STACK = 0x10090000, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const callSlot = (i) => [0xff, 0x15, ...le(SLOTS + 4 * i)];
const METHODS = [
  ['com.dll!IDirect3DDevice9::SetRenderState', 2], ['com.dll!IDirect3DDevice9::SetTextureStageState', 3], ['com.dll!IDirect3DDevice9::SetSamplerState', 3],
  ['com.dll!ID3DXEffect::CommitChanges', 0], ['com.dll!IDirect3DDevice9::BeginStateBlock', 0], ['com.dll!IDirect3DDevice9::EndStateBlock', 0],
  ['com.dll!IDirect3DDevice9::BeginScene', 0], ['com.dll!IDirect3DTexture9::AddRef', 0], ['com.dll!IDirect3DTexture9::Release', 0], ['com.dll!IDirect3DDevice9::SetTexture', 2],
  ['com.dll!IDirect3DDevice9::SetStreamSource', 4], ['com.dll!IDirect3DDevice9::SetIndices', 1],
];
const M = Object.fromEntries(METHODS.map(([k], i) => [k.split('::')[1] + (k.includes('Texture9::') ? '9' : ''), i]));

/** A device model: the handlers' semantics for these calls (redundant sets change nothing; recording only records). */
class Model {
  constructor(shadow) {
    this.rs = new StateTable(256, [[7, 1], [20, 5]]);
    this.tss = Array.from({ length: 8 }, () => new StateTable(40, [[1, 4]]));
    this.samp = Array.from({ length: 20 }, () => new StateTable(16, [[5, 2]]));
    this.recording = false; this.recorded = 0; this.commits = 0; this.log = [];
    this.textures = new Array(20).fill(0); this.streams = Array.from({ length: 16 }, () => [0, 0, 0]); this.ib = 0; // (the bindings, as d3d8.js / d3d9.js keep them)
    this.shadow = shadow;
    if (shadow) { for (let i = 0; i < 16; i++) this.shadowSet(SHADOW_TEX + i, 0); for (let i = 0; i < 48; i++) this.shadowSet(SHADOW_STREAM + i, 0); this.shadowSet(SHADOW_IB, 0); }
    if (shadow) {
      const { u32 } = shadow, e = (i) => SB + 16 + 8 * i;
      this.rs.attachShadow(u32, e(SHADOW_RS), 256);
      this.tss.forEach((t, i) => t.attachShadow(u32, e(SHADOW_TSS + 40 * i), 40));
      this.samp.slice(0, 16).forEach((t, i) => t.attachShadow(u32, e(SHADOW_SAMP + 16 * i), 16));
    }
  }
  shadowSet(i, v) { if (!this.shadow) return; const a = SB + 16 + 8 * i; this.shadow.mem.write32(a, 1); this.shadow.mem.write32(a + 4, v); }
  /** SetTexture (Device8.bindTexture): recorded while a state block records; a binding changed is logged */
  bind(st, t) {
    if (this.recording) { this.recorded++; return; }
    if (st >= 20) return;
    if (this.textures[st] !== t) { this.textures[st] = t; this.log.push(`tex${st}=${t}`); }
    if (st < 16) this.shadowSet(SHADOW_TEX + st, t);
  }
  set(table, key, v, what) {
    if (this.recording) { this.recorded++; return; }
    if (!table) return; // (an invalid stage: D3DERR_INVALIDCALL)
    if (table.get(key) === v) return;
    table.set(key, v); this.log.push(`${what}=${v}`);
  }
  call(m, a) {
    switch (m) {
      case M.SetRenderState: return this.set(this.rs, a[1], a[2], `rs${a[1]}`);
      case M.SetTextureStageState: return this.set(this.tss[a[1]], a[2], a[3], `tss${a[1]}.${a[2]}`);
      case M.SetSamplerState: return this.set(this.samp[a[1]], a[2], a[3], `samp${a[1]}.${a[2]}`);
      case M.CommitChanges: { const n = ++this.commits; this.set(this.rs, 7, n % 3, 'rs7'); this.set(this.tss[0], 1, n % 2, 'tss0.1'); this.set(this.samp[2], 5, n % 4, 'samp2.5'); this.bind(3, 0x5000 + n % 2); return; }
      case M.SetTexture: return this.bind(a[1], a[2]);
      case M.SetStreamSource: { // (Direct3D 9: applied even while a state block records)
        if (a[1] >= 16) return;
        const s = this.streams[a[1]];
        if (s[0] !== a[2] || s[1] !== a[3] || s[2] !== a[4]) { s[0] = a[2]; s[1] = a[3]; s[2] = a[4]; this.log.push(`stream${a[1]}=${s}`); }
        for (let i = 0; i < 3; i++) this.shadowSet(SHADOW_STREAM + 3 * a[1] + i, s[i]);
        return;
      }
      case M.SetIndices: if (this.ib !== a[1]) { this.ib = a[1]; this.log.push(`ib=${a[1]}`); } this.shadowSet(SHADOW_IB, a[1]); return;
      case M.BeginStateBlock: this.recording = true; if (this.shadow) this.shadow.mem.write32(SB, 0); return;
      case M.EndStateBlock: this.recording = false; if (this.shadow) this.shadow.mem.write32(SB, 1); return;
      case M.BeginScene: this.log.push('draw'); return;
    }
  }
  state() { return JSON.stringify([[...this.rs], this.tss.map((t) => [...t]), this.samp.map((t) => [...t]), this.textures, this.streams, this.ib]); }
}

function randomProgram(seed, n) {
  let x = seed >>> 0;
  const rnd = (k) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % k; };
  const calls = [];
  for (let i = 0; i < n; i++) {
    const r = rnd(100);
    // few keys and values: many sets repeat the current value; a few keys out of the shadow's range
    if (r < 40) calls.push([M.SetRenderState, [DEV, rnd(10) === 0 ? 256 + rnd(4) : [7, 20, 27, 137][rnd(4)], rnd(3)]]);
    else if (r < 65) calls.push([M.SetTextureStageState, [DEV, rnd(12) === 0 ? 8 : rnd(3), rnd(12) === 0 ? 40 : [1, 2, 33][rnd(3)], rnd(3)]]);
    else if (r < 88) calls.push([M.SetSamplerState, [DEV, rnd(12) === 0 ? 16 + rnd(3) : rnd(4), rnd(12) === 0 ? 16 : [5, 6][rnd(2)], rnd(4)]]);
    else if (r < 93) calls.push([M.CommitChanges, [FX]]);
    else if (r < 94) calls.push([M.SetTexture, [DEV, rnd(10) === 0 ? 16 + rnd(4) : rnd(4), [0, 0x5000, 0x5001][rnd(3)]]]);
    else if (r < 95) calls.push([M.SetStreamSource, [DEV, rnd(10) === 0 ? 16 : rnd(2), [0, 0x6000][rnd(2)], [0, 32][rnd(2)], [24, 32][rnd(2)]]]);
    else if (r < 96) calls.push([M.SetIndices, [DEV, [0, 0x7000, 0x7100][rnd(3)]]]);
    else if (r < 97) calls.push([M.BeginScene, [DEV]]);
    else if (r < 98) calls.push([M.BeginStateBlock, [DEV]]), calls.push(...Array.from({ length: 1 + rnd(4) }, () => [M.SetRenderState, [DEV, [7, 20][rnd(2)], rnd(3)]]), [M.EndStateBlock, [DEV]]);
    else calls.push([M.BeginScene, [DEV]]);
  }
  return calls;
}

function setup() {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  METHODS.forEach(([k], i) => { jit.markFast(i, k, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + i * THUNK_SIZE); });
  return { mem, cpu, jit };
}

/** Run guest code made of `calls` through the JIT; calls left to JavaScript drain the queue first, as Vm.dispatchThunk does. */
function runJit(env, calls, model, onThunk) {
  const { mem, cpu, jit } = env;
  const code = [];
  for (const [m, args] of calls) { for (let i = args.length - 1; i >= 0; i--) code.push(...push(args[i])); code.push(...callSlot(m)); }
  code.push(0xf4);
  mem.writeBytes(CODE, Uint8Array.from(code));
  jit.invalidate?.(CODE, code.length);
  cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
  const drain = () => {
    const n = mem.read32(DEFER_QUEUE);
    mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 4, 0); mem.write32(DEFER_QUEUE + 8, 0);
    for (let p = DEFER_QUEUE + 16, end = p + n; p < end;) {
      const idx = mem.read32(p), argc = mem.read32(p + 4), words = (mem.read32(DEFER_SPEC + 4 * idx) >>> 8) & 0xff;
      model.call(idx, Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i)));
      p += 4 * (2 + argc + words);
    }
  };
  let r, toJs = 0;
  for (let k = 0; k < 100000; k++) {
    r = jit.run({ maxInsns: 1e7 });
    if (r !== EXIT.THUNK) break;
    toJs++;
    drain();
    const idx = cpu.exitArg, argc = METHODS[idx][1] + 1, args = Array.from({ length: argc }, (_, i) => mem.read32(cpu.esp + 4 + 4 * i));
    const eax = onThunk ? onThunk(idx, args) : (model.call(idx, args), 0);
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 4 + 4 * argc; cpu.eax = eax >>> 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(cpu.esp, STACK, 'stdcall returns');
  drain();
  return toJs;
}

test('issued-state filter: randomized call sequences end in the same state with the same changes as executing every call', () => {
  let dropped = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const env = setup(), { mem } = env;
    mem.write32(DEV + 4, COM_MARKER); mem.write32(DEV + 12, SB); mem.write32(FX + 4, COM_MARKER); mem.write32(FX + 12, 0x10006000);
    mem.fill(SB, SHADOW_BYTES, 0); mem.write32(SB, 1);
    // odd seeds: the effect lists the states its CommitChanges sets (forgotten when it is queued); even: no list (the
    // filter waits for the queue to run)
    if (seed % 2) { const L = 0x10007800, e = [SHADOW_RS + 7, SHADOW_TSS + 1, SHADOW_SAMP + 16 * 2 + 5, SHADOW_TEX + 3]; mem.write32(L, SB); mem.write32(L + 4, e.length); e.forEach((x, i) => mem.write32(L + 8 + 4 * i, x)); mem.write32(FX + COMMIT_LIST, L); }
    const calls = randomProgram(seed, 400);
    const ref = new Model(null);
    for (const [m, a] of calls) ref.call(m, a);
    const dev = new Model({ u32: mem.u32, mem });
    const dropped0 = mem.read32(FAST_STATS);
    // (draws and state block calls go to JavaScript: the queue runs at random points of the sequence)
    runJit(env, calls, dev);
    assert.equal(dev.state(), ref.state(), `seed ${seed}: final state`);
    assert.deepEqual(dev.log, ref.log, `seed ${seed}: state changes in order`);
    assert.equal(dev.recorded, ref.recorded, `seed ${seed}: sets recorded by state blocks`);
    dropped += mem.read32(FAST_STATS) - dropped0;
  }
});

test('issued-state filter: a device without a shadow block, or another object, queues every set', () => {
  const env = setup(), { mem } = env;
  mem.write32(DEV + 4, COM_MARKER); mem.write32(DEV + 12, 0);
  const dev = new Model(null);
  const calls = Array.from({ length: 6 }, () => [M.SetRenderState, [DEV, 7, 1]]);
  const before = mem.read32(FAST_STATS);
  runJit(env, calls, dev);
  assert.equal(mem.read32(FAST_STATS), before, 'nothing dropped');
});

test('COM AddRef/Release: counted in guest memory by the fast path; the last Release and pending reference changes go to JavaScript', () => {
  const env = setup(), { mem, cpu } = env;
  mem.write32(TEX + 4, COM_MARKER); mem.write32(TEX + COM_REFS, 1);
  const results = [];
  const calls = [[M.AddRef9, [TEX]], [M.AddRef9, [TEX]], [M.Release9, [TEX]], [M.Release9, [TEX]], [M.Release9, [TEX]]];
  // record each result: the program stores EAX after every call
  const code = [];
  calls.forEach(([m, a], i) => { code.push(...push(a[0]), ...callSlot(m), 0xa3, ...le(0x10007000 + 4 * i)); });
  code.push(0xf4);
  mem.writeBytes(CODE, Uint8Array.from(code));
  cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
  const toJs = [];
  for (;;) {
    const r = env.jit.run({ maxInsns: 1e6 });
    if (r !== EXIT.THUNK) { assert.equal(r, EXIT.HALT); break; }
    toJs.push(cpu.exitArg);
    const n = mem.read32(TEX + COM_REFS) - 1; mem.write32(TEX + COM_REFS, n); if (!n) mem.write32(TEX + 4, 0); // (JavaScript: the last reference)
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 8; cpu.eax = n;
  }
  for (let i = 0; i < calls.length; i++) results.push(mem.read32(0x10007000 + 4 * i));
  assert.deepEqual(results, [2, 3, 2, 1, 0]);
  assert.deepEqual(toJs, [M.Release9], 'only the last Release left the JIT');

  // a queued SetTexture may take a reference: AddRef waits for JavaScript (which runs the queue first)
  mem.write32(TEX + 4, COM_MARKER); mem.write32(TEX + COM_REFS, 1);
  const code2 = [...push(TEX), ...push(0), ...push(DEV), ...callSlot(M.SetTexture), ...push(TEX), ...callSlot(M.AddRef9), 0xf4];
  mem.writeBytes(CODE, Uint8Array.from(code2));
  env.jit.invalidate?.(CODE, code2.length);
  mem.write32(DEV + 4, COM_MARKER);
  cpu.eip = CODE; cpu.esp = STACK;
  const r = env.jit.run({ maxInsns: 1e6 });
  assert.equal(r, EXIT.THUNK);
  assert.equal(cpu.exitArg, M.AddRef9, 'AddRef with a SetTexture queued goes to JavaScript');
  assert.equal(mem.read32(DEFER_QUEUE + 4), REFS_ANY, 'a device without its shadow block: anyone\'s count may change');
});

test('COM AddRef/Release with Direct3D 9 bindings queued: on the fast path with the counts the queue will leave; results, final counts and no count reaching 0 early, as executing every call', () => {
  const OBJS = [0x10004400, 0x10004440, 0x10004480, 0x100044c0, 0x10004500]; // (textures, a vertex buffer, an index buffer: COM objects)
  for (let seed = 1; seed <= 40; seed++) {
    const env = setup(), { mem, cpu } = env;
    mem.write32(DEV + 4, COM_MARKER); mem.write32(DEV + 12, SB); mem.fill(SB, SHADOW_BYTES, 0); mem.write32(SB, 1);
    for (const o of OBJS) { mem.write32(o + 4, COM_MARKER); mem.write32(o + COM_REFS, 3); }
    // the device as d3d9.js keeps it (bindings take and drop references; the shadow follows), and its reference twin
    const world = (refsOf, setRefs, shadow) => {
      const tex = new Array(16).fill(0), streams = Array.from({ length: 16 }, () => [0, 0, 0]); let ib = 0, commits = 0;
      const sh = (i, v) => { if (shadow) { mem.write32(SB + 16 + 8 * i, 1); mem.write32(SB + 16 + 8 * i + 4, v); } };
      if (shadow) { for (let i = 0; i < 16; i++) sh(SHADOW_TEX + i, 0); for (let i = 0; i < 48; i++) sh(SHADOW_STREAM + i, 0); sh(SHADOW_IB, 0); }
      const swap = (old, nu) => { if (old === nu) return; if (nu) setRefs(nu, refsOf(nu) + 1); if (old) setRefs(old, refsOf(old) - 1); };
      return {
        bound: () => ({ tex, streams, ib, commits }),
        call(m, a) {
          if (m === M.SetTexture) { if (a[1] >= 16) return; swap(tex[a[1]], a[2]); tex[a[1]] = a[2]; sh(SHADOW_TEX + a[1], a[2]); }
          else if (m === M.SetStreamSource) { if (a[1] >= 16) return; const s = streams[a[1]]; swap(s[0], a[2]); s[0] = a[2]; s[1] = a[3]; s[2] = a[4]; for (let i = 0; i < 3; i++) sh(SHADOW_STREAM + 3 * a[1] + i, s[i]); }
          else if (m === M.SetIndices) { swap(ib, a[1]); ib = a[1]; sh(SHADOW_IB, a[1]); }
          else if (m === M.AddRef9) { const n = refsOf(a[0]) + 1; setRefs(a[0], n); return n; }
          else if (m === M.Release9) { const n = refsOf(a[0]) - 1; setRefs(a[0], n); return n; }
          else if (m === M.BeginScene) { // (as an effect commit: textures bound behind the shadow's back, its entries forgotten — their values stale)
            commits++;
            for (let i = 0; i < 3; i++) { const t = OBJS[(i + commits) % 3]; swap(tex[i], t); tex[i] = t; if (shadow) mem.write32(SB + 16 + 8 * (SHADOW_TEX + i), 0); }
          }
          return 0;
        },
      };
    };
    const refRefs = new Map(OBJS.map((o) => [o, 3]));
    const ref = world((o) => refRefs.get(o), (o, n) => refRefs.set(o, n), false);
    // (in program order no count reaches 0 — the program never releases a last reference —, so a count reaching 0 in the
    // queued world is an object destroyed while still referenced: a fast-path Release made before queued releases)
    let lowest = Infinity;
    const dev = world((o) => mem.read32(o + COM_REFS) | 0, (o, n) => { lowest = Math.min(lowest, n); mem.write32(o + COM_REFS, n); }, true);
    let x = seed;
    const rnd = (k) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % k; };
    const calls = [], want = [];
    const keeps = (old, nu) => !old || old === nu || refRefs.get(old) >= 2; // (a binding replaced never drops a last reference)
    for (let i = 0; calls.length < 300; i++) {
      const r = rnd(100), o = OBJS[rnd(OBJS.length)], b = ref.bound();
      let call;
      if (r < 25) { const st = rnd(3), t = [0, OBJS[0], OBJS[1], OBJS[2]][rnd(4)]; if (keeps(b.tex[st], t)) call = [M.SetTexture, [DEV, st, t]]; }
      else if (r < 35) { const n = rnd(2), vb = [0, OBJS[3]][rnd(2)]; if (keeps(b.streams[n][0], vb)) call = [M.SetStreamSource, [DEV, n, vb, 0, 32]]; }
      else if (r < 42) { const x = [0, OBJS[4]][rnd(2)]; if (keeps(b.ib, x)) call = [M.SetIndices, [DEV, x]]; }
      else if (r < 66) call = [M.AddRef9, [o]];
      else if (r < 97) { if (refRefs.get(o) >= 2) call = [M.Release9, [o]]; } // (counts kept low: releases as often as the program can)
      else { // (handled in JavaScript: the queue runs; then textures bound behind the shadow — no last reference dropped on the way)
        const n = new Map(refRefs);
        const ok = [0, 1, 2].every((st) => { const old = b.tex[st], nu = OBJS[(st + b.commits + 1) % 3]; if (old === nu) return true; n.set(nu, n.get(nu) + 1); if (!old) return true; n.set(old, n.get(old) - 1); return n.get(old) >= 1; });
        if (ok) call = [M.BeginScene, [DEV]];
      }
      if (!call) continue;
      const res = ref.call(call[0], call[1]);
      if (call[0] === M.AddRef9 || call[0] === M.Release9) want.push([calls.length, res]);
      calls.push(call);
    }
    // (the program stores EAX after every AddRef / Release)
    const code = [];
    calls.forEach(([m, a], i) => { for (let k = a.length - 1; k >= 0; k--) code.push(...push(a[k])); code.push(...callSlot(m)); if (m === M.AddRef9 || m === M.Release9) code.push(0xa3, ...le(0x10008000 + 4 * i)); });
    code.push(0xf4);
    mem.writeBytes(CODE, Uint8Array.from(code)); env.jit.invalidate?.(CODE, code.length);
    cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
    const drain = () => {
      const nb = mem.read32(DEFER_QUEUE); mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 4, 0); mem.write32(DEFER_QUEUE + 8, 0);
      for (let p = DEFER_QUEUE + 16, end = p + nb; p < end;) { const idx = mem.read32(p), argc = mem.read32(p + 4); dev.call(idx, Array.from({ length: argc }, (_, i) => mem.read32(p + 8 + 4 * i))); p += 4 * (2 + argc); }
    };
    let fastRefs = 0, jsRefs = 0;
    for (;;) {
      const r = env.jit.run({ maxInsns: 1e7 });
      if (r !== EXIT.THUNK) { assert.equal(r, EXIT.HALT); break; }
      drain();
      const idx = cpu.exitArg, argc = METHODS[idx][1] + 1, args = Array.from({ length: argc }, (_, i) => mem.read32(cpu.esp + 4 + 4 * i));
      if (idx === M.AddRef9 || idx === M.Release9) jsRefs++;
      const eax = dev.call(idx, args) ?? 0;
      cpu.eip = mem.read32(cpu.esp); cpu.esp += 4 + 4 * argc; cpu.eax = eax >>> 0;
    }
    drain();
    for (const [i, r] of want) assert.equal(mem.read32(0x10008000 + 4 * i) | 0, r, `seed ${seed}: call ${i} returns`);
    for (const o of OBJS) assert.equal(mem.read32(o + COM_REFS) | 0, refRefs.get(o), `seed ${seed}: count of ${o.toString(16)}`);
    assert.ok(lowest >= 1, `seed ${seed}: a count reached ${lowest} while references remained`);
    fastRefs += want.length - jsRefs;
    assert.ok(fastRefs > 0);
  }
});

test('issued-state filter: an effect commit list that misses a state it sets is caught by the randomized comparison', () => {
  // (the test's sensitivity: CommitChanges sets samp2.5, the list forgets only rs7 and tss0.1)
  let mismatches = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const env = setup(), { mem } = env;
    mem.write32(DEV + 4, COM_MARKER); mem.write32(DEV + 12, SB); mem.write32(FX + 4, COM_MARKER); mem.write32(FX + 12, 0x10006000);
    mem.fill(SB, SHADOW_BYTES, 0); mem.write32(SB, 1);
    const L = 0x10007800, e = [SHADOW_RS + 7, SHADOW_TSS + 1]; mem.write32(L, SB); mem.write32(L + 4, e.length); e.forEach((x, i) => mem.write32(L + 8 + 4 * i, x)); mem.write32(FX + COMMIT_LIST, L);
    const calls = randomProgram(seed, 400);
    const ref = new Model(null); for (const [m, a] of calls) ref.call(m, a);
    const dev = new Model({ u32: mem.u32, mem });
    runJit(env, calls, dev);
    if (dev.state() !== ref.state() || JSON.stringify(dev.log) !== JSON.stringify(ref.log)) mismatches++;
  }
  assert.ok(mismatches > 0, 'an incomplete list makes the filter drop sets it must not');
});

test('measurement switch: AddRef/Release back to JavaScript and the filter off, then on once the queue is empty', async () => {
  const env = setup(), { mem, cpu } = env;
  mem.write32(TEX + 4, COM_MARKER); mem.write32(TEX + COM_REFS, 1);
  const runAddRef = () => {
    const code = [...push(TEX), ...callSlot(M.AddRef9), 0xf4];
    mem.writeBytes(CODE, Uint8Array.from(code)); env.jit.invalidate?.(CODE, code.length);
    cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF;
    return env.jit.run({ maxInsns: 1e6 });
  };
  env.jit.setRefFast(false);
  assert.equal(runAddRef(), EXIT.THUNK, 'switched off: AddRef handled in JavaScript');
  env.jit.setRefFast(true);
  assert.equal(runAddRef(), EXIT.HALT, 'switched on: the fast path again');
  assert.equal(mem.read32(TEX + COM_REFS), 2);

  // Vm.setApiFastPaths: the devices' filter flag follows; switched on while calls are queued, it waits for the drain
  const { Vm } = await import('../src/core/vm.js');
  const flags = [];
  const fakeVm = { jit: env.jit, mem, d3dDevices: new Set([{ shadowOn() { flags.push(fakeVm.stateFilterOff ? 0 : 1); } }]) };
  Vm.prototype.setApiFastPaths.call(fakeVm, false);
  assert.deepEqual(flags, [0]);
  mem.write32(DEFER_QUEUE, 8);
  Vm.prototype.setApiFastPaths.call(fakeVm, true);
  assert.deepEqual(flags, [0], 'not while the queue holds calls');
  assert.equal(fakeVm.shadowResync, true);
  mem.write32(DEFER_QUEUE, 0);
  Vm.prototype.setApiFastPaths.call(fakeVm, true);
  assert.deepEqual(flags, [0, 1]);
});

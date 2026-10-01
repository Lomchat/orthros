// D3DX effect commit list (d3dx9-effect.js commitEntries, runtime.js COMMIT_LIST): a queued CommitChanges makes the
// JIT's issued-state filter forget only the shadow entries the list names, so every render / stage / sampler state a
// CommitChanges can set must be on it — else a later redundant-looking set would be dropped while the device holds the
// value the commit wrote. An effect whose pass sets such states from a parameter in every way an effect can (a render
// state, a stage state, a sampler state, a sampler parameter bound to a register whose states read the parameter, a
// pixel shader whose sampler is that parameter) is committed with the parameter changing; every state set by the
// commits must be listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { STATES, PT, PC } from '../src/win32/d3dx9-fxparse.js';
import { defineEffects } from '../src/win32/d3dx9-effect.js';
import { StateTable } from '../src/win32/state-table.js';
import { COMMIT_LIST, SHADOW_RS, SHADOW_TSS, SHADOW_SAMP } from '../src/cpu/jit/runtime.js';

const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
class Words {
  constructor() { this.w = []; }
  get off() { return this.w.length * 4; }
  u32(...v) { const o = this.off; for (const x of v) this.w.push(x >>> 0); return o; }
  bytes(b) { const o = this.off; const p = new Uint8Array((b.length + 3) & ~3); p.set(b); const dv = new DataView(p.buffer); for (let i = 0; i < p.length; i += 4) this.w.push(dv.getUint32(i, true)); return o; }
  toBytes() { return new Uint8Array(Uint32Array.from(this.w).buffer); }
}
const cstr = (s) => new TextEncoder().encode(s + '\0');
const op = (cls, idx) => { const i = STATES.findIndex(([c, x]) => c === cls && (idx === undefined || x === idx)); assert.ok(i >= 0, `${cls} ${idx}`); return i; };

/** ps_2_0 with a constant table naming sampler S in s4 */
function pixelShader() {
  const ct = new Words();
  ct.u32(28, 0, 0xffff0200, 1, 28, 0, 0);
  const info = ct.off; ct.u32(0, 0, 0, 0, 0);
  const name = ct.bytes(cstr('S'));
  const type = ct.u32(PC.OBJECT | (PT.SAMPLER2D << 16), 1 | (1 << 16), 1, 0);
  ct.w.splice(info / 4, 5, name, 3 | (4 << 16), 1, type, 0); // set SAMPLER, register 4, count 1
  const block = new Words(); block.u32(FOURCC('CTAB')); block.bytes(ct.toBytes());
  const w = new Words();
  w.u32(0xffff0200, 0xfffe | (block.w.length << 16)); w.w.push(...block.w);
  w.u32(0x0000ffff);
  return w.toBytes();
}

/**
 * fx_2_0: R (int), S (sampler2D: AddressU = R, MinFilter = 2); technique T, pass P: ZEnable = R, ColorOp[1] = R,
 * AddressV[3] = R, Sampler[2] = S, PixelShader = the shader above, CullMode = 1 (constant: not re-applied at commit)
 */
function effectBinary() {
  const pool = new Words();
  pool.u32(0);
  const str = (s) => { const b = cstr(s); const o = pool.u32(b.length); pool.bytes(b); return o; };
  const intType = pool.u32(PT.INT, PC.SCALAR, str(''), 0, 0, 1, 1);
  const val = (v) => pool.u32(v);
  const rType = pool.u32(PT.INT, PC.SCALAR, str('R'), 0, 0, 1, 1), rValue = pool.u32(1);
  const sType = pool.u32(PT.SAMPLER2D, PC.OBJECT, str('S'), 0, 0);
  const sValue = pool.u32(2, op('samp', 1), 0, intType, val(0), op('samp', 6), 0, intType, val(2));
  const anySampler = pool.u32(PT.SAMPLER2D, PC.OBJECT, str(''), 0, 0), noStates = pool.u32(0);
  const psType = pool.u32(PT.PIXELSHADER, PC.OBJECT, str(''), 0, 0), psValue = pool.u32(1);
  const tName = str('T'), pName = str('P');
  const states = [
    [op('rs', 7), 0, intType, val(0)],
    [op('tss', 1), 1, intType, val(0)],
    [op('samp', 2), 3, intType, val(0)],
    [op('sampler'), 2, anySampler, noStates],
    [op('ps'), 0, psType, psValue],
    [op('rs', 22), 0, intType, val(1)],
  ];
  const tables = pool.off;
  const t = new Words();
  t.u32(2, 1, 0, 2);
  t.u32(rType, rValue, 0, 0);
  t.u32(sType, sValue, 0, 0);
  t.u32(tName, 0, 1);
  t.u32(pName, 0, states.length);
  for (const s of states) t.u32(...s);
  const ps = pixelShader();
  const refs = [[0, 0, 0, 0, 'R'], [0, 0, 0, 1, 'R'], [0, 0, 0, 2, 'R'], [0, 0, 0, 3, 'S'], [0xffffffff, 1, 0, 0, 'R']];
  t.u32(0, refs.length + 1);
  t.u32(0, 0, 0, 4, 0, ps.length); t.bytes(ps);
  for (const [tq, i, e, s, name] of refs) { const b = cstr(name); t.u32(tq, i, e, s, 1, b.length); t.bytes(b); }
  const head = new Words(); head.u32(0xfeff0901, tables);
  const out = new Uint8Array(8 + pool.off + t.off);
  out.set(head.toBytes(), 0); out.set(pool.toBytes(), 8); out.set(t.toBytes(), 8 + pool.off);
  return out;
}

function setup() {
  const mem = new GuestMemory();
  let brk = 0x10000000;
  const heap = { alloc: (n) => { const a = brk; brk += (n + 15) & ~15; return a; }, free_() {} };
  const proc = { processHeap: heap };
  const objects = new Map();
  const com = {
    interface() {},
    create(p, iface, impl) { const ptr = heap.alloc(24); objects.set(ptr, { ptr, impl, refs: 1 }); impl.comObject = objects.get(ptr); return ptr; },
    objectAt: (p) => objects.get(p >>> 0) ?? null,
    implAt: (p) => objects.get(p >>> 0)?.impl ?? null,
    addRef: (o) => ++o.refs, release: (o) => --o.refs,
  };
  const log = [];
  const dev = {
    shadow: 0x12340000,
    vsConst: new Float32Array(1024), psConst: new Float32Array(1024), vsConstI: new Int32Array(64), psConstI: new Int32Array(64), vsConstB: new Int32Array(16), psConstB: new Int32Array(16),
    constVersion: 0, textures: [],
    rs: new StateTable(256), tss: Array.from({ length: 8 }, () => new StateTable(40)), samplers: Array.from({ length: 20 }, () => new StateTable(16)),
    SetRenderState(c) { const s = c.arg(1), v = c.arg(2); if (this.rs.get(s) !== v) { this.rs.set(s, v); log.push(SHADOW_RS + s); } },
    SetTextureStageState(c) { const st = c.arg(1), ty = c.arg(2), v = c.arg(3); if (this.tss[st].get(ty) !== v) { this.tss[st].set(ty, v); log.push(SHADOW_TSS + 40 * st + ty); } },
    SetSamplerState(c) { const s = c.arg(1), ty = c.arg(2), v = c.arg(3); if (this.samplers[s].get(ty) !== v) { this.samplers[s].set(ty, v); if (s < 16 && ty < 16) log.push(SHADOW_SAMP + 16 * s + ty); } },
    SetTexture(c) { this.textures[c.arg(1)] = c.arg(2); }, SetPixelShader() {}, SetVertexShader() {},
  };
  const devPtr = com.create(proc, 'IDirect3DDevice9', dev);
  const vm = { mem, com, log() {}, effectCtx: null, callGuest() { return 0; } };
  const h = { callMethod(ctx, self, name, [, out]) { mem.write32(out, 0x7000); return 0; }, textBuffer: () => 0 };
  const X = {};
  defineEffects(X, vm, h);
  const ctx = (...a) => ({ proc, thread: null, a, arg(i) { return (this.a[i] ?? 0) >>> 0; }, sarg(i) { return (this.a[i] ?? 0) | 0; } });
  const fxBytes = effectBinary(), src = heap.alloc(fxBytes.length), out = heap.alloc(4);
  mem.writeBytes(src, fxBytes);
  assert.equal(X.D3DXCreateEffect[1](ctx(devPtr, src, fxBytes.length, 0, 0, 0, 0, out, 0)), 0);
  const fxPtr = mem.read32(out), fx = com.implAt(fxPtr);
  const name = (s) => { const p = heap.alloc(s.length + 1); mem.writeCString(p, s); return p; };
  return { mem, dev, fx, fxPtr, ctx, name, log };
}

test('effect commit list: every render, stage and sampler state CommitChanges sets is listed', () => {
  const { mem, fx, fxPtr, ctx, name, log } = setup();
  const R = name('R');
  assert.equal(fx.Begin(ctx(fxPtr, 0, 0)), 0);
  fx.BeginPass(ctx(fxPtr, 0));
  const list = mem.read32(fxPtr + COMMIT_LIST);
  assert.equal(mem.read32(list), 0x12340000, 'the device shadow');
  const n = mem.read32(list + 4);
  assert.notEqual(n, 0xffffffff, 'a list, not "any state"');
  const listed = new Set(Array.from({ length: n }, (_, i) => mem.read32(list + 8 + 4 * i)));
  const seen = new Set();
  for (const v of [5, 6, 7, 3, 9]) {
    fx.SetInt(ctx(fxPtr, R, v));
    log.length = 0;
    fx.CommitChanges(ctx(fxPtr));
    assert.ok(log.length > 0, 'the commit changed states');
    for (const e of log) { seen.add(e); assert.ok(listed.has(e), `state entry ${e} set by CommitChanges but not on the commit list [${[...listed]}]`); }
  }
  // the ways covered: ZEnable, ColorOp[1], AddressV[3], AddressU of sampler 2 (Sampler[2] = S) and of s4 (the shader's)
  for (const e of [SHADOW_RS + 7, SHADOW_TSS + 40 + 1, SHADOW_SAMP + 16 * 3 + 2, SHADOW_SAMP + 16 * 2 + 1, SHADOW_SAMP + 16 * 4 + 1]) assert.ok(seen.has(e), `entry ${e} exercised`);
  assert.ok(!listed.has(SHADOW_RS + 22), 'a constant state (not re-applied by CommitChanges) is not listed');
  fx.EndPass(ctx(fxPtr)); fx.End(ctx(fxPtr));
});

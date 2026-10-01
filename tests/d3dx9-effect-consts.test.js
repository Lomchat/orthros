// D3DX effect shader constants: a pass binding a vertex shader loads the constants its constant table names from the
// effect's parameters. The values are converted again only when the parameter changed (d3dx9-effect.js bindShader:
// the version of the top-level parameter), so every way of changing a parameter must reach the device at the next
// CommitChanges: the whole array (SetVectorArray, SetValue), one element (SetVector on "A[1]", by name or handle),
// a parameter block; and a device constant changed by someone else is restored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { STATES, PT, PC } from '../src/win32/d3dx9-fxparse.js';
import { defineEffects } from '../src/win32/d3dx9-effect.js';

const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
class Words {
  constructor() { this.w = []; }
  get off() { return this.w.length * 4; }
  u32(...v) { const o = this.off; for (const x of v) this.w.push(x >>> 0); return o; }
  bytes(b) { const o = this.off; const p = new Uint8Array((b.length + 3) & ~3); p.set(b); const dv = new DataView(p.buffer); for (let i = 0; i < p.length; i += 4) this.w.push(dv.getUint32(i, true)); return o; }
  toBytes() { return new Uint8Array(Uint32Array.from(this.w).buffer); }
}
const cstr = (s) => new TextEncoder().encode(s + '\0');

/** vs_2_0 with a constant table: A (float4[2]) in c0..c1, B (float4) in c4 */
function vertexShader() {
  const ct = new Words();
  ct.u32(28, 0, 0xfffe0200, 2, 28, 0, 0); // header: size, creator, version, 2 constants at 28, flags, target
  const infoAt = ct.off; ct.u32(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // (two constant infos, patched below)
  const nameA = ct.bytes(cstr('A')), nameB = ct.bytes(cstr('B'));
  const typeA = ct.u32(PC.VECTOR | (PT.FLOAT << 16), 1 | (4 << 16), 2, 0); // vector float, 1 x 4, 2 elements
  const typeB = ct.u32(PC.VECTOR | (PT.FLOAT << 16), 1 | (4 << 16), 1, 0);
  const i0 = infoAt / 4, i1 = i0 + 5;
  ct.w.splice(i0, 5, nameA, 2 | (0 << 16), 2, typeA, 0); // name, set FLOAT4 | reg 0 << 16, count 2, type, no default
  ct.w.splice(i1, 5, nameB, 2 | (4 << 16), 1, typeB, 0);
  const block = new Words(); block.u32(FOURCC('CTAB')); block.bytes(ct.toBytes());
  const w = new Words();
  w.u32(0xfffe0200, 0xfffe | (block.w.length << 16)); w.w.push(...block.w);
  w.u32(0x0000ffff);
  return w.toBytes();
}

/** fx_2_0: parameters A (float4[2]) and B (float4), technique T, pass P: VertexShader = the shader above */
function effectBinary() {
  const pool = new Words();
  pool.u32(0);
  const str = (s) => { const b = cstr(s); const o = pool.u32(b.length); pool.bytes(b); return o; };
  const aType = pool.u32(PT.FLOAT, PC.VECTOR, str('A'), 0, 2, 4, 1), aValue = pool.u32(...Array(8).fill(0));
  const bType = pool.u32(PT.FLOAT, PC.VECTOR, str('B'), 0, 0, 4, 1), bValue = pool.u32(0, 0, 0, 0);
  const vsType = pool.u32(PT.VERTEXSHADER, PC.OBJECT, str(''), 0, 0), vsValue = pool.u32(1);
  const tName = str('T'), pName = str('P');
  const vsOp = STATES.findIndex(([cls]) => cls === 'vs');
  const tables = pool.off;
  const t = new Words();
  t.u32(2, 1, 0, 2); // 2 parameters, 1 technique, objects
  t.u32(aType, aValue, 0, 0);
  t.u32(bType, bValue, 0, 0);
  t.u32(tName, 0, 1); // technique: name, no annotation, 1 pass
  t.u32(pName, 0, 1); // pass: name, no annotation, 1 state
  t.u32(vsOp, 0, vsType, vsValue);
  t.u32(0, 1); // no string, 1 resource
  const vs = vertexShader();
  t.u32(0, 0, 0, 0, 0, vs.length); t.bytes(vs); // technique 0, pass 0, element 0, state 0, usage 0: the shader
  const head = new Words(); head.u32(0xfeff0901, tables);
  const out = new Uint8Array(8 + pool.off + t.off);
  out.set(head.toBytes(), 0); out.set(pool.toBytes(), 8); out.set(t.toBytes(), 8 + pool.off);
  return out;
}

/** a minimal VM around defineEffects: guest memory, a bump heap, COM objects in a map, a device keeping constants */
function setup() {
  const mem = new GuestMemory();
  let brk = 0x10000000;
  const heap = { alloc: (n) => { const a = brk; brk += (n + 15) & ~15; return a; }, free_() {} };
  const proc = { processHeap: heap };
  const objects = new Map();
  const com = {
    interface() {},
    create(p, iface, impl) { const ptr = heap.alloc(16); objects.set(ptr, { ptr, impl, refs: 1 }); impl.comObject = objects.get(ptr); return ptr; },
    objectAt: (p) => objects.get(p >>> 0) ?? null,
    implAt: (p) => objects.get(p >>> 0)?.impl ?? null,
    addRef: (o) => ++o.refs, release: (o) => --o.refs,
  };
  const dev = {
    vsConst: new Float32Array(1024), psConst: new Float32Array(1024), vsConstI: new Int32Array(64), psConstI: new Int32Array(64), vsConstB: new Int32Array(16), psConstB: new Int32Array(16),
    constVersion: 0, textures: [], vs: 0,
    SetVertexShader(c) { this.vs = c.arg(1); }, SetPixelShader() {},
  };
  const devPtr = com.create(proc, 'IDirect3DDevice9', dev);
  const vm = { mem, com, log() {}, effectCtx: null };
  const h = {
    callMethod(ctx, self, name, [, out]) { mem.write32(out, 0x7000); return 0; }, // (CreateVertexShader: a shader pointer)
    textBuffer: () => 0,
  };
  const X = {};
  defineEffects(X, vm, h);
  const ctx = (...a) => ({ proc, thread: null, a, arg(i) { return (this.a[i] ?? 0) >>> 0; }, sarg(i) { return (this.a[i] ?? 0) | 0; }, argF32(i) { const f = new Float32Array(1); new Uint32Array(f.buffer)[0] = this.a[i] ?? 0; return f[0]; } });
  const fxBytes = effectBinary(), src = heap.alloc(fxBytes.length), out = heap.alloc(4);
  mem.writeBytes(src, fxBytes);
  assert.equal(X.D3DXCreateEffect[1](ctx(devPtr, src, fxBytes.length, 0, 0, 0, 0, out, 0)), 0);
  const fxPtr = mem.read32(out), fx = com.implAt(fxPtr);
  const name = (s) => { const p = heap.alloc(s.length + 1); mem.writeCString(p, s); return p; };
  const vec = (...v) => { const p = heap.alloc(16 * Math.ceil(v.length / 4)); v.forEach((x, i) => mem.writeF32(p + 4 * i, x)); return p; };
  return { mem, dev, fx, fxPtr, ctx, name, vec };
}

test('effect constants: every change of a parameter reaches the device at CommitChanges, and only then', () => {
  const { dev, fx, fxPtr, ctx, name, vec } = setup();
  const c = (i) => Array.from(dev.vsConst.subarray(4 * i, 4 * i + 4));
  const A = name('A'), A1 = name('A[1]'), B = name('B');
  fx.SetVectorArray(ctx(fxPtr, A, vec(1, 2, 3, 4, 5, 6, 7, 8), 2));
  fx.SetVector(ctx(fxPtr, B, vec(9, 10, 11, 12)));
  assert.equal(fx.Begin(ctx(fxPtr, 0, 0)), 0);
  fx.BeginPass(ctx(fxPtr, 0));
  assert.equal(dev.vs, 0x7000, 'the pass sets its vertex shader');
  assert.deepEqual([c(0), c(1), c(4)], [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);

  // one element, by name: the array's binding is converted again
  fx.SetVector(ctx(fxPtr, A1, vec(-1, -2, -3, -4)));
  assert.deepEqual(c(1), [5, 6, 7, 8], 'nothing reaches the device before CommitChanges');
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(0), c(1), c(4)], [[1, 2, 3, 4], [-1, -2, -3, -4], [9, 10, 11, 12]]);

  // one element, by handle
  const h1 = fx.GetParameterElement(ctx(fxPtr, fx.GetParameterByName(ctx(fxPtr, 0, A)), 0));
  fx.SetVector(ctx(fxPtr, h1, vec(0.5, 0.25, 0.125, 2)));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(0), [0.5, 0.25, 0.125, 2]);

  // the whole array as raw bytes
  const raw = vec(11, 12, 13, 14, 15, 16, 17, 18);
  fx.SetValue(ctx(fxPtr, A, raw, 32));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(0), c(1)], [[11, 12, 13, 14], [15, 16, 17, 18]]);

  // a device constant overwritten by someone else (another effect, SetVertexShaderConstantF) is set again
  dev.vsConst[5] = 99; dev.vsConst[16] = 98; dev.constVersion++; // (as SetVertexShaderConstantF does)
  const v0 = dev.constVersion;
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(1), c(4)], [[15, 16, 17, 18], [9, 10, 11, 12]]);
  assert.ok(dev.constVersion > v0, 'a restored constant moves the device version');

  // nothing changed: no constant version move
  const v1 = dev.constVersion;
  fx.CommitChanges(ctx(fxPtr));
  assert.equal(dev.constVersion, v1);

  // a parameter block recorded, the parameter changed, the block applied again
  fx.BeginParameterBlock(ctx(fxPtr));
  fx.SetVector(ctx(fxPtr, B, vec(1, 1, 1, 1)));
  const block = fx.EndParameterBlock(ctx(fxPtr));
  fx.SetVector(ctx(fxPtr, B, vec(2, 2, 2, 2)));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [2, 2, 2, 2]);
  fx.ApplyParameterBlock(ctx(fxPtr, block));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [1, 1, 1, 1]);

  // SetFloatArray over the array's words
  fx.SetFloatArray(ctx(fxPtr, A, vec(21, 22, 23, 24, 25, 26, 27, 28), 8));
  fx.EndPass(ctx(fxPtr));
  fx.BeginPass(ctx(fxPtr, 0));
  assert.deepEqual([c(0), c(1)], [[21, 22, 23, 24], [25, 26, 27, 28]]);
  fx.End(ctx(fxPtr));
});

test('effect state manager: the calls the JIT queues go to JavaScript while one is set', () => {
  const { mem, fx, fxPtr, ctx } = setup();
  const block = mem.read32(fxPtr + 12);
  assert.ok(block !== 0, 'the handle block at +12');
  fx.SetStateManager(ctx(fxPtr, 0x12340000));
  assert.equal(mem.read32(fxPtr + 12), 0, 'cleared: nothing queued (runtime.js DEFER_OBJ / DEFER_HANDLE)');
  fx.SetStateManager(ctx(fxPtr, 0));
  assert.equal(mem.read32(fxPtr + 12), block, 'restored');
});

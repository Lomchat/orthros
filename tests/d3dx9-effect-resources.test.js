// D3DX effect resources: compiled code attached to a pass state is a shader, or (version token 'FX') an expression
// computing the state's value from parameters. A synthetic fx_2_0 binary with one float parameter F and one pass whose
// AlphaTestEnable = (F >= 0.5) is parsed, its resources classified, and the expression evaluated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEffect, STATES, PT, PC } from '../src/win32/d3dx9-fxparse.js';
import { effectResources } from '../src/win32/d3dx9-effect.js';
import { compilePreshader } from '../src/win32/d3dx9-preshader.js';

const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
class Words {
  constructor() { this.w = []; }
  get off() { return this.w.length * 4; }
  u32(...v) { const o = this.off; for (const x of v) this.w.push(x >>> 0); return o; }
  bytes(b) { const o = this.off; const p = new Uint8Array((b.length + 3) & ~3); p.set(b); const dv = new DataView(p.buffer); for (let i = 0; i < p.length; i += 4) this.w.push(dv.getUint32(i, true)); return o; }
  f64(v) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v, true); return this.u32(dv.getUint32(0, true), dv.getUint32(4, true)); }
  toBytes() { return new Uint8Array(Uint32Array.from(this.w).buffer); }
}
const cstr = (s) => new TextEncoder().encode(s + '\0');

/** 'FX' expression: out.x = (input F >= 0.5) — literals, one instruction, the input table */
function expression() {
  const ctab = new Words();
  ctab.u32(28, 0, 0, 1, 28, 0, 0); // header: size, creator, version, 1 constant at 28, flags, target
  ctab.u32(48, (0 << 16) | 2, (0 << 16) | 1, 56, 0); // name at 48, set FLOAT4 (2), reg 0, count 1, type at 56, no default
  ctab.bytes(cstr('F')); ctab.u32(0); // (the type at 56)
  ctab.u32(0 | (3 << 16), 1 | (1 << 16), 0, 0); // class scalar, type float, rows 1, cols 1, 0 elements / members
  const ct = ctab.toBytes();
  const w = new Words();
  w.u32(0x46580101);
  const lit = new Words(); lit.u32(FOURCC('CLIT'), 1); lit.f64(0.5);
  w.u32(0xfffe | ((lit.w.length) << 16)); w.w.push(...lit.w);
  const fxlc = new Words(); fxlc.u32(FOURCC('FXLC'), 1, (0x2030 << 16) | 1, 2, 0, 2, 0, 0, 1, 0, 0, 4, 0);
  w.u32(0xfffe | ((fxlc.w.length) << 16)); w.w.push(...fxlc.w);
  const ctabBlock = new Words(); ctabBlock.u32(FOURCC('CTAB')); ctabBlock.bytes(ct);
  w.u32(0xfffe | ((ctabBlock.w.length) << 16)); w.w.push(...ctabBlock.w);
  w.u32(0x0000ffff);
  return w.toBytes();
}

function effectBinary() {
  const pool = new Words();
  pool.u32(0); // (offset 0: the empty string)
  const str = (s) => { const b = cstr(s); const o = pool.u32(b.length); pool.bytes(b); return o; };
  const scalar = (type, name) => pool.u32(type, PC.SCALAR, str(name), 0, 0, 1, 1);
  const fType = scalar(PT.FLOAT, 'F'), fValue = pool.u32(0);
  const bType = scalar(PT.BOOL, ''), bValue = pool.u32(0);
  const psType = pool.u32(PT.PIXELSHADER, PC.OBJECT, str(''), 0, 0), psValue = pool.u32(1);
  const tName = str('T'), pName = str('P');
  const alphaTest = STATES.findIndex(([cls, i]) => cls === 'rs' && i === 15), psOp = STATES.findIndex(([cls]) => cls === 'ps');
  const tables = pool.off;
  const t = new Words();
  t.u32(1, 1, 0, 2); // 1 parameter, 1 technique, objects
  t.u32(fType, fValue, 0, 0);
  t.u32(tName, 0, 1); // technique: name, no annotation, 1 pass
  t.u32(pName, 0, 2); // pass: name, no annotation, 2 states
  t.u32(alphaTest, 0, bType, bValue);
  t.u32(psOp, 0, psType, psValue);
  t.u32(0, 2); // no string, 2 resources
  const ex = expression();
  t.u32(0, 0, 0, 0, 0, ex.length); t.bytes(ex); // technique 0, pass 0, element 0, state 0, usage 0
  const ps = Uint8Array.from([0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]); // ps_2_0, end
  t.u32(0, 0, 0, 1, 0, ps.length); t.bytes(ps);
  const head = new Words(); head.u32(0xfeff0901, tables);
  const out = new Uint8Array(8 + pool.off + t.off);
  out.set(head.toBytes(), 0); out.set(pool.toBytes(), 8); out.set(t.toBytes(), 8 + pool.off);
  return out;
}

test('an FX expression on a render state is an expression, a shader stays a shader', () => {
  const fx = parseEffect(effectBinary());
  assert.equal(fx.techniques[0].passes[0].states.length, 2);
  const { shaders, exprs, refs } = effectResources(fx);
  assert.equal(refs.size, 0);
  assert.ok(shaders.has('0:0:1'), 'the pixel shader');
  assert.ok(!shaders.has('0:0:0'));
  const ex = exprs.get('0:0:0');
  assert.ok(ex && ex.name === null, 'the state expression');
  assert.deepEqual(ex.prog.inputs.map((i) => [i.name, i.set, i.reg, i.count]), [['F', 2, 0, 1]]);
  const run = compilePreshader(ex.prog, 4), out = new Float32Array(1024);
  run(Float64Array.of(1, 0, 0, 0), out); assert.equal(out[0], 1);
  run(Float64Array.of(0.25, 0, 0, 0), out); assert.equal(out[0], 0);
});

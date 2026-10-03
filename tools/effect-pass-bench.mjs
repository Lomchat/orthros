// Cost of D3DX effect passes on the emulator thread: an fx_2_0 effect shaped like a game's — a vertex shader with a
// matrix and two vectors from parameters, a pixel shader sampling a sampler parameter (texture and filter states) with
// a color constant, nine render states one of which reads a parameter — driven per object as games do (parameters set,
// Begin, BeginPass, three draws each after new parameters and CommitChanges, EndPass, End) on a Direct3D 9 device whose
// work is recorded for the render worker ("recorder", what ?glworker=1 leaves on the emulator thread) or dropped
// ("none"). Prints µs per pass; with ORTHROS_BENCH_PROFILE unset the variants alternate.
// Usage: node tools/effect-pass-bench.mjs [passes per frame (100)] [frames (200)] [none | recorder]
import { d3dEnv } from '../tests/d3d-random.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { defineEffects } from '../src/win32/d3dx9-effect.js';
import { STATES, PT, PC } from '../src/win32/d3dx9-fxparse.js';

const PASSES = Number(process.argv[2] ?? 100), FRAMES = Number(process.argv[3] ?? 200), only = process.argv[4] ?? null;
const ROUNDS = Number(process.env.ROUNDS ?? 5);

class Words {
  constructor() { this.w = []; }
  get off() { return this.w.length * 4; }
  u32(...v) { const o = this.off; for (const x of v) this.w.push(x >>> 0); return o; }
  bytes(b) { const o = this.off; const p = new Uint8Array((b.length + 3) & ~3); p.set(b); const dv = new DataView(p.buffer); for (let i = 0; i < p.length; i += 4) this.w.push(dv.getUint32(i, true)); return o; }
  toBytes() { return new Uint8Array(Uint32Array.from(this.w).buffer); }
}
const cstr = (s) => new TextEncoder().encode(s + '\0');
const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
const op = (cls, idx) => STATES.findIndex(([c, x]) => c === cls && (idx === undefined || x === idx));

/** shader bytecode: version, a CTAB comment for `consts` ([name, set, reg, count, class, type, rows, cols]), then `body` */
function shader(version, consts, body) {
  const ct = new Words();
  ct.u32(28, 0, version, consts.length, 28, 0, 0);
  const infoAt = ct.off / 4; for (let i = 0; i < consts.length; i++) ct.u32(0, 0, 0, 0, 0);
  consts.forEach(([name, set, reg, count, cls, type, rows, cols], i) => {
    const n = ct.bytes(cstr(name)), t = ct.u32(cls | (type << 16), rows | (cols << 16), 1, 0);
    ct.w.splice(infoAt + 5 * i, 5, n, set | (reg << 16), count, t, 0);
  });
  const block = new Words(); block.u32(FOURCC('CTAB')); block.bytes(ct.toBytes());
  const w = new Words(); w.u32(version, 0xfffe | (block.w.length << 16)); w.w.push(...block.w); w.w.push(...body); return w.toBytes();
}
// vs_2_0: m4x4 oPos, v0, c0; mov oT0, v1 — ps_2_0: texld r0, t0, s0; mul r0, r0, c0; mov oC0, r0
const VS_BODY = [0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff];
const PS_BODY = [0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800, 0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x03000005, 0x800f0000, 0x80e40000, 0xa0e40000, 0x02000001, 0x800f0800, 0x80e40000, 0xffff];

/** fx_2_0: WVP (float4x4), LightDir, Diffuse (float4), Tex (texture), Samp (sampler2D: Tex, filters, addressing), AlphaRef (int); technique T, pass P */
function effectBinary() {
  const pool = new Words(); pool.u32(0);
  const str = (s) => { const b = cstr(s); const o = pool.u32(b.length); pool.bytes(b); return o; };
  const intType = pool.u32(PT.INT, PC.SCALAR, str(''), 0, 0, 1, 1), val = (v) => pool.u32(v);
  const wvpType = pool.u32(PT.FLOAT, PC.MATRIX_COLUMNS, str('WVP'), 0, 0, 4, 4), wvpValue = pool.u32(...Array(16).fill(0));
  const ldType = pool.u32(PT.FLOAT, PC.VECTOR, str('LightDir'), 0, 0, 4, 1), ldValue = pool.u32(0, 0, 0, 0);
  const dfType = pool.u32(PT.FLOAT, PC.VECTOR, str('Diffuse'), 0, 0, 4, 1), dfValue = pool.u32(0, 0, 0, 0);
  const txType = pool.u32(PT.TEXTURE, PC.OBJECT, str('Tex'), 0, 0), txValue = pool.u32(3);
  const smType = pool.u32(PT.SAMPLER2D, PC.OBJECT, str('Samp'), 0, 0);
  const smValue = pool.u32(6, op('texture'), 0, txType, val(3), op('samp', 6), 0, intType, val(2), op('samp', 5), 0, intType, val(2), op('samp', 7), 0, intType, val(2), op('samp', 1), 0, intType, val(1), op('samp', 2), 0, intType, val(1));
  const arType = pool.u32(PT.INT, PC.SCALAR, str('AlphaRef'), 0, 0, 1, 1), arValue = pool.u32(96);
  const anySampler = pool.u32(PT.SAMPLER2D, PC.OBJECT, str(''), 0, 0), noStates = pool.u32(0);
  const vsType = pool.u32(PT.VERTEXSHADER, PC.OBJECT, str(''), 0, 0), vsValue = pool.u32(1);
  const psType = pool.u32(PT.PIXELSHADER, PC.OBJECT, str(''), 0, 0), psValue = pool.u32(2);
  const states = [
    [op('vs'), 0, vsType, vsValue], [op('ps'), 0, psType, psValue],
    [op('rs', 7), 0, intType, val(1)], [op('rs', 14), 0, intType, val(1)], [op('rs', 27), 0, intType, val(0)], [op('rs', 22), 0, intType, val(3)],
    [op('rs', 15), 0, intType, val(1)], [op('rs', 25), 0, intType, val(7)], [op('rs', 19), 0, intType, val(5)], [op('rs', 20), 0, intType, val(6)],
    [op('rs', 24), 0, intType, val(0)], // AlphaRef = <AlphaRef>
    [op('sampler'), 0, anySampler, noStates], // Sampler[0] = <Samp>
  ];
  const tName = str('T'), pName = str('P');
  const tables = pool.off, t = new Words();
  t.u32(6, 1, 0, 4);
  for (const [ty, v] of [[wvpType, wvpValue], [ldType, ldValue], [dfType, dfValue], [txType, txValue], [smType, smValue], [arType, arValue]]) t.u32(ty, v, 0, 0);
  t.u32(tName, 0, 1); t.u32(pName, 0, states.length);
  for (const s of states) t.u32(...s);
  const vs = shader(0xfffe0200, [['WVP', 2, 0, 4, PC.MATRIX_COLUMNS, PT.FLOAT, 4, 4], ['LightDir', 2, 4, 1, PC.VECTOR, PT.FLOAT, 1, 4], ['Diffuse', 2, 5, 1, PC.VECTOR, PT.FLOAT, 1, 4]], VS_BODY);
  const ps = shader(0xffff0200, [['Samp', 3, 0, 1, PC.OBJECT, PT.SAMPLER2D, 1, 1], ['Diffuse', 2, 0, 1, PC.VECTOR, PT.FLOAT, 1, 4]], PS_BODY);
  const refs = [[0, 0, 0, 10, 'AlphaRef'], [0, 0, 0, 11, 'Samp'], [0xffffffff, 4, 0, 0, 'Tex']];
  t.u32(0, 2 + refs.length);
  t.u32(0, 0, 0, 0, 0, vs.length); t.bytes(vs);
  t.u32(0, 0, 0, 1, 0, ps.length); t.bytes(ps);
  for (const [tq, i, e, s, name] of refs) { const b = cstr(name); t.u32(tq, i, e, s, 1, b.length); t.bytes(b); }
  const head = new Words(); head.u32(0xfeff0901, tables);
  const out = new Uint8Array(8 + pool.off + t.off);
  out.set(head.toBytes(), 0); out.set(pool.toBytes(), 8); out.set(t.toBytes(), 8 + pool.off);
  return out;
}

function session(gfx) {
  const E = d3dEnv(gfx), { mem, ctx, com, vm } = E;
  const out = E.alloc(64), pp = E.alloc(64), scratch = E.alloc(4096);
  [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...a) => { const c = ctx([devPtr, ...a]); return dev[name](c); };
  // the effect runtime over this device (COM method calls of the effect go straight to the device's handlers)
  Object.assign(vm, { effectCtx: null, callGuest: () => 0, log: (k, m) => { if (process.env.FXLOG) console.log(k, m); } });
  const X = {}; com.interface ??= () => {};
  defineEffects(X, vm, { callMethod: (c, self, name, args) => com.implAt(self)[name](ctx([self, ...args])), textBuffer: () => 0 });
  const fxBytes = effectBinary(), src = E.alloc(fxBytes.length);
  mem.writeBytes(src, fxBytes);
  const r = X.D3DXCreateEffect[1](ctx([devPtr, src, fxBytes.length, 0, 0, 0, 0, out, 0]));
  if (r !== 0) throw new Error(`effect not created (${r})`);
  const fxPtr = mem.read32(out), fx = com.implAt(fxPtr);
  const fc = (...a) => ctx([fxPtr, ...a]);
  const handle = (s) => { const p = E.alloc(s.length + 1); mem.writeCString(p, s); return fx.GetParameterByName(fc(0, p)) >>> 0; };
  const H = { wvp: handle('WVP'), ld: handle('LightDir'), df: handle('Diffuse'), tex: handle('Tex'), ar: handle('AlphaRef') };
  const tech = fx.GetTechniqueByName ? fx.GetTechniqueByName(fc((() => { const p = E.alloc(4); mem.writeCString(p, 'T'); return p; })())) >>> 0 : 0;
  const tex = []; for (let i = 0; i < 16; i++) { call('CreateTexture', 64, 64, 1, 0, 21, 1, out, 0); tex.push(mem.read32(out)); }
  call('CreateVertexBuffer', 65536, 8, 0, 1, out, 0); call('SetStreamSource', 0, mem.read32(out), 0, 20);
  call('CreateIndexBuffer', 65536, 8, 101, 1, out, 0); call('SetIndices', mem.read32(out));
  const el = E.alloc(64); [0x00000000, 0x00000002, 0x000c0000, 0x00050001, 0x000000ff, 0x00000011].forEach((v, i) => mem.write32(el + 4 * i, v));
  call('CreateVertexDeclaration', el, out); call('SetVertexDeclaration', mem.read32(out));
  const mat = scratch, vec = scratch + 64, nPasses = E.alloc(4);
  let k = 0, last = null;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    call('BeginScene');
    for (let o = 0; o < PASSES; o++, k++) {
      if (tech) fx.SetTechnique(fc(tech));
      mem.writeF32(vec, 0.5); mem.writeF32(vec + 4, 0.25); mem.writeF32(vec + 8, -1); mem.writeF32(vec + 12, 0); fx.SetVector(fc(H.ld, vec));
      fx.SetTexture(fc(H.tex, tex[k % tex.length]));
      if ((k & 15) === 0) fx.SetInt(fc(H.ar, 64 + (k & 31)));
      fx.Begin(fc(nPasses, 0)); fx.BeginPass(fc(0));
      for (let d = 0; d < 3; d++) {
        for (let i = 0; i < 16; i++) mem.writeF32(mat + 4 * i, (i % 5 === 0 ? 1 : 0) + (i === 12 ? k + d : 0));
        fx.SetMatrixTranspose(fc(H.wvp, mat));
        mem.writeF32(vec, (k + d) & 7); fx.SetVector(fc(H.df, vec));
        fx.CommitChanges(fc());
        call('DrawIndexedPrimitive', 4, 0, 0, 100, 0, 50);
      }
      if (f === FRAMES - 1 && o === PASSES - 1) last = { vs: !!dev.vsObj, ps: !!dev.psObj, c3x: dev.vsConst[12], want: k + 2, ar: dev.rs.get(24), wantAr: 64 + ((k & ~15) & 31), minf: dev.samplers[0].get(6), tex: dev.textures[0] === tex[k % tex.length], c4x: dev.vsConst[16] };
      fx.EndPass(fc()); fx.End(fc());
    }
    call('EndScene'); call('Present', 0, 0, 0, 0);
  }
  const ms = performance.now() - t0;
  // (the pass did reach the device: shaders, constants from the parameters, render and sampler states, the texture)
  const L = last;
  if (!L.vs || !L.ps || L.c3x !== L.want || L.ar !== L.wantAr || L.minf !== 2 || !L.tex || L.c4x !== 0.5) throw new Error(`the effect did not apply: ${JSON.stringify(L)}`);
  return ms;
}

const variants = {
  none: () => ({ createDevice: () => null }),
  recorder: () => {
    const words = new Int32Array(new SharedArrayBuffer(4 << 20));
    const link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
    link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
    return { createDevice: (dev) => new Recorder(link, dev) };
  },
};
const names = only ? [only] : Object.keys(variants), res = new Map(names.map((n) => [n, []]));
for (let r = 0; r < (only ? 1 : ROUNDS); r++) for (const n of names) res.get(n).push(session(variants[n]()) * 1000 / (PASSES * FRAMES));
const best = (a) => Math.min(...(a.length > 1 ? a.slice(1) : a));
console.log(`effect passes (1 pass, 3 draws each), ${PASSES} x ${FRAMES}: ` + names.map((n) => `${n} ${best(res.get(n)).toFixed(2)} us/pass [${res.get(n).map((x) => x.toFixed(2)).join(' ')}]`).join('; '));

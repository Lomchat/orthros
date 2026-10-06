// Builders of compiled D3DX effects (fx_2_0) for tests and benchmarks: parameters of any numeric shape (scalars,
// vectors, row / column matrices, arrays, structs), textures and sampler parameters, techniques and passes of state
// assignments, and shaders with constant tables (CTAB) and preshaders (PRES: literals, code, input table, outputs).
import { STATES, PT, PC } from '../src/win32/d3dx9-fxparse.js';

const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
export class Words {
  constructor() { this.w = []; }
  get off() { return this.w.length * 4; }
  u32(...v) { const o = this.off; for (const x of v) this.w.push(x >>> 0); return o; }
  bytes(b) { const o = this.off; const p = new Uint8Array((b.length + 3) & ~3); p.set(b); const dv = new DataView(p.buffer); for (let i = 0; i < p.length; i += 4) this.w.push(dv.getUint32(i, true)); return o; }
  toBytes() { return new Uint8Array(Uint32Array.from(this.w).buffer); }
}
export const cstr = (s) => new TextEncoder().encode(s + '\0');
/** the state operation number of class `cls` (and index `idx`), see d3dx9-fxparse.js STATES */
export const op = (cls, idx) => STATES.findIndex(([c, x]) => c === cls && (idx === undefined || x === idx));

/**
 * @typedef {{ cls: number, type: number, rows?: number, cols?: number, elements?: number, members?: { name: string, t: T }[] }} T
 *   a type (rows x cols for scalars, vectors and matrices; members of structs)
 */
/** words of one element of a numeric type */
export const elemWords = (t) => (t.cls === PC.STRUCT ? t.members.reduce((s, m) => s + elemWords(m.t) * Math.max(1, m.t.elements ?? 0), 0) : (t.rows ?? 1) * (t.cols ?? 1));
export const totalWords = (t) => elemWords(t) * Math.max(1, t.elements ?? 0);

/** a CTAB block's contents (after its fourcc): entries [name, set, reg, count, type T] */
function ctabContents(entries, version) {
  const ct = new Words();
  ct.u32(28, 0, version, entries.length, 28, 0, 0);
  const infoAt = ct.off / 4; for (let i = 0; i < entries.length; i++) ct.u32(0, 0, 0, 0, 0);
  const typeInfo = (t) => {
    const mem = (t.members ?? []).map((m) => [ct.bytes(cstr(m.name)), typeInfo(m.t)]);
    let mi = 0; if (mem.length) { mi = ct.off; for (const [n, ty] of mem) ct.u32(n, ty); }
    return ct.u32(t.cls | (t.type << 16), (t.rows ?? 1) | ((t.cols ?? 1) << 16), (t.elements ?? 0) | (mem.length << 16), mi);
  };
  entries.forEach(([name, set, reg, count, t], i) => {
    const n = ct.bytes(cstr(name)), ty = typeInfo(t);
    ct.w.splice(infoAt + 5 * i, 5, n, set | (reg << 16), count, ty, 0);
  });
  return ct;
}
const comment = (four, contents) => { const w = new Words(); w.u32(0xfffe | ((contents.w.length + 1) << 16), FOURCC(four)); w.w.push(...contents.w); return w; };

/**
 * A preshader block: `literals` (numbers), `insns` ([op, components, [operands...], out] with operands
 * { table, offset, index? }: tables 1 literals, 2 inputs, 4 outputs, 7 temporaries), `inputs` (CTAB entries) and the
 * output register ranges [[start, count], ...].
 */
export function preshader({ literals = [], insns = [], inputs = [], outRanges = [] }) {
  const lit = new Words(); lit.u32(literals.length); for (const v of literals) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v, true); lit.u32(dv.getUint32(0, true), dv.getUint32(4, true)); }
  const fx = new Words(); fx.u32(insns.length);
  for (const [o, n, ins, out] of insns) {
    fx.u32((o << 16) | n, ins.length);
    for (const a of [...ins, out]) { if (a.index) fx.u32(1, a.table, a.offset, a.index.table, a.index.offset); else fx.u32(0, a.table, a.offset); }
  }
  const prsi = new Words(); prsi.u32(0, 0, 0, 0, 0, 0, outRanges.length); for (const [s, c] of outRanges) prsi.u32(s, c);
  const inner = new Words(); inner.u32(0x46580200);
  for (const b of [comment('CLIT', lit), comment('FXLC', fx), comment('CTAB', ctabContents(inputs, 0x46580200)), comment('PRSI', prsi)]) inner.w.push(...b.w);
  inner.u32(0x0000ffff);
  return inner;
}

/** shader bytecode: version token, CTAB (`consts`: [name, set, reg, count, T]), an optional preshader, then `body` */
export function shader(vs, consts, pre = null, body = []) {
  const version = vs ? 0xfffe0300 : 0xffff0300;
  const w = new Words(); w.u32(version);
  w.w.push(...comment('CTAB', ctabContents(consts, version)).w);
  if (pre) w.w.push(...comment('PRES', preshader(pre)).w);
  w.w.push(...body); w.u32(0x0000ffff);
  return w.toBytes();
}

/**
 * An effect: `params` [{ name, t: T, value?: number[] (raw words), samplers?: [[op, index, refName | value]...] per element }],
 * `techniques` [{ name, passes: [{ name, states: [{ op, index, value?: raw word | shader bytes, ref?: name }] }] }].
 * Shader states take their own bytecode (value: Uint8Array) or a shader parameter's (ref).
 */
export function effectBinary({ params, techniques }) {
  const pool = new Words(); pool.u32(0);
  const str = (s) => { const b = cstr(s); const o = pool.u32(b.length); pool.bytes(b); return o; };
  const typeOf = (t, name = '') => {
    // (the member names' strings written first: the members' type words follow their struct's inline, nothing between)
    const names = [], strs = (x, nm) => { names.push([str(nm), str('')]); if (x.cls === PC.STRUCT) for (const m of x.members) strs(m.t, m.name); };
    strs(t, name);
    let k = 0; // (the same traversal order as strs)
    const words = (x) => { const w = [x.type, x.cls, ...names[k++], x.elements ?? 0]; if (x.cls <= PC.VECTOR) w.push(x.cols ?? 1, x.rows ?? 1); else if (x.cls <= PC.MATRIX_COLUMNS) w.push(x.rows ?? 1, x.cols ?? 1); else if (x.cls === PC.STRUCT) w.push(x.members.length); return w; };
    const inline = (x) => { const at = pool.u32(...words(x)); if (x.cls === PC.STRUCT) for (const m of x.members) inline(m.t); return at; };
    return inline(t);
  };
  const intType = typeOf({ cls: PC.SCALAR, type: PT.INT });
  const resources = []; // [technique, index, element, state, usage, bytes]
  let nextObj = 1;
  const objects = [];
  const paramRows = params.map((p, pi) => {
    const t = p.t, ty = typeOf(t, p.name);
    let val;
    if (t.cls === PC.OBJECT && t.type >= PT.SAMPLER && t.type <= PT.SAMPLERCUBE) {
      const els = p.samplers ?? [[]];
      const w = [];
      els.forEach((st, e) => {
        w.push(st.length);
        st.forEach(([o, idx, v], k) => {
          if (typeof v === 'string') { w.push(o, idx, intType, pool.u32(0)); resources.push([0xffffffff, pi, e, k, 1, cstr(v)]); }
          else w.push(o, idx, intType, pool.u32(v));
        });
      });
      val = pool.u32(...w);
    } else if (t.cls === PC.OBJECT) {
      const ids = []; for (let e = 0; e < Math.max(1, t.elements ?? 0); e++) ids.push(nextObj++);
      val = pool.u32(...ids);
      if (p.shaders) p.shaders.forEach((b, e) => resources.push([0xffffffff, pi, e, 0, 0, b]));
    } else {
      const n = totalWords(t), v = p.value ?? [];
      val = pool.u32(...Array.from({ length: n }, (_, i) => v[i] ?? 0));
    }
    return [ty, val];
  });
  const tech = techniques.map((tq, ti) => [str(tq.name), tq.passes.map((ps, pi) => [str(ps.name), ps.states.map((s, si) => {
    const cls = STATES[s.op]?.[0];
    if (cls === 'vs' || cls === 'ps') {
      const ty = typeOf({ cls: PC.OBJECT, type: cls === 'vs' ? PT.VERTEXSHADER : PT.PIXELSHADER });
      const v = pool.u32(nextObj++);
      if (s.ref) resources.push([ti, pi, 0, si, 1, cstr(s.ref)]); else resources.push([ti, pi, 0, si, 0, s.value]);
      return [s.op, s.index ?? 0, ty, v];
    }
    if (cls === 'sampler') { const ty = typeOf({ cls: PC.OBJECT, type: PT.SAMPLER2D }); resources.push([ti, pi, 0, si, 1, cstr(s.ref)]); return [s.op, s.index ?? 0, ty, pool.u32(0)]; }
    if (s.ref) resources.push([ti, pi, 0, si, 1, cstr(s.ref)]);
    return [s.op, s.index ?? 0, intType, pool.u32(s.value ?? 0)];
  })])]);
  void objects;
  const tables = pool.off, t = new Words();
  t.u32(params.length, techniques.length, 0, nextObj);
  for (const [ty, v] of paramRows) t.u32(ty, v, 0, 0);
  for (const [name, passes] of tech) { t.u32(name, 0, passes.length); for (const [pn, states] of passes) { t.u32(pn, 0, states.length); for (const s of states) t.u32(...s); } }
  t.u32(0, resources.length);
  for (const [tq, i, e, s, usage, b] of resources) { t.u32(tq, i, e, s, usage, b.length); t.bytes(b); }
  const head = new Words(); head.u32(0xfeff0901, tables);
  const out = new Uint8Array(8 + pool.off + t.off);
  out.set(head.toBytes(), 0); out.set(pool.toBytes(), 8); out.set(t.toBytes(), 8 + pool.off);
  return out;
}

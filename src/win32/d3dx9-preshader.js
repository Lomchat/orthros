// D3DX shader constant tables (CTAB) and preshaders: the constant table describes which registers of a compiled
// shader a uniform occupies and how (register set, count, type layout); a preshader (PRES block, or the "fx"
// expression programs of an effect's array selectors) is a small CPU program (FXLC) that computes constants from
// uniforms before the draw: inputs are uniforms laid out in registers by its own constant table, literals (CLIT,
// doubles), temporaries, and outputs written into the shader's float constant registers (the PRSI ranges).

const FOURCC = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
const CTAB = FOURCC('CTAB'), PRES = FOURCC('PRES'), CLIT = FOURCC('CLIT'), FXLC = FOURCC('FXLC'), PRSI = FOURCC('PRSI');

/** D3DXREGISTER_SET */
export const RSET = { BOOL: 0, INT4: 1, FLOAT4: 2, SAMPLER: 3 };

/**
 * @typedef {{ cls: number, type: number, rows: number, cols: number, elements: number, members: {name: string, type: CtabType}[] }} CtabType
 * @typedef {{ name: string, set: number, reg: number, count: number, type: CtabType, defaultWords: Uint32Array|null }} CtabEntry
 */

/** Parse a CTAB block (bytes: the block's contents after its fourcc). */
export function parseCtab(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = (o) => dv.getUint32(o, true), h = (o) => dv.getUint16(o, true);
  const cstr = (o) => { let s = ''; while (o < bytes.length && bytes[o]) s += String.fromCharCode(bytes[o++]); return s; };
  const readType = (o) => {
    const t = { cls: h(o), type: h(o + 2), rows: h(o + 4), cols: h(o + 6), elements: h(o + 8), members: [] };
    const n = h(o + 10), mi = u(o + 12);
    for (let i = 0; i < n; i++) t.members.push({ name: cstr(u(mi + 8 * i)), type: readType(u(mi + 8 * i + 4)) });
    return t;
  };
  const n = u(12), ci = u(16), out = [];
  for (let i = 0; i < n; i++) {
    const e = ci + 20 * i;
    const entry = { name: cstr(u(e)), set: h(e + 4), reg: h(e + 6), count: h(e + 8), type: readType(u(e + 12)), defaultWords: null };
    const dflt = u(e + 16);
    if (dflt && entry.set !== RSET.SAMPLER) { const words = new Uint32Array(entry.count * 4); for (let k = 0; k < words.length && dflt + 4 * k + 4 <= bytes.length; k++) words[k] = u(dflt + 4 * k); entry.defaultWords = words; }
    out.push(entry);
  }
  return { creator: cstr(u(4)), version: u(8), target: cstr(u(24)), constants: out };
}

/** The comment blocks of a shader token stream (bytes from the version token): fourcc -> contents (first occurrence). */
export function commentBlocks(bytes, from = 4, to = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = (o) => dv.getUint32(o, true);
  const blocks = new Map();
  let p = from;
  while (p + 4 <= to) {
    const t = u(p);
    if (t === 0x0000ffff) break;
    if ((t & 0xffff) === 0xfffe) {
      const n = t >>> 16;
      if (n >= 1 && p + 8 <= to) { const four = u(p + 4); if (!blocks.has(four)) blocks.set(four, { off: p + 8, end: p + 4 + 4 * n }); }
      p += 4 + 4 * n; continue;
    }
    return { blocks, instructionsAt: p }; // (the first instruction: comments come first in compiled shaders)
  }
  return { blocks, instructionsAt: p };
}

/**
 * A preshader program from its blocks: literals, code (instructions of opcode, component count, operands), its input
 * constant table and the output register ranges.
 */
function parseProgram(bytes, blocks) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = (o) => dv.getUint32(o, true);
  const lit = blocks.get(CLIT), code = blocks.get(FXLC), ctab = blocks.get(CTAB), prsi = blocks.get(PRSI);
  const literals = [];
  if (lit) { const n = u(lit.off); for (let i = 0; i < n; i++) literals.push(dv.getFloat64(lit.off + 4 + 8 * i, true)); }
  const insns = [];
  let temps = 0;
  if (code) {
    const n = u(code.off);
    let p = code.off + 4;
    for (let i = 0; i < n; i++) {
      const tok = u(p), nin = u(p + 4); p += 8;
      const ops = [];
      for (let a = 0; a <= nin; a++) {
        const flags = u(p), table = u(p + 4), offset = u(p + 8); p += 12;
        let index = null;
        if (flags) { index = { table: u(p), offset: u(p + 4) }; p += 8; } // (relative addressing: an index register)
        ops.push({ table, offset, index });
        if (table === 7) temps = Math.max(temps, offset + 4);
      }
      insns.push({ op: tok >>> 16, n: tok & 0xffff, ins: ops.slice(0, nin), out: ops[nin] });
    }
  }
  const ranges = [];
  if (prsi) { const w = []; for (let o = prsi.off; o < prsi.end; o += 4) w.push(u(o)); const k = w[6] ?? 0; for (let i = 0; i < k; i++) ranges.push([w[7 + 2 * i], w[8 + 2 * i]]); }
  return { literals, insns, temps, inputs: ctab ? parseCtab(bytes.subarray(ctab.off, ctab.end)).constants : [], outRanges: ranges };
}

/** The constant table and the preshader (if any) of a compiled shader (Uint8Array from its version token). */
export function shaderInfo(bytes) {
  const { blocks } = commentBlocks(bytes);
  const c = blocks.get(CTAB);
  const info = { constants: c ? parseCtab(bytes.subarray(c.off, c.end)).constants : [], preshader: null };
  const pres = blocks.get(PRES);
  if (pres) { // the PRES block holds its own token stream: version, comments (CLIT, FXLC, CTAB, PRSI...)
    const inner = commentBlocks(bytes, pres.off + 4, pres.end);
    info.preshader = parseProgram(bytes, inner.blocks);
  }
  return info;
}

/** An effect expression ("fx" token stream, e.g. an array selector) */
export function expressionInfo(bytes) {
  const { blocks } = commentBlocks(bytes);
  return parseProgram(bytes, blocks);
}

/**
 * Run a preshader. `inputs`: Float64Array of input registers (4 components each) filled from the uniforms per the
 * program's input table; `out`: Float32Array written at the output components (constant registers of the shader).
 */
export function runPreshader(prog, inputs, out) {
  const lit = prog.literals, temp = new Float64Array(Math.max(4, prog.temps));
  const read = (o, k) => {
    let off = o.offset + k;
    if (o.index) off += Math.floor(read({ table: o.index.table, offset: o.index.offset, index: null }, 0)) * 4;
    switch (o.table) {
      case 1: return lit[off] ?? 0;
      case 2: return inputs[off] ?? 0;
      case 4: return out[off] ?? 0;
      case 7: return temp[off] ?? 0;
      default: return 0;
    }
  };
  const write = (o, k, v) => {
    const off = o.offset + k;
    if (o.table === 4) { if (off < out.length) out[off] = v; }
    else if (o.table === 7) temp[off] = v;
  };
  for (const I of prog.insns) {
    const n = I.n, [a, b, c] = I.ins, op = I.op;
    const scalarFirst = (op & 0xf000) === 0xa000, base = scalarFirst ? (op & 0x0fff) | 0x2000 : op;
    const A = (k) => read(a, scalarFirst ? 0 : k), B = (k) => read(b, k), C = (k) => read(c, k);
    if (base === 0x5000) { let s = 0; for (let k = 0; k < n; k++) s += A(k) * B(k); write(I.out, 0, s); continue; } // dot
    for (let k = 0; k < n; k++) {
      let v;
      switch (base) {
        case 0x1000: v = A(k); break; // mov
        case 0x1010: v = -A(k); break; // neg
        case 0x1030: v = 1 / A(k); break; // rcp
        case 0x1040: { const x = A(k); v = x - Math.floor(x); break; } // frc
        case 0x1050: v = Math.pow(2, A(k)); break; // exp (base 2)
        case 0x1060: v = Math.log2(Math.abs(A(k))); break; // log (base 2)
        case 0x1070: v = 1 / Math.sqrt(Math.abs(A(k))); break; // rsq
        case 0x1080: v = Math.sin(A(k)); break;
        case 0x1090: v = Math.cos(A(k)); break;
        case 0x10a0: v = Math.asin(A(k)); break;
        case 0x10b0: v = Math.acos(A(k)); break;
        case 0x10c0: v = Math.atan(A(k)); break;
        case 0x2000: v = Math.min(A(k), B(k)); break;
        case 0x2010: v = Math.max(A(k), B(k)); break;
        case 0x2020: v = A(k) < B(k) ? 1 : 0; break; // lt
        case 0x2030: v = A(k) >= B(k) ? 1 : 0; break; // ge
        case 0x2040: v = A(k) + B(k); break;
        case 0x2050: v = A(k) * B(k); break;
        case 0x2060: v = Math.atan2(A(k), B(k)); break;
        case 0x2080: v = A(k) / B(k); break;
        case 0x3000: v = A(k) >= 0 ? B(k) : C(k); break; // cmp
        case 0x3010: v = A(k) !== 0 ? B(k) : C(k); break; // movc
        default: v = 0;
      }
      write(I.out, k, v);
    }
  }
}

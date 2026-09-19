// MMX / SSE / SSE2 (+ a few SSE3) handlers for the reference interpreter.
//
// Vector operands are copied into a scratch buffer, computed lane by lane with typed views, and
// the result is copied back to the destination (register in guest memory or memory operand).
// Single-precision results are rounded with Math.fround (exact for + - * / sqrt on f32 inputs).
import { H, CpuFault } from './interp.js';
import { OP, OT } from './decoder.js';
import { F } from './state.js';
import { roundEven } from './interp-x87.js';

const buf = new ArrayBuffer(64);
function views(off) {
  return {
    u8: new Uint8Array(buf, off, 16), i8: new Int8Array(buf, off, 16),
    u16: new Uint16Array(buf, off, 8), i16: new Int16Array(buf, off, 8),
    u32: new Uint32Array(buf, off, 4), i32: new Int32Array(buf, off, 4),
    f32: new Float32Array(buf, off, 4), f64: new Float64Array(buf, off, 2),
    u64: new BigUint64Array(buf, off, 2), i64: new BigInt64Array(buf, off, 2),
  };
}
const A = views(0), B = views(16), R = views(32);
const dvR = new DataView(buf, 32, 16);

function opAddr(I, o) {
  if (o.t === OT.XMM) return I.cpu.xmmAddr(o.r);
  if (o.t === OT.MM) { I.cpu.fpuTw = 0xff; I.cpu.fpuTop = 0; return I.cpu.mmAddr(o.r); }
  if (o.t === OT.MEM) return I.ea(o);
  throw new Error('bad vector operand');
}
function vsize(o) { return o.t === OT.MM ? 8 : o.t === OT.XMM ? 16 : o.size; }

/** Load operand bytes into view V (zero-filling the rest of 16 bytes). */
function load(I, o, V, size) {
  if (o.t === OT.REG) { // GPR source (movd etc.)
    V.u32[0] = I.rd(o); V.u32[1] = 0; V.u32[2] = 0; V.u32[3] = 0; return;
  }
  const a = opAddr(I, o);
  const n = size ?? vsize(o);
  V.u8.set(I.mem.u8.subarray(a, a + n));
  if (n < 16) V.u8.fill(0, n);
}
function store(I, o, V, size) {
  if (o.t === OT.REG) { I.wr(o, V.u32[0]); return; }
  const a = opAddr(I, o);
  const n = size ?? vsize(o);
  I.mem.u8.set(V.u8.subarray(0, n), a);
}

// MXCSR helpers
const MX_DAZ = 1 << 6, MX_FTZ = 1 << 15;
function dazIn(I, v) { // denormals-are-zero on inputs
  if (I.cpu.mxcsr & MX_DAZ && v !== 0 && Math.abs(v) < 1.1754943508222875e-38) return v < 0 ? -0 : 0;
  return v;
}
function dazInD(I, v) {
  if (I.cpu.mxcsr & MX_DAZ && v !== 0 && Math.abs(v) < 2.2250738585072014e-308) return v < 0 ? -0 : 0;
  return v;
}
function ftzOut(I, v) {
  if (I.cpu.mxcsr & MX_FTZ && v !== 0 && Math.abs(v) < 1.1754943508222875e-38) return v < 0 ? -0 : 0;
  return v;
}
function ftzOutD(I, v) {
  if (I.cpu.mxcsr & MX_FTZ && v !== 0 && Math.abs(v) < 2.2250738585072014e-308) return v < 0 ? -0 : 0;
  return v;
}
function mxRound(I, v) {
  switch ((I.cpu.mxcsr >> 13) & 3) {
    case 0: return roundEven(v);
    case 1: return Math.floor(v);
    case 2: return Math.ceil(v);
    default: return Math.trunc(v);
  }
}
function toInt32(I, v, trunc) {
  if (Number.isNaN(v)) return 0x80000000;
  const r = trunc ? Math.trunc(v) : mxRound(I, v);
  if (r < -2147483648 || r > 2147483647) return 0x80000000;
  return r >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Packed float arithmetic

// x86 NaN rule for SSE arithmetic: a NaN result comes from the first (destination) operand when it is
// a NaN (quieted), else from the second, else it is the "real indefinite" negative QNaN. JS arithmetic
// canonicalises NaNs, so the result bits are rebuilt from the operand bits.
const isNan32 = (u) => (u & 0x7fffffff) > 0x7f800000;
function nan32(au, bu) { return isNan32(au) ? (au | 0x00400000) >>> 0 : isNan32(bu) ? (bu | 0x00400000) >>> 0 : 0xffc00000; }
function storeF32Lane(V, i, r, au, bu) { if (r === r) V.f32[i] = r; else V.u32[i] = nan32(au, bu); }
function storeF64Lane(V, i, r, alo, ahi, blo, bhi) {
  if (r === r) { V.f64[i] = r; return; }
  const aNan = (ahi & 0x7fffffff) > 0x7ff00000 || ((ahi & 0x7fffffff) === 0x7ff00000 && alo !== 0);
  const bNan = (bhi & 0x7fffffff) > 0x7ff00000 || ((bhi & 0x7fffffff) === 0x7ff00000 && blo !== 0);
  if (aNan) { V.u32[2 * i] = alo; V.u32[2 * i + 1] = (ahi | 0x00080000) >>> 0; } else if (bNan) { V.u32[2 * i] = blo; V.u32[2 * i + 1] = (bhi | 0x00080000) >>> 0; } else { V.u32[2 * i] = 0; V.u32[2 * i + 1] = 0xfff80000; }
}
// kind: 'ps' 4xf32, 'pd' 2xf64, 'ss' 1xf32 (rest from dest), 'sd' 1xf64. mode: 'bin' (two operands),
// 'select' (MIN/MAX: one operand is returned unchanged — no NaN quieting, no FTZ on the result) or
// 'unary' (SQRT/RCP/RSQRT: only the source operand feeds the NaN rule).
function fpBin(kind, fn, mode = 'bin') {
  const select = mode === 'select', unary = mode === 'unary';
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    load(I, d, A, 16);
    if (kind === 'ss') load(I, s, B, s.t === OT.MEM ? 4 : 16);
    else if (kind === 'sd') load(I, s, B, s.t === OT.MEM ? 8 : 16);
    else load(I, s, B, 16);
    R.u8.set(A.u8);
    if (kind === 'ps' || kind === 'ss') {
      const n = kind === 'ps' ? 4 : 1;
      for (let i = 0; i < n; i++) {
        const a = dazIn(I, A.f32[i]), b = dazIn(I, B.f32[i]);
        if (select) { if (a !== a || b !== b) R.u32[i] = B.u32[i]; else R.f32[i] = fn(a, b); }
        else storeF32Lane(R, i, ftzOut(I, Math.fround(fn(a, b))), unary ? B.u32[i] : A.u32[i], B.u32[i]);
      }
    } else {
      const n = kind === 'pd' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const a = dazInD(I, A.f64[i]), b = dazInD(I, B.f64[i]);
        if (select) { if (a !== a || b !== b) { R.u32[2 * i] = B.u32[2 * i]; R.u32[2 * i + 1] = B.u32[2 * i + 1]; } else R.f64[i] = fn(a, b); }
        else storeF64Lane(R, i, ftzOutD(I, fn(a, b)), unary ? B.u32[2 * i] : A.u32[2 * i], unary ? B.u32[2 * i + 1] : A.u32[2 * i + 1], B.u32[2 * i], B.u32[2 * i + 1]);
      }
    }
    store(I, d, R, 16);
  };
}
const add = (a, b) => a + b, sub = (a, b) => a - b, mul = (a, b) => a * b, div = (a, b) => a / b;
const min = (a, b) => (a < b ? a : b), max = (a, b) => (a > b ? a : b);
const sqrt = (a, b) => Math.sqrt(b);
for (const [k, fn] of [['ADD', add], ['SUB', sub], ['MUL', mul], ['DIV', div], ['MIN', min], ['MAX', max], ['SQRT', sqrt]]) {
  const mode = k === 'MIN' || k === 'MAX' ? 'select' : k === 'SQRT' ? 'unary' : 'bin';
  H[OP[k + 'PS']] = fpBin('ps', fn, mode); H[OP[k + 'PD']] = fpBin('pd', fn, mode);
  H[OP[k + 'SS']] = fpBin('ss', fn, mode); H[OP[k + 'SD']] = fpBin('sd', fn, mode);
}
H[OP.RCPPS] = fpBin('ps', (a, b) => 1 / b, 'unary');
H[OP.RCPSS] = fpBin('ss', (a, b) => 1 / b, 'unary');
H[OP.RSQRTPS] = fpBin('ps', (a, b) => 1 / Math.sqrt(b), 'unary');
H[OP.RSQRTSS] = fpBin('ss', (a, b) => 1 / Math.sqrt(b), 'unary');
// SSE3 horizontal / alternating forms: same NaN rule, the "first operand" being the left lane of each pair
const f32pair = (i, X, xi, Y, yi, sub) => storeF32Lane(R, i, Math.fround(sub ? X.f32[xi] - Y.f32[yi] : X.f32[xi] + Y.f32[yi]), X.u32[xi], Y.u32[yi]);
const f64pair = (i, X, xi, Y, yi, sub) => storeF64Lane(R, i, sub ? X.f64[xi] - Y.f64[yi] : X.f64[xi] + Y.f64[yi], X.u32[2 * xi], X.u32[2 * xi + 1], Y.u32[2 * yi], Y.u32[2 * yi + 1]);
H[OP.ADDSUBPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); for (let i = 0; i < 4; i++) f32pair(i, A, i, B, i, !(i & 1)); store(I, insn.ops[0], R, 16); };
H[OP.ADDSUBPD] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); f64pair(0, A, 0, B, 0, true); f64pair(1, A, 1, B, 1, false); store(I, insn.ops[0], R, 16); };
H[OP.HADDPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); f32pair(0, A, 0, A, 1, false); f32pair(1, A, 2, A, 3, false); f32pair(2, B, 0, B, 1, false); f32pair(3, B, 2, B, 3, false); store(I, insn.ops[0], R, 16); };
H[OP.HSUBPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); f32pair(0, A, 0, A, 1, true); f32pair(1, A, 2, A, 3, true); f32pair(2, B, 0, B, 1, true); f32pair(3, B, 2, B, 3, true); store(I, insn.ops[0], R, 16); };
H[OP.HADDPD] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); f64pair(0, A, 0, A, 1, false); f64pair(1, B, 0, B, 1, false); store(I, insn.ops[0], R, 16); };
H[OP.HSUBPD] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); f64pair(0, A, 0, A, 1, true); f64pair(1, B, 0, B, 1, true); store(I, insn.ops[0], R, 16); };

// bitwise
function bitop(fn) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    const n = vsize(d);
    load(I, d, A, n); load(I, s, B, n);
    for (let i = 0; i < 4; i++) R.u32[i] = fn(A.u32[i], B.u32[i]) >>> 0;
    store(I, d, R, n);
  };
}
H[OP.ANDPS] = H[OP.ANDPD] = H[OP.PAND] = bitop((a, b) => a & b);
H[OP.ANDNPS] = H[OP.ANDNPD] = H[OP.PANDN] = bitop((a, b) => ~a & b);
H[OP.ORPS] = H[OP.ORPD] = H[OP.POR] = bitop((a, b) => a | b);
H[OP.XORPS] = H[OP.XORPD] = H[OP.PXOR] = bitop((a, b) => a ^ b);

// compares
const PRED = [
  (a, b) => a === b, (a, b) => a < b, (a, b) => a <= b, (a, b) => Number.isNaN(a) || Number.isNaN(b),
  (a, b) => !(a === b), (a, b) => !(a < b), (a, b) => !(a <= b), (a, b) => !(Number.isNaN(a) || Number.isNaN(b)),
];
function cmpHandler(kind) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const p = PRED[insn.ops[2].v & 7];
    load(I, d, A, 16);
    load(I, s, B, s.t === OT.MEM ? (kind === 'ss' ? 4 : kind === 'sd' ? 8 : 16) : 16);
    R.u8.set(A.u8);
    if (kind === 'ps' || kind === 'ss') { const n = kind === 'ps' ? 4 : 1; for (let i = 0; i < n; i++) R.u32[i] = p(A.f32[i], B.f32[i]) ? 0xffffffff : 0; }
    else { const n = kind === 'pd' ? 2 : 1; for (let i = 0; i < n; i++) R.u64[i] = p(A.f64[i], B.f64[i]) ? 0xffffffffffffffffn : 0n; }
    store(I, d, R, 16);
  };
}
H[OP.CMPPS] = cmpHandler('ps'); H[OP.CMPPD] = cmpHandler('pd'); H[OP.CMPSS] = cmpHandler('ss'); H[OP.CMPSD] = cmpHandler('sd');
function comis(double) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    load(I, d, A, 16); load(I, s, B, s.t === OT.MEM ? (double ? 8 : 4) : 16);
    const a = double ? A.f64[0] : A.f32[0], b = double ? B.f64[0] : B.f32[0];
    let f = I.flags & ~(F.ZF | F.PF | F.CF | F.OF | F.SF | F.AF);
    if (Number.isNaN(a) || Number.isNaN(b)) f |= F.ZF | F.PF | F.CF;
    else if (a < b) f |= F.CF;
    else if (a === b) f |= F.ZF;
    I.flags = f >>> 0;
  };
}
H[OP.COMISS] = H[OP.UCOMISS] = comis(false);
H[OP.COMISD] = H[OP.UCOMISD] = comis(true);

// moves
function mov(size, zeroUpper) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    load(I, s, B, size);
    if (d.t === OT.MEM || d.t === OT.REG) { store(I, d, B, size); return; }
    if (zeroUpper || s.t === OT.MEM) { store(I, d, B, 16); return; }
    load(I, d, A, 16); A.u8.set(B.u8.subarray(0, size)); store(I, d, A, 16);
  };
}
H[OP.MOVAPS] = H[OP.MOVAPD] = H[OP.MOVUPS] = H[OP.MOVUPD] = H[OP.MOVDQA] = H[OP.MOVDQU] = H[OP.LDDQU] = H[OP.MOVNTPS] = H[OP.MOVNTPD] = H[OP.MOVNTDQ] = mov(16, true);
H[OP.MOVSS] = mov(4, false);
H[OP.MOVSD] = mov(8, false);
H[OP.MOVD] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  if (d.t === OT.REG || d.t === OT.MEM) { load(I, s, B, 4); if (d.t === OT.REG) I.wr(d, B.u32[0]); else I.mem.write32(I.ea(d), B.u32[0]); return; }
  load(I, s, B, 4); store(I, d, B, vsize(d));
};
H[OP.MOVQ] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  load(I, s, B, 8);
  if (d.t === OT.MEM) { store(I, d, B, 8); return; }
  store(I, d, B, vsize(d)); // zero-extends into xmm
};
H[OP.MOVQ2DQ] = (I, insn) => { load(I, insn.ops[1], B, 8); store(I, insn.ops[0], B, 16); };
H[OP.MOVDQ2Q] = (I, insn) => { load(I, insn.ops[1], B, 8); store(I, insn.ops[0], B, 8); };
H[OP.MOVNTQ] = (I, insn) => { load(I, insn.ops[1], B, 8); store(I, insn.ops[0], B, 8); };
H[OP.MOVNTI] = (I, insn) => { I.mem.write32(I.ea(insn.ops[0]), I.rd(insn.ops[1])); };
H[OP.MOVLPS] = H[OP.MOVLPD] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  if (d.t === OT.MEM) { load(I, s, B, 8); store(I, d, B, 8); return; }
  load(I, d, A, 16); load(I, s, B, 8); A.u64[0] = B.u64[0]; store(I, d, A, 16);
};
H[OP.MOVHPS] = H[OP.MOVHPD] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  if (d.t === OT.MEM) { load(I, s, B, 16); R.u64[0] = B.u64[1]; store(I, d, R, 8); return; }
  load(I, d, A, 16); load(I, s, B, 8); A.u64[1] = B.u64[0]; store(I, d, A, 16);
};
H[OP.MOVLHPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); A.u64[1] = B.u64[0]; store(I, insn.ops[0], A, 16); };
H[OP.MOVHLPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); A.u64[0] = B.u64[1]; store(I, insn.ops[0], A, 16); };
H[OP.MOVSLDUP] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = R.u32[1] = B.u32[0]; R.u32[2] = R.u32[3] = B.u32[2]; store(I, insn.ops[0], R, 16); };
H[OP.MOVSHDUP] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = R.u32[1] = B.u32[1]; R.u32[2] = R.u32[3] = B.u32[3]; store(I, insn.ops[0], R, 16); };
H[OP.MOVDDUP] = (I, insn) => { load(I, insn.ops[1], B, 8); R.u64[0] = R.u64[1] = B.u64[0]; store(I, insn.ops[0], R, 16); };
H[OP.MOVMSKPS] = (I, insn) => { load(I, insn.ops[1], B, 16); let m = 0; for (let i = 0; i < 4; i++) if (B.u32[i] & 0x80000000) m |= 1 << i; I.cpu.setReg(insn.ops[0].r, m); };
H[OP.MOVMSKPD] = (I, insn) => { load(I, insn.ops[1], B, 16); let m = 0; if (B.u32[1] & 0x80000000) m |= 1; if (B.u32[3] & 0x80000000) m |= 2; I.cpu.setReg(insn.ops[0].r, m); };
H[OP.PMOVMSKB] = (I, insn) => { const n = vsize(insn.ops[1]); load(I, insn.ops[1], B, n); let m = 0; for (let i = 0; i < n; i++) if (B.u8[i] & 0x80) m |= 1 << i; I.cpu.setReg(insn.ops[0].r, m >>> 0); };
H[OP.PEXTRW] = (I, insn) => { const n = vsize(insn.ops[1]); load(I, insn.ops[1], B, n); I.cpu.setReg(insn.ops[0].r, B.u16[insn.ops[2].v & (n / 2 - 1)]); };
H[OP.PINSRW] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
  load(I, d, A, n);
  const v = s.t === OT.REG ? I.readReg(4, s.r) & 0xffff : I.mem.read16(I.ea(s));
  A.u16[insn.ops[2].v & (n / 2 - 1)] = v; store(I, d, A, n);
};
H[OP.MASKMOVQ] = H[OP.MASKMOVDQU] = (I, insn) => {
  const n = vsize(insn.ops[0]);
  load(I, insn.ops[0], A, n); load(I, insn.ops[1], B, n);
  let a = I.cpu.edi; if (insn.seg === 4) a += I.cpu.fsBase; else if (insn.seg === 5) a += I.cpu.gsBase;
  for (let i = 0; i < n; i++) if (B.u8[i] & 0x80) I.mem.write8((a + i) >>> 0, A.u8[i]);
};

// shuffles / unpacks
H[OP.SHUFPS] = (I, insn) => {
  load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); const im = insn.ops[2].v;
  R.u32[0] = A.u32[im & 3]; R.u32[1] = A.u32[(im >> 2) & 3]; R.u32[2] = B.u32[(im >> 4) & 3]; R.u32[3] = B.u32[(im >> 6) & 3];
  store(I, insn.ops[0], R, 16);
};
H[OP.SHUFPD] = (I, insn) => {
  load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); const im = insn.ops[2].v;
  R.u64[0] = A.u64[im & 1]; R.u64[1] = B.u64[(im >> 1) & 1];
  store(I, insn.ops[0], R, 16);
};
H[OP.UNPCKLPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); R.u32[0] = A.u32[0]; R.u32[1] = B.u32[0]; R.u32[2] = A.u32[1]; R.u32[3] = B.u32[1]; store(I, insn.ops[0], R, 16); };
H[OP.UNPCKHPS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); R.u32[0] = A.u32[2]; R.u32[1] = B.u32[2]; R.u32[2] = A.u32[3]; R.u32[3] = B.u32[3]; store(I, insn.ops[0], R, 16); };
H[OP.UNPCKLPD] = H[OP.PUNPCKLQDQ] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); R.u64[0] = A.u64[0]; R.u64[1] = B.u64[0]; store(I, insn.ops[0], R, 16); };
H[OP.UNPCKHPD] = H[OP.PUNPCKHQDQ] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 16); R.u64[0] = A.u64[1]; R.u64[1] = B.u64[1]; store(I, insn.ops[0], R, 16); };
function punpck(width, high) {
  const V = { 1: 'u8', 2: 'u16', 4: 'u32' }[width];
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
    load(I, d, A, n); load(I, s, B, n);
    const lanes = n / width, half = lanes / 2, base = high ? half : 0;
    for (let i = 0; i < half; i++) { R[V][2 * i] = A[V][base + i]; R[V][2 * i + 1] = B[V][base + i]; }
    store(I, d, R, n);
  };
}
H[OP.PUNPCKLBW] = punpck(1, false); H[OP.PUNPCKLWD] = punpck(2, false); H[OP.PUNPCKLDQ] = punpck(4, false);
H[OP.PUNPCKHBW] = punpck(1, true); H[OP.PUNPCKHWD] = punpck(2, true); H[OP.PUNPCKHDQ] = punpck(4, true);
H[OP.PSHUFD] = (I, insn) => { load(I, insn.ops[1], B, 16); const im = insn.ops[2].v; for (let i = 0; i < 4; i++) R.u32[i] = B.u32[(im >> (2 * i)) & 3]; store(I, insn.ops[0], R, 16); };
H[OP.PSHUFW] = (I, insn) => { load(I, insn.ops[1], B, 8); const im = insn.ops[2].v; for (let i = 0; i < 4; i++) R.u16[i] = B.u16[(im >> (2 * i)) & 3]; store(I, insn.ops[0], R, 8); };
H[OP.PSHUFLW] = (I, insn) => { load(I, insn.ops[1], B, 16); const im = insn.ops[2].v; R.u64[1] = B.u64[1]; for (let i = 0; i < 4; i++) R.u16[i] = B.u16[(im >> (2 * i)) & 3]; store(I, insn.ops[0], R, 16); };
H[OP.PSHUFHW] = (I, insn) => { load(I, insn.ops[1], B, 16); const im = insn.ops[2].v; R.u64[0] = B.u64[0]; for (let i = 0; i < 4; i++) R.u16[4 + i] = B.u16[4 + ((im >> (2 * i)) & 3)]; store(I, insn.ops[0], R, 16); };

// packed integer lane ops
function lanes(V, fn) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
    load(I, d, A, n); load(I, s, B, n);
    const cnt = n / A[V].BYTES_PER_ELEMENT;
    for (let i = 0; i < cnt; i++) R[V][i] = fn(A[V][i], B[V][i]);
    store(I, d, R, n);
  };
}
const sat = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
H[OP.PADDB] = lanes('u8', (a, b) => a + b); H[OP.PADDW] = lanes('u16', (a, b) => a + b); H[OP.PADDD] = lanes('u32', (a, b) => (a + b) >>> 0);
H[OP.PADDQ] = lanes('u64', (a, b) => BigInt.asUintN(64, a + b));
H[OP.PSUBB] = lanes('u8', (a, b) => a - b); H[OP.PSUBW] = lanes('u16', (a, b) => a - b); H[OP.PSUBD] = lanes('u32', (a, b) => (a - b) >>> 0);
H[OP.PSUBQ] = lanes('u64', (a, b) => BigInt.asUintN(64, a - b));
H[OP.PADDSB] = lanes('i8', (a, b) => sat(a + b, -128, 127)); H[OP.PADDSW] = lanes('i16', (a, b) => sat(a + b, -32768, 32767));
H[OP.PSUBSB] = lanes('i8', (a, b) => sat(a - b, -128, 127)); H[OP.PSUBSW] = lanes('i16', (a, b) => sat(a - b, -32768, 32767));
H[OP.PADDUSB] = lanes('u8', (a, b) => sat(a + b, 0, 255)); H[OP.PADDUSW] = lanes('u16', (a, b) => sat(a + b, 0, 65535));
H[OP.PSUBUSB] = lanes('u8', (a, b) => sat(a - b, 0, 255)); H[OP.PSUBUSW] = lanes('u16', (a, b) => sat(a - b, 0, 65535));
H[OP.PCMPEQB] = lanes('u8', (a, b) => (a === b ? 0xff : 0)); H[OP.PCMPEQW] = lanes('u16', (a, b) => (a === b ? 0xffff : 0));
H[OP.PCMPEQD] = lanes('u32', (a, b) => (a === b ? 0xffffffff : 0));
H[OP.PCMPGTB] = lanes('i8', (a, b) => (a > b ? -1 : 0)); H[OP.PCMPGTW] = lanes('i16', (a, b) => (a > b ? -1 : 0));
H[OP.PCMPGTD] = lanes('i32', (a, b) => (a > b ? -1 : 0));
H[OP.PMULLW] = lanes('i16', (a, b) => a * b);
H[OP.PMULHW] = lanes('i16', (a, b) => (a * b) >> 16);
H[OP.PMULHUW] = lanes('u16', (a, b) => (a * b) >>> 16);
H[OP.PMINUB] = lanes('u8', (a, b) => (a < b ? a : b)); H[OP.PMAXUB] = lanes('u8', (a, b) => (a > b ? a : b));
H[OP.PMINSW] = lanes('i16', (a, b) => (a < b ? a : b)); H[OP.PMAXSW] = lanes('i16', (a, b) => (a > b ? a : b));
H[OP.PAVGB] = lanes('u8', (a, b) => (a + b + 1) >> 1); H[OP.PAVGW] = lanes('u16', (a, b) => (a + b + 1) >> 1);
H[OP.PMULUDQ] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
  load(I, d, A, n); load(I, s, B, n);
  for (let i = 0; i < n / 8; i++) R.u64[i] = BigInt(A.u32[2 * i]) * BigInt(B.u32[2 * i]);
  store(I, d, R, n);
};
H[OP.PMADDWD] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
  load(I, d, A, n); load(I, s, B, n);
  for (let i = 0; i < n / 4; i++) R.i32[i] = (A.i16[2 * i] * B.i16[2 * i] + A.i16[2 * i + 1] * B.i16[2 * i + 1]) | 0;
  store(I, d, R, n);
};
H[OP.PSADBW] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
  load(I, d, A, n); load(I, s, B, n);
  for (let q = 0; q < n / 8; q++) { let sum = 0; for (let i = 0; i < 8; i++) sum += Math.abs(A.u8[8 * q + i] - B.u8[8 * q + i]); R.u64[q] = BigInt(sum); }
  store(I, d, R, n);
};
function pack(srcV, dstV, lo, hi) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
    load(I, d, A, n); load(I, s, B, n);
    const cnt = n / A[srcV].BYTES_PER_ELEMENT;
    for (let i = 0; i < cnt; i++) { R[dstV][i] = sat(A[srcV][i], lo, hi); R[dstV][cnt + i] = sat(B[srcV][i], lo, hi); }
    store(I, d, R, n);
  };
}
H[OP.PACKSSWB] = pack('i16', 'i8', -128, 127);
H[OP.PACKSSDW] = pack('i32', 'i16', -32768, 32767);
H[OP.PACKUSWB] = pack('i16', 'u8', 0, 255);

// shifts
function pshift(V, width, kind) { // kind: 'l' left, 'r' logical right, 'a' arithmetic right
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const n = vsize(d);
    load(I, d, A, n);
    let cnt;
    if (s.t === OT.IMM) cnt = s.v;
    else { load(I, s, B, s.t === OT.MEM ? 8 : vsize(s)); cnt = B.u64[0] > 255n ? 255 : Number(B.u64[0]); }
    const lanesN = n / (width / 8);
    for (let i = 0; i < lanesN; i++) {
      let v = A[V][i];
      if (width === 64) {
        const c = BigInt(cnt);
        if (kind === 'l') v = cnt >= 64 ? 0n : BigInt.asUintN(64, v << c);
        else v = cnt >= 64 ? 0n : v >> c;
      } else if (cnt >= width) v = kind === 'a' ? (v < 0 ? -1 : 0) : 0;
      else if (kind === 'l') v = v << cnt;
      else if (kind === 'r') v = (v >>> cnt);
      else v = v >> cnt;
      R[V][i] = v;
    }
    store(I, d, R, n);
  };
}
H[OP.PSLLW] = pshift('u16', 16, 'l'); H[OP.PSLLD] = pshift('u32', 32, 'l'); H[OP.PSLLQ] = pshift('u64', 64, 'l');
H[OP.PSRLW] = pshift('u16', 16, 'r'); H[OP.PSRLD] = pshift('u32', 32, 'r'); H[OP.PSRLQ] = pshift('u64', 64, 'r');
H[OP.PSRAW] = pshift('i16', 16, 'a'); H[OP.PSRAD] = pshift('i32', 32, 'a');
H[OP.PSLLDQ] = (I, insn) => { load(I, insn.ops[0], A, 16); const c = Math.min(insn.ops[1].v, 16); R.u8.fill(0); R.u8.set(A.u8.subarray(0, 16 - c), c); store(I, insn.ops[0], R, 16); };
H[OP.PSRLDQ] = (I, insn) => { load(I, insn.ops[0], A, 16); const c = Math.min(insn.ops[1].v, 16); R.u8.fill(0); R.u8.set(A.u8.subarray(c, 16), 0); store(I, insn.ops[0], R, 16); };

// conversions
H[OP.CVTSI2SS] = (I, insn) => { load(I, insn.ops[0], A, 16); A.f32[0] = Math.fround(I.rd(insn.ops[1]) | 0); store(I, insn.ops[0], A, 16); };
H[OP.CVTSI2SD] = (I, insn) => { load(I, insn.ops[0], A, 16); A.f64[0] = I.rd(insn.ops[1]) | 0; store(I, insn.ops[0], A, 16); };
function cvt2si(double, trunc) {
  return (I, insn) => {
    const s = insn.ops[1]; load(I, s, B, s.t === OT.MEM ? (double ? 8 : 4) : 16);
    I.cpu.setReg(insn.ops[0].r, toInt32(I, double ? B.f64[0] : B.f32[0], trunc));
  };
}
H[OP.CVTSS2SI] = cvt2si(false, false); H[OP.CVTTSS2SI] = cvt2si(false, true);
H[OP.CVTSD2SI] = cvt2si(true, false); H[OP.CVTTSD2SI] = cvt2si(true, true);
H[OP.CVTSS2SD] = (I, insn) => { const s = insn.ops[1]; load(I, insn.ops[0], A, 16); load(I, s, B, s.t === OT.MEM ? 4 : 16); A.f64[0] = B.f32[0]; store(I, insn.ops[0], A, 16); };
H[OP.CVTSD2SS] = (I, insn) => { const s = insn.ops[1]; load(I, insn.ops[0], A, 16); load(I, s, B, s.t === OT.MEM ? 8 : 16); A.f32[0] = Math.fround(B.f64[0]); store(I, insn.ops[0], A, 16); };
H[OP.CVTPS2PD] = (I, insn) => { const s = insn.ops[1]; load(I, s, B, s.t === OT.MEM ? 8 : 16); R.f64[0] = B.f32[0]; R.f64[1] = B.f32[1]; store(I, insn.ops[0], R, 16); };
H[OP.CVTPD2PS] = (I, insn) => { load(I, insn.ops[1], B, 16); R.f32[0] = Math.fround(B.f64[0]); R.f32[1] = Math.fround(B.f64[1]); R.u64[1] = 0n; store(I, insn.ops[0], R, 16); };
H[OP.CVTDQ2PS] = (I, insn) => { load(I, insn.ops[1], B, 16); for (let i = 0; i < 4; i++) R.f32[i] = Math.fround(B.i32[i]); store(I, insn.ops[0], R, 16); };
H[OP.CVTPS2DQ] = (I, insn) => { load(I, insn.ops[1], B, 16); for (let i = 0; i < 4; i++) R.u32[i] = toInt32(I, B.f32[i], false); store(I, insn.ops[0], R, 16); };
H[OP.CVTTPS2DQ] = (I, insn) => { load(I, insn.ops[1], B, 16); for (let i = 0; i < 4; i++) R.u32[i] = toInt32(I, B.f32[i], true); store(I, insn.ops[0], R, 16); };
H[OP.CVTDQ2PD] = (I, insn) => { const s = insn.ops[1]; load(I, s, B, s.t === OT.MEM ? 8 : 16); R.f64[0] = B.i32[0]; R.f64[1] = B.i32[1]; store(I, insn.ops[0], R, 16); };
H[OP.CVTPD2DQ] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = toInt32(I, B.f64[0], false); R.u32[1] = toInt32(I, B.f64[1], false); R.u64[1] = 0n; store(I, insn.ops[0], R, 16); };
H[OP.CVTTPD2DQ] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = toInt32(I, B.f64[0], true); R.u32[1] = toInt32(I, B.f64[1], true); R.u64[1] = 0n; store(I, insn.ops[0], R, 16); };
H[OP.CVTPI2PS] = (I, insn) => { load(I, insn.ops[0], A, 16); load(I, insn.ops[1], B, 8); A.f32[0] = Math.fround(B.i32[0]); A.f32[1] = Math.fround(B.i32[1]); store(I, insn.ops[0], A, 16); };
H[OP.CVTPI2PD] = (I, insn) => { load(I, insn.ops[1], B, 8); R.f64[0] = B.i32[0]; R.f64[1] = B.i32[1]; store(I, insn.ops[0], R, 16); };
H[OP.CVTPS2PI] = (I, insn) => { const s = insn.ops[1]; load(I, s, B, s.t === OT.MEM ? 8 : 16); R.u32[0] = toInt32(I, B.f32[0], false); R.u32[1] = toInt32(I, B.f32[1], false); store(I, insn.ops[0], R, 8); };
H[OP.CVTTPS2PI] = (I, insn) => { const s = insn.ops[1]; load(I, s, B, s.t === OT.MEM ? 8 : 16); R.u32[0] = toInt32(I, B.f32[0], true); R.u32[1] = toInt32(I, B.f32[1], true); store(I, insn.ops[0], R, 8); };
H[OP.CVTPD2PI] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = toInt32(I, B.f64[0], false); R.u32[1] = toInt32(I, B.f64[1], false); store(I, insn.ops[0], R, 8); };
H[OP.CVTTPD2PI] = (I, insn) => { load(I, insn.ops[1], B, 16); R.u32[0] = toInt32(I, B.f64[0], true); R.u32[1] = toInt32(I, B.f64[1], true); store(I, insn.ops[0], R, 8); };

export {};

// x87 FPU handlers for the reference interpreter. Registers are emulated as f64 (see D005);
// precision control (24/53-bit) is honoured on arithmetic results, rounding control on integer
// conversions and FRNDINT. Masked-exception responses (indefinite NaN/integer) are reproduced
// so that stack faults behave like hardware.
import { H, CpuFault } from './interp.js';
import { OP, OT } from './decoder.js';
import { F } from './state.js';

// Status word bits
const SW_IE = 1 << 0, SW_DE = 1 << 1, SW_ZE = 1 << 2, SW_OE = 1 << 3, SW_UE = 1 << 4, SW_PE = 1 << 5;
const SW_SF = 1 << 6, SW_ES = 1 << 7;
const C0 = 1 << 8, C1 = 1 << 9, C2 = 1 << 10, C3 = 1 << 14;
const SW_CC = C0 | C1 | C2 | C3;

const INDEFINITE_BITS = 0xfff8000000000000n;
const scratch = new DataView(new ArrayBuffer(16));
scratch.setBigUint64(0, INDEFINITE_BITS, true);
const INDEFINITE = scratch.getFloat64(0, true); // -NaN (payload is not preserved by JS)

/** x87 helper bound to an interpreter. */
class X87 {
  constructor(I) { this.I = I; this.cpu = I.cpu; this.mem = I.mem; }
  get cw() { return this.cpu.fpuCw; }
  get sw() { return this.cpu.fpuSw; }
  set sw(v) { this.cpu.fpuSw = v & 0xffff; }
  get top() { return this.cpu.fpuTop; }
  set top(v) { this.cpu.fpuTop = v & 7; }
  get tw() { return this.cpu.fpuTw; }
  set tw(v) { this.cpu.fpuTw = v & 0xff; }

  phys(i) { return (this.top + i) & 7; }
  isEmpty(i) { return !((this.tw >> this.phys(i)) & 1); }
  setValid(i, valid) {
    const p = this.phys(i);
    this.tw = valid ? this.tw | (1 << p) : this.tw & ~(1 << p);
  }
  setCC(c0, c1, c2, c3) {
    let s = this.sw & ~SW_CC;
    if (c0) s |= C0;
    if (c1) s |= C1;
    if (c2) s |= C2;
    if (c3) s |= C3;
    this.sw = s;
  }
  clearC1() { this.sw = this.sw & ~C1; }
  /**
   * Raise exception flags. A masked exception only sets its flag; ES (the error summary) is set
   * when one of them is unmasked in the control word (mask bits CW[0..5] = IE DE ZE OE UE PE,
   * SDM 8.1.3); nothing else happens on an unmasked exception (no fault is delivered, D034).
   */
  raise(bits) {
    let sw = this.sw | bits;
    if (bits & ~this.cw & 0x3f) sw |= SW_ES;
    this.sw = sw;
  }
  /** Result of a one-operand instruction given a NaN operand: an SNaN raises IE and is quieted, a QNaN propagates. */
  nan1(a) {
    if (isSignalingNaN(a)) { this.raise(SW_IE); return quietNaN(a); }
    return a;
  }
  /**
   * Result of a two-operand instruction with at least one NaN operand (x87 rule, SDM 4.8.3.5,
   * measured in D034): the NaN operand, or with two NaNs the one with the larger significand
   * (the positive one on a tie), quieted; an SNaN among the operands raises IE.
   */
  nan2(a, b) {
    if (isSignalingNaN(a) || isSignalingNaN(b)) this.raise(SW_IE);
    if (!Number.isNaN(a)) return quietNaN(b);
    if (!Number.isNaN(b)) return quietNaN(a);
    return quietNaN(pickNaN(a, b));
  }

  /** Read ST(i); stack underflow yields indefinite. */
  st(i) {
    if (this.isEmpty(i)) { this.raise(SW_IE | SW_SF); this.clearC1(); return INDEFINITE; }
    return this.cpu.fpr(this.phys(i));
  }
  setSt(i, v) { this.cpu.setFpr(this.phys(i), v); this.setValid(i, true); }

  push(v) {
    this.top = this.top - 1;
    if (!this.isEmpty(0)) { // stack overflow (masked): ST(0) = indefinite, C1 = 1
      this.raise(SW_IE | SW_SF);
      this.sw = this.sw | C1;
      v = INDEFINITE;
    }
    this.setSt(0, v);
  }
  pop() {
    this.setValid(0, false);
    this.top = this.top + 1;
  }

  /**
   * Round an arithmetic result according to precision control. PC=24 reduces the mantissa to
   * 24 bits but keeps the extended exponent range (no overflow/underflow to float limits).
   * PC=53/64: the f64 result is already nearest-rounded; directed rounding is not emulated there.
   */
  round(v, errSign = 0) {
    const pc = (this.cw >> 8) & 3;
    if (pc === 0) return roundMant24(v, (this.cw >> 10) & 3, errSign);
    return v;
  }
  /** Value to store for FST m32 honouring the rounding control. */
  toF32(v) { return storeF32(v, (this.cw >> 10) & 3); }
  /** Round to integer according to rounding control. */
  rint(v, rc = (this.cw >> 10) & 3) {
    if (!Number.isFinite(v)) return v;
    switch (rc) {
      case 0: return roundEven(v);
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      default: return Math.trunc(v);
    }
  }
  arith(a, b, op) {
    let r, err = 0;
    // In single-precision mode the exact error term of the f64 operation lets us apply the
    // rounding mode exactly (no double-rounding artefacts).
    const pc24 = ((this.cw >> 8) & 3) === 0;
    switch (op) {
      case 0: r = a + b; if (pc24) err = twoSumErr(a, b, r); break;
      case 1: r = a * b; if (pc24) err = twoProdErr(a, b, r); break;
      case 4: r = a - b; if (pc24) err = twoSumErr(a, -b, r); break;
      case 5: r = b - a; if (pc24) err = twoSumErr(b, -a, r); break;
      case 6: r = a / b; if (pc24) err = divErr(a, b, r); break;
      default: r = b / a; if (pc24) err = divErr(b, a, r); break;
    }
    if (Number.isNaN(r)) {
      if (!Number.isNaN(a) && !Number.isNaN(b)) { this.raise(SW_IE); return INDEFINITE; } // inf-inf, 0*inf, 0/0
      return this.nan2(a, b); // the hardware rule (D034), as for the two-operand transcendentals
    }
    if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) {
      if ((op === 6 && b === 0) || (op === 7 && a === 0)) this.raise(SW_ZE); else this.raise(SW_OE);
    }
    return this.round(r, err > 0 ? 1 : err < 0 ? -1 : 0);
  }
  compare(a, b, quiet) {
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (!quiet || isSignalingNaN(a) || isSignalingNaN(b)) this.raise(SW_IE);
      this.setCC(1, 0, 1, 1);
      return;
    }
    if (a > b) this.setCC(0, 0, 0, 0);
    else if (a < b) this.setCC(1, 0, 0, 0);
    else this.setCC(0, 0, 0, 1);
  }
  compareEflags(a, b, quiet) {
    let f = this.I.flags & ~(F.ZF | F.PF | F.CF | F.OF | F.SF | F.AF);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (!quiet || isSignalingNaN(a) || isSignalingNaN(b)) this.raise(SW_IE);
      f |= F.ZF | F.PF | F.CF;
    } else if (a < b) f |= F.CF;
    else if (a === b) f |= F.ZF;
    this.I.flags = f >>> 0;
    this.clearC1();
  }

  // ---- memory operand conversions
  loadOp(o) {
    const a = this.I.ea(o);
    switch (o.size) {
      case 4: return this.mem.readF32(a);
      case 8: return this.mem.readF64(a);
      case 10: return readF80(this.mem, a);
    }
    throw new Error('bad fp operand size');
  }
  loadInt(o) {
    const a = this.I.ea(o);
    switch (o.size) {
      case 2: return this.mem.readS16(a);
      case 4: return this.mem.readS32(a);
      case 8: return Number(this.mem.dv.getBigInt64(a, true));
    }
    throw new Error('bad int operand size');
  }
  storeFp(o, v) {
    const a = this.I.ea(o);
    switch (o.size) {
      case 4: this.mem.writeF32(a, v); break;
      case 8: this.mem.writeF64(a, v); break;
      case 10: writeF80(this.mem, a, v); break;
    }
  }
  storeInt(o, v, truncate) {
    const a = this.I.ea(o);
    const r = truncate ? Math.trunc(v) : this.rint(v);
    switch (o.size) {
      case 2:
        if (!(r >= -32768 && r <= 32767)) { this.raise(SW_IE); this.mem.write16(a, 0x8000); }
        else { this.mem.write16(a, r & 0xffff); if (r !== v) this.raise(SW_PE); }
        break;
      case 4:
        if (!(r >= -2147483648 && r <= 2147483647)) { this.raise(SW_IE); this.mem.write32(a, 0x80000000); }
        else { this.mem.write32(a, r >>> 0); if (r !== v) this.raise(SW_PE); }
        break;
      case 8:
        if (!(r >= -9223372036854775808 && r < 9223372036854775808) || Number.isNaN(r)) { this.raise(SW_IE); this.mem.write64(a, 0x8000000000000000n); }
        else { this.mem.write64(a, BigInt.asUintN(64, BigInt(r))); if (r !== v) this.raise(SW_PE); }
        break;
    }
  }
}

const FLT_MAX = 3.4028234663852886e38;
const FLT_MIN = 1.1754943508222875e-38;
// Error-free transformations (exact error of an f64 operation), used for exact directed rounding.
function twoSumErr(a, b, s) {
  if (!Number.isFinite(s)) return 0;
  const bb = s - a;
  return (a - (s - bb)) + (b - bb);
}
const SPLIT = 134217729; // 2^27 + 1
function twoProdErr(a, b, p) {
  if (!Number.isFinite(p) || p === 0) return 0;
  const aa = Math.abs(a), ab = Math.abs(b);
  if (aa > 2 ** 500 || ab > 2 ** 500 || aa < 2 ** -500 || ab < 2 ** -500) return 0; // splitting would over/underflow
  let t = SPLIT * a; const ah = t - (t - a), al = a - ah;
  t = SPLIT * b; const bh = t - (t - b), bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}
function divErr(a, b, q) { // sign of (a/b - q)
  if (!Number.isFinite(q) || q === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const p = q * b;
  const pe = twoProdErr(q, b, p);
  const e = (a - p) - pe; // a - q*b (exact remainder)
  return b > 0 ? e : -e;
}
function sqrtErr(a, r) {
  if (!Number.isFinite(r) || r === 0) return 0;
  const p = r * r;
  return (a - p) - twoProdErr(r, r, p);
}

/**
 * Round the mantissa of v to 24 bits with rounding mode rc (0 nearest, 1 down, 2 up, 3 trunc).
 * errSign: sign of (exact - v) when v is itself a rounded f64 result (0 if v is exact).
 */
function roundMant24(v, rc, errSign = 0) {
  if (v === 0 || !Number.isFinite(v)) return v;
  let e = Math.floor(Math.log2(Math.abs(v)));
  let m = scalb(v, -e);
  if (Math.abs(m) >= 2) { m /= 2; e++; } else if (Math.abs(m) < 1) { m *= 2; e--; }
  let r = Math.fround(m);
  const ulp = 2 ** -23;
  const sgn = m < 0 ? -1 : 1;
  const stepDown = (x) => (Math.abs(x) === 1 ? x - sgn * 2 ** -24 : x - sgn * ulp); // decrease magnitude
  const stepUp = (x) => x + sgn * ulp; // increase magnitude
  if (rc === 0) {
    if (errSign !== 0 && r !== m && Math.abs(m - r) === 2 ** -24) {
      // m sits exactly on a 24-bit midpoint but the exact value is beyond it: round toward it
      const above = errSign * sgn > 0; // exact magnitude larger than |m|
      r = above ? (Math.abs(r) > Math.abs(m) ? r : stepUp(r)) : (Math.abs(r) < Math.abs(m) ? r : stepDown(r));
    }
  } else if (r !== m) {
    if (rc === 1) { if (r > m) r -= ulp; }
    else if (rc === 2) { if (r < m) r += ulp; }
    else if (Math.abs(r) > Math.abs(m)) r = stepDown(r);
  } else if (errSign !== 0) {
    // v representable at 24 bits but the exact value lies just beside it
    if (rc === 1) { if (errSign < 0) r = sgn > 0 ? stepDown(r) : stepUp(r); }
    else if (rc === 2) { if (errSign > 0) r = sgn > 0 ? stepUp(r) : stepDown(r); }
    else if (errSign * sgn < 0) r = stepDown(r);
  }
  return scalb(r, e);
}
/** Convert to a float32 value (what FST m32 writes) with rounding mode rc. */
function storeF32(v, rc) {
  if (v === 0 || !Number.isFinite(v)) return v;
  if (Math.abs(v) < FLT_MIN) { // denormal float range: granularity 2^-149
    let r = Math.fround(v);
    if (rc !== 0 && r !== v) {
      const d = 2 ** -149;
      if (rc === 1) { if (r > v) r -= d; }
      else if (rc === 2) { if (r < v) r += d; }
      else if (Math.abs(r) > Math.abs(v)) r -= Math.sign(r) * d;
      if (r === 0) r = v < 0 ? -0 : 0; // a step to zero keeps the sign (-2^-149 + 2^-149 is +0 in IEEE arithmetic)
    }
    return r;
  }
  const r = roundMant24(v, rc);
  if (Math.abs(r) > FLT_MAX) {
    if (rc === 0) return r > 0 ? Infinity : -Infinity;
    if (rc === 1) return r > 0 ? FLT_MAX : -Infinity;
    if (rc === 2) return r > 0 ? Infinity : -FLT_MAX;
    return r > 0 ? FLT_MAX : -FLT_MAX;
  }
  return r;
}

function roundEven(v) {
  const f = Math.floor(v);
  const d = v - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return r === 0 && (v < 0 || Object.is(v, -0)) ? -0 : r; // a zero keeps the operand's sign (-0.5 -> -0, IEEE)
}

function isSignalingNaN(v) {
  if (!Number.isNaN(v)) return false;
  scratch.setFloat64(0, v, true);
  return (scratch.getBigUint64(0, true) & 0x0008000000000000n) === 0n;
}

/** The NaN v with its quiet bit set (sign and payload kept). */
function quietNaN(v) {
  scratch.setFloat64(0, v, true);
  scratch.setBigUint64(0, scratch.getBigUint64(0, true) | 0x0008000000000000n, true);
  return scratch.getFloat64(0, true);
}
/** Of two NaNs, the one with the larger significand (52-bit fraction, quiet bit included); the positive one on a tie. */
function pickNaN(a, b) {
  scratch.setFloat64(0, a, true); scratch.setFloat64(8, b, true);
  const ab = scratch.getBigUint64(0, true), bb = scratch.getBigUint64(8, true);
  const fa = ab & 0x000fffffffffffffn, fb = bb & 0x000fffffffffffffn;
  return fa > fb || (fa === fb && ab < 0x8000000000000000n) ? a : b;
}

/** Read 80-bit extended from memory as f64. */
export function readF80(mem, a) {
  const mant = mem.read64(a);
  const se = mem.read16(a + 8);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  if (exp === 0 && mant === 0n) return sign * 0;
  if (exp === 0x7fff) {
    if ((mant & 0x7fffffffffffffffn) === 0n) return sign * Infinity;
    // NaN: sign, quiet bit (bit 62 -> 51) and the top 51 payload bits are kept (writeF80 restores them)
    let frac = (mant >> 11n) & 0x000fffffffffffffn;
    if (frac === 0n) frac = 0x0008000000000000n; // payload only in the low bits: a quiet NaN
    scratch.setBigUint64(0, (se & 0x8000 ? 0xfff0000000000000n : 0x7ff0000000000000n) | frac, true);
    return scratch.getFloat64(0, true);
  }
  let r = Number(mant);
  let e = exp - 16383 - 63;
  while (e > 1000) { r *= 2 ** 1000; e -= 1000; }
  while (e < -1000) { r *= 2 ** -1000; e += 1000; }
  return sign * (r * 2 ** e);
}

/** Write f64 as 80-bit extended (exact). */
export function writeF80(mem, a, x) {
  scratch.setFloat64(0, x, true);
  const bits = scratch.getBigUint64(0, true);
  const sign = Number(bits >> 63n);
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let m, se;
  if (exp === 0) {
    if (mant === 0n) { m = 0n; se = sign << 15; }
    else {
      let e = -1022;
      while (!(mant & (1n << 52n))) { mant <<= 1n; e--; }
      mant &= (1n << 52n) - 1n;
      m = (1n << 63n) | (mant << 11n); se = (sign << 15) | (e + 16383);
    }
  } else if (exp === 0x7ff) {
    m = (1n << 63n) | (mant << 11n); se = (sign << 15) | 0x7fff; // infinity, or a NaN with its sign, quiet bit and payload
  } else {
    m = (1n << 63n) | (mant << 11n); se = (sign << 15) | (exp - 1023 + 16383);
  }
  mem.write64(a, m);
  mem.write16(a + 8, se);
}

function x87(I) { return I._x87 || (I._x87 = new X87(I)); }

// ---- loads / stores
H[OP.FLD] = (I, insn) => {
  const x = x87(I); const o = insn.ops[0];
  let v;
  if (o.t === OT.ST) v = x.st(o.r);
  else v = x.loadOp(o);
  x.clearC1();
  x.push(v);
};
H[OP.FILD] = (I, insn) => { const x = x87(I); x.clearC1(); x.push(x.loadInt(insn.ops[0])); };
H[OP.FST] = (I, insn) => {
  const x = x87(I); const o = insn.ops[0]; const v = x.st(0);
  x.clearC1();
  if (o.t === OT.ST) x.setSt(o.r, v); else x.storeFp(o, o.size === 4 ? x.toF32(v) : v);
};
H[OP.FSTP] = (I, insn) => {
  const x = x87(I); const o = insn.ops[0]; const v = x.st(0);
  x.clearC1();
  if (o.t === OT.ST) x.setSt(o.r, v); else x.storeFp(o, o.size === 4 ? x.toF32(v) : v);
  x.pop();
};
H[OP.FIST] = (I, insn) => { const x = x87(I); x.clearC1(); x.storeInt(insn.ops[0], x.st(0), false); };
H[OP.FISTP] = (I, insn) => { const x = x87(I); x.clearC1(); x.storeInt(insn.ops[0], x.st(0), false); x.pop(); };
H[OP.FISTTP] = (I, insn) => { const x = x87(I); x.clearC1(); x.storeInt(insn.ops[0], x.st(0), true); x.pop(); };
H[OP.FBLD] = (I, insn) => {
  const x = x87(I); const a = I.ea(insn.ops[0]);
  let v = 0;
  for (let i = 8; i >= 0; i--) { const b = I.mem.read8(a + i); v = v * 100 + (b >> 4) * 10 + (b & 15); }
  if (I.mem.read8(a + 9) & 0x80) v = -v;
  x.clearC1(); x.push(v);
};
H[OP.FBSTP] = (I, insn) => {
  const x = x87(I); const a = I.ea(insn.ops[0]);
  let v = x.rint(x.st(0));
  const neg = v < 0 || Object.is(v, -0);
  v = Math.abs(v);
  if (!Number.isFinite(v) || v >= 1e18) { for (let i = 0; i < 7; i++) I.mem.write8(a + i, 0); I.mem.write8(a + 7, 0xc0); I.mem.write8(a + 8, 0xff); I.mem.write8(a + 9, 0xff); x.raise(SW_IE); }
  else {
    let big = BigInt(v);
    for (let i = 0; i < 9; i++) { const d = Number(big % 100n); big /= 100n; I.mem.write8(a + i, ((d / 10) << 4) | (d % 10)); }
    I.mem.write8(a + 9, neg ? 0x80 : 0);
  }
  x.clearC1(); x.pop();
};

// ---- constants
const constant = (v) => (I) => { const x = x87(I); x.clearC1(); x.push(v); };
H[OP.FLD1] = constant(1);
H[OP.FLDZ] = constant(0);
H[OP.FLDPI] = constant(Math.PI);
H[OP.FLDL2E] = constant(Math.LOG2E);
H[OP.FLDL2T] = constant(Math.log2(10));
H[OP.FLDLG2] = constant(Math.LOG10E * Math.LN2);
H[OP.FLDLN2] = constant(Math.LN2);

// ---- arithmetic
// op codes: 0 add, 1 mul, 4 sub, 5 subr, 6 div, 7 divr (matching D8 /r ordering)
function arithHandler(op, pop, integer) {
  return (I, insn) => {
    const x = x87(I);
    x.clearC1();
    if (insn.ops.length === 2 && insn.ops[0].t === OT.ST && insn.ops[1].t === OT.ST) {
      // ST(d) <- ST(d) op ST(s)
      const d = insn.ops[0].r, s = insn.ops[1].r;
      const a = x.st(d), b = x.st(s);
      x.setSt(d, x.arith(a, b, op));
    } else {
      const o = insn.ops[insn.ops.length - 1];
      const a = x.st(0);
      let b;
      if (o.t === OT.ST) b = x.st(o.r);
      else b = integer ? x.loadInt(o) : x.loadOp(o);
      x.setSt(0, x.arith(a, b, op));
    }
    if (pop) x.pop();
  };
}
H[OP.FADD] = arithHandler(0, false, false); H[OP.FADDP] = arithHandler(0, true, false); H[OP.FIADD] = arithHandler(0, false, true);
H[OP.FMUL] = arithHandler(1, false, false); H[OP.FMULP] = arithHandler(1, true, false); H[OP.FIMUL] = arithHandler(1, false, true);
H[OP.FSUB] = arithHandler(4, false, false); H[OP.FSUBP] = arithHandler(4, true, false); H[OP.FISUB] = arithHandler(4, false, true);
H[OP.FSUBR] = arithHandler(5, false, false); H[OP.FSUBRP] = arithHandler(5, true, false); H[OP.FISUBR] = arithHandler(5, false, true);
H[OP.FDIV] = arithHandler(6, false, false); H[OP.FDIVP] = arithHandler(6, true, false); H[OP.FIDIV] = arithHandler(6, false, true);
H[OP.FDIVR] = arithHandler(7, false, false); H[OP.FDIVRP] = arithHandler(7, true, false); H[OP.FIDIVR] = arithHandler(7, false, true);

// ---- comparisons
function cmpHandler(pops, quiet, integer, eflags) {
  return (I, insn) => {
    const x = x87(I);
    const a = x.st(0);
    let b;
    if (insn.ops.length === 0) b = x.st(1);
    else {
      const o = insn.ops[insn.ops.length - 1];
      if (o.t === OT.ST) b = x.st(o.r);
      else b = integer ? x.loadInt(o) : x.loadOp(o);
    }
    if (eflags) x.compareEflags(a, b, quiet); else { x.compare(a, b, quiet); x.clearC1(); }
    for (let i = 0; i < pops; i++) x.pop();
  };
}
H[OP.FCOM] = cmpHandler(0, false, false, false); H[OP.FCOMP] = cmpHandler(1, false, false, false); H[OP.FCOMPP] = cmpHandler(2, false, false, false);
H[OP.FUCOM] = cmpHandler(0, true, false, false); H[OP.FUCOMP] = cmpHandler(1, true, false, false); H[OP.FUCOMPP] = cmpHandler(2, true, false, false);
H[OP.FICOM] = cmpHandler(0, false, true, false); H[OP.FICOMP] = cmpHandler(1, false, true, false);
H[OP.FCOMI] = cmpHandler(0, false, false, true); H[OP.FCOMIP] = cmpHandler(1, false, false, true);
H[OP.FUCOMI] = cmpHandler(0, true, false, true); H[OP.FUCOMIP] = cmpHandler(1, true, false, true);
H[OP.FTST] = (I) => { const x = x87(I); x.compare(x.st(0), 0, false); x.clearC1(); };
H[OP.FXAM] = (I) => {
  const x = x87(I);
  let c0 = 0, c2 = 0, c3 = 0, c1 = 0;
  if (x.isEmpty(0)) { c0 = 1; c3 = 1; const v = x.cpu.fpr(x.phys(0)); c1 = (v < 0 || Object.is(v, -0)) ? 1 : 0; }
  else {
    const v = x.cpu.fpr(x.phys(0));
    c1 = (v < 0 || Object.is(v, -0) || (Number.isNaN(v) && signOfNaN(v))) ? 1 : 0;
    if (Number.isNaN(v)) c0 = 1;
    else if (!Number.isFinite(v)) { c0 = 1; c2 = 1; }
    else if (v === 0) c3 = 1;
    else if (Math.abs(v) < 2.2250738585072014e-308) { c2 = 1; c3 = 1; }
    else c2 = 1;
  }
  x.setCC(c0, c1, c2, c3);
};
function signOfNaN(v) { scratch.setFloat64(0, v, true); return (scratch.getUint8(7) & 0x80) !== 0; }

// ---- unary
H[OP.FCHS] = (I) => { const x = x87(I); x.clearC1(); x.setSt(0, -x.st(0)); };
H[OP.FABS] = (I) => { const x = x87(I); x.clearC1(); x.setSt(0, Math.abs(x.st(0))); };
H[OP.FSQRT] = (I) => {
  const x = x87(I); x.clearC1(); const v = x.st(0);
  if (Number.isNaN(v)) x.setSt(0, x.nan1(v));
  else if (v < 0) { x.raise(SW_IE); x.setSt(0, INDEFINITE); }
  else { const r = Math.sqrt(v); const e = ((x.cw >> 8) & 3) === 0 ? sqrtErr(v, r) : 0; x.setSt(0, x.round(r, e > 0 ? 1 : e < 0 ? -1 : 0)); }
};
H[OP.FRNDINT] = (I) => { const x = x87(I); x.clearC1(); x.setSt(0, x.rint(x.st(0))); };
// FSCALE: ST(0) * 2^trunc(ST(1)). 0 * 2^+inf and inf * 2^-inf are invalid (IE, indefinite); the
// other infinite scales give +-inf / +-0 (SDM table 8-11, hardware D034)
H[OP.FSCALE] = (I) => {
  const x = x87(I); x.clearC1();
  const a = x.st(0), b = x.st(1);
  if (Number.isNaN(a) || Number.isNaN(b)) { x.setSt(0, x.nan2(a, b)); return; }
  if (!Number.isFinite(b)) {
    const invalid = b > 0 ? a === 0 : !Number.isFinite(a);
    if (invalid) { x.raise(SW_IE); x.setSt(0, INDEFINITE); } else x.setSt(0, b > 0 ? a * Infinity : a * 0);
    return;
  }
  x.setSt(0, scalb(a, Math.trunc(b)));
};
/**
 * a * 2^e rounded once, like the hardware and the JIT kernel (fpmath-exp.js scalb): the exponent
 * of the exact result decides between overflow, an exact exponent rewrite and the denormal range,
 * where the mantissa placed at exponent -1022 is multiplied by one (possibly denormal) power of
 * two, which is the single correct rounding. Stepping by 2^-1000 would round twice down there
 * (1.25 2^-74 by 2^-1001: 0 instead of 2^-1074).
 */
function scalb(a, e) {
  if (a === 0 || !Number.isFinite(a)) return a;
  if (e > 2200) e = 2200; else if (e < -2200) e = -2200; // beyond, every finite non-zero double overflows / underflows
  scratch.setFloat64(0, a, true);
  let hi = scratch.getUint32(4, true);
  let be = (hi >>> 20) & 0x7ff;
  if (be === 0) { scratch.setFloat64(0, a * 2 ** 54, true); hi = scratch.getUint32(4, true); be = (hi >>> 20) & 0x7ff; e -= 54; } // denormal a: normalized (exact)
  const t = be - 1023 + e; // exponent of the exact result
  if (t > 1023) return a > 0 ? Infinity : -Infinity;
  const signMant = hi & 0x800fffff;
  if (t >= -1022) { scratch.setUint32(4, signMant | ((t + 1023) << 20), true); return scratch.getFloat64(0, true); }
  scratch.setUint32(4, signMant | (1 << 20), true); // mantissa at exponent -1022 (exact)
  const m = scratch.getFloat64(0, true);
  const n = Math.max(t + 1022, -1074); // 2^n: a normal or denormal power of two (n < -1074 gives 0 as well)
  if (n >= -1022) { scratch.setUint32(0, 0, true); scratch.setUint32(4, (n + 1023) << 20, true); } else { scratch.setBigUint64(0, 1n << BigInt(n + 1074), true); }
  return m * scratch.getFloat64(0, true);
}
H[OP.FXTRACT] = (I) => {
  const x = x87(I); x.clearC1();
  const v = x.st(0);
  if (v === 0) { x.raise(SW_ZE); x.setSt(0, -Infinity); x.push(v); return; }
  if (!Number.isFinite(v)) { if (Number.isNaN(v)) { x.setSt(0, v); x.push(v); } else { x.setSt(0, Infinity); x.push(v); } return; }
  const e = Math.floor(Math.log2(Math.abs(v)));
  let sig = scalb(v, -e);
  // guard against log2 rounding
  if (Math.abs(sig) >= 2) { sig /= 2; x.setSt(0, e + 1); } else if (Math.abs(sig) < 1) { sig *= 2; x.setSt(0, e - 1); } else x.setSt(0, e);
  x.push(sig);
};
/** Decompose a finite non-zero double: |v| = mant * 2^exp (mant BigInt with the implicit bit). */
function decompose(v) {
  scratch.setFloat64(0, v, true);
  const bits = scratch.getBigUint64(0, true);
  const be = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let exp;
  if (be === 0) exp = -1074;
  else { mant |= 1n << 52n; exp = be - 1075; }
  return { mant, exp, top: exp + mant.toString(2).length - 1 }; // top = floor(log2|v|)
}
/** floor((A.mant*2^A.exp) / (B.mant*2^B.exp)) exactly. */
function bigFloorDiv(A, B) {
  if (A.exp >= B.exp) return (A.mant << BigInt(A.exp - B.exp)) / B.mant;
  return A.mant / (B.mant << BigInt(B.exp - A.exp));
}
function prem(I, nearest) {
  const x = x87(I);
  const a = x.st(0), b = x.st(1);
  if (Number.isNaN(a) || Number.isNaN(b)) { x.setSt(0, x.nan2(a, b)); x.setCC(0, 0, 0, 0); return; }
  if (!Number.isFinite(a) || b === 0) { x.raise(SW_IE); x.setSt(0, INDEFINITE); x.setCC(0, 0, 0, 0); return; }
  if (!Number.isFinite(b) || a === 0) { x.setSt(0, a); x.setCC(0, 0, 0, 0); return; }
  const A = decompose(a), B = decompose(b);
  const d = A.top - B.top;
  let q, r, partial = false;
  if (d < 64) {
    q = bigFloorDiv(A, B);
    r = a % b; // exact fmod, sign of a
    if (nearest) {
      const twoR = Math.abs(r) * 2, ab = Math.abs(b); // exact comparison
      if (twoR > ab || (twoR === ab && (q & 1n))) { q += 1n; r = r - Math.sign(a) * ab; }
    }
    if (r === 0) r = Math.sign(a) * 0;
  } else {
    partial = true;
    const n = d - 63;
    const bs = scalb(b, n);
    q = bigFloorDiv(A, { mant: B.mant, exp: B.exp + n });
    r = a % bs;
    if (r === 0) r = Math.sign(a) * 0;
  }
  x.setSt(0, r);
  const qi = Number(q & 7n);
  x.setCC(qi & 4 ? 1 : 0, qi & 1 ? 1 : 0, partial ? 1 : 0, qi & 2 ? 1 : 0);
}
H[OP.FPREM] = (I) => prem(I, false);
H[OP.FPREM1] = (I) => prem(I, true);
// ---- transcendentals (exception semantics measured on the hardware, D034; the JIT's
// translate-x87.js mirrors every rule). A NaN operand follows nan1 / nan2; a NaN produced from
// non-NaN operands is an invalid arithmetic operand: IE and the indefinite.
// F2XM1: finite |x| > 1 is undefined by the SDM and leaves ST(0) unchanged on the reference CPU
// (mirrored); +-inf follow the SDM (+inf -> +inf, -inf -> -1)
H[OP.F2XM1] = (I) => {
  const x = x87(I); x.clearC1(); const v = x.st(0);
  if (Number.isNaN(v)) { x.setSt(0, x.nan1(v)); return; }
  if (Math.abs(v) > 1 && Number.isFinite(v)) return;
  x.setSt(0, Math.expm1(v * Math.LN2));
};
// FYL2X: y log2 x. Invalid: x < 0, 0 log2 0, 0 log2 inf, inf log2 1 (the products are NaN);
// y log2 0 with a finite non-zero y is a zero divide (ZE, -+inf), with y = +-inf it is not.
H[OP.FYL2X] = (I) => {
  const x = x87(I); x.clearC1(); const a = x.st(0), b = x.st(1);
  let r;
  if (Number.isNaN(a) || Number.isNaN(b)) r = x.nan2(a, b);
  else {
    r = b * Math.log2(a);
    if (Number.isNaN(r)) { x.raise(SW_IE); r = INDEFINITE; }
    else if (a === 0 && Number.isFinite(b)) x.raise(SW_ZE);
  }
  x.setSt(1, r); x.pop();
};
// FYL2XP1: y log2(1 + x). Invalid: x < -1 (outside the SDM domain anyway), 0 log2(1 + inf) and inf log2 1
H[OP.FYL2XP1] = (I) => {
  const x = x87(I); x.clearC1(); const a = x.st(0), b = x.st(1);
  let r;
  if (Number.isNaN(a) || Number.isNaN(b)) r = x.nan2(a, b);
  else {
    r = b * Math.log1p(a) * Math.LOG2E;
    if (Number.isNaN(r)) { x.raise(SW_IE); r = INDEFINITE; }
  }
  x.setSt(1, r); x.pop();
};
/**
 * Classify the argument of FSIN/FCOS/FSINCOS/FPTAN (the JIT's trigArg): a NaN -> C0-C3 cleared,
 * nan1 (SNaN: IE, quieted; QNaN propagated); +-inf -> C0-C3 cleared, IE, the indefinite; a finite
 * |x| >= 2^63 -> C2 set, ST(0) unchanged, no push (null); else C0-C3 cleared, compute (undefined).
 */
function trigSpecial(x, v) {
  if (Number.isNaN(v)) { x.setCC(0, 0, 0, 0); return x.nan1(v); }
  if (!Number.isFinite(v)) { x.setCC(0, 0, 0, 0); x.raise(SW_IE); return INDEFINITE; }
  if (Math.abs(v) >= 2 ** 63) { x.sw = x.sw | C2; return null; }
  x.setCC(0, 0, 0, 0);
  return undefined;
}
function trig1(fn) {
  return (I) => {
    const x = x87(I); const v = x.st(0);
    const s = trigSpecial(x, v);
    if (s !== null) x.setSt(0, s === undefined ? fn(v) : s);
  };
}
H[OP.FSIN] = trig1(Math.sin);
H[OP.FCOS] = trig1(Math.cos);
// FSINCOS / FPTAN push a second value: cos / 1.0, or the same NaN / indefinite on the special paths
/** A push onto a full stack (ST(7) in use): masked stack overflow, both results are the indefinite (measured). */
function pushOverflow(x) { if (x.isEmpty(7)) return false; x.setSt(0, INDEFINITE); x.push(INDEFINITE); return true; }
H[OP.FSINCOS] = (I) => {
  const x = x87(I); const v = x.st(0);
  if (pushOverflow(x)) return;
  const s = trigSpecial(x, v);
  if (s === null) return;
  if (s === undefined) { x.setSt(0, Math.sin(v)); x.push(Math.cos(v)); } else { x.setSt(0, s); x.push(s); }
};
H[OP.FPTAN] = (I) => {
  const x = x87(I); const v = x.st(0);
  if (pushOverflow(x)) return;
  const s = trigSpecial(x, v);
  if (s === null) return;
  if (s === undefined) { x.setSt(0, Math.tan(v)); x.push(1); } else { x.setSt(0, s); x.push(s); }
};
// FPATAN: atan2(ST(1), ST(0)) is defined for every non-NaN pair (signed zeros and infinities included)
H[OP.FPATAN] = (I) => {
  const x = x87(I); x.clearC1(); const a = x.st(0), b = x.st(1);
  x.setSt(1, Number.isNaN(a) || Number.isNaN(b) ? x.nan2(a, b) : Math.atan2(b, a));
  x.pop();
};

// ---- stack / control
H[OP.FXCH] = (I, insn) => {
  const x = x87(I); const i = insn.ops.length ? insn.ops[0].r : 1;
  const a = x.st(0), b = x.st(i);
  x.setSt(0, b); x.setSt(i, a); x.clearC1();
};
H[OP.FFREE] = (I, insn) => { const x = x87(I); x.setValid(insn.ops[0].r, false); };
H[OP.FINCSTP] = (I) => { const x = x87(I); x.top = x.top + 1; x.clearC1(); };
H[OP.FDECSTP] = (I) => { const x = x87(I); x.top = x.top - 1; x.clearC1(); };
H[OP.FNOP] = () => {};
H[OP.FLDCW] = (I, insn) => { const x = x87(I); x.cpu.fpuCw = (I.mem.read16(I.ea(insn.ops[0])) & 0x1f3f) | 0x40; };
H[OP.FNSTCW] = (I, insn) => { I.mem.write16(I.ea(insn.ops[0]), I.cpu.fpuCw); };
H[OP.FNSTSW] = (I, insn) => {
  const x = x87(I); const sw = (x.sw & ~0x3800) | (x.top << 11);
  const o = insn.ops[0];
  if (o.t === OT.REG) I.writeReg(2, 0, sw); else I.mem.write16(I.ea(o), sw);
};
H[OP.FNCLEX] = (I) => { const x = x87(I); x.sw = x.sw & ~0x80ff; };
H[OP.FNINIT] = (I) => { const x = x87(I); x.cpu.fpuCw = 0x037f; x.sw = 0; x.tw = 0; x.top = 0; };
H[OP.FCMOVCC] = (I, insn) => {
  const x = x87(I); const i = insn.ops[0].r;
  const take = I.cond(insn.cc);
  if (x.isEmpty(0) || x.isEmpty(i)) { x.raise(SW_IE | SW_SF); x.setSt(0, INDEFINITE); x.clearC1(); return; }
  if (take) x.setSt(0, x.st(i));
  x.clearC1();
};

// ---- environment save/restore (32-bit protected mode layout, 28 bytes)
function fullTags(x) {
  let t = 0;
  for (let p = 0; p < 8; p++) {
    let tag;
    if (!((x.tw >> p) & 1)) tag = 3;
    else {
      const v = x.cpu.fpr(p);
      if (v === 0) tag = 1;
      else if (!Number.isFinite(v) || Math.abs(v) < 2.2250738585072014e-308) tag = 2;
      else tag = 0;
    }
    t |= tag << (2 * p);
  }
  return t;
}
function storeEnv(I, a) {
  const x = x87(I);
  I.mem.write32(a, x.cpu.fpuCw | 0xffff0000);
  I.mem.write32(a + 4, ((x.sw & ~0x3800) | (x.top << 11)) | 0xffff0000);
  I.mem.write32(a + 8, fullTags(x) | 0xffff0000);
  I.mem.write32(a + 12, 0); I.mem.write32(a + 16, 0); I.mem.write32(a + 20, 0); I.mem.write32(a + 24, 0);
}
function loadEnv(I, a) {
  const x = x87(I);
  x.cpu.fpuCw = (I.mem.read16(a) & 0x1f3f) | 0x40;
  const sw = I.mem.read16(a + 4);
  x.sw = sw & ~0x3800; x.top = (sw >> 11) & 7;
  const ft = I.mem.read16(a + 8);
  let tw = 0;
  for (let p = 0; p < 8; p++) if (((ft >> (2 * p)) & 3) !== 3) tw |= 1 << p;
  x.tw = tw;
}
H[OP.FNSTENV] = (I, insn) => { storeEnv(I, I.ea(insn.ops[0])); I.cpu.fpuCw |= 0x3f; };
H[OP.FLDENV] = (I, insn) => { loadEnv(I, I.ea(insn.ops[0])); };
H[OP.FNSAVE] = (I, insn) => {
  const x = x87(I); const a = I.ea(insn.ops[0]);
  storeEnv(I, a);
  for (let i = 0; i < 8; i++) writeF80(I.mem, a + 28 + 10 * i, x.cpu.fpr(x.phys(i)));
  x.cpu.fpuCw = 0x037f; x.sw = 0; x.tw = 0; x.top = 0;
};
H[OP.FRSTOR] = (I, insn) => {
  const x = x87(I); const a = I.ea(insn.ops[0]);
  loadEnv(I, a);
  for (let i = 0; i < 8; i++) x.cpu.setFpr(x.phys(i), readF80(I.mem, a + 28 + 10 * i));
};

// ---- FXSAVE / FXRSTOR (512-byte image; also used by the SSE state)
export function fxsave(I, a) {
  const x = x87(I); const m = I.mem; const cpu = I.cpu;
  m.fill(a, 512, 0);
  m.write16(a, cpu.fpuCw);
  m.write16(a + 2, (x.sw & ~0x3800) | (x.top << 11));
  m.write8(a + 4, x.tw);
  m.write32(a + 24, cpu.mxcsr);
  m.write32(a + 28, 0xffff);
  for (let i = 0; i < 8; i++) writeF80(m, a + 32 + 16 * i, cpu.fpr(x.phys(i)));
  for (let i = 0; i < 8; i++) m.copy(a + 160 + 16 * i, cpu.xmmAddr(i), 16);
}
export function fxrstor(I, a) {
  const x = x87(I); const m = I.mem; const cpu = I.cpu;
  cpu.fpuCw = (m.read16(a) & 0x1f3f) | 0x40;
  const sw = m.read16(a + 2);
  x.sw = sw & ~0x3800; x.top = (sw >> 11) & 7;
  x.tw = m.read8(a + 4);
  cpu.mxcsr = m.read32(a + 24) & 0xffff;
  for (let i = 0; i < 8; i++) cpu.setFpr(x.phys(i), readF80(m, a + 32 + 16 * i));
  for (let i = 0; i < 8; i++) m.copy(cpu.xmmAddr(i), a + 160 + 16 * i, 16);
}
H[OP.FXSAVE] = (I, insn) => fxsave(I, I.ea(insn.ops[0]));
H[OP.FXRSTOR] = (I, insn) => fxrstor(I, I.ea(insn.ops[0]));
H[OP.LDMXCSR] = (I, insn) => { I.cpu.mxcsr = I.mem.read32(I.ea(insn.ops[0])) & 0xffff; };
H[OP.STMXCSR] = (I, insn) => { I.mem.write32(I.ea(insn.ops[0]), I.cpu.mxcsr); };
H[OP.EMMS] = (I) => { const x = x87(I); x.tw = 0; x.top = 0; }; // like every MMX instruction, EMMS resets TOP

export { X87, x87, INDEFINITE, roundEven, scalb };

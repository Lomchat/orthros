// Shared helpers for the SSE/SSE2/SSE3/MMX translators (translate-sse*.js). No HANDLERS
// registrations live here: this module only knows how to move vectors between the XMM registers
// (v128 locals L_XMM0+r for the whole region, written back to ST.XMM at exits: see Emitter.xmmMask),
// the MM registers (memory-resident at ST.MM), guest memory and the WASM value stack, and how to
// build i8x16.shuffle masks from x86 immediates.
//
// Conventions (see translate.js): `E` is the Emitter, `E.c` the Code writer; GPRs live in
// locals L_REG+r; every guest store goes through L_TA and is followed by E.smcCheck(insn);
// any MM register access mirrors interp-sse.js opAddr (FPU tag word = 0xff, TOP = 0).
import { L_STATE, L_REG, L_TA, L_FTW, L_V0, L_V1, L_V2, L_XMM0, L_XS0, L_XD0 } from './translate.js';
import { OT } from '../decoder.js';
import { ST } from '../state.js';

/** 16 zero bytes (v128.const immediate) */
export const ZERO16 = Object.freeze(new Array(16).fill(0));

// ------------------------------------------------------------------ operand geometry

/**
 * Vector width in bytes of an operand: MEM -> its decoded size, MM -> 8, XMM -> 16.
 * @param {{t: number, size?: number}} o
 */
export function width(o) { return o.t === OT.MEM ? o.size : o.t === OT.MM ? 8 : 16; }

/** Byte offset of XMM r inside the state block. */
export function xmmOff(r) { return ST.XMM + 16 * (r & 7); }
/** Local caching XMM r. */
export function xmmLocal(r) { return L_XMM0 + (r & 7); }
/** Byte offset of MM r inside the state block. */
export function mmOff(r) { return ST.MM + 8 * (r & 7); }

// ------------------------------------------------------------------ XMM

/** Push the v128 value of XMM r. */
export function xmmLoad(E, r) { E.c.get(xmmLocal(r)); }

/**
 * Store a v128 into XMM r: calls emitValue(E) (which must push exactly one v128) and sets the
 * register's local.
 * @param {(E: any) => void} emitValue
 */
export function xmmStore(E, r, emitValue) { emitValue(E); E.c.set(xmmLocal(r)); }

/** i8x16.shuffle(old, new) masks: the low `bytes` bytes from new, the rest from old */
const LOW_MERGE = Object.fromEntries([2, 4, 8].map((n) => [n, Array.from({ length: 16 }, (_, i) => (i < n ? 16 + i : i))]));
const HIGH_MERGE = Array.from({ length: 16 }, (_, i) => (i < 8 ? i : 16 + i));

/**
 * Store only the low `bytes` (4 or 8) of a v128 into XMM r, preserving the other lanes
 * (scalar SS/SD results, MOVLPS-style merges). emitValue(E) must push one v128.
 */
export function xmmStoreLow(E, r, bytes, emitValue) {
  const c = E.c;
  if (bytes === 16) { xmmStore(E, r, emitValue); return; }
  if (!LOW_MERGE[bytes]) throw new Error(`xmmStoreLow: bad width ${bytes}`);
  c.get(xmmLocal(r)); emitValue(E); c.i8x16shuffle(LOW_MERGE[bytes]).set(xmmLocal(r));
}

/** Store the 64-bit lane 1 of a v128 into the high qword of XMM r (MOVHPS/MOVLHPS-style). */
export function xmmStoreHigh(E, r, emitValue) { const c = E.c; c.get(xmmLocal(r)); emitValue(E); c.i8x16shuffle(HIGH_MERGE).set(xmmLocal(r)); }

// ------------------------------------------------------------------ MMX

/**
 * Side effect of any MM register access (interp-sse.js opAddr): all x87 tags valid, TOP = 0.
 * A region with an MM operand is an x87 region (translate.js touchesFpu), so the cached stack is
 * re-based on TOP = 0 (E.x87SetTop0) and the tag word local set; the memory form is kept for
 * completeness should a non-x87 region ever call this.
 */
export function mmTouch(E) {
  const c = E.c;
  E.x87SetTop0();
  if (E.usesX87) { c.i32(0xff).set(L_FTW); E.stValid = 0xff; }
  else c.get(L_STATE).i32(0xff).i32store16(ST.FPU_TW);
}

/** Push MM r zero-extended to a v128 (lanes 8..15 zero) — with the mmTouch side effect. */
export function mmLoad(E, r) { mmTouch(E); E.c.get(L_STATE).v128load64zero(mmOff(r)); }

/**
 * Store the low 64 bits of a v128 into MM r (store64_lane 0) — with the mmTouch side effect.
 * emitValue(E) must push one v128.
 */
export function mmStore(E, r, emitValue) { mmTouch(E); E.c.get(L_STATE); emitValue(E); E.c.v128store64lane(mmOff(r), 0); }

// ------------------------------------------------------------------ generic vector operands

/**
 * Push a v128 loaded from operand o, zero-extended to 128 bits: XMM (full register), MM
 * (low 64 bits, mmTouch), or MEM through E.ea(o) reading `bytes` (16/8/4/2/1) bytes.
 * @param {number} [bytes] defaults to width(o)
 */
export function loadVec(E, o, bytes = width(o)) {
  const c = E.c;
  if (o.t === OT.XMM) { xmmLoad(E, o.r); return; }
  if (o.t === OT.MM) { mmLoad(E, o.r); return; }
  if (o.t !== OT.MEM) throw new Error('loadVec: bad operand');
  if (bytes === 2 || bytes === 1) {
    // (addr, zero) -> load lane 0
    E.ea(o); pushZero(E);
    if (bytes === 2) c.v128load16lane(0, 0); else c.v128load8lane(0, 0);
    return;
  }
  E.ea(o);
  if (bytes === 16) c.v128load(0);
  else if (bytes === 8) c.v128load64zero(0);
  else if (bytes === 4) c.v128load32zero(0);
  else throw new Error(`loadVec: bad width ${bytes}`);
}

/**
 * Store the low `bytes` of a v128 into operand o. MEM: EA into L_TA, then
 * v128.store / store64_lane 0 / store32_lane 0 / store16_lane 0, followed by E.smcCheck(insn)
 * (and, when `unaligned`, by smcCheckEnd for a store that may cross into the next page).
 * XMM: full store (16) or low-lane merge (8/4/2). MM: mmStore (8) or a 32-bit low-lane merge (4).
 * emitValue(E) must push exactly one v128.
 * @param {any} insn the instruction (for smcCheck)
 * @param {number} bytes 16 | 8 | 4 | 2
 * @param {(E: any) => void} emitValue
 * @param {boolean} [unaligned] the ISA allows any address (MOVUPS/MOVDQU...), so the store may
 *   straddle two pages; aligned forms (MOVAPS/MOVNTPS/MOVDQA...) never do and skip the end check
 */
export function storeVec(E, o, insn, bytes, emitValue, unaligned = false) {
  const c = E.c;
  if (o.t === OT.XMM) { xmmStoreLow(E, o.r, bytes, emitValue); return; }
  if (o.t === OT.MM) {
    if (bytes === 8) { mmStore(E, o.r, emitValue); return; }
    mmTouch(E); c.get(L_STATE); emitValue(E);
    if (bytes === 4) c.v128store32lane(mmOff(o.r), 0); else if (bytes === 2) c.v128store16lane(mmOff(o.r), 0); else throw new Error(`storeVec: bad MM width ${bytes}`);
    return;
  }
  if (o.t !== OT.MEM) throw new Error('storeVec: bad operand');
  E.eaTo(o);
  c.get(L_TA); emitValue(E);
  if (bytes === 16) c.v128store(0);
  else if (bytes === 8) c.v128store64lane(0, 0);
  else if (bytes === 4) c.v128store32lane(0, 0);
  else if (bytes === 2) c.v128store16lane(0, 0);
  else if (bytes === 1) c.v128store8lane(0, 0);
  else throw new Error(`storeVec: bad width ${bytes}`);
  E.smcCheck(insn);
  if (unaligned) smcCheckEnd(E, insn, bytes);
}

/**
 * Second SMC page check for a `bytes`-wide store starting at L_TA: E.smcCheck only inspects the
 * page of the first byte, so an unaligned 16-byte store that crosses into the next 4 KB page
 * would silently overwrite translated code there. Taken only when the store actually crosses
 * (L_TA & 0xfff > 0x1000 - bytes); then L_TA is moved to the last byte written (the EXIT_ARG the
 * host invalidates). Emit after the store and after E.smcCheck(insn). Cost: and/compare/branch
 * per store (measured: ~20% on a pure vector-store loop when applied to every store, hence only
 * the unaligned-capable 16-byte forms use it; 8-byte and scalar stores keep the single check).
 */
export function smcCheckEnd(E, insn, bytes) {
  if (!E.smc || !insn) return;
  const c = E.c;
  c.get(L_TA).i32(0xfff).and().i32(0x1000 - bytes).gt_u();
  const i = c.if_();
  c.get(L_TA).i32(bytes - 1).add().set(L_TA);
  E.smcCheck(insn);
  c.end(); void i;
}

// ------------------------------------------------------------------ scalars (lane 0)

// ------------------------------------------------------------------ lane-0 f32 / f64 shadows
// In an instruction of XMM_SHADOW_OPS (E.xsOK) lane 0 of an XMM register is read from / written to its f32 shadow
// L_XS0+r (see Emitter.xmmShadowSync), in one of XMM_SHADOW64_OPS (E.xdOK) the low qword from / to its f64 shadow
// L_XD0+r (Emitter.xmmShadowSync64); elsewhere these helpers work on the v128 local, whose shadow the emitter has
// already written back and dropped (Emitter.xmmShadowRelease).

/**
 * Push lane 0 of operand o as an f32 (XMM register or m32). In a shadow instruction an XMM operand is read from its
 * shadow, extracted into it first when not valid.
 */
export function scalarF32(E, o) {
  const c = E.c;
  if (o.t === OT.XMM) {
    const r = o.r & 7, bit = 1 << r;
    if (!E.xsOK) { c.get(xmmLocal(r)).f32x4extractlane(0); return; }
    if (E.xsValid & bit) { c.get(L_XS0 + r); return; }
    c.get(xmmLocal(r)).f32x4extractlane(0).tee(L_XS0 + r);
    E.xsValid |= bit;
    return;
  }
  if (o.t === OT.MEM) { E.ea(o); c.f32load(0, 0); return; }
  throw new Error('scalarF32: bad operand');
}

/**
 * Push lane 0 of operand o as an f64 (XMM register or m64). In an f64 shadow instruction (E.xdOK) an XMM operand is
 * read from its shadow, extracted into it first when not valid.
 */
export function scalarF64(E, o) {
  const c = E.c;
  if (o.t === OT.XMM) {
    const r = o.r & 7, bit = 1 << r;
    if (!E.xdOK) { c.get(xmmLocal(r)).f64x2extractlane(0); return; }
    if (E.xdValid & bit) { c.get(L_XD0 + r); return; }
    c.get(xmmLocal(r)).f64x2extractlane(0).tee(L_XD0 + r);
    E.xdValid |= bit;
    return;
  }
  if (o.t === OT.MEM) { E.ea(o); c.f64load(0, 0); return; }
  throw new Error('scalarF64: bad operand');
}

/** Push lane 0 of operand o as an i32 (XMM register — the valid f64 shadow's bits in an f64 shadow instruction —, MM
 * register (mmTouch), or m32). */
export function scalarI32(E, o) {
  const c = E.c;
  if (o.t === OT.XMM) { if (E.xdOK && (E.xdValid & (1 << (o.r & 7)))) { xmmLowI64(E, o.r); c.wrap(); } else c.get(xmmLocal(o.r)).i32x4extractlane(0); return; }
  if (o.t === OT.MM) { mmTouch(E); c.get(L_STATE).i32load(mmOff(o.r)); return; }
  if (o.t === OT.MEM) { E.ea(o); c.i32load(0, 0); return; }
  throw new Error('scalarI32: bad operand');
}

/** Push the low 64 bits of operand o as an i64 (XMM (xmmLowI64), MM (mmTouch) or m64). */
export function scalarI64(E, o) {
  const c = E.c;
  if (o.t === OT.XMM) { xmmLowI64(E, o.r); return; }
  if (o.t === OT.MM) { mmTouch(E); c.get(L_STATE).i64load(mmOff(o.r)); return; }
  if (o.t === OT.MEM) { E.ea(o); c.i64load(0, 0); return; }
  throw new Error('scalarI64: bad operand');
}

/**
 * Store an f32 into lane 0 of XMM r (other lanes preserved). emitValue(E) pushes one f32. In a shadow instruction
 * only the shadow is written (the v128 local's lane 0 becomes stale: xsDirty).
 */
export function xmmStoreF32(E, r, emitValue) {
  if (E.xsOK) { emitValue(E); E.c.set(L_XS0 + (r & 7)); E.xsValid |= 1 << (r & 7); E.xsDirty |= 1 << (r & 7); return; }
  E.c.get(xmmLocal(r)); emitValue(E); E.c.f32x4replacelane(0).set(xmmLocal(r));
}
/**
 * Shadow instructions: XMM r <- a whole v128 (emitValue pushes it) whose lane 0 also goes to the shadow (valid,
 * not dirty) — MOVSS xmm, m32.
 */
export function xmmStoreShadowed(E, r, emitValue) {
  const c = E.c;
  emitValue(E); c.tee(xmmLocal(r)).f32x4extractlane(0).set(L_XS0 + (r & 7));
  E.xsValid |= 1 << (r & 7); E.xsDirty &= ~(1 << (r & 7));
}
/**
 * Store an f64 into lane 0 of XMM r (lane 1 preserved). emitValue(E) pushes one f64. In an f64 shadow instruction
 * only the shadow is written (xdDirty). The value's bits are kept as they are (locals, loads and stores never touch
 * a NaN's payload in WASM: only arithmetic may), so a move through the shadow is exact.
 */
export function xmmStoreF64(E, r, emitValue) {
  if (E.xdOK) { emitValue(E); E.c.set(L_XD0 + (r & 7)); E.xdValid |= 1 << (r & 7); E.xdDirty |= 1 << (r & 7); return; }
  E.c.get(xmmLocal(r)); emitValue(E); E.c.f64x2replacelane(0).set(xmmLocal(r));
}
/**
 * f64 shadow instructions: XMM r <- a whole v128 (emitValue pushes it) whose low qword also goes to the shadow (valid,
 * not dirty) — MOVSD / MOVQ xmm, m64.
 */
export function xmmStoreShadowed64(E, r, emitValue) {
  const c = E.c;
  emitValue(E); c.tee(xmmLocal(r)).f64x2extractlane(0).set(L_XD0 + (r & 7));
  E.xdValid |= 1 << (r & 7); E.xdDirty &= ~(1 << (r & 7));
}
/**
 * Push the low qword of XMM r as an i64 in an f64 shadow instruction: the shadow's bits when valid (a PEXTRW / MOVD /
 * MOVQ reading the double a scalar chain left there), else the v128 local's.
 */
export function xmmLowI64(E, r) {
  const c = E.c;
  if (E.xdOK && (E.xdValid & (1 << (r & 7)))) c.get(L_XD0 + (r & 7)).i64reinterpret_f64(); else c.get(xmmLocal(r)).i64x2extractlane(0);
}
/**
 * Instructions of both shadow families (the whole-register moves): before XMM r is read as a whole, its dirty
 * shadows (f32 and f64) are written back, both staying valid.
 */
export function xmmSyncWhole(E, r) {
  const bit = 1 << (r & 7);
  if (E.xsDirty & bit) { E.xmmShadowSync(bit); E.xsDirty &= ~bit; }
  if (E.xdDirty & bit) { E.xmmShadowSync64(bit); E.xdDirty &= ~bit; }
}
/** ... before XMM r is overwritten as a whole: its shadows dropped (nothing written back). */
export function xmmDropShadows(E, r) {
  const bit = ~(1 << (r & 7));
  E.xsValid &= bit; E.xsDirty &= bit; E.xdValid &= bit; E.xdDirty &= bit;
}
/** Store an i32 into lane 0 of XMM r (other lanes preserved). emitValue(E) pushes one i32. */
export function xmmStoreI32(E, r, emitValue) { E.c.get(xmmLocal(r)); emitValue(E); E.c.i32x4replacelane(0).set(xmmLocal(r)); }
/** Store an i64 into the low qword of XMM r (high qword preserved). emitValue(E) pushes one i64. */
export function xmmStoreI64(E, r, emitValue) { E.c.get(xmmLocal(r)); emitValue(E); E.c.i64x2replacelane(0).set(xmmLocal(r)); }

// ------------------------------------------------------------------ constants

/** Push a zero v128. */
export function pushZero(E) { E.c.v128const(ZERO16); }

/** Push a v128 with every i32 lane = v. */
export function pushSplatI32(E, v) { const b = new Uint8Array(16); new Int32Array(b.buffer).fill(v | 0); E.c.v128const(b); }
/** Push a v128 with every i64 lane = v (BigInt). */
export function pushSplatI64(E, v) { const b = new Uint8Array(16); new BigInt64Array(b.buffer).fill(BigInt.asIntN(64, BigInt(v))); E.c.v128const(b); }
/** Push a v128 with every f32 lane = v. */
export function pushSplatF32(E, v) { const b = new Uint8Array(16); new Float32Array(b.buffer).fill(v); E.c.v128const(b); }
/** Push a v128 with every f64 lane = v. */
export function pushSplatF64(E, v) { const b = new Uint8Array(16); new Float64Array(b.buffer).fill(v); E.c.v128const(b); }
/** Push a v128 with every i16 lane = v. */
export function pushSplatI16(E, v) { const b = new Uint8Array(16); new Int16Array(b.buffer).fill(v); E.c.v128const(b); }
/** Push a v128 with every i8 lane = v. */
export function pushSplatI8(E, v) { E.c.v128const(new Array(16).fill(v & 0xff)); }

/**
 * Push a v128 mask whose low `bytes` bytes are 0xff and the rest 0 (lane-0 merge masks for
 * v128.bitselect: bitselect(new, old, mask) keeps `new` in the low lanes).
 */
export function pushLowMask(E, bytes) { E.c.v128const(Array.from({ length: 16 }, (_, i) => (i < bytes ? 0xff : 0))); }

// ------------------------------------------------------------------ shuffle masks
// All masks are 16-entry arrays for i8x16.shuffle(A, B): indices 0..15 select bytes of A
// (the first operand pushed), 16..31 bytes of B (the second).

/**
 * Build a byte mask from element selectors: element i of the result takes element sel[i]
 * (0..(16/elem)-1 from A, then the same count from B) of size `elem` bytes.
 * @param {number} elem element size in bytes (1, 2, 4, 8)
 * @param {number[]} sel one selector per result element (16/elem entries)
 */
export function elemMask(elem, sel) {
  const n = 16 / elem;
  if (sel.length !== n) throw new Error(`elemMask: need ${n} selectors`);
  const m = new Array(16);
  for (let i = 0; i < n; i++) for (let k = 0; k < elem; k++) m[i * elem + k] = sel[i] * elem + k;
  return m;
}

/** Mask for the low `bytes` bytes of B merged into A (MOVSS/MOVSD reg-reg style): shuffle(A, B). */
export function lowMergeMask(bytes) { return Array.from({ length: 16 }, (_, i) => (i < bytes ? 16 + i : i)); }

/** SHUFPS imm: R0 = A[im&3], R1 = A[(im>>2)&3], R2 = B[(im>>4)&3], R3 = B[(im>>6)&3] (dwords). */
export function shufps(imm) { return elemMask(4, [imm & 3, (imm >> 2) & 3, 4 + ((imm >> 4) & 3), 4 + ((imm >> 6) & 3)]); }

/** SHUFPD imm: R.q0 = A.q[im&1], R.q1 = B.q[(im>>1)&1]. */
export function shufpd(imm) { return elemMask(8, [imm & 1, 2 + ((imm >> 1) & 1)]); }

/** PSHUFD imm on a single operand (shuffle(A, A)): R[i] = A.d[(im >> 2i) & 3]. */
export function pshufd(imm) { return elemMask(4, [imm & 3, (imm >> 2) & 3, (imm >> 4) & 3, (imm >> 6) & 3]); }

/** PSHUFLW imm (single operand): low words permuted, words 4..7 copied. */
export function pshuflw(imm) { return elemMask(2, [imm & 3, (imm >> 2) & 3, (imm >> 4) & 3, (imm >> 6) & 3, 4, 5, 6, 7]); }

/** PSHUFHW imm (single operand): words 0..3 copied, high words permuted within the high half. */
export function pshufhw(imm) { return elemMask(2, [0, 1, 2, 3, 4 + (imm & 3), 4 + ((imm >> 2) & 3), 4 + ((imm >> 4) & 3), 4 + ((imm >> 6) & 3)]); }

/** PSHUFW imm (MMX, single 64-bit operand): same as PSHUFLW; the upper half is don't-care. */
export function pshufw(imm) { return pshuflw(imm); }

/**
 * PUNPCK{L,H}{BW,WD,DQ,QDQ} / UNPCK{L,H}{PS,PD}: interleave elements of A and B.
 * @param {number} elem element size in bytes
 * @param {boolean} high take the high half of each `n`-byte operand
 * @param {number} [n] vector width (16 for XMM, 8 for MMX)
 */
export function unpackMask(elem, high, n = 16) {
  const lanes = n / elem, half = lanes / 2, base = high ? half : 0, per = 16 / elem;
  const sel = [];
  for (let i = 0; i < half; i++) { sel.push(base + i); sel.push(per + base + i); }
  // remaining result elements (MMX forms): A's upper elements (zero after a 64-bit zero-load)
  for (let i = lanes; i < per; i++) sel.push(i);
  return elemMask(elem, sel);
}

/** PSLLDQ imm: byte shift left (toward higher addresses) of A with zeros from B (push zero as B). */
export function pslldqMask(imm) { const n = Math.min(imm, 16); return Array.from({ length: 16 }, (_, i) => (i < n ? 16 + i : i - n)); }

/** PSRLDQ imm: byte shift right of A with zeros from B (push zero as B). */
export function psrldqMask(imm) { const n = Math.min(imm, 16); return Array.from({ length: 16 }, (_, i) => (i + n < 16 ? i + n : 16 + i)); }

/** MOVHLPS: R.q0 = B.q1, R.q1 = A.q1 (shuffle(dst, src)). */
export const MOVHLPS_MASK = Object.freeze(elemMask(8, [3, 1]));
/** MOVLHPS: R.q0 = A.q0, R.q1 = B.q0 (shuffle(dst, src)). */
export const MOVLHPS_MASK = Object.freeze(elemMask(8, [0, 2]));

// ------------------------------------------------------------------ GPRs

/** Push GPR r (size 4/2/1, zero-extended) — wrapper around E.loadReg. */
export function gprGet(E, r, size = 4) { E.loadReg(size, r); }

/** Store local `srcLocal` into GPR r (size-aware merge) — wrapper around E.storeRegFrom. */
export function gprSet(E, r, srcLocal, size = 4) { E.storeRegFrom(size, r, srcLocal); }

/** Pop an i32 from the stack into the full 32-bit GPR r. */
export function gprSetStack(E, r) { E.c.set(L_REG + r); }

/** Push a scalar GPR/MEM operand (size 4/2/1) via E.loadOp (REG/MEM/IMM). */
export function scalarOp(E, o) { E.loadOp(o); }

/**
 * Store an i32 result to a REG or MEM operand of size 4/2 (PEXTRW, MOVD, MOVMSK*, CVT*2SI):
 * value on the stack; goes through L_TA + smcCheck for MEM.
 */
export function storeScalar(E, o, insn, tmpLocal) {
  const c = E.c;
  if (o.t === OT.REG) { if (o.size === 4) { c.set(L_REG + o.r); return; } c.set(tmpLocal); E.storeRegFrom(o.size, o.r, tmpLocal); return; }
  if (o.t === OT.MEM) { c.set(tmpLocal); E.eaTo(o); E.storeOpFrom(o, tmpLocal, insn); return; }
  throw new Error('storeScalar: bad operand');
}

export { L_V0, L_V1, L_V2 };

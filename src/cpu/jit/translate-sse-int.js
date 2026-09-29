// Native translation of the MMX / SSE2 packed-integer instruction set (moves, logic, add/sub,
// saturating arithmetic, compares, multiplies, min/max/avg, unpack/pack, shuffles, shifts,
// PEXTRW/PINSRW/PMOVMSKB, EMMS, MASKMOVQ/MASKMOVDQU) with WASM SIMD.
//
// Each mnemonic serves both the 64-bit MMX form ('Pq,Qq') and the 128-bit XMM form ('Vdq,Wdq'
// under the 66 prefix) through one OP id; the handler branches on the destination width
// (width(o) from translate-sse-common.js). MMX forms load 8 bytes zero-extended
// (v128.load64_zero), run the same 128-bit lane operation and store the low 8 bytes
// (v128.store64_lane 0); any instruction touching an OT.MM operand mirrors the interpreter's
// side effect (TOP = 0, FPU tag word = 0xff) exactly once via mmTouch.
//
// Reference semantics: src/cpu/interp-sse.js (bit-exact target, checked by tests/generated/sse).
// XMM/MM registers stay memory-resident in the thread state; nothing here touches EFLAGS.
import { HANDLERS, XMM_SHADOW64_OPS, L_STATE, L_REG, L_TA, L_TV, L_I64A, L_FS, L_FTW, L_V0, L_V1 } from './translate.js';
import { OP, OT } from '../decoder.js';
import { ST, SEG } from '../state.js';
import { T } from './wasm.js';
import {
  width, xmmOff, xmmLocal, mmOff, mmTouch, loadVec, storeVec, xmmStore, scalarI32, scalarI64, pushZero, xmmLowI64, xmmStoreShadowed64,
  elemMask, unpackMask, pshufd, pshuflw, pshufhw, pshufw, pslldqMask, psrldqMask, storeScalar,
} from './translate-sse-common.js';

// ------------------------------------------------------------------ local helpers

/** Apply the MM side effect once if any operand of insn is an MM register. */
function touch(E, insn) {
  for (const o of insn.ops) if (o.t === OT.MM) { mmTouch(E); return; }
}

/** Push operand o as a v128 (XMM full, MM low 64 bits zero-extended, MEM by its size) — no MM touch. */
function vec(E, o) {
  const c = E.c;
  if (o.t === OT.MM) { c.get(L_STATE).v128load64zero(mmOff(o.r)); return; }
  loadVec(E, o);
}

/**
 * Store the low `n` (16 or 8) bytes of the v128 pushed by emit(E) into operand o
 * (XMM full store, MM store64_lane 0, MEM through storeVec/L_TA/smcCheck) — no MM touch.
 */
function put(E, o, insn, n, emit) {
  const c = E.c;
  if (o.t === OT.XMM) { xmmStore(E, o.r, emit); return; }
  if (o.t === OT.MM) { c.get(L_STATE); emit(E); c.v128store64lane(mmOff(o.r), 0); return; }
  storeVec(E, o, insn, n, emit);
}

/** Generic two-operand lane op: dst = op(dst, src); emitOp(c) consumes (dst, src) and pushes the result. */
function binop(emitOp) {
  return (E, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    touch(E, insn);
    put(E, d, insn, width(d), () => { vec(E, d); vec(E, s); emitOp(E.c, width(d), E); });
  };
}

/** Same, with both operands in L_V0 (dst) / L_V1 (src) for ops that read them more than once. */
function binopLocals(emitOp) {
  return (E, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
    touch(E, insn);
    vec(E, d); c.set(L_V0); vec(E, s); c.set(L_V1);
    put(E, d, insn, width(d), () => emitOp(c, width(d)));
  };
}

const EVEN_DWORD_MASK = Object.freeze(Array.from({ length: 16 }, (_, i) => ((i >> 2) & 1 ? 0 : 0xff)));
/** High 16 bits of each i32 lane of (A, B) gathered into one i16x8 (A lanes first). */
const HIGH_HALVES_MASK = Object.freeze([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
const SWAP_DWORD_PAIRS = Object.freeze(elemMask(4, [1, 0, 3, 2]));
/** MMX pack pre-shuffles: put the valid halves of A and B side by side. */
const MM_PACK_WORDS = Object.freeze(elemMask(2, [0, 1, 2, 3, 8, 9, 10, 11]));
const MM_PACK_DWORDS = Object.freeze(elemMask(4, [0, 1, 4, 5]));

// ------------------------------------------------------------------ moves

HANDLERS[OP.MOVD] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
  if (d.t === OT.REG || d.t === OT.MEM) {
    // r32/m32 <- low dword of mm/xmm
    scalarI32(E, s); // MM: touch included
    storeScalar(E, d, insn, L_TV);
    return;
  }
  // mm/xmm <- r32/m32, zero-extended
  touch(E, insn);
  put(E, d, insn, width(d), () => { pushZero(E); E.loadOp(s); c.i32x4replacelane(0); });
  if (d.t === OT.XMM) xmmDropF64(E, d.r);
};

// MOVQ: in XMM_SHADOW64_OPS (like MOVD and PEXTRW: a C runtime's SSE2 routine moves a double's bits between the x87
// stack, memory, integer registers and XMM registers with them): xmm <- m64 also fills the f64 shadow, m64 <- xmm and
// xmm <- xmm read the shadow's bits when valid; the MMX forms name no XMM register
HANDLERS[OP.MOVQ] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
  touch(E, insn);
  if (d.t === OT.MEM) {
    if (s.t === OT.XMM) { E.eaTo(d); c.get(L_TA); scalarI64(E, s); c.i64store(0, 0); E.smcCheck(insn); return; }
    storeVec(E, d, insn, 8, () => vec(E, s)); return;
  }
  if (d.t === OT.MM) { put(E, d, insn, 8, () => vec(E, s)); return; }
  // xmm <- low qword of xmm/m64, zero-extended
  if (s.t === OT.XMM) { xmmStore(E, d.r, () => { pushZero(E); scalarI64(E, s); c.i64x2replacelane(0); }); xmmDropF64(E, d.r); }
  else xmmStoreShadowed64(E, d.r, () => vec(E, s));
};
/** The f64 shadow of XMM r dropped (the whole v128 local just written by an XMM_SHADOW64_OPS member). */
function xmmDropF64(E, r) { const m = ~(1 << (r & 7)); E.xdValid &= m; E.xdDirty &= m; }
HANDLERS[OP.MOVQ2DQ] = (E, insn) => { touch(E, insn); xmmStore(E, insn.ops[0].r, () => vec(E, insn.ops[1])); };
HANDLERS[OP.MOVDQ2Q] = (E, insn) => { touch(E, insn); put(E, insn.ops[0], insn, 8, () => vec(E, insn.ops[1])); };
HANDLERS[OP.MOVNTQ] = (E, insn) => { touch(E, insn); storeVec(E, insn.ops[0], insn, 8, () => vec(E, insn.ops[1])); };
HANDLERS[OP.MOVNTI] = (E, insn) => { E.loadOp(insn.ops[1]); storeScalar(E, insn.ops[0], insn, L_TV); };

// ------------------------------------------------------------------ logic

HANDLERS[OP.PAND] = binop((c) => c.v128and());
HANDLERS[OP.POR] = binop((c) => c.v128or());
HANDLERS[OP.PXOR] = binop((c) => c.v128xor());
// PANDN: dst = ~dst & src = v128.andnot(src, dst)
HANDLERS[OP.PANDN] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  touch(E, insn);
  put(E, d, insn, width(d), () => { vec(E, s); vec(E, d); E.c.v128andnot(); });
};

// ------------------------------------------------------------------ add / sub / saturating / compares / min / max / avg

for (const [op, m] of [
  ['PADDB', 'i8x16add'], ['PADDW', 'i16x8add'], ['PADDD', 'i32x4add'], ['PADDQ', 'i64x2add'],
  ['PSUBB', 'i8x16sub'], ['PSUBW', 'i16x8sub'], ['PSUBD', 'i32x4sub'], ['PSUBQ', 'i64x2sub'],
  ['PADDSB', 'i8x16add_sat_s'], ['PADDSW', 'i16x8add_sat_s'], ['PSUBSB', 'i8x16sub_sat_s'], ['PSUBSW', 'i16x8sub_sat_s'],
  ['PADDUSB', 'i8x16add_sat_u'], ['PADDUSW', 'i16x8add_sat_u'], ['PSUBUSB', 'i8x16sub_sat_u'], ['PSUBUSW', 'i16x8sub_sat_u'],
  ['PCMPEQB', 'i8x16eq'], ['PCMPEQW', 'i16x8eq'], ['PCMPEQD', 'i32x4eq'],
  ['PCMPGTB', 'i8x16gt_s'], ['PCMPGTW', 'i16x8gt_s'], ['PCMPGTD', 'i32x4gt_s'],
  ['PMULLW', 'i16x8mul'], ['PMADDWD', 'i32x4dot_i16x8_s'],
  ['PAVGB', 'i8x16avgr_u'], ['PAVGW', 'i16x8avgr_u'],
  ['PMINUB', 'i8x16min_u'], ['PMAXUB', 'i8x16max_u'], ['PMINSW', 'i16x8min_s'], ['PMAXSW', 'i16x8max_s'],
]) HANDLERS[OP[op]] = binop((c) => c[m]());

// ------------------------------------------------------------------ multiplies

// PMULHW / PMULHUW: full 32-bit products (extmul low/high) then gather the high halves.
function pmulh(signed) {
  return binopLocals((c) => {
    c.get(L_V0).get(L_V1); if (signed) c.i32x4extmul_low_i16x8_s(); else c.i32x4extmul_low_i16x8_u();
    c.get(L_V0).get(L_V1); if (signed) c.i32x4extmul_high_i16x8_s(); else c.i32x4extmul_high_i16x8_u();
    c.i8x16shuffle(HIGH_HALVES_MASK);
  });
}
HANDLERS[OP.PMULHW] = pmulh(true);
HANDLERS[OP.PMULHUW] = pmulh(false);

// PMULUDQ: u64 lanes = u32 lane 0 * u32 lane 0 and lane 2 * lane 2 (odd dwords masked off).
HANDLERS[OP.PMULUDQ] = binop((c) => {
  c.v128const(EVEN_DWORD_MASK).v128and().set(L_V1); // src & mask
  c.v128const(EVEN_DWORD_MASK).v128and().get(L_V1).i64x2mul(); // (dst & mask) * (src & mask)
});

// PSADBW: per 8-byte group, sum of |a - b| as a u64.
HANDLERS[OP.PSADBW] = binopLocals((c) => {
  c.get(L_V0).get(L_V1).i8x16max_u().get(L_V0).get(L_V1).i8x16min_u().i8x16sub();
  c.i16x8extadd_pairwise_i8x16_u().i32x4extadd_pairwise_i16x8_u().set(L_V0); // [s0, s1, s2, s3]
  c.get(L_V0).get(L_V0).i8x16shuffle(SWAP_DWORD_PAIRS).get(L_V0).i32x4add(); // [s0+s1, s0+s1, s2+s3, s2+s3]
  c.v128const(EVEN_DWORD_MASK).v128and(); // u64 lanes [s0+s1, s2+s3]
});

// ------------------------------------------------------------------ unpack / pack

for (const [op, elem, high] of [
  ['PUNPCKLBW', 1, false], ['PUNPCKLWD', 2, false], ['PUNPCKLDQ', 4, false],
  ['PUNPCKHBW', 1, true], ['PUNPCKHWD', 2, true], ['PUNPCKHDQ', 4, true],
  ['PUNPCKLQDQ', 8, false], ['PUNPCKHQDQ', 8, true],
]) HANDLERS[OP[op]] = binop((c, n) => c.i8x16shuffle(unpackMask(elem, high, n)));

function pack(narrow, mmMask) {
  return binop((c, n, E) => {
    if (n === 8) { c.i8x16shuffle(mmMask); pushZero(E); }
    narrow(c);
  });
}
HANDLERS[OP.PACKSSWB] = pack((c) => c.i8x16narrow_i16x8_s(), MM_PACK_WORDS);
HANDLERS[OP.PACKUSWB] = pack((c) => c.i8x16narrow_i16x8_u(), MM_PACK_WORDS);
HANDLERS[OP.PACKSSDW] = pack((c) => c.i16x8narrow_i32x4_s(), MM_PACK_DWORDS);

// ------------------------------------------------------------------ shuffles (single source + imm8)

function pshuf(maskOf) {
  return (E, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
    touch(E, insn);
    put(E, d, insn, width(d), () => { vec(E, s); c.tee(L_V0).get(L_V0).i8x16shuffle(maskOf(insn.ops[2].v)); });
  };
}
HANDLERS[OP.PSHUFD] = pshuf(pshufd);
HANDLERS[OP.PSHUFLW] = pshuf(pshuflw);
HANDLERS[OP.PSHUFHW] = pshuf(pshufhw);
HANDLERS[OP.PSHUFW] = pshuf(pshufw);

// ------------------------------------------------------------------ shifts

/**
 * PSLL/PSRL/PSRA by imm8 ('Nq,Ib' / 'Udq,Ib') or by the low 64 bits of an mm/xmm/m64 count
 * ('Pq,Qq' / 'Vdq,Wdq'). Counts >= lane width give 0 (logical) or the sign fill (arithmetic);
 * WASM lane shifts wrap the count, so the clamp is explicit (static for imm, runtime otherwise).
 */
function pshift(method, w, arith) {
  return (E, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const c = E.c; const n = width(d);
    touch(E, insn);
    if (s.t === OT.IMM) {
      const cnt = s.v;
      put(E, d, insn, n, () => {
        if (cnt < w) { vec(E, d); c.i32(cnt)[method](); } else if (arith) { vec(E, d); c.i32(w - 1)[method](); } else pushZero(E);
      });
      return;
    }
    scalarI64(E, s); c.set(L_I64A);
    vec(E, d); c.set(L_V0);
    put(E, d, insn, n, () => {
      c.get(L_I64A).i64(w).i64lt_u();
      const i = c.if_(T.v128);
      c.get(L_V0).get(L_I64A).wrap()[method]();
      c.else_();
      if (arith) c.get(L_V0).i32(w - 1)[method](); else pushZero(E);
      c.end(); void i;
    });
  };
}
HANDLERS[OP.PSLLW] = pshift('i16x8shl', 16, false); HANDLERS[OP.PSRLW] = pshift('i16x8shr_u', 16, false); HANDLERS[OP.PSRAW] = pshift('i16x8shr_s', 16, true);
HANDLERS[OP.PSLLD] = pshift('i32x4shl', 32, false); HANDLERS[OP.PSRLD] = pshift('i32x4shr_u', 32, false); HANDLERS[OP.PSRAD] = pshift('i32x4shr_s', 32, true);
HANDLERS[OP.PSLLQ] = pshift('i64x2shl', 64, false); HANDLERS[OP.PSRLQ] = pshift('i64x2shr_u', 64, false);

// PSLLDQ / PSRLDQ: byte shifts of the whole xmm by min(imm, 16), zeros shifted in.
function pshiftdq(maskOf) {
  return (E, insn) => {
    const d = insn.ops[0]; const c = E.c;
    put(E, d, insn, 16, () => { vec(E, d); pushZero(E); c.i8x16shuffle(maskOf(insn.ops[1].v)); });
  };
}
HANDLERS[OP.PSLLDQ] = pshiftdq(pslldqMask);
HANDLERS[OP.PSRLDQ] = pshiftdq(psrldqMask);

// ------------------------------------------------------------------ extract / insert / mask / EMMS

HANDLERS[OP.PEXTRW] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
  touch(E, insn);
  const k = insn.ops[2].v & (width(s) / 2 - 1);
  // (XMM_SHADOW64_OPS: a word of the low qword from the f64 shadow when valid — the exponent word of a double a
  // scalar chain or a MOVLPD left there —, the high qword's from the v128 local, never stale)
  if (s.t === OT.XMM && k < 4 && (E.xdValid & (1 << (s.r & 7)))) { xmmLowI64(E, s.r); if (k) c.i64(BigInt(16 * k)).i64shr_u(); c.wrap().i32(0xffff).and(); }
  else { vec(E, s); c.i16x8extractlane_u(k); }
  storeScalar(E, d, insn, L_TV);
};
HANDLERS[OP.PINSRW] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const c = E.c; const n = width(d);
  touch(E, insn);
  put(E, d, insn, n, () => { vec(E, d); E.loadOp(s); c.i16x8replacelane(insn.ops[2].v & (n / 2 - 1)); });
};
HANDLERS[OP.PMOVMSKB] = (E, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const c = E.c;
  touch(E, insn);
  vec(E, s); c.i8x16bitmask(); // MM: lanes 8..15 are zero -> bits 8..15 clear
  storeScalar(E, d, insn, L_TV);
};
// EMMS: all x87 tags empty and TOP = 0 (hardware, oracle-verified: like every MMX instruction,
// EMMS resets the stack top; only the tag word value differs from mmTouch).
HANDLERS[OP.EMMS] = (E) => {
  const c = E.c;
  E.x87SetTop0(); // re-bases the cached stack of an x87 region (EMMS makes one)
  if (E.usesX87) { c.i32(0).set(L_FTW); E.stValid = 0; }
  else c.get(L_STATE).i32(0).i32store16(ST.FPU_TW);
};

// ------------------------------------------------------------------ MASKMOVQ / MASKMOVDQU
// Byte-masked store of ops[0] to [EDI] (DS by default, FS/GS via a segment override), one
// conditional store8_lane per byte so that only selected bytes are written; the base address
// sits in L_TA for the single SMC page check (same granularity as the other vector stores).

function maskmov(E, insn) {
  const d = insn.ops[0], m = insn.ops[1]; const c = E.c; const n = width(d);
  touch(E, insn);
  vec(E, d); c.set(L_V0);
  vec(E, m); c.i8x16bitmask().set(L_TV);
  c.get(L_REG + 7);
  if (insn.seg === SEG.FS) c.get(L_FS).add();
  else if (insn.seg === SEG.GS) c.get(L_STATE).i32load(ST.GS_BASE).add();
  c.set(L_TA);
  for (let i = 0; i < n; i++) {
    c.get(L_TV).i32(1 << i).and();
    const l = c.if_();
    c.get(L_TA).get(L_V0).v128store8lane(i, i);
    c.end(); void l;
  }
  E.smcCheck(insn, n); // (MASKMOVDQU: an unaligned 16-byte store, may straddle two pages)
}
HANDLERS[OP.MASKMOVQ] = maskmov;
HANDLERS[OP.MASKMOVDQU] = maskmov;

// the f64 shadow family (translate.js XMM_SHADOW64_OPS): their XMM accesses go through scalarI32 / scalarI64 /
// xmmLowI64 / xmmStoreShadowed64, or drop the destination's shadow after writing the whole register
for (const k of ['MOVD', 'MOVQ', 'PEXTRW']) XMM_SHADOW64_OPS.add(OP[k]);

export {};

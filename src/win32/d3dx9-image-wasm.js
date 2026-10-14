// WebAssembly SIMD kernels of D3DX's image work (d3dx9-image.js), each giving the bytes of the JavaScript code it
// stands for, bit for bit:
// - encodeRows: the DXT1/3/5 block encoder (encodeDxtRowsJs). Every decision of the JavaScript encoder is taken on the
//   same values computed the same way: endpoint texels by integer luminance (first minimum / maximum), the palette on
//   f64 (k * 255 / 31...), each texel's projection on the endpoint axis in f64 with the same operations in the same
//   order (two texels per f64x2: IEEE results do not depend on the lane), the same thresholds and comparisons; the
//   DXT5 alpha levels and distances in f64 with the same strict "nearer than every earlier level" scan. No fused
//   multiply-add (WebAssembly has none outside relaxed SIMD).
// - swizzle: 32-bit texels with red and blue exchanged and an alpha mask ORed (A8R8G8B8 / X8R8G8B8 <-> RGBA8), rows
//   `pitch` bytes apart.
// - halve: the 2:1 box filter of mip levels, (a + b + c + d + 2) >> 2 per channel, on 16-bit lanes.
// - decodeDxt: DXT1/3/5 blocks to RGBA8 (d3d8-webgl.js decodeDxt), integer arithmetic throughout.
// - unpack<fmt> / pack<fmt>: the 16-bit formats (R5G6B5, X1R5G5B5, A1R5G5B5, A4R4G4B4, X4R4G4B4) to and from RGBA8,
//   eight texels at a time (FMT16).
// The module imports its memory: a private one on the calling thread, or the DXT pool's shared memory in the helpers
// (dxt-pool.js), which then encode their block rows in place.
import { ModuleBuilder, Code, T } from '../cpu/jit/wasm.js';

/** fmt argument of encodeRows: 1 DXT1 (with its transparent mode), 3 DXT2/3 (explicit alpha), 5 DXT4/5 (interpolated alpha) */
export const KIND = Object.freeze({ DXT1: 1, DXT3: 3, DXT5: 5 });
/** bytes of scratch a call needs (the 4 x 4 texels of the block, 16-byte aligned) */
export const SCRATCH_BYTES = 64;

const i32x4c = (a, b, c, d) => { const v = new Uint8Array(16), dv = new DataView(v.buffer); [a, b, c, d].forEach((x, i) => dv.setInt32(4 * i, x, true)); return v; };
const HI_TO_LO = [8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15]; // (i32 lanes 2, 3 -> 0, 1)
const SWAP64 = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7], SWAP32 = [4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11];

/**
 * colorBlock(px, out): one color block (8 bytes at out) of the 16 RGBA texels at px. `transparent`: DXT1's 3-color mode
 * for texels whose alpha is below 128 (the function for DXT1), else the 4-color mode only (DXT3/5's color half).
 */
function colorBlockCode(transparent) {
  const c = new Code();
  const PX = 0, OUT = 1;
  let n = 2;
  const R = [n++, n++, n++, n++], TM = [n++, n++, n++, n++]; // v128: the rows; their transparent-texel masks
  const V = n++, W = n++, MN = n++, MX = n++; // v128 scratch
  const BR = n++, BG = n++, BB = n++, DR = n++, DG = n++, DB = n++, HI0 = n++, MID = n++, LOW = n++, NN = n++, NH = n++; // v128 (f64x2)
  const v128Count = n - 2;
  const LO = n++, HI = n++, ANYT = n++, C0 = n++, C1 = n++, IDX = n++, MLO = n++, MHI = n++, B0 = n++, B1 = n++, TB = n++, TT = n++;
  const i32Count = n - 2 - v128Count;
  const AR = n++, AG = n++, AB = n++, FBR = n++, FBG = n++, FBB = n++, FDR = n++, FDG = n++, FDB = n++, DD = n++;
  const f64Count = n - 2 - v128Count - i32Count;
  const k255 = i32x4c(255, 255, 255, 255);
  // the rows, each texel's luminance r * 2 + g * 4 + b, with transparent texels out of the minimum and maximum
  for (let k = 0; k < 4; k++) {
    c.get(PX).v128load(16 * k).set(R[k]);
    // l = (r << 1) + (g << 2) + b
    c.get(R[k]).v128const(k255).v128and().i32(1).i32x4shl();
    c.get(R[k]).i32(8).i32x4shr_u().v128const(k255).v128and().i32(2).i32x4shl().i32x4add();
    c.get(R[k]).i32(16).i32x4shr_u().v128const(k255).v128and().i32x4add().set(V);
    if (transparent) {
      c.get(R[k]).v128const(i32x4c(-1, -1, -1, -1)).i32x4gt_s().set(TM[k]); // (alpha < 128: the word's sign bit clear)
      // minimum: transparent texels at 0x7fffffff; maximum: at -1 (luminances are 0..1785)
      if (k === 0) { c.get(V).get(TM[k]).i32(1).i32x4shr_u().v128or().set(MN); c.get(V).get(TM[k]).v128or().set(MX); }
      else { c.get(MN).get(V).get(TM[k]).i32(1).i32x4shr_u().v128or().i32x4min_s().set(MN); c.get(MX).get(V).get(TM[k]).v128or().i32x4max_s().set(MX); }
      // (the per-row values again for the index search below: kept in TM's companions)
    } else if (k === 0) { c.get(V).set(MN); c.get(V).set(MX); } else { c.get(MN).get(V).i32x4min_s().set(MN); c.get(MX).get(V).i32x4max_s().set(MX); }
    c.get(V).set(k === 0 ? NN : k === 1 ? NH : k === 2 ? W : V); // (row luminances kept: rows 0..2 in NN, NH, W; row 3 stays in V)
  }
  // horizontal minimum / maximum, splatted
  c.get(MN).get(MN).get(MN).i8x16shuffle(SWAP64).i32x4min_s().set(MN); c.get(MN).get(MN).get(MN).i8x16shuffle(SWAP32).i32x4min_s().set(MN);
  c.get(MX).get(MX).get(MX).i8x16shuffle(SWAP64).i32x4max_s().set(MX); c.get(MX).get(MX).get(MX).i8x16shuffle(SWAP32).i32x4max_s().set(MX);
  // first texel at the minimum (lo) and at the maximum (hi): bitmasks of the rows' equalities, lowest bit set
  const rowLum = (k) => {
    const v = k === 0 ? NN : k === 1 ? NH : k === 2 ? W : V;
    c.get(v);
  };
  const firstEq = (ext, toward, dst) => { // ext: MN or MX; toward: transparent texels' value
    for (let k = 0; k < 4; k++) {
      rowLum(k);
      if (transparent) { c.get(TM[k]); if (toward === 'min') c.i32(1).i32x4shr_u(); c.v128or(); }
      c.get(ext).i32x4eq().i32x4bitmask();
      if (k) c.i32(4 * k).shl().or();
    }
    c.ctz().set(dst);
  };
  firstEq(MN, 'min', LO); firstEq(MX, 'max', HI);
  if (transparent) c.get(TM[0]).get(TM[1]).v128or().get(TM[2]).get(TM[3]).v128or().v128or().v128anytrue().set(ANYT);
  // endpoints: to565 of the brightest (c0) and darkest (c1) texels
  const to565 = (texelIdx) => {
    c.get(PX).get(texelIdx).i32(2).shl().add().i32load(0).set(TT);
    c.get(TT).i32(0xf8).and().i32(8).shl().get(TT).i32(5).shr_u().i32(0x7e0).and().or().get(TT).i32(19).shr_u().i32(0x1f).and().or();
  };
  to565(HI); c.set(C0); to565(LO); c.set(C1);
  const swap = () => { c.get(C0).set(TT); c.get(C1).set(C0); c.get(TT).set(C1); };
  const opaqueOrder = () => {
    c.get(C0).get(C1).lt_u(); c.if_(); swap(); c.end();
    c.get(C0).get(C1).eq(); c.if_();
    c.get(C1).i32(0).gt_u(); c.if_(); c.get(C1).i32(1).sub().set(C1); c.else_(); c.get(C0).i32(1).add().set(C0); c.end();
    c.end();
  };
  if (transparent) { c.get(ANYT); c.if_(); c.get(C0).get(C1).gt_u(); c.if_(); swap(); c.end(); c.else_(); opaqueOrder(); c.end(); }
  else opaqueOrder();
  // the palette's ends as JavaScript computes them: (k * 255) / 31 (or / 63)
  const expand = (cv, shift, mask, div, dst) => { c.get(cv); if (shift) c.i32(shift).shr_u(); c.i32(mask).and().i32(255).mul().f64convert_i32_s().f64c(div).f64div().set(dst); };
  expand(C0, 11, 31, 31, AR); expand(C0, 5, 63, 63, AG); expand(C0, 0, 31, 31, AB);
  expand(C1, 11, 31, 31, FBR); expand(C1, 5, 63, 63, FBG); expand(C1, 0, 31, 31, FBB);
  c.get(AR).get(FBR).f64sub().set(FDR); c.get(AG).get(FBG).f64sub().set(FDG); c.get(AB).get(FBB).f64sub().set(FDB);
  c.get(FDR).get(FDR).f64mul().get(FDG).get(FDG).f64mul().f64add().get(FDB).get(FDB).f64mul().f64add().set(DD);
  c.i32(0).set(IDX);
  // transparent texels: index 3 (both bits), whatever the projection
  c.get(DD).f64c(0).f64gt();
  c.if_();
  {
    c.get(FBR).f64x2splat().set(BR); c.get(FBG).f64x2splat().set(BG); c.get(FBB).f64x2splat().set(BB);
    c.get(FDR).f64x2splat().set(DR); c.get(FDG).f64x2splat().set(DG); c.get(FDB).f64x2splat().set(DB);
    const thresholds = (hi0, mid) => { c.get(DD).f64c(hi0).f64mul().f64x2splat().set(HI0); c.get(DD).f64c(mid).f64mul().f64x2splat().set(MID); };
    if (transparent) { c.get(ANYT); c.if_(); thresholds(0.75, 0.25); c.else_(); thresholds(5 / 6, 0.5); c.end(); }
    else thresholds(5 / 6, 0.5);
    c.get(DD).f64c(1 / 6).f64mul().f64x2splat().set(LOW);
    // n = (r - br) * dr + (g - bg) * dg + (b - bb) * db, two texels per f64x2 (lanes 0, 1 then 2, 3 of the row)
    const proj = (k, high, dst) => {
      const conv = (shift) => { c.get(R[k]); if (shift) c.i32(shift).i32x4shr_u(); c.v128const(k255).v128and(); if (high) { c.set(W); c.get(W).get(W).i8x16shuffle(HI_TO_LO); } c.f64x2convert_low_i32x4_s(); };
      conv(0); c.get(BR).f64x2sub().get(DR).f64x2mul();
      conv(8); c.get(BG).f64x2sub().get(DG).f64x2mul().f64x2add();
      conv(16); c.get(BB).f64x2sub().get(DB).f64x2mul().f64x2add().set(dst);
    };
    // per pair: bit0 / bit1 masks of the index (general forms: no ordering of the thresholds assumed)
    //   4-color: A = n >= hi0, B = n >= mid, C = n > low: best = A ? 0 : B ? 2 : C ? 3 : 1 -> bit0 = !A & !B, bit1 = !A & (B | C)
    //   3-color: A = n >= hi0, M = n > mid: best = A ? 0 : M ? 2 : 1 -> bit0 = !A & !M, bit1 = !A & M
    const bits = (nv, three) => { // leaves bitmask(bit0) | bitmask(bit1) << 2 of the pair on the stack (2 + 2 bits)
      // bit0
      c.get(nv).get(HI0).f64x2ge().get(nv).get(MID); if (three) c.f64x2gt(); else c.f64x2ge(); c.v128or().v128not().i64x2bitmask();
      // bit1
      c.get(nv).get(MID); if (three) c.f64x2gt(); else { c.f64x2ge().get(nv).get(LOW).f64x2gt().v128or(); }
      c.get(nv).get(HI0).f64x2ge().v128andnot().i64x2bitmask().i32(2).shl().or();
    };
    const rows = (three) => {
      for (let k = 0; k < 4; k++) {
        proj(k, false, NN); proj(k, true, NH);
        bits(NN, three); c.set(MLO); bits(NH, three); c.set(MHI);
        // b0 = 4 bits (texels 0..3 of the row), b1 likewise
        c.get(MLO).i32(3).and().get(MHI).i32(3).and().i32(2).shl().or().set(B0);
        c.get(MLO).i32(2).shr_u().get(MHI).i32(2).shr_u().i32(2).shl().or().set(B1);
        if (transparent) { c.get(TM[k]).i32x4bitmask().tee(TB).get(B0).or().set(B0); c.get(TB).get(B1).or().set(B1); }
        spreadInto(k);
      }
    };
    if (transparent) { c.get(ANYT); c.if_(); rows(true); c.else_(); rows(false); c.end(); }
    else rows(false);
  }
  if (transparent) { // dd = 0 (equal endpoints, 3-color mode): opaque texels 0, transparent ones 3
    c.else_();
    c.get(ANYT); c.if_();
    for (let k = 0; k < 4; k++) { c.get(TM[k]).i32x4bitmask().tee(B0).set(B1); spreadInto(k); }
    c.end();
  }
  c.end();
  c.get(OUT).get(C0).i32store16(0); c.get(OUT).get(C1).i32store16(2); c.get(OUT).get(IDX).i32store(4, 0);
  function spreadInto(k) { // IDX |= (spread(B0) | spread(B1) << 1) << 8k, spread: 4 bits to every other bit of 8
    const spread = (v) => { c.get(v).get(v).i32(2).shl().or().i32(0x33).and().tee(TT).get(TT).i32(1).shl().or().i32(0x55).and(); };
    spread(B0); spread(B1); c.i32(1).shl().or();
    if (k) c.i32(8 * k).shl();
    c.get(IDX).or().set(IDX);
  }
  return { code: c, locals: [...Array(v128Count).fill(T.v128), ...Array(i32Count).fill(T.i32), ...Array(f64Count).fill(T.f64)] };
}

/** alphaBlock(px, out): DXT4/5 interpolated alpha (8 bytes at out), as d3dx9-image.js alphaBlock */
function alphaBlockCode() {
  const c = new Code();
  const PX = 0, OUT = 1;
  let n = 2;
  const A = [n++, n++, n++, n++]; // v128: the rows' alphas (i32 lanes)
  const MN = n++, MX = n++, X = n++, BD = n++, BEST = n++, D = n++, LT = n++;
  const v128Count = n - 2;
  const A0 = n++, A1 = n++; const i32Count = n - 2 - v128Count;
  const BITS = n++; const i64Count = 1;
  const PAL = Array.from({ length: 8 }, () => n++); const f64Count = 8;
  for (let k = 0; k < 4; k++) {
    c.get(PX).v128load(16 * k).i32(24).i32x4shr_u().set(A[k]);
    if (k === 0) { c.get(A[0]).set(MN); c.get(A[0]).set(MX); } else { c.get(MN).get(A[k]).i32x4min_s().set(MN); c.get(MX).get(A[k]).i32x4max_s().set(MX); }
  }
  c.get(MN).get(MN).get(MN).i8x16shuffle(SWAP64).i32x4min_s().set(MN); c.get(MN).get(MN).get(MN).i8x16shuffle(SWAP32).i32x4min_s().i32x4extractlane(0).set(A1);
  c.get(MX).get(MX).get(MX).i8x16shuffle(SWAP64).i32x4max_s().set(MX); c.get(MX).get(MX).get(MX).i8x16shuffle(SWAP32).i32x4max_s().i32x4extractlane(0).set(A0);
  c.get(A0).get(A1).eq(); c.if_(); c.get(A1).i32(0).gt_u(); c.if_(); c.get(A1).i32(1).sub().set(A1); c.else_(); c.get(A0).i32(1).add().set(A0); c.end(); c.end();
  // levels: a0, a1, then ((7 - k) a0 + k a1) / 7 for k = 1..6
  c.get(A0).f64convert_i32_s().set(PAL[0]); c.get(A1).f64convert_i32_s().set(PAL[1]);
  for (let k = 1; k < 7; k++) c.i32(7 - k).get(A0).mul().i32(k).get(A1).mul().add().f64convert_i32_s().f64c(7).f64div().set(PAL[k + 1]);
  c.i64(0).set(BITS);
  // each texel: the first level strictly nearer than every earlier one (distances |level - a| in f64), two texels per f64x2
  for (let p = 0; p < 8; p++) {
    const k = p >> 1, high = p & 1;
    c.get(A[k]); if (high) c.get(A[k]).i8x16shuffle(HI_TO_LO);
    c.f64x2convert_low_i32x4_s().set(X);
    c.get(PAL[0]).f64x2splat().get(X).f64x2sub().f64x2abs().set(BD);
    c.v128const(new Uint8Array(16)).set(BEST);
    for (let l = 1; l < 8; l++) {
      c.get(PAL[l]).f64x2splat().get(X).f64x2sub().f64x2abs().tee(D).get(BD).f64x2lt().set(LT);
      c.get(D).get(BD).get(LT).v128bitselect().set(BD);
      c.i64(l).i64x2splat().get(BEST).get(LT).v128bitselect().set(BEST);
    }
    // texels 2p, 2p + 1: their 3-bit indexes at bit 6p
    c.get(BEST).i64x2extractlane(0).get(BEST).i64x2extractlane(1).i64(3).i64shl().i64or();
    if (p) c.i64(6 * p).i64shl();
    c.get(BITS).i64or().set(BITS);
  }
  c.get(OUT).get(A0).i32store8(0); c.get(OUT).get(A1).i32store8(1);
  c.get(OUT).get(BITS).i64store32(2); c.get(OUT).get(BITS).i64(32).i64shr_u().wrap().i32store16(6);
  return { code: c, locals: [...Array(v128Count).fill(T.v128), ...Array(i32Count).fill(T.i32), ...Array(i64Count).fill(T.i64), ...Array(f64Count).fill(T.f64)] };
}

/** explicitAlpha(px, out): DXT2/3 4-bit alphas (8 bytes at out): byte i = (a(2i) >> 4) | (a(2i + 1) >> 4) << 4 */
function explicitAlphaCode() {
  const c = new Code();
  const PX = 0, OUT = 1, V = 2;
  // nibbles a >> 4 per texel (i32 lanes) narrowed to 16 bytes in texel order, then pairs joined: (lo & 15) | (hi << 4)
  c.get(PX).v128load(0).i32(28).i32x4shr_u().get(PX).v128load(16).i32(28).i32x4shr_u().i16x8narrow_i32x4_u();
  c.get(PX).v128load(32).i32(28).i32x4shr_u().get(PX).v128load(48).i32(28).i32x4shr_u().i16x8narrow_i32x4_u();
  c.i8x16narrow_i16x8_u().set(V);
  c.get(V).v128const(i32x4c(0x000f000f, 0x000f000f, 0x000f000f, 0x000f000f)).v128and();
  c.get(V).i32(4).i16x8shr_u().v128const(i32x4c(0x00f000f0, 0x00f000f0, 0x00f000f0, 0x00f000f0)).v128and().v128or();
  c.set(V);
  c.get(OUT).get(V).get(V).i8x16narrow_i16x8_u().v128store64lane(0, 0);
  return { code: c, locals: [T.v128] };
}

/**
 * encodeRows(kind, w, h, by0, by1, src, dst, scratch): block rows [by0, by1) of the RGBA8 image at src (w x h), written
 * at their place in the image's blocks at dst; edge blocks repeat the last row / column (as encodeDxtRows).
 */
function encodeRowsCode(fColor1, fColor, fAlpha5, fAlpha3) {
  const c = new Code();
  const KINDP = 0, W = 1, H = 2, BY0 = 3, BY1 = 4, SRC = 5, DST = 6, S = 7;
  const BW = 8, UNIT = 9, BY = 10, BX = 11, O = 12, Y = 13, X = 14, SY = 15, ROW = 16;
  c.get(W).i32(3).add().i32(2).shr_u().tee(BW).eqz(); c.if_(); c.i32(1).set(BW); c.end();
  c.get(KINDP).i32(1).eq(); c.if_(T.i32); c.i32(8); c.else_(); c.i32(16); c.end(); c.set(UNIT);
  c.get(BY0).set(BY);
  const rowsDone = c.block(); const rowLoop = c.loop();
  c.get(BY).get(BY1).ge_s().br_if(rowsDone);
  c.i32(0).set(BX);
  const colsDone = c.block(); const colLoop = c.loop();
  c.get(BX).get(BW).ge_s().br_if(colsDone);
  // the block's 16 texels into the scratch
  c.get(BX).i32(2).shl().i32(3).add().get(W).lt_s().get(BY).i32(2).shl().i32(3).add().get(H).lt_s().and();
  c.if_();
  { // inside the image: four rows of four texels
    c.get(SRC).get(BY).i32(2).shl().get(W).mul().get(BX).i32(2).shl().add().i32(2).shl().add().set(ROW);
    for (let y = 0; y < 4; y++) { c.get(S).get(ROW).v128load(0).v128store(16 * y); if (y < 3) c.get(ROW).get(W).i32(2).shl().add().set(ROW); }
  }
  c.else_();
  { // an edge block: coordinates clamped to the last row / column
    c.i32(0).set(Y);
    const yl = c.loop();
    c.get(BY).i32(2).shl().get(Y).add().tee(SY).get(H).i32(1).sub().tee(ROW).get(SY).get(ROW).lt_s().select().set(SY);
    c.i32(0).set(X);
    const xl = c.loop();
    c.get(S).get(Y).i32(4).shl().add().get(X).i32(2).shl().add(); // (destination)
    c.get(BX).i32(2).shl().get(X).add().tee(ROW).get(W).i32(1).sub().tee(O).get(ROW).get(O).lt_s().select(); // sx
    c.get(SY).get(W).mul().add().i32(2).shl().get(SRC).add().i32load(0, 0).i32store(0, 0);
    c.get(X).i32(1).add().tee(X).i32(4).lt_s().br_if(xl);
    c.end(); void xl;
    c.get(Y).i32(1).add().tee(Y).i32(4).lt_s().br_if(yl);
    c.end(); void yl;
  }
  c.end();
  c.get(DST).get(BY).get(BW).mul().get(BX).add().get(UNIT).mul().add().set(O);
  c.get(KINDP).i32(1).eq(); c.if_();
  c.get(S).get(O).call(fColor1);
  c.else_();
  c.get(KINDP).i32(3).eq(); c.if_(); c.get(S).get(O).call(fAlpha3); c.else_(); c.get(S).get(O).call(fAlpha5); c.end();
  c.get(S).get(O).i32(8).add().call(fColor);
  c.end();
  c.get(BX).i32(1).add().set(BX); c.br(colLoop);
  c.end(); c.end(); void colsDone;
  c.get(BY).i32(1).add().set(BY); c.br(rowLoop);
  c.end(); c.end(); void rowsDone;
  return { code: c, locals: Array(9).fill(T.i32) };
}

/** swizzle(src, pitch, dst, w, h, alphaOr): w x h 32-bit texels, rows `pitch` bytes apart at src, to packed rows at dst */
function swizzleCode() {
  const c = new Code();
  const SRC = 0, PITCH = 1, DST = 2, W = 3, H = 4, AO = 5, Y = 6, X = 7, S = 8, D = 9, V = 10, AV = 11, SH = 12;
  c.get(AO).i32x4splat().set(AV);
  c.v128const(Uint8Array.from([2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15])).set(SH);
  c.i32(0).set(Y);
  const yd = c.block(); const yl = c.loop();
  c.get(Y).get(H).ge_s().br_if(yd);
  c.get(SRC).get(Y).get(PITCH).mul().add().set(S); c.get(DST).get(Y).get(W).mul().i32(2).shl().add().set(D);
  c.i32(0).set(X);
  const xd = c.block(); const xl = c.loop(); // (four texels at a time)
  c.get(X).i32(4).add().get(W).gt_s().br_if(xd);
  c.get(D).get(S).v128load(0).get(SH).i8x16swizzle().get(AV).v128or().v128store(0);
  c.get(S).i32(16).add().set(S); c.get(D).i32(16).add().set(D); c.get(X).i32(4).add().set(X); c.br(xl);
  c.end(); c.end(); void xd;
  const td = c.block(); const tl = c.loop(); // (the last ones of the row)
  c.get(X).get(W).ge_s().br_if(td);
  c.get(D).get(S).i32load(0, 0).tee(V).i32(0xff00ff00 | 0).and().get(V).i32(0xff).and().i32(16).shl().or().get(V).i32(16).shr_u().i32(0xff).and().or().get(AO).or().i32store(0, 0);
  c.get(S).i32(4).add().set(S); c.get(D).i32(4).add().set(D); c.get(X).i32(1).add().set(X); c.br(tl);
  c.end(); c.end(); void td;
  c.get(Y).i32(1).add().set(Y); c.br(yl);
  c.end(); c.end(); void yd;
  return { code: c, locals: [T.i32, T.i32, T.i32, T.i32, T.i32, T.v128, T.v128] };
}

/** halve(src, dst, dw, dh): the 2 dw x 2 dh RGBA8 image at src box-filtered to dw x dh at dst */
function halveCode() {
  const c = new Code();
  const SRC = 0, DST = 1, DW = 2, DH = 3, Y = 4, X = 5, S = 6, D = 7, ROW = 8, A = 9, B = 10, TWO = 11;
  c.v128const(Uint8Array.from([2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0])).set(TWO);
  c.get(DW).i32(3).shl().set(ROW); // (a source row: 2 dw texels)
  c.i32(0).set(Y);
  const yd = c.block(); const yl = c.loop();
  c.get(Y).get(DH).ge_s().br_if(yd);
  c.get(SRC).get(Y).get(ROW).mul().i32(1).shl().add().set(S); c.get(DST).get(Y).get(DW).mul().i32(2).shl().add().set(D);
  c.i32(0).set(X);
  const xd = c.block(); const xl = c.loop(); // (two output texels from 4 x 2 source texels)
  c.get(X).i32(2).add().get(DW).gt_s().br_if(xd);
  // channels on 16-bit lanes: the two rows summed (A: source texels 0, 1; B: 2, 3), then horizontal pairs
  c.get(S).v128load(0).i16x8extend_low_i8x16_u().get(S).get(ROW).add().v128load(0).i16x8extend_low_i8x16_u().i16x8add().set(A);
  c.get(S).v128load(0).i16x8extend_high_i8x16_u().get(S).get(ROW).add().v128load(0).i16x8extend_high_i8x16_u().i16x8add().set(B);
  c.get(A).get(B).i8x16shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
  c.get(A).get(B).i8x16shuffle([8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31]);
  c.i16x8add().get(TWO).i16x8add().i32(2).i16x8shr_u().set(A);
  c.get(D).get(A).get(A).i8x16narrow_i16x8_u().v128store64lane(0, 0);
  c.get(S).i32(16).add().set(S); c.get(D).i32(8).add().set(D); c.get(X).i32(2).add().set(X); c.br(xl);
  c.end(); c.end(); void xd;
  const td = c.block(); // (an odd width: the last texel from 2 x 2)
  c.get(X).get(DW).ge_s().br_if(td);
  c.get(S).v128load64zero(0).i16x8extend_low_i8x16_u().get(S).get(ROW).add().v128load64zero(0).i16x8extend_low_i8x16_u().i16x8add().set(A);
  c.get(A).get(A).i8x16shuffle([8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15]).get(A).i16x8add().get(TWO).i16x8add().i32(2).i16x8shr_u().set(A);
  c.get(D).get(A).get(A).i8x16narrow_i16x8_u().v128store32lane(0, 0);
  c.end(); void td;
  c.get(Y).i32(1).add().set(Y); c.br(yl);
  c.end(); c.end(); void yd;
  return { code: c, locals: [T.i32, T.i32, T.i32, T.i32, T.i32, T.v128, T.v128, T.v128] };
}

/**
 * 16-bit formats (D3DFORMAT numbers) the kernels convert: [shift, bits] of R, G, B, A (null: none — 255 decoded) and
 * the bits an encoding always sets. Decoding expands a channel k of b bits to k * 255 / (2^b - 1) truncated (the
 * JavaScript conversions' `| 0`), by table lookups (i8x16.swizzle on tables made by that same expression) for 5 and 6
 * bits, k * 17 for 4, k * 255 for 1; encoding rounds v * (2^b - 1) / 255 to nearest as Math.round does, computed
 * exactly as floor((v (2^b - 1) + 127) / 255) = (z + 1 + (z >> 8)) >> 8 (checked for every value by the tests).
 */
export const FMT16 = Object.freeze({
  23: { ch: [[11, 5], [5, 6], [0, 5], null], set: 0 }, // R5G6B5
  24: { ch: [[10, 5], [5, 5], [0, 5], null], set: 0x8000 }, // X1R5G5B5
  25: { ch: [[10, 5], [5, 5], [0, 5], [15, 1]], set: 0 }, // A1R5G5B5
  26: { ch: [[8, 4], [4, 4], [0, 4], [12, 4]], set: 0 }, // A4R4G4B4
  30: { ch: [[8, 4], [4, 4], [0, 4], null], set: 0xf000 }, // X4R4G4B4
});
const i16x8c = (v) => { const b = new Uint8Array(16); for (let i = 0; i < 8; i++) { b[2 * i] = v & 255; b[2 * i + 1] = (v >> 8) & 255; } return b; };
/** unpack16(src, pitch, dst, w, h): w x h texels of a FMT16 format (rows `pitch` bytes apart) to packed RGBA8 */
function unpack16Code(f) {
  const c = new Code();
  const SRC = 0, PITCH = 1, DST = 2, W = 3, H = 4, Y = 5, X = 6, S = 7, D = 8, V0 = 9, V1 = 10, CH = [11, 12, 13, 14], RG = 15, GR = 16, BA = 17, AB = 18;
  const WORD = 19, K = 20;
  const ZIP_LO = [0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23], ZIP_HI = ZIP_LO.map((i) => i + 8);
  const ZIP16_LO = [0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23], ZIP16_HI = ZIP16_LO.map((i) => i + 8);
  c.i32(0).set(Y);
  const yd = c.block(); const yl = c.loop();
  c.get(Y).get(H).ge_s().br_if(yd);
  c.get(SRC).get(Y).get(PITCH).mul().add().set(S); c.get(DST).get(Y).get(W).mul().i32(2).shl().add().set(D);
  c.i32(0).set(X);
  const xd = c.block(); const xl = c.loop(); // (sixteen texels at a time: each channel's 16 values in the byte lanes of one vector)
  c.get(X).i32(16).add().get(W).gt_s().br_if(xd);
  c.get(S).v128load(0).set(V0); c.get(S).v128load(16).set(V1);
  f.ch.forEach((ch, i) => {
    if (!ch) { c.v128const(new Uint8Array(16).fill(255)).set(CH[i]); return; }
    const [shift, bits] = ch, m = (1 << bits) - 1;
    for (const v of [V0, V1]) {
      c.get(v); if (shift) c.i32(shift).i16x8shr_u(); c.v128const(i16x8c(m)).v128and();
      if (bits === 1 || bits === 4) c.v128const(i16x8c(bits === 1 ? 255 : 17)).i16x8mul();
    }
    c.i8x16narrow_i16x8_u().set(CH[i]);
    if (bits === 1 || bits === 4) return;
    for (let t = 0; t < (m + 1) / 16; t++) { // (16 entries of k * 255 / m per table; an index past them gives 0)
      c.v128const(Uint8Array.from({ length: 16 }, (_, j) => ((16 * t + j) * 255 / m) | 0)).get(CH[i]); if (t) c.i32(16 * t).i8x16splat().i8x16sub(); c.i8x16swizzle();
      if (t) c.v128or();
    }
    c.set(CH[i]);
  });
  // R,G,B,A byte vectors to 64 bytes of R,G,B,A texels
  c.get(CH[0]).get(CH[1]).i8x16shuffle(ZIP_LO).set(RG); c.get(CH[0]).get(CH[1]).i8x16shuffle(ZIP_HI).set(GR);
  c.get(CH[2]).get(CH[3]).i8x16shuffle(ZIP_LO).set(BA); c.get(CH[2]).get(CH[3]).i8x16shuffle(ZIP_HI).set(AB);
  c.get(D).get(RG).get(BA).i8x16shuffle(ZIP16_LO).v128store(0);
  c.get(D).get(RG).get(BA).i8x16shuffle(ZIP16_HI).v128store(16);
  c.get(D).get(GR).get(AB).i8x16shuffle(ZIP16_LO).v128store(32);
  c.get(D).get(GR).get(AB).i8x16shuffle(ZIP16_HI).v128store(48);
  c.get(S).i32(32).add().set(S); c.get(D).i32(64).add().set(D); c.get(X).i32(16).add().set(X); c.br(xl);
  c.end(); c.end(); void xd;
  const td = c.block(); const tl = c.loop(); // (the last texels of the row, one at a time)
  c.get(X).get(W).ge_s().br_if(td);
  c.get(S).i32load16u(0).set(K); c.i32(0).set(WORD);
  f.ch.forEach((ch, i) => {
    if (!ch) c.i32(255);
    else { const [shift, bits] = ch, m = (1 << bits) - 1; c.get(K); if (shift) c.i32(shift).shr_u(); c.i32(m).and().i32(255).mul().i32(m).div_u(); }
    if (i) c.i32(8 * i).shl();
    c.get(WORD).or().set(WORD);
  });
  c.get(D).get(WORD).i32store(0, 0);
  c.get(S).i32(2).add().set(S); c.get(D).i32(4).add().set(D); c.get(X).i32(1).add().set(X); c.br(tl);
  c.end(); c.end(); void td;
  c.get(Y).i32(1).add().set(Y); c.br(yl);
  c.end(); c.end(); void yd;
  return { code: c, locals: [T.i32, T.i32, T.i32, T.i32, ...Array(10).fill(T.v128), T.i32, T.i32] };
}
/** pack16(src, dst, n): n packed RGBA8 texels to a FMT16 format */
function pack16Code(f) {
  const c = new Code();
  const SRC = 0, DST = 1, N = 2, I = 3, V0 = 4, V1 = 5, RG = 6, BA = 7, CH = [8, 9, 10, 11], Z = 12, ACC = 13, P = 14, Q = 15;
  // q = (z + 1 + (z >> 8)) >> 8, z = v * m + 127
  const quantV = (i, m) => { c.get(CH[i]).v128const(i16x8c(m)).i16x8mul().v128const(i16x8c(127)).i16x8add().tee(Z).v128const(i16x8c(1)).i16x8add().get(Z).i32(8).i16x8shr_u().i16x8add().i32(8).i16x8shr_u(); };
  c.i32(0).set(I);
  const vd = c.block(); const vl = c.loop(); // (eight texels at a time)
  c.get(I).i32(8).add().get(N).gt_s().br_if(vd);
  c.get(SRC).v128load(0).set(V0); c.get(SRC).v128load(16).set(V1);
  c.get(V0).get(V1).i8x16shuffle([0, 4, 8, 12, 16, 20, 24, 28, 1, 5, 9, 13, 17, 21, 25, 29]).set(RG);
  c.get(V0).get(V1).i8x16shuffle([2, 6, 10, 14, 18, 22, 26, 30, 3, 7, 11, 15, 19, 23, 27, 31]).set(BA);
  c.get(RG).i16x8extend_low_i8x16_u().set(CH[0]); c.get(RG).i16x8extend_high_i8x16_u().set(CH[1]);
  c.get(BA).i16x8extend_low_i8x16_u().set(CH[2]); c.get(BA).i16x8extend_high_i8x16_u().set(CH[3]);
  c.v128const(i16x8c(f.set)).set(ACC);
  f.ch.forEach((ch, i) => { if (!ch) return; const [shift, bits] = ch; quantV(i, (1 << bits) - 1); if (shift) c.i32(shift).i16x8shl(); c.get(ACC).v128or().set(ACC); });
  c.get(DST).get(ACC).v128store(0);
  c.get(SRC).i32(32).add().set(SRC); c.get(DST).i32(16).add().set(DST); c.get(I).i32(8).add().set(I); c.br(vl);
  c.end(); c.end(); void vd;
  const td = c.block(); const tl = c.loop(); // (the last texels, one at a time: q = floor((v m + 127) / 255))
  c.get(I).get(N).ge_s().br_if(td);
  c.get(SRC).i32load(0, 0).set(P); c.i32(f.set).set(Q);
  f.ch.forEach((ch, i) => {
    if (!ch) return; const [shift, bits] = ch, m = (1 << bits) - 1;
    c.get(P); if (i) c.i32(8 * i).shr_u(); c.i32(255).and().i32(m).mul().i32(127).add().i32(255).div_u();
    if (shift) c.i32(shift).shl();
    c.get(Q).or().set(Q);
  });
  c.get(DST).get(Q).i32store16(0);
  c.get(SRC).i32(4).add().set(SRC); c.get(DST).i32(2).add().set(DST); c.get(I).i32(1).add().set(I); c.br(tl);
  c.end(); c.end(); void td;
  return { code: c, locals: [T.i32, T.v128, T.v128, T.v128, T.v128, T.v128, T.v128, T.v128, T.v128, T.v128, T.v128, T.i32, T.i32] };
}

/**
 * decodeDxt(kind, src, w, h, dst, scratch): the DXT1/3/5 blocks at src decoded to w x h RGBA8 at dst, as the JavaScript
 * decoder (d3d8-webgl.js decodeDxt) computes them: endpoints expanded k * 255 / 31 (63) truncated, the 4-color palette
 * (2 c0 + c1) / 3 and (c0 + 2 c1) / 3 truncated, DXT1's 3-color mode (c0 <= c1) (c0 + c1) >> 1 and transparent black;
 * DXT3 alpha nibble * 17, DXT5 alpha levels ((7 - i) a0 + i a1) / 7 (a0 > a1) or ((5 - i) a0 + i a1) / 5 with 0 and 255,
 * truncated. The palette is built per block with integer arithmetic; each row's four texels are gathered from it with
 * i8x16.swizzle (byte indices made from the 2-bit color / 3-bit alpha indices). Blocks past the image's edge write their
 * texels inside it only (through `scratch`, 64 bytes).
 */
function decodeDxtCode() {
  const c = new Code();
  const KINDP = 0, SRC = 1, W = 2, H = 3, DST = 4, SCR = 5;
  let n = 6;
  const BW = n++, BH = n++, BX = n++, BY = n++, P = n++, C0 = n++, C1 = n++, R0 = n++, G0 = n++, B0 = n++, R1 = n++, G1 = n++, B1 = n++;
  const W2 = n++, W3 = n++, IDX = n++, A0 = n++, A1 = n++, ALO = n++, AHI = n++, ROW = n++, D = n++, Y = n++, X = n++, T0 = n++, EDGE = n++;
  const i32Count = n - 6;
  const PAL = n++, APAL = n++, K = n++, COL = n++; const v128Count = 4;
  c.get(W).i32(3).add().i32(2).shr_u().tee(BW).eqz(); c.if_(); c.i32(1).set(BW); c.end();
  c.get(H).i32(3).add().i32(2).shr_u().tee(BH).eqz(); c.if_(); c.i32(1).set(BH); c.end();
  c.get(SRC).set(P);
  c.i32(0).set(BY);
  const byd = c.block(); const byl = c.loop();
  c.get(BY).get(BH).ge_s().br_if(byd);
  c.i32(0).set(BX);
  const bxd = c.block(); const bxl = c.loop();
  c.get(BX).get(BW).ge_s().br_if(bxd);
  // ---- alpha (DXT3: nibbles, DXT5: 8-level palette and 3-bit indices); P moves past it
  c.get(KINDP).i32(1).ne(); c.if_();
  {
    c.get(KINDP).i32(3).eq(); c.if_();
    c.else_();
    {
      c.get(P).i32load8u(0).set(A0); c.get(P).i32load8u(1).set(A1);
      // levels as bytes of APAL: [a0, a1, l2..l7]
      const lvl = (k, num, den) => { c.i32(num - k).get(A0).mul().i32(k).get(A1).mul().add().i32(den).div_u(); };
      c.get(A0).get(A1).gt_u(); c.if_();
      c.get(A0).get(A1).i32(8).shl().or(); lvl(1, 7, 7); c.i32(16).shl().or(); lvl(2, 7, 7); c.i32(24).shl().or().set(T0);
      lvl(3, 7, 7); lvl(4, 7, 7); c.i32(8).shl().or(); lvl(5, 7, 7); c.i32(16).shl().or(); lvl(6, 7, 7); c.i32(24).shl().or().set(EDGE);
      c.else_();
      c.get(A0).get(A1).i32(8).shl().or(); lvl(1, 5, 5); c.i32(16).shl().or(); lvl(2, 5, 5); c.i32(24).shl().or().set(T0);
      lvl(3, 5, 5); lvl(4, 5, 5); c.i32(8).shl().or(); c.i32(0xff000000 | 0).or().set(EDGE); // (level 6: 0, level 7: 255)
      c.end();
      c.v128const(new Uint8Array(16)).get(T0).i32x4replacelane(0).get(EDGE).i32x4replacelane(1).set(APAL);
      c.get(P).i32load16u(2).get(P).i32load8u(4).i32(16).shl().or().set(ALO);
      c.get(P).i32load16u(5).get(P).i32load8u(7).i32(16).shl().or().set(AHI);
    }
    c.end();
    c.get(P).i32(8).add().set(P);
  }
  c.end();
  // ---- color palette: 4 RGBA words in PAL
  c.get(P).i32load16u(0).set(C0); c.get(P).i32load16u(2).set(C1); c.get(P).i32load(4, 0).set(IDX);
  const exp = (cv, shift, mask, dst) => { c.get(cv); if (shift) c.i32(shift).shr_u(); c.i32(mask).and().i32(255).mul().i32(mask).div_u().set(dst); };
  exp(C0, 11, 31, R0); exp(C0, 5, 63, G0); exp(C0, 0, 31, B0); exp(C1, 11, 31, R1); exp(C1, 5, 63, G1); exp(C1, 0, 31, B1);
  const word = (r, g, b, a) => { r(); g(); c.i32(8).shl().or(); b(); c.i32(16).shl().or(); if (a) c.i32(0xff000000 | 0).or(); };
  const third = (x, y) => () => { c.get(x).i32(1).shl().get(y).add().i32(3).div_u(); };
  c.get(KINDP).i32(1).ne().get(C0).get(C1).gt_u().or(); c.if_();
  word(third(R0, R1), third(G0, G1), third(B0, B1), true); c.set(W2);
  word(third(R1, R0), third(G1, G0), third(B1, B0), true); c.set(W3);
  c.else_();
  const half = (x, y) => () => { c.get(x).get(y).add().i32(1).shr_u(); };
  word(half(R0, R1), half(G0, G1), half(B0, B1), true); c.set(W2);
  c.i32(0).set(W3);
  c.end();
  word(() => c.get(R0), () => c.get(G0), () => c.get(B0), true); c.i32x4splat();
  word(() => c.get(R1), () => c.get(G1), () => c.get(B1), true); c.i32x4replacelane(1);
  c.get(W2).i32x4replacelane(2).get(W3).i32x4replacelane(3).set(PAL);
  // ---- the 4 rows: inside the image straight to dst, at the edge through the scratch
  c.get(BX).i32(2).shl().i32(3).add().get(W).ge_s().get(BY).i32(2).shl().i32(3).add().get(H).ge_s().or().set(EDGE);
  c.get(DST).get(BY).i32(2).shl().get(W).mul().get(BX).i32(2).shl().add().i32(2).shl().add().set(D);
  for (let r = 0; r < 4; r++) {
    // color indices of the row's texels j: (byte >> 2j) & 3, as byte indices 4k..4k+3 of the palette
    c.get(IDX); if (r) c.i32(8 * r).shr_u(); c.i32(255).and().i32x4splat().v128const(i32x4c(64, 16, 4, 1)).i32x4mul().i32(6).i32x4shr_u().v128const(i32x4c(3, 3, 3, 3)).v128and();
    c.v128const(i32x4c(0x04040404, 0x04040404, 0x04040404, 0x04040404)).i32x4mul().v128const(i32x4c(0x03020100, 0x03020100, 0x03020100, 0x03020100)).i32x4add().set(K);
    c.get(PAL).get(K).i8x16swizzle().set(COL);
    c.get(KINDP).i32(1).ne(); c.if_();
    c.get(KINDP).i32(3).eq(); c.if_();
    // DXT3: nibble j of the row's 16 bits, * 17, in byte 3
    c.get(P).i32(8).sub().i32load16u(2 * r).i32x4splat().v128const(i32x4c(4096, 256, 16, 1)).i32x4mul().i32(12).i32x4shr_u().v128const(i32x4c(15, 15, 15, 15)).v128and();
    c.v128const(i32x4c(17, 17, 17, 17)).i32x4mul().i32(24).i32x4shl().set(K);
    c.else_();
    // DXT5: index j = (row bits >> 3j) & 7, the level byte swizzled into byte 3 (bytes 0..2: index 16, out of range: 0)
    c.get(r < 2 ? ALO : AHI); if (r & 1) c.i32(12).shr_u(); c.i32(0xfff).and().i32x4splat().v128const(i32x4c(512, 64, 8, 1)).i32x4mul().i32(9).i32x4shr_u().v128const(i32x4c(7, 7, 7, 7)).v128and();
    c.i32(24).i32x4shl().v128const(i32x4c(0x00101010, 0x00101010, 0x00101010, 0x00101010)).v128or().set(K);
    c.get(APAL).get(K).i8x16swizzle().set(K);
    c.end();
    c.get(COL).v128const(i32x4c(0x00ffffff, 0x00ffffff, 0x00ffffff, 0x00ffffff)).v128and().get(K).v128or().set(COL);
    c.end();
    c.get(EDGE); c.if_(); c.get(SCR).get(COL).v128store(16 * r); c.else_(); c.get(D).get(COL).v128store(0); c.get(D).get(W).i32(2).shl().add().set(D); c.end();
  }
  // edge block: its texels inside the image from the scratch
  c.get(EDGE); c.if_();
  c.i32(0).set(Y);
  const eyd = c.block(); const eyl = c.loop();
  c.get(Y).i32(4).ge_s().get(BY).i32(2).shl().get(Y).add().get(H).ge_s().or().br_if(eyd);
  c.i32(0).set(X);
  const exd = c.block(); const exl = c.loop();
  c.get(X).i32(4).ge_s().get(BX).i32(2).shl().get(X).add().get(W).ge_s().or().br_if(exd);
  c.get(DST).get(BY).i32(2).shl().get(Y).add().get(W).mul().get(BX).i32(2).shl().add().get(X).add().i32(2).shl().add();
  c.get(SCR).get(Y).i32(4).shl().add().get(X).i32(2).shl().add().i32load(0).i32store(0, 0);
  c.get(X).i32(1).add().set(X); c.br(exl);
  c.end(); c.end(); void exd;
  c.get(Y).i32(1).add().set(Y); c.br(eyl);
  c.end(); c.end(); void eyd;
  c.end();
  c.get(P).i32(8).add().set(P);
  c.get(BX).i32(1).add().set(BX); c.br(bxl);
  c.end(); c.end(); void bxd;
  c.get(BY).i32(1).add().set(BY); c.br(byl);
  c.end(); c.end(); void byd;
  return { code: c, locals: [...Array(i32Count).fill(T.i32), ...Array(v128Count).fill(T.v128)] };
}

// snapshot: constant, the kernels' module bytes built once
const moduleBytes = new Map();
/** The kernels' module bytes (its memory imported as env.memory, shared or not). */
export function imageModuleBytes(shared) {
  let b = moduleBytes.get(shared);
  if (b) return b;
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, shared ? 65536 : undefined, shared);
  const f = (gen, params, name) => { const { code, locals } = gen; return m.func(params, [], locals, code, name); };
  const fColor1 = f(colorBlockCode(true), [T.i32, T.i32], 'colorBlockDxt1');
  const fColor = f(colorBlockCode(false), [T.i32, T.i32], 'colorBlock');
  const fAlpha5 = f(alphaBlockCode(), [T.i32, T.i32], 'alphaBlock');
  const fAlpha3 = f(explicitAlphaCode(), [T.i32, T.i32], 'explicitAlpha');
  m.exportFunc('encodeRows', f(encodeRowsCode(fColor1, fColor, fAlpha5, fAlpha3), Array(8).fill(T.i32), 'encodeRows'));
  m.exportFunc('swizzle', f(swizzleCode(), Array(6).fill(T.i32), 'swizzle'));
  m.exportFunc('halve', f(halveCode(), Array(4).fill(T.i32), 'halve'));
  m.exportFunc('decodeDxt', f(decodeDxtCode(), Array(6).fill(T.i32), 'decodeDxt'));
  for (const [fmt, desc] of Object.entries(FMT16)) {
    m.exportFunc(`unpack${fmt}`, f(unpack16Code(desc), Array(5).fill(T.i32), `unpack${fmt}`));
    m.exportFunc(`pack${fmt}`, f(pack16Code(desc), Array(3).fill(T.i32), `pack${fmt}`));
  }
  b = m.build();
  moduleBytes.set(shared, b);
  return b;
}

let supported = null; // snapshot: host capability, probed once
/** WebAssembly SIMD available (and the module valid here)? */
export function imageWasmSupported() {
  if (supported === null) { try { supported = typeof WebAssembly === 'object' && WebAssembly.validate(imageModuleBytes(false)); } catch { supported = false; } }
  return supported;
}

/**
 * The kernels on `memory` (a WebAssembly.Memory): encodeRows(kind, w, h, by0, by1, src, dst, scratch),
 * swizzle(src, pitch, dst, w, h, alphaOr), halve(src, dst, dw, dh), decodeDxt(kind, src, w, h, dst, scratch), and per FMT16 format unpack<fmt>(src, pitch, dst,
 * w, h) / pack<fmt>(src, dst, n).
 */
export function instantiateImage(memory) {
  const shared = typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer;
  return new WebAssembly.Instance(new WebAssembly.Module(imageModuleBytes(shared)), { env: { memory } }).exports;
}

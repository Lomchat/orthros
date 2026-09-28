// Minimal WebAssembly binary emitter: modules, imports/exports, functions with locals, and a
// typed instruction builder with structured-control label bookkeeping.

export const T = Object.freeze({ i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, empty: 0x40 });

const UTF8 = new TextEncoder();

export class ByteWriter {
  constructor(cap = 256) { this.buf = new Uint8Array(cap); this.len = 0; }
  ensure(n) { if (this.len + n > this.buf.length) { const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n)); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; } }
  byte(b) { this.ensure(1); this.buf[this.len++] = b & 0xff; return this; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; return this; }
  /** unsigned LEB128 */
  u(v) { v >>>= 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; this.byte(b); } while (v); return this; }
  /** signed LEB128 (32-bit) */
  s(v) {
    v |= 0;
    for (;;) {
      const b = v & 0x7f; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) { this.byte(b); return this; }
      this.byte(b | 0x80);
    }
  }
  /** signed LEB128 for 64-bit (BigInt) */
  s64(v) {
    v = BigInt.asIntN(64, BigInt(v));
    for (;;) {
      const b = Number(v & 0x7fn); v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40)) { this.byte(b); return this; }
      this.byte(b | 0x80);
    }
  }
  f32(v) { this.ensure(4); new DataView(this.buf.buffer).setFloat32(this.len, v, true); this.len += 4; return this; }
  f64(v) { this.ensure(8); new DataView(this.buf.buffer).setFloat64(this.len, v, true); this.len += 8; return this; }
  str(s) { const b = UTF8.encode(s); this.u(b.length); this.bytes(b); return this; }
  /** append another writer's contents prefixed with its length */
  sized(w) { this.u(w.len); this.bytes(w.buf.subarray(0, w.len)); return this; }
  raw(w) { this.bytes(w.buf.subarray(0, w.len)); return this; }
  finish() { return this.buf.slice(0, this.len); }
}

/**
 * Function body builder. Tracks the control stack so branch targets can be given as label
 * objects rather than raw depths.
 */
export class Code extends ByteWriter {
  constructor(cap) { super(cap); this.labels = []; this.hints = []; }
  /** empty the builder for another function body (the buffer is kept) */
  reset() { this.len = 0; this.labels = []; this.hints = []; this.callsTo = null; return this; }

  /**
   * Branch hint for the next instruction (an `if` or `br_if`): likely taken or not. Emitted in the
   * module's metadata.code.branch_hint section; the optimizing tier lays out and register-allocates
   * the unlikely side as deferred code (spills and reloads stay off the hot path).
   */
  hint(likely) { this.hints.push(this.len, likely ? 1 : 0); return this; }
  /** Function body bytes; the branch hints travel with them (`.hints`, pairs offset/direction). */
  finish() { const b = super.finish(); b.hints = this.hints; return b; }

  // ---- control
  // a label records its position on the control stack (fixed while it is open): depth is O(1)
  block(bt = T.empty) { this.byte(0x02).byte(bt); const l = { kind: 'block', at: this.labels.length }; this.labels.push(l); return l; }
  loop(bt = T.empty) { this.byte(0x03).byte(bt); const l = { kind: 'loop', at: this.labels.length }; this.labels.push(l); return l; }
  if_(bt = T.empty) { this.byte(0x04).byte(bt); const l = { kind: 'if', at: this.labels.length }; this.labels.push(l); return l; }
  else_() { this.byte(0x05); return this; }
  end() { this.byte(0x0b); this.labels.pop(); return this; }
  depth(l) { if (this.labels[l.at] !== l) throw new Error('label not on stack'); return this.labels.length - 1 - l.at; }
  br(l) { this.byte(0x0c).u(this.depth(l)); return this; }
  br_if(l) { this.byte(0x0d).u(this.depth(l)); return this; }
  br_table(ls, def) { this.byte(0x0e).u(ls.length); for (const l of ls) this.u(this.depth(l)); this.u(this.depth(def)); return this; }
  return_() { this.byte(0x0f); return this; }
  unreachable() { this.byte(0x00); return this; }
  nop() { this.byte(0x01); return this; }
  call(f) { (this.callsTo ??= []).push(f, this.site ?? -1); this.byte(0x10).u(f); return this; } // callsTo: [function, site] pairs (statistics; site: set by the user)
  call_indirect(type, table = 0) { this.byte(0x11).u(type).u(table); return this; }
  return_call(f) { this.byte(0x12).u(f); return this; }
  return_call_indirect(type, table = 0) { this.byte(0x13).u(type).u(table); return this; }
  drop() { this.byte(0x1a); return this; }
  select() { this.byte(0x1b); return this; }

  // ---- variables
  get(i) { this.byte(0x20).u(i); return this; }
  set(i) { this.byte(0x21).u(i); return this; }
  tee(i) { this.byte(0x22).u(i); return this; }
  gget(i) { this.byte(0x23).u(i); return this; }
  gset(i) { this.byte(0x24).u(i); return this; }

  // ---- memory (align as log2)
  mem(op, align, offset) { this.byte(op).u(align).u(offset >>> 0); return this; }
  i32load(off = 0, align = 2) { return this.mem(0x28, align, off); }
  i64load(off = 0, align = 3) { return this.mem(0x29, align, off); }
  f32load(off = 0, align = 2) { return this.mem(0x2a, align, off); }
  f64load(off = 0, align = 3) { return this.mem(0x2b, align, off); }
  i32load8s(off = 0) { return this.mem(0x2c, 0, off); }
  i32load8u(off = 0) { return this.mem(0x2d, 0, off); }
  i32load16s(off = 0) { return this.mem(0x2e, 1, off); }
  i32load16u(off = 0) { return this.mem(0x2f, 1, off); }
  i64load32u(off = 0) { return this.mem(0x35, 2, off); }
  i64load32s(off = 0) { return this.mem(0x34, 2, off); }
  i32store(off = 0, align = 2) { return this.mem(0x36, align, off); }
  i64store(off = 0, align = 3) { return this.mem(0x37, align, off); }
  f32store(off = 0, align = 2) { return this.mem(0x38, align, off); }
  f64store(off = 0, align = 3) { return this.mem(0x39, align, off); }
  i32store8(off = 0) { return this.mem(0x3a, 0, off); }
  i32store16(off = 0) { return this.mem(0x3b, 1, off); }
  i64store32(off = 0) { return this.mem(0x3e, 2, off); }
  v128load(off = 0) { this.byte(0xfd).u(0).u(4).u(off >>> 0); return this; }
  v128store(off = 0) { this.byte(0xfd).u(11).u(4).u(off >>> 0); return this; }

  // ---- SIMD (prefix 0xfd + unsigned-LEB128 id; ids >= 0x80 are two bytes)
  /** SIMD opcode without immediates */
  simd(id) { this.byte(0xfd).u(id); return this; }
  /** SIMD memory opcode: memarg = u(alignLog2) u(offset) */
  simdmem(id, align, off) { this.byte(0xfd).u(id).u(align).u(off >>> 0); return this; }
  /** SIMD lane memory opcode: memarg then one lane byte (stack: addr, v128) */
  simdlanemem(id, align, off, lane) { this.byte(0xfd).u(id).u(align).u(off >>> 0).byte(lane); return this; }
  /** SIMD lane opcode: one raw lane byte */
  simdlane(id, lane) { this.byte(0xfd).u(id).byte(lane); return this; }
  // memory forms
  v128load8x8s(off = 0) { return this.simdmem(0x01, 3, off); }
  v128load8x8u(off = 0) { return this.simdmem(0x02, 3, off); }
  v128load16x4s(off = 0) { return this.simdmem(0x03, 3, off); }
  v128load16x4u(off = 0) { return this.simdmem(0x04, 3, off); }
  v128load32x2s(off = 0) { return this.simdmem(0x05, 3, off); }
  v128load32x2u(off = 0) { return this.simdmem(0x06, 3, off); }
  v128load8splat(off = 0) { return this.simdmem(0x07, 0, off); }
  v128load16splat(off = 0) { return this.simdmem(0x08, 1, off); }
  v128load32splat(off = 0) { return this.simdmem(0x09, 2, off); }
  v128load64splat(off = 0) { return this.simdmem(0x0a, 3, off); }
  v128load8lane(off, lane) { return this.simdlanemem(0x54, 0, off, lane); }
  v128load16lane(off, lane) { return this.simdlanemem(0x55, 1, off, lane); }
  v128load32lane(off, lane) { return this.simdlanemem(0x56, 2, off, lane); }
  v128load64lane(off, lane) { return this.simdlanemem(0x57, 3, off, lane); }
  v128store8lane(off, lane) { return this.simdlanemem(0x58, 0, off, lane); }
  v128store16lane(off, lane) { return this.simdlanemem(0x59, 1, off, lane); }
  v128store32lane(off, lane) { return this.simdlanemem(0x5a, 2, off, lane); }
  v128store64lane(off, lane) { return this.simdlanemem(0x5b, 3, off, lane); }
  v128load32zero(off = 0) { return this.simdmem(0x5c, 2, off); }
  v128load64zero(off = 0) { return this.simdmem(0x5d, 3, off); }
  // constants / shuffles
  /** v128.const: 16 raw bytes (little-endian lane order) */
  v128const(bytes16) { if (bytes16.length !== 16) throw new Error('v128const needs 16 bytes'); this.byte(0xfd).u(0x0c).bytes(bytes16); return this; }
  /** i8x16.shuffle: 16 lane indices 0..31 (16..31 select from the second operand) */
  i8x16shuffle(lanes16) { if (lanes16.length !== 16) throw new Error('i8x16shuffle needs 16 lanes'); this.byte(0xfd).u(0x0d).bytes(lanes16); return this; }
  i8x16swizzle() { return this.simd(0x0e); }
  // splats
  i8x16splat() { return this.simd(0x0f); } i16x8splat() { return this.simd(0x10); } i32x4splat() { return this.simd(0x11); }
  i64x2splat() { return this.simd(0x12); } f32x4splat() { return this.simd(0x13); } f64x2splat() { return this.simd(0x14); }
  // extract / replace lanes
  i8x16extractlane_s(l) { return this.simdlane(0x15, l); } i8x16extractlane_u(l) { return this.simdlane(0x16, l); } i8x16replacelane(l) { return this.simdlane(0x17, l); }
  i16x8extractlane_s(l) { return this.simdlane(0x18, l); } i16x8extractlane_u(l) { return this.simdlane(0x19, l); } i16x8replacelane(l) { return this.simdlane(0x1a, l); }
  i32x4extractlane(l) { return this.simdlane(0x1b, l); } i32x4replacelane(l) { return this.simdlane(0x1c, l); }
  i64x2extractlane(l) { return this.simdlane(0x1d, l); } i64x2replacelane(l) { return this.simdlane(0x1e, l); }
  f32x4extractlane(l) { return this.simdlane(0x1f, l); } f32x4replacelane(l) { return this.simdlane(0x20, l); }
  f64x2extractlane(l) { return this.simdlane(0x21, l); } f64x2replacelane(l) { return this.simdlane(0x22, l); }
  // compares (all-ones / zero lane masks)
  i8x16eq() { return this.simd(0x23); } i8x16ne() { return this.simd(0x24); } i8x16lt_s() { return this.simd(0x25); } i8x16lt_u() { return this.simd(0x26); }
  i8x16gt_s() { return this.simd(0x27); } i8x16gt_u() { return this.simd(0x28); } i8x16le_s() { return this.simd(0x29); } i8x16le_u() { return this.simd(0x2a); }
  i8x16ge_s() { return this.simd(0x2b); } i8x16ge_u() { return this.simd(0x2c); }
  i16x8eq() { return this.simd(0x2d); } i16x8ne() { return this.simd(0x2e); } i16x8lt_s() { return this.simd(0x2f); } i16x8lt_u() { return this.simd(0x30); }
  i16x8gt_s() { return this.simd(0x31); } i16x8gt_u() { return this.simd(0x32); } i16x8le_s() { return this.simd(0x33); } i16x8le_u() { return this.simd(0x34); }
  i16x8ge_s() { return this.simd(0x35); } i16x8ge_u() { return this.simd(0x36); }
  i32x4eq() { return this.simd(0x37); } i32x4ne() { return this.simd(0x38); } i32x4lt_s() { return this.simd(0x39); } i32x4lt_u() { return this.simd(0x3a); }
  i32x4gt_s() { return this.simd(0x3b); } i32x4gt_u() { return this.simd(0x3c); } i32x4le_s() { return this.simd(0x3d); } i32x4le_u() { return this.simd(0x3e); }
  i32x4ge_s() { return this.simd(0x3f); } i32x4ge_u() { return this.simd(0x40); }
  f32x4eq() { return this.simd(0x41); } f32x4ne() { return this.simd(0x42); } f32x4lt() { return this.simd(0x43); }
  f32x4gt() { return this.simd(0x44); } f32x4le() { return this.simd(0x45); } f32x4ge() { return this.simd(0x46); }
  f64x2eq() { return this.simd(0x47); } f64x2ne() { return this.simd(0x48); } f64x2lt() { return this.simd(0x49); }
  f64x2gt() { return this.simd(0x4a); } f64x2le() { return this.simd(0x4b); } f64x2ge() { return this.simd(0x4c); }
  i64x2eq() { return this.simd(0xd6); } i64x2ne() { return this.simd(0xd7); } i64x2lt_s() { return this.simd(0xd8); }
  i64x2gt_s() { return this.simd(0xd9); } i64x2le_s() { return this.simd(0xda); } i64x2ge_s() { return this.simd(0xdb); }
  // bitwise
  v128not() { return this.simd(0x4d); } v128and() { return this.simd(0x4e); }
  /** v128.andnot(a, b) = a & ~b (first operand and-not second) */
  v128andnot() { return this.simd(0x4f); }
  v128or() { return this.simd(0x50); } v128xor() { return this.simd(0x51); }
  /** v128.bitselect(v1, v2, mask): mask bits set select v1 */
  v128bitselect() { return this.simd(0x52); }
  v128anytrue() { return this.simd(0x53); }
  // conversions
  f32x4demote_f64x2_zero() { return this.simd(0x5e); } f64x2promote_low_f32x4() { return this.simd(0x5f); }
  i32x4trunc_sat_f32x4_s() { return this.simd(0xf8); } i32x4trunc_sat_f32x4_u() { return this.simd(0xf9); }
  f32x4convert_i32x4_s() { return this.simd(0xfa); } f32x4convert_i32x4_u() { return this.simd(0xfb); }
  i32x4trunc_sat_f64x2_s_zero() { return this.simd(0xfc); } i32x4trunc_sat_f64x2_u_zero() { return this.simd(0xfd); }
  f64x2convert_low_i32x4_s() { return this.simd(0xfe); } f64x2convert_low_i32x4_u() { return this.simd(0xff); }
  // i8x16
  i8x16abs() { return this.simd(0x60); } i8x16neg() { return this.simd(0x61); } i8x16popcnt() { return this.simd(0x62); }
  i8x16alltrue() { return this.simd(0x63); } i8x16bitmask() { return this.simd(0x64); }
  i8x16narrow_i16x8_s() { return this.simd(0x65); } i8x16narrow_i16x8_u() { return this.simd(0x66); }
  i8x16shl() { return this.simd(0x6b); } i8x16shr_s() { return this.simd(0x6c); } i8x16shr_u() { return this.simd(0x6d); }
  i8x16add() { return this.simd(0x6e); } i8x16add_sat_s() { return this.simd(0x6f); } i8x16add_sat_u() { return this.simd(0x70); }
  i8x16sub() { return this.simd(0x71); } i8x16sub_sat_s() { return this.simd(0x72); } i8x16sub_sat_u() { return this.simd(0x73); }
  i8x16min_s() { return this.simd(0x76); } i8x16min_u() { return this.simd(0x77); } i8x16max_s() { return this.simd(0x78); } i8x16max_u() { return this.simd(0x79); }
  i8x16avgr_u() { return this.simd(0x7b); }
  // float rounding
  f32x4ceil() { return this.simd(0x67); } f32x4floor() { return this.simd(0x68); } f32x4trunc() { return this.simd(0x69); } f32x4nearest() { return this.simd(0x6a); }
  f64x2ceil() { return this.simd(0x74); } f64x2floor() { return this.simd(0x75); } f64x2trunc() { return this.simd(0x7a); } f64x2nearest() { return this.simd(0x94); }
  // pairwise extending adds
  i16x8extadd_pairwise_i8x16_s() { return this.simd(0x7c); } i16x8extadd_pairwise_i8x16_u() { return this.simd(0x7d); }
  i32x4extadd_pairwise_i16x8_s() { return this.simd(0x7e); } i32x4extadd_pairwise_i16x8_u() { return this.simd(0x7f); }
  // i16x8
  i16x8abs() { return this.simd(0x80); } i16x8neg() { return this.simd(0x81); } i16x8q15mulr_sat_s() { return this.simd(0x82); }
  i16x8alltrue() { return this.simd(0x83); } i16x8bitmask() { return this.simd(0x84); }
  i16x8narrow_i32x4_s() { return this.simd(0x85); } i16x8narrow_i32x4_u() { return this.simd(0x86); }
  i16x8extend_low_i8x16_s() { return this.simd(0x87); } i16x8extend_high_i8x16_s() { return this.simd(0x88); }
  i16x8extend_low_i8x16_u() { return this.simd(0x89); } i16x8extend_high_i8x16_u() { return this.simd(0x8a); }
  i16x8shl() { return this.simd(0x8b); } i16x8shr_s() { return this.simd(0x8c); } i16x8shr_u() { return this.simd(0x8d); }
  i16x8add() { return this.simd(0x8e); } i16x8add_sat_s() { return this.simd(0x8f); } i16x8add_sat_u() { return this.simd(0x90); }
  i16x8sub() { return this.simd(0x91); } i16x8sub_sat_s() { return this.simd(0x92); } i16x8sub_sat_u() { return this.simd(0x93); }
  i16x8mul() { return this.simd(0x95); }
  i16x8min_s() { return this.simd(0x96); } i16x8min_u() { return this.simd(0x97); } i16x8max_s() { return this.simd(0x98); } i16x8max_u() { return this.simd(0x99); }
  i16x8avgr_u() { return this.simd(0x9b); }
  i16x8extmul_low_i8x16_s() { return this.simd(0x9c); } i16x8extmul_high_i8x16_s() { return this.simd(0x9d); }
  i16x8extmul_low_i8x16_u() { return this.simd(0x9e); } i16x8extmul_high_i8x16_u() { return this.simd(0x9f); }
  // i32x4
  i32x4abs() { return this.simd(0xa0); } i32x4neg() { return this.simd(0xa1); } i32x4alltrue() { return this.simd(0xa3); } i32x4bitmask() { return this.simd(0xa4); }
  i32x4extend_low_i16x8_s() { return this.simd(0xa7); } i32x4extend_high_i16x8_s() { return this.simd(0xa8); }
  i32x4extend_low_i16x8_u() { return this.simd(0xa9); } i32x4extend_high_i16x8_u() { return this.simd(0xaa); }
  i32x4shl() { return this.simd(0xab); } i32x4shr_s() { return this.simd(0xac); } i32x4shr_u() { return this.simd(0xad); }
  i32x4add() { return this.simd(0xae); } i32x4sub() { return this.simd(0xb1); } i32x4mul() { return this.simd(0xb5); }
  i32x4min_s() { return this.simd(0xb6); } i32x4min_u() { return this.simd(0xb7); } i32x4max_s() { return this.simd(0xb8); } i32x4max_u() { return this.simd(0xb9); }
  i32x4dot_i16x8_s() { return this.simd(0xba); }
  i32x4extmul_low_i16x8_s() { return this.simd(0xbc); } i32x4extmul_high_i16x8_s() { return this.simd(0xbd); }
  i32x4extmul_low_i16x8_u() { return this.simd(0xbe); } i32x4extmul_high_i16x8_u() { return this.simd(0xbf); }
  // i64x2
  i64x2abs() { return this.simd(0xc0); } i64x2neg() { return this.simd(0xc1); } i64x2alltrue() { return this.simd(0xc3); } i64x2bitmask() { return this.simd(0xc4); }
  i64x2extend_low_i32x4_s() { return this.simd(0xc7); } i64x2extend_high_i32x4_s() { return this.simd(0xc8); }
  i64x2extend_low_i32x4_u() { return this.simd(0xc9); } i64x2extend_high_i32x4_u() { return this.simd(0xca); }
  i64x2shl() { return this.simd(0xcb); } i64x2shr_s() { return this.simd(0xcc); } i64x2shr_u() { return this.simd(0xcd); }
  i64x2add() { return this.simd(0xce); } i64x2sub() { return this.simd(0xd1); } i64x2mul() { return this.simd(0xd5); }
  i64x2extmul_low_i32x4_s() { return this.simd(0xdc); } i64x2extmul_high_i32x4_s() { return this.simd(0xdd); }
  i64x2extmul_low_i32x4_u() { return this.simd(0xde); } i64x2extmul_high_i32x4_u() { return this.simd(0xdf); }
  // f32x4
  f32x4abs() { return this.simd(0xe0); } f32x4neg() { return this.simd(0xe1); } f32x4sqrt() { return this.simd(0xe3); }
  f32x4add() { return this.simd(0xe4); } f32x4sub() { return this.simd(0xe5); } f32x4mul() { return this.simd(0xe6); } f32x4div() { return this.simd(0xe7); }
  /** IEEE min/max: NaN-propagating, -0 < +0 (NOT x86 MINPS/MAXPS; use pmin/pmax with swapped operands) */
  f32x4min() { return this.simd(0xe8); } f32x4max() { return this.simd(0xe9); }
  /** pmin(a, b) = b < a ? b : a ; pmax(a, b) = a < b ? b : a */
  f32x4pmin() { return this.simd(0xea); } f32x4pmax() { return this.simd(0xeb); }
  // f64x2
  f64x2abs() { return this.simd(0xec); } f64x2neg() { return this.simd(0xed); } f64x2sqrt() { return this.simd(0xef); }
  f64x2add() { return this.simd(0xf0); } f64x2sub() { return this.simd(0xf1); } f64x2mul() { return this.simd(0xf2); } f64x2div() { return this.simd(0xf3); }
  f64x2min() { return this.simd(0xf4); } f64x2max() { return this.simd(0xf5); }
  f64x2pmin() { return this.simd(0xf6); } f64x2pmax() { return this.simd(0xf7); }

  // ---- constants
  i32(v) { this.byte(0x41).s(v | 0); return this; }
  i64(v) { this.byte(0x42).s64(v); return this; }
  f32c(v) { this.byte(0x43).f32(v); return this; }
  f64c(v) { this.byte(0x44).f64(v); return this; }

  // ---- i32 ops
  eqz() { return this.byte(0x45); } eq() { return this.byte(0x46); } ne() { return this.byte(0x47); }
  lt_s() { return this.byte(0x48); } lt_u() { return this.byte(0x49); } gt_s() { return this.byte(0x4a); } gt_u() { return this.byte(0x4b); }
  le_s() { return this.byte(0x4c); } le_u() { return this.byte(0x4d); } ge_s() { return this.byte(0x4e); } ge_u() { return this.byte(0x4f); }
  clz() { return this.byte(0x67); } ctz() { return this.byte(0x68); } popcnt() { return this.byte(0x69); }
  add() { return this.byte(0x6a); } sub() { return this.byte(0x6b); } mul() { return this.byte(0x6c); }
  div_s() { return this.byte(0x6d); } div_u() { return this.byte(0x6e); } rem_s() { return this.byte(0x6f); } rem_u() { return this.byte(0x70); }
  and() { return this.byte(0x71); } or() { return this.byte(0x72); } xor() { return this.byte(0x73); }
  shl() { return this.byte(0x74); } shr_s() { return this.byte(0x75); } shr_u() { return this.byte(0x76); } rotl() { return this.byte(0x77); } rotr() { return this.byte(0x78); }
  extend8_s() { return this.byte(0xc0); } extend16_s() { return this.byte(0xc1); }
  // ---- i64 ops
  i64eqz() { return this.byte(0x50); } i64eq() { return this.byte(0x51); } i64ne() { return this.byte(0x52); }
  i64lt_s() { return this.byte(0x53); } i64lt_u() { return this.byte(0x54); } i64gt_s() { return this.byte(0x55); } i64gt_u() { return this.byte(0x56); }
  i64le_s() { return this.byte(0x57); } i64le_u() { return this.byte(0x58); } i64ge_s() { return this.byte(0x59); } i64ge_u() { return this.byte(0x5a); }
  i64add() { return this.byte(0x7c); } i64sub() { return this.byte(0x7d); } i64mul() { return this.byte(0x7e); }
  i64div_s() { return this.byte(0x7f); } i64div_u() { return this.byte(0x80); } i64rem_s() { return this.byte(0x81); } i64rem_u() { return this.byte(0x82); }
  i64and() { return this.byte(0x83); } i64or() { return this.byte(0x84); } i64xor() { return this.byte(0x85); }
  i64shl() { return this.byte(0x86); } i64shr_s() { return this.byte(0x87); } i64shr_u() { return this.byte(0x88); } i64rotl() { return this.byte(0x89); } i64rotr() { return this.byte(0x8a); }
  i64clz() { return this.byte(0x79); } i64ctz() { return this.byte(0x7a); }
  wrap() { return this.byte(0xa7); } extend_s() { return this.byte(0xac); } extend_u() { return this.byte(0xad); }
  // ---- f64 ops
  f64abs() { return this.byte(0x99); } f64neg() { return this.byte(0x9a); } f64ceil() { return this.byte(0x9b); } f64floor() { return this.byte(0x9c); }
  f64trunc() { return this.byte(0x9d); } f64nearest() { return this.byte(0x9e); } f64sqrt() { return this.byte(0x9f); }
  f64add() { return this.byte(0xa0); } f64sub() { return this.byte(0xa1); } f64mul() { return this.byte(0xa2); } f64div() { return this.byte(0xa3); }
  f64min() { return this.byte(0xa4); } f64max() { return this.byte(0xa5); }
  /** f64.copysign(a, b): magnitude of a with the sign bit of b */
  f64copysign() { return this.byte(0xa6); }
  f64eq() { return this.byte(0x61); } f64ne() { return this.byte(0x62); } f64lt() { return this.byte(0x63); } f64gt() { return this.byte(0x64); } f64le() { return this.byte(0x65); } f64ge() { return this.byte(0x66); }
  // ---- f32 ops
  f32add() { return this.byte(0x92); } f32sub() { return this.byte(0x93); } f32mul() { return this.byte(0x94); } f32div() { return this.byte(0x95); } f32sqrt() { return this.byte(0x91); }
  f32min() { return this.byte(0x96); } f32max() { return this.byte(0x97); } f32neg() { return this.byte(0x8c); } f32abs() { return this.byte(0x8b); }
  f32eq() { return this.byte(0x5b); } f32ne() { return this.byte(0x5c); } f32lt() { return this.byte(0x5d); } f32gt() { return this.byte(0x5e); } f32le() { return this.byte(0x5f); } f32ge() { return this.byte(0x60); }
  // ---- conversions
  i32trunc_f64_s() { return this.byte(0xaa); } i64trunc_f64_s() { return this.byte(0xb0); }
  i32trunc_sat_f64_s() { this.byte(0xfc).u(2); return this; } i64trunc_sat_f64_s() { this.byte(0xfc).u(6); return this; }
  i32trunc_sat_f32_s() { this.byte(0xfc).u(0); return this; }
  f64convert_i32_s() { return this.byte(0xb7); } f64convert_i32_u() { return this.byte(0xb8); } f64convert_i64_s() { return this.byte(0xb9); } f64convert_i64_u() { return this.byte(0xba); }
  f32convert_i32_s() { return this.byte(0xb2); }
  f64promote() { return this.byte(0xbb); } f32demote() { return this.byte(0xb6); }
  i32reinterpret_f32() { return this.byte(0xbc); } i64reinterpret_f64() { return this.byte(0xbd); }
  f32reinterpret_i32() { return this.byte(0xbe); } f64reinterpret_i64() { return this.byte(0xbf); }
  memcopy() { this.byte(0xfc).u(10).byte(0).byte(0); return this; }
  memfill() { this.byte(0xfc).u(11).byte(0); return this; }
}

/** Module builder. */
export class ModuleBuilder {
  /**
   * @param {object} [headerCache] shared by builders that declare the same types and imports: the
   *   magic, type and import sections are encoded once into it and reused
   */
  constructor(headerCache = null) {
    this.headerCache = headerCache;
    this.types = []; // [params[], results[]]
    this.typeKeys = new Map();
    this.imports = []; // { module, name, kind, ...}
    this.funcs = []; // { type, locals: [[count, type]], code: Code, name }
    this.exports = [];
    this.tables = [];
    this.memories = [];
    this.globals = [];
    this.elems = [];
    this.datas = [];
    this.importedFuncs = 0;
    this.importedGlobals = 0;
  }

  type(params, results) {
    const key = params.join(',') + '>' + results.join(',');
    let i = this.typeKeys.get(key);
    if (i === undefined) { i = this.types.length; this.types.push([params, results]); this.typeKeys.set(key, i); }
    return i;
  }

  importFunc(module, name, params, results) {
    if (this.funcs.length) throw new Error('imports must precede function definitions');
    const idx = this.importedFuncs++;
    this.imports.push({ module, name, kind: 0, type: this.type(params, results) });
    return idx;
  }
  importMemory(module, name, min, max, shared = false) { this.imports.push({ module, name, kind: 2, min, max, shared }); }
  importTable(module, name, min, max) { this.imports.push({ module, name, kind: 1, min, max }); }
  importGlobal(module, name, type, mutable) { const idx = this.importedGlobals++; this.imports.push({ module, name, kind: 3, type, mutable }); return idx; }

  /** Define a function; returns its index. locals: array of value types (beyond params). */
  func(params, results, locals, code, name = '') {
    const idx = this.importedFuncs + this.funcs.length;
    // compress locals into runs
    const runs = [];
    for (const t of locals) { if (runs.length && runs[runs.length - 1][1] === t) runs[runs.length - 1][0]++; else runs.push([1, t]); }
    this.funcs.push({ type: this.type(params, results), locals: runs, code, name, hints: code.hints ?? null });
    return idx;
  }
  /** A builder with the same types and imports (shared, not to be extended) and no functions or exports yet. */
  fork() {
    const m = Object.assign(Object.create(ModuleBuilder.prototype), this);
    m.funcs = []; m.exports = [];
    return m;
  }
  exportFunc(name, idx) { this.exports.push({ name, kind: 0, idx }); }
  exportMemory(name, idx = 0) { this.exports.push({ name, kind: 2, idx }); }
  exportTable(name, idx = 0) { this.exports.push({ name, kind: 1, idx }); }
  global(type, mutable, init) { const idx = this.importedGlobals + this.globals.length; this.globals.push({ type, mutable, init }); return idx; }
  table(min, max) { this.tables.push({ min, max }); return this.tables.length - 1; }
  memory(min, max) { this.memories.push({ min, max }); return this.memories.length - 1; }

  build() {
    const w = new ByteWriter(1 << 14);
    const section = (id, body) => { w.byte(id); w.sized(body); };
    const hc = this.headerCache;
    if (hc?.bytes) w.bytes(hc.bytes);
    else { this.buildHeader(w, section); if (hc) hc.bytes = w.finish(); }
    this.buildBody(w, section);
    return w.finish();
  }
  buildHeader(w, section) {
    w.bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    // types
    if (this.types.length) {
      const s = new ByteWriter(); s.u(this.types.length);
      for (const [p, r] of this.types) { s.byte(0x60); s.u(p.length); for (const t of p) s.byte(t); s.u(r.length); for (const t of r) s.byte(t); }
      section(1, s);
    }
    if (this.imports.length) {
      const s = new ByteWriter(); s.u(this.imports.length);
      for (const im of this.imports) {
        s.str(im.module).str(im.name).byte(im.kind);
        if (im.kind === 0) s.u(im.type);
        else if (im.kind === 1) { s.byte(0x70); limits(s, im.min, im.max, false); }
        else if (im.kind === 2) limits(s, im.min, im.max, im.shared);
        else { s.byte(im.type).byte(im.mutable ? 1 : 0); }
      }
      section(2, s);
    }
  }
  buildBody(w, section) {
    if (this.funcs.length) { const s = new ByteWriter(); s.u(this.funcs.length); for (const f of this.funcs) s.u(f.type); section(3, s); }
    if (this.tables.length) { const s = new ByteWriter(); s.u(this.tables.length); for (const t of this.tables) { s.byte(0x70); limits(s, t.min, t.max, false); } section(4, s); }
    if (this.memories.length) { const s = new ByteWriter(); s.u(this.memories.length); for (const m of this.memories) limits(s, m.min, m.max, false); section(5, s); }
    if (this.globals.length) {
      const s = new ByteWriter(); s.u(this.globals.length);
      for (const g of this.globals) { s.byte(g.type).byte(g.mutable ? 1 : 0); if (g.type === T.i32) s.byte(0x41).s(g.init | 0); else if (g.type === T.i64) s.byte(0x42).s64(g.init); else if (g.type === T.f64) s.byte(0x44).f64(g.init); else s.byte(0x43).f32(g.init); s.byte(0x0b); }
      section(6, s);
    }
    if (this.exports.length) { const s = new ByteWriter(); s.u(this.exports.length); for (const e of this.exports) s.str(e.name).byte(e.kind).u(e.idx); section(7, s); }
    if (this.funcs.length) {
      const bodies = this.funcs.map((f) => { const b = new ByteWriter(f.code.len + 64); b.u(f.locals.length); for (const [n, t] of f.locals) b.u(n).byte(t); const at = b.len; b.raw(f.code); b.byte(0x0b); return { b, at }; });
      // branch hints (custom section before the code section): offsets from the start of the body (locals included)
      const hinted = this.funcs.map((f, i) => [i, f.hints]).filter(([, h]) => h && h.length);
      if (hinted.length) {
        const s = new ByteWriter(); s.str('metadata.code.branch_hint'); s.u(hinted.length);
        for (const [i, h] of hinted) {
          s.u(this.importedFuncs + i).u(h.length >> 1);
          for (let k = 0; k < h.length; k += 2) s.u(bodies[i].at + h[k]).u(1).byte(h[k + 1]);
        }
        section(0, s);
      }
      const s = new ByteWriter(bodies.reduce((n, { b }) => n + b.len + 5, 8)); s.u(this.funcs.length);
      for (const { b } of bodies) s.sized(b);
      section(10, s);
    }
    // custom "name" section (function names only): profilers and stack traces show them instead of wasm-function[i]
    const named = this.funcs.map((f, i) => [this.importedFuncs + i, f.name]).filter(([, n]) => n);
    if (named.length) {
      const s = new ByteWriter(); s.str('name');
      const sub = new ByteWriter(); sub.u(named.length); for (const [idx, n] of named) { sub.u(idx); sub.str(n); }
      s.byte(1); s.sized(sub);
      section(0, s);
    }
  }
}

function limits(s, min, max, shared) {
  if (max === undefined || max === null) { s.byte(0x00).u(min); }
  else { s.byte(shared ? 0x03 : 0x01).u(min).u(max); }
}

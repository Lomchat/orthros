// Minimal WebAssembly binary emitter: modules, imports/exports, functions with locals, and a
// typed instruction builder with structured-control label bookkeeping.

export const T = Object.freeze({ i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, empty: 0x40 });

export class ByteWriter {
  constructor(cap = 4096) { this.buf = new Uint8Array(cap); this.len = 0; }
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
  str(s) { const b = new TextEncoder().encode(s); this.u(b.length); this.bytes(b); return this; }
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
  constructor() { super(); this.labels = []; }

  // ---- control
  block(bt = T.empty) { this.byte(0x02).byte(bt); const l = { kind: 'block' }; this.labels.push(l); return l; }
  loop(bt = T.empty) { this.byte(0x03).byte(bt); const l = { kind: 'loop' }; this.labels.push(l); return l; }
  if_(bt = T.empty) { this.byte(0x04).byte(bt); const l = { kind: 'if' }; this.labels.push(l); return l; }
  else_() { this.byte(0x05); return this; }
  end() { this.byte(0x0b); this.labels.pop(); return this; }
  depth(l) { const i = this.labels.lastIndexOf(l); if (i < 0) throw new Error('label not on stack'); return this.labels.length - 1 - i; }
  br(l) { this.byte(0x0c).u(this.depth(l)); return this; }
  br_if(l) { this.byte(0x0d).u(this.depth(l)); return this; }
  br_table(ls, def) { this.byte(0x0e).u(ls.length); for (const l of ls) this.u(this.depth(l)); this.u(this.depth(def)); return this; }
  return_() { this.byte(0x0f); return this; }
  unreachable() { this.byte(0x00); return this; }
  nop() { this.byte(0x01); return this; }
  call(f) { this.byte(0x10).u(f); return this; }
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
  f64eq() { return this.byte(0x61); } f64ne() { return this.byte(0x62); } f64lt() { return this.byte(0x63); } f64gt() { return this.byte(0x64); } f64le() { return this.byte(0x65); } f64ge() { return this.byte(0x66); }
  // ---- f32 ops
  f32add() { return this.byte(0x92); } f32sub() { return this.byte(0x93); } f32mul() { return this.byte(0x94); } f32div() { return this.byte(0x95); } f32sqrt() { return this.byte(0x91); }
  f32min() { return this.byte(0x96); } f32max() { return this.byte(0x97); } f32neg() { return this.byte(0x8c); } f32abs() { return this.byte(0x8b); }
  f32eq() { return this.byte(0x5b); } f32ne() { return this.byte(0x5c); } f32lt() { return this.byte(0x5d); } f32gt() { return this.byte(0x5e); } f32le() { return this.byte(0x5f); } f32ge() { return this.byte(0x60); }
  // ---- conversions
  i32trunc_f64_s() { return this.byte(0xaa); } i64trunc_f64_s() { return this.byte(0xb0); }
  i32trunc_sat_f64_s() { this.byte(0xfc).u(2); return this; } i64trunc_sat_f64_s() { this.byte(0xfc).u(6); return this; }
  i32trunc_sat_f32_s() { this.byte(0xfc).u(0); return this; }
  f64convert_i32_s() { return this.byte(0xb7); } f64convert_i32_u() { return this.byte(0xb8); } f64convert_i64_s() { return this.byte(0xb9); }
  f32convert_i32_s() { return this.byte(0xb2); }
  f64promote() { return this.byte(0xbb); } f32demote() { return this.byte(0xb6); }
  i32reinterpret_f32() { return this.byte(0xbc); } i64reinterpret_f64() { return this.byte(0xbd); }
  f32reinterpret_i32() { return this.byte(0xbe); } f64reinterpret_i64() { return this.byte(0xbf); }
  memcopy() { this.byte(0xfc).u(10).byte(0).byte(0); return this; }
  memfill() { this.byte(0xfc).u(11).byte(0); return this; }
}

/** Module builder. */
export class ModuleBuilder {
  constructor() {
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
    this.funcs.push({ type: this.type(params, results), locals: runs, code, name });
    return idx;
  }
  exportFunc(name, idx) { this.exports.push({ name, kind: 0, idx }); }
  exportMemory(name, idx = 0) { this.exports.push({ name, kind: 2, idx }); }
  exportTable(name, idx = 0) { this.exports.push({ name, kind: 1, idx }); }
  global(type, mutable, init) { const idx = this.importedGlobals + this.globals.length; this.globals.push({ type, mutable, init }); return idx; }
  table(min, max) { this.tables.push({ min, max }); return this.tables.length - 1; }
  memory(min, max) { this.memories.push({ min, max }); return this.memories.length - 1; }

  build() {
    const w = new ByteWriter();
    w.bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const section = (id, body) => { w.byte(id); w.sized(body); };
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
      const s = new ByteWriter(); s.u(this.funcs.length);
      for (const f of this.funcs) {
        const b = new ByteWriter(); b.u(f.locals.length); for (const [n, t] of f.locals) b.u(n).byte(t);
        b.raw(f.code); b.byte(0x0b);
        s.sized(b);
      }
      section(10, s);
    }
    return w.finish();
  }
}

function limits(s, min, max, shared) {
  if (max === undefined || max === null) { s.byte(0x00).u(min); }
  else { s.byte(shared ? 0x03 : 0x01).u(min).u(max); }
}

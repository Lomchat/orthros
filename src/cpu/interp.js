// Reference x86-32 interpreter. Correctness first; it is the oracle-checked model that the JIT
// is validated against, and the fallback executor. Handlers are registered per OP in a table.
//
// Faults are thrown as CpuFault; the run loop converts them into EXIT.FAULT with EIP left at the
// faulting instruction.

import { OP, OT, decode, fmtInsn } from './decoder.js';
import { F, EXIT, SEG, FLAGS_ARITH, CPU_MHZ, CPU_BRAND } from './state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE } from './memory.js';

export class CpuFault extends Error {
  /**
   * @param {number} vector x86 exception vector (0 #DE, 6 #UD, 13 #GP, 14 #PF, 3 #BP, 4 #OF, 5 #BR)
   * @param {number} [addr]
   * @param {string} [msg]
   */
  constructor(vector, addr = 0, msg = '') {
    super(`cpu fault #${vector}${msg ? ' ' + msg : ''}`);
    this.vector = vector;
    this.faultAddr = addr;
  }
}

// Parity lookup: PF set when low byte has even number of 1 bits.
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, c = 0;
  while (b) { c ^= b & 1; b >>= 1; }
  PARITY[i] = c ? 0 : F.PF;
}

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];
const BITS = [0, 8, 16, 0, 32];

/** @type {Array<(I: Interp, insn: import('./decoder.js').Insn) => void>} */
export const H = new Array(Object.keys(OP).length).fill(null);

export class Interp {
  /**
   * @param {import('./memory.js').GuestMemory} mem
   * @param {import('./state.js').CpuState} cpu
   */
  constructor(mem, cpu) {
    this.mem = mem;
    this.cpu = cpu;
    /** @type {Map<number, import('./decoder.js').Insn>} */
    this.cache = new Map();
    this.icount = 0;
    /** Trace hook: (insn) => void, or null. */
    this.trace = null;
    /** Host hooks for privileged/misc instructions. */
    this.hooks = {
      cpuid: null, // (I, leaf, sub) => [eax, ebx, ecx, edx]
      rdtsc: null, // (I) => bigint
      int: null, // (I, n) => boolean handled
    };
    // Scratch for SIMD/x87 helpers.
    this.scratch = new ArrayBuffer(64);
    this.sdv = new DataView(this.scratch);
    this.su8 = new Uint8Array(this.scratch);
  }

  /** Invalidate cached decodes in [addr, addr+len) (self-modifying code / code loads). */
  invalidate(addr, len) {
    if (this.cache.size === 0) return;
    if (len >= 0x10000) { this.cache.clear(); return; }
    for (let a = addr - 15; a < addr + len; a++) this.cache.delete(a >>> 0);
  }

  /** @param {number} addr */
  fetch(addr) {
    let insn = this.cache.get(addr);
    if (insn === undefined) {
      insn = decode(this.mem, addr);
      this.cache.set(addr, insn);
    }
    return insn;
  }

  /** Execute one instruction. Returns the EXIT code (EXIT.NONE to continue). */
  step() {
    const cpu = this.cpu;
    const eip = cpu.eip;
    if (eip >= THUNK_BASE && eip < THUNK_END) {
      cpu.exit = EXIT.THUNK;
      cpu.exitArg = ((eip - THUNK_BASE) / THUNK_SIZE) | 0;
      return EXIT.THUNK;
    }
    let insn;
    try {
      insn = this.fetch(eip);
    } catch (e) {
      cpu.exit = EXIT.FAULT;
      cpu.exitArg = 6;
      this.lastFault = e;
      return EXIT.FAULT;
    }
    if (this.trace) this.trace(insn);
    this.lastOp = insn.op;
    const h = H[insn.op];
    try {
      if (h === null) throw new CpuFault(6, eip, `unimplemented ${fmtInsn(insn)}`);
      cpu.eip = insn.next; // handlers that branch overwrite this
      h(this, insn);
    } catch (e) {
      if (e instanceof CpuFault) {
        cpu.eip = eip;
        cpu.exit = EXIT.FAULT;
        cpu.exitArg = e.vector;
        this.lastFault = e;
        return EXIT.FAULT;
      }
      if (e instanceof RangeError) {
        // out-of-bounds guest access
        cpu.eip = eip;
        cpu.exit = EXIT.FAULT;
        cpu.exitArg = 14;
        this.lastFault = new CpuFault(14, 0, e.message);
        return EXIT.FAULT;
      }
      throw e;
    }
    this.icount++;
    return cpu.exit;
  }

  /**
   * Run until an exit condition.
   * @param {{ stopAt?: number, maxInsns?: number }} [opts]
   */
  run(opts = {}) {
    const cpu = this.cpu;
    const stopAt = opts.stopAt ?? -1;
    let budget = opts.maxInsns ?? Infinity;
    cpu.exit = EXIT.NONE;
    while (budget-- > 0) {
      if (cpu.eip === stopAt) { cpu.exit = EXIT.HALT; this.lastRemaining = budget; return EXIT.HALT; }
      const r = this.step();
      if (r !== EXIT.NONE) { this.lastRemaining = budget; return r; }
    }
    this.lastRemaining = 0;
    cpu.exit = EXIT.TIMESLICE;
    return EXIT.TIMESLICE;
  }
  /** instructions left from the last run()'s budget */
  remaining() { return this.lastRemaining ?? 0; }

  // ------------------------------------------------------------------ operand access
  /** Linear address of a memory operand. */
  ea(o) {
    const cpu = this.cpu;
    let a = o.disp;
    if (o.base >= 0) a += cpu.reg(o.base);
    if (o.index >= 0) a += cpu.reg(o.index) * o.scale;
    if (o.a16) a &= 0xffff;
    if (o.seg === SEG.FS) a += cpu.fsBase;
    else if (o.seg === SEG.GS) a += cpu.gsBase;
    return a >>> 0;
  }

  readReg(size, r) {
    const v = this.cpu.reg(size === 1 && r >= 4 ? r - 4 : r);
    if (size === 4) return v;
    if (size === 2) return v & 0xffff;
    return r >= 4 ? (v >>> 8) & 0xff : v & 0xff;
  }

  writeReg(size, r, v) {
    const cpu = this.cpu;
    if (size === 4) { cpu.setReg(r, v); return; }
    if (size === 2) { cpu.setReg(r, (cpu.reg(r) & 0xffff0000) | (v & 0xffff)); return; }
    if (r >= 4) { r -= 4; cpu.setReg(r, (cpu.reg(r) & 0xffff00ff) | ((v & 0xff) << 8)); }
    else cpu.setReg(r, (cpu.reg(r) & 0xffffff00) | (v & 0xff));
  }

  readMem(size, a) {
    const m = this.mem;
    if (size === 4) return m.read32(a);
    if (size === 1) return m.read8(a);
    if (size === 2) return m.read16(a);
    throw new Error(`readMem size ${size}`);
  }

  writeMem(size, a, v) {
    const m = this.mem;
    if (size === 4) m.write32(a, v);
    else if (size === 1) m.write8(a, v);
    else if (size === 2) m.write16(a, v);
    else throw new Error(`writeMem size ${size}`);
  }

  /** Read an integer operand (1/2/4 bytes) as unsigned number. */
  rd(o) {
    switch (o.t) {
      case OT.REG: return this.readReg(o.size, o.r);
      case OT.MEM: return this.readMem(o.size, this.ea(o));
      case OT.IMM: return o.size === 4 ? o.v >>> 0 : o.v & MASK[o.size];
      case OT.SEG: return this.mem.read16(this.cpu.base + 0x40 + 2 * o.r);
    }
    throw new Error('rd: bad operand');
  }

  wr(o, v) {
    switch (o.t) {
      case OT.REG: this.writeReg(o.size, o.r, v); return;
      case OT.MEM: this.writeMem(o.size, this.ea(o), v); return;
      case OT.SEG: this.mem.write16(this.cpu.base + 0x40 + 2 * o.r, v & 0xffff); return;
    }
    throw new Error('wr: bad operand');
  }

  // ------------------------------------------------------------------ flags
  get flags() { return this.cpu.eflags; }
  set flags(v) { this.cpu.eflags = v; }

  /** Set SF/ZF/PF from result, plus CF/OF/AF given as booleans. */
  setArith(res, size, cf, of, af) {
    let f = this.cpu.eflags & ~FLAGS_ARITH;
    if (cf) f |= F.CF;
    if (of) f |= F.OF;
    if (af) f |= F.AF;
    if (res === 0) f |= F.ZF;
    if (res & SIGN[size]) f |= F.SF;
    f |= PARITY[res & 0xff];
    this.cpu.eflags = f >>> 0;
  }

  /** Logic ops: CF=OF=0, AF cleared (undefined). */
  setLogic(res, size) {
    let f = this.cpu.eflags & ~FLAGS_ARITH;
    if (res === 0) f |= F.ZF;
    if (res & SIGN[size]) f |= F.SF;
    f |= PARITY[res & 0xff];
    this.cpu.eflags = f >>> 0;
  }

  add(a, b, size, cin = 0) {
    const sum = a + b + cin;
    const r = (sum & MASK[size]) >>> 0;
    const cf = sum > MASK[size];
    const of = ((a ^ r) & (b ^ r) & SIGN[size]) !== 0;
    const af = ((a ^ b ^ r) & 0x10) !== 0;
    this.setArith(r, size, cf, of, af);
    return r;
  }

  sub(a, b, size, bin = 0) {
    const r = ((a - b - bin) & MASK[size]) >>> 0;
    const cf = a < b + bin;
    const of = ((a ^ b) & (a ^ r) & SIGN[size]) !== 0;
    const af = ((a ^ b ^ r) & 0x10) !== 0;
    this.setArith(r, size, cf, of, af);
    return r;
  }

  /** Evaluate condition code 0..15 against EFLAGS. */
  cond(cc) {
    const f = this.cpu.eflags;
    let r;
    switch (cc >> 1) {
      case 0: r = (f & F.OF) !== 0; break;
      case 1: r = (f & F.CF) !== 0; break;
      case 2: r = (f & F.ZF) !== 0; break;
      case 3: r = (f & (F.CF | F.ZF)) !== 0; break;
      case 4: r = (f & F.SF) !== 0; break;
      case 5: r = (f & F.PF) !== 0; break;
      case 6: r = ((f & F.SF) !== 0) !== ((f & F.OF) !== 0); break;
      default: r = (f & F.ZF) !== 0 || ((f & F.SF) !== 0) !== ((f & F.OF) !== 0); break;
    }
    return cc & 1 ? !r : r;
  }

  // ------------------------------------------------------------------ stack
  push(size, v) {
    const cpu = this.cpu;
    const sp = (cpu.esp - size) >>> 0;
    this.writeMem(size, sp, v);
    cpu.esp = sp;
  }

  pop(size) {
    const cpu = this.cpu;
    const v = this.readMem(size, cpu.esp);
    cpu.esp = (cpu.esp + size) >>> 0;
    return v;
  }

  segSel(i) { return this.mem.read16(this.cpu.base + 0x40 + 2 * i); }
  setSegSel(i, v) { this.mem.write16(this.cpu.base + 0x40 + 2 * i, v & 0xffff); }
}

// =============================================================================================
// Handlers

const noflags = () => {};

// ---- ALU
function binop(fn) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1];
    const a = I.rd(d), b = I.rd(s);
    const r = fn(I, a, b, d.size);
    if (r !== undefined) I.wr(d, r);
  };
}
H[OP.ADD] = binop((I, a, b, sz) => I.add(a, b, sz));
H[OP.ADC] = binop((I, a, b, sz) => I.add(a, b, sz, I.flags & F.CF ? 1 : 0));
H[OP.SUB] = binop((I, a, b, sz) => I.sub(a, b, sz));
H[OP.SBB] = binop((I, a, b, sz) => I.sub(a, b, sz, I.flags & F.CF ? 1 : 0));
H[OP.CMP] = binop((I, a, b, sz) => { I.sub(a, b, sz); return undefined; });
H[OP.AND] = binop((I, a, b, sz) => { const r = (a & b) >>> 0; I.setLogic(r, sz); return r; });
H[OP.OR] = binop((I, a, b, sz) => { const r = (a | b) >>> 0; I.setLogic(r, sz); return r; });
H[OP.XOR] = binop((I, a, b, sz) => { const r = (a ^ b) >>> 0; I.setLogic(r, sz); return r; });
H[OP.TEST] = binop((I, a, b, sz) => { I.setLogic((a & b) >>> 0, sz); return undefined; });
H[OP.NOT] = (I, insn) => { const d = insn.ops[0]; I.wr(d, (~I.rd(d)) & MASK[d.size]); };
H[OP.NEG] = (I, insn) => { const d = insn.ops[0]; I.wr(d, I.sub(0, I.rd(d), d.size)); };
H[OP.INC] = (I, insn) => {
  const d = insn.ops[0]; const cf = I.flags & F.CF;
  const r = I.add(I.rd(d), 1, d.size);
  I.flags = (I.flags & ~F.CF) | cf; I.wr(d, r);
};
H[OP.DEC] = (I, insn) => {
  const d = insn.ops[0]; const cf = I.flags & F.CF;
  const r = I.sub(I.rd(d), 1, d.size);
  I.flags = (I.flags & ~F.CF) | cf; I.wr(d, r);
};

// ---- multiply / divide
H[OP.MUL] = (I, insn) => {
  const s = insn.ops[0]; const size = s.size; const b = I.rd(s);
  const cpu = I.cpu;
  let hi, lo;
  if (size === 1) { const p = (cpu.eax & 0xff) * b; I.writeReg(2, 0, p); hi = p >>> 8; lo = p & 0xff; }
  else if (size === 2) { const p = (cpu.eax & 0xffff) * b; I.writeReg(2, 0, p & 0xffff); I.writeReg(2, 2, p >>> 16); hi = p >>> 16; lo = p & 0xffff; }
  else { const p = BigInt(cpu.eax) * BigInt(b); lo = Number(p & 0xffffffffn); hi = Number(p >> 32n); cpu.eax = lo; cpu.edx = hi; }
  const cf = hi !== 0;
  // SF/ZF/AF/PF undefined; mirror hardware-ish: compute from low result
  I.setArith(lo, size, cf, cf, false);
};
function imulFlags(I, full, size) {
  // full: signed product as BigInt; result truncated to size; CF=OF if truncation lost information
  const lo = BigInt.asUintN(BITS[size], full);
  const sx = BigInt.asIntN(BITS[size], lo);
  const cf = sx !== full;
  I.setArith(Number(lo), size, cf, cf, false);
  return Number(lo);
}
H[OP.IMUL] = (I, insn) => {
  const cpu = I.cpu;
  if (insn.ops.length === 1) {
    const s = insn.ops[0]; const size = s.size;
    const a = BigInt.asIntN(BITS[size], BigInt(I.readReg(size, 0)));
    const b = BigInt.asIntN(BITS[size], BigInt(I.rd(s)));
    const p = a * b;
    if (size === 1) { I.writeReg(2, 0, Number(BigInt.asUintN(16, p))); }
    else if (size === 2) { const u = Number(BigInt.asUintN(32, p)); I.writeReg(2, 0, u & 0xffff); I.writeReg(2, 2, u >>> 16); }
    else { const u = BigInt.asUintN(64, p); cpu.eax = Number(u & 0xffffffffn); cpu.edx = Number(u >> 32n); }
    imulFlags(I, p, size);
  } else {
    const d = insn.ops[0], s1 = insn.ops[1], s2 = insn.ops[2] || insn.ops[0];
    const size = d.size;
    const a = BigInt.asIntN(BITS[size], BigInt(I.rd(insn.ops.length === 3 ? s1 : d)));
    const b = BigInt.asIntN(BITS[size], BigInt(I.rd(insn.ops.length === 3 ? s2 : s1)));
    I.wr(d, imulFlags(I, a * b, size));
  }
};
H[OP.DIV] = (I, insn) => {
  const s = insn.ops[0]; const size = s.size; const b = I.rd(s);
  if (b === 0) throw new CpuFault(0);
  const cpu = I.cpu;
  if (size === 1) { const a = cpu.eax & 0xffff; const q = (a / b) | 0; if (q > 0xff) throw new CpuFault(0); I.writeReg(2, 0, (a % b) << 8 | q); }
  else if (size === 2) { const a = ((cpu.edx & 0xffff) << 16 | (cpu.eax & 0xffff)) >>> 0; const q = Math.floor(a / b); if (q > 0xffff) throw new CpuFault(0); I.writeReg(2, 0, q); I.writeReg(2, 2, a % b); }
  else { const a = (BigInt(cpu.edx) << 32n) | BigInt(cpu.eax); const bb = BigInt(b); const q = a / bb; if (q > 0xffffffffn) throw new CpuFault(0); cpu.eax = Number(q); cpu.edx = Number(a % bb); }
};
H[OP.IDIV] = (I, insn) => {
  const s = insn.ops[0]; const size = s.size;
  const b = BigInt.asIntN(BITS[size], BigInt(I.rd(s)));
  if (b === 0n) throw new CpuFault(0);
  const cpu = I.cpu;
  let a;
  if (size === 1) a = BigInt.asIntN(16, BigInt(cpu.eax & 0xffff));
  else if (size === 2) a = BigInt.asIntN(32, BigInt(((cpu.edx & 0xffff) << 16 | (cpu.eax & 0xffff)) >>> 0));
  else a = BigInt.asIntN(64, (BigInt(cpu.edx) << 32n) | BigInt(cpu.eax));
  const q = a / b; // truncates toward zero
  const r = a % b;
  const lim = 1n << BigInt(BITS[size] - 1);
  if (q >= lim || q < -lim) throw new CpuFault(0);
  const qu = Number(BigInt.asUintN(BITS[size], q)), ru = Number(BigInt.asUintN(BITS[size], r));
  if (size === 1) I.writeReg(2, 0, (ru << 8) | qu);
  else if (size === 2) { I.writeReg(2, 0, qu); I.writeReg(2, 2, ru); }
  else { cpu.eax = qu; cpu.edx = ru; }
};

// ---- shifts and rotates
function shiftCount(I, insn) {
  const c = insn.ops[1];
  return (c.t === OT.IMM ? c.v : I.rd(c)) & 31;
}
H[OP.SHL] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const cnt = shiftCount(I, insn);
  if (cnt === 0) return;
  const a = I.rd(d); const bits = BITS[size];
  let r, cf;
  if (cnt <= bits) { r = (a << cnt) & MASK[size]; cf = cnt === bits ? a & 1 : (a >>> (bits - cnt)) & 1; }
  else { r = 0; cf = 0; }
  r >>>= 0;
  const of = ((r & SIGN[size]) !== 0) !== (cf !== 0);
  I.setArith(r, size, cf !== 0, of, false);
  I.wr(d, r);
};
H[OP.SHR] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const cnt = shiftCount(I, insn);
  if (cnt === 0) return;
  const a = I.rd(d); const bits = BITS[size];
  let r, cf;
  if (cnt <= bits) { r = cnt === 32 ? 0 : a >>> cnt; cf = (a >>> (cnt - 1)) & 1; }
  else { r = 0; cf = 0; }
  const of = (a & SIGN[size]) !== 0; // defined for count 1
  I.setArith(r, size, cf !== 0, of, false);
  I.wr(d, r);
};
H[OP.SAR] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const cnt = shiftCount(I, insn);
  if (cnt === 0) return;
  const a = I.rd(d); const bits = BITS[size];
  const sa = (a << (32 - bits)) >> (32 - bits); // sign-extend to 32
  const sh = cnt >= bits ? bits - 1 : cnt;
  const r = ((sa >> sh) & MASK[size]) >>> 0;
  const cf = cnt >= bits ? (sa < 0 ? 1 : 0) : (sa >> (cnt - 1)) & 1;
  I.setArith(r, size, cf !== 0, false, false);
  I.wr(d, r);
};
H[OP.ROL] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const cnt = shiftCount(I, insn);
  if (cnt === 0) return;
  const a = I.rd(d); const bits = BITS[size]; const n = cnt % bits;
  const r = n === 0 ? a : (((a << n) | (a >>> (bits - n))) & MASK[size]) >>> 0;
  let f = I.flags & ~(F.CF | F.OF);
  if (r & 1) f |= F.CF;
  if (((r & SIGN[size]) !== 0) !== ((r & 1) !== 0)) f |= F.OF; // defined only for count 1
  I.flags = f >>> 0;
  I.wr(d, r);
};
H[OP.ROR] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const cnt = shiftCount(I, insn);
  if (cnt === 0) return;
  const a = I.rd(d); const bits = BITS[size]; const n = cnt % bits;
  const r = n === 0 ? a : (((a >>> n) | (a << (bits - n))) & MASK[size]) >>> 0;
  let f = I.flags & ~(F.CF | F.OF);
  if (r & SIGN[size]) f |= F.CF;
  const msb = (r & SIGN[size]) !== 0, msb1 = (r & (SIGN[size] >>> 1)) !== 0;
  if (msb !== msb1) f |= F.OF;
  I.flags = f >>> 0;
  I.wr(d, r);
};
H[OP.RCL] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; let cnt = shiftCount(I, insn);
  const bits = BITS[size];
  if (bits < 32) cnt %= bits + 1;
  if (cnt === 0) return;
  let a = I.rd(d); let cf = I.flags & F.CF ? 1 : 0;
  for (let i = 0; i < cnt; i++) {
    const msb = (a & SIGN[size]) !== 0 ? 1 : 0;
    a = ((a << 1) | cf) & MASK[size];
    cf = msb;
  }
  a >>>= 0;
  let f = I.flags & ~(F.CF | F.OF);
  if (cf) f |= F.CF;
  if (((a & SIGN[size]) !== 0) !== (cf !== 0)) f |= F.OF;
  I.flags = f >>> 0;
  I.wr(d, a);
};
H[OP.RCR] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; let cnt = shiftCount(I, insn);
  const bits = BITS[size];
  if (bits < 32) cnt %= bits + 1;
  if (cnt === 0) return;
  let a = I.rd(d); let cf = I.flags & F.CF ? 1 : 0;
  const of = ((a & SIGN[size]) !== 0) !== (cf !== 0);
  for (let i = 0; i < cnt; i++) {
    const lsb = a & 1;
    a = ((a >>> 1) | (cf ? SIGN[size] : 0)) >>> 0;
    cf = lsb;
  }
  let f = I.flags & ~(F.CF | F.OF);
  if (cf) f |= F.CF;
  if (of) f |= F.OF;
  I.flags = f >>> 0;
  I.wr(d, a);
};
H[OP.SHLD] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const c = insn.ops[2];
  const cnt = (c.t === OT.IMM ? c.v : I.rd(c)) & 31;
  if (cnt === 0) return;
  const bits = BITS[size];
  const a = I.rd(d), b = I.rd(insn.ops[1]);
  if (cnt > bits) { // undefined; emulate 32-bit behaviour on the concatenation
    const r = ((a << cnt) | (b << (cnt - bits))) & MASK[size];
    I.setArith(r >>> 0, size, false, false, false); I.wr(d, r >>> 0); return;
  }
  const r = (((a << cnt) | (b >>> (bits - cnt))) & MASK[size]) >>> 0;
  const cf = (a >>> (bits - cnt)) & 1;
  const of = ((a & SIGN[size]) !== 0) !== ((r & SIGN[size]) !== 0);
  I.setArith(r, size, cf !== 0, of, false);
  I.wr(d, r);
};
H[OP.SHRD] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const c = insn.ops[2];
  const cnt = (c.t === OT.IMM ? c.v : I.rd(c)) & 31;
  if (cnt === 0) return;
  const bits = BITS[size];
  const a = I.rd(d), b = I.rd(insn.ops[1]);
  if (cnt > bits) {
    const r = ((a >>> cnt) | (b >>> (cnt - bits))) & MASK[size];
    I.setArith(r >>> 0, size, false, false, false); I.wr(d, r >>> 0); return;
  }
  const r = (((a >>> cnt) | (b << (bits - cnt))) & MASK[size]) >>> 0;
  const cf = (a >>> (cnt - 1)) & 1;
  const of = ((a & SIGN[size]) !== 0) !== ((r & SIGN[size]) !== 0);
  I.setArith(r, size, cf !== 0, of, false);
  I.wr(d, r);
};

// ---- moves
H[OP.MOV] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  if (d.t === OT.SEG) {
    if (d.r === SEG.CS) throw new CpuFault(6);
    I.wr(d, I.rd(s));
    return;
  }
  if (s.t === OT.SEG) {
    // MOV Ev,Sw: 16-bit store to memory; zero-extended into a 32-bit register
    const v = I.rd(s);
    if (d.t === OT.MEM) I.writeMem(2, I.ea(d), v); else I.writeReg(d.size, d.r, v);
    return;
  }
  I.wr(d, I.rd(s));
};
H[OP.MOVZX] = (I, insn) => { const d = insn.ops[0], s = insn.ops[1]; I.wr(d, I.rd(s)); };
H[OP.MOVSX] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const v = I.rd(s);
  const sx = s.size === 1 ? (v << 24) >> 24 : (v << 16) >> 16;
  I.wr(d, (sx & MASK[d.size]) >>> 0);
};
H[OP.LEA] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  let a = s.disp;
  if (s.base >= 0) a += I.cpu.reg(s.base);
  if (s.index >= 0) a += I.cpu.reg(s.index) * s.scale;
  if (s.a16) a &= 0xffff;
  I.wr(d, (a & MASK[d.size]) >>> 0);
};
H[OP.XCHG] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  const a = I.rd(d), b = I.rd(s);
  I.wr(d, b); I.wr(s, a);
};
H[OP.XADD] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  // EA is computed once: writing the source register may alter a base/index register.
  const addr = d.t === OT.MEM ? I.ea(d) : 0;
  const a = d.t === OT.MEM ? I.readMem(d.size, addr) : I.rd(d);
  const b = I.rd(s);
  const r = I.add(a, b, d.size);
  I.wr(s, a); // source first: when both operands are the same register the sum must win
  if (d.t === OT.MEM) I.writeMem(d.size, addr, r); else I.wr(d, r);
};
H[OP.CMPXCHG] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const size = d.size;
  const acc = I.readReg(size, 0); const dv = I.rd(d);
  I.sub(acc, dv, size);
  if (acc === dv) I.wr(d, I.rd(s));
  else I.writeReg(size, 0, dv);
};
H[OP.CMPXCHG8B] = (I, insn) => {
  const a = I.ea(insn.ops[0]); const cpu = I.cpu;
  const lo = I.mem.read32(a), hi = I.mem.read32(a + 4);
  if (lo === cpu.eax && hi === cpu.edx) {
    I.mem.write32(a, cpu.ebx); I.mem.write32(a + 4, cpu.ecx);
    I.flags |= F.ZF;
  } else {
    cpu.eax = lo; cpu.edx = hi;
    I.flags &= ~F.ZF;
  }
};
H[OP.BSWAP] = (I, insn) => {
  const d = insn.ops[0]; const v = I.cpu.reg(d.r);
  I.cpu.setReg(d.r, ((v >>> 24) | ((v >>> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)) >>> 0);
};
H[OP.CMOVCC] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1];
  const v = I.rd(s);
  if (I.cond(insn.cc)) I.wr(d, v);
};
H[OP.SETCC] = (I, insn) => { I.wr(insn.ops[0], I.cond(insn.cc) ? 1 : 0); };

// ---- bit ops
function bitop(kind) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const size = d.size; const bits = BITS[size];
    let off = I.rd(s);
    let addr = 0, v;
    if (d.t === OT.MEM) {
      addr = I.ea(d);
      if (s.t !== OT.IMM) {
        // register bit offset: signed, addresses the bit string
        const so = size === 2 ? (off << 16) >> 16 : off | 0;
        addr = (addr + Math.floor(so / bits) * size) >>> 0;
        off = ((so % bits) + bits) % bits;
      } else off &= bits - 1;
      v = I.readMem(size, addr);
    } else { off &= bits - 1; v = I.rd(d); }
    const bit = (v >>> off) & 1;
    let f = I.flags & ~F.CF;
    if (bit) f |= F.CF;
    I.flags = f >>> 0;
    if (kind === 0) return;
    let nv = v;
    if (kind === 1) nv = v | (1 << off);
    else if (kind === 2) nv = v & ~(1 << off);
    else nv = v ^ (1 << off);
    nv = (nv & MASK[size]) >>> 0;
    if (d.t === OT.MEM) I.writeMem(size, addr, nv); else I.wr(d, nv);
  };
}
H[OP.BT] = bitop(0); H[OP.BTS] = bitop(1); H[OP.BTR] = bitop(2); H[OP.BTC] = bitop(3);
H[OP.BSF] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const v = I.rd(s);
  if (v === 0) { I.flags |= F.ZF; return; }
  I.flags &= ~F.ZF;
  let i = 0; while (!((v >>> i) & 1)) i++;
  I.wr(d, i);
};
H[OP.BSR] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const v = I.rd(s);
  if (v === 0) { I.flags |= F.ZF; return; }
  I.flags &= ~F.ZF;
  I.wr(d, 31 - Math.clz32(v));
};

// ---- stack
H[OP.PUSH] = (I, insn) => {
  const s = insn.ops[0];
  const size = insn.opsize;
  if (s.t === OT.SEG) {
    // 16-bit move into the slot, upper bytes untouched (matches recent Intel/AMD behaviour)
    const cpu = I.cpu; const sp = (cpu.esp - size) >>> 0;
    I.mem.write16(sp, I.rd(s)); cpu.esp = sp; return;
  }
  if (s.t === OT.IMM) { I.push(size, s.size === 1 ? ((s.v << 24) >> 24 & MASK[size]) >>> 0 : s.v & MASK[size]); return; }
  I.push(size, I.rd(s));
};
H[OP.POP] = (I, insn) => {
  const d = insn.ops[0]; const size = insn.opsize;
  if (d.t === OT.SEG) { const cpu = I.cpu; const v = I.mem.read16(cpu.esp); cpu.esp = (cpu.esp + size) >>> 0; I.wr(d, v); return; }
  const v = I.pop(size);
  if (d.t === OT.MEM) {
    // ESP already incremented when EA is computed (matters for [esp] forms)
    I.writeMem(size, I.ea(d), v);
  } else I.wr(d, v);
};
H[OP.PUSHA] = (I, insn) => {
  const cpu = I.cpu; const size = insn.opsize; const sp = cpu.esp;
  const regs = [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, sp, cpu.ebp, cpu.esi, cpu.edi];
  for (const r of regs) I.push(size, r & MASK[size]);
};
H[OP.POPA] = (I, insn) => {
  const size = insn.opsize;
  for (let i = 7; i >= 0; i--) {
    const v = I.pop(size);
    if (i !== 4) I.writeReg(size, i, v);
  }
};
H[OP.PUSHF] = (I, insn) => { I.push(insn.opsize, (I.flags & 0x00fcffff) & MASK[insn.opsize]); };
const POPF_WRITABLE = F.CF | F.PF | F.AF | F.ZF | F.SF | F.DF | F.OF | (1 << 14) | (1 << 18) | (1 << 21);
H[OP.POPF] = (I, insn) => {
  const size = insn.opsize; const v = I.pop(size);
  const w = size === 2 ? POPF_WRITABLE & 0xffff : POPF_WRITABLE;
  I.flags = ((I.flags & ~w) | (v & w) | F.RESERVED1) >>> 0;
};
H[OP.LAHF] = (I) => { I.writeReg(1, 4, (I.flags & 0xd5) | 2); };
H[OP.SAHF] = (I) => { const ah = I.readReg(1, 4); I.flags = ((I.flags & ~0xd5) | (ah & 0xd5) | F.RESERVED1) >>> 0; };
H[OP.ENTER] = (I, insn) => {
  const cpu = I.cpu; const size = insn.opsize; const alloc = insn.imm; const level = insn.ext & 31;
  I.push(size, cpu.ebp);
  const frame = cpu.esp;
  if (level > 0) {
    for (let i = 1; i < level; i++) {
      cpu.ebp = (cpu.ebp - size) >>> 0;
      I.push(size, I.readMem(size, cpu.ebp));
    }
    I.push(size, frame);
  }
  cpu.ebp = frame;
  cpu.esp = (cpu.esp - alloc) >>> 0;
};
H[OP.LEAVE] = (I, insn) => { const cpu = I.cpu; cpu.esp = cpu.ebp; cpu.ebp = I.pop(insn.opsize); };

// ---- control flow
H[OP.JMP] = (I, insn) => {
  const t = insn.ops[0];
  I.cpu.eip = t.t === OT.REL ? t.v : I.rd(t) & (insn.opsize === 2 ? 0xffff : 0xffffffff);
};
H[OP.JCC] = (I, insn) => { if (I.cond(insn.cc)) I.cpu.eip = insn.ops[0].v; };
H[OP.CALL] = (I, insn) => {
  const t = insn.ops[0];
  const target = t.t === OT.REL ? t.v : I.rd(t);
  I.push(insn.opsize, insn.next);
  I.cpu.eip = insn.opsize === 2 ? target & 0xffff : target >>> 0;
};
H[OP.RET] = (I, insn) => {
  const size = insn.opsize;
  const target = I.pop(size);
  if (insn.ops.length) I.cpu.esp = (I.cpu.esp + insn.ops[0].v) >>> 0;
  I.cpu.eip = size === 2 ? target & 0xffff : target;
};
function loopCount(I, insn) {
  const cpu = I.cpu;
  if (insn.adsize === 2) { const c = (cpu.ecx - 1) & 0xffff; I.writeReg(2, 1, c); return c; }
  cpu.ecx = (cpu.ecx - 1) >>> 0; return cpu.ecx;
}
H[OP.LOOP] = (I, insn) => { if (loopCount(I, insn) !== 0) I.cpu.eip = insn.ops[0].v; };
H[OP.LOOPE] = (I, insn) => { if (loopCount(I, insn) !== 0 && I.flags & F.ZF) I.cpu.eip = insn.ops[0].v; };
H[OP.LOOPNE] = (I, insn) => { if (loopCount(I, insn) !== 0 && !(I.flags & F.ZF)) I.cpu.eip = insn.ops[0].v; };
H[OP.JECXZ] = (I, insn) => {
  const c = insn.adsize === 2 ? I.cpu.ecx & 0xffff : I.cpu.ecx;
  if (c === 0) I.cpu.eip = insn.ops[0].v;
};
H[OP.INT3] = (I) => { I.cpu.exit = EXIT.BREAK; I.cpu.exitArg = 3; };
H[OP.INT] = (I, insn) => {
  const n = insn.ops[0].v;
  if (I.hooks.int && I.hooks.int(I, n)) return;
  throw new CpuFault(13, 0, `int ${n.toString(16)}`);
};
H[OP.INTO] = (I) => { if (I.flags & F.OF) throw new CpuFault(4); };
H[OP.IRET] = () => { throw new CpuFault(13, 0, 'iret'); };
H[OP.CALLF] = () => { throw new CpuFault(13, 0, 'far call'); };
H[OP.JMPF] = () => { throw new CpuFault(13, 0, 'far jump'); };
H[OP.RETF] = () => { throw new CpuFault(13, 0, 'far ret'); };
H[OP.HLT] = (I) => { I.cpu.exit = EXIT.HALT; };
H[OP.UD2] = () => { throw new CpuFault(6, 0, 'ud2'); };
H[OP.INVALID] = () => { throw new CpuFault(6, 0, 'invalid'); };

// ---- conversions
H[OP.CBW] = (I, insn) => {
  if (insn.opsize === 2) I.writeReg(2, 0, ((I.cpu.eax << 24) >> 24) & 0xffff);
  else I.cpu.eax = ((I.cpu.eax << 16) >> 16) >>> 0;
};
H[OP.CWD] = (I, insn) => {
  if (insn.opsize === 2) I.writeReg(2, 2, (I.cpu.eax & 0x8000) ? 0xffff : 0);
  else I.cpu.edx = (I.cpu.eax & 0x80000000) ? 0xffffffff : 0;
};
H[OP.XLAT] = (I, insn) => {
  const cpu = I.cpu;
  let a = (cpu.ebx + (cpu.eax & 0xff));
  if (insn.adsize === 2) a &= 0xffff;
  if (insn.seg === SEG.FS) a += cpu.fsBase; else if (insn.seg === SEG.GS) a += cpu.gsBase;
  I.writeReg(1, 0, I.mem.read8(a >>> 0));
};

// ---- string ops
function strStep(I, insn, size) {
  return (I.flags & F.DF ? -size : size);
}
function strAddr(I, insn, o) {
  const cpu = I.cpu;
  let a = cpu.reg(o.base);
  if (insn.adsize === 2) a &= 0xffff;
  if (o.seg === SEG.FS) a += cpu.fsBase; else if (o.seg === SEG.GS) a += cpu.gsBase;
  return a >>> 0;
}
function strAdvance(I, insn, r, delta) {
  const cpu = I.cpu;
  if (insn.adsize === 2) I.writeReg(2, r, (cpu.reg(r) + delta) & 0xffff);
  else cpu.setReg(r, (cpu.reg(r) + delta) >>> 0);
}
const REP_CHUNK = 1 << 16;
function repLoop(I, insn, body, isCmp) {
  const cpu = I.cpu;
  if (!insn.rep) { body(); return; }
  const a16 = insn.adsize === 2;
  let n = 0;
  for (;;) {
    let c = a16 ? cpu.ecx & 0xffff : cpu.ecx;
    if (c === 0) return;
    if (++n > REP_CHUNK) { cpu.eip = insn.addr; return; } // resume later (keeps the emulator responsive)
    body();
    c = (c - 1) & (a16 ? 0xffff : 0xffffffff);
    if (a16) I.writeReg(2, 1, c); else cpu.ecx = c >>> 0;
    if (isCmp) {
      const zf = (I.flags & F.ZF) !== 0;
      if (insn.rep === 0xf3 && !zf) return; // repe
      if (insn.rep === 0xf2 && zf) return; // repne
    }
  }
}
H[OP.MOVS] = (I, insn) => {
  const d = insn.ops[0], s = insn.ops[1]; const size = d.size; const delta = strStep(I, insn, size);
  repLoop(I, insn, () => {
    I.writeMem(size, strAddr(I, insn, d), I.readMem(size, strAddr(I, insn, s)));
    strAdvance(I, insn, 6, delta); strAdvance(I, insn, 7, delta);
  }, false);
};
H[OP.STOS] = (I, insn) => {
  const d = insn.ops[0]; const size = d.size; const delta = strStep(I, insn, size);
  repLoop(I, insn, () => {
    I.writeMem(size, strAddr(I, insn, d), I.readReg(size, 0));
    strAdvance(I, insn, 7, delta);
  }, false);
};
H[OP.LODS] = (I, insn) => {
  const s = insn.ops[1]; const size = s.size; const delta = strStep(I, insn, size);
  repLoop(I, insn, () => {
    I.writeReg(size, 0, I.readMem(size, strAddr(I, insn, s)));
    strAdvance(I, insn, 6, delta);
  }, false);
};
H[OP.SCAS] = (I, insn) => {
  const d = insn.ops[1]; const size = d.size; const delta = strStep(I, insn, size);
  repLoop(I, insn, () => {
    I.sub(I.readReg(size, 0), I.readMem(size, strAddr(I, insn, d)), size);
    strAdvance(I, insn, 7, delta);
  }, true);
};
H[OP.CMPS] = (I, insn) => {
  const s = insn.ops[0], d = insn.ops[1]; const size = s.size; const delta = strStep(I, insn, size);
  repLoop(I, insn, () => {
    I.sub(I.readMem(size, strAddr(I, insn, s)), I.readMem(size, strAddr(I, insn, d)), size);
    strAdvance(I, insn, 6, delta); strAdvance(I, insn, 7, delta);
  }, true);
};
H[OP.INS] = () => { throw new CpuFault(13, 0, 'ins'); };
H[OP.OUTS] = () => { throw new CpuFault(13, 0, 'outs'); };
H[OP.IN] = () => { throw new CpuFault(13, 0, 'in'); };
H[OP.OUT] = () => { throw new CpuFault(13, 0, 'out'); };

// ---- flags / misc
H[OP.CLC] = (I) => { I.flags &= ~F.CF; };
H[OP.STC] = (I) => { I.flags |= F.CF; };
H[OP.CMC] = (I) => { I.flags ^= F.CF; };
H[OP.CLD] = (I) => { I.flags &= ~F.DF; };
H[OP.STD] = (I) => { I.flags |= F.DF; };
H[OP.CLI] = noflags; // user mode: tolerated as no-op
H[OP.STI] = noflags;
H[OP.NOP] = noflags;
H[OP.PAUSE] = noflags;
H[OP.WAIT] = noflags;
H[OP.SALC] = (I) => { I.writeReg(1, 0, I.flags & F.CF ? 0xff : 0); };
H[OP.BOUND] = (I, insn) => {
  const idx = I.rd(insn.ops[0]) | 0; const a = I.ea(insn.ops[1]); const size = insn.opsize;
  const lo = size === 2 ? I.mem.readS16(a) : I.mem.readS32(a);
  const hi = size === 2 ? I.mem.readS16(a + 2) : I.mem.readS32(a + 4);
  const v = size === 2 ? (idx << 16) >> 16 : idx;
  if (v < lo || v > hi) throw new CpuFault(5);
};
H[OP.ARPL] = () => { throw new CpuFault(6, 0, 'arpl'); };
H[OP.CPUID] = (I) => {
  const cpu = I.cpu;
  const r = I.hooks.cpuid ? I.hooks.cpuid(I, cpu.eax, cpu.ecx) : defaultCpuid(cpu.eax, cpu.ecx);
  cpu.eax = r[0] >>> 0; cpu.ebx = r[1] >>> 0; cpu.ecx = r[2] >>> 0; cpu.edx = r[3] >>> 0;
};
H[OP.RDTSC] = (I) => {
  const t = I.hooks.rdtsc ? I.hooks.rdtsc(I) : BigInt(Math.floor(performance.now() * CPU_MHZ * 1000)); // (CPU_MHZ ticks per microsecond)
  I.cpu.eax = Number(t & 0xffffffffn); I.cpu.edx = Number((t >> 32n) & 0xffffffffn);
};
H[OP.RDPMC] = () => { throw new CpuFault(13, 0, 'rdpmc'); };
H[OP.RDMSR] = () => { throw new CpuFault(13, 0, 'rdmsr'); };
H[OP.WRMSR] = () => { throw new CpuFault(13, 0, 'wrmsr'); };
H[OP.SYSENTER] = () => { throw new CpuFault(13, 0, 'sysenter'); };
H[OP.SYSEXIT] = () => { throw new CpuFault(13, 0, 'sysexit'); };
H[OP.MOVCR] = () => { throw new CpuFault(13, 0, 'mov cr'); };
H[OP.MOVDR] = () => { throw new CpuFault(13, 0, 'mov dr'); };
H[OP.INT1] = () => { throw new CpuFault(1, 0, 'int1'); };
H[OP.LFENCE] = noflags; H[OP.MFENCE] = noflags; H[OP.SFENCE] = noflags;
H[OP.CLFLUSH] = noflags; H[OP.PREFETCH] = noflags;

function segLoad(segIdx) {
  return (I, insn) => {
    const d = insn.ops[0], s = insn.ops[1]; const a = I.ea(s); const size = d.size;
    const off = I.readMem(size, a); const sel = I.mem.read16(a + size);
    I.wr(d, off); I.setSegSel(segIdx, sel);
  };
}
H[OP.LDS] = segLoad(SEG.DS); H[OP.LES] = segLoad(SEG.ES); H[OP.LFS] = segLoad(SEG.FS);
H[OP.LGS] = segLoad(SEG.GS); H[OP.LSS] = segLoad(SEG.SS);

// ---- BCD
H[OP.DAA] = (I) => {
  let al = I.readReg(1, 0); const old = al; const cf = (I.flags & F.CF) !== 0;
  let f = I.flags & ~(F.CF | F.AF);
  if ((al & 0xf) > 9 || I.flags & F.AF) { al += 6; if (cf || old > 0xf9) f |= F.CF; f |= F.AF; }
  if (old > 0x99 || cf) { al += 0x60; f |= F.CF; }
  al &= 0xff;
  I.flags = f; I.setArith(al, 1, (f & F.CF) !== 0, false, (f & F.AF) !== 0); I.writeReg(1, 0, al);
};
H[OP.DAS] = (I) => {
  let al = I.readReg(1, 0); const old = al; const cf = (I.flags & F.CF) !== 0;
  let f = I.flags & ~(F.CF | F.AF);
  if ((al & 0xf) > 9 || I.flags & F.AF) { al -= 6; if (cf || old < 6) f |= F.CF; f |= F.AF; }
  if (old > 0x99 || cf) { al -= 0x60; f |= F.CF; }
  al &= 0xff;
  I.flags = f; I.setArith(al, 1, (f & F.CF) !== 0, false, (f & F.AF) !== 0); I.writeReg(1, 0, al);
};
H[OP.AAA] = (I) => {
  let ax = I.readReg(2, 0); let f = I.flags & ~(F.CF | F.AF);
  if ((ax & 0xf) > 9 || I.flags & F.AF) { ax = (ax + 0x106) & 0xffff; f |= F.CF | F.AF; }
  I.writeReg(2, 0, ax & 0xff0f); I.flags = f;
};
H[OP.AAS] = (I) => {
  let ax = I.readReg(2, 0); let f = I.flags & ~(F.CF | F.AF);
  if ((ax & 0xf) > 9 || I.flags & F.AF) { ax = (ax - 6) & 0xffff; ax = (ax - 0x100) & 0xffff; f |= F.CF | F.AF; }
  I.writeReg(2, 0, ax & 0xff0f); I.flags = f;
};
H[OP.AAM] = (I, insn) => {
  const base = insn.ops[0].v; if (base === 0) throw new CpuFault(0);
  const al = I.readReg(1, 0); const ah = (al / base) | 0; const nal = al % base;
  I.writeReg(2, 0, (ah << 8) | nal); I.setLogic(nal, 1);
};
H[OP.AAD] = (I, insn) => {
  const base = insn.ops[0].v; const ax = I.readReg(2, 0);
  const al = ((ax & 0xff) + ((ax >>> 8) & 0xff) * base) & 0xff;
  I.writeReg(2, 0, al); I.setLogic(al, 1);
};

/** Default CPUID: a generic SSE2-capable P6-class CPU. */
export function defaultCpuid(leaf, sub) {
  switch (leaf) {
    case 0: return [0x2, 0x756e6547, 0x6c65746e, 0x49656e69]; // "GenuineIntel"
    case 1: {
      // family 6, model 15 (Core 2), stepping 2; 1 logical cpu; features
      const edx = (1 << 0) | (1 << 4) | (1 << 5) | (1 << 8) | (1 << 11) | (1 << 15) | (1 << 19) | (1 << 23) | (1 << 24) | (1 << 25) | (1 << 26);
      // FPU TSC MSR CX8 SEP CMOV CLFSH MMX FXSR SSE SSE2
      const ecx = (1 << 0); // SSE3
      return [0x06f2, 0x00010800, ecx, edx >>> 0];
    }
    case 2: return [0x605b5001, 0, 0, 0x007a7000];
    // extended leaves, present on every CPU since the Pentium 4: brand string, L2 cache, address sizes
    case 0x80000000: return [0x80000008, 0, 0, 0];
    case 0x80000001: return [0, 0, 1, 1 << 20]; // LAHF/SAHF, XD (no long mode: a 32-bit CPU)
    case 0x80000002: case 0x80000003: case 0x80000004: {
      const r = [0, 0, 0, 0], base = (leaf - 0x80000002) * 16;
      for (let i = 0; i < 16; i++) r[i >> 2] |= (CPU_BRAND.charCodeAt(base + i) || 0) << (8 * (i & 3)); // NUL-padded to 48 bytes
      return r;
    }
    case 0x80000006: return [0, 0, (4096 << 16) | (6 << 12) | 64, 0]; // L2: 4 MB, 8-way, 64-byte lines
    case 0x80000008: return [0x2020, 0, 0, 0]; // 32-bit physical and linear addresses
    default: return [0, 0, 0, 0];
  }
}

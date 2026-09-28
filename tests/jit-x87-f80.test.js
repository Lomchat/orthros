// Native x87 extended-precision memory operands and state save/restore in the JIT (translate-x87.js,
// fpmath-f80.js): FLD m80, FSTP m80, FNSAVE, FRSTOR, FNSTENV, FLDENV used to be interpreter fallbacks.
//   - the inline m80 conversions against the interpreter's readF80 / writeF80, bit for bit, on edge cases
//     (zeros, f80 denormals, unnormals, pseudo-infinities / NaNs, f64 denormal and overflow boundaries, rounding
//     ties, the scaling-loop cut-offs) and a seeded random sweep;
//   - JIT against the reference interpreter: the whole x87 state (control / status / tag words, TOP, the
//     physical registers' bits) and the data page must match exactly, with no instruction left to the
//     interpreter: pending static shifts before the save, a non-zero TOP, every tag class (valid, zero,
//     special, empty), a restored control word changing the precision mode mid-block, FLDENV moving TOP;
//   - SMC: an FNSAVE image or an FSTP m80 that starts on a data page and ends on a translated code page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { readF80, writeF80 } from '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { ModuleBuilder, Code, T } from '../src/cpu/jit/wasm.js';
import { emitF80Load, emitF80Store } from '../src/cpu/jit/fpmath-f80.js';

const CODE = 0x20000000, DATA = 0x10000000;
const START = CODE + 0x100; // (the first 256 bytes of the code page stay free: SMC targets)
const hex = (v) => '0x' + (v >>> 0).toString(16);

// --------------------------------------------------------------------------- the conversions alone
function conversions(mem) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', mem.memory.buffer.byteLength / 65536, mem.memory.buffer.byteLength / 65536, typeof SharedArrayBuffer !== 'undefined' && mem.memory.buffer instanceof SharedArrayBuffer);
  const ld = new Code(); emitF80Load(ld, 0, 0, { m: 1, se: 2, e: 3, r: 4 });
  m.exportFunc('load', m.func([T.i32], [T.f64], [T.i64, T.i32, T.i32, T.f64], ld, 'load'));
  const st = new Code(); emitF80Store(st, 0, 0, 1, { b: 2, exp: 3, sg: 4 });
  m.exportFunc('store', m.func([T.i32, T.f64], [], [T.i64, T.i32, T.i32], st, 'store'));
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory: mem.memory } }).exports;
}
const dv = new DataView(new ArrayBuffer(8));
const bitsOf = (x) => { dv.setFloat64(0, x, true); return dv.getBigUint64(0, true); };
const f64Of = (b) => { dv.setBigUint64(0, BigInt.asUintN(64, b), true); return dv.getFloat64(0, true); };
function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; }; }
const rnd64 = (r) => (BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32));

test('inline m80 load: the interpreter\'s readF80 bit for bit (edge cases and a random sweep)', () => {
  const mem = new GuestMemory();
  const k = conversions(mem);
  const A = DATA;
  const r = prng(80);
  const mants = [0n, 1n, 1n << 63n, (1n << 63n) | 1n, 0x7fffffffffffffffn, 0xffffffffffffffffn, 0xc000000000000000n, 0x8000000000000400n, 0x8000000000000c00n, 0x8000000000000401n,
    0x80000000000007ffn, 0x0000000000000400n, 0x4000000000000000n, 0x0000000000000001n];
  const exps = [0, 1, 2, 1000, 14444, 14445, 14446, 14447, 14448, 15300, 15320, 15330, 15340, 15350, 15360, 15361, 15362, 15383, 15384, 15385, 16000, 16382, 16383, 16384,
    17405, 17406, 17407, 17408, 17446, 17447, 18444, 18445, 18446, 18447, 18448, 30000, 0x7ffe, 0x7fff];
  let n = 0;
  const check = (mant, se) => {
    mem.write64(A, mant); mem.write16(A + 8, se);
    const want = bitsOf(readF80(mem, A)), got = bitsOf(k.load(A));
    if (want !== got) assert.fail(`mant ${mant.toString(16)} se ${se.toString(16)}: interpreter ${want.toString(16)} inline ${got.toString(16)}`);
    n++;
  };
  for (const e of exps) for (const s of [0, 0x8000]) {
    for (const mt of mants) check(mt, s | e);
    for (let i = 0; i < 40; i++) check(rnd64(r) >> BigInt(Math.floor(r() * 8)), s | e);
    for (let i = 0; i < 20; i++) check((rnd64(r) >> 11n << 11n) | (r() < 0.5 ? 0x400n : 0n), s | e); // ties / near ties of the 53-bit rounding
  }
  for (let i = 0; i < 20000; i++) check(rnd64(r), Math.floor(r() * 65536));
  for (let i = 0; i < 20000; i++) check(rnd64(r) | (1n << 63n), (r() < 0.5 ? 0x8000 : 0) | (15250 + Math.floor(r() * 150))); // around the f64 denormal range
  assert.ok(n > 45000);
});

test('inline m80 store: the interpreter\'s writeF80 bit for bit (edge cases and a random sweep)', () => {
  const mem = new GuestMemory();
  const k = conversions(mem);
  const A = DATA, B = DATA + 16;
  const r = prng(81);
  const values = [0, -0, 1, -1, 5e-324, -5e-324, 2 ** -1022, 2 ** -1023, 2 ** -1022 - 5e-324, 1.7976931348623157e308, Infinity, -Infinity, NaN,
    f64Of(0x7ff0000000000001n), f64Of(0xfff4000000000123n), f64Of(0x7ff8000000000000n), f64Of(0xfff8000000000000n), f64Of(0x000fffffffffffffn), f64Of(0x8000000000000001n)];
  const check = (x) => {
    mem.fill(A, 32, 0x5a);
    writeF80(mem, A, x); k.store(B, x);
    assert.deepEqual([...mem.bytes(B, 10)], [...mem.bytes(A, 10)], `value bits ${bitsOf(x).toString(16)}`);
    assert.equal(mem.read8(B + 10), 0x5a, 'no byte written past the 10');
  };
  for (const x of values) check(x);
  for (let i = 0; i < 20000; i++) check(f64Of(rnd64(r)));
  for (let i = 0; i < 5000; i++) check(f64Of(rnd64(r) & 0x800fffffffffffffn)); // denormals
});

// --------------------------------------------------------------------------- JIT against the interpreter
class Asm {
  constructor(base) { this.base = base; this.bytes = []; }
  emit(...b) { this.bytes.push(...b); return this; }
  imm32(v) { return this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  abs(op, ext, addr) { return this.emit(...op, (ext << 3) | 5).imm32(addr); }
  get pc() { return this.base + this.bytes.length; }
  fld1() { return this.emit(0xd9, 0xe8); }
  fldz() { return this.emit(0xd9, 0xee); }
  fldSt0() { return this.emit(0xd9, 0xc0); }
  fldpi() { return this.emit(0xd9, 0xeb); }
  fchs() { return this.emit(0xd9, 0xe0); }
  fxam() { return this.emit(0xd9, 0xe5); }
  faddp() { return this.emit(0xde, 0xc1); }
  fdivp() { return this.emit(0xde, 0xf9); }
  fincstp() { return this.emit(0xd9, 0xf7); }
  fdecstp() { return this.emit(0xd9, 0xf6); }
  ffree(i) { return this.emit(0xdd, 0xc0 + i); }
  fstpSt(i) { return this.emit(0xdd, 0xd8 + i); }
  fldQ(a) { return this.abs([0xdd], 0, a); }
  fstpQ(a) { return this.abs([0xdd], 3, a); }
  fldT(a) { return this.abs([0xdb], 5, a); }
  fstpT(a) { return this.abs([0xdb], 7, a); }
  fnsave(a) { return this.abs([0xdd], 6, a); }
  frstor(a) { return this.abs([0xdd], 4, a); }
  fnstenv(a) { return this.abs([0xd9], 6, a); }
  fldenv(a) { return this.abs([0xd9], 4, a); }
  fnstswM(a) { return this.abs([0xdd], 7, a); }
  fldcw(a) { return this.abs([0xd9], 5, a); }
  movEcxImm(v) { return this.emit(0xb9).imm32(v); }
  decEcx() { return this.emit(0x49); }
  jnzBack(to) { const rel = to - (this.pc + 2); return this.emit(0x75, rel & 0xff); }
  call(to) { this.emit(0xe8); return this.imm32(to - (this.pc + 4)); }
  hlt() { return this.emit(0xf4); }
}

function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, fallbackHist: true }) : null;
  return { mem, cpu, I, jit, smcExits: 0 };
}
/** load code (at START, plus optional [addr, bytes] pieces) and data, run to the HLT; SMC exits invalidate as the VM does */
function exec(E, code, { pieces = [], data = [], raw = [] } = {}) {
  E.mem.fill(CODE, 0x3000, 0xcc);
  E.mem.writeBytes(START, code);
  for (const [a, b] of pieces) E.mem.writeBytes(a, b);
  E.cpu.reset();
  E.mem.fill(DATA, 0x2000, 0);
  for (const [off, v] of data) E.mem.writeF64(DATA + off, v);
  for (const [a, b] of raw) E.mem.writeBytes(a, b);
  E.cpu.eip = START; E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
  E.I.cache.clear();
  if (!E.jit) { assert.equal(E.I.run({ maxInsns: 1e6 }), EXIT.HALT, 'interpreter halts'); return; }
  E.jit.cpu = E.cpu;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 100, 'SMC loop');
    const r = E.jit.run({ maxInsns: 1e6 });
    if (r === EXIT.SMC) { E.smcExits++; E.jit.invalidate(E.mem.read32(E.cpu.base + ST.EXIT_ARG), 16); continue; }
    assert.equal(r, EXIT.HALT, 'JIT halts');
    return;
  }
}
/** (EIP left out: the interpreter stops past the HLT, the JIT on it) every observable x87 bit: control / status / tag words, TOP, the 8 physical registers' bits, GPRs, the data pages */
function snapshot(E, extra = []) {
  const c = E.cpu;
  return {
    cw: hex(c.fpuCw), sw: hex(c.fpuSw), tw: c.fpuTw.toString(2).padStart(8, '0'), top: c.fpuTop,
    fpr: Buffer.from(E.mem.bytes(c.base + ST.FPR, 64)).toString('hex'),
    regs: Array.from({ length: 8 }, (_, k) => hex(c.reg(k))),
    data: Buffer.from(E.mem.bytes(DATA, 0x2000)).toString('hex'),
    extra: extra.map(([a, n]) => Buffer.from(E.mem.bytes(a, n)).toString('hex')),
  };
}
function both(code, opts = {}, msg = '') {
  const EI = makeExec(false), EJ = makeExec(true);
  exec(EI, code, opts); exec(EJ, code, opts);
  assert.deepEqual(snapshot(EJ, opts.extra), snapshot(EI, opts.extra), msg);
  assert.equal(EJ.jit.stats.fallbackSteps, 0, `${msg}: nothing left to the interpreter (${[...EJ.jit.fallbackHist.keys()]})`);
  return { EI, EJ };
}
function f80Bytes(mant, se) { const b = new Uint8Array(10); for (let i = 0; i < 8; i++) b[i] = Number((mant >> BigInt(8 * i)) & 0xffn); b[8] = se & 0xff; b[9] = se >> 8; return b; }

test('FLD m80 / FSTP m80: round trips of edge-case extended values, stored back and as doubles', () => {
  const vals = [[0n, 0], [0n, 0x8000], [1n << 63n, 0x3fff], [(1n << 63n) | 0x400n, 0x3fff], [0xffffffffffffffffn, 0x43fe], [1n << 63n, 0x7fff], [0n, 0xffff], [0xc000000000000001n, 0x7fff],
    [0x8000000000000001n, 0xffff], [0x0000000000000400n, 0x7fff], [1n << 62n, 0x0000], [0x123456789abcdef0n, 0x0001], [0x123456789abcdef0n, 0x3c00], [0x8000000000000000n, 0x3bcd],
    [0xfedcba9876543210n, 0x3bff], [0x7fffffffffffffffn, 0x4000], [1n << 63n, 0x43ff], [1n << 63n, 0x47ff], [0x8000000000000000n, 0x3c01 - 52]];
  const a = new Asm(START);
  const raw = [];
  vals.forEach(([m, se], i) => {
    raw.push([DATA + 0x100 + 16 * i, f80Bytes(m, se)]);
    a.fldT(DATA + 0x100 + 16 * i).fldSt0().fstpT(DATA + 0x400 + 16 * i).fstpQ(DATA + 0x700 + 8 * i);
  });
  a.hlt();
  both(Uint8Array.from(a.bytes), { raw }, 'm80 round trips');
});

test('FNSAVE / FRSTOR: every tag class, a non-zero TOP, a pending shift, the status word, then reuse of the restored stack', () => {
  const a = new Asm(START);
  a.fldQ(DATA).fldQ(DATA + 8).fstpSt(0); // TOP moves: 7, then 7 again after the pop -> the stack below starts at TOP 7
  a.fldz().fldQ(DATA + 16).fldQ(DATA + 24).fldQ(DATA + 32).fld1().fchs().fxam(); // zero, denormal, inf, NaN, -1 (FXAM: C1 set)
  a.ffree(3); // an empty slot inside the stack
  a.fldpi().fnsave(DATA + 0x200); // the push is a pending static shift at the save
  a.fnstswM(DATA + 0x300).fld1().fldQ(DATA + 40).faddp().fstpQ(DATA + 0x308); // an initialized FPU in between
  a.frstor(DATA + 0x200).fnstswM(DATA + 0x310).fnstenv(DATA + 0x320);
  a.faddp().fstpQ(DATA + 0x340).fstpQ(DATA + 0x348).fstpQ(DATA + 0x350).fnstenv(DATA + 0x360).fnsave(DATA + 0x380);
  a.hlt();
  both(Uint8Array.from(a.bytes), { data: [[0, 3.5], [8, -2.25], [16, 2 ** -1060], [24, -Infinity], [32, NaN], [40, 0.1]] }, 'save/restore');
});

test('FRSTOR of a stored image: a precision-control change applies to the arithmetic that follows in the same block', () => {
  const a = new Asm(START);
  a.fldQ(DATA).fldQ(DATA + 8).fnsave(DATA + 0x200);
  // patch the saved control word to 24-bit precision, round up (0x087f), then restore and divide
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x200).emit(0x7f, 0x08);
  a.frstor(DATA + 0x200).fdivp().fstpQ(DATA + 0x300).fldQ(DATA).fldQ(DATA + 8).fdivp().fstpQ(DATA + 0x308);
  a.emit(0x66, 0xc7, 0x05).imm32(DATA + 0x200).emit(0x7f, 0x02); // 0x027f: back to 53 bits, nearest
  a.frstor(DATA + 0x200).fdivp().fstpQ(DATA + 0x310);
  a.hlt();
  const { EJ } = both(Uint8Array.from(a.bytes), { data: [[0, 1], [8, 3]] }, 'precision after FRSTOR');
  assert.notEqual(EJ.mem.readF64(DATA + 0x300), 1 / 3, '24-bit result');
  assert.equal(EJ.mem.readF64(DATA + 0x310), 1 / 3);
});

test('FNSTENV / FLDENV: a restored environment moving TOP re-bases the stack; same TOP; exceptions masked by FNSTENV', () => {
  const a = new Asm(START);
  a.fldQ(DATA).fldQ(DATA + 8).fldQ(DATA + 16).fnstenv(DATA + 0x200); // TOP 5
  a.fincstp().fincstp().fnstenv(DATA + 0x220); // TOP 7
  a.fldenv(DATA + 0x200).fstpQ(DATA + 0x300).fstpQ(DATA + 0x308).fstpQ(DATA + 0x310); // back to TOP 5: the three values
  a.fldQ(DATA + 24).fnstenv(DATA + 0x240).fldenv(DATA + 0x240).fstpQ(DATA + 0x318); // same TOP
  a.fldenv(DATA + 0x220).fnstenv(DATA + 0x260); // TOP 7, tags of the older state
  a.hlt();
  both(Uint8Array.from(a.bytes), { data: [[0, 1.5], [8, -7], [16, 1e300], [24, 42]] }, 'environment');
});

test('FNSAVE / FRSTOR in a loop (budget exits and chaining across iterations), TOP left non-zero', () => {
  const a = new Asm(START);
  a.fldQ(DATA).movEcxImm(500);
  const L = a.pc;
  a.fnsave(DATA + 0x200).fldQ(DATA + 8).fstpQ(DATA + 0x300).frstor(DATA + 0x200).fldQ(DATA + 8).faddp().fldT(DATA + 0x200 + 28).fstpT(DATA + 0x320).decEcx().jnzBack(L);
  a.fstpQ(DATA + 0x340).hlt();
  both(Uint8Array.from(a.bytes), { data: [[0, 0.5], [8, 0.25]] }, 'loop');
});

test('SMC: an FNSAVE image and an FSTP m80 starting on a data page and ending on a translated code page', () => {
  // the 108-byte image at CODE - 50 ends 58 bytes into the code page (free bytes: the code starts at CODE + 0x100);
  // the tbyte at CODE - 4 straddles the same boundary
  const a = new Asm(START);
  a.fldQ(DATA).fldQ(DATA + 8).fnsave(CODE - 50).fldQ(DATA + 8).fstpT(CODE - 4).frstor(CODE - 50).faddp().fstpQ(DATA + 0x300).hlt();
  const { EJ } = both(Uint8Array.from(a.bytes), { data: [[0, 2], [8, 5]], extra: [[CODE - 64, 128]] }, 'SMC');
  assert.equal(EJ.smcExits, 2, 'both stores left the region through the end-of-range check');
});

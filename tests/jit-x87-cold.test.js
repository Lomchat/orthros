// x87 arithmetic's cold paths as runtime kernels (fpmath-x87cold.js, translation option x87Cold 'call', the default)
// against the same code inline in every instruction ('inline', the earlier translation) and the interpreter: results,
// status word and interpreter steps for operands of every class — zeros, float / double denormals, the float range's
// edges, results overflowing / underflowing the float range, infinities, quiet and signaling NaNs of both signs and
// payloads that fit a float or not, 24-bit midpoints from double operands (0.9, 0.1, 1/3) — through float, double
// and register operands, under 24-bit (round to nearest, down, toward zero), 53-bit and 64-bit precision, with and
// without the float representation (ORTHROS_NO_F32). Also: region exits leave the x87 stack unrotated
// (Emitter.x87ExitState) — the same results whatever the pending shift (x87ExitRotate, the earlier exits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, A = DATA, B = DATA + 8, OUT = DATA + 0x100;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const f32bits = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
const f64bits = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0];
// floats: zeros, denormals, the normal range's edges, values whose products / quotients leave it, ordinary values,
// infinities, quiet / signaling NaNs of both signs
const BITS32 = [0x00000000, 0x80000000, 0x00000001, 0x807fffff, 0x00800000, 0x7f7fffff, 0xff7fffff, 0x7e800000, 0x01000000,
  0x3f800000, f32bits(1.5), f32bits(-3), f32bits(0.9), f32bits(1 / 3), 0x7f800000, 0xff800000, 0x7fc00000, 0xffc12345, 0x7f812345];
// doubles: the same classes, plus non-float multipliers (0.9, 0.1, 1/3), values outside the float range, double
// denormals, NaNs whose payload fits a float or not
const BITS64 = [0n, 0x8000000000000000n, f64bits(0.9), f64bits(0.1), f64bits(-1 / 3), f64bits(3), f64bits(2 ** -149), f64bits(2 ** -130),
  f64bits(1e300), f64bits(-1e-300), 1n, f64bits(2 ** 128), 0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000000n,
  0xfffa468ac0000000n, 0x7ff8000000000001n, 0x7ff0000000000001n];
const OPS = [0, 1, 4, 5, 6, 7]; // fadd fmul fsub fsubr fdiv fdivr

/**
 * form 0: fld m32 [A]; fop m32 [B] — 1: fld m32 [A]; fld m32 [B]; fop st(0), st(1) — 2: ...; fop st(1), st(0) —
 * 3: fld m32 [A]; fop m64 [B] — 4: fld m64 [A]; fop m64 [B] — 5: fld m64 [A]; fld m32 [B]; fop st(1), st(0);
 * every register stored (fstp m64), fnstsw ax, hlt. A is a float for forms 0-3, a double for 4-5.
 */
function program(op, form) {
  const b = form >= 4 ? [0xdd, 0x05, ...le(A)] : [0xd9, 0x05, ...le(A)];
  if (form === 0) b.push(0xd8, (op << 3) | 5, ...le(B));
  else if (form === 3 || form === 4) b.push(0xdc, (op << 3) | 5, ...le(B));
  else { b.push(0xd9, 0x05, ...le(B)); b.push(form === 1 ? 0xd8 : 0xdc, 0xc0 | (op << 3) | 1); }
  b.push(0xdd, 0x1d, ...le(OUT));
  if (form === 1 || form === 2 || form === 5) b.push(0xdd, 0x1d, ...le(OUT + 8));
  b.push(0xdf, 0xe0, 0xf4);
  return Uint8Array.from(b);
}
/** an executor (the interpreter, or a JIT with `opts` translating `code` once) on its own memory */
function executor(code, opts, cw) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.writeBytes(CODE, code);
  const interp = new Interp(mem, cpu);
  const ex = opts ? new Jit(mem, interp, { smc: true, ...opts }) : interp;
  ex.cpu = cpu;
  return (a, b, aw, bw) => {
    cpu.reset();
    if (aw) mem.write64(A, a); else mem.write32(A, Number(a));
    if (bw) mem.write64(B, b); else mem.write32(B, Number(b));
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1;
    mem.write16(cpu.base + ST.FPU_CW, cw);
    const steps0 = opts ? (ex.stats.steps ?? 0) : 0;
    let r; do r = ex.run({ maxInsns: 1e6 }); while (r === EXIT.TIMESLICE);
    assert.equal(r, EXIT.HALT);
    return { out: [mem.read64(OUT), mem.read64(OUT + 8)], ax: cpu.eax & 0xffff, steps: opts ? (ex.stats.steps ?? 0) - steps0 : 0 };
  };
}
const isNan64 = (v) => (v & 0x7ff0000000000000n) === 0x7ff0000000000000n && (v & 0x000fffffffffffffn) !== 0n;
const snan32 = (x) => (x & 0x7fc00000) === 0x7f800000 && (x & 0x3fffff) !== 0;

function compareAll(cw, label, extra = {}) {
  let n = 0, kernelSettled = 0;
  for (const op of OPS) for (let form = 0; form < 6; form++) {
    const code = program(op, form);
    const interp = executor(code, null, cw), call = executor(code, { x87Cold: 'call', ...extra }, cw), inline = executor(code, { x87Cold: 'inline', ...extra }, cw);
    const aw = form >= 4, bw = form === 3 || form === 4;
    for (const a of aw ? BITS64 : BITS32) for (const b of bw ? BITS64 : BITS32) {
      const what = `${label} cw ${cw.toString(16)} op ${op} form ${form} a ${a.toString(16)} b ${b.toString(16)}`;
      const i = interp(a, b, aw, bw), c = call(a, b, aw, bw), l = inline(a, b, aw, bw);
      // the kernels and the inline code: the same bits, status word and interpreter steps
      assert.deepEqual(c, l, what);
      n++;
      // against the interpreter, as tests/jit-x87-nan-f32.test.js: a signaling float NaN loaded and stored unchanged
      // keeps its bits in the JIT's float shadow (a difference of FLD / FSTP: only the result compared then); the
      // double paths raise no ZE / OE (only the NaN results' status words compared there)
      const k = form === 2 || form === 5 ? 1 : 0;
      if ((!aw && snan32(Number(a))) || (!bw && snan32(Number(b)))) assert.equal(c.out[k], i.out[k], what);
      else assert.deepEqual(c.out, i.out, what);
      if (((cw & 0x300) === 0 && !globalThis.ORTHROS_NO_F32) || isNan64(i.out[k])) assert.equal(c.ax, i.ax, `${what}: status word`);
      if (c.steps === 0 && (isNan64(i.out[k]) || (i.out[k] & 0x7fffffffffffffffn) === 0x7ff0000000000000n)) kernelSettled++;
    }
  }
  return { n, kernelSettled };
}

for (const cw of [0x007f, 0x047f, 0x0c7f, 0x027f, 0x037f]) {
  test(`x87 cold paths as kernels = inline = interpreter (control word ${cw.toString(16)})`, () => {
    const { n, kernelSettled } = compareAll(cw, '');
    // (directed rounding at 24-bit precision leaves every NaN / infinite result to the interpreter: roundDirected24)
    const directed24 = (cw & 0x300) === 0 && (cw & 0xc00) !== 0;
    assert.ok(n > 5000 && (directed24 || kernelSettled > 500), `${n} cases, ${kernelSettled} NaN / infinite results without an interpreter step`);
  });
}

// The status word in the state block (swLocal off) as well as in the region's local (the default): the kernels raise IE
// in the state block, so with swLocal the region stores L_SW before the call and reloads it after (translate-x87.js
// swOut / swIn), and the inline form raises into L_SW (emitRaise's `sw`). The programs read the status word back with
// FNSTSW in the same region.
for (const cw of [0x007f, 0x027f, 0x037f]) {
  test(`x87 cold paths with the status word in the state block (swLocal off, control word ${cw.toString(16)})`, () => {
    const { n } = compareAll(cw, 'swLocal off', { swLocal: false });
    assert.ok(n > 5000);
  });
}

test('x87 cold paths without the float representation (ORTHROS_NO_F32, 24-bit precision)', () => {
  globalThis.ORTHROS_NO_F32 = true;
  try { compareAll(0x007f, 'no-f32'); } finally { delete globalThis.ORTHROS_NO_F32; }
});

// Exits with a pending x87 shift: a block that pushes, then leaves the region in its middle — an SMC exit (a store
// into the code page: the next instruction rewritten), an interpreter step (a product overflowing the float range
// under 24-bit precision), the time-slice exit of a loop — then more x87 work after the exit, in the interpreter or
// another region. The stack, TOP and tags are written back from the unrotated locals (L_XSH): compared with the
// interpreter and with the earlier rotating exits, for every starting TOP.
test('x87 exits with a pending shift: unrotated locals, TOP from L_XSH', () => {
  // fld [A] ; fld [B] ; fmul st, st(1) (overflow at 24-bit: interpreter step) ; fld1 ; mov [CODE+0x40], al (SMC:
  // the byte at +0x40 is a nop, rewritten with itself) ; faddp st(1), st ; fxch ; fsub st, st(1) ; loop: dec ecx ; jnz ;
  // fnstenv [OUT+0x40] ; fstp m64 x2 ; fnstsw ax ; hlt
  const b = [0xd9, 0x05, ...le(A), 0xd9, 0x05, ...le(B), 0xd8, 0xc9, 0xd9, 0xe8, 0xa2, ...le(CODE + 0x40), 0xde, 0xc1, 0xd9, 0xc9, 0xd8, 0xe1];
    b.push(0xd9, 0xe8, 0xde, 0xc9, 0x49, 0x75, -7 & 0xff); // L: fld1 ; fmulp ; dec ecx ; jnz L
  b.push(0xd9, 0x35, ...le(OUT + 0x40)); // fnstenv
  for (let k = 0; k < 2; k++) b.push(0xdd, 0x1d, ...le(OUT + 8 * k));
  b.push(0xdf, 0xe0, 0xf4);
  while (b.length < 0x40) b.push(0x90);
  b.push(0x90, 0xf4);
  const code = Uint8Array.from(b);
  const run = (opts, top, a, bb) => {
    const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
    mem.writeBytes(CODE, code);
    const interp = new Interp(mem, cpu);
    const ex = opts ? new Jit(mem, interp, { smc: true, ...opts }) : interp;
    ex.cpu = cpu;
    cpu.reset();
    mem.write32(A, a); mem.write32(B, bb);
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1; cpu.ecx = 300; cpu.eax = 0x90;
    mem.write16(cpu.base + ST.FPU_CW, 0x007f);
    mem.write8(cpu.base + ST.FPU_TOP, top);
    let r, smc = 0;
    do { r = ex.run({ maxInsns: 37 }); if (r === EXIT.SMC) { smc++; ex.invalidate(cpu.exitArg, 16); } } while (r === EXIT.TIMESLICE || r === EXIT.SMC);
    assert.equal(r, EXIT.HALT);
    if (opts) assert.ok(smc > 0, 'the store into the code page left the region');
    return [cpu.eax & 0xffff, ...Array.from({ length: 2 }, (_, k) => mem.read64(OUT + 8 * k)), ...Array.from({ length: 7 }, (_, k) => mem.read32(OUT + 0x40 + 4 * k))].join();
  };
  for (const top of [0, 3, 7]) for (const [a, bb] of [[f32bits(3), f32bits(1.25)], [0x7f000000, 0x7f000000], [0x7fc00000, f32bits(2)]]) {
    const ref = run(null, top, a, bb);
    assert.equal(run({}, top, a, bb), ref, `top ${top} a ${a.toString(16)} b ${bb.toString(16)}`);
    assert.equal(run({ x87ExitRotate: true }, top, a, bb), ref, `rotating exits, top ${top}`);
  }
});

// 24-bit midpoints of float (op) double (the x87RoundF32 kernel's Dekker / TwoSum path, tests/jit-x87-f32.test.js):
// random floats times / plus / minus doubles that are not floats, in a loop — the kernels, the inline code and the
// interpreter give the same floats, and the kernels leave the region no more often than the inline code.
test('24-bit midpoints of float (op) double: kernels = inline = interpreter', () => {
  let s = 1234;
  const R = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const N = 256, floats = Array.from({ length: N }, () => Math.fround((R() - 0.5) * 2 ** (Math.floor(R() * 40) - 20)));
  const doubles = [0.9, 0.1, 1 / 3, -0.7, 2 ** -24 + 2 ** -60];
  for (const [modrm, name] of [[0x0f, 'fmul'], [0x07, 'fadd'], [0x27, 'fsub'], [0x2f, 'fsubr']]) for (let k = 0; k < doubles.length; k++) {
    // ecx = N ; L: fld dword [esi] ; fop qword [edi+k*8] ; fstp dword [ebx] ; add esi,4 ; add ebx,4 ; dec ecx ; jnz L ; hlt
    const code = [0xb9, ...le(N), 0xd9, 0x06, 0xdc, modrm + 0x40, 8 * k, 0xd9, 0x1b, 0x83, 0xc6, 0x04, 0x83, 0xc3, 0x04, 0x49, 0x75, 0, 0xf4];
    code[code.length - 2] = (0x100 - (code.length - 1 - 5)) & 0xff;
    const run = (opts) => {
      const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
      cpu.reset(); mem.writeBytes(CODE, Uint8Array.from(code));
      floats.forEach((v, i) => mem.writeF32(DATA + 0x1000 + 4 * i, v));
      doubles.forEach((v, i) => mem.writeF64(DATA + 8 * i, v));
      cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA + 0x1000; cpu.edi = DATA; cpu.ebx = DATA + 0x4000; cpu.eflags = F.RESERVED1 | F.IF;
      mem.write16(cpu.base + ST.FPU_CW, 0x007f);
      const I = new Interp(mem, cpu);
      let r, steps = 0;
      if (opts) { const jit = new Jit(mem, I, { smc: true, ...opts }); jit.cpu = cpu; r = jit.run({ maxInsns: 1e7 }); steps = jit.stats.steps ?? 0; }
      else r = I.run({ maxInsns: 1e7 });
      assert.equal(r, EXIT.HALT);
      return { out: Buffer.from(mem.bytes(DATA + 0x4000, 4 * N)).toString('hex'), steps };
    };
    const want = run(null), call = run({ x87Cold: 'call' }), inline = run({ x87Cold: 'inline' });
    assert.equal(call.out, want.out, `${name} by ${doubles[k]}`);
    assert.deepEqual(call, inline, `${name} by ${doubles[k]}: kernels and inline code`);
  }
});

// x87 regions specialized for 24-bit precision keep register values that are exact floats in f32
// locals and compute with f32 arithmetic (translate-x87.js arithF32 / roundF32 / f32OrDeopt).
// Random x87 sequences over boundary values (zeros, denormals, the float range limits, results
// beyond it that the x87's wider exponent keeps, NaN, infinities, doubles that are not floats) and
// every operand form run under the JIT and the reference interpreter for several control words,
// the JIT translating under the control word of the run (specialized code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
/** random programs per test (X87_SEEDS=3000 for a longer stress run) */
const SEEDS = Number(process.env.X87_SEEDS ?? 400);
const F32S = DATA, F64S = DATA + 0x100, OUT = DATA + 0x200;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const F32_VALUES = [0, -0, 1, -1, 0.1, 3.0000002, 1e-38, 1.17549435e-38, 1e-45, -2.5e-42, 3.4028235e38, -1e38, 2 ** -100, 2 ** 100, 12345.678, -0.75, Infinity, -Infinity, NaN, 1.5, 7, 1e20, 1e-20, 65504];
const F64_VALUES = [0.1, 1 / 3, Math.PI, 1e-300, 1e300, -2.5, 1 + 2 ** -40, 3.4028236e38, 1e-40, 123456789.123];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A random x87 sequence keeping the stack depth in 1..7; ends by storing every register as m64 and FNSTSW AX. */
function program(seed, limit = 40) {
  const R = rng(seed), pick = (n) => Math.floor(R() * n);
  const b = [];
  let depth = 0;
  const m32 = () => le(F32S + 4 * pick(F32_VALUES.length)), m64 = () => le(F64S + 8 * pick(F64_VALUES.length));
  const push = () => {
    switch (pick(7)) {
      case 0: case 1: case 2: b.push(0xd9, 0x05, ...m32()); break; // fld m32
      case 3: b.push(0xdd, 0x05, ...m64()); break; // fld m64
      case 4: if (depth) { b.push(0xd9, 0xc0 + pick(depth)); break; } b.push(0xd9, 0xe8); break; // fld st(i) / fld1
      case 5: b.push(0xd9, [0xe8, 0xee, 0xeb][pick(3)]); break; // fld1 / fldz / fldpi
      default: b.push(0xdb, 0x05, ...m32()); break; // fild m32 (the float bits as an integer)
    }
    depth++;
  };
  for (let n = 0; n < limit; n++) {
    if (depth === 0 || (depth < 7 && R() < 0.3)) { push(); continue; }
    const r = pick(8), op = [0, 1, 4, 5, 6, 7][pick(6)];
    switch (pick(13)) {
      case 0: case 1: b.push(0xd8, (op << 3) | 5, ...m32()); break; // fop m32
      case 2: b.push(0xdc, (op << 3) | 5, ...m64()); break; // fop m64
      case 3: b.push(0xd8, 0xc0 | (op << 3) | pick(depth)); break; // fop st(0), st(i)
      case 4: b.push(0xdc, 0xc0 | (op << 3) | pick(depth)); break; // fop st(i), st(0)
      case 5: if (depth >= 2) { b.push(0xde, 0xc0 | (op << 3) | (1 + pick(depth - 1))); depth--; } break; // fopp st(i), st(0)
      case 6: b.push(0xd9, [0xe0, 0xe1][pick(2)]); break; // fchs / fabs
      case 7: if (depth >= 2) b.push(0xd9, 0xc8 + 1 + pick(depth - 1)); break; // fxch st(i)
      case 8: b.push(0xd9, [0x15, 0x1d][pick(2)], ...le(OUT + 0x100 + 4 * (r & 3))); if (b[b.length - 5] === 0x1d) depth--; break; // fst / fstp m32
      case 9: if (depth >= 2) { b.push(0xdd, 0xd8 + 1 + pick(depth - 1)); depth--; } break; // fstp st(i)
      case 10: b.push(0xe9, 0, 0, 0, 0); break; // jmp to the next instruction: a block boundary
      case 11: switch (pick(14)) { // integer / double stores, compares, misc
        case 0: b.push(0xdb, 0x15, ...le(OUT + 0x110 + 4 * (r & 3))); break; // fist m32
        case 1: b.push(0xdb, 0x1d, ...le(OUT + 0x110 + 4 * (r & 3))); depth--; break; // fistp m32
        case 2: b.push(0xdf, 0x15, ...le(OUT + 0x110 + 2 * (r & 3))); break; // fist m16
        case 3: b.push(0xdb, 0x0d, ...le(OUT + 0x110 + 4 * (r & 3))); depth--; break; // fisttp m32
        case 4: b.push(0xdd, 0x15, ...le(OUT + 0x100 + 8 * (r & 1))); break; // fst m64
        case 5: b.push(0xd9, 0xfa); break; // fsqrt
        case 6: b.push(0xd9, 0xfc); break; // frndint
        case 7: if (depth >= 2) { b.push(0xd8, 0xd8 + 1 + pick(depth - 1)); depth--; } break; // fcomp st(i)
        case 8: if (depth >= 2) { b.push(0xdb, 0xf0 + 1 + pick(depth - 1)); } break; // fcomi st, st(i)
        case 9: if (depth >= 2) { b.push(0xdf, 0xe8 + 1 + pick(depth - 1)); depth--; } break; // fucomip st, st(i)
        case 10: b.push(0xdf, 0xe0); break; // fnstsw ax
        case 11: if (depth >= 2) b.push(0xda + pick(2), 0xc0 + 8 * pick(4) + 1 + pick(depth - 1)); break; // fcmovcc st, st(i)
        case 12: b.push(0xd9, 0xe4); break; // ftst
        default: if (depth >= 2) { b.push(0xde, 0xd9); depth -= 2; } break; // fcompp
      } break;
      default: b.push(0xd8, 0xd0 + pick(depth)); break; // fcom st(i)
    }
  }
  for (let i = 0; i < depth; i++) b.push(0xdd, 0x1d, ...le(OUT + 8 * i)); // fstp m64
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return Uint8Array.from(b);
}

/**
 * Loops and forward branches over float values: `mov ecx, n` / body / `dec ecx` / `jnz` (a WASM loop in the
 * region), the body made of stack-neutral chunks: operations at a fixed depth, a push ... pop pair around a
 * nested chunk, and a compare (FCOM + FNSTSW + SAHF or FCOMI) with a Jcc over a nested chunk. Stores go
 * to the output area and to the float table the loads read (values carried through memory across iterations).
 */
function loopProgram(seed) {
  const R = rng(seed), pick = (n) => Math.floor(R() * n);
  const m32 = () => le(F32S + 4 * pick(F32_VALUES.length)), m64 = () => le(F64S + 8 * pick(F64_VALUES.length));
  const st32 = () => (R() < 0.5 ? m32() : le(OUT + 0x100 + 4 * pick(4)));
  const arithOp = () => [0, 1, 4, 5, 6, 7][pick(6)];
  const neutral = (depth) => {
    const op = arithOp();
    switch (pick(12)) {
      case 0: case 1: return [0xd8, (op << 3) | 5, ...m32()]; // fop m32
      case 2: return [0xdc, (op << 3) | 5, ...m64()]; // fop m64
      case 3: return [0xd8, 0xc0 | (op << 3) | pick(depth)]; // fop st(0), st(i)
      case 4: return [0xdc, 0xc0 | (op << 3) | pick(depth)]; // fop st(i), st(0)
      case 5: return [0xd9, [0xe0, 0xe1][pick(2)]]; // fchs / fabs
      case 6: return depth >= 2 ? [0xd9, 0xc8 + 1 + pick(depth - 1)] : [0xd9, 0xe0]; // fxch st(i)
      case 7: return [0xd9, 0x15, ...st32()]; // fst m32
      case 8: return depth >= 2 ? [0xdd, 0xd0 + 1 + pick(depth - 1)] : [0xd9, 0xe1]; // fst st(i)
      case 9: return [0xd9, [0xfa, 0xfc][pick(2)]]; // fsqrt / frndint
      case 10: return [0xdb, 0x15, ...le(OUT + 0x110 + 4 * pick(4))]; // fist m32
      default: return [0xd8, 0xd0 + pick(depth)]; // fcom st(i)
    }
  };
  const chunk = (depth, level) => {
    const b = [];
    for (let n = 1 + pick(4); n > 0; n--) {
      const k = level < 3 ? pick(6) : 0;
      if (k <= 2 || (k === 3 && depth >= 7)) { b.push(...neutral(depth)); continue; }
      if (k === 3) { // push, nested chunk, pop
        switch (pick(4)) { case 0: case 1: b.push(0xd9, 0x05, ...m32()); break; case 2: b.push(0xd9, [0xe8, 0xee][pick(2)]); break; default: b.push(0xd9, 0xc0 + pick(depth)); }
        b.push(...chunk(depth + 1, level + 1));
        if (R() < 0.5) b.push(0xd9, 0x1d, ...st32()); else b.push(0xde, 0xc1 | (arithOp() << 3)); // fstp m32 / fopp st(1), st(0)
        continue;
      }
      // compare, Jcc over a nested chunk
      if (depth >= 2 && R() < 0.5) b.push(0xdb, [0xf0, 0xe8][pick(2)] + 1 + pick(depth - 1)); // fcomi / fucomi st, st(i)
      else b.push(0xd8, 0xd0 + pick(depth), 0xdf, 0xe0, 0x9e); // fcom st(i) ; fnstsw ax ; sahf
      const body = chunk(depth, level + 1);
      if (body.length > 127) { b.push(...body); continue; }
      b.push(0x72 + [0, 1, 2, 3, 4, 5, 8, 9][pick(8)], body.length, ...body); // jb/jae/jz/jnz/jbe/ja/jp/jnp
    }
    return b;
  };
  const b = [];
  const depth = 1 + pick(4);
  for (let i = 0; i < depth; i++) b.push(0xd9, 0x05, ...m32());
  for (let loops = 1 + pick(2); loops > 0; loops--) {
    b.push(0xb9, ...le(1 + pick(4))); // mov ecx, n
    const body = chunk(depth, 0);
    b.push(...body, 0x49); // dec ecx
    b.push(0x0f, 0x85, ...le(-(body.length + 1 + 6))); // jnz body
  }
  for (let i = 0; i < depth; i++) b.push(0xdd, 0x1d, ...le(OUT + 8 * i)); // fstp m64
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return Uint8Array.from(b);
}

/** Run `code` under the interpreter or the JIT (time slices of `slice` instructions: budget exits everywhere). */
function exec(useJit, code, cw, slice = 1e6) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  cpu.reset();
  mem.fill(DATA, 0x400, 0);
  F32_VALUES.forEach((v, i) => mem.writeF32(F32S + 4 * i, v));
  F64_VALUES.forEach((v, i) => mem.writeF64(F64S + 8 * i, v));
  mem.writeBytes(CODE, code);
  mem.write16(cpu.base + ST.FPU_CW, cw);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
  const end = CODE + code.length - 1;
  let r, jit = null;
  if (useJit) {
    jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]);
    let n = 0;
    do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e6);
  }
  else r = I.run({ stopAt: end, maxInsns: 1e6 });
  assert.equal(r, EXIT.HALT);
  // status word: TOP and the condition codes C0 C2 C3 (the JIT leaves C1 and the exception flags to the interpreter)
  return { out: Buffer.from(mem.bytes(OUT, 0x120)).toString('hex'), sw: (cpu.eax & 0x4500) | (cpu.eax & 0x3800), top: cpu.fpuTop, jit };
}

test('x87 under 24-bit precision (f32 shadows, exact fallbacks) and the other modes: random sequences match the interpreter', () => {
  let shadowExits = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const code = program(seed);
    for (const cw of [0x007f, 0x027f, 0x037f, 0x047f, 0x087f, 0x0c7f]) {
      const want = exec(false, code, cw), got = exec(true, code, cw);
      assert.deepEqual({ out: got.out, sw: got.sw, top: got.top }, { out: want.out, sw: want.sw, top: want.top }, `seed ${seed} cw ${cw.toString(16)}`);
      if (cw === 0x007f && got.jit.stats.regions > 2) shadowExits++;
    }
  }
  assert.ok(shadowExits > 0, 'some sequences left their region on a result that is not a float');
});

test('time slices ending on a backward edge with a pending x87 shift and float registers keep the stack', () => {
  // fld b ; fld a ; mov ecx, 40 ; top: fld1 ; jmp next ; next: faddp st(1), st ; dec ecx ; jnz top ; fstp m64 x2 ; hlt
  // the back edge leaves its block with ST(0) in an f32 shadow and the pop not yet applied to the locals: a budget
  // exit there must write the stack back once (it rewrote the shadow over ST(1) after the rotation)
  const body = [0xd9, 0xe8, 0xe9, 0, 0, 0, 0, 0xde, 0xc1, 0x49];
  const code = Uint8Array.from([0xd9, 0x05, ...le(F32S + 4 * 14), 0xd9, 0x05, ...le(F32S + 4 * 19), 0xb9, ...le(40), ...body, 0x0f, 0x85, ...le(-(body.length + 6)),
    0xdd, 0x1d, ...le(OUT), 0xdd, 0x1d, ...le(OUT + 8), 0xdf, 0xe0, 0xf4]);
  const want = exec(false, code, 0x007f);
  for (let slice = 1; slice <= 16; slice++) {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    const I = new Interp(mem, cpu);
    cpu.reset();
    mem.fill(DATA, 0x400, 0);
    F32_VALUES.forEach((v, i) => mem.writeF32(F32S + 4 * i, v));
    mem.writeBytes(CODE, code);
    mem.write16(cpu.base + ST.FPU_CW, 0x007f);
    cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
    const end = CODE + code.length - 1;
    const jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]);
    let r, n = 0;
    do r = jit.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 10000);
    assert.equal(r, EXIT.HALT);
    assert.equal(Buffer.from(mem.bytes(OUT, 0x10)).toString('hex'), want.out.slice(0, 32), `slice ${slice}`);
  }
});

test('x87 float values across loops and conditional branches: random programs match the interpreter', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const code = loopProgram(seed);
    for (const cw of [0x007f, 0x027f, 0x0c7f]) {
      // short time slices: budget exits on every back edge (with a pending x87 shift and float registers)
      const want = exec(false, code, cw), got = exec(true, code, cw, seed % 3 ? 1 + (seed % 23) : 1e6);
      assert.deepEqual({ out: got.out, sw: got.sw, top: got.top }, { out: want.out, sw: want.sw, top: want.top }, `seed ${seed} cw ${cw.toString(16)}`);
    }
  }
});

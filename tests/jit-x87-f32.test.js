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
const F32S = DATA, F64S = DATA + 0x100, OUT = DATA + 0x200;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const F32_VALUES = [0, -0, 1, -1, 0.1, 3.0000002, 1e-38, 1.17549435e-38, 1e-45, -2.5e-42, 3.4028235e38, -1e38, 2 ** -100, 2 ** 100, 12345.678, -0.75, Infinity, -Infinity, NaN, 1.5, 7, 1e20, 1e-20, 65504];
const F64_VALUES = [0.1, 1 / 3, Math.PI, 1e-300, 1e300, -2.5, 1 + 2 ** -40, 3.4028236e38, 1e-40, 123456789.123];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A random x87 sequence keeping the stack depth in 1..7; ends by storing every register as m64 and FNSTSW AX. */
function program(seed) {
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
  for (let n = 0; n < 40; n++) {
    if (depth === 0 || (depth < 7 && R() < 0.3)) { push(); continue; }
    const r = pick(8), op = [0, 1, 4, 5, 6, 7][pick(6)];
    switch (pick(12)) {
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
      default: b.push(0xd8, 0xd0 + pick(depth)); break; // fcom st(i)
    }
  }
  for (let i = 0; i < depth; i++) b.push(0xdd, 0x1d, ...le(OUT + 8 * i)); // fstp m64
  b.push(0xdf, 0xe0, 0xf4); // fnstsw ax ; hlt
  return Uint8Array.from(b);
}

function exec(useJit, code, cw) {
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
  if (useJit) { jit = new Jit(mem, I, { smc: true }); jit.cpu = cpu; jit.boundaries = new Set([end]); r = jit.run({ stopAt: end, maxInsns: 1e6 }); }
  else r = I.run({ stopAt: end, maxInsns: 1e6 });
  assert.equal(r, EXIT.HALT);
  // status word: TOP and the condition codes C0 C2 C3 (the JIT leaves C1 and the exception flags to the interpreter)
  return { out: Buffer.from(mem.bytes(OUT, 0x120)).toString('hex'), sw: (cpu.eax & 0x4500) | (cpu.eax & 0x3800), top: cpu.fpuTop, jit };
}

test('x87 under 24-bit precision (f32 shadows, exact fallbacks) and the other modes: random sequences match the interpreter', () => {
  let shadowExits = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const code = program(seed);
    for (const cw of [0x007f, 0x027f, 0x037f, 0x047f, 0x0c7f]) {
      const want = exec(false, code, cw), got = exec(true, code, cw);
      assert.deepEqual({ out: got.out, sw: got.sw, top: got.top }, { out: want.out, sw: want.sw, top: want.top }, `seed ${seed} cw ${cw.toString(16)}`);
      if (cw === 0x007f && got.jit.stats.regions > 2) shadowExits++;
    }
  }
  assert.ok(shadowExits > 0, 'some sequences left their region on a result that is not a float');
});

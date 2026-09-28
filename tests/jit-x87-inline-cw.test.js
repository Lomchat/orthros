// Inline x87 transcendental fast paths (translate-x87.js) against the kernel path (ORTHROS_NO_X87_INLINE) under
// every precision / rounding control and with float (m32) operands, which put the stack cache in its f32-shadow
// representation (24-bit precision, round to nearest), and in sequences mixing the fast and kernel paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
const CODE = 0x20000000, DATA = 0x10000000, REC = 32;
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
// fldcw [DATA-16]; mov esi; mov ecx; L: fld dword [esi+8]; fld dword [esi]; op; [op2]; fstp qword [esi+16]; fstp st0; fnstsw ax; mov [esi+24],eax; fnclex; add esi,32; dec ecx; jnz L; hlt
function program(ops, n, dword) {
  const ld = dword ? 0xd9 : 0xdd;
  const b = [0xd9, 0x2d, ...le32(DATA - 16), 0xbe, ...le32(DATA), 0xb9, ...le32(n)];
  const L = b.length;
  b.push(ld, 0x46, 8, ld, 0x06, ...ops, 0xdd, 0x5e, 16, 0xdd, 0xd8, 0xdf, 0xe0, 0x89, 0x46, 24, 0xdb, 0xe2, 0x83, 0xc6, REC, 0x49);
  const rel = L - (b.length + 6);
  b.push(0x0f, 0x85, ...le32(rel), 0xf4);
  return { code: Uint8Array.from(b), end: CODE + b.length - 1 };
}
function run(kind, ops, cw, dword, pairs) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const { code, end } = program(ops, pairs.length, dword);
  cpu.reset(); mem.writeBytes(CODE, code); mem.write32(DATA - 16, cw);
  pairs.forEach(([a, b], i) => { if (dword) { mem.writeF32(DATA + REC * i, a); mem.writeF32(DATA + REC * i + 8, b); } else { mem.writeF64(DATA + REC * i, a); mem.writeF64(DATA + REC * i + 8, b); } });
  cpu.eip = CODE; cpu.esp = DATA - 0x100; cpu.eflags = F.RESERVED1 | F.IF;
  let r;
  if (kind === 'interp') r = I.run({ stopAt: end, maxInsns: 1e8 });
  else { globalThis.ORTHROS_NO_X87_INLINE = kind === 'kernel'; const jit = new Jit(mem, I); jit.cpu = cpu; jit.boundaries = new Set([end]); r = jit.run({ stopAt: end, maxInsns: 1e8 }); globalThis.ORTHROS_NO_X87_INLINE = false; }
  assert.equal(r, EXIT.HALT);
  return Buffer.from(mem.bytes(DATA, REC * pairs.length)).toString('hex');
}
let s = 7; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
const vals = Array.from({ length: 300 }, () => (2 * rnd() - 1) * (rnd() < 0.3 ? 1 : rnd() < 0.5 ? 0.8 : 40) * (rnd() < 0.2 ? rnd() ** 10 : 1));
const pairs = vals.map((v, i) => [v, Math.trunc(vals[(i * 7) % vals.length] * 30)]);
for (const cw of [0x037f, 0x007f, 0x027f, 0x0f7f, 0x047f, 0x0b7f, 0x0360])
  for (const dword of [false, true])
    for (const [name, ops] of [['f2xm1', [0xd9, 0xf0]], ['fsin', [0xd9, 0xfe]], ['fcos', [0xd9, 0xff]], ['fscale', [0xd9, 0xfd]], ['exp', [0xd9, 0xf0, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0xfd, 0xd9, 0xfe, 0xd9, 0xf0]], ['fsin2', [0xd9, 0xfe, 0xd9, 0xfe, 0xd9, 0xff, 0xd9, 0xfd]]])
      test(`inline x87 fast paths == kernel path: ${name} cw=${cw.toString(16)} ${dword ? 'm32' : 'm64'}`, () => { assert.equal(run('fast', ops, cw, dword, pairs), run('kernel', ops, cw, dword, pairs)); });

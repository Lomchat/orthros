// opts.imulDead (translate.js HANDLERS[OP.IMUL]): a 32-bit two- or three-operand IMUL whose next instruction writes every
// arithmetic flag computes the low half alone (no 64-bit product for CF / OF). Randomized programs of IMUL forms
// (register, memory, imm8, imm32 operands, values overflowing or not) followed by flag writers (CMP, TEST, ADD, SAR by a
// constant, another IMUL), by flag readers of CF / OF (JO / JC / SETO / ADC / PUSHFD...) or by instructions keeping
// the flags (MOV, LEA, a store to memory), in blocks joined by Jcc / JMP and time-sliced: JIT with imulDead on and off
// against the interpreter, every register, the flags and memory compared. Also: the fast form is used where it may be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { listRegion } from '../src/cpu/jit/listing.js';

const CODE = 0x20000000, DATA = 0x10000000;
let seed = 11;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
function makeExec(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  return { mem, cpu, load(code, regs) { cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, code);
    mem.write32(DATA + 0x100, regs[2] ^ 0x5a5aa5a5); mem.write32(DATA + 0x104, regs[0] * 3 + 7);
    cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, , , cpu.esi, cpu.edi] = regs; cpu.ebp = DATA + 0x100; cpu.eflags = F.RESERVED1 | F.IF | (regs[8] & 0x8d5); },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); } };
}
// IMUL forms on eax / edx (ecx is the loop counter)
const M = () => {
  switch (rnd(7)) {
    case 0: return [0x0f, 0xaf, 0xc2]; // imul eax, edx
    case 1: return [0x0f, 0xaf, 0x55, 0x00]; // imul edx, [ebp]
    case 2: return [0x6b, 0xc0, rnd(256)]; // imul eax, eax, imm8
    case 3: return [0x69, 0xd0, ...le((rnd(65536) << 16 | rnd(65536)) >>> 0)]; // imul edx, eax, imm32
    case 4: return [0x0f, 0xaf, 0x45, 0x04]; // imul eax, [ebp+4]
    case 5: return [0x66, 0x0f, 0xaf, 0xc2]; // imul ax, dx (16-bit: not the fast form)
    default: return [0x6b, 0xd2, 0x7f]; // imul edx, edx, 127
  }
};
// what follows: flag writers, readers of CF / OF (and the rest), instructions keeping the flags
const N = () => {
  const cc = rnd(16);
  switch (rnd(14)) {
    case 0: return [0x39, 0xd0]; // cmp eax, edx
    case 1: return [0x85, 0xc0]; // test eax, eax
    case 2: return [0x01, 0xc2]; // add edx, eax
    case 3: return [0xc1, 0xf8, 1 + rnd(31)]; // sar eax, imm
    case 4: return [0x0f, 0x90, 0xc3, 0x8d, 0x34, 0x73]; // seto bl ; lea esi, [ebx+esi*2]
    case 5: return [0x0f, 0x92, 0xc3, 0x8d, 0x34, 0x73]; // setc bl ; lea esi, [ebx+esi*2]
    case 6: return [0x13, 0xf8]; // adc edi, eax
    case 7: return [0x9c, 0x5b, 0x81, 0xe3, ...le(0x8d5), 0x8d, 0x34, 0x73]; // pushfd ; pop ebx ; and ebx, 0x8d5 ; lea esi,...
    case 8: return [0x89, 0xc3]; // mov ebx, eax (flags kept)
    case 9: return [0x89, 0x45, 0x08]; // mov [ebp+8], eax (a store, flags kept)
    case 10: return [0x8d, 0x7c, 0x07, 0x01]; // lea edi, [edi+eax+1]
    case 11: return [0x0f, 0x40 + cc, 0xf8]; // cmovcc edi, eax
    case 12: return [0x47]; // inc edi (keeps CF)
    default: return M();
  }
};
function gen() {
  const nb = 5 + rnd(6), blocks = [];
  for (let i = 0; i < nb; i++) { const body = []; const n = 1 + rnd(4); for (let k = 0; k < n; k++) body.push(...M(), ...N()); blocks.push(body); }
  const out = []; const fix = []; const start = [];
  for (let i = 0; i < nb; i++) {
    start[i] = out.length; out.push(...blocks[i]);
    const t = rnd(4);
    if (i < nb - 1 && t < 3) { const tgt = i + 1 + rnd(nb - i - 1); const cc = rnd(16);
      if (t === 0) out.push(0xe9); else out.push(0x0f, 0x80 + cc); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); }
  }
  start[nb] = out.length; out.push(0x49, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4); // dec ecx ; jnz start ; hlt
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 2, 0x7f, 0x80, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0x40000000, 0xdeadbeef];
const val = () => rnd(3) ? V[rnd(V.length)] : (rnd(65536) << 16 | rnd(65536)) >>> 0;

test('imulDead: random IMUL programs match the interpreter (on and off, whole and time-sliced)', () => {
  for (let t = 0; t < 120; t++) {
    const code = gen(); const end = CODE + code.length - 1;
    const regs = [val(), 1 + rnd(20), val(), 0, 0, 0, 0, 0, rnd(0x1000)];
    const EI = makeExec(null); EI.load(code, regs); const ri = EI.run(end, 1e5);
    const snap = (E) => [E.cpu.eax, E.cpu.ecx, E.cpu.edx, E.cpu.ebx, E.cpu.esi, E.cpu.edi, E.cpu.eflags & 0x8d5, E.cpu.eip, E.mem.read32(DATA + 0x100), E.mem.read32(DATA + 0x108)].map((x) => (x >>> 0).toString(16)).join(' ');
    const a = snap(EI);
    for (const imulDead of [true, false]) for (const slice of [0, 2, 5, 13]) {
      const EJ = makeExec({ imulDead }); EJ.load(code, regs); let r, k = 0;
      while ((r = EJ.run(end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e5);
      const what = `program ${t}, imulDead ${imulDead}, slices ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => x.toString(16)).join(' ')}`;
      assert.equal(r, ri, what);
      assert.equal(snap(EJ), a, what);
    }
  }
});

test('imulDead: no 64-bit product when the next instruction overwrites the flags, one when they are read', () => {
  const mem = new GuestMemory();
  const ops = (code, opts = {}) => { mem.writeBytes(CODE, Uint8Array.from(code)); return listRegion(mem, CODE, { imulDead: true, ...opts }).text; };
  // imul eax, edx ; cmp eax, 5 ; ret
  assert.doesNotMatch(ops([0x0f, 0xaf, 0xc2, 0x83, 0xf8, 0x05, 0xc3]), /i64mul/);
  // imul eax, edx ; jo +0 ; ret: OF read
  assert.match(ops([0x0f, 0xaf, 0xc2, 0x70, 0x00, 0xc3]), /i64mul/);
  // imul eax, edx ; mov [ebp], eax ; cmp eax, 5 ; ret: a store between, the flags kept exact
  assert.match(ops([0x0f, 0xaf, 0xc2, 0x89, 0x45, 0x00, 0x83, 0xf8, 0x05, 0xc3]), /i64mul/);
  // off: always the 64-bit product
  assert.match(ops([0x0f, 0xaf, 0xc2, 0x83, 0xf8, 0x05, 0xc3], { imulDead: false }), /i64mul/);
});

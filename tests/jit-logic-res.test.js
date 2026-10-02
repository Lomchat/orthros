// opts.logicRes (translate.js binArith): AND/OR/XOR/TEST keep their result as the lazy operands too. Randomized
// programs of logic ops of every size and form (8-bit low/high registers, 16, 32 bits, immediates, memory
// destinations, TEST) followed by every kind of flag reader (Jcc, SETcc, CMOVcc, ADC/SBB, INC/DEC keeping CF,
// PUSHFD, LAHF, an instruction run by the interpreter), in blocks joined by Jcc/JMP and time-sliced so the lazy state
// crosses region exits, chains and the interpreter: JIT with logicRes on and off against the interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
const CODE = 0x20000000, DATA = 0x10000000;
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
function makeExec(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  return { mem, cpu, load(code, regs) { cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, code);
    mem.write32(DATA + 0x100, regs[2] ^ 0x5a5aa5a5);
    cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, , , cpu.esi, cpu.edi] = regs; cpu.ebp = DATA + 0x100; cpu.eflags = F.RESERVED1 | F.IF | (regs[8] & 0x8d5); },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); } };
}
// logic writers on eax/edx/[ebp]
const W = () => {
  const imm = rnd(256);
  switch (rnd(18)) {
    case 0: return [0x20, 0xd0]; // and al, dl
    case 1: return [0x08, 0xf4]; // or ah, dh
    case 2: return [0x30, 0xe0]; // xor al, ah
    case 3: return [0x84, 0xe4]; // test ah, ah
    case 4: return [0x66, 0x21, 0xd0]; // and ax, dx
    case 5: return [0x66, 0x85, 0xc0]; // test ax, ax
    case 6: return [0x66, 0x83, 0xf0, imm]; // xor ax, imm8 (sign-extended)
    case 7: return [0x09, 0xd0]; // or eax, edx
    case 8: return [0x31, 0xd2]; // xor edx, edx
    case 9: return [0x85, 0xc2]; // test edx, eax
    case 10: return [0x25, ...le((imm * 0x01010101 ^ 0x80000000) >>> 0)]; // and eax, imm32
    case 11: return [0xa8, imm]; // test al, imm8
    case 12: return [0x21, 0x45, 0x00]; // and [ebp], eax
    case 13: return [0x08, 0x55, 0x01]; // or [ebp+1], dl
    case 14: return [0x85, 0x55, 0x00]; // test [ebp], edx
    case 15: return [0x33, 0x45, 0x00]; // xor eax, [ebp]
    case 16: return [0x81, 0xc2, ...le(0x9e3779b9)]; // add edx, const (changes values)
    default: return [0xc1, 0xc0, imm & 31]; // rol eax, imm (changes values)
  }
};
// readers accumulating into ebx/esi/edi
const R = () => { const cc = rnd(16);
  switch (rnd(9)) {
    case 0: return [0x0f, 0x90 + cc, 0xc3, 0x8d, 0x34, 0x73]; // setcc bl ; lea esi,[ebx+esi*2]
    case 1: return [0x47]; // inc edi (keeps CF)
    case 2: return [0x4f]; // dec edi (keeps CF)
    case 3: return [0x0f, 0x40 + cc, 0xf8]; // cmovcc edi, eax
    case 4: return [0x13, 0xf8]; // adc edi, eax
    case 5: return [0x1b, 0xf2]; // sbb esi, edx
    case 6: return [0x9c, 0x5b, 0x81, 0xe3, ...le(0x8d5), 0x8d, 0x34, 0x73]; // pushfd ; pop ebx ; and ebx, 0x8d5 ; lea esi,...
    case 7: return [0x9f, 0x0f, 0xb6, 0xdc, 0x8d, 0x34, 0x73]; // lahf ; movzx ebx, ah ; lea esi,...
    default: return [0x0f, 0x9f, 0xc3, 0x01, 0xde]; // setg bl ; add esi, ebx
  } };
function gen() {
  const nb = 6 + rnd(6), blocks = [];
  for (let i = 0; i < nb; i++) { const body = []; const n = 1 + rnd(4); for (let k = 0; k < n; k++) body.push(...(rnd(2) ? W() : R())); blocks.push(body); }
  const out = []; const fix = []; const start = [];
  for (let i = 0; i < nb; i++) {
    start[i] = out.length; out.push(...blocks[i]);
    const t = rnd(4);
    if (i < nb - 1 && t < 3) { const tgt = i + 1 + rnd(nb - i - 1); const cc = rnd(16);
      if (t === 0) out.push(0xe9); else out.push(0x0f, 0x80 + cc); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); }
  }
  // loop: dec ecx ; jnz start ; hlt
  start[nb] = out.length; out.push(0x49, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4);
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
const val = () => rnd(3) ? V[rnd(V.length)] : (rnd(65536) << 16 | rnd(65536)) >>> 0;
test('logicRes: random logic-op programs match the interpreter (on and off, whole and time-sliced)', () => {
  for (let t = 0; t < 60; t++) {
    const code = gen(); const end = CODE + code.length - 1;
    const regs = [val(), 1 + rnd(20), val(), 0, 0, 0, 0, 0, rnd(0x1000)];
    const EI = makeExec(null); EI.load(code, regs); const ri = EI.run(end, 1e5);
    const snap = (E) => [E.cpu.eax, E.cpu.ecx, E.cpu.edx, E.cpu.ebx, E.cpu.esi, E.cpu.edi, E.cpu.eflags & 0x8d5, E.cpu.eip, E.mem.read32(DATA + 0x100)].map((x) => (x >>> 0).toString(16)).join(' ');
    const a = snap(EI);
    for (const logicRes of [true, false]) for (const slice of [0, 2, 5, 13]) {
      const EJ = makeExec({ logicRes }); EJ.load(code, regs); let r, k = 0;
      while ((r = EJ.run(end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e5);
      const what = `program ${t}, logicRes ${logicRes}, slices ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => x.toString(16)).join(' ')}`;
      assert.equal(r, ri, what);
      assert.equal(snap(EJ), a, what);
    }
  }
});

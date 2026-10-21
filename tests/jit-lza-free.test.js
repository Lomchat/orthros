// opts.lzaFree (translate.js LZA_FREE): ADD, SUB (as the SUBR kind), INC, DEC and NEG leave 0 as the lazy first operand; every reader derives
// what it needs from the result and the second operand. Checked here: randomized programs of those instructions (8 / 16
// / 32 bits, register and memory destinations, ADD of the same register, values around the carry / overflow / auxiliary
// boundaries) followed by every kind of flag reader (Jcc and SETcc of all conditions, CMOVcc, ADC / SBB, INC / DEC keeping
// CF, PUSHFD, LAHF, an instruction left to the interpreter), in blocks joined by Jcc / JMP and time-sliced so the lazy
// state crosses exits, chains and the state block — JIT with lzaFree on and off against the interpreter; and both flags
// helpers (the JavaScript fold and the runtime module's WASM function) giving the same flags whatever the first operand
// holds for those kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { LZ, materializeFlags } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, DATA = 0x10000000;
let seed = 23;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
function makeExec(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  return { mem, cpu, jit, load(code, regs) { cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, code);
    mem.write32(DATA + 0x100, regs[2] ^ 0x5a5aa5a5);
    cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, , , cpu.esi, cpu.edi] = regs; cpu.ebp = DATA + 0x100; cpu.eflags = F.RESERVED1 | F.IF | (regs[8] & 0x8d5); },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); } };
}
// ADD / INC / DEC / NEG on eax / edx / [ebp] (ecx counts the loop)
const W = () => {
  const imm = rnd(256);
  switch (rnd(27)) {
    case 20: return [0x28, 0xd0]; // sub al, dl
    case 21: return [0x66, 0x29, 0xd0]; // sub ax, dx
    case 22: return [0x29, 0xd0]; // sub eax, edx
    case 23: return [0x83, 0xe8, imm]; // sub eax, imm8
    case 24: return [0x29, 0x45, 0x00]; // sub [ebp], eax
    case 25: return [0x28, 0x55, 0x01]; // sub [ebp+1], dl
    case 26: return [0x29, 0xc0]; // sub eax, eax
    case 0: return [0x00, 0xd0]; // add al, dl
    case 1: return [0x00, 0xf4]; // add ah, dh
    case 2: return [0x66, 0x01, 0xd0]; // add ax, dx
    case 3: return [0x01, 0xd0]; // add eax, edx
    case 4: return [0x01, 0xc0]; // add eax, eax
    case 5: return [0x83, 0xc0, imm]; // add eax, imm8 (sign-extended)
    case 6: return [0x05, ...le((imm * 0x01010101 ^ 0x80000000) >>> 0)]; // add eax, imm32
    case 7: return [0x01, 0x45, 0x00]; // add [ebp], eax
    case 8: return [0x00, 0x55, 0x01]; // add [ebp+1], dl
    case 9: return [0x40]; // inc eax
    case 10: return [0xfe, 0xc4]; // inc ah
    case 11: return [0x66, 0x42]; // inc dx
    case 12: return [0x4a]; // dec edx
    case 13: return [0xfe, 0x4d, 0x02]; // dec byte [ebp+2]
    case 14: return [0xf7, 0xd8]; // neg eax
    case 15: return [0xf6, 0xda]; // neg dl
    case 16: return [0x66, 0xf7, 0x5d, 0x00]; // neg word [ebp]
    case 17: return [0x81, 0xc2, ...le(0x9e3779b9)]; // add edx, const
    case 18: return [0x80, 0xc4, 0x7f]; // add ah, 0x7f
    default: return [0xc1, 0xc0, imm & 31]; // rol eax, imm (changes values)
  }
};
// readers accumulating into ebx / esi / edi
const R = () => { const cc = rnd(16);
  switch (rnd(10)) {
    case 0: return [0x0f, 0x90 + cc, 0xc3, 0x8d, 0x34, 0x73]; // setcc bl ; lea esi,[ebx+esi*2]
    case 1: return [0x47]; // inc edi (keeps CF)
    case 2: return [0x4f]; // dec edi (keeps CF)
    case 3: return [0x0f, 0x40 + cc, 0xf8]; // cmovcc edi, eax
    case 4: return [0x13, 0xf8]; // adc edi, eax
    case 5: return [0x1b, 0xf2]; // sbb esi, edx
    case 6: return [0x9c, 0x5b, 0x81, 0xe3, ...le(0x8d5), 0x8d, 0x34, 0x73]; // pushfd ; pop ebx ; and ebx, 0x8d5 ; lea esi,...
    case 7: return [0x9f, 0x0f, 0xb6, 0xdc, 0x8d, 0x34, 0x73]; // lahf ; movzx ebx, ah ; lea esi,...
    case 8: return [0x27]; // daa (the interpreter: the flags materialized first)
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
  start[nb] = out.length; out.push(0x49, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4); // dec ecx ; jnz start ; hlt
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 0x0f, 0x10, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
const val = () => rnd(3) ? V[rnd(V.length)] : (rnd(65536) << 16 | rnd(65536)) >>> 0;

test('lzaFree: random ADD / SUB / INC / DEC / NEG programs match the interpreter (on and off, whole and time-sliced)', () => {
  for (let t = 0; t < 100; t++) {
    const code = gen(); const end = CODE + code.length - 1;
    const regs = [val(), 1 + rnd(20), val(), 0, 0, 0, 0, 0, rnd(0x1000)];
    const EI = makeExec(null); EI.load(code, regs); const ri = EI.run(end, 1e5);
    const snap = (E) => [E.cpu.eax, E.cpu.ecx, E.cpu.edx, E.cpu.ebx, E.cpu.esi, E.cpu.edi, E.cpu.eflags & 0x8d5, E.cpu.eip, E.mem.read32(DATA + 0x100)].map((x) => (x >>> 0).toString(16)).join(' ');
    const a = snap(EI);
    for (const lzaFree of [true, false]) for (const slice of [0, 2, 5, 13]) {
      const EJ = makeExec({ lzaFree }); EJ.load(code, regs); let r, k = 0;
      while ((r = EJ.run(end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e5);
      const what = `program ${t}, lzaFree ${lzaFree}, slices ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => x.toString(16)).join(' ')}`;
      assert.equal(r, ri, what);
      assert.equal(snap(EJ), a, what);
    }
  }
});

test('lzaFree: both flags helpers ignore the first operand of ADD, SUBR, INC, DEC and NEG', () => {
  const E = makeExec({}); E.jit.cpu = E.cpu;
  const wasmFlags = E.jit.runtime.flags;
  for (let n = 0; n < 4000; n++) {
    const sz = rnd(3), mask = sz === 2 ? 0xffffffff : (1 << (8 << sz)) - 1;
    const a = val() & mask, b = val() & mask, cin = rnd(2), ef = (F.RESERVED1 | (rnd(0x1000) & 0x8d5)) >>> 0;
    for (const [kind, res, bb, aa] of [[LZ.ADD, (a + b) & mask, b, a], [LZ.INC, (a + 1) & mask, cin, a], [LZ.DEC, (a - 1) & mask, cin, a], [LZ.NEG, (0 - a) & mask, 0, a], [LZ.SUBR, (a - b) & mask, b, a]]) {
      const op = (kind << 2) | sz, garbage = val();
      const want = materializeFlags(kind === LZ.SUBR ? (LZ.SUB << 2) | sz : op, res, aa, bb, ef); // (SUBR: the flags of that SUB)
      assert.equal(materializeFlags(op, res, garbage, bb, ef), want, `JS helper, kind ${kind} size ${sz}: a ${aa.toString(16)} b ${bb.toString(16)}`);
      assert.equal(wasmFlags(op, res, aa, bb, ef) >>> 0, want, `WASM helper, kind ${kind} size ${sz}`);
      assert.equal(wasmFlags(op, res, garbage, bb, ef) >>> 0, want, `WASM helper with another first operand, kind ${kind} size ${sz}`);
    }
  }
});

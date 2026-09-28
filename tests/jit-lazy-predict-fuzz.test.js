// Randomized check of the lazy flag state across block boundaries (translate.js regionLazyPrediction /
// pushCondDynamic, SHL's inline CF/OF): looped programs of random flag writers (every lazy kind and size, SHL by CL
// and by constants 0..31) and readers (SETcc, CMOVcc, ADC, INC keeping CF) in blocks joined by random JMP/Jcc, so
// blocks are entered with predicted, mispredicted and dispatcher-set lazy ops; whole and time-sliced JIT runs
// against the interpreter (registers, arithmetic flags, EIP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
const CODE = 0x20000000, DATA = 0x10000000;
let seed = 1;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
function makeExec(useJit) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  return { mem, cpu, load(code, regs) { cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, code);
    cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, , , cpu.esi, cpu.edi] = regs; cpu.ebp = 7; cpu.eflags = F.RESERVED1 | F.IF | (regs[8] & 0x8d5); },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); } };
}
// writers on eax/edx using cl (random), regs: eax=0 ecx=1 edx=2 ebx=3 esi=6
const W = () => {
  const r = rnd(20), imm = rnd(40);
  switch (r) {
    case 0: return [0xd2, 0xe0]; // shl al, cl
    case 1: return [0x66, 0xd3, 0xe0]; // shl ax, cl
    case 2: return [0xd3, 0xe0]; // shl eax, cl
    case 3: return [0xc0, 0xe0, imm & 31]; // shl al, imm
    case 4: return [0x66, 0xc1, 0xe0, imm & 31];
    case 5: return [0xc1, 0xe2, imm & 31]; // shl edx, imm
    case 6: return [0x01, 0xd0]; // add eax, edx
    case 7: return [0x28, 0xd0]; // sub al, dl
    case 8: return [0x66, 0x39, 0xd0]; // cmp ax, dx
    case 9: return [0x48]; case 10: return [0x42]; // dec eax, inc edx
    case 11: return [0x11, 0xd0]; case 12: return [0x18, 0xd0]; // adc eax, edx / sbb al, dl
    case 13: return [0xd3, 0xe8]; case 14: return [0xc0, 0xf8, imm & 31]; // shr eax,cl / sar al, imm
    case 15: return [0x21, 0xd0]; case 16: return [0xf7, 0xd8]; // and / neg
    case 17: return [0x0f, 0xaf, 0xc2]; case 18: return [0xd1, 0xe0]; // imul eax, edx / shl eax,1
    default: return [0x89, 0xc1, 0x83, 0xe1, 0x3f]; // mov ecx, eax ; and ecx, 63
  }
};
// readers: setcc bl + rol ebx? use: setcc bl ; add esi, ebx (esi accumulates) — add writes flags; use lea instead
const R = () => { const r = rnd(6), cc = rnd(16);
  switch (r) { case 0: case 1: return [0x0f, 0x90 + cc, 0xc3, 0xc1, 0xc6, 0x05, 0x8d, 0x34, 0x33]; // setcc bl ; rol esi,5 (writes CF/OF!) ...
    case 2: return [0x47]; // inc edi (keeps CF)
    case 3: return [0x0f, 0x40 + cc, 0xf8]; // cmovcc edi, eax
    case 4: return [0x13, 0xf8]; // adc edi, eax
    default: return [0x0f, 0x90 + cc, 0xc3, 0x8d, 0x34, 0x73]; } }; // setcc bl ; lea esi,[ebx+esi*2]
function gen() {
  // blocks: each = some writers/readers, ends with jcc to a random later block, or jmp, or fallthrough. Straight-line forward only.
  const nb = 6 + rnd(6), blocks = [];
  for (let i = 0; i < nb; i++) { const body = []; const n = rnd(4); for (let k = 0; k < n; k++) body.push(...(rnd(2) ? W() : R())); blocks.push(body); }
  // layout with jumps: jcc rel32 forward
  const out = []; const fix = []; const start = [];
  for (let i = 0; i < nb; i++) {
    start[i] = out.length; out.push(...blocks[i]);
    const t = rnd(4);
    if (i < nb - 1 && t < 3) { const tgt = i + 1 + rnd(nb - i - 1) ; const cc = rnd(16);
      if (t === 0) { out.push(0xe9); } else out.push(0x0f, 0x80 + cc); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); }
  }
  start[nb] = out.length; out.push(0x4d, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4);
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
const val = () => rnd(3) ? V[rnd(V.length)] : (rnd(65536) << 16 | rnd(65536)) >>> 0;
test('random lazy-flag programs across block boundaries match the interpreter', () => {
const N = 80;
for (let t = 0; t < N; t++) {
  const code = gen(); const end = CODE + code.length - 1;
  const regs = [val(), rnd(40), val(), 0, 0, 0, 0, 0, rnd(0x1000)];
  const EI = makeExec(false); EI.load(code, regs); const ri = EI.run(end, 1e5);
  for (const slice of [0, 3, 17]) {
    const EJ = makeExec(true); EJ.load(code, regs); let r, k = 0;
    while ((r = EJ.run(end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e5);
    const a = [EI.cpu.eax, EI.cpu.ecx, EI.cpu.edx, EI.cpu.ebx, EI.cpu.esi, EI.cpu.edi, EI.cpu.eflags & 0x8d5, EI.cpu.eip, EI.cpu.ebp];
    const b = [EJ.cpu.eax, EJ.cpu.ecx, EJ.cpu.edx, EJ.cpu.ebx, EJ.cpu.esi, EJ.cpu.edi, EJ.cpu.eflags & 0x8d5, EJ.cpu.eip, EJ.cpu.ebp];
    assert.equal(r, ri, `program ${t}, slices ${slice}: ${Buffer.from(code).toString('hex')}`);
    assert.equal(b.map((x) => (x >>> 0).toString(16)).join(' '), a.map((x) => (x >>> 0).toString(16)).join(' '), `program ${t}, slices ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => x.toString(16)).join(' ')}`);
  }
}
});

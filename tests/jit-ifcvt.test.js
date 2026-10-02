// If-conversion (translate.js ifcvtPlan / emitIfcvt): looped programs of random blocks ending in branches over short
// arms — triangles, mirrored triangles (the arm after the loop, jumping back) and diamonds — whose arms hold every kind
// of instruction the conversion accepts (moves, loads, LEA, ALU with registers / immediates / memory, INC/DEC/NEG/NOT,
// shifts by constants and CL, SETcc, CMOVcc, XCHG, CDQ/CWDE, BSWAP, 8/16-bit forms) and loads through a pointer the
// branch guards (an arm not taken must not touch its address: some are beyond the guest memory). Whole and time-sliced
// JIT runs, with and without if-conversion, against the interpreter: registers, arithmetic flags, EIP, exit code; the
// translations are checked to have converted branches. (Also with opts.tierPad: dead bytes at the start of each region.)
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
  return {
    mem, cpu, jit,
    load(code, regs) {
      cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, code);
      for (let i = 0; i < 0x100; i++) mem.write32(DATA + 4 * i, Math.imul(i + 1, 0x9e3779b1));
      cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esi] = regs; cpu.edi = DATA + 0x40; cpu.ebp = 5;
      cpu.eflags = F.RESERVED1 | F.IF | (regs[5] & 0x8d5);
    },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); },
  };
}
const R4 = () => rnd(4); // eax ecx edx ebx
/** an instruction an arm may hold (register destinations eax..ebx; loads from [edi+d8]) */
function armInsn() {
  const r = R4(), s = R4(), d8 = rnd(32) * 4, cc = rnd(16), n = rnd(8);
  switch (rnd(24)) {
    case 0: return [0x89, 0xc0 | (s << 3) | r]; // mov r, s
    case 1: return [0xb8 + r, ...le(rnd(1 << 30) * 3)]; // mov r, imm32
    case 2: return [0x8b, 0x40 | (r << 3) | 7, d8]; // mov r, [edi+d8]
    case 3: return [0x0f, 0xb6, 0x40 | (r << 3) | 7, d8 + rnd(4)]; // movzx r, byte [edi+d8]
    case 4: return [0x0f, 0xbf, 0x40 | (r << 3) | 7, d8]; // movsx r, word [edi+d8]
    case 5: return [0x8d, 0x44 | (r << 3), (2 << 6) | (s << 3) | R4(), rnd(256)]; // lea r, [b + s*4 + d8]
    case 6: return [0x01 | (n << 3), 0xc0 | (s << 3) | r]; // alu r, s
    case 7: return [0x83, 0xc0 | (n << 3) | r, rnd(256)]; // alu r, imm8
    case 8: return [0x03 | (n << 3), 0x40 | (r << 3) | 7, d8]; // alu r, [edi+d8]
    case 9: return [0xf7, 0xc0 | r, ...le(rnd(1 << 16) << rnd(16))]; // test r, imm32
    case 10: return [0x40 + r]; case 11: return [0x48 + r]; // inc / dec
    case 12: return [0xf7, 0xd8 | r]; case 13: return [0xf7, 0xd0 | r]; // neg / not
    case 14: return [0xc1, 0xe0 | ([4, 5, 7][rnd(3)] << 3) | r, rnd(32)]; // shl/shr/sar r, imm
    case 15: return r === 1 ? [0xd1, 0xe0 | r] : [0xd3, 0xe0 | ([4, 5, 7][rnd(3)] << 3) | r]; // shift r, cl
    case 16: return [0x0f, 0x90 + cc, 0xc0 | (rnd(2) ? r : r + 4)]; // setcc r8 (al..bl, ah..bh)
    case 17: return [0x0f, 0x40 + cc, 0xc0 | (r << 3) | s]; // cmovcc r, s
    case 18: return [0x87, 0xc0 | (s << 3) | r]; // xchg r, s
    case 19: return [rnd(2) ? 0x99 : 0x98]; // cdq / cwde
    case 20: return [0x0f, 0xc8 + r]; // bswap
    case 21: return [0x88, 0xc0 | (r << 3) | (s + 4 * rnd(2))]; // mov r8, r8 (high bytes too)
    case 22: return [0x66, 0x01 | (n << 3), 0xc0 | (s << 3) | r]; // 16-bit alu
    default: return [0x13 | (rnd(2) << 4), 0xc0 | (r << 3) | s]; // adc / sbb r, s
  }
}
/** a flag writer before a branch (or in a block body) */
function flagWriter() {
  const r = R4(), s = R4();
  switch (rnd(8)) {
    case 6: return [0x3b, 0x40 | (r << 3) | 7, rnd(32) * 4]; // cmp r, [edi+d8] (data: if-converted by the heuristic too)
    case 7: return [0x8b, 0x40 | (r << 3) | 7, rnd(32) * 4, 0x85, 0xc0 | (r << 3) | r]; // mov r, [edi+d8] ; test r, r
    case 0: return [0x39, 0xc0 | (s << 3) | r]; // cmp r, s
    case 1: return [0x85, 0xc0 | (s << 3) | r]; // test r, s
    case 2: return [0x83, 0xf8 | r, rnd(256)]; // cmp r, imm8
    case 3: return [0x40 + r]; // inc r
    case 4: return [0x29, 0xc0 | (s << 3) | r]; // sub r, s
    default: return [0xd1, 0xe8 | r]; // shr r, 1
  }
}
const arm = (max) => { const out = []; const n = 1 + rnd(max); for (let i = 0; i < n; i++) out.push(...armInsn()); return out; };
/**
 * A program: a loop (EBP times) over blocks, each a few flag writers / arm instructions then one of: a triangle
 * (jcc over an arm), a guarded load (test esi ; js over `mov r, [esi]`: esi may lie beyond the guest memory), a diamond
 * (jcc T ; arm ; jmp M ; T: arm ; M:), a mirrored triangle (jcc to an arm after the loop's end, which jumps back), or
 * nothing. Ends with `dec ebp ; jnz top ; hlt`.
 */
function gen() {
  const out = [], fix = [], tails = [];
  const nb = 2 + rnd(5);
  for (let i = 0; i < nb; i++) {
    for (let k = rnd(3); k > 0; k--) out.push(...(rnd(2) ? flagWriter() : armInsn()));
    const cc = rnd(16);
    switch (rnd(6)) {
      case 0: case 1: { // triangle
        out.push(...flagWriter());
        const a = arm(3); out.push(0x70 + cc, a.length, ...a); break;
      }
      case 2: { // guarded load through esi
        out.push(0x85, 0xf6); // test esi, esi
        const a = [0x8b, 0x06 | (R4() << 3), ...(rnd(2) ? arm(1) : [])]; // mov r, [esi] (; one more)
        out.push(0x78, a.length, ...a); break; // js over it
      }
      case 3: { // diamond
        out.push(...flagWriter());
        const a = arm(2), b = arm(2);
        out.push(0x70 + cc, a.length + 2, ...a, 0xeb, b.length, ...b); break;
      }
      case 4: { // mirrored triangle: the arm placed after the loop
        out.push(...flagWriter());
        out.push(0x0f, 0x80 + cc); const at = out.length; out.push(0, 0, 0, 0);
        tails.push({ at, back: out.length, body: arm(3) }); break;
      }
      default: break;
    }
  }
  out.push(0x4d, 0x0f, 0x85, ...le(-(out.length + 7))); // dec ebp ; jnz top
  const end = out.length; out.push(0xf4); // hlt
  for (const t of tails) {
    fix.push([t.at, out.length]);
    out.push(...t.body, 0xe9); out.push(...le(t.back - (out.length + 4)));
  }
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(tgt - (at + 4)));
  return { code: Uint8Array.from(out), end };
}
const V = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
const val = () => (rnd(3) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);
const ptr = () => [DATA + 4 * rnd(64), 0x80000000 + rnd(1 << 20) * 4, 0xfffffffc, DATA + 0x100][rnd(4)] >>> 0;
const state = (E) => [E.cpu.eax, E.cpu.ecx, E.cpu.edx, E.cpu.ebx, E.cpu.esi, E.cpu.edi, E.cpu.ebp, E.cpu.eflags & 0x8d5, E.cpu.eip].map((x) => (x >>> 0).toString(16)).join(' ');

test('random branches over short arms: if-converted translations match the interpreter, whole and time-sliced', () => {
  let converted = 0, heuristic = 0;
  for (let t = 0; t < 250; t++) {
    const { code, end } = gen();
    const regs = [val(), rnd(40), val(), val(), ptr(), rnd(0x1000)];
    const EI = makeExec(null); EI.load(code, regs); const ri = EI.run(CODE + end, 1e5);
    for (const [opts, slice] of [[{ ifcvt: 'all' }, 0], [{ ifcvt: 'all' }, 1], [{ ifcvt: 'all' }, 3], [{ ifcvt: 'all' }, 17], [{ ifcvt: true }, 0], [{ ifcvt: false }, 0], [{ ifcvt: 'all', tierPad: 300 }, 3]]) {
      const EJ = makeExec(opts); EJ.load(code, regs);
      let r, k = 0;
      while ((r = EJ.run(CODE + end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e6);
      if (opts.ifcvt === 'all' && !slice) converted += EJ.jit.stats.ifcvt;
      if (opts.ifcvt === true) heuristic += EJ.jit.stats.ifcvt;
      const msg = `program ${t}, ${JSON.stringify(opts)} slices ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => (x >>> 0).toString(16)).join(' ')}`;
      assert.equal(r, ri, msg);
      assert.equal(state(EJ), state(EI), msg);
    }
  }
  assert.ok(converted > 200 && heuristic > 50 && heuristic < converted, `branches converted: ${converted}, by the data heuristic: ${heuristic}`);
});

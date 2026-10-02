// Block layout in reverse postorder (translate.js opts.layout, layoutBlocks): random programs of blocks joined by
// forward and backward conditional branches, jumps, and calls to leaf functions placed before or after their callers
// (so that in address order their returns go backward through the region's dispatch, and forward in reverse
// postorder), every block counting down EDI to a bounded end. The JIT with the layout matches the interpreter (registers,
// arithmetic flags, the stack written by the calls), whole and time-sliced; and its time slices end at the same
// addresses, after the same instruction counts, as without the layout (the budget is checked on the transfers backward
// in address order whatever the emission order: the threads' interleavings do not change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
let seed = 4242;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const R3 = () => [0, 1, 2, 3][rnd(4)]; // eax ecx edx ebx
const alu = () => [[0x01, 0xc0 | (R3() << 3) | R3()], [0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)], [0x8d, 0x40 | (R3() << 3) | R3(), rnd(128)], [0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()]][rnd(4)];

/**
 * blocks: k of them, each `dec edi ; jz end ; <alu>* ; <terminator>`, the terminator a Jcc / JMP to a random block, a CALL
 * to one of the leaf functions, or a fallthrough; the leaf functions (`<alu>* ; ret`) are placed among the blocks.
 */
function gen() {
  const nb = 4 + rnd(8), nf = 1 + rnd(3);
  const kinds = []; // 'b' block, 'f' function
  for (let i = 0; i < nb; i++) kinds.push('b');
  for (let i = 0; i < nf; i++) kinds.splice(rnd(kinds.length + 1), 0, 'f');
  kinds.unshift('b'); // (the entry is a block)
  const fns = kinds.map((k, i) => (k === 'f' ? i : -1)).filter((i) => i >= 0), blocksIdx = kinds.map((k, i) => (k === 'b' ? i : -1)).filter((i) => i >= 0);
  const out = [], start = [], fix = []; // fix: [at, target index, rel32]
  for (let i = 0; i < kinds.length; i++) {
    start[i] = out.length;
    if (kinds[i] === 'f') { for (let k = rnd(3); k >= 0; k--) out.push(...alu()); out.push(0xc3); continue; }
    out.push(0x4f, 0x0f, 0x84); fix.push([out.length, -1]); out.push(0, 0, 0, 0); // dec edi ; jz end
    for (let k = rnd(3); k > 0; k--) out.push(...alu());
    const tgt = blocksIdx[rnd(blocksIdx.length)];
    switch (rnd(4)) {
      case 0: out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break; // jcc
      case 1: out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break; // jmp
      case 2: out.push(0xe8); fix.push([out.length, fns[rnd(fns.length)]]); out.push(0, 0, 0, 0); // call fn, then on
        if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, blocksIdx[rnd(blocksIdx.length)]]); out.push(0, 0, 0, 0); }
        break;
      default: if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); } break; // fallthrough (not into a function)
    }
  }
  // the last block falls through to the end
  if (kinds[kinds.length - 1] === 'f') { out.push(0xe9); fix.push([out.length, 0]); out.push(0, 0, 0, 0); }
  const end = out.length; out.push(0xf4);
  for (const [at, t] of fix) out.splice(at, 4, ...le((t < 0 ? end : start[t]) - (at + 4)));
  return { code: Uint8Array.from(out), end };
}
function run(code, end, regs, jitOpts, slice) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code); mem.fill(DATA, 0x1000, 0);
  [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = regs; cpu.edi = 200 + rnd(300); cpu.esp = DATA + 0x800; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF | (regs[4] & ARITH);
  const I = new Interp(mem, cpu);
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  if (jit) jit.cpu = cpu;
  const slices = [];
  let r;
  for (;;) {
    r = jit ? jit.run({ stopAt: CODE + end, maxInsns: slice }) : I.run({ stopAt: CODE + end, maxInsns: 1e7 });
    if (r !== EXIT.TIMESLICE) break;
    slices.push(`${(cpu.eip >>> 0).toString(16)}/${jit.remaining()}`);
    if (slices.length > 1e5) throw new Error('runaway');
  }
  if (jit) CpuState.foldLazyFlags?.(cpu);
  const state = [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA + 0x700, 0x100)].join(',');
  return { r, state, slices: slices.join(' ') };
}
const V = [0, 1, 0x7f, 0x80, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(2) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);

test('reverse-postorder layout: random programs with in-region calls and backward branches match the interpreter, with the same time slices', () => {
  for (let t = 0; t < 200; t++) {
    const { code, end } = gen();
    const regs = [val(), val(), val(), val(), rnd(0x1000)];
    const s0 = seed;
    const want = run(code, end, regs, null, 0);
    for (const slice of [1e7, 1, 3, 7]) {
      seed = s0; const off = run(code, end, regs, { layout: false }, slice);
      seed = s0; const on = run(code, end, regs, { layout: true }, slice);
      const msg = `program ${t} slice ${slice}: ${Buffer.from(code).toString('hex')} regs ${regs.map((x) => (x >>> 0).toString(16)).join(' ')}`;
      assert.equal(on.r, want.r, msg);
      assert.equal(on.state, want.state, msg);
      assert.equal(off.state, want.state, msg);
      assert.equal(on.slices, off.slices, `time slices: ${msg}`);
    }
  }
});

// The x87-mode versions of a region (jit.js EXIT_FPUMODE: the guard of one version tail-calls the next with the block
// index it was entered with) must number their blocks alike. A region whose first version was translated in another
// layout (the background worker with other options than the emulator's translations, as after an in-session switch)
// must not get a version under another numbering: the entry's index would select another block there.
import { handleMessage } from '../src/cpu/jit/bg-translate.js';
test('x87-mode versions of a region translated under different layouts are not chained (block numbers differ)', () => {
  // L0 (lower address, reached from the entry): fld1 ; faddp ; fstp dword [esi] ; hlt — entry E: fldz ; fld1 ; faddp... ; jmp L0
  const L0 = [0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0x1e, 0xf4]; // fld1 ; faddp st1 ; fstp dword [esi] ; hlt
  const E = [0xd9, 0xee, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0xe8, 0xde, 0xc1, 0xe9]; // fldz ; fld1 ; faddp ; fld1 ; faddp ; jmp L0
  const code = [...L0, 0x90, 0x90, 0x90, ...E];
  code.push(...le(0 - (code.length + 4)));
  const entry = CODE + L0.length + 3, stop = CODE + L0.length - 1;
  const mem = new GuestMemory({ shared: true }), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.writeBytes(CODE, Uint8Array.from(code));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, layout: true });
  jit.cpu = cpu;
  const replies = [];
  jit.attachBackground({ postMessage: (m) => handleMessage(m, (r) => replies.push(r)) }); // (its translations: layout on)
  jit.opts.layout = false; // (the emulator's own translations: address order)
  mem.write16(cpu.base + ST.FPU_CW, 0x027f);
  jit.bgPrewarm([[entry, 0x200]]);
  jit.bgInstall(replies[0]);
  assert.equal(jit.bg.installed, 1);
  for (const cw of [0x007f, 0x027f, 0x0c7f]) {
    mem.write16(cpu.base + ST.FPU_CW, cw); cpu.eip = entry; cpu.esi = DATA; cpu.esp = DATA + 0x800; mem.write32(DATA, 0);
    let r; do r = jit.run({ stopAt: stop, maxInsns: 1e6 }); while (r === EXIT.TIMESLICE);
    assert.equal(r, EXIT.HALT, `cw ${cw.toString(16)}`);
    assert.equal(mem.readF32(DATA), 3, `cw ${cw.toString(16)}: 0 + 1 + 1 + 1 stored`);
  }
});

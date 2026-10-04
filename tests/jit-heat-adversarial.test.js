// Adversarial review of heat-shaped regions (translate.js opts.coldExits, heat.js): random programs mixing integer
// code, x87 arithmetic under control-word changes (FLDCW inside the program: x87-mode versions of regions), divisions
// that may fault (#DE: precise exits) and calls, run several times on ONE Jit whose heat is replaced between runs by
// another random heat (heat growing and shrinking between sessions, successors marked cold that then run), with
// random code ranges invalidated between runs (translated again under the new heat, as after self-modifying code),
// the initial x87 mode changing between runs, whole and time-sliced. Every run ends as the interpreter does: exit
// code, EIP, registers, flags, x87 control word and TOP, data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { decode } from '../src/cpu/decoder.js';
import { RangeHeat } from '../src/cpu/jit/heat.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
let seed = 4343;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const R3 = () => rnd(4); // eax ecx edx ebx
const CWS = [0x027f, 0x007f, 0x0c7f, 0x037f]; // (at esi+0x70.., loaded by FLDCW)
const unit = () => {
  switch (rnd(9)) {
    case 0: return [0x01, 0xc0 | (R3() << 3) | R3()];
    case 1: return [0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)];
    case 2: return [0x89, 0x46 | (R3() << 3), 4 * rnd(16)]; // mov [esi+d8], r
    case 3: return [0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()];
    case 4: return [0x31, 0xd2, 0xf7, 0xf3]; // xor edx, edx ; div ebx (#DE when ebx = 0)
    case 5: return [0xd9, 0x6e, 0x70 + 2 * rnd(4)]; // fldcw [esi+0x70+2k]
    case 6: { // fld dword [esi+a] ; fadd / fmul / fsub dword [esi+b] ; fstp dword [esi+c]
      const op = [[0xd8, 0x46], [0xd8, 0x4e], [0xd8, 0x66]][rnd(3)];
      return [0xd9, 0x46, 4 * rnd(16), ...op, 4 * rnd(16), 0xd9, 0x5e, 4 * rnd(16)];
    }
    case 7: return [0xdb, 0x46, 4 * rnd(16), 0xdb, 0x5e, 4 * rnd(16)]; // fild / fistp dword (rounding control)
    default: return [0x31, 0xdb]; // xor ebx, ebx (divisions by zero likelier)
  }
};

/** blocks `dec edi ; jz end ; <unit>* ; <terminator>` (Jcc / JMP to a random block, CALL of a leaf function, fallthrough) */
function gen() {
  const nb = 4 + rnd(10), nf = 1 + rnd(3);
  const kinds = [];
  for (let i = 0; i < nb; i++) kinds.push('b');
  for (let i = 0; i < nf; i++) kinds.splice(rnd(kinds.length + 1), 0, 'f');
  kinds.unshift('b');
  const fns = kinds.map((k, i) => (k === 'f' ? i : -1)).filter((i) => i >= 0), blocksIdx = kinds.map((k, i) => (k === 'b' ? i : -1)).filter((i) => i >= 0);
  const out = [], start = [], fix = [];
  for (let i = 0; i < kinds.length; i++) {
    start[i] = out.length;
    if (kinds[i] === 'f') { for (let k = rnd(3); k >= 0; k--) out.push(...unit()); out.push(0xc3); continue; }
    out.push(0x4f, 0x0f, 0x84); fix.push([out.length, -1]); out.push(0, 0, 0, 0);
    for (let k = rnd(4); k > 0; k--) out.push(...unit());
    const tgt = blocksIdx[rnd(blocksIdx.length)];
    switch (rnd(4)) {
      case 0: out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break;
      case 1: out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break;
      case 2: out.push(0xe8); fix.push([out.length, fns[rnd(fns.length)]]); out.push(0, 0, 0, 0);
        if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, blocksIdx[rnd(blocksIdx.length)]]); out.push(0, 0, 0, 0); }
        break;
      default: if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); } break;
    }
  }
  if (kinds[kinds.length - 1] === 'f') { out.push(0xe9); fix.push([out.length, 0]); out.push(0, 0, 0, 0); }
  const end = out.length; out.push(0xf4);
  for (const [at, t] of fix) out.splice(at, 4, ...le((t < 0 ? end : start[t]) - (at + 4)));
  return { code: Uint8Array.from(out), end };
}

const V = [0, 1, 2, 0x7f, 0x80, 0xffff, 0x3f800000, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(2) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);
const input = () => ({ regs: [val(), val(), val(), val(), rnd(0x1000)], edi: 20 + rnd(300), cw: CWS[rnd(CWS.length)], data: Array.from({ length: 16 }, () => (rnd(3) ? [0x3f800000, 0x40490fdb, 0xc2c80000, 0x4b000001, 0x3eaaaaab][rnd(5)] : val())) });
function init(mem, cpu, inp) {
  cpu.reset(); mem.fill(DATA, 0x1000, 0);
  inp.data.forEach((v, i) => mem.write32(DATA + 0x100 + 4 * i, v));
  CWS.forEach((cw, i) => mem.write16(DATA + 0x170 + 2 * i, cw));
  [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
  mem.write16(cpu.base + ST.FPU_CW, inp.cw);
}
const stateOf = (r, mem, cpu) => [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip, mem.read16(cpu.base + ST.FPU_CW), mem.u8[cpu.base + ST.FPU_TOP] & 7].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA + 0x100, 0x80), ...mem.bytes(DATA + 0x700, 0x100)].join(',');
function setup(code) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code);
  return { mem, cpu };
}
function randomHeat(addrs) {
  const h = rnd(2) ? new RangeHeat() : new Map();
  for (let i = 0; i < addrs.length; i++) {
    if (rnd(3) === 0) continue; // never ran
    if (h instanceof Map) h.set(addrs[i], rnd(4) ? 1000 : 1 + rnd(100));
    else h.add(addrs[i], i + 1 < addrs.length ? addrs[i + 1] : addrs[i] + 1);
  }
  return h;
}

test('heat replaced between runs, code invalidated, x87 modes, faults: every run matches the interpreter', () => {
  let faults = 0, versions = 0, regionsMore = 0;
  for (let t = 0; t < 80; t++) {
    const { code, end } = gen();
    const scratch = new GuestMemory(); scratch.writeBytes(CODE, code);
    const addrs = [];
    for (let a = 0; a <= end;) { addrs.push(CODE + a); a = decode(scratch, CODE + a).next - CODE; }
    const { mem, cpu } = setup(code);
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, coldExits: true, coldMin: 1 + rnd(3) });
    jit.cpu = cpu;
    for (let k = 0; k < 6; k++) {
      const inp = input();
      const ref = setup(code); init(ref.mem, ref.cpu, inp);
      const want = stateOf(new Interp(ref.mem, ref.cpu).run({ stopAt: CODE + end, maxInsns: 1e7 }), ref.mem, ref.cpu);
      jit.heat = rnd(5) ? randomHeat(addrs) : null;
      if (rnd(3) === 0) { const a = addrs[rnd(addrs.length)]; jit.invalidate(a, 1 + rnd(16)); }
      const before = jit.regions.length;
      init(mem, cpu, inp);
      const slice = [1e7, 1, 3, 17][rnd(4)];
      let r;
      for (let n = 0; ; n++) {
        if (n > 1e6) throw new Error('runaway');
        r = jit.run({ stopAt: CODE + end, maxInsns: slice });
        if (r !== EXIT.TIMESLICE) break;
      }
      CpuState.foldLazyFlags?.(cpu);
      if (r === EXIT.FAULT) faults++;
      if (jit.regions.length > before) regionsMore++;
      assert.equal(stateOf(r, mem, cpu), want, `program ${t} run ${k} slice ${slice}: ${Buffer.from(code).toString('hex')}`);
    }
    versions += jit.stats.fpuVersions ?? 0;
  }
  assert.ok(faults > 20, `runs ending in #DE: ${faults}`);
  assert.ok(versions > 5, `x87-mode versions: ${versions}`);
  assert.ok(regionsMore > 50, `runs translating new regions: ${regionsMore}`);
});

// Visit flags allocated after the area is full: no allocation keeps advancing the shared bump index (it would
// eventually wrap and hand out addresses outside the area), and nothing outside the area is written.
import { VisitSlots, allocBlockCounters } from '../src/cpu/jit/translate.js';
import { BLOCK_COUNTS_BASE, BLOCK_COUNTS_SLOTS } from '../src/cpu/memory.js';
test('visit flags: an exhausted counter area stays exhausted (the bump index stops advancing)', () => {
  const mem = new GuestMemory();
  const slots = new VisitSlots();
  let n = 0;
  while (slots.get(mem, 0x1000 + n) >= 0) n++;
  assert.ok(n > 300000 && n <= 4 * BLOCK_COUNTS_SLOTS, `flags allocated: ${n}`);
  const idx = mem.i32[BLOCK_COUNTS_BASE >>> 2];
  for (let i = 0; i < 1000; i++) assert.equal(slots.get(mem, 0x900000 + i), -1);
  assert.equal(allocBlockCounters(mem, 2048), -1);
  assert.equal(mem.i32[BLOCK_COUNTS_BASE >>> 2], idx, 'bump index unchanged once full');
  // (a wrapped index — negative — is refused too)
  mem.i32[BLOCK_COUNTS_BASE >>> 2] = -0x7ffffff0;
  assert.equal(allocBlockCounters(mem, 1024), -1);
});

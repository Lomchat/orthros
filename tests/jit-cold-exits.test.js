// Regions shaped by block heat (translate.js opts.coldExits with a heat map, Jit.collectHeat): a branch successor the
// counted run never executed is left out of the region and becomes an exit. Random programs (blocks joined by
// conditional branches, jumps and calls, EDI counting down to a bounded end) are first run with block counters on
// some inputs, the heat collected, then run on other inputs — which take edges the counted run never took — with the
// cold exits: the same registers, flags, stack and data as the interpreter, whole and time-sliced (a slice may end
// at a cold exit instead of the next backward transfer: the dispatcher checks the budget at every region entry, as
// for any region boundary). Also with a
// heat map naming random instructions (any heat is exact: only the regions' extent changes) and under self-modifying code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { decode } from '../src/cpu/decoder.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
let seed = 777;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const R3 = () => [0, 1, 2, 3][rnd(4)]; // eax ecx edx ebx
const alu = () => [[0x01, 0xc0 | (R3() << 3) | R3()], [0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)], [0x8d, 0x40 | (R3() << 3) | R3(), rnd(128)], [0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()],
  [0x89, 0x46 | (R3() << 3), 4 * rnd(16)]][rnd(5)]; // (... mov [esi+d8], r: stores into the data)

/** blocks `dec edi ; jz end ; <alu>* ; <terminator>` (Jcc / JMP to a random block, CALL of a leaf function, fallthrough) */
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
    if (kinds[i] === 'f') { for (let k = rnd(3); k >= 0; k--) out.push(...alu()); out.push(0xc3); continue; }
    out.push(0x4f, 0x0f, 0x84); fix.push([out.length, -1]); out.push(0, 0, 0, 0);
    for (let k = rnd(3); k > 0; k--) out.push(...alu());
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

/** run from CODE to the end (interpreter when `jit` is null), time slices of `slice` instructions */
function run(mem, cpu, jit, end, input, slice) {
  cpu.reset(); mem.fill(DATA, 0x1000, 0);
  [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = input.regs; cpu.edi = input.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF | (input.regs[4] & ARITH);
  const slices = [];
  let r;
  for (;;) {
    if (jit) { jit.cpu = cpu; r = jit.run({ stopAt: CODE + end, maxInsns: slice }); } else r = new Interp(mem, cpu).run({ stopAt: CODE + end, maxInsns: 1e7 });
    if (r !== EXIT.TIMESLICE) break;
    slices.push(`${(cpu.eip >>> 0).toString(16)}/${jit.remaining()}`);
    if (slices.length > 1e5) throw new Error('runaway');
  }
  if (jit) CpuState.foldLazyFlags?.(cpu);
  const state = [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA + 0x100, 0x40), ...mem.bytes(DATA + 0x700, 0x100)].join(',');
  return { state, slices: slices.join(' ') };
}
const V = [0, 1, 0x7f, 0x80, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(2) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);
const input = (edi) => ({ regs: [val(), val(), val(), val(), rnd(0x1000)], edi });
function setup(code) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code);
  return { mem, cpu };
}

test('cold exits from a counted or visited run: random programs on other inputs match the interpreter, whole and time-sliced', () => {
  let left = 0;
  for (let t = 0; t < 60; t++) {
    const { code, end } = gen();
    // counted run: short (few edges taken), then the heat of its translations — block counters (collectHeat) or, every
    // other program, visit flags (harvestVisits: the ranges a session sends to the server)
    const { mem, cpu } = setup(code);
    const visits = t % 2 === 1;
    const jit = new Jit(mem, new Interp(mem, cpu), visits ? { smc: true, visit: true } : { smc: true, blockCounts: true });
    for (let k = 0; k < 2; k++) run(mem, cpu, jit, end, input(20 + rnd(20)), 1e7);
    if (visits) jit.harvestVisits(); else jit.collectHeat();
    const heat = jit.heat;
    for (let k = 0; k < 3; k++) {
      const inp = input(100 + rnd(400));
      // (the reference: the interpreter on a fresh memory)
      const ref = setup(code); const exp = run(ref.mem, ref.cpu, null, end, inp, 0);
      for (const slice of [1e7, 1, 5]) {
        const a = setup(code), b = setup(code);
        const ja = new Jit(a.mem, new Interp(a.mem, a.cpu), { smc: true });
        const jb = new Jit(b.mem, new Interp(b.mem, b.cpu), { smc: true, coldExits: true, coldMin: 2 }); jb.heat = heat;
        const off = run(a.mem, a.cpu, ja, end, inp, slice), on = run(b.mem, b.cpu, jb, end, inp, slice);
        const msg = `program ${t} input ${k} slice ${slice}: ${Buffer.from(code).toString('hex')}`;
        assert.equal(on.state, exp.state, msg);
        assert.equal(off.state, exp.state, msg);
        if (slice === 1e7) left += jb.regions.length > ja.regions.length;
      }
    }
  }
  assert.ok(left > 10, `programs whose cold edges were taken later (more regions): ${left}`);
});

test('cold exits under an arbitrary heat map and self-modifying code match the interpreter', () => {
  let smc = 0;
  for (let t = 0; t < 120; t++) {
    const g = gen(), body = [...g.code], imms = [];
    const scratch = new GuestMemory(); scratch.writeBytes(CODE, g.code);
    const addrs = [];
    for (let a = 0; a < g.end;) { const insn = decode(scratch, CODE + a); addrs.push(CODE + 5 + a); if (body[a] === 0x83 && (body[a + 1] & 0xc0) === 0xc0) imms.push(a + 2); a = insn.next - CODE; }
    if (!imms.length) continue;
    const at = 5 + imms[rnd(imms.length)];
    // call patch ; <body ... hlt> ; patch: mov [CODE+at], al ; inc al ; ret
    const code = Uint8Array.from([0xe8, ...le(body.length), ...body, 0xa2, ...le(CODE + at), 0xfe, 0xc0, 0xc3]), end = 5 + g.end;
    // a random heat map: each instruction executed (many times) or never
    const heat = new Map([[CODE, 1000]]);
    for (const a of addrs) if (rnd(3)) heat.set(a, rnd(2) ? 1000 : 1 + rnd(100));
    const inp = input(100 + rnd(300));
    // (the interpreter decoding afresh: the program patches itself)
    const want = (() => {
      const { mem, cpu } = setup(code); cpu.reset(); mem.fill(DATA, 0x1000, 0);
      [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE; cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
      const I = new Interp(mem, cpu); I.cache = new (class extends Map { set() { return this; } })();
      const r = I.run({ stopAt: CODE + end, maxInsns: 1e7 });
      return [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + Buffer.from(mem.bytes(CODE, code.length)).toString('hex');
    })();
    for (const slice of [1e7, 3]) {
      const { mem, cpu } = setup(code); mem.fill(DATA, 0x1000, 0);
      const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, coldExits: true, coldMin: 2 }); jit.heat = heat; jit.cpu = cpu;
      [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE; cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
      let r;
      for (let n = 0; ; n++) {
        if (n > 1e6) throw new Error('runaway');
        r = jit.run({ stopAt: CODE + end, maxInsns: slice });
        if (r === EXIT.SMC) { const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0); jit.invalidate(cpu.exitArg, len); smc++; continue; }
        if (r !== EXIT.TIMESLICE) break;
      }
      CpuState.foldLazyFlags?.(cpu);
      const got = [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + Buffer.from(mem.bytes(CODE, code.length)).toString('hex');
      assert.equal(got, want, `program ${t} slice ${slice}: ${Buffer.from(code).toString('hex')}`);
    }
  }
  assert.ok(smc > 50, `SMC exits: ${smc}`);
});

test('visit flags: the harvested ranges are the translated blocks that ran, each reported once', () => {
  for (let t = 0; t < 80; t++) {
    const { code, end } = gen();
    const inp = input(30 + rnd(200));
    // the instructions the interpreter executes
    const ran = new Set([CODE + end]); // (the stop address's block counts as entered: its flag is set before the stop check)
    { const { mem, cpu } = setup(code); cpu.reset(); mem.fill(DATA, 0x1000, 0); [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE;
      cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
      const I = new Interp(mem, cpu);
      for (let n = 0; n < 1e6 && (cpu.eip >>> 0) !== CODE + end; n++) { ran.add(cpu.eip >>> 0); if (I.run({ stopAt: CODE + end, maxInsns: 1 }) !== EXIT.TIMESLICE) break; } }
    const { mem, cpu } = setup(code);
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, visit: true });
    const half = run(mem, cpu, jit, end, inp, 1e7);
    void half;
    // (odd programs: the pass cut into steps of budget 0 — a time check every 64 regions)
    let pairs; if (t & 1) { while (!(pairs = jit.harvestVisitsStep(0))); } else pairs = jit.harvestVisits();
    assert.equal(jit.harvestVisits().length, 0, 'reported once');
    const covered = new Set();
    for (let i = 0; i < pairs.length; i += 2) {
      for (let a = pairs[i]; a < pairs[i + 1];) { assert.ok(ran.has(a), `program ${t}: ${a.toString(16)} reported, never executed`); covered.add(a); a = decode(mem, a).next; }
    }
    for (const a of ran) if (a !== CODE + end && a >= CODE && a < CODE + code.length) assert.ok(covered.has(a) || jit.heat.has(a), `program ${t}: ${a.toString(16)} executed, not in the heat`);
  }
});

import { RangeHeat, LearnedHeat, VISITED } from '../src/cpu/jit/heat.js';
test('RangeHeat merges ranges; LearnedHeat applies module ranges once per module', () => {
  const h = new RangeHeat();
  h.add(100, 110); h.add(105, 120); h.add(200, 201); h.add(120, 130);
  assert.equal(h.get(99), 0); assert.equal(h.get(100), VISITED); assert.equal(h.get(129), VISITED); assert.equal(h.get(130), 0); assert.equal(h.get(200), VISITED); assert.equal(h.get(201), 0);
  assert.deepEqual([...h.pairs()], [100, 130, 200, 201]);
  const L = new LearnedHeat({ 'a.dll': [0x10, 4, 0x2000, 8], 'b.exe': [0x1000, 0x10] });
  assert.deepEqual(L.apply([{ name: 'A.DLL', base: 0x400000, size: 0x1000 }]), [0x400010, 0x400014]); // (the range beyond the image dropped)
  assert.equal(L.apply([{ name: 'a.dll', base: 0x400000, size: 0x1000 }]), null);
  assert.deepEqual(L.apply([{ name: 'a.dll', base: 0x400000, size: 0x1000 }, { name: 'b.exe', base: 0x800000, size: 0x2000 }]), [0x801000, 0x801010]);
});

// The x87-mode versions of a region repeat its blocks under the same numbers (a version's guard passes the block index
// it was entered with to the next one): a version translated after the heat grew keeps the first version's extent
// (discoverRegion opts.onlyBlocks) instead of falling back to the mode tested at run time.
test('x87-mode versions keep the first version\'s blocks when the heat grows meanwhile', () => {
  // E: fldz ; fld1 ; faddp ; test eax, eax ; jz L1 ; fld1 ; faddp ; L1: fld1 ; faddp ; fstp dword [esi] ; hlt
  const code = [0xd9, 0xee, 0xd9, 0xe8, 0xde, 0xc1, 0x85, 0xc0, 0x74, 0x04, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0xe8, 0xde, 0xc1, 0xd9, 0x1e, 0xf4];
  const cold = CODE + 10, L1 = CODE + 14, stop = CODE + code.length - 1;
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.writeBytes(CODE, Uint8Array.from(code));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  const heat = new RangeHeat(); heat.add(CODE, cold); heat.add(L1, stop + 1); // (the fallthrough of the jz never ran)
  jit.heat = heat;
  const go = (cw, eax) => {
    mem.write16(cpu.base + ST.FPU_CW, cw); cpu.eip = CODE; cpu.eax = eax; cpu.esi = DATA; cpu.esp = DATA + 0x800; mem.write32(DATA, 0);
    let r; do r = jit.run({ stopAt: stop, maxInsns: 1e6 }); while (r === EXIT.TIMESLICE);
    assert.equal(r, EXIT.HALT);
    return mem.readF32(DATA);
  };
  assert.equal(go(0x027f, 0), 2);
  const first = jit.regionAt(CODE);
  assert.ok(!first.blocks.some((b) => b.eip === cold), 'the cold block left out');
  heat.add(cold, L1); // (it runs now)
  assert.equal(go(0x027f, 1), 3);
  assert.equal(go(0x007f, 1), 3); // (another mode: a version of the region)
  assert.equal(go(0x0c7f, 0), 2);
  assert.ok((jit.stats.fpuVersions ?? 0) >= 2, `versions chained: ${jit.stats.fpuVersions}`);
  for (const v of first.versions) assert.deepEqual(v.blocks.map((b) => [b.eip, b.index]), first.blocks.map((b) => [b.eip, b.index]));
});

// Threads: three guest threads run one program (each its own registers, stack and data) alternated every few
// instructions under cold exits from a random heat; each ends as the interpreter does on its own inputs.
test('cold exits with threads alternated every few instructions: each thread matches the interpreter', () => {
  for (let t = 0; t < 60; t++) {
    const { code, end } = gen();
    const scratch = new GuestMemory(); scratch.writeBytes(CODE, code);
    const heat = new Map([[CODE, 1000]]);
    for (let a = 0; a < end;) { if (rnd(3)) heat.set(CODE + a, 1000); a = decode(scratch, CODE + a).next - CODE; }
    const inputs = [0, 1, 2].map(() => input(50 + rnd(300)));
    const init = (cpu, inp, k) => {
      cpu.reset(); [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100 + 0x1000 * k; cpu.esp = DATA + 0x800 + 0x1000 * k; cpu.eip = CODE;
      cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
    };
    const stateOf = (r, cpu, mem, k) => [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA + 0x100 + 0x1000 * k, 0x40), ...mem.bytes(DATA + 0x700 + 0x1000 * k, 0x100)].join(',');
    const want = inputs.map((inp, k) => {
      const { mem, cpu } = setup(code); mem.fill(DATA, 0x4000, 0); init(cpu, inp, k);
      const r = new Interp(mem, cpu).run({ stopAt: CODE + end, maxInsns: 1e7 });
      return stateOf(r, cpu, mem, k);
    });
    for (const slice of [2, 7]) {
      const mem = new GuestMemory(); mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code); mem.fill(DATA, 0x4000, 0);
      const cpus = inputs.map((inp, k) => { const c = new CpuState(mem, THREAD_STATES_BASE + k * 0x1000); init(c, inp, k); return c; });
      const jit = new Jit(mem, new Interp(mem, cpus[0]), { smc: true, coldExits: true, coldMin: 2 }); jit.heat = heat;
      const res = [null, null, null];
      for (let turn = 0; res.some((x) => x === null); turn++) {
        if (turn > 1e6) throw new Error('runaway');
        const k = turn % 3; if (res[k] !== null) continue;
        jit.cpu = cpus[k];
        const r = jit.run({ stopAt: CODE + end, maxInsns: slice });
        if (r === EXIT.TIMESLICE) continue;
        CpuState.foldLazyFlags?.(cpus[k]);
        res[k] = stateOf(r, cpus[k], mem, k);
      }
      for (let k = 0; k < 3; k++) assert.equal(res[k], want[k], `program ${t} thread ${k} slice ${slice}: ${Buffer.from(code).toString('hex')}`);
    }
  }
});

import { VisitSlots, translateRegion } from '../src/cpu/jit/translate.js';
import { BLOCK_COUNTS_BASE } from '../src/cpu/memory.js';
test('visit flags: one byte per block address, shared by the regions holding the block', () => {
  // A: inc eax ; jmp C — B: inc ecx ; jmp C — C: dec edi ; jnz A ; hlt (C in the regions of A and of B)
  const code = [0x40, 0xeb, 0x02, 0x41, 0x90, 0x4f, 0x75, 0xf8, 0xf4];
  const mem = new GuestMemory(); mem.writeBytes(CODE, Uint8Array.from(code));
  const slots = new VisitSlots();
  const ra = translateRegion(mem, CODE, { visit: true, visitSlots: slots }), rb = translateRegion(mem, CODE + 3, { visit: true, visitSlots: slots });
  const flagOf = (r, eip) => r.stats.visits.find((v) => v[0] === eip)?.[2];
  assert.ok(flagOf(ra, CODE + 5) >= BLOCK_COUNTS_BASE);
  assert.equal(flagOf(ra, CODE + 5), flagOf(rb, CODE + 5), 'block C: the same byte in both regions');
  assert.notEqual(flagOf(ra, CODE), flagOf(rb, CODE + 3));
  assert.equal(new Set([...ra.stats.visits, ...rb.stats.visits].map((v) => v[2])).size, slots.map.size, 'one byte per distinct block');
});

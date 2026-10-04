// Return-site records (translate.js opts.ras): a call leaving its region writes its return site (a block of the region,
// with the region's table index and the block's index) into the thread's state block, and a chained transfer to that
// address enters the region there without a hash lookup. Hand-built programs whose calls leave their regions (region
// boundaries at the callees), with returns to other addresses, recursion, regions dropped while a record names them
// (code written by the callee), x87 regions, and two threads alternating on one JIT, must match the reference
// interpreter whole and in small time slices; the profiling counters show the records used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; }
  raw(...x) { this.b.push(...x); return this; }
  label(n) { this.labels.set(n, this.b.length); return this; }
  ref(n, abs) { this.fix.push([this.b.length, n, abs]); this.b.push(0, 0, 0, 0); return this; }
  call(n) { return this.raw(0xe8).ref(n); }
  jmp(n) { return this.raw(0xe9).ref(n); }
  jnz(n) { return this.raw(0x0f, 0x85).ref(n); }
  jz(n) { return this.raw(0x0f, 0x84).ref(n); }
  at(n) { return CODE + this.labels.get(n); }
  build() {
    for (const [o, n, abs] of this.fix) {
      const t = this.labels.get(n); if (t === undefined) throw new Error('label ' + n);
      this.b.splice(o, 4, ...le(abs ? CODE + t : t - (o + 4)));
    }
    return Uint8Array.from(this.b);
  }
}

function makeExec(useJit, opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, ...opts }) : null;
  return {
    mem, cpu, jit,
    load(code) {
      cpu.reset();
      mem.fill(DATA, 0x1000, 0);
      mem.fill(CODE, 0x4000, 0xcc);
      mem.writeBytes(CODE, code);
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eax = 0x12345678; cpu.ebx = 0x9e3779b9; cpu.edx = 5;
      cpu.eflags = F.RESERVED1 | F.IF;
    },
    run(stopAt, maxInsns) {
      if (!jit) return I.run({ stopAt, maxInsns });
      jit.cpu = cpu;
      let r;
      // (as the VM does: an SMC exit invalidates the written range and resumes)
      while ((r = jit.run({ stopAt, maxInsns })) === EXIT.SMC) {
        const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0);
        jit.invalidate(cpu.exitArg, len);
      }
      return r;
    },
  };
}
function snapshot(E) {
  const s = { eip: hex(E.cpu.eip), eflags: hex(E.cpu.eflags & ARITH), regs: [], mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex'), stack: Buffer.from(E.mem.bytes(DATA + 0x700, 0x100)).toString('hex'), code: Buffer.from(E.mem.bytes(CODE, 0x400)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(E.cpu.reg(k)));
  if (E.cpu.fpuTop !== undefined) s.st0 = String(E.cpu.st?.(0));
  return s;
}

/** Interpreter vs JIT (records on and off; whole and sliced): all agree. Returns the profiling counters with records. */
function check(code, end, { boundaries = [], slices = [3, 7, 23] } = {}) {
  const EI = makeExec(false);
  EI.load(code);
  assert.equal(EI.run(end, 1e8), EXIT.HALT);
  const want = snapshot(EI);
  let prof = null;
  for (const ras of [true, false]) {
    const EJ = makeExec(true, { profile: true, ras });
    EJ.jit.boundaries = new Set(boundaries);
    EJ.load(code);
    assert.equal(EJ.run(end, 1e8), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), want, `whole run, ras ${ras}`);
    if (ras) prof = { ...EJ.jit.stats.prof };
    for (const slice of slices) {
      const ES = makeExec(true, { ras });
      ES.jit.boundaries = new Set(boundaries);
      ES.load(code);
      let r, k = 0;
      while ((r = ES.run(end, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
      assert.equal(r, EXIT.HALT);
      assert.deepEqual(snapshot(ES), want, `slices of ${slice}, ras ${ras}`);
    }
  }
  return prof;
}

test('a call to another region returns through its record; returns elsewhere take the hash lookup', () => {
  // main: mov ecx, 50 ; L: call F ; A: add ebx, eax ; call G ; dec ecx ; jnz L ; hlt
  // F (a region of its own): add eax, ecx ; ret      G (one too): test cl, 3 ; jnz r ; add dword [esp], 3 (returns past
  // the `dec ecx`... to `jnz L`'s... no: to the next instruction boundary 3 bytes on: see below) ; r: ret
  const a = new Asm();
  a.raw(0xb9, ...le(50)).label('L').call('F').label('A').raw(0x01, 0xc3).call('G').label('B').raw(0x90, 0x90, 0x90, 0x49).jnz('L').label('end').raw(0xf4);
  a.label('F').raw(0x01, 0xc8, 0xc3);
  a.label('G').raw(0xf6, 0xc1, 3).jnz('r').raw(0x83, 0x04, 0x24, 3).label('r').raw(0xc3); // (skips B's three nops)
  const code = a.build();
  const prof = check(code, a.at('end'), { boundaries: [a.at('F'), a.at('G')] });
  assert.ok(prof.chainRas >= 50 + 30, `returns through the record: ${prof.chainRas}`);
});

test('nested calls across regions, recursion and tail calls: JIT = interpreter', () => {
  // main: mov ecx, 30 ; L: mov edx, 6 ; call R ; call T ; dec ecx ; jnz L ; hlt
  // R (boundary): dec edx ; jz base ; call R ; add eax, edx ; ret ; base: call F ; ret     F (boundary): xor eax, ecx ; ret
  // T (boundary): add esi, 1 ; jmp F (a tail call: F returns to T's caller)
  const a = new Asm();
  a.raw(0xb9, ...le(30)).label('L').raw(0xba, ...le(6)).call('R').call('T').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('R').raw(0x4a).jz('base').call('R').raw(0x01, 0xd0, 0xc3).label('base').call('F').raw(0xc3);
  a.label('F').raw(0x31, 0xc8, 0xc3);
  a.label('T').raw(0x83, 0xc6, 1).jmp('F');
  const code = a.build();
  const prof = check(code, a.at('end'), { boundaries: [a.at('R'), a.at('F'), a.at('T')] });
  assert.ok(prof.chainRas > 0, `returns through the record: ${prof.chainRas}`);
});

test('a callee that rewrites its caller\'s code drops the caller\'s region: the record is not used', () => {
  // main: mov ecx, 20 ; L: call W ; add ebx, eax ; P: mov eax, imm32 ; dec ecx ; jnz L ; hlt
  // W (boundary): mov [P+1], ecx (the caller's immediate: SMC in the caller's page, its region dropped) ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(20)).label('L').call('W').raw(0x01, 0xc3).label('P').raw(0xb8, ...le(7)).raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('W').raw(0x89, 0x0d).ref('P1', true).raw(0xc3);
  a.labels.set('P1', a.labels.get('P') + 1);
  const code = a.build();
  // (the reference interpreter alone keeps its decodes of the rewritten instruction: the JIT, which invalidates on the
  // SMC exits as the VM does, is compared with itself without records and with the values the program computes)
  const runs = [];
  for (const ras of [true, false]) for (const slice of [1e8, 3, 7]) {
    const E = makeExec(true, { ras, profile: slice > 1e7 });
    E.jit.boundaries = new Set([a.at('W')]);
    E.load(code);
    let r, k = 0;
    while ((r = E.run(a.at('end'), slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
    assert.equal(r, EXIT.HALT);
    runs.push(snapshot(E));
    // ebx: 0x9e3779b9 + the immediates the callee wrote (eax before the first: 0x12345678; then 20, 19, ..., 2)
    let ebx = 0x9e3779b9, eax = 0x12345678;
    for (let ecx = 20; ecx >= 1; ecx--) { ebx = (ebx + eax) >>> 0; eax = ecx; }
    assert.equal(E.cpu.eax >>> 0, 1, `eax, ras ${ras}, slices of ${slice}`);
    assert.equal(E.cpu.ebx >>> 0, ebx, `ebx, ras ${ras}, slices of ${slice}`);
  }
  for (const s of runs) assert.deepEqual(s, runs[0]);
});

test('x87 regions keep the hash lookup; integer callers around them use their records', () => {
  // main: mov ecx, 25 ; fld1 ; L: call X ; call F ; dec ecx ; jnz L ; fstp qword [DATA] ; hlt
  // X (boundary, x87): fld st0 ; faddp st1 ; ret        F (boundary): add eax, ecx ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(25), 0xd9, 0xe8).label('L').call('X').call('F').raw(0x49).jnz('L').raw(0xdd, 0x1d, ...le(DATA + 32)).label('end').raw(0xf4);
  a.label('X').raw(0xd9, 0xc0, 0xde, 0xc1, 0xc3);
  a.label('F').raw(0x01, 0xc8, 0xc3);
  const code = a.build();
  check(code, a.at('end'), { boundaries: [a.at('X'), a.at('F')] });
});

test('two threads alternating on one JIT: each thread returns through its own record', () => {
  // the same program in two threads (own stacks and data), switched every few instructions
  const a = new Asm();
  a.raw(0xb9, ...le(40)).label('L').call('F').raw(0x01, 0xc3).call('G').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('F').raw(0x01, 0xc8, 0x8b, 0x14, 0x24, 0xc3); // add eax, ecx ; mov edx, [esp] ; ret
  a.label('G').raw(0x31, 0xd3, 0xc3); // xor ebx, edx ; ret
  const code = a.build();
  const end = a.at('end');
  const EI = makeExec(false);
  EI.load(code);
  assert.equal(EI.run(end, 1e8), EXIT.HALT);
  const want = [hex(EI.cpu.eax), hex(EI.cpu.ebx), hex(EI.cpu.edx)];
  for (const slice of [2, 5, 9]) {
    const mem = new GuestMemory();
    mem.fill(CODE, 0x4000, 0xcc);
    mem.writeBytes(CODE, code);
    const cpus = [0, 1].map((k) => {
      const cpu = new CpuState(mem, THREAD_STATES_BASE + k * ST.SIZE); cpu.reset();
      cpu.eip = CODE; cpu.esp = DATA + 0x800 + k * 0x1000; cpu.eax = 0x12345678; cpu.ebx = 0x9e3779b9; cpu.edx = 5; cpu.eflags = F.RESERVED1 | F.IF;
      return cpu;
    });
    const jit = new Jit(mem, new Interp(mem, cpus[0]), { smc: true });
    jit.boundaries = new Set([a.at('F'), a.at('G')]);
    const done = [false, false];
    for (let n = 0; !(done[0] && done[1]); n++) {
      assert.ok(n < 1e6, 'runaway');
      for (let k = 0; k < 2; k++) {
        if (done[k]) continue;
        jit.cpu = cpus[k];
        const r = jit.run({ stopAt: end, maxInsns: slice });
        if (r === EXIT.HALT) done[k] = true; else assert.equal(r, EXIT.TIMESLICE);
      }
    }
    for (const cpu of cpus) assert.deepEqual([hex(cpu.eax), hex(cpu.ebx), hex(cpu.edx)], want, `slices of ${slice}`);
  }
});

test('random call graphs whose callees are regions of their own: JIT = interpreter', () => {
  let seed = 0x3c6ef372;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  let used = 0;
  for (let round = 0; round < 20; round++) {
    const a = new Asm();
    const nf = 3 + rnd(8);
    let lbl = 0;
    const body = (f) => {
      for (let k = 0, ops = 1 + rnd(6); k < ops; k++) {
        const r = rnd(12);
        if (r < 4 && f + 1 < nf) { a.call('F' + (f + 1 + rnd(nf - f - 1))).raw(0x46); if (rnd(2)) a.raw(0x11, 0xc3); }
        else if (r < 6) a.raw(0x01, [0xd8, 0xd9, 0xda, 0xde][rnd(4)]);
        else if (r < 7) a.raw(0xc1, 0xc0, 1 + rnd(31));
        else if (r < 9) { const l = 'j' + lbl++; a.raw(0xa8, 1 + rnd(255)).jz(l).raw(0x83, 0xc3, rnd(127)).label(l); }
        else if (r < 10) a.raw(0xff, 0x05, ...le(DATA + 4 * rnd(16)));
        else a.raw(0x3d, ...le(rnd(1 << 30)));
      }
    };
    a.raw(0xbf, ...le(20)).label('L');
    for (let k = 0, n = 2 + rnd(10); k < n; k++) a.call('F' + rnd(nf)).raw(0x46, 0x11, 0xc3);
    a.raw(0x4f).jnz('L').label('end').raw(0xf4);
    for (let f = 0; f < nf; f++) {
      a.label('F' + f);
      body(f);
      const e = rnd(6);
      if (e === 0 && f + 1 < nf) { a.jmp('F' + (f + 1 + rnd(nf - f - 1))); continue; } // tail call
      if (e === 1) { const l = 'j' + lbl++; a.raw(0xf6, 0xc3, 1).jz(l).raw(0x83, 0x04, 0x24, 1).label(l); } // return past the `inc esi`
      a.raw(0xc3);
    }
    const code = a.build();
    const bounds = [];
    for (let f = 0; f < nf; f++) if (rnd(3)) bounds.push(a.at('F' + f));
    used += check(code, a.at('end'), { boundaries: bounds, slices: [5, 17] }).chainRas ?? 0;
  }
  assert.ok(used > 1000, `returns through the record: ${used}`);
});

// Indirect calls and jumps through a slot at an absolute address (translate.js slotPredOf): the slot's value when the
// region is translated is the predicted target, translated as a direct transfer guarded by a compare (the callee joins
// the region, its return stays local); any other value at run time leaves the region as before. Hand-built programs
// (import-stub JMPs, CALLs through a slot, slots the program rewrites — to another function, to a thunk —, a slot
// pointing at code that is never reached through it, random call graphs whose slots change while they run) run under
// the JIT, whole and in small time slices, with and without the prediction, and must match the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE, SITE_PRED_BASE, SITE_PRED_BITS } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, SLOTS = 0x10003000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

/** Minimal assembler: raw bytes, labels, rel32 / abs32 fixups. */
class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; }
  raw(...x) { this.b.push(...x); return this; }
  label(n) { this.labels.set(n, this.b.length); return this; }
  ref(n, abs) { this.fix.push([this.b.length, n, abs]); this.b.push(0, 0, 0, 0); return this; }
  call(n) { return this.raw(0xe8).ref(n); }
  jmp(n) { return this.raw(0xe9).ref(n); }
  jnz(n) { return this.raw(0x0f, 0x85).ref(n); }
  jz(n) { return this.raw(0x0f, 0x84).ref(n); }
  /** call dword ptr [SLOTS + 4k] */
  callSlot(k) { return this.raw(0xff, 0x15, ...le(SLOTS + 4 * k)); }
  /** jmp dword ptr [SLOTS + 4k] */
  jmpSlot(k) { return this.raw(0xff, 0x25, ...le(SLOTS + 4 * k)); }
  /** mov dword ptr [SLOTS + 4k], label */
  setSlot(k, n) { return this.raw(0xc7, 0x05, ...le(SLOTS + 4 * k)).ref(n, true); }
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
    load(code, slots) {
      cpu.reset();
      mem.fill(DATA, 0x4000, 0);
      mem.fill(CODE, 0x8000, 0xcc);
      mem.writeBytes(CODE, code);
      slots.forEach((v, k) => mem.write32(SLOTS + 4 * k, v));
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eax = 0x12345678; cpu.ebx = 0x9e3779b9; cpu.edx = 5;
      cpu.eflags = F.RESERVED1 | F.IF;
    },
    run(stopAt, maxInsns) {
      if (!jit) return I.run({ stopAt, maxInsns });
      jit.cpu = cpu;
      return jit.run({ stopAt, maxInsns });
    },
  };
}
function snapshot(E) {
  const s = { eip: hex(E.cpu.eip), eflags: hex(E.cpu.eflags & ARITH), regs: [], mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex'), stack: Buffer.from(E.mem.bytes(DATA + 0x700, 0x100)).toString('hex'), slots: Buffer.from(E.mem.bytes(SLOTS, 32)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(E.cpu.reg(k)));
  return s;
}

/**
 * Run `code` (slots initialized to `slots`) to `end` under the interpreter, then under the JIT whole and in time slices,
 * with the prediction on and off: all must agree. Returns the transition counters of the whole run with the prediction.
 */
function check(code, slots, end, { boundaries = null, slices = [3, 7, 23] } = {}) {
  const EI = makeExec(false);
  EI.load(code, slots);
  assert.equal(EI.run(end, 1e8), EXIT.HALT);
  const want = snapshot(EI);
  let prof = null;
  for (const slotPred of [true, false]) {
    const EJ = makeExec(true, { profile: true, slotPred });
    EJ.jit.boundaries = boundaries;
    EJ.load(code, slots);
    assert.equal(EJ.run(end, 1e8), EXIT.HALT);
    assert.deepEqual(snapshot(EJ), want, `whole run, slotPred ${slotPred}`);
    if (slotPred) prof = { ...EJ.jit.stats.prof };
    for (const slice of slices) {
      const ES = makeExec(true, { slotPred });
      ES.jit.boundaries = boundaries;
      ES.load(code, slots);
      let r, k = 0;
      while ((r = ES.run(end, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
      assert.equal(r, EXIT.HALT);
      assert.deepEqual(snapshot(ES), want, `slices of ${slice}, slotPred ${slotPred}`);
    }
  }
  return prof;
}

test('calls through a slot and import-stub jumps run their callee in the caller\'s region; returns stay local', () => {
  // main: mov ecx, 40 ; L: call [S0] ; add ebx, eax ; call STUB ; adc esi, eax ; dec ecx ; jnz L ; hlt
  // STUB: jmp [S1]       F: add eax, ecx ; ret       G: xor eax, ebx ; rol eax, 5 ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(40)).label('L').callSlot(0).raw(0x01, 0xc3).call('STUB').raw(0x11, 0xc6, 0x49).jnz('L').label('end').raw(0xf4);
  a.label('STUB').jmpSlot(1);
  a.label('F').raw(0x01, 0xc8, 0xc3);
  a.label('G').raw(0x31, 0xd8, 0xc1, 0xc0, 5, 0xc3);
  const code = a.build();
  const prof = check(code, [a.at('F'), a.at('G')], a.at('end'));
  assert.ok(prof.retLocal >= 40 * 2 - 2, `local returns: ${prof.retLocal}`);
  assert.ok((prof.indirect ?? 0) <= 2, `indirect exits: ${prof.indirect}`);
});

test('a slot rewritten while the program runs (another function, back): mispredicted transfers leave the region', () => {
  // main: mov ecx, 30 ; L: call [S0] ; call STUB ; test cl, 3 ; jnz keep ; mov [S0], H ; mov [S1], F ; jmp next ;
  //       keep: test cl, 5 ; jnz next ; mov [S0], F ; mov [S1], G ; next: dec ecx ; jnz L ; hlt
  const a = new Asm();
  a.raw(0xb9, ...le(30)).label('L').callSlot(0).call('STUB').raw(0xf6, 0xc1, 3).jnz('keep').setSlot(0, 'H').setSlot(1, 'F').jmp('next')
    .label('keep').raw(0xf6, 0xc1, 5).jnz('next').setSlot(0, 'F').setSlot(1, 'G').label('next').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('STUB').jmpSlot(1);
  a.label('F').raw(0x01, 0xc8, 0xc3);
  a.label('G').raw(0x31, 0xd8, 0xc1, 0xc0, 5, 0xc3);
  a.label('H').raw(0x29, 0xc2, 0x83, 0xc6, 3, 0xc3);
  const code = a.build();
  check(code, [a.at('F'), a.at('G')], a.at('end'));
});

test('a slot pointing at code never reached through it, at a thunk, or at nothing: the same as the interpreter', () => {
  // S0 holds JUNK (bytes that are not code: 0xcc) but is rewritten to F before the first call through it; S1 holds a
  // thunk address and is rewritten to G before the jump; S2 holds 0 and the call through it is never taken
  // main: mov [S0], F ; mov [S1], G ; mov ecx, 20 ; L: call [S0] ; call STUB ; test ecx, ecx ; jnz skip ; call [S2] ;
  //       skip: dec ecx ; jnz L ; hlt   (one region from the entry: translated with S0 = JUNK, S1 = a thunk)
  const a = new Asm();
  a.setSlot(0, 'F').setSlot(1, 'G').raw(0xb9, ...le(20)).label('L').callSlot(0).call('STUB').raw(0x85, 0xc9).jnz('skip').callSlot(2).label('skip')
    .raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('STUB').jmpSlot(1);
  a.label('F').raw(0x01, 0xc8, 0xc3);
  a.label('G').raw(0x31, 0xd8, 0xc1, 0xc0, 5, 0xc3);
  a.label('JUNK').raw(0xcc, 0xcc, 0xcc, 0xcc);
  const code = a.build();
  // (the entry region is translated with the slots' first values: JUNK, a thunk, 0)
  check(code, [a.at('JUNK'), THUNK_BASE + 16 * 7, 0], a.at('end'));
});

test('random call graphs through slots the program rewrites (calls, stub jumps, tail jumps): JIT = interpreter', () => {
  let seed = 0x6c8e9cf5;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  let local = 0;
  for (let round = 0; round < 24; round++) {
    const a = new Asm();
    const nf = 3 + rnd(7), ns = 1 + rnd(4);
    let lbl = 0;
    // slot k targets functions with index >= minOf[k] only, so that every call graph is acyclic: slot k is called from
    // functions below minOf[k]
    const minOf = Array.from({ length: ns }, () => 1 + rnd(Math.max(1, nf - 1)));
    const body = (f) => {
      for (let k = 0, ops = 1 + rnd(6); k < ops; k++) {
        const r = rnd(14);
        const sl = rnd(ns);
        if (r < 3 && f < minOf[sl]) { a.callSlot(sl).raw(0x46); if (rnd(2)) a.raw(0x11, 0xc3); } // call [slot] ; inc esi ; (adc ebx, eax)
        else if (r < 5 && f + 1 < nf) a.call('F' + (f + 1 + rnd(nf - f - 1))).raw(0x46);
        else if (r < 6) { const t = minOf[sl] + rnd(nf - minOf[sl]); a.setSlot(sl, 'F' + t); } // retarget a slot
        else if (r < 8) a.raw(0x01, [0xd8, 0xd9, 0xda, 0xde][rnd(4)]);
        else if (r < 9) a.raw(0xc1, 0xc0, 1 + rnd(31));
        else if (r < 10) { const l = 'j' + lbl++; a.raw(0xa8, 1 + rnd(255)).jz(l).raw(0x83, 0xc3, rnd(127)).label(l); }
        else if (r < 11) a.raw(0xff, 0x05, ...le(DATA + 4 * rnd(16)));
        else if (r < 12 && f < minOf[sl]) { a.call('STUB' + sl).raw(0x46); } // a call through an import stub
        else a.raw(0x3d, ...le(rnd(1 << 30)));
      }
    };
    a.raw(0xbf, ...le(20)).label('L');
    for (let k = 0, n = 2 + rnd(12); k < n; k++) {
      const sl = rnd(ns);
      if (rnd(3) === 0) a.callSlot(sl); else a.call('F' + rnd(nf));
      a.raw(0x46, 0x11, 0xc3);
    }
    a.raw(0x4f).jnz('L').label('end').raw(0xf4);
    for (let k = 0; k < ns; k++) a.label('STUB' + k).jmpSlot(k);
    for (let f = 0; f < nf; f++) {
      a.label('F' + f);
      body(f);
      const sl = rnd(ns);
      if (rnd(5) === 0 && f < minOf[sl]) { a.jmpSlot(sl); continue; } // a tail jump through a slot
      a.raw(0xc3);
    }
    const code = a.build();
    const slots = minOf.map((m) => a.at('F' + (m + rnd(nf - m))));
    local += check(code, slots, a.at('end'), { slices: [5, 17] }).retLocal ?? 0;
    check(code, slots, a.at('end'), { slices: [], boundaries: new Set([a.at('F' + rnd(nf)), a.at('STUB0')]) });
  }
  assert.ok(local > 200, `local returns: ${local}`);
});

test('indirect calls and jumps through registers predicted from the site table (right, wrong, stale): JIT = interpreter', () => {
  // Random acyclic call graphs whose calls go through registers (mov edx, F ; call edx), through variables the program
  // rewrites (mov edx, [V] ; call edx) and whose tails jump through one (jmp edx). The site table is seeded before the
  // run (every site predicted: its right callee, another function, the middle of a function) and updated by the run
  // itself (the regions translated later predict from it); the JIT must match the interpreter whole and in slices.
  let seed = 0x1b873593;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const V = DATA + 0x100;
  let predicted = 0;
  for (let round = 0; round < 24; round++) {
    const a = new Asm();
    const nf = 3 + rnd(7);
    const sites = []; // [label of the call / jmp, lowest callee index]
    let lbl = 0;
    const site = (lo) => { const l = 's' + lbl++; a.label(l); sites.push([l, lo]); };
    const callee = (f) => 'F' + (f + 1 + rnd(nf - f - 1));
    const body = (f) => {
      for (let k = 0, ops = 1 + rnd(6); k < ops; k++) {
        const r = rnd(12);
        if (r < 3 && f + 1 < nf) { a.raw(0xba).ref(callee(f), true); site(f + 1); a.raw(0xff, 0xd2, 0x46); } // mov edx, F ; call edx ; inc esi
        else if (r < 5 && f + 1 < nf) { a.raw(0x8b, 0x15, ...le(V + 4 * f)); site(f + 1); a.raw(0xff, 0xd2, 0x46); } // mov edx, [V+4f] ; call edx
        else if (r < 6 && f + 1 < nf) a.raw(0xc7, 0x05, ...le(V + 4 * f)).ref(callee(f), true); // retarget V+4f
        else if (r < 8) a.raw(0x01, [0xd8, 0xd9, 0xde][rnd(3)]);
        else if (r < 9) a.raw(0xc1, 0xc0, 1 + rnd(31));
        else if (r < 10) { const l = 'j' + lbl++; a.raw(0xa8, 1 + rnd(255)).jz(l).raw(0x83, 0xc3, rnd(127)).label(l); }
        else a.raw(0xff, 0x05, ...le(DATA + 4 * rnd(16)));
      }
    };
    // main: V initialized ; mov edi, 20 ; L: calls through edx ; dec edi ; jnz L ; hlt
    for (let f = 0; f + 1 < nf; f++) a.raw(0xc7, 0x05, ...le(V + 4 * f)).ref(callee(f), true);
    a.raw(0xbf, ...le(20)).label('L');
    for (let k = 0, n = 2 + rnd(10); k < n; k++) { a.raw(0xba).ref('F' + rnd(nf), true); site(0); a.raw(0xff, 0xd2, 0x46); }
    a.raw(0x4f).jnz('L').label('end').raw(0xf4);
    for (let f = 0; f < nf; f++) {
      a.label('F' + f);
      body(f);
      if (rnd(5) === 0 && f + 1 < nf) { a.raw(0xba).ref(callee(f), true); site(f + 1); a.raw(0xff, 0xe2); continue; } // jmp edx (a tail jump)
      a.raw(0xc3);
    }
    const code = a.build();
    // the seeded predictions: per site its right callee (one of them), another function, or the middle of a function
    const table = sites.map(([l, lo]) => {
      const k = rnd(3), f = lo + rnd(nf - lo);
      return [a.at(l), k === 0 ? a.at('F' + f) : k === 1 ? a.at('F' + rnd(nf)) : a.at('F' + f) + 1 + rnd(3)];
    });
    const EI = makeExec(false);
    EI.load(code, []);
    assert.equal(EI.run(a.at('end'), 1e8), EXIT.HALT);
    const want = snapshot(EI);
    for (const sitePred of [true, false]) {
      for (const slice of [1e8, 5, 17]) {
        const ES = makeExec(true, { sitePred, profile: slice > 1e7 });
        ES.load(code, []);
        for (const [at, t] of table) {
          const e = SITE_PRED_BASE + 12 * (Math.imul(at, 0x9e3779b1) >>> (32 - SITE_PRED_BITS));
          ES.mem.write32(e, at); ES.mem.write32(e + 4, t); ES.mem.write32(e + 8, 100);
        }
        let r, k = 0;
        while ((r = ES.run(a.at('end'), slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
        assert.equal(r, EXIT.HALT);
        assert.deepEqual(snapshot(ES), want, `round ${round}, slices of ${slice}, sitePred ${sitePred}`);
        if (sitePred && slice > 1e7) predicted += ES.jit.stats.prof.retLocal ?? 0;
      }
    }
  }
  assert.ok(predicted > 100, `local returns of predicted calls: ${predicted}`);
});

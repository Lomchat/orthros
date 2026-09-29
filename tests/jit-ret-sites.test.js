// Returns that stay inside a region (translate.js regionRetSites): a RET compares the address it pops with the return
// sites of the in-region calls of the function(s) it belongs to, and jumps there locally; any other return leaves the
// region as before. Hand-built programs (more call sites than the old region-wide limit, nested and recursive calls, a
// tail call, RET imm16, return addresses the callee changes, a helper entered from another region, import stubs of
// inline fast APIs) run under the JIT, whole and in small time slices, and must match the reference interpreter; the
// transition counters of profiling translations show the returns staying local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000, TEB = 0x10002000, SLOT = 0x10003000;
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
      return jit.run({ stopAt, maxInsns });
    },
  };
}
function snapshot(E) {
  const s = { eip: hex(E.cpu.eip), eflags: hex(E.cpu.eflags & ARITH), regs: [], mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex'), stack: Buffer.from(E.mem.bytes(DATA + 0x700, 0x100)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(E.cpu.reg(k)));
  return s;
}

/** Run `code` to `end` under the interpreter, then under the JIT whole and in time slices: all must agree. */
function check(code, end, { boundaries = null, jitOpts = {}, slices = [3, 7, 23] } = {}) {
  const EI = makeExec(false);
  EI.load(code);
  assert.equal(EI.run(end, 1e8), EXIT.HALT);
  const want = snapshot(EI);
  const EJ = makeExec(true, { profile: true, ...jitOpts });
  EJ.jit.boundaries = boundaries;
  EJ.load(code);
  assert.equal(EJ.run(end, 1e8), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), want, 'whole run');
  const prof = { ...EJ.jit.stats.prof };
  for (const slice of slices) {
    const ES = makeExec(true, jitOpts);
    ES.jit.boundaries = boundaries;
    ES.load(code);
    let r, k = 0;
    while ((r = ES.run(end, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
    assert.equal(r, EXIT.HALT);
    assert.deepEqual(snapshot(ES), want, `slices of ${slice}`);
  }
  return prof;
}

test('a region with more call sites than one RET compares: the returns of its inlined helpers stay local', () => {
  // main: mov ecx, 40 ; L: 20 x (call G ; inc dword [DATA + 4k]) ; call H ; push 5 ; call G4 ; call T ; call N ;
  //       dec ecx ; jnz L ; hlt
  // G: add eax, ebx ; rol eax, 3 ; ret     H: xor ebx, eax ; ret     G4: add ebx, [esp+4] ; ret 4
  // T: add eax, 7 ; jmp G (a tail call: G returns to T's caller)     N: call G ; add eax, 3 ; ret (nested)
  const a = new Asm();
  a.raw(0xb9, ...le(40)).label('L');
  for (let k = 0; k < 20; k++) a.call('G').raw(0xff, 0x05, ...le(DATA + 4 * (k % 16)));
  a.call('H').raw(0x6a, 5).call('G4').call('T').call('N').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('G').raw(0x01, 0xd8, 0xc1, 0xc0, 3, 0xc3);
  a.label('H').raw(0x31, 0xc3, 0xc3);
  a.label('G4').raw(0x03, 0x5c, 0x24, 0x04, 0xc2, 4, 0);
  a.label('T').raw(0x83, 0xc0, 7).jmp('G');
  a.label('N').call('G').raw(0x83, 0xc0, 3, 0xc3);
  const code = a.build();
  const prof = check(code, a.at('end'));
  // 40 iterations of 25 returns: G's 16 first call sites (in address order) are compared, its other ones (the last 4 of
  // main, T's and N's) leave the region; before, more than 16 call sites in the region dropped them all
  assert.ok(prof.retLocal >= 40 * 19, `local returns: ${prof.retLocal}`);
  assert.ok(prof.ret <= 40 * 7 + 5, `returns leaving the region: ${prof.ret}`);
});

test('RET to an address the callee changed, to a site of another function, to a non-site: same as the interpreter', () => {
  // main: mov ecx, 30 ; L: call G ; A: call H ; B: inc dword [DATA] ; call G2 ; C: inc dword [DATA+4] ; dec ecx ; jnz L ; hlt
  // G: add eax, ecx ; ret                              H: sub ebx, eax ; ret
  // G2: inc dword [DATA+12] ; test byte [DATA+12], 1 ; jz keep ; test cl, 3 ; jnz keep ;
  //     mov dword [esp], A (a return to G's site: not one of G2's) ; test cl, 4 ; jz keep ; mov dword [esp], X (not a
  //     call site) ; keep: ret                         X: inc dword [DATA+8] ; jmp C
  const a = new Asm();
  a.raw(0xb9, ...le(30)).label('L').call('G').label('A').call('H').label('B').raw(0xff, 0x05, ...le(DATA)).call('G2').label('C')
    .raw(0xff, 0x05, ...le(DATA + 4), 0x49).jnz('L').label('end').raw(0xf4);
  a.label('G').raw(0x01, 0xc8, 0xc3);
  a.label('H').raw(0x29, 0xc3, 0xc3);
  a.label('G2').raw(0xff, 0x05, ...le(DATA + 12), 0xf6, 0x05, ...le(DATA + 12), 1).jz('keep').raw(0xf6, 0xc1, 3).jnz('keep')
    .raw(0xc7, 0x04, 0x24).ref('A', true).raw(0xf6, 0xc1, 4).jz('keep').raw(0xc7, 0x04, 0x24).ref('X', true).label('keep').raw(0xc3);
  a.label('X').raw(0xff, 0x05, ...le(DATA + 8)).jmp('C');
  const code = a.build();
  check(code, a.at('end'));
});

test('a helper entered from another region returns there (its in-region sites do not match)', () => {
  // Q (entry): mov ecx, 25 ; L: mov eax, M ; call eax ; mov eax, G ; call eax ; dec ecx ; jnz L ; hlt
  // (indirect calls: M and G are not part of Q's region; G's first entry is M's region, which holds G)
  // M: 3 x call G ; ret         G: add edx, 9 ; xor edx, ecx ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(25)).label('L').raw(0xb8).ref('M', true).raw(0xff, 0xd0, 0xb8).ref('G', true).raw(0xff, 0xd0, 0x49).jnz('L').label('end').raw(0xf4);
  a.label('M').call('G').call('G').call('G').raw(0xc3);
  a.label('G').raw(0x83, 0xc2, 9, 0x31, 0xca, 0xc3);
  const code = a.build();
  const prof = check(code, a.at('end'));
  assert.ok(prof.retLocal >= 25 * 3 - 3, `M's calls of G return locally: ${prof.retLocal}`);
});

test('recursion inside a region: every level returns locally to the recursive call site or to the first caller', () => {
  // main: mov ecx, 20 ; L: mov edx, 12 ; call R ; add ebx, eax ; dec ecx ; jnz L ; hlt
  // R: dec edx ; jz base ; push edx ; call R ; pop edx ; add eax, edx ; ret ; base: mov eax, ecx ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(20)).label('L').raw(0xba, ...le(12)).call('R').raw(0x01, 0xc3, 0x49).jnz('L').label('end').raw(0xf4);
  a.label('R').raw(0x4a).jz('base').raw(0x52).call('R').raw(0x5a, 0x01, 0xd0, 0xc3).label('base').raw(0x89, 0xc8, 0xc3);
  const code = a.build();
  const prof = check(code, a.at('end'));
  assert.ok(prof.retLocal >= 20 * 12 - 2, `local returns: ${prof.retLocal}`);
});

test('recursion whose function entry is another region: the levels return locally to the recursive call site', () => {
  // main: mov ecx, 20 ; L: mov ebx, 30 ; call R ; dec ecx ; jnz L ; hlt
  // R (a region boundary): dec ebx ; jz done ; call R ; done: add eax, 1 ; ret   (the region after R's first block
  // holds the recursive call and the RET: R itself is outside it)
  const a = new Asm();
  a.raw(0xb9, ...le(20)).label('L').raw(0xbb, ...le(30)).call('R').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('R').raw(0x4b).jz('done').call('R').label('done').raw(0x83, 0xc0, 1, 0xc3);
  const code = a.build();
  const prof = check(code, a.at('end'), { boundaries: new Set([a.at('R')]) });
  assert.ok(prof.retLocal >= 20 * 28, `local returns: ${prof.retLocal}`);
});

test('the inline-API JMP of an import stub returns locally to the stub\'s callers only', () => {
  // main: mov ecx, 30 ; L: call S ; add ebx, eax ; call S ; add esi, eax ; call G ; dec ecx ; jnz L ; hlt
  // S: jmp [SLOT] (GetCurrentThreadId, run inline)       G: add eax, 1 ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(30)).label('L').call('S').raw(0x01, 0xc3).call('S').raw(0x01, 0xc6).call('G').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('S').raw(0xff, 0x25, ...le(SLOT));
  a.label('G').raw(0x83, 0xc0, 1, 0xc3);
  const code = a.build();
  const run = (slice) => {
    const E = makeExec(true, { profile: true });
    E.load(code);
    E.jit.markFast(13, 'kernel32.dll!GetCurrentThreadId', true);
    E.mem.write32(SLOT, THUNK_BASE + 13 * 16); E.mem.write32(TEB + 0x24, 0x345); E.cpu.fsBase = TEB;
    let r, k = 0;
    while ((r = E.run(a.at('end'), slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
    assert.equal(r, EXIT.HALT);
    return { regs: [E.cpu.eax, E.cpu.ebx, E.cpu.esi, E.cpu.esp], prof: E.jit.stats.prof, inlined: E.jit.stats.inlineApi ?? 0 };
  };
  const whole = run(1e8);
  assert.deepEqual(whole.regs.slice(1), [(0x9e3779b9 + 30 * 0x345) >>> 0, 30 * 0x345, DATA + 0x800]);
  assert.equal(whole.regs[0], 0x346);
  assert.ok(whole.inlined >= 1);
  assert.ok(whole.prof.retLocal >= 30 * 3 - 3, `local returns: ${whole.prof.retLocal}`);
  for (const slice of [3, 5]) assert.deepEqual(run(slice).regs, whole.regs, `slices of ${slice}`);
});

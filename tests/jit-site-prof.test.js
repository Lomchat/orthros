// The exit-site measurement (translate.js siteProf, startbench --jit-sites, globalThis.ORTHROS_SITE_PROF): instrumented
// translations must stay exact (same results as the reference interpreter, whole and in time slices) and count every
// exit kind at its site — indirect calls through a register and through a fixed slot, indirect jumps, returns leaving
// their region, static exits (of a call; to a successor left out for the region's size).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { SITE_PROF } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000, SLOT = 0x10003000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; }
  raw(...x) { this.b.push(...x); return this; }
  label(n) { this.labels.set(n, this.b.length); return this; }
  ref(n, abs) { this.fix.push([this.b.length, n, abs]); this.b.push(0, 0, 0, 0); return this; }
  call(n) { return this.raw(0xe8).ref(n); }
  jmp(n) { return this.raw(0xe9).ref(n); }
  jnz(n) { return this.raw(0x0f, 0x85).ref(n); }
  at(n) { return CODE + this.labels.get(n); }
  build() {
    for (const [o, n, abs] of this.fix) this.b.splice(o, 4, ...le(abs ? CODE + this.labels.get(n) : this.labels.get(n) - (o + 4)));
    return Uint8Array.from(this.b);
  }
}

function exec(useJit, code, opts, boundaries) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true, ...opts }) : null;
  if (jit) { jit.cpu = cpu; jit.boundaries = boundaries; }
  cpu.reset(); mem.fill(DATA, 0x4000, 0); mem.fill(CODE, 0x4000, 0xcc); mem.writeBytes(CODE, code);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.eax = 0x12345678; cpu.ebx = 0x9e3779b9; cpu.edx = 5; cpu.eflags = F.RESERVED1 | F.IF;
  return { mem, cpu, run: (stopAt, n) => (jit ? jit.run({ stopAt, maxInsns: n }) : I.run({ stopAt, maxInsns: n })) };
}
const snap = (E) => ({ eip: E.cpu.eip, fl: E.cpu.eflags & ARITH, regs: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => E.cpu.reg(k) >>> 0), mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex') });

test('site measurement: instrumented translations match the interpreter and count every exit kind', () => {
  // main: mov ecx, 30 ; mov [SLOT], G ; L: mov eax, M ; call eax (icall) ; call [SLOT] (icallAbs) ; mov eax, J ;
  //       jmp eax (ijmp) ; K: call B (B a region boundary: static exit of a call) ; dec ecx ; jnz L ; hlt
  // M: add edx, ecx ; ret            G: xor ebx, edx ; inc dword [DATA] ; ret       J: rol ebx, 1 ; jmp K
  // B: add esi, 3 ; ret
  const a = new Asm();
  a.raw(0xb9, ...le(30), 0xc7, 0x05, ...le(SLOT)).ref('G', true).label('L').raw(0xb8).ref('M', true).raw(0xff, 0xd0)
    .raw(0xff, 0x15, ...le(SLOT)).raw(0xb8).ref('J', true).raw(0xff, 0xe0).label('K').call('B').raw(0x49).jnz('L').label('end').raw(0xf4);
  a.label('M').raw(0x01, 0xca, 0xc3);
  a.label('G').raw(0x31, 0xd3, 0xff, 0x05, ...le(DATA), 0xc3);
  a.label('J').raw(0xd1, 0xc3).jmp('K');
  a.label('B').raw(0x83, 0xc6, 3, 0xc3);
  const code = a.build(), end = a.at('end'), boundaries = new Set([a.at('B')]);
  const EI = exec(false, code); assert.equal(EI.run(end, 1e8), EXIT.HALT);
  const want = snap(EI);
  globalThis.ORTHROS_SITE_PROF = true;
  try {
    for (const maxBlocks of [48, 2]) for (const slice of [1e8, 3, 7]) {
      const EJ = exec(true, code, { maxBlocks }, boundaries);
      let r, k = 0;
      while ((r = EJ.run(end, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e7, 'runaway');
      assert.equal(r, EXIT.HALT);
      assert.deepEqual(snap(EJ), want, `maxBlocks ${maxBlocks}, slices of ${slice}`);
    }
    // a fresh VM: its own counter slots (allocated in its memory), counting this run only
    const EJ = exec(true, code, {}, boundaries);
    const n0 = SITE_PROF.length;
    const count = () => { const m = new Map(); for (const [addr, kind, s] of SITE_PROF.slice(n0)) m.set(kind + ':' + addr, EJ.mem.read32(s) >>> 0); return m; };
    assert.equal(EJ.run(end, 1e8), EXIT.HALT);
    assert.deepEqual(snap(EJ), want);
    const c1 = count(), delta = (k) => c1.get(k) ?? 0;
    const callR = a.at('L') + 5, callS = callR + 2;
    assert.equal(delta('icall:' + callR), 30, 'register call site');
    assert.equal(delta('icallAbs:' + callS), 30, 'slot call site');
    assert.equal(delta('ijmp:' + (callS + 6 + 5)), 30, 'indirect jump site');
    assert.equal(delta('exitCall:' + a.at('B')), 30, 'static exit of a call into another region');
    assert.equal(delta('ret:' + (a.at('B') + 3)), 30, 'return leaving its region');
    // target changes: the register call always goes to M (one change, from 0)
    const slotOf = (k) => SITE_PROF.slice(n0).find(([addr, kind]) => kind + ':' + addr === k)[2];
    assert.equal(EJ.mem.read32(slotOf('icall:' + callR) + 4) >>> 0, a.at('M'));
    // a region of 2 blocks: the successors left out are counted as exitLim
    const E2 = exec(true, code, { maxBlocks: 2 }, boundaries);
    assert.equal(E2.run(end, 1e8), EXIT.HALT);
    assert.ok(SITE_PROF.some(([, kind]) => kind.startsWith('exitLim')), 'exitLim sites');
  } finally { delete globalThis.ORTHROS_SITE_PROF; }
});

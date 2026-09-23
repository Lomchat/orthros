// Control flow inside a translated region (translate.js planUnits / jumpTo): forward branches are
// plain `br`s, innermost loops are WASM loops, everything else goes through the region's
// dispatcher. Random control-flow graphs (overlapping and nested loops, jumps into loop bodies,
// flags live across edges) run under the JIT, whole and in small time slices (which re-enter
// regions in the middle of their loops), and must match the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * n blocks; block k: adc ebx, imm (CF from the predecessor) ; dec esi ; jz exit ; add eax, imm ;
 * rol eax, r ; xor ebx, eax ; add ecx, ebx ; inc dword [DATA + 4 * (k & 15)] ; bt eax, bit ;
 * jc/jnc <random block> ; then a jmp to a random block, or a fallthrough.
 */
function program(seed, n) {
  const R = rng(seed), pick = (m) => Math.floor(R() * m);
  const bytes = [], fix = [], at = [];
  const imm32 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const rel = (target) => { fix.push([bytes.length, target]); imm32(0); };
  for (let k = 0; k < n; k++) {
    at[k] = CODE + bytes.length;
    bytes.push(0x81, 0xd3); imm32(pick(0x10000));
    bytes.push(0x4e, 0x0f, 0x84); rel('exit');
    bytes.push(0x05); imm32((R() * 0x100000000) | 0);
    bytes.push(0xc1, 0xc0, 1 + pick(31), 0x31, 0xc3, 0x01, 0xd9, 0xff, 0x05); imm32(DATA + 4 * (k & 15));
    bytes.push(0x0f, 0xba, 0xe0, pick(32));
    // bias toward nearby targets (tight loops) with some far ones
    const near = () => Math.max(0, Math.min(n - 1, k + pick(7) - 4));
    bytes.push(0x0f, 0x82 + pick(2)); rel(R() < 0.7 ? near() : pick(n));
    if (R() < 0.3 || k === n - 1) { bytes.push(0xe9); rel(R() < 0.6 ? near() : pick(n)); }
  }
  const exit = CODE + bytes.length;
  bytes.push(0xf4);
  for (const [o, t] of fix) {
    const v = (t === 'exit' ? exit : at[t]) - (CODE + o + 4);
    bytes[o] = v & 0xff; bytes[o + 1] = (v >> 8) & 0xff; bytes[o + 2] = (v >> 16) & 0xff; bytes[o + 3] = (v >>> 24) & 0xff;
  }
  return { code: Uint8Array.from(bytes), exit };
}

/**
 * Flags live across block boundaries: every block ends with a random flag-setting instruction (cmp/add/
 * test/and/inc/dec at 8, 16 and 32 bits, and kinds without an inline path: shl, neg, imul, bt) followed
 * by a jcc, and the successors start by consuming those flags (jcc on any condition, setcc, cmovcc,
 * adc/sbb, inc: CF preserved) before anything else writes them.
 */
function flagsProgram(seed, n) {
  const R = rng(seed), pick = (m) => Math.floor(R() * m);
  const bytes = [], fix = [], at = [];
  const imm32 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const rel = (target) => { fix.push([bytes.length, target]); imm32(0); };
  const near = (k) => Math.max(0, Math.min(n - 1, k + pick(7) - 4));
  const SETTERS = [
    () => bytes.push(0x3c, pick(256)), () => { bytes.push(0x66, 0x3d, pick(256), pick(256)); }, () => { bytes.push(0x3d); imm32((R() * 2 ** 32) | 0); }, // cmp al/ax/eax, imm
    () => bytes.push(0x00, 0xc3), () => bytes.push(0x66, 0x01, 0xc3), () => bytes.push(0x01, 0xc3), // add bl,al / bx,ax / ebx,eax
    () => bytes.push(0xa8, pick(256)), () => bytes.push(0x66, 0xa9, pick(256), pick(256)), () => bytes.push(0x21, 0xc3), // test al / test ax / and ebx,eax
    () => bytes.push(0xfe, 0xcb), () => bytes.push(0x66, 0x47), () => bytes.push(0x47), () => bytes.push(0x4f), // dec bl, inc di, inc edi, dec edi
    () => bytes.push(0xc1, 0xe3, 1 + pick(31)), () => bytes.push(0xf7, 0xdb), () => bytes.push(0x0f, 0xaf, 0xd8), () => bytes.push(0x0f, 0xba, 0xe0, pick(32)), // shl, neg, imul, bt
  ];
  for (let k = 0; k < n; k++) {
    at[k] = CODE + bytes.length;
    switch (pick(6)) { // consumer of the predecessor's flags
      case 0: bytes.push(0x0f, 0x80 + pick(16)); rel(k === n - 1 ? 'exit' : k + 1 + pick(Math.min(4, n - 1 - k))); break; // jcc (a block of its own; forward: no fuel-free cycle)
      case 1: bytes.push(0x0f, 0x90 + pick(16), 0xc2); break; // setcc dl
      case 2: bytes.push(0x0f, 0x40 + pick(16), 0xd9); break; // cmovcc ebx, ecx
      case 3: bytes.push(0x81, 0xd3); imm32(pick(0x10000)); break; // adc ebx, imm
      case 4: bytes.push(0x81, 0xd9); imm32(pick(0x10000)); break; // sbb ecx, imm
      default: bytes.push(0x42); // inc edx (keeps CF)
    }
    bytes.push(0x4e, 0x0f, 0x84); rel('exit');
    bytes.push(0x05); imm32((R() * 0x100000000) | 0);
    bytes.push(0xc1, 0xc0, 1 + pick(31), 0x31, 0xc3, 0x01, 0xd9, 0x31, 0xd7); // rol eax ; xor ebx,eax ; add ecx,ebx ; xor edi,edx
    SETTERS[pick(SETTERS.length)]();
    bytes.push(0x0f, 0x80 + pick(16)); rel(R() < 0.7 ? near(k) : pick(n));
    if (R() < 0.25 || k === n - 1) { bytes.push(0xe9); rel(near(k)); }
  }
  const exit = CODE + bytes.length;
  bytes.push(0xf4);
  for (const [o, t] of fix) {
    const v = (t === 'exit' ? exit : at[t]) - (CODE + o + 4);
    bytes[o] = v & 0xff; bytes[o + 1] = (v >> 8) & 0xff; bytes[o + 2] = (v >> 16) & 0xff; bytes[o + 3] = (v >>> 24) & 0xff;
  }
  return { code: Uint8Array.from(bytes), exit };
}

function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, jit,
    load(code, fuel) {
      cpu.reset();
      mem.fill(DATA, 0x1000, 0);
      mem.fill(CODE, 0x4000, 0xcc);
      mem.writeBytes(CODE, code);
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.esi = fuel; cpu.eax = 0x12345678;
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
  const s = { eip: hex(E.cpu.eip), eflags: hex(E.cpu.eflags & ARITH), regs: [], mem: Buffer.from(E.mem.bytes(DATA, 64)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(E.cpu.reg(k)));
  return s;
}

test('random control flow: whole runs and time-sliced runs match the interpreter', () => {
  let loops = 0, dispatches = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const n = 3 + (seed * 7) % 58; // up to 60 blocks: some regions exceed MAX_BLOCKS
    const { code, exit } = program(seed, n);
    const fuel = 3000;
    const EI = makeExec(false);
    EI.load(code, fuel);
    assert.equal(EI.run(exit, 1e7), EXIT.HALT, `seed ${seed}: interpreter`);
    const want = snapshot(EI);
    const EJ = makeExec(true);
    EJ.load(code, fuel);
    assert.equal(EJ.run(exit, 1e7), EXIT.HALT, `seed ${seed}: jit`);
    assert.deepEqual(snapshot(EJ), want, `seed ${seed}: whole run`);
    // translated code re-entered after every time slice, at whatever block the budget ran out
    for (const slice of [5, 17, 61]) {
      EJ.load(code, fuel);
      let r, k = 0;
      while ((r = EJ.run(exit, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e6, 'runaway');
      assert.equal(r, EXIT.HALT, `seed ${seed} slice ${slice}`);
      assert.deepEqual(snapshot(EJ), want, `seed ${seed}: slices of ${slice}`);
    }
    loops += EJ.jit.stats.regions; dispatches += EJ.jit.stats.fallbackSteps;
  }
  assert.equal(dispatches, 0, 'no interpreter fallback');
});

test('flags consumed at block entry (every lazy kind and size) match the interpreter', () => {
  for (let seed = 100; seed < 160; seed++) {
    const n = 4 + (seed * 5) % 40;
    const { code, exit } = flagsProgram(seed, n);
    const EI = makeExec(false);
    EI.load(code, 2000);
    assert.equal(EI.run(exit, 1e7), EXIT.HALT, `seed ${seed}: interpreter`);
    const want = snapshot(EI);
    const EJ = makeExec(true);
    EJ.load(code, 2000);
    assert.equal(EJ.run(exit, 1e7), EXIT.HALT, `seed ${seed}: jit`);
    assert.deepEqual(snapshot(EJ), want, `seed ${seed}: whole run`);
    EJ.load(code, 2000);
    let r, k = 0;
    while ((r = EJ.run(exit, 23)) === EXIT.TIMESLICE) assert.ok(++k < 1e6, 'runaway');
    assert.deepEqual(snapshot(EJ), want, `seed ${seed}: time slices`);
  }
});

test('returns to call sites of the same region stay in the region and match the interpreter', () => {
  // main: mov ecx, 300 ; L: call f ; add eax, ebx ; push 7 ; call g4 ; call g ; dec ecx ; jnz L ;
  //       push X ; ret (a return to a non-call site) ; X: hlt
  // f: add ebx, 3 ; call g ; ret        g: xor eax, ebx ; rol eax, 5 ; ret        g4: add ebx, [esp+4] ; ret 4
  const bytes = [], fix = [], at = {};
  const imm32 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const label = (n) => { at[n] = CODE + bytes.length; };
  const call = (n) => { bytes.push(0xe8); fix.push([bytes.length, n, 'rel']); imm32(0); };
  bytes.push(0xb9); imm32(300);
  label('L'); call('f'); bytes.push(0x01, 0xd8, 0x6a, 7); call('g4'); call('g'); bytes.push(0x49, 0x0f, 0x85); fix.push([bytes.length, 'L', 'rel']); imm32(0);
  bytes.push(0x68); fix.push([bytes.length, 'X', 'abs']); imm32(0); bytes.push(0xc3);
  label('X'); bytes.push(0xf4);
  label('f'); bytes.push(0x83, 0xc3, 3); call('g'); bytes.push(0xc3);
  label('g'); bytes.push(0x31, 0xd8, 0xc1, 0xc0, 5, 0xc3);
  label('g4'); bytes.push(0x03, 0x5c, 0x24, 0x04, 0xc2, 4, 0);
  for (const [o, n, kind] of fix) {
    const v = kind === 'abs' ? at[n] : at[n] - (CODE + o + 4);
    bytes[o] = v & 0xff; bytes[o + 1] = (v >> 8) & 0xff; bytes[o + 2] = (v >> 16) & 0xff; bytes[o + 3] = (v >>> 24) & 0xff;
  }
  const code = Uint8Array.from(bytes);
  const EI = makeExec(false);
  EI.load(code, 0);
  assert.equal(EI.run(at.X, 1e7), EXIT.HALT);
  const want = snapshot(EI);
  const EJ = makeExec(true);
  EJ.load(code, 0);
  assert.equal(EJ.run(at.X, 1e7), EXIT.HALT);
  assert.deepEqual(snapshot(EJ), want, 'whole run');
  assert.ok(EJ.jit.stats.chained < 50, `returns chained back into the region: ${EJ.jit.stats.chained}`);
  for (const slice of [3, 11]) {
    EJ.load(code, 0);
    let r, k = 0;
    while ((r = EJ.run(at.X, slice)) === EXIT.TIMESLICE) assert.ok(++k < 1e6, 'runaway');
    assert.deepEqual(snapshot(EJ), want, `slices of ${slice}`);
  }
});

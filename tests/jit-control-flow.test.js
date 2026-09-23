// Control flow inside a translated region (translate.js planUnits / jumpTo): forward branches are
// plain `br`s, innermost loops are WASM loops, everything else goes through the region's
// dispatcher. Random control-flow graphs (overlapping and nested loops, jumps into loop bodies,
// flags live across edges) run under the JIT, whole and in small time slices (which re-enter
// regions in the middle of their loops), and must match the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

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

test('x87 regions specialized for the control word in force: entered under another mode, replaced by run-time tested code', () => {
  // fld dword [DATA+0x100] ; fmul dword [DATA+0x104] ; fadd dword [DATA+0x108] ; fstp qword [DATA+0x110] ; fldcw [DATA+0x120] ; fld1 ; fadd dword [DATA+0x104] ; fstp dword [DATA+0x118] ; hlt
  const bytes = [0xd9, 0x05, ...le(DATA + 0x100), 0xd8, 0x0d, ...le(DATA + 0x104), 0xd8, 0x05, ...le(DATA + 0x108), 0xdd, 0x1d, ...le(DATA + 0x110),
    0xd9, 0x2d, ...le(DATA + 0x120), 0xd9, 0xe8, 0xd8, 0x05, ...le(DATA + 0x104), 0xd9, 0x1d, ...le(DATA + 0x118), 0xf4];
  const code = Uint8Array.from(bytes), end = CODE + bytes.length - 1;
  const setup = (E, cw, cwNew) => {
    E.load(code, 0);
    E.mem.writeF32(DATA + 0x100, 1 / 3); E.mem.writeF32(DATA + 0x104, 3.0000002); E.mem.writeF32(DATA + 0x108, 1e-9); E.mem.write16(DATA + 0x120, cwNew);
    E.mem.write16(E.cpu.base + ST.FPU_CW, cw);
  };
  const result = (E) => [E.mem.readF64(DATA + 0x110), E.mem.readF32(DATA + 0x118), E.mem.read16(E.cpu.base + ST.FPU_CW)];
  for (const [cw, cwNew] of [[0x007f, 0x027f], [0x027f, 0x007f], [0x0c7f, 0x007f], [0x047f, 0x087f]]) {
    const EI = makeExec(false); setup(EI, cw, cwNew); assert.equal(EI.run(end, 1e6), EXIT.HALT);
    // translated under `cw`, then run again under the other control words
    const EJ = makeExec(true); setup(EJ, cw, cwNew); assert.equal(EJ.run(end, 1e6), EXIT.HALT);
    assert.deepEqual(result(EJ), result(EI), `cw ${cw.toString(16)}`);
    for (const other of [0x007f, 0x027f, 0x0c7f]) {
      const EI2 = makeExec(false); setup(EI2, other, cwNew); assert.equal(EI2.run(end, 1e6), EXIT.HALT);
      setup(EJ, other, cwNew); assert.equal(EJ.run(end, 1e6), EXIT.HALT);
      assert.deepEqual(result(EJ), result(EI2), `translated under ${cw.toString(16)}, run under ${other.toString(16)}`);
    }
    if (cw !== 0x007f) assert.ok(EJ.jit.stats.fpuModeMisses >= 1, 'a specialized region left on a mode mismatch');
  }
});

test('flags liveness: partial flag writers (rotates, bit tests, inc/dec, clc/stc) mixed with readers and full writers match the interpreter', () => {
  // straight-line random integer code over eax..edi (esp untouched), with jcc to the next instruction to split blocks
  const R = rng(4242), pick = (n) => Math.floor(R() * n);
  const reg = () => [0, 1, 2, 3, 5, 6, 7][pick(7)]; // not esp
  const modrm = (r, rm) => 0xc0 | (r << 3) | rm;
  const EDGE = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x80000001, 0x7ffffffe, 0x7e, 0x81, 0xfe, 0x7ffe, 0x8001];
  const ops = [
    () => [0x01 + 8 * [0, 1, 4, 5, 6, 7][pick(6)], modrm(reg(), reg())], // add/or/and/sub/xor/cmp r, r
    () => [0x85, modrm(reg(), reg())], // test
    () => [0xf7, modrm(3, reg())], // neg
    () => [0x40 + reg()], () => [0x48 + reg()], // inc / dec
    () => [0xc1, modrm(pick(2), reg()), pick(32)], // rol / ror imm
    () => [0xd3, modrm(pick(2), reg())], // rol / ror cl
    () => [0xd1, modrm(2 + pick(2), reg())], // rcl / rcr 1
    () => [0xc1, modrm([4, 5, 7][pick(3)], reg()), pick(32)], // shl / shr / sar imm
    () => [0xd3, modrm([4, 5, 7][pick(3)], reg())], // shl / shr / sar cl
    () => [0x0f, 0xba, modrm(4 + pick(4), reg()), pick(32)], // bt / bts / btr / btc imm
    () => [0x0f, [0xa3, 0xab, 0xb3, 0xbb][pick(4)], modrm(reg(), reg())], // bt* r, r
    () => [[0xf8, 0xf9, 0xf5][pick(3)]], // clc / stc / cmc
    () => [0x11 + 8 * pick(2), modrm(reg(), reg())], // adc / sbb
    () => [0x0f, 0x90 + pick(16), modrm(0, [0, 1, 2, 3][pick(4)])], // setcc r8
    () => [0x0f, 0x40 + pick(16), modrm(reg(), reg())], // cmovcc
    () => [0x9f], () => [0x9e], // lahf / sahf
    () => [0x9c, 0x58 + [0, 1, 2, 3, 5, 6, 7][pick(7)]], // pushf ; pop r
    () => [0x0f, 0x80 + pick(16), 0, 0, 0, 0], // jcc to the next instruction: a block boundary
    () => [0x89, modrm(reg(), reg())], // mov (transparent)
    () => { const v = EDGE[pick(EDGE.length)]; return [0xb8 + reg(), v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]; }, // mov r, edge value
    () => { const v = EDGE[pick(EDGE.length)]; return [0xb8 + reg(), v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]; },
    () => { // edge value, a flag writer on it, then a condition read at once (setcc / cmovcc / jcc)
      const r = reg(), v = EDGE[pick(EDGE.length)], w = [[0x40 + r], [0x48 + r], [0xf7, modrm(3, r)], [0x83, modrm(0, r), 1], [0x83, modrm(5, r), 1], [0xd1, modrm(5, r)], [0xd1, modrm(7, r)],
        [0xd1, modrm(4, r)], [0x83, modrm(2, r), 0], [0x83, modrm(3, r), 0], [0x85, modrm(r, r)], [0x0f, 0xaf, modrm(r, r)], [0xc1, modrm(pick(2), r), 1 + pick(31)]][pick(13)];
      const rd = [[0x0f, 0x90 + pick(16), modrm(0, [0, 1, 2, 3][pick(4)])], [0x0f, 0x40 + pick(16), modrm(reg(), reg())], [0x0f, 0x80 + pick(16), 0, 0, 0, 0]][pick(3)];
      return [0xb8 + r, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24, ...w, ...rd];
    },
    () => [0x8d, 0x04 | (reg() << 3), (reg() << 3) | [0, 1, 2, 3, 6, 7][pick(6)]], // lea r, [base + index] (transparent)
  ];
  for (let seed = 0; seed < 300; seed++) {
    const bytes = [];
    for (let i = 0; i < 40; i++) {
      bytes.push(...ops[pick(ops.length)]());
    }
    bytes.push(0x9c, 0x5e, 0xf4); // pushf ; pop esi ; hlt  (every flag observed at the end)
    const code = Uint8Array.from(bytes), end = CODE + bytes.length - 1;
    const init = (E) => { E.load(code, 0); const R2 = rng(seed + 1); E.cpu.eax = (R2() * 2 ** 32) >>> 0; E.cpu.ecx = (R2() * 2 ** 32) >>> 0; E.cpu.edx = (R2() * 2 ** 32) >>> 0; E.cpu.ebx = (R2() * 2 ** 32) >>> 0; E.cpu.ebp = (R2() * 2 ** 32) >>> 0; E.cpu.edi = (R2() * 2 ** 32) >>> 0; };
    const EI = makeExec(false); init(EI); assert.equal(EI.run(end, 1e6), EXIT.HALT);
    const EJ = makeExec(true); init(EJ); assert.equal(EJ.run(end, 1e6), EXIT.HALT);
    const st = (E) => { const s = snapshot(E); s.esiFlags = hex(E.cpu.esi & (0x8d5 | 0x400)); return s; };
    assert.deepEqual(st(EJ), st(EI), `seed ${seed}`);
  }
});

test('every condition after every flag writer on boundary values, in the same block and across a block boundary, matches the interpreter', () => {
  const EDGE = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x80000001, 0x7ffffffe, 0x7e, 0xfe, 0x8001];
  // writers on eax (ecx = 3 as a second operand / shift count)
  const WRITERS = [[0x40], [0x48], [0xfe, 0xc0], [0x66, 0x48], [0xf7, 0xd8], [0xf6, 0xd8], [0x83, 0xc0, 0x01], [0x83, 0xe8, 0x01], [0x04, 0x01], [0x66, 0x2d, 0x01, 0x00],
    [0x83, 0xd0, 0x00], [0x83, 0xd8, 0x00], [0x01, 0xc8], [0x29, 0xc8], [0x85, 0xc0], [0x84, 0xc0], [0xd1, 0xe8], [0xd1, 0xf8], [0xd1, 0xe0], [0xc1, 0xe8, 0x03], [0xc0, 0xf8, 0x03],
    [0xd3, 0xe8], [0x0f, 0xaf, 0xc1], [0xf7, 0xe1], [0x0f, 0xa4, 0xc8, 0x03], [0x3c, 0x80], [0x66, 0x3d, 0x00, 0x80]];
  for (const w of WRITERS) for (const v of EDGE) for (const split of [false, true]) {
    const bytes = [];
    for (let cc = 0; cc < 16; cc++) {
      // stc/clc give adc/sbb a known carry-in; setcc into cl, accumulated in ebx
      bytes.push(0xb8, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24, 0xb9, 3, 0, 0, 0, cc & 1 ? 0xf9 : 0xf8, ...w);
      if (split) bytes.push(0x0f, 0x80 + ((cc + 5) & 15), 0, 0, 0, 0); // jcc to the next instruction: the reader starts a block
      bytes.push(0x0f, 0x90 + cc, 0xc1, 0xd1, 0xe3, 0x09, 0xcb); // setcc cl ; shl ebx, 1 ; or ebx, ecx
    }
    bytes.push(0xf4);
    const code = Uint8Array.from(bytes), end = CODE + bytes.length - 1;
    const EI = makeExec(false); EI.load(code, 0); EI.cpu.ebx = 0; assert.equal(EI.run(end, 1e6), EXIT.HALT);
    const EJ = makeExec(true); EJ.load(code, 0); EJ.cpu.ebx = 0; assert.equal(EJ.run(end, 1e6), EXIT.HALT);
    // mul/imul define only CF/OF (the others are undefined and differ between the executors): their conditions are O, B (and negations)
    const mask = (w[0] === 0x0f && w[1] === 0xaf) || (w[0] === 0xf7 && w[1] === 0xe1) ? 0b1111 << 12 : 0xffff;
    assert.equal(EJ.cpu.ebx & mask, EI.cpu.ebx & mask, `writer ${w.map((b) => b.toString(16)).join(' ')} on ${v.toString(16)}${split ? ' (reader in the next block)' : ''}`);
  }
});

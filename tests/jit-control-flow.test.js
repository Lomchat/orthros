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

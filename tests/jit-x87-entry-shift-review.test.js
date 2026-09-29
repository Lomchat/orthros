// Adversarial review of the planned x87 entry shifts (translate.js x87EntryPlan / x87EntryTop): generated programs
// whose planned blocks contain instructions reading or re-basing the real TOP (FNSTSW AX, FNSTENV / FLDENV,
// FNSAVE / FRSTOR, FINCSTP / FDECSTP, FXCH), in-region CALL / RET with values pushed or popped by the callee (return
// sites stay at shift 0, callees reached with any shift), MMX / EMMS at an empty stack, FCOMIP / FUCOMPP feeding
// JCCs, whole and at every time slice, against the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100; // esi
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const SW_CC = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 14);
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(jit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, I, J,
    run(end, slice = 1e6) {
      I.cache.clear();
      if (!J) return I.run({ stopAt: end, maxInsns: 1e7 });
      J.reset(); J.cpu = cpu; J.boundaries = new Set([end]);
      let r, n = 0;
      do r = J.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e6);
      return r;
    },
  };
}
const EI = makeExec(false), EJ = makeExec(true);
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

function snapshot(E) {
  const { mem, cpu: c } = E;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cc: hex(c.fpuSw & SW_CC), fpr: [], mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(Object.is(c.fpr(k), -0) ? '-0' : String(c.fpr(k)));
  return s;
}
function runBoth(code, seed, label, slice) {
  for (const E of [EI, EJ]) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x100, 0x3000, 0xcc);
    mem.writeBytes(CODE, code);
    mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
    const r = prng(seed);
    for (let i = 0; i < 0x100; i += 8) mem.writeF64(MEMOP + i, ((r() % 2000) - 1000) / 64);
    for (let k = 0; k < 8; k++) cpu.setReg(k, r());
    cpu.esi = MEMOP; cpu.esp = DATA + 0xf00;
    cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
    cpu.eip = CODE;
  }
  const end = CODE + code.length;
  const ri = EI.run(end), rj = EJ.run(end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), `${label}: jit state differs from the interpreter`);
}

const md = (r) => (r() % 0x10) * 8; // [esi + disp8] (0..0x78: the saves go to esi+0x200..)
const d32 = (v) => [v & 0xff, (v >> 8) & 0xff, 0, 0];
function push(r, d) {
  const k = r() % 4;
  if (k === 0) return [0xdd, 0x46, md(r)]; // fld qword
  if (k === 1) return [0xd9, 0xe8]; // fld1
  if (k === 2 && d > 0) return [0xd9, 0xc0 + (r() % d)]; // fld st(i)
  return [0xd9, 0xee]; // fldz
}
function pop(r, d) {
  const k = r() % 5;
  if (k === 0 && d >= 2) return [0xde, 0xc1]; // faddp
  if (k === 1 && d >= 2) return [0xdf, 0xf1, 0x72, 0x00]; // fcomip st1 ; jb +0 (a block end right after the pop)
  if (k === 2 && d >= 2) return [0xdd, 0xd9]; // fstp st(1)
  if (k === 3) return [0xdd, 0x5e, md(r)]; // (fistp would set PE, which the JIT does not track: pre-existing)
  return [0xdd, 0x5e, md(r)]; // fstp qword
}
/** instructions keeping the depth, several of them reading or re-basing the real TOP */
function neutral(r, d) {
  const k = r() % 12;
  if (k === 0 && d >= 2) return [0xd9, 0xc8 + 1 + (r() % (d - 1))]; // fxch
  if (k === 1) return [0xdf, 0xe0, 0x25, 0x00, 0x7f, 0, 0]; // fnstsw ax ; and eax, 0x7f00 (TOP and the condition codes)
  if (k === 2) return [0xd9, 0xb6, ...d32(0x200), 0xd9, 0xa6, ...d32(0x200)]; // fnstenv [esi+0x200] ; fldenv [esi+0x200]
  if (k === 3) return [0xdd, 0xb6, ...d32(0x240), 0xdd, 0xa6, ...d32(0x240)]; // fnsave [esi+0x240] ; frstor [esi+0x240]
  if (k === 4 && d >= 1) return [0xd9, 0xf7, 0xd9, 0xf6]; // fincstp ; fdecstp
  if (k === 5 && d >= 1) return [0xd8, 0xc0 + (r() % d)]; // fadd st0, st(i)
  if (k === 6 && d >= 1) return [0xdd, 0x56, md(r)]; // fst qword
  if (k === 7 && d >= 1) return [0xd9, 0xe1]; // fabs
  if (k === 8 && d === 0) return [0x0f, 0x6e, 0xc3, 0x0f, 0x7e, 0xc7, 0x0f, 0x77]; // movd mm0, ebx ; movd edi, mm0 ; emms
  if (k === 9) return [0xd9, 0x7e, 0x70, 0xd9, 0x6e, 0x70]; // fnstcw [esi+0x70] ; fldcw [esi+0x70]
  return [[0x01, 0xd3], [0x29, 0xd3], [0x83, 0xf9, 0x40], [0x42]][r() % 4];
}
function balanced(r, d) { return d < 7 ? [...push(r, d), ...neutral(r, d + 1), ...pop(r, d + 1)] : neutral(r, d); }

// functions before the main code (jmp main): F0 pushes one value, F1 pops one, F2 is balanced with a JCC inside
const F0 = [0xdd, 0x46, 0x08, 0xc3];
const F1 = [0xdd, 0x5e, 0x10, 0xc3];
const F2 = [0xd9, 0xe8, 0x85, 0xdb, 0x74, 0x02, 0xd9, 0xe0, 0xdd, 0x5e, 0x18, 0xc3];
const FUNCS = [...F0, ...F1, ...F2];
const FOFF = [2, 2 + F0.length, 2 + F0.length + F1.length];

function program(seed, n = 30) {
  const r = prng(seed);
  const out = [0xe9, 0, 0, 0, 0]; // jmp main (rel32, patched)
  // (the rel32 JMP is 5 bytes: function offsets shift by 3)
  const fo = FOFF.map((x) => x + 3);
  out.push(...FUNCS);
  const main = out.length;
  out[1] = (main - 5) & 0xff;
  const call = (k) => { const rel = fo[k] - (out.length + 5); out.push(0xe8, rel & 0xff, (rel >> 8) & 0xff, (rel >> 16) & 0xff, (rel >> 24) & 0xff); };
  let d = 0;
  for (let i = 0; i < n; i++) {
    const k = r() % 13;
    if (k < 3 && d < 6) { out.push(...push(r, d)); d++; }
    else if (k < 5 && d > 0) { out.push(...pop(r, d)); d--; }
    else if (k < 7) out.push(...neutral(r, d));
    else if (k < 8) { const g = balanced(r, d); out.push(0x70 + (r() & 15), g.length, ...g); }
    else if (k < 9) out.push(0xeb, 0x00);
    else if (k < 10) {
      const body = [...balanced(r, d), ...(r() & 1 ? neutral(r, d) : [])];
      out.push(0xb9, 2 + (r() % 4), 0, 0, 0, ...body, 0x49, 0x75, (-(body.length + 3)) & 0xff);
    } else if (k < 11 && d < 6) { call(0); d++; }
    else if (k < 12 && d > 0) { call(1); d--; }
    else if (d < 6) call(2);
  }
  while (d-- > 0) out.push(0xdd, 0x5e, 0x80 + 8 * (d & 7));
  return Uint8Array.from(out);
}

test('review: planned blocks with TOP readers / re-basers, in-region calls, MMX, match the interpreter', () => {
  let planned = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const code = program(seed * 4099 + 3);
    runBoth(code, seed, `seed ${seed} (${Buffer.from(code).toString('hex')})`);
    const mem = new GuestMemory(); mem.writeBytes(CODE, code);
    planned += translateRegion(mem, CODE, { smc: true }).stats.x87Planned;
  }
  assert.ok(planned > 50, `planned blocks ${planned}`);
});

test('review: the same programs at every time slice', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const code = program(seed * 3001 + 7, 22);
    runBoth(code, seed + 900, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 4));
  }
});

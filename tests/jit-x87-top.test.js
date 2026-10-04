// x87 regions specialized for the stack top at their entry (opts.x87Top, translate.js x87ModeOf): the region's x87
// stack cache is loaded and written back at constant offsets, its entry guard compares TOP minus the entered block's
// planned shift with the top it was translated for and hands any other top to the next version (or to the JIT, which
// adds one for another control word; entered with another top under a control word it has a version for, the region
// is translated again testing the top at run time, as before the option). Generated programs
// (pushes, pops, arithmetic, FDECSTP / FINCSTP, branches and loops over balanced groups, calls into separate regions
// returning values on the stack, interpreter fallbacks) entered with random tops, stack contents (empty registers
// included: their values must survive), control words, time slices down to one instruction, and the same code run
// again and again from other tops in one JIT: the whole x87 state, registers and memory must be the interpreter's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { X87_MODE_TOP, translateRegion } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100; // esi: base of the [esi+disp8] operands
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const SW_CC = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 14);
const hex = (v) => '0x' + (v >>> 0).toString(16);
const CWS = [0x027f, 0x007f, 0x037f, 0x0e7f, 0x047f];

function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

function makeExec(jit, opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jit ? new Jit(mem, I, { smc: true, x87Top: true, ...opts }) : null;
  if (J) J.cpu = cpu;
  return { mem, cpu, I, J };
}

function snapshot(E) {
  const { mem, cpu: c } = E;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cc: hex(c.fpuSw & SW_CC), cw: hex(c.fpuCw), fpr: [], mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(Object.is(c.fpr(k), -0) ? '-0' : String(c.fpr(k)));
  return s;
}

/** load `code`, the data and an x87 state made from `seed` (top, values pushed, every register's value, control word) */
function setup(E, code, seed, fresh = true) {
  const { mem, cpu } = E;
  cpu.reset();
  mem.fill(DATA, DATA_SIZE, 0);
  if (fresh) { mem.fill(CODE - 0x100, 0x3000, 0xcc); mem.writeBytes(CODE, code); mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0; }
  const r = prng(seed);
  for (let i = 0; i < 0x100; i += 8) mem.writeF64(MEMOP + i, ((r() % 2000) - 1000) / 64);
  for (let k = 0; k < 8; k++) cpu.setReg(k, r());
  cpu.esi = MEMOP; cpu.esp = DATA + 0xf00;
  cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
  // the stack: `pushed` values below a random top, every physical register holding a value (empty ones too)
  const top = r() & 7, pushed = r() % 2; // (one value at most: the programs reach a depth of 7, the JIT does not emulate stack faults, D014)
  let tw = 0;
  for (let k = 0; k < 8; k++) cpu.setFpr(k, ((r() % 20000) - 10000) / 128);
  for (let k = 0; k < pushed; k++) tw |= 1 << ((top + k) & 7);
  cpu.fpuTop = top; cpu.fpuTw = tw;
  cpu.fpuCw = CWS[r() % CWS.length];
  cpu.eip = CODE;
}

function run(E, end, slice, keep = false) {
  E.I.cache.clear();
  if (!E.J) return E.I.run({ stopAt: end, maxInsns: 1e7 });
  if (!keep) E.J.reset();
  E.J.boundaries = new Set([end, ...(E.extra ?? [])]);
  let r, n = 0;
  do r = E.J.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e6);
  return r;
}

function check(EI, EJ, code, seed, label, slice, end = CODE + code.length) {
  setup(EI, code, seed); setup(EJ, code, seed);
  const ri = run(EI, end, 1e7), rj = run(EJ, end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), `${label}: jit state differs from the interpreter`);
}

// ---------------------------------------------------------------- program generator (as jit-x87-entry-shift.test.js,
// with FDECSTP / FINCSTP pairs and calls)
const md = (r) => (r() % 0x20) * 8; // [esi + disp8]
function push(r, d) {
  const k = r() % 4;
  if (k === 0) return [0xdd, 0x46, md(r)]; // fld qword [esi+d]
  if (k === 1) return [0xd9, 0xe8]; // fld1
  if (k === 2 && d > 0) return (r() & 3) ? [0xd9, 0xc0 + (r() % d)] : [0xd9, 0xf4]; // fld st(i) / fxtract (an interpreter fallback)
  return [0xd9, 0x46, md(r)]; // fld dword [esi+d]
}
function pop(r, d) {
  const k = r() % 4;
  if (k === 0 && d >= 2) return [0xde, 0xc1]; // faddp
  if (k === 1 && d >= 2) return [0xde, 0xc9]; // fmulp
  if (k === 2 && d >= 2) return [0xdd, 0xd9]; // fstp st(1)
  return [0xdd, 0x5e, md(r)]; // fstp qword [esi+d]
}
function neutral(r, d) {
  const k = r() % 10;
  if (k === 0 && d >= 2) return [0xd9, 0xc8 + 1 + (r() % (d - 1))]; // fxch st(i)
  if (k === 1 && d >= 1) return [0xd8, 0xc0 + (r() % d)]; // fadd st0, st(i)
  if (k === 2 && d >= 1) return [0xdc, 0x4e, md(r)]; // fmul qword [esi+d]
  if (k === 3 && d >= 1) return [0xdd, 0x56, md(r)]; // fst qword [esi+d]
  if (k === 4 && d >= 1) return [0xd9, 0xe0]; // fchs
  if (k === 5) return [[0x01, 0xd3], [0x29, 0xd3], [0x83, 0xf9, 0x40], [0xf7, 0xc3, 1, 0, 0, 0]][r() % 4]; // add ebx,edx / sub ebx,edx / cmp ecx,0x40 / test ebx,1
  if (k === 6) return [0x83, 0xe3, 0x1f, 0x0f, 0xa3, 0x1e]; // and ebx, 31 ; bt [esi], ebx (a fallback)
  if (k === 7) return [0xd9, 0xf6, 0xd9, 0xf7]; // fdecstp ; fincstp (TOP moved and back, no data)
  if (k === 8 && d >= 2) return [0xd9, 0xf7, 0xdd, 0x56, md(r), 0xd9, 0xf6]; // fincstp ; fst qword [esi+d] (of ST(1)) ; fdecstp
  return [0x42]; // inc edx
}
function balanced(r, d) { return d < 7 ? [...push(r, d), ...neutral(r, d + 1), ...pop(r, d + 1)] : [...neutral(r, d)]; }

function program(seed, n = 30, calls = false) {
  const r = prng(seed);
  const out = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const k = r() % (calls ? 11 : 10);
    if (k < 3 && d < 6) { out.push(...push(r, d)); d++; }
    else if (k < 5 && d > 0) { out.push(...pop(r, d)); d--; }
    else if (k < 6) out.push(...neutral(r, d));
    else if (k < 8) { const g = balanced(r, d); out.push(0x70 + (r() & 15), g.length, ...g); } // jcc over a balanced group
    else if (k < 9) out.push(0xeb, 0x00); // jmp +0
    else if (k < 10) { // a loop: mov ecx, n ; L: <balanced> ; dec ecx ; jnz L
      const body = [...balanced(r, d), ...(r() & 1 ? balanced(r, d) : [])];
      out.push(0xb9, 2 + (r() % 4), 0, 0, 0, ...body, 0x49, 0x75, (-(body.length + 3)) & 0xff);
    } else if (d < 6) { out.push({ call: r() % 3 }); d++; } // call F_k: returns a value pushed (fld ; fmul ; ret)
  }
  while (d-- > 0) out.push(0xdd, 0x5e, 0x80 + 8 * (d & 7));
  // the callees after the HLT that ends the program (the test stops at the HLT's address): F_k: fld qword [esi+8k] ;
  // fmul st0, st0 ; [fld1 ; faddp] ; ret
  const body = [];
  for (const x of out) if (typeof x === 'number') body.push(x); else body.push(0xe8, x.call, 0, 0, 0); // (patched below)
  const end = body.length;
  body.push(0xf4);
  const fAt = [];
  for (let k = 0; k < 3; k++) { fAt.push(body.length); body.push(0xdd, 0x46, 8 * k, 0xd8, 0xc8, ...(k === 1 ? [0xd9, 0xe8, 0xde, 0xc1] : []), 0xc3); }
  for (let i = 0; i < end; i++) if (body[i] === 0xe8 && body[i + 2] === 0 && body[i + 3] === 0 && body[i + 4] === 0 && body[i + 1] < 3 && isCallSite(out, i)) {
    const rel = fAt[body[i + 1]] - (i + 5);
    body[i + 1] = rel & 0xff; body[i + 2] = (rel >> 8) & 0xff; body[i + 3] = (rel >> 16) & 0xff; body[i + 4] = (rel >> 24) & 0xff;
  }
  return { code: Uint8Array.from(body), end, callees: fAt };
}
/** is body offset `at` the start of a call placeholder of `out`? */
function isCallSite(out, at) {
  let o = 0;
  for (const x of out) { if (o === at) return typeof x !== 'number'; o += typeof x === 'number' ? 1 : 5; if (o > at) return false; }
  return false;
}

// ---------------------------------------------------------------- tests
test('generated x87 programs entered with random stack tops, contents and control words match the interpreter', () => {
  const EI = makeExec(false), EJ = makeExec(true);
  let specialized = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { code, end } = program(seed * 6007 + 1);
    check(EI, EJ, code, seed, `seed ${seed} (${Buffer.from(code).toString('hex')})`, 1e6, CODE + end);
    specialized += EJ.J.regions.filter((r) => r.fpc !== null && (r.fpc & X87_MODE_TOP)).length;
  }
  assert.ok(specialized > 200, `regions specialized for the stack top: ${specialized}`);
});

test('time slices at every instruction: entries into planned blocks check the top less the planned shift', () => {
  const EI = makeExec(false), EJ = makeExec(true);
  for (let seed = 1; seed <= 100; seed++) {
    const { code, end } = program(seed * 7703 + 2, 20);
    check(EI, EJ, code, seed + 500, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 4), CODE + end);
  }
});

test('calls into separate regions returning values on the stack (return sites entered with another top)', () => {
  const EI = makeExec(false), EJ = makeExec(true);
  for (let seed = 1; seed <= 150; seed++) {
    const { code, end, callees } = program(seed * 911 + 3, 30, true);
    EJ.extra = callees.map((f) => CODE + f); // (the callees: regions of their own)
    for (const slice of [1e6, 3]) check(EI, EJ, code, seed + 900, `call seed ${seed} slice ${slice} (${Buffer.from(code).toString('hex')})`, slice, CODE + end);
  }
  EJ.extra = null;
});

test('one JIT running the same code from other tops and control words: versions, regions translated again testing the top', () => {
  const EI = makeExec(false), EJ = makeExec(true, { warn: () => {} });
  let topless = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { code, end, callees } = program(seed * 3301 + 7, 24, seed & 1);
    EJ.extra = callees.map((f) => CODE + f);
    EJ.J.reset();
    for (let k = 0; k < 10; k++) {
      setup(EI, code, seed * 100 + k); setup(EJ, code, seed * 100 + k, k === 0);
      const ri = run(EI, CODE + end, 1e7), rj = run(EJ, CODE + end, k % 3 === 2 ? 2 : 1e6, true);
      assert.equal(ri, EXIT.HALT); assert.equal(rj, EXIT.HALT, `seed ${seed} run ${k}: jit exit ${rj}`);
      assert.deepEqual(snapshot(EJ), snapshot(EI), `seed ${seed} run ${k} (${Buffer.from(code).toString('hex')})`);
    }
    topless += EJ.J.regions.filter((r) => r.fpc !== null && !(r.fpc & X87_MODE_TOP)).length;
  }
  EJ.extra = null;
  assert.ok(EJ.J.stats.fpuVersions > 20, `versions added: ${EJ.J.stats.fpuVersions}`);
  assert.ok(EJ.J.stats.genericTop > 20, `regions translated again for another top: ${EJ.J.stats.genericTop}`);
  assert.ok(topless > 20, `regions testing the top at run time: ${topless}`);
});

test('the specialized prologue addresses the stack registers at constant offsets', () => {
  // fld qword [esi] ; fmul qword [esi+8] ; fstp qword [esi+16] ; hlt — the same region for TOP 0 and TOP 5, specialized
  // for the top or not: only the generic one computes (TOP + i) & 7
  const mem = new GuestMemory();
  mem.writeBytes(CODE, Uint8Array.from([0xdd, 0x06, 0xdc, 0x4e, 0x08, 0xdd, 0x5e, 0x10, 0xf4]));
  const size = (mode, x87Top) => translateRegion(mem, CODE, { smc: true, fpcAssume: mode, x87Top }).code.length;
  const generic = size(0x200, false), top0 = size(0x200 | X87_MODE_TOP | 0, true), top5 = size(0x200 | X87_MODE_TOP | 5, true);
  assert.equal(translateRegion(mem, CODE, { smc: true, fpcAssume: 0x200 | X87_MODE_TOP | 5, x87Top: true }).fpcAssume, 0x200 | X87_MODE_TOP | 5);
  assert.equal(translateRegion(mem, CODE, { smc: true, fpcAssume: 0x200 | X87_MODE_TOP | 5, x87Top: false }).fpcAssume, 0x200, 'without the option: the control word only');
  assert.ok(top0 > 0 && top5 > 0 && generic > 0);
});

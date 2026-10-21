// x87 regions load and write back only the stack registers their code touches (opts.x87Live, translate.js
// x87LiveSites): the per-register loads and stores of the others become nops. Checked here: the mask of a few regions
// (the elision happens, rotations and TOP resets keep all eight), and random programs touching few registers — every
// physical register holding a value at the start (empty ones too), random tops and control words, interpreter
// fallbacks (FXTRACT), FNSAVE / FRSTOR and FNSTENV / FLDENV (TOP changed under the cache), FINCSTP / FDECSTP, time
// slices down to one instruction — give the interpreter's whole x87 state, every register's value included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000, MEMOP = DATA + 0x100;
const hexb = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

function liveMask(code, opts = {}) {
  const mem = new GuestMemory();
  mem.writeBytes(CODE, code);
  return translateRegion(mem, CODE, opts).stats.x87Live;
}

test('x87Live: the registers a region touches', () => {
  // fld qword [esi] ; fadd st0, st0 ; fstp qword [esi+8] ; ret: one register (the pushed slot)
  const one = liveMask(hexb('dd06 d8c0 dd5e08 c3'));
  assert.equal(one.toString(2).replace(/0/g, '').length, 1);
  // fld ; fld ; faddp ; fstp: two
  assert.equal(liveMask(hexb('dd06 dd4608 dec1 dd5e10 c3')).toString(2).replace(/0/g, '').length, 2);
  // an unbalanced block followed by a branch to a block entered at another shift may rotate: then all eight
  // (fld qword [esi] ; jmp L ; ... L: fstp qword [esi+8] ; ret) — whatever the plan, the mask covers what moved
  const m = liveMask(hexb('dd06 eb00 dd5e08 c3'));
  assert.ok(m > 0 && m <= 0xff);
  // off: no mask computed
  assert.equal(liveMask(hexb('dd06 d8c0 dd5e08 c3'), { x87Live: false }), undefined);
});

function makeExec(jitOpts) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  if (J) J.cpu = cpu;
  return { mem, cpu, I, J };
}
function setup(E, code, seed) {
  const { mem, cpu } = E;
  cpu.reset();
  mem.fill(DATA, DATA_SIZE, 0);
  mem.fill(CODE - 0x100, 0x3000, 0xcc); mem.writeBytes(CODE, code); mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
  const r = prng(seed);
  for (let i = 0; i < 0x100; i += 8) mem.writeF64(MEMOP + i, ((r() % 2000) - 1000) / 64);
  cpu.esi = MEMOP; cpu.esp = DATA + 0xf00;
  for (let k = 0; k < 8; k++) cpu.setFpr(k, ((r() % 20000) - 10000) / 128); // (empty registers hold values too)
  const top = r() & 7;
  cpu.fpuTop = top; cpu.fpuTw = r() & 1 ? 1 << top : 0;
  cpu.fpuCw = [0x027f, 0x007f, 0x037f, 0x0c7f][r() & 3];
  cpu.eip = CODE;
}
function snapshot(E) {
  const { mem, cpu: c } = E;
  const fpr = [];
  for (let k = 0; k < 8; k++) fpr.push(Object.is(c.fpr(k), -0) ? '-0' : String(c.fpr(k)));
  return { eip: c.eip >>> 0, top: c.fpuTop, tw: c.fpuTw, sw: c.fpuSw & 0x4700, cw: c.fpuCw, fpr, mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
}
function run(E, end, slice) {
  E.I.cache.clear();
  if (!E.J) return E.I.run({ stopAt: end, maxInsns: 1e7 });
  E.J.reset();
  E.J.boundaries = new Set([end]);
  let r, n = 0;
  do r = E.J.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e6);
  return r;
}

const md = (r) => (r() % 0x10) * 8;
/** a straight-line / branching program over few registers (depth at most 3), ending on HLT */
function program(seed) {
  const r = prng(seed), out = [];
  let d = 0;
  for (let i = 0; i < 24; i++) {
    const k = r() % 14;
    if (k < 3 && d < 3) { out.push(...[[0xdd, 0x46, md(r)], [0xd9, 0xe8], [0xd9, 0x46, md(r)]][r() % 3]); d++; } // fld m64 / fld1 / fld m32
    else if (k < 5 && d > 0) { out.push(...(d >= 2 && r() & 1 ? [0xde, 0xc1] : [0xdd, 0x5e, md(r)])); d--; } // faddp / fstp m64
    else if (k === 5 && d >= 1) out.push(0xdc, 0x4e, md(r)); // fmul qword [esi+d]
    else if (k === 6 && d >= 2) out.push(0xd9, 0xc9); // fxch st(1)
    else if (k === 7 && d >= 1 && d < 3) { out.push(0xd9, 0xf4); d++; } // fxtract (an interpreter fallback)
    else if (k === 8) out.push(0xdd, 0x76, 0x80, 0xdd, 0x66, 0x80); // fnsave [esi+0x80] ; frstor [esi+0x80]
    else if (k === 9) out.push(0xd9, 0x76, 0x80, 0xd9, 0x66, 0x80); // fnstenv / fldenv
    else if (k === 10) out.push(0xd9, 0xf6, 0xd9, 0xf7); // fdecstp ; fincstp
    else if (k === 11) out.push(0xeb, 0x00); // jmp +0 (a block boundary)
    else if (k === 12 && d >= 1) out.push(0xdd, 0x56, md(r)); // fst qword [esi+d]
    else out.push(0x42); // inc edx
  }
  while (d-- > 0) out.push(0xdd, 0x5e, 0x80 + 8 * d);
  out.push(0xf4);
  return Uint8Array.from(out);
}

test('x87Live: random programs over few registers, every register value as the interpreter leaves it', () => {
  const EI = makeExec(null), EJ = makeExec({ x87Live: true }), EO = makeExec({ x87Live: false });
  for (let seed = 1; seed <= 300; seed++) {
    const code = program(seed), end = CODE + code.length - 1;
    for (const slice of [1e6, 1 + (seed % 7)]) {
      setup(EI, code, seed); setup(EJ, code, seed); setup(EO, code, seed);
      const ri = run(EI, end, 1e7), rj = run(EJ, end, slice), ro = run(EO, end, slice);
      assert.equal(ri, EXIT.HALT, `seed ${seed}: interpreter exit ${ri}`);
      assert.equal(rj, EXIT.HALT, `seed ${seed}: jit exit ${rj}`);
      assert.equal(ro, EXIT.HALT);
      assert.deepEqual(snapshot(EJ), snapshot(EI), `seed ${seed} slice ${slice}: x87Live state differs from the interpreter`);
      assert.deepEqual(snapshot(EO), snapshot(EI), `seed ${seed} slice ${slice}: x87Live off differs`);
    }
  }
});

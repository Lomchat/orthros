// The x87 stack layout of translated code (Jit opts.x87Logical, ST.XL): x87 regions keep ST(0..7) and the tag word
// in logical order in the state block, the dispatcher converts from / to the physical registers at its boundaries and
// the JavaScript paths (interpreter fallbacks, traps) convert around themselves. Programs run on the interpreter and on
// the JIT under both layouts (chained regions, time slices, fallbacks, two threads, a trap, a layout switch between
// runs); the whole x87 state must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const abs = (op, ext, a) => [...op, (ext << 3) | 5, ...le(a)];
const X = {
  fld1: [0xd9, 0xe8], fldpi: [0xd9, 0xeb], fldz: [0xd9, 0xee], faddp: [0xde, 0xc1], fmulp: [0xde, 0xc9], fsubp: [0xde, 0xe9],
  fxch1: [0xd9, 0xc9], fld_st1: [0xd9, 0xc1], fprem: [0xd9, 0xf8], fxtract: [0xd9, 0xf4], fincstp: [0xd9, 0xf7], fdecstp: [0xd9, 0xf6],
  ffree2: [0xdd, 0xc2],
  fldQ: (a) => abs([0xdd], 0, a), fstpQ: (a) => abs([0xdd], 3, a), faddQ: (a) => abs([0xdc], 0, a), fmulQ: (a) => abs([0xdc], 1, a),
};

/** Assemble [bytes | {label} | {jnz: label} | {jmp: label}] at CODE; returns { bytes, at: label -> address }. */
function asm(parts) {
  const out = [], at = new Map(), fix = [];
  for (const p of parts) {
    if (Array.isArray(p)) out.push(...p);
    else if (p.label) at.set(p.label, CODE + out.length);
    else if (p.jnz) { out.push(0x0f, 0x85); fix.push([out.length, p.jnz]); out.push(0, 0, 0, 0); }
    else if (p.jmp) { out.push(0xe9); fix.push([out.length, p.jmp]); out.push(0, 0, 0, 0); }
  }
  for (const [o, l] of fix) { const rel = at.get(l) - (CODE + o + 4); out.splice(o, 4, ...le(rel)); }
  return { bytes: Uint8Array.from(out), at };
}

function machine(kind, threads = 1) {
  const mem = new GuestMemory();
  const cpus = Array.from({ length: threads }, (_, i) => new CpuState(mem, THREAD_STATES_BASE + i * ST.SIZE));
  const interp = new Interp(mem, cpus[0]);
  const jit = kind === 'interp' ? null : new Jit(mem, interp, { smc: true, x87Logical: kind === 'logical' });
  return { mem, cpus, interp, jit };
}
function setup(M, prog, data) {
  M.mem.writeBytes(CODE, prog.bytes);
  M.mem.fill(DATA, 0x1000, 0);
  for (const [off, v] of data) M.mem.writeF64(DATA + off, v);
  M.cpus.forEach((c, i) => { c.reset(); c.eip = CODE; c.esp = DATA + 0x800 + 0x100 * i; c.ecx = 5 + i; c.eflags = F.RESERVED1 | F.IF; });
}
/** Run thread `t` up to `stopAt` (or `slice` instructions); returns the exit code. */
function step(M, t, stopAt, slice, boundaries) {
  const cpu = M.cpus[t];
  if (!M.jit) { M.interp.cpu = cpu; return M.interp.run({ stopAt, maxInsns: slice }); }
  M.jit.cpu = cpu; M.jit.boundaries = new Set(boundaries);
  return M.jit.run({ stopAt, maxInsns: slice });
}
function state(M, t = 0) {
  const c = M.cpus[t];
  const fpr = []; for (let k = 0; k < 8; k++) fpr.push(c.fpr(k));
  return { eip: c.eip >>> 0, top: c.fpuTop, tw: c.fpuTw & 0xff, sw: c.fpuSw & 0x4700, fpr, ecx: c.ecx >>> 0, mem: Buffer.from(M.mem.bytes(DATA, 0x100)).toString('hex') };
}
/** Run every thread to `stopAt` in slices of `slice` instructions, round robin. */
function runAll(M, stopAt, slice, boundaries) {
  const done = M.cpus.map(() => false);
  for (let guard = 0; guard < 100000 && done.includes(false); guard++) {
    for (let t = 0; t < M.cpus.length; t++) {
      if (done[t]) continue;
      const r = step(M, t, stopAt, slice, boundaries);
      if (r === EXIT.HALT) done[t] = true;
      else assert.equal(r, EXIT.TIMESLICE, `thread ${t} exit ${r}`);
    }
  }
}

// a loop keeping values on the x87 stack across region boundaries (TOP moves inside each region), an interpreter
// fallback (FPREM, FXTRACT) between pushes, tag changes (FFREE), stores of the results
const LOOP = asm([
  X.fld1, X.fldpi, X.fldQ(DATA),
  { label: 'top' },
  X.fld_st1, X.faddQ(DATA + 8), { label: 'b1' },
  X.fxch1, X.fmulQ(DATA + 16), X.fprem, X.fsubp, { label: 'b2' },
  X.fld1, X.fxtract, X.faddp, X.fstpQ(DATA + 32), X.fdecstp, X.fincstp,
  X.fstpQ(DATA + 40), X.fld1, X.ffree2, { label: 'b3' },
  [0x49], { jnz: 'top' },
  X.fstpQ(DATA + 48), X.fstpQ(DATA + 56),
  { label: 'end' }, [0xf4],
]);
const DATA0 = [[0, 0.75], [8, 1.0 / 3], [16, -2.5]];
const BOUNDS = ['top', 'b1', 'b2', 'b3'].map((l) => LOOP.at.get(l));
const END = LOOP.at.get('end');

test('x87 values across chained regions, fallbacks and time slices: same state under both layouts as the interpreter', () => {
  for (const slice of [1e6, 7, 3, 1]) {
    const ref = machine('interp'); setup(ref, LOOP, DATA0); runAll(ref, END, slice, []);
    for (const kind of ['logical', 'physical']) {
      for (const bounds of [[], BOUNDS]) {
        const M = machine(kind); setup(M, LOOP, DATA0); runAll(M, END, slice, bounds);
        assert.deepEqual(state(M), state(ref), `${kind}, slice ${slice}, ${bounds.length} boundaries`);
      }
    }
  }
});

test('two threads with different x87 stacks interleaved on one JIT: each keeps its own (both layouts)', () => {
  for (const slice of [5, 2]) {
    const ref = machine('interp', 2); setup(ref, LOOP, DATA0);
    // (distinct stacks: thread 1 starts with a value pushed, so its TOP differs)
    ref.cpus[1].fpuTop = 7; ref.cpus[1].setFpr(7, 42.5); ref.cpus[1].fpuTw = 0x80;
    runAll(ref, END, slice, []);
    for (const kind of ['logical', 'physical']) {
      const M = machine(kind, 2); setup(M, LOOP, DATA0);
      M.cpus[1].fpuTop = 7; M.cpus[1].setFpr(7, 42.5); M.cpus[1].fpuTw = 0x80;
      runAll(M, END, slice, BOUNDS);
      for (const t of [0, 1]) assert.deepEqual(state(M, t), state(ref, t), `${kind}, thread ${t}, slice ${slice}`);
    }
  }
});

test('a WASM trap in an x87 region leaves the same x87 state in both layouts (the last write-back)', () => {
  const prog = asm([X.fld1, X.fldpi, X.fldQ(DATA), { label: 'r2' }, X.faddp, X.fld1, [0xa1, ...le(0x90000000)], [0xf4]]);
  const out = {};
  for (const kind of ['logical', 'physical']) {
    const M = machine(kind);
    // (twice: the second run chains from the first region into the trapping one, translated by the first run, inside
    // one dispatcher call — the dispatcher's conversion back to the physical registers is skipped by the trap)
    for (let k = 0; k < 2; k++) {
      setup(M, prog, []);
      const r = step(M, 0, CODE + prog.bytes.length - 1, 1e6, [prog.at.get('r2')]);
      assert.equal(r, EXIT.FAULT, kind);
    }
    out[kind] = state(M);
  }
  assert.deepEqual(out.logical, out.physical);
  assert.deepEqual(out.logical.fpr.slice(5), [0, Math.PI, 1]);
  assert.equal(out.logical.top, 5, 'the three pushes of the first region were written back (TOP 0 - 3)');
});

test('switching the layout between runs (Jit.switchOpts) keeps the x87 state', () => {
  const ref = machine('interp'); setup(ref, LOOP, DATA0); runAll(ref, END, 1e6, []);
  const M = machine('logical'); setup(M, LOOP, DATA0);
  let n = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const r = step(M, 0, END, 4, BOUNDS);
    if (r === EXIT.HALT) break;
    if (++n % 3 === 0) M.jit.switchOpts(n % 2 ? { x87Logical: false } : { x87Logical: true });
  }
  assert.deepEqual(state(M), state(ref));
});

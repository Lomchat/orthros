#!/usr/bin/env node
// Code-shape microbenchmarks of the JIT: small x86 kernels of common forms (written here, not taken from any program),
// each run under the JIT with the given translation options; ns per guest instruction (the guest instructions charged
// to the budget), best of 5. Compares code-generator variants without the noise of a game:
//   node tools/shape-bench.mjs [--opts '{"ifcvt":true}'] [--vs '{"ifcvt":false}'] [--only name,name]
// (with --vs: the two variants alternated, each kernel's ratio printed; --trace <kernel>: its time per repetition in one
// JIT — a large region runs in V8's baseline tier until its optimized code is ready)
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, A = 0x10000000, B = 0x10400000, C = 0x10800000, STACK = 0x11000000;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

// ---- a tiny assembler (32-bit registers: eax ecx edx ebx esp ebp esi edi = 0..7)
const [EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI] = [0, 1, 2, 3, 4, 5, 6, 7];
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const rr = (op, dst, src) => [op, 0xc0 | (src << 3) | dst]; // op r/m32(dst), r32(src)
/** [base + index*4 + disp8] as a ModRM/SIB tail for register field `reg` */
const mi = (reg, base, index, disp = 0) => (disp ? [0x44 | (reg << 3), (2 << 6) | (index << 3) | base, disp & 0xff] : [0x04 | (reg << 3), (2 << 6) | (index << 3) | base]);
function asm(items) {
  const out = [], labels = new Map(), fix = [];
  for (const it of items) {
    if (typeof it === 'string') { labels.set(it, out.length); continue; }
    if (it.j32) { out.push(...it.op); fix.push([out.length, it.j32, 4]); out.push(0, 0, 0, 0); continue; }
    if (it.j) { out.push(it.op); fix.push([out.length, it.j, it.op === 0xe8 ? 4 : 1]); out.push(...(it.op === 0xe8 ? [0, 0, 0, 0] : [0])); continue; }
    out.push(...it);
  }
  for (const [at, l, n] of fix) { const d = labels.get(l) - (at + n); if (n === 1) { if (d < -128 || d > 127) throw new Error('rel8 range ' + l); out[at] = d & 0xff; } else out.splice(at, 4, ...le(d)); }
  out.push(0xc3); // (after the kernel's HLT: a RET, so that the region ends there instead of decoding the zeros after it)
  return Uint8Array.from(out);
}
const jcc = (cc, l) => ({ op: 0x70 + cc, j: l }), jmp = (l) => ({ op: 0xeb, j: l }), call = (l) => ({ op: 0xe8, j: l });
const CC = { B: 2, AE: 3, E: 4, NE: 5, BE: 6, A: 7, S: 8, NS: 9, L: 12, GE: 13, LE: 14, G: 15 };
const cmpImm = (r, v) => [0x81, 0xf8 | r, ...le(v)];

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
const N = 4096;
/** kernels: code, data setup, outer repetitions (EDI-free counters in each) */
const KERNELS = {
  // binary search (lower bound) of random keys in a sorted array: a data-dependent diamond
  bsearch: {
    code: asm([[0xbb, ...le(0)], 'outer', [0x8b, ...mi(EDX, EDI, EBX)], [0xb8, ...le(A)], [0xb9, ...le(N)],
      'L', rr(0x85, ECX, ECX), jcc(CC.E, 'done'), rr(0x89, EBP, ECX), [0xd1, 0xe8 | EBP],
      [0x39, ...mi(EDX, EAX, EBP)], jcc(CC.GE, 'else'), [0x8d, ...mi(EAX, EAX, EBP, 4)], rr(0x29, ECX, EBP), [0x48 + ECX], jmp('L'),
      'else', rr(0x89, ECX, EBP), jmp('L'),
      'done', [0x01, 0x04, 0x24], [0x43], cmpImm(EBX, N), jcc(CC.B, 'outer'), [0xf4]]),
    setup(m) { const v = []; for (let i = 0; i < N; i++) v.push(rnd() >>> 1); v.sort((x, y) => x - y); v.forEach((x, i) => m.write32(A + 4 * i, x)); for (let i = 0; i < N; i++) m.write32(B + 4 * i, rnd() >>> 1); },
    regs: { edi: B },
  },
  // |x| of random values (a data-dependent triangle) summed
  abs: {
    code: asm([[0x31, 0xc9], 'L', [0x8b, ...mi(EAX, ESI, ECX)], rr(0x85, EAX, EAX), jcc(CC.NS, 'pos'), [0xf7, 0xd8], 'pos', rr(0x01, EBX, EAX), [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4]]),
    setup(m) { for (let i = 0; i < N; i++) m.write32(A + 4 * i, rnd()); },
    regs: { esi: A }, reps: 4,
  },
  // a read-modify-write of an array (stores checked for self-modifying code)
  store: {
    code: asm([[0x31, 0xc9], 'L', [0x8b, ...mi(EAX, EDI, ECX)], rr(0x31, EAX, EDX), rr(0x01, EAX, ECX), [0x89, ...mi(EAX, EDI, ECX)], [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4]]),
    setup(m) { for (let i = 0; i < N; i++) m.write32(B + 4 * i, rnd()); },
    regs: { edi: B, edx: 0x5a5a5a5a }, reps: 4,
  },
  // a loop calling a small function (call / ret, push / pop)
  calls: {
    code: asm([[0xb9, ...le(N)], 'L', [0x50 + ECX], call('f'), [0x83, 0xc4, 0x04], rr(0x01, EBX, EAX), [0x48 + ECX], jcc(CC.NE, 'L'), [0xf4],
      'f', [0x8b, 0x44, 0x24, 0x04], [0x8d, 0x04, 0x40], [0xc3]]),
    setup() {}, regs: {}, reps: 4,
  },
  // predictable branches (period 8) in a counting loop
  branchy: {
    code: asm([[0x31, 0xc9], 'L', rr(0x89, EAX, ECX), [0x83, 0xe0, 0x07], [0x83, 0xf8, 0x03], jcc(CC.NE, 's1'), [0x43], 's1', [0x83, 0xf8, 0x05], jcc(CC.B, 's2'), rr(0x01, EDX, EAX), 's2', [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4]]),
    setup() {}, regs: {}, reps: 4,
  },
  // x87: c[i] += a[i] * b[i] (single precision)
  x87: {
    code: asm([[0x31, 0xc9], 'L', [0xd9, ...mi(0, ESI, ECX)], [0xd8, ...mi(1, EDI, ECX)], [0xd8, ...mi(0, EBX, ECX)], [0xd9, ...mi(3, EBX, ECX)], [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4]]),
    setup(m) { for (let i = 0; i < N; i++) { m.writeF32?.(A + 4 * i, 1 + (rnd() & 0xff) / 256) ?? m.write32(A + 4 * i, 0x3f800000); m.write32(B + 4 * i, 0x3f000000); m.write32(C + 4 * i, 0); } },
    regs: { esi: A, edi: B, ebx: C }, reps: 4,
  },
};

// abs with cold code in its region: a branch never taken leads to 40 blocks of 4 instructions, each with a store
// (an SMC-checked exit) or not, ending back in the loop
function coldKernel(stores) {
  const cold = [];
  for (let i = 0; i < 40; i++) {
    cold.push('c' + i, rr(0x01, EDX, EAX), stores ? [0x89, ...mi(EDX, EDI, ECX)] : rr(0x31, EDX, ECX), [0x83, 0xc2, i], jcc(CC.E, 'c' + (i + 1)));
  }
  cold.push('c40', { op: [0xe9], j32: 'pos' });
  return {
    code: asm([[0x31, 0xc9], 'L', [0x8b, ...mi(EAX, ESI, ECX)], rr(0x85, EAX, EAX), jcc(CC.NS, 'pos'), [0xf7, 0xd8], 'pos', rr(0x01, EBX, EAX), cmpImm(EBX, 0x7fffffff), { op: [0x0f, 0x80 + CC.E], j32: 'c0' }, [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4], [0xc3], ...cold]),
    setup(m) { for (let i = 0; i < N; i++) m.write32(A + 4 * i, rnd() >>> 4); },
    regs: { esi: A, edi: B }, reps: 4,
  };
}
// the x87 kernel under 24-bit precision (what Direct3D leaves the FPU in) and 53-bit precision
KERNELS.x87p24 = { ...KERNELS.x87, cw: 0x007f };
KERNELS.x87p53 = { ...KERNELS.x87, cw: 0x027f };
KERNELS.coldst = coldKernel(true);
KERNELS.coldalu = coldKernel(false);
// abs with one cold block of n instructions: stores (mov), read-modify-writes (add [m], dl) or ALU only
function coldBlock(n, kind) {
  const ins = kind === 'mov' ? [0x89, ...mi(EDX, EDI, ECX)] : kind === 'rmw' ? [0x00, ...mi(EDX, EDI, ECX)] : rr(0x01, EDX, ECX);
  const cold = ['c0']; for (let i = 0; i < n; i++) cold.push(ins);
  cold.push({ op: [0xe9], j32: 'pos' });
  return {
    code: asm([[0x31, 0xc9], 'L', [0x8b, ...mi(EAX, ESI, ECX)], rr(0x85, EAX, EAX), jcc(CC.NS, 'pos'), [0xf7, 0xd8], 'pos', rr(0x01, EBX, EAX), cmpImm(EBX, 0x7fffffff), { op: [0x0f, 0x80 + CC.E], j32: 'c0' }, [0x41], cmpImm(ECX, N), jcc(CC.B, 'L'), [0xf4], [0xc3], ...cold]),
    setup(m) { for (let i = 0; i < N; i++) m.write32(A + 4 * i, rnd() >>> 4); },
    regs: { esi: A, edi: B }, reps: 4,
  };
}
for (const n of [50, 150, 350]) for (const k of ['mov', 'rmw', 'alu']) KERNELS[`cold${k}${n}`] = coldBlock(n, k);

function runKernel(k, opts, reps) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.writeBytes(CODE, k.code); seed = 12345; k.setup(mem);
  if (k.cw !== undefined) mem.write16(cpu.base + ST.FPU_CW, k.cw);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...opts }); jit.cpu = cpu;
  const end = CODE + k.code.indexOf(0xf4);
  let best = Infinity, insns = 0;
  for (let rep = 0; rep < reps; rep++) {
    cpu.eip = CODE; cpu.esp = STACK; cpu.eflags = F.RESERVED1 | F.IF; cpu.eax = cpu.ecx = cpu.edx = cpu.ebx = cpu.ebp = 0;
    for (const [r, v] of Object.entries(k.regs)) cpu[r] = v;
    mem.write32(STACK, 0);
    let n = 0, r;
    const t0 = performance.now();
    for (let i = 0; i < (k.reps ?? 1) * 40; i++) {
      cpu.eip = CODE; for (const [rg, v] of Object.entries(k.regs)) cpu[rg] = v; cpu.ecx = k === KERNELS.calls ? 0 : cpu.ecx;
      do { r = jit.run({ stopAt: end, maxInsns: 1e9 }); n += 1e9 - jit.remaining(); } while (r === EXIT.TIMESLICE);
      if (r !== EXIT.HALT) throw new Error(`exit ${r} at ${cpu.eip.toString(16)}`);
    }
    const t = performance.now() - t0;
    if (rep > 0 && t < best) best = t; // (the first repetition translates)
    if (process.env.SHAPE_TRACE) console.log(`  rep ${rep}: ${(t * 1e6 / n).toFixed(3)} ns/insn (${t.toFixed(1)} ms)`);
    insns = n;
  }
  return best * 1e6 / insns;
}

if (opt('trace')) { process.env.SHAPE_TRACE = '1'; const k = KERNELS[opt('trace')]; runKernel(k, JSON.parse(opt('opts', '{}')), 25); process.exit(0); }
const optsA = JSON.parse(opt('opts', '{}')), optsB = opt('vs') ? JSON.parse(opt('vs')) : null;
const only = opt('only') ? opt('only').split(',') : Object.keys(KERNELS);
let gA = 0, gB = 0, n = 0;
for (const name of only) {
  const k = KERNELS[name];
  const a = [], b = [];
  for (let i = 0; i < 7; i++) { a.push(runKernel(k, optsA, 3)); if (optsB) b.push(runKernel(k, optsB, 3)); }
  const ma = Math.min(...a), mb = optsB ? Math.min(...b) : 0;
  gA += Math.log(ma); if (optsB) gB += Math.log(mb); n++;
  console.log(`${name.padEnd(8)} ${ma.toFixed(3)} ns/insn${optsB ? `  vs ${mb.toFixed(3)}  ratio ${(ma / mb).toFixed(3)}` : ''}`);
}
console.log(`geomean ${Math.exp(gA / n).toFixed(3)}${optsB ? ` vs ${Math.exp(gB / n).toFixed(3)} ratio ${Math.exp((gA - gB) / n).toFixed(3)}` : ''}`);

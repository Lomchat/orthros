#!/usr/bin/env node
// String instruction microbenchmark: ns per REP MOVS / REP STOS instruction under the JIT, for element counts from
// 1 to 4096, byte and dword elements, both directions (DF=1 with ESI/EDI at the last element: the backward copy a C
// runtime's memmove does for overlapping buffers), non-overlapping and overlapping ranges. Each case is a loop
// `L: mov esi, S ; mov edi, D ; mov ecx, N ; [std] ; rep movs/stos ; [cld] ; dec ebx ; jnz L ; hlt`; the loop
// overhead (the same loop without the string instruction) is measured too and subtracted. Median of 7 runs.
// Usage: node tools/strop-bench.mjs [filter substring]
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, BUF = 0x10000000;
const mem = new GuestMemory();
const cpu = new CpuState(mem, THREAD_STATES_BASE);
cpu.reset();
const filter = process.argv[2] ?? '';
const le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
const OPS = { movsb: [0xf3, 0xa4], movsd: [0xf3, 0xa5], stosb: [0xf3, 0xaa], stosd: [0xf3, 0xab], none: [] };

/** ns per iteration of the loop for one case */
function run(op, sz, n, back, dstOff, reps, eax = 0x11223344) {
  const last = back ? (n - 1) * sz : 0;
  const src = BUF + 0x10000 + last, dst = BUF + 0x10000 + dstOff + last;
  const body = [0xbe, ...le(src), 0xbf, ...le(dst), 0xb9, ...le(n), ...(back ? [0xfd] : []), ...OPS[op], ...(back ? [0xfc] : []), 0x4b];
  const code = Uint8Array.from([...body, 0x75, (-(body.length + 2)) & 255, 0xf4]);
  mem.writeBytes(CODE, code);
  mem.fill(BUF, 0x40000, 0x5a);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true }); jit.cpu = cpu;
  const end = CODE + code.length - 1;
  const times = [];
  for (let r = -1; r < 7; r++) { // run -1 translates (and warms up) the loop
    cpu.eip = CODE; cpu.esp = BUF + 0x3f000; cpu.ebx = r < 0 ? 100 : reps; cpu.eax = eax; cpu.eflags = F.RESERVED1 | F.IF;
    const t0 = performance.now();
    let x; do x = jit.run({ stopAt: end, maxInsns: 2e9 }); while (x === EXIT.TIMESLICE);
    if (r >= 0) times.push(performance.now() - t0);
    if (x !== EXIT.HALT) throw new Error('exit ' + x);
  }
  times.sort((a, b) => a - b);
  return { med: times[3] * 1e6 / reps, lo: times[0] * 1e6 / reps, hi: times[6] * 1e6 / reps };
}

const REPS = 200000;
const base = run('none', 4, 1, false, 0x8000, REPS);
console.log(`loop overhead: ${base.med.toFixed(2)} ns/iter (subtracted below; min..max of 7 runs in brackets)`);
const cases = [];
const OV = ['', ' overlap(memmove-safe)', ' overlap(replicating)'];
for (const op of ['movsd', 'movsb', 'stosd', 'stosb']) {
  const sz = op.endsWith('d') ? 4 : 1;
  for (const back of [false, true]) {
    for (const ov of op.startsWith('movs') ? [0, 1, 2] : op === 'stosd' ? [0, 3] : [0]) {
      const name = `${op} ${back ? 'bwd' : 'fwd'}${ov === 3 ? ' eax=0(memset)' : OV[ov]}`;
      if (!name.includes(filter)) continue;
      cases.push([name, op, sz, back, ov]);
    }
  }
}
for (const [name, op, sz, back, ov] of cases) {
  const cols = [];
  for (const n of [1, 4, 16, 64, 256, 4096]) {
    // memmove-safe overlap: backward copies to a higher address, forward to a lower (what memmove picks the
    // direction for); replicating: the other way round (x86 element order repeats the first elements)
    const dstOff = ov === 1 ? (back ? 3 : -3) : ov === 2 ? (back ? -3 : 3) : 0x8000;
    const reps = Math.max(2000, Math.min(REPS, (REPS * 16 / n) | 0));
    const t = run(op, sz, n, back, dstOff, reps, ov === 3 ? 0 : 0x11223344);
    cols.push(`n=${n}: ${(t.med - base.med).toFixed(1)} [${(t.lo - base.med).toFixed(1)}..${(t.hi - base.med).toFixed(1)}]`);
  }
  console.log(`${name.padEnd(32)} ${cols.join('  ')}`);
}

#!/usr/bin/env node
// Region chaining microbenchmark: ns per call/return pair between regions (a function whose entry and return site are
// region boundaries: every iteration chains three times — the call, the return, the loop's jump back from the return
// site's region to the call's), for integer regions and for x87 regions
// (each side touches the x87 stack: the cached stack is flushed and reloaded at every transition).
// `--opts <json>`: translation options (JIT_DEFAULTS keys, e.g. '{"nestCalls":true}'); `--local-ret`: the call's return
// site in the caller's region (only the callee's entry is a boundary: the call leaves the region, its RET comes back
// into it — the shape nestCalls applies to; by default the return site is a region of its own).
// Usage: node tools/bench/chain-bench.mjs [iterations] [--opts <json>] [--local-ret] [--kinds int,x87]
import './node-wasm-flags.mjs'; // (branch hints honoured, as in Chrome)
import { GuestMemory } from '../../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../../src/cpu/state.js';
import { Interp } from '../../src/cpu/interp.js';
import '../../src/cpu/interp-x87.js';
import { Jit } from '../../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1]; };
// `--pre`: the callee translated first (the call's static exit to it can be linked: opts.linkExits; the loop's jump back is
// linked whenever the return site's region is translated after the loop's)
const pre = args.includes('--pre'); if (pre) args.splice(args.indexOf('--pre'), 1);
const localRet = args.includes('--local-ret'); if (localRet) args.splice(args.indexOf('--local-ret'), 1);
const OPTS = JSON.parse(flag('--opts') ?? '{}');
const KINDS = (flag('--kinds') ?? 'int,x87').split(','); // ('int', 'x87': which programs)
const N = +(args[0] ?? 2e6);
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

function program(x87) {
  // main: mov ecx, N ; L: [fld m32 ; fstp m32] call F ; R: dec ecx ; jnz L ; hlt       F: add eax, 1 ; [fld1 ; fstp st0] ; ret
  const main = [0xb9, ...le(N)];
  const loop = main.length;
  if (x87) main.push(0xd9, 0x05, ...le(DATA), 0xd9, 0x1d, ...le(DATA + 4));
  const callAt = main.length;
  main.push(0xe8, 0, 0, 0, 0);
  const ret = main.length;
  main.push(0x49, 0x0f, 0x85, 0, 0, 0, 0);
  const jnzEnd = main.length;
  main.push(0xf4);
  const f = main.length + 16;
  while (main.length < f) main.push(0x90);
  main.push(0x83, 0xc0, 0x01);
  if (x87) main.push(0xd9, 0xe8, 0xdd, 0xd8);
  main.push(0xc3);
  const rel = (from, to) => le(to - from);
  main.splice(callAt + 1, 4, ...rel(callAt + 5, f));
  main.splice(jnzEnd - 4, 4, ...rel(jnzEnd, loop));
  return { bytes: Uint8Array.from(main), f: CODE + f, ret: CODE + ret, end: CODE + jnzEnd };
}

for (const x87 of KINDS.map((k) => k === 'x87')) {
  const p = program(x87);
  let best = Infinity;
  for (let rep = 0; rep < 5; rep++) {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    mem.writeBytes(CODE, p.bytes);
    cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...OPTS });
    jit.cpu = cpu; jit.boundaries = new Set(localRet ? [p.f, p.end] : [p.f, p.ret, p.end]);
    if (pre) jit.translate(p.f);
    const t0 = performance.now();
    let r;
    do r = jit.run({ stopAt: p.end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
    const ms = performance.now() - t0;
    if (r !== EXIT.HALT) throw new Error(`exit ${r}`);
    best = Math.min(best, ms);
  }
  console.log(`${x87 ? 'x87' : 'int'}: ${(best * 1e6 / N).toFixed(1)} ns per call/return (${localRet ? 2 : 3} chained transitions: call, return${localRet ? '' : ', the loop\'s jump back'})`);
}

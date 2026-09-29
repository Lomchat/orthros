#!/usr/bin/env node
// x87 loop microbenchmark: ns per iteration of small loops shaped like x87 compiler output under a chosen control
// word (default 0x007f, the Direct3D FPU mode: 24-bit precision, round to nearest; 0x0c7f the same truncating, as
// code that sets the rounding control once for its FISTPs runs; 0x027f the MSVC default): FCOM-family compares whose
// condition reaches the integer side through FNSTSW AX + TEST AH,imm / SAHF + JCC, x87 values living across the
// blocks such branches create, a vertex transform, a latency-bound recurrence, the e^x sequence, FILD. Every case reads
// its operand from a 1024-entry float table indexed by the loop counter; `rand` tables hold random signs, `pos` tables
// only positive values. Each case: ecx = N iterations, esi -> table, edi -> constants (+0: 0.0f, +4: 0.5f, +8: 3.0f,
// +0x100: a 4x4 float matrix), ebx -> output table; ends on HLT. Results are checked against the interpreter first.
// Usage: node tools/x87loop-bench.mjs [iterations] [--runs 7] [--cw 0x7f] [--cases name,...] [--pos|--rand] [--ab <dir>]
//   --ab <dir>: A/B in one process — <dir>/src (an extraction of the src tree of an earlier revision) against this
//   tree's src, runs alternated (base, new, base, new...) so that both see the same machine load.
//   --stats: interpreter steps (EXIT_STEP) per iteration; --no-warm: no discarded first round.
// On a loaded shared machine wall-clock times drift by +-30 % between runs; cycles spent in the translated region are
// steadier: run one case with `perf record -e cycles:u` on `node --no-liftoff --perf-prof tools/x87loop-bench.mjs N
// --runs 1 --no-warm --cases <case> --pos`, `perf inject -j`, and divide the period of the JS:r_* symbols by 2N (each
// run executes the loop twice: warm-up and timed).
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

async function loadImpl(root) {
  const u = (f) => pathToFileURL(path.join(root, 'src', f)).href;
  const [{ GuestMemory }, { CpuState, THREAD_STATES_BASE, EXIT, F, ST }, { Interp }, , { Jit }] = await Promise.all([
    import(u('cpu/memory.js')), import(u('cpu/state.js')), import(u('cpu/interp.js')), import(u('cpu/interp-x87.js')), import(u('cpu/jit/jit.js'))]);
  return { GuestMemory, CpuState, THREAD_STATES_BASE, EXIT, F, ST, Interp, Jit };
}

const CODE = 0x20000000, DATA = 0x10000000, TAB = DATA, CONST = DATA + 0x1000, OUT = DATA + 0x2000;
const args = process.argv.slice(2);
const N = +(args.find((a, i) => /^\d+$/.test(a) && !['--runs', '--cw'].includes(args[i - 1])) ?? 1e7);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const RUNS = +opt('--runs', 7);
const CW = parseInt(opt('--cw', '0x7f'), 16);
const ONLY = opt('--cases', null)?.split(',');
const AB = opt('--ab', null);
const NEW = await loadImpl(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = AB ? await loadImpl(path.resolve(AB)) : null;
const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));

// common loop head: mov eax, ecx ; and eax, 1023  (89c8 25ff030000), tail: dec ecx ; jnz L ; hlt
const HEAD = '89c8 25ff030000';
/** head + body + dec ecx ; jnz L ; hlt (the back-edge displacement computed) */
function loop(text) {
  const [pre, body] = text.includes('|') ? text.split('|') : ['', text]; // (code before the loop: 'pre | body')
  const p = pre.trim() ? [...hex(pre)] : [], b = hex(HEAD + body);
  if (b.length + 3 <= 128) return Uint8Array.from([...p, ...b, 0x49, 0x75, -(b.length + 3) & 0xff, 0xf4]);
  const rel = -(b.length + 7); // jnz rel32
  return Uint8Array.from([...p, ...b, 0x49, 0x0f, 0x85, rel & 0xff, (rel >> 8) & 0xff, (rel >> 16) & 0xff, (rel >>> 24) & 0xff, 0xf4]);
}
const d32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24].map((b) => b.toString(16).padStart(2, '0')).join('');
function xformBody() {
  let h = '';
  for (let r = 0; r < 3; r++) {
    h += 'd90486' + 'd88f' + d32(0x100 + 4 * r) + 'd9448604' + 'd88f' + d32(0x110 + 4 * r) + 'dec1';
    h += 'd9448608' + 'd88f' + d32(0x120 + 4 * r) + 'dec1' + 'd887' + d32(0x130 + 4 * r) + 'd95c83' + (4 * r).toString(16).padStart(2, '0');
  }
  return h;
}
const CASES = [
  // fld [esi+eax*4] ; fcomp [edi] ; fnstsw ax ; test ah, 41h ; jnz S ; inc edx ; S:       (x <= 0 ?)
  ['fcomp+test ah', 'd90486 d81f dfe0 f6c441 7501 42'],
  // mov ebx, [esi+eax*4] ; cmp ebx, [edi] ; jle S ; inc edx ; S:   (reference: the same control flow, integer compare)
  ['  ref: integer cmp', '8b1c86 3b1f 7e01 42'],
  // fld [esi+eax*4] ; fcomp [edi] ; fnstsw ax ; sahf ; jae S ; inc edx ; S:                (x < 0 ?)
  ['fcomp+sahf', 'd90486 d81f dfe0 9e 7301 42'],
  // fld [edi] ; fld [esi+eax*4] ; fucompp ; fnstsw ax ; test ah, 44h ; jpe S ; inc edx ; S:   (x != 0 or unordered ?)
  ['fucompp+test 44', 'd907 d90486 dae9 dfe0 f6c444 7a01 42'],
  // fld [esi+eax*4] ; fcom [edi+4] ; fnstsw ax ; test ah, 5 ; jp S ; fchs ; S: fstp [ebx+eax*4]   (value across the branch)
  ['fcom+fchs+fstp', 'd90486 d84f04 dfe0 f6c405 7a02 d9e0 d91c83'],
  // fld [esi+eax*4] ; fmul [edi+8] ; fadd [edi+4] ; fcom [edi] ; fnstsw ax ; test ah, 1 ; jz P ; fchs ; P: fmul st, st(0) ;
  // fadd [edi+4] ; fstp [ebx+eax*4]                            (f32 arithmetic on both sides of a block boundary)
  ['arith across blocks', 'd90486 d84f08 d84704 d817 dfe0 f6c401 7402 d9e0 dcc8 d84704 d91c83'],
  // same without the branch (reference: one block)
  ['  ref: one block', 'd90486 d84f08 d84704 d817 dfe0 f6c401 d9e1 dcc8 d84704 d91c83'],
  // fld [esi+eax*4] ; fmul [edi+4] ; e^x (fldl2e ; fmulp ; fld st0 ; frndint ; fsub st(1), st ; fxch ; f2xm1 ; fld1 ;
  // faddp ; fscale ; fstp st(1)) ; fadd [edi+8] ; fstp [ebx+eax*4]      (the x87 exp sequence inside arithmetic)
  ['exp in loop', 'd90486 d84f04 d9ea dec9 d9c0 d9fc dce9 d9c9 d9f0 d9e8 dec1 d9fd ddd9 d84708 d91c83'],
  // a vertex transform: per output component r, fld [esi+eax*4] ; fmul [edi+M+4r] ; fld [esi+eax*4+4] ;
  // fmul [edi+M+16+4r] ; faddp ; fld [esi+eax*4+8] ; fmul [edi+M+32+4r] ; faddp ; fadd [edi+M+48+4r] ; fstp [ebx+eax*4+4r]
  // (M = 0x100: a 4x4 float matrix; the arithmetic of x87 3D code, e.g. under --cw 0xc7f, truncation)
  ['xform', xformBody()],
  // fldz | L: fmul [edi+4] ; fadd [esi+eax*4]      (a recurrence acc = acc * 0.5 + x: latency-bound, one rounding per op)
  ['recurrence', 'd9ee | d84f04 d80486'],
  // fild word [esi+eax*2] (the table's halves as 16-bit integers) ; fmul [edi+4] ; fadd [edi+8] ; fstp [ebx+eax*4]
  ['fild+fmul+fstp', 'df0446 d84f04 d84708 d91c83'],
];

function setup({ ST, F }, mem, cpu, bytes, rand) {
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  let s = 12345;
  for (let k = 0; k < 1024; k++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const v = ((s >>> 8) & 0xffff) / 4096 + 0.125;
    mem.writeF32(TAB + 4 * k, rand && (s & 0x80000000) ? -v : v);
  }
  mem.writeF32(CONST, 0); mem.writeF32(CONST + 4, 0.5); mem.writeF32(CONST + 8, 3);
  for (let i = 0; i < 16; i++) mem.writeF32(CONST + 0x100 + 4 * i, 0.5 + 0.37 * Math.sin(i + 1)); // (xform's matrix)
  mem.write16(cpu.base + ST.FPU_CW, CW);
  cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.esi = TAB; cpu.edi = CONST; cpu.ebx = OUT; cpu.edx = 0;
  cpu.eflags = F.RESERVED1 | F.IF;
}

function check(impl, name, bytes, rand) {
  const { GuestMemory, CpuState, THREAD_STATES_BASE, Interp, Jit, EXIT, ST } = impl;
  const n = 1000, end = CODE + bytes.length - 1;
  const st = [];
  for (const useJit of [false, true]) {
    const mem = new GuestMemory();
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    setup(impl, mem, cpu, bytes, rand); cpu.ecx = n;
    const I = new Interp(mem, cpu);
    let r;
    if (useJit) { const jit = new Jit(mem, I); jit.cpu = cpu; do r = jit.run({ stopAt: end, maxInsns: 1e9 }); while (r === EXIT.TIMESLICE); } else r = I.run({ stopAt: end });
    st.push([cpu.edx, cpu.eax & 0xffff, Array.from({ length: 260 }, (_, k) => mem.read32(OUT + 4 * k)).join(), mem.read16(cpu.base + ST.FPU_SW)].join('|'));
  }
  if (st[0] !== st[1]) throw new Error(`${name}: JIT and interpreter differ`);
}

async function once(impl, bytes, rand) {
  const { GuestMemory, CpuState, THREAD_STATES_BASE, Interp, Jit, EXIT } = impl;
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  setup(impl, mem, cpu, bytes, rand);
  const jit = new Jit(mem, new Interp(mem, cpu)); jit.cpu = cpu;
  const end = CODE + bytes.length - 1;
  let r;
  cpu.ecx = N;
  do r = jit.run({ stopAt: end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE); // warm-up: translation, then
  await new Promise((res) => setTimeout(res, 100)); // V8's background tier-up of the region to optimized code
  cpu.eip = CODE; cpu.ecx = N;
  const t0 = performance.now();
  do r = jit.run({ stopAt: end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error('exit ' + r);
  if (args.includes('--stats')) console.log(`  interpreter steps (EXIT_STEP) per iteration: ${((jit.stats.steps ?? 0) / (2 * N)).toFixed(3)}`);
  return (ms * 1e6) / N;
}

console.log(`x87 loops, control word 0x${CW.toString(16)}, ${N} iterations, ${RUNS} runs: median [min..max] ns/iter${AB ? `, A/B against ${AB} (alternated)` : ''}`);
const impls = BASE ? [BASE, NEW] : [NEW];
for (const [name, h] of CASES) for (const rand of [false, true]) for (const impl of impls) check(impl, name, loop(h), rand);
const selected = (name) => !ONLY || ONLY.includes(name.trim());
if (!args.includes('--no-warm')) for (const [name, h] of CASES) if (selected(name)) for (const impl of impls) await once(impl, loop(h), true); // discarded round (see flags-bench.mjs)
const stat = (t) => { t.sort((a, b) => a - b); return `${t[t.length >> 1].toFixed(2).padStart(6)} [${t[0].toFixed(2)}..${t[t.length - 1].toFixed(2)}]`; };
for (const [name, h] of CASES) {
  if (!selected(name)) continue;
  for (const rand of args.includes('--rand') ? [true] : args.includes('--pos') ? [false] : [false, true]) {
    const t = impls.map(() => []);
    for (let k = 0; k < RUNS; k++) for (let j = 0; j < impls.length; j++) t[j].push(await once(impls[j], loop(h), rand));
    const med = t.map((x) => [...x].sort((a, b) => a - b)[x.length >> 1]);
    console.log(`${name.padEnd(22)} ${rand ? 'rand' : 'pos '}  ${AB ? `base ${stat(t[0])}  new ${stat(t[1])}  ${((med[1] / med[0] - 1) * 100).toFixed(1).padStart(6)} %` : stat(t[0])}`);
  }
}

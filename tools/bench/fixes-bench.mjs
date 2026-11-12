#!/usr/bin/env node
// Targeted translation fixes (docs/jit-code-shape.md "Targeted fixes"): small loops, each the pattern one JIT option
// changes — single MOVS / STOS (strSmcOne), CDQ ; IDIV and XOR EDX, EDX ; DIV (divFast), an MMX pixel loop
// (mmxTopOnce), stores to the fields of one structure (smcGroup) — run with the options of --a and --b (JSON, the
// translator's JIT_DEFAULTS keys), alternated in one process: median ns per iteration.
// --perf: host instructions per iteration in the translated regions instead (perf record of a child process,
// the samples of V8's r_* functions, --perf-basic-prof; deterministic to ~1 %).
// Usage: node tools/bench/fixes-bench.mjs [iterations] [--runs 7] [--only <substring>] [--a <opts>] [--b <opts>] [--perf]
// (defaults: --a the four fixes off, --b on; e.g. --b '{"apiInline":true}' --only thunk for the API case)
import './node-wasm-flags.mjs'; // (branch hints honoured, as in Chrome)
import { spawnSync } from 'node:child_process';
const { GuestMemory, THUNK_BASE } = await import('../../src/cpu/memory.js');
const { CpuState, THREAD_STATES_BASE, EXIT, F } = await import('../../src/cpu/state.js');
const { Interp } = await import('../../src/cpu/interp.js');
const { Jit } = await import('../../src/cpu/jit/jit.js');

const CODE = 0x20000000, DATA = 0x10000000;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = +(args.find((a, i) => /^\d/.test(a) && !['--runs', '--only', '--a', '--b'].includes(args[i - 1])) ?? 2e6);
const RUNS = +opt('--runs', 7), ONLY = opt('--only', null);
const A = opt('--a', '{"strSmcOne":false,"divFast":false,"mmxTopOnce":false,"smcGroup":false}'), B = opt('--b', '{"strSmcOne":true,"divFast":true,"mmxTopOnce":true,"smcGroup":true}');
const hex = (s) => s.replace(/\s+/g, '');
const rep = (s, n) => hex(s).repeat(n);
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24].map((b) => b.toString(16).padStart(2, '0')).join('');
// every case: L: <body> ; dec ecx ; jnz L ; hlt (ecx = N, esi -> data, edi -> data + 0x1000, ebx = 7, mm1 / mm2 set)
const CASES = [
  ['empty loop', ''],
  ['8x movsd (esi, edi reset)', 'be' + le(DATA) + 'bf' + le(DATA + 0x1000) + rep('a5', 8)],
  ['8x stosd (edi reset)', 'bf' + le(DATA + 0x1000) + rep('ab', 8)],
  ['8x movsb (esi, edi reset)', 'be' + le(DATA) + 'bf' + le(DATA + 0x1000) + rep('a4', 8)],
  ['4x (mov eax, ecx ; cdq ; idiv ebx ; add esi, edx)', rep('89c8 99 f7fb 01d6', 4)],
  ['4x (mov eax, ecx ; xor edx, edx ; div ebx ; add esi, edx)', rep('89c8 31d2 f7f3 01d6', 4)],
  ['4x (mov eax, ecx ; cdq ; idiv dword [edi] ; add esi, eax)', rep('89c8 99 f73f 01c6', 4)],
  ['4x MMX pixel (movq, punpcklbw, pmullw, psrlw, packuswb, movd)', rep('0f6f06 0f60c3 0fd5c1 0f71d002 0f67c0 0f7e07', 4)],
  ['8x mov [edi+4k], eax', '894704 894708 89470c 894710 894714 894718 89471c 894720'.replace(/ /g, '')],
  ['struct (4 stores, rmw, byte) x2', rep('894704 895708 015f0c 884710', 2)],
  ['8x (mov [edi+4], eax ; mov edx, [esi+0x100])', rep('894704 8b9600010000', 8)],
  // a fast-path API through a register (GetCurrentThreadId's thunk, index 1), as a COM method through its vtable (apiInline)
  ['4x (mov eax, thunk ; call eax ; add esi, eax)', rep('b8' + le(THUNK_BASE + 16) + 'ffd0 01c6', 4)],
];
function build(body) {
  const b = [];
  for (const x of hex(body).match(/../g) ?? []) b.push(parseInt(x, 16));
  b.push(0x49, 0x0f, 0x85, 0, 0, 0, 0);
  const rel = -b.length; for (let k = 0; k < 4; k++) b[b.length - 4 + k] = (rel >> (8 * k)) & 0xff;
  const end = b.length; b.push(0xf4, 0xcc); // (HLT then INT3: the region stops there)
  return { bytes: Uint8Array.from(b), end: CODE + end };
}
function make(p, opts, n) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.writeBytes(CODE, p.bytes);
  for (let i = 0; i < 0x2000; i += 4) mem.write32(DATA + i, (i * 2654435761) >>> 0 | 1);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...opts }); jit.cpu = cpu;
  jit.markFast(1, 'kernel32.dll!GetCurrentThreadId', true); cpu.fsBase = DATA + 0x4000; mem.write32(DATA + 0x4024, 0x800);
  const reset = () => {
    cpu.eip = CODE; cpu.ecx = n; cpu.eax = 1; cpu.ebx = 7; cpu.edx = 0; cpu.esi = DATA; cpu.edi = DATA + 0x1000;
    cpu.esp = DATA + 0x10000; cpu.ebp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
    mem.write32(cpu.base + 0x180 + 8, 0x00030003); mem.write32(cpu.base + 0x180 + 12, 0x00030003); mem.write32(cpu.base + 0x180 + 24, 0);
  };
  const run = () => { let r; reset(); do r = jit.run({ stopAt: p.end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE); if (r !== EXIT.HALT || cpu.ecx !== 0) throw new Error('exit ' + r); };
  return { run, mem };
}
async function once(p, opts) {
  const m = make(p, opts, N);
  m.run(); await new Promise((res) => setTimeout(res, 100)); // (translation, then V8's tier-up)
  const t0 = performance.now(); m.run(); return ((performance.now() - t0) * 1e6) / N;
}
if (args[0] === '--child') { // --child <case index> <opts> <n>: translate and run once (under perf stat)
  const m = make(build(CASES[+args[1]][1]), JSON.parse(args[2]), +args[3]);
  m.run(); process.exit(0);
}
const all = CASES.map(([n, h], i) => [n, build(h), i]).filter(([n]) => !ONLY || n.includes(ONLY) || n === 'empty loop');
// host instructions in the translated regions (perf's samples of the r_* functions, --perf-basic-prof) per iteration
const insns = (i, o, n) => {
  const f = `/tmp/orthros-fixes-bench-${process.pid}.perf`;
  const r = spawnSync('perf', ['record', '-q', '-e', 'instructions:u', '-c', '1000000', '-o', f, process.execPath, '--no-liftoff', '--perf-basic-prof', new URL(import.meta.url).pathname, '--child', String(i), o, String(n)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const rep = spawnSync('perf', ['report', '-i', f, '--sort', 'sym', '-n', '--stdio'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  let k = 0;
  for (const line of rep.stdout.split('\n')) { const m = /^\s+[\d.]+%\s+(\d+)\s+\[.\]\s+(.*)$/.exec(line); if (m && /(^|[:\s])r_[0-9a-f]+/.test(m[2])) k += Number(m[1]); }
  spawnSync('rm', ['-f', f]);
  return (k * 1e6) / n; // (one sample per 10^6: a smaller period loses samples to the kernel's rate limit)
};
for (const [name, p, i] of all) {
  if (args.includes('--perf')) {
    const per = (o) => insns(i, o, N);
    const ra = [], rb = []; for (let k = 0; k < Math.max(1, RUNS >> 2); k++) { ra.push(per(A)); rb.push(per(B)); }
    const med = (t) => t.sort((x, y) => x - y)[t.length >> 1];
    console.log(`${name.padEnd(64)} A ${med(ra).toFixed(1)} / B ${med(rb).toFixed(1)} host instructions per iteration`);
    continue;
  }
  await once(p, JSON.parse(A)); await once(p, JSON.parse(B));
  const ta = [], tb = [];
  for (let k = 0; k < RUNS; k++) { ta.push(await once(p, JSON.parse(A))); tb.push(await once(p, JSON.parse(B))); }
  ta.sort((x, y) => x - y); tb.sort((x, y) => x - y);
  const ma = ta[ta.length >> 1], mb = tb[tb.length >> 1];
  console.log(`${name.padEnd(64)} A ${ma.toFixed(2)} / B ${mb.toFixed(2)} ns/iter (${(((mb - ma) / ma) * 100).toFixed(1)} %)`);
}

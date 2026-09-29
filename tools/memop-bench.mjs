#!/usr/bin/env node
// Memory-operand / stack microbenchmark: ns per iteration of small integer loops, each case differing from a
// reference loop by one kind of memory access (loads, MOVZX, stores and their SMC check, read-modify-write ALU ops,
// PUSH/POP runs, a call/return with a frame inside the region, LEA), so that the difference between a case and
// its reference is the cost of that access as the JIT emits it. With --nosmc the translations skip the SMC check
// on stores (unsafe; to measure what the check costs). Loops run 8 copies of the measured instruction group.
// WASM branch hints are turned on (as Chrome ships them; Node 24 keeps them behind a flag): the translations mark
// their cold paths (SMC exits, budget exits) unlikely, which decides V8's block layout; --no-hints leaves them off.
// Usage: node tools/memop-bench.mjs [iterations] [--runs 7] [--nosmc] [--no-hints] [--only <substring>]
import v8 from 'node:v8';
if (!process.argv.includes('--no-hints')) v8.setFlagsFromString('--experimental-wasm-branch-hinting');
const { GuestMemory } = await import('../src/cpu/memory.js'); // (after the flag: dynamic imports)
const { CpuState, THREAD_STATES_BASE, EXIT, F } = await import('../src/cpu/state.js');
const { Interp } = await import('../src/cpu/interp.js');
const { Jit } = await import('../src/cpu/jit/jit.js');

const CODE = 0x20000000, DATA = 0x10000000;
const args = process.argv.slice(2);
const N = +(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs' && args[i - 1] !== '--only') ?? 5e6);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = +opt('--runs', 7);
const ONLY = opt('--only', null);
const SMC = !args.includes('--nosmc');
const hex = (s) => s.replace(/\s+/g, '');
const rep = (s, n = 8) => hex(s).repeat(n);

// every case: L: <body> ; dec ecx ; jnz L ; hlt  (ecx = N, esi/edi -> data, esp -> a stack page, ebp = esp)
// 49 = dec ecx ; 0f85 rel32 = jnz (filled in), f4 = hlt
const CASES = [
  ['empty loop', ''],
  ['8x mov eax, [esi+4]', rep('8b4604')],
  ['8x mov eax, [esi+ebx*4+8]', rep('8b449e08')],
  ['8x movzx eax, byte [esi+5]', rep('0fb64605')],
  ['8x mov [edi+4], eax', rep('894704')],
  ['8x mov byte [edi+5], al', rep('884705')],
  ['8x mov [edi+4*k], eax', '894704 894708 89470c 894710 894714 894718 89471c 894720'.replace(/ /g, '')],
  ['8x (mov [edi+4],eax ; mov edx,[esi+0x100])', rep('894704 8b9600010000')],
  ['8x (mov [esp+8],eax ; mov edx,[esi+0x100])', rep('89442408 8b9600010000')],
  ['8x mov [ebp-8], eax', rep('8945f8')],
  ['8x mov [esp+8], eax', rep('89442408')],
  ['8x add [edi+8], eax', rep('014708')],
  ['8x movups [edi+16], xmm0', rep('0f114710')],
  ['8x fst dword [edi+4]', rep('d95704')],
  ['8x add eax, [esi+8]', rep('034608')],
  ['8x (cmp dword [esi+8], 0 ; jz +0)', rep('837e0800 7400')],
  ['8x (cmp eax, [esi+8] ; jne +0)', rep('3b4608 7500')],
  ['8x (test byte [esi+5], 1 ; jnz +0)', rep('f6460501 7500')],
  ['8x (movzx edx, byte [esi+5] ; test edx, edx ; jz +0)', rep('0fb65605 85d2 7400')],
  ['8x lea eax, [esi+ebx*4+8]', rep('8d449e08')],
  ['8x (push eax ; pop edx)', rep('50 5a')],
  ['8x (push 4 regs ; pop 4)', rep('50 53 56 57 5f 5e 5b 5a')],
  ['8x (push 3 ; add esp, 12)', rep('50 53 6a01 83c40c')],
  ['8x (push [esi+4] ; pop edx)', rep('ff7604 5a')],
];
// call/return within the region: body = 4x (push eax ; push ebx ; call F ; add esp, 8), F after the hlt:
// F: push ebp ; mov ebp, esp ; mov eax, [ebp+8] ; add eax, [ebp+12] ; pop ebp ; ret
const CALLF = { name: '4x call F(a,b) with frame', body: 4 };

function build(body, call) {
  const b = [];
  const bytes = (h) => { for (const x of h.match(/../g) ?? []) b.push(parseInt(x, 16)); };
  const calls = [];
  if (call) for (let k = 0; k < call.body; k++) { bytes('50 53'.replace(/ /g, '')); calls.push(b.length); bytes('e800000000'); bytes('83c408'); }
  else bytes(body);
  b.push(0x49, 0x0f, 0x85, 0, 0, 0, 0);
  const jEnd = b.length; const rel = -jEnd;
  b[jEnd - 4] = rel & 0xff; b[jEnd - 3] = (rel >> 8) & 0xff; b[jEnd - 2] = (rel >> 16) & 0xff; b[jEnd - 1] = (rel >>> 24) & 0xff;
  const end = b.length; b.push(0xf4);
  const f = b.length;
  bytes('55 8bec 8b4508 03450c 5d c3'.replace(/ /g, ''));
  for (const at of calls) { const r = f - (at + 5); for (let k = 0; k < 4; k++) b[at + 1 + k] = (r >> (8 * k)) & 0xff; }
  return { bytes: Uint8Array.from(b), end: CODE + end };
}

async function once(p) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, p.bytes);
  const reset = () => {
    cpu.eip = CODE; cpu.ecx = N; cpu.eax = 1; cpu.ebx = 2; cpu.edx = 0;
    cpu.esi = DATA; cpu.edi = DATA + 0x1000; cpu.esp = DATA + 0x10000; cpu.ebp = DATA + 0x10000;
    cpu.eflags = F.RESERVED1 | F.IF;
  };
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: SMC }); jit.cpu = cpu;
  let r;
  reset();
  do r = jit.run({ stopAt: p.end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE); // warm-up: translation, then
  await new Promise((res) => setTimeout(res, 100)); // V8's background tier-up of the region to optimized code
  reset();
  const t0 = performance.now();
  do r = jit.run({ stopAt: p.end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE);
  const ms = performance.now() - t0;
  if (r !== EXIT.HALT) throw new Error('exit ' + r);
  if (cpu.ecx !== 0) throw new Error('did not run to the end');
  return (ms * 1e6) / N;
}

const all = [...CASES.map(([n, h]) => [n, build(h)]), [CALLF.name, build('', CALLF)]].filter(([n]) => !ONLY || n.includes(ONLY) || n === 'empty loop');
for (const [, p] of all) await once(p); // discarded round (the JS dispatcher and translator still being optimized)
let base = 0;
for (const [name, p] of all) {
  const t = [];
  for (let k = 0; k < RUNS; k++) t.push(await once(p));
  t.sort((a, b) => a - b);
  const med = t[t.length >> 1];
  if (name === 'empty loop') base = med;
  console.log(`${name.padEnd(32)} ${med.toFixed(3)} ns/iter  (+${((med - base) / 8).toFixed(3)} per group; min ${t[0].toFixed(3)}, max ${t[t.length - 1].toFixed(3)})`);
}

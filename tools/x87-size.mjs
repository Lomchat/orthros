#!/usr/bin/env node
// Static size of translated x87 code: small regions shaped like compiler x87 output (the x87loop-bench loops, plus
// double-operand and register-register arithmetic) translated under several control words, measured as WASM operations
// per x87 arithmetic instruction (the listing, src/cpu/jit/listing.js), WASM body bytes per region and TurboFan machine
// code bytes per region (V8's --print-wasm-code, eager TurboFan compilation with branch hints honoured, as in Chrome).
// Usage: node tools/x87-size.mjs [--ab <root>] [--cw 0x7f,0x27f,...] [--cases a,b] [--disasm <case>@<cw>]
//   --ab <root>: also measure the src tree under <root> (e.g. a worktree of an earlier revision) and print both
//   --disasm <case>@<cw>: print the machine code of that region (this tree)
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const CODE = 0x20000000;
const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
const d32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24].map((b) => b.toString(16).padStart(2, '0')).join('');
function xformBody() {
  let h = '';
  for (let r = 0; r < 3; r++) {
    h += 'd90486' + 'd88f' + d32(0x100 + 4 * r) + 'd9448604' + 'd88f' + d32(0x110 + 4 * r) + 'dec1';
    h += 'd9448608' + 'd88f' + d32(0x120 + 4 * r) + 'dec1' + 'd887' + d32(0x130 + 4 * r) + 'd95c83' + (4 * r).toString(16).padStart(2, '0');
  }
  return h;
}
// loop: mov eax, ecx ; and eax, 1023 ; <body> ; dec ecx ; jnz L ; ret (as tools/x87loop-bench.mjs, ending on RET: one region)
function loop(body) {
  const b = hex('89c8 25ff030000' + body);
  if (b.length + 3 <= 128) return Uint8Array.from([...b, 0x49, 0x75, -(b.length + 3) & 0xff, 0xc3]);
  const rel = -(b.length + 7);
  return Uint8Array.from([...b, 0x49, 0x0f, 0x85, rel & 0xff, (rel >> 8) & 0xff, (rel >> 16) & 0xff, (rel >>> 24) & 0xff, 0xc3]);
}
const CASES = [
  ['fcomp+test', 'd90486 d81f dfe0 f6c441 7501 42'],
  ['fcom+fchs+fstp', 'd90486 d84f04 dfe0 f6c405 7a02 d9e0 d91c83'],
  ['arith-blocks', 'd90486 d84f08 d84704 d817 dfe0 f6c401 7402 d9e0 dcc8 d84704 d91c83'],
  ['exp', 'd90486 d84f04 d9ea dec9 d9c0 d9fc dce9 d9c9 d9f0 d9e8 dec1 d9fd ddd9 d84708 d91c83'],
  ['xform', xformBody()],
  ['recurrence', 'd84f04 d80486'],
  ['fild', 'df0446 d84f04 d84708 d91c83'],
  // fld dword [esi+eax*4] ; fmul qword [edi+0x200] ; fadd qword [edi+0x208] ; fsub dword [edi+4] ; fdiv qword [edi+0x210] ;
  // fsubr qword [edi+0x218] ; fstp dword [ebx+eax*4]   (double operands: the roundF32 / double paths)
  ['m64', 'd90486 dc8f00020000 dc8708020000 d86704 dcb710020000 dcaf18020000 d91c83'],
  // fld dword [esi+eax*4] ; fld dword [edi+4] ; fmul st, st(1) ; fadd st(1), st ; fsubrp st(1), st ; fld st(0) ;
  // fdivr st, st(1) ; faddp st(1), st ; fstp dword [ebx+eax*4]   (register operands)
  ['regs', 'd90486 d94704 d8c9 dcc1 dee9 d9c0 d8f9 dec1 d91c83'],
];
const CWS = (opt('--cw', '0x7f,0x27f,0x37f,0xc7f')).split(',').map((x) => parseInt(x, 16));
const ONLY = opt('--cases', null)?.split(',');
const ARITH = /^(fadd|faddp|fiadd|fmul|fmulp|fimul|fsub|fsubp|fisub|fsubr|fsubrp|fisubr|fdiv|fdivp|fidiv|fdivr|fdivrp|fidivr)$/;

if (args[0] === '--child') {
  // (run under V8's code printing flags: translate every case, compile the modules eagerly, report the WASM side on stderr)
  const root = args[1];
  if (process.env.X87_SIZE_GLOBALS) Object.assign(globalThis, JSON.parse(process.env.X87_SIZE_GLOBALS)); // (translation switches, e.g. ORTHROS_NO_F32)
  const u = (f) => pathToFileURL(path.join(root, 'src', f)).href;
  const [{ GuestMemory }, { CpuState, THREAD_STATES_BASE, ST }, { translateRegion, buildRegionModule }, { listRegion }] = await Promise.all([
    import(u('cpu/memory.js')), import(u('cpu/state.js')), import(u('cpu/jit/translate.js')), import(u('cpu/jit/listing.js'))]);
  await import(u('cpu/jit/translate-x87.js'));
  const out = [];
  for (const [name, body] of CASES) {
    if (ONLY && !ONLY.includes(name)) continue;
    for (const cw of CWS) {
      const mem = new GuestMemory();
      const cpu = new CpuState(mem, THREAD_STATES_BASE);
      cpu.reset();
      mem.writeBytes(CODE, loop(body));
      mem.write16(cpu.base + ST.FPU_CW, cw);
      const opts = { fpcAssume: cw & 0xf00, smc: true };
      const { code } = translateRegion(mem, CODE, opts);
      const L = listRegion(mem, CODE, opts, { ops: false });
      let arithOps = 0, arithN = 0, insnOps = 0;
      for (const g of L.groups) {
        if (g.block < 0 || g.head || g.tail) continue;
        const m = g.label.trim().split(/\s+/)[1];
        insnOps += g.ops.length;
        if (ARITH.test(m)) { arithOps += g.ops.length; arithN++; }
      }
      const fname = `r_${name}_${cw.toString(16)}`;
      const bytes = buildRegionModule([code], [fname]);
      new WebAssembly.Module(bytes); // (compiled now: --no-wasm-lazy-compilation)
      out.push({ name, cw, fname, wasm: code.length, arithOps, arithN, insnOps });
    }
  }
  process.stderr.write('X87SIZE ' + JSON.stringify(out) + '\n');
  process.exit(0);
}

function measure(root, disasm) {
  const r = spawnSync(process.execPath, ['--no-liftoff', '--no-wasm-lazy-compilation', '--experimental-wasm-branch-hinting', '--print-wasm-code', SELF, '--child', root, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  const line = r.stderr.split('\n').find((l) => l.startsWith('X87SIZE '));
  const rows = JSON.parse(line.slice(8));
  // V8's listing: "name: <fn>" ... "Instructions (size = N)" per compiled function
  const machine = new Map();
  let cur = null, text = [];
  for (const l of r.stdout.split('\n')) {
    const n = /^name: (\S+)/.exec(l);
    if (n) { cur = n[1]; text = []; continue; }
    const s = /^Instructions \(size = (\d+)\)/.exec(l);
    if (s && cur) machine.set(cur, { size: +s[1], text });
    if (cur) text.push(l);
  }
  for (const row of rows) row.machine = machine.get(row.fname)?.size ?? NaN;
  if (disasm) { const [c, w] = disasm.split('@'); const f = `r_${c}_${parseInt(w, 16).toString(16)}`; console.log(machine.get(f)?.text.join('\n') ?? `no ${f}`); }
  return rows;
}

const disasm = opt('--disasm', null);
const cur = measure(ROOT, disasm);
const base = opt('--ab', null) ? measure(path.resolve(opt('--ab')), null) : null;
const fmt = (r) => `${String(r.wasm).padStart(6)} B wasm ${String(r.machine).padStart(6)} B code ${(r.arithN ? (r.arithOps / r.arithN).toFixed(0) : '-').padStart(4)} ops/arith`;
console.log(`x87 regions: WASM body bytes, TurboFan machine code bytes, WASM operations per x87 arithmetic instruction${base ? ' (base -> this tree)' : ''}`);
const tot = { w: [0, 0], m: [0, 0] };
for (let i = 0; i < cur.length; i++) {
  const r = cur[i], b = base?.[i];
  const label = `${r.name}@${r.cw.toString(16)}`.padEnd(22);
  if (b) {
    const pct = (x, y) => `${(100 * (y / x - 1)).toFixed(0).padStart(4)} %`;
    console.log(`${label} ${fmt(b)}  ->  ${fmt(r)}   wasm ${pct(b.wasm, r.wasm)}, code ${pct(b.machine, r.machine)}`);
    tot.w[0] += b.wasm; tot.m[0] += b.machine;
  } else console.log(`${label} ${fmt(r)}`);
  tot.w[1] += r.wasm; tot.m[1] += r.machine;
}
if (base) console.log(`total: wasm ${tot.w[0]} -> ${tot.w[1]} B (${(100 * (tot.w[1] / tot.w[0] - 1)).toFixed(1)} %), machine code ${tot.m[0]} -> ${tot.m[1]} B (${(100 * (tot.m[1] / tot.m[0] - 1)).toFixed(1)} %)`);
else console.log(`total: wasm ${tot.w[1]} B, machine code ${tot.m[1]} B`);

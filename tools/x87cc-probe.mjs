#!/usr/bin/env node
// The x87 status word after one instruction from known condition codes (tools/x87cc-cases.mjs): the host FPU
// (tools/oracle/x87cc.c, built here with clang-18) against the interpreter and the JIT (swLocal on and off).
//   node tools/x87cc-probe.mjs [--only fcomi,fsin,...] [--scratch DIR] [--table]
// Prints, per instruction, the cases where the interpreter's condition codes (C0 C2 C3, then C1 apart: it is the
// rounding direction after an inexact result, not emulated) differ from the hardware, and where the JIT differs from
// the interpreter (whole status word). --table: the hardware values as `name hex` lines (tests/x87-cc-hw.test.js).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases, dataBlock, runOrthros } from './x87cc-cases.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const only = opt('--only', null)?.split(',') ?? null;
const scratch = opt('--scratch', '/tmp/orthros-scratch/x87cc');
fs.mkdirSync(scratch, { recursive: true });
const root = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(scratch, 'x87cc');
execFileSync('clang-18', ['-O1', '-o', exe, path.join(root, 'oracle/x87cc.c')]);
const list = cases(only);
const parts = [Buffer.from(dataBlock())];
for (const c of list) { const l = Buffer.alloc(2); l.writeUInt16LE(c.code.length); parts.push(l, Buffer.from(c.code)); }
const bin = path.join(scratch, 'cases.bin');
fs.writeFileSync(bin, Buffer.concat(parts));
const hwOut = execFileSync(exe, [bin], { maxBuffer: 1 << 24 });
const hw = list.map((_, k) => hwOut.readUInt16LE(2 * k));
const h = (v) => v.toString(16).padStart(4, '0');
if (args.includes('--table')) { list.forEach((c, k) => console.log(`${c.name} ${h(hw[k])}`)); process.exit(0); }
const interp = await runOrthros(list, null), jitL = await runOrthros(list, { swLocal: true }), jit = await runOrthros(list, { swLocal: false });
const groups = { 'C0/C2/C3 hardware != interpreter': new Map(), 'C1 hardware != interpreter': new Map(), 'JIT != interpreter': new Map() };
const [gcc, gc1, gjit] = Object.values(groups);
const add = (m, k, s) => { if (!m.has(k)) m.set(k, []); m.get(k).push(s); };
list.forEach((c, k) => {
  const H = hw[k], I = interp[k];
  if ((H ^ I) & 0x4500) add(gcc, c.iname, `${c.name}: hw ${h(H)} interp ${h(I)}`);
  if ((H ^ I) & 0x200) add(gc1, c.iname, `${c.name}: hw ${h(H)} interp ${h(I)}`);
  if (jitL[k] !== I || jit[k] !== I) add(gjit, c.iname, `${c.name}: interp ${h(I)} jit(swLocal) ${h(jitL[k])} jit ${h(jit[k])}`);
});
for (const [title, m] of Object.entries(groups)) {
  console.log(`== ${title}: ${m.size} instructions`);
  for (const [n, l] of m) console.log(`  ${n} (${l.length}): ${l.slice(0, 3).join(' | ')}`);
}

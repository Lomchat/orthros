// Dynamic instruction mix of the translated code (diagnostics for the code generator): every live region translated
// with block counters (Jit opts.blockCounts) has its blocks decoded again and weighted by their execution counts —
// which instructions run, how many stores are checked for self-modifying code (not addressed by ESP), how long the
// blocks are, how often the code leaves its region. Used by tools/startbench.mjs --mix.
import { decode, OP, OP_NAMES, OT } from '../src/cpu/decoder.js';
import fs from 'node:fs';
import path from 'node:path';
import { translateRegion, buildRegionModule, touchesFpu } from '../src/cpu/jit/translate.js';

const READS_FIRST = new Set(['CMP', 'TEST', 'BT', 'JMP', 'CALL', 'PUSH', 'FLD', 'FILD', 'FBLD', 'FCOM', 'FCOMP', 'FICOM', 'FICOMP', 'FUCOM', 'FUCOMP',
  'FADD', 'FSUB', 'FSUBR', 'FMUL', 'FDIV', 'FDIVR', 'FIADD', 'FISUB', 'FISUBR', 'FIMUL', 'FIDIV', 'FIDIVR', 'FLDCW', 'FLDENV', 'FRSTOR', 'FXRSTOR',
  'COMISS', 'UCOMISS', 'COMISD', 'UCOMISD', 'PREFETCH', 'CLFLUSH', 'LDMXCSR', 'NOP']);
const TERM_NAMES = ['fallthrough', 'jmp', 'jcc', 'call', 'ret', 'indirect', 'exit', 'loop'];

/**
 * @param {import('../src/cpu/jit/jit.js').Jit} jit
 * @returns {string} report
 */
export function jitMix(jit) {
  const mem = jit.mem;
  const ops = new Map(), stores = { esp: 0, ebp: 0, other: 0, abs: 0 }, terms = new Map();
  let insns = 0, blocks = 0, regionsCounted = 0, regionEntries = 0;
  const regionInsns = [];
  for (const r of jit.regions) {
    const counts = jit.blockCounts(r);
    if (!counts) continue;
    regionsCounted++;
    let ri = 0;
    r.blocks.forEach((b, k) => {
      const n = counts[b.index];
      if (!n) return;
      blocks += n;
      let a = b.eip;
      let last = null;
      while (a < b.end) {
        let insn;
        try { insn = decode(mem, a); } catch { break; }
        const name = OP_NAMES[insn.op];
        ops.set(name, (ops.get(name) ?? 0) + n);
        insns += n; ri += n;
        const m = insn.ops[0];
        if (m && m.t === OT.MEM && !READS_FIRST.has(name)) {
          if (m.base === 4 && m.index < 0) stores.esp += n;
          else if (m.base === 5) stores.ebp += n;
          else if (m.base < 0 && m.index < 0) stores.abs += n;
          else stores.other += n;
        }
        last = insn;
        a = insn.next;
      }
      void last;
    });
    regionInsns.push([r.entry, ri]);
    void regionEntries;
  }
  // checked stores per block that could share one check made before the first of them: stores whose address registers
  // no instruction between them writes (a register operand written, or any instruction with implicit writes)
  let checked = 0, groups = 0;
  for (const r of jit.regions) {
    const counts = jit.blockCounts(r);
    if (!counts) continue;
    r.blocks.forEach((b, k) => {
      const n = counts[b.index]; if (!n) return;
      let a = b.eip, open = null; // open group: Set of address registers
      while (a < b.end) {
        let insn; try { insn = decode(mem, a); } catch { break; }
        const name = OP_NAMES[insn.op], m = insn.ops[0];
        const isStore = m && m.t === OT.MEM && !READS_FIRST.has(name) && !(m.base === 4 && m.index < 0);
        if (isStore) {
          checked += n;
          const regsOf = new Set([m.base, m.index].filter((x) => x >= 0));
          if (!open) { groups += n; open = regsOf; } else for (const x of regsOf) open.add(x);
        }
        // writes ending the group: a register destination among the group's address registers, or an implicit writer
        const d = insn.ops[0];
        const writesReg = d && d.t === OT.REG ? (d.size === 1 && d.r >= 4 ? d.r - 4 : d.r) : -1;
        if (open && ((writesReg >= 0 && open.has(writesReg)) || ['CALL', 'RET', 'PUSHA', 'POPA', 'MOVS', 'STOS', 'CMPS', 'SCAS', 'LODS', 'XCHG', 'XADD', 'CMPXCHG', 'MUL', 'IMUL', 'DIV', 'IDIV', 'CDQ', 'CWD', 'LEAVE', 'POP'].includes(name))) open = null;
        a = insn.next;
      }
    });
  }
  const pct = (x) => (100 * x / Math.max(1, insns)).toFixed(1) + '%';
  void 0;
  const lines = [];
  lines.push(`[mix] ${regionsCounted} regions with counters, ${(insns / 1e6).toFixed(0)} M guest instructions in ${(blocks / 1e6).toFixed(0)} M block executions (${(insns / Math.max(1, blocks)).toFixed(2)} per block)`);
  lines.push(`[mix] stores: esp ${pct(stores.esp)}, ebp ${pct(stores.ebp)}, absolute ${pct(stores.abs)}, other ${pct(stores.other)} (checked: ${pct(stores.ebp + stores.abs + stores.other)})`);
  lines.push(`[mix] checked stores (executed) ${(checked / 1e6).toFixed(0)} M in ${(groups / 1e6).toFixed(0)} M groups sharing their address registers (x${(checked / Math.max(1, groups)).toFixed(2)} per group)`);
  lines.push(`[mix] top: ${[...ops].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`);
  regionInsns.sort((x, y) => y[1] - x[1]);
  let acc = 0; const cum = [];
  for (let i = 0; i < regionInsns.length; i++) { acc += regionInsns[i][1]; if ([10, 50, 100, 500, 1000, 2000].includes(i + 1)) cum.push(`${i + 1}: ${pct(acc)}`); }
  lines.push(`[mix] instructions in the hottest regions: ${cum.join(', ')}`);
  lines.push(`[mix] hottest: ${regionInsns.slice(0, 12).map(([e, v]) => `${e.toString(16)} ${pct(v)}`).join(', ')}`);
  void terms; void TERM_NAMES; void OP;
  return lines.join('\n');
}

/**
 * ORTHROS_X87_DUMP=<dir> (with --mix): every live x87 region's module written to <dir>/new (as translated now) and to
 * <dir>/old (the same region translated with the x87 options of the earlier code: cold paths inline, rotating exits,
 * separate exit tails) — the game's own x87 regions, compiled afterwards by tools/x87-size.mjs --modules <dir> for
 * their machine code.
 */
const X87_DUMP = globalThis.process?.env?.ORTHROS_X87_DUMP ?? null;
const X87_OLD = { x87Cold: 'inline', x87ExitRotate: true, exitShare: false };
function dumpX87Region(jit, r, code) {
  const name = `x_${(r.entry >>> 0).toString(16)}_${r.fpc ?? 'g'}_${r.fnIdx}`; // (unique: versions share their entry)
  for (const [sub, c] of [['new', code], ['old', null]]) {
    const d = path.join(X87_DUMP, sub); fs.mkdirSync(d, { recursive: true });
    let body = c;
    if (!body) { try { body = translateRegion(jit.mem, r.entry, { ...jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false, ...X87_OLD }).code; } catch { return; } }
    fs.writeFileSync(path.join(d, name + '.wasm'), buildRegionModule([body], [name]));
  }
}

/**
 * The x87 regions among every live region (a region holding an x87 instruction caches the register stack: translate.js
 * usesX87), not only the first ones jitShape lists: count, WASM body bytes, guest instructions, operations by part, the
 * x87 arithmetic's share (FADD..FDIVR, FIADD..FIDIVR and their popping forms) — static, and weighted by the block
 * executions (translations with counters) — and the static operations per instruction of the most executed mnemonics.
 * With ORTHROS_X87_DUMP each region's module is written both ways (dumpX87Region).
 */
function x87Shape(jit, listRegion, over) {
  const ARITH = /^f(i?add|i?mul|i?sub|i?subr|i?div|i?divr|addp|mulp|subp|subrp|divp|divrp)$/;
  const x = { regions: 0, bytes: 0, insns: 0, ops: 0, arith: 0, arithN: 0, prologue: 0, epilogue: 0, blockEnd: 0, dynInsns: 0, dynOps: 0, dynArith: 0, dynArithOps: 0 };
  const byOp = new Map();
  for (const r of jit.regions) {
    let fpu = false;
    for (const b of r.blocks) {
      for (let a = b.eip; a < b.end && !fpu;) { let insn; try { insn = decode(jit.mem, a); } catch { break; } if (touchesFpu(insn)) fpu = true; a = insn.next; }
      if (fpu) break;
    }
    if (!fpu) continue;
    let L;
    try { L = listRegion(jit.mem, r.entry, { ...jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false, ...over }, { counts: jit.blockCounts(r), ops: false }); } catch { continue; }
    if (X87_DUMP && over && over !== X87_OLD) dumpX87Region(jit, r, L.result.code);
    const counts = jit.blockCounts(r);
    x.regions++; x.bytes += L.result.code.length;
    for (const g of L.groups) {
      if (g.head) continue;
      const n = g.ops.length, w = counts && g.block >= 0 ? counts[g.block] ?? 0 : 0;
      x.ops += n;
      if (g.block < 0) { if (/prologue/.test(g.label)) x.prologue += n; else x.epilogue += n; continue; }
      x.dynOps += n * w;
      if (g.tail) { x.blockEnd += n; continue; }
      const m = g.label.trim().split(/\s+/)[1] ?? '';
      x.insns++; x.dynInsns += w;
      const e = byOp.get(m) ?? { n: 0, ops: 0, dyn: 0 }; e.n++; e.ops += n; e.dyn += w; byOp.set(m, e);
      if (ARITH.test(m)) { x.arith += n; x.arithN++; x.dynArith += w; x.dynArithOps += n * w; }
    }
  }
  if (!x.regions) return [];
  const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1);
  const lines = [`[shape] x87 regions: ${x.regions} of ${jit.regions.length}, ${(x.bytes / 1024).toFixed(0)} KiB WASM bodies (${(x.bytes / x.regions / 1024).toFixed(1)} KiB each), ${x.insns} guest instructions, ${(x.ops / x.insns).toFixed(1)} operations per instruction; x87 arithmetic ${x.arithN} instructions, ${(x.arith / Math.max(1, x.arithN)).toFixed(1)} operations each, ${pct(x.arith, x.ops)} % of the operations; prologues ${pct(x.prologue, x.ops)} %, epilogues ${pct(x.epilogue, x.ops)} %, block ends ${pct(x.blockEnd, x.ops)} %`];
  if (x.dynInsns) lines.push(`[shape] x87 regions executed: ${(x.dynInsns / 1e6).toFixed(0)} M guest instructions, x87 arithmetic ${pct(x.dynArith, x.dynInsns)} % of them and ${pct(x.dynArithOps, x.dynOps)} % of the operations executed (weighted by block executions)`);
  const top = [...byOp].sort((a, b) => (b[1].dyn || b[1].n) - (a[1].dyn || a[1].n)).slice(0, 16);
  lines.push(`[shape] x87 regions by instruction (static operations per instruction${x.dynInsns ? ', share of executed instructions' : ''}): ${top.map(([k, e]) => `${k} ${(e.ops / e.n).toFixed(0)}${x.dynInsns ? ` ${pct(e.dyn, x.dynInsns)}%` : ''}`).join(', ')}`);
  return lines;
}

/**
 * Static shape of the translated code: every live region translated again under the listing (src/cpu/jit/listing.js),
 * its WASM operations counted per guest instruction kind and per part (prologue, block ends, epilogue: exits, chaining)
 * — with `counts`, weighted by the block executions too. What the code generator spends its operations on.
 * @param {import('../src/cpu/jit/jit.js').Jit} jit
 * @param {(mem: any, entry: number, opts: any, how: any) => any} listRegion
 */
export function jitShape(jit, listRegion, max = 4000, over = null) {
  // (with ORTHROS_X87_DUMP, the same report for the earlier x87 options follows, its lines tagged [shape-old])
  if (X87_DUMP && !over) return jitShape(jit, listRegion, max, {}) + '\n' + jitShape(jit, listRegion, max, X87_OLD).replace(/\[shape\]/g, '[shape-old]');
  const byOp = new Map(), parts = { insn: 0, blockEnd: 0, prologue: 0, epilogue: 0 }, dyn = { insn: 0, blockEnd: 0 };
  let insns = 0, regions = 0, bytes = 0, dynInsns = 0;
  for (const r of jit.regions.slice(0, max)) {
    let L;
    try { L = listRegion(jit.mem, r.entry, { ...jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false, ...over }, { counts: jit.blockCounts(r), ops: false }); } catch { continue; }
    regions++; bytes += L.result.code.length;
    const counts = jit.blockCounts(r);
    for (const g of L.groups) {
      const n = g.ops.length, w = counts && g.block >= 0 ? counts[g.block] ?? 0 : 0;
      if (g.head) continue;
      if (g.block < 0) { if (/prologue/.test(g.label)) parts.prologue += n; else parts.epilogue += n; continue; }
      if (g.tail) { parts.blockEnd += n; dyn.blockEnd += n * w; continue; }
      const m = g.label.split(/\s+/)[1];
      const e = byOp.get(m) ?? { n: 0, ops: 0, dyn: 0, dynOps: 0 };
      e.n++; e.ops += n; e.dyn += w; e.dynOps += n * w; byOp.set(m, e);
      parts.insn += n; dyn.insn += n * w; insns++; dynInsns += w;
    }
  }
  const total = parts.insn + parts.blockEnd + parts.prologue + parts.epilogue;
  const lines = [];
  const x87Lines = x87Shape(jit, listRegion, over);
  // duplication: the same guest code translated in several regions (callees and shared paths copied into each region
  // reaching them)
  { const seen = new Set(); let all = 0; for (const r of jit.regions) for (const b of r.blocks) { all += b.end - b.eip; for (let a = b.eip; a < b.end; a++) seen.add(a); }
    lines.push(`[shape] duplication: ${jit.regions.length} live regions translate ${(all / 1024).toFixed(0)} KiB of guest code, ${(seen.size / 1024).toFixed(0)} KiB distinct (x${(all / Math.max(1, seen.size)).toFixed(2)})`); }
  lines.push(`[shape] ${regions} regions, ${insns} guest instructions, ${(bytes / insns).toFixed(1)} body bytes and ${(total / insns).toFixed(1)} operations per instruction: instructions ${(100 * parts.insn / total).toFixed(0)}%, block ends ${(100 * parts.blockEnd / total).toFixed(0)}%, prologues ${(100 * parts.prologue / total).toFixed(0)}%, epilogues ${(100 * parts.epilogue / total).toFixed(0)}%`);
  lines.push(...x87Lines);
  if (dynInsns) lines.push(`[shape] executed: ${((dyn.insn + dyn.blockEnd) / dynInsns).toFixed(1)} operations per instruction (block ends ${(100 * dyn.blockEnd / (dyn.insn + dyn.blockEnd)).toFixed(0)}%)`);
  const top = [...byOp].sort((a, b) => (b[1].dynOps || b[1].ops) - (a[1].dynOps || a[1].ops)).slice(0, 25);
  lines.push(`[shape] by instruction (static ops/insn, executed share of operations): ${top.map(([k, e]) => `${k} ${(e.ops / e.n).toFixed(1)}${dynInsns ? ` ${(100 * e.dynOps / Math.max(1, dyn.insn + dyn.blockEnd)).toFixed(1)}%` : ''}`).join(', ')}`);
  return lines.join('\n');
}

// Dynamic instruction mix of the translated code (diagnostics for the code generator): every live region translated
// with block counters (Jit opts.blockCounts) has its blocks decoded again and weighted by their execution counts —
// which instructions run, how many stores are checked for self-modifying code (not addressed by ESP), how long the
// blocks are, how often the code leaves its region. Used by tools/bench/startbench.mjs --mix.
import { decode, OP, OP_NAMES, OT } from '../../src/cpu/decoder.js';
import fs from 'node:fs';
import path from 'node:path';
import { translateRegion, buildRegionModule, touchesFpu } from '../../src/cpu/jit/translate.js';

const READS_FIRST = new Set(['CMP', 'TEST', 'BT', 'JMP', 'CALL', 'PUSH', 'FLD', 'FILD', 'FBLD', 'FCOM', 'FCOMP', 'FICOM', 'FICOMP', 'FUCOM', 'FUCOMP',
  'FADD', 'FSUB', 'FSUBR', 'FMUL', 'FDIV', 'FDIVR', 'FIADD', 'FISUB', 'FISUBR', 'FIMUL', 'FIDIV', 'FIDIVR', 'FLDCW', 'FLDENV', 'FRSTOR', 'FXRSTOR',
  'COMISS', 'UCOMISS', 'COMISD', 'UCOMISD', 'PREFETCH', 'CLFLUSH', 'LDMXCSR', 'NOP']);
const TERM_NAMES = ['fallthrough', 'jmp', 'jcc', 'call', 'ret', 'indirect', 'exit', 'loop'];

/**
 * @param {import('../../src/cpu/jit/jit.js').Jit} jit
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
 * separate exit tails) — the game's own x87 regions, compiled afterwards by tools/bench/x87-size.mjs --modules <dir> for
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
 * @param {import('../../src/cpu/jit/jit.js').Jit} jit
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

/**
 * Stack-slot opportunity (2026-11-12, docs/jit-code-shape.md "Guest stack slots in locals"): of the executed guest
 * memory accesses, those addressed by [esp+d] / [ebp+d] (no index) whose base is known relative to the region's entry
 * ESP / EBP (ADD/SUB by a constant, PUSH/POP, MOV EBP,ESP, LEA, LEAVE tracked through the region's own jumps and
 * branches; anything else, a call or a return makes it unknown), and the loads a promotion of frame slots to WASM locals
 * could serve from a local:
 * - same block: the slot was read or written earlier in the same block execution (exact for those executions);
 * - every path: the slot was accessed on every path from the region's entry to the block (must-availability over the
 *   region's own jumps and branches);
 * - per region entry: a load of a region-frame slot in a block that runs more often than the region's entry block —
 *   every execution beyond one per entry (an estimate on the generous side: entries at other blocks are not counted).
 * Also the stores through other bases (each would need a range check against a promoted window, or end it).
 * @param {import('../../src/cpu/jit/jit.js').Jit} jit
 */
export function stackSlotMix(jit) {
  const mem = jit.mem;
  const PURE_STORE = new Set(['MOV', 'FST', 'FSTP', 'FIST', 'FISTP', 'FISTTP', 'FBSTP', 'MOVSS', 'MOVSD', 'MOVQ', 'MOVD', 'MOVAPS', 'MOVUPS', 'MOVAPD',
    'MOVUPD', 'MOVDQA', 'MOVDQU', 'MOVLPS', 'MOVHPS', 'MOVLPD', 'MOVHPD', 'MOVNTI', 'MOVNTPS', 'MOVNTQ', 'MOVNTDQ', 'FNSTSW', 'FNSTCW', 'FSTSW',
    'FSTCW', 'POP', 'STOS', 'SETCC']);
  const NO_ACCESS = new Set(['LEA', 'NOP', 'PREFETCH']);
  const c = { insns: 0, loads: 0, stores: 0, espL: 0, espS: 0, ebpL: 0, ebpS: 0, frameIdxL: 0, frameUnkL: 0, push: 0, pop: 0, popRed: 0,
    otherS: 0, blockRed: 0, pathRed: 0, regionRed: 0 };
  let fresh = 0;
  const regOf = (o) => (o && o.t === OT.REG && o.size === 4 ? o.r : -1);
  const eq = (x, y) => (x === y) || (!!x && !!y && x[0] === y[0] && x[1] === y[1]);
  for (const r of jit.regions) {
    const counts = jit.blockCounts(r);
    if (!counts) continue;
    const byEip = new Map(r.blocks.map((b) => [b.eip, b]));
    const decoded = new Map();
    const insnsOf = (b) => {
      if (decoded.has(b)) return decoded.get(b);
      const out = []; let a = b.eip;
      while (a < b.end) { let i; try { i = decode(mem, a); } catch { break; } out.push(i); a = i.next; }
      decoded.set(b, out); return out;
    };
    // one instruction: its memory accesses (visit(op, load, store)) and what it does to the bases
    const step = (st, insn, visit) => {
      const name = OP_NAMES[insn.op], o0 = insn.ops[0], o1 = insn.ops[1];
      if (!NO_ACCESS.has(name)) insn.ops.forEach((m, k) => {
        if (!m || m.t !== OT.MEM) return;
        let ld = true, sd = false;
        if (k === 0 && !READS_FIRST.has(name)) { sd = true; ld = !PURE_STORE.has(name) && !/^SET/.test(name); }
        visit(m, ld, sd);
      });
      const adj = (v, d) => (v ? [v[0], v[1] + d] : null);
      const val = (rr) => (rr === 4 ? st.esp : rr === 5 ? st.ebp : null);
      switch (name) {
        case 'PUSH': visit({ base: -2, off: -4, index: -1 }, false, true); st.esp = adj(st.esp, -4); return;
        case 'POP': visit({ base: -2, off: 0, index: -1 }, true, false); st.esp = adj(st.esp, 4); if (regOf(o0) === 5) st.ebp = null; return;
        case 'LEAVE': st.esp = adj(st.ebp, 0); visit({ base: -2, off: 0, index: -1 }, true, false); st.esp = adj(st.esp, 4); st.ebp = null; return;
        case 'CALL': case 'RET': case 'IRET': case 'ENTER': case 'PUSHA': case 'POPA': case 'PUSHF': case 'POPF': st.esp = null; st.ebp = null; return;
        default: break;
      }
      const w = o0 && !READS_FIRST.has(name) ? regOf(o0) : -1;
      if (w === 4 || w === 5) {
        const k = w === 4 ? 'esp' : 'ebp';
        if ((name === 'ADD' || name === 'SUB') && o1?.t === OT.IMM) st[k] = adj(st[k], name === 'ADD' ? o1.v | 0 : -(o1.v | 0));
        else if (name === 'MOV' && regOf(o1) >= 0) st[k] = val(regOf(o1));
        else if (name === 'LEA' && o1.index < 0 && (o1.base === 4 || o1.base === 5)) st[k] = adj(val(o1.base), o1.disp | 0);
        else st[k] = null;
      }
      if ((name === 'XCHG' || name === 'XADD' || name === 'CMPXCHG') && [4, 5].includes(regOf(o1))) st[regOf(o1) === 4 ? 'esp' : 'ebp'] = null;
    };
    // the bases at each block's entry, relative to the region's entry (its own jumps and branches)
    const inState = new Map();
    const entry = byEip.get(r.entry);
    if (entry) {
      inState.set(entry, { esp: ['R', 0], ebp: ['E', 0] });
      const work = [entry];
      while (work.length) {
        const b = work.pop(), st = { ...inState.get(b) };
        const ins = insnsOf(b);
        for (const i of ins) step(st, i, () => {});
        const last = ins[ins.length - 1];
        if (!last) continue;
        const nm = OP_NAMES[last.op], succ = [];
        if (nm !== 'CALL' && nm !== 'RET' && !(nm === 'JMP' && last.ops[0]?.t !== OT.REL)) {
          if ((nm === 'JMP' || /^J/.test(nm) || /^LOOP/.test(nm)) && last.ops[0]?.t === OT.REL) succ.push(last.ops[0].v);
          if (nm !== 'JMP') succ.push(last.next);
        }
        for (const a of succ) {
          const t = byEip.get(a); if (!t || t === entry) continue;
          const old = inState.get(t);
          const nw = old ? { esp: eq(old.esp, st.esp) ? old.esp : null, ebp: eq(old.ebp, st.ebp) ? old.ebp : null } : { esp: st.esp, ebp: st.ebp };
          if (!old || !eq(old.esp, nw.esp) || !eq(old.ebp, nw.ebp)) { inState.set(t, nw); work.push(t); }
        }
      }
    }
    const entryCount = entry ? counts[entry.index] : 0;
    // the region-frame slots accessed on every path from the region's entry to each block (must-availability: the
    // intersection over its in-region predecessors; a block entered from outside — its in-region predecessors unknown
    // here, the entry — starts empty)
    const keysOut = (b) => {
      const rs = inState.get(b); if (!rs) return new Set();
      const st = { esp: rs.esp, ebp: rs.ebp }, out = new Set();
      for (const i of insnsOf(b)) step(st, i, (m) => {
        const v = m.base === -2 ? st.esp : (m.base === 4 || m.base === 5) && m.index < 0 ? (m.base === 4 ? st.esp : st.ebp) : null;
        if (v) out.add(v[0] + ':' + (v[1] + (m.base === -2 ? m.off : m.disp | 0)));
      });
      return out;
    };
    const preds = new Map(), outs = new Map();
    for (const b of inState.keys()) {
      const ins = insnsOf(b), last = ins[ins.length - 1]; if (!last) continue;
      const nm = OP_NAMES[last.op], succ = [];
      if (nm !== 'CALL' && nm !== 'RET' && !(nm === 'JMP' && last.ops[0]?.t !== OT.REL)) {
        if ((nm === 'JMP' || /^J/.test(nm) || /^LOOP/.test(nm)) && last.ops[0]?.t === OT.REL) succ.push(last.ops[0].v);
        if (nm !== 'JMP') succ.push(last.next);
      }
      for (const a of succ) { const t = byEip.get(a); if (t && t !== entry && inState.has(t)) { if (!preds.has(t)) preds.set(t, []); preds.get(t).push(b); } }
      outs.set(b, keysOut(b));
    }
    const avail = new Map(); // block -> Set (null: not computed yet = everything)
    for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
      changed = false;
      for (const b of inState.keys()) {
        let inn = null;
        if (b === entry || !preds.has(b)) inn = new Set();
        else for (const p of preds.get(b)) {
          const pa = avail.get(p); if (pa === undefined) continue; // (top)
          const po = new Set([...pa, ...(outs.get(p) ?? [])]);
          inn = inn === null ? po : new Set([...inn].filter((k) => po.has(k)));
        }
        if (inn === null) continue;
        const old = avail.get(b);
        if (!old || old.size !== inn.size) { avail.set(b, inn); changed = true; }
      }
    }
    for (const b of r.blocks) {
      const n = counts[b.index]; if (!n) continue;
      const rs = inState.get(b);
      const st = rs ? { esp: rs.esp, ebp: rs.ebp } : { esp: ['B' + (fresh++), 0], ebp: ['b' + (fresh++), 0] };
      const seen = new Set(avail.get(b) ?? []), here = new Set();
      for (const i of insnsOf(b)) {
        c.insns += n;
        step(st, i, (m, ld, sd) => {
          if (ld) c.loads += n;
          if (sd) c.stores += n;
          let v, d;
          if (m.base === -2) { if (ld) c.pop += n; else c.push += n; v = st.esp; d = m.off; }
          else if ((m.base === 4 || m.base === 5) && m.index < 0) {
            if (m.base === 4) { if (ld) c.espL += n; if (sd) c.espS += n; } else { if (ld) c.ebpL += n; if (sd) c.ebpS += n; }
            v = m.base === 4 ? st.esp : st.ebp; d = m.disp | 0;
            if (!v && ld) c.frameUnkL += n;
          } else if (m.base === 4 || m.base === 5) { if (ld) c.frameIdxL += n; return; }
          else { if (sd) c.otherS += n; return; }
          if (!v) return;
          const key = v[0] + ':' + (v[1] + d);
          if (ld && here.has(key)) { c.blockRed += n; if (m.base === -2) c.popRed += n; }
          else if (ld && seen.has(key)) c.pathRed += n;
          else if (ld && rs && v[0].length === 1) c.regionRed += Math.max(0, n - entryCount);
          seen.add(key); here.add(key);
        });
      }
    }
  }
  const pct = (x) => (100 * x / Math.max(1, c.insns)).toFixed(1) + '%';
  return [
    `[stack] ${(c.insns / 1e6).toFixed(0)} M guest instructions counted; per guest instruction: memory loads ${pct(c.loads)}, stores ${pct(c.stores)}`,
    `[stack] [esp+d] loads ${pct(c.espL)}, stores ${pct(c.espS)}; [ebp+d] loads ${pct(c.ebpL)}, stores ${pct(c.ebpS)}; PUSH ${pct(c.push)}, POP ${pct(c.pop)}; frame loads with an index ${pct(c.frameIdxL)}, base unknown ${pct(c.frameUnkL)}; stores through other bases ${pct(c.otherS)}`,
    `[stack] loads a frame-slot local could serve: same block ${pct(c.blockRed)} (POP of a slot pushed in the block ${pct(c.popRed)}), accessed on every path from the region's entry ${pct(c.pathRed)}, loop iterations beyond one per region entry (estimate) ${pct(c.regionRed)}`,
  ].join('\n');
}

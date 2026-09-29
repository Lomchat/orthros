// Translated code listing (debugging): the WASM a region's translation emits, as a pseudo-WAT trace of the emitter's
// instruction-level calls (locals by name) grouped per guest instruction, with the region's block structure (extent,
// terminator, successors in / out of the region, predicted lazy op, planned x87 shift) and, for a region translated
// with block counters (Jit opts.blockCounts), each block's execution count. Used by tools/jit-dump.mjs (a byte string
// translated in isolation) and by the page worker (a live region of a running game: the `jitlist` harness input and
// the profiler's listing of the hottest regions) — to see what the translated code does per guest instruction.
// The listing re-translates the region with the options it was translated with: the same emitter decisions (the
// translation depends only on the code bytes and those options), not the module that is running.
import { Code } from './wasm.js';
import { translateRegion, Emitter } from './translate.js';
import { fmtInsn, OT } from '../decoder.js';

// local names (translate.js layout)
const LOCALS = { 0: 'blk', 1: 'state', 10: 'eflags', 11: 'lzop', 12: 'lzres', 13: 'lza', 14: 'lzb', 15: 'icount', 16: 'ta', 17: 'tv', 18: 't2', 19: 't3', 20: 't4', 21: 't5', 22: 't6', 23: 't7', 24: 'i64a', 25: 'i64b', 26: 'f64a', 27: 'f64b', 28: 'top', 29: 't8', 30: 'v0', 31: 'v1', 32: 'v2', 41: 'ftw', 42: 'fpc', 43: 'f64c', 44: 'fs', 53: 'f32a', 54: 'f32b', 55: 'f32c', 64: 'f64d', 65: 'f64e', 66: 'f64g', 67: 'f64h' };
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
export const localName = (i) => (i >= 2 && i < 10 ? REGS[i - 2] : i >= 33 && i < 41 ? `st${i - 33}` : i >= 45 && i < 53 ? `s32_${i - 45}` : i >= 56 && i < 64 ? `xmm${i - 56}` : i >= 68 && i < 76 ? `xmm${i - 68}.f32` : i >= 76 && i < 84 ? `xmm${i - 76}.f64` : LOCALS[i] ?? `l${i}`);
const TERMS = ['fallthrough', 'jmp', 'jcc', 'call', 'ret', 'indirect', 'exit', 'loop'];
/** byte-level writers of Code (not instructions) */
const RAW = new Set(['constructor', 'byte', 'bytes', 'u', 's', 's64', 'f32', 'f64', 'str', 'sized', 'raw', 'finish', 'ensure', 'reset', 'depth', 'hint']);

/**
 * Operation classes of the summary: what the translated code spends its operations on (the state block — the region's
 * guest registers are locals, so its loads and stores are x87/XMM/flag spills, exits, chains and counters —, guest
 * memory, control flow, calls, locals).
 */
function classify(op, prev, prev2) {
  const name = op.split(' ')[0];
  if (name === 'call' || name === 'call_indirect' || name === 'return_call_indirect') return 'call';
  // (a state block access: `get state ; load` or `get state ; <value> ; store` — approximate, from the pattern)
  if (/load/.test(name)) return prev === 'get state' ? 'state' : 'mem';
  if (/store/.test(name)) return prev2 === 'get state' || prev === 'get state' ? 'state' : 'mem';
  if (/^(br|br_if|br_table|if_|else_|block|loop|end|return_|unreachable)$/.test(name)) return 'ctl';
  if (name === 'get' || name === 'set' || name === 'tee') return 'local';
  return 'alu';
}

/**
 * Translate the region at `entry` with `opts` (translateRegion options) while tracing the emitter.
 * @param {import('../memory.js').GuestMemory} mem
 * @param {number} entry
 * @param {object} opts
 * @param {{ counts?: number[] | null, ops?: boolean }} [how] counts: execution count per block index; ops: false for
 *   the per-instruction operation counts without the operations themselves
 * @returns {{ text: string, groups: Array<{ label: string, ops: string[], block: number }>, result: any, summary: Record<string, number> }}
 */
export function listRegion(mem, entry, opts, how = {}) {
  const counts = how.counts ?? null, showOps = how.ops !== false;
  const groups = [];
  let trace = null, depth = 0, block = -1;
  const saved = [];
  const wrap = (proto, name, fn) => { saved.push([proto, name, proto[name]]); proto[name] = fn; };
  for (const name of Object.getOwnPropertyNames(Code.prototype)) {
    if (RAW.has(name)) continue;
    const d = Object.getOwnPropertyDescriptor(Code.prototype, name);
    if (typeof d.value !== 'function') continue;
    const fn = d.value;
    // only the outermost call is recorded (an instruction method built on others is one operation)
    wrap(Code.prototype, name, function (...a) {
      if (trace && depth === 0) trace.push(['get', 'set', 'tee'].includes(name) ? `${name} ${localName(a[0])}` : a.length && typeof a[0] !== 'object' ? `${name} ${a.map((x) => (typeof x === 'number' && Math.abs(x) > 255 ? '0x' + (x >>> 0).toString(16) : String(x))).join(',')}` : name);
      depth++;
      try { return fn.apply(this, a); } finally { depth--; }
    });
  }
  const P = Emitter.prototype, emitInsn = P.emitInsn, emitBlock = P.emitBlock, run = P.run;
  wrap(P, 'emitInsn', function (insn, b) { trace = []; groups.push({ label: `${insn.addr.toString(16)}  ${fmtInsn(insn)}`, ops: trace, block }); return emitInsn.call(this, insn, b); });
  wrap(P, 'emitBlock', function (b, next) {
    block = b.index;
    const last = b.insns[b.insns.length - 1];
    const tgt = last && b.term !== 0 && last.ops[0]?.t === OT.REL ? last.ops[0].v >>> 0 : -1;
    const succ = [];
    if (tgt >= 0) succ.push(`${tgt.toString(16)}${this.byEip.has(tgt) ? '' : ' (exit)'}`);
    if (b.term === 0 || b.term === 2 || b.term === 3 || b.term === 7) succ.push(`${(b.fallthrough >>> 0).toString(16)}${this.byEip.has(b.fallthrough) ? '' : ' (exit)'}`);
    const loops = this.pathOf?.[b.index]?.filter((u) => u.loop).length ?? 0;
    const info = [`${b.insns.length} insns`, TERMS[b.term] ?? `term ${b.term}`, succ.length ? `-> ${succ.join(', ')}` : '', loops ? `loop depth ${loops}` : '', b.lzPred >= 0 ? `lz pred ${b.lzPred}` : '', this.planOf(b.index) ? `x87 shift ${this.planOf(b.index)}` : '', counts ? `executed ${counts[b.index]}` : ''].filter(Boolean).join(', ');
    trace = []; groups.push({ label: `-- block ${b.index} @${b.eip.toString(16)}..${b.end.toString(16)}: ${info}`, ops: trace, block: b.index, head: true });
    const r = emitBlock.call(this, b, next);
    trace = []; groups.push({ label: `-- block ${b.index} end`, ops: trace, block: b.index, tail: true });
    return r;
  });
  // the code after the outermost unit list (the region's exit paths: chaining, state flush) is the epilogue
  const emitUnits = P.emitUnits;
  let unitDepth = 0;
  wrap(P, 'emitUnits', function (...a) {
    unitDepth++;
    try { return emitUnits.apply(this, a); } finally { if (--unitDepth === 0) { block = -1; trace = []; groups.push({ label: '-- region epilogue (exits: chaining, state flush)', ops: trace, block: -1 }); } }
  });
  // (an x87 region may be emitted more than once: the last emission is listed)
  wrap(P, 'run', function (e) { groups.length = 0; block = -1; trace = []; groups.push({ label: '-- region prologue', ops: trace, block: -1 }); return run.call(this, e); });
  let result;
  try {
    result = translateRegion(mem, entry, opts);
  } finally {
    for (let k = saved.length - 1; k >= 0; k--) { const [proto, name, fn] = saved[k]; proto[name] = fn; }
  }
  // per-region summary: operations by class, weighted by the block counts when known
  const summary = {}, weighted = {};
  let prev = '', prev2 = '';
  for (const g of groups) {
    const w = counts && g.block >= 0 ? counts[g.block] ?? 0 : 0;
    for (const op of g.ops) { const k = classify(op, prev, prev2); summary[k] = (summary[k] ?? 0) + 1; if (w) weighted[k] = (weighted[k] ?? 0) + w; prev2 = prev; prev = op; }
  }
  const lines = [];
  const fmtSum = (s) => Object.entries(s).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`region ${entry.toString(16)}: ${result.blocks.length} blocks, ${result.code.length} body bytes, ${result.stats.native} native / ${result.stats.fallback} fallback insns; emitted ops: ${fmtSum(summary)}${counts ? `; executed ops (block counts x ops): ${fmtSum(weighted)}` : ''}`);
  for (const g of groups) {
    if (!g.ops.length && !g.head) continue;
    const w = counts && g.block >= 0 && !g.head ? counts[g.block] ?? 0 : 0;
    lines.push(`${g.head ? '' : '  '}${g.label.padEnd(g.head ? 0 : 46)}${g.head ? '' : ` ${String(g.ops.length).padStart(4)} ops${w ? ` x${w}` : ''}`}`);
    if (showOps) for (const o of g.ops) lines.push(`        ${o}`);
  }
  return { text: lines.join('\n'), groups, result, summary };
}

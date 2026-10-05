// Regions compiled by the background translator (opts.bgCompile, bg-translate.js compileHere): V8 compiles a
// WebAssembly function at its first call, on the calling thread, so the background worker calls each region of a batch
// once — block index -1, on a state block no thread uses (JIT_WARM_STATE) — before sending it. Randomized programs
// (blocks joined by forward and backward branches, calls to leaf functions, x87 under several precision modes, memory,
// self-modifying code) run time-sliced with regions translated ahead in the background: the calls write nothing but
// that state block (the program's code and data, the thread's state block, the x87-version slots unchanged) and the
// results match the interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, JIT_ALT_BASE, JIT_WARM_STATE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { handleMessage } from '../src/cpu/jit/bg-translate.js';

const CODE = 0x20000000, DATA = 0x10000000, CW = DATA + 0x100;
const tick = () => new Promise((r) => setTimeout(r, 0));
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
let seed = 991;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const R3 = () => rnd(4); // eax ecx edx ebx
const ALU = () => [[0x01, 0xc0 | (R3() << 3) | R3()], [0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)], [0x8d, 0x40 | (R3() << 3) | R3(), rnd(128)], [0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()], [0x0f, 0x40 + rnd(16), 0xc0 | (R3() << 3) | R3()]][rnd(5)];
const X87 = () => [0xdd, 0x05, ...le(DATA + 8), 0xdc, 0x05, ...le(DATA + 16), 0xdc, 0x0d, ...le(DATA + 24), 0xdd, 0x1d, ...le(DATA + 8)]; // x = (x + a) * b
const CWSET = () => [0xd9, 0x2d, ...le(CW + 2 * rnd(3))]; // fldcw: 24, 53 or 64-bit precision
const MEM = () => [[0xa3, ...le(DATA + 32)], [0x01, 0x15, ...le(DATA + 36)]][rnd(2)];
const SMC = () => [0xc7, 0x05, ...le(CODE + 1), ...le(rnd(1 << 30))]; // mov dword [CODE+1], imm32: the first instruction's immediate

/**
 * `mov ebx, imm32` (rewritten by the SMC snippets), then blocks `dec edi ; jz end ; <body> ; <terminator>` (a Jcc / JMP
 * to any block, a CALL to a leaf function, or a fallthrough) with leaf functions (`<body> ; ret`) among them.
 */
function gen({ x87 = true, smc = true } = {}) {
  const nb = 6 + rnd(12), nf = 1 + rnd(3);
  const kinds = [];
  for (let i = 0; i < nb; i++) kinds.push('b');
  for (let i = 0; i < nf; i++) kinds.splice(1 + rnd(kinds.length), 0, 'f');
  const fns = kinds.map((k, i) => (k === 'f' ? i : -1)).filter((i) => i >= 0), blocks = kinds.map((k, i) => (k === 'b' ? i : -1)).filter((i) => i >= 0);
  const body = () => { const o = []; for (let k = rnd(4); k > 0; k--) { const r = rnd(12); o.push(...(r === 0 && x87 ? (rnd(3) ? X87() : CWSET()) : r === 1 ? MEM() : r === 2 && smc && rnd(4) === 0 ? SMC() : ALU())); } return o; };
  const out = [0xbb, ...le(rnd(1 << 30))], start = [], fix = [];
  for (let i = 0; i < kinds.length; i++) {
    start[i] = out.length;
    if (kinds[i] === 'f') { out.push(...body(), 0xc3); continue; }
    out.push(0x4f, 0x0f, 0x84); fix.push([out.length, -1]); out.push(0, 0, 0, 0); // dec edi ; jz end
    out.push(...body());
    const tgt = blocks[rnd(blocks.length)], nextIsFn = i + 1 < kinds.length && kinds[i + 1] === 'f';
    switch (rnd(4)) {
      case 0: out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); if (nextIsFn) { out.push(0xe9); fix.push([out.length, blocks[rnd(blocks.length)]]); out.push(0, 0, 0, 0); } break;
      case 1: out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break;
      case 2: out.push(0xe8); fix.push([out.length, fns[rnd(fns.length)]]); out.push(0, 0, 0, 0); if (nextIsFn) { out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); } break;
      default: if (nextIsFn) { out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); } break;
    }
  }
  if (kinds[kinds.length - 1] === 'f') { out.push(0xe9); fix.push([out.length, 0]); out.push(0, 0, 0, 0); }
  const end = out.length; out.push(0xf4);
  for (const [at, t] of fix) out.splice(at, 4, ...le((t < 0 ? end : start[t]) - (at + 4)));
  return { code: Uint8Array.from(out), end: CODE + end };
}
const V = [0, 1, 0x7f, 0x80, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(2) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);

function machine(code, regs, shared = false) {
  const mem = new GuestMemory({ shared }), cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset(); mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code); mem.fill(DATA, 0x1000, 0);
  mem.writeF64(DATA + 8, 1.25); mem.writeF64(DATA + 16, 0.1); mem.writeF64(DATA + 24, 0.7);
  mem.write16(CW, 0x007f); mem.write16(CW + 2, 0x027f); mem.write16(CW + 4, 0x037f);
  [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = regs; cpu.edi = 300 + (regs[4] & 511); cpu.esp = DATA + 0x800; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF | (regs[4] & 0x8d5); mem.write16(cpu.base + ST.FPU_CW, 0x027f);
  return { mem, cpu, interp: new Interp(mem, cpu) };
}
const state = (c, mem) => [c.eax, c.ecx, c.edx, c.ebx, c.esp, c.edi, c.eflags & 0x8d5, c.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA, 0x800)].join(',');
function reference(p, regs) {
  const m = machine(p.code, regs);
  const r = m.interp.run({ stopAt: p.end, maxInsns: 1e7 });
  return { r, s: state(m.cpu, m.mem) };
}
/** a store into translated code: its regions dropped (as Vm does), the run goes on */
function smcExit(jit, m) {
  const lenAt = m.cpu.base + ST.EXIT_LEN, len = m.mem.read32(lenAt) || 16;
  m.mem.write32(lenAt, 0); jit.invalidate(m.cpu.exitArg, len);
}
/** a session with the background translator (shared memory), its batches installed between slices */
async function bgSession(p, regs, { maxBlocks, slice, learned = null, bgCompile = false, onPrewarm = null }) {
  const m = machine(p.code, regs, true);
  const jit = new Jit(m.mem, m.interp, { smc: true, maxBlocks, maxInsns: 400, bgCompile, warn: (msg) => { throw new Error(msg); } });
  jit.cpu = m.cpu;
  const replies = [];
  jit.attachBackground({ postMessage: (msg) => handleMessage(msg, (rep) => replies.push(rep)) });
  await tick();
  const install = () => { for (const rep of replies.splice(0)) if (rep.type === 'batch') jit.bgInstall(rep); };
  // (an earlier session's entries translated ahead, as the page does)
  if (learned?.length) { const before = onPrewarm?.(m); jit.bgPrewarm(learned); await tick(); await tick(); onPrewarm?.(m, before); install(); }
  jit.learned = [];
  let r, n = 0;
  for (;;) {
    r = jit.run({ stopAt: p.end, maxInsns: slice });
    if (r === EXIT.SMC) { smcExit(jit, m); continue; }
    if (r !== EXIT.TIMESLICE) break;
    if (n % 3 === 0) { await tick(); install(); }
    if (++n > 1e6) throw new Error('runaway');
  }
  CpuState.foldLazyFlags?.(m.cpu);
  await tick();
  return { r, s: state(m.cpu, m.mem), jit, learned: jit.learned.map(([eip, fpc]) => [eip, fpc]) };
}

test('opts.bgCompile: the background translator compiles its regions by calling them once on a state block of its own — guest memory and thread state untouched, results exact', async () => {
  // (the memory a call could touch: the program's code and data, the thread's state block, the x87-version slots)
  const snap = (m) => [m.mem.bytes(CODE, 0x1000), m.mem.bytes(DATA, 0x1000), m.mem.bytes(THREAD_STATES_BASE, 0x400), m.mem.bytes(JIT_ALT_BASE, 0x1000)].map((b) => Buffer.from(b).toString('base64')).join('|');
  let warmed = 0;
  for (let i = 0; i < 32; i++) {
    const p = gen({ x87: i % 2 === 0, smc: i % 5 === 0 });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    // (regions of 3 blocks — many of them —, or of up to 48: x87 regions specialized for their entry's mode)
    const maxBlocks = i % 3 === 0 ? 3 : 48;
    const a = await bgSession(p, regs, { maxBlocks, slice: 7 });
    const b = await bgSession(p, regs, { maxBlocks, slice: 3 + (i % 9), learned: a.learned, bgCompile: true, onPrewarm: (m, before) => {
      // (the warm block's control word: on three programs in four a mode no program uses — every x87 region leaves through
      // its guard, writing the warm block —, on the others zero — 24-bit-precision regions pass it and trap at the dispatcher)
      if (before === undefined) { m.mem.fill(JIT_WARM_STATE, 0x400, 0); if (i % 4 !== 1) m.mem.write16(JIT_WARM_STATE + ST.FPU_CW, 0x0f7f); return snap(m); }
      assert.equal(snap(m), before, `program ${i}: memory written by the compiling calls`);
      if (m.mem.read32(JIT_WARM_STATE + ST.EXIT_ARG) !== 0) warmed++;
    } });
    assert.equal(b.r, ref.r, `program ${i}: exit`);
    assert.equal(b.s, ref.s, `program ${i}: state`);
  }
  assert.ok(warmed > 0, 'some calls left through their guard (x87 mode) writing the warm state block');
});

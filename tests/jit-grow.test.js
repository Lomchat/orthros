// Region growth (opts.grow, Jit.sample / grow): a region that left code out for its size and is found hot by the
// slice-end samples is translated again with larger size limits, here or in the background translator, and replaces
// the region it grows. Exact whatever is grown and when: randomized programs (blocks joined by forward and backward
// branches, calls to leaf functions, x87 under several precision modes, memory, self-modifying code) run time-sliced
// with growth at every slice end against the interpreter, with the background translator and with the translated-code
// cache (a grown region and the region it grows are kept apart: neither supersedes the other). Also the background
// translator's own options: opts.bgSize (its regions larger) and opts.bgCompile (its regions compiled there by one call
// each, on a state block no thread uses: nothing else written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, JIT_ALT_BASE, JIT_WARM_STATE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { discoverRegion } from '../src/cpu/jit/translate.js';
import { handleMessage, grownKey } from '../src/cpu/jit/bg-translate.js';
import { MemStore } from '../src/cpu/jit/code-cache.js';

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
/** sliced run sampling at every slice end (as Vm.sliceEnd); `between` runs then too (background installs) */
function sliced(jit, m, p, slice, between = null) {
  jit.boundaries = new Set([p.end + 1]); // (what follows the final hlt is no code)
  let r, n = 0;
  for (;;) {
    r = jit.run({ stopAt: p.end, maxInsns: slice });
    if (r === EXIT.SMC) { smcExit(jit, m); continue; }
    if (r !== EXIT.TIMESLICE) break;
    jit.sample(m.cpu.eip);
    between?.();
    if (++n > 1e6) throw new Error('runaway');
  }
  CpuState.foldLazyFlags?.(m.cpu);
  return r;
}

test('discovery reports a region that left code out for its size', () => {
  const p = gen({ x87: false, smc: false });
  const m = machine(p.code, [1, 2, 3, 4, 5]);
  // (the address after the final hlt bounds the region: what follows is no code)
  const boundaries = new Set([p.end + 1]);
  assert.equal(discoverRegion(m.mem, CODE, { maxBlocks: 2, maxInsns: 400, boundaries }).full, true);
  assert.equal(discoverRegion(m.mem, CODE, { maxBlocks: 4096, maxInsns: 100000, boundaries }).full, false);
  // (one block left out of 3: full; the same with room for every block: not)
  const tiny = Uint8Array.from([0x85, 0xc0, 0x74, 0x02, 0x40, 0x40, 0x41, 0xf4]); // test eax,eax ; jz +2 ; inc eax ; inc eax ; inc ecx ; hlt
  const t = machine(tiny, [0, 0, 0, 0, 0]);
  const tb = new Set([CODE + tiny.length]);
  assert.equal(discoverRegion(t.mem, CODE, { maxBlocks: 2, maxInsns: 400, boundaries: tb }).full, true);
  assert.equal(discoverRegion(t.mem, CODE, { maxBlocks: 3, maxInsns: 400, boundaries: tb }).full, false);
  assert.equal(discoverRegion(t.mem, CODE, { maxBlocks: 3, maxInsns: 2, boundaries: tb }).full, true); // (the instruction cap)
});

test('region growth at slice ends: random programs match the interpreter, regions grown and replaced', () => {
  let grown = 0, runs = 0;
  for (let i = 0; i < 80; i++) {
    const p = gen({ x87: i % 2 === 0, smc: i % 3 === 0 });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    for (const [maxBlocks, f, growMin, slice] of [[2, 2, 1, 7], [3, 3, 2, 13], [4, 1.5, 1, 1], [2, 8, 3, 29], [2, 4, 1, 5]]) {
      const m = machine(p.code, regs);
      const jit = new Jit(m.mem, m.interp, { smc: true, maxBlocks, maxInsns: 400, grow: f, growMin });
      jit.cpu = m.cpu;
      const r = sliced(jit, m, p, slice);
      assert.equal(r, ref.r, `program ${i} ${maxBlocks}/${f}: exit`);
      assert.equal(state(m.cpu, m.mem), ref.s, `program ${i} ${maxBlocks}/${f}: state`);
      grown += jit.stats.grown ?? 0; runs++;
      // (a grown region is the only live region at its entry, and holds more blocks than the size it grew from)
      for (const reg of jit.regions) if (reg.grown > 0 && !reg.first) assert.equal(jit.byEntry.get(reg.entry), reg);
    }
  }
  assert.ok(grown > runs, `regions grown: ${grown} in ${runs} runs`);
});

test('no growth without the option, nor for regions that hold all their code', () => {
  const p = gen({ x87: false, smc: false });
  const regs = [1, 2, 3, 4, 5];
  const m = machine(p.code, regs);
  const jit = new Jit(m.mem, m.interp, { smc: true, maxBlocks: 2 }); jit.cpu = m.cpu;
  sliced(jit, m, p, 5);
  assert.equal(jit.stats.grown ?? 0, 0);
  const m2 = machine(p.code, regs);
  const j2 = new Jit(m2.mem, m2.interp, { smc: true, maxBlocks: 4096, maxInsns: 100000, grow: 2, growMin: 1 }); j2.cpu = m2.cpu;
  sliced(j2, m2, p, 5);
  assert.equal(j2.stats.grown ?? 0, 0);
});

/** a session with the background translator (shared memory), growth installed between slices; `cache`: its store */
async function bgSession(p, regs, { maxBlocks, f, slice, cache = null, skipFns = 0, learned = null, bgSize = 0, bgCompile = false, onPrewarm = null }) {
  const m = machine(p.code, regs, true);
  const jit = new Jit(m.mem, m.interp, { smc: true, maxBlocks, maxInsns: 400, grow: f, growMin: 1, bgSize, bgCompile, warn: (msg) => { throw new Error(msg); } });
  jit.cpu = m.cpu;
  for (let i = 0; i < skipFns; i++) jit.reserveFn();
  const replies = [];
  jit.attachBackground({ postMessage: (msg) => handleMessage(msg.type === 'init' ? { ...msg, cache } : msg, (rep) => replies.push(rep)) });
  await tick();
  // (the background worker answers synchronously here once its cache is open: installs between slices)
  const install = () => { for (const rep of replies.splice(0)) if (rep.type === 'batch') jit.bgInstall(rep); };
  // (an earlier session's entries translated ahead, as the page does: the cache then holds regions of both sizes)
  if (learned?.length) { const before = onPrewarm?.(m); jit.bgPrewarm(learned); await tick(); await tick(); onPrewarm?.(m, before); install(); }
  jit.learned = [];
  let r, n = 0;
  for (;;) {
    r = jit.run({ stopAt: p.end, maxInsns: slice });
    if (r === EXIT.SMC) { smcExit(jit, m); continue; }
    if (r !== EXIT.TIMESLICE) break;
    jit.sample(m.cpu.eip);
    if (n % 3 === 0) { await tick(); install(); }
    if (++n > 1e6) throw new Error('runaway');
  }
  CpuState.foldLazyFlags?.(m.cpu);
  await tick();
  const st = await new Promise((res) => handleMessage({ type: 'cache-stats' }, (rep) => res(rep.cache)));
  return { r, s: state(m.cpu, m.mem), jit, cache: st, learned: jit.learned.map(([eip, fpc]) => [eip, fpc]) };
}

test('region growth in the background translator: grown regions installed in place of live ones, results exact', async () => {
  let installed = 0;
  for (let i = 0; i < 40; i++) {
    const p = gen({ x87: i % 2 === 1, smc: i % 4 === 0 });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    const s = await bgSession(p, regs, { maxBlocks: 2 + (i % 3), f: 2 + (i % 2), slice: 3 + (i % 11) });
    assert.equal(s.r, ref.r, `program ${i}: exit`);
    assert.equal(s.s, ref.s, `program ${i}: state`);
    installed += s.jit.regions.filter((r) => r.grown > 0 && !r.first).length;
    for (const reg of s.jit.regions) if (reg.grown > 0 && !reg.first) assert.equal(s.jit.byEntry.get(reg.entry), reg);
  }
  assert.ok(installed > 40, `grown regions installed: ${installed}`);
});

test('translated-code cache: a grown region is kept apart from the region it grows, both reused by the next session', async () => {
  assert.notEqual(grownKey(null, 2), grownKey(0, 2));
  assert.notEqual(grownKey(0x200, 2), grownKey(0x200, 3));
  for (const mode of [null, 0, 0x200, 0x300, 0xf0f]) assert.ok(grownKey(mode, 2) > 0xffff && grownKey(mode, 2) !== mode);
  let reused = 0;
  for (let i = 0; i < 8; i++) {
    const p = gen({ x87: i % 2 === 0, smc: false });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    const store = new MemStore(), cache = () => ({ key: 'test|grow', store, idleMs: 1e9, refresh: false });
    const a = await bgSession(p, regs, { maxBlocks: 2, f: 2, slice: 5, cache: cache() });
    assert.equal(a.s, ref.s, `program ${i}: first session`);
    const b = await bgSession(p, regs, { maxBlocks: 2, f: 2, slice: 5, cache: cache(), skipFns: 7, learned: a.learned });
    assert.equal(b.s, ref.s, `program ${i}: second session`);
    const c = await bgSession(p, regs, { maxBlocks: 2, f: 2, slice: 5, cache: cache(), skipFns: 3, learned: a.learned });
    assert.equal(c.s, ref.s, `program ${i}: third session`);
    assert.equal(c.cache.superseded, 0, `program ${i}: nothing superseded`);
    reused += c.cache.hits;
  }
  assert.ok(reused > 0);
});

test('opts.bgSize: regions translated ahead in the background are larger; exact, their x87-mode versions alike', async () => {
  let larger = 0;
  for (let i = 0; i < 24; i++) {
    const p = gen({ x87: i % 2 === 0, smc: i % 5 === 0 });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    const a = await bgSession(p, regs, { maxBlocks: 2, f: 0, slice: 7 });
    const b = await bgSession(p, regs, { maxBlocks: 2, f: 0, slice: 3 + (i % 9), learned: a.learned, bgSize: 2 + (i % 3) });
    assert.equal(b.r, ref.r, `program ${i}: exit`);
    assert.equal(b.s, ref.s, `program ${i}: state`);
    larger += b.jit.regions.filter((r) => r.grown > 0 && r.blocks.length > 2).length;
  }
  assert.ok(larger > 10, `larger regions installed: ${larger}`);
});

test('opts.bgCompile: the background translator compiles its regions by calling them once on a state block of its own — guest memory and thread state untouched, results exact', async () => {
  // (the memory a call could touch: the program's code and data, the thread's state block, the x87-version slots)
  const snap = (m) => [m.mem.bytes(CODE, 0x1000), m.mem.bytes(DATA, 0x1000), m.mem.bytes(THREAD_STATES_BASE, 0x400), m.mem.bytes(JIT_ALT_BASE, 0x1000)].map((b) => Buffer.from(b).toString('base64')).join('|');
  let warmed = 0;
  for (let i = 0; i < 24; i++) {
    const p = gen({ x87: i % 2 === 0, smc: i % 5 === 0 });
    const regs = [val(), val(), val(), val(), val()];
    const ref = reference(p, regs);
    const a = await bgSession(p, regs, { maxBlocks: 3, f: 0, slice: 7 });
    const b = await bgSession(p, regs, { maxBlocks: 3, f: 2, slice: 3 + (i % 9), learned: a.learned, bgCompile: true, onPrewarm: (m, before) => {
      if (before === undefined) { m.mem.fill(JIT_WARM_STATE, 0x400, 0); return snap(m); }
      assert.equal(snap(m), before, `program ${i}: memory written by the compiling calls`);
      if (m.mem.bytes(JIT_WARM_STATE, 0x400).some((x) => x !== 0)) warmed++;
    } });
    assert.equal(b.r, ref.r, `program ${i}: exit`);
    assert.equal(b.s, ref.s, `program ${i}: state`);
  }
  assert.ok(warmed > 0, 'some calls left through their guard (x87 mode) writing the warm state block');
});

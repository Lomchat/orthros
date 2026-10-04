// Adversarial review of the translated-code cache under code heat (bg-translate.js heatRecorder / sameHeat,
// code-cache.js lookup `accept`, translate.js patchVisitSlots): random programs mixing integer code, x87 arithmetic
// under control-word changes (FLDCW: x87-mode versions of regions, translated on the main thread from the blocks of a
// first version that may come from the cache), divisions that may fault and calls, run over several sessions sharing
// ONE cache. Each session is a new Jit with the background translator and visit flags: a heat drawn from a small pool
// (so that sessions repeat an earlier heat — reuse — or bring another one), sometimes grown mid-session between two
// batches of learned entries (random instruction addresses, random x87 modes: covered entries under heat cuts), flag
// bytes and table indexes shifted. Every run ends as the interpreter does, and every region the background worker
// answered — reused or translated — has the extent, block numbering, x87 mode and visit flags a fresh translation
// under the session's heat of the moment gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { decode } from '../src/cpu/decoder.js';
import { RangeHeat } from '../src/cpu/jit/heat.js';
import { translateRegion, allocBlockCounters } from '../src/cpu/jit/translate.js';
import { MemStore } from '../src/cpu/jit/code-cache.js';
import { handleMessage } from '../src/cpu/jit/bg-translate.js';

const CODE = 0x20000000, DATA = 0x10000000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
let seed = 90210;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const R3 = () => rnd(4);
const CWS = [0x027f, 0x007f, 0x0c7f, 0x037f];
const unit = () => {
  switch (rnd(9)) {
    case 0: return [0x01, 0xc0 | (R3() << 3) | R3()];
    case 1: return [0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)];
    case 2: return [0x89, 0x46 | (R3() << 3), 4 * rnd(16)];
    case 3: return [0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()];
    case 4: return [0x31, 0xd2, 0xf7, 0xf3];
    case 5: return [0xd9, 0x6e, 0x70 + 2 * rnd(4)];
    case 6: {
      const op = [[0xd8, 0x46], [0xd8, 0x4e], [0xd8, 0x66]][rnd(3)];
      return [0xd9, 0x46, 4 * rnd(16), ...op, 4 * rnd(16), 0xd9, 0x5e, 4 * rnd(16)];
    }
    case 7: return [0xdb, 0x46, 4 * rnd(16), 0xdb, 0x5e, 4 * rnd(16)];
    default: return [0x31, 0xdb];
  }
};
function gen() {
  const nb = 4 + rnd(10), nf = 1 + rnd(3);
  const kinds = [];
  for (let i = 0; i < nb; i++) kinds.push('b');
  for (let i = 0; i < nf; i++) kinds.splice(rnd(kinds.length + 1), 0, 'f');
  kinds.unshift('b');
  const fns = kinds.map((k, i) => (k === 'f' ? i : -1)).filter((i) => i >= 0), blocksIdx = kinds.map((k, i) => (k === 'b' ? i : -1)).filter((i) => i >= 0);
  const out = [], start = [], fix = [];
  for (let i = 0; i < kinds.length; i++) {
    start[i] = out.length;
    if (kinds[i] === 'f') { for (let k = rnd(3); k >= 0; k--) out.push(...unit()); out.push(0xc3); continue; }
    out.push(0x4f, 0x0f, 0x84); fix.push([out.length, -1]); out.push(0, 0, 0, 0);
    for (let k = rnd(4); k > 0; k--) out.push(...unit());
    const tgt = blocksIdx[rnd(blocksIdx.length)];
    switch (rnd(4)) {
      case 0: out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break;
      case 1: out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); break;
      case 2: out.push(0xe8); fix.push([out.length, fns[rnd(fns.length)]]); out.push(0, 0, 0, 0);
        if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, blocksIdx[rnd(blocksIdx.length)]]); out.push(0, 0, 0, 0); }
        break;
      default: if (i + 1 < kinds.length && kinds[i + 1] === 'f') { out.push(0xe9); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); } break;
    }
  }
  if (kinds[kinds.length - 1] === 'f') { out.push(0xe9); fix.push([out.length, 0]); out.push(0, 0, 0, 0); }
  const end = out.length; out.push(0xf4);
  for (const [at, t] of fix) out.splice(at, 4, ...le((t < 0 ? end : start[t]) - (at + 4)));
  return { code: Uint8Array.from(out), end };
}
const V = [0, 1, 2, 0x7f, 0x80, 0xffff, 0x3f800000, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(2) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);
const input = () => ({ regs: [val(), val(), val(), val(), rnd(0x1000)], edi: 20 + rnd(300), cw: CWS[rnd(CWS.length)], data: Array.from({ length: 16 }, () => (rnd(3) ? [0x3f800000, 0x40490fdb, 0xc2c80000, 0x4b000001, 0x3eaaaaab][rnd(5)] : val())) });
function init(mem, cpu, inp) {
  cpu.reset(); mem.fill(DATA, 0x1000, 0);
  inp.data.forEach((v, i) => mem.write32(DATA + 0x100 + 4 * i, v));
  CWS.forEach((cw, i) => mem.write16(DATA + 0x170 + 2 * i, cw));
  [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx] = inp.regs; cpu.edi = inp.edi; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0x800; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF | (inp.regs[4] & ARITH);
  mem.write16(cpu.base + ST.FPU_CW, inp.cw);
}
const stateOf = (r, mem, cpu) => [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.edi, cpu.eflags & ARITH, cpu.eip, mem.read16(cpu.base + ST.FPU_CW), mem.u8[cpu.base + ST.FPU_TOP] & 7].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + [...mem.bytes(DATA + 0x100, 0x80), ...mem.bytes(DATA + 0x700, 0x100)].join(',');
function setup(code, shared) {
  const mem = new GuestMemory({ shared }), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code);
  return { mem, cpu };
}
/** random [lo, hi) pairs over the instructions (each ran or not) */
function randomPairs(addrs) {
  const p = [];
  for (let i = 0; i < addrs.length; i++) if (rnd(3)) p.push(addrs[i], i + 1 < addrs.length ? addrs[i + 1] : addrs[i] + 1);
  return p;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('code cache under heat, adversarial: sessions sharing one cache, heats repeated / changed / grown, x87 modes, covered entries', async () => {
  let hits = 0, missHeat = 0, missExtent = 0, versions = 0, covered = 0, checked = 0, grown = 0;
  for (let t = 0; t < 40; t++) {
    const { code, end } = gen();
    const scratch = new GuestMemory(); scratch.writeBytes(CODE, code);
    const addrs = [];
    for (let a = 0; a <= end;) { addrs.push(CODE + a); a = decode(scratch, CODE + a).next - CODE; }
    const store = new MemStore();
    const pool = [null, randomPairs(addrs), randomPairs(addrs), addrs.length ? [CODE, CODE + end + 1] : null];
    const coldMin = 1 + rnd(3);
    for (let k = 0; k < 7; k++) {
      const inp = input();
      const ref = setup(code, false); init(ref.mem, ref.cpu, inp);
      const want = stateOf(new Interp(ref.mem, ref.cpu).run({ stopAt: CODE + end, maxInsns: 1e7 }), ref.mem, ref.cpu);
      const { mem, cpu } = setup(code, true);
      if (rnd(2)) allocBlockCounters(mem, 1 + rnd(5000)); // (the session's flag bytes elsewhere)
      init(mem, cpu, inp);
      const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, visit: true, coldExits: true, coldMin });
      jit.cpu = cpu;
      for (let i = rnd(20); i > 0; i--) jit.reserveFn();
      const heat0 = pool[rnd(pool.length)];
      if (heat0) jit.heatAdd(heat0);
      // the heat the background worker sees, mirrored here: the translation a reused region must equal
      const mirror = new RangeHeat(); if (heat0) mirror.addPairs(heat0);
      const replies = [];
      let bgOpts = null;
      jit.attachBackground({ postMessage: (msg) => {
        if (msg.type === 'init') bgOpts = msg.opts;
        handleMessage(msg.type === 'init' ? { ...msg, cache: { key: 'test|adv', store } } : msg, (r) => replies.push(r));
      } });
      await tick();
      const learnedOf = () => addrs.filter(() => rnd(3) === 0).map((a) => [a, rnd(3) ? CWS[rnd(4)] & 0xf00 : null]);
      const answer = (hasHeat) => {
        for (const rep of replies.splice(0)) {
          if (rep.type !== 'batch') continue;
          hits += rep.cacheHits ?? 0;
          for (const it of rep.items) {
            if (it.covered) { covered++; continue; }
            if (it.k < 0) continue;
            // a fresh translation under the heat of now, with the region's own flag bytes: same extent, numbering,
            // x87 mode, flagged blocks
            const flags = new Map((it.stats.visits ?? []).map(([e, , a]) => [e, a]));
            const fresh = translateRegion(mem, it.eip, { ...bgOpts, heat: hasHeat ? mirror : null, visitSlots: { get: (_m, e) => flags.get(e) ?? 0x7ff00000 }, fnIdx: it.fnIdx, fpcAssume: it.fpc });
            assert.deepEqual(it.blocks.map((b) => [b.eip, b.end, b.index]), fresh.blocks.map((b) => [b.eip, b.end, b.index]), `program ${t} session ${k} region ${it.eip.toString(16)}: extent / numbering`);
            assert.equal(it.fpc, fresh.fpcAssume, 'x87 mode');
            assert.deepEqual((it.stats.visits ?? []).map((v) => v[0]), (fresh.stats.visits ?? []).map((v) => v[0]), `program ${t} session ${k} region ${it.eip.toString(16)}: flagged blocks`);
            checked++;
          }
          jit.bgInstall(rep);
        }
      };
      jit.bgPrewarm(learnedOf()); await tick(); await tick();
      answer(!!heat0);
      // the heat grown mid-session (visit flags harvested, a later learned list)
      if (rnd(2)) {
        const more = randomPairs(addrs);
        if (more.length) { jit.heatAdd(more); mirror.addPairs(more); grown++; }
        jit.bgPrewarm(learnedOf()); await tick(); await tick();
        answer(!!heat0 || more.length > 0);
      }
      const slice = [1e7, 1, 3, 17][rnd(4)];
      let r;
      for (let n = 0; ; n++) {
        if (n > 1e6) throw new Error('runaway');
        r = jit.run({ stopAt: CODE + end, maxInsns: slice });
        if (r !== EXIT.TIMESLICE) break;
      }
      CpuState.foldLazyFlags?.(cpu);
      assert.equal(stateOf(r, mem, cpu), want, `program ${t} session ${k} slice ${slice}: ${Buffer.from(code).toString('hex')}`);
      versions += jit.stats.fpuVersions ?? 0;
      if (jit.bg.cache) { missHeat += jit.bg.cache.missHeat; missExtent += jit.bg.cache.missExtent; }
    }
  }
  assert.ok(hits > 100, `regions reused: ${hits}`);
  assert.ok(missHeat > 10, `other heat answers: ${missHeat}`);
  assert.ok(missExtent > 10, `other extents: ${missExtent}`);
  assert.ok(versions > 5, `x87-mode versions: ${versions}`);
  assert.ok(covered > 20, `covered entries: ${covered}`);
  assert.ok(grown > 20 && checked > 500, `heat grown ${grown}, regions checked ${checked}`);
});

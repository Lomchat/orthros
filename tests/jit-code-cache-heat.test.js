// Translated code kept across sessions (code-cache.js, bg-translate.js) under code heat (heat.js, cold exits and
// visit flags): a cached region is reused only where the heat of the session gives its extent and flags every block
// the heat does not know to have run — another heat cutting the region otherwise (another extent) or leaving such a
// block unflagged is another translation, which supersedes the earlier shape of the same code —, its visit flags move
// to the session's own flag bytes (those of blocks the heat learned since to a byte never harvested), and the learned
// entries a heat-cut region no longer holds are not skipped as covered. Every run matches the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion, patchVisitSlots, VisitSlots, allocBlockCounters } from '../src/cpu/jit/translate.js';
import { MemStore } from '../src/cpu/jit/code-cache.js';
import { handleMessage } from '../src/cpu/jit/bg-translate.js';

const CODE = 0x20000000, DATA = 0x10000000;
const tick = () => new Promise((r) => setTimeout(r, 0));
// CODE+0  dec ecx ; jz COLD          (the cold successor: taken once, at the last iteration of ecx)
// CODE+3  inc eax ; dec ebp ; jnz CODE
// CODE+7  hlt                        (stopAt: never executed — its block entered, its flag set)
// CODE+8  COLD: inc edx ; jmp CODE+3
const PROGRAM = Uint8Array.of(0x49, 0x74, 0x05, 0x40, 0x4d, 0x75, 0xf9, 0xf4, 0x42, 0xeb, 0xf8);
const STOP = CODE + 7, COLD = CODE + 8;
// heats (pairs lo, hi): every block ran; all but the cold block (the jz ran: its cold successor is cut out);
// the cold block only (the jz never ran: nothing cut, the other blocks flagged); none (every block flagged)
const H = { all: [CODE, CODE + 11], cut: [CODE, CODE + 8], coldOnly: [COLD, CODE + 11], none: null };

function machine(regs) {
  const mem = new GuestMemory({ shared: true });
  const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, PROGRAM);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; [cpu.eax, cpu.ecx, cpu.edx, cpu.ebp] = regs; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x027f);
  return { mem, cpu, interp: new Interp(mem, cpu) };
}
const state = (c) => [c.eax, c.ecx, c.edx, c.ebp, c.eip].map((x) => (x >>> 0).toString(16)).join(' ');
function reference(regs) {
  const m = machine(regs);
  const r = m.interp.run({ stopAt: STOP, maxInsns: 1e6 });
  return { r, s: state(m.cpu) };
}

/**
 * One session: the background translator with the cache (`store`), the heat `heat` known before the learned entries
 * are asked, `shiftFlags` flag bytes taken first (the session's visit flags elsewhere than the last one's), `over`
 * in-session options. Returns the run, the batch items, the background stats and the visits harvested after the run.
 */
async function session(store, heat, { regs = [0, 3, 0, 10], learned = [[CODE, null]], shiftFlags = 0, over = null, skipFns = 0, maxBytes, idleMs } = {}) {
  const m = machine(regs);
  if (shiftFlags) allocBlockCounters(m.mem, shiftFlags);
  const jit = new Jit(m.mem, m.interp, { smc: true, visit: true, warn: (s) => { throw new Error(s); } });
  jit.cpu = m.cpu;
  for (let i = 0; i < skipFns; i++) jit.reserveFn();
  if (heat) jit.heatAdd(heat);
  const replies = [];
  jit.attachBackground({ postMessage: (msg) => handleMessage(msg.type === 'init' ? { ...msg, cache: { key: 'test|heat', store, maxBytes, idleMs } } : msg, (r) => replies.push(r)) });
  if (over) jit.switchOpts(over);
  await tick();
  jit.bgPrewarm(learned); await tick(); await tick();
  const items = [];
  for (const rep of replies.splice(0)) if (rep.type === 'batch') { items.push(...rep.items); jit.bgInstall(rep); }
  let r, k = 0;
  do r = jit.run({ stopAt: STOP, maxInsns: 1e6 }); while (r === EXIT.TIMESLICE && ++k < 1e5);
  const visited = jit.harvestVisits();
  const ran = [];
  for (let i = 0; i < visited.length; i += 2) ran.push(visited[i] - CODE);
  return { r, s: state(m.cpu), items, bg: jit.bg, ran: ran.sort((a, b) => a - b), installed: jit.bg.installed };
}

test('code cache with heat: a region cached under one heat is reused where the heat of now gives its translation', async () => {
  const store = new MemStore(), ref = reference([0, 3, 0, 10]);
  const run = async (name, opts) => {
    const s = await session(store, H[name], opts);
    assert.equal(s.r, ref.r, name); assert.equal(s.s, ref.s, `${name}: like the interpreter`);
    assert.equal(s.installed, 1, `${name}: the learned region installed`);
    return s;
  };
  // heat that cuts the cold block out: added, then reused by a session with the same heat
  let s = await run('cut');
  assert.equal(s.bg.cacheHits, 0); assert.equal(s.bg.cache.added, 1);
  s = await run('cut', { skipFns: 9 });
  assert.equal(s.bg.cacheHits, 1, 'same heat: reused');
  // every block ran: the region holds the cold block (another extent) — not the cut one's code
  s = await run('all');
  assert.equal(s.bg.cacheHits, 0, 'another heat (another extent): translated again');
  assert.equal(s.bg.cache.missExtent, 1); assert.equal(s.bg.cache.added, 1);
  s = await run('all');
  assert.equal(s.bg.cacheHits, 1);
  // no heat: the same extent as 'all' (nothing cut either way), but every block needs a visit flag — the entry of
  // 'all' flags none: translated again (and the entry of 'all', the same code, superseded)
  s = await run('none');
  assert.equal(s.bg.cacheHits, 0, 'the same extent, blocks the heat does not know left unflagged: translated again');
  assert.equal(s.bg.cache.missHeat, 1); assert.equal(s.bg.cache.added, 1); assert.equal(s.bg.cache.superseded, 1);
  assert.deepEqual(s.ran, [0, 3, 7, 8], 'the blocks that ran, from the visit flags');
  s = await run('none', { shiftFlags: 777 });
  assert.equal(s.bg.cacheHits, 1, 'no heat again: reused');
  assert.deepEqual(s.ran, [0, 3, 7, 8], 'reused: its visit flags moved to this session\'s flag bytes');
  // the heat grows with the same extent (the jz never ran: nothing cut; the cold block ran): the entry flagging every
  // block serves, the flag of the block the heat knows sent to the sink byte — the harvest reports the others only
  s = await run('coldOnly', { shiftFlags: 1234 });
  assert.equal(s.bg.cacheHits, 1, 'a grown heat, the same extent: reused'); assert.equal(s.bg.cache.added, 0);
  assert.deepEqual(s.ran, [0, 3, 7], 'reused: the blocks the heat knows are not reported');
  s = await run('all', { shiftFlags: 64 });
  assert.equal(s.bg.cacheHits, 1, 'every block known: reused, every flag to the sink');
  assert.deepEqual(s.ran, [], 'nothing reported');
  // a heat cutting the region: another extent, translated; the earlier shape of the same code superseded
  s = await run('cut');
  assert.equal(s.bg.cacheHits, 0); assert.equal(s.bg.cache.missExtent, 1); assert.equal(s.bg.cache.superseded, 1);
  assert.equal(s.bg.cache.loaded, 1, 'one shape per code kept');
  s = await run('cut', { shiftFlags: 99 });
  assert.equal(s.bg.cacheHits, 1); assert.equal(s.bg.cache.loaded, 1);
});

test('code cache with heat: past its bound, the cache makes room when the background worker is idle', async () => {
  const store = new MemStore(), ref = reference([0, 3, 0, 10]), head = 16 + 'test|heat'.length;
  let s = await session(store, H.none);
  const other = new MemStore(); await session(other, H.cut);
  const rl = store.size() - head, maxBytes = head + rl + (other.size() - head) - 1; // (the second record: 1 byte past it)
  // another shape of the same code: added past the bound (the earlier one superseded), the file compacted only once
  // no batch came for idleMs
  s = await session(store, H.cut, { maxBytes, idleMs: 5 });
  assert.equal(s.s, ref.s); assert.equal(s.bg.cache.superseded, 1); assert.equal(s.bg.cache.added, 1);
  assert.ok(store.size() > maxBytes, 'past the bound until idle');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.size(), other.size(), 'compacted when idle: the superseded record gone');
  s = await session(store, H.cut, { maxBytes });
  assert.equal(s.bg.cacheHits, 1); assert.equal(s.bg.cache.loaded, 1); assert.equal(s.bg.cache.dead, 0);
});

test('code cache with heat: in-session options are neither looked up nor kept', async () => {
  const store = new MemStore(), ref = reference([0, 3, 0, 10]);
  let s = await session(store, H.cut);
  assert.equal(s.bg.cache.added, 1);
  s = await session(store, H.cut, { over: { layout: false } });
  assert.equal(s.s, ref.s);
  assert.equal(s.bg.cacheHits, 0); assert.equal(s.bg.cache.added, 0); assert.equal(s.bg.cache.misses, 0);
});

test('code cache with heat: a learned entry is skipped as covered only when the heat-cut region holds it', async () => {
  const ref = reference([0, 3, 0, 10]), learned = [[CODE, null], [COLD, null]];
  for (const store of [new MemStore(), null]) { // (with the cache, then the same from it)
    const st = store ?? new MemStore();
    for (let pass = 0; pass < (store ? 2 : 1); pass++) {
      // every block ran: the cold block is a block of the entry's region
      let s = await session(st, H.all, { learned });
      assert.equal(s.s, ref.s);
      assert.ok(s.items.find((it) => it.eip === COLD).covered, 'held by the region of CODE');
      // the cold block cut out of the entry's region: its own region, translated and installed
      s = await session(st, H.cut, { learned });
      assert.equal(s.s, ref.s);
      const it = s.items.find((x) => x.eip === COLD);
      assert.ok(!it.covered && it.k >= 0, 'not held by the cut region: translated');
      assert.equal(s.installed, 2);
    }
  }
});

test('visit flags moved to other flag bytes: the same body as a translation with those bytes', () => {
  const m = machine([0, 3, 0, 10]);
  const opts = { chain: true, smc: true, visit: true, fnIdx: 3 };
  const a = translateRegion(m.mem, CODE, { ...opts, visitSlots: new VisitSlots() });
  allocBlockCounters(m.mem, 4321); // (another thread's flags in between)
  const slotsB = new VisitSlots();
  const b = translateRegion(m.mem, CODE, { ...opts, visitSlots: slotsB });
  assert.ok(a.stats.visits.length >= 3 && a.stats.visitSites.length === 2 * a.stats.visits.length);
  assert.notDeepEqual([...a.code], [...b.code]);
  const sites = [];
  for (let i = 0; i < a.stats.visitSites.length; i += 2) sites.push([a.stats.visitSites[i + 1], slotsB.get(m.mem, a.stats.visitSites[i])]);
  assert.deepEqual([...patchVisitSlots(a.code.slice(), sites)], [...b.code]);
  assert.throws(() => patchVisitSlots(a.code.slice(), [[a.stats.visitSites[1] + 1, sites[0][1]]]), /not a visit flag store/);
});
